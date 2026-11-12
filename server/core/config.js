import os from 'node:os';
import path from 'node:path';

// 실행 데이터(DB·파일 본문)는 OneDrive 동기화를 피하려고 기본값을 홈 폴더 아래에 둔다.
export function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    port: Number(env.PORT || 4300),
    baseUrl: env.MIMIC_BASE_URL || `http://localhost:${env.PORT || 4300}`,
    dataDir: env.MIMIC_DATA || path.join(os.homedir(), '.mimic'),
    dev: env.NODE_ENV !== 'production',
    secret: env.MIMIC_SECRET || 'dev-secret-change-me',
    timezoneOffsetMin: 9 * 60, // 쿼터 일·월 초기화 기준: KST
    runJobs: true,
    oauth: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      facebook: { clientId: env.FACEBOOK_CLIENT_ID, clientSecret: env.FACEBOOK_CLIENT_SECRET },
      apple: { clientId: env.APPLE_CLIENT_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY },
    },
    payments: { tossClientKey: env.TOSS_CLIENT_KEY, tossSecretKey: env.TOSS_SECRET_KEY },
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    adminEmail: env.MIMIC_ADMIN_EMAIL,
    ...overrides,
  };
  return cfg;
}
