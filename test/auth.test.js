import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { createSession, createToken, hashPassword } from '../server/core/auth.js';
import { now, DAY } from '../server/core/util.js';
import { runHourly, runDormant, detectSharing, regionBlocked, netOf } from '../server/modules/auth/index.js';
import { appleClientSecret } from '../server/modules/auth/oauth.js';

const NO_OAUTH = { google: {}, facebook: {}, apple: {} };
const lastCode = (db, to) => db.prepare('SELECT body FROM outbox WHERE to_addr=? ORDER BY rowid DESC LIMIT 1').get(to).body.match(/\d{6}/)[0];
const cookieOf = (res, name = 'mimic_sid') => res.headers.getSetCookie().map((c) => c.match(new RegExp(`^${name}=([^;]+)`))?.[1]).find(Boolean);
// 소셜 로그인을 시작한 브라우저가 받은 state 쿠키
const oauthCookie = (res) => ({ cookie: `mimic_oauth=${cookieOf(res, 'mimic_oauth')}` });
const form = (o, extra = {}) => [new URLSearchParams(o).toString(), { 'content-type': 'application/x-www-form-urlencoded', ...extra }];
const userRow = (db, id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
// 새 계정 필수 동의 3가지(만 14세 이상·이용약관·개인정보 수집·이용)
const AGREE = { agreeAge14: true, agreeTerms: true, agreePrivacy: true };
const AGREE_Q = 'agreeAge14=1&agreeTerms=1&agreePrivacy=1';

test('auth: 가입·로그인·계정·정책', async (t) => {
  const s = await startServer({ oauth: NO_OAUTH });
  t.after(() => s.close());
  const c = client(s.url);
  const events = [];
  for (const name of ['user:created', 'user:login', 'user:deleted']) s.ctx.events.on(name, (p) => events.push({ name, ...p }));
  const admin = createUser(s.db, { admin: true });
  const adminC = client(s.url, sessionFor(s.db, admin.id));

  await t.test('[H-01] 이메일 가입: 인증코드·60초 재전송 제한·비밀번호 규칙·약관 동의·초대코드 전달', async () => {
    const email = 'new@test.local';
    assert.equal((await c.post('/api/auth/email/send-code', { email, purpose: 'signup' })).status, 200);
    assert.equal((await c.post('/api/auth/email/send-code', { email, purpose: 'signup' })).body.error, 'too_soon');
    const code = lastCode(s.db, email);
    assert.equal(s.db.prepare('SELECT count(*) n FROM auth_codes WHERE code_hash=?').get(code).n, 0, '코드는 해시로만 저장');
    const base = { email, code, password: 'abc12!x', ...AGREE, inviteCode: 'INV123' };
    assert.equal((await c.post('/api/auth/email/signup', { ...base, password: 'abcdef' })).body.error, 'weak_password');
    assert.equal((await c.post('/api/auth/email/signup', { ...base, agreeAge14: false })).body.error, 'terms_required');
    assert.equal((await c.post('/api/auth/email/signup', { ...base, agreePrivacy: undefined })).body.error, 'terms_required', '개인정보 동의만 빠져도 거절');
    assert.equal((await c.post('/api/auth/email/signup', { ...base, code: code === '000000' ? '111111' : '000000' })).body.error, 'invalid_code');
    const r = await c.post('/api/auth/email/signup', base, { 'accept-language': 'en-US,en;q=0.9' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.email, email);
    assert.equal(r.body.user.region, 'US');
    assert.match(r.body.user.inviteCode, /^[A-Z2-9]{8}$/);
    const token = cookieOf(r);
    assert.ok(token, '세션 쿠키');
    assert.equal((await client(s.url, token).get('/api/me')).body.user.email, email);
    assert.ok(events.some((e) => e.name === 'user:created' && e.via === 'email' && e.inviteCode === 'INV123'));
    assert.ok(events.some((e) => e.name === 'user:login' && e.userId === r.body.user.id));
    assert.equal((await c.post('/api/auth/email/send-code', { email, purpose: 'signup' })).body.error, 'email_taken');
  });

  await t.test('[H-01] 인증코드는 5분 뒤 만료', async () => {
    const email = 'late@test.local';
    await c.post('/api/auth/email/send-code', { email, purpose: 'signup' });
    const code = lastCode(s.db, email);
    const row = s.db.prepare('SELECT created_at, expires_at FROM auth_codes WHERE target=?').get(email);
    assert.equal(row.expires_at - row.created_at, 5 * 60_000);
    s.db.prepare('UPDATE auth_codes SET expires_at=? WHERE target=?').run(now() - 1, email);
    const r = await c.post('/api/auth/email/signup', { email, code, password: 'abc12!x', ...AGREE });
    assert.equal(r.body.error, 'code_expired');
    assert.equal(s.db.prepare('SELECT 1 FROM users WHERE email=?').get(email), undefined);
  });

  await t.test('[H-01] 이메일 로그인 5회 실패 시 시도 제한, 비밀번호 재설정', async () => {
    const email = 'login@test.local';
    createUser(s.db, { email, password: 'pass12!' });
    for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/email/login', { email, password: 'wrong1!' })).status, 401);
    assert.equal((await c.post('/api/auth/email/login', { email, password: 'pass12!' })).body.error, 'too_many_attempts');
    await c.post('/api/auth/email/send-code', { email, purpose: 'reset' });
    const r = await c.post('/api/auth/password/reset', { email, code: lastCode(s.db, email), password: 'newpw1@' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ok = await c.post('/api/auth/email/login', { email, password: 'newpw1@' });
    assert.equal(ok.status, 200);
    assert.ok(cookieOf(ok));
  });

  await t.test('[H-01] 인증코드 추측 제한: 대상별 합산 10회 틀리면 1시간 잠금(새 코드·다른 IP 도), 하루 10개, IP 별 확인 30회/10분', async () => {
    const email = 'guess@test.local';
    createUser(s.db, { email, password: 'guess1!' });
    let ip = 0;
    const from = () => ({ 'x-forwarded-for': `198.51.100.${++ip}` }); // 요청마다 다른 IP
    const resend = () => s.db.prepare('UPDATE auth_codes SET created_at = created_at - 61000 WHERE target=?').run(email);
    const sendReset = () => c.post('/api/auth/email/send-code', { email, purpose: 'reset' }, from());
    const reset = (code) => c.post('/api/auth/password/reset', { email, code, password: 'hijack1!' }, from());
    const wrong = (code) => (code === '000000' ? '111111' : '000000');
    for (let round = 0; round < 2; round++) {
      resend();
      assert.equal((await sendReset()).status, 200);
      const code = lastCode(s.db, email);
      for (let i = 0; i < 5; i++) assert.equal((await reset(wrong(code))).body.error, 'invalid_code');
    }
    assert.equal((await reset(lastCode(s.db, email))).body.error, 'too_many_attempts', '잠금 중엔 맞는 코드도 거절');
    resend();
    assert.equal((await sendReset()).body.error, 'too_many_attempts', '잠금 중엔 새 코드도 보내지 않음');
    // 1시간이 지나면 풀린다
    s.db.prepare('UPDATE auth_failures SET created_at = created_at - 3600000 WHERE key=?').run(`code:${email}`);
    assert.equal((await sendReset()).status, 200);
    assert.equal((await reset(lastCode(s.db, email))).status, 200);
    // 대상별 하루 10개
    const phone = '+821055556666';
    const ins = s.db.prepare('INSERT INTO auth_codes (id, target, purpose, code_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)');
    for (let i = 0; i < 10; i++) ins.run(`c_daily${i}`, phone, 'login', 'x', now() - 3600_000, now() - 3000_000);
    assert.equal((await c.post('/api/auth/phone/send-code', { phone }, from())).body.error, 'too_many_codes');
    // IP 하나로 여러 대상을 번갈아 확인해도 10분에 30회까지
    const one = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 30; i++) assert.equal((await c.post('/api/auth/phone/verify', { phone: `+8210111100${String(i).padStart(2, '0')}`, code: '123456', ...AGREE }, one)).body.error, 'code_expired');
    assert.equal((await c.post('/api/auth/phone/verify', { phone: '+821011119999', code: '123456', ...AGREE }, one)).body.error, 'too_many_requests');
  });

  await t.test('[H-01] 휴대폰: 처음 쓰는 번호는 자동 가입, 다시 오면 로그인, 비밀번호 로그인, 로그아웃', async () => {
    const phone = '+821012345678';
    const sent = await c.post('/api/auth/phone/send-code', { phone });
    assert.equal(sent.body.isNew, true);
    assert.equal((await c.post('/api/auth/phone/verify', { phone, code: lastCode(s.db, phone) })).body.error, 'terms_required');
    const r = await c.post('/api/auth/phone/verify', { phone, code: lastCode(s.db, phone), ...AGREE, inviteCode: 'FRIEND1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.created, true);
    assert.equal(r.body.user.phone, phone);
    assert.equal(r.body.user.region, 'KR');
    assert.ok(events.some((e) => e.name === 'user:created' && e.via === 'phone' && e.inviteCode === 'FRIEND1'));

    const token = cookieOf(r);
    assert.equal((await client(s.url, token).post('/api/auth/logout')).status, 200);
    assert.equal((await client(s.url, token).get('/api/me')).status, 401);

    s.db.prepare('UPDATE auth_codes SET created_at = created_at - 61000 WHERE target=?').run(phone);
    assert.equal((await c.post('/api/auth/phone/send-code', { phone })).body.isNew, false);
    const again = await c.post('/api/auth/phone/verify', { phone, code: lastCode(s.db, phone) });
    assert.equal(again.body.created, false);
    assert.equal(again.body.user.id, r.body.user.id);

    s.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword('ph0ne!pw'), r.body.user.id);
    assert.equal((await c.post('/api/auth/phone/password-login', { phone, password: 'ph0ne!pw' })).status, 200);
    assert.equal((await c.post('/api/auth/phone/password-login', { phone, password: 'nope11!' })).body.error, 'invalid_credentials');
  });

  await t.test('[H-01] 소셜(개발용 화면): 시작 → 개발용 로그인 → 가입·세션, 약관 미동의·state 재사용 거절, 계정 연결', async () => {
    const start = await c.get(`/api/auth/oauth/google/start?${AGREE_Q}&invite=SOC1&next=/drive/recent`);
    assert.equal(start.status, 302);
    const loc = start.headers.get('location');
    assert.match(loc, /^\/api\/auth\/oauth\/google\/dev\?state=/);
    const state = new URL(loc, s.url).searchParams.get('state');
    const page = await c.get(loc);
    assert.match(page.body, /개발용/);
    const bound = oauthCookie(start);
    assert.match(start.headers.getSetCookie().find((x) => x.startsWith('mimic_oauth=')), /HttpOnly/i);
    const done = await c.post('/api/auth/oauth/google/dev', ...form({ state, email: 'soc@test.local', name: '소셜' }, bound));
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/drive/recent');
    assert.ok(cookieOf(done));
    const u = s.db.prepare('SELECT * FROM users WHERE email=?').get('soc@test.local');
    assert.equal(u.password_hash, null);
    assert.ok(s.db.prepare("SELECT 1 FROM identities WHERE provider='google' AND user_id=?").get(u.id));
    assert.ok(events.some((e) => e.name === 'user:created' && e.via === 'google' && e.inviteCode === 'SOC1'));
    // 같은 state 는 한 번만
    assert.equal((await c.post('/api/auth/oauth/google/dev', ...form({ state, email: 'x@test.local' }, bound))).headers.get('location'), '/login?error=oauth_state');
    // 약관 동의 없이 새 가입은 거절
    const a2 = await c.get('/api/auth/oauth/apple/start');
    const s2 = new URL(a2.headers.get('location'), s.url).searchParams.get('state');
    assert.equal((await c.post('/api/auth/oauth/apple/dev', ...form({ state: s2, email: 'noagree@test.local' }, oauthCookie(a2)))).headers.get('location'), '/login?error=terms_required');
    // 로그인한 사용자가 Facebook 연결
    const me = createUser(s.db);
    const mc = client(s.url, sessionFor(s.db, me.id));
    const l = await mc.get('/api/auth/oauth/facebook/start?link=1');
    const s3 = new URL(l.headers.get('location'), s.url).searchParams.get('state');
    const linked = await mc.post('/api/auth/oauth/facebook/dev', ...form({ state: s3, email: 'fb@test.local' }, oauthCookie(l)));
    assert.equal(linked.headers.get('location'), '/drive/account/social?linked=facebook');
    assert.equal((await mc.get('/api/auth/account')).body.identities[0].provider, 'facebook');
  });

  await t.test('[H-01] 인증 안 된 Facebook 이메일로 남의 이메일을 선점하거나 주인의 소셜 로그인을 가로챌 수 없다', async () => {
    const devSocial = async (p, email) => {
      const st = await c.get(`/api/auth/oauth/${p}/start?${AGREE_Q}`);
      const state = new URL(st.headers.get('location'), s.url).searchParams.get('state');
      return c.post(`/api/auth/oauth/${p}/dev`, ...form({ state, email }, oauthCookie(st)));
    };
    const identOwner = (p, email) => s.db.prepare('SELECT user_id FROM identities WHERE provider=? AND email=?').get(p, email).user_id;
    const victim = 'victim@test.local';
    // 공격자: 피해자 이메일을 단 Facebook 으로 먼저 가입
    assert.equal((await devSocial('facebook', victim)).headers.get('location'), '/drive/all');
    const atkId = identOwner('facebook', victim);
    assert.equal(userRow(s.db, atkId).email, null, '인증 안 된 공급자 이메일은 계정 이메일이 되지 않음');
    // 주인은 자기 이메일로 가입할 수 있다
    assert.equal((await c.post('/api/auth/email/send-code', { email: victim, purpose: 'signup' })).status, 200);
    const own = await c.post('/api/auth/email/signup', { email: victim, code: lastCode(s.db, victim), password: 'vict1m!', ...AGREE });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    // 주인의 Google(인증된 같은 이메일) 로그인은 주인 계정에 연결되고 공격자 계정과는 무관
    assert.equal((await devSocial('google', victim)).headers.get('location'), '/drive/all');
    assert.equal(identOwner('google', victim), own.body.user.id);
    assert.deepEqual(s.db.prepare('SELECT provider FROM identities WHERE user_id=?').all(atkId).map((r) => r.provider), ['facebook']);
    // 인증 표시가 없는 이메일 계정(관리자가 넣은 값·예전 데이터)에는 자동 연결하지 않고 새 계정을 만든다
    const legacy = createUser(s.db, { email: 'legacy@test.local' });
    assert.equal((await devSocial('apple', 'legacy@test.local')).headers.get('location'), '/drive/all');
    const appleId = identOwner('apple', 'legacy@test.local');
    assert.notEqual(appleId, legacy.id);
    assert.equal(userRow(s.db, appleId).email, null);
  });

  await t.test('[H-01] 소셜 CSRF: 시작한 브라우저가 아니면 로그인·연결을 끝낼 수 없다', async () => {
    // 로그인 CSRF: 공격자가 받은 state 를 쿠키 없는 다른 브라우저가 쓰면 거절, 세션도 안 생김
    const atk = await c.get(`/api/auth/oauth/google/start?${AGREE_Q}`);
    const st = new URL(atk.headers.get('location'), s.url).searchParams.get('state');
    const forged = await c.post('/api/auth/oauth/google/dev', ...form({ state: st, email: 'attacker@test.local' }));
    assert.equal(forged.headers.get('location'), '/login?error=oauth_state');
    assert.equal(cookieOf(forged), undefined);
    assert.equal(s.db.prepare('SELECT 1 FROM users WHERE email=?').get('attacker@test.local'), undefined);
    // 다른 state 쿠키를 가진 브라우저도 거절
    const mine = await c.get(`/api/auth/oauth/google/start?${AGREE_Q}`);
    assert.equal((await c.post('/api/auth/oauth/google/dev', ...form({ state: st, email: 'attacker@test.local' }, oauthCookie(mine)))).headers.get('location'), '/login?error=oauth_state');

    // 연결 CSRF: 공격자가 자기 세션으로 연결을 시작 → 피해자 브라우저(피해자 세션, 공격자 쿠키 없음)가 끝내려 하면 거절
    const attacker = createUser(s.db);
    const victim = createUser(s.db);
    const ac = client(s.url, sessionFor(s.db, attacker.id));
    const vc = client(s.url, sessionFor(s.db, victim.id));
    const l = await ac.get('/api/auth/oauth/google/start?link=1');
    const ls = new URL(l.headers.get('location'), s.url).searchParams.get('state');
    assert.equal((await vc.post('/api/auth/oauth/google/dev', ...form({ state: ls, email: 'victim-g@test.local' }))).headers.get('location'), '/login?error=oauth_state');
    // 쿠키가 있어도 연결을 시작한 계정의 세션이 아니면 거절
    const l2 = await ac.get('/api/auth/oauth/google/start?link=1');
    const ls2 = new URL(l2.headers.get('location'), s.url).searchParams.get('state');
    assert.equal((await vc.post('/api/auth/oauth/google/dev', ...form({ state: ls2, email: 'victim-g@test.local' }, oauthCookie(l2)))).headers.get('location'), '/drive/account/social?error=oauth_session_mismatch');
    assert.equal(s.db.prepare("SELECT count(*) n FROM identities WHERE user_id IN (?, ?)").get(attacker.id, victim.id).n, 0);

    // 프로토타입 키는 공급자가 아니다
    for (const p of ['constructor', 'toString', '__proto__']) assert.equal((await c.get(`/api/auth/oauth/${p}/start?${AGREE_Q}`)).status, 404, p);
  });

  await t.test('[H-01] QR 로그인: 발급 → 대기 → 다른 기기 승인 → 세션 발급, 만료 처리', async () => {
    const q = await c.post('/api/auth/qr');
    assert.match(q.body.qrDataUrl, /^data:image\/png;base64,/);
    assert.ok(q.body.expiresAt - now() <= 2 * 60_000 + 1000);
    const token = new URL(q.body.approveUrl).searchParams.get('qr');
    assert.equal((await c.get(`/api/auth/qr/${q.body.qrId}/status`)).body.status, 'pending');
    const approver = createUser(s.db);
    const ac = client(s.url, sessionFor(s.db, approver.id));
    assert.equal((await ac.get(`/api/auth/qr/info?token=${token}`)).status, 200);
    assert.equal((await c.post('/api/auth/qr/approve', { token })).status, 401);
    assert.equal((await ac.post('/api/auth/qr/approve', { token, approve: true }, { 'user-agent': 'MimicPhone/1.0' })).body.status, 'approved');
    const rec = s.db.prepare('SELECT user_id, approver_ip, approver_ua FROM auth_qr WHERE id=?').get(q.body.qrId);
    assert.equal(rec.user_id, approver.id);
    assert.match(rec.approver_ip, /127\.0\.0\.1/);
    assert.equal(rec.approver_ua, 'MimicPhone/1.0');
    const st = await c.get(`/api/auth/qr/${q.body.qrId}/status`);
    assert.equal(st.body.status, 'approved');
    assert.equal(st.body.user.id, approver.id);
    assert.ok(cookieOf(st));
    assert.equal((await c.get(`/api/auth/qr/${q.body.qrId}/status`)).body.status, 'expired', '한 번만 쓸 수 있음');

    const q2 = await c.post('/api/auth/qr');
    s.db.prepare('UPDATE auth_qr SET expires_at=? WHERE id=?').run(now() - 1, q2.body.qrId);
    assert.equal((await c.get(`/api/auth/qr/${q2.body.qrId}/status`)).body.status, 'expired');
    assert.equal((await ac.post('/api/auth/qr/approve', { token: new URL(q2.body.approveUrl).searchParams.get('qr'), approve: true })).status, 410);

    // approve:true 가 아니면 거절로 처리 → 웹은 로그인되지 않음
    const q3 = await c.post('/api/auth/qr');
    assert.equal((await ac.post('/api/auth/qr/approve', { token: new URL(q3.body.approveUrl).searchParams.get('qr') })).body.status, 'denied');
    const st3 = await c.get(`/api/auth/qr/${q3.body.qrId}/status`);
    assert.equal(st3.body.status, 'denied');
    assert.equal(cookieOf(st3), undefined);
  });

  await t.test('[H-01] CLI 기기 인가: 코드 발급 → 대기 → 브라우저 승인 → 토큰', async () => {
    const d = await c.post('/api/auth/device/code', { clientName: 'Mimic CLI' });
    assert.match(d.body.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.match(d.body.verificationUri, /\/approve\?code=/);
    assert.equal((await c.post('/api/auth/device/token', { deviceCode: d.body.deviceCode })).body.error, 'authorization_pending');
    const owner = createUser(s.db);
    const oc = client(s.url, sessionFor(s.db, owner.id));
    assert.deepEqual((await oc.get(`/api/auth/device/info?code=${d.body.userCode.toLowerCase()}`)).body.scopes, ['files:write', 'services']);
    assert.equal((await oc.post('/api/auth/device/approve', { userCode: d.body.userCode, approve: true })).status, 200);
    const tok = await c.post('/api/auth/device/token', { deviceCode: d.body.deviceCode });
    assert.equal(tok.status, 200, JSON.stringify(tok.body));
    // G-04: 다른 키 발급과 같게 이메일 + 사이트 알림(kind 'token')
    assert.match(s.db.prepare('SELECT body FROM outbox WHERE to_addr=? ORDER BY rowid DESC LIMIT 1').get(owner.email).body, /Mimic CLI/);
    assert.ok(s.db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind='token'").get(owner.id));
    assert.match(tok.body.token, /^mp_/);
    assert.equal((await client(s.url, tok.body.token).get('/api/me')).body.user.id, owner.id);
    assert.equal(s.db.prepare('SELECT app_id FROM personal_tokens WHERE id=?').get(tok.body.tokenId).app_id, 'cli');
    assert.equal((await c.post('/api/auth/device/token', { deviceCode: d.body.deviceCode })).body.error, 'expired_token');
    // 연결 앱 토큰으로는 다른 기기를 승인할 수 없다
    const d2 = await c.post('/api/auth/device/code', {});
    assert.equal((await client(s.url, tok.body.token).post('/api/auth/device/approve', { userCode: d2.body.userCode, approve: true })).body.error, 'session_required');
    // 'extension'(공식 확장 대우)은 누구나 댈 수 있으므로 무엇을 요청해도 클라우드 다운로드(services)만 받는다(F-05)
    const ext = await c.post('/api/auth/device/code', { clientName: 'my script', appId: 'extension', scopes: ['files:write', 'files:delete', 'account', 'services'] });
    assert.deepEqual((await oc.get(`/api/auth/device/info?code=${ext.body.userCode}`)).body.scopes, ['services']);
    assert.equal((await c.post('/api/auth/device/code', { appId: 'webdav' })).body.error, 'invalid_app');
  });

  await t.test('[H-02] 계정 및 보안: 프로필·비밀번호·휴대폰·이메일 연동·기기 목록·원격 로그아웃·소셜 해제', async () => {
    const u = createUser(s.db, { email: null });
    s.db.prepare("INSERT INTO identities (provider, subject, user_id, created_at) VALUES ('google', 'g-only', ?, ?)").run(u.id, now());
    const token = sessionFor(s.db, u.id);
    const uc = client(s.url, token);
    const avatar = 'data:image/png;base64,iVBORw0KGgo=';
    const p = await uc.patch('/api/auth/account', { name: '새 이름', avatar });
    assert.equal(p.body.user.name, '새 이름');
    assert.equal(p.body.user.avatar, avatar);
    assert.equal((await uc.patch('/api/auth/account', { avatar: 'data:image/png;base64,"><script>' })).body.error, 'invalid_avatar');
    // 마지막 로그인 수단은 해제할 수 없다
    assert.equal((await uc.del('/api/auth/account/identities/google')).body.error, 'last_login_method');
    // 소셜 계정은 현재 비밀번호 없이 처음 설정
    assert.equal((await uc.post('/api/auth/account/password', { password: 'first1!' })).status, 200);
    assert.equal((await uc.post('/api/auth/account/password', { password: 'second2!' })).body.error, 'wrong_password');
    assert.equal((await uc.post('/api/auth/account/password', { current: 'first1!', password: 'second2!' })).status, 200);
    // 휴대폰 연동(일본 번호 → 지역 JP)
    const phone = '+819012345678';
    assert.equal((await uc.post('/api/auth/phone/send-code', { phone, purpose: 'bind' })).status, 200);
    const ph = await uc.post('/api/auth/account/phone', { phone, code: lastCode(s.db, phone) });
    assert.equal(ph.body.user.phone, phone);
    assert.equal(ph.body.user.region, 'JP');
    // 이메일 연동
    const email = 'bind@test.local';
    await uc.post('/api/auth/email/send-code', { email, purpose: 'bind' });
    assert.equal((await uc.post('/api/auth/account/email', { email, code: lastCode(s.db, email) })).body.user.email, email);
    // 이메일 바꾸기: 지금 이메일로 받은 코드가 없으면 거절, 있으면 변경 + 예전 주소로 안내
    const email2 = 'bind2@test.local';
    await uc.post('/api/auth/email/send-code', { email: email2, purpose: 'bind' });
    const newCode = lastCode(s.db, email2);
    assert.equal((await uc.post('/api/auth/account/email', { email: email2, code: newCode })).status, 400);
    assert.equal((await uc.post('/api/auth/email/send-code', { purpose: 'change' })).status, 200);
    const ch = await uc.post('/api/auth/account/email', { email: email2, code: newCode, oldCode: lastCode(s.db, email) });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    assert.equal(ch.body.user.email, email2);
    assert.ok(s.db.prepare("SELECT 1 FROM outbox WHERE to_addr=? AND subject LIKE '%이메일 변경%'").get(email));
    // 번호 바꾸기도 지금 번호 확인 필요 + 예전 번호로 안내
    const phone2 = '+819087654321';
    await uc.post('/api/auth/phone/send-code', { phone: phone2, purpose: 'bind' });
    const pCode = lastCode(s.db, phone2);
    assert.equal((await uc.post('/api/auth/account/phone', { phone: phone2, code: pCode, oldCode: '000000' })).status, 400);
    assert.equal(userRow(s.db, u.id).phone, phone);
    await uc.post('/api/auth/phone/send-code', { purpose: 'change' });
    const pch = await uc.post('/api/auth/account/phone', { phone: phone2, code: pCode, oldCode: lastCode(s.db, phone) });
    assert.equal(pch.status, 200, JSON.stringify(pch.body));
    assert.equal(pch.body.user.phone, phone2);
    assert.match(s.db.prepare('SELECT body FROM outbox WHERE to_addr=? ORDER BY rowid DESC LIMIT 1').get(phone).body, /바뀌었습니다/);
    // 이제 해제 가능
    assert.equal((await uc.del('/api/auth/account/identities/google')).status, 200);
    // 기기 목록·원격 로그아웃
    const other = sessionFor(s.db, u.id);
    const list = (await uc.get('/api/auth/sessions')).body.items;
    assert.equal(list.length, 2);
    assert.equal(list.filter((x) => x.current).length, 1);
    const target = list.find((x) => !x.current);
    assert.equal((await uc.del(`/api/auth/sessions/${target.id}`)).status, 200);
    assert.equal((await client(s.url, other).get('/api/me')).status, 401);
    // 다른 사람 세션은 지울 수 없다
    const stranger = createUser(s.db);
    assert.equal((await client(s.url, sessionFor(s.db, stranger.id)).del(`/api/auth/sessions/${list.find((x) => x.current).id}`)).status, 404);
    // 연결 앱 토큰으로는 계정을 바꿀 수 없다
    const pat = createToken(s.db, u.id, { name: 'x', scopes: ['files:write'] }).token;
    assert.equal((await client(s.url, pat).patch('/api/auth/account', { name: 'hack' })).body.error, 'session_required');
  });

  await t.test('[H-02] 탈퇴: 즉시 오프라인 → 7일 안 재로그인 복구 → 7일 뒤 삭제', async () => {
    const email = 'bye@test.local';
    const u = createUser(s.db, { email, password: 'bye12!x' });
    const token = cookieOf(await c.post('/api/auth/email/login', { email, password: 'bye12!x' }));
    const uc = client(s.url, token);
    assert.equal((await uc.post('/api/auth/account/delete', { confirm: '아니오' })).body.error, 'confirm_required');
    assert.equal((await uc.post('/api/auth/account/delete', { confirm: '탈퇴' })).status, 200);
    assert.equal(userRow(s.db, u.id).status, 'pending_delete');
    assert.equal((await uc.get('/api/me')).status, 401);
    const back = await c.post('/api/auth/email/login', { email, password: 'bye12!x' });
    assert.equal(back.status, 200);
    assert.equal(userRow(s.db, u.id).status, 'active');
    assert.ok(s.db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE '%취소%'").get(u.id));
    // 휴대폰만 있는 계정은 SMS 로 복구 안내
    const pu = createUser(s.db, { email: null, phone: '+821077778888' });
    assert.equal((await client(s.url, sessionFor(s.db, pu.id)).post('/api/auth/account/delete', { confirm: '탈퇴' })).status, 200);
    assert.match(s.db.prepare("SELECT body FROM outbox WHERE to_addr=? AND channel='sms'").get(pu.phone).body, /7일 안에 다시 로그인/);
    // 유예 7일이 지난 뒤 로그인은 복구하지 않는다(매시간 삭제 작업이 아직 돌지 않았어도 그 자리에서 삭제)
    const late = createUser(s.db, { email: 'late@test.local', password: 'late12!x' });
    s.db.prepare("UPDATE users SET status='pending_delete', delete_requested_at=? WHERE id=?").run(now() - 10 * DAY, late.id);
    assert.equal((await c.post('/api/auth/email/login', { email: 'late@test.local', password: 'late12!x' })).body.error, 'account_deleted');
    assert.equal(userRow(s.db, late.id), undefined);

    const gone = createUser(s.db);
    const held = createUser(s.db);
    s.db.prepare("UPDATE users SET status='pending_delete', delete_requested_at=? WHERE id IN (?, ?)").run(now() - 8 * DAY, gone.id, held.id);
    // 관리자가 탈퇴 처리를 멈춘다(법 위반·도난 위험)
    assert.equal((await client(s.url, sessionFor(s.db, createUser(s.db).id)).post(`/api/admin/auth/users/${held.id}/delete-hold`, { hold: true })).status, 403);
    assert.equal((await adminC.post(`/api/admin/auth/users/${held.id}/delete-hold`, { hold: 'yes' })).body.error, 'invalid_hold');
    const hold = await adminC.post(`/api/admin/auth/users/${held.id}/delete-hold`, { hold: true });
    assert.equal(hold.status, 200, JSON.stringify(hold.body));
    assert.equal(hold.body.status, 'pending_delete');
    assert.equal(hold.body.deleteHold, true);
    assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action='auth:delete_hold_on'").get());
    runHourly(s.ctx);
    assert.equal(userRow(s.db, gone.id), undefined);
    assert.ok(userRow(s.db, held.id), '삭제 중지된 계정은 남는다');
    assert.ok(events.some((e) => e.name === 'user:deleted' && e.userId === gone.id));
  });

  await t.test('[H-01] CLI 미인증 계정: 72시간 뒤 잠금, 잠금 12개월 뒤 삭제', () => {
    const u = createUser(s.db);
    s.db.prepare("UPDATE users SET status='unverified', created_at=? WHERE id=?").run(now() - 73 * 3600_000, u.id);
    runHourly(s.ctx);
    const locked = userRow(s.db, u.id);
    assert.equal(locked.status, 'locked');
    assert.ok(locked.status_until > now() + 360 * DAY);
    s.db.prepare('UPDATE users SET status_until=? WHERE id=?').run(now() - 1, u.id);
    runHourly(s.ctx);
    assert.equal(userRow(s.db, u.id), undefined);
  });

  await t.test('[H-03] 휴면: 12개월 미로그인 알림·7일 유예 후 삭제, 3년+연락처 없음 즉시 삭제, 프리미엄 제외, 로그인하면 중단', async () => {
    const old = now() - 400 * DAY;
    const a = createUser(s.db, { email: 'dormant@test.local' });
    const noContact = createUser(s.db, { email: null });
    const prem = createUser(s.db, { premium: true });
    const back = createUser(s.db, { email: 'comeback@test.local', password: 'back12!' });
    const deadContact = createUser(s.db, { email: 'bounced@test.local' });
    const oldWithContact = createUser(s.db, { email: 'oldbutok@test.local' });
    s.db.prepare('UPDATE users SET created_at=?, last_login_at=? WHERE id IN (?,?,?)').run(old, old, a.id, prem.id, back.id);
    const ancient = now() - 4 * 365 * DAY;
    s.db.prepare('UPDATE users SET created_at=?, last_login_at=? WHERE id IN (?,?,?)').run(ancient, ancient, noContact.id, deadContact.id, oldWithContact.id);
    // 관리자가 연락처 무효(반송 등)를 표시
    assert.equal((await client(s.url, sessionFor(s.db, createUser(s.db).id)).post(`/api/admin/auth/users/${deadContact.id}/contact-invalid`, { invalid: true })).status, 403);
    assert.equal((await adminC.post(`/api/admin/auth/users/${deadContact.id}/contact-invalid`, { invalid: 'y' })).body.error, 'invalid_flag');
    assert.ok((await adminC.post(`/api/admin/auth/users/${deadContact.id}/contact-invalid`, { invalid: true })).body.contactInvalidAt);
    runDormant(s.ctx);
    assert.equal(userRow(s.db, noContact.id), undefined);
    assert.equal(userRow(s.db, deadContact.id), undefined, '3년+ 연락처 무효 → 즉시 삭제');
    assert.ok(JSON.parse(userRow(s.db, oldWithContact.id).settings).dormantNoticeAt, '3년+ 이어도 연락처가 살아 있으면 알림·유예');
    assert.ok(JSON.parse(userRow(s.db, a.id).settings).dormantNoticeAt);
    assert.ok(s.db.prepare("SELECT 1 FROM outbox WHERE to_addr='dormant@test.local'").get());
    assert.ok(s.db.prepare('SELECT 1 FROM notifications WHERE user_id=?').get(a.id));
    assert.equal(JSON.parse(userRow(s.db, prem.id).settings).dormantNoticeAt, undefined);
    // 유예 중 로그인하면 중단
    assert.equal((await c.post('/api/auth/email/login', { email: 'comeback@test.local', password: 'back12!' })).status, 200);
    assert.equal(JSON.parse(userRow(s.db, back.id).settings).dormantNoticeAt, null);
    // 7일이 지나면 삭제
    s.db.prepare('UPDATE users SET settings=? WHERE id=?').run(JSON.stringify({ dormantNoticeAt: now() - 8 * DAY }), a.id);
    runDormant(s.ctx);
    assert.equal(userRow(s.db, a.id), undefined);
    assert.ok(userRow(s.db, back.id));
  });

  await t.test('[H-04] 계정 공유 탐지: 1시간 안 /24 대역 5곳 → 24시간 정지, 기한 뒤 자동 해제', async () => {
    const email = 'share@test.local';
    const u = createUser(s.db, { email, password: 'share1!' });
    for (let i = 1; i <= 4; i++) createSession(s.db, u.id, { ip: `10.0.${i}.5`, get: () => null });
    createSession(s.db, u.id, { ip: '10.0.1.99', get: () => null }); // 같은 대역은 한 곳
    assert.equal(detectSharing(s.ctx, u.id), false);
    createSession(s.db, u.id, { ip: '::ffff:10.0.5.7', get: () => null });
    assert.equal(detectSharing(s.ctx, u.id), true);
    const row = userRow(s.db, u.id);
    assert.equal(row.status, 'suspended');
    assert.ok(Math.abs(row.status_until - (now() + DAY)) < 60_000);
    assert.equal((await client(s.url, sessionFor(s.db, u.id)).get('/api/me')).body.error, 'account_suspended');
    assert.equal((await c.post('/api/auth/email/login', { email, password: 'share1!' })).body.error, 'account_suspended');
    assert.ok(s.db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind='security'").get(u.id));
    s.db.prepare('UPDATE users SET status_until=? WHERE id=?').run(now() - 1, u.id);
    runHourly(s.ctx);
    assert.equal(userRow(s.db, u.id).status, 'active');
  });

  await t.test('[H-04] 세션 하나를 여러 곳에서 돌려 써도 탐지, 미인증 계정도 정지 후 원래 상태로, IPv6 /48 묶음', async () => {
    const u = createUser(s.db);
    s.db.prepare("UPDATE users SET status='unverified' WHERE id=?").run(u.id);
    const uc = client(s.url, sessionFor(s.db, u.id)); // 쿠키(세션) 하나
    const from = (i) => uc.get('/api/auth/account', { 'x-forwarded-for': `172.16.${i}.9` });
    for (let i = 1; i <= 4; i++) assert.equal((await from(i)).status, 200);
    assert.equal((await from(2)).status, 200, '같은 대역은 다시 세지 않음');
    const r = await from(5);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'account_suspended');
    const row = userRow(s.db, u.id);
    assert.equal(row.status, 'suspended');
    assert.equal(JSON.parse(row.settings).suspendedFrom, 'unverified');
    s.db.prepare('UPDATE users SET status_until=? WHERE id=?').run(now() - 1, u.id);
    runHourly(s.ctx);
    assert.equal(userRow(s.db, u.id).status, 'unverified', '정지가 풀리면 미인증 상태로 돌아가 72시간 잠금 규칙이 그대로 적용');
    assert.equal(JSON.parse(userRow(s.db, u.id).settings).suspendedFrom, undefined);
    // 코어 API(/api/me)만 돌려 써도 탐지(코어 훅 hooks.activity 로 기록)
    const mc = client(s.url, sessionFor(s.db, createUser(s.db).id));
    const me = (i) => mc.get('/api/me', { 'x-forwarded-for': `172.17.${i}.9` });
    for (let i = 1; i <= 4; i++) assert.equal((await me(i)).status, 200);
    assert.equal((await me(5)).body.error, 'account_suspended');

    // 매시간 작업도 최근 활동 기록으로 탐지
    const v = createUser(s.db);
    for (let i = 1; i <= 5; i++) s.db.prepare('INSERT INTO auth_activity (user_id, net, seen_at) VALUES (?,?,?)').run(v.id, `192.168.${i}`, now());
    runHourly(s.ctx);
    assert.equal(userRow(s.db, v.id).status, 'suspended');
    // 휴대폰만 있는 계정은 SMS 로 정지 안내(정지 중엔 사이트 알림을 못 봄)
    const w = createUser(s.db, { email: null, phone: '+821066667777' });
    for (let i = 1; i <= 5; i++) s.db.prepare('INSERT INTO auth_activity (user_id, net, seen_at) VALUES (?,?,?)').run(w.id, `192.169.${i}`, now());
    assert.equal(detectSharing(s.ctx, w.id), true);
    assert.match(s.db.prepare("SELECT body FROM outbox WHERE to_addr=? AND channel='sms'").get(w.phone).body, /24시간/);

    assert.equal(netOf('2001:db8::1'), netOf('2001:0db8:0:1::5'));
    assert.equal(netOf('2001:db8::1'), '2001:db8:0');
    assert.notEqual(netOf('2001:db8::1'), netOf('2001:db8:1::1'));
    assert.equal(netOf('::ffff:10.0.5.7'), '10.0.5');
  });

  await t.test('[H-05] 피드백 보내기 → 관리자 목록', async () => {
    const u = createUser(s.db);
    const uc = client(s.url, sessionFor(s.db, u.id));
    assert.equal((await uc.post('/api/auth/feedback', { category: 'nope', message: '안녕하세요 미믹' })).body.error, 'invalid_category');
    assert.equal((await uc.post('/api/auth/feedback', { category: 'feature', message: '자막 크기 조절이 있으면 좋겠어요', contact: 'me@test.local' })).status, 200);
    assert.equal((await uc.get('/api/admin/auth/feedback')).status, 403);
    const list = await adminC.get('/api/admin/auth/feedback');
    assert.equal(list.body.items[0].message, '자막 크기 조절이 있으면 좋겠어요');
    assert.equal(list.body.items[0].userId, u.id);
  });

  await t.test('[K-04] 지역 정책: 기본 +86 가입 차단, 관리자 규칙 추가·삭제, 다운로드 제한 조회', async () => {
    assert.equal((await c.post('/api/auth/phone/send-code', { phone: '+8613800000000' })).body.error, 'region_blocked');
    // 이미 가입된 +86 번호는 로그인 가능
    createUser(s.db, { phone: '+8613900000000' });
    assert.equal((await c.post('/api/auth/phone/send-code', { phone: '+8613900000000' })).status, 200);
    const userC = client(s.url, sessionFor(s.db, createUser(s.db).id));
    assert.equal((await userC.get('/api/admin/auth/region-rules')).status, 403);
    assert.ok((await adminC.get('/api/admin/auth/region-rules')).body.items.some((r) => r.countryCode === '+86' && r.blockSignup));
    assert.equal((await adminC.post('/api/admin/auth/region-rules', { countryCode: '86' })).body.error, 'invalid_country_code');
    // 실제로 없는 국가번호 접두어(+8)는 거절. 예전에 잘못 저장된 규칙이 있어도 +82 가입을 막지 않는다
    assert.equal((await adminC.post('/api/admin/auth/region-rules', { countryCode: '+8' })).body.error, 'invalid_country_code');
    s.db.prepare("INSERT INTO auth_region_rules (country_code, block_signup, created_at) VALUES ('+8', 1, 0)").run();
    assert.equal((await c.post('/api/auth/phone/send-code', { phone: '+821099998888' })).status, 200);
    s.db.prepare("DELETE FROM auth_region_rules WHERE country_code='+8'").run();
    assert.equal((await adminC.post('/api/admin/auth/region-rules', { countryCode: '+7' })).status, 200, '목록 밖 15개국도 실제 국가번호면 허용');
    assert.equal((await c.post('/api/auth/phone/send-code', { phone: '+79161234567' })).body.error, 'region_blocked');
    assert.equal((await adminC.post('/api/admin/auth/region-rules', { countryCode: '+44', blockSignup: true, blockDownload: true })).status, 200);
    assert.equal((await c.post('/api/auth/phone/send-code', { phone: '+447700900123' })).body.error, 'region_blocked');
    assert.equal(regionBlocked(s.db, { phone: '+447700900123' }, 'download'), true);
    assert.equal(regionBlocked(s.db, { region: 'GB' }, 'download'), true);
    assert.equal(regionBlocked(s.db, { region: 'KR' }, 'download'), false);
    // 휴대폰 없는 가입: 언어 태그는 표준 방식으로 지역을 채운다(zh-Hant-TW·zh-Hant → TW 라 +86 규칙에 안 걸림, zh → CN)
    const signupCode = (email, h) => c.post('/api/auth/email/send-code', { email, purpose: 'signup' }, h);
    assert.equal((await signupCode('tw@test.local', { 'accept-language': 'zh-Hant-TW,zh;q=0.9' })).status, 200);
    assert.equal((await signupCode('hant@test.local', { 'accept-language': 'zh-Hant' })).status, 200);
    assert.equal((await signupCode('cn@test.local', { 'accept-language': 'zh-CN' })).body.error, 'region_blocked');
    assert.equal((await signupCode('zh@test.local', { 'accept-language': 'zh' })).body.error, 'region_blocked');
    // 신뢰하는 프록시의 IP 국가 헤더(cfg.countryHeader)가 있으면 브라우저 언어보다 먼저 보고, 판정 근거를 감사 기록에 남긴다
    s.ctx.cfg.countryHeader = 'cf-ipcountry';
    try {
      assert.equal((await signupCode('ipcn@test.local', { 'accept-language': 'ko-KR', 'cf-ipcountry': 'CN' })).body.error, 'region_blocked');
      const kr = 'ipkr@test.local';
      const h = { 'accept-language': 'zh-CN', 'cf-ipcountry': 'KR' };
      assert.equal((await signupCode(kr, h)).status, 200);
      const r = await c.post('/api/auth/email/signup', { email: kr, code: lastCode(s.db, kr), password: 'ipkr12!', ...AGREE }, h);
      assert.equal(r.body.user.region, 'KR');
      assert.match(s.db.prepare("SELECT detail FROM audit_log WHERE user_id=? AND action='auth:signup'").get(r.body.user.id).detail, /"regionFrom":"ip"/);
      // 다운로드 제한은 지금 요청의 IP 국가도 본다(가입 지역 KR 이어도 다운로드 막힌 나라에서 접속하면 차단). 헤더가 없으면 저장된 지역만
      const fake = (hdr) => ({ app: s.app, get: (n) => hdr[n.toLowerCase()] });
      assert.equal(regionBlocked(s.db, { region: 'KR' }, 'download', fake({ 'cf-ipcountry': 'GB' })), true);
      assert.equal(regionBlocked(s.db, { region: 'KR' }, 'download', fake({ 'cf-ipcountry': 'KR' })), false);
      assert.equal(regionBlocked(s.db, { region: 'KR' }, 'download', fake({ 'accept-language': 'en-GB' })), false);
    } finally {
      delete s.ctx.cfg.countryHeader;
    }
    assert.equal((await adminC.del(`/api/admin/auth/region-rules/${encodeURIComponent('+86')}`)).status, 200);
    assert.equal((await c.post('/api/auth/phone/send-code', { phone: '+8613800000000' })).status, 200);
  });
});

test('[H-01] 소셜(실제 OAuth): Google OIDC·Facebook Graph·Apple(ES256 client secret) 코드 교환 — 로컬 모의 공급자', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let nonce = null;
  let appleSecretValid = null;
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, mockUrl);
    const sendJson = (status, o) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    // Facebook Graph: GET 토큰 교환 → GET /me
    if (url.pathname === '/fb/token') {
      const ok = url.searchParams.get('client_id') === 'fb-client' && url.searchParams.get('client_secret') === 'fb-secret' && url.searchParams.get('code') === 'fbcode';
      return ok ? sendJson(200, { access_token: 'fb-at', token_type: 'bearer' }) : sendJson(400, { error: { message: 'bad code' } });
    }
    if (url.pathname === '/fb/me') {
      if (url.searchParams.get('access_token') !== 'fb-at') return sendJson(401, { error: { message: 'bad token' } });
      return sendJson(200, { id: 'fb-1001', name: '페북 사용자', email: 'fbuser@test.local' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const q = new URLSearchParams(body);
    const apple = q.get('client_id') === 'apple-svc';
    if (apple) {
      const [h, p, sig] = q.get('client_secret').split('.');
      appleSecretValid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    } else if (q.get('client_secret') !== 'g-secret') return res.writeHead(401).end('{}');
    const claims = { iss: mockUrl, aud: q.get('client_id'), sub: apple ? 'apple-sub' : 'google-sub', email: apple ? 'relay@privaterelay.test' : 'g@test.local', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, nonce };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'at', id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig` }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const s = await startServer({
    oauth: {
      google: { clientId: 'g-client', clientSecret: 'g-secret', authUrl: `${mockUrl}/auth`, tokenUrl: `${mockUrl}/token`, issuer: [mockUrl] },
      apple: { clientId: 'apple-svc', teamId: 'TEAM1', keyId: 'KEY1', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), authUrl: `${mockUrl}/auth`, tokenUrl: `${mockUrl}/token`, issuer: [mockUrl] },
      facebook: { clientId: 'fb-client', clientSecret: 'fb-secret', authUrl: `${mockUrl}/auth`, tokenUrl: `${mockUrl}/fb/token`, profileUrl: `${mockUrl}/fb/me` },
    },
  });
  t.after(async () => {
    await s.close();
    mock.close();
  });
  const c = client(s.url);
  let bound = null; // 시작한 브라우저의 state 쿠키
  const startState = async (p) => {
    const r = await c.get(`/api/auth/oauth/${p}/start?${AGREE_Q}`);
    const u = new URL(r.headers.get('location'));
    assert.equal(u.origin + u.pathname, `${mockUrl}/auth`);
    nonce = u.searchParams.get('nonce');
    bound = oauthCookie(r);
    return u;
  };

  const g = await startState('google');
  assert.equal(g.searchParams.get('client_id'), 'g-client');
  assert.equal(g.searchParams.get('scope'), 'openid email profile');
  const cb = `/api/auth/oauth/google/callback?code=abc&state=${g.searchParams.get('state')}`;
  assert.equal((await c.get(cb)).headers.get('location'), '/login?error=oauth_state', '쿠키 없는 브라우저는 거절');
  const g1 = await startState('google');
  const done = await c.get(`/api/auth/oauth/google/callback?code=abc&state=${g1.searchParams.get('state')}`, bound);
  assert.equal(done.headers.get('location'), '/drive/all');
  assert.ok(cookieOf(done));
  assert.ok(s.db.prepare("SELECT 1 FROM identities WHERE provider='google' AND subject='google-sub'").get());

  // Facebook: Graph 토큰 교환 → /me 프로필. 이메일 인증 여부를 모르므로 새 계정으로 가입
  const f = await startState('facebook');
  assert.equal(f.searchParams.get('client_id'), 'fb-client');
  assert.equal(f.searchParams.get('nonce'), null);
  const fd = await c.get(`/api/auth/oauth/facebook/callback?code=fbcode&state=${f.searchParams.get('state')}`, bound);
  assert.equal(fd.headers.get('location'), '/drive/all');
  assert.ok(cookieOf(fd));
  const fu = s.db.prepare("SELECT u.* FROM users u JOIN identities i ON i.user_id=u.id WHERE i.provider='facebook' AND i.subject='fb-1001'").get();
  assert.equal(fu.name, '페북 사용자');
  assert.equal(fu.email, null, '인증 여부를 모르는 Facebook 이메일은 계정 이메일로 쓰지 않음');
  assert.equal(s.db.prepare("SELECT email FROM identities WHERE provider='facebook' AND subject='fb-1001'").get().email, 'fbuser@test.local');
  const fbad = await startState('facebook');
  assert.equal((await c.get(`/api/auth/oauth/facebook/callback?code=wrong&state=${fbad.searchParams.get('state')}`, bound)).headers.get('location'), '/login?error=oauth_failed');

  // Apple: form_post 는 같은 값으로 GET 에 다시 보내져(쿠키가 실리도록) 처리된다. 이메일은 주소에 싣지 않는다
  const a = await startState('apple');
  assert.equal(a.searchParams.get('response_mode'), 'form_post');
  const user = JSON.stringify({ name: { firstName: '사과', lastName: '김' }, email: 'relay@privaterelay.test' });
  const hop = await c.post('/api/auth/oauth/apple/callback', ...form({ code: 'xyz', state: a.searchParams.get('state'), user }));
  assert.equal(hop.status, 303);
  const next = hop.headers.get('location');
  assert.match(next, /^\/api\/auth\/oauth\/apple\/callback\?/);
  assert.doesNotMatch(decodeURIComponent(next), /privaterelay/);
  assert.equal((await c.get(next)).headers.get('location'), '/login?error=oauth_state', '쿠키 없이 GET 만 따라가면 거절');
  const a2 = await startState('apple');
  const hop2 = await c.post('/api/auth/oauth/apple/callback', ...form({ code: 'xyz', state: a2.searchParams.get('state'), user }));
  const ad = await c.get(hop2.headers.get('location'), bound);
  assert.equal(ad.headers.get('location'), '/drive/all');
  assert.equal(appleSecretValid, true, 'Apple client secret 은 ES256 으로 서명');
  const au = s.db.prepare("SELECT u.* FROM users u JOIN identities i ON i.user_id=u.id WHERE i.provider='apple'").get();
  assert.equal(au.email, 'relay@privaterelay.test');
  assert.equal(au.name, '사과 김');

  // nonce 가 다르면 거절
  const g2 = await startState('google');
  nonce = 'tampered';
  assert.equal((await c.get(`/api/auth/oauth/google/callback?code=abc&state=${g2.searchParams.get('state')}`, bound)).headers.get('location'), '/login?error=oauth_failed');
  // client secret 단독 확인
  const [h] = appleClientSecret({ clientId: 'x', teamId: 't', keyId: 'k', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'ES256');
});

test('[H-01] 운영 모드에서 소셜 키가 없으면 503, 개발용 화면은 열리지 않음', async (t) => {
  const s = await startServer({ dev: false, oauth: NO_OAUTH });
  t.after(() => s.close());
  const c = client(s.url);
  const r = await c.get(`/api/auth/oauth/google/start?${AGREE_Q}`);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'oauth_not_configured');
  assert.equal((await c.get('/api/auth/oauth/google/dev?state=abcdefghijkl')).status, 404);
});
