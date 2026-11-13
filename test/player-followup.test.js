// 플레이어 후속: 데스크톱 앱 링크(C-03), 이전/다음 순서(C-04), 차단된 공유 안내(J-01)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { ingestStream } from '../server/core/storage.js';
import { createFolder, createFileNode } from '../server/core/files.js';
import { newId, now } from '../server/core/util.js';

const root = path.resolve(import.meta.dirname, '..');

test('player-followup: 서버', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const u = createUser(s.db);
  const c = client(s.url, sessionFor(s.db, u.id));
  const put = async (parentId, name, bytes, mime) => {
    const b = await ingestStream(s.db, s.cfg, Readable.from([Buffer.alloc(bytes, name)]), mime);
    return createFileNode(s.db, u.id, parentId, { name, size: b.size, mime, blobHash: b.hash, origin: 'upload' });
  };

  await t.test('[C-04] 이전/다음은 저장된 드라이브 정렬을 따른다', async () => {
    const dir = createFolder(s.db, u.id, null, '사진');
    const a = await put(dir.id, 'a.jpg', 30, 'image/jpeg');
    const b = await put(dir.id, 'b.jpg', 10, 'image/jpeg');
    const cc = await put(dir.id, 'c.jpg', 20, 'image/jpeg');
    const sib = async (id) => (await c.get(`/api/media/${id}/info`)).body.siblings;
    // 기본(이름순)은 예전과 같다
    assert.deepEqual(await sib(b.id), { prevId: a.id, nextId: cc.id, ids: [a.id, b.id, cc.id] });
    assert.equal((await c.put('/api/drive/prefs', { folderId: dir.id, sort: 'largest' })).status, 200);
    assert.deepEqual(await sib(cc.id), { prevId: a.id, nextId: b.id, ids: [a.id, cc.id, b.id] });
    // 드라이브 목록과 같은 순서
    const list = (await c.get(`/api/drive/list?parentId=${dir.id}`)).body.items.map((x) => x.id);
    assert.deepEqual(list, [a.id, cc.id, b.id]);
    // 루트 폴더는 'root' 키의 정렬
    const r1 = await put(null, 'x.jpg', 5, 'image/jpeg');
    const r2 = await put(null, 'y.jpg', 50, 'image/jpeg');
    assert.equal((await sib(r1.id)).nextId, r2.id);
    await c.put('/api/drive/prefs', { sort: 'name_desc' });
    assert.equal((await sib(r1.id)).prevId, r2.id);
  });

  await t.test('[C-03] 데스크톱 앱 링크에 파일 id 가 붙는다', async () => {
    const v = await put(null, 'v.mp4', 100, 'video/mp4'); // 읽을 수 없는 영상: mimicPlayable=false
    const r = await c.get(`/api/media/${v.id}/external-url`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mimic, `mimic://play?id=${v.id}&url=${encodeURIComponent(r.body.url)}`);
    assert.equal(r.body.mimicPlayable, false);
  });

  await t.test('[J-01] 차단된 공유는 나의 공유 목록에 blocked 로 보인다', async () => {
    const f = await put(null, 'shared.txt', 12, 'text/plain');
    const other = await put(null, 'fine.txt', 13, 'text/plain');
    const sh = (await c.post('/api/share', { fileIds: [f.id] })).body.share;
    const ok = (await c.post('/api/share', { fileIds: [other.id] })).body.share;
    const mine = async () => Object.fromEntries((await c.get('/api/share/mine')).body.items.map((x) => [x.id, x]));
    assert.equal((await mine())[sh.id].blocked, false);
    s.db.prepare('INSERT INTO blocklist (id, kind, value, reason, created_at) VALUES (?,?,?,?,?)').run(newId('bl_'), 'blob', f.blob_hash, 'report:test', now());
    const m = await mine();
    assert.equal(m[sh.id].blocked, true);
    assert.equal(m[sh.id].status, 'active');
    assert.equal(m[ok.id].blocked, false);
    // 하위 폴더 깊이 있는 파일도 찾는다
    const top = createFolder(s.db, u.id, null, '깊은');
    const sub = createFolder(s.db, u.id, top.id, '안');
    const deep = await put(sub.id, 'deep.txt', 14, 'text/plain');
    const dsh = (await c.post('/api/share', { fileIds: [top.id] })).body.share;
    assert.equal(dsh.blocked, false);
    s.db.prepare('INSERT INTO blocklist (id, kind, value, reason, created_at) VALUES (?,?,?,?,?)').run(newId('bl_'), 'blob', deep.blob_hash, 'report:test', now());
    assert.equal((await mine())[dsh.id].blocked, true);
  });

  await t.test('[J-01] 큰 공유 폴더도 나의 공유 목록이 바로 뜬다(하위 트리 질의가 색인을 쓴다)', async () => {
    const big = createFolder(s.db, u.id, null, '큰 폴더');
    const ins = s.db.prepare("INSERT INTO files (id, user_id, parent_id, space, kind, name, size, created_at, updated_at) VALUES (?,?,?,'drive','file',?,1,?,?)");
    s.db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) ins.run(newId('f_'), u.id, big.id, `n${i}.txt`, now(), now());
    s.db.exec('COMMIT');
    const t0 = Date.now();
    const r = await c.post('/api/share', { fileIds: [big.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await c.get('/api/share/mine')).status, 200);
    // 색인을 안 쓰면 (하위 수 × 사용자 파일 수)라 수 초가 걸린다
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
  });
});

