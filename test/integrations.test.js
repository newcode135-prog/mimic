import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { createToken } from '../server/core/auth.js';
import { createFolder, createFileNode } from '../server/core/files.js';
import { addUsage, summary } from '../server/core/quota.js';
import { MONTHLY_QUOTA, APP_QUOTA_SHARE, capacityOf } from '../server/core/plans.js';

const BASE = 'https://mimic.test'; // cfg.baseUrl: 설치 파일·MCP 주소는 Host 헤더가 아니라 이 값을 쓴다

const cli = path.join(import.meta.dirname, '..', 'cli', 'mimic.js');

test('integrations: 설정·토큰·연결 앱·WebDAV·MCP·텔레그램·확장·CLI', async (t) => {
  // offline·share 모듈 대신 받는 로컬 대역 서버
  const calls = [];
  const stub = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tasks: [{ id: 'task_1', status: 'queued' }] }));
    });
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  const s = await startServer({ baseUrl: BASE, botSecret: 'bot-secret', internalApiBase: `http://127.0.0.1:${stub.address().port}` });
  t.after(async () => {
    await s.close();
    stub.close();
  });
  const free = createUser(s.db, { phone: '+821011112222' });
  const prem = createUser(s.db, { premium: true, phone: '+821033334444' });
  const web = client(s.url, sessionFor(s.db, free.id));
  const pweb = client(s.url, sessionFor(s.db, prem.id));
  const outboxCount = () => s.db.prepare('SELECT COUNT(*) n FROM outbox').get().n;

  await t.test('[K-07] 설정: 기본값, 허용된 키만 저장, lang 은 users.lang 도 갱신', async () => {
    const g = await web.get('/api/integrations/settings');
    assert.equal(g.status, 200);
    assert.equal(g.body.settings.uploadConcurrency, 3);
    assert.equal(g.body.settings.appFilesFolder, true);
    // drive 가 값이 없을 때 쓰는 기본(폴더마다)과 같다
    assert.equal(g.body.settings.sortScope, 'folder');
    assert.equal(g.body.settings.viewScope, 'folder');
    const p = await web.put('/api/integrations/settings', { lang: 'en', uploadConcurrency: 2, shareCodeDisplay: 'warn', sortScope: 'folder' });
    assert.equal(p.status, 200);
    assert.equal(p.body.settings.uploadConcurrency, 2);
    assert.equal(s.db.prepare('SELECT lang FROM users WHERE id=?').get(free.id).lang, 'en');
    assert.equal((await web.put('/api/integrations/settings', { hacker: 1 })).status, 400);
    // [B-06] 동시 업로드는 최대 3개
    assert.equal((await web.put('/api/integrations/settings', { uploadConcurrency: 4 })).status, 400);
    assert.equal((await web.put('/api/integrations/settings', { uploadConcurrency: 9 })).status, 400);
    assert.equal((await web.put('/api/integrations/settings', { shareDefaultView: 'table' })).status, 400);
    const w = await web.put('/api/integrations/settings', { webdavEnabled: true });
    assert.equal(w.status, 403);
    assert.equal(w.body.error, 'premium_required');
    // Object.prototype 이름으로 허용 키 검사를 빠져나갈 수 없다
    for (const raw of ['{"constructor":"x"}', '{"toString":"junk"}', '{"valueOf":{"big":1}}', '{"propertyIsEnumerable":"lang"}', '{"__proto__":1}']) {
      const r = await web.put('/api/integrations/settings', raw, { 'content-type': 'application/json' });
      assert.equal(r.status, 400, raw);
      assert.equal(r.body.error, 'unknown_setting', raw);
    }
    const saved = JSON.parse(s.db.prepare('SELECT settings FROM users WHERE id=?').get(free.id).settings);
    assert.deepEqual(Object.keys(saved).sort(), ['shareCodeDisplay', 'sortScope', 'uploadConcurrency']);
  });

  let patId;
  let patToken;
  await t.test('[G-04] 개인 액세스 토큰: 1회 노출, 만료 30~365일, 영구삭제·초대 권한 불가, 이메일 알림, 폐기 즉시 반영', async () => {
    const before = outboxCount();
    const r = await web.post('/api/integrations/tokens', { name: '백업 스크립트', scopes: ['files:read', 'services'] });
    assert.equal(r.status, 201);
    assert.match(r.body.token, /^mp_/);
    assert.ok(Math.abs(r.body.expiresAt - Date.now() - 90 * 864e5) < 60_000, '기본 90일');
    assert.equal(outboxCount(), before + 1, '생성 알림 발송');
    patId = r.body.id;
    patToken = r.body.token;
    const list = await web.get('/api/integrations/tokens');
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].token, undefined, '목록에는 원문이 없음');
    assert.ok(!JSON.stringify(list.body).includes(patToken));
    for (const days of [10, 400, 0, null]) assert.equal((await web.post('/api/integrations/tokens', { name: 'x', scopes: ['files:read'], days })).status, 400, `days=${days}`);
    assert.equal((await web.post('/api/integrations/tokens', { name: 'x', scopes: ['files:delete'] })).body.error, 'scope_not_allowed');
    assert.equal((await web.post('/api/integrations/tokens', { name: 'x', scopes: ['account'] })).body.error, 'scope_not_allowed');
    const tok = client(s.url, patToken);
    assert.equal((await tok.get('/api/me')).status, 200);
    assert.equal((await tok.post('/api/integrations/tokens', { name: 'y', scopes: ['files:read'] })).status, 403, '토큰으로 토큰을 만들 수 없음');
    assert.equal((await web.del(`/api/integrations/tokens/${patId}`)).status, 200);
    assert.equal((await tok.get('/api/me')).status, 401, '폐기 즉시 사용 불가');
    assert.equal((await web.del(`/api/integrations/tokens/${patId}`)).status, 404);
  });

  await t.test('[G-05] 권한 6단계: 상위 권한 포함, 계정 권한 없는 토큰은 설정 접근 불가', async () => {
    const { token } = createToken(s.db, free.id, { name: 'manage', scopes: ['files:manage'] });
    const c = client(s.url, token);
    assert.equal((await c.get('/api/integrations/settings')).status, 403);
    const { token: acc } = createToken(s.db, free.id, { name: 'acc', scopes: ['account'] });
    assert.equal((await client(s.url, acc).get('/api/integrations/settings')).status, 200);
  });

  // 실제 차단은 drive 모듈 라우트가 한다. 모듈이 없으면(동시 개발 중) 건너뛴다
  await t.test('[G-04] 토큰에 줄 수 있는 최고 권한(files:manage)으로도 영구삭제·휴지통 비우기 불가', { skip: !s.ctx.modules.drive && 'drive 모듈 없음' }, async () => {
    const r = await web.post('/api/integrations/tokens', { name: 'manage', scopes: ['files:manage'] });
    assert.equal(r.status, 201);
    const c = client(s.url, r.body.token);
    const f = createFileNode(s.db, free.id, null, { name: 'trashed.txt', size: 0 });
    s.db.prepare('UPDATE files SET trashed_at=?, trash_root=1 WHERE id=?').run(Date.now(), f.id);
    assert.equal((await c.post('/api/drive/delete-forever', { ids: [f.id] })).status, 403);
    assert.equal((await c.post('/api/drive/trash/empty', {})).status, 403);
    assert.ok(s.db.prepare('SELECT 1 FROM files WHERE id=?').get(f.id), '휴지통 항목이 그대로 남음');
    assert.equal((await c.post('/api/drive/restore', { ids: [f.id] })).status, 200, '휴지통 복원은 관리 권한으로 가능');
  });

  let mcpToken;
  const mcp = async (token, method, params, id = 1) => {
    const r = await fetch(`${s.url}/api/integrations/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return { status: r.status, body: await r.json() };
  };
  await t.test('[G-03] MCP: 연결 토큰·설정 JSON, initialize·tools/list·tools/call, 권한 검사', async () => {
    const con = await web.post('/api/integrations/mcp/connect', { client: 'Claude' }, { host: 'evil.example' });
    assert.equal(con.status, 201);
    assert.equal(con.body.endpoint, `${BASE}/api/integrations/mcp`, 'Host 헤더가 아닌 설정 주소');
    assert.equal(con.body.config.mcpServers.mimic.headers.Authorization, `Bearer ${con.body.token}`);
    // Claude Desktop(Windows)·Cursor 는 args 의 공백을 이스케이프하지 않는다: 공백 없는 헤더 인자 + env
    const desk = con.body.claudeDesktop.mcpServers.mimic;
    assert.ok(desk.args.every((a) => !a.includes(' ')), JSON.stringify(desk.args));
    assert.ok(desk.args.includes('Authorization:${AUTH_HEADER}'));
    assert.equal(desk.env.AUTH_HEADER, `Bearer ${con.body.token}`);
    mcpToken = con.body.token;
    const init = await mcp(mcpToken, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'mimic');
    const list = await mcp(mcpToken, 'tools/list', {});
    const names = list.body.result.tools.map((x) => x.name).sort();
    assert.deepEqual(names, ['add_cloud_download', 'create_folder', 'create_share_link', 'get_file_info', 'get_quota', 'list_files', 'list_tasks', 'move_files', 'rename_file', 'restore_files', 'search_files', 'trash_files']);
    const made = await mcp(mcpToken, 'tools/call', { name: 'create_folder', arguments: { name: 'AI 폴더' } });
    assert.ok(!made.body.result.isError, JSON.stringify(made.body));
    const folder = JSON.parse(made.body.result.content[0].text);
    assert.equal(folder.name, 'AI 폴더');
    const ls = await mcp(mcpToken, 'tools/call', { name: 'list_files', arguments: {} });
    assert.ok(JSON.parse(ls.body.result.content[0].text).items.some((x) => x.id === folder.id));
    const found = await mcp(mcpToken, 'tools/call', { name: 'search_files', arguments: { query: 'AI' } });
    assert.equal(JSON.parse(found.body.result.content[0].text).items[0].id, folder.id);
    const dl = await mcp(mcpToken, 'tools/call', { name: 'add_cloud_download', arguments: { urls: ['magnet:?xt=urn:btih:abc'], parentId: folder.id } });
    assert.ok(!dl.body.result.isError, JSON.stringify(dl.body));
    const call = calls.at(-1);
    assert.equal(call.url, '/api/offline/tasks');
    assert.equal(call.auth, `Bearer ${mcpToken}`);
    assert.deepEqual(call.body, { urls: ['magnet:?xt=urn:btih:abc'], parentId: folder.id });
    await mcp(mcpToken, 'tools/call', { name: 'create_share_link', arguments: { fileIds: [folder.id], expiryDays: 7 } });
    assert.equal(calls.at(-1).url, '/api/share');
    assert.deepEqual(calls.at(-1).body, { fileIds: [folder.id], expiryDays: 7 });
    const { token: ro } = createToken(s.db, free.id, { name: 'ro', scopes: ['files:read'], appId: 'mcp' });
    const denied = await mcp(ro, 'tools/call', { name: 'create_folder', arguments: { name: 'x' } });
    assert.equal(denied.body.result.isError, true);
    assert.equal((await fetch(`${s.url}/api/integrations/mcp`, { method: 'POST' })).status, 401);
    // MCP 토큰(appId mcp)만 받는다: 일반 개인 토큰·세션은 거절
    const { token: pat } = createToken(s.db, free.id, { name: 'pat', scopes: ['files:write', 'services'] });
    assert.equal((await mcp(pat, 'tools/list', {})).status, 403);
    assert.equal((await mcp(sessionFor(s.db, free.id), 'tools/list', {})).status, 403);
    // [G-05] 클라우드 다운로드는 서비스 권한만 있으면 된다(offline API 와 같은 규칙)
    const { token: svc } = createToken(s.db, free.id, { name: 'svc', scopes: ['services'], appId: 'mcp' });
    const svcDl = await mcp(svc, 'tools/call', { name: 'add_cloud_download', arguments: { urls: ['magnet:?xt=urn:btih:abc'] } });
    assert.ok(!svcDl.body.result.isError, JSON.stringify(svcDl.body));
    assert.equal(calls.at(-1).url, '/api/offline/tasks');
    const n = calls.length;
    const noSvc = await mcp(ro, 'tools/call', { name: 'add_cloud_download', arguments: { urls: ['magnet:?xt=urn:btih:abc'] } });
    assert.equal(noSvc.body.result.isError, true);
    assert.match(noSvc.body.result.content[0].text, /services/);
    assert.equal(calls.length, n, '권한이 모자라면 offline API 를 부르지 않음');
    // 이름 바꾸기·옮기기(files:write), 휴지통·복원(files:manage)은 drive API 로
    const { token: manage } = createToken(s.db, free.id, { name: 'manage', scopes: ['files:manage'], appId: 'mcp' });
    const cases = [
      [mcpToken, 'rename_file', { fileId: folder.id, name: '새 이름' }, 'PATCH', `/api/drive/files/${folder.id}`, { name: '새 이름' }],
      [mcpToken, 'move_files', { fileIds: [folder.id] }, 'POST', '/api/drive/move', { ids: [folder.id], parentId: null }],
      [manage, 'trash_files', { fileIds: [folder.id] }, 'POST', '/api/drive/trash', { ids: [folder.id] }],
      [manage, 'restore_files', { fileIds: [folder.id] }, 'POST', '/api/drive/restore', { ids: [folder.id] }],
    ];
    for (const [tok, name, args, method, url, body] of cases) {
      const r = await mcp(tok, 'tools/call', { name, arguments: args });
      assert.ok(!r.body.result.isError, `${name} ${JSON.stringify(r.body)}`);
      assert.deepEqual({ method: calls.at(-1).method, url: calls.at(-1).url, body: calls.at(-1).body }, { method, url, body }, name);
    }
    // 기본 연결(읽기·쓰기 + 서비스)에는 관리 권한이 없어 휴지통 도구를 쓸 수 없다
    const m = calls.length;
    assert.equal((await mcp(mcpToken, 'tools/call', { name: 'trash_files', arguments: { fileIds: [folder.id] } })).body.result.isError, true);
    assert.equal(calls.length, m);
  });

  await t.test('[G-06] 연결 앱: 앱별 목록·권한·마지막 사용, 제거 즉시 반영', async () => {
    const { token: cliTok } = createToken(s.db, free.id, { name: 'CLI on laptop', scopes: ['files:write', 'services'], appId: 'cli' });
    assert.equal((await client(s.url, cliTok).get('/api/me')).status, 200);
    const apps = await web.get('/api/integrations/apps');
    const byId = Object.fromEntries(apps.body.items.map((a) => [a.id, a]));
    assert.ok(byId.cli && byId.mcp);
    assert.deepEqual(byId.cli.scopes, ['files:write', 'services']);
    assert.ok(byId.cli.lastUsedAt > 0);
    assert.equal(byId.mcp.connections.length, 4); // Claude, ro, svc, manage
    assert.equal((await web.del('/api/integrations/apps/cli')).status, 200);
    assert.equal((await client(s.url, cliTok).get('/api/me')).status, 401);
    // MCP 연결 하나만 해제(토큰 ID)
    const claude = byId.mcp.connections.find((c) => c.name === 'Claude');
    assert.equal((await web.del(`/api/integrations/apps/${claude.id}`)).status, 200);
    assert.equal((await mcp(mcpToken, 'tools/list', {})).status, 401);
  });

  await t.test('[G-01] WebDAV: 무료 403, 프리미엄+켜짐에서 PROPFIND·PUT·GET·MKCOL·MOVE·COPY·DELETE(휴지통), 쿼터 출처 app', async () => {
    const dav = (method, p, { auth, headers = {}, body } = {}) =>
      fetch(s.url + '/webdav' + p, { method, headers: { authorization: 'Basic ' + Buffer.from(auth).toString('base64'), ...headers }, body });
    // 무료: 비밀번호를 만들 수 없고, 예전 비밀번호가 있어도 403
    assert.equal((await web.post('/api/integrations/webdav/password')).status, 403);
    const { token: oldPw } = createToken(s.db, free.id, { name: 'old', scopes: ['files:manage'], appId: 'webdav' });
    assert.equal((await dav('PROPFIND', '/', { auth: `${free.email}:${oldPw}` })).status, 403);

    const pw = await pweb.post('/api/integrations/webdav/password');
    assert.equal(pw.status, 201);
    assert.equal(pw.body.username, prem.email);
    assert.match(pw.body.password, /^mw_/);
    // WebDAV 비밀번호는 /webdav 전용: /api 에서 Bearer 로 쓸 수 없다
    assert.equal((await client(s.url, pw.body.password).get('/api/me')).status, 401);
    assert.equal((await client(s.url, pw.body.password).post('/api/drive/trash/empty', {})).status, 401);
    const auth = `${prem.email}:${pw.body.password}`;
    const off = await dav('PROPFIND', '/', { auth });
    assert.equal(off.status, 403, '설정에서 켜기 전');
    assert.equal((await pweb.put('/api/integrations/settings', { webdavEnabled: true })).status, 200);
    const noAuth = await fetch(s.url + '/webdav/', { method: 'PROPFIND' });
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get('www-authenticate'), /Basic/);
    assert.equal((await dav('PROPFIND', '/', { auth: `${prem.email}:wrong` })).status, 401);
    assert.equal((await dav('OPTIONS', '/', { auth })).headers.get('dav'), '1, 2');

    createFolder(s.db, prem.id, null, '영상');
    const root = await dav('PROPFIND', '/', { auth, headers: { depth: '1' } });
    assert.equal(root.status, 207);
    const xml = await root.text();
    assert.match(xml, /<D:href>\/webdav\/<\/D:href>/);
    assert.match(xml, new RegExp(`<D:href>/webdav/${encodeURIComponent('영상')}/</D:href>`));
    assert.match(xml, /quota-available-bytes/);
    // 사용자명은 휴대폰·사용자 ID 도 가능
    assert.equal((await dav('PROPFIND', '/', { auth: `${prem.phone}:${pw.body.password}`, headers: { depth: '0' } })).status, 207);
    assert.equal((await dav('PROPFIND', '/', { auth: `${prem.id}:${pw.body.password}`, headers: { depth: '0' } })).status, 207);

    assert.equal((await dav('MKCOL', '/docs', { auth })).status, 201);
    assert.equal((await dav('MKCOL', '/docs', { auth })).status, 405);
    assert.equal((await dav('MKCOL', '/nope/sub', { auth })).status, 409);
    assert.equal((await dav('PUT', '/docs/a.txt', { auth, body: 'hello mimic' })).status, 201);
    assert.equal((await dav('PUT', '/docs/a.txt', { auth, body: 'hello again' })).status, 204, '덮어쓰기');
    const get = await dav('GET', '/docs/a.txt', { auth });
    assert.equal(await get.text(), 'hello again');
    const old = s.db.prepare("SELECT * FROM files WHERE user_id=? AND name='a.txt' AND trashed_at IS NOT NULL").get(prem.id);
    assert.equal(old?.size, 11, '덮어쓴 이전 내용은 휴지통에 남음(영구삭제 아님)');
    const part = await dav('GET', '/docs/a.txt', { auth, headers: { range: 'bytes=0-4' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'hello');
    const one = await dav('PROPFIND', '/docs/a.txt', { auth, headers: { depth: '0' } });
    assert.match(await one.text(), /<D:getcontentlength>11<\/D:getcontentlength>/);

    const q = (kind) => s.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM quota_usage WHERE user_id=? AND kind=? AND source='app' AND period LIKE 'm:%'").get(prem.id, kind).n;
    assert.equal(q('up'), 22);
    assert.ok(q('down') >= 16);

    const dest = (p) => ({ destination: `${s.url}/webdav${p}` });
    assert.equal((await dav('MOVE', '/docs/a.txt', { auth, headers: dest('/docs/b.txt') })).status, 201);
    assert.equal((await dav('GET', '/docs/a.txt', { auth })).status, 404);
    assert.equal((await dav('COPY', '/docs/b.txt', { auth, headers: dest(`/${encodeURIComponent('영상')}/c.txt`) })).status, 201);
    assert.equal(await (await dav('GET', `/${encodeURIComponent('영상')}/c.txt`, { auth })).text(), 'hello again');
    assert.equal((await dav('MOVE', '/docs', { auth, headers: dest('/docs/inner') })).status, 403, '자기 하위로 이동 불가');
    assert.equal((await dav('LOCK', '/docs/b.txt', { auth })).headers.get('lock-token')?.startsWith('<opaquelocktoken:'), true);

    // 덮어쓸 대상이 원본의 상위 폴더면 거절하고 아무것도 휴지통에 넣지 않는다(원본까지 휴지통에 들어가 사라지는 것 방지)
    assert.equal((await dav('MKCOL', '/p', { auth })).status, 201);
    assert.equal((await dav('MKCOL', '/p/c', { auth })).status, 201);
    assert.equal((await dav('PUT', '/p/c/f.txt', { auth, body: 'keep' })).status, 201);
    for (const m of ['MOVE', 'COPY']) assert.equal((await dav(m, '/p/c', { auth, headers: dest('/p') })).status, 403, m);
    const trashedAt = (name) => s.db.prepare('SELECT trashed_at FROM files WHERE user_id=? AND name=? ORDER BY created_at DESC').get(prem.id, name).trashed_at;
    for (const n of ['p', 'c', 'f.txt']) assert.equal(trashedAt(n), null, n);
    // COPY 가 용량 초과(507)면 덮어쓸 대상을 휴지통에 넣기 전에 멈춘다
    assert.equal((await dav('PUT', '/p/g.txt', { auth, body: 'old' })).status, 201);
    const filler = createFileNode(s.db, prem.id, null, { name: 'filler.bin', size: capacityOf(prem) });
    assert.equal((await dav('COPY', '/p/c/f.txt', { auth, headers: dest('/p/g.txt') })).status, 507);
    assert.equal(trashedAt('g.txt'), null, '507 이면 덮어쓸 대상이 그대로');
    s.db.prepare('DELETE FROM files WHERE id=?').run(filler.id);
    // 덮어쓰는 MOVE: 이전 대상은 휴지통에, 원본은 그 이름으로
    assert.equal((await dav('MOVE', '/p/c/f.txt', { auth, headers: dest('/p/g.txt') })).status, 204);
    assert.equal(await (await dav('GET', '/p/g.txt', { auth })).text(), 'keep');
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM files WHERE user_id=? AND name='g.txt' AND trashed_at IS NOT NULL AND trash_root=1").get(prem.id).n, 1);

    assert.equal((await dav('DELETE', '/docs/b.txt', { auth })).status, 204);
    const row = s.db.prepare("SELECT * FROM files WHERE user_id=? AND name='b.txt'").get(prem.id);
    assert.ok(row, '영구삭제하지 않음');
    assert.ok(row.trashed_at > 0, '휴지통으로 이동');
    assert.equal((await dav('DELETE', '/', { auth })).status, 403, '전체 삭제·휴지통 비우기 불가');
    assert.equal((await dav('DELETE', '/docs', { auth })).status, 204);
    assert.ok(s.db.prepare("SELECT trashed_at FROM files WHERE user_id=? AND name='docs'").get(prem.id).trashed_at > 0);

    // 본문 바이트를 그대로 저장한다. 코어가 /webdav 에서는 JSON·폼 해석을 건너뛰므로 어떤 Content-Type 이어도 그대로 저장
    const pretty = '{\n  "a": 1,\n  "b": [1, 2]\n}\n';
    assert.equal((await dav('PUT', '/p.json', { auth, body: pretty, headers: { 'content-type': 'application/octet-stream' } })).status, 201);
    assert.equal(await (await dav('GET', '/p.json', { auth })).text(), pretty);
    for (const [i, ct] of ['application/json', 'application/x-www-form-urlencoded'].entries()) {
      const body = ct.includes('json') ? pretty : 'a=1&a=2&b=x y';
      assert.equal((await dav('PUT', `/q${i}.json`, { auth, body, headers: { 'content-type': ct } })).status, 201, ct);
      assert.equal(await (await dav('GET', `/q${i}.json`, { auth })).text(), body, `${ct} 본문이 바뀌지 않음`);
    }

    // [F-05] 내려받기는 요청한 길이로 한도를 검사한다: 한도 안의 Range 는 그대로, 한도를 넘길 요청은 처음부터 감속
    addUsage(s.db, prem.id, 'down', Math.floor(MONTHLY_QUOTA.down * APP_QUOTA_SHARE) - q('down') - 5, 'app');
    const small = await dav('GET', '/p.json', { auth, headers: { range: 'bytes=0-1' } });
    assert.equal(small.headers.get('x-mimic-throttled'), null);
    await small.text();
    const whole = await dav('GET', '/p.json', { auth });
    assert.equal(whole.headers.get('x-mimic-throttled'), 'app_quota');
    assert.equal(await whole.text(), pretty);

    // [G-01] 만료된 앱 비밀번호: 접속은 401, 상태 API 는 expired 로 알린다
    assert.equal((await pweb.get('/api/integrations/webdav')).body.password.expired, false);
    s.db.prepare("UPDATE personal_tokens SET expires_at=? WHERE user_id=? AND app_id='webdav' AND revoked_at IS NULL").run(Date.now() - 1000, prem.id);
    assert.equal((await dav('PROPFIND', '/', { auth, headers: { depth: '0' } })).status, 401);
    const st = (await pweb.get('/api/integrations/webdav')).body.password;
    assert.equal(st.expired, true);
    assert.ok(st.expiresAt < Date.now());
    s.db.prepare("UPDATE personal_tokens SET expires_at=? WHERE user_id=? AND app_id='webdav' AND revoked_at IS NULL").run(Date.now() + 864e5, prem.id);

    // 길이를 모르는(chunked) 업로드도 연결 앱 업로드 상한(25%)을 넘으면 막는다
    addUsage(s.db, prem.id, 'up', MONTHLY_QUOTA.up * APP_QUOTA_SHARE - q('up') - 5, 'app');
    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('0123456789'));
        c.close();
      },
    });
    const ch = await fetch(s.url + '/webdav/big.bin', { method: 'PUT', duplex: 'half', body: chunked, headers: { authorization: 'Basic ' + Buffer.from(auth).toString('base64') } });
    assert.equal(ch.status, 403);
    assert.equal((await ch.json()).error, 'app_quota');
    assert.equal((await dav('GET', '/big.bin', { auth })).status, 404);
  });

  await t.test('[G-07] 텔레그램: 코드 연결(비밀 헤더), 링크·파일을 My telegram 폴더로, 연동 해제', async () => {
    const bot = client(s.url);
    const sec = { 'x-bot-secret': 'bot-secret' };
    const code = await web.post('/api/integrations/telegram/bind-code');
    // 6자리 숫자는 여러 텔레그램 계정으로 맞힐 수 있어 8자리 영숫자(헷갈리는 0·O·1·I 제외)
    assert.match(code.body.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal((await bot.post('/api/integrations/telegram/bind', { code: code.body.code, telegramUserId: '777', chatId: '777' })).status, 401, '비밀 헤더 없음');
    assert.equal((await bot.post('/api/integrations/telegram/bind', { code: '000000', telegramUserId: '777' }, sec)).status, 400);
    assert.equal((await bot.post('/api/integrations/telegram/bind', { code: 'ZZZZZZZZ', telegramUserId: '777' }, sec)).body.error, 'invalid_code');
    // 소문자로 보내도 된다
    const b = await bot.post('/api/integrations/telegram/bind', { code: code.body.code.toLowerCase(), telegramUserId: '777', chatId: '777' }, sec);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    // 응답의 계정은 가려서 보여 준다
    assert.notEqual(b.body.account, free.email);
    assert.match(b.body.account, /^.\*\*\*@/);
    assert.equal((await bot.post('/api/integrations/telegram/bind', { code: code.body.code, telegramUserId: '777' }, sec)).status, 400, '코드는 한 번만');
    assert.equal((await web.get('/api/integrations/telegram/status')).body.bound, true);
    assert.ok((await web.get('/api/integrations/apps')).body.items.some((a) => a.id === 'telegram'));

    const links = await bot.post('/api/integrations/telegram/links', { telegramUserId: '777', urls: ['https://example.com/a.mp4'] }, sec);
    assert.equal(links.status, 200, JSON.stringify(links.body));
    const folder = s.db.prepare("SELECT id FROM files WHERE user_id=? AND name='My telegram' AND kind='folder'").get(free.id);
    assert.ok(folder);
    assert.equal(calls.at(-1).url, '/api/offline/tasks');
    assert.deepEqual(calls.at(-1).body, { urls: ['https://example.com/a.mp4'], parentId: folder.id });
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id=? AND device='telegram'").get(free.id).n, 0, '중계 세션은 바로 지움');

    const fd = new FormData();
    fd.append('telegramUserId', '777');
    fd.append('file', new Blob(['photo-bytes'], { type: 'image/jpeg' }), '사진.jpg');
    const up = await bot.post('/api/integrations/telegram/upload', fd, sec);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const f = s.db.prepare('SELECT * FROM files WHERE id=?').get(up.body.file.id);
    assert.equal(f.parent_id, folder.id);
    assert.equal(f.origin, 'telegram');
    assert.equal(f.name, '사진.jpg');
    assert.equal(f.size, 11);
    // 남은 월 업로드 쿼터보다 큰 파일은 받지 않는다(웹 업로드와 같게 한도를 넘기지 않음)
    const mu = summary(s.db, free).month.up;
    addUsage(s.db, free.id, 'up', mu.limit - mu.used - 5);
    const over = new FormData();
    over.append('telegramUserId', '777');
    over.append('file', new Blob(['0123456789'], { type: 'text/plain' }), 'over.txt');
    const ov = await bot.post('/api/integrations/telegram/upload', over, sec);
    assert.equal(ov.status, 403, JSON.stringify(ov.body));
    assert.equal(ov.body.error, 'upload_quota');
    assert.equal(summary(s.db, free).month.up.used, mu.limit - 5, '쿼터를 넘기지 않음');
    assert.ok(!s.db.prepare("SELECT 1 FROM files WHERE user_id=? AND name='over.txt'").get(free.id));

    assert.equal((await bot.post('/api/integrations/telegram/quota', { telegramUserId: '777' }, sec)).status, 200);
    assert.equal((await web.del('/api/integrations/telegram')).status, 200);
    assert.equal((await web.get('/api/integrations/telegram/status')).body.bound, false);
    assert.equal((await bot.post('/api/integrations/telegram/links', { telegramUserId: '777', urls: ['https://x.y/z'] }, sec)).status, 404);
    // 봇의 /settings → 연동 해제
    const code2 = await web.post('/api/integrations/telegram/bind-code');
    await bot.post('/api/integrations/telegram/bind', { code: code2.body.code, telegramUserId: '778' }, sec);
    assert.equal((await bot.post('/api/integrations/telegram/unbind', { telegramUserId: '778' }, sec)).body.removed, true);

    // [G-06] 연결 토큰이 만료되면 목록에서 빠지는 것과 같이 실제 연동도 끊긴다
    const code3 = await web.post('/api/integrations/telegram/bind-code');
    assert.equal((await bot.post('/api/integrations/telegram/bind', { code: code3.body.code, telegramUserId: '779' }, sec)).status, 200);
    assert.equal((await bot.post('/api/integrations/telegram/quota', { telegramUserId: '779' }, sec)).status, 200);
    s.db.prepare("UPDATE personal_tokens SET expires_at=? WHERE user_id=? AND app_id='telegram' AND revoked_at IS NULL").run(Date.now() - 1000, free.id);
    assert.ok(!(await web.get('/api/integrations/apps')).body.items.some((a) => a.id === 'telegram'));
    assert.equal((await web.get('/api/integrations/telegram/status')).body.bound, false);
    assert.equal((await bot.post('/api/integrations/telegram/quota', { telegramUserId: '779' }, sec)).body.error, 'not_linked');

    // 연동 상태(텔레그램 ID)는 웹 로그인 세션에서만 읽는다
    const { token: readTok } = createToken(s.db, free.id, { name: 'read', scopes: ['files:read'] });
    assert.equal((await client(s.url, readTok).get('/api/integrations/telegram/status')).status, 403);
  });

  await t.test('[G-08] 브라우저 확장: 오프라인 설치 zip', async () => {
    const r = await fetch(`${s.url}/api/integrations/extension.zip`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    const zip = new AdmZip(Buffer.from(await r.arrayBuffer()));
    const manifest = JSON.parse(zip.readAsText('mimic-extension/manifest.json'));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.permissions.includes('contextMenus'));
    assert.ok(zip.getEntry('mimic-extension/background.js') && zip.getEntry('mimic-extension/content.js') && zip.getEntry('mimic-extension/popup.html'));
    // 이 서버 주소가 기본값·접근 권한으로 들어 있다
    assert.ok(zip.readAsText('mimic-extension/api.js').includes(`export const DEFAULT_SERVER = "${BASE}";`));
    assert.ok(manifest.host_permissions.includes('https://mimic.test/*'));
  });

  await t.test('[G-02] CLI: 도움말, 토큰으로 무인 실행(whoami)', async () => {
    const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    for (const cmd of ['auth login', 'upload', 'download', 'share', 'offline add', 'stream', 'skill install']) assert.ok(help.includes(cmd), cmd);
    const { token } = createToken(s.db, free.id, { name: 'ci', scopes: ['files:read'], appId: 'cli' });
    const { stdout: out } = await promisify(execFile)(process.execPath, [cli, 'whoami', '--server', s.url], { encoding: 'utf8', env: { ...process.env, MIMIC_TOKEN: token, HOME: os.tmpdir(), USERPROFILE: os.tmpdir() } });
    assert.ok(out.includes(free.email), out);
    // 설치 스크립트는 이 서버 주소를 담아 내려준다
    const sh = await fetch(`${s.url}/api/integrations/cli/install.sh`).then((r) => r.text());
    assert.ok(sh.includes(BASE) && sh.includes('/api/integrations/cli/mimic.js'));
    // Host 헤더는 스크립트에 들어가지 않는다(curl | sh, irm | iex 명령 주입·캐시 오염 방지)
    const ps1 = await new Promise((resolve, reject) =>
      http.get(`${s.url}/api/integrations/cli/install.ps1`, { headers: { host: "x'; calc; '" } }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => resolve(b));
      }).on('error', reject),
    );
    assert.ok(ps1.includes(`'${BASE}'`) && !ps1.includes('calc'), ps1.slice(0, 200));
    assert.equal((await fetch(`${s.url}/api/integrations/cli/..%2Fpackage.json`)).status, 404);

    // npx·Homebrew: 서버가 npm 패키지 tarball 과 그 sha256 을 담은 공식을 내려준다
    const tgz = Buffer.from(await (await fetch(`${s.url}/api/integrations/cli/mimic-cli.tgz`)).arrayBuffer());
    const tar = zlib.gunzipSync(tgz);
    const entries = {};
    for (let at = 0; at + 512 <= tar.length && tar[at]; ) {
      const name = tar.toString('ascii', at, at + 100).replace(/\0.*$/s, '');
      const size = parseInt(tar.toString('ascii', at + 124, at + 135), 8);
      entries[name] = tar.toString('utf8', at + 512, at + 512 + size);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    assert.deepEqual(Object.keys(entries).sort(), ['package/README.md', 'package/mimic.js', 'package/package.json']);
    assert.equal(JSON.parse(entries['package/package.json']).bin.mimic, 'mimic.js');
    assert.ok(entries['package/mimic.js'].includes(`const DEFAULT_SERVER = "${BASE}";`), '기본 서버 주소가 이 서버');
    const rb = await (await fetch(`${s.url}/api/integrations/cli/mimic.rb`)).text();
    assert.ok(rb.includes(`url "${BASE}/api/integrations/cli/mimic-cli.tgz"`), rb);
    assert.ok(rb.includes(`sha256 "${createHash('sha256').update(tgz).digest('hex')}"`), 'tarball 의 sha256 과 같음');
  });

  await t.test('[G-09] AI 에이전트 스킬: skill install 이 SKILL.md 를 만든다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-skill-'));
    try {
      execFileSync(process.execPath, [cli, 'skill', 'install', '--dir', dir], { encoding: 'utf8' });
      const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      assert.match(md, /^---\nname: mimic/);
      assert.ok(md.includes('mimic offline add'));
      // 연결 앱 25% 상한은 프리미엄에도 걸린다(8-7)
      assert.ok(md.includes('모든 계정(프리미엄 포함)'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 대역 서버 없이 실제 drive·offline·share 모듈로: MCP 도구, CLI 브라우저 승인 로그인·업로드·다운로드·공유·클라우드 다운로드
test('[G-02][G-03] 실제 모듈로 MCP 도구·CLI 명령', async (t) => {
  const s = await startServer({ baseUrl: BASE });
  // 클라우드 다운로드 대상(외부 네트워크 대신 로컬 서버)
  const origin = http.createServer((_req, res) => res.end('cloud-bytes'));
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const src = `http://127.0.0.1:${origin.address().port}/a.txt`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-cli-home-'));
  t.after(async () => {
    await s.close();
    origin.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const missing = ['drive', 'offline', 'share'].filter((m) => !s.ctx.modules[m]);
  const skip = missing.length ? `${missing.join('·')} 모듈 없음` : false;
  const user = createUser(s.db);
  const web = client(s.url, sessionFor(s.db, user.id));

  await t.test('[G-03] MCP: 이름 바꾸기·옮기기·휴지통·복원·클라우드 다운로드·공유 링크', { skip }, async () => {
    const { token } = createToken(s.db, user.id, { name: 'ai', scopes: ['files:manage', 'services'], appId: 'mcp' });
    const call = async (name, args) => {
      const r = await fetch(`${s.url}/api/integrations/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const b = await r.json();
      assert.ok(!b.result?.isError, `${name} ${JSON.stringify(b)}`);
      return JSON.parse(b.result.content[0].text);
    };
    const a = createFolder(s.db, user.id, null, 'A');
    const b = createFolder(s.db, user.id, null, 'B');
    const row = () => s.db.prepare('SELECT * FROM files WHERE id=?').get(a.id);
    await call('rename_file', { fileId: a.id, name: 'A2' });
    assert.equal(row().name, 'A2');
    await call('move_files', { fileIds: [a.id], parentId: b.id });
    assert.equal(row().parent_id, b.id);
    await call('trash_files', { fileIds: [a.id] });
    assert.ok(row().trashed_at > 0);
    await call('restore_files', { fileIds: [a.id] });
    assert.equal(row().trashed_at, null);
    const dl = await call('add_cloud_download', { urls: [src], parentId: b.id });
    assert.equal(dl.tasks.length, 1);
    const sh = await call('create_share_link', { fileIds: [a.id], expiryDays: 7 });
    assert.ok(sh.url.startsWith(`${BASE}/s/`), sh.url);
  });

  await t.test('[G-02] CLI: 브라우저 승인 로그인 → 업로드·다운로드·공유·클라우드 다운로드', { skip }, async () => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.MIMIC_TOKEN;
    delete env.MIMIC_SERVER;
    const login = spawn(process.execPath, [cli, 'auth', 'login', '--no-browser', '--server', s.url], { env });
    const exited = once(login, 'exit');
    let log = '';
    login.stderr.on('data', (c) => (log += c));
    const code = await new Promise((resolve, reject) => {
      login.stdout.on('data', (c) => {
        log += c;
        const m = /([A-Z]{4}-[A-Z]{4})/.exec(log);
        if (m) resolve(m[1]);
      });
      login.on('exit', () => reject(new Error(log)));
    });
    const ap = await web.post('/api/auth/device/approve', { userCode: code, approve: true });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, log);
    const conf = JSON.parse(fs.readFileSync(path.join(home, '.mimic-cli.json'), 'utf8'));
    assert.equal(conf.server, s.url);
    assert.ok(conf.token);

    // 이후 명령은 저장된 로그인으로(서버 주소도 저장된 값)
    const run = async (...a) => (await promisify(execFile)(process.execPath, [cli, ...a, '--json'], { encoding: 'utf8', env })).stdout;
    const local = path.join(home, '올릴 파일.txt');
    fs.writeFileSync(local, 'cli-bytes');
    const up = JSON.parse(await run('upload', local));
    assert.equal(up.file.size, 9);
    assert.equal(s.db.prepare('SELECT user_id FROM files WHERE id=?').get(up.file.id).user_id, user.id);
    assert.ok(summary(s.db, user).app.up.used >= 9, 'CLI 업로드는 연결 앱 쿼터로 센다');
    const saved = path.join(home, 'got.txt');
    await run('download', up.file.id, saved);
    assert.equal(fs.readFileSync(saved, 'utf8'), 'cli-bytes');
    const sh = JSON.parse(await run('share', up.file.id, '--days', '7'));
    assert.match(sh.url, /\/s\//);
    const off = JSON.parse(await run('offline', 'add', src));
    assert.equal(off.tasks.length, 1);
  });
});
