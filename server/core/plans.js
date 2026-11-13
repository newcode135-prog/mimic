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

// 가격은 PikPak 과 같게(Q-3): 2026-11-13 PikPak 웹 원화 표시가(싱가포르 달러 환산이라 환율 따라 움직임). 단위는 원.
// 지역 등급은 PikPak 앱스토어 지역가($4.99·$49.99)가 글로벌($9.99·$99.99)의 절반인 비율을 따라 절반을 100원 단위로 반올림.
// 해외(한국 외 지역) 사용자는 이 원화 가격을 그날 환율로 나눈 달러(센트 반올림)로 결제한다(Q-2·Q-4, billing 모듈)
const half = (krw) => Math.round(krw / 200) * 100;
const tiered = (krw) => ({ global: krw, regional: half(krw) });
// usd: PayPal 결제(provider=paypal)의 달러 고정가(센트). 2026-11-13 결정: PikPak 미국 App Store 구독가(글로벌 월 $9.99·연 $99.99,
// 지역 월 $4.99·연 $49.99). 첫 결제 할인·1회권·추가 상품은 위 원화가와 같은 비율로 맞춘 미믹 값(PikPak 웹 달러가는 미확인)
const usd = (global, regional) => ({ global, regional });
export const PRODUCTS = [
  { id: 'sub_month', kind: 'subscription', months: 1, label: '월 구독', labelEn: 'Monthly plan', price: tiered(9587), firstPrice: tiered(6254), usd: { price: usd(999, 499), firstPrice: usd(649, 329) } },
  { id: 'sub_year', kind: 'subscription', months: 12, label: '연간 구독', labelEn: 'Annual plan', price: tiered(101591), firstPrice: tiered(62389), usd: { price: usd(9999, 4999), firstPrice: usd(6149, 3069) } },
  { id: 'once_month', kind: 'once', months: 1, label: '1개월', labelEn: '1 month', price: tiered(10120), usd: { price: usd(1049, 529) } },
  { id: 'once_year', kind: 'once', months: 12, label: '1년', labelEn: '1 year', price: tiered(69323), usd: { price: usd(6819, 3409) } },
  // ponytail: 추가 상품 가격은 PikPak 이 공개하지 않아 미믹 자체 값 그대로. PikPak 가격을 확인하면 바꾼다
  { id: 'storage_10tb_year', kind: 'addon_storage', months: 12, bytes: 10 * TB, label: '추가 저장공간 10TB · 1년', labelEn: 'Extra 10TB storage · 1 year', price: { global: 59000, regional: 29500 }, usd: { price: usd(6149, 3079) } },
  { id: 'quota_month', kind: 'addon_quota', months: 1, amounts: { cloud: 10 * TB, down: 1 * TB, up: 256 * GB }, label: '추가 전송 쿼터 · 1개월', labelEn: 'Extra transfer quota · 1 month', price: { global: 9900, regional: 4900 }, usd: { price: usd(1029, 509) } },
  { id: 'quota_year', kind: 'addon_quota', months: 12, amounts: { cloud: 10 * TB, down: 1 * TB, up: 256 * GB }, label: '추가 전송 쿼터 · 1년', labelEn: 'Extra transfer quota · 1 year', price: { global: 99000, regional: 49000 }, usd: { price: usd(10319, 5109) } },
];
// 암호화폐는 국내 규제 검토 전까지 보류(8-4)라 받지 않는다. 받을 수 있는 수단 전체
export const PAYMENT_METHODS = ['card', 'paypal', 'alipay', 'unionpay'];
// 결제 통화별 수단: 국내(원화)는 카드(결제창 안 국내 간편결제 포함), 해외(달러)는 해외 카드·PayPal·Alipay·UnionPay(카드 브랜드)
export const METHODS_BY_CURRENCY = { KRW: ['card'], USD: PAYMENT_METHODS };
// 상품이 주는 일수: 1년 = 365일, 그 외 30일 × 개월(초대 보상 예시 "월 구독 4회 → 42일, 연 구독 → 128일"과 맞춤)
export const productDays = (p) => (p.months === 12 ? 365 : p.months * 30);
// 출석 체크(I-06). ponytail: PikPak 보상 수치 미확인 → 미믹 자체 값(7일 연속마다 프리미엄 1일)
export const CHECKIN = { rewardEvery: 7, rewardDays: 1 };
export const TRIAL_REMIND_DAYS = 3; // 체험 코드 종료 알림
export const RENEW_REMIND_DAYS = 7; // 정기결제 갱신 사전 안내(국내 규정)
export const RENEW_RETRIES = 3; // 자동 갱신 결제가 실패하면 하루 간격으로 이만큼 시도한 뒤 자동 갱신을 멈춘다
export const ORDER_KEEP_DAYS = 5 * 365; // 탈퇴·삭제 회원의 결제 기록 보관 기간(전자상거래법: 대금결제·공급 기록 5년)

export const REFERRAL = { shareRate: 0.35, windowDays: 365, bindHours: 12, uploadBonusEvery: 10, uploadBonus: 100 * GB, uploadBonusMax: 5 * TB };
// 추천 보상 Pro(I-05) 기본값. 관리자가 바꾸면 billing_meta 값이 우선한다(billing proSettings).
// cashPercent: 친구 결제 금액 중 현금 보상 비율(%, 그 결제 통화), minWithdraw: 출금 최소 금액(최소 단위: 원·센트)
export const REFERRAL_PRO = { cashPercent: 20, minWithdraw: { KRW: 10000, USD: 1000 } };
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
