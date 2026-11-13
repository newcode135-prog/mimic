// PayPal 직접 결제(2026-11-13 결정): 모든 사용자 달러·PayPal, PikPak 미국 App Store 가격, 구독은 PayPal 자동 청구
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { isPremium } from '../server/core/plans.js';
import { now, DAY } from '../server/core/util.js';
import { runRenewals } from '../server/modules/billing/index.js';

// PayPal REST API 흉내. orders·subs 는 조회(GET) 응답을 테스트가 바꿀 수 있다
function fakePaypal() {
  const calls = [];
  const orders = {};
  const subs = {};
  const plans = {};
  let n = 0;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : {};
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, body: b, auth: req.headers.authorization, requestId: req.headers['paypal-request-id'] });
      const send = (o, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      const p = url.pathname;
      if (p === '/v1/oauth2/token') return req.headers.authorization === 'Basic ' + Buffer.from('cid:csecret').toString('base64') ? send({ access_token: 'tok', expires_in: 3600 }) : send({}, 401);
      if (req.headers.authorization !== 'Bearer tok') return send({ name: 'AUTHENTICATION_FAILURE' }, 401);
      if (p === '/v1/catalogs/products') return send({ id: 'PROD-1' });
      if (p === '/v1/billing/plans') {
        const id = `P-${++n}`;
        plans[id] = b;
        return send({ id, status: 'ACTIVE' });
      }
      if (p === '/v1/billing/subscriptions' && req.method === 'POST') {
        const id = `I-SUB${++n}`;
        subs[id] = { id, plan_id: b.plan_id, custom_id: b.custom_id, status: 'APPROVAL_PENDING' };
        return send({ ...subs[id], links: [{ rel: 'approve', href: `https://paypal.test/approve/${id}` }] });
      }
      let m;
      if ((m = p.match(/^\/v1\/billing\/subscriptions\/([^/]+)$/))) return subs[m[1]] ? send(subs[m[1]]) : send({}, 404);
      if ((m = p.match(/^\/v1\/billing\/subscriptions\/([^/]+)\/(suspend|activate|cancel)$/))) {
        subs[m[1]].status = { suspend: 'SUSPENDED', activate: 'ACTIVE', cancel: 'CANCELLED' }[m[2]];
        return res.writeHead(204).end();
      }
      if ((m = p.match(/^\/v1\/billing\/subscriptions\/([^/]+)\/transactions$/))) return send({ transactions: subs[m[1]].transactions || [] });
      if ((m = p.match(/^\/v1\/payments\/sale\/([^/]+)\/refund$/))) return send({ id: `R-${m[1]}`, status: 'COMPLETED' });
      if (p === '/v2/checkout/orders') {
        const id = `ORD${++n}`;
        const unit = b.purchase_units[0];
        orders[id] = { id, status: 'PAYER_ACTION_REQUIRED', unit };
        return send({ id, status: orders[id].status, links: [{ rel: 'payer-action', href: `https://paypal.test/checkout/${id}` }] });
      }
      const view = (o) => ({ id: o.id, status: o.status, purchase_units: [{ custom_id: o.unit.custom_id, payments: o.capture ? { captures: [o.capture] } : undefined }] });
      if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) return orders[m[1]] ? send(view(orders[m[1]])) : send({}, 404);
      if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
        const o = orders[m[1]];
        if (o.status !== 'APPROVED') return send({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 422);
        o.status = 'COMPLETED';
        o.capture = { id: `CAP-${o.id}`, status: o.captureStatus || 'COMPLETED', custom_id: o.unit.custom_id, amount: o.paidAmount || o.unit.amount };
        return send(view(o));
      }
      if ((m = p.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/))) return send({ id: `R-${m[1]}`, status: 'COMPLETED' });
      if ((m = p.match(/^\/v2\/payments\/captures\/([^/]+)$/))) {
        const o = Object.values(orders).find((x) => x.capture?.id === m[1]);
        return o ? send({ ...o.capture, status: o.captureFinal || o.capture.status }) : send({}, 404);
      }
      send({ name: 'NOT_FOUND' }, 404);
    });
  });
  return { srv, calls, orders, subs, plans };
}

