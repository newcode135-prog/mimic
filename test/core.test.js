import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { ingestStream, hasBlob } from '../server/core/storage.js';
import { createFolder, createFileNode, uniqueName, copyTree, usage, listChildren } from '../server/core/files.js';
import { checkTransfer, addUsage, consumeCloudTask, grant } from '../server/core/quota.js';
import { passwordValid } from '../server/core/auth.js';
import { GB } from '../server/core/plans.js';

test('core: 인증·저장소·드라이브 헬퍼·쿼터', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const u = createUser(s.db);

  await t.test('로그인 없이 /api/me 는 401, 세션이 있으면 사용자 정보', async () => {
    assert.equal((await client(s.url).get('/api/me')).status, 401);
    const me = await client(s.url, sessionFor(s.db, u.id)).get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, u.id);
    assert.equal(me.body.storage.total, 6 * GB);
  });

  await t.test('같은 내용은 한 벌만 저장(중복 제거)', async () => {
    const a = await ingestStream(s.db, s.cfg, Readable.from([Buffer.from('mimic')]));
    const b = await ingestStream(s.db, s.cfg, Readable.from([Buffer.from('mimic')]));
    assert.equal(a.hash, b.hash);
    assert.equal(b.deduped, true);
    assert.ok(hasBlob(s.db, s.cfg, a.hash));
  });

  await t.test('이름 중복 처리, 폴더 복사, 사용량', async () => {
    const folder = createFolder(s.db, u.id, null, '영상');
    createFileNode(s.db, u.id, folder.id, { name: 'a.mp4', size: 10 });
    assert.equal(uniqueName(s.db, u.id, folder.id, 'a.mp4'), 'a (1).mp4');
    const other = createUser(s.db);
    const copy = copyTree(s.db, u.id, folder.id, other.id, null);
    assert.equal(listChildren(s.db, other.id, copy.id).length, 1);
    assert.equal(usage(s.db, other.id), 10);
  });

  await t.test('무료 일일 다운스트림 20GB 초과 시 감속', () => {
    assert.equal(checkTransfer(s.db, u, 'down', GB).ok, true);
    addUsage(s.db, u.id, 'down', 20 * GB);
    const r = checkTransfer(s.db, u, 'down', 1);
    assert.equal(r.ok, false);
    assert.equal(r.slow, true);
  });

  await t.test('무료 클라우드 다운로드 하루 3회 + 보너스 2회', () => {
    const v = createUser(s.db);
    grant(s.db, v.id, { kind: 'cloud_count', amount: 2, reason: 'signup_bonus' });
    for (let i = 0; i < 5; i++) consumeCloudTask(s.db, v);
    assert.throws(() => consumeCloudTask(s.db, v), /무료 클라우드/);
  });

  await t.test('비밀번호 규칙: 문자·숫자·기호 6~16자', () => {
    assert.equal(passwordValid('abc12!'), true);
    assert.equal(passwordValid('abcdef'), false);
    assert.equal(passwordValid('a1!'), false);
  });
});
