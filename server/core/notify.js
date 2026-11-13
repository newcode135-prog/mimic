import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns';
import { now, newId, isPrivateIp } from './util.js';
import { isLocalUrl, vapidKeys } from './config.js';

// notify() 는 db 만 받으므로 웹 푸시에 필요한 설정(cfg)을 db 에 묶어 둔다(server/index.js 가 createApp 에서 부른다)
const cfgOf = new WeakMap();
export const bindNotify = (db, cfg) => cfgOf.set(db, cfg);

// 사이트 내 알림 + 앱 푸시(K-05). titleEn·bodyEn 은 영어 화면용(K-03, 없으면 한국어를 보여 준다)
export function notify(db, userId, { kind, title, body = '', link = null, titleEn = null, bodyEn = null }) {
  db.prepare('INSERT INTO notifications (id, user_id, kind, title, body, link, created_at, title_en, body_en) VALUES (?,?,?,?,?,?,?,?,?)').run(
    newId('n_'),
    userId,
    kind,
    title,
    body,
    link,
    now(),
    titleEn,
    bodyEn,
  );
  // 푸시를 켠 기기(push_subscriptions)가 있는 사용자에게만. outbox 에 기록하고 기기마다 웹 푸시로 보낸다
  const u = db.prepare('SELECT lang FROM users WHERE id=? AND EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id=users.id)').get(userId);
  if (!u) return;
  const en = u.lang === 'en';
  const t = (en && titleEn) || title;
  const b = (en && bodyEn) || body;
  sendMessage(db, { quiet: true }, { channel: 'push', to: userId, subject: t, body: b || link || '' });
  const cfg = cfgOf.get(db);
  if (cfg) sendPush(db, cfg, userId, { title: t.slice(0, 150), body: (b || '').slice(0, 600), link });
}

// ---------- 웹 푸시(K-05): RFC 8291(aes128gcm 암호화) + RFC 8292(VAPID). 외부 라이브러리 없이 node:crypto 만 쓴다 ----------
// 푸시 주소: 운영 모드는 https + 이름 주소만(내부망 여부는 연결할 때 확인). 개발·테스트는 http://localhost 도 받는다
export function pushEndpointOk(cfg, endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.username || u.password) return false;
    if (cfg.dev && !cfg.demo && !cfg.sitePassword) return u.protocol === 'https:' || (u.protocol === 'http:' && isLocalUrl(endpoint)); // 체험·미리보기 서버는 운영 규칙
    return u.protocol === 'https:' && !net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && u.hostname !== 'localhost';
  } catch {
    return false;
  }
}

// 기다리지 않는다. 실패는 로그만, 404·410(사라진 구독)은 지운다
function sendPush(db, cfg, userId, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  for (const s of db.prepare('SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id=? AND keys IS NOT NULL').all(userId)) {
    pushOne(cfg, s, data)
      .then((status) => {
        if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
        else if (status >= 400) throw new Error(`HTTP ${status}`);
      })
      .catch((e) => {
        if (!cfg.quiet) console.error(`[notify] push → ${userId} 발송 실패: ${e.message}`);
      });
  }
}

async function pushOne(cfg, sub, data) {
  if (!pushEndpointOk(cfg, sub.endpoint)) throw new Error('허용하지 않는 푸시 주소');
  const { p256dh, auth } = JSON.parse(sub.keys);
  const body = encrypt(data, Buffer.from(p256dh, 'base64url'), Buffer.from(auth, 'base64url'));
  const v = vapidKeys(cfg);
  const url = new URL(sub.endpoint);
  const headers = {
    TTL: '86400',
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    Authorization: `vapid t=${vapidJwt(v, url.origin)}, k=${v.publicKey}`,
  };
  const guard = cfg.dev && !cfg.demo && !cfg.sitePassword ? undefined : publicLookup;
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers, agent: false, lookup: guard, signal: AbortSignal.timeout(15_000) }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject).end(body);
  });
}

