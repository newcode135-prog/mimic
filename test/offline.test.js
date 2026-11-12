import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bencode from 'bencode';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import parseTorrent from 'parse-torrent';
import { createFolder, createFileNode, listChildren } from '../server/core/files.js';
import { saveSettings, createToken } from '../server/core/auth.js';
import { tx } from '../server/core/db.js';
import { newId, now, periodKeys, DAY } from '../server/core/util.js';
import { MONTHLY_QUOTA, APP_QUOTA_SHARE, capacityOf } from '../server/core/plans.js';
import { addUsage } from '../server/core/quota.js';
import { isLikelyAd, pickFiles, findYtDlp, isPrivateIp, assertPublicUrl, stripPrivate, parseYtDlpProgress } from '../server/modules/offline/index.js';
import { requeueStale, safeFetch, kick, ytDlpPath, findBlock } from '../server/modules/offline/engine.js';
import dnsPromises from 'node:dns/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const BT_OPTS = { dht: false, lsd: false, natUpnp: false, natPmp: false, utPex: false };

async function waitFor(fn, ms = 15_000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, step));
  }
}

// 외부 인터넷 대신 쓰는 로컬 파일 서버
async function fileServer() {
  const hits = {};
  const held = [];
  const gated = []; // /gate… 응답: release() 하면 끝난다
  const routes = {}; // 경로 → 본문(테스트가 채움)
  const versions = {}; // 경로 → { body, etag }: ETag 를 주고 If-None-Match 가 맞으면 304
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits[p] = (hits[p] || 0) + 1;
    if (routes[p]) return res.end(routes[p]);
    const v = versions[p];
    if (v) return req.headers['if-none-match'] === v.etag ? res.writeHead(304).end() : res.writeHead(200, { etag: v.etag, 'content-length': v.body.length }).end(v.body);
    if (p.startsWith('/gate')) {
      res.writeHead(200, { 'content-length': 2000 });
      res.write(Buffer.alloc(1000, 3));
      gated.push(res);
      return;
    }
    if (p.startsWith('/slow')) {
      res.writeHead(200, { 'content-length': 1_000_000 });
      res.write(Buffer.alloc(1000, 1));
      held.push(res);
      return;
    }
    // /redir… → 같은 서버를 localhost 이름으로 가리키는 리다이렉트(도메인 차단 우회 시험)
    if (p.startsWith('/redir')) return res.writeHead(302, { location: `http://localhost:${srv.address().port}/target${p.slice(6)}` }).end();
    if (p.startsWith('/missing')) return res.writeHead(404).end('no');
    // 흔한 다운로드 링크: 이름 없는 주소 → CDN 의 실제 파일(Content-Disposition 없음, octet-stream)
    if (p === '/download') return res.writeHead(302, { location: '/files/movie.mp4' }).end();
    if (p.startsWith('/files/')) return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(4096, 5));
    const body = Buffer.from(`mimic sample ${p} `.repeat(3000));
    res.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('샘플 ' + p.slice(1))}.bin` });
    res.end(body);
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    hits,
    routes,
    versions,
    release: () => gated.splice(0).forEach((r) => r.end(Buffer.alloc(1000, 3))),
    close() {
      held.forEach((r) => r.destroy());
      srv.closeAllConnections();
      srv.close();
    },
  };
}

const waitTask = (api, id, statuses = ['done', 'error', 'blocked'], ms) =>
  waitFor(async () => {
    const r = await api.get(`/api/offline/tasks/${id}`);
    return statuses.includes(r.body.task?.status) && r.body.task;
  }, ms);

test('offline: 클라우드 다운로드', async (t) => {
  const s = await startServer({ bt: BT_OPTS, ytDlp: null });
  const files = await fileServer();
  t.after(async () => {
    files.close();
    await s.close();
  });
  const premium = () => {
    const u = createUser(s.db, { premium: true });
    return { u, api: client(s.url, sessionFor(s.db, u.id)) };
  };
  const addBlock = (kind, value) => {
    const id = newId('b_');
    s.db.prepare('INSERT INTO blocklist (id, kind, value, reason, created_at) VALUES (?,?,?,?,?)').run(id, kind, value, '테스트', now());
    return id;
  };
  const adminApi = () => client(s.url, sessionFor(s.db, createUser(s.db, { admin: true }).id));

  await t.test('[A-03] HTTP 파일 링크를 서버가 받아 지정한 폴더에 저장', async () => {
    const { u, api } = premium();
    const folder = createFolder(s.db, u.id, null, '받은 파일');
    const r = await api.post('/api/offline/tasks', { urls: [`${files.url}/a`], parentId: folder.id });
    assert.equal(r.status, 201);
    assert.equal(r.body.tasks[0].kind, 'url');
    const task = await waitTask(api, r.body.tasks[0].id);
    assert.equal(task.status, 'done', task.error);
    assert.equal(task.progress, 100);
    const kids = listChildren(s.db, u.id, folder.id);
    assert.equal(kids.length, 1);
    assert.equal(kids[0].name, '샘플 a.bin');
    assert.equal(kids[0].origin, 'cloud');
    assert.equal(kids[0].size, task.size);
    assert.deepEqual(task.fileIds, [kids[0].id]);
    const n = s.db.prepare("SELECT * FROM notifications WHERE user_id=? AND kind='offline'").get(u.id);
    assert.equal(n.title, '클라우드 다운로드 완료');
    assert.equal(n.link, `/drive/folder/${folder.id}`);
    const used = s.db.prepare("SELECT amount FROM quota_usage WHERE user_id=? AND kind='cloud' AND period LIKE 'm:%'").get(u.id);
    assert.equal(used.amount, task.size);
  });

  await t.test('[A-03] 리다이렉트를 거친 링크는 최종 주소로 이름·종류를 정함', async () => {
    const { u, api } = premium();
    const r = await api.post('/api/offline/tasks', { urls: [`${files.url}/download?id=7`] });
    const task = await waitTask(api, r.body.tasks[0].id);
    assert.equal(task.status, 'done', task.error);
    const [node] = listChildren(s.db, u.id, null);
    assert.deepEqual([node.name, node.mime], ['movie.mp4', 'video/mp4']);
  });

  await t.test('[A-06] 같은 URL 두 번째 요청은 받지 않고 즉시 완료', async () => {
    const a = premium();
    const b = premium();
    const r1 = await a.api.post('/api/offline/tasks', { urls: [`${files.url}/dup`] });
    await waitTask(a.api, r1.body.tasks[0].id);
    assert.equal(files.hits['/dup'], 1);
    const t0 = Date.now();
    const r2 = await b.api.post('/api/offline/tasks', { text: `${files.url}/dup` });
    const task = await waitTask(b.api, r2.body.tasks[0].id);
    assert.equal(task.status, 'done');
    assert.equal(task.progress, 100);
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(files.hits['/dup'], 1, '원본 서버에 다시 요청하지 않음');
    assert.equal(listChildren(s.db, b.u.id, null)[0].name, '샘플 dup.bin');
  });

  await t.test('[A-06] 주소로 찾은 즉시 완료는 원본이 바뀌었는지 확인(ETag), 검증값이 없으면 하루만', async () => {
    const fetchAs = async (p) => {
      const { u, api } = premium();
      const r = await api.post('/api/offline/tasks', { urls: [files.url + p] });
      const task = await waitTask(api, r.body.tasks[0].id);
      assert.equal(task.status, 'done', task.error);
      return { task, node: listChildren(s.db, u.id, null)[0] };
    };
    files.versions['/changing'] = { body: Buffer.from('VERSION-1 '.repeat(100)), etag: '"v1"' };
    const a = await fetchAs('/changing');
    const b = await fetchAs('/changing'); // 조건부 요청 → 304 → 받지 않고 즉시 완료
    assert.equal(b.node.blob_hash, a.node.blob_hash);
    assert.equal(files.hits['/changing'], 2);
    files.versions['/changing'] = { body: Buffer.from('VERSION-2 '.repeat(140)), etag: '"v2"' };
    const c = await fetchAs('/changing');
    assert.equal(c.task.size, 1400, '바뀐 원본을 새로 받음');
    assert.notEqual(c.node.blob_hash, a.node.blob_hash);
    // 검증값이 없는 주소(/dup)는 받은 지 하루가 지나면 다시 받는다
    s.db.prepare('UPDATE offline_cache SET created_at=? WHERE name=?').run(now() - 2 * DAY, '샘플 dup.bin');
    await fetchAs('/dup');
    assert.equal(files.hits['/dup'], 2);
  });

  await t.test('[A-03] 응답 오류는 실패 사유와 함께 기록, 다시 시도·삭제·완료 지우기', async () => {
    const { api } = premium();
    const r = await api.post('/api/offline/tasks', { urls: [`${files.url}/missing`] });
    const task = await waitTask(api, r.body.tasks[0].id);
    assert.equal(task.status, 'error');
    assert.equal(task.error, 'http_error');
    const retry = await api.post(`/api/offline/tasks/${task.id}/retry`);
    assert.equal(retry.status, 200);
    assert.equal((await waitTask(api, task.id)).status, 'error');
    const ok = await api.post('/api/offline/tasks', { urls: [`${files.url}/clear`] });
    await waitTask(api, ok.body.tasks[0].id);
    const cleared = await api.post('/api/offline/tasks/clear', { status: 'done' });
    assert.equal(cleared.body.deleted, 1);
    assert.equal((await api.del(`/api/offline/tasks/${task.id}`)).status, 200);
    assert.equal((await api.get('/api/offline/tasks')).body.tasks.length, 0);
  });

  await t.test('[A-01] 마그넷 링크 여러 개(줄바꿈) 생성, 잘못된 마그넷은 거절', async () => {
    const { u, api } = premium();
    const bad = await api.post('/api/offline/tasks', { text: 'magnet:?dn=nohash\nftp://example.com/a' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_link');
    const h1 = 'a'.repeat(40);
    const h2 = 'b'.repeat(40);
    // 피어가 없는 마그넷이 실제로 받으러 나가지 않도록 저장 직후 삭제한다
    const r = await api.post('/api/offline/tasks', { text: `magnet:?xt=urn:btih:${h1}&dn=First\nmagnet:?xt=urn:btih:${h2}\nnot a link` });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.invalid, ['not a link']);
    assert.deepEqual(r.body.tasks.map((x) => [x.kind, x.name]), [['magnet', 'First'], ['magnet', h2]]);
    for (const x of r.body.tasks) await api.del(`/api/offline/tasks/${x.id}`);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM offline_tasks WHERE user_id=?').get(u.id).n, 0);
  });

  await t.test('[A-05] 무료는 하루 3회, 초과하면 403 cloud_limit', async () => {
    const u = createUser(s.db);
    const api = client(s.url, sessionFor(s.db, u.id));
    const allow = await api.get('/api/offline/allowance');
    assert.equal(allow.body.remaining, 3);
    // [A-01] 남은 횟수보다 많이 넣으면 하나도 만들지 않고 몇 개까지 되는지 알려 준다
    const five = await api.post('/api/offline/tasks', { urls: [1, 2, 3, 4, 5].map((i) => `${files.url}/five${i}`) });
    assert.deepEqual([five.status, five.body.error], [403, 'cloud_limit']);
    assert.match(five.body.message, /3회/);
    assert.equal((await api.get('/api/offline/allowance')).body.remaining, 3);
    const r = await api.post('/api/offline/tasks', { urls: [`${files.url}/f1`, `${files.url}/f2`, `${files.url}/f3`] });
    assert.equal(r.status, 201);
    assert.equal(r.body.allowance.remaining, 0);
    const over = await api.post('/api/offline/tasks', { urls: [`${files.url}/f4`] });
    assert.equal(over.status, 403);
    assert.equal(over.body.error, 'cloud_limit');
    // [A-01] 만들 수 없는 요청이면 .torrent 주소를 미리 받으러 나가지 않는다
    const torrents = Array.from({ length: 5 }, (_, i) => `${files.url}/pre${i}.torrent`);
    const pre = await api.post('/api/offline/tasks', { urls: torrents });
    assert.deepEqual([pre.status, pre.body.error], [403, 'cloud_limit']);
    const p = premium();
    const nf = await p.api.post('/api/offline/tasks', { urls: torrents, parentId: 'f_nonexistent' });
    assert.deepEqual([nf.status, nf.body.error], [404, 'not_found']);
    assert.equal(Object.keys(files.hits).filter((k) => k.startsWith('/pre')).length, 0, '원본 서버에 요청하지 않음');
    for (const x of r.body.tasks) await waitTask(api, x.id);
  });

  await t.test('[A-05][F-05] 다시 시도도 월 쿼터·연결 앱 상한을 확인', async () => {
    const { u, api } = premium();
    const r = await api.post('/api/offline/tasks', { urls: [`${files.url}/missing-quota`] });
    const task = await waitTask(api, r.body.tasks[0].id);
    assert.equal(task.status, 'error');
    const { month } = periodKeys();
    const use = s.db.prepare("INSERT INTO quota_usage (user_id, period, kind, source, amount) VALUES (?, ?, 'cloud', ?, ?)");
    // 연결 앱 상한만 채움 → 앱 토큰으로 다시 시도는 거절, 공식 웹은 허용
    use.run(u.id, month, 'app', Math.floor(MONTHLY_QUOTA.cloud * APP_QUOTA_SHARE));
    const app = client(s.url, createToken(s.db, u.id, { name: 'app', scopes: ['services'] }).token);
    const viaApp = await app.post(`/api/offline/tasks/${task.id}/retry`);
    assert.deepEqual([viaApp.status, viaApp.body.error], [403, 'app_quota']);
    assert.equal((await api.post(`/api/offline/tasks/${task.id}/retry`)).status, 200);
    await waitTask(api, task.id);
    // 월 쿼터를 다 쓰면 웹에서도 거절
    use.run(u.id, month, 'official', 1e15);
    const viaWeb = await api.post(`/api/offline/tasks/${task.id}/retry`);
    assert.deepEqual([viaWeb.status, viaWeb.body.error], [403, 'monthly_quota']);
  });

  await t.test('[A-05] 동시 작업 수: 무료 1개·프리미엄 5개, 나머지는 대기', async () => {
    const free = createUser(s.db);
    const fapi = client(s.url, sessionFor(s.db, free.id));
    const fr = await fapi.post('/api/offline/tasks', { urls: [`${files.url}/slow1`, `${files.url}/slow2`] });
    await waitFor(async () => (await fapi.get('/api/offline/tasks?status=running')).body.tasks.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    const st = (await fapi.get('/api/offline/tasks')).body.tasks.map((x) => x.status).sort();
    assert.deepEqual(st, ['queued', 'running']);
    const { api } = premium();
    const links = Array.from({ length: 6 }, (_, i) => `${files.url}/slowp${i}`);
    await api.post('/api/offline/tasks', { urls: links });
    await waitFor(async () => (await api.get('/api/offline/tasks?status=running')).body.tasks.length === 5);
    assert.equal((await api.get('/api/offline/tasks?status=queued')).body.tasks.length, 1);
    // 진행 중 작업 삭제 = 취소. 빈자리로 대기 작업이 들어간다
    const running = (await fapi.get('/api/offline/tasks?status=running')).body.tasks[0];
    await fapi.del(`/api/offline/tasks/${running.id}`);
    await waitFor(async () => (await fapi.get('/api/offline/tasks?status=running')).body.tasks.some((x) => x.id !== running.id));
    assert.ok(fr.body.tasks.length === 2);
    // 다음 테스트를 위해 느린 작업 정리
    for (const a of [fapi, api]) for (const x of (await a.get('/api/offline/tasks')).body.tasks) await a.del(`/api/offline/tasks/${x.id}`);
  });

  await t.test('[A-05] 한 사용자가 대기 작업을 잔뜩 쌓아도 다른 사용자 작업은 시작됨', async () => {
    const hog = premium();
    const ins = s.db.prepare("INSERT INTO offline_tasks (id, user_id, kind, source, name, status, cache_key, created_at, updated_at) VALUES (?,?,'url',?,?,'queued',?,?,?)");
    const t0 = now() - 60_000; // 다른 사용자 작업보다 먼저 쌓인 600개
    tx(s.db, () => {
      for (let i = 0; i < 600; i++) ins.run(newId('ot_'), hog.u.id, `${files.url}/slowhog${i}`, `h${i}`, `url:hog${i}`, t0 + i, t0 + i);
    });
    const other = createUser(s.db);
    const oapi = client(s.url, sessionFor(s.db, other.id));
    const r = await oapi.post('/api/offline/tasks', { urls: [`${files.url}/fair`] });
    const task = await waitTask(oapi, r.body.tasks[0].id, undefined, 5000);
    assert.equal(task.status, 'done');
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM offline_tasks WHERE user_id=? AND status='running'").get(hog.u.id).n, 5);
    s.db.prepare("DELETE FROM offline_tasks WHERE user_id=? AND status='queued'").run(hog.u.id);
    for (const x of (await hog.api.get('/api/offline/tasks')).body.tasks) await hog.api.del(`/api/offline/tasks/${x.id}`);
  });

  await t.test('[A-01] 연결 앱 권한: services 로 만들고 보기, files:write 만으로는 만들 수 없음', async () => {
    const u = createUser(s.db, { premium: true });
    const tok = (scopes) => client(s.url, createToken(s.db, u.id, { name: 'test', scopes }).token);
    const svc = tok(['services']);
    const made = await svc.post('/api/offline/tasks', { urls: [`${files.url}/scope`] });
    assert.equal(made.status, 201);
    assert.equal((await svc.get('/api/offline/tasks')).status, 200);
    assert.equal((await svc.get(`/api/offline/tasks/${made.body.tasks[0].id}`)).status, 200);
    const w = tok(['files:write']);
    assert.equal((await w.post('/api/offline/tasks', { urls: [`${files.url}/scope2`] })).status, 403);
    assert.equal((await w.post(`/api/offline/tasks/${made.body.tasks[0].id}/retry`)).status, 403);
    assert.equal((await w.del(`/api/offline/tasks/${made.body.tasks[0].id}`)).status, 403);
    assert.equal((await tok(['files:read']).get('/api/offline/allowance')).status, 200);
    await waitTask(svc, made.body.tasks[0].id);
  });

  await t.test('[A-05] 서버 재시작 시 진행 중 작업은 대기열로 돌아감', () => {
    const u = createUser(s.db);
    const id = newId('ot_');
    s.db
      .prepare("INSERT INTO offline_tasks (id, user_id, kind, source, name, status, cache_key, created_at, updated_at) VALUES (?,?,'url','http://x','x','running','url:x',?,?)")
      .run(id, u.id, now(), now());
    requeueStale(s.db);
    assert.equal(s.db.prepare('SELECT status FROM offline_tasks WHERE id=?').get(id).status, 'queued');
    s.db.prepare('DELETE FROM offline_tasks WHERE id=?').run(id);
  });

  const queueTask = (userId, p) => {
    const id = newId('ot_');
    s.db
      .prepare("INSERT INTO offline_tasks (id, user_id, kind, source, name, status, cache_key, created_at, updated_at) VALUES (?,?,'url',?,'q','queued',?,?,?)")
      .run(id, userId, files.url + p, 'url:' + p, now(), now());
    kick(s.ctx);
    return id;
  };
  const taskRow = (id) => s.db.prepare('SELECT * FROM offline_tasks WHERE id=?').get(id);

  await t.test('[F-01] 만든 뒤 월 쿼터를 다 쓰면 아직 시작하지 않은 작업은 monthly_quota 로 끝남', async () => {
    const { u } = premium();
    addUsage(s.db, u.id, 'cloud', MONTHLY_QUOTA.cloud);
    const id = queueTask(u.id, '/f01-late');
    await waitFor(() => taskRow(id).status === 'error');
    assert.equal(taskRow(id).error, 'monthly_quota');
    assert.equal(files.hits['/f01-late'], undefined);
  });

  await t.test('[A-05] 탈퇴 신청·정지 계정: 받던 작업은 저장하지 않고, 대기 작업은 계정이 돌아올 때까지 시작하지 않음', async () => {
    const u = createUser(s.db);
    const api = client(s.url, sessionFor(s.db, u.id));
    const setStatus = (st) => s.db.prepare('UPDATE users SET status=? WHERE id=?').run(st, u.id);
    const r = await api.post('/api/offline/tasks', { urls: [`${files.url}/gate-acct`] });
    const id = r.body.tasks[0].id;
    await waitFor(() => taskRow(id).downloaded > 0); // 받는 중(원본 서버가 응답을 붙잡고 있음)
    setStatus('pending_delete');
    files.release();
    await waitFor(() => taskRow(id).status === 'error');
    assert.equal(taskRow(id).error, 'account_unavailable');
    assert.equal(listChildren(s.db, u.id, null).length, 0);
    assert.equal(s.db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind='offline'").get(u.id), undefined);
    setStatus('suspended');
    const q = queueTask(u.id, '/acct-later');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(taskRow(q).status, 'queued');
    setStatus('active');
    kick(s.ctx);
    await waitFor(() => taskRow(q).status === 'done');
  });

  await t.test('[A-08] 차단 목록(도메인·URL·infohash)은 저장 거부, 이의제기 → 관리자 해제', async () => {
    const { u, api } = premium();
    const add = (kind, value) => s.db.prepare('INSERT INTO blocklist (id, kind, value, reason, created_at) VALUES (?,?,?,?,?)').run(newId('b_'), kind, value, '테스트', now());
    add('url', `${files.url}/blocked-url`);
    add('infohash', 'c'.repeat(40));
    const before = (await api.get('/api/offline/allowance')).body;
    const r = await api.post('/api/offline/tasks', { urls: [`${files.url}/blocked-url`, `magnet:?xt=urn:btih:${'C'.repeat(40)}`] });
    assert.deepEqual(r.body.tasks.map((x) => x.status), ['blocked', 'blocked']);
    assert.deepEqual(r.body.allowance, before);
    // '#조각'·빈 '?'·쿼리를 붙여도 같은 파일이므로 차단
    const bypass = await api.post('/api/offline/tasks', { urls: ['#x', '?', '?x=1', '?#y'].map((sfx) => `${files.url}/blocked-url${sfx}`) });
    assert.deepEqual(bypass.body.tasks.map((x) => x.status), ['blocked', 'blocked', 'blocked', 'blocked']);
    // 도메인 차단: 127.0.0.1 대신 localhost 로 같은 서버를 부른다
    add('domain', 'localhost');
    const local = files.url.replace('127.0.0.1', 'localhost');
    const d = await api.post('/api/offline/tasks', { urls: [`${local}/blocked-domain`] });
    assert.equal(d.body.tasks[0].status, 'blocked');
    assert.equal(files.hits['/blocked-url'], undefined);

    const task = r.body.tasks[0];
    assert.equal((await api.post(`/api/offline/tasks/${task.id}/appeal`, { reason: '' })).status, 400);
    const ap = await api.post(`/api/offline/tasks/${task.id}/appeal`, { reason: '제가 직접 올린 공개 자료입니다' });
    assert.equal(ap.status, 201);
    assert.equal((await api.post(`/api/offline/tasks/${task.id}/appeal`, { reason: '다시 요청' })).status, 409);
    assert.equal((await api.get('/api/admin/offline/appeals')).status, 403);
    const admin = createUser(s.db, { admin: true });
    const aapi = client(s.url, sessionFor(s.db, admin.id));
    const list = await aapi.get('/api/admin/offline/appeals?status=open');
    const mine = list.body.appeals.find((x) => x.taskId === task.id);
    assert.equal(mine.block.kind, 'url');
    const res = await aapi.post(`/api/admin/offline/appeals/${mine.id}/resolve`, { action: 'unblock' });
    assert.equal(res.body.status, 'accepted');
    const done = await waitTask(api, task.id, ['done', 'error']);
    assert.equal(done.status, 'done');
    assert.ok(s.db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind='offline_appeal'").get(u.id));
    // 반려하면 차단 유지
    const ap2 = await api.post(`/api/offline/tasks/${r.body.tasks[1].id}/appeal`, { reason: '확인 부탁드립니다' });
    await aapi.post(`/api/admin/offline/appeals/${ap2.body.appeal.id}/resolve`, { action: 'reject' });
    assert.equal((await api.get(`/api/offline/tasks/${r.body.tasks[1].id}`)).body.task.status, 'blocked');
    assert.equal((await api.get(`/api/offline/tasks/${r.body.tasks[1].id}`)).body.task.appeal, 'rejected');
  });

  await t.test('[A-08] .torrent 주소·리다이렉트·다시 시도도 차단 목록을 확인', async () => {
    // 앞 테스트에서 도메인 localhost 가 차단되어 있다
    const { api } = premium();
    const local = files.url.replace('127.0.0.1', 'localhost');
    const r = await api.post('/api/offline/tasks', { urls: [`${local}/x.torrent`, `${files.url}/redir.torrent`] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.tasks.map((x) => [x.kind, x.status, x.source]), [
      ['torrent', 'blocked', `${local}/x.torrent`],
      ['torrent', 'blocked', `${files.url}/redir.torrent`],
    ]);
    assert.equal(files.hits['/x.torrent'], undefined, '차단된 곳에서 .torrent 를 받지 않음');
    assert.equal(files.hits['/target.torrent'], undefined);

    // 파일 주소도 리다이렉트 단계마다 확인 → 차단으로 기록, 이의제기 가능
    const d = await api.post('/api/offline/tasks', { urls: [`${files.url}/redir`] });
    const dt = await waitTask(api, d.body.tasks[0].id);
    assert.equal(dt.status, 'blocked');
    assert.equal(files.hits['/target'], undefined);
    assert.ok(s.db.prepare('SELECT block_id FROM offline_tasks WHERE id=?').get(dt.id).block_id);
    assert.equal((await api.post(`/api/offline/tasks/${dt.id}/appeal`, { reason: '리다이렉트 확인 부탁' })).status, 201);

    // 실패한 뒤 차단된 링크는 다시 시도해도 받지 않음
    const later = `${files.url}/missing-later`;
    const m = await api.post('/api/offline/tasks', { urls: [later] });
    assert.equal((await waitTask(api, m.body.tasks[0].id)).error, 'http_error');
    addBlock('url', later);
    await api.post(`/api/offline/tasks/${m.body.tasks[0].id}/retry`);
    const mt = await waitTask(api, m.body.tasks[0].id);
    assert.equal(mt.status, 'blocked');
    assert.equal(files.hits['/missing-later'], 1);
  });

  await t.test('[A-08] %인코딩·대소문자·겹친 / 로 바꿔 써도 차단된 주소는 차단', async () => {
    const { api } = premium();
    addBlock('url', `${files.url}/Bad-File.bin`);
    addBlock('url', `${files.url}/movie2.mp4`);
    addBlock('url', `${files.url}/%ED%95%9C.mp4`);
    const paths = ['/Bad%2DFile.bin', '/bad-file.bin', '//Bad-File.bin', '/Bad-File.bin?x=1', '/m%6Fvie2.mp4', '/%ed%95%9c.mp4', '/한.mp4'];
    const r = await api.post('/api/offline/tasks', { urls: paths.map((p) => files.url + p) });
    assert.deepEqual(r.body.tasks.map((x) => x.status), paths.map(() => 'blocked'));
    assert.deepEqual(Object.keys(files.hits).filter((k) => /bad-file|movie2|%ED/i.test(k)), []);
    // 다른 파일까지 막지는 않는다
    assert.equal(findBlock(s.db, null, `${files.url}/Bad-File.bin2`), null);
    assert.equal(findBlock(s.db, null, `${files.url}/movie2.mp4/x`), null);
  });

  await t.test('[A-08] 이의제기로 풀리면 같은 차단에 막힌 작업을 모두 다시 받고, 만들 때 안 쓴 무료 횟수를 그때 쓴다', async () => {
    const src = `${files.url}/lifted`;
    const bid = addBlock('url', src);
    const free = () => {
      const u = createUser(s.db);
      return { u, api: client(s.url, sessionFor(s.db, u.id)) };
    };
    const [a, b, c] = [free(), free(), free()];
    const ra = await a.api.post('/api/offline/tasks', { urls: [src, `${src}?utm=1`] });
    const rb = await b.api.post('/api/offline/tasks', { urls: [src] });
    const rc = await c.api.post('/api/offline/tasks', { urls: [src] });
    for (const r of [ra, rb, rc]) assert.deepEqual([...new Set(r.body.tasks.map((x) => x.status))], ['blocked']);
    assert.equal(ra.body.allowance.remaining, 3);
    addUsage(s.db, c.u.id, 'cloud_count', 3); // c 는 풀리기 전에 오늘 횟수를 다 씀
    const ap = await a.api.post(`/api/offline/tasks/${ra.body.tasks[0].id}/appeal`, { reason: '공개 자료입니다' });
    await adminApi().post(`/api/admin/offline/appeals/${ap.body.appeal.id}/resolve`, { action: 'unblock' });
    assert.equal(s.db.prepare('SELECT 1 FROM blocklist WHERE id=?').get(bid), undefined);
    for (const x of ra.body.tasks) assert.equal((await waitTask(a.api, x.id)).status, 'done');
    assert.equal((await waitTask(b.api, rb.body.tasks[0].id)).status, 'done');
    assert.equal((await a.api.get('/api/offline/allowance')).body.remaining, 1);
    assert.equal((await b.api.get('/api/offline/allowance')).body.remaining, 2);
    // 횟수가 없으면 시작하지 않고 cloud_limit 로 남는다. 다시 시도할 때 횟수를 확인한다
    const ct = await waitTask(c.api, rc.body.tasks[0].id);
    assert.deepEqual([ct.status, ct.error], ['error', 'cloud_limit']);
    const retry = await c.api.post(`/api/offline/tasks/${ct.id}/retry`);
    assert.deepEqual([retry.status, retry.body.error], [403, 'cloud_limit']);
  });

  await t.test('[A-08] 차단된 파일 해시는 받은 뒤에도 저장하지 않음', async () => {
    const a = premium();
    const r1 = await a.api.post('/api/offline/tasks', { urls: [`${files.url}/hash`] });
    await waitTask(a.api, r1.body.tasks[0].id);
    const hash = s.db.prepare("SELECT blob_hash FROM files WHERE user_id=? AND kind='file'").get(a.u.id).blob_hash;
    s.db.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES (?, 'blob', ?, ?)").run(newId('b_'), hash, now());
    const b = premium();
    const r2 = await b.api.post('/api/offline/tasks', { urls: [`${files.url}/hash`] });
    const task = await waitTask(b.api, r2.body.tasks[0].id);
    assert.equal(task.status, 'blocked');
    assert.equal(task.error, 'blocked_file');
    assert.equal(listChildren(s.db, b.u.id, null).length, 0);
  });

  await t.test('[A-04] SNS 링크는 social 로 분류, yt-dlp 가 없으면 횟수를 쓰지 않고 안내 오류', async () => {
    const u = createUser(s.db);
    const api = client(s.url, sessionFor(s.db, u.id));
    assert.equal((await api.get('/api/offline/allowance')).body.social, false);
    const r = await api.post('/api/offline/tasks', { text: 'https://youtu.be/abc123\nhttps://www.tiktok.com/@a/video/1\nhttps://x.com/a/status/1\nhttps://fb.watch/xyz/' });
    assert.deepEqual([r.status, r.body.error], [400, 'social_unavailable']);
    assert.equal((await api.get('/api/offline/allowance')).body.remaining, 3);
    // 다른 링크와 섞이면 SNS 링크만 빼고 만든다
    const mixed = await api.post('/api/offline/tasks', { text: `https://youtu.be/abc123\n${files.url}/with-social` });
    assert.equal(mixed.status, 201);
    assert.deepEqual(mixed.body.tasks.map((x) => x.kind), ['url']);
    assert.deepEqual(mixed.body.invalid, ['https://youtu.be/abc123']);
    assert.equal(mixed.body.allowance.remaining, 2);
    await waitTask(api, mixed.body.tasks[0].id);
    // 만든 뒤 yt-dlp 가 사라진 작업(여기서는 실패 상태로 직접 넣음)은 실행할 때 안내 오류
    const id = newId('ot_');
    s.db
      .prepare("INSERT INTO offline_tasks (id, user_id, kind, source, name, status, cache_key, created_at, updated_at) VALUES (?,?,'social','https://youtu.be/gone','gone','error','url:gone',?,?)")
      .run(id, u.id, now(), now());
    assert.equal((await api.post(`/api/offline/tasks/${id}/retry`)).status, 200);
    const task = await waitTask(api, id);
    assert.equal(task.error, 'social_unavailable');
    // PATH 에서 yt-dlp 찾기
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
    const bin = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    fs.writeFileSync(bin, '');
    assert.equal(findYtDlp({ PATH: ['nowhere', dir].join(path.delimiter) }), bin);
    assert.equal(findYtDlp({ PATH: '' }), null);
    // 운영(launchd 처럼 PATH 가 짧은 환경)은 YTDLP_PATH 로 지정
    assert.equal(ytDlpPath({}, { YTDLP_PATH: '/opt/homebrew/bin/yt-dlp', PATH: '' }), '/opt/homebrew/bin/yt-dlp');
    assert.equal(ytDlpPath({ ytDlp: null }, { YTDLP_PATH: '/opt/homebrew/bin/yt-dlp' }), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('[A-04] yt-dlp 실행: 진행률·크기·속도 읽기, 받은 파일을 드라이브에 저장', async () => {
    assert.deepEqual(parseYtDlpProgress('[download]  45.3% of ~  12.00MiB at    1.50MiB/s ETA 00:05'), { pct: 45.3, size: 12 * 1024 * 1024, speed: 1.5 * 1024 * 1024 });
    assert.deepEqual(parseYtDlpProgress('[download]  10.0% of 2.00KiB at Unknown B/s'), { pct: 10, size: 2048, speed: null });
    assert.equal(parseYtDlpProgress('[youtube] abc: Downloading webpage'), null);
    // 가짜 yt-dlp: -o 경로 틀에 파일을 쓰고 진행 줄을 찍는다. 주소 끝으로 재생목록(…/videos)·멈춤(hang)·용량 초과(big)를 흉내 낸다
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
    const script = path.join(dir, 'fake-yt-dlp.cjs');
    fs.writeFileSync(
      script,
      `const fs = require('fs');
const a = process.argv.slice(2);
const arg = (k) => a[a.indexOf(k) + 1];
if (a.at(-2) !== '--' || !a.includes('--no-playlist') || !a.includes('--ignore-config') || arg('--use-extractors') !== 'default,-generic' || arg('--playlist-items') !== '1:4' || arg('--max-downloads') !== '4') process.exit(3);
const url = a.at(-1);
const out = (id) => arg('-o').replace('%(title).120B', 'clip').replace('%(id)s', id).replace('%(ext)s', 'mp4');
if (url.endsWith('/videos')) {
  for (let i = 0; i < Number(arg('--max-downloads')); i++) fs.writeFileSync(out('p' + i), Buffer.alloc(1024, i));
  process.exit(101); // --max-downloads 에 닿음
} else if (url.endsWith('/hang')) {
  for (let i = 0; i < 3; i++) fs.writeFileSync(out('h' + i), Buffer.alloc(4096, i));
  setInterval(() => {}, 1000);
} else if (url.endsWith('/big')) {
  console.log('[download] File is larger than max-filesize (999999 bytes > ' + arg('--max-filesize') + ' bytes). Aborting.');
} else {
  console.log('[download]  50.0% of   2.00KiB at    1.00KiB/s ETA 00:01');
  fs.writeFileSync(out('abc'), Buffer.alloc(2048, 9));
  console.log('[download] 100% of    2.00KiB in 00:00:01 at 2.00KiB/s');
}`,
    );
    s.cfg.ytDlp = [process.execPath, script];
    try {
      const { u, api } = premium();
      assert.equal((await api.get('/api/offline/allowance')).body.social, true);
      const r = await api.post('/api/offline/tasks', { urls: ['https://youtu.be/fake1'] });
      const task = await waitTask(api, r.body.tasks[0].id);
      assert.equal(task.status, 'done', task.error);
      assert.equal(task.size, 2048);
      const [node] = listChildren(s.db, u.id, null);
      assert.equal(node.name, 'clip [abc].mp4');
      assert.equal(node.mime, 'video/mp4');
      assert.equal(node.origin, 'cloud');
      assert.deepEqual(task.fileIds, [node.id]);
      // 재생목록·채널 주소는 앞쪽 4개까지만(종료 코드 101 = 개수 상한에 닿음, 성공)
      const pl = premium();
      const plr = await pl.api.post('/api/offline/tasks', { urls: ['https://www.youtube.com/@mimic/videos'] });
      const plt = await waitTask(pl.api, plr.body.tasks[0].id);
      assert.deepEqual([plt.status, plt.size, listChildren(s.db, pl.u.id, null).length], ['done', 4096, 4], plt.error);
      // 받는 동안 합계가 남은 용량을 넘으면 멈추고, 남은 용량보다 큰 미디어는 storage_full 로 알려 준다
      const free = createUser(s.db);
      createFileNode(s.db, free.id, null, { name: 'filler.bin', size: capacityOf(free) - 5000 });
      const fapi = client(s.url, sessionFor(s.db, free.id));
      for (const link of ['https://youtu.be/hang', 'https://youtu.be/big']) {
        const fr = await fapi.post('/api/offline/tasks', { urls: [link] });
        const ft = await waitTask(fapi, fr.body.tasks[0].id, undefined, 10_000);
        assert.deepEqual([ft.status, ft.error], ['error', 'storage_full'], link);
        assert.ok(!fs.existsSync(path.join(s.dataDir, 'offline', ft.id)), '임시 폴더 정리');
      }
      assert.equal(listChildren(s.db, free.id, null).length, 1);
    } finally {
      s.cfg.ytDlp = null;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('[A-09] BT 스마트 필터: 광고성 하위 파일 판별', () => {
    assert.equal(isLikelyAd({ path: 'Show/Episode01.mkv', length: 900e6 }), false);
    assert.equal(isLikelyAd({ path: 'Show/www.example-site.com.txt', length: 300 }), true);
    assert.equal(isLikelyAd({ path: 'Show/더 많은 자료.url', length: 120 }), true);
    assert.equal(isLikelyAd({ path: 'Show/.pad/1234', length: 1234 }), true);
    assert.equal(isLikelyAd({ path: 'Show/_____padding_file_0_', length: 10 }), true);
    assert.equal(isLikelyAd({ path: 'Show/광고.html', length: 4000 }), true);
    assert.equal(isLikelyAd({ path: 'Show/promo-site.com.mp4', length: 5e6 }), true);
    assert.equal(isLikelyAd({ path: 'Show/Movie.2020-site.com.mp4', length: 2e9 }), false);
    assert.equal(isLikelyAd({ path: 'Show/cover.jpg', length: 200e3 }), false);
    assert.equal(isLikelyAd({ path: 'Show/subs.srt', length: 30e3 }), false);
    const list = [{ path: 'a.mkv', size: 5e8 }, { path: 'b.txt', size: 100 }, { path: '.pad/1', size: 5 }];
    assert.deepEqual(pickFiles(list, true).map((f) => f.path), ['a.mkv']);
    assert.deepEqual(pickFiles(list, false).map((f) => f.path), ['a.mkv', 'b.txt']); // 꺼도 패딩은 저장 안 함
    assert.deepEqual(pickFiles([{ path: 'only.txt', size: 10 }], true).map((f) => f.path), ['only.txt']);
    // 광고 신호 없는 작은 문서는 내용으로 본다: 텍스트 소설·설명서·nfo
    assert.equal(isLikelyAd({ path: 'App/README.txt', length: 3000 }), false);
    assert.equal(isLikelyAd({ path: 'movie.nfo', length: 2000 }), false);
    const novel = [1, 2, 3, 4, 5].map((i) => ({ path: `Novel/chapter0${i}.txt`, size: 40e3 })).concat({ path: 'Novel/cover.jpg', size: 300e3 });
    assert.equal(pickFiles(novel, true).length, 6);
    const app = [{ path: 'App/setup.exe', size: 50e6 }, { path: 'App/README.txt', size: 3000 }, { path: 'App/notes.txt', size: 2000 }];
    assert.deepEqual(pickFiles(app, true).map((f) => f.path), ['App/setup.exe', 'App/README.txt']); // 본 내용보다 아주 작은 부속 문서만 뺌
  });

  await t.test('[A-02] 토렌트 파일 7,000개 초과는 거절', async () => {
    const { api } = premium();
    const info = { name: 'many', 'piece length': 16384, pieces: Buffer.alloc(20), files: Array.from({ length: 7001 }, (_, i) => ({ length: 1, path: [`f${i}`] })) };
    const fd = new FormData();
    fd.append('file', new Blob([bencode.encode({ info })]), 'many.torrent');
    const r = await api.post('/api/offline/torrent', fd);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'too_many_files');
    // BEP 47 패딩 항목은 세지 않는다: 실제 3,600개 + 패딩 3,600개는 받아들임
    const padded = { name: 'hybrid', 'piece length': 16384, pieces: Buffer.alloc(20), files: Array.from({ length: 3600 }, (_, i) => [{ length: 1, path: [`f${i}`] }, { length: 1, path: ['.pad', `${i}`], attr: 'p' }]).flat() };
    const pfd = new FormData();
    pfd.append('file', new Blob([bencode.encode({ info: padded })]), 'hybrid.torrent');
    const ok = await api.post('/api/offline/torrent', pfd);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    await api.del(`/api/offline/tasks/${ok.body.tasks[0].id}`);
    const junk = new FormData();
    junk.append('file', new Blob(['not a torrent']), 'x.torrent');
    assert.equal((await api.post('/api/offline/torrent', junk)).body.error, 'invalid_torrent');
    // 4MB 를 넘는 토렌트는 '올바르지 않음'이 아니라 크기 상한으로 알려 준다(올린 파일·.torrent 주소 모두)
    const huge = bencode.encode({ info: { name: 'huge', 'piece length': 16384, pieces: Buffer.alloc(20 * 220_000), length: 16384 * 220_000 } });
    const hfd = new FormData();
    hfd.append('file', new Blob([huge]), 'huge.torrent');
    const hr = await api.post('/api/offline/torrent', hfd);
    assert.deepEqual([hr.status, hr.body.error], [400, 'torrent_too_large']);
    files.routes['/huge.torrent'] = huge;
    const hu = await api.post('/api/offline/tasks', { urls: [`${files.url}/huge.torrent`] });
    assert.deepEqual([hu.status, hu.body.error], [400, 'torrent_too_large']);
    // 한 번에 20개 초과는 조용히 버리지 않고 거절
    const many = new FormData();
    for (let i = 0; i < 21; i++) many.append('file', new Blob(['x']), `t${i}.torrent`);
    const over = await api.post('/api/offline/torrent', many);
    assert.equal(over.status, 400);
    assert.equal(over.body.error, 'too_many_uploads');
  });

  await t.test('[A-02][A-09][A-06] 로컬 시더의 토렌트 파일로 받기 → 같은 infohash 마그넷은 즉시 완료', { timeout: 90_000 }, async () => {
    const { default: WebTorrent } = await import('webtorrent');
    const { Server: Tracker } = await import('bittorrent-tracker');
    const tracker = new Tracker({ udp: false, ws: false, http: true, stats: false });
    await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
    const seeder = new WebTorrent({ ...BT_OPTS, utp: false });
    t.after(async () => {
      await new Promise((r) => seeder.destroy(() => r()));
      await new Promise((r) => tracker.close(() => r()));
    });
    const named = (buf, name) => Object.assign(buf, { name });
    const input = [named(Buffer.alloc(200_000, 7), 'movie.mkv'), named(Buffer.from('visit our site'), 'www.ads-site.com.txt'), named(Buffer.alloc(3000, 2), 'subs.srt')];
    const seeded = await new Promise((r) => seeder.seed(input, { name: 'Sample Pack', announce: [`http://127.0.0.1:${tracker.http.address().port}/announce`] }, r));

    const { u, api } = premium();
    const folder = createFolder(s.db, u.id, null, '토렌트');
    const fd = new FormData();
    fd.append('parentId', folder.id);
    fd.append('file', new Blob([seeded.torrentFile]), 'sample.torrent');
    const r = await api.post('/api/offline/torrent', fd);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.tasks[0].kind, 'torrent');
    const task = await waitTask(api, r.body.tasks[0].id, ['done', 'error'], 60_000);
    assert.equal(task.status, 'done', task.error);
    const root = listChildren(s.db, u.id, folder.id);
    assert.equal(root.length, 1);
    assert.equal(root[0].name, 'Sample Pack');
    assert.equal(root[0].kind, 'folder');
    assert.equal(task.resultRootId, root[0].id);
    assert.equal(task.resultKind, 'folder');
    assert.deepEqual(listChildren(s.db, u.id, root[0].id).map((f) => f.name).sort(), ['movie.mkv', 'subs.srt']); // 광고 txt 제외
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'offline', task.id)), '임시 폴더 정리');

    // 다른 사용자가 같은 infohash 마그넷 → 받지 않고 즉시 완료
    const b = premium();
    const t0 = Date.now();
    const m = await b.api.post('/api/offline/tasks', { urls: [`magnet:?xt=urn:btih:${seeded.infoHash}&dn=Sample+Pack`] });
    const mt = await waitTask(b.api, m.body.tasks[0].id, ['done', 'error'], 5000);
    assert.equal(mt.status, 'done');
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(listChildren(s.db, b.u.id, null)[0].name, 'Sample Pack');

    // [A-08] 일부 파일만 차단되면 나머지는 저장하고, 뺀 수를 남기고 이의제기할 수 있다
    const subsHash = s.db.prepare("SELECT blob_hash FROM files WHERE user_id=? AND name='subs.srt'").get(u.id).blob_hash;
    const subsBlock = addBlock('blob', subsHash);
    const e = premium();
    const pm = await e.api.post('/api/offline/tasks', { urls: [`magnet:?xt=urn:btih:${seeded.infoHash}`] });
    const pt = await waitTask(e.api, pm.body.tasks[0].id, ['done', 'error', 'blocked'], 5000);
    assert.deepEqual([pt.status, pt.skippedBlocked, pt.skippedAds], ['done', 1, 1]);
    assert.deepEqual(listChildren(s.db, e.u.id, listChildren(s.db, e.u.id, null)[0].id).map((f) => f.name), ['movie.mkv']);
    assert.equal((await e.api.post(`/api/offline/tasks/${pt.id}/appeal`, { reason: '제가 만든 자막입니다' })).status, 201);
    s.db.prepare('DELETE FROM blocklist WHERE id=?').run(subsBlock);

    // 스마트 필터를 끈 사용자는 광고 파일 본문이 없으므로 즉시 완료가 아니라 실제로 받는다(전부 저장)
    const c = premium();
    saveSettings(s.db, c.u.id, { btSmartFilter: false });
    const m2 = await c.api.post('/api/offline/tasks', { urls: [`magnet:?xt=urn:btih:${seeded.infoHash}&tr=${encodeURIComponent(`http://127.0.0.1:${tracker.http.address().port}/announce`)}`] });
    const t2 = await waitTask(c.api, m2.body.tasks[0].id, ['done', 'error'], 60_000);
    assert.equal(t2.status, 'done', t2.error);
    const top = listChildren(s.db, c.u.id, null)[0];
    assert.equal(listChildren(s.db, c.u.id, top.id).length, 3);

    // .torrent 주소: 차단된 동안은 받지 않고 원래 주소를 남김 → 이의제기로 풀리면 그때 받아 진행
    const tUrl = `${files.url}/pack.torrent`;
    files.routes['/pack.torrent'] = seeded.torrentFile;
    addBlock('url', tUrl);
    const d = premium();
    const tr = await d.api.post('/api/offline/tasks', { urls: [tUrl] });
    assert.deepEqual([tr.body.tasks[0].status, tr.body.tasks[0].source], ['blocked', tUrl]);
    assert.equal(files.hits['/pack.torrent'], undefined);
    const ap = await d.api.post(`/api/offline/tasks/${tr.body.tasks[0].id}/appeal`, { reason: '공개 자료입니다' });
    await adminApi().post(`/api/admin/offline/appeals/${ap.body.appeal.id}/resolve`, { action: 'unblock' });
    const dt = await waitTask(d.api, tr.body.tasks[0].id, ['done', 'error'], 60_000);
    assert.equal(dt.status, 'done', dt.error);
    assert.equal(files.hits['/pack.torrent'], 1);
    assert.equal(listChildren(s.db, d.u.id, null)[0].name, 'Sample Pack');
    // [A-06] 받은 .torrent 의 infohash 로 키를 바꿔 마그넷과 같은 즉시 완료·캐시를 쓴다
    assert.equal(s.db.prepare('SELECT cache_key FROM offline_tasks WHERE id=?').get(dt.id).cache_key, `bt:${seeded.infoHash}`);

    // [A-08] URL 차단만 풀려도 .torrent 안의 infohash 가 차단돼 있으면 받지 않는다
    const hx = `${files.url}/hx.torrent`;
    files.routes['/hx.torrent'] = seeded.torrentFile;
    addBlock('url', hx);
    const ih = addBlock('infohash', seeded.infoHash);
    const f = premium();
    const fr = await f.api.post('/api/offline/tasks', { urls: [hx] });
    assert.equal(fr.body.tasks[0].status, 'blocked');
    const fap = await f.api.post(`/api/offline/tasks/${fr.body.tasks[0].id}/appeal`, { reason: '공개 자료입니다' });
    await adminApi().post(`/api/admin/offline/appeals/${fap.body.appeal.id}/resolve`, { action: 'unblock' });
    const ft = await waitTask(f.api, fr.body.tasks[0].id);
    assert.equal(ft.status, 'blocked');
    assert.equal(s.db.prepare('SELECT block_id FROM offline_tasks WHERE id=?').get(ft.id).block_id, ih);
    assert.equal(files.hits['/hx.torrent'], 1);
    assert.equal(listChildren(s.db, f.u.id, null).length, 0);
    s.db.prepare('DELETE FROM blocklist WHERE id=?').run(ih);
  });

  await t.test('[A-05] 받은 데이터가 멈추면 stalled, 피어 없는 마그넷은 no_peers 로 끝나 자리를 비움', async () => {
    s.cfg.offlineStallMs = 500;
    try {
      const { api } = premium();
      const r = await api.post('/api/offline/tasks', { urls: [`${files.url}/slowstall`, `magnet:?xt=urn:btih:${'d'.repeat(40)}`] });
      const [a, b] = await Promise.all(r.body.tasks.map((x) => waitTask(api, x.id)));
      assert.deepEqual([a.status, a.error], ['error', 'stalled']);
      assert.deepEqual([b.status, b.error], ['error', 'no_peers']);
    } finally {
      delete s.cfg.offlineStallMs;
    }
  });

  await t.test('[A-07] 전송 패널 API: 상태별 목록·남은 횟수, 화면 컴포넌트 문법', async () => {
    const u = createUser(s.db);
    const api = client(s.url, sessionFor(s.db, u.id));
    const r = await api.get('/api/offline/tasks?status=active');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tasks, []);
    assert.equal(r.body.allowance.premium, false);
    assert.equal(r.body.allowance.dailyLeft, 3);
    const p = premium();
    assert.equal((await p.api.get('/api/offline/allowance')).body.unlimited, true);
    assert.equal((await client(s.url).get('/api/offline/tasks')).status, 401);
    for (const f of ['web/components/offline.js', 'web/components/transfers.js']) {
      const out = spawnSync(process.execPath, ['--check', path.join(here, '..', f)], { encoding: 'utf8' });
      assert.equal(out.status, 0, out.stderr);
    }
  });

  await t.test('운영 모드에서는 내부망 주소를 받지 않음(SSRF 방지)', async () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('192.168.1.5'), true);
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('8.8.8.8'), false);
    await assert.rejects(assertPublicUrl({ dev: false }, 'http://127.0.0.1:9/x'), { code: 'blocked_address' });
    // [A-02] 마그넷의 tracker·웹 시드·xs·x.pe 로 내부망에 요청하지 않음
    const enc = encodeURIComponent;
    const m = await parseTorrent(
      `magnet:?xt=urn:btih:${'e'.repeat(40)}&tr=${enc('http://127.0.0.1:1/announce')}&tr=${enc('udp://8.8.8.8:80')}&tr=${enc('wss://[::1]:9/x')}&tr=${enc('https://tracker.invalid/announce')}&tr=${enc('http://localhost:1/announce')}&ws=${enc('http://10.0.0.1/f')}&xs=${enc('http://192.168.0.1/t.torrent')}&x.pe=10.0.0.2:6881`,
    );
    assert.ok(m.xs && m.urlList.length && m.peerAddresses.length, '파싱 결과에 위험한 필드가 있음');
    const safe = await stripPrivate({ dev: false }, m);
    assert.deepEqual(safe.announce, ['udp://8.8.8.8:80']);
    assert.deepEqual(safe.urlList, []);
    assert.equal(safe.xs, undefined);
    assert.equal(safe.peerAddresses, undefined);
    // [A-01] http(s) tracker 는 3xx 를 스스로 따라가 내부망으로 넘겨질 수 있어 공인 주소라도 빼고, UDP tracker 만 확인한 IP 로 고정한다
    const lookup0 = dnsPromises.lookup;
    dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    try {
      const pub = await stripPrivate({ dev: false }, await parseTorrent(`magnet:?xt=urn:btih:${'f'.repeat(40)}&tr=${enc('http://tracker.example/announce')}&tr=${enc('udp://tracker.example:6969/announce')}`));
      assert.deepEqual(pub.announce, ['udp://93.184.216.34:6969/announce']);
    } finally {
      dnsPromises.lookup = lookup0;
    }

    // [A-03] DNS rebinding: 미리 따로 조회한 결과가 공인 IP 라도, 연결할 때의 조회 결과로 막는다
    s.db.prepare("DELETE FROM blocklist WHERE kind='domain' AND value='localhost'").run(); // 앞 테스트의 도메인 차단
    const local = files.url.replace('127.0.0.1', 'localhost');
    const prod = { db: s.db, cfg: { dev: false } };
    await assert.rejects(safeFetch(prod, `${local}/ssrf-direct`), { code: 'blocked_address' });
    await assert.rejects(safeFetch(prod, `${files.url}/ssrf-ip`), { code: 'blocked_address' });
    const realLookup = dnsPromises.lookup;
    dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }]; // 검사용 조회만 공인 IP 를 돌려주는 리바인딩 흉내
    const p = await startServer({ dev: false, bt: BT_OPTS, ytDlp: null });
    try {
      const u = createUser(p.db, { premium: true });
      const api = client(p.url, sessionFor(p.db, u.id));
      const r = await api.post('/api/offline/tasks', { urls: [`${local}/ssrf-secret`] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const task = await waitTask(api, r.body.tasks[0].id);
      assert.deepEqual([task.status, task.error], ['error', 'blocked_address']);
      assert.equal(listChildren(p.db, u.id, null).length, 0);
      // [A-01] tracker·DHT·PEX 가 알려 준 내부망·이름 주소 피어에는 연결하지 않는다(IPv6 포함)
      await api.post('/api/offline/tasks', { urls: [`magnet:?xt=urn:btih:${'9'.repeat(40)}`] });
      const bt = await waitFor(() => p.ctx.offline?.client);
      const blocked = (await bt).blocked;
      assert.deepEqual(['10.1.2.3', '192.168.0.9', '::1', '::ffff:127.0.0.1', 'fd00::1', 'peer.local'].map((h) => blocked.contains(h)), [true, true, true, true, true, true]);
      assert.deepEqual(['8.8.8.8', '2001:4860:4860::8888'].map((h) => blocked.contains(h)), [false, false]);
    } finally {
      dnsPromises.lookup = realLookup;
      await p.close();
    }
    assert.equal(Object.keys(files.hits).filter((k) => k.startsWith('/ssrf')).length, 0, '내부 서버에 요청이 닿지 않음');
  });
});
