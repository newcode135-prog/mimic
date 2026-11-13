// 결제·혜택·전송 쿼터 모듈(I-01~I-06, F-01~F-05, 만료 5단계, 환불). 규칙: docs/MIMIC_PLAN.md 8장.
import crypto from 'node:crypto';
import { now, newId, sha256, fail, rateLimit, periodKeys, DAY } from '../../core/util.js';
import { requireUser, requireAdmin, requireScope, saveSettings, getSettings } from '../../core/auth.js';
import { tx } from '../../core/db.js';
import { notify, sendMessage, audit } from '../../core/notify.js';
import { usage } from '../../core/files.js';
import * as quota from '../../core/quota.js';
import {
  PRODUCTS, PAYMENT_METHODS, REFERRAL, EXPIRY, CHECKIN, LIMITS, MONTHLY_QUOTA, APP_QUOTA_SHARE, FREE_APP_DAILY_DOWN, SPEED_BPS,
  TRIAL_REMIND_DAYS, RENEW_REMIND_DAYS, RENEW_RETRIES, ORDER_KEEP_DAYS, GB, TB, MB, isPremium, capacityOf, productDays,
} from '../../core/plans.js';

export const migrations = `
CREATE TABLE IF NOT EXISTS billing_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- subscription | once | addon_storage | addon_quota
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,                  -- 원화, 서버가 계산
  first_discount INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed | refund_requested | refunded
  test_mode INTEGER NOT NULL DEFAULT 1,
  renewal INTEGER NOT NULL DEFAULT 0,
  subscription_id TEXT,
  pg_key TEXT,
  refund_reason TEXT,
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  refunded_at INTEGER
);
CREATE INDEX IF NOT EXISTS billing_orders_user ON billing_orders(user_id, created_at);
-- 회원이 삭제되면 주문은 CASCADE 로 지워지므로, 지우기 직전에 결제 기록을 따로 보관한다(K-06, 전자상거래법 5년).
-- 보관 기간이 지나면 billing:archive-purge 작업이 지운다
CREATE TABLE IF NOT EXISTS billing_orders_archive (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_email TEXT,
  user_phone TEXT,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  first_discount INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 1,
  renewal INTEGER NOT NULL DEFAULT 0,
  subscription_id TEXT,
  pg_key TEXT,
  refund_reason TEXT,
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  refunded_at INTEGER,
  archived_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS billing_orders_keep BEFORE DELETE ON users BEGIN
  INSERT OR IGNORE INTO billing_orders_archive (id, user_id, user_email, user_phone, product_id, kind, method, amount, first_discount, days, status, test_mode, renewal, subscription_id, pg_key, refund_reason, admin_note, created_at, paid_at, refunded_at, archived_at)
    SELECT id, user_id, OLD.email, OLD.phone, product_id, kind, method, amount, first_discount, days, status, test_mode, renewal, subscription_id, pg_key, refund_reason, admin_note, created_at, paid_at, refunded_at, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM billing_orders WHERE user_id = OLD.id AND status != 'pending';
END;
-- 운영(토스) 자동 결제 카드. 빌링키는 결제사 비밀 키와 함께일 때만 쓸 수 있고, 갱신 때 원문이 필요해 해시하지 않는다
CREATE TABLE IF NOT EXISTS billing_cards (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  billing_key TEXT NOT NULL,
  customer_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',    -- active | canceled(환불) | ended
  auto_renew INTEGER NOT NULL DEFAULT 1,
  current_period_end INTEGER NOT NULL,
  next_charge_at INTEGER,
  reminded_for INTEGER,                     -- 갱신 안내를 보낸 next_charge_at
  created_at INTEGER NOT NULL,
  canceled_at INTEGER
);
CREATE INDEX IF NOT EXISTS billing_subs_user ON billing_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS billing_addons (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS billing_coupons (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,           -- 코드 원문은 발급 때 한 번만 보여 준다
  hint TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- paid | trial | free
  days INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  batch TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES billing_coupons(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  days INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  reminded_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (coupon_id, user_id)
);
CREATE TABLE IF NOT EXISTS billing_invites (
  invitee_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL,                        -- signup | code
  month TEXT NOT NULL,                      -- 초대가 맺어진 달(KST)
  suspicious INTEGER NOT NULL DEFAULT 0,    -- 0 정상, 1 같은 기기 의심(보상 보류·관리자 검토 대기), 2 관리자가 부정 참여로 판정(보상 회수)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_invites_inviter ON billing_invites(inviter_id);
CREATE TABLE IF NOT EXISTS billing_referral_rewards (
  id TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                     -- 주문 id 또는 쿠폰 사용 id
  purchase_days INTEGER NOT NULL,
  reward_days INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_rewards_inviter ON billing_referral_rewards(inviter_id);
CREATE TABLE IF NOT EXISTS billing_pro_applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  audience TEXT NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  note TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS billing_checkins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                        -- KST 'd:2026-11-13'
  streak INTEGER NOT NULL,
  reward_days INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
`;

