// 추천 보상 Pro(I-05): 스스로 전환(되돌릴 수 없음) → 친구 결제 금액의 일정 비율을 현금으로, 환불·부정 판정 회수, 출금 요청·관리자 처리
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { now, DAY } from '../server/core/util.js';
import { createOrder, applyOrder, bindInvite, upgradeSchema, proBalance } from '../server/modules/billing/index.js';

test('referral-pro: 추천 보상 Pro 현금 보상·출금', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { db, ctx } = s;
  const as = (u) => client(s.url, sessionFor(db, u.id));
  const user = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const A = as(createUser(db, { admin: true }));
  const bal = (u, cur = 'KRW') => proBalance(db, u.id, cur).available;
  const friendOf = (inviter, region = null) => {
    const f = createUser(db);
    if (region) db.prepare('UPDATE users SET region=? WHERE id=?').run(region, f.id);
    bindInvite(ctx, f.id, inviter.invite_code);
    return user(f.id);
  };
  const buy = (f, productId = 'once_month') => applyOrder(ctx, createOrder(ctx, user(f.id), productId, 'card'));
  const titles = (u) => db.prepare('SELECT title, title_en FROM notifications WHERE user_id=? ORDER BY rowid').all(u.id);

  await t.test('[I-05] 스스로 전환(확인 필요·한 번만), 전환 전 구매는 일수, 전환 뒤 구매는 결제 금액 20% 현금(통화별)', async () => {
    const inviter = createUser(db);
    const c = as(inviter);
    const before = (await c.get('/api/billing/invite/pro')).body;
    assert.equal(before.pro, false);
    assert.equal(before.cashPercent, 20);
    assert.deepEqual(before.minWithdraw, { KRW: 10000, USD: 1000 });
    const a = friendOf(inviter);
    buy(a); // 전환 전: 30일 × 35% = 11일
    assert.ok(user(inviter.id).premium_until > now() + 10 * DAY);
    const until = user(inviter.id).premium_until;

    assert.equal((await c.post('/api/billing/invite/pro/upgrade', {})).status, 400); // 확인 없이 전환 불가
    assert.equal((await c.post('/api/billing/invite/pro/upgrade', { confirm: true })).status, 200);
    assert.equal((await c.post('/api/billing/invite/pro/upgrade', { confirm: true })).status, 409);
    assert.equal((await c.get('/api/billing/invite/pro')).body.pro, true);

    const o = buy(a); // ₩10,120 × 20% = ₩2,024, 일수는 그대로
    assert.equal(o.amount, 10120);
    assert.equal(user(inviter.id).premium_until, until);
    assert.equal(bal(inviter), 2024);
    assert.ok(titles(inviter).some((n) => n.title === '초대 보상 ₩2,024이 적립되었습니다' && n.title_en === 'You earned ₩2,024 as an invite reward'));
    // 해외(달러) 친구: 결제 통화로 적립(첫 월 구독 ₩6,254 ÷ 1450 = $4.31 → 20% = 86센트)
    const us = friendOf(inviter, 'US');
    const uo = buy(us, 'sub_month');
    assert.equal(uo.currency, 'USD');
    assert.equal(uo.amount, 431);
    assert.equal(bal(inviter, 'USD'), 86);
    assert.equal(bal(inviter), 2024);
    const pro = (await c.get('/api/billing/invite/pro')).body;
    assert.deepEqual(pro.balances.map((b) => [b.currency, b.available]), [['KRW', 2024], ['USD', 86]]);
    assert.equal(pro.ledger.length, 2);
    const rec = (await c.get('/api/billing/invite')).body.records.find((r) => r.rewardCash === 86);
    assert.equal(rec.cashCurrency, 'USD');

    // 친구가 탈퇴해 보상 행이 지워져도 이미 받은 현금은 남는다
    db.prepare('DELETE FROM users WHERE id=?').run(us.id);
    assert.equal(bal(inviter, 'USD'), 86);

    // 환불하면 그 결제로 받은 현금을 거둔다
    assert.equal((await A.post(`/api/admin/billing/orders/${o.id}/refund`, {})).status, 200);
    assert.equal(bal(inviter), 0);
    assert.ok(titles(inviter).some((n) => n.title === '초대 보상 ₩2,024이 회수되었습니다'));
  });

  await t.test('[I-05] 관리자 설정: 현금 비율·출금 최소 금액, 같은 기기 의심이면 보류 → 지급·회수', async () => {
    assert.equal((await A.post('/api/admin/billing/referral-pro', { cashPercent: 101 })).status, 400);
    assert.equal((await A.post('/api/admin/billing/referral-pro', { minWithdraw: { KRW: 0 } })).status, 400);
    const set = await A.post('/api/admin/billing/referral-pro', { cashPercent: 30, minWithdraw: { KRW: 2000 } });
    assert.equal(set.status, 200);
    assert.deepEqual((await A.get('/api/admin/billing/referral-pro')).body.minWithdraw, { KRW: 2000, USD: 1000 });

    const inviter = createUser(db);
    await as(inviter).post('/api/billing/invite/pro/upgrade', { confirm: true });
    const f = friendOf(inviter);
    db.prepare('UPDATE billing_invites SET suspicious=1 WHERE invitee_id=?').run(f.id);
    buy(f); // ₩10,120 × 30% = ₩3,036 보류
    assert.equal(bal(inviter), 0);
    const r = await A.post(`/api/admin/billing/invites/${f.id}`, { action: 'release' });
    assert.deepEqual([r.body.rewardDays, r.body.rewardCash], [0, { KRW: 3036 }]);
    assert.equal(bal(inviter), 3036);
    assert.ok(titles(inviter).some((n) => n.title === '보류됐던 초대 보상 ₩3,036을 받았습니다'));
    assert.equal((await A.get('/api/admin/billing/invites')).body.items.find((x) => x.inviteeId === f.id).rewardCash, 3036);
    await A.post(`/api/admin/billing/invites/${f.id}`, { action: 'revoke' });
    assert.equal(bal(inviter), 0);
    assert.ok(titles(inviter).some((n) => n.title === '초대 보상 ₩3,036이 회수되었습니다'));
    buy(f); // 부정 판정 뒤 구매는 보상 없음
    assert.equal(bal(inviter), 0);
    await A.post('/api/admin/billing/referral-pro', { cashPercent: 20, minWithdraw: { KRW: 10000 } });
  });

  await t.test('[I-05] 출금 요청(최소 금액·잔액·받을 곳), 관리자 보냄·반려(메모 알림·이메일, 반려하면 잔액 복구)', async () => {
    const inviter = createUser(db, { email: 'pro@test.local' });
    const c = as(inviter);
    const req = (body) => c.post('/api/billing/invite/pro/withdrawals', body);
    assert.equal((await req({ currency: 'KRW', payout: 'x' })).status, 403); // Pro 아님
    await c.post('/api/billing/invite/pro/upgrade', { confirm: true });
    for (let i = 0; i < 3; i++) buy(friendOf(inviter)); // ₩2,024 × 3 = ₩6,072
    assert.equal((await req({ currency: 'KRW', payout: 'paypal@me.test' })).status, 400); // 최소 ₩10,000 미만
    for (let i = 0; i < 2; i++) buy(friendOf(inviter)); // ₩10,120
    assert.equal(bal(inviter), 10120);
    assert.equal((await req({ currency: 'EUR', payout: 'x' })).status, 400);
    assert.equal((await req({ currency: 'KRW', payout: '  ' })).status, 400);
    assert.equal((await req({ currency: 'KRW', amount: 20000, payout: 'x' })).status, 409);
    const w1 = await req({ currency: 'KRW', payout: '국민은행 123-456 홍길동' }); // 금액을 빼면 전액
    assert.equal(w1.status, 200);
    assert.equal(w1.body.withdrawal.amount, 10120);
    assert.equal(bal(inviter), 0);
    assert.equal((await req({ currency: 'KRW', amount: 10000, payout: 'x' })).status, 409); // 대기 중 출금만큼 잔액이 줄었다
    assert.equal((await A.get('/api/admin/billing/stats')).body.withdrawalsPending, 1);
    const list = (await A.get('/api/admin/billing/withdrawals?status=pending')).body.items;
    const item = list.find((x) => x.id === w1.body.withdrawal.id);
    assert.equal(item.payout, '국민은행 123-456 홍길동');
    assert.equal(item.user, 'pro@test.local');

    assert.equal((await A.post(`/api/admin/billing/withdrawals/${item.id}`, { status: 'done' })).status, 400);
    assert.equal((await A.post(`/api/admin/billing/withdrawals/${item.id}`, { status: 'rejected', note: '예금주 확인 불가' })).status, 200);
    assert.equal((await A.post(`/api/admin/billing/withdrawals/${item.id}`, { status: 'paid' })).status, 409);
    assert.equal(bal(inviter), 10120);
    assert.ok(titles(inviter).some((n) => n.title === '출금 요청 ₩10,120이 반려되었습니다'));
    const mail = db.prepare("SELECT * FROM outbox WHERE to_addr='pro@test.local' AND channel='email' ORDER BY rowid DESC LIMIT 1").get();
    assert.match(mail.body, /예금주 확인 불가/);

    const w2 = await req({ currency: 'KRW', amount: 10000, payout: 'paypal@me.test' });
    assert.equal((await A.post(`/api/admin/billing/withdrawals/${w2.body.withdrawal.id}`, { status: 'paid', note: '송금 완료' })).status, 200);
    const pro = (await c.get('/api/billing/invite/pro')).body;
    assert.deepEqual(pro.balances[0], { currency: 'KRW', earned: 10120, pending: 0, paid: 10000, available: 120 });
    assert.deepEqual(pro.withdrawals.map((w) => w.status), ['paid', 'rejected']);
    assert.ok(titles(inviter).some((n) => n.title === '출금 ₩10,000을 보냈습니다' && n.title_en === 'Your ₩10,000 withdrawal was sent'));
  });

  await t.test('[I-05] 출금 요청 뒤 친구 결제가 환불되면 잔액이 음수 → 관리자 목록에 표시, 보냄은 막고 반려만', async () => {
    const inviter = createUser(db);
    await as(inviter).post('/api/billing/invite/pro/upgrade', { confirm: true });
    const orders = [];
    for (let i = 0; i < 5; i++) orders.push(buy(friendOf(inviter))); // ₩2,024 × 5 = ₩10,120
    const w = (await as(inviter).post('/api/billing/invite/pro/withdrawals', { currency: 'KRW', payout: 'paypal@me.test' })).body.withdrawal;
    assert.equal((await A.post(`/api/admin/billing/orders/${orders[0].id}/refund`, {})).status, 200);
    assert.equal(bal(inviter), -2024);
    const item = (await A.get('/api/admin/billing/withdrawals?status=pending')).body.items.find((x) => x.id === w.id);
    assert.equal(item.available, -2024);
    const r = await A.post(`/api/admin/billing/withdrawals/${w.id}`, { status: 'paid' });
    assert.deepEqual([r.status, r.body.error], [409, 'balance_negative']);
    assert.equal((await A.post(`/api/admin/billing/withdrawals/${w.id}`, { status: 'rejected' })).status, 200);
    assert.equal(bal(inviter), 8096);
    assert.equal((await A.get('/api/admin/billing/withdrawals?status=rejected')).body.items.find((x) => x.id === w.id).available, null);
  });

  await t.test('[I-05] 예전 Pro 신청: 승인된 신청자는 Pro 로 옮기고, 대기 중이던 사람은 스스로 전환한다', async () => {
    const approved = createUser(db);
    const pending = createUser(db);
    const ins = db.prepare('INSERT INTO billing_pro_applications (id, user_id, channel, audience, contact, status, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?)');
    ins.run(`pa_${approved.id}`, approved.id, 'yt', '1만', 'a@x', 'approved', now() - DAY, now());
    ins.run(`pp_${pending.id}`, pending.id, 'blog', '1천', 'b@x', 'pending', now(), null);
    upgradeSchema(db, ctx.cfg);
    upgradeSchema(db, ctx.cfg); // 여러 번 켜져도 같다
    assert.equal((await as(approved).get('/api/billing/invite/pro')).body.pro, true);
    assert.equal((await as(pending).get('/api/billing/invite/pro')).body.pro, false);
    assert.equal((await as(pending).post('/api/billing/invite/pro/upgrade', { confirm: true })).status, 200);
    // 관리자 승인 API 는 없어졌다
    assert.equal((await A.get('/api/admin/billing/pro-applications')).status, 404);
  });
});
