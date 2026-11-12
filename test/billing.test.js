import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { createToken } from '../server/core/auth.js';
import { createFileNode, usage } from '../server/core/files.js';
import { addUsage, checkTransfer, consumeCloudTask, monthlyLimit, grant } from '../server/core/quota.js';
import { GB, TB, LIMITS, capacityOf, isPremium } from '../server/core/plans.js';
import { periodKeys, now, DAY, json } from '../server/core/util.js';
import { runRenewals, runExpiry, createOrder, applyOrder, bindInvite, checkin, monthStart, carryInviteBonus, purgeOrderArchive } from '../server/modules/billing/index.js';

test('billing: 결제·혜택·쿼터', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const db = s.db;
  const ctx = s.ctx;
  const as = (u) => client(s.url, sessionFor(db, u.id));
  const user = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const admin = createUser(db, { admin: true });
  const A = as(admin);
  const buy = async (c, productId, result = 'success', method = 'card') => {
    const o = await c.post('/api/billing/orders', { productId, method });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const r = await c.post(`/api/billing/orders/${o.body.orderId}/confirm`, { result });
    return { order: o.body, confirm: r };
  };

  await t.test('[I-01] 상품 4종·첫 구독 할인·비교표는 로그인 없이 조회', async () => {
    const r = await client(s.url).get('/api/billing/products');
    assert.equal(r.status, 200);
    assert.equal(r.body.testMode, true);
    assert.equal(r.body.available, true);
    assert.deepEqual(r.body.methods, ['card', 'paypal', 'alipay', 'unionpay']); // 암호화폐 보류(8-4)
    const m = r.body.products.find((p) => p.id === 'sub_month');
    assert.equal(m.firstDiscount, true);
    assert.equal(m.payNow, 6256);
    assert.equal(m.price, 9591);
    assert.equal(r.body.products.find((p) => p.id === 'sub_year').payNow, 62417);
    assert.equal(r.body.products.find((p) => p.id === 'once_month').payNow, 10125);
    assert.equal(r.body.products.find((p) => p.id === 'once_year').payNow, 69354);
    assert.equal(r.body.compare.premium.length, 10);
    assert.equal(r.body.compare.tier.length, 4);
    const reg = createUser(db, { tier: 'regional' });
    assert.equal((await as(reg).get('/api/billing/products')).body.products.find((p) => p.id === 'sub_month').payNow, 3100);
  });

  await t.test('[I-01] 테스트 결제로 구독 → 프리미엄·자동 갱신, 실패 결제는 반영 안 됨', async () => {
    const u = createUser(db);
    const c = as(u);
    assert.equal((await client(s.url).post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).status, 401);
    assert.equal((await c.post('/api/billing/orders', { productId: 'nope', method: 'card' })).status, 400);
    assert.equal((await c.post('/api/billing/orders', { productId: 'sub_month', method: 'cash' })).status, 400);
    const failed = await buy(c, 'sub_month', 'fail');
    assert.equal(failed.confirm.body.status, 'failed');
    assert.equal(isPremium(user(u.id)), false);
    const ok = await buy(c, 'sub_month');
    assert.equal(ok.order.amount, 6256);
    assert.equal(ok.confirm.body.status, 'paid');
    assert.equal(isPremium(user(u.id)), true);
    assert.equal((await c.post(`/api/billing/orders/${ok.order.orderId}/confirm`, { result: 'success' })).status, 409);
    const subs = (await c.get('/api/billing/subscriptions')).body.items;
    assert.equal(subs.length, 1);
    assert.equal(subs[0].autoRenew, true);
    assert.equal(subs[0].nextChargeAt, user(u.id).premium_until);
    assert.equal((await c.post('/api/billing/orders', { productId: 'sub_year', method: 'card' })).status, 409);
    // 다른 사용자의 주문·구독에는 접근할 수 없다
    const other = as(createUser(db));
    assert.equal((await other.post(`/api/billing/subscriptions/${subs[0].id}/cancel`)).status, 404);
    assert.equal((await other.post(`/api/billing/orders/${ok.order.orderId}/refund-request`, { reason: 'x' })).status, 404);
    // 해지 = 자동 갱신만 끔, 기간은 유지. 다시 켜기 가능
    assert.equal((await c.post(`/api/billing/subscriptions/${subs[0].id}/cancel`)).body.subscription.autoRenew, false);
    assert.equal(isPremium(user(u.id)), true);
    assert.equal((await c.post(`/api/billing/subscriptions/${subs[0].id}/resume`)).body.subscription.autoRenew, true);
    const orders = (await c.get('/api/billing/orders')).body.items;
    assert.deepEqual(orders.map((o) => o.status).sort(), ['failed', 'paid']);
    // 같은 상품을 한 번 구독했으면 재구독은 정가
    assert.equal((await c.get('/api/billing/products')).body.products.find((p) => p.id === 'sub_month').firstDiscount, false);
  });

  await t.test('[I-01] 대기 주문 여러 개를 한꺼번에 확정해도 자동 갱신 구독은 하나, 첫 할인은 한 번', async () => {
    const u = createUser(db);
    const c = as(u);
    const mk = async (productId) => (await c.post('/api/billing/orders', { productId, method: 'card' })).body.orderId;
    const ids = [await mk('sub_month'), await mk('sub_month'), await mk('sub_year')];
    const res = [];
    for (const id of ids) res.push(await c.post(`/api/billing/orders/${id}/confirm`, { result: 'success' }));
    assert.deepEqual(res.map((r) => r.status), [200, 409, 409]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE user_id=? AND status='active' AND auto_renew=1").get(u.id).n, 1);
    assert.deepEqual(db.prepare('SELECT status FROM billing_orders WHERE user_id=?').all(u.id).map((o) => o.status).sort(), ['failed', 'failed', 'paid']);
    // 자동 갱신을 꺼도, 첫 구독 할인이 붙은 두 번째 대기 주문은 확정되지 않는다
    const v = createUser(db);
    const cv = as(v);
    const a1 = (await cv.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body;
    const a2 = (await cv.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body;
    assert.equal(a2.amount, 6256);
    await cv.post(`/api/billing/orders/${a1.orderId}/confirm`, { result: 'success' });
    const sub = db.prepare('SELECT id FROM billing_subscriptions WHERE user_id=?').get(v.id);
    await cv.post(`/api/billing/subscriptions/${sub.id}/cancel`);
    assert.equal((await cv.post(`/api/billing/orders/${a2.orderId}/confirm`, { result: 'success' })).status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_orders WHERE user_id=? AND status='paid' AND first_discount=1").get(v.id).n, 1);
    assert.equal((await cv.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body.amount, 9591); // 다시 주문하면 정가
  });

  await t.test('[I-01] 갱신 7일 전 안내·정가 자동 결제·해지하면 기간 끝에 종료', async () => {
    const u = createUser(db);
    const c = as(u);
    await buy(c, 'sub_month');
    let sub = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get(u.id);
    await runRenewals(ctx, sub.next_charge_at - 6 * DAY);
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE '%자동 갱신됩니다%'").get(u.id));
    assert.ok(db.prepare("SELECT 1 FROM outbox WHERE to_addr=? AND subject LIKE '%자동 갱신%'").get(u.email));
    const before = sub.next_charge_at;
    await runRenewals(ctx, before + 1000);
    const renewal = db.prepare('SELECT * FROM billing_orders WHERE user_id=? AND renewal=1').get(u.id);
    assert.equal(renewal.amount, 9591);
    assert.equal(renewal.status, 'paid');
    sub = db.prepare('SELECT * FROM billing_subscriptions WHERE id=?').get(sub.id);
    assert.ok(sub.next_charge_at >= before + 30 * DAY);
    await c.post(`/api/billing/subscriptions/${sub.id}/cancel`);
    await runRenewals(ctx, sub.current_period_end + 1000);
    assert.equal(db.prepare('SELECT status FROM billing_subscriptions WHERE id=?').get(sub.id).status, 'ended');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_orders WHERE user_id=? AND renewal=1').get(u.id).n, 1);
  });

  await t.test('[I-01] 구독 중 1회 상품은 기간 연장·다음 결제일도 미룸, 환불 요청·관리자 환불은 남은 기간 회수', async () => {
    const u = createUser(db);
    const c = as(u);
    await buy(c, 'sub_month');
    const until1 = user(u.id).premium_until;
    const once = await buy(c, 'once_month');
    assert.equal(once.order.amount, 10125);
    assert.equal(user(u.id).premium_until, until1 + 30 * DAY);
    assert.equal(db.prepare('SELECT next_charge_at FROM billing_subscriptions WHERE user_id=?').get(u.id).next_charge_at, until1 + 30 * DAY);
    assert.equal((await c.post(`/api/billing/orders/${once.order.orderId}/refund-request`, {})).status, 400);
    const rr = await c.post(`/api/billing/orders/${once.order.orderId}/refund-request`, { reason: '실수로 구매' });
    assert.equal(rr.body.order.status, 'refund_requested');
    assert.equal((await as(u).get('/api/admin/billing/orders')).status, 403);
    const list = await A.get('/api/admin/billing/orders?status=refund_requested');
    assert.ok(list.body.items.some((o) => o.id === once.order.orderId));
    const ref = await A.post(`/api/admin/billing/orders/${once.order.orderId}/refund`, { note: '7일 이내 청약철회' });
    assert.equal(ref.body.order.status, 'refunded');
    assert.equal(user(u.id).premium_until, until1);
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE '%환불%'").get(u.id));
    const st = await A.get('/api/admin/billing/stats');
    assert.ok(st.body.revenue.total > 0);
    assert.ok(st.body.revenue.refunded >= 10125);
  });

  await t.test('[I-02] 추가 저장공간: 프리미엄만 구매, 용량 증가, 만료되면 동결, 기간 끝나면 회수', async () => {
    const free = createUser(db);
    assert.equal((await as(free).post('/api/billing/orders', { productId: 'storage_10tb_year', method: 'card' })).status, 403);
    const u = createUser(db, { premium: true });
    await buy(as(u), 'storage_10tb_year');
    assert.equal(user(u.id).extra_storage_bytes, 10 * TB);
    assert.equal(capacityOf(user(u.id)), LIMITS.premium.storage + 10 * TB);
    assert.equal(capacityOf({ ...user(u.id), premium_until: now() - 1 }), LIMITS.free.storage);
    await runExpiry(ctx, now() + 366 * DAY);
    assert.equal(user(u.id).extra_storage_bytes, 0);
    assert.ok(db.prepare('SELECT revoked_at FROM billing_addons WHERE user_id=?').get(u.id).revoked_at);
  });

  await t.test('[I-03] 쿠폰: 관리자 발급, 1인 1회·횟수 제한·만료, 체험 코드 종료 3일 전 알림', async () => {
    assert.equal((await as(createUser(db)).post('/api/admin/billing/coupons', { kind: 'paid', days: 30 })).status, 403);
    assert.equal((await A.post('/api/admin/billing/coupons', { kind: 'gold', days: 30 })).status, 400);
    const made = await A.post('/api/admin/billing/coupons', { kind: 'paid', days: 30, count: 3, maxUses: 1 });
    assert.equal(made.body.codes.length, 3);
    const row = db.prepare('SELECT * FROM billing_coupons WHERE batch=?').get(made.body.batch);
    assert.notEqual(row.code_hash, made.body.codes[0]); // 원문 저장 안 함
    const u = createUser(db);
    const c = as(u);
    assert.equal((await c.post('/api/billing/coupons/redeem', { code: 'NOPE-NOPE' })).status, 404);
    const r = await c.post('/api/billing/coupons/redeem', { code: made.body.codes[0].toLowerCase() });
    assert.equal(r.status, 200);
    assert.equal(r.body.days, 30);
    assert.equal(isPremium(user(u.id)), true);
    assert.equal((await c.post('/api/billing/coupons/redeem', { code: made.body.codes[0] })).status, 409);
    assert.equal((await as(createUser(db)).post('/api/billing/coupons/redeem', { code: made.body.codes[0] })).status, 410);
    const exp = await A.post('/api/admin/billing/coupons', { kind: 'paid', days: 1, expiresAt: now() + 1000 });
    db.prepare('UPDATE billing_coupons SET expires_at=? WHERE batch=?').run(now() - 1, exp.body.batch);
    assert.equal((await c.post('/api/billing/coupons/redeem', { code: exp.body.codes[0] })).status, 410);
    // 체험 코드: 자동 결제 없음, 종료 3일 전 알림
    const trial = await A.post('/api/admin/billing/coupons', { kind: 'trial', days: 7 });
    const v = createUser(db);
    await as(v).post('/api/billing/coupons/redeem', { code: trial.body.codes[0] });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_subscriptions WHERE user_id=?').get(v.id).n, 0);
    await runRenewals(ctx, user(v.id).premium_until - 2 * DAY);
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE '%체험 기간%'").get(v.id));
    // 체험 중 1회권을 사서 프리미엄이 길어지면 종료 알림을 보내지 않는다
    const trial2 = await A.post('/api/admin/billing/coupons', { kind: 'trial', days: 7 });
    const w = createUser(db);
    await as(w).post('/api/billing/coupons/redeem', { code: trial2.body.codes[0] });
    const endsAt = user(w.id).premium_until;
    applyOrder(ctx, createOrder(ctx, user(w.id), 'once_month', 'card'));
    await runRenewals(ctx, endsAt - 2 * DAY);
    assert.equal(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE '%체험 기간%'").get(w.id), undefined);
    assert.ok(db.prepare('SELECT reminded_at FROM billing_coupon_redemptions WHERE user_id=?').get(w.id).reminded_at);
    assert.equal((await as(v).get('/api/billing/coupons/history')).body.items[0].kind, 'trial');
    assert.ok((await A.get('/api/admin/billing/coupons')).body.items.length >= 5);
  });

  await t.test('[I-04] 초대 관계: 가입 이벤트·코드 등록(12시간·자기 자신·중복), 35% 반올림 보상(월 4회 42일·연 128일), 소문자 코드', async () => {
    const inviter = createUser(db);
    const a = createUser(db);
    s.ctx.events.emit('user:created', { userId: a.id, via: 'email', inviteCode: inviter.invite_code });
    assert.equal(user(a.id).invited_by, inviter.id);
    const b = createUser(db);
    const cb = as(b);
    assert.equal((await cb.post('/api/billing/invite/bind', { code: b.invite_code })).status, 400);
    assert.equal((await cb.post('/api/billing/invite/bind', { code: 'zzzzzzzz' })).status, 404);
    assert.equal((await cb.post('/api/billing/invite/bind', { code: inviter.invite_code })).status, 200);
    assert.equal((await cb.post('/api/billing/invite/bind', { code: inviter.invite_code })).status, 409);
    const late = createUser(db);
    db.prepare('UPDATE users SET created_at=? WHERE id=?').run(now() - 13 * 3600_000, late.id);
    assert.equal((await as(late).post('/api/billing/invite/bind', { code: inviter.invite_code })).status, 403);
    // a: 월 구독 4회(첫 결제 + 갱신 3회) → 120일 × 35% = 42일
    await buy(as(a), 'sub_month');
    for (let i = 0; i < 3; i++) await runRenewals(ctx, db.prepare('SELECT next_charge_at FROM billing_subscriptions WHERE user_id=?').get(a.id).next_charge_at + 1);
    const sumFor = (id) => db.prepare('SELECT COALESCE(SUM(reward_days),0) AS n FROM billing_referral_rewards WHERE invitee_id=?').get(id).n;
    assert.equal(sumFor(a.id), 42);
    // b: 연 구독 → 365일 × 35% = 127.75 → 128일(PikPak 예시와 같게 반올림)
    await buy(cb, 'sub_year');
    assert.equal(sumFor(b.id), 128);
    assert.ok(isPremium(user(inviter.id)));
    const inv = await as(inviter).get('/api/billing/invite');
    assert.equal(inv.body.inviteCode, inviter.invite_code);
    assert.equal(inv.body.link, `/signup?invite=${inviter.invite_code}`);
    assert.equal(inv.body.stats.invited, 2);
    assert.equal(inv.body.stats.purchased, 2);
    assert.equal(inv.body.stats.rewardDays, 170); // 42 + 128
    assert.ok(!inv.body.records[0].name.includes('@'));
    // 미믹 코드는 대문자. 소문자·하이픈·공백을 섞어 입력해도 찾는다
    const up = createUser(db);
    db.prepare('UPDATE users SET invite_code=? WHERE id=?').run('MIMC2345', up.id);
    assert.equal((await as(createUser(db)).post('/api/billing/invite/bind', { code: ' mimc-2345 ' })).status, 200);
    // 초대 코드가 없던 사용자는 대문자 8자리 코드를 받는다
    const nocode = createUser(db);
    db.prepare('UPDATE users SET invite_code=NULL WHERE id=?').run(nocode.id);
    assert.match((await as(nocode).get('/api/billing/invite')).body.inviteCode, /^[A-Z2-9]{8}$/);
  });

  await t.test('[I-04] 무료 코드 제외, 가입 1년 지난 구매 제외, 같은 달 구매자 10명마다 업로드 100GB(다음 달로 이월), 환불하면 보상 회수', async () => {
    const inviter = createUser(db);
    const free = await A.post('/api/admin/billing/coupons', { kind: 'free', days: 30 });
    const x = createUser(db);
    bindInvite(ctx, x.id, inviter.invite_code);
    await as(x).post('/api/billing/coupons/redeem', { code: free.body.codes[0] });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_referral_rewards WHERE invitee_id=?').get(x.id).n, 0);
    const old = createUser(db);
    bindInvite(ctx, old.id, inviter.invite_code);
    db.prepare('UPDATE users SET created_at=? WHERE id=?').run(now() - 400 * DAY, old.id);
    applyOrder(ctx, createOrder(ctx, user(old.id), 'once_month', 'card'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_referral_rewards WHERE invitee_id=?').get(old.id).n, 0);
    const baseUp = monthlyLimit(db, inviter.id, 'up');
    let lastOrder;
    for (let i = 0; i < 10; i++) {
      const f = createUser(db);
      bindInvite(ctx, f.id, inviter.invite_code);
      lastOrder = applyOrder(ctx, createOrder(ctx, user(f.id), 'once_month', 'card'));
      if (i === 8) assert.equal(monthlyLimit(db, inviter.id, 'up'), baseUp);
    }
    assert.equal(monthlyLimit(db, inviter.id, 'up'), baseUp + 100 * GB);
    const g = db.prepare("SELECT * FROM quota_grants WHERE user_id=? AND reason LIKE 'invite_upload:%'").get(inviter.id);
    assert.equal(g.valid_to, monthStart(now(), 2));
    assert.equal((await as(inviter).get('/api/billing/invite')).body.stats.uploadBonusThisMonth, 100 * GB);
    // 보너스는 지급한 달 한도에만 들어가고(두 달에 겹쳐 더하지 않음), 안 쓴 만큼만 다음 달로 넘어간다
    const next = monthStart(now(), 1) + 1000;
    assert.equal(monthlyLimit(db, inviter.id, 'up', next), 1 * TB);
    addUsage(db, inviter.id, 'up', 1 * TB + 30 * GB);
    carryInviteBonus(db, next);
    carryInviteBonus(db, next);
    assert.equal(monthlyLimit(db, inviter.id, 'up', next), 1 * TB + 70 * GB);
    // 환불: 그 주문으로 준 초대 보상(30일 × 35% = 10.5 → 11일, 반올림)과, 구매자가 9명이 되어 업로드 보너스를 거둔다
    const before = user(inviter.id).premium_until;
    const ref = await A.post(`/api/admin/billing/orders/${lastOrder.id}/refund`, {});
    assert.equal(ref.status, 200);
    assert.equal(user(inviter.id).premium_until, before - 11 * DAY);
    assert.equal(monthlyLimit(db, inviter.id, 'up'), baseUp);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_referral_rewards WHERE source=?').get(lastOrder.id).n, 0);
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE '%회수%'").get(inviter.id));
    assert.equal((await A.post(`/api/admin/billing/orders/${lastOrder.id}/refund`, {})).status, 409);
    // 다시 10명이 되면 다시 지급
    const f = createUser(db);
    bindInvite(ctx, f.id, inviter.invite_code);
    applyOrder(ctx, createOrder(ctx, user(f.id), 'once_month', 'card'));
    assert.equal(monthlyLimit(db, inviter.id, 'up'), baseUp + 100 * GB);
  });

  await t.test('[I-05] 추천 보상 Pro 신청·관리자 승인', async () => {
    const u = createUser(db);
    const c = as(u);
    assert.equal((await c.post('/api/billing/invite/pro/apply', { channel: '' })).status, 400);
    assert.equal((await c.post('/api/billing/invite/pro/apply', { channel: '유튜브 채널', audience: '1만 명', contact: 'me@test.local' })).status, 200);
    assert.equal((await c.post('/api/billing/invite/pro/apply', { channel: 'a', audience: 'b', contact: 'c' })).status, 409);
    const list = await A.get('/api/admin/billing/pro-applications');
    const app = list.body.items.find((x) => x.userId === u.id);
    assert.equal(app.status, 'pending');
    await A.post(`/api/admin/billing/pro-applications/${app.id}`, { status: 'approved' });
    const pro = (await c.get('/api/billing/invite/pro')).body;
    assert.equal(pro.application.status, 'approved');
    assert.ok(pro.description.ko && pro.description.en);
    assert.equal(pro.conditionsConfirmed, false);
  });

  await t.test('[I-06] 출석 체크: KST 하루 1회, 7일 연속마다 프리미엄 1일, 확장 토큰 허용', async () => {
    const u = createUser(db);
    const c = as(u);
    const r = await c.post('/api/billing/checkin');
    assert.equal(r.body.checkedToday, true);
    assert.equal(r.body.streak, 1);
    assert.equal((await c.post('/api/billing/checkin')).status, 409);
    const pat = createToken(db, u.id, { name: 'pat', scopes: ['account'] });
    assert.equal((await client(s.url, pat.token).post('/api/billing/checkin')).status, 403);
    const v = createUser(db);
    const ext = createToken(db, v.id, { name: '브라우저 확장', scopes: ['account'], appId: 'extension' });
    assert.equal((await client(s.url, ext.token).post('/api/billing/checkin')).status, 200);
    // 7일 연속(내일부터 6일 더)
    const w = createUser(db);
    let last;
    for (let i = 0; i < 7; i++) last = checkin(ctx, user(w.id), now() + i * DAY);
    assert.equal(last.streak, 7);
    assert.equal(last.rewarded, 1);
    assert.ok(user(w.id).premium_until > now());
    // 하루 건너뛰면 연속 일수 초기화
    assert.equal(checkin(ctx, user(w.id), now() + 9 * DAY).streak, 1);
  });

  await t.test('[F-01] 월 기본 쿼터 40TB·4TB·1TB, 매월 초기화·이월 없음', () => {
    const u = createUser(db, { premium: true });
    assert.equal(monthlyLimit(db, u.id, 'cloud'), 40 * TB);
    assert.equal(monthlyLimit(db, u.id, 'down'), 4 * TB);
    assert.equal(monthlyLimit(db, u.id, 'up'), 1 * TB);
    addUsage(db, u.id, 'up', 1 * TB, 'official', monthStart(now()) - DAY); // 지난달 사용량
    assert.equal(checkTransfer(db, user(u.id), 'up', 100 * GB).ok, true);
    addUsage(db, u.id, 'up', 1 * TB - GB);
    const r = checkTransfer(db, user(u.id), 'up', 2 * GB);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'monthly_quota');
  });

  await t.test('[F-02] 무료 하루 다운스트림 20GB·클라우드 다운로드 3회(KST 0시 초기화), 프리미엄 무제한', () => {
    const u = createUser(db);
    addUsage(db, u.id, 'down', 20 * GB, 'official', now() - DAY);
    assert.equal(checkTransfer(db, user(u.id), 'down', GB).ok, true); // 어제 사용량은 오늘 한도와 무관
    addUsage(db, u.id, 'down', 19.5 * GB);
    assert.deepEqual(checkTransfer(db, user(u.id), 'down', GB), { ok: false, reason: 'daily_quota', slow: true });
    for (let i = 0; i < 3; i++) consumeCloudTask(db, user(u.id));
    assert.throws(() => consumeCloudTask(db, user(u.id)), /무료 클라우드/);
    const p = createUser(db, { premium: true });
    addUsage(db, p.id, 'down', 25 * GB);
    assert.equal(checkTransfer(db, user(p.id), 'down', GB).ok, true);
    for (let i = 0; i < 5; i++) consumeCloudTask(db, user(p.id));
    assert.equal(periodKeys(Date.UTC(2026, 10, 12, 15, 0)).day, 'd:2026-11-13'); // UTC 15시 = KST 다음날 0시
  });

  await t.test('[F-03] 추가 쿼터: 1개월권은 구매한 달만, 1년권은 12개월 각각 지급', async () => {
    const u = createUser(db);
    await buy(as(u), 'quota_month');
    const m0 = periodKeys().month;
    const m1 = periodKeys(monthStart(now(), 1)).month;
    assert.equal(monthlyLimit(db, u.id, 'cloud'), 50 * TB);
    assert.deepEqual(db.prepare("SELECT DISTINCT period FROM quota_grants WHERE user_id=? AND reason LIKE 'order:%'").all(u.id).map((r) => r.period), [m0]);
    const v = createUser(db);
    await buy(as(v), 'quota_year');
    const periods = db.prepare("SELECT DISTINCT period FROM quota_grants WHERE user_id=? AND kind='up' ORDER BY period").all(v.id).map((r) => r.period);
    assert.equal(periods.length, 12);
    assert.equal(periods[0], m0);
    assert.equal(periods[1], m1);
    assert.equal(monthlyLimit(db, v.id, 'up'), 1 * TB + 256 * GB);
  });

  await t.test('[F-04] 쿼터 상세: 항목별 사용량·연결 앱 상한·오늘 사용량·지급 내역', async () => {
    const u = createUser(db);
    addUsage(db, u.id, 'down', 3 * GB);
    addUsage(db, u.id, 'down', GB, 'app');
    grant(db, u.id, { kind: 'cloud_count', amount: 2, reason: 'signup_bonus' });
    const r = await as(u).get('/api/billing/quota');
    assert.equal(r.status, 200);
    assert.equal(r.body.month.down.used, 4 * GB);
    assert.equal(r.body.month.down.limit, 4 * TB);
    assert.equal(r.body.app.down.used, GB);
    assert.equal(r.body.app.down.limit, TB);
    assert.equal(r.body.today.down.limit, 20 * GB);
    assert.equal(r.body.today.cloudTasks.remaining, 5);
    assert.equal(r.body.grants.length, 0); // cloud_count 는 지급 내역 표에서 제외
  });

  await t.test('[F-05] 연결 앱 합산 25% 상한: 다운로드 감속·업로드·새 클라우드 다운로드 차단, 무료 앱 다운로드 하루 5GB', () => {
    const p = user(createUser(db, { premium: true }).id);
    addUsage(db, p.id, 'up', 256 * GB, 'app');
    assert.deepEqual(checkTransfer(db, p, 'up', GB, 'app'), { ok: false, reason: 'app_quota', slow: false });
    assert.equal(checkTransfer(db, p, 'up', GB, 'official').ok, true); // 공식 앱은 상한 없음
    addUsage(db, p.id, 'down', TB, 'app');
    assert.deepEqual(checkTransfer(db, p, 'down', GB, 'app'), { ok: false, reason: 'app_quota', slow: true });
    addUsage(db, p.id, 'cloud', 10 * TB, 'app');
    assert.equal(checkTransfer(db, p, 'cloud', GB, 'app').ok, false);
    const f = user(createUser(db).id);
    addUsage(db, f.id, 'down', 5 * GB, 'app');
    assert.deepEqual(checkTransfer(db, f, 'down', GB, 'app'), { ok: false, reason: 'app_daily_quota', slow: true });
    assert.equal(checkTransfer(db, f, 'down', GB, 'official').ok, true);
  });

  await t.test('[I-01] 만료 5단계: 초과·재생 중지·유예 알림·오래 수정된 파일부터 삭제, 재결제하면 해제', async () => {
    const u = createUser(db);
    const t0 = now();
    db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(t0 - DAY, u.id);
    const oldF = createFileNode(db, u.id, null, { name: 'old.mkv', size: 4 * GB });
    const newF = createFileNode(db, u.id, null, { name: 'new.mkv', size: 4 * GB });
    db.prepare('UPDATE files SET updated_at=? WHERE id=?').run(t0 - 100 * DAY, oldF.id);
    const stage = () => json(user(u.id).settings, {}).expiryStage;
    await runExpiry(ctx, t0);
    assert.equal(stage(), 2);
    assert.equal(user(u.id).premium_expired_at, t0 - DAY);
    await runExpiry(ctx, t0 + 7 * DAY);
    assert.equal(stage(), 3);
    await runExpiry(ctx, t0 + 120 * DAY);
    assert.equal(stage(), 4);
    await runExpiry(ctx, t0 + 180 * DAY);
    assert.equal(stage(), 5);
    assert.equal(usage(db, u.id), 8 * GB); // 15일 유예 전에는 삭제 안 함
    await runExpiry(ctx, t0 + 196 * DAY);
    assert.equal(db.prepare('SELECT 1 FROM files WHERE id=?').get(oldF.id), undefined);
    assert.ok(db.prepare('SELECT 1 FROM files WHERE id=?').get(newF.id));
    assert.equal(stage(), 1);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND kind='expiry'").get(u.id).n >= 5);
    await buy(as(u), 'once_month');
    assert.equal(stage(), undefined);
    assert.equal(user(u.id).premium_expired_at, null);
    // 용량 안이면 1단계(만료 알림)만
    const v = createUser(db);
    db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(t0 - 10 * DAY, v.id);
    await runExpiry(ctx, t0);
    assert.equal(json(user(v.id).settings, {}).expiryStage, 1);
  });

  await t.test('[I-01][I-02][I-04] 결제·구독·쿠폰·초대 변경은 웹 세션 전용, 토큰은 403(조회는 account 권한)', async () => {
    const u = createUser(db, { premium: true });
    const order = (await as(u).post('/api/billing/orders', { productId: 'once_month', method: 'card' })).body.orderId;
    const cli = client(s.url, createToken(db, u.id, { name: 'cli', scopes: ['files:read'], appId: 'cli' }).token);
    const ext = client(s.url, createToken(db, u.id, { name: 'ext', scopes: ['account'], appId: 'extension' }).token);
    for (const k of [cli, ext]) {
      assert.equal((await k.post('/api/billing/orders', { productId: 'storage_10tb_year', method: 'card' })).status, 403); // 추가 저장공간은 웹에서만
      assert.equal((await k.post(`/api/billing/orders/${order}/confirm`, { result: 'success' })).status, 403);
      assert.equal((await k.post(`/api/billing/orders/${order}/refund-request`, { reason: 'x' })).status, 403);
      assert.equal((await k.post('/api/billing/subscriptions/x/cancel')).status, 403);
      assert.equal((await k.post('/api/billing/subscriptions/x/resume')).status, 403);
      assert.equal((await k.post('/api/billing/coupons/redeem', { code: 'NOPE' })).status, 403);
      assert.equal((await k.post('/api/billing/invite/bind', { code: 'NOPE' })).status, 403);
      assert.equal((await k.post('/api/billing/invite/pro/apply', { channel: 'a', audience: 'b', contact: 'c' })).status, 403);
    }
    for (const p of ['/api/billing/orders', '/api/billing/subscriptions', '/api/billing/coupons/history', '/api/billing/invite', '/api/billing/invite/pro']) assert.equal((await cli.get(p)).status, 403, p);
    assert.equal((await cli.get('/api/billing/quota')).status, 200); // CLI 쿼터 조회는 그대로
    assert.equal(db.prepare('SELECT status FROM billing_orders WHERE id=?').get(order).status, 'pending');
  });

  await t.test('[I-04] 초대 링크 가입 뒤 첫 로그인이 초대자와 같은 기기면 의심 처리·보상 보류', async () => {
    const inviter = createUser(db);
    const f = createUser(db);
    s.ctx.events.emit('user:created', { userId: f.id, via: 'email', inviteCode: inviter.invite_code });
    const sess = db.prepare('INSERT INTO sessions (id, user_id, device, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const id of [inviter.id, f.id]) sess.run(`s_${id}`, id, 'web', '10.1.2.3', 'same-browser', now(), now(), now() + DAY);
    s.ctx.events.emit('user:login', { userId: f.id, via: 'email' });
    assert.equal(db.prepare('SELECT suspicious FROM billing_invites WHERE invitee_id=?').get(f.id).suspicious, 1);
    applyOrder(ctx, createOrder(ctx, user(f.id), 'once_month', 'card'));
    assert.equal(user(inviter.id).premium_until, null);
    assert.equal(db.prepare('SELECT reward_days FROM billing_referral_rewards WHERE invitee_id=?').get(f.id).reward_days, 0);
  });

  await t.test('[K-05] 자동 갱신 없는 프리미엄은 끝나기 7일 전 알림·이메일 한 번, 만료 알림도 이메일', async () => {
    const u = createUser(db);
    applyOrder(ctx, createOrder(ctx, user(u.id), 'once_month', 'card'));
    const until = user(u.id).premium_until;
    await runRenewals(ctx, until - 6 * DAY);
    await runRenewals(ctx, until - 5 * DAY);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE to_addr=? AND subject LIKE '%프리미엄이 %끝납니다%'").get(u.email).n, 1);
    // 자동 갱신 중인 구독자는 갱신 안내만 받는다
    const v = createUser(db);
    await buy(as(v), 'sub_month');
    await runRenewals(ctx, user(v.id).premium_until - 6 * DAY);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE to_addr=? AND subject LIKE '%프리미엄이 %끝납니다%'").get(v.email).n, 0);
    await runExpiry(ctx, until + 1000);
    assert.ok(db.prepare("SELECT 1 FROM outbox WHERE to_addr=? AND subject LIKE '%프리미엄 기간이 끝났습니다%'").get(u.email));
  });

  await t.test('[H-02][I-01] 탈퇴 유예·잠금 계정은 갱신 안내·자동 결제를 하지 않고, 되살리면 다시 갱신한다', async () => {
    const u = createUser(db);
    await buy(as(u), 'sub_month');
    const sub = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get(u.id);
    const renewals = () => db.prepare('SELECT COUNT(*) AS n FROM billing_orders WHERE user_id=? AND renewal=1').get(u.id).n;
    for (const st of ['pending_delete', 'locked']) {
      db.prepare('UPDATE users SET status=? WHERE id=?').run(st, u.id);
      await runRenewals(ctx, sub.next_charge_at - 6 * DAY);
      await runRenewals(ctx, sub.next_charge_at + 1000);
      assert.equal(renewals(), 0, st);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title LIKE '%자동 갱신됩니다%'").get(u.id).n, 0);
    assert.equal(db.prepare('SELECT auto_renew FROM billing_subscriptions WHERE id=?').get(sub.id).auto_renew, 1); // 끄지 않고 건너뛰기만
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(u.id);
    await runRenewals(ctx, sub.next_charge_at + 2000);
    assert.equal(renewals(), 1);
  });

  await t.test('[I-01] 자동 갱신 주문은 구독할 때 쓴 결제 수단으로 청구', async () => {
    const u = createUser(db);
    await buy(as(u), 'sub_month', 'success', 'paypal');
    await runRenewals(ctx, db.prepare('SELECT next_charge_at FROM billing_subscriptions WHERE user_id=?').get(u.id).next_charge_at + 1);
    const items = (await as(u).get('/api/billing/orders')).body.items.map((o) => `${o.method}:${o.renewal}`);
    assert.deepEqual(items.sort(), ['paypal:false', 'paypal:true']);
  });

  await t.test('[I-04] 초대 통계는 기록 목록 200개 제한과 따로 전체를 센다', async () => {
    const inviter = createUser(db);
    const ids = [];
    for (let i = 0; i < 203; i++) {
      const f = createUser(db);
      bindInvite(ctx, f.id, inviter.invite_code);
      ids.push(f.id);
    }
    for (const id of ids.slice(0, 3)) applyOrder(ctx, createOrder(ctx, user(id), 'once_month', 'card'));
    const r = (await as(inviter).get('/api/billing/invite')).body;
    assert.equal(r.records.length, 200);
    assert.equal(r.stats.invited, 203);
    assert.equal(r.stats.purchased, 3);
    assert.equal(r.stats.rewardDays, 33); // 30일 × 35% = 10.5 → 11일 × 3명
  });

  await t.test('[I-04] 가입 뒤 추천인 코드 등록 전에 한 결제·체험 코드도 소급 보상(무료 코드 제외)', async () => {
    const inviter = createUser(db);
    const f = createUser(db);
    applyOrder(ctx, createOrder(ctx, user(f.id), 'once_month', 'card'));
    const free = (await A.post('/api/admin/billing/coupons', { kind: 'free', days: 30 })).body.codes[0];
    const trial = (await A.post('/api/admin/billing/coupons', { kind: 'trial', days: 30 })).body.codes[0];
    for (const code of [free, trial]) assert.equal((await as(f).post('/api/billing/coupons/redeem', { code })).status, 200);
    assert.equal((await as(f).post('/api/billing/invite/bind', { code: inviter.invite_code })).status, 200);
    // 30 + 30일 = 60일 × 35% = 21일(누적 반올림). 무료 코드 30일은 빠진다
    assert.equal(db.prepare('SELECT COALESCE(SUM(reward_days),0) AS n FROM billing_referral_rewards WHERE invitee_id=?').get(f.id).n, 21);
    assert.ok(Math.abs(user(inviter.id).premium_until - (now() + 21 * DAY)) < 60_000);
  });

  await t.test('[I-04] 같은 기기 의심 초대: 관리자가 보류 보상을 지급(release)하거나 부정 참여로 회수(revoke)', async () => {
    const inviter = createUser(db);
    const f = createUser(db);
    const sess = db.prepare('INSERT INTO sessions (id, user_id, device, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const id of [inviter.id, f.id]) sess.run(`s2_${id}`, id, 'web', '10.9.9.9', 'same-ua', now(), now(), now() + DAY);
    assert.equal(bindInvite(ctx, f.id, inviter.invite_code).suspicious, true);
    applyOrder(ctx, createOrder(ctx, user(f.id), 'once_month', 'card'));
    assert.equal(user(inviter.id).premium_until, null);
    assert.equal((await as(inviter).get('/api/admin/billing/invites')).status, 403);
    const list = (await A.get('/api/admin/billing/invites?suspicious=1')).body.items;
    const row = list.find((x) => x.inviteeId === f.id);
    assert.equal(row.suspicious, 1);
    assert.equal(row.purchaseDays, 30);
    assert.equal((await A.post(`/api/admin/billing/invites/${f.id}`, { action: 'maybe' })).status, 400);
    const rel = await A.post(`/api/admin/billing/invites/${f.id}`, { action: 'release' });
    assert.equal(rel.status, 200);
    assert.equal(rel.body.rewardDays, 11);
    assert.ok(Math.abs(user(inviter.id).premium_until - (now() + 11 * DAY)) < 60_000);
    assert.ok(!(await A.get('/api/admin/billing/invites?suspicious=1')).body.items.some((x) => x.inviteeId === f.id));
    const rev = await A.post(`/api/admin/billing/invites/${f.id}`, { action: 'revoke' });
    assert.equal(rev.body.rewardDays, -11);
    assert.ok(user(inviter.id).premium_until <= now());
    applyOrder(ctx, createOrder(ctx, user(f.id), 'once_month', 'card')); // 회수 뒤 구매는 보상 없음
    assert.equal(db.prepare('SELECT COALESCE(SUM(reward_days),0) AS n FROM billing_referral_rewards WHERE invitee_id=?').get(f.id).n, 0);
    const rec = (await as(inviter).get('/api/billing/invite')).body.records[0];
    assert.equal(rec.revoked, true);
  });

  await t.test('[K-06] 회원을 삭제해도 결제 기록은 보관(관리자 조회), 5년 지나면 정리', async () => {
    const u = createUser(db);
    const paid = (await buy(as(u), 'once_month')).order.orderId;
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_orders WHERE id=?').get(paid).n, 0);
    const kept = (await A.get('/api/admin/billing/orders?archived=1')).body.items.find((o) => o.id === paid);
    assert.equal(kept.status, 'paid');
    assert.equal(kept.amount, 10125);
    assert.equal(kept.user, u.email);
    assert.equal(purgeOrderArchive(db, now() + 4 * 365 * DAY), 0);
    assert.ok(purgeOrderArchive(db, now() + 5 * 365 * DAY + DAY) >= 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_orders_archive WHERE id=?').get(paid).n, 0);
  });
});

test('billing: 운영 모드 결제', async (t) => {
  const calls = [];
  let declineBilling = false;
  const toss = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      calls.push({ path: req.url, auth: req.headers.authorization, body: b });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/payments/confirm') {
        if (b.paymentKey === 'bad') return res.writeHead(400).end(JSON.stringify({ message: '카드 승인 거절' }));
        return res.end(JSON.stringify({ paymentKey: b.paymentKey, totalAmount: b.amount }));
      }
      if (req.url === '/v1/billing/authorizations/issue') return res.end(JSON.stringify({ billingKey: `bk_${b.authKey}`, customerKey: b.customerKey }));
      if (req.url.startsWith('/v1/billing/')) {
        if (declineBilling) return res.writeHead(400).end(JSON.stringify({ message: '한도 초과' }));
        return res.end(JSON.stringify({ paymentKey: `pay_${b.orderId}`, totalAmount: b.amount }));
      }
      res.end(JSON.stringify({ status: 'CANCELED' }));
    });
  });
  toss.listen(0, '127.0.0.1');
  await once(toss, 'listening');
  const s = await startServer({ dev: false, payments: {} });
  t.after(async () => {
    await s.close();
    toss.close();
  });
  const db = s.db;
  const u = createUser(db);
  const c = client(s.url, sessionFor(db, u.id));
  const A = client(s.url, sessionFor(db, createUser(db, { admin: true }).id));

  await t.test('[I-01] 운영 모드에 결제 키가 없으면 테스트 결제도 받지 않는다', async () => {
    const p = (await client(s.url).get('/api/billing/products')).body;
    assert.equal(p.testMode, false);
    assert.equal(p.available, false);
    const r = await c.post('/api/billing/orders', { productId: 'once_year', method: 'card' });
    assert.equal(r.status, 503);
    // 개발 모드에서 만든 테스트 주문이 남아 있어도 확정할 수 없다
    db.prepare("INSERT INTO billing_orders (id, user_id, product_id, kind, method, amount, days, test_mode, created_at) VALUES ('ord_old', ?, 'once_year', 'once', 'card', 69354, 365, 1, ?)").run(u.id, now());
    assert.equal((await c.post('/api/billing/orders/ord_old/confirm', { result: 'success' })).status, 503);
    assert.equal(db.prepare('SELECT premium_until FROM users WHERE id=?').get(u.id).premium_until, null);
  });

  await t.test('[I-01] 운영 키가 있으면 토스 승인 후 반영, 관리자 환불은 토스 취소가 성공해야 처리', async () => {
    s.ctx.cfg.payments = { tossSecretKey: 'sk_test_mimic', tossApiBase: `http://127.0.0.1:${toss.address().port}` };
    const o = (await c.post('/api/billing/orders', { productId: 'once_month', method: 'card' })).body;
    assert.equal(o.testMode, false);
    assert.equal((await c.post(`/api/billing/orders/${o.orderId}/confirm`, { result: 'success' })).status, 400); // 결제 키 필요
    const bad = (await c.post('/api/billing/orders', { productId: 'once_month', method: 'card' })).body;
    assert.equal((await c.post(`/api/billing/orders/${bad.orderId}/confirm`, { paymentKey: 'bad' })).status, 402);
    assert.equal(db.prepare('SELECT status FROM billing_orders WHERE id=?').get(bad.orderId).status, 'failed');
    const ok = await c.post(`/api/billing/orders/${o.orderId}/confirm`, { paymentKey: 'pk_1' });
    assert.equal(ok.status, 200);
    assert.ok(isPremium(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
    assert.equal(calls.at(-1).auth, 'Basic ' + Buffer.from('sk_test_mimic:').toString('base64'));
    assert.equal(calls.at(-1).body.amount, 10125);
    const ref = await A.post(`/api/admin/billing/orders/${o.orderId}/refund`, { note: '청약철회' });
    assert.equal(ref.status, 200);
    assert.equal(calls.at(-1).path, '/v1/payments/pk_1/cancel');
    assert.equal(ref.body.order.status, 'refunded');
    // 새 구독은 돈을 받기 전에 확인한다(자동 갱신 중이면 토스를 부르지 않음)
    const s1 = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body;
    const s2 = (await c.post('/api/billing/orders', { productId: 'sub_year', method: 'card' })).body;
    assert.equal((await c.post(`/api/billing/orders/${s1.orderId}/confirm`, { paymentKey: 'pk_2' })).status, 200);
    const n = calls.length;
    assert.equal((await c.post(`/api/billing/orders/${s2.orderId}/confirm`, { paymentKey: 'pk_3' })).status, 409);
    assert.equal(calls.length, n);
    // 운영 결제는 빌링키 연동 전이라 구독이 기간제: 자동 갱신 꺼짐, 다시 켤 수 없음, 화면에 자동 결제 없음
    const sub = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get(u.id);
    assert.equal(sub.auto_renew, 0);
    const subs = (await c.get('/api/billing/subscriptions')).body;
    assert.equal(subs.autoRenewAvailable, false);
    assert.equal(subs.items[0].nextChargeAt, null);
    assert.equal((await c.post(`/api/billing/subscriptions/${sub.id}/resume`)).status, 409);
  });

  await t.test('[I-01] 운영 카드 구독: 빌링키로 첫 결제·자동 갱신, 갱신이 실패하면 하루 간격 재시도 후 자동 갱신 중지', async () => {
    const v = createUser(db);
    const cv = client(s.url, sessionFor(db, v.id));
    const o = (await cv.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body;
    assert.match(o.customerKey, /^[0-9a-f]{40}$/);
    assert.equal((await c.post('/api/billing/orders', { productId: 'once_month', method: 'card' })).body.customerKey, null); // 1회 상품은 빌링 없음
    assert.equal((await cv.post(`/api/billing/orders/${o.orderId}/confirm`, { authKey: 'a1', customerKey: 'someone-else' })).status, 400);
    const ok = await cv.post(`/api/billing/orders/${o.orderId}/confirm`, { authKey: 'a1', customerKey: o.customerKey });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(calls.at(-2).path, '/v1/billing/authorizations/issue');
    assert.deepEqual([calls.at(-1).path, calls.at(-1).body.amount], ['/v1/billing/bk_a1', 6256]);
    const order = db.prepare('SELECT * FROM billing_orders WHERE id=?').get(o.orderId);
    assert.equal(order.pg_key, `pay_${o.orderId}`); // 환불 때 토스 취소에 쓴다
    let sub = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get(v.id);
    assert.equal(sub.auto_renew, 1);
    assert.equal((await cv.get('/api/billing/subscriptions')).body.autoRenewAvailable, true);
    // 갱신: 빌링키로 정가 청구
    await runRenewals(s.ctx, sub.next_charge_at + 1000);
    const renewal = db.prepare("SELECT * FROM billing_orders WHERE user_id=? AND renewal=1 AND status='paid'").get(v.id);
    assert.deepEqual([renewal.amount, renewal.method, renewal.pg_key], [9591, 'card', `pay_${renewal.id}`]);
    assert.equal(calls.at(-1).path, '/v1/billing/bk_a1');
    // 갱신 결제 실패: 하루 뒤 재시도, 3번 실패하면 자동 갱신을 멈춘다
    declineBilling = true;
    sub = db.prepare('SELECT * FROM billing_subscriptions WHERE id=?').get(sub.id);
    let at = sub.next_charge_at + 1000;
    for (let i = 1; i <= 3; i++) {
      await runRenewals(s.ctx, at);
      sub = db.prepare('SELECT * FROM billing_subscriptions WHERE id=?').get(sub.id);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_orders WHERE subscription_id=? AND status='failed'").get(sub.id).n, i);
      if (i < 3) {
        assert.equal(sub.auto_renew, 1);
        assert.equal(sub.next_charge_at, at + DAY);
        at = sub.next_charge_at + 1000;
      }
    }
    assert.equal(sub.auto_renew, 0);
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE '%갱신 결제에 실패%' AND body LIKE '%한도 초과%'").get(v.id));
    assert.ok(db.prepare("SELECT 1 FROM outbox WHERE to_addr=? AND subject LIKE '%자동 갱신을 멈췄습니다%'").get(v.email));
    declineBilling = false;
  });
});
