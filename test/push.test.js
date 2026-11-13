// 웹 푸시(K-05): VAPID JWT 서명, RFC 8291 aes128gcm 암호문, 사라진 구독(410) 정리, 구독 검사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { notify } from '../server/core/notify.js';
import { vapidKeys } from '../server/core/config.js';

const b64u = (b) => Buffer.from(b).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// 브라우저 쪽 구독: P-256 키 + 16바이트 auth
function makeSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, pub, auth, keys: { p256dh: b64u(pub), auth: b64u(auth) } };
}

// RFC 8291 §3.3·3.4 를 HMAC 단계 그대로 따라 복호화
function decrypt(body, sub) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const secret = sub.ecdh.computeSecret(asPub);
  const prkKey = hmac(sub.auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), sub.pub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, '마지막 레코드 구분자 0x02');
  return { rs, idlen, payload: JSON.parse(plain.subarray(0, end).toString('utf8')) };
}

function verifyJwt(jwt, publicKey) {
  const [h, p, sig] = jwt.split('.');
  const pub = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'ES256 서명');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(p, 'base64url')) };
}

const waitFor = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (fn()) return;
  assert.fail('시간 초과');
};

test('웹 푸시(K-05)', async (t) => {
  const s = await startServer();
  // 푸시 서비스 흉내: 받은 요청을 모으고, /gone 은 410
  const got = [];
  const push = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.statusCode = req.url === '/gone' ? 410 : 201;
    res.end();
  });
  push.listen(0, '127.0.0.1');
  await once(push, 'listening');
  const base = `http://127.0.0.1:${push.address().port}`;
  t.after(async () => {
    push.closeAllConnections();
    push.close();
    await s.close();
  });
  const u = createUser(s.db);
  const U = client(s.url, sessionFor(s.db, u.id));

  await t.test('VAPID 키: 데이터 폴더에 한 번 만들어 계속 쓴다', async () => {
    const { publicKey } = (await U.get('/api/notifications/push/key')).body;
    const pub = Buffer.from(publicKey, 'base64url');
    assert.equal(pub.length, 65);
    assert.equal(pub[0], 4);
    assert.ok(fs.existsSync(path.join(s.dataDir, 'vapid.json')));
    assert.equal(vapidKeys({ dataDir: s.dataDir, supportEmail: 'x@y.test' }).publicKey, publicKey, '다시 읽어도 같은 키');
  });

  await t.test('notify → 암호화된 푸시 요청(VAPID 서명·aes128gcm), 받은 쪽이 풀면 { title, body, link }', async () => {
    const sub = makeSubscriber();
    assert.equal((await U.post('/api/notifications/push-subscriptions', { endpoint: `${base}/sub1`, keys: sub.keys })).status, 201);
    const { publicKey } = (await U.get('/api/notifications/push/key')).body;
    notify(s.db, u.id, { kind: 'notice', title: '다운로드 완료', body: '영화.mkv', link: '/drive/notifications' });
    await waitFor(() => got.some((r) => r.path === '/sub1'));
    const r = got.find((x) => x.path === '/sub1');
    assert.equal(r.headers['content-encoding'], 'aes128gcm');
    assert.ok(Number(r.headers.ttl) > 0);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(r.headers.authorization);
    assert.ok(m, r.headers.authorization);
    assert.equal(m[2], publicKey);
    const { header, claims } = verifyJwt(m[1], publicKey);
    assert.equal(header.alg, 'ES256');
    assert.equal(claims.aud, base);
    assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 12 * 3600 + 5, 'exp 는 12시간 이내');
    assert.match(claims.sub, /^mailto:/);
    const { rs, idlen, payload } = decrypt(r.body, sub);
    assert.equal(rs, 4096);
    assert.equal(idlen, 65);
    assert.deepEqual(payload, { title: '다운로드 완료', body: '영화.mkv', link: '/drive/notifications' });
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel='push' AND to_addr=?").get(u.id).n, 1, 'outbox 기록은 그대로');
    // 같은 푸시 서비스로 다시 보내면 서명해 둔 JWT 를 다시 쓴다(암호문은 매번 새로)
    notify(s.db, u.id, { kind: 'notice', title: '두 번째' });
    await waitFor(() => got.filter((x) => x.path === '/sub1').length === 2);
    const r2 = got.filter((x) => x.path === '/sub1')[1];
    assert.equal(r2.headers.authorization, r.headers.authorization);
    assert.equal(decrypt(r2.body, sub).payload.title, '두 번째');
  });

  await t.test('푸시 서비스가 410 이면 그 구독을 지운다', async () => {
    const v = createUser(s.db);
    const V = client(s.url, sessionFor(s.db, v.id));
    assert.equal((await V.post('/api/notifications/push-subscriptions', { endpoint: `${base}/gone`, keys: makeSubscriber().keys })).status, 201);
    notify(s.db, v.id, { kind: 'notice', title: '사라진 기기' });
    await waitFor(() => !s.db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint=?').get(`${base}/gone`));
    assert.ok(got.some((r) => r.path === '/gone'));
  });

  await t.test('잘못된 구독은 받지 않는다', async () => {
    const ok = makeSubscriber().keys;
    const bad = async (endpoint, keys) => assert.equal((await U.post('/api/notifications/push-subscriptions', { endpoint, keys })).status, 400, `${endpoint} ${JSON.stringify(keys)}`);
    await bad('http://push.example.com/x', ok); // 개발 모드에서도 http 는 localhost 만
    await bad('ftp://push.example.com/x', ok);
    await bad('https://user:pw@push.example.com/x', ok);
    await bad(`${base}/k`, { ...ok, p256dh: b64u(crypto.randomBytes(64)) }); // 64바이트
    await bad(`${base}/k`, { ...ok, p256dh: b64u(Buffer.concat([Buffer.from([3]), crypto.randomBytes(64)])) }); // 0x04 로 시작하지 않음
    await bad(`${base}/k`, { ...ok, p256dh: 'B'.repeat(87) }); // 65바이트·0x04 지만 P-256 곡선 위의 점이 아님
    await bad(`${base}/k`, { ...ok, auth: b64u(crypto.randomBytes(15)) });
    await bad(`${base}/k`, { ...ok, auth: 'a+b/'.repeat(6) }); // base64url 아님
  });
});