test('billing-paypal: 테스트 모드(키 없음) — 모든 사용자 달러·PayPal, App Store 미국가', async () => {
  const s = await startServer({ payments: { provider: 'paypal' } });
  try {
    const u = createUser(s.db); // 지역 KR 이어도 달러
    const c = client(s.url, sessionFor(s.db, u.id));
    const p = (await c.get('/api/billing/products')).body;
    const price = (id) => p.products.find((x) => x.id === id);
    assert.deepEqual([p.currency, p.provider, p.methods, p.testMode, p.fx], ['USD', 'paypal', ['paypal'], true, null]);
    assert.deepEqual([price('sub_month').price, price('sub_month').firstPrice, price('sub_month').payNow], [999, 649, 649]);
    assert.deepEqual([price('sub_year').price, price('once_month').price, price('once_year').price], [9999, 1049, 6819]);
    assert.equal((await c.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).status, 400); // PayPal 만
    const o = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'paypal' })).body;
    assert.deepEqual([o.currency, o.amount, o.approveUrl], ['USD', 649, null]);
    assert.equal((await c.post(`/api/billing/orders/${o.orderId}/confirm`, { result: 'success' })).body.status, 'paid');
    assert.equal(s.db.prepare('SELECT auto_renew FROM billing_subscriptions WHERE user_id=?').get(u.id).auto_renew, 1);
    // 지역 등급은 App Store 지역가
    const r = createUser(s.db, { tier: 'regional' });
    const rp = (await client(s.url, sessionFor(s.db, r.id)).get('/api/billing/products')).body;
    assert.deepEqual([rp.products.find((x) => x.id === 'sub_month').price, rp.products.find((x) => x.id === 'sub_year').price], [499, 4999]);
  } finally {
    await s.close();
  }
});