// ---------- 공통 ----------
const KST = 9 * 3600_000;
const MONTH = 30 * DAY;
const productById = (id) => PRODUCTS.find((p) => p.id === id);
const tierOf = (u) => (u?.tier === 'regional' ? 'regional' : 'global');
// 결제 방식: 토스 운영 키가 있으면 live, 키 없는 개발 모드만 test, 운영 모드인데 키가 없으면 null(결제 받지 않음)
const payMode = (cfg) => (cfg.payments?.tossSecretKey ? 'live' : cfg.dev ? 'test' : null);
const testModeOf = (cfg) => payMode(cfg) === 'test';
// KST 기준 달의 시작 시각. add 개월 뒤
export function monthStart(t, add = 0) {
  const d = new Date(t + KST);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1) - KST;
}
const monthKey = (t, add = 0) => periodKeys(monthStart(t, add)).month;
const userById = (db, id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
// 탈퇴 유예·삭제·잠금 계정은 자동 결제·갱신 안내를 하지 않는다(H-02). 유예 중 로그인해 되살리면 다음 작업 때 다시 갱신한다
const OFF_STATUS = "('pending_delete','deleted','locked')";
// 토스 자동 결제 구매자 키: 사용자마다 고정이고 추측할 수 없게 서버 비밀값으로 만든다(영문·숫자 40자)
const customerKeyOf = (cfg, userId) => sha256(`${cfg.secret}:toss-customer:${userId}`).slice(0, 40);
const cardOf = (db, userId) => db.prepare('SELECT * FROM billing_cards WHERE user_id=?').get(userId);
const mask = (s) => (s ? String(s).slice(0, 2) + '***' : '***');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const daysEn = (n) => `${n} day${n === 1 ? '' : 's'}`;

// titleEn·bodyEn: 영어 사용자용(K-03). 이메일도 계정 언어가 영어면 영어로 보낸다
function tell(ctx, userId, { kind, title, body = '', link = null, titleEn = null, bodyEn = null, email = false }) {
  notify(ctx.db, userId, { kind, title, body, link, titleEn, bodyEn });
  const u = email && userById(ctx.db, userId);
  if (!u?.email) return;
  const en = u.lang === 'en';
  sendMessage(ctx.db, ctx.cfg, { channel: 'email', to: u.email, subject: en ? `[Mimic] ${titleEn || title}` : `[미믹] ${title}`, body: (en && bodyEn) || body });
}

// 프리미엄 연장. 남은 기간 뒤에 이어 붙이고, 만료 처리 단계는 없앤다
export function extendPremium(db, userId, days, t = now()) {
  const u = userById(db, userId);
  const until = Math.max(t, u.premium_until || 0) + days * DAY;
  db.prepare('UPDATE users SET premium_until=?, premium_expired_at=NULL WHERE id=?').run(until, userId);
  const s = getSettings(u);
  if (s.expiryStage != null || s.overSince != null || s.expiryDeleteAt != null) {
    saveSettings(db, userId, { expiryStage: undefined, overSince: undefined, expiryDeleteAt: undefined });
  }
  return until;
}
// 1회 상품·쿠폰: 구독 중이면 멤버십 기간을 늘리고 다음 결제일도 그만큼 미룬다
function extendMembership(db, userId, days, t) {
  const until = extendPremium(db, userId, days, t);
  db.prepare("UPDATE billing_subscriptions SET current_period_end=current_period_end+?, next_charge_at=next_charge_at+? WHERE user_id=? AND status='active'").run(days * DAY, days * DAY, userId);
  return until;
}

function orderApi(o) {
  const p = productById(o.product_id);
  return {
    id: o.id, productId: o.product_id, label: p?.label || o.product_id, labelEn: p?.labelEn, kind: o.kind, method: o.method, amount: o.amount,
    firstDiscount: !!o.first_discount, days: o.days, status: o.status, testMode: !!o.test_mode, renewal: !!o.renewal,
    refundReason: o.refund_reason, adminNote: o.admin_note, createdAt: o.created_at, paidAt: o.paid_at, refundedAt: o.refunded_at,
  };
}
function subApi(s, tier) {
  const p = productById(s.product_id);
  return {
    id: s.id, productId: s.product_id, label: p?.label, labelEn: p?.labelEn, months: p?.months, status: s.status, autoRenew: !!s.auto_renew,
    currentPeriodEnd: s.current_period_end, nextChargeAt: s.auto_renew ? s.next_charge_at : null, renewPrice: p?.price[tier], createdAt: s.created_at, canceledAt: s.canceled_at,
  };
}

// ---------- 혜택 비교표(8-1, 8-2) ----------
const fmt = (n) => (n >= TB ? `${+(n / TB).toFixed(1)}TB` : `${Math.round(n / GB)}GB`);
function compareTables() {
  const F = LIMITS.free;
  const P = LIMITS.premium;
  const q = `${fmt(MONTHLY_QUOTA.cloud)} · ${fmt(MONTHLY_QUOTA.down)} · ${fmt(MONTHLY_QUOTA.up)}`;
  const yes = ['제공', 'Included'];
  const no = ['없음', 'No'];
  return {
    premium: [
      { item: ['저장공간', 'Storage'], free: [fmt(F.storage), fmt(F.storage)], premium: [fmt(P.storage), fmt(P.storage)] },
      { item: ['클라우드 다운로드 횟수', 'Cloud downloads'], free: [`하루 ${F.cloudPerDay}회 (+가입 보너스 2회)`, `${F.cloudPerDay}/day (+2 signup bonus)`], premium: ['무제한', 'Unlimited'] },
      { item: ['전송 쿼터', 'Transfer quota'], free: [`월 쿼터 + 다운로드 하루 ${fmt(F.dailyDown)}`, `Monthly quota + ${fmt(F.dailyDown)}/day download`], premium: [`월 클라우드·다운스트림·업로드 ${q}`, `Monthly cloud · down · up ${q}`] },
      { item: ['금고', 'Vault'], free: no, premium: yes },
      { item: ['영상 화질', 'Video quality'], free: [F.playback, F.playback], premium: ['원본', 'Original'] },
      { item: ['고속 다운로드', 'Fast download'], free: no, premium: yes },
      { item: ['동시 다운로드 작업', 'Concurrent tasks'], free: [`${F.concurrentTasks}개`, `${F.concurrentTasks}`], premium: [`${P.concurrentTasks}개`, `${P.concurrentTasks}`] },
      { item: ['온라인 압축 해제', 'Online unzip'], free: no, premium: yes },
      { item: ['WebDAV', 'WebDAV'], free: no, premium: yes },
      { item: ['광고', 'Ads'], free: ['있음', 'Yes'], premium: no },
    ],
    tier: [
      { item: ['대상 지역', 'Regions'], global: ['전 세계(일부 제외)·선진국', 'Worldwide (some excluded)'], regional: ['개발도상국(일부 제외)', 'Developing regions (some excluded)'] },
      { item: ['연결당 다운로드 속도', 'Speed per connection'], global: [`${SPEED_BPS.global / MB}MB/s`, `${SPEED_BPS.global / MB}MB/s`], regional: [`${SPEED_BPS.regional / MB}MB/s`, `${SPEED_BPS.regional / MB}MB/s`] },
      { item: ['고비트레이트 영상', 'High-bitrate video'], global: ['변환본·원본 선택', 'Transcoded or original'], regional: ['변환본만', 'Transcoded only'] },
      {
        item: ['월 구독 가격', 'Monthly price'],
        global: [`₩${productById('sub_month').price.global.toLocaleString('ko-KR')}`, `₩${productById('sub_month').price.global.toLocaleString('en-US')}`],
        regional: [`₩${productById('sub_month').price.regional.toLocaleString('ko-KR')}`, `₩${productById('sub_month').price.regional.toLocaleString('en-US')}`],
      },
    ],
  };
}

// ---------- 토스페이먼츠(운영 키가 있을 때만). tossApiBase 는 테스트용 로컬 서버 주소 ----------
async function toss(cfg, path, body) {
  const r = await fetch((cfg.payments.tossApiBase || 'https://api.tosspayments.com') + path, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(cfg.payments.tossSecretKey + ':').toString('base64'), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) fail(402, 'payment_failed', data.message || '결제사 요청에 실패했습니다');
  return data;
}
async function tossConfirm(cfg, { paymentKey, orderId, amount }) {
  const data = await toss(cfg, '/v1/payments/confirm', { paymentKey, orderId, amount });
  if (Number(data.totalAmount) !== amount) fail(402, 'amount_mismatch', '결제 금액이 주문과 다릅니다');
  return data;
}
const tossCancel = (cfg, paymentKey, cancelReason) => toss(cfg, `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason });
// 빌링키로 청구하고 paymentKey 를 돌려준다. 청구액이 주문과 다르면 바로 취소한다
async function tossBillingPay(cfg, card, o) {
  const data = await toss(cfg, `/v1/billing/${encodeURIComponent(card.billing_key)}`, { customerKey: card.customer_key, amount: o.amount, orderId: o.id, orderName: productById(o.product_id).label });
  if (Number(data.totalAmount) !== o.amount) {
    await tossCancel(cfg, data.paymentKey, '결제 금액 불일치').catch((x) => console.error('[billing] 결제 취소 실패', o.id, x.message));
    fail(402, 'amount_mismatch', '결제 금액이 주문과 다릅니다');
  }
  return data.paymentKey;
}

// ---------- 주문 ----------
// 첫 구독 할인은 사용자당 한 번(8-5): 어떤 구독이든 한 번 했으면 월·연 모두 정가
function hasSubscribed(db, userId) {
  return !!db.prepare('SELECT 1 FROM billing_subscriptions WHERE user_id=? LIMIT 1').get(userId);
}
const autoRenewing = (db, userId) => db.prepare("SELECT 1 FROM billing_subscriptions WHERE user_id=? AND status='active' AND auto_renew=1").get(userId);
const isNewSubscription = (o) => o.kind === 'subscription' && !o.renewal;
// 주문할 때, 돈을 받기 전, 반영할 때 모두 확인한다(대기 주문 여러 개를 한꺼번에 확정하거나 그사이 프리미엄이 끝난 경우)
function assertCanApply(db, o, t = now()) {
  if (isNewSubscription(o)) {
    if (autoRenewing(db, o.user_id)) fail(409, 'already_subscribed', '이미 자동 갱신 중인 구독이 있습니다. 구독 관리에서 자동 갱신을 끈 뒤 다시 시도해 주세요');
    if (o.first_discount && hasSubscribed(db, o.user_id)) fail(409, 'discount_used', '첫 구독 할인은 한 번만 받을 수 있습니다. 다시 주문해 주세요');
  }
  if (o.kind === 'addon_storage' && !isPremium(userById(db, o.user_id), t)) fail(403, 'premium_required', '추가 저장공간은 프리미엄 회원만 구매할 수 있습니다');
}
function priceFor(db, user, p) {
  const tier = tierOf(user);
  const first = p.kind === 'subscription' && !!p.firstPrice && !(user && hasSubscribed(db, user.id));
  return { amount: first ? p.firstPrice[tier] : p.price[tier], first };
}

export function createOrder(ctx, user, productId, method, { renewalOf = null, t = now() } = {}) {
  const { db, cfg } = ctx;
  const p = productById(productId);
  if (!p) fail(400, 'invalid_product', '없는 상품입니다');
  if (!PAYMENT_METHODS.includes(method)) fail(400, 'invalid_method', '지원하지 않는 결제 수단입니다');
  if (!payMode(cfg)) fail(503, 'payments_unavailable', '지금은 결제를 받을 수 없습니다. 잠시 뒤 다시 시도해 주세요');
  let amount;
  let first = false;
  if (renewalOf) amount = p.price[tierOf(user)]; // 갱신은 정가
  else {
    assertCanApply(db, { user_id: user.id, kind: p.kind }, t);
    ({ amount, first } = priceFor(db, user, p));
  }
  const id = newId('ord_');
  db.prepare(
    'INSERT INTO billing_orders (id, user_id, product_id, kind, method, amount, first_discount, days, test_mode, renewal, subscription_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, user.id, p.id, p.kind, method, amount, first ? 1 : 0, productDays(p), testModeOf(cfg) ? 1 : 0, renewalOf ? 1 : 0, renewalOf, t);
  return db.prepare('SELECT * FROM billing_orders WHERE id=?').get(id);
}

// 결제 성공을 반영한다(구독·1회·추가 저장공간·추가 쿼터). card: 운영 결제에서 새로 받은 자동 결제 카드(빌링키)
export function applyOrder(ctx, order, t = now(), card = null) {
  const { db } = ctx;
  const p = productById(order.product_id);
  const uid = order.user_id;
  tx(db, () => {
    if (db.prepare("UPDATE billing_orders SET status='paid', paid_at=? WHERE id=? AND status='pending'").run(t, order.id).changes !== 1) {
      fail(409, 'order_closed', '이미 처리된 주문입니다');
    }
    assertCanApply(db, order, t);
    if (p.kind === 'subscription') {
      const until = extendPremium(db, uid, order.days, t);
      if (order.subscription_id) {
        db.prepare('UPDATE billing_subscriptions SET current_period_end=?, next_charge_at=? WHERE id=?').run(until, until, order.subscription_id);
      } else {
        const sid = newId('sub_');
        // 운영(토스) 결제는 카드 빌링키를 받은 구독만 자동 갱신한다. 1회 승인(PayPal 등)으로 산 구독은 기간제(auto_renew=0)
        if (card) {
          db.prepare('INSERT INTO billing_cards (user_id, billing_key, customer_key, created_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET billing_key=excluded.billing_key, customer_key=excluded.customer_key, created_at=excluded.created_at').run(uid, card.billing_key, card.customer_key, t);
        }
        db.prepare('INSERT INTO billing_subscriptions (id, user_id, product_id, auto_renew, current_period_end, next_charge_at, created_at) VALUES (?,?,?,?,?,?,?)').run(sid, uid, p.id, order.test_mode || card ? 1 : 0, until, until, t);
        db.prepare('UPDATE billing_orders SET subscription_id=? WHERE id=?').run(sid, order.id);
      }
    } else if (p.kind === 'once') {
      extendMembership(db, uid, order.days, t);
    } else if (p.kind === 'addon_storage') {
      db.prepare('UPDATE users SET extra_storage_bytes=extra_storage_bytes+? WHERE id=?').run(p.bytes, uid);
      db.prepare('INSERT INTO billing_addons (id, user_id, order_id, product_id, bytes, valid_from, valid_to) VALUES (?,?,?,?,?,?,?)').run(newId('ad_'), uid, order.id, p.id, p.bytes, t, t + order.days * DAY);
    } else if (p.kind === 'addon_quota') {
      // 1개월권: 구매한 달만, 1년권: 12개월 각각 그 달에만 유효
      for (let i = 0; i < p.months; i++) {
        for (const [kind, amount] of Object.entries(p.amounts)) quota.grant(db, uid, { kind, amount, period: monthKey(t, i), validFrom: t, reason: `order:${order.id}` });
      }
    }
  });
  if (p.kind === 'subscription' || p.kind === 'once') rewardInviter(ctx, uid, order.days, order.id, t);
  tell(ctx, uid, {
    kind: 'payment',
    title: order.renewal ? '구독이 자동 갱신되었습니다' : '결제가 완료되었습니다',
    body: `${p.label} · ₩${order.amount.toLocaleString('ko-KR')}`,
    titleEn: order.renewal ? 'Your subscription was renewed automatically' : 'Payment complete',
    bodyEn: `${p.labelEn || p.label} · ₩${order.amount.toLocaleString('en-US')}`,
    link: '/drive/orders',
  });
  ctx.events?.emit('payment:completed', { userId: uid, orderId: order.id, productId: p.id, days: order.days });
  return db.prepare('SELECT * FROM billing_orders WHERE id=?').get(order.id);
}

// 프리미엄 기간을 days 만큼 줄인다. 지금보다 앞으로는 당기지 않는다
function shortenPremium(db, userId, days, t) {
  const u = userById(db, userId);
  const left = Math.max(0, (u.premium_until || 0) - t);
  const until = (u.premium_until || t) - Math.min(days * DAY, left);
  db.prepare('UPDATE users SET premium_until=? WHERE id=?').run(until, userId);
  return until;
}

// 남은 기간 회수(환불). 이 주문으로 초대자에게 준 보상도 거둔다(8-8)
function revokeOrder(ctx, o, t = now()) {
  const { db } = ctx;
  const p = productById(o.product_id);
  if (p.kind === 'subscription' || p.kind === 'once') {
    const until = shortenPremium(db, o.user_id, o.days, t);
    if (o.subscription_id) {
      db.prepare("UPDATE billing_subscriptions SET status='canceled', auto_renew=0, canceled_at=?, current_period_end=? WHERE id=? AND user_id=?").run(t, until, o.subscription_id, o.user_id);
    } else {
      db.prepare("UPDATE billing_subscriptions SET current_period_end=MAX(?, current_period_end-?), next_charge_at=MAX(?, next_charge_at-?) WHERE user_id=? AND status='active'").run(t, o.days * DAY, t, o.days * DAY, o.user_id);
    }
    for (const r of db.prepare('SELECT * FROM billing_referral_rewards WHERE source=?').all(o.id)) {
      db.prepare('DELETE FROM billing_referral_rewards WHERE id=?').run(r.id);
      if (r.reward_days) {
        shortenPremium(db, r.inviter_id, r.reward_days, t);
        tell(ctx, r.inviter_id, {
          kind: 'invite',
          title: `초대 보상 ${r.reward_days}일이 회수되었습니다`,
          body: '초대한 친구의 결제가 환불되어 그 결제로 받은 보상을 거두었습니다.',
          titleEn: `${daysEn(r.reward_days)} of invite reward taken back`,
          bodyEn: "The friend you invited got a refund, so the reward from that payment was taken back.",
          link: '/drive/invite',
        });
      }
      const inv = db.prepare('SELECT month FROM billing_invites WHERE invitee_id=?').get(r.invitee_id);
      if (inv) syncUploadBonus(ctx, r.inviter_id, inv.month, t);
    }
  } else if (p.kind === 'addon_storage') {
    const a = db.prepare('SELECT * FROM billing_addons WHERE order_id=? AND user_id=? AND revoked_at IS NULL').get(o.id, o.user_id);
    if (a) {
      db.prepare('UPDATE users SET extra_storage_bytes=MAX(0, extra_storage_bytes-?) WHERE id=?').run(a.bytes, o.user_id);
      db.prepare('UPDATE billing_addons SET revoked_at=? WHERE id=?').run(t, a.id);
    }
  } else if (p.kind === 'addon_quota') {
    db.prepare('DELETE FROM quota_grants WHERE user_id=? AND reason=? AND period>=?').run(o.user_id, `order:${o.id}`, monthKey(t));
  }
}

// ---------- 초대 보상(I-04, 8-8) ----------
const sameDevice = (db, a, b) =>
  !!db
    .prepare('SELECT 1 FROM sessions a JOIN sessions b ON a.ip=b.ip AND a.user_agent=b.user_agent WHERE a.user_id=? AND b.user_id=? AND a.ip IS NOT NULL AND a.user_agent IS NOT NULL LIMIT 1')
    .get(a, b);
// 초대 링크 가입은 user:created 가 세션보다 먼저라 판정할 수 없다. 가입 직후 첫 로그인(세션 생성 뒤)에 다시 판정한다
export function recheckSignupInvite(db, inviteeId, t = now()) {
  const inv = db.prepare("SELECT inviter_id FROM billing_invites WHERE invitee_id=? AND via='signup' AND suspicious=0 AND created_at>=?").get(inviteeId, t - REFERRAL.bindHours * 3600_000);
  if (!inv || !sameDevice(db, inviteeId, inv.inviter_id)) return false;
  db.prepare('UPDATE billing_invites SET suspicious=1 WHERE invitee_id=?').run(inviteeId);
  audit(db, { userId: inviteeId, action: 'billing.invite_suspicious', detail: { inviter: inv.inviter_id } });
  return true;
}

export function bindInvite(ctx, inviteeId, code, via = 'code', t = now()) {
  const { db } = ctx;
  const invitee = userById(db, inviteeId);
  if (!invitee) fail(404, 'not_found', '사용자를 찾을 수 없습니다');
  if (invitee.invited_by) fail(409, 'already_bound', '이미 초대 관계가 있습니다');
  if (t - invitee.created_at > REFERRAL.bindHours * 3600_000) fail(403, 'bind_expired', `초대 코드는 가입 후 ${REFERRAL.bindHours}시간 안에만 등록할 수 있습니다`);
  // 미믹 코드는 대문자(ABCD2345)라 소문자·공백·하이픈을 섞어 입력해도 찾는다. 원문 일치도 허용
  const c = str(code, 64);
  const inviter = c && db.prepare('SELECT id FROM users WHERE invite_code IN (?, ?) LIMIT 1').get(c, c.toUpperCase().replace(/[\s-]/g, ''));
  if (!inviter) fail(404, 'invalid_code', '초대 코드를 찾을 수 없습니다');
  if (inviter.id === inviteeId) fail(400, 'self_invite', '내 초대 코드는 등록할 수 없습니다');
  // 같은 기기(브라우저·IP 동일) 의심이면 보상을 보류한다(8-8). 가입 경로는 세션이 아직 없어 user:login 때 다시 본다
  const same = sameDevice(db, inviteeId, inviter.id);
  tx(db, () => {
    db.prepare('UPDATE users SET invited_by=? WHERE id=? AND invited_by IS NULL').run(inviter.id, inviteeId);
    db.prepare('INSERT INTO billing_invites (invitee_id, inviter_id, via, month, suspicious, created_at) VALUES (?,?,?,?,?,?)').run(inviteeId, inviter.id, via, periodKeys(t).month, same ? 1 : 0, t);
  });
  if (same) audit(db, { userId: inviteeId, action: 'billing.invite_suspicious', detail: { inviter: inviter.id } });
  // 가입 뒤 코드 등록 전에 한 결제·코드 등록도 "가입 1년 안 구매"라 소급해 보상한다(8-8). 이미 반영된 source 는 건너뛴다
  const past = db
    .prepare(
      `SELECT id, days, created_at AS at FROM billing_orders WHERE user_id=? AND kind IN ('subscription','once') AND status IN ('paid','refund_requested')
       UNION ALL SELECT id, days, created_at FROM billing_coupon_redemptions WHERE user_id=? AND kind!='free' ORDER BY at`,
    )
    .all(inviteeId, inviteeId);
  for (const p of past) {
    if (!db.prepare('SELECT 1 FROM billing_referral_rewards WHERE source=?').get(p.id)) rewardInviter(ctx, inviteeId, p.days, p.id, t);
  }
  return { inviterId: inviter.id, suspicious: !!same };
}

// 친구가 가입 1년 안에 산 프리미엄 일수의 35%(반올림)를 초대자에게. 누적 일수로 계산해
// 월 구독 4회(120일) → 42일, 연 구독(365일) → 128일(8-8 예시). 정수로 계산해 부동소수 오차를 피한다
const referralShare = (n) => Math.round((n * Math.round(REFERRAL.shareRate * 100)) / 100);
// 결제·쿠폰 반영 뒤에 부른다. 보상 지급이 실패해도 결제 결과는 그대로 두고 0을 돌려준다
export function rewardInviter(ctx, inviteeId, days, source, t = now()) {
  const { db } = ctx;
  try {
    return tx(db, () => {
      const invitee = userById(db, inviteeId);
      // 초대 관계는 billing_invites 기준(초대자가 탈퇴하면 CASCADE 로 사라짐. users.invited_by 는 남을 수 있음)
      const inv = db.prepare('SELECT * FROM billing_invites WHERE invitee_id=?').get(inviteeId);
      if (!invitee || !inv || !days || t - invitee.created_at > REFERRAL.windowDays * DAY) return 0;
      const inviterId = inv.inviter_id;
      const prev = Number(db.prepare('SELECT COALESCE(SUM(purchase_days),0) AS n FROM billing_referral_rewards WHERE invitee_id=?').get(inviteeId).n);
      // 같은 기기 의심 초대는 구매만 기록하고 보상은 주지 않는다(8-8 이상 데이터 걸러내기)
      const reward = inv.suspicious ? 0 : referralShare(prev + days) - referralShare(prev);
      db.prepare('INSERT INTO billing_referral_rewards (id, inviter_id, invitee_id, source, purchase_days, reward_days, created_at) VALUES (?,?,?,?,?,?,?)').run(newId('rr_'), inviterId, inviteeId, source, days, reward, t);
      if (inv.suspicious) {
        audit(db, { userId: inviterId, action: 'billing.invite_reward_held', detail: { invitee: inviteeId, source, days } });
        return 0;
      }
      if (reward > 0) {
        extendPremium(db, inviterId, reward, t);
        const who = mask(invitee.name || invitee.email);
        tell(ctx, inviterId, {
          kind: 'invite',
          title: `초대 보상으로 프리미엄 ${reward}일을 받았습니다`,
          body: `초대한 친구(${who})가 프리미엄을 구매했어요.`,
          titleEn: `You received ${daysEn(reward)} of Premium as an invite reward`,
          bodyEn: `A friend you invited (${who}) bought Premium.`,
          link: '/drive/invite',
        });
      }
      syncUploadBonus(ctx, inviterId, inv.month, t);
      return reward;
    });
  } catch (e) {
    console.error('[billing] 초대 보상 지급 실패', inviteeId, source, e.message);
    return 0;
  }
}

// 관리자 검토(8-8 "이상 데이터는 걸러내고, 부정 참여는 회수"). release: 보류한 보상을 소급 지급하고 이후 구매도 보상,
// revoke: 부정 참여로 보고 이미 준 보상을 거두며 이후 구매도 보상하지 않는다. 구매별 보상은 누적 일수로 다시 계산한다
export function reviewInvite(ctx, inviteeId, action, t = now()) {
  const { db } = ctx;
  if (action !== 'release' && action !== 'revoke') fail(400, 'invalid_action', "action 은 'release' 또는 'revoke' 입니다");
  const inv = db.prepare('SELECT * FROM billing_invites WHERE invitee_id=?').get(inviteeId) || fail(404, 'not_found', '초대 기록을 찾을 수 없습니다');
  let delta = 0;
  tx(db, () => {
    db.prepare('UPDATE billing_invites SET suspicious=? WHERE invitee_id=?').run(action === 'release' ? 0 : 2, inviteeId);
    let prev = 0;
    for (const r of db.prepare('SELECT * FROM billing_referral_rewards WHERE invitee_id=? ORDER BY created_at, rowid').all(inviteeId)) {
      const want = action === 'release' ? referralShare(prev + r.purchase_days) - referralShare(prev) : 0;
      prev += r.purchase_days;
      if (want === r.reward_days) continue;
      db.prepare('UPDATE billing_referral_rewards SET reward_days=? WHERE id=?').run(want, r.id);
      delta += want - r.reward_days;
    }
    if (delta > 0) extendPremium(db, inv.inviter_id, delta, t);
    if (delta < 0) shortenPremium(db, inv.inviter_id, -delta, t);
    syncUploadBonus(ctx, inv.inviter_id, inv.month, t);
  });
  if (delta > 0) {
    tell(ctx, inv.inviter_id, {
      kind: 'invite',
      title: `보류됐던 초대 보상 ${delta}일을 받았습니다`,
      body: '확인 결과 정상 초대로 판단되어 보류했던 보상을 지급했습니다.',
      titleEn: `You received ${daysEn(delta)} of invite reward that had been on hold`,
      bodyEn: 'After review, the invite was found to be genuine, so the reward on hold has been granted.',
      link: '/drive/invite',
    });
  }
  if (delta < 0) {
    tell(ctx, inv.inviter_id, {
      kind: 'invite',
      title: `초대 보상 ${-delta}일이 회수되었습니다`,
      body: '확인 결과 정상적인 초대로 보기 어려워 그 친구의 구매로 받은 보상을 거두었습니다.',
      titleEn: `${daysEn(-delta)} of invite reward taken back`,
      bodyEn: "After review, the invite didn't appear to be genuine, so the reward from that friend's purchases was taken back.",
      link: '/drive/invite',
    });
  }
  return { inviterId: inv.inviter_id, suspicious: action === 'release' ? 0 : 2, rewardDays: delta };
}

// 같은 달에 초대한 사람 중 구매자 10명마다 업로드 100GB(그 달 합계 최대 5TB). 환불로 구매자가 줄면 거둔다.
// 지급한 달 몫(period)으로 주고, 안 쓴 양은 carryInviteBonus 가 다음 달로 넘겨 "다음 달 말까지"를 맞춘다
function syncUploadBonus(ctx, inviterId, month, t) {
  const { db } = ctx;
  const buyers = Number(db.prepare('SELECT COUNT(DISTINCT r.invitee_id) AS n FROM billing_referral_rewards r JOIN billing_invites i ON i.invitee_id=r.invitee_id WHERE i.inviter_id=? AND i.month=? AND i.suspicious=0').get(inviterId, month).n);
  const want = Math.min(Math.floor(buyers / REFERRAL.uploadBonusEvery) * REFERRAL.uploadBonus, REFERRAL.uploadBonusMax);
  const reason = `invite_upload:${month}`;
  const rows = db.prepare('SELECT id, amount FROM quota_grants WHERE user_id=? AND reason=? ORDER BY created_at DESC').all(inviterId, reason);
  let given = rows.reduce((s, r) => s + Number(r.amount), 0);
  for (const r of rows) {
    if (given <= want) break;
    db.prepare('DELETE FROM quota_grants WHERE id=?').run(r.id);
    given -= Number(r.amount);
  }
  if (given < want) {
    quota.grant(db, inviterId, { kind: 'up', amount: want - given, period: monthKey(t), validFrom: t, validTo: monthStart(t, 2), reason });
    tell(ctx, inviterId, {
      kind: 'invite',
      title: `초대 보너스로 업로드 쿼터 ${fmt(want - given)}를 받았습니다`,
      body: '다음 달 말까지 쓸 수 있어요.',
      titleEn: `You received ${fmt(want - given)} of upload quota as an invite bonus`,
      bodyEn: 'You can use it until the end of next month.',
      link: '/drive/quota',
    });
  }
}

// 지난달 받은 초대 업로드 보너스 중 안 쓴 만큼을 이번 달로 넘긴다(보너스는 그 달 한도에서 마지막에 쓴 것으로 계산)
export function carryInviteBonus(db, t = now()) {
  const prev = monthKey(t, -1);
  const reason = `invite_carry:${prev}`;
  for (const g of db.prepare("SELECT user_id, SUM(amount) AS n FROM quota_grants WHERE kind='up' AND period=? AND reason LIKE 'invite_upload:%' GROUP BY user_id").all(prev)) {
    if (db.prepare('SELECT 1 FROM quota_grants WHERE user_id=? AND reason=?').get(g.user_id, reason)) continue;
    const used = Number(db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM quota_usage WHERE user_id=? AND period=? AND kind='up'").get(g.user_id, prev).n);
    const left = Math.min(Number(g.n), quota.monthlyLimit(db, g.user_id, 'up', monthStart(t) - 1) - used);
    if (left > 0) quota.grant(db, g.user_id, { kind: 'up', amount: left, period: monthKey(t), validFrom: monthStart(t), validTo: monthStart(t, 1), reason });
  }
}

// ---------- 쿠폰(I-03) ----------
const normCode = (c) => str(c, 64).toUpperCase().replace(/[\s-]/g, '');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  const raw = Array.from(crypto.randomBytes(16), (b) => ALPHABET[b % ALPHABET.length]).join('');
  return raw.match(/.{4}/g).join('-');
}
export function createCoupons(db, { kind, days, count = 1, maxUses = 1, expiresAt = null }, adminId = null) {
  if (!['paid', 'trial', 'free'].includes(kind)) fail(400, 'invalid_kind', '쿠폰 종류는 paid·trial·free 중 하나입니다');
  days = Number(days);
  count = Number(count);
  maxUses = Number(maxUses);
  if (!Number.isInteger(days) || days < 1 || days > 3660) fail(400, 'invalid_days', '일수는 1~3660 사이 정수입니다');
  if (!Number.isInteger(count) || count < 1 || count > 1000) fail(400, 'invalid_count', '한 번에 1~1000개까지 만들 수 있습니다');
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) fail(400, 'invalid_max_uses', '사용 가능 횟수가 올바르지 않습니다');
  const exp = expiresAt == null || expiresAt === '' ? null : Number(typeof expiresAt === 'string' && !/^\d+$/.test(expiresAt) ? Date.parse(expiresAt) : expiresAt);
  if (exp != null && !(exp > now())) fail(400, 'invalid_expires', '만료일은 지금 이후여야 합니다');
  const batch = newId('cb_');
  const codes = [];
  tx(db, () => {
    for (let i = 0; i < count; i++) {
      const code = genCode();
      db.prepare('INSERT INTO billing_coupons (id, code_hash, hint, kind, days, max_uses, expires_at, batch, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        newId('cp_'), sha256(normCode(code)), code.slice(-4), kind, days, maxUses, exp, batch, adminId, now(),
      );
      codes.push(code);
    }
  });
  return { batch, codes };
}
export function redeemCoupon(ctx, user, code, t = now()) {
  const { db } = ctx;
  const c = db.prepare('SELECT * FROM billing_coupons WHERE code_hash=?').get(sha256(normCode(code)));
  if (!c) fail(404, 'invalid_code', '등록할 수 없는 쿠폰 코드입니다');
  if (c.expires_at && c.expires_at <= t) fail(410, 'code_expired', '사용 기간이 지난 쿠폰입니다');
  if (db.prepare('SELECT 1 FROM billing_coupon_redemptions WHERE coupon_id=? AND user_id=?').get(c.id, user.id)) fail(409, 'already_redeemed', '이미 등록한 쿠폰입니다');
  if (c.used_count >= c.max_uses) fail(410, 'code_used_up', '모두 사용된 쿠폰입니다');
  const rid = newId('cr_');
  let until;
  tx(db, () => {
    if (db.prepare('UPDATE billing_coupons SET used_count=used_count+1 WHERE id=? AND used_count<max_uses').run(c.id).changes !== 1) fail(410, 'code_used_up', '모두 사용된 쿠폰입니다');
    until = extendMembership(db, user.id, c.days, t);
    db.prepare('INSERT INTO billing_coupon_redemptions (id, coupon_id, user_id, kind, days, ends_at, created_at) VALUES (?,?,?,?,?,?,?)').run(rid, c.id, user.id, c.kind, c.days, until, t);
  });
  // 유료·체험 코드는 초대 보상 대상, 무료 코드는 제외
  if (c.kind !== 'free') rewardInviter(ctx, user.id, c.days, rid, t);
  const trial = c.kind === 'trial';
  notify(db, user.id, {
    kind: 'payment',
    title: `쿠폰으로 프리미엄 ${c.days}일이 추가되었습니다`,
    body: trial ? '체험 코드는 자동 결제되지 않으며 끝나기 3일 전에 알려 드려요.' : '',
    titleEn: `${daysEn(c.days)} of Premium added with a coupon`,
    bodyEn: trial ? "Trial codes are never charged automatically, and we'll remind you 3 days before the trial ends." : '',
    link: '/drive/orders?tab=coupons',
  });
  return { days: c.days, kind: c.kind, premiumUntil: until };
}

// ---------- 출석 체크(I-06) ----------
function checkinState(db, userId, t = now()) {
  const today = periodKeys(t).day;
  const yesterday = periodKeys(t - DAY).day;
  const recent = db.prepare('SELECT day, streak, reward_days FROM billing_checkins WHERE user_id=? ORDER BY day DESC LIMIT 30').all(userId);
  const last = recent[0];
  const streak = last && (last.day === today || last.day === yesterday) ? last.streak : 0;
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM billing_checkins WHERE user_id=?').get(userId).n);
  const earned = Number(db.prepare('SELECT COALESCE(SUM(reward_days),0) AS n FROM billing_checkins WHERE user_id=?').get(userId).n);
  return {
    checkedToday: last?.day === today, streak, total, earnedDays: earned, rewardEvery: CHECKIN.rewardEvery, rewardDays: CHECKIN.rewardDays,
    nextRewardIn: CHECKIN.rewardEvery - (streak % CHECKIN.rewardEvery), recent: recent.map((r) => ({ day: r.day.slice(2), streak: r.streak, rewardDays: r.reward_days })),
  };
}
export function checkin(ctx, user, t = now()) {
  const { db } = ctx;
  const today = periodKeys(t).day;
  const last = db.prepare('SELECT day, streak FROM billing_checkins WHERE user_id=? ORDER BY day DESC LIMIT 1').get(user.id);
  if (last?.day === today) fail(409, 'already_checked_in', '오늘은 이미 출석했어요. 내일 다시 와 주세요');
  const streak = last?.day === periodKeys(t - DAY).day ? last.streak + 1 : 1;
  const reward = streak % CHECKIN.rewardEvery === 0 ? CHECKIN.rewardDays : 0;
  tx(db, () => {
    db.prepare('INSERT INTO billing_checkins (user_id, day, streak, reward_days, created_at) VALUES (?,?,?,?,?)').run(user.id, today, streak, reward, t);
    if (reward) extendPremium(db, user.id, reward, t);
  });
  if (reward) {
    notify(db, user.id, {
      kind: 'checkin',
      title: `${streak}일 연속 출석! 프리미엄 ${reward}일을 받았습니다`,
      titleEn: `${streak}-day check-in streak! You received ${daysEn(reward)} of Premium`,
      link: '/drive/orders?tab=checkin',
    });
  }
  return { ...checkinState(db, user.id, t), rewarded: reward };
}

// ---------- 정기 작업 ----------
// 갱신 안내(7일 전)·자동 결제·기간 종료·체험 코드 종료 알림
// 갱신 주문의 결제 수단: 운영은 빌링키 카드, 테스트는 이 구독을 마지막으로 결제한 수단
function renewMethod(ctx, s) {
  if (!testModeOf(ctx.cfg)) return 'card';
  const m = ctx.db.prepare("SELECT method FROM billing_orders WHERE subscription_id=? AND status IN ('paid','refund_requested') ORDER BY paid_at DESC LIMIT 1").get(s.id)?.method;
  return PAYMENT_METHODS.includes(m) ? m : 'card';
}
// 갱신 결제 실패: 하루 뒤 다시 시도하고, RENEW_RETRIES 번 연달아 실패하면 자동 갱신을 멈춘다(이번 기간 끝 이후 실패만 센다)
function renewalFailed(ctx, s, t, reason) {
  const { db } = ctx;
  const fails = Number(db.prepare("SELECT COUNT(*) AS n FROM billing_orders WHERE subscription_id=? AND renewal=1 AND status='failed' AND created_at>=?").get(s.id, s.current_period_end).n);
  const why = reason ? ` (${reason})` : '';
  if (fails >= RENEW_RETRIES) {
    db.prepare('UPDATE billing_subscriptions SET auto_renew=0 WHERE id=?').run(s.id);
    tell(ctx, s.user_id, {
      kind: 'billing',
      email: true,
      title: '구독 자동 갱신을 멈췄습니다',
      body: `결제가 ${fails}번 실패했습니다${why}. 계속 쓰려면 결제 화면에서 다시 구독해 주세요.`,
      titleEn: 'Subscription auto-renewal has been stopped',
      bodyEn: `Payment failed ${fails} times${why}. To keep using Premium, please subscribe again on the payment page.`,
      link: '/drive/payment',
    });
    return;
  }
  // 재시도 시각이 바뀌어도 7일 전 갱신 안내를 다시 보내지 않게 reminded_for 도 맞춘다
  db.prepare('UPDATE billing_subscriptions SET next_charge_at=?, reminded_for=? WHERE id=?').run(t + DAY, t + DAY, s.id);
  tell(ctx, s.user_id, {
    kind: 'billing',
    email: true,
    title: '구독 갱신 결제에 실패했습니다',
    body: `결제하지 못했습니다${why}. 내일 다시 시도하며, ${RENEW_RETRIES}번 실패하면 자동 갱신이 멈춥니다. 카드 한도·유효기간을 확인해 주세요.`,
    titleEn: 'Subscription renewal payment failed',
    bodyEn: `We couldn't charge your card${why}. We'll try again tomorrow, and auto-renewal stops after ${RENEW_RETRIES} failed attempts. Please check your card's limit and expiry date.`,
    link: '/drive/orders',
  });
}
async function renewOne(ctx, s, t) {
  const { db, cfg } = ctx;
  const u = userById(db, s.user_id);
  const card = !testModeOf(cfg) && cardOf(db, s.user_id);
  if (!testModeOf(cfg) && !card) {
    // 자동 결제 카드가 없는 운영 구독(예전 기간제 구독 등)은 갱신을 멈추고 재결제를 안내한다
    db.prepare('UPDATE billing_subscriptions SET auto_renew=0 WHERE id=?').run(s.id);
    tell(ctx, s.user_id, {
      kind: 'billing',
      email: true,
      title: '구독을 자동으로 갱신하지 못했습니다',
      body: '등록된 자동 결제 카드가 없습니다. 결제 화면에서 다시 구독해 주세요.',
      titleEn: "Your subscription couldn't be renewed automatically",
      bodyEn: 'There is no card registered for automatic payment. Please subscribe again on the payment page.',
      link: '/drive/payment',
    });
    return;
  }
  const o = createOrder(ctx, u, s.product_id, renewMethod(ctx, s), { renewalOf: s.id, t });
  if (!card) return applyOrder(ctx, o, t); // 테스트 결제는 바로 성공
  let paymentKey;
  try {
    paymentKey = await tossBillingPay(cfg, card, o);
    db.prepare('UPDATE billing_orders SET pg_key=? WHERE id=?').run(paymentKey, o.id);
    return applyOrder(ctx, o, t);
  } catch (e) {
    if (paymentKey) await tossCancel(cfg, paymentKey, '갱신 반영 실패').catch((x) => console.error('[billing] 결제 취소 실패', o.id, x.message));
    db.prepare("UPDATE billing_orders SET status='failed' WHERE id=? AND status='pending'").run(o.id);
    renewalFailed(ctx, s, t, e.status === 402 ? e.message : '');
  }
}

