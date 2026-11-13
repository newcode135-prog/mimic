// Q-5: 데이터 디스크 경보와 새 가입 멈춤. statfs 를 cfg 로 바꿔 끼워 사용률을 마음대로 정한다
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { checkDisk, jobs } from '../server/modules/admin/index.js';
import { DAY } from '../server/core/util.js';

test('[Q-5] 디스크 경보·가입 멈춤·자동 재개·수동 설정', async (t) => {
  let used = 50; // 사용률(%)
  const s = await startServer({ statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 1000 - used * 10 }) });
  t.after(() => s.close());
  const check = (pct) => {
    used = pct;
    return checkDisk(s.ctx);
  };
  const admin = createUser(s.db, { admin: true, email: 'boss@test.local' });
  const adminEn = createUser(s.db, { admin: true, email: 'boss-en@test.local' });
  s.db.prepare("UPDATE users SET lang='en' WHERE id=?").run(adminEn.id);
  const member = createUser(s.db, { email: 'member@test.local', password: 'abc123!@' });
  const A = client(s.url, sessionFor(s.db, admin.id));
  const M = client(s.url, sessionFor(s.db, member.id));
  const anon = client(s.url);
  const alerts = (u) => s.db.prepare("SELECT * FROM notifications WHERE user_id=? AND kind='admin' ORDER BY created_at, rowid").all(u.id);
  const mails = (to) => s.db.prepare("SELECT * FROM outbox WHERE channel='email' AND to_addr=? ORDER BY created_at, rowid").all(to);
  let n = 0;
  const signupCode = (h) => anon.post('/api/auth/email/send-code', { purpose: 'signup', email: `new${++n}@test.local` }, h);

  assert.ok(jobs.some((j) => j.name === 'admin:disk' && j.everyMs === 10 * 60_000), '10분마다 도는 작업');

  // 50%: 정상, 경보 없음
  let st = check(50);
  assert.equal(st.pct, 50);
  assert.equal(st.signupPaused, false);
  assert.equal(st.totalBytes, 4096 * 1000);
  assert.equal(alerts(admin).length, 0);
  assert.equal((await signupCode()).status, 200);

  // 82%: 관리자 모두에게 사이트 알림 + 이메일, 새 가입 멈춤
  st = check(82);
  assert.equal(st.signupPaused, true);
  assert.equal(alerts(admin).length, 1);
  assert.match(alerts(admin)[0].title, /82%/);
  assert.ok(alerts(admin)[0].title_en && alerts(admin)[0].body_en, '영어 알림도 함께');
  assert.equal(alerts(adminEn).length, 1);
  assert.equal(alerts(member).length, 0, '일반 회원에게는 보내지 않는다');
  assert.equal(mails('boss@test.local').length, 1);
  assert.match(mails('boss@test.local')[0].subject, /^\[미믹\]/);
  assert.match(mails('boss-en@test.local')[0].subject, /^\[Mimic\] Data disk 82% full/);

  // 가입 API 는 503 signup_paused(한국어·영어 안내), 기존 회원은 그대로
  let r = await signupCode();
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'signup_paused');
  assert.match(r.body.message, /새 가입/);
  r = await signupCode({ 'x-mimic-lang': 'en' });
  assert.equal(r.status, 503);
  assert.match(r.body.message, /sign-ups are temporarily paused/i);
  r = await anon.post('/api/auth/phone/send-code', { phone: '+821099990001' });
  assert.equal(r.status, 503, '처음 보는 번호(새 가입)는 막는다');
  assert.equal((await anon.post('/api/auth/email/login', { email: 'member@test.local', password: 'abc123!@' })).status, 200, '기존 회원 로그인은 된다');
  assert.equal((await M.get('/api/me')).status, 200);

  // 같은 단계 경보는 24시간에 한 번
  check(85);
  assert.equal(alerts(admin).length, 1);
  assert.equal(mails('boss@test.local').length, 1);

  // 90% 이상: 긴급 경보(한 번)
  check(91);
  check(92);
  assert.equal(alerts(admin).length, 2);
  assert.match(alerts(admin)[1].title, /긴급/);
  assert.match(alerts(adminEn)[1].title_en, /Urgent/);
  assert.equal(mails('boss@test.local').length, 2);

  // 24시간이 지나면 같은 단계도 다시 알린다
  const d = JSON.parse(s.db.prepare("SELECT v FROM admin_meta WHERE k='disk'").get().v);
  d.alerts.urgent -= DAY;
  s.db.prepare("UPDATE admin_meta SET v=? WHERE k='disk'").run(JSON.stringify(d));
  check(93);
  assert.equal(alerts(admin).length, 3);

  // 75~80% 사이는 그대로 멈춤, 75% 미만이면 자동으로 다시 열고 관리자에게 알린다
  assert.equal(check(78).signupPaused, true);
  assert.equal((await signupCode()).status, 503);
  st = check(74);
  assert.equal(st.signupPaused, false);
  assert.match(alerts(admin).at(-1).title, /다시 열었어요/);
  assert.equal(alerts(admin).length, 4);
  assert.equal((await signupCode()).status, 200);

  // 인증코드를 받은 뒤 멈춰도 가입은 막히고, 받은 코드는 쓰이지 않은 채 남는다(다시 열리면 그 코드로 가입)
  const phone = '+821099990002';
  const late = 'late@test.local';
  const agree = { agreeAge14: true, agreeTerms: true, agreePrivacy: true };
  const lastCode = (to) => /(\d{6})/.exec(s.db.prepare('SELECT body FROM outbox WHERE to_addr=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(to).body)[1];
  const unused = (to) => s.db.prepare('SELECT used_at FROM auth_codes WHERE target=? ORDER BY rowid DESC LIMIT 1').get(to).used_at === null;
  assert.equal((await anon.post('/api/auth/phone/send-code', { phone })).status, 200);
  assert.equal((await anon.post('/api/auth/email/send-code', { purpose: 'signup', email: late })).status, 200);
  const code = lastCode(phone);
  const lateCode = lastCode(late);
  check(81);
  r = await anon.post('/api/auth/phone/verify', { phone, code, ...agree });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'signup_paused');
  assert.equal(s.db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone), undefined);
  r = await anon.post('/api/auth/email/signup', { email: late, code: lateCode, password: 'abc123!@', ...agree });
  assert.equal(r.status, 503);
  assert.ok(unused(phone) && unused(late), '멈춘 동안 받은 코드는 소모되지 않는다');

  // 관리자 대시보드: 상태 표시, 수동 설정(멈춤·허용·자동), 감사 로그
  r = await A.get('/api/admin/stats');
  assert.equal(r.body.disk.pct, 81);
  assert.equal(r.body.disk.signupPaused, true);
  assert.equal(r.body.disk.mode, 'auto');
  assert.equal(r.body.disk.alertPct, 80);
  assert.equal(r.body.disk.resumePct, 75);
  r = await A.post('/api/admin/disk', { mode: 'resume' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'resume');
  assert.equal(r.body.signupPaused, false, '관리자가 열면 디스크가 차 있어도 가입 가능');
  assert.equal((await signupCode()).status, 200);
  r = await anon.post('/api/auth/phone/verify', { phone, code, ...agree });
  assert.equal(r.status, 200, '멈추기 전에 받은 코드로 가입');
  assert.equal(r.body.created, true);
  assert.equal((await anon.post('/api/auth/email/signup', { email: late, code: lateCode, password: 'abc123!@', ...agree })).status, 200);
  used = 30;
  r = await A.post('/api/admin/disk', { mode: 'pause' });
  assert.equal(r.body.pct, 30, '설정을 바꿀 때 디스크도 다시 확인한다');
  assert.equal(r.body.signupPaused, true, '관리자가 멈추면 디스크가 비어 있어도 멈춘다');
  assert.equal((await signupCode()).status, 503);
  r = await A.post('/api/admin/disk', { mode: 'auto' });
  assert.equal(r.body.signupPaused, false);
  assert.equal((await A.post('/api/admin/disk', { mode: 'off' })).status, 400);
  assert.equal((await M.post('/api/admin/disk', { mode: 'pause' })).status, 403, '일반 회원은 못 바꾼다');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='admin.disk.mode'").get().n, 3);
});

