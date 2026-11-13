import crypto from 'node:crypto';
import fs from 'node:fs';
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
    secret: env.MIMIC_SECRET || DEV_SECRET, // 바꾸면 저장된 자동 결제 카드(빌링키 암호문)를 풀 수 없어 그 구독은 자동 갱신이 멈춘다
    timezoneOffsetMin: 9 * 60, // 쿼터 일·월 초기화 기준: KST
    runJobs: true,
    oauth: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      facebook: { clientId: env.FACEBOOK_CLIENT_ID, clientSecret: env.FACEBOOK_CLIENT_SECRET },
      apple: { clientId: env.APPLE_CLIENT_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY },
    },
    // 해외(달러) 결제는 토스 달러 전용 상점 키가 따로 있다(Q-4). fxUsdKrw: 환율을 받아 오지 못할 때 쓰는 USD/KRW(없으면 billing 기본값)
    payments: {
      tossClientKey: env.TOSS_CLIENT_KEY,
      tossSecretKey: env.TOSS_SECRET_KEY,
      tossClientKeyUsd: env.TOSS_CLIENT_KEY_USD,
      tossSecretKeyUsd: env.TOSS_SECRET_KEY_USD,
      tossApiBase: env.TOSS_API_BASE,
      fxUsdKrw: env.MIMIC_FX_USD_KRW,
    },
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    supportEmail: env.MIMIC_SUPPORT_EMAIL || 'support@mimic.local',
    adminEmail: env.MIMIC_ADMIN_EMAIL,
    // 신뢰하는 프록시가 붙이는 IP 국가 헤더 이름(예: cf-ipcountry). 없으면 휴대폰 없는 가입의 지역은 기기 언어로만 정한다(K-04)
    countryHeader: env.MIMIC_COUNTRY_HEADER?.trim().toLowerCase() || undefined,
    // 비공개 미리보기·베타: 설정하면 사이트 전체가 접속 비밀번호(HTTP Basic)를 물어본다
    sitePassword: env.MIMIC_SITE_PASSWORD || undefined,
    // 체험(데모) 서버: 개발 모드에서만. 새 가입 인증코드를 화면에 바로 보여 준다(메일 업체 없이 가입 체험). 운영에서는 무시
    demo: env.MIMIC_DEMO === '1',
    // 운영 모드 발송 대행사(H-01): JSON POST { from, to, subject, text } + Authorization: Bearer <KEY>
    mail: { api: env.MIMIC_EMAIL_API, key: env.MIMIC_EMAIL_API_KEY, from: env.MIMIC_EMAIL_FROM },
    sms: { api: env.MIMIC_SMS_API, key: env.MIMIC_SMS_API_KEY, from: env.MIMIC_SMS_FROM },
    // Android TWA 앱 링크(K-09, /.well-known/assetlinks.json): 패키지 이름과 서명 인증서 SHA-256 지문(쉼표로 여러 개).
    // apksigner 는 콜론 없이 64자로 출력하므로 Digital Asset Links 형식(AA:BB:…)으로 맞추고, 길이가 틀리면 시작 거부(앱 링크 검증이 조용히 실패함)
    androidPackage: env.MIMIC_ANDROID_PACKAGE?.trim() || undefined,
    androidSha256: (env.MIMIC_ANDROID_SHA256 || '').split(',').filter((s) => s.trim()).map((s) => {
      const hex = s.replace(/[\s:]/g, '').toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(hex)) throw new Error(`MIMIC_ANDROID_SHA256 의 지문이 SHA-256(16진수 64자)이 아닙니다: ${s.trim()}`);
      return hex.match(/../g).join(':');
    }),
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

// 웹 푸시 VAPID 키(K-05, RFC 8292): 공개키는 P-256 비압축 점 65바이트, 비밀키는 d 32바이트(둘 다 base64url).
// 환경변수(MIMIC_VAPID_PUBLIC_KEY·MIMIC_VAPID_PRIVATE_KEY)가 없으면 처음 쓸 때 만들어 데이터 폴더 vapid.json 에 두고 계속 쓴다
export function vapidKeys(cfg) {
  if (cfg.vapid) return cfg.vapid;
  const env = process.env;
  const subject = env.MIMIC_VAPID_SUBJECT || `mailto:${cfg.supportEmail}`;
  if (env.MIMIC_VAPID_PUBLIC_KEY || env.MIMIC_VAPID_PRIVATE_KEY) {
    if (!env.MIMIC_VAPID_PUBLIC_KEY || !env.MIMIC_VAPID_PRIVATE_KEY) throw new Error('MIMIC_VAPID_PUBLIC_KEY 와 MIMIC_VAPID_PRIVATE_KEY 는 함께 설정해야 합니다');
    return (cfg.vapid = { publicKey: env.MIMIC_VAPID_PUBLIC_KEY, privateKey: env.MIMIC_VAPID_PRIVATE_KEY, subject });
  }
  const file = path.join(cfg.dataDir, 'vapid.json');
  if (!fs.existsSync(file)) {
    const j = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ publicKey, privateKey: j.d }), { mode: 0o600 });
  }
  const { publicKey, privateKey } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (cfg.vapid = { publicKey, privateKey, subject });
}
