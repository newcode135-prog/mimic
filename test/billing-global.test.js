// 해외 결제(Q-2·Q-4)·PikPak 가격(Q-3)·만료 뒤 금고 보관(Q-10)·빌링키 암호화(Q-11)
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { createFileNode, usage } from '../server/core/files.js';
import { GB, PRODUCTS, isPremium } from '../server/core/plans.js';
import { now, DAY, json } from '../server/core/util.js';
import { refreshFx, fxOf, runExpiry, runRenewals, sealKey, upgradeSchema, currencyOf, money } from '../server/modules/billing/index.js';

const NOV13 = Date.UTC(2026, 10, 13) / 1000;

// 토스·환율 API 흉내. payments[paymentKey] 는 결제 조회(GET) 응답
function fakeToss() {
  const calls = [];
  const payments = {};
  let fx = { status: 200, body: { result: 'success', time_last_update_unix: NOV13, rates: { KRW: 1400 } } };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw || '{}');
      const secret = Buffer.from(String(req.headers.authorization || '').replace('Basic ', ''), 'base64').toString().slice(0, -1);
      calls.push({ method: req.method, path: req.url, secret, body: b });
      res.setHeader('content-type', 'application/json');
      const send = (o, status = 200) => res.writeHead(status).end(JSON.stringify(o));
      if (req.url === '/fx') return send(fx.body, fx.status);
      const currency = secret === 'sk_usd' ? 'USD' : 'KRW';
      if (req.url === '/v1/payments/confirm') {
        const status = b.paymentKey.startsWith('pend') ? 'IN_PROGRESS' : 'DONE';
        payments[b.paymentKey] = { paymentKey: b.paymentKey, orderId: b.orderId, totalAmount: b.amount, currency, status };
        return send(payments[b.paymentKey]);
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/payments/')) {
        const p = payments[decodeURIComponent(req.url.split('/')[3])];
        return p ? send(p) : send({ message: '없는 결제' }, 404);
      }
      if (req.url === '/v1/billing/authorizations/issue') return send({ billingKey: `bk_${b.authKey}`, customerKey: b.customerKey });
      if (req.url.startsWith('/v1/billing/')) return send({ paymentKey: `pay_${b.orderId}`, orderId: b.orderId, totalAmount: b.amount, currency, status: 'DONE' });
      send({ status: 'CANCELED' });
    });
  });
  return { srv, calls, payments, setFx: (v) => (fx = v) };
}