test('운영 모드: https 공개 이름 주소만 받고, 내부망으로는 보내지 않는다', async (t) => {
  const s = await startServer({ dev: false });
  let hits = 0;
  const push = http.createServer((req, res) => {
    hits++;
    res.end();
  });
  push.listen(0, '127.0.0.1');
  await once(push, 'listening');
  t.after(async () => {
    push.closeAllConnections();
    push.close();
    await s.close();
  });
  const u = createUser(s.db);
  const U = client(s.url, sessionFor(s.db, u.id));
  const keys = makeSubscriber().keys;
  for (const endpoint of [`http://127.0.0.1:${push.address().port}/x`, 'https://localhost/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'http://push.example.com/x']) {
    assert.equal((await U.post('/api/notifications/push-subscriptions', { endpoint, keys })).status, 400, endpoint);
  }
  assert.equal((await U.post('/api/notifications/push-subscriptions', { endpoint: 'https://push.example.com/x', keys })).status, 201);
  // API 를 거치지 않고 들어간 내부 주소 구독도 보낼 때 다시 막는다
  s.db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, keys, created_at) VALUES (?,?,?,?,?)').run('ps_local', u.id, `http://127.0.0.1:${push.address().port}/x`, JSON.stringify(keys), Date.now());
  s.db.prepare("DELETE FROM push_subscriptions WHERE endpoint='https://push.example.com/x'").run(); // 바깥으로 실제 요청이 나가지 않게
  // 이름 주소라 저장은 되지만 DNS 가 내부망(localhost. → ::1·127.0.0.1)을 돌려주면 연결하지 않는다(publicLookup)
  let conns = 0;
  const tcp = net.createServer((c) => (conns++, c.destroy()));
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  t.after(() => tcp.close());
  assert.equal((await U.post('/api/notifications/push-subscriptions', { endpoint: `https://localhost.:${tcp.address().port}/x`, keys })).status, 201);
  notify(s.db, u.id, { kind: 'notice', title: '보내면 안 됨' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hits, 0);
  assert.equal(conns, 0);
});

test('VAPID 환경변수는 둘 다 있어야 한다', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-vapid-'));
  const saved = process.env.MIMIC_VAPID_PUBLIC_KEY;
  process.env.MIMIC_VAPID_PUBLIC_KEY = 'BAAA';
  try {
    assert.throws(() => vapidKeys({ dataDir, supportEmail: 'x@y.test' }), /함께/);
  } finally {
    if (saved === undefined) delete process.env.MIMIC_VAPID_PUBLIC_KEY;
    else process.env.MIMIC_VAPID_PUBLIC_KEY = saved;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