export async function runRenewals(ctx, t = now()) {
  const { db, cfg } = ctx;
  const subs = (where) => db.prepare(`SELECT s.* FROM billing_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.status='active' AND s.auto_renew=1 AND u.status NOT IN ${OFF_STATUS} AND ${where}`);
  for (const s of subs('s.next_charge_at>? AND s.next_charge_at<=? AND s.reminded_for IS NOT s.next_charge_at').all(t, t + RENEW_REMIND_DAYS * DAY)) {
    const p = productById(s.product_id);
    const u = userById(db, s.user_id);
    const day = new Date(s.next_charge_at + KST).toISOString().slice(0, 10);
    const price = p.price[tierOf(u)].toLocaleString('ko-KR');
    tell(ctx, s.user_id, testModeOf(cfg) || cardOf(db, s.user_id)
      ? {
          kind: 'billing', email: true, link: '/drive/orders',
          title: `구독이 ${day}에 자동 갱신됩니다`,
          body: `${p.label} · ₩${price}이 결제됩니다. 원하지 않으면 구독 관리에서 자동 갱신을 꺼 주세요.`,
          titleEn: `Your subscription renews automatically on ${day}`,
          bodyEn: `You will be charged ₩${price} for ${p.labelEn || p.label}. If you don't want this, turn off auto-renewal in subscription management.`,
        }
      : {
          kind: 'billing', email: true, link: '/drive/payment',
          title: `구독 기간이 ${day}에 끝납니다`,
          body: '등록된 자동 결제 카드가 없어 청구되지 않아요. 계속 쓰려면 기간이 끝난 뒤 결제 화면에서 다시 구독해 주세요.',
          titleEn: `Your subscription ends on ${day}`,
          bodyEn: "You won't be charged because no card is registered for automatic payment. To keep using Premium, subscribe again on the payment page after the period ends.",
        });
    db.prepare('UPDATE billing_subscriptions SET reminded_for=? WHERE id=?').run(s.next_charge_at, s.id);
  }
  for (const s of subs('s.next_charge_at<=?').all(t)) {
    try {
      await renewOne(ctx, s, t);
    } catch (e) {
      console.error('[billing] 구독 갱신 실패', s.id, e.message); // 한 구독의 오류가 다른 구독 갱신을 막지 않게
    }
  }
  db.prepare("UPDATE billing_subscriptions SET status='ended' WHERE status='active' AND auto_renew=0 AND current_period_end<=?").run(t);
  for (const r of db.prepare("SELECT * FROM billing_coupon_redemptions WHERE kind='trial' AND reminded_at IS NULL AND ends_at>? AND ends_at<=?").all(t, t + TRIAL_REMIND_DAYS * DAY)) {
    // 그 뒤 구독·1회권으로 프리미엄이 더 길어졌으면 알리지 않는다
    if (!(userById(db, r.user_id)?.premium_until > r.ends_at)) {
      tell(ctx, r.user_id, {
        kind: 'billing',
        email: true,
        title: '체험 기간이 곧 끝납니다',
        body: '체험 코드는 자동으로 결제되지 않아요. 계속 쓰려면 프리미엄을 구매해 주세요.',
        titleEn: 'Your trial ends soon',
        bodyEn: "Trial codes aren't charged automatically. To keep using Premium, please purchase it.",
        link: '/drive/payment',
      });
    }
    db.prepare('UPDATE billing_coupon_redemptions SET reminded_at=? WHERE id=?').run(t, r.id);
  }
  // 자동 갱신이 없는 프리미엄(1회권·유료 코드·자동 갱신을 끈 구독)은 끝나기 7일 전에 한 번 알린다(K-05). 체험 코드는 위 알림이 있다
  const ending = db.prepare(
    `SELECT * FROM users u WHERE premium_until>? AND premium_until<=? AND status NOT IN ${OFF_STATUS}
       AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.user_id=u.id AND s.status='active' AND s.auto_renew=1)
       AND NOT EXISTS (SELECT 1 FROM billing_coupon_redemptions r WHERE r.user_id=u.id AND r.kind='trial' AND r.ends_at=u.premium_until)`,
  );
  for (const u of ending.all(t, t + RENEW_REMIND_DAYS * DAY)) {
    if (getSettings(u).expiryRemindedFor === u.premium_until) continue;
    const day = new Date(u.premium_until + KST).toISOString().slice(0, 10);
    tell(ctx, u.id, {
      kind: 'expiry',
      email: true,
      title: `프리미엄이 ${day}에 끝납니다`,
      body: '자동으로 결제되지 않아요. 계속 쓰려면 결제 화면에서 기간을 늘려 주세요.',
      titleEn: `Your Premium ends on ${day}`,
      bodyEn: "You won't be charged automatically. To keep using Premium, extend it on the payment page.",
      link: '/drive/payment',
    });
    saveSettings(db, u.id, { expiryRemindedFor: u.premium_until });
  }
}