test('[Q-5] 경보·재개 기준은 MIMIC_DISK_ALERT_PCT·MIMIC_DISK_RESUME_PCT 로 바꾼다', async (t) => {
  let used = 0;
  const s = await startServer({ statfs: () => ({ bsize: 1, blocks: 100, bavail: 100 - used }) });
  const old = [process.env.MIMIC_DISK_ALERT_PCT, process.env.MIMIC_DISK_RESUME_PCT];
  process.env.MIMIC_DISK_ALERT_PCT = '60';
  process.env.MIMIC_DISK_RESUME_PCT = '50';
  t.after(async () => {
    [process.env.MIMIC_DISK_ALERT_PCT, process.env.MIMIC_DISK_RESUME_PCT] = old;
    if (old[0] === undefined) delete process.env.MIMIC_DISK_ALERT_PCT;
    if (old[1] === undefined) delete process.env.MIMIC_DISK_RESUME_PCT;
    await s.close();
  });
  const check = (pct) => {
    used = pct;
    return checkDisk(s.ctx);
  };
  assert.equal(check(59).signupPaused, false);
  const st = check(61);
  assert.equal(st.signupPaused, true);
  assert.deepEqual([st.alertPct, st.resumePct, st.urgentPct], [60, 50, 90]);
  assert.equal(check(55).signupPaused, true);
  assert.equal(check(49).signupPaused, false);
});
