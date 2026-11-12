// 미믹 서버 진입점. server/modules/<이름>/index.js 를 자동으로 불러와 등록한다.
// 모듈 규약(docs/BUILD_SPEC.md): export const migrations(SQL), export function register(app, ctx), export const jobs([{ name, everyMs, run(ctx) }])
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './core/config.js';
import { openDb } from './core/db.js';
import { loadUser, requireUser, publicUser } from './core/auth.js';
import { usage } from './core/files.js';
import { capacityOf, limitsFor, isPremium } from './core/plans.js';
import { gcBlobs } from './core/storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');

export async function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const db = openDb(cfg.dataDir);
  const events = new EventEmitter(); // 모듈 간 이벤트: user:created, user:login, payment:completed, file:created, offline:completed
  events.setMaxListeners(50);
  const ctx = { db, cfg, events, modules: {}, failedModules: [] };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(loadUser(db));

  app.get('/api/health', (_req, res) => res.json({ ok: true, modules: Object.keys(ctx.modules), failed: ctx.failedModules }));
  app.get('/api/config', (_req, res) =>
    res.json({
      dev: cfg.dev,
      oauth: Object.fromEntries(Object.entries(cfg.oauth).map(([k, v]) => [k, !!v.clientId])),
      paymentsTestMode: !cfg.payments.tossSecretKey,
      telegram: !!cfg.telegramToken,
    }),
  );
  app.get('/api/me', requireUser, (req, res) => {
    const u = req.user;
    res.json({ user: publicUser(u), premium: isPremium(u), storage: { used: usage(db, u.id), total: capacityOf(u) }, limits: limitsFor(u) });
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