// [제목, 본문, 영어 제목, 영어 본문]
const STAGE_MSG = {
  1: ['프리미엄 기간이 끝났습니다', '무료 등급으로 바뀌었어요. 파일 보기와 정리는 계속할 수 있습니다.', 'Your Premium has ended', "You're now on the free plan. You can still view and organize your files."],
  2: [
    '저장공간이 무료 용량을 넘었습니다',
    '용량을 줄이거나 프리미엄을 다시 구매할 때까지 업로드·새 클라우드 다운로드·새 저장이 막힙니다.',
    'Your storage is over the free limit',
    'Uploads, new cloud downloads and new saves are blocked until you free up space or buy Premium again.',
  ],
  3: [
    '온라인 재생이 중지되었습니다',
    '만료 후 7일이 지나 용량 초과 상태에서는 재생이 멈추고 기기 다운로드가 100KB/s로 느려집니다.',
    'Online playback has been stopped',
    "It's been 7 days since Premium ended and you're still over the limit, so playback is stopped and device downloads are slowed to 100KB/s.",
  ],
  4: [
    '초과 파일 정리 유예 기간 안내',
    `초과 상태가 ${EXPIRY.overQuotaMonths}개월 지났습니다. ${EXPIRY.warnMonths}개월 안에 정리하지 않으면 초과분이 삭제됩니다.`,
    'Grace period for cleaning up excess files',
    `You've been over the limit for ${EXPIRY.overQuotaMonths} months. If you don't clean up within ${EXPIRY.warnMonths} months, the excess will be deleted.`,
  ],
  5: [
    '초과 파일이 곧 삭제됩니다',
    `${EXPIRY.deleteWindowDays[0]}~${EXPIRY.deleteWindowDays[1]}일 안에 오래전에 수정된 파일부터 초과분을 삭제합니다. 삭제된 파일은 복구할 수 없습니다.`,
    'Excess files will be deleted soon',
    `Within ${EXPIRY.deleteWindowDays[0]}–${EXPIRY.deleteWindowDays[1]} days, the excess will be deleted, starting with the files modified longest ago. Deleted files can't be recovered.`,
  ],
};
// 만료 처리(8-6)와 추가 저장공간 만료. 하루 한 번
export async function runExpiry(ctx, t = now()) {
  const { db } = ctx;
  for (const a of db.prepare('SELECT * FROM billing_addons WHERE revoked_at IS NULL AND valid_to<=?').all(t)) {
    db.prepare('UPDATE users SET extra_storage_bytes=MAX(0, extra_storage_bytes-?) WHERE id=?').run(a.bytes, a.user_id);
    db.prepare('UPDATE billing_addons SET revoked_at=? WHERE id=?').run(t, a.id);
  }
  for (const u0 of db.prepare("SELECT id FROM users WHERE premium_until IS NOT NULL AND premium_until<=? AND status!='deleted'").all(t)) {
    const u = userById(db, u0.id);
    const first = !u.premium_expired_at;
    const expiredAt = u.premium_expired_at || u.premium_until;
    if (first) db.prepare('UPDATE users SET premium_expired_at=? WHERE id=?').run(expiredAt, u.id);
    const s = getSettings(u);
    const cap = capacityOf(u); // 만료 → 무료 용량(추가 저장공간 동결)
    let used = usage(db, u.id);
    let patch = {};
    let overSince = used > cap ? (s.overSince ?? (first ? expiredAt : t)) : null;
    let deleteAt = s.expiryDeleteAt ?? null;
    const stageOf = () => {
      if (!overSince) return 1;
      const el = t - overSince;
      if (el >= (EXPIRY.overQuotaMonths + EXPIRY.warnMonths) * MONTH) return 5;
      if (el >= EXPIRY.overQuotaMonths * MONTH) return 4;
      return t - expiredAt >= EXPIRY.playbackStopDays * DAY ? 3 : 2;
    };
    let stage = stageOf();
    if (stage === 5 && !deleteAt) deleteAt = t + EXPIRY.deleteWindowDays[0] * DAY;
    if (stage === 5 && t >= deleteAt) {
      // 오래전에 수정된 파일부터 초과분 삭제(복구 불가)
      // ponytail: 다른 모듈 테이블이 files 를 CASCADE 없이 참조하면 그 파일은 건너뛴다
      let excess = used - cap;
      for (const f of db.prepare("SELECT id, size FROM files WHERE user_id=? AND space='drive' AND kind='file' ORDER BY updated_at ASC").all(u.id)) {
        if (excess <= 0) break;
        try {
          db.prepare('DELETE FROM files WHERE id=? AND user_id=?').run(f.id, u.id);
          excess -= f.size;
        } catch (e) {
          console.error('[billing] 초과 파일 삭제 실패', f.id, e.message);
        }
      }
      used = usage(db, u.id);
      audit(db, { userId: u.id, action: 'billing.expiry_delete', detail: { cap, used } });
      tell(ctx, u.id, {
        kind: 'expiry',
        email: true,
        title: '초과 파일을 삭제했습니다',
        body: '무료 용량을 넘은 파일을 오래전에 수정된 것부터 삭제했습니다.',
        titleEn: 'Excess files were deleted',
        bodyEn: 'Files over the free storage limit were deleted, starting with the ones modified longest ago.',
        link: '/drive/all',
      });
      if (used <= cap) overSince = null;
      stage = stageOf();
    }
    if (stage < 5) deleteAt = null;
    patch = { expiryStage: stage, overSince: overSince ?? undefined, expiryDeleteAt: deleteAt ?? undefined };
    if (stage > (s.expiryStage || 0)) {
      // 처음 알릴 때 이미 용량 초과(2단계 이상)여도 만료 안내(1단계)부터 보낸다
      for (const k of s.expiryStage || stage === 1 ? [stage] : [1, stage]) {
        const [title, body, titleEn, bodyEn] = STAGE_MSG[k];
        tell(ctx, u.id, { kind: 'expiry', email: true, title, body, titleEn, bodyEn, link: k >= 2 ? '/drive/payment' : '/pricing' });
      }
    }
    saveSettings(db, u.id, patch);
  }
}