test('billing-paypal: 운영 — 1회 결제 캡처·구독 자동 청구·웹훅·갱신·환불', async (t) => {
  const pp = fakePaypal();
  pp.srv.listen(0, '127.0.0.1');
  await once(pp.srv, 'listening');
  const paypalApiBase = `http://127.0.0.1:${pp.srv.address().port}`;
  const s = await startServer({ dev: false, payments: { provider: 'paypal', paypalClientId: 'cid', paypalSecret: 'csecret', paypalApiBase } });
  t.after(async () => {
    await s.close();
    pp.srv.close();
  });
  const db = s.db;
  const ctx = s.ctx;
  const user = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const order = (id) => db.prepare('SELECT * FROM billing_orders WHERE id=?').get(id);
  const as = (u) => client(s.url, sessionFor(db, u.id));
  const hook = (event_type, resource) => client(s.url).post('/api/billing/paypal/webhook', { event_type, resource });
  const last = (path) => pp.calls.filter((x) => x.path === path).at(-1);

  await t.test('1회 결제: 승인 화면 주소 → 돌아오면 서버가 캡처, 캡처 번호로 환불', async () => {
    const u = createUser(db);
    const c = as(u);
    const p = (await c.get('/api/billing/products')).body;
    assert.deepEqual([p.testMode, p.available, p.methods], [false, true, ['paypal']]);
    const o = (await c.post('/api/billing/orders', { productId: 'once_month', method: 'paypal' })).body;
    assert.match(o.approveUrl, /^https:\/\/paypal\.test\/checkout\/ORD/);
    const ppId = order(o.orderId).pg_key;
    const unit = pp.orders[ppId].unit;
    assert.deepEqual([unit.custom_id, unit.amount], [o.orderId, { currency_code: 'USD', value: '10.49' }]);
    assert.match(last('/v2/checkout/orders').body.payment_source.paypal.experience_context.return_url, new RegExp(`/drive/payment\\?paypal=order&orderId=${o.orderId}$`));
    // 승인 전에 돌아오면(창 닫기 등) 결제 실패
    const early = await c.post(`/api/billing/orders/${o.orderId}/confirm`, {});
    assert.equal(early.status, 402);
    assert.equal(order(o.orderId).status, 'failed');
    // 새 주문 → 승인 → 캡처
    const o2 = (await c.post('/api/billing/orders', { productId: 'once_month', method: 'paypal' })).body;
    pp.orders[order(o2.orderId).pg_key].status = 'APPROVED';
    const ok = await c.post(`/api/billing/orders/${o2.orderId}/confirm`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'paid');
    assert.match(order(o2.orderId).pg_key, /^CAP-ORD/);
    assert.ok(isPremium(user(u.id)));
    // 관리자 환불: 캡처 환불
    const A = as(createUser(db, { admin: true }));
    assert.equal((await A.post(`/api/admin/billing/orders/${o2.orderId}/refund`, {})).status, 200);
    assert.equal(pp.calls.at(-1).path, `/v2/payments/captures/${order(o2.orderId).pg_key}/refund`);
    assert.equal(order(o2.orderId).status, 'refunded');
  });

  await t.test('1회 결제: 캡처 금액이 주문과 다르면 반영하지 않는다', async () => {
    const u = createUser(db);
    const c = as(u);
    const o = (await c.post('/api/billing/orders', { productId: 'once_year', method: 'paypal' })).body;
    const po = pp.orders[order(o.orderId).pg_key];
    po.status = 'APPROVED';
    po.paidAmount = { currency_code: 'USD', value: '0.01' };
    assert.equal((await c.post(`/api/billing/orders/${o.orderId}/confirm`, {})).status, 402);
    assert.equal(isPremium(user(u.id)), false);
  });

  await t.test('1회 결제: 결제사 검토(PENDING)는 대기 → 캡처 완료 웹훅을 PayPal 에 다시 조회해 반영, 한 번만', async () => {
    const u = createUser(db);
    const c = as(u);
    const o = (await c.post('/api/billing/orders', { productId: 'once_month', method: 'paypal' })).body;
    const po = pp.orders[order(o.orderId).pg_key];
    po.status = 'APPROVED';
    po.captureStatus = 'PENDING';
    assert.equal((await c.post(`/api/billing/orders/${o.orderId}/confirm`, {})).body.status, 'pending');
    // 본문만 COMPLETED 라고 속여도 조회 결과가 PENDING 이면 반영하지 않는다
    await hook('PAYMENT.CAPTURE.COMPLETED', { id: po.capture.id, custom_id: o.orderId, status: 'COMPLETED' });
    assert.equal(order(o.orderId).status, 'pending');
    po.captureFinal = 'COMPLETED';
    await hook('PAYMENT.CAPTURE.COMPLETED', { id: po.capture.id, custom_id: o.orderId });
    await hook('PAYMENT.CAPTURE.COMPLETED', { id: po.capture.id, custom_id: o.orderId });
    assert.deepEqual([order(o.orderId).status, order(o.orderId).pg_key], ['paid', po.capture.id]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND kind='payment'").get(u.id).n, 1);
    // 남의 주문 번호를 붙인 캡처로는 반영하지 않는다
    const other = (await c.post('/api/billing/orders', { productId: 'once_month', method: 'paypal' })).body;
    await hook('PAYMENT.CAPTURE.COMPLETED', { id: po.capture.id, custom_id: other.orderId });
    assert.equal(order(other.orderId).status, 'pending');
  });

  await t.test('구독: 첫 할인 요금제(TRIAL 1회 + 정가) → 첫 청구 확인 뒤 자동 갱신 구독, 위조 웹훅 무시', async () => {
    const u = createUser(db);
    const c = as(u);
    const o = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'paypal' })).body;
    assert.equal(o.amount, 649);
    assert.match(o.approveUrl, /^https:\/\/paypal\.test\/approve\/I-SUB/);
    const subId = order(o.orderId).pg_key.slice(4);
    const plan = pp.plans[pp.subs[subId].plan_id];
    assert.deepEqual(
      plan.billing_cycles.map((x) => [x.tenure_type, x.total_cycles, x.pricing_scheme.fixed_price.value, x.frequency.interval_unit, x.frequency.interval_count]),
      [['TRIAL', 1, '6.49', 'DAY', 30], ['REGULAR', 0, '9.99', 'DAY', 30]],
    );
    // 같은 요금제는 다시 만들지 않는다
    const plansBefore = Object.keys(pp.plans).length;
    const again = createUser(db);
    await as(again).post('/api/billing/orders', { productId: 'sub_month', method: 'paypal' });
    assert.equal(Object.keys(pp.plans).length, plansBefore);
    // 아직 승인 전이면 대기
    assert.equal((await c.post(`/api/billing/orders/${o.orderId}/confirm`, {})).body.status, 'pending');
    assert.equal(isPremium(user(u.id)), false);
    // 활성인데 첫 청구 금액이 다르면 반영하지 않는다
    pp.subs[subId] = { ...pp.subs[subId], status: 'ACTIVE', billing_info: { last_payment: { amount: { currency_code: 'USD', value: '0.10' }, time: new Date().toISOString() } } };
    await hook('BILLING.SUBSCRIPTION.ACTIVATED', { id: subId });
    assert.equal(order(o.orderId).status, 'pending');
    // 맞으면 웹훅으로 확정
    pp.subs[subId].billing_info.last_payment.amount.value = '6.49';
    await hook('BILLING.SUBSCRIPTION.ACTIVATED', { id: subId });
    await hook('PAYMENT.SALE.COMPLETED', { id: 'SALE-1', billing_agreement_id: subId });
    assert.equal(order(o.orderId).status, 'paid');
    const sub = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get(u.id);
    assert.deepEqual([sub.pg_sub_id, sub.auto_renew], [subId, 1]);
    assert.ok(isPremium(user(u.id)));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_orders WHERE user_id=? AND status='paid'").get(u.id).n, 1);
    const list = (await c.get('/api/billing/subscriptions')).body;
    assert.equal(list.autoRenewAvailable, true);
    // 모르는 구독 번호·이벤트는 그냥 200
    assert.equal((await hook('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-NOPE' })).status, 200);
    assert.equal((await hook('CUSTOMER.DISPUTE.CREATED', {})).status, 200);
  });

  await t.test('구독 갱신: PayPal 청구가 들어오면 기록·연장(한 번만), 자동 갱신 끄기·켜기는 PayPal 정지·재개', async () => {
    const u = createUser(db);
    const c = as(u);
    const o = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'paypal' })).body;
    const subId = order(o.orderId).pg_key.slice(4);
    pp.subs[subId] = { ...pp.subs[subId], status: 'ACTIVE', billing_info: { last_payment: { amount: { currency_code: 'USD', value: '6.49' }, time: new Date().toISOString() } } };
    assert.equal((await c.post(`/api/billing/orders/${o.orderId}/confirm`, {})).body.status, 'paid');
    let sub = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get(u.id);
    const end = sub.current_period_end;
    // 기간 끝 무렵 PayPal 이 정가로 청구
    pp.subs[subId].billing_info.last_payment = { amount: { currency_code: 'USD', value: '9.99' }, time: new Date(end + 3600_000).toISOString() };
    await runRenewals(ctx, end + 2 * 3600_000);
    await runRenewals(ctx, end + 3 * 3600_000);
    const renewals = db.prepare("SELECT * FROM billing_orders WHERE subscription_id=? AND renewal=1 AND status='paid'").all(sub.id);
    assert.deepEqual([renewals.length, renewals[0].amount, renewals[0].method], [1, 999, 'paypal']);
    sub = db.prepare('SELECT * FROM billing_subscriptions WHERE id=?').get(sub.id);
    assert.ok(sub.current_period_end >= end + 29 * DAY);
    // 끄기 → PayPal 정지, 켜기 → 재개
    assert.equal((await c.post(`/api/billing/subscriptions/${sub.id}/cancel`, {})).status, 200);
    assert.equal(pp.calls.at(-1).path, `/v1/billing/subscriptions/${subId}/suspend`);
    assert.equal(db.prepare('SELECT auto_renew FROM billing_subscriptions WHERE id=?').get(sub.id).auto_renew, 0);
    assert.equal((await c.post(`/api/billing/subscriptions/${sub.id}/resume`, {})).status, 200);
    assert.equal(pp.calls.at(-1).path, `/v1/billing/subscriptions/${subId}/activate`);
    assert.equal(db.prepare('SELECT auto_renew FROM billing_subscriptions WHERE id=?').get(sub.id).auto_renew, 1);
    // 갱신 결제 환불: 그 무렵 구독 거래(sale)를 찾아 환불하고 PayPal 구독도 끝낸다
    pp.subs[subId].transactions = [{ id: 'SALE-R1', status: 'COMPLETED', amount_with_breakdown: { gross_amount: { currency_code: 'USD', value: '9.99' } } }];
    const A = as(createUser(db, { admin: true }));
    const rf = await A.post(`/api/admin/billing/orders/${renewals[0].id}/refund`, {});
    assert.equal(rf.status, 200, JSON.stringify(rf.body));
    assert.ok(pp.calls.some((x) => x.path === '/v1/payments/sale/SALE-R1/refund'));
    assert.equal(pp.calls.at(-1).path, `/v1/billing/subscriptions/${subId}/cancel`);
  });

  await t.test('구독 갱신: 기간이 끝나고 3일이 지나도 청구가 없으면 자동 갱신을 멈추고 PayPal 구독을 끝낸다', async () => {
    const u = createUser(db);
    const c = as(u);
    const o = (await c.post('/api/billing/orders', { productId: 'sub_year', method: 'paypal' })).body;
    const subId = order(o.orderId).pg_key.slice(4);
    pp.subs[subId] = { ...pp.subs[subId], status: 'ACTIVE', billing_info: { last_payment: { amount: { currency_code: 'USD', value: '61.49' }, time: new Date().toISOString() } } };
    assert.equal((await c.post(`/api/billing/orders/${o.orderId}/confirm`, {})).body.status, 'paid');
    const sub = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get(u.id);
    await runRenewals(ctx, sub.current_period_end + 1000); // 아직 유예 안: 6시간 뒤 다시
    assert.equal(db.prepare('SELECT auto_renew FROM billing_subscriptions WHERE id=?').get(sub.id).auto_renew, 1);
    await runRenewals(ctx, sub.current_period_end + 4 * DAY);
    assert.equal(db.prepare('SELECT auto_renew FROM billing_subscriptions WHERE id=?').get(sub.id).auto_renew, 0);
    assert.equal(pp.subs[subId].status, 'CANCELLED');
    assert.ok(now() > 0);
  });
});
