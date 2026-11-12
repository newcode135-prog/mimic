import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { ingestStream } from '../server/core/storage.js';
import { createFolder, createFileNode, listChildren } from '../server/core/files.js';
import { saveSettings, createToken } from '../server/core/auth.js';
import { DAY } from '../server/core/util.js';

test('share: 공유 링크·코드·보기·업데이트·옵션', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const owner = createUser(s.db, { name: '홍길동' });
  const bob = createUser(s.db, { name: '받는이' });
  const O = client(s.url, sessionFor(s.db, owner.id));
  const B = client(s.url, sessionFor(s.db, bob.id));
  const G = client(s.url);

  const put = async (parentId, name, text, mime = 'text/plain') => {
    const blob = await ingestStream(s.db, s.cfg, Readable.from([Buffer.from(text)]), mime);
    return createFileNode(s.db, owner.id, parentId, { name, size: blob.size, mime, blobHash: blob.hash, origin: 'upload' });
  };
  const trip = createFolder(s.db, owner.id, null, '여행');
  const inner = createFolder(s.db, owner.id, trip.id, '사진');
  await put(trip.id, 'a.txt', 'hello-a');
  await put(inner.id, 'b.txt', 'hello-b');
  const loose = await put(null, 'memo.txt', 'memo');
  const secret = await put(null, 'secret.txt', 'not shared');

  const make = async (body) => {
    const r = await O.post('/api/share', body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };

  await t.test('[D-01] 공유 링크 생성·나의 공유 목록·취소', async () => {
    const r = await make({ fileIds: [trip.id, loose.id] });
    assert.match(r.url, /^\/s\/[A-Za-z0-9_-]{22,}$/);
    assert.equal(r.share.title, '여행');
    assert.equal(r.share.fileIds.length, 2);
    const mine = await O.get('/api/share/mine');
    assert.ok(mine.body.items.some((x) => x.id === r.share.id));
    // 받는 사람: 로그인 없이 목록, 공유하지 않은 파일·폴더는 못 봄
    const root = await G.get(`/api/share/public/${r.share.token}/list`);
    assert.deepEqual(root.body.items.map((x) => x.name), ['여행', 'memo.txt']);
    const sub = await G.get(`/api/share/public/${r.share.token}/list?folderId=${inner.id}`);
    assert.deepEqual(sub.body.path.map((x) => x.name), ['여행', '사진']);
    assert.equal((await G.get(`/api/share/public/${r.share.token}/list?folderId=${secret.id}`)).status, 404);
    // 남의 파일은 공유 불가
    assert.equal((await B.post('/api/share', { fileIds: [trip.id] })).status, 404);
    assert.equal((await B.del(`/api/share/${r.share.id}`)).status, 404);
    // 취소
    assert.equal((await O.del(`/api/share/${r.share.id}`)).status, 200);
    assert.equal((await G.get(`/api/share/public/${r.share.token}`)).body.error, 'share_revoked');
    assert.equal((await G.get(`/api/share/public/${r.share.token}/list`)).status, 410);
    assert.ok(!(await O.get('/api/share/mine')).body.items.some((x) => x.id === r.share.id));
  });

  await t.test('[D-05] 만료일·비밀번호·재생/다운로드(로그인·쿼터)·내 드라이브 저장', async () => {
    assert.equal((await O.post('/api/share', { fileIds: [loose.id], expiryDays: 3 })).status, 400);
    const week = await make({ fileIds: [loose.id], expiryDays: 7 });
    assert.ok(Math.abs(week.share.expiresAt - (Date.now() + 7 * DAY)) < 60_000);
    s.db.prepare('UPDATE share_links SET expires_at=? WHERE id=?').run(Date.now() - 1, week.share.id);
    assert.equal((await G.get(`/api/share/public/${week.share.token}`)).body.error, 'share_expired');
    assert.equal((await B.get(`/api/share/public/${week.share.token}/files/${loose.id}/download`)).status, 410);

    const r = await make({ fileIds: [trip.id, loose.id], password: true, expiryDays: 0 });
    assert.match(r.password, /^[a-z0-9]{4}$/);
    assert.equal(r.share.expiresAt, null);
    const row = s.db.prepare('SELECT password_hash FROM share_links WHERE id=?').get(r.share.id);
    assert.ok(row.password_hash && !row.password_hash.includes(r.password));
    const tk = r.share.token;
    const info = await G.get(`/api/share/public/${tk}`);
    assert.equal(info.body.share.needsPassword, true);
    assert.equal(info.body.share.title, null);
    assert.equal(info.body.share.owner, '홍*동');
    assert.equal((await G.get(`/api/share/public/${tk}/list`)).body.error, 'password_required');
    assert.equal((await G.post(`/api/share/public/${tk}/unlock`, { password: 'zzzz' })).body.error, 'wrong_password');
    const un = await G.post(`/api/share/public/${tk}/unlock`, { password: r.password });
    assert.ok(un.body.accessToken);
    assert.match(un.headers.get('set-cookie'), /mimic_share=.*Path=\/api\/share\/public\//);
    const hdr = { 'x-share-access': un.body.accessToken };
    assert.equal((await G.get(`/api/share/public/${tk}/list`, hdr)).status, 200);
    assert.equal((await G.get(`/api/share/public/${tk}/list`, { 'x-share-access': un.body.accessToken.replace(/.$/, 'x') })).status, 403);

    // 재생·다운로드는 로그인 필요, 받는 사람 쿼터에서 차감, 조회 수 증가
    assert.equal((await G.get(`/api/share/public/${tk}/files/${loose.id}/download`, hdr)).status, 401);
    const dl = await B.get(`/api/share/public/${tk}/files/${loose.id}/download`, hdr);
    assert.equal(dl.status, 200);
    assert.equal(dl.body, 'memo');
    assert.equal((await B.get(`/api/share/public/${tk}/files/${secret.id}/download`, hdr)).status, 404);
    await sleep(50);
    const used = s.db.prepare("SELECT SUM(amount) AS n FROM quota_usage WHERE user_id=? AND kind='down' AND period LIKE 'm:%'").get(bob.id);
    assert.equal(Number(used.n), 4);
    assert.equal(s.db.prepare('SELECT view_count FROM share_links WHERE id=?').get(r.share.id).view_count, 1);
    // HEAD·처음부터 다시 받기(재생기가 여러 번 보냄)는 조회 수를 다시 올리지 않는다
    const raw = (method, headers = {}) => fetch(`${s.url}/api/share/public/${tk}/files/${loose.id}/download`, { method, headers: { authorization: `Bearer ${sessionFor(s.db, bob.id)}`, ...hdr, ...headers } });
    await raw('HEAD');
    await (await raw('GET', { range: 'bytes=0-' })).arrayBuffer();
    assert.equal(s.db.prepare('SELECT view_count FROM share_links WHERE id=?').get(r.share.id).view_count, 1);
    // 서명에 비ASCII 문자가 와도 500 이 아니라 403
    // (latin1 é 43자: 글자 수는 서명 길이와 같고 바이트 수는 다르다)
    assert.equal((await G.get(`/api/share/public/${tk}/list`, { 'x-share-access': `${Date.now() + DAY}.${'é'.repeat(43)}` })).status, 403);

    // 비밀번호 해제 → 누구나 접근, 바꾸면 이전 토큰 무효
    const pw2 = await O.patch(`/api/share/${r.share.id}`, { password: 'abcd' });
    assert.equal(pw2.body.password, 'abcd');
    assert.equal((await G.get(`/api/share/public/${tk}/list`, hdr)).status, 403);
    await O.patch(`/api/share/${r.share.id}`, { password: null });
    assert.equal((await G.get(`/api/share/public/${tk}/list`)).status, 200);

    // 내 드라이브로 저장(전체·일부), 공유 범위 밖은 거부, 저장 수 증가
    assert.equal((await G.post(`/api/share/public/${tk}/save`, {})).status, 401);
    const box = createFolder(s.db, bob.id, null, '받은 것');
    const saved = await B.post(`/api/share/public/${tk}/save`, { parentId: box.id });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(listChildren(s.db, bob.id, box.id).map((x) => x.name).sort(), ['memo.txt', '여행']);
    assert.ok(saved.body.items.every((x) => x.origin === 'share'));
    const one = await B.post(`/api/share/public/${tk}/save`, { fileIds: [inner.id] });
    assert.equal(one.body.items[0].name, '사진');
    assert.equal((await B.post(`/api/share/public/${tk}/save`, { fileIds: [secret.id] })).status, 404);
    assert.equal((await B.post(`/api/share/public/${tk}/save`, { parentId: trip.id })).status, 404);
    assert.equal(s.db.prepare('SELECT save_count FROM share_links WHERE id=?').get(r.share.id).save_count, 2);
  });

  await t.test('[D-02] 공유 코드 설정·전역 고유·코드로 찾기(바로/경고)', async () => {
    const a = await make({ fileIds: [loose.id] });
    const b = await make({ fileIds: [trip.id] });
    assert.equal((await O.post(`/api/share/${a.share.id}/code`, { code: 'ab' })).body.error, 'invalid_code');
    assert.equal((await O.post(`/api/share/${a.share.id}/code`, { code: 'has space' })).body.error, 'invalid_code');
    assert.equal((await O.post(`/api/share/${a.share.id}/code`, { code: 'Mimic#24' })).status, 200);
    assert.equal((await O.post(`/api/share/${b.share.id}/code`, { code: 'mimic#24' })).body.error, 'code_taken');
    assert.equal((await B.post(`/api/share/${a.share.id}/code`, { code: 'Other_1' })).status, 404);

    const look = await B.get(`/api/share/lookup?code=${encodeURIComponent('MIMIC#24')}`);
    assert.equal(look.body.token, a.share.token);
    assert.equal(look.body.warn, false);
    saveSettings(s.db, bob.id, { shareCodeDisplay: 'warn' });
    assert.equal((await B.get(`/api/share/lookup?code=${encodeURIComponent('Mimic#24')}`)).body.warn, true);
    assert.equal((await B.get('/api/share/lookup?code=nope1')).status, 404);
    assert.equal((await G.get('/api/share/lookup?code=Mimic%2324')).status, 401);
    // services 토큰도 /mine 처럼 코드로 찾는다
    const svc = client(s.url, createToken(s.db, bob.id, { name: 'svc-look', scopes: ['services'] }).token);
    assert.equal((await svc.get(`/api/share/lookup?code=${encodeURIComponent('Mimic#24')}`)).body.token, a.share.token);
    // 취소하면 코드도 풀린다
    await O.del(`/api/share/${a.share.id}`);
    assert.equal((await B.get(`/api/share/lookup?code=${encodeURIComponent('Mimic#24')}`)).status, 404);
    assert.equal((await O.post(`/api/share/${b.share.id}/code`, { code: 'mimic#24' })).status, 200);
  });

  await t.test('[D-03] 받는 사람 기본 보기 방식(공유별·설정 기본값)', async () => {
    const g = await make({ fileIds: [loose.id], viewMode: 'grid' });
    assert.equal((await G.get(`/api/share/public/${g.share.token}`)).body.share.viewMode, 'grid');
    assert.equal((await O.post('/api/share', { fileIds: [loose.id], viewMode: 'tiles' })).status, 400);
    // 설정이 없으면 환경설정 화면과 같은 기본값 grid
    const d = await make({ fileIds: [loose.id] });
    assert.equal(d.share.viewMode, 'grid');
    saveSettings(s.db, owner.id, { shareDefaultView: 'list' });
    const d2 = await make({ fileIds: [loose.id] });
    assert.equal(d2.share.viewMode, 'list');
    await O.patch(`/api/share/${d2.share.id}`, { viewMode: 'grid' });
    assert.equal((await G.get(`/api/share/public/${d2.share.token}`)).body.share.viewMode, 'grid');
  });

  await t.test('[D-04] 공유 폴더에 새 파일 → 받는 사람 화면 반영·업데이트 표시·동기화', async () => {
    const r = await make({ fileIds: [trip.id] });
    const tk = r.share.token;
    const sv = await B.post(`/api/share/public/${tk}/save`, {});
    const copyId = sv.body.items[0].id;
    let saved = (await B.get('/api/share/saved')).body.items.find((x) => x.savedRootId === copyId);
    assert.equal(saved.hasUpdates, false);
    assert.equal(saved.kind, 'folder');

    await sleep(5);
    const fresh = await put(inner.id, 'new.txt', 'new-file');
    // 공유 링크는 지금 내용을 그대로 보여 준다
    const live = await G.get(`/api/share/public/${tk}/list?folderId=${inner.id}`);
    assert.ok(live.body.items.some((x) => x.id === fresh.id));
    saved = (await B.get('/api/share/saved')).body.items.find((x) => x.savedRootId === copyId);
    assert.equal(saved.hasUpdates, true);

    const sync = await B.post(`/api/share/saved/${saved.id}/sync`, {});
    assert.equal(sync.body.added, 1);
    const copyInner = listChildren(s.db, bob.id, copyId).find((x) => x.name === '사진');
    assert.ok(listChildren(s.db, bob.id, copyInner.id).some((x) => x.name === 'new.txt' && x.origin === 'share'));
    assert.equal((await B.get('/api/share/saved')).body.items.find((x) => x.id === saved.id).hasUpdates, false);
    assert.equal((await B.post(`/api/share/saved/${saved.id}/sync`, {})).body.added, 0);
    // 다른 사람의 저장 기록은 동기화 불가, 취소된 공유는 동기화 불가
    assert.equal((await O.post(`/api/share/saved/${saved.id}/sync`, {})).status, 404);
    // 읽기 전용 토큰은 저장 기록(동기화 연결)을 지울 수 없다
    const ro = client(s.url, createToken(s.db, bob.id, { name: 'ro', scopes: ['files:read'] }).token);
    assert.equal((await ro.del(`/api/share/saved/${saved.id}`)).status, 403);
    assert.ok((await B.get('/api/share/saved')).body.items.some((x) => x.id === saved.id));
    await O.del(`/api/share/${r.share.id}`);
    assert.equal((await B.post(`/api/share/saved/${saved.id}/sync`, {})).status, 410);
  });

  await t.test('[D-04] 비밀번호를 바꾸면 저장한 사람도 새 비밀번호로 다시 풀어야 동기화', async () => {
    const r = await make({ fileIds: [trip.id], password: 'abc123' });
    const tk = r.share.token;
    const un = await B.post(`/api/share/public/${tk}/unlock`, { password: 'abc123' });
    const sv = await B.post(`/api/share/public/${tk}/save`, {}, { 'x-share-access': un.body.accessToken });
    assert.equal(sv.status, 200, JSON.stringify(sv.body));
    const copyId = sv.body.items[0].id;
    await O.patch(`/api/share/${r.share.id}`, { password: 'newpw9' });
    await sleep(5);
    await put(trip.id, 'after-pw.txt', 'after');
    let saved = (await B.get('/api/share/saved')).body.items.find((x) => x.savedRootId === copyId);
    assert.equal(saved.locked, true);
    assert.equal(saved.hasUpdates, false);
    assert.equal((await B.post(`/api/share/saved/${saved.id}/sync`, {})).body.error, 'password_required');
    assert.ok(!listChildren(s.db, bob.id, copyId).some((x) => x.name === 'after-pw.txt'));
    // 새 비밀번호로 풀면 다시 따라간다
    assert.equal((await B.post(`/api/share/public/${tk}/unlock`, { password: 'newpw9' })).status, 200);
    saved = (await B.get('/api/share/saved')).body.items.find((x) => x.savedRootId === copyId);
    assert.equal(saved.locked, false);
    assert.equal(saved.hasUpdates, true);
    assert.equal((await B.post(`/api/share/saved/${saved.id}/sync`, {})).body.added, 1);
  });

  await t.test('[D-05] 미리보기(inline)는 영상·음성·이미지만, HTML 은 내려받기 + nosniff·CSP', async () => {
    const html = await put(null, 'evil.html', '<script>document.title=1</script>', 'text/html');
    const svg = await put(null, 'x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', 'image/svg+xml');
    const png = await put(null, 'p.png', 'png-bytes', 'image/png');
    const r = await make({ fileIds: [html.id, svg.id, png.id] });
    const get = (id) => B.get(`/api/share/public/${r.share.token}/files/${id}/download?inline=1`);
    for (const id of [html.id, svg.id]) {
      const res = await get(id);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /^attachment/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('content-security-policy'), /sandbox/);
    }
    const img = await get(png.id);
    assert.match(img.headers.get('content-disposition'), /^inline/);
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('[D-01] 제목은 지금 이름을 따르고, services 토큰도 나의 공유를 본다', async () => {
    const f = await put(null, 'old-name.txt', 'x');
    const r = await make({ fileIds: [f.id] });
    s.db.prepare('UPDATE files SET name=? WHERE id=?').run('new-name.txt', f.id);
    assert.equal((await O.get('/api/share/mine')).body.items.find((x) => x.id === r.share.id).title, 'new-name.txt');
    assert.equal((await G.get(`/api/share/public/${r.share.token}`)).body.share.title, 'new-name.txt');
    const svc = client(s.url, createToken(s.db, owner.id, { name: 'svc', scopes: ['services'] }).token);
    const made = await svc.post('/api/share', { fileIds: [loose.id] });
    assert.equal(made.status, 200);
    const list = await svc.get('/api/share/mine');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((x) => x.id === made.body.share.id));
    const none = client(s.url, createToken(s.db, owner.id, { name: 'none', scopes: ['offline'] }).token);
    assert.equal((await none.get('/api/share/mine')).status, 403);
  });

  await t.test('[D-01] 공유 페이지에 소유자 초대 코드 노출(가입 유도)', async () => {
    const r = await make({ fileIds: [loose.id] });
    const info = await G.get(`/api/share/public/${r.share.token}`);
    assert.equal(info.body.share.inviteCode, owner.invite_code);
    assert.equal(info.body.share.isOwner, false);
    assert.equal((await O.get(`/api/share/public/${r.share.token}`)).body.share.isOwner, true);
  });

  await t.test('[D-01] 소유자가 탈퇴 신청·잠금·정지면 공유가 멈추고, 풀리면 다시 열린다', async () => {
    const carol = createUser(s.db, { name: '캐롤' });
    const C = client(s.url, sessionFor(s.db, carol.id));
    const box = createFolder(s.db, carol.id, null, 'box');
    const blob = await ingestStream(s.db, s.cfg, Readable.from([Buffer.from('c')]), 'text/plain');
    const f = createFileNode(s.db, carol.id, box.id, { name: 'c.txt', size: blob.size, mime: 'text/plain', blobHash: blob.hash, origin: 'upload' });
    const sh = (await C.post('/api/share', { fileIds: [box.id] })).body.share;
    const tk = sh.token;
    assert.equal((await C.post(`/api/share/${sh.id}/code`, { code: 'carol1' })).status, 200);
    const saved = (await B.post(`/api/share/public/${tk}/save`, {})).body.items[0];
    const rec = (await B.get('/api/share/saved')).body.items.find((x) => x.savedRootId === saved.id);
    const setStatus = (status, until = null) => s.db.prepare('UPDATE users SET status=?, status_until=? WHERE id=?').run(status, until, carol.id);
    const calls = () => [
      G.get(`/api/share/public/${tk}`),
      G.get(`/api/share/public/${tk}/list`),
      B.get(`/api/share/public/${tk}/files/${f.id}/download`),
      B.post(`/api/share/public/${tk}/save`, {}),
      B.post(`/api/share/saved/${rec.id}/sync`, {}),
      B.get('/api/share/lookup?code=carol1'), // [D-02] 코드로 찾기도 같은 기준
    ];
    for (const [st, until] of [['pending_delete'], ['locked'], ['suspended'], ['suspended', Date.now() + DAY]]) {
      setStatus(st, until);
      for (const r of await Promise.all(calls())) assert.equal(r.body.error, 'share_unavailable', `${st}: ${JSON.stringify(r.body)}`);
      assert.equal((await B.get('/api/share/saved')).body.items.find((x) => x.id === rec.id).status, 'unavailable');
    }
    setStatus('suspended', Date.now() - 1000); // 정지 기간이 지남
    assert.equal((await G.get(`/api/share/public/${tk}/list`)).status, 200);
    setStatus('active');
    for (const r of await Promise.all(calls())) assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  await t.test('[D-02] 기간이 끝난 공유의 코드는 다른 공유가 쓸 수 있고, 끝난 공유에는 코드를 못 건다', async () => {
    const a = await make({ fileIds: [loose.id] });
    const b = await make({ fileIds: [loose.id] });
    assert.equal((await O.post(`/api/share/${a.share.id}/code`, { code: 'gone7' })).status, 200);
    s.db.prepare('UPDATE share_links SET expires_at=? WHERE id=?').run(Date.now() - 1000, a.share.id);
    assert.equal((await O.post(`/api/share/${a.share.id}/code`, { code: 'gone8' })).status, 410);
    assert.equal((await B.get('/api/share/lookup?code=gone7')).status, 404);
    assert.equal((await O.post(`/api/share/${b.share.id}/code`, { code: 'GONE7' })).status, 200);
    assert.equal((await B.get('/api/share/lookup?code=gone7')).body.token, b.share.token);
  });

  await t.test('[D-04] 이동으로 들어온 파일도 업데이트로 잡고, 닫힌 공유는 원본의 새 이름을 숨긴다', async () => {
    const dir = createFolder(s.db, owner.id, null, 'mv-src');
    await put(dir.id, 'one.txt', 'one');
    const outside = await put(null, 'outside.txt', 'outside');
    const r = await make({ fileIds: [dir.id] });
    const copyId = (await B.post(`/api/share/public/${r.share.token}/save`, {})).body.items[0].id;
    const find = async () => (await B.get('/api/share/saved')).body.items.find((x) => x.savedRootId === copyId);
    assert.equal((await find()).hasUpdates, false);
    s.db.prepare('UPDATE files SET parent_id=? WHERE id=?').run(dir.id, outside.id); // drive 이동처럼 updated_at 은 그대로
    const v = await find();
    assert.equal(v.hasUpdates, true);
    assert.equal((await B.post(`/api/share/saved/${v.id}/sync`, {})).body.added, 1);
    assert.equal((await find()).hasUpdates, false);
    await O.del(`/api/share/${r.share.id}`);
    s.db.prepare('UPDATE files SET name=? WHERE id=?').run('renamed-after-revoke', dir.id);
    const closed = await find();
    assert.equal(closed.title, 'mv-src');
    assert.equal(closed.sourceName, null);
  });

  await t.test('[D-05] 만료 3단계(8-6)면 공유 영상 온라인 재생 차단, 다운로드는 가능', async () => {
    const vid = await put(null, 'clip.mp4', 'fake-video', 'video/mp4');
    const r = await make({ fileIds: [vid.id] });
    const url = `/api/share/public/${r.share.token}/files/${vid.id}/download`;
    const P = client(s.url, sessionFor(s.db, createUser(s.db, { premium: true }).id));
    assert.match((await P.get(`${url}?inline=1`)).headers.get('content-disposition'), /^inline/);
    saveSettings(s.db, bob.id, { expiryStage: 3 });
    try {
      assert.equal((await B.get(`${url}?inline=1`)).body.error, 'playback_blocked');
      assert.equal((await B.get(url)).status, 200);
    } finally {
      saveSettings(s.db, bob.id, { expiryStage: 0 });
    }
  });

  await t.test('[D-05] 공유 페이지 영상 재생도 화질 규칙(C-01): 무료는 720p 이하만 바로 재생, 원본은 프리미엄', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-share-'));
    try {
      const mk = async (name, size) => {
        const f = path.join(tmp, name);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10:duration=0.3`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
        return put(null, name, fs.readFileSync(f), 'video/mp4');
      };
      const big = await mk('big.mp4', '1280x1080');
      const small = await mk('small.mp4', '320x240');
      const fake = await put(null, 'broken.mkv', 'not-a-video', 'application/octet-stream'); // 확장자로만 영상
      const r = await make({ fileIds: [big.id, small.id, fake.id] });
      const url = (id, inline = true) => `/api/share/public/${r.share.token}/files/${id}/download${inline ? '?inline=1' : ''}`;
      const P = client(s.url, sessionFor(s.db, createUser(s.db, { premium: true }).id));
      // 무료: 1080p 원본·읽을 수 없는 영상은 바로 재생 불가, 720p 이하는 재생, 첨부 다운로드는 그대로
      assert.equal((await B.get(url(big.id))).body.error, 'premium_required');
      assert.equal((await B.get(url(fake.id))).body.error, 'premium_required');
      assert.match((await B.get(url(small.id))).headers.get('content-disposition'), /^inline/);
      assert.match((await B.get(url(big.id, false))).headers.get('content-disposition'), /^attachment/);
      // 공유한 사람이 무료여도 자기 공유에서 원본을 보지 못한다
      assert.equal((await O.get(url(big.id))).body.error, 'premium_required');
      // 프리미엄(글로벌)은 원본 그대로
      assert.match((await P.get(url(big.id))).headers.get('content-disposition'), /^inline/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('[D-01] 공유한 항목이 모두 휴지통·삭제면 나의 공유에 남은 개수 0, 받는 사람 목록은 빈다', async () => {
    const f = await put(null, 'gone.txt', 'gone');
    const r = await make({ fileIds: [f.id] });
    const mine = async () => (await O.get('/api/share/mine')).body.items.find((x) => x.id === r.share.id);
    assert.equal((await mine()).liveCount, 1);
    s.db.prepare('UPDATE files SET trashed_at=?, trash_root=1 WHERE id=?').run(Date.now(), f.id);
    const v = await mine();
    assert.equal(v.liveCount, 0);
    assert.equal(v.status, 'active');
    assert.deepEqual((await G.get(`/api/share/public/${r.share.token}/list`)).body.items, []);
  });

  await t.test('[D-04] 받는 사람이 사본을 지우거나 이름을 바꿔도, 원본 내용만 바뀌어도 업데이트가 아니다', async () => {
    const dir = createFolder(s.db, owner.id, null, 'track-src');
    await put(dir.id, 'one.txt', '1');
    await put(dir.id, 'two.txt', '2');
    const three = await put(dir.id, 'three.txt', '3');
    const r = await make({ fileIds: [dir.id] });
    const copyId = (await B.post(`/api/share/public/${r.share.token}/save`, {})).body.items[0].id;
    const find = async () => (await B.get('/api/share/saved')).body.items.find((x) => x.savedRootId === copyId);
    const names = () => listChildren(s.db, bob.id, copyId).map((x) => x.name).sort();
    const mine = (name) => listChildren(s.db, bob.id, copyId).find((x) => x.name === name);
    s.db.prepare('UPDATE files SET trashed_at=?, trash_root=1 WHERE id=?').run(Date.now(), mine('two.txt').id);
    s.db.prepare('UPDATE files SET name=? WHERE id=?').run('one-renamed.txt', mine('one.txt').id);
    const other = await ingestStream(s.db, s.cfg, Readable.from([Buffer.from('3-changed')]), 'text/plain');
    s.db.prepare('UPDATE files SET blob_hash=?, size=? WHERE id=?').run(other.hash, other.size, three.id);
    const v = await find();
    assert.equal(v.hasUpdates, false);
    assert.equal((await B.post(`/api/share/saved/${v.id}/sync`, {})).body.added, 0);
    assert.deepEqual(names(), ['one-renamed.txt', 'three.txt']);
    // 원본에 새로 생긴 파일만 가져온다
    await put(dir.id, 'four.txt', '4');
    assert.equal((await find()).hasUpdates, true);
    assert.equal((await B.post(`/api/share/saved/${v.id}/sync`, {})).body.added, 1);
    assert.deepEqual(names(), ['four.txt', 'one-renamed.txt', 'three.txt']);
    assert.equal((await find()).hasUpdates, false);
    // copied 가 없는 예전 기록은 지금 사본과 이름·해시로 한 번 맞춰 채운다. 이름·내용이 사본과 다른 항목은 그때만 예전 방식대로 새 파일로 보인다
    s.db.prepare('UPDATE share_saves SET copied=NULL WHERE id=?').run(v.id);
    assert.equal((await find()).hasUpdates, true);
    const back = JSON.parse(s.db.prepare('SELECT copied FROM share_saves WHERE id=?').get(v.id).copied);
    assert.equal(back[r.share.fileIds[0]], copyId);
  });
});