export const jobs = [
  { name: 'billing:renew', everyMs: 3600_000, run: (ctx) => runRenewals(ctx) },
  { name: 'billing:expiry', everyMs: DAY, run: (ctx) => runExpiry(ctx) },
  { name: 'billing:invite-carry', everyMs: 3600_000, run: (ctx) => carryInviteBonus(ctx.db) },
  { name: 'billing:archive-purge', everyMs: DAY, run: (ctx) => purgeOrderArchive(ctx.db) },
];
// 보관 기간(결제일 기준 5년)이 지난 삭제 회원 결제 기록을 지운다(K-06)
export const purgeOrderArchive = (db, t = now()) => db.prepare('DELETE FROM billing_orders_archive WHERE created_at<?').run(t - ORDER_KEEP_DAYS * DAY).changes;

// ---------- 라우트 ----------
export function register(app, ctx) {
  const { db, cfg, events } = ctx;
  const R = '/api/billing';
  const A = '/api/admin/billing';
  const myOrder = (req) => db.prepare('SELECT * FROM billing_orders WHERE id=? AND user_id=?').get(req.params.id, req.user.id) || fail(404, 'not_found', '주문을 찾을 수 없습니다');
  const mySub = (req) => db.prepare('SELECT * FROM billing_subscriptions WHERE id=? AND user_id=?').get(req.params.id, req.user.id) || fail(404, 'not_found', '구독을 찾을 수 없습니다');
  // 결제·구독·쿠폰·초대 같은 계정 동작은 웹 세션 전용(G-04·G-05: 토큰에는 계정 권한을 줄 수 없음). 조회는 account 권한
  const web = (req, res, next) =>
    requireUser(req, res, () => {
      if (req.authKind !== 'session') fail(403, 'session_required', '웹에 로그인한 상태에서만 할 수 있습니다');
      next();
    });
  const account = requireScope('account');

  events.on('user:created', ({ userId, inviteCode } = {}) => {
    if (!inviteCode) return;
    try {
      bindInvite(ctx, userId, inviteCode, 'signup');
    } catch {
      /* 잘못된 초대 코드는 가입을 막지 않는다 */
    }
  });
  // 가입 직후 첫 로그인(세션이 생긴 뒤)에 같은 기기 초대인지 다시 본다(8-8)
  events.on('user:login', ({ userId } = {}) => recheckSignupInvite(db, userId));

  // 가격표(로그인 없이도 조회)
  app.get(`${R}/products`, (req, res) => {
    const u = req.user;
    const tier = tierOf(u);
    const active = u && db.prepare("SELECT * FROM billing_subscriptions WHERE user_id=? AND status='active' ORDER BY created_at DESC LIMIT 1").get(u.id);
    res.json({
      tier,
      testMode: testModeOf(cfg),
      available: !!payMode(cfg),
      tossClientKey: testModeOf(cfg) ? null : cfg.payments.tossClientKey || null,
      methods: PAYMENT_METHODS,
      premium: isPremium(u),
      premiumUntil: u?.premium_until || null,
      activeSubscription: active ? subApi(active, tier) : null,
      products: PRODUCTS.map((p) => {
        const { amount, first } = priceFor(db, u, p);
        return {
          id: p.id, kind: p.kind, months: p.months, days: productDays(p), label: p.label, labelEn: p.labelEn, bytes: p.bytes || null, amounts: p.amounts || null,
          price: p.price[tier], firstPrice: p.firstPrice?.[tier] ?? null, firstDiscount: first, payNow: amount,
        };
      }),
      compare: compareTables(),
    });
  });

  app.post(`${R}/orders`, web, (req, res) => {
    const o = createOrder(ctx, req.user, String(req.body?.productId || ''), String(req.body?.method || ''));
    // 운영 카드 구독은 결제창에서 자동 결제 카드를 등록(빌링 인증)하고, 서버가 빌링키로 첫 결제를 청구한다
    const customerKey = !o.test_mode && isNewSubscription(o) && o.method === 'card' ? customerKeyOf(cfg, req.user.id) : null;
    res.json({ orderId: o.id, amount: o.amount, testMode: !!o.test_mode, customerKey, order: orderApi(o) });
  });

  app.post(`${R}/orders/:id/confirm`, web, async (req, res) => {
    const o = myOrder(req);
    if (o.status !== 'pending') fail(409, 'order_closed', '이미 처리된 주문입니다');
    // 테스트 주문은 개발 모드에서만, 운영 주문은 운영 키가 있을 때만 확정한다
    if (payMode(cfg) !== (o.test_mode ? 'test' : 'live')) fail(503, 'payments_unavailable', '지금은 이 주문을 결제할 수 없습니다');
    const closeFailed = () => db.prepare("UPDATE billing_orders SET status='failed' WHERE id=? AND status='pending'").run(o.id);
    const orFail = (fn) => {
      try {
        return fn();
      } catch (e) {
        closeFailed();
        throw e;
      }
    };
    orFail(() => assertCanApply(db, o)); // 돈을 받기 전에 먼저 확인(중복 구독·첫 할인·추가 저장공간 프리미엄)
    let paymentKey = null;
    let card = null;
    if (o.test_mode) {
      const result = req.body?.result;
      if (result !== 'success' && result !== 'fail') fail(400, 'invalid_result', "result 는 'success' 또는 'fail' 입니다");
      if (result === 'fail') {
        closeFailed();
        return res.json({ ok: false, status: 'failed', order: orderApi({ ...o, status: 'failed' }) });
      }
    } else if (req.body?.authKey) {
      // 빌링 인증에서 돌아옴: 빌링키 발급 → 빌링키로 첫 결제
      if (!isNewSubscription(o) || o.method !== 'card') fail(400, 'billing_not_allowed', '자동 결제 카드는 카드 구독 주문에서만 등록할 수 있습니다');
      const customerKey = customerKeyOf(cfg, req.user.id);
      if (req.body.customerKey !== customerKey) fail(400, 'invalid_customer', '결제 정보가 이 계정과 맞지 않습니다');
      const issued = await toss(cfg, '/v1/billing/authorizations/issue', { authKey: str(req.body.authKey, 300), customerKey }).catch((e) => {
        closeFailed();
        throw e;
      });
      if (!issued.billingKey) {
        closeFailed();
        fail(402, 'payment_failed', '자동 결제 카드를 등록하지 못했습니다');
      }
      card = { billing_key: String(issued.billingKey), customer_key: customerKey };
      paymentKey = await tossBillingPay(cfg, card, o).catch((e) => {
        closeFailed();
        throw e;
      });
      db.prepare('UPDATE billing_orders SET pg_key=? WHERE id=?').run(paymentKey, o.id);
    } else {
      paymentKey = str(req.body?.paymentKey, 200);
      if (!paymentKey) fail(400, 'payment_key_required', '결제 키가 없습니다');
      await tossConfirm(cfg, { paymentKey, orderId: o.id, amount: o.amount }).catch((e) => {
        closeFailed();
        throw e;
      });
      db.prepare('UPDATE billing_orders SET pg_key=? WHERE id=?').run(paymentKey, o.id);
    }
    let done;
    try {
      done = applyOrder(ctx, o, now(), card);
    } catch (e) {
      // 승인 뒤 반영이 막히면(그사이 다른 구독이 확정됨 등) 받은 돈을 바로 취소한다
      if (paymentKey && e.code !== 'order_closed') {
        await tossCancel(cfg, paymentKey, '주문 반영 실패').catch((x) => console.error('[billing] 결제 취소 실패', o.id, x.message));
        closeFailed();
      }
      throw e;
    }
    res.json({ ok: true, status: 'paid', order: orderApi(done), premiumUntil: userById(db, req.user.id).premium_until });
  });

  app.get(`${R}/orders`, account, (req, res) => {
    const rows = db.prepare("SELECT * FROM billing_orders WHERE user_id=? AND status!='pending' ORDER BY created_at DESC LIMIT 200").all(req.user.id);
    res.json({ items: rows.map(orderApi) });
  });

  app.post(`${R}/orders/:id/refund-request`, web, (req, res) => {
    const o = myOrder(req);
    if (o.status !== 'paid') fail(409, 'not_refundable', '결제 완료된 주문만 환불을 요청할 수 있습니다');
    const reason = str(req.body?.reason, 1000);
    if (!reason) fail(400, 'reason_required', '환불 사유를 적어 주세요');
    db.prepare("UPDATE billing_orders SET status='refund_requested', refund_reason=? WHERE id=?").run(reason, o.id);
    audit(db, { userId: req.user.id, action: 'billing.refund_request', detail: { orderId: o.id }, ip: req.ip });
    res.json({ ok: true, order: orderApi({ ...o, status: 'refund_requested', refund_reason: reason }) });
  });

  app.get(`${R}/subscriptions`, account, (req, res) => {
    const rows = db.prepare('SELECT * FROM billing_subscriptions WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
    // 자동 갱신을 켤 수 있는지: 테스트 결제이거나 운영 자동 결제 카드(빌링키)가 등록돼 있을 때
    res.json({ items: rows.map((s) => subApi(s, tierOf(req.user))), premiumUntil: req.user.premium_until, autoRenewAvailable: testModeOf(cfg) || (payMode(cfg) === 'live' && !!cardOf(db, req.user.id)) });
  });
  app.post(`${R}/subscriptions/:id/cancel`, web, (req, res) => {
    const s = mySub(req);
    if (s.status !== 'active') fail(409, 'not_active', '진행 중인 구독이 아닙니다');
    db.prepare('UPDATE billing_subscriptions SET auto_renew=0, canceled_at=? WHERE id=?').run(now(), s.id);
    res.json({ ok: true, subscription: subApi({ ...s, auto_renew: 0, canceled_at: now() }, tierOf(req.user)) });
  });
  app.post(`${R}/subscriptions/:id/resume`, web, (req, res) => {
    const s = mySub(req);
    if (!testModeOf(cfg) && !(payMode(cfg) === 'live' && cardOf(db, req.user.id))) fail(409, 'auto_renew_unavailable', '등록된 자동 결제 카드가 없어 자동 갱신을 켤 수 없습니다. 기간이 끝나면 카드로 다시 구독해 주세요');
    if (s.status !== 'active' || s.current_period_end <= now()) fail(409, 'not_active', '기간이 끝난 구독은 다시 결제해 주세요');
    if (db.prepare("SELECT 1 FROM billing_subscriptions WHERE user_id=? AND status='active' AND auto_renew=1 AND id!=?").get(req.user.id, s.id)) fail(409, 'already_subscribed', '자동 갱신 중인 다른 구독이 있습니다');
    db.prepare('UPDATE billing_subscriptions SET auto_renew=1, canceled_at=NULL WHERE id=?').run(s.id);
    res.json({ ok: true, subscription: subApi({ ...s, auto_renew: 1, canceled_at: null }, tierOf(req.user)) });
  });

  // 쿠폰
  app.post(`${R}/coupons/redeem`, web, (req, res) => {
    if (!rateLimit(`coupon:${req.user.id}`, 10, 10 * 60_000)) fail(429, 'too_many_attempts', '시도 횟수를 넘었습니다. 10분 뒤 다시 시도해 주세요');
    res.json({ ok: true, ...redeemCoupon(ctx, req.user, req.body?.code) });
  });
  app.get(`${R}/coupons/history`, account, (req, res) => {
    const rows = db.prepare('SELECT r.*, c.hint FROM billing_coupon_redemptions r JOIN billing_coupons c ON c.id=r.coupon_id WHERE r.user_id=? ORDER BY r.created_at DESC').all(req.user.id);
    res.json({ items: rows.map((r) => ({ id: r.id, hint: r.hint, kind: r.kind, days: r.days, endsAt: r.ends_at, createdAt: r.created_at })) });
  });

  // 출석 체크: 웹 세션 또는 브라우저 확장 토큰
  app.post(`${R}/checkin`, requireUser, (req, res) => {
    if (req.authKind !== 'session' && req.appId !== 'extension') fail(403, 'checkin_app_only', '출석 체크는 웹이나 브라우저 확장에서만 할 수 있습니다');
    res.json(checkin(ctx, req.user));
  });
  app.get(`${R}/checkin`, requireUser, (req, res) => res.json(checkinState(db, req.user.id)));

  // 쿼터(F-01~F-05)
  app.get(`${R}/quota`, requireUser, (req, res) => {
    const t = now();
    const grants = db
      .prepare("SELECT kind, amount, period, valid_from, valid_to, reason, created_at FROM quota_grants WHERE user_id=? AND kind IN ('cloud','down','up') AND (valid_to IS NULL OR valid_to>?) AND (period IS NULL OR period>=?) ORDER BY created_at DESC, period LIMIT 200")
      .all(req.user.id, t, periodKeys(t).month);
    res.json({
      ...quota.summary(db, req.user),
      monthKey: periodKeys(t).month.slice(2),
      base: MONTHLY_QUOTA,
      appShare: APP_QUOTA_SHARE,
      freeAppDailyDown: FREE_APP_DAILY_DOWN,
      premium: isPremium(req.user),
      grants: grants.map((g) => ({ kind: g.kind, amount: g.amount, period: g.period?.slice(2) || null, validFrom: g.valid_from, validTo: g.valid_to, reason: g.reason.split(':')[0], createdAt: g.created_at })),
    });
  });

  // 초대(I-04)
  app.get(`${R}/invite`, account, (req, res) => {
    const u = req.user;
    let code = u.invite_code;
    if (!code) {
      code = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join(''); // auth 와 같은 대문자 형식
      db.prepare('UPDATE users SET invite_code=? WHERE id=? AND invite_code IS NULL').run(code, u.id);
    }
    const records = db
      .prepare(
        `SELECT i.invitee_id, i.created_at, i.via, i.suspicious, u.name, u.email, u.phone,
          (SELECT COALESCE(SUM(purchase_days),0) FROM billing_referral_rewards r WHERE r.invitee_id=i.invitee_id) AS bought,
          (SELECT COALESCE(SUM(reward_days),0) FROM billing_referral_rewards r WHERE r.invitee_id=i.invitee_id AND r.inviter_id=i.inviter_id) AS reward
         FROM billing_invites i JOIN users u ON u.id=i.invitee_id WHERE i.inviter_id=? ORDER BY i.created_at DESC LIMIT 200`,
      )
      .all(u.id);
    const month = periodKeys().month;
    // 통계는 목록(LIMIT 200)과 따로 전체를 센다
    const count = (sql) => Number(db.prepare(sql).get(u.id).n);
    res.json({
      inviteCode: code,
      link: `/signup?invite=${encodeURIComponent(code)}`,
      invitedBy: !!u.invited_by,
      canBind: !u.invited_by && now() - u.created_at <= REFERRAL.bindHours * 3600_000,
      rules: { shareRate: REFERRAL.shareRate, windowDays: REFERRAL.windowDays, bindHours: REFERRAL.bindHours, uploadBonusEvery: REFERRAL.uploadBonusEvery, uploadBonus: REFERRAL.uploadBonus, uploadBonusMax: REFERRAL.uploadBonusMax },
      stats: {
        invited: count('SELECT COUNT(*) AS n FROM billing_invites WHERE inviter_id=?'),
        purchased: count('SELECT COUNT(DISTINCT invitee_id) AS n FROM billing_referral_rewards WHERE inviter_id=? AND purchase_days>0'),
        rewardDays: count('SELECT COALESCE(SUM(reward_days),0) AS n FROM billing_referral_rewards WHERE inviter_id=?'),
        uploadBonusThisMonth: Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM quota_grants WHERE user_id=? AND reason=?').get(u.id, `invite_upload:${month}`).n),
      },
      records: records.map((r) => ({ name: mask(r.name || r.email || r.phone), joinedAt: r.created_at, via: r.via, purchased: Number(r.bought) > 0, rewardDays: Number(r.reward), suspicious: !!r.suspicious, revoked: r.suspicious === 2 })),
    });
  });
  app.post(`${R}/invite/bind`, web, (req, res) => res.json({ ok: true, ...bindInvite(ctx, req.user.id, req.body?.code, 'code') }));

  // 추천 보상 Pro(I-05). PikPak 조건 미확인 → 설명·신청 접수·관리자 승인만
  app.get(`${R}/invite/pro`, account, (req, res) => {
    const a = db.prepare('SELECT * FROM billing_pro_applications WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
    res.json({
      description: {
        ko: '영상·블로그·커뮤니티로 미믹을 꾸준히 알리는 분을 위한 현금 보상 프로그램이에요. 보상 조건은 심사 후 개별로 안내해 드립니다.',
        en: 'A cash-reward program for creators who regularly introduce Mimic. Terms are shared individually after review.',
      },
      conditionsConfirmed: false,
      application: a ? { id: a.id, channel: a.channel, audience: a.audience, contact: a.contact, status: a.status, note: a.note, createdAt: a.created_at, decidedAt: a.decided_at } : null });
  });
  app.post(`${R}/invite/pro/apply`, web, (req, res) => {
    const channel = str(req.body?.channel, 300);
    const audience = str(String(req.body?.audience ?? ''), 100);
    const contact = str(req.body?.contact, 200);
    if (!channel || !audience || !contact) fail(400, 'invalid_input', '홍보 채널, 구독자 규모, 연락처를 모두 적어 주세요');
    if (db.prepare("SELECT 1 FROM billing_pro_applications WHERE user_id=? AND status IN ('pending','approved')").get(req.user.id)) fail(409, 'already_applied', '이미 신청했거나 승인된 상태입니다');
    const id = newId('pro_');
    db.prepare('INSERT INTO billing_pro_applications (id, user_id, channel, audience, contact, created_at) VALUES (?,?,?,?,?,?)').run(id, req.user.id, channel, audience, contact, now());
    res.json({ ok: true, id, status: 'pending' });
  });

  // ---------- 관리자 ----------
  app.get(`${A}/orders`, requireAdmin, (req, res) => {
    // archived=1: 삭제된 회원의 보관 결제 기록(K-06)
    if (req.query.archived === '1') {
      const rows = db.prepare('SELECT * FROM billing_orders_archive ORDER BY created_at DESC LIMIT 500').all();
      return res.json({ items: rows.map((o) => ({ ...orderApi(o), userId: o.user_id, user: o.user_email || o.user_phone, archived: true, archivedAt: o.archived_at })) });
    }
    const st = str(req.query.status, 30);
    const rows = st
      ? db.prepare('SELECT o.*, u.email, u.phone, u.name FROM billing_orders o JOIN users u ON u.id=o.user_id WHERE o.status=? ORDER BY o.created_at DESC LIMIT 500').all(st)
      : db.prepare('SELECT o.*, u.email, u.phone, u.name FROM billing_orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 500').all();
    res.json({ items: rows.map((o) => ({ ...orderApi(o), userId: o.user_id, user: o.email || o.phone || o.name })) });
  });
  app.post(`${A}/orders/:id/refund`, requireAdmin, async (req, res) => {
    const o = db.prepare('SELECT * FROM billing_orders WHERE id=?').get(req.params.id) || fail(404, 'not_found', '주문을 찾을 수 없습니다');
    if (o.status !== 'paid' && o.status !== 'refund_requested') fail(409, 'not_refundable', '환불할 수 없는 상태입니다');
    const note = str(req.body?.note, 1000) || null;
    // 운영 주문은 토스 결제 취소가 성공해야 환불로 바꾼다(실패하면 402, 주문은 그대로)
    if (!o.test_mode) {
      if (payMode(cfg) !== 'live' || !o.pg_key) fail(503, 'payments_unavailable', '결제사 연동이 없어 지금은 환불할 수 없습니다');
      await tossCancel(cfg, o.pg_key, note || '고객 요청 환불');
    }
    const t = now();
    tx(db, () => {
      if (db.prepare("UPDATE billing_orders SET status='refunded', refunded_at=?, admin_note=? WHERE id=? AND status IN ('paid','refund_requested')").run(t, note, o.id).changes !== 1) {
        fail(409, 'not_refundable', '이미 처리된 주문입니다');
      }
      revokeOrder(ctx, o, t);
    });
    audit(db, { userId: req.user.id, action: 'billing.refund', detail: { orderId: o.id, amount: o.amount }, ip: req.ip });
    tell(ctx, o.user_id, {
      kind: 'payment',
      email: true,
      title: '환불이 처리되었습니다',
      body: `₩${o.amount.toLocaleString('ko-KR')} 환불과 함께 남은 혜택 기간이 회수되었습니다.`,
      titleEn: 'Your refund has been processed',
      bodyEn: `₩${o.amount.toLocaleString('en-US')} was refunded and the remaining benefit period was taken back.`,
      link: '/drive/orders?tab=orders',
    });
    res.json({ ok: true, order: orderApi(db.prepare('SELECT * FROM billing_orders WHERE id=?').get(o.id)) });
  });
  app.get(`${A}/stats`, requireAdmin, (_req, res) => {
    const t = now();
    const sum = (where, ...a) => Number(db.prepare(`SELECT COALESCE(SUM(amount),0) AS n FROM billing_orders WHERE ${where}`).get(...a).n);
    const cnt = (sql, ...a) => Number(db.prepare(sql).get(...a).n);
    res.json({
      revenue: { total: sum("status='paid'"), today: sum("status='paid' AND paid_at>=?", t - (t + KST) % DAY), month: sum("status='paid' AND paid_at>=?", monthStart(t)), refunded: sum("status='refunded'") },
      orders: { paid: cnt("SELECT COUNT(*) AS n FROM billing_orders WHERE status='paid'"), refundRequested: cnt("SELECT COUNT(*) AS n FROM billing_orders WHERE status='refund_requested'"), failed: cnt("SELECT COUNT(*) AS n FROM billing_orders WHERE status='failed'") },
      byProduct: db.prepare("SELECT product_id AS productId, COUNT(*) AS count, SUM(amount) AS amount FROM billing_orders WHERE status='paid' GROUP BY product_id").all(),
      subscriptions: { active: cnt("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE status='active'"), autoRenew: cnt("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE status='active' AND auto_renew=1") },
      premiumUsers: cnt('SELECT COUNT(*) AS n FROM users WHERE premium_until>?', t),
      coupons: { issued: cnt('SELECT COUNT(*) AS n FROM billing_coupons'), redeemed: cnt('SELECT COUNT(*) AS n FROM billing_coupon_redemptions') },
      invites: { total: cnt('SELECT COUNT(*) AS n FROM billing_invites'), rewardDays: cnt('SELECT COALESCE(SUM(reward_days),0) AS n FROM billing_referral_rewards') },
      proPending: cnt("SELECT COUNT(*) AS n FROM billing_pro_applications WHERE status='pending'"),
    });
  });
  app.get(`${A}/coupons`, requireAdmin, (_req, res) => {
    const rows = db.prepare('SELECT * FROM billing_coupons ORDER BY created_at DESC LIMIT 1000').all();
    res.json({ items: rows.map((c) => ({ id: c.id, hint: c.hint, kind: c.kind, days: c.days, maxUses: c.max_uses, usedCount: c.used_count, expiresAt: c.expires_at, batch: c.batch, createdAt: c.created_at })) });
  });
  app.post(`${A}/coupons`, requireAdmin, (req, res) => {
    const b = req.body || {};
    const out = createCoupons(db, { kind: b.kind, days: b.days, count: b.count ?? 1, maxUses: b.maxUses ?? 1, expiresAt: b.expiresAt ?? null }, req.user.id);
    audit(db, { userId: req.user.id, action: 'billing.coupons_create', detail: { batch: out.batch, count: out.codes.length, kind: b.kind, days: b.days }, ip: req.ip });
    res.json(out);
  });
  // 초대 검토(I-04, 8-8). suspicious=1 이면 같은 기기 의심으로 보상이 보류된 초대만
  app.get(`${A}/invites`, requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT i.*, COALESCE(a.email, a.phone, a.name) AS inviter, COALESCE(b.email, b.phone, b.name) AS invitee,
          (SELECT COALESCE(SUM(purchase_days),0) FROM billing_referral_rewards r WHERE r.invitee_id=i.invitee_id) AS bought,
          (SELECT COALESCE(SUM(reward_days),0) FROM billing_referral_rewards r WHERE r.invitee_id=i.invitee_id) AS reward
         FROM billing_invites i JOIN users a ON a.id=i.inviter_id JOIN users b ON b.id=i.invitee_id
         ${req.query.suspicious === '1' ? 'WHERE i.suspicious=1' : ''} ORDER BY i.created_at DESC LIMIT 500`,
      )
      .all();
    res.json({ items: rows.map((r) => ({ inviteeId: r.invitee_id, invitee: r.invitee, inviterId: r.inviter_id, inviter: r.inviter, via: r.via, month: r.month, suspicious: r.suspicious, purchaseDays: Number(r.bought), rewardDays: Number(r.reward), createdAt: r.created_at })) });
  });
  app.post(`${A}/invites/:inviteeId`, requireAdmin, (req, res) => {
    const out = reviewInvite(ctx, req.params.inviteeId, req.body?.action);
    audit(db, { userId: req.user.id, action: `billing.invite_${req.body.action}`, detail: { invitee: req.params.inviteeId, rewardDays: out.rewardDays }, ip: req.ip });
    res.json({ ok: true, ...out });
  });

  app.get(`${A}/pro-applications`, requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT a.*, u.email, u.phone, u.name FROM billing_pro_applications a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 500').all();
    res.json({ items: rows.map((a) => ({ id: a.id, userId: a.user_id, user: a.email || a.phone || a.name, channel: a.channel, audience: a.audience, contact: a.contact, status: a.status, note: a.note, createdAt: a.created_at, decidedAt: a.decided_at })) });
  });
  app.post(`${A}/pro-applications/:id`, requireAdmin, (req, res) => {
    const status = req.body?.status;
    if (status !== 'approved' && status !== 'rejected') fail(400, 'invalid_status', "status 는 'approved' 또는 'rejected' 입니다");
    const a = db.prepare('SELECT * FROM billing_pro_applications WHERE id=?').get(req.params.id) || fail(404, 'not_found', '신청을 찾을 수 없습니다');
    const note = str(req.body?.note, 1000) || null;
    db.prepare('UPDATE billing_pro_applications SET status=?, note=?, decided_at=? WHERE id=?').run(status, note, now(), a.id);
    const ok = status === 'approved';
    tell(ctx, a.user_id, {
      kind: 'invite',
      email: true,
      title: ok ? '추천 보상 Pro 신청이 승인되었습니다' : '추천 보상 Pro 신청 결과 안내',
      titleEn: ok ? 'Your Referral Pro application was approved' : 'Result of your Referral Pro application',
      body: note || '', // 관리자가 적은 메모라 영어 본문은 따로 없다(영어 화면에도 이 메모가 보인다)
      link: '/drive/invite',
    });
    res.json({ ok: true, status });
  });
}
