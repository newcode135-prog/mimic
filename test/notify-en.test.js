// K-03 영어 알림(사이트 알림·이메일)과 K-04 클라우드 다운로드의 요청 IP 국가 확인
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { now, periodKeys, DAY } from '../server/core/util.js';
import { runRenewals } from '../server/modules/billing/index.js';

const BT_OPTS = { dht: false, lsd: false, natUpnp: false, natPmp: false, utPex: false };

async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('K-03·K-04: 영어 사용자 알림과 다운로드 지역 확인', async (t) => {
  const s = await startServer({ bt: BT_OPTS, ytDlp: null, countryHeader: 'cf-ipcountry' });
  // 외부 인터넷 대신 쓰는 로컬 파일 서버
  const files = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(2048, 7)));
  files.listen(0, '127.0.0.1');
  await once(files, 'listening');
  const fileUrl = (p) => `http://127.0.0.1:${files.address().port}/${p}.bin`;
  t.after(async () => {
    files.closeAllConnections();
    files.close();
    await s.close();
  });
  const db = s.db;
  const en = createUser(db, { premium: true, email: 'en-user@test.local' });
  db.prepare("UPDATE users SET lang='en' WHERE id=?").run(en.id);
  const api = client(s.url, sessionFor(db, en.id));
  const lastMail = (to) => db.prepare("SELECT * FROM outbox WHERE to_addr=? AND channel='email' ORDER BY rowid DESC LIMIT 1").get(to);
  const titles = async () => (await api.get('/api/notifications?limit=100')).body.items.map((n) => n.title);

  await t.test('[K-04] 다운로드를 막은 나라의 IP 로 들어온 요청은 새 클라우드 다운로드를 만들 수 없다', async () => {
    db.prepare("INSERT INTO auth_region_rules (country_code, block_signup, block_download, created_at) VALUES ('+44', 1, 1, 0)").run();
    const blocked = await api.post('/api/offline/tasks', { urls: [fileUrl('gb')] }, { 'cf-ipcountry': 'GB' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'region_blocked');
    const ok = await api.post('/api/offline/tasks', { urls: [fileUrl('kr')] }, { 'cf-ipcountry': 'KR' });
    assert.equal(ok.status, 201);
    const id = ok.body.tasks[0].id;
    const task = await waitFor(async () => {
      const r = (await api.get(`/api/offline/tasks/${id}`)).body.task;
      return ['done', 'error'].includes(r?.status) && r;
    });
    assert.equal(task.status, 'done', task.error);
  });

  await t.test('[K-03] 영어 사용자는 접근 키·출석 보상·다운로드 완료 알림을 영어로 받는다', async () => {
    assert.equal((await api.post('/api/integrations/tokens', { name: 'ci', scopes: ['files:read'] })).status, 201);
    // 어제까지 6일 연속 → 오늘 7일째 출석 보상
    db.prepare('INSERT INTO billing_checkins (user_id, day, streak, reward_days, created_at) VALUES (?,?,?,?,?)').run(en.id, periodKeys(now() - DAY).day, 6, 0, now() - DAY);
    const c = await api.post('/api/billing/checkin');
    assert.equal(c.status, 200);
    assert.equal(c.body.rewarded, 1);
    const list = (await api.get('/api/notifications?limit=100')).body.items;
    const got = list.map((n) => n.title);
    assert.ok(got.includes('A new access key was created'), got.join(' | '));
    assert.ok(got.includes('7-day check-in streak! You received 1 day of Premium'), got.join(' | '));
    assert.ok(got.includes('Cloud download complete'), got.join(' | '));
    assert.match(list.find((n) => n.kind === 'token').body, /^A new access key "ci" was created/);
    // 이메일도 영어
    const mail = lastMail(en.email);
    assert.equal(mail.subject, '[Mimic] A new access key was created');
    assert.match(mail.body, /Settings > Access & integrations/);
  });

  await t.test('[K-03] 결제 안내(이메일 포함)도 계정 언어를 따른다', async () => {
    db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(now() + 3 * DAY, en.id);
    const ko = createUser(db, { premium: true });
    db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(now() + 3 * DAY, ko.id);
    await runRenewals(s.ctx);
    assert.ok((await titles()).some((x) => /^Your Premium ends on \d{4}-\d{2}-\d{2}$/.test(x)));
    assert.match(lastMail(en.email).subject, /^\[Mimic\] Your Premium ends on /);
    assert.match(lastMail(ko.email).subject, /^\[미믹\] 프리미엄이 .*에 끝납니다$/);
    const koTitles = (await client(s.url, sessionFor(db, ko.id)).get('/api/notifications')).body.items.map((n) => n.title);
    assert.ok(koTitles.some((x) => /^프리미엄이 .*에 끝납니다$/.test(x)));
  });

  await t.test('[K-03] 가입 전 인증코드는 브라우저 언어(Accept-Language)를 따른다', async () => {
    const c = client(s.url);
    assert.equal((await c.post('/api/auth/email/send-code', { email: 'new-en@test.local', purpose: 'signup' }, { 'accept-language': 'en-US,en;q=0.9' })).status, 200);
    const m = lastMail('new-en@test.local');
    assert.equal(m.subject, '[Mimic] Your verification code');
    assert.match(m.body, /^Your Mimic verification code is \d{6}\./);
    assert.equal((await c.post('/api/auth/email/send-code', { email: 'new-ko@test.local', purpose: 'signup' }, { 'accept-language': 'ko-KR' })).status, 200);
    assert.equal(lastMail('new-ko@test.local').subject, '[미믹] 인증코드 안내');
    // 화면 언어(x-mimic-lang)가 브라우저 언어보다 먼저
    assert.equal((await c.post('/api/auth/email/send-code', { email: 'ui-en@test.local', purpose: 'signup' }, { 'x-mimic-lang': 'en', 'accept-language': 'ko-KR' })).status, 200);
    assert.equal(lastMail('ui-en@test.local').subject, '[Mimic] Your verification code');
    // 가입된 계정이면 브라우저 언어보다 계정 언어(비밀번호 재설정)
    assert.equal((await c.post('/api/auth/email/send-code', { email: en.email, purpose: 'reset' }, { 'accept-language': 'ko-KR' })).status, 200);
    assert.equal(lastMail(en.email).subject, '[Mimic] Your verification code');
  });
});
