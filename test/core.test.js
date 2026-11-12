import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { ingestStream, hasBlob, sendBlob } from '../server/core/storage.js';
import { notify, sendMessage } from '../server/core/notify.js';
import { loadConfig } from '../server/core/config.js';
import { openDb } from '../server/core/db.js';
import { fail } from '../server/core/util.js';
import { createFolder, createFileNode, uniqueName, copyTree, usage, listChildren } from '../server/core/files.js';
import { checkTransfer, addUsage, consumeCloudTask, grant } from '../server/core/quota.js';
import { passwordValid, createToken, quotaSource } from '../server/core/auth.js';
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

  await t.test('[G-05] /api/me: account 권한 없는 토큰에는 설정·초대 코드를 주지 않는다', async () => {
    const me = async (scopes) => (await client(s.url, createToken(s.db, u.id, { name: 't', scopes, appId: 'pat', days: 30 }).token).get('/api/me')).body.user;
    const narrow = await me(['files:manage', 'services']);
    assert.equal(narrow.id, u.id);
    assert.ok(!('settings' in narrow) && !('inviteCode' in narrow));
    const wide = await me(['account']);
    assert.ok('settings' in wide && wide.inviteCode === u.invite_code);
    assert.ok('settings' in (await client(s.url, sessionFor(s.db, u.id)).get('/api/me')).body.user, '웹 세션은 그대로');
  });

  await t.test('[F-05] 토큰 요청은 appId 가 extension 이어도 연결 앱 쿼터로 센다', () => {
    assert.equal(quotaSource({ authKind: 'token', appId: 'extension' }), 'app');
    assert.equal(quotaSource({ authKind: 'token', appId: 'cli' }), 'app');
    assert.equal(quotaSource({ authKind: 'session' }), 'official');
  });

  await t.test('[K-04][H-01] 설정: MIMIC_COUNTRY_HEADER·발송 대행사 환경변수를 읽는다', () => {
    const keys = ['MIMIC_COUNTRY_HEADER', 'MIMIC_EMAIL_API', 'MIMIC_SMS_API'];
    const saved = keys.map((k) => process.env[k]);
    Object.assign(process.env, { MIMIC_COUNTRY_HEADER: ' CF-IPCountry ', MIMIC_EMAIL_API: 'https://mail.example/send', MIMIC_SMS_API: 'https://sms.example/send' });
    try {
      const c = loadConfig({ quiet: true });
      assert.equal(c.countryHeader, 'cf-ipcountry');
      assert.equal(c.mail.api, 'https://mail.example/send');
      assert.equal(c.sms.api, 'https://sms.example/send');
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  await t.test('[H-01] sendMessage: 운영 모드는 발송 대행사로 보내고, 개발 모드는 outbox 에만', async () => {
    const got = [];
    const api = express();
    api.use(express.json());
    api.post('/:ch', (req, res) => {
      got.push({ ch: req.params.ch, auth: req.get('authorization'), body: req.body });
      res.json({ ok: true });
    });
    const srv = api.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const prod = { dev: false, quiet: true, supportEmail: 'help@mimic.test', mail: { api: `${base}/mail`, key: 'k1' }, sms: { api: `${base}/sms`, key: 'k2', from: 'MIMIC' } };
      sendMessage(s.db, prod, { channel: 'email', to: 'a@x.test', subject: '[미믹] 인증코드 안내', body: '코드 123456' });
      sendMessage(s.db, prod, { channel: 'sms', to: '+821012345678', body: '코드 654321' });
      sendMessage(s.db, { ...prod, dev: true }, { channel: 'email', to: 'dev@x.test', subject: 's', body: 'b' });
      for (let i = 0; got.length < 2 && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(got.sort((a, b) => a.ch.localeCompare(b.ch)), [
        { ch: 'mail', auth: 'Bearer k1', body: { from: 'help@mimic.test', to: 'a@x.test', subject: '[미믹] 인증코드 안내', text: '코드 123456' } },
        { ch: 'sms', auth: 'Bearer k2', body: { from: 'MIMIC', to: '+821012345678', text: '코드 654321' } },
      ]);
      assert.ok(s.db.prepare("SELECT 1 FROM outbox WHERE to_addr='dev@x.test'").get(), '개발 모드는 outbox 에 남는다');
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
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

  await t.test('[H-04] hooks.activity 는 코어·모듈 API 모두보다 먼저, 로그인한 요청에만 불리고 던지면 요청을 막는다', async () => {
    const seen = [];
    const hook = (req) => {
      seen.push(req.user.id);
      if (req.user.id === blocked.id) fail(403, 'account_suspended', '정지');
    };
    const blocked = createUser(s.db);
    s.ctx.hooks.activity.push(hook);
    try {
      assert.equal((await client(s.url).get('/api/config')).status, 200);
      assert.deepEqual(seen, []);
      assert.equal((await client(s.url, sessionFor(s.db, u.id)).get('/api/me')).status, 200);
      assert.equal((await client(s.url, sessionFor(s.db, u.id)).get('/api/config')).status, 200);
      assert.deepEqual(seen, [u.id, u.id]);
      assert.equal((await client(s.url, sessionFor(s.db, blocked.id)).get('/api/me')).body.error, 'account_suspended');
    } finally {
      s.ctx.hooks.activity.splice(s.ctx.hooks.activity.indexOf(hook), 1);
    }
  });

  await t.test('[B-07] sendBlob: ETag·Last-Modified, If-Range 가 맞으면 206, 다르면 전체 200', async () => {
    const { hash } = await ingestStream(s.db, s.cfg, Readable.from([Buffer.from('0123456789')]));
    const mini = express();
    mini.get('/b', (req, res) => sendBlob(req, res, s.cfg, hash, { name: 'a.txt', mime: 'text/plain', inline: false }));
    const srv = mini.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    try {
      const url = `http://127.0.0.1:${srv.address().port}/b`;
      const full = await fetch(url);
      await full.text();
      const etag = full.headers.get('etag');
      const lastMod = full.headers.get('last-modified');
      assert.equal(etag, `"${hash}"`);
      assert.ok(lastMod);
      for (const ir of [etag, lastMod]) {
        const part = await fetch(url, { headers: { range: 'bytes=2-', 'if-range': ir } });
        assert.equal(part.status, 206);
        assert.equal(await part.text(), '23456789');
      }
      const stale = await fetch(url, { headers: { range: 'bytes=2-', 'if-range': '"stale"' } });
      assert.equal(stale.status, 200);
      assert.equal(await stale.text(), '0123456789');
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });

  await t.test('[K-05][K-03] notify: 영어 제목·본문 저장, 푸시 구독이 있는 사용자에게만 push(사용자 언어로)', () => {
    const pushes = (id) => s.db.prepare("SELECT * FROM outbox WHERE channel='push' AND to_addr=?").all(id);
    const a = createUser(s.db);
    notify(s.db, a.id, { kind: 'test', title: '완료', body: '본문', titleEn: 'Done', bodyEn: 'Body' });
    assert.deepEqual({ ...s.db.prepare('SELECT title_en, body_en FROM notifications WHERE user_id=?').get(a.id) }, { title_en: 'Done', body_en: 'Body' });
    assert.equal(pushes(a.id).length, 0, '구독 없으면 push 없음');
    s.db.prepare("UPDATE users SET lang='en' WHERE id=?").run(a.id);
    s.db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, created_at) VALUES (?,?,?,?)').run('ps1', a.id, 'https://push.example/1', Date.now());
    notify(s.db, a.id, { kind: 'test', title: '완료', body: '본문', titleEn: 'Done', bodyEn: 'Body' });
    notify(s.db, a.id, { kind: 'test', title: '한국어만' });
    assert.deepEqual(pushes(a.id).map((o) => o.subject), ['Done', '한국어만']);
  });

  await t.test('예전 DB 를 열면 새 열(notifications.title_en·body_en)이 더해진다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-olddb-'));
    const old = new DatabaseSync(path.join(dir, 'mimic.db'));
    old.exec("CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT, read_at INTEGER, created_at INTEGER NOT NULL)");
    old.close();
    const db = openDb(dir);
    const cols = db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    assert.ok(cols.includes('title_en') && cols.includes('body_en'));
  });
});
