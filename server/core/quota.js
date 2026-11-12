// 전송 쿼터 적립·검사(docs/MIMIC_PLAN.md 8-7). 담당: billing 모듈. 내보내는 함수의 모양은 유지할 것.
import { periodKeys, now, fail } from './util.js';
import { MONTHLY_QUOTA, APP_QUOTA_SHARE, FREE_APP_DAILY_DOWN, LIMITS, isPremium } from './plans.js';

const KINDS = ['cloud', 'down', 'up'];

// kind: cloud | down | up, source: official(미믹 공식 앱·웹) | app(연결 앱·WebDAV·CLI)
export function addUsage(db, userId, kind, amount, source = 'official', ts = now()) {
  if (!amount) return;
  const { day, month } = periodKeys(ts);
  const up = db.prepare(
    `INSERT INTO quota_usage (user_id, period, kind, source, amount) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, period, kind, source) DO UPDATE SET amount = amount + excluded.amount`,
  );
  up.run(userId, month, kind, source, amount);
  up.run(userId, day, kind, source, amount);
}

function used(db, userId, period, kind, source = null) {
  const row = source
    ? db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM quota_usage WHERE user_id=? AND period=? AND kind=? AND source=?').get(userId, period, kind, source)
    : db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM quota_usage WHERE user_id=? AND period=? AND kind=?').get(userId, period, kind);
  return Number(row.n);
}

function granted(db, userId, kind, month, ts = now()) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS n FROM quota_grants
       WHERE user_id=? AND kind=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) AND (period IS NULL OR period=?)`,
    )
    .get(userId, kind, ts, ts, month);
  return Number(row.n);
}

export function grant(db, userId, { kind, amount, period = null, validFrom = now(), validTo = null, reason }) {
  db.prepare(
    'INSERT INTO quota_grants (id, user_id, kind, amount, period, valid_from, valid_to, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(crypto.randomUUID(), userId, kind, amount, period, validFrom, validTo, reason, now());
}

export function monthlyLimit(db, userId, kind) {
  const { month } = periodKeys();
  return MONTHLY_QUOTA[kind] + granted(db, userId, kind, month);
}

// 전송 전에 호출. { ok, reason, slow } — slow 가 true 면 막지 말고 SLOW_BPS 로 감속한다
export function checkTransfer(db, user, kind, bytes = 0, source = 'official') {
  const { day, month } = periodKeys();
  const limit = monthlyLimit(db, user.id, kind);
  if (used(db, user.id, month, kind) + bytes > limit) return { ok: false, reason: 'monthly_quota', slow: kind === 'down' };
  const premium = isPremium(user);
  if (!premium && kind === 'down' && used(db, user.id, day, 'down') + bytes > LIMITS.free.dailyDown) {
    return { ok: false, reason: 'daily_quota', slow: true };
  }
  if (source === 'app') {
    if (used(db, user.id, month, kind, 'app') + bytes > limit * APP_QUOTA_SHARE) return { ok: false, reason: 'app_quota', slow: kind === 'down' };
    if (!premium && kind === 'down' && used(db, user.id, day, 'down', 'app') + bytes > FREE_APP_DAILY_DOWN) {
      return { ok: false, reason: 'app_daily_quota', slow: true };
    }
  }
  return { ok: true };
}

// 무료 클라우드 다운로드 횟수: 하루 3회 + 가입 보너스(quota_grants kind='cloud_count')
export function cloudTaskAllowance(db, user) {
  if (isPremium(user)) return { unlimited: true, dailyLeft: null, bonusLeft: null, remaining: null };
  const { day } = periodKeys();
  const dailyLeft = Math.max(0, LIMITS.free.cloudPerDay - used(db, user.id, day, 'cloud_count'));
  const bonusTotal = Number(db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM quota_grants WHERE user_id=? AND kind='cloud_count'").get(user.id).n);
  const bonusUsed = used(db, user.id, 'all', 'cloud_bonus');
  const bonusLeft = Math.max(0, bonusTotal - bonusUsed);
  return { unlimited: false, dailyLeft, bonusLeft, remaining: dailyLeft + bonusLeft };
}

export function consumeCloudTask(db, user) {
  const a = cloudTaskAllowance(db, user);
  if (a.unlimited || a.dailyLeft > 0) {
    addUsage(db, user.id, 'cloud_count', 1);
  } else if (a.bonusLeft > 0) {
    db.prepare(
      `INSERT INTO quota_usage (user_id, period, kind, source, amount) VALUES (?, 'all', 'cloud_bonus', 'official', 1)
       ON CONFLICT (user_id, period, kind, source) DO UPDATE SET amount = amount + 1`,
    ).run(user.id);
  } else {
    fail(403, 'cloud_limit', '오늘의 무료 클라우드 다운로드 횟수를 모두 사용했습니다');
  }
  return cloudTaskAllowance(db, user);
}

export function summary(db, user) {
  const { day, month } = periodKeys();
  const out = { month: {}, app: {}, today: {} };
  for (const k of KINDS) {
    const limit = monthlyLimit(db, user.id, k);
    out.month[k] = { used: used(db, user.id, month, k), limit };
    out.app[k] = { used: used(db, user.id, month, k, 'app'), limit: Math.floor(limit * APP_QUOTA_SHARE) };
  }
  out.today.down = { used: used(db, user.id, day, 'down'), limit: isPremium(user) ? null : LIMITS.free.dailyDown };
  out.today.cloudTasks = cloudTaskAllowance(db, user);
  return out;
}