test('billing-global: 가격·환율·해외 결제(테스트 모드)·금고 보관', async (t) => {
  const toss = fakeToss();
  toss.srv.listen(0, '127.0.0.1');
  await once(toss.srv, 'listening');
  const s = await startServer();
  t.after(async () => {
    await s.close();
    toss.srv.close();
  });
  const db = s.db;
  const ctx = s.ctx;
  const base = `http://127.0.0.1:${toss.srv.address().port}`;
  const user = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const as = (u) => client(s.url, sessionFor(db, u.id));
  const overseas = (region = 'US') => {
    const u = createUser(db);
    db.prepare('UPDATE users SET region=? WHERE id=?').run(region, u.id);
    return user(u.id);
  };
  const price = (body, id) => body.products.find((p) => p.id === id);

  await t.test('[Q-3] 국내 가격은 PikPak 2026-11-13 원화가, 지역 등급은 절반(100원 단위)', async () => {
    const r = (await as(createUser(db)).get('/api/billing/products')).body;
    assert.equal(r.currency, 'KRW');
    assert.equal(r.fx, null);
    assert.deepEqual(r.methods, ['card']);
    const want = { sub_month: [6254, 9587], sub_year: [62389, 101591], once_month: [10120, 10120], once_year: [69323, 69323] };
    for (const [id, [payNow, regular]] of Object.entries(want)) assert.deepEqual([price(r, id).payNow, price(r, id).price], [payNow, regular], id);
    const reg = (await as(createUser(db, { tier: 'regional' })).get('/api/billing/products')).body;
    assert.deepEqual(['sub_month', 'sub_year', 'once_month', 'once_year'].map((id) => price(reg, id).payNow), [3100, 31200, 5100, 34700]);
    assert.equal(PRODUCTS.find((p) => p.id === 'storage_10tb_year').price.global, 59000); // 추가 상품은 그대로
  });

  await t.test('[Q-2] 해외 사용자는 달러: 원화 ÷ 환율(센트 반올림), 환율이 없으면 기본값, 하루 한 번 받아 온 환율과 기준일 표시', async () => {
    assert.deepEqual([currencyOf('KR'), currencyOf('US'), currencyOf('JP'), currencyOf(null)], ['KRW', 'USD', 'USD', 'KRW']);
    assert.deepEqual(fxOf(ctx), { rate: 1450, date: null });
    const u = overseas();
    let r = (await as(u).get('/api/billing/products')).body;
    assert.equal(r.currency, 'USD');
    assert.deepEqual(r.methods, ['card', 'paypal', 'alipay', 'unionpay']);
    assert.equal(price(r, 'sub_month').payNow, 431); // 6254 / 1450 = 4.313 → $4.31
    // 받아 오기 실패(HTTP 오류·이상한 값)는 저장하지 않는다
    toss.setFx({ status: 500, body: {} });
    await assert.rejects(refreshFx(ctx, `${base}/fx`));
    toss.setFx({ status: 200, body: { rates: { KRW: 3 } } });
    await assert.rejects(refreshFx(ctx, `${base}/fx`));
    assert.equal(fxOf(ctx).date, null);
    toss.setFx({ status: 200, body: { result: 'success', time_last_update_unix: NOV13, rates: { KRW: 1400 } } });
    assert.deepEqual(await refreshFx(ctx, `${base}/fx`), { rate: 1400, date: '2026-11-13' });
    r = (await as(u).get('/api/billing/products')).body;
    assert.deepEqual(r.fx, { rate: 1400, date: '2026-11-13' });
    assert.equal(price(r, 'sub_month').payNow, 447); // 6254 / 1400 = 4.467 → $4.47
    assert.equal(price(r, 'sub_month').price, 685);
    assert.equal(price(r, 'once_year').payNow, 4952);
    assert.equal(r.compare.tier.at(-1).global[1], '$6.85');
    // 로그인 전에는 요청 지역(기기 언어)으로 통화를 정한다
    const anon = (await client(s.url).get('/api/billing/products', { 'accept-language': 'en-US,en;q=0.9' })).body;
    assert.equal(anon.currency, 'USD');
    assert.equal((await client(s.url).get('/api/billing/products', { 'accept-language': 'ko-KR' })).body.currency, 'KRW');
  });

  await t.test('[Q-4] 테스트 모드 달러 결제: 센트로 저장, PayPal 구독 갱신도 달러, 국내 사용자는 해외 수단 불가', async () => {
    const u = overseas('DE');
    const c = as(u);
    assert.equal((await as(createUser(db)).post('/api/billing/orders', { productId: 'once_month', method: 'paypal' })).status, 400);
    const o = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'paypal' })).body;
    assert.deepEqual([o.testMode, o.currency, o.amount, o.customerKey], [true, 'USD', 447, null]);
    assert.equal((await c.post(`/api/billing/orders/${o.orderId}/confirm`, { result: 'success' })).body.status, 'paid');
    assert.ok(isPremium(user(u.id)));
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind='payment' AND body LIKE '%$4.47%'").get(u.id));
    const items = (await c.get('/api/billing/orders')).body.items;
    assert.deepEqual([items[0].currency, items[0].amount], ['USD', 447]);
    const sub = (await c.get('/api/billing/subscriptions')).body.items[0];
    assert.deepEqual([sub.currency, sub.renewPrice], ['USD', 685]);
    await runRenewals(ctx, db.prepare('SELECT next_charge_at FROM billing_subscriptions WHERE user_id=?').get(u.id).next_charge_at + 1);
    const renewal = db.prepare('SELECT * FROM billing_orders WHERE user_id=? AND renewal=1').get(u.id);
    assert.deepEqual([renewal.currency, renewal.amount, renewal.method, renewal.status], ['USD', 685, 'paypal', 'paid']);
    // Alipay·UnionPay 1회권
    for (const method of ['alipay', 'unionpay']) {
      const x = (await c.post('/api/billing/orders', { productId: 'once_month', method })).body;
      assert.equal((await c.post(`/api/billing/orders/${x.orderId}/confirm`, { result: 'success' })).status, 200, method);
    }
    // 관리자 매출은 통화별로 따로
    const A = as(createUser(db, { admin: true }));
    const st = (await A.get('/api/admin/billing/stats')).body;
    assert.ok(st.revenueUsd.total >= 447 + 685 + 723 * 2);
    assert.equal(st.revenue.total, 0);
    const list = (await A.get('/api/admin/billing/orders')).body.items;
    assert.ok(list.every((x) => x.currency === 'USD'));
    // 환불 알림도 달러로
    assert.equal((await A.post(`/api/admin/billing/orders/${o.orderId}/refund`, {})).status, 200);
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE '%환불%' AND body LIKE '%$4.47%'").get(u.id));
    // 삭제 회원 보관 기록도 통화를 남긴다
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    assert.equal(db.prepare('SELECT currency FROM billing_orders_archive WHERE id=?').get(o.orderId).currency, 'USD');
    assert.deepEqual([money(447, 'USD'), money(6254, 'KRW'), money(6254, 'KRW', true)], ['$4.47', '₩6,254', '₩6,254']);
  });

  await t.test('[Q-10] 프리미엄이 끝나도 금고 파일은 용량 초과 계산·삭제에서 빠지고 그대로 남는다', async () => {
    const t0 = now();
    // 드라이브는 무료 용량 안, 금고만 크다 → 1단계(만료 안내)만
    const a = createUser(db);
    db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(t0 - DAY, a.id);
    createFileNode(db, a.id, null, { name: 'doc.pdf', size: 1 * GB });
    const av = createFileNode(db, a.id, null, { name: 'secret.mkv', size: 50 * GB, space: 'vault' });
    await runExpiry(ctx, t0);
    await runExpiry(ctx, t0 + 400 * DAY);
    assert.equal(json(user(a.id).settings, {}).expiryStage, 1);
    assert.ok(db.prepare('SELECT 1 FROM files WHERE id=?').get(av.id));
    // 드라이브가 초과 → 5단계 삭제는 드라이브 파일만, 금고는 한 개도 지우지 않는다
    const b = createUser(db);
    db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(t0 - DAY, b.id);
    const old = createFileNode(db, b.id, null, { name: 'old.mkv', size: 4 * GB });
    createFileNode(db, b.id, null, { name: 'new.mkv', size: 4 * GB });
    const vaultOld = createFileNode(db, b.id, null, { name: 'v-old.mkv', size: 20 * GB, space: 'vault' });
    db.prepare('UPDATE files SET updated_at=? WHERE id IN (?, ?)').run(t0 - 500 * DAY, old.id, vaultOld.id);
    for (const d of [0, 7, 120, 180, 196]) await runExpiry(ctx, t0 + d * DAY);
    assert.equal(db.prepare('SELECT 1 FROM files WHERE id=?').get(old.id), undefined);
    assert.ok(db.prepare('SELECT 1 FROM files WHERE id=?').get(vaultOld.id));
    assert.deepEqual([usage(db, b.id), usage(db, b.id, 'vault')], [4 * GB, 20 * GB]);
    assert.equal(json(user(b.id).settings, {}).expiryStage, 1);
  });
});

