// 미믹 서버 진입점. server/modules/<이름>/index.js 를 자동으로 불러와 등록한다.
// 모듈 규약(docs/BUILD_SPEC.md): export const migrations(SQL), export function register(app, ctx), export const jobs([{ name, everyMs, run(ctx) }])
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './core/config.js';
import { openDb } from './core/db.js';
import { loadUser, requireUser, publicUser, hasScope } from './core/auth.js';
import { usage } from './core/files.js';
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
      oauth: Object.fromEntries(Object.entries(cfg.oauth).map(([k, v]) => [k, !!v.clientId])),
      paymentsTestMode: cfg.dev && !cfg.payments.tossSecretKey,
      telegram: !!cfg.telegramToken,
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
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: err.code || (status >= 500 ? 'server_error' : 'bad_request'), message: status >= 500 ? '서버 오류가 발생했습니다' : err.message });
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
  const server = inst.app.listen(inst.cfg.port, () => {
    console.log(`미믹 서버 실행 중: ${inst.cfg.baseUrl} (데이터: ${inst.cfg.dataDir})`);
    if (inst.ctx.failedModules.length) console.log(`불러오지 못한 모듈: ${inst.ctx.failedModules.join(', ')}`);
  });
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
