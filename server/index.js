// 미믹 서버 진입점. server/modules/<이름>/index.js 를 자동으로 불러와 등록한다.
// 모듈 규약(docs/BUILD_SPEC.md): export const migrations(SQL), export function register(app, ctx), export const jobs([{ name, everyMs, run(ctx) }])
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './core/config.js';
import { openDb } from './core/db.js';
import { loadUser, requireUser, publicUser, hasScope } from './core/auth.js';
import { usage } from './core/files.js';
import { HttpError } from './core/util.js';
import { capacityOf, limitsFor, isPremium } from './core/plans.js';
import { fail } from './core/util.js';
import { gcBlobs } from './core/storage.js';
import { bindNotify } from './core/notify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');

export async function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const db = openDb(cfg.dataDir);
  bindNotify(db, cfg); // notify() 가 웹 푸시(K-05)에 쓸 설정
  const events = new EventEmitter(); // 모듈 간 이벤트: user:created, user:login, payment:completed, file:created, offline:completed
  events.setMaxListeners(50);
  // hooks.activity: 로그인한 요청마다 동기 함수 (req, ctx) 로 불린다(모든 API 보다 먼저, 모듈은 register 에서 push). 던지면 그 요청은 오류로 끝난다(H-04 계정 공유 탐지 등)
  const ctx = { db, cfg, events, modules: {}, failedModules: [], hooks: { activity: [] } };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // 비공개 미리보기·베타(MIMIC_SITE_PASSWORD): 접속 키를 아는 사람만 들어온다.
  // 공유 링크에 ?key=<키> 를 붙이면 한 번 누르는 것으로 들어오고(쿠키 30일), 키 없이 오면 입력 화면을 보여 준다.
  // 브라우저 기본 비밀번호 창(HTTP Basic)은 카카오톡 등 앱 안 브라우저에서 뜨지 않아 쓰지 않는다
  if (cfg.sitePassword) {
    const pass = crypto.createHmac('sha256', cfg.secret).update('site:' + cfg.sitePassword).digest('base64url');
    const same = (a, b) => {
      const x = crypto.createHash('sha256').update(String(a)).digest();
      return crypto.timingSafeEqual(x, crypto.createHash('sha256').update(String(b)).digest());
    };
    const okCookie = (req) => same(/(?:^|;\s*)mimic_site=([^;]+)/.exec(req.get('cookie') || '')?.[1] || '', pass);
    const letIn = (req, res) => res.cookie('mimic_site', pass, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600e3, path: '/' });
    const safeNext = (v) => (typeof v === 'string' && /^\/(?![/\\])/.test(v) ? v : '/');
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const form = (res, next, wrong) =>
      res
        .status(401)
        .type('html')
        .send(
          `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>미믹 미리보기</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:#f4f7f6;color:#14302c}
form{background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.08);width:min(340px,88vw)}h1{margin:0 0 6px;font-size:20px;color:#0f9d8f}p{margin:0 0 16px;font-size:14px;color:#55706b}
input,button{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border-radius:10px}input{border:1px solid #cfdcd9;margin-bottom:10px}button{border:0;background:#0f9d8f;color:#fff;font-weight:600}.err{color:#c0392b}</style></head>
<body><form method="post" action="/__site-login"><h1>미믹 미리보기</h1><p>받은 링크를 그대로 누르면 바로 들어와요. 접속 키를 받았다면 아래에 넣어 주세요.<br>Enter the access key you were given.</p>
${wrong ? '<p class="err">접속 키가 맞지 않아요 / Wrong key</p>' : ''}<input name="key" placeholder="접속 키 / Access key" autocomplete="off" autofocus><input type="hidden" name="next" value="${esc(next)}"><button>들어가기 / Enter</button></form></body></html>`,
        );
    app.post('/__site-login', express.urlencoded({ extended: false }), (req, res) => {
      const next = safeNext(req.body?.next);
      if (!same(req.body?.key || '', cfg.sitePassword)) return form(res, next, true);
      letIn(req, res).redirect(303, next);
    });
    app.use((req, res, next) => {
      if (okCookie(req)) return next();
      if (req.method === 'GET' && typeof req.query.key === 'string' && same(req.query.key, cfg.sitePassword)) {
        const u = new URL(req.originalUrl, 'http://x');
        u.searchParams.delete('key');
        return letIn(req, res).redirect(302, safeNext(u.pathname + u.search)); // //evil.example 같은 주소로 내보내지 않는다
      }
      if (/^\/(api|webdav)(\/|$)/i.test(req.path)) return res.status(401).json({ error: 'site_key_required', message: '미리보기 접속 키가 필요합니다' });
      form(res, safeNext(req.originalUrl), false);
    });
  }
  // WebDAV 는 요청 본문이 파일 그 자체라 JSON 해석을 건너뛴다(Express 경로는 대소문자 구분 없음 → /WEBDAV 도 같게, G-01)
  const jsonBody = express.json({ limit: '2mb' });
  app.use((req, res, next) => (/^\/webdav(\/|$)/i.test(req.path) ? next() : jsonBody(req, res, next)));
  // 폼 본문은 소셜 로그인 콜백(Apple form_post·개발용 화면)에만. 다른 API 는 CORS 사전 요청 없는 단순 폼 POST 를 받지 않는다(K-06)
  app.use('/api/auth/oauth', express.urlencoded({ extended: false }));
  app.use(loadUser(db));
  app.use((req, _res, next) => {
    if (req.user) for (const fn of ctx.hooks.activity) fn(req, ctx);
    next();
  });
  // 관리자 상태 변경은 같은 출처에서 온 요청만 받는다(K-06 CSRF 심층 방어. 브라우저는 POST·PATCH·DELETE 에 Origin 을 붙인다)
  const ownOrigin = new URL(cfg.baseUrl).origin;
  const hostOf = (o) => {
    try {
      return new URL(o).host;
    } catch {
      return null;
    }
  };
  app.use('/api/admin', (req, _res, next) => {
    const o = req.get('origin');
    if (o && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && o !== ownOrigin && hostOf(o) !== req.get('host')) fail(403, 'bad_origin', '다른 사이트에서 보낸 요청은 처리하지 않습니다');
    next();
  });
  // 개발용 창구(인증코드 outbox·개발용 소셜 로그인)는 이 컴퓨터에서 온 요청만(H-01). 프록시 뒤면 req.ip 는 X-Forwarded-For 의 실제 주소
  const localOnly = (req, _res, next) => (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip) ? next() : fail(404, 'not_found', '없는 API 입니다'));
  app.use(['/api/dev', /^\/api\/auth\/oauth\/[^/]+\/dev\/?$/i], localOnly);

  app.get('/api/health', (_req, res) => res.json({ ok: true, modules: Object.keys(ctx.modules), failed: ctx.failedModules }));
  // Android TWA 가 이 사이트를 주소창 없이 열 수 있게 하는 Digital Asset Links(K-09). 설정이 없으면 빈 목록
  // (정적 파일은 점으로 시작하는 폴더를 건너뛰고 SPA 는 확장자 있는 주소를 받지 않으므로 여기서 직접 답한다)
  app.get('/.well-known/assetlinks.json', (_req, res) =>
    res.json(
      cfg.androidPackage && cfg.androidSha256?.length
        ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: cfg.androidPackage, sha256_cert_fingerprints: cfg.androidSha256 } }]
        : [],
    ),
  );
  app.get('/api/config', (_req, res) =>
    res.json({
      dev: cfg.dev,
      demo: !!(cfg.dev && cfg.demo),
      oauth: Object.fromEntries(Object.entries(cfg.oauth).map(([k, v]) => [k, !!v.clientId])),
      paymentsTestMode: cfg.dev && !cfg.payments.tossSecretKey && !cfg.payments.tossSecretKeyUsd,
      telegram: !!cfg.telegramToken,
      // 미리보기 접속 키: 이 응답은 이미 키를 아는 사람만 받는다(위 접속 키 검사). 공유 링크에 붙여 받는 사람이 바로 열게 한다
      ...(cfg.sitePassword ? { siteKey: cfg.sitePassword } : {}),
    }),
  );
  app.get('/api/me', requireUser, (req, res) => {
    const u = req.user;
    const user = publicUser(u);
    // 설정·초대 코드는 account 권한(G-05)이 있는 토큰에만. CLI whoami 는 id·이메일·이름만 쓴다
    if (req.authKind === 'token' && !hasScope(req, 'account')) {
      delete user.settings;
      delete user.inviteCode;
    }
    res.json({ user, premium: isPremium(u), storage: { used: usage(db, u.id), total: capacityOf(u) }, limits: limitsFor(u) });
  });
  if (cfg.dev) {
    app.get('/api/dev/outbox', (_req, res) => res.json({ items: db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 100').all() }));
  }

  // 기능 모듈 자동 등록. 한 모듈이 깨져도 나머지는 동작하도록 오류를 기록하고 건너뛴다
  const modDir = path.join(here, 'modules');
  const names = fs.existsSync(modDir) ? fs.readdirSync(modDir).filter((n) => fs.existsSync(path.join(modDir, n, 'index.js'))).sort() : [];
  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(path.join(modDir, name, 'index.js')).href);
      if (mod.migrations) db.exec(mod.migrations);
      ctx.modules[name] = mod;
    } catch (e) {
      ctx.failedModules.push(name);
      console.error(`[module ${name}] 불러오기 실패: ${e.stack || e.message}`);
    }
  }
  // MIMIC_ADMIN_EMAIL 로 지정한 계정은 서버가 켜질 때 관리자로 지정한다
  if (cfg.adminEmail) db.prepare('UPDATE users SET is_admin=1 WHERE email=?').run(cfg.adminEmail.trim().toLowerCase());

  for (const [name, mod] of Object.entries(ctx.modules)) {
    try {
      await mod.register?.(app, ctx);
    } catch (e) {
      ctx.failedModules.push(name);
      console.error(`[module ${name}] 등록 실패: ${e.stack || e.message}`);
    }
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found', message: '없는 API 입니다' }));
  app.use(express.static(webDir, { index: false }));
  // 화면 주소는 모두 SPA 가 처리한다(확장자가 있는 정적 파일 요청은 제외 → 404)
  app.get(/^\/(?!api\/|webdav)(?!.*\.[a-z0-9]+$).*/i, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const known = err instanceof HttpError; // fail() 로 일부러 낸 오류(가입 일시 중지 503 등)는 문구를 그대로 보여 준다
    if (status >= 500 && !known) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: err.code || (status >= 500 ? 'server_error' : 'bad_request'), message: status >= 500 && !known ? '서버 오류가 발생했습니다' : err.message });
  });

  const timers = [];
  function startJobs() {
    const jobs = [{ name: 'core:gc-blobs', everyMs: 6 * 3600_000, run: () => gcBlobs(db, cfg) }];
    for (const mod of Object.values(ctx.modules)) jobs.push(...(mod.jobs || []));
    for (const job of jobs) {
      const tick = async () => {
        try {
          await job.run(ctx);
        } catch (e) {
          console.error(`[job ${job.name}]`, e);
        }
      };
      timers.push(setInterval(tick, job.everyMs));
      setTimeout(tick, 5_000).unref();
    }
  }

  async function close() {
    timers.forEach(clearInterval);
    for (const mod of Object.values(ctx.modules)) await mod.close?.(ctx);
    db.close();
  }

  return { app, db, cfg, ctx, startJobs, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inst = await createApp();
  // 운영에서는 같은 컴퓨터의 Caddy(HTTPS)만 들어오게 127.0.0.1 에서만 받는다. 다른 구성이면 MIMIC_HOST=0.0.0.0
  const host = process.env.MIMIC_HOST || (inst.cfg.dev ? undefined : '127.0.0.1');
  const server = inst.app.listen(inst.cfg.port, host, () => {
    console.log(`미믹 서버 실행 중: ${inst.cfg.baseUrl} (데이터: ${inst.cfg.dataDir})`);
    if (inst.ctx.failedModules.length) console.log(`불러오지 못한 모듈: ${inst.ctx.failedModules.join(', ')}`);
  });
  server.requestTimeout = 0; // 큰 파일 업로드·긴 영상 스트리밍이 5분(Node 기본값)에 끊기지 않게. 헤더 대기 시간 제한은 그대로
  inst.ctx.server = server;
  if (inst.cfg.runJobs) inst.startJobs();
  const stop = async () => {
    server.close();
    await inst.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
