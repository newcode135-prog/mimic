// PayPal 직접 결제(provider=paypal). 1회 결제는 Orders v2(승인 → 서버 캡처), 구독은 Subscriptions(PayPal 이 자동 청구).
// 웹훅 본문은 믿지 않는다: 알림을 받으면 PayPal API 로 다시 조회한 결과만 반영한다(서명 검증 대신, 토스 웹훅과 같은 방식).
// 키(PAYPAL_CLIENT_ID·PAYPAL_CLIENT_SECRET)는 로그·응답에 남기지 않는다.
import { fail } from '../../core/util.js';

const tokens = new Map(); // clientId → { token, exp }

const base = (cfg) => cfg.payments.paypalApiBase;
export const paypalLive = (cfg) => !!(cfg.payments?.paypalClientId && cfg.payments?.paypalSecret);

async function accessToken(cfg) {
  const { paypalClientId: id, paypalSecret: secret } = cfg.payments;
  const hit = tokens.get(id);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await fetch(base(cfg) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) fail(502, 'payment_failed', 'PayPal 에 연결하지 못했습니다');
  tokens.set(id, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 300) * 1000 });
  return j.access_token;
}

// body 가 없으면 GET. requestId: 같은 요청을 다시 보내도 한 번만 처리되게(PayPal-Request-Id)
export async function paypal(cfg, path, body, { requestId, method } = {}) {
  const r = await fetch(base(cfg) + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      authorization: 'Bearer ' + (await accessToken(cfg)),
      'content-type': 'application/json',
      prefer: 'return=representation',
      ...(requestId ? { 'paypal-request-id': requestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const why = data?.details?.[0]?.issue || data?.name || `HTTP ${r.status}`;
    fail(402, 'payment_failed', `PayPal 요청에 실패했습니다(${why})`);
  }
  return data;
}

export const usd = (cents) => (cents / 100).toFixed(2);
export const cents = (v) => Math.round(Number(v) * 100);
export const linkOf = (data, ...rels) => data?.links?.find((l) => rels.includes(l.rel))?.href || null;

// 상품 1개 + (상품·등급·첫 할인·가격)마다 요금제 1개를 처음 쓸 때 만들고 billing_meta 에 기억한다.
// 가격이 바뀌면 키가 달라져 새 요금제를 만든다(이미 구독 중인 사람은 예전 요금제 그대로)
export async function ensurePlan(ctx, { product, tier, first, regular, intro }) {
  const { db, cfg } = ctx;
  const meta = (k) => db.prepare('SELECT v FROM billing_meta WHERE k=?').get(k)?.v;
  const save = (k, v) => db.prepare('INSERT INTO billing_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
  const key = `paypal_plan:${product.id}:${tier}:${first ? intro : 0}:${regular}`;
  const known = meta(key);
  if (known) return known;
  let pid = meta('paypal_product');
  if (!pid) {
    pid = (await paypal(cfg, '/v1/catalogs/products', { name: 'Mimic Premium', type: 'SERVICE', category: 'SOFTWARE' }, { requestId: `mimic-product-${cfg.payments.paypalClientId?.slice(-8)}` })).id;
    if (!pid) fail(502, 'payment_failed', 'PayPal 상품을 만들지 못했습니다');
    save('paypal_product', pid);
  }
  // 미믹의 기간과 같게 일 단위(월 = 30일, 연 = 365일)로 청구한다
  const frequency = { interval_unit: 'DAY', interval_count: product.months === 12 ? 365 : product.months * 30 };
  const cycle = (tenure_type, sequence, total_cycles, value) => ({ frequency, tenure_type, sequence, total_cycles, pricing_scheme: { fixed_price: { value: usd(value), currency_code: 'USD' } } });
  const plan = await paypal(
    cfg,
    '/v1/billing/plans',
    {
      product_id: pid,
      name: `Mimic ${product.labelEn || product.id} (${tier}${first ? ', intro' : ''})`,
      status: 'ACTIVE',
      billing_cycles: first ? [cycle('TRIAL', 1, 1, intro), cycle('REGULAR', 2, 0, regular)] : [cycle('REGULAR', 1, 0, regular)],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    },
    { requestId: `mimic-${key}`.slice(0, 108) },
  );
  if (!plan.id) fail(502, 'payment_failed', 'PayPal 요금제를 만들지 못했습니다');
  save(key, plan.id);
  return plan.id;
}
