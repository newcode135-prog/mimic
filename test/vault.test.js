import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { createToken, hashPassword } from '../server/core/auth.js';
import { sha256 } from '../server/core/util.js';
import { listChildren, usage, createFileNode } from '../server/core/files.js';
import { blobPath } from '../server/core/storage.js';
import { VAULT_STORAGE } from '../server/core/plans.js';
import * as vc from '../web/pages/vault-crypto.js';

// 증명값으로 잠금 해제 토큰을 받아 헤더로 만든다(E-03)
async function unlockH(c, proof) {
  const r = await c.post('/api/vault/unlock', { proof });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { 'x-vault-token': r.body.token };
}
// 브라우저 화면이 하는 일을 그대로 흉내 낸다: 금고 만들기 → 증명값으로 잠금 해제 → 토큰으로 API 호출
async function openVault(s, { premium = true, passcode = '246810' } = {}) {
  const u = createUser(s.db, { premium });
  const sess = sessionFor(s.db, u.id);
  const c = client(s.url, sess);
  const { master, body } = await vc.createVault(passcode);
  const r = await c.post('/api/vault/setup', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { u, c, sess, master, proof: body.proof, H: await unlockH(c, body.proof) };
}
async function uploadFile(v, { name = '비밀 메모.txt', data = new TextEncoder().encode('미믹 금고 평문'), mime = 'text/plain', parentId = '' } = {}) {
  const fileKey = await vc.newKey();
  const cipher = await vc.encryptBlob(fileKey, new Blob([data]));
  const meta = await vc.sealFileMeta(v.master, fileKey, { name, mime, size: data.length });
  const fd = new FormData();
  fd.append('parentId', parentId);
  fd.append('encMeta', JSON.stringify(meta));
  fd.append('file', cipher, 'blob');
  const r = await v.c.post('/api/vault/upload', fd, v.H);
  return { r, fileKey, cipher, meta };
}
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());