test('billing-global: 운영 모드 해외 결제·웹훅·빌링키 암호화', async (t) => {
  const toss = fakeToss();
  toss.srv.listen(0, '127.0.0.1');
  await once(toss.srv, 'listening');
  const s = await startServer({ dev: false, payments: {} });
  t.after(async () => {
    await s.close();
    toss.srv.close();
  });
  const db = s.db;
  const ctx = s.ctx;
  const tossApiBase = `http://127.0.0.1:${toss.srv.address().port}`;
  const user = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const as = (u) => client(s.url, sessionFor(db, u.id));
  const overseas = () => {
    const u = createUser(db);
    db.prepare("UPDATE users SET region='US' WHERE id=?").run(u.id);
    return user(u.id);
  };
  const order = (id) => db.prepare('SELECT * FROM billing_orders WHERE id=?').get(id);
  const hook = (data) => client(s.url).post('/api/billing/toss/webhook', { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-11-13T00:00:00', data });

  await t.test('[Q-4] 달러 키만 있으면 해외만 결제, 승인은 달러 키·소수 금액, 환불도 달러 키', async () => {
    s.ctx.cfg.payments = { tossSecretKeyUsd: 'sk_usd', tossClientKeyUsd: 'ck_usd', tossApiBase };
    assert.equal((await as(createUser(db)).post('/api/billing/orders', { productId: 'once_month', method: 'card' })).status, 503); // 원화 키 없음
    const kr = (await client(s.url).get('/api/billing/products', { 'accept-language': 'ko-KR' })).body;
    assert.equal(kr.available, false);
    const u = overseas();
    const c = as(u);
    const p = (await c.get('/api/billing/products')).body;
    assert.deepEqual([p.available, p.testMode, p.tossClientKey, p.region], [true, false, 'ck_usd', 'US']);
    const o = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body;
    assert.deepEqual([o.testMode, o.currency, o.amount, o.customerKey], [false, 'USD', 431, null]); // 해외 카드는 빌링키 없음
    const ok = await c.post(`/api/billing/orders/${o.orderId}/confirm`, { paymentKey: 'pk_us1' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([toss.calls.at(-1).path, toss.calls.at(-1).secret, toss.calls.at(-1).body.amount], ['/v1/payments/confirm', 'sk_usd', 4.31]);
    assert.ok(isPremium(user(u.id)));
    assert.equal(db.prepare('SELECT auto_renew FROM billing_subscriptions WHERE user_id=?').get(u.id).auto_renew, 0); // 1회 승인이라 기간제
    const A = as(createUser(db, { admin: true }));
    assert.equal((await A.post(`/api/admin/billing/orders/${o.orderId}/refund`, {})).status, 200);
    assert.deepEqual([toss.calls.at(-1).path, toss.calls.at(-1).secret], ['/v1/payments/pk_us1/cancel', 'sk_usd']);
  });

  await t.test('[Q-4] 나중에 끝나는 해외 간편결제는 웹훅으로 반영: 토스에 다시 조회, 한 번만, 위조·금액 불일치는 무시', async () => {
    const u = overseas();
    const c = as(u);
    const o = (await c.post('/api/billing/orders', { productId: 'once_month', method: 'alipay' })).body;
    const r = await c.post(`/api/billing/orders/${o.orderId}/confirm`, { paymentKey: 'pend_1' });
    assert.equal(r.body.status, 'pending');
    assert.deepEqual([order(o.orderId).status, order(o.orderId).pg_key], ['pending', 'pend_1']);
    assert.equal(isPremium(user(u.id)), false);
    // 본문만 DONE 이라고 속여도 토스 조회 결과가 진행 중이면 반영하지 않는다
    assert.equal((await hook({ paymentKey: 'pend_1', orderId: o.orderId, status: 'DONE' })).status, 200);
    assert.equal(toss.calls.at(-1).method, 'GET');
    assert.equal(toss.calls.at(-1).secret, 'sk_usd');
    assert.equal(order(o.orderId).status, 'pending');
    // 금액이 다르면 반영하지 않는다
    toss.payments.pend_1 = { ...toss.payments.pend_1, status: 'DONE', totalAmount: 0.01 };
    await hook({ paymentKey: 'pend_1', orderId: o.orderId, status: 'DONE' });
    assert.equal(order(o.orderId).status, 'pending');
    // 다른 주문의 결제 키로는 반영하지 않는다
    const other = (await c.post('/api/billing/orders', { productId: 'once_month', method: 'paypal' })).body;
    toss.payments.pend_1 = { ...toss.payments.pend_1, totalAmount: o.amount / 100 };
    await hook({ paymentKey: 'pend_1', orderId: other.orderId, status: 'DONE' });
    assert.equal(order(other.orderId).status, 'pending');
    // 토스 조회도 DONE → 반영. 같은 알림이 다시 와도 한 번만
    await hook({ paymentKey: 'pend_1', orderId: o.orderId, status: 'DONE' });
    await hook({ paymentKey: 'pend_1', orderId: o.orderId, status: 'DONE' });
    assert.equal(order(o.orderId).status, 'paid');
    assert.ok(isPremium(user(u.id)));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND kind='payment'").get(u.id).n, 1);
    // 결제사에서 취소·만료되면 실패로 닫는다
    toss.payments.pend_2 = { paymentKey: 'pend_2', orderId: other.orderId, totalAmount: other.amount / 100, currency: 'USD', status: 'EXPIRED' };
    await hook({ paymentKey: 'pend_2', orderId: other.orderId, status: 'EXPIRED' });
    assert.equal(order(other.orderId).status, 'failed');
    // 모르는 이벤트·주문은 그냥 200
    assert.equal((await client(s.url).post('/api/billing/toss/webhook', { eventType: 'DEPOSIT_CALLBACK', data: {} })).status, 200);
    assert.equal((await hook({ paymentKey: 'x', orderId: 'ord_nope' })).status, 200);
  });

  await t.test('[Q-11] 빌링키는 암호화해 저장(DB 파일 어디에도 원문 없음), 청구할 때만 풀어 쓴다, 예전 평문은 시작할 때 암호화', async () => {
    s.ctx.cfg.payments = { tossSecretKey: 'sk_krw', tossSecretKeyUsd: 'sk_usd', tossApiBase };
    const u = createUser(db);
    const c = as(u);
    const o = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body;
    assert.ok(o.customerKey);
    const ok = await c.post(`/api/billing/orders/${o.orderId}/confirm`, { authKey: 'Zq9SecretAuth', customerKey: o.customerKey });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const plain = 'bk_Zq9SecretAuth';
    assert.equal(toss.calls.at(-1).path, `/v1/billing/${plain}`);
    const stored = db.prepare('SELECT billing_key FROM billing_cards WHERE user_id=?').get(u.id).billing_key;
    assert.match(stored, /^v1:[A-Za-z0-9_-]+$/);
    assert.ok(!stored.includes(plain));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const f of ['mimic.db', 'mimic.db-wal']) {
      const file = path.join(s.dataDir, f);
      if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(plain), false, f);
    }
    // 갱신 때 풀어서 청구
    const sub = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get(u.id);
    await runRenewals(ctx, sub.next_charge_at + 1000);
    assert.deepEqual([toss.calls.at(-1).path, toss.calls.at(-1).secret], [`/v1/billing/${plain}`, 'sk_krw']);
    // 같은 값도 매번 다른 암호문(무작위 IV)
    assert.notEqual(sealKey(s.cfg, plain), sealKey(s.cfg, plain));
    // 예전 평문 빌링키 → 시작할 때(upgradeSchema) 암호화하고 갱신은 원래 키로 청구
    const v = createUser(db);
    db.prepare("INSERT INTO billing_cards (user_id, billing_key, customer_key, created_at) VALUES (?, 'bk_legacyPlain', 'ck', ?)").run(v.id, now());
    upgradeSchema(db, s.cfg);
    upgradeSchema(db, s.cfg); // 두 번 불러도 다시 암호화하지 않는다
    const migrated = db.prepare('SELECT billing_key FROM billing_cards WHERE user_id=?').get(v.id).billing_key;
    assert.ok(migrated.startsWith('v1:') && !migrated.includes('bk_legacyPlain'));
    db.prepare("INSERT INTO billing_subscriptions (id, user_id, product_id, current_period_end, next_charge_at, created_at) VALUES ('sub_legacy', ?, 'sub_month', ?, ?, ?)").run(v.id, now(), now(), now());
    await runRenewals(ctx, now() + 1000);
    assert.equal(toss.calls.at(-1).path, '/v1/billing/bk_legacyPlain');
    assert.equal(db.prepare("SELECT status FROM billing_orders WHERE subscription_id='sub_legacy'").get().status, 'paid');
  });

  await t.test('[Q-4·Q-11] 달러 카드 구독은 빌링키로 청구하지 않는다(센트를 원화로 청구하는 일 방지)', async () => {
    s.ctx.cfg.payments = { tossSecretKey: 'sk_krw', tossSecretKeyUsd: 'sk_usd', tossApiBase };
    const u = createUser(db);
    const c = as(u);
    const customerKey = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body.customerKey; // 원화 주문에서 받은 키
    db.prepare("UPDATE users SET region='US' WHERE id=?").run(u.id); // 해외 전화번호 연결 등으로 지역이 바뀜
    const o = (await c.post('/api/billing/orders', { productId: 'sub_month', method: 'card' })).body;
    assert.deepEqual([o.currency, o.customerKey], ['USD', null]);
    const n = toss.calls.length;
    const r = await c.post(`/api/billing/orders/${o.orderId}/confirm`, { authKey: 'Zq9x', customerKey });
    assert.deepEqual([r.status, r.body.error], [400, 'billing_not_allowed']);
    assert.equal(toss.calls.length, n); // 토스 호출 없음(빌링키 발급·청구 모두)
    assert.equal(isPremium(user(u.id)), false);
  });

  await t.test('[Q-11] 풀 수 없는 빌링키(MIMIC_SECRET 변경)는 카드 문제로 알리지 않고 갱신을 멈춰 재구독을 안내한다', async () => {
    const u = createUser(db);
    db.prepare("INSERT INTO billing_cards (user_id, billing_key, customer_key, created_at) VALUES (?, 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'ck', ?)").run(u.id, now());
    db.prepare("INSERT INTO billing_subscriptions (id, user_id, product_id, current_period_end, next_charge_at, reminded_for, created_at) VALUES ('sub_badkey', ?, 'sub_month', ?, ?, ?, ?)").run(u.id, now(), now(), now(), now());
    const n = toss.calls.length;
    await runRenewals(ctx, now() + 1000);
    assert.equal(toss.calls.length, n);
    assert.equal(db.prepare("SELECT auto_renew FROM billing_subscriptions WHERE id='sub_badkey'").get().auto_renew, 0);
    assert.equal(db.prepare("SELECT status FROM billing_orders WHERE subscription_id='sub_badkey'").get().status, 'failed');
    const titles = db.prepare('SELECT title FROM notifications WHERE user_id=?').all(u.id).map((x) => x.title);
    assert.deepEqual(titles, ['구독을 자동으로 갱신하지 못했습니다']);
  });
});