test('[C-03] 데스크톱: mimic://play 는 앱 계정이 열 수 있으면 /play/<id>, 아니면 재생 링크', () => {
  const appOn = {};
  const opened = [];
  const checked = [];
  let errors = 0;
  let status = 200; // 앱 로그인 계정으로 /api/media/<id>/info 를 부른 결과(null 이면 연결 오류)
  const net = {
    request: (o) => {
      const h = {};
      checked.push(o);
      return { on: (ev, fn) => (h[ev] = fn), end: () => (status === null ? h.error(new Error('down')) : h.response({ statusCode: status, on: () => {} })) };
    },
  };
  class BrowserWindow {
    loadURL(u) {
      opened.push(u);
    }
  }
  const electron = {
    app: { on: (ev, fn) => (appOn[ev] = fn), requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), getPath: () => '' },
    BrowserWindow,
    net,
    shell: { openExternal: () => {} },
    dialog: { showErrorBox: () => errors++, showMessageBox: async () => ({ response: 0 }) },
  };
  const req = (m) => (m === 'electron' ? electron : { fs, path }[m]);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8'), { require: req, process: { argv: [], env: {} }, __dirname: path.join(root, 'desktop'), URL, console });
  const wc = { on: () => {}, setWindowOpenHandler: (fn) => (wc.open = fn) };
  appOn['web-contents-created']({}, wc);
  const S = 'http://localhost:4300'; // main.js 기본 서버 주소(접속하지 않는다)
  const play = (q) => wc.open({ url: `mimic://play?${q}` });
  const url = `${S}/api/media/x/tok.sig/a.mp4`;

  play(`id=f_abc-1&url=${encodeURIComponent(url)}`);
  assert.deepEqual(opened, [`${S}/play/f_abc-1`], '서버 변환을 쓰는 미믹 플레이어로');
  assert.deepEqual(checked.map((o) => [o.url, o.useSessionCookies]), [[`${S}/api/media/f_abc-1/info`, true]]);
  status = 404; // 앱이 브라우저와 다른 계정
  play(`id=f_abc-1&url=${encodeURIComponent(url)}`);
  assert.equal(opened.at(-1), url, '앱 계정이 못 여는 파일은 서명 재생 링크로');
  status = 401; // 앱이 로그인 전
  play(`id=f_abc-1&url=${encodeURIComponent(url)}`);
  assert.equal(opened.at(-1), url);
  status = null;
  play(`id=f_abc-1&url=${encodeURIComponent(url)}`);
  assert.equal(opened.at(-1), url, '확인 실패도 재생 링크로');
  const n = checked.length;
  play(`url=${encodeURIComponent(url)}`);
  assert.equal(opened.at(-1), url, '예전 링크는 재생 링크 그대로');
  play(`id=${encodeURIComponent('../admin')}&url=${encodeURIComponent(url)}`);
  assert.equal(opened.at(-1), url, '이상한 id 는 무시');
  assert.equal(checked.length, n, 'id 가 없거나 이상하면 확인 요청도 없다');
  play(`id=f_abc&url=${encodeURIComponent('https://other.test/api/media/x/t/a.mp4')}`);
  assert.equal(opened.length, 6, '다른 서버의 링크는 열지 않는다');
  assert.equal(errors, 1);
});

test('[C-03·J-01] 화면 파일 문법 확인', () => {
  for (const f of ['web/pages/drive.js', 'web/pages/shared.js']) execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
});
