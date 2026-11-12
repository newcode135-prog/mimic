import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { createFolder, createFileNode } from '../server/core/files.js';
import { createToken, saveSettings } from '../server/core/auth.js';
import { addUsage, summary } from '../server/core/quota.js';
import { MONTHLY_QUOTA, GB, TRASH_DAYS, SLOW_BPS, LIMITS, APP_QUOTA_SHARE } from '../server/core/plans.js';
import { DAY, now } from '../server/core/util.js';
import { jobs, makeLink, tutorialBlob } from '../server/modules/drive/index.js';

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 30));
  }
  return true;
};

function upload(c, { parentId, path, name = 'a.txt', data = 'hello', type = 'text/plain' } = {}) {
  const fd = new FormData();
  if (parentId) fd.append('parentId', parentId);
  if (path) fd.append('path', path);
  fd.append('file', new Blob([data], { type }), name);
  return c.post('/api/drive/upload', fd);
}

// Content-Length 없이(Transfer-Encoding: chunked) 보내는 멀티파트 업로드
async function chunkedUpload(base, token, data, name = 'big.bin') {
  const b = 'mimicChunked';
  const parts = [`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`, data, `\r\n--${b}--\r\n`];
  const body = new ReadableStream({
    start(ctrl) {
      for (const p of parts) ctrl.enqueue(new TextEncoder().encode(p));
      ctrl.close();
    },
  });
  const res = await fetch(base + '/api/drive/upload', { method: 'POST', body, duplex: 'half', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${b}` } });
  return { status: res.status, body: await res.json() };
}

test('drive 모듈', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const newUser = (opts) => {
    const u = createUser(s.db, opts);
    return { u, c: client(s.url, sessionFor(s.db, u.id)) };
  };
  const names = (items) => items.map((x) => x.name);

  await t.test('[B-01] 새 폴더·이름 바꾸기·이동·복사·자세한 정보, 다른 사람 파일은 못 건드림', async () => {
    const { u, c } = newUser();
    const a = (await c.post('/api/drive/folders', { name: '영상' })).body.folder;
    const b = (await c.post('/api/drive/folders', { parentId: a.id, name: '하위' })).body.folder;
    assert.equal((await c.post('/api/drive/folders', { name: '../x' })).status, 400);
    const f = createFileNode(s.db, u.id, a.id, { name: 'clip.mp4', size: 5, mime: 'video/mp4' });
    createFileNode(s.db, u.id, a.id, { name: 'other.mp4', size: 1 });

    const ren = await c.patch(`/api/drive/files/${f.id}`, { name: 'other.mp4' });
    assert.equal(ren.body.file.name, 'other (1).mp4');

    assert.equal((await c.post('/api/drive/move', { ids: [a.id], parentId: b.id })).status, 400, '자기 하위로 이동 금지');
    assert.equal((await c.post('/api/drive/move', { ids: [f.id], parentId: b.id })).body.items[0].parentId, b.id);

    const list = await c.get(`/api/drive/list?parentId=${b.id}`);
    assert.deepEqual(names(list.body.items), ['other (1).mp4']);
    assert.deepEqual(list.body.path.map((p) => p.name), ['영상', '하위']);
    assert.equal(list.body.folder.id, b.id);

    const cp = await c.post('/api/drive/copy', { ids: [a.id], parentId: null });
    assert.equal(cp.status, 201);
    assert.equal(cp.body.items[0].name, '영상 (1)');
    assert.equal((await c.post('/api/drive/copy', { ids: [a.id], parentId: b.id })).status, 400, '자기 안으로 복사 금지');

    const info = await c.get(`/api/drive/files/${f.id}`);
    assert.equal(info.body.file.mime, 'video/mp4');
    assert.deepEqual(info.body.path.map((p) => p.name), ['영상', '하위']);

    const { c: other } = newUser();
    assert.equal((await other.get(`/api/drive/files/${f.id}`)).status, 404);
    assert.equal((await other.post('/api/drive/move', { ids: [f.id], parentId: null })).status, 404);
    assert.equal((await other.post('/api/drive/folders', { parentId: a.id, name: 'x' })).status, 404);
    assert.equal((await client(s.url).get('/api/drive/list')).status, 401);
  });

  await t.test('[B-02] 휴지통: 하위 함께 숨김, 복원, 원래 폴더가 없으면 루트로, 영구삭제, 비우기, 15일 자동 삭제', async () => {
    const { u, c } = newUser();
    const dir = createFolder(s.db, u.id, null, '문서');
    const child = createFileNode(s.db, u.id, dir.id, { name: 'a.pdf', size: 100 });
    const tr = await c.post('/api/drive/trash', { ids: [dir.id, child.id] });
    assert.equal(tr.body.expiresAt - tr.body.trashedAt, TRASH_DAYS * DAY);
    assert.equal((await c.get('/api/drive/list')).body.items.length, 0);
    const trash = await c.get('/api/drive/trash');
    assert.deepEqual(names(trash.body.items), ['문서'], '하위 항목은 따로 보이지 않는다');
    assert.equal((await c.get(`/api/drive/files/${child.id}`)).status, 404);

    await c.post('/api/drive/restore', { ids: [dir.id] });
    assert.deepEqual(names((await c.get(`/api/drive/list?parentId=${dir.id}`)).body.items), ['a.pdf']);

    // 파일을 먼저 버리고 폴더를 나중에 버린 뒤 파일만 복원 → 원래 폴더가 휴지통이므로 루트로
    await c.post('/api/drive/trash', { ids: [child.id] });
    await c.post('/api/drive/trash', { ids: [dir.id] });
    await c.post('/api/drive/restore', { ids: [child.id] });
    assert.deepEqual(names((await c.get('/api/drive/list')).body.items), ['a.pdf']);

    assert.equal((await c.post('/api/drive/delete-forever', { ids: [child.id] })).status, 400, '휴지통 밖 항목은 영구삭제 불가');
    assert.equal((await c.post('/api/drive/delete-forever', { ids: [dir.id] })).body.deleted, 1);
    await c.post('/api/drive/trash', { ids: [child.id] });
    assert.equal((await c.post('/api/drive/trash/empty')).body.deleted, 1);
    assert.equal((await c.get('/api/drive/trash')).body.items.length, 0);

    const old = createFileNode(s.db, u.id, null, { name: 'old.bin', size: 1 });
    const fresh = createFileNode(s.db, u.id, null, { name: 'fresh.bin', size: 1 });
    await c.post('/api/drive/trash', { ids: [old.id, fresh.id] });
    s.db.prepare('UPDATE files SET trashed_at=? WHERE id=?').run(now() - (TRASH_DAYS + 1) * DAY, old.id);
    await jobs.find((j) => j.name === 'drive:purge-trash').run(s.ctx);
    assert.deepEqual(names((await c.get('/api/drive/trash')).body.items), ['fresh.bin']);
  });

  await t.test('[B-02] 폴더를 영구삭제해도 따로 먼저 버린 하위 항목은 휴지통에 남아 복원할 수 있다', async () => {
    const { u, c } = newUser();
    const p = createFolder(s.db, u.id, null, 'P');
    const kid = createFileNode(s.db, u.id, p.id, { name: 'c.bin', size: 1 });
    const same = createFileNode(s.db, u.id, p.id, { name: 'd.bin', size: 1 });
    await c.post('/api/drive/trash', { ids: [kid.id] });
    s.db.prepare('UPDATE files SET trashed_at=trashed_at-1000 WHERE id=?').run(kid.id);
    await c.post('/api/drive/trash', { ids: [p.id] });
    assert.deepEqual(names((await c.get('/api/drive/trash')).body.items), ['P', 'c.bin']);
    assert.equal((await c.post('/api/drive/delete-forever', { ids: [p.id] })).body.deleted, 2, 'P 와 함께 버린 d.bin 만');
    assert.equal(s.db.prepare('SELECT 1 FROM files WHERE id=?').get(same.id), undefined);
    assert.deepEqual(names((await c.get('/api/drive/trash')).body.items), ['c.bin']);
    await c.post('/api/drive/restore', { ids: [kid.id] });
    assert.deepEqual(names((await c.get('/api/drive/list')).body.items), ['c.bin'], '원래 폴더가 없으니 루트로');
  });

  await t.test('[B-02] 하위 항목이 상위 폴더보다 먼저 와도 휴지통엔 상위만 보이고, 함께 되살리면 원래 자리로', async () => {
    const { u, c } = newUser();
    const a = createFolder(s.db, u.id, null, 'a');
    const f = createFileNode(s.db, u.id, a.id, { name: 'abc.txt', size: 1 });
    await c.post('/api/drive/trash', { ids: [f.id, a.id] });
    assert.deepEqual(names((await c.get('/api/drive/trash')).body.items), ['a']);
    const r = await c.post('/api/drive/restore', { ids: [f.id, a.id] });
    assert.deepEqual(r.body.items.map((x) => x.id), [f.id, a.id], '응답은 요청 순서');
    assert.deepEqual(names((await c.get('/api/drive/list')).body.items), ['a']);
    assert.deepEqual(names((await c.get(`/api/drive/list?parentId=${a.id}`)).body.items), ['abc.txt']);
  });

  await t.test('[B-02][B-12] 권한: 휴지통·복원은 files:manage, 영구삭제·비우기는 files:delete(토큰·WebDAV 불가)', async () => {
    const { u, c } = newUser();
    const tok = (scopes, appId = null) => client(s.url, createToken(s.db, u.id, { name: 't', scopes, appId }).token);
    const write = tok(['files:write', 'services'], 'cli');
    // files:manage 권한을 받은 연결 앱(WebDAV 비밀번호는 일반 API 에서 쓸 수 없으므로 다른 연결 앱으로 확인)
    const dav = tok(['files:manage'], 'third-party');
    const f = createFileNode(s.db, u.id, null, { name: 'a.bin', size: 1 });
    assert.equal((await write.post('/api/drive/trash', { ids: [f.id] })).status, 403);
    assert.equal((await dav.post('/api/drive/trash', { ids: [f.id] })).status, 200);
    assert.equal((await write.post('/api/drive/restore', { ids: [f.id] })).status, 403);
    assert.equal((await dav.post('/api/drive/restore', { ids: [f.id] })).status, 200);
    await dav.post('/api/drive/trash', { ids: [f.id] });
    assert.equal((await dav.post('/api/drive/delete-forever', { ids: [f.id] })).status, 403);
    assert.equal((await dav.post('/api/drive/trash/empty')).status, 403);
    assert.equal((await c.get('/api/drive/trash')).body.items.length, 1, '토큰으로는 아무것도 지워지지 않음');
    assert.equal((await tok(['files:read']).post('/api/drive/folders', { name: 'x' })).status, 403);
    assert.equal((await tok(['files:read']).get('/api/drive/trash')).status, 200);
    assert.equal((await c.post('/api/drive/delete-forever', { ids: [f.id] })).body.deleted, 1, '웹 세션은 영구삭제 가능');
  });

  await t.test('[B-03] 사용량: 휴지통에 있어도 포함, 영구삭제해야 반환', async () => {
    const { c } = newUser();
    const up = await upload(c, { data: 'x'.repeat(1000) });
    const used = async () => (await c.get('/api/me')).body.storage.used;
    assert.equal(await used(), 1000);
    assert.equal((await c.get('/api/me')).body.storage.total, 6 * GB);
    await c.post('/api/drive/trash', { ids: [up.body.file.id] });
    assert.equal(await used(), 1000);
    await c.post('/api/drive/delete-forever', { ids: [up.body.file.id] });
    assert.equal(await used(), 0);
  });

  await t.test('[B-04] 서명된 임시 다운로드 링크: 로그인 없이 받고, 위조·만료 링크는 거부, 소유자 쿼터 차감', async () => {
    const { u, c } = newUser();
    const f = (await upload(c, { name: '자료.txt', data: 'resource-link' })).body.file;
    const link = await c.get(`/api/drive/files/${f.id}/link`);
    assert.match(link.body.url, /^\/api\/drive\/dl\//);
    assert.ok(Math.abs(link.body.expiresAt - now() - 24 * 3600_000) < 60_000);
    const res = await fetch(s.url + link.body.url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'resource-link');
    assert.ok(await until(() => summary(s.db, u).month.down.used === 13));
    assert.equal((await fetch(s.url + link.body.url.slice(0, -2) + 'xx')).status, 404);
    assert.equal((await fetch(`${s.url}/api/drive/dl/${makeLink(s.cfg, u.id, f.id, now() - 1)}`)).status, 404);
    await c.post('/api/drive/trash', { ids: [f.id] });
    assert.equal((await fetch(s.url + link.body.url)).status, 404, '휴지통 파일은 링크로 못 받음');
  });

  await t.test('[B-05] 검색(LIKE 이스케이프)·정렬 6종+폴더 우선·정렬/보기 기억(폴더별·전체)', async () => {
    const { u, c } = newUser();
    const dir = createFolder(s.db, u.id, null, 'zeta');
    const files = [['100% 진짜.txt', 30], ['a_b.txt', 10], ['axb.txt', 20], ['9.txt', 5], ['10.txt', 40]].map(([name, size], i) => {
      const n = createFileNode(s.db, u.id, null, { name, size });
      s.db.prepare('UPDATE files SET updated_at=? WHERE id=?').run(1000 + i, n.id);
      return n;
    });
    assert.deepEqual(names((await c.get('/api/drive/search?q=_')).body.items), ['a_b.txt']);
    assert.deepEqual(names((await c.get('/api/drive/search?q=%25')).body.items), ['100% 진짜.txt']);
    assert.deepEqual(names((await c.get(`/api/drive/search?q=${encodeURIComponent('진짜')}`)).body.items), ['100% 진짜.txt']);
    await c.post('/api/drive/trash', { ids: [files[2].id] });
    assert.equal((await c.get('/api/drive/search?q=axb')).body.items.length, 0, '휴지통 항목은 검색 제외');

    const order = async (qs) => names((await c.get(`/api/drive/list?${qs}`)).body.items);
    const first = await order('sort=name');
    assert.equal(first[0], 'zeta', '폴더 우선');
    assert.ok(first.indexOf('9.txt') < first.indexOf('10.txt'), '숫자는 자연 순서');
    assert.equal((await order('sort=name_desc&foldersFirst=0'))[0], 'zeta');
    assert.deepEqual((await order('sort=largest&foldersFirst=0')).slice(0, 2), ['10.txt', '100% 진짜.txt']);
    assert.equal((await order('sort=smallest&foldersFirst=0'))[0], 'zeta');
    assert.equal((await order('sort=newest&foldersFirst=0'))[0], 'zeta');
    assert.equal((await order('sort=oldest'))[1], '100% 진짜.txt');

    // 기본은 폴더별 기억(설정 화면 integrations SETTING_DEFAULTS 와 같은 값): 하위 폴더에서 바꿔도 루트는 그대로
    const p0 = (await c.get('/api/drive/list')).body.prefs;
    assert.deepEqual([p0.sortScope, p0.viewScope], ['folder', 'folder']);
    const p1 = await c.put('/api/drive/prefs', { folderId: dir.id, sort: 'largest', view: 'list' });
    assert.equal(p1.body.prefs.sort, 'largest');
    assert.equal((await c.get(`/api/drive/list?parentId=${dir.id}`)).body.prefs.view, 'list');
    assert.equal((await c.get('/api/drive/list')).body.prefs.sort, 'name');
    assert.equal((await c.get('/api/drive/list')).body.prefs.view, 'grid');
    // 전체 기억
    await c.put('/api/drive/prefs', { sortScope: 'global', sort: 'smallest', foldersFirst: false });
    for (const qs of ['', `parentId=${dir.id}`]) {
      const p = (await c.get(`/api/drive/list?${qs}`)).body.prefs;
      assert.equal(p.sort, 'smallest');
      assert.equal(p.foldersFirst, false);
    }
    assert.equal((await c.get('/api/drive/list')).body.items[0].name, 'zeta', '저장된 정렬이 목록에 적용');
    assert.equal((await c.put('/api/drive/prefs', { sort: 'drop table' })).status, 400);
    const many = await c.post('/api/drive/star', { ids: Array.from({ length: 1001 }, (_, i) => 'f_' + i), starred: true });
    assert.equal(many.status, 400);
    assert.match(many.body.message, /1000개까지/, '일괄 작업 한도를 사실대로 안내(B-12)');

    // 저장 키는 고정 화면이거나 내 폴더만
    assert.equal((await c.put('/api/drive/prefs', { folderId: '__proto__', sort: 'largest' })).status, 404);
    assert.equal((await c.put('/api/drive/prefs', { folderId: 'f_made_up', view: 'list' })).status, 404);
    const { u: o } = newUser();
    assert.equal((await c.put('/api/drive/prefs', { folderId: createFolder(s.db, o.id, null, 'x').id, view: 'list' })).status, 404);
    assert.equal((await c.put('/api/drive/prefs', { folderId: 'recent', view: 'list' })).status, 200);
    const saved = JSON.parse(s.db.prepare('SELECT settings FROM users WHERE id=?').get(u.id).settings);
    assert.deepEqual(Object.keys(saved.viewPrefs).sort(), [dir.id, 'recent'].sort());
    assert.ok(!Object.hasOwn(saved.sortPrefs, '__proto__'));
  });

  await t.test('[B-05] 검색 결과가 500개를 넘으면 정렬을 먼저 적용해 앞 500개만 주고 truncated 로 알린다', async () => {
    const { u, c } = newUser();
    for (let i = 1; i <= 501; i++) createFileNode(s.db, u.id, null, { name: `m${i}.bin`, size: i });
    const r = (await c.get('/api/drive/search?q=m&sort=largest')).body;
    assert.equal(r.items.length, 500);
    assert.equal(r.truncated, true);
    assert.equal(r.items[0].size, 501, '잘리기 전 전체에서 가장 큰 파일');
    assert.equal((await c.get('/api/drive/search?q=m50')).body.truncated, false);
  });

  await t.test('[B-06] 업로드: 폴더 경로 생성, 업로드 쿼터 차감, 용량 초과·쿼터 초과 거부', async () => {
    const { u, c } = newUser();
    const dir = createFolder(s.db, u.id, null, '올림');
    const r = await upload(c, { parentId: dir.id, path: '사진/2026', name: '한글 이름.png', data: 'png-bytes', type: 'application/octet-stream' });
    assert.equal(r.status, 201);
    assert.equal(r.body.file.name, '한글 이름.png');
    assert.equal(r.body.file.mime, 'image/png');
    assert.equal(r.body.file.origin, 'upload');
    const p = (await c.get(`/api/drive/files/${r.body.file.id}`)).body.path.map((x) => x.name);
    assert.deepEqual(p, ['올림', '사진', '2026']);
    await upload(c, { parentId: dir.id, path: '사진/2026', name: 'b.png' });
    assert.equal((await c.get(`/api/drive/list?parentId=${dir.id}`)).body.items.length, 1, '같은 경로 폴더는 다시 만들지 않음');
    assert.equal(summary(s.db, u).month.up.used, 9 + 5);

    const { u: full, c: fc } = newUser();
    createFileNode(s.db, full.id, null, { name: 'big', size: 6 * GB - 10 });
    const over = await upload(fc, { data: 'x'.repeat(100) });
    assert.equal(over.status, 413);
    assert.equal(over.body.error, 'storage_full');
    assert.equal((await fc.get('/api/drive/list')).body.items.length, 1);

    const { u: q, c: qc } = newUser();
    addUsage(s.db, q.id, 'up', MONTHLY_QUOTA.up);
    assert.equal((await upload(qc)).status, 429);
    assert.equal((await upload(c, { parentId: 'f_nope' })).status, 404);
  });

  await t.test('[B-06] Content-Length 없는 chunked 업로드도 월 업로드 쿼터·연결 앱 25% 몫을 넘지 못함', async () => {
    const { u, c } = newUser();
    const token = sessionFor(s.db, u.id);
    addUsage(s.db, u.id, 'up', MONTHLY_QUOTA.up - 10);
    const over = await chunkedUpload(s.url, token, 'x'.repeat(5000));
    assert.equal(over.status, 429);
    assert.equal(over.body.error, 'monthly_quota');
    assert.equal(summary(s.db, u).month.up.used, MONTHLY_QUOTA.up - 10);
    assert.equal((await c.get('/api/drive/list')).body.items.length, 0);
    assert.equal((await chunkedUpload(s.url, token, 'small')).status, 201, '남은 10바이트 안은 허용');

    const { u: a } = newUser();
    addUsage(s.db, a.id, 'up', MONTHLY_QUOTA.up * APP_QUOTA_SHARE - 10, 'app');
    const app = createToken(s.db, a.id, { name: 'cli', scopes: ['files:write'], appId: 'cli' }).token;
    const r = await chunkedUpload(s.url, app, 'x'.repeat(5000));
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'app_quota');
    assert.equal((await chunkedUpload(s.url, sessionFor(s.db, a.id), 'x'.repeat(5000))).status, 201, '공식 웹은 앱 몫과 무관');
  });

  await t.test('[B-06] 업로드 중 연결이 끊기면 임시 파일을 지우고 요청을 끝낸다', async () => {
    const { u } = newUser();
    const tmp = path.join(s.dataDir, 'tmp');
    const pending = () => (fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((n) => n.startsWith('up_')) : []);
    const b = 'mimicAbort';
    const req = http.request(s.url + '/api/drive/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionFor(s.db, u.id)}`, 'content-type': `multipart/form-data; boundary=${b}`, 'content-length': 1_000_000 },
    });
    req.on('error', () => {});
    req.write(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="cut.bin"\r\n\r\n`);
    req.write(Buffer.alloc(64 * 1024, 1));
    assert.ok(await until(() => pending().length === 1), '받는 동안 임시 파일이 생김');
    req.destroy();
    assert.ok(await until(() => pending().length === 0), '끊긴 뒤 임시 파일이 지워짐');
    assert.equal(summary(s.db, u).month.up.used, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id=?').get(u.id).n, 0);
  });

  await t.test('[B-07] 기기로 다운로드: 첨부·이어받기(Range)·다운스트림 쿼터 차감', async () => {
    const { u, c } = newUser();
    const f = (await upload(c, { name: 'movie.bin', data: '0123456789' })).body.file;
    const full = await c.get(`/api/drive/files/${f.id}/download`);
    assert.equal(full.status, 200);
    assert.equal(full.body, '0123456789');
    const part = await c.get(`/api/drive/files/${f.id}/download`, { range: 'bytes=2-5' });
    assert.equal(part.status, 206);
    assert.equal(part.body, '2345');
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.ok(await until(() => summary(s.db, u).month.down.used === 14));
    const { c: other } = newUser();
    assert.equal((await other.get(`/api/drive/files/${f.id}/download`)).status, 404);
  });

  await t.test('[B-07] 다운로드 감속: 일일·월 한도를 넘거나 만료 3단계면 SLOW_BPS, 프리미엄은 일일 한도 없음', async () => {
    const data = 'z'.repeat(SLOW_BPS / 2); // 감속이면 약 500ms, 평소(무료 2MB/s)면 약 25ms
    const timed = async (c, id) => {
      const t0 = Date.now();
      const r = await c.get(`/api/drive/files/${id}/download`);
      assert.equal(r.status, 200);
      assert.equal(r.body.length, data.length);
      return Date.now() - t0;
    };
    const mk = (opts) => {
      const { u, c } = newUser(opts);
      return upload(c, { name: 'z.bin', data }).then((r) => ({ u, c, id: r.body.file.id }));
    };

    const free = await mk();
    const fast = await timed(free.c, free.id);
    assert.ok(fast < 400, `평소 속도 ${fast}ms`);
    addUsage(s.db, free.u.id, 'down', LIMITS.free.dailyDown);
    const slow = await timed(free.c, free.id);
    assert.ok(slow >= 450, `일일 한도 초과면 감속 ${slow}ms`);

    const expiring = await mk();
    saveSettings(s.db, expiring.u.id, { expiryStage: 3 });
    assert.ok((await timed(expiring.c, expiring.id)) >= 450, '만료 3단계면 감속');

    const prem = await mk({ premium: true });
    addUsage(s.db, prem.u.id, 'down', LIMITS.free.dailyDown);
    assert.ok((await timed(prem.c, prem.id)) < 400, '프리미엄은 일일 한도가 없어 speedFor 속도');
    addUsage(s.db, prem.u.id, 'down', MONTHLY_QUOTA.down);
    assert.ok((await timed(prem.c, prem.id)) >= 450, '월 한도는 프리미엄도 감속');
  });

  await t.test('[B-07] 동시 연결: 보내는 중인 바이트도 한도에 넣어 분할·병렬 다운로드로 일일 한도를 넘지 못함', async () => {
    const { u, c } = newUser();
    const L = 2 * 1024 * 1024; // 무료 2MB/s 라 약 1초 걸려 두 번째 요청 때 첫 연결이 아직 보내는 중
    const f = (await upload(c, { name: 'big.bin', data: 'x'.repeat(L) })).body.file;
    addUsage(s.db, u.id, 'down', LIMITS.free.dailyDown - 1.5 * L); // 남은 양 1.5L: 하나는 되고 둘은 넘는다
    const tok = sessionFor(s.db, u.id);
    const url = `${s.url}/api/drive/files/${f.id}/download`;
    const ac = new AbortController();
    const open = (method = 'GET') => fetch(url, { method, headers: { authorization: `Bearer ${tok}` }, signal: method === 'GET' ? ac.signal : undefined });
    const a = await open();
    assert.equal(a.headers.get('x-mimic-throttled'), null, '첫 연결은 평소 속도');
    const b = await open();
    assert.equal(b.headers.get('x-mimic-throttled'), 'daily_quota', '첫 연결이 보내는 중이면 둘째는 감속');
    ac.abort();
    // 연결이 끊기면 진행분이 빠지고 실제로 보낸 만큼만 적힌다
    assert.ok(await until(async () => !(await open('HEAD')).headers.get('x-mimic-throttled')), '끊긴 연결의 진행분은 남지 않는다');
  });

  await t.test('[B-09] 웹은 첨부 다운로드로 저장 위치를 브라우저에 맡긴다(SD카드 저장은 Android 앱 기능)', async () => {
    const { c } = newUser();
    const f = (await upload(c, { name: '노래.mp3', data: 'mp3' })).body.file;
    const r = await c.get(`/api/drive/files/${f.id}/download`);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
  });

  await t.test('[B-10] 최근 저장됨: 30일 안의 파일만 최신순', async () => {
    const { u, c } = newUser();
    const mk = (name, ago) => {
      const n = createFileNode(s.db, u.id, null, { name, size: 1 });
      s.db.prepare('UPDATE files SET created_at=? WHERE id=?').run(now() - ago, n.id);
    };
    mk('old.txt', 40 * DAY);
    mk('mid.txt', 2 * DAY);
    mk('new.txt', 1000);
    createFolder(s.db, u.id, null, '폴더는 제외');
    assert.deepEqual(names((await c.get('/api/drive/recent')).body.items), ['new.txt', 'mid.txt']);
  });

  await t.test('[B-11] 즐겨찾기 추가·해제·모아보기', async () => {
    const { u, c } = newUser();
    const a = createFileNode(s.db, u.id, null, { name: 'a', size: 1 });
    const b = createFolder(s.db, u.id, null, 'b');
    await c.post('/api/drive/star', { ids: [a.id, b.id], starred: true });
    assert.deepEqual(names((await c.get('/api/drive/starred')).body.items), ['b', 'a']);
    await c.post('/api/drive/star', { ids: [a.id], starred: false });
    assert.deepEqual(names((await c.get('/api/drive/starred')).body.items), ['b']);
    assert.equal((await c.post('/api/drive/star', { ids: [a.id], starred: 'yes' })).status, 400);
  });

  await t.test('[B-12] 다중 선택 일괄 작업: 이동·즐겨찾기·휴지통·복원', async () => {
    const { u, c } = newUser();
    const dest = createFolder(s.db, u.id, null, '모음');
    const ids = ['1', '2', '3'].map((n) => createFileNode(s.db, u.id, null, { name: `${n}.txt`, size: 1 }).id);
    assert.equal((await c.post('/api/drive/move', { ids, parentId: dest.id })).body.items.length, 3);
    await c.post('/api/drive/star', { ids, starred: true });
    assert.equal((await c.get('/api/drive/starred')).body.items.length, 3);
    await c.post('/api/drive/trash', { ids });
    assert.equal((await c.get('/api/drive/trash')).body.items.length, 3);
    await c.post('/api/drive/restore', { ids });
    assert.equal((await c.get(`/api/drive/list?parentId=${dest.id}`)).body.items.length, 3);
    assert.equal((await c.post('/api/drive/trash', { ids: [] })).status, 400);
  });

  await t.test('[K-08] 가입 시 My Pack·튜토리얼 영상·클라우드 다운로드 보너스 2회', async () => {
    const u = createUser(s.db);
    try {
      s.ctx.events.emit('user:created', { userId: u.id, via: 'email' });
    } catch (e) {
      t.diagnostic(`다른 모듈의 user:created 처리 오류: ${e.message}`);
    }
    const c = client(s.url, sessionFor(s.db, u.id));
    const root = (await c.get('/api/drive/list')).body.items;
    const pack = root.find((x) => x.name === 'My Pack');
    assert.ok(pack);
    assert.equal(pack.meta.default, true);
    assert.equal(summary(s.db, u).today.cloudTasks.bonusLeft, 2);

    const hash = await tutorialBlob(s.ctx);
    if (!hash) return t.diagnostic('ffmpeg 가 없어 튜토리얼 영상 확인을 건너뜀');
    assert.ok(await until(async () => (await c.get(`/api/drive/list?parentId=${pack.id}`)).body.items.length === 1, 10_000));
    const video = (await c.get(`/api/drive/list?parentId=${pack.id}`)).body.items[0];
    assert.equal(video.name, '미믹 시작하기.mp4');
    assert.equal(video.mime, 'video/mp4');
    assert.ok(video.size > 1000);

    // 두 번째 가입자는 같은 blob 을 재사용, 같은 이벤트가 또 와도 중복 생성 없음
    const v = createUser(s.db);
    const { onboard } = await import('../server/modules/drive/index.js');
    await onboard(s.ctx, v.id);
    await onboard(s.ctx, v.id);
    const vPack = s.db.prepare("SELECT id FROM files WHERE user_id=? AND name='My Pack'").all(v.id);
    assert.equal(vPack.length, 1);
    const vFiles = s.db.prepare('SELECT blob_hash FROM files WHERE user_id=? AND parent_id=?').all(v.id, vPack[0].id);
    assert.deepEqual(vFiles.map((x) => x.blob_hash), [hash]);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM quota_grants WHERE user_id=? AND reason='signup_bonus'").get(v.id).n, 1);
  });
});
