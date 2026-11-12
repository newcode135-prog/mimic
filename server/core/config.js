import os from 'node:os';
import path from 'node:path';

export const DEV_SECRET = 'dev-secret-change-me';
// 개발 모드는 로컬 주소(localhost·127.0.0.1·[::1])로 띄울 때만 켠다. 공개 도메인이면 NODE_ENV 를 빠뜨려도 운영 모드(H-01)
export const isLocalUrl = (u) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};

// 실행 데이터(DB·파일 본문)는 OneDrive 동기화를 피하려고 기본값을 홈 폴더 아래에 둔다.
export function loadConfig(overrides = {}) {
  const env = process.env;
  const baseUrl = env.MIMIC_BASE_URL || `http://localhost:${env.PORT || 4300}`;
  const cfg = {
    port: Number(env.PORT || 4300),
    baseUrl,
    dataDir: env.MIMIC_DATA || path.join(os.homedir(), '.mimic'),
    dev: env.NODE_ENV !== 'production' && isLocalUrl(baseUrl),
    secret: env.MIMIC_SECRET || DEV_SECRET,
    timezoneOffsetMin: 9 * 60, // 쿼터 일·월 초기화 기준: KST
    runJobs: true,
    oauth: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      facebook: { clientId: env.FACEBOOK_CLIENT_ID, clientSecret: env.FACEBOOK_CLIENT_SECRET },
      apple: { clientId: env.APPLE_CLIENT_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY },
    },
    payments: { tossClientKey: env.TOSS_CLIENT_KEY, tossSecretKey: env.TOSS_SECRET_KEY, tossApiBase: env.TOSS_API_BASE },
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    supportEmail: env.MIMIC_SUPPORT_EMAIL || 'support@mimic.local',
    adminEmail: env.MIMIC_ADMIN_EMAIL,
    // 신뢰하는 프록시가 붙이는 IP 국가 헤더 이름(예: cf-ipcountry). 없으면 휴대폰 없는 가입의 지역은 기기 언어로만 정한다(K-04)
    countryHeader: env.MIMIC_COUNTRY_HEADER?.trim().toLowerCase() || undefined,
    // 운영 모드 발송 대행사(H-01): JSON POST { from, to, subject, text } + Authorization: Bearer <KEY>
    mail: { api: env.MIMIC_EMAIL_API, key: env.MIMIC_EMAIL_API_KEY, from: env.MIMIC_EMAIL_FROM },
    sms: { api: env.MIMIC_SMS_API, key: env.MIMIC_SMS_API_KEY, from: env.MIMIC_SMS_FROM },
    ...overrides,
  };
  // 운영 모드에서 공개된 기본 비밀값이면 다운로드·공유 링크를 누구나 위조할 수 있다(B-04) → 시작 거부
  if (!cfg.dev && (!cfg.secret || cfg.secret === DEV_SECRET || cfg.secret.length < 32)) {
    throw new Error('운영 모드에서는 MIMIC_SECRET(32자 이상 임의 문자열)을 설정해야 합니다');
  }
  if (!cfg.dev && !cfg.quiet) {
    if (cfg.supportEmail.endsWith('.local')) console.warn(`[config] MIMIC_SUPPORT_EMAIL 이 설정되지 않아 받을 수 없는 주소(${cfg.supportEmail})가 공개됩니다`);
    if (!cfg.mail?.api) console.warn('[config] MIMIC_EMAIL_API 가 없어 이메일(인증코드·안내)이 발송되지 않습니다. 이메일 가입·로그인·비밀번호 찾기를 끝까지 할 수 없습니다');
    if (!cfg.sms?.api) console.warn('[config] MIMIC_SMS_API 가 없어 SMS(인증코드·안내)가 발송되지 않습니다. 휴대폰 가입·로그인을 끝까지 할 수 없습니다');
    if (!cfg.countryHeader) console.warn('[config] MIMIC_COUNTRY_HEADER(예: cf-ipcountry)가 없어 지역 판정이 브라우저 언어로만 됩니다. 국가별 가입·다운로드 제한을 언어만 바꿔 우회할 수 있습니다');
  }
  return cfg;
}