// RFC 8291 §3.4: 일회용 P-256 키로 ECDH → HKDF 로 CEK·NONCE → 레코드 하나(rs 4096, 끝 표시 0x02)
function encrypt(data, uaPublic, authSecret) {
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('구독 키 길이가 잘못되었습니다');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const salt = crypto.randomBytes(16);
  const hkdf = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hkdf(authSecret, ecdh.computeSecret(uaPublic), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([c.update(data), c.update(Buffer.from([2])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, sealed]);
}

// RFC 8292: ES256 JWT { aud: 푸시 서비스 출처, exp: 12시간, sub: 연락처 }. 비밀키와 출처별 JWT 는 cfg.vapid 에 두고 만료 1시간 전까지 다시 쓴다
// ponytail: 푸시는 notify() 안에서 바로 보낸다(기기마다 ECDH·암호화 ~1ms, 연결 하나). 전체 공지처럼 한 번에 수천 대면 이벤트 루프·동시 연결이 몰리므로 그때는 outbox 를 큐로 삼아 작업으로 나눠 보낸다
function vapidJwt(v, aud) {
  const at = Math.floor(Date.now() / 1000);
  const hit = (v.jwts ??= new Map()).get(aud);
  if (hit && hit.exp - at > 3600) return hit.token;
  const pub = Buffer.from(v.publicKey, 'base64url');
  v.key ??= crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: v.privateKey, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = at + 12 * 3600;
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp, sub: v.subject })}`;
  const token = `${unsigned}.${crypto.sign('sha256', Buffer.from(unsigned), { key: v.key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  if (v.jwts.size >= 1000) v.jwts.clear(); // 출처는 사용자가 정하므로 무한히 쌓이지 않게
  v.jwts.set(aud, { token, exp });
  return token;
}

// 운영 모드: 소켓이 연결할 바로 그 DNS 조회 결과가 내부망이면 막는다(SSRF·DNS rebinding)
function publicLookup(host, opts, cb) {
  lookup(host, opts, (e, address, family) => {
    const list = Array.isArray(address) ? address : [{ address }];
    if (!e && (!list.length || list.some((a) => isPrivateIp(a.address)))) e = new Error('내부망 주소로는 보내지 않습니다');
    cb(e, address, family);
  });
}

// 이메일·SMS·푸시·텔레그램 발송. 개발 모드에서는 outbox 에만 쌓고 콘솔에 출력한다(/dev/outbox 에서 확인).
// 운영 모드의 email·sms 는 설정한 발송 대행사(cfg.mail·cfg.sms, MIMIC_EMAIL_API·MIMIC_SMS_API)로 보낸다. 호출한 쪽을 막지 않도록 기다리지 않는다
// ponytail: 대행사 형식은 JSON { from, to, subject, text } + Bearer 한 가지, 실패는 로그만. 재시도·다른 형식이 필요하면 outbox 에 발송 상태 열을 두고 작업으로 다시 보낸다
export function sendMessage(db, cfg, { channel, to, subject = null, body }) {
  db.prepare('INSERT INTO outbox (id, channel, to_addr, subject, body, created_at) VALUES (?,?,?,?,?,?)').run(
    newId('o_'),
    channel,
    to,
    subject,
    body,
    now(),
  );
  if (cfg.dev) {
    if (!cfg.quiet) console.log(`[outbox:${channel} → ${to}] ${subject ? subject + ' | ' : ''}${body}`);
    return;
  }
  const p = channel === 'email' ? cfg.mail : channel === 'sms' ? cfg.sms : null;
  if (!p?.api) {
    if (p && !cfg.quiet) console.error(`[notify] ${channel} 발송 대행사가 설정되지 않아 ${to} 에게 보내지 못했습니다`);
    return;
  }
  const from = p.from || (channel === 'email' ? cfg.supportEmail : undefined);
  fetch(p.api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(p.key ? { authorization: `Bearer ${p.key}` } : {}) },
    body: JSON.stringify({ from, to, subject: subject ?? undefined, text: body }),
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (r) => {
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
    })
    .catch((e) => console.error(`[notify] ${channel} → ${to} 발송 실패: ${e.message}`));
}

export function audit(db, { userId = null, action, detail = null, ip = null }) {
  db.prepare('INSERT INTO audit_log (id, user_id, action, detail, ip, created_at) VALUES (?,?,?,?,?,?)').run(
    newId('a_'),
    userId,
    action,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    ip,
    now(),
  );
}
