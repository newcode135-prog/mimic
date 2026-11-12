// 도움말·정책·블로그 본문에 넣는 정책 수치. plans.js 값을 그대로 읽어 문서와 실제 동작이 어긋나지 않게 한다.
import {
  LIMITS,
  MONTHLY_QUOTA,
  APP_QUOTA_SHARE,
  FREE_APP_DAILY_DOWN,
  SLOW_BPS,
  SPEED_BPS,
  TRASH_DAYS,
  SIGNUP_BONUS_CLOUD,
  BT_MAX_FILES,
  REFERRAL,
  EXPIRY,
  DORMANT,
  ACCOUNT_DELETE_GRACE_DAYS,
  CHECKIN,
} from '../../../core/plans.js';

export function size(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${+n.toFixed(1)}${u[i]}`;
}

export const N = {
  freeStorage: size(LIMITS.free.storage),
  premiumStorage: size(LIMITS.premium.storage),
  freePerDay: LIMITS.free.cloudPerDay,
  signupBonus: SIGNUP_BONUS_CLOUD,
  freeDailyDown: size(LIMITS.free.dailyDown),
  freeTasks: LIMITS.free.concurrentTasks,
  premiumTasks: LIMITS.premium.concurrentTasks,
  mCloud: size(MONTHLY_QUOTA.cloud),
  mDown: size(MONTHLY_QUOTA.down),
  mUp: size(MONTHLY_QUOTA.up),
  appShare: Math.round(APP_QUOTA_SHARE * 100),
  freeAppDown: size(FREE_APP_DAILY_DOWN),
  slow: size(SLOW_BPS) + '/s',
  speedGlobal: size(SPEED_BPS.global) + '/s',
  speedRegional: size(SPEED_BPS.regional) + '/s',
  trashDays: TRASH_DAYS,
  btMax: BT_MAX_FILES.toLocaleString('ko-KR'),
  refRate: Math.round(REFERRAL.shareRate * 100),
  refWindow: REFERRAL.windowDays,
  refBind: REFERRAL.bindHours,
  refEvery: REFERRAL.uploadBonusEvery,
  refBonus: size(REFERRAL.uploadBonus),
  refMax: size(REFERRAL.uploadBonusMax),
  playStop: EXPIRY.playbackStopDays,
  overMonths: EXPIRY.overQuotaMonths,
  warnMonths: EXPIRY.warnMonths,
  delWindow: EXPIRY.deleteWindowDays.join('~'),
  dormantMonths: DORMANT.freeInactiveMonths,
  dormantGrace: DORMANT.graceDays,
  hardYears: DORMANT.hardInactiveYears,
  deleteGrace: ACCOUNT_DELETE_GRACE_DAYS,
  checkinEvery: CHECKIN.rewardEvery,
  checkinDays: CHECKIN.rewardDays,
  counterWaitDays: 10, // 저작권 이의제기를 권리자에게 전달한 뒤 법적 조치 통지를 기다리는 날수(저작권법 시행령: 7~14일). content 모듈이 메일에 쓴다
};