test('vault: 종단간 암호화 금고', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  await t.test('[E-01] 무료 사용자는 금고 API 403, 프리미엄은 사용 가능', async () => {
    const free = createUser(s.db);
    const c = client(s.url, sessionFor(s.db, free.id));
    for (const p of ['/api/vault/keys', '/api/vault/list', '/api/vault/usage']) {
      const r = await c.get(p);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.error, 'premium_required');
    }
    assert.equal((await client(s.url).get('/api/vault/keys')).status, 401);
    const prem = createUser(s.db, { premium: true });
    const k = await client(s.url, sessionFor(s.db, prem.id)).get('/api/vault/keys');
    assert.equal(k.status, 200);
    assert.equal(k.body.setup, false);
  });

  await t.test('[E-01] 브라우저 암호화 코드 왕복: 여러 조각·변조·잘림 감지', async () => {
    const key = await vc.newKey();
    const data = vc.randomBytes(1000);
    const big = new Uint8Array(vc.CHUNK * 2 + 123);
    for (let i = 0; i < big.length; i += 65536) big.set(vc.randomBytes(Math.min(65536, big.length - i)), i);
    for (const plain of [new Uint8Array(0), data, big]) {
      const cipher = await vc.encryptBlob(key, new Blob([plain]));
      assert.equal(cipher.size, vc.cipherSize(plain.length), '[E-04] 올리기 전 용량 확인에 쓰는 암호문 크기 계산');
      const back = new Uint8Array(await (await vc.decryptBlob(key, cipher)).arrayBuffer());
      assert.deepEqual(back, plain);
    }
    const cipher = new Uint8Array(await (await vc.encryptBlob(key, new Blob([big]))).arrayBuffer());
    const tampered = cipher.slice();
    tampered[100] ^= 1;
    await assert.rejects(vc.decryptBlob(key, new Blob([tampered])));
    await assert.rejects(vc.decryptBlob(key, new Blob([cipher.slice(0, vc.CHUNK + 28)])), '조각 경계에서 잘라도 감지');
    await assert.rejects(vc.decryptBlob(await vc.newKey(), new Blob([cipher])), '다른 키로는 못 연다');
  });

  await t.test('[E-01] 암호문 업로드·다운로드 왕복, 서버에는 평문·이름이 없다, 일반 드라이브와 분리', async () => {
    const v = await openVault(s);
    const plain = new TextEncoder().encode('주민등록 사본 — 금고 전용');
    const { r, fileKey } = await uploadFile(v, { name: '신분증.png', data: plain, mime: 'image/png' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const it = r.body.item;
    const row = s.db.prepare('SELECT * FROM files WHERE id=?').get(it.id);
    assert.equal(row.space, 'vault');
    assert.match(row.name, /^enc_/);
    assert.ok(!row.meta.includes('신분증'));
    const stored = fs.readFileSync(blobPath(s.cfg, row.blob_hash));
    assert.ok(!stored.includes(Buffer.from(plain)), '서버 디스크에 평문이 없어야 한다');

    const dl = await fetch(`${s.url}/api/vault/files/${it.id}/blob`, { headers: { authorization: `Bearer ${v.sess}`, ...v.H } });
    assert.equal(dl.status, 200);
    const back = await vc.decryptBlob(fileKey, new Blob([await bytesOf(dl)]));
    assert.deepEqual(new Uint8Array(await back.arrayBuffer()), plain);

    const list = await v.c.get('/api/vault/list', v.H);
    const meta = await vc.openFileMeta(await vc.unwrapKey(v.master, list.body.items[0].encKey), list.body.items[0]);
    assert.deepEqual(meta, { name: '신분증.png', mime: 'image/png', size: plain.length });

    assert.equal(listChildren(s.db, v.u.id, null).length, 0, '일반 드라이브 목록에 보이지 않는다');
    assert.equal(usage(s.db, v.u.id, 'drive'), 0);
  });

  await t.test('[E-01] 폴더·이름 바꾸기·이동·영구 삭제', async () => {
    const v = await openVault(s);
    const f1 = await v.c.post('/api/vault/folders', { encName: await vc.sealText(v.master, '여권') }, v.H);
    assert.equal(f1.status, 201);
    const f2 = await v.c.post('/api/vault/folders', { parentId: f1.body.item.id, encName: await vc.sealText(v.master, '2026') }, v.H);
    const { r, fileKey } = await uploadFile(v, { parentId: f1.body.item.id });
    const fileId = r.body.item.id;

    const inside = await v.c.get(`/api/vault/list?parentId=${f2.body.item.id}`, v.H);
    assert.equal(await vc.openText(v.master, inside.body.path[0].encName), '여권');

    const ren = await v.c.patch(`/api/vault/files/${fileId}`, { encName: await vc.sealText(fileKey, '새이름.txt') }, v.H);
    assert.equal(await vc.openText(fileKey, ren.body.item.encName), '새이름.txt');
    assert.equal((await v.c.patch(`/api/vault/files/${fileId}`, { encName: '평문 이름!' }, v.H)).status, 400);

    assert.equal((await v.c.post('/api/vault/move', { ids: [f1.body.item.id], parentId: f2.body.item.id }, v.H)).status, 400, '자기 안으로 이동 불가');
    assert.equal((await v.c.post('/api/vault/move', { ids: [fileId], parentId: f2.body.item.id }, v.H)).status, 200);
    assert.equal((await v.c.get(`/api/vault/list?parentId=${f2.body.item.id}`, v.H)).body.items.length, 1);

    const hash = s.db.prepare('SELECT blob_hash FROM files WHERE id=?').get(fileId).blob_hash;
    assert.equal((await v.c.del(`/api/vault/files/${f1.body.item.id}`, undefined, v.H)).status, 200);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM files WHERE user_id=? AND space='vault'").get(v.u.id).n, 0, '하위까지 바로 영구 삭제');
    assert.equal(fs.existsSync(blobPath(s.cfg, hash)), false, '본문도 즉시 삭제');
  });

  await t.test('[E-02] 패스코드·생체인증(PRF) 잠금 해제, 증명값 없으면 잠김', async () => {
    const v = await openVault(s, { passcode: 'open-sesame' });
    const keys = (await v.c.get('/api/vault/keys')).body;
    assert.equal(keys.setup, true);
    assert.equal(keys.iterations, vc.KDF_ITERATIONS);
    assert.ok(!JSON.stringify(keys).includes('open-sesame'));
    await assert.rejects(vc.unlockWithPasscode(keys, 'wrong-pass'));
    const m = await vc.unlockWithPasscode(keys, 'open-sesame');
    assert.equal(await vc.vaultProof(m), v.proof);

    assert.equal((await v.c.get('/api/vault/list')).body.error, 'vault_locked');
    assert.equal((await v.c.get('/api/vault/list', { 'x-vault-token': 'AAAA' })).status, 403);
    assert.equal((await v.c.post('/api/vault/unlock', { proof: 'AAAA' })).body.error, 'vault_locked', '틀린 증명값으로는 토큰을 못 받는다');
    assert.equal((await v.c.post('/api/vault/setup', (await vc.createVault('another')).body)).status, 409, '덮어쓰기 불가');

    // 패스코드 변경: 마스터키는 그대로, 새 패스코드로만 열린다
    assert.equal((await v.c.put('/api/vault/keys', await vc.wrapWithPasscode(m, 'new-pass-99'))).status, 403, '잠금 상태로는 변경 불가');
    assert.equal((await v.c.put('/api/vault/keys', await vc.wrapWithPasscode(m, 'new-pass-99'), v.H)).status, 200);
    const keys2 = (await v.c.get('/api/vault/keys')).body;
    await assert.rejects(vc.unlockWithPasscode(keys2, 'open-sesame'));
    assert.equal(await vc.vaultProof(await vc.unlockWithPasscode(keys2, 'new-pass-99')), v.proof);

    // 생체인증: 인증기 안의 PRF 출력으로 마스터키를 감싼다(여기서는 출력값을 흉내)
    const prfOut = vc.randomBytes(32);
    const salt = vc.b64(vc.randomBytes(32));
    const wrapped = await vc.wrapKey(await vc.prfKey(prfOut), v.master);
    const credA = vc.b64(vc.randomBytes(16));
    assert.equal((await v.c.put('/api/vault/prf', { credentialId: credA, salt, wrapped }, v.H)).status, 200);
    const keys3 = (await v.c.get('/api/vault/keys')).body;
    assert.equal(keys3.prf[0].salt, salt);
    const viaBio = await vc.unwrapKey(await vc.prfKey(prfOut), keys3.prf[0].wrapped);
    assert.equal(await vc.vaultProof(viaBio), v.proof);
    await assert.rejects(vc.unwrapKey(await vc.prfKey(vc.randomBytes(32)), keys3.prf[0].wrapped), '다른 인증기로는 못 연다');

    // 기기 B 를 등록해도 기기 A 등록은 남는다. 끄면 그 기기 것만 지운다
    const credB = vc.b64(vc.randomBytes(16));
    const wrappedB = await vc.wrapKey(await vc.prfKey(vc.randomBytes(32)), v.master);
    assert.equal((await v.c.put('/api/vault/prf', { credentialId: credB, salt, wrapped: wrappedB }, v.H)).status, 200);
    assert.deepEqual((await v.c.get('/api/vault/keys')).body.prf.map((p) => p.credentialId).sort(), [credA, credB].sort(), '[E-02] 기기마다 따로 등록');
    assert.equal((await v.c.del('/api/vault/prf', { credentialId: credB }, v.H)).status, 200);
    assert.deepEqual((await v.c.get('/api/vault/keys')).body.prf.map((p) => p.credentialId), [credA]);
    assert.equal((await v.c.del('/api/vault/prf', {}, v.H)).status, 400, '어느 기기인지 정해야 한다');
    assert.equal((await v.c.del('/api/vault/prf', { credentialId: credA }, v.H)).status, 200);
    assert.deepEqual((await v.c.get('/api/vault/keys')).body.prf, []);
  });

  await t.test('[E-02] 패스코드 변경 때 마스터키 교체: 예전 증명값·패스코드는 더 못 쓰고, 파일·폴더·공유는 그대로', async () => {
    const v = await openVault(s, { passcode: 'Old-pass-2026' });
    const folder = await v.c.post('/api/vault/folders', { encName: await vc.sealText(v.master, '계약') }, v.H);
    const plain = new TextEncoder().encode('교체 전후 같은 내용');
    const { r, fileKey } = await uploadFile(v, { data: plain, parentId: folder.body.item.id });
    const sk = await vc.makeShareKeys([{ id: r.body.item.id, key: fileKey }]);
    const sh = (await v.c.post('/api/vault/shares', { fileIds: [r.body.item.id], wrappedKeys: sk.wrappedKeys, mode: 'separate', expiresDays: 0 }, v.H)).body;
    await v.c.put('/api/vault/prf', { credentialId: 'cred', salt: 'AAAA', wrapped: await vc.wrapKey(await vc.prfKey(vc.randomBytes(32)), v.master) }, v.H);
    const oldKeys = (await v.c.get('/api/vault/keys')).body;
    const otherTab = await unlockH(v.c, v.proof); // 교체 전에 잠금 해제해 둔 다른 탭

    const { items } = (await v.c.get('/api/vault/list?all=1', v.H)).body;
    assert.equal(items.length, 2, '하위 폴더 안 파일까지 전체');
    const rot = await vc.rotateMaster(v.master, items, 'New-pass-2027');
    assert.equal((await v.c.put('/api/vault/keys', { ...rot.body, items: rot.body.items.slice(1) }, v.H)).body.error, 'vault_changed', '빠진 항목이 있으면 아무것도 바꾸지 않는다');
    assert.equal((await v.c.get('/api/vault/list', otherTab)).status, 200, '실패하면 다른 탭도 그대로');
    assert.equal((await v.c.put('/api/vault/keys', rot.body, v.H)).status, 200);

    assert.equal((await v.c.get('/api/vault/list', otherTab)).body.error, 'vault_locked', '다른 기기·탭은 다시 잠금 해제해야 한다');
    assert.equal((await v.c.get('/api/vault/list', v.H)).status, 200, '바꾼 탭은 계속 열려 있다');
    assert.equal((await v.c.post('/api/vault/unlock', { proof: v.proof })).body.error, 'vault_locked', '예전 증명값은 더 못 쓴다');
    const keys = (await v.c.get('/api/vault/keys')).body;
    assert.deepEqual(keys.prf, [], '생체인증 등록은 지워진다');
    await assert.rejects(vc.unlockWithPasscode(keys, 'Old-pass-2026'));
    const oldMaster = await vc.unlockWithPasscode(oldKeys, 'Old-pass-2026'); // 예전 wrappedMaster 를 가진 사람
    assert.equal((await v.c.post('/api/vault/unlock', { proof: await vc.vaultProof(oldMaster) })).status, 403);

    const m2 = await vc.unlockWithPasscode(keys, 'New-pass-2027');
    const H2 = await unlockH(v.c, await vc.vaultProof(m2));
    const top = (await v.c.get('/api/vault/list', H2)).body.items;
    assert.equal(await vc.openText(m2, top[0].encName), '계약');
    const inner = (await v.c.get(`/api/vault/list?parentId=${folder.body.item.id}`, H2)).body.items[0];
    const fk = await vc.unwrapKey(m2, inner.encKey);
    const dl = await fetch(`${s.url}/api/vault/files/${inner.id}/blob`, { headers: { authorization: `Bearer ${v.sess}`, ...H2 } });
    assert.deepEqual(new Uint8Array(await (await vc.decryptBlob(fk, new Blob([await bytesOf(dl)]))).arrayBuffer()), plain);
    assert.equal((await client(s.url).get(`/api/vault/public/${sh.token}`)).status, 200, '공유 링크는 그대로');
  });

  await t.test('[E-03] 자동 잠금: 탭 숨김·페이지 떠남 즉시, 미사용 시간 경과, 전송 중 유예, 고르기 창 유예', (tt) => {
    tt.mock.timers.enable({ apis: ['setTimeout'] }); // 실제 시간에 기대지 않는다
    const doc = new EventTarget();
    const win = new EventTarget();
    const hide = (v) => ((doc.hidden = v), doc.dispatchEvent(new Event('visibilitychange')));
    let locks = 0;
    const stop = vc.autoLock(() => locks++, 10, doc, win);
    hide(false);
    assert.equal(locks, 0);
    hide(true);
    assert.equal(locks, 1, '탭이 숨겨지면 즉시');
    win.dispatchEvent(new Event('pagehide'));
    assert.equal(locks, 2, '페이지를 떠나면 즉시');
    stop();
    win.dispatchEvent(new Event('pagehide'));
    tt.mock.timers.tick(11 * 60_000);
    assert.equal(locks, 2, '해제 후에는 반응 없음');

    hide(false);
    let idle = 0;
    const a = vc.autoLock(() => idle++, 1, doc, win); // 1분
    tt.mock.timers.tick(50_000);
    doc.dispatchEvent(new Event('keydown')); // 조작하면 타이머가 다시 시작
    tt.mock.timers.tick(50_000);
    assert.equal(idle, 0);
    tt.mock.timers.tick(10_001);
    assert.equal(idle, 1, '조작 없이 시간이 지나면 잠금');

    // 올리기·내려받기 중에는 조작이 없어도 잠그지 않고, 끝난 뒤부터 다시 센다
    const done = a.hold();
    tt.mock.timers.tick(5 * 60_000);
    assert.equal(idle, 1, '전송 중에는 미사용 잠금 없음');
    done();
    done(); // 두 번 불러도 한 번만
    tt.mock.timers.tick(59_000);
    assert.equal(idle, 1);
    tt.mock.timers.tick(1_001);
    assert.equal(idle, 2, '전송이 끝나고 시간이 지나면 잠금');

    // 파일 고르기·생체인증 창(휴대폰에서 탭이 숨겨짐): 창이 닫힐 때 다시 보이면 잠그지 않는다
    let r = a.defer();
    hide(true);
    assert.equal(idle, 2, '창이 떠 있는 동안 숨겨져도 바로 잠그지 않음');
    hide(false);
    r();
    assert.equal(idle, 2);
    r = a.defer();
    hide(true);
    r();
    assert.equal(idle, 3, '창이 닫혔는데 여전히 숨겨져 있으면 잠금');
    hide(true);
    assert.equal(idle, 4, '유예가 끝나면 다시 즉시 잠금');

    // 설정에서 시간을 바꿔도 진행 중인 전송·고르기 창 유예는 이어진다
    hide(false);
    const busy = a.hold();
    r = a.defer();
    a.setMinutes(2);
    tt.mock.timers.tick(10 * 60_000);
    assert.equal(idle, 4, '시간을 바꿔도 전송 중에는 잠그지 않음');
    hide(true);
    assert.equal(idle, 4, '시간을 바꿔도 고르기 창 유예는 유지');
    hide(false);
    r();
    busy();
    tt.mock.timers.tick(119_000);
    assert.equal(idle, 4);
    tt.mock.timers.tick(1_001);
    assert.equal(idle, 5, '바뀐 시간(2분)으로 잠금');
    a();
  });

  await t.test('[E-01] 패스코드 규칙: 짧은·숫자만·흔한 코드는 거절', () => {
    for (const p of ['123456', '111111', 'abc12', '1234567890', '0000000000000', 'password123!', 'qwerty12345', 'aaaaaaaaaa', 'abcdefgh', 'Mimic2026!', 'abababab12', 'abcdefg1'])
      assert.ok(vc.passcodeProblem(p), `${p} 는 거절`);
    for (const p of ['open-sesame', 'Tr0ub4dor&3', 'correct horse', 'kX9#pLm2', '우리집금고비밀번호예요']) assert.equal(vc.passcodeProblem(p), null, `${p} 는 허용`);
    assert.equal(vc.passcodeScore(''), 0);
    assert.equal(vc.passcodeScore('123456'), 1);
    assert.ok(vc.passcodeScore('Long-Strong-Pass-99') > vc.passcodeScore('open-sesame'));
    assert.ok(vc.KDF_ITERATIONS >= 600_000);
  });

  await t.test('[E-03] 자동 잠금 시간 설정 저장', async () => {
    const v = await openVault(s);
    assert.equal((await v.c.get('/api/vault/keys')).body.autoLockMinutes, 5, '기본 5분');
    assert.equal((await v.c.put('/api/vault/settings', { autoLockMinutes: 15 }, v.H)).status, 200);
    assert.equal((await v.c.get('/api/vault/keys')).body.autoLockMinutes, 15);
    assert.equal((await v.c.put('/api/vault/settings', { autoLockMinutes: 0 }, v.H)).status, 400);
  });

  await t.test('[E-03] 서버 쪽 잠금: 토큰은 이 세션에서만, 자동 잠금 시간 동안 안 쓰면 끝나고, 잠그거나 로그아웃하면 바로 끝난다', async () => {
    const v = await openVault(s);
    const left = () => s.db.prepare('SELECT expires_at FROM vault_unlocks WHERE user_id=?').get(v.u.id).expires_at - Date.now();
    assert.equal((await v.c.get('/api/vault/usage', v.H)).status, 200);
    assert.ok(left() > 4.9 * 60_000 && left() <= 5 * 60_000, '쓸 때마다 기본 5분 연장');
    const other = client(s.url, sessionFor(s.db, v.u.id));
    assert.equal((await other.get('/api/vault/usage', v.H)).body.error, 'vault_locked', '다른 로그인 세션으로는 같은 토큰을 못 쓴다');

    s.db.prepare('UPDATE vault_unlocks SET expires_at=? WHERE user_id=?').run(Date.now() - 1, v.u.id);
    assert.equal((await v.c.get('/api/vault/usage', v.H)).body.error, 'vault_locked', '자동 잠금 시간이 지나면 서버도 잠근다');

    const H = await unlockH(v.c, v.proof);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM vault_unlocks WHERE user_id=?').get(v.u.id).n, 1, '끝난 토큰은 정리');
    assert.equal((await v.c.put('/api/vault/settings', { autoLockMinutes: 15 }, H)).status, 200);
    await v.c.get('/api/vault/usage', H);
    assert.ok(left() > 14.9 * 60_000, '바꾼 자동 잠금 시간을 서버도 쓴다');

    assert.equal((await v.c.post('/api/vault/lock', undefined, H)).status, 200);
    assert.equal((await v.c.get('/api/vault/usage', H)).body.error, 'vault_locked', '잠그면 바로 끝난다');

    await unlockH(v.c, v.proof);
    s.db.prepare('DELETE FROM sessions WHERE id=?').run(sha256(v.sess));
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM vault_unlocks WHERE user_id=?').get(v.u.id).n, 0, '로그아웃하면 토큰도 사라진다');
  });

  await t.test('[E-04] 금고 용량은 일반 드라이브와 별도', async () => {
    const v = await openVault(s);
    const { r } = await uploadFile(v);
    const u1 = (await v.c.get('/api/vault/usage', v.H)).body;
    assert.equal(u1.total, VAULT_STORAGE);
    assert.equal(u1.used, r.body.item.size);
    const me = await v.c.get('/api/me');
    assert.equal(me.body.storage.used, 0, '드라이브 용량에는 들어가지 않는다');

    // 남은 공간에 암호문이 딱 맞으면 올라간다(multipart 경계·encMeta 크기로 거절하지 않는다)
    const filler = createFileNode(s.db, v.u.id, null, { name: 'filler', size: VAULT_STORAGE - u1.used * 2, space: 'vault' });
    const exact = await uploadFile(v);
    assert.equal(exact.r.status, 201, JSON.stringify(exact.r.body));
    assert.equal((await v.c.get('/api/vault/usage', v.H)).body.used, VAULT_STORAGE);
    const full = await uploadFile(v);
    assert.equal(full.r.status, 403);
    assert.equal(full.r.body.error, 'storage_full');
    // 1바이트 모자라면 받는 도중에 거절
    s.db.prepare('UPDATE files SET size=size+1 WHERE id=?').run(filler.id);
    s.db.prepare('DELETE FROM files WHERE id=?').run(exact.r.body.item.id);
    const over = await uploadFile(v);
    assert.equal(over.r.body.error, 'storage_full');
  });

  await t.test('[E-05] 암호화 공유: 링크·키 분리/결합, 만료·취소, 다른 사용자 차단', async () => {
    const v = await openVault(s);
    const plain = new TextEncoder().encode('공유할 비밀 문서');
    const { r, fileKey } = await uploadFile(v, { name: '계약서.pdf', data: plain, mime: 'application/pdf' });
    const fileId = r.body.item.id;

    const sk = await vc.makeShareKeys([{ id: fileId, key: fileKey }]);
    const cr = await v.c.post('/api/vault/shares', { fileIds: [fileId], wrappedKeys: sk.wrappedKeys, mode: 'separate', expiresDays: 7 }, v.H);
    assert.equal(cr.status, 201, JSON.stringify(cr.body));
    const { token, share } = cr.body;
    assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM vault_shares WHERE id=?').get(share.id)).includes(token), '토큰은 해시로만 저장');
    assert.ok(!JSON.stringify(cr.body).includes(sk.key), '공유키는 서버로 가지 않는다');

    // 받는 사람(로그인 없음): 키로 브라우저에서 복호화
    const anon = client(s.url);
    const pub = await anon.get(`/api/vault/public/${token}`);
    assert.equal(pub.status, 200);
    const f = pub.body.files[0];
    const shareKey = await vc.importShareKey(sk.key);
    const fk = await vc.unwrapKey(shareKey, f.wrappedKey);
    assert.equal((await vc.openFileMeta(fk, f)).name, '계약서.pdf');
    const blob = await fetch(`${s.url}/api/vault/public/${token}/files/${fileId}/blob`);
    assert.equal(blob.status, 200);
    const back = await vc.decryptBlob(fk, new Blob([await bytesOf(blob)]));
    assert.deepEqual(new Uint8Array(await back.arrayBuffer()), plain);
    await assert.rejects(vc.unwrapKey(await vc.importShareKey((await vc.makeShareKeys([])).key), f.wrappedKey), '틀린 키로는 못 연다');

    // 결합 모드·영구
    const comb = await v.c.post('/api/vault/shares', { fileIds: [fileId], wrappedKeys: sk.wrappedKeys, mode: 'combined', expiresDays: 0 }, v.H);
    assert.equal(comb.body.share.mode, 'combined');
    assert.equal(comb.body.share.expiresAt, null);
    assert.equal((await v.c.post('/api/vault/shares', { fileIds: [fileId], wrappedKeys: sk.wrappedKeys, mode: 'separate', expiresDays: 3 }, v.H)).status, 400);

    // 만료
    s.db.prepare('UPDATE vault_shares SET expires_at=? WHERE id=?').run(Date.now() - 1, share.id);
    assert.equal((await anon.get(`/api/vault/public/${token}`)).body.error, 'share_expired');
    assert.equal((await fetch(`${s.url}/api/vault/public/${token}/files/${fileId}/blob`)).status, 410);

    // 다른 사용자: 공유 취소·파일 접근·남의 파일 공유 불가
    const w = await openVault(s);
    assert.equal((await w.c.del(`/api/vault/shares/${comb.body.share.id}`, undefined, w.H)).status, 404);
    assert.equal((await w.c.get(`/api/vault/files/${fileId}/blob`, w.H)).status, 404);
    assert.equal((await w.c.patch(`/api/vault/files/${fileId}`, { encName: 'AAAA' }, w.H)).status, 404);
    assert.equal((await w.c.del(`/api/vault/files/${fileId}`, undefined, w.H)).status, 404);
    assert.equal((await w.c.post('/api/vault/shares', { fileIds: [fileId], wrappedKeys: sk.wrappedKeys, mode: 'separate' }, w.H)).status, 404);
    assert.equal((await w.c.get(`/api/vault/files/${fileId}/blob`, v.H)).status, 403, '남의 잠금 해제 토큰으로는 안 열린다');

    // 취소
    const comToken = comb.body.token;
    assert.equal((await anon.get(`/api/vault/public/${comToken}`)).status, 200);
    assert.equal((await v.c.del(`/api/vault/shares/${comb.body.share.id}`, undefined, v.H)).status, 200);
    assert.equal((await anon.get(`/api/vault/public/${comToken}`)).body.error, 'share_revoked');
    const listed = (await v.c.get('/api/vault/shares', v.H)).body.items;
    assert.deepEqual(listed.map((x) => x.status).sort(), ['expired', 'revoked']);
    assert.equal((await anon.get('/api/vault/public/nope')).status, 404);
  });

  await t.test('[E-05] 공개 공유는 하루에 담긴 파일 크기의 5배까지만 내려보내고, 받아 간 양을 보여 준다', async () => {
    const v = await openVault(s);
    const { r, fileKey } = await uploadFile(v);
    const { id, size } = r.body.item;
    const sk = await vc.makeShareKeys([{ id, key: fileKey }]);
    const { token, share } = (await v.c.post('/api/vault/shares', { fileIds: [id], wrappedKeys: sk.wrappedKeys, mode: 'combined', expiresDays: 0 }, v.H)).body;
    const get = async () => {
      const res = await fetch(`${s.url}/api/vault/public/${token}/files/${id}/blob`);
      const buf = Buffer.from(await res.arrayBuffer());
      await new Promise((ok) => setImmediate(ok)); // 서버가 보낸 양을 기록할 틈
      return { status: res.status, buf };
    };
    for (let i = 0; i < 5; i++) assert.equal((await get()).status, 200);
    const over = await get();
    assert.equal(over.status, 429);
    assert.equal(JSON.parse(over.buf).error, 'share_daily_limit');
    const listed = (await v.c.get('/api/vault/shares')).body;
    assert.equal(listed.items.find((x) => x.id === share.id).sentBytes, size * 5, '공유 관리에 받아 간 양');
    assert.equal(listed.dailyCopies, 5);
    s.db.prepare("UPDATE vault_share_traffic SET day='d:2000-01-01' WHERE share_id=?").run(share.id);
    assert.equal((await get()).status, 200, '다음 날에는 다시 받을 수 있다');
  });
  await t.test('[E-01] 입력 검증: 문자열이 아닌 parentId 는 400, 토큰 접근 차단(웹 세션 전용)', async () => {
    const v = await openVault(s);
    assert.equal((await v.c.get('/api/vault/list?parentId=a&parentId=b', v.H)).body.error, 'invalid_parent');
    assert.equal((await v.c.post('/api/vault/folders', { parentId: { a: 1 }, encName: 'AAAA' }, v.H)).status, 400);
    const { r } = await uploadFile(v);
    assert.equal((await v.c.post('/api/vault/move', { ids: [r.body.item.id], parentId: { a: 1 } }, v.H)).body.error, 'invalid_parent');
    assert.equal((await v.c.post('/api/vault/move', { ids: [r.body.item.id], parentId: ['x'] }, v.H)).status, 400);

    // 권한 범위와 상관없이 개인 액세스 토큰·연결 앱 토큰은 금고를 못 쓴다(증명값이 있어도)
    for (const scopes of [['files:read'], ['files:manage']]) {
      const tc = client(s.url, createToken(s.db, v.u.id, { name: 'cli', scopes }).token);
      assert.equal((await tc.get('/api/vault/list', v.H)).body.error, 'session_only');
      assert.equal((await tc.del(`/api/vault/files/${r.body.item.id}`, undefined, v.H)).status, 403);
      assert.equal((await tc.get('/api/vault/shares')).status, 403);
    }
    assert.equal((await v.c.get('/api/vault/list', v.H)).body.items.length, 1, '토큰 요청으로 지워지지 않았다');
  });

  await t.test('[E-02] 패스코드 분실: 로그인 재확인 후 금고 초기화(파일·본문·공유·키 영구 삭제)', async () => {
    const v = await openVault(s);
    s.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword('Login#123'), v.u.id);
    const { r, fileKey } = await uploadFile(v);
    const hash = s.db.prepare('SELECT blob_hash FROM files WHERE id=?').get(r.body.item.id).blob_hash;
    const sk = await vc.makeShareKeys([{ id: r.body.item.id, key: fileKey }]);
    const sh = await v.c.post('/api/vault/shares', { fileIds: [r.body.item.id], wrappedKeys: sk.wrappedKeys, mode: 'separate', expiresDays: 0 }, v.H);

    assert.equal((await v.c.del('/api/vault', { password: 'wrong' })).body.error, 'wrong_password');
    assert.equal((await v.c.del('/api/vault', {})).status, 403, '비밀번호 없이 불가');
    const tc = client(s.url, createToken(s.db, v.u.id, { name: 'x', scopes: ['files:manage'] }).token);
    assert.equal((await tc.del('/api/vault', { password: 'Login#123' })).status, 403, '토큰으로는 불가');
    assert.equal((await v.c.get('/api/vault/list', v.H)).body.items.length, 1, '실패하면 그대로');

    const ok = await v.c.del('/api/vault', { password: 'Login#123' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM files WHERE user_id=? AND space='vault'").get(v.u.id).n, 0);
    assert.equal(fs.existsSync(blobPath(s.cfg, hash)), false, '본문도 삭제');
    assert.equal((await client(s.url).get(`/api/vault/public/${sh.body.token}`)).status, 404, '공유도 삭제');
    assert.equal((await v.c.get('/api/vault/keys')).body.setup, false);
    assert.equal((await v.c.post('/api/vault/setup', (await vc.createVault('new-start')).body)).status, 201, '새 패스코드로 다시 만들 수 있다');

    // 비밀번호 없는 계정(이메일 코드·소셜 로그인): 로그인한 지 10분 안의 세션만
    const w = await openVault(s);
    const token = sessionFor(s.db, w.u.id);
    s.db.prepare('UPDATE sessions SET created_at=? WHERE id=?').run(Date.now() - 11 * 60_000, sha256(token));
    assert.equal((await client(s.url, token).del('/api/vault', {})).body.error, 'reauth_required');
    assert.equal((await w.c.del('/api/vault', {})).status, 200, '방금 로그인한 세션은 가능');
  });

  await t.test('[E-05] 프리미엄이 끝나면 공개 링크는 멈추고, 소유자는 공유를 보고 취소할 수 있다', async () => {
    const v = await openVault(s);
    const { r, fileKey } = await uploadFile(v);
    const fileId = r.body.item.id;
    const sk = await vc.makeShareKeys([{ id: fileId, key: fileKey }]);
    const sh = (await v.c.post('/api/vault/shares', { fileIds: [fileId], wrappedKeys: sk.wrappedKeys, mode: 'combined', expiresDays: 0 }, v.H)).body;
    const anon = client(s.url);
    assert.equal((await anon.get(`/api/vault/public/${sh.token}`)).status, 200);

    s.db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(Date.now() - 1000, v.u.id);
    const pub = await anon.get(`/api/vault/public/${sh.token}`);
    assert.equal(pub.status, 410);
    assert.equal(pub.body.error, 'share_unavailable');
    assert.equal(pub.headers.get('cache-control'), 'no-store', '410 도 캐시하지 않는다(프리미엄을 다시 쓰면 바로 열리게)');
    assert.equal((await fetch(`${s.url}/api/vault/public/${sh.token}/files/${fileId}/blob`)).status, 410, '암호문도 내주지 않는다');
    assert.equal((await v.c.get('/api/vault/list', v.H)).body.error, 'premium_required');

    // 증명값·프리미엄 없이 세션만으로 목록·취소
    const listed = await v.c.get('/api/vault/shares');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items[0].id, sh.share.id);
    assert.equal((await v.c.del(`/api/vault/shares/${sh.share.id}`)).status, 200);
    s.db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(Date.now() + 86_400_000, v.u.id);
    assert.equal((await anon.get(`/api/vault/public/${sh.token}`)).body.error, 'share_revoked', '프리미엄을 다시 써도 취소한 공유는 안 열린다');
  });

  await t.test('[E-05] 정지·잠금·삭제 대기 계정의 금고 공유는 410', async () => {
    const v = await openVault(s);
    const { r, fileKey } = await uploadFile(v);
    const fileId = r.body.item.id;
    const sk = await vc.makeShareKeys([{ id: fileId, key: fileKey }]);
    const { token } = (await v.c.post('/api/vault/shares', { fileIds: [fileId], wrappedKeys: sk.wrappedKeys, mode: 'combined', expiresDays: 0 }, v.H)).body;
    const anon = client(s.url);
    const setStatus = (status, until = null) => s.db.prepare('UPDATE users SET status=?, status_until=? WHERE id=?').run(status, until, v.u.id);
    for (const [status, until] of [
      ['suspended', Date.now() + 86_400_000],
      ['suspended', null],
      ['locked', null],
      ['pending_delete', null],
    ]) {
      setStatus(status, until);
      const pub = await anon.get(`/api/vault/public/${token}`);
      assert.equal(pub.status, 410, status);
      assert.equal(pub.body.error, 'share_unavailable');
      assert.equal((await fetch(`${s.url}/api/vault/public/${token}/files/${fileId}/blob`)).status, 410, `${status}: 암호문도 막는다`);
    }
    setStatus('suspended', Date.now() - 1000); // 정지 기간이 끝났으면 다시 열린다
    assert.equal((await anon.get(`/api/vault/public/${token}`)).status, 200);
    setStatus('active');
    assert.equal((await fetch(`${s.url}/api/vault/public/${token}/files/${fileId}/blob`)).status, 200);
  });
});
