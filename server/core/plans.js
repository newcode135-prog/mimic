// 미믹 정책 수치를 한곳에 모은다(docs/MIMIC_PLAN.md 8장). 맥미니 베타에서는 환경변수로 낮춰 운영한다.
// 담당: billing 모듈. 다른 모듈은 읽기만 한다. 내보내는 이름은 바꾸지 말고 추가만 할 것.
export const KB = 1024;
export const MB = 1024 ** 2;
export const GB = 1024 ** 3;
export const TB = 1024 ** 4;

const env = process.env;

export const LIMITS = {
  free: {
    storage: 6 * GB,
    cloudPerDay: 3,
    concurrentTasks: 1,
    dailyDown: 20 * GB,
    playback: '720p',
    unzip: false,
    webdav: false,
    vault: false,
    ads: true,
    fastDownload: false,
  },
  premium: {
    storage: Number(env.MIMIC_PREMIUM_STORAGE_GB || 10 * 1024) * GB,
    cloudPerDay: Infinity,
    concurrentTasks: 5,
    dailyDown: Infinity,
    playback: 'original',
    unzip: true,
    webdav: true,
    vault: true,
    ads: false,
    fastDownload: true,
  },
};

export const MONTHLY_QUOTA = { cloud: 40 * TB, down: 4 * TB, up: 1 * TB }; // 모든 사용자 공통, 매월 초기화
export const APP_QUOTA_SHARE = 0.25; // 연결 앱 합산 상한(각 월 쿼터의 25%)
export const FREE_APP_DAILY_DOWN = 5 * GB;
export const SLOW_BPS = 100 * KB; // 한도 초과 시 감속 속도
export const SPEED_BPS = { global: 20 * MB, regional: 8 * MB, free: 2 * MB }; // 연결당 다운로드 속도(무료값은 미믹 자체 설정)
export const TRASH_DAYS = 15;
export const SIGNUP_BONUS_CLOUD = 2;
export const VAULT_STORAGE = Number(env.MIMIC_VAULT_STORAGE_GB || 100) * GB; // PikPak 수치 미확인(E-04)
export const SHARE_EXPIRY_DAYS = [0, 7, 14, 30]; // 0 = 영구
export const BT_MAX_FILES = 7000;

// 가격은 참고값(PikPak 2026-11-12 원화 표시가). 실제 미믹 가격은 미결정(Q-3)
export const PRODUCTS = [
  { id: 'sub_month', kind: 'subscription', months: 1, label: '월 구독', price: { global: 9591, regional: 4800 }, firstPrice: { global: 6256, regional: 3100 } },
  { id: 'sub_year', kind: 'subscription', months: 12, label: '연간 구독', price: { global: 101636, regional: 50800 }, firstPrice: { global: 62417, regional: 31200 } },
  { id: 'once_month', kind: 'once', months: 1, label: '1개월', price: { global: 10125, regional: 5100 } },
  { id: 'once_year', kind: 'once', months: 12, label: '1년', price: { global: 69354, regional: 34700 } },
  { id: 'storage_10tb_year', kind: 'addon_storage', months: 12, bytes: 10 * TB, label: '추가 저장공간 10TB · 1년', price: { global: 59000, regional: 29500 } },
  { id: 'quota_month', kind: 'addon_quota', months: 1, amounts: { cloud: 10 * TB, down: 1 * TB, up: 256 * GB }, label: '추가 전송 쿼터 · 1개월', price: { global: 9900, regional: 4900 } },
  { id: 'quota_year', kind: 'addon_quota', months: 12, amounts: { cloud: 10 * TB, down: 1 * TB, up: 256 * GB }, label: '추가 전송 쿼터 · 1년', price: { global: 99000, regional: 49000 } },
];
export const PAYMENT_METHODS = ['card', 'paypal', 'crypto', 'alipay', 'unionpay'];

export const REFERRAL = { shareRate: 0.35, windowDays: 365, bindHours: 12, uploadBonusEvery: 10, uploadBonus: 100 * GB, uploadBonusMax: 5 * TB };
export const EXPIRY = { playbackStopDays: 7, overQuotaMonths: 4, warnMonths: 2, deleteWindowDays: [15, 30] };
export const DORMANT = { freeInactiveMonths: 12, graceDays: 7, hardInactiveYears: 3 };
export const ACCOUNT_DELETE_GRACE_DAYS = 7;

export function isPremium(user, t = Date.now()) {
  return !!user?.premium_until && user.premium_until > t;
}
export function limitsFor(user) {
  return isPremium(user) ? LIMITS.premium : LIMITS.free;
}
// 추가 저장공간은 프리미엄이 끝나면 동결된다
export function capacityOf(user) {
  return isPremium(user) ? LIMITS.premium.storage + (user.extra_storage_bytes || 0) : LIMITS.free.storage;
}
export function speedFor(user) {
  return isPremium(user) ? SPEED_BPS[user.tier === 'regional' ? 'regional' : 'global'] : SPEED_BPS.free;
}
