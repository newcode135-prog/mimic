// auth 모듈: 가입·로그인 6종(H-01), 계정 및 보안(H-02), 휴면 정리(H-03), 계정 공유 탐지(H-04), 피드백(H-05), 지역 정책(K-04), CLI 기기 인가(G-02 로그인)
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { now, newId, sha256, randomCode, fail, json, rateLimit, DAY } from '../../core/util.js';
import {
  requireUser,
  requireAdmin,
  createSession,
  setSessionCookie,
  destroySession,
  readToken,
  createToken,
  hashPassword,
  verifyPassword,
  passwordValid,
  publicUser,
  getSettings,
  saveSettings,
  parseCookies,
  COOKIE,
} from '../../core/auth.js';
import { notify, sendMessage, audit } from '../../core/notify.js';
import { isPremium, DORMANT, ACCOUNT_DELETE_GRACE_DAYS } from '../../core/plans.js';
import { PROVIDERS, providerCfg, authorizeUrl, exchangeCode } from './oauth.js';

const MIN = 60_000;
const CODE_TTL = 5 * MIN;
const CODE_RESEND = MIN;
const CODE_MAX_TRIES = 5;
// 대상(이메일·번호)별: 코드를 새로 받아도 틀린 횟수를 합산해 10회면 1시간 잠금, 하루 10개까지 발급(코드 추측으로 재설정·로그인 탈취 방지)
const CODE_TARGET_FAILS = 10;
const CODE_LOCK = 60 * MIN;
const CODE_DAILY = 10;
const LOGIN_FAILS = 5;
const LOGIN_WINDOW = 15 * MIN;
const QR_TTL = 2 * MIN;
const DEVICE_TTL = 10 * MIN;
const DEVICE_INTERVAL = 5;
const OAUTH_STATE_TTL = 10 * MIN;
// 소셜 로그인 state 를 시작한 브라우저에 묶는 쿠키(로그인·연결 CSRF 방지)
const OAUTH_COOKIE = 'mimic_oauth';
const OAUTH_PATH = '/api/auth/oauth';
const UNVERIFIED_LOCK_MS = 72 * 3600_000;
const LOCKED_DELETE_MS = 365 * DAY;
export const SHARING = { windowMs: 3600_000, maxNets: 5, suspendMs: DAY }; // 1시간 안에 /24 대역 5곳 이상 → 24시간 정지
export const SCOPES = ['files:read', 'files:write', 'files:manage', 'files:delete', 'services', 'account'];
const FEEDBACK_CATEGORIES = ['bug', 'feature', 'download', 'playback', 'account', 'payment', 'other'];
// 휴대폰 국가번호 → 지역(ISO). 화면의 국가 선택 목록(web/pages/login.js)과 같은 15개국
export const COUNTRIES = { '+82': 'KR', '+1': 'US', '+81': 'JP', '+86': 'CN', '+852': 'HK', '+886': 'TW', '+65': 'SG', '+84': 'VN', '+66': 'TH', '+63': 'PH', '+62': 'ID', '+60': 'MY', '+91': 'IN', '+44': 'GB', '+61': 'AU' };
// ITU 국가 호출코드 전체. 서로 접두어가 겹치지 않는 목록이라, 여기 있는 값만 규칙으로 받으면 접두어 일치가 곧 정확한 국가 일치가 된다
const DIAL_CODES = new Set(
  `1 20 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249
  250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 27 290 291 297 298 299
  30 31 32 33 34 350 351 352 353 354 355 356 357 358 359 36 370 371 372 373 374 375 376 377 378 379 380 381 382 383 385 386 387 389 39
  40 41 420 421 423 43 44 45 46 47 48 49 500 501 502 503 504 505 506 507 508 509 51 52 53 54 55 56 57 58 590 591 592 593 594 595 596 597 598 599
  60 61 62 63 64 65 66 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 7
  800 808 81 82 84 850 852 853 855 856 86 870 878 880 881 882 883 886 888
  90 91 92 93 94 95 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 979 98 991 992 993 994 995 996 998`
    .split(/\s+/)
    .map((c) => `+${c}`),
);
// 지역(ISO) → 국가번호. 휴대폰 없는 사용자(이메일·소셜 가입)를 관리자 규칙(국가번호)에 맞춰 보기 위한 표. 값은 모두 DIAL_CODES 안에 있다
const ISO_DIAL = Object.fromEntries(
  `1 US CA UM AG AI AS BB BM BS DM DO GD GU JM KN KY LC MP MS PR SX TC TT VC VG VI|7 RU KZ|20 EG|211 SS|212 MA EH|213 DZ|216 TN|218 LY
  |220 GM|221 SN|222 MR|223 ML|224 GN|225 CI|226 BF|227 NE|228 TG|229 BJ|230 MU|231 LR|232 SL|233 GH|234 NG|235 TD|236 CF|237 CM|238 CV|239 ST
  |240 GQ|241 GA|242 CG|243 CD|244 AO|245 GW|246 IO|248 SC|249 SD|250 RW|251 ET|252 SO|253 DJ|254 KE|255 TZ|256 UG|257 BI|258 MZ
  |260 ZM|261 MG|262 RE YT TF|263 ZW|264 NA|265 MW|266 LS|267 BW|268 SZ|269 KM|27 ZA|290 SH|291 ER|297 AW|298 FO|299 GL
  |30 GR|31 NL|32 BE|33 FR|34 ES|350 GI|351 PT|352 LU|353 IE|354 IS|355 AL|356 MT|357 CY|358 FI AX|359 BG|36 HU
  |370 LT|371 LV|372 EE|373 MD|374 AM|375 BY|376 AD|377 MC|378 SM|379 VA|380 UA|381 RS|382 ME|383 XK|385 HR|386 SI|387 BA|389 MK|39 IT
  |40 RO|41 CH|420 CZ|421 SK|423 LI|43 AT|44 GB GG IM JE|45 DK|46 SE|47 NO SJ|48 PL|49 DE
  |500 FK GS|501 BZ|502 GT|503 SV|504 HN|505 NI|506 CR|507 PA|508 PM|509 HT|51 PE|52 MX|53 CU|54 AR|55 BR|56 CL|57 CO|58 VE
  |590 GP BL MF|591 BO|592 GY|593 EC|594 GF|595 PY|596 MQ|597 SR|598 UY|599 CW BQ
  |60 MY|61 AU CX CC|62 ID|63 PH|64 NZ PN|65 SG|66 TH|670 TL|672 NF AQ|673 BN|674 NR|675 PG|676 TO|677 SB|678 VU|679 FJ
  |680 PW|681 WF|682 CK|683 NU|685 WS|686 KI|687 NC|688 TV|689 PF|690 TK|691 FM|692 MH
  |81 JP|82 KR|84 VN|850 KP|852 HK|853 MO|855 KH|856 LA|86 CN|880 BD|886 TW
  |90 TR|91 IN|92 PK|93 AF|94 LK|95 MM|960 MV|961 LB|962 JO|963 SY|964 IQ|965 KW|966 SA|967 YE|968 OM
  |970 PS|971 AE|972 IL|973 BH|974 QA|975 BT|976 MN|977 NP|98 IR|992 TJ|993 TM|994 AZ|995 GE|996 KG|998 UZ`
    .split('|')
    .flatMap((g) => {
      const [code, ...isos] = g.trim().split(/\s+/);
      return isos.map((iso) => [iso, `+${code}`]);
    }),
);

export const migrations = `
CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY, target TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE INDEX IF NOT EXISTS auth_codes_target ON auth_codes(target, purpose);
CREATE TABLE IF NOT EXISTS auth_failures (key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_failures_key ON auth_failures(key, created_at);
CREATE TABLE IF NOT EXISTS auth_qr (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE, req_ip TEXT, req_ua TEXT, approver_ip TEXT, approver_ua TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_device (
  id TEXT PRIMARY KEY, user_code_hash TEXT NOT NULL UNIQUE, client_name TEXT NOT NULL, app_id TEXT NOT NULL DEFAULT 'cli', scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  req_ip TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_oauth_states (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT, next_url TEXT, agree INTEGER NOT NULL DEFAULT 0, nonce TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_feedback (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, category TEXT NOT NULL,
  message TEXT NOT NULL, contact TEXT, ip TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_region_rules (
  country_code TEXT PRIMARY KEY, block_signup INTEGER NOT NULL DEFAULT 1, block_download INTEGER NOT NULL DEFAULT 0,
  note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_activity (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, net TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (user_id, net)
);
CREATE TABLE IF NOT EXISTS auth_meta (k TEXT PRIMARY KEY, v TEXT);
INSERT OR IGNORE INTO auth_region_rules (country_code, block_signup, block_download, note, created_at)
  SELECT '+86', 1, 0, '기본 규칙', 0 WHERE NOT EXISTS (SELECT 1 FROM auth_meta WHERE k = 'region_seeded');
INSERT OR IGNORE INTO auth_meta (k, v) VALUES ('region_seeded', '1');
`;

// ---------- 공통 도우미 ----------
const normEmail = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, 'invalid_email', '이메일 주소를 확인해 주세요');
  return s;
};
const normPhone = (v) => {
  const s = String(v ?? '').replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(s)) fail(400, 'invalid_phone', '휴대폰 번호를 국가번호와 함께 확인해 주세요');
  return s;
};
const cleanInvite = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v.trim()) ? v.trim() : null);
const safeNext = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/drive/all');
const needUser = (req) => requireUser(req, null, () => {});
// 계정 변경·승인은 웹 세션으로만(연결 앱 토큰으로는 불가)
const needSession = (req) => {
  needUser(req);
  if (req.authKind !== 'session') fail(403, 'session_required', '웹에서 로그인한 상태에서만 할 수 있습니다');
};
const sessionOnly = (req, _res, next) => (needSession(req), next());
const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

function emit(ctx, name, payload) {
  try {
    ctx.events.emit(name, payload);
  } catch (e) {
    console.error(`[auth] ${name} 처리 중 오류`, e);
  }
}

const dialOf = (phone) => Object.keys(COUNTRIES).filter((k) => phone.startsWith(k)).sort((a, b) => b.length - a.length)[0] || null;
// 지역 판정 → { region, from }: 휴대폰 국가번호 → 신뢰하는 프록시가 붙인 IP 국가 헤더(cfg.countryHeader, 예: 'cf-ipcountry') → 기기 언어(Accept-Language)
// 언어 태그는 표준 방식으로 지역을 채운다(zh-Hant-TW·zh-Hant → TW, zh → CN, en → US)
export function regionOf(req, phone, cfg) {
  const dial = phone && dialOf(phone);
  if (dial) return { region: COUNTRIES[dial], from: 'phone' };
  const ipCountry = cfg?.countryHeader ? String(req?.get?.(cfg.countryHeader) || '').trim().toUpperCase() : '';
  if (/^[A-Z]{2}$/.test(ipCountry) && ipCountry !== 'XX') return { region: ipCountry, from: 'ip' };
  try {
    const r = new Intl.Locale(String(req?.get?.('accept-language') || '').split(',')[0].split(';')[0].trim().replace(/_/g, '-')).maximize().region;
    if (/^[A-Z]{2}$/.test(r || '')) return { region: r, from: 'lang' };
  } catch {}
  return { region: 'KR', from: 'default' };
}
// DIAL_CODES 는 접두어가 겹치지 않으므로, 그 안의 규칙에 한해 접두어 일치 = 그 나라 번호(예전에 잘못 저장된 규칙은 무시)
const ruleFor = (db, phone, col) =>
  db
    .prepare(`SELECT country_code FROM auth_region_rules WHERE ${col}=1`)
    .all()
    .find((r) => DIAL_CODES.has(r.country_code) && phone.startsWith(r.country_code));
// register 가 서버(app)별 설정을 남긴다 → regionBlocked 가 req 만 받아도 그 서버의 IP 국가 헤더(cfg.countryHeader)를 안다
const cfgByApp = new WeakMap();
// K-04: 다른 모듈(offline 등)이 ctx.modules.auth.regionBlocked(db, user, 'download', req) 로 쓸 수 있다.
// 가입 때 저장한 지역(번호·region)과, req 를 주면 지금 요청의 IP 국가(신뢰하는 프록시 헤더가 있을 때만)도 함께 본다
export function regionBlocked(db, user, kind = 'download', req = null) {
  const col = kind === 'signup' ? 'block_signup' : 'block_download';
  const cur = req ? regionOf(req, null, cfgByApp.get(req.app)) : null;
  const dials = [user?.phone || ISO_DIAL[user?.region], cur?.from === 'ip' && ISO_DIAL[cur.region]];
  return dials.some((d) => d && ruleFor(db, d, col));
}
const REGION_BLOCKED_MSG = '현재 지역(국가번호)에서는 새로 가입할 수 없습니다';
// H-01: 새 계정은 필수 동의(만 14세 이상·이용약관·개인정보 수집·이용)를 하나씩 따로 받는다. 마케팅 수신은 선택
const consentOf = (b) => ({ required: b?.agreeAge14 === true && b?.agreeTerms === true && b?.agreePrivacy === true, marketing: b?.agreeMarketing === true });
const TERMS_MSG = '만 14세 이상 확인, 이용약관과 개인정보 수집·이용 동의가 필요합니다';
// 기기 인가로 연결할 수 있는 앱. webdav·mcp·telegram 은 설정 화면에서 따로 만드는 연결이라 받지 않는다(공식 앱 이름 사칭 방지)
const DEVICE_APPS = new Set(['cli', 'extension']);

// ---------- 인증코드(5분 유효·60초 재전송 제한·해시 저장) ----------
const codeHash = (cfg, target, purpose, code) => sha256(`${cfg.secret}:${target}:${purpose}:${code}`);
const CODE_LOCK_MSG = '인증코드를 너무 많이 틀렸습니다. 1시간 뒤에 다시 시도해 주세요';
function issueCode(db, cfg, req, { target, purpose, channel }) {
  if (!rateLimit(`auth-code:${req.ip}`, 30, 10 * MIN)) fail(429, 'too_many_requests', '요청이 너무 많습니다. 잠시 뒤에 다시 시도해 주세요');
  checkFails(db, `code:${target}`, CODE_TARGET_FAILS, CODE_LOCK, CODE_LOCK_MSG);
  const last = db.prepare('SELECT created_at FROM auth_codes WHERE target=? AND purpose=? ORDER BY rowid DESC LIMIT 1').get(target, purpose);
  const wait = last ? CODE_RESEND - (now() - last.created_at) : 0;
  if (wait > 0) fail(429, 'too_soon', `인증코드는 ${Math.ceil(wait / 1000)}초 뒤에 다시 받을 수 있습니다`);
  if (db.prepare('SELECT count(*) AS n FROM auth_codes WHERE target=? AND created_at>?').get(target, now() - DAY).n >= CODE_DAILY) {
    fail(429, 'too_many_codes', '오늘 받을 수 있는 인증코드 수를 넘었습니다. 내일 다시 시도해 주세요');
  }
  const code = randomCode(6);
  db.prepare('INSERT INTO auth_codes (id, target, purpose, code_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(
    newId('c_'),
    target,
    purpose,
    codeHash(cfg, target, purpose, code),
    now(),
    now() + CODE_TTL,
  );
  sendMessage(db, cfg, {
    channel,
    to: target,
    subject: channel === 'email' ? '[미믹] 인증코드 안내' : null,
    body: `미믹 인증코드는 ${code} 입니다. 5분 안에 입력해 주세요. 직접 요청하지 않았다면 이 메시지는 무시하셔도 됩니다.`,
  });
  return { ok: true, expiresIn: CODE_TTL / 1000, resendIn: CODE_RESEND / 1000 };
}
// 확인 한도: 코드 하나 5회 + 대상별 합산 10회/1시간 + IP 별 30회/10분(여러 대상을 번갈아 노리는 추측 방지)
function useCode(db, cfg, req, { target, purpose, code }) {
  if (!rateLimit(`auth-verify:${req.ip}`, 30, 10 * MIN)) fail(429, 'too_many_requests', '요청이 너무 많습니다. 잠시 뒤에 다시 시도해 주세요');
  const key = `code:${target}`;
  checkFails(db, key, CODE_TARGET_FAILS, CODE_LOCK, CODE_LOCK_MSG);
  const row = db.prepare('SELECT * FROM auth_codes WHERE target=? AND purpose=? AND used_at IS NULL ORDER BY rowid DESC LIMIT 1').get(target, purpose);
  if (!row || row.expires_at < now()) fail(400, 'code_expired', '인증코드가 없거나 만료되었습니다. 다시 받아 주세요');
  if (row.attempts >= CODE_MAX_TRIES) fail(429, 'too_many_attempts', '인증코드를 너무 많이 틀렸습니다. 새 코드를 받아 주세요');
  if (codeHash(cfg, target, purpose, String(code ?? '').trim()) !== row.code_hash) {
    db.prepare('UPDATE auth_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    addFail(db, key);
    fail(400, 'invalid_code', '인증코드가 맞지 않습니다');
  }
  db.prepare('UPDATE auth_codes SET used_at=? WHERE id=?').run(now(), row.id);
  clearFails(db, key);
}

// ---------- 실패 제한(로그인: 15분 안에 5회) ----------
function checkFails(db, key, max = LOGIN_FAILS, windowMs = LOGIN_WINDOW, msg = '로그인 시도 횟수를 넘었습니다. 15분 뒤에 다시 시도해 주세요') {
  const { n } = db.prepare('SELECT count(*) AS n FROM auth_failures WHERE key=? AND created_at>?').get(key, now() - windowMs);
  if (n >= max) fail(429, 'too_many_attempts', msg);
}
const addFail = (db, key) => db.prepare('INSERT INTO auth_failures (key, created_at) VALUES (?,?)').run(key, now());
const clearFails = (db, key) => db.prepare('DELETE FROM auth_failures WHERE key=?').run(key);

// ---------- 계정 만들기·로그인 ----------
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newInviteCode = () => Array.from({ length: 8 }, () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)]).join('');

// 모든 가입(이메일·휴대폰·소셜)이 지나가는 곳: K-04 가입 차단 지역이면 여기서 막는다.
// email 은 인증된 주소만 받는다(인증코드 확인·공급자가 인증했다고 알린 주소). 인증된 주소는 settings.verifiedEmail 에도 남겨 소셜 자동 연결의 기준으로 쓴다
function createAccount(ctx, req, { email = null, phone = null, password = null, name = '', via, inviteCode = null, status = 'active', marketing = false }) {
  const { db, cfg } = ctx;
  const { region, from: regionFrom } = regionOf(req, phone, cfg);
  if (regionBlocked(db, { phone, region }, 'signup')) fail(403, 'region_blocked', REGION_BLOCKED_MSG);
  const id = newId('u_');
  const display = (name || (email ? email.split('@')[0] : phone ? `미믹${phone.slice(-4)}` : '미믹 사용자')).slice(0, 30);
  const lang = /^en/i.test(req?.get?.('accept-language') || '') ? 'en' : 'ko';
  const settings = JSON.stringify({ consentAt: now(), marketingConsent: !!marketing, verifiedEmail: email || undefined }); // 필수 동의 시각·선택(마케팅) 동의 여부
  for (let i = 0; ; i++) {
    try {
      db.prepare('INSERT INTO users (id, email, phone, password_hash, name, lang, region, status, invite_code, settings, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        id,
        email,
        phone,
        password ? hashPassword(password) : null,
        display,
        lang,
        region,
        status,
        newInviteCode(),
        settings,
        now(),
      );
      break;
    } catch (e) {
      if (/users\.(email|phone)/.test(e.message)) fail(409, 'already_registered', '이미 가입된 연락처입니다');
      if (i >= 5 || !/invite_code/.test(e.message)) throw e;
    }
  }
  audit(db, { userId: id, action: 'auth:signup', detail: { via, marketing: !!marketing, region, regionFrom }, ip: req?.ip });
  emit(ctx, 'user:created', { userId: id, via, inviteCode: cleanInvite(inviteCode) });
  return getUser(db, id);
}

const suspendedMsg = (until) => (until ? `계정 공유가 감지되어 ${new Date(until).toLocaleString('ko-KR')}까지 이용이 정지되었습니다` : '계정 이용이 정지되었습니다. 고객지원으로 문의해 주세요');

// 모든 로그인 방식이 거치는 곳: 상태 확인·탈퇴 복구·세션 발급
function login(ctx, req, res, user, via) {
  const { db, cfg } = ctx;
  if (user.status === 'locked') fail(403, 'account_locked', '인증을 마치지 않아 잠긴 계정입니다. 고객지원으로 문의해 주세요');
  if (user.status === 'suspended') {
    if (!user.status_until || user.status_until > now()) fail(403, 'account_suspended', suspendedMsg(user.status_until));
    unsuspend(db, now(), user.id);
  }
  if (user.status === 'pending_delete') {
    // 유예(7일)가 지났으면 복구하지 않고 그 자리에서 삭제한다(매시간 작업이 아직 돌지 않았어도). 관리자가 삭제를 멈춘 계정(deleteHold)은 제외
    if (user.delete_requested_at && now() - user.delete_requested_at >= ACCOUNT_DELETE_GRACE_DAYS * DAY && !getSettings(user).deleteHold) {
      purge(ctx, user.id, 'withdrawn');
      fail(401, 'account_deleted', `탈퇴 신청 후 ${ACCOUNT_DELETE_GRACE_DAYS}일이 지나 계정이 삭제되었습니다`);
    }
    db.prepare("UPDATE users SET status='active', delete_requested_at=NULL WHERE id=?").run(user.id);
    notify(db, user.id, { kind: 'account', title: '계정 삭제 신청이 취소되었습니다', body: '유예 기간 안에 다시 로그인하셔서 계정과 파일이 그대로 돌아왔습니다.' });
    audit(db, { userId: user.id, action: 'auth:delete_cancelled', ip: req.ip });
  }
  if (getSettings(user).dormantNoticeAt) saveSettings(db, user.id, { dormantNoticeAt: null });
  const token = createSession(db, user.id, req, 'web');
  if (detectSharing(ctx, user.id)) fail(403, 'account_suspended', suspendedMsg(getUser(db, user.id).status_until));
  setSessionCookie(res, token, cfg);
  audit(db, { userId: user.id, action: 'auth:login', detail: { via }, ip: req.ip });
  emit(ctx, 'user:login', { userId: user.id, via });
  return publicUser(getUser(db, user.id));
}

function passwordLogin(ctx, req, res, field, value, password, via) {
  const { db } = ctx;
  const key = `${field}:${value}`;
  checkFails(db, key);
  const u = db.prepare(`SELECT * FROM users WHERE ${field}=?`).get(value);
  if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) {
    addFail(db, key);
    fail(401, 'invalid_credentials', '계정 또는 비밀번호가 맞지 않습니다');
  }
  clearFails(db, key);
  return login(ctx, req, res, u, via);
}

// ---------- H-04 계정 공유 탐지 ----------
// IPv4 는 /24, IPv6 는 축약을 풀어 앞 48비트로 묶는다
export function netOf(ip) {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split('.').slice(0, 3).join('.');
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(':');
}
// 정지 해제: 정지 전 상태(미인증 등)로 되돌린다
function unsuspend(db, t, id = null) {
  db.prepare(
    `UPDATE users SET status=COALESCE(json_extract(settings, '$.suspendedFrom'), 'active'), status_until=NULL, settings=json_remove(settings, '$.suspendedFrom')
     WHERE status='suspended' AND status_until IS NOT NULL AND status_until <= ? AND (? IS NULL OR id = ?)`,
  ).run(t, id, id);
}
// 사용자 요청이 들어온 IP 대역 기록(웹 세션·연결 앱 토큰 활동). 처음 보는 대역이면 바로 공유 탐지를 돌린다
function recordActivity(ctx, userId, ip) {
  const net = netOf(ip);
  if (!net) return false;
  const prev = ctx.db.prepare('SELECT seen_at FROM auth_activity WHERE user_id=? AND net=?').get(userId, net);
  ctx.db.prepare('INSERT INTO auth_activity (user_id, net, seen_at) VALUES (?,?,?) ON CONFLICT(user_id, net) DO UPDATE SET seen_at=excluded.seen_at').run(userId, net, now());
  return !prev || prev.seen_at < now() - SHARING.windowMs ? detectSharing(ctx, userId) : false;
}
// 1시간 안에 세션을 만든 IP + 세션·토큰으로 들어온 요청 IP 의 대역 수를 센다
export function detectSharing(ctx, userId) {
  const { db, cfg } = ctx;
  const since = now() - SHARING.windowMs;
  const rows = db.prepare('SELECT ip FROM sessions WHERE user_id=? AND last_seen_at>?').all(userId, since);
  const nets = new Set(rows.map((r) => netOf(r.ip)).filter(Boolean));
  for (const r of db.prepare('SELECT net FROM auth_activity WHERE user_id=? AND seen_at>?').all(userId, since)) nets.add(r.net);
  if (nets.size < SHARING.maxNets) return false;
  const until = now() + SHARING.suspendMs;
  const changed = db
    .prepare("UPDATE users SET status='suspended', status_until=?, settings=json_set(settings, '$.suspendedFrom', status) WHERE id=? AND status IN ('active', 'unverified')")
    .run(until, userId).changes;
  if (!changed) return false;
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM auth_activity WHERE user_id=?').run(userId); // 정지가 풀린 뒤 예전 기록으로 다시 정지되지 않게
  const body = `짧은 시간에 서로 다른 ${nets.size}곳의 네트워크에서 로그인이 확인되어 24시간 동안 이용을 멈췄습니다. 본인이 아니라면 정지가 풀린 뒤 비밀번호를 바꿔 주세요.`;
  notify(db, userId, { kind: 'security', title: '계정 공유가 감지되어 일시 정지되었습니다', body });
  const u = getUser(db, userId);
  // 정지 중에는 사이트 알림을 볼 수 없으니 이메일, 없으면 SMS 로도 알린다
  if (u.email) sendMessage(db, cfg, { channel: 'email', to: u.email, subject: '[미믹] 계정 일시 정지 안내', body });
  else if (u.phone) sendMessage(db, cfg, { channel: 'sms', to: u.phone, body: `[미믹] ${body}` });
  audit(db, { userId, action: 'auth:sharing_suspended', detail: { nets: nets.size, until } });
  return true;
}

function purge(ctx, userId, reason) {
  try {
    ctx.db.prepare('DELETE FROM users WHERE id=?').run(userId);
  } catch (e) {
    return console.error(`[auth] 계정 ${userId} 삭제 실패`, e);
  }
  audit(ctx.db, { userId, action: 'auth:account_deleted', detail: { reason } });
  emit(ctx, 'user:deleted', { userId });
}

// ---------- 작업 ----------
// 매시간: 탈퇴 유예 만료 삭제, 정지 해제, 미인증 잠금·삭제, 오래된 임시 기록 정리
export function runHourly(ctx) {
  const { db } = ctx;
  const t = now();
  for (const u of db.prepare("SELECT id, settings FROM users WHERE status='pending_delete' AND delete_requested_at < ?").all(t - ACCOUNT_DELETE_GRACE_DAYS * DAY)) {
    if (!json(u.settings, {}).deleteHold) purge(ctx, u.id, 'withdrawn'); // deleteHold: 법 위반·도난 위험으로 관리자가 삭제를 멈춘 계정
  }
  unsuspend(db, t);
  for (const { user_id } of db.prepare('SELECT DISTINCT user_id FROM auth_activity WHERE seen_at > ?').all(t - SHARING.windowMs)) detectSharing(ctx, user_id);
  db.prepare('DELETE FROM auth_activity WHERE seen_at < ?').run(t - SHARING.windowMs);
  // 미인증 72시간 → 잠금. 잠금 계정의 status_until 은 삭제 예정 시각
  db.prepare("UPDATE users SET status='locked', status_until=? WHERE status='unverified' AND created_at < ?").run(t + LOCKED_DELETE_MS, t - UNVERIFIED_LOCK_MS);
  for (const u of db.prepare("SELECT id FROM users WHERE status='locked' AND status_until IS NOT NULL AND status_until < ?").all(t)) purge(ctx, u.id, 'unverified');
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t - DAY);
  db.prepare('DELETE FROM auth_failures WHERE created_at < ?').run(t - CODE_LOCK); // 가장 긴 창(인증코드 잠금 1시간)
  db.prepare('DELETE FROM auth_qr WHERE expires_at < ?').run(t - DAY);
  db.prepare('DELETE FROM auth_device WHERE expires_at < ?').run(t - DAY);
  db.prepare('DELETE FROM auth_oauth_states WHERE created_at < ?').run(t - OAUTH_STATE_TTL);
}

// 하루 1회(H-03): 무료 12개월 미로그인 → 알림 + 7일 유예 → 삭제. 3년 이상 + 연락처 무효(연락처 없음, 또는 관리자가 무효로 표시한 settings.contactInvalidAt) → 즉시 삭제.
// 프리미엄 기간과 연결 앱(CLI·WebDAV·텔레그램·MCP·확장) 토큰 사용도 활동으로 본다
export function runDormant(ctx) {
  const { db, cfg } = ctx;
  const t = now();
  const inactiveMs = DORMANT.freeInactiveMonths * 30.5 * DAY;
  const candidates = db
    .prepare(
      `SELECT u.*, (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS seen,
         (SELECT max(last_used_at) FROM personal_tokens p WHERE p.user_id = u.id AND p.revoked_at IS NULL) AS used FROM users u
       WHERE u.is_admin = 0 AND u.status != 'pending_delete' AND COALESCE(u.last_login_at, u.created_at) < ?`,
    )
    .all(t - inactiveMs);
  for (const u of candidates) {
    if (isPremium(u, t)) continue;
    const last = Math.max(u.last_login_at || 0, u.created_at, u.premium_until || 0, u.seen || 0, u.used || 0);
    const { dormantNoticeAt: notice, contactInvalidAt } = json(u.settings, {});
    if (t - last >= DORMANT.hardInactiveYears * 365 * DAY && ((!u.email && !u.phone) || contactInvalidAt)) purge(ctx, u.id, 'dormant_no_contact');
    else if (notice) {
      if (last > notice) saveSettings(db, u.id, { dormantNoticeAt: null });
      else if (t - notice >= DORMANT.graceDays * DAY) purge(ctx, u.id, 'dormant');
    } else if (t - last >= inactiveMs) {
      const body = `12개월 넘게 로그인하거나 연결된 앱을 쓴 기록이 없어 ${DORMANT.graceDays}일 뒤 계정과 파일이 삭제될 예정입니다. 계속 쓰시려면 그 전에 한 번 로그인해 주세요.`;
      notify(db, u.id, { kind: 'account', title: '휴면 계정 삭제 예정 안내', body, link: '/login' });
      if (u.email) sendMessage(db, cfg, { channel: 'email', to: u.email, subject: '[미믹] 휴면 계정 삭제 예정 안내', body });
      else if (u.phone) sendMessage(db, cfg, { channel: 'sms', to: u.phone, body: `[미믹] ${body}` });
      saveSettings(db, u.id, { dormantNoticeAt: t });
    }
  }
}

export const jobs = [
  { name: 'auth:hourly', everyMs: 3600_000, run: runHourly },
  { name: 'auth:dormant', everyMs: DAY, run: runDormant },
];

// ---------- 라우트 ----------
export function register(app, ctx) {
  const { db, cfg } = ctx;
  const A = '/api/auth';

  cfgByApp.set(app, cfg);

  // H-04: 웹 세션·연결 앱 토큰으로 들어온 요청의 IP 대역을 기록한다(같은 세션·토큰·대역은 1분에 한 번). 쿠키나 토큰 하나를 여러 곳에서 돌려 써도 잡힌다.
  // 코어 훅이라 코어(/api/me 등)·관리자 API 를 포함한 모든 로그인 요청이 지나간다.
  // 서버 안 중계(텔레그램·MCP)는 loopback 한 대역으로 세어진다. WebDAV 는 자체 인증이라 여기를 지나지 않는다
  const lastWrite = new Map();
  ctx.hooks.activity.push((req) => {
    const key = `${req.sessionId ?? req.tokenId}|${req.ip}`;
    if (now() - (lastWrite.get(key) || 0) < MIN) return;
    if (lastWrite.size > 50_000) lastWrite.clear();
    lastWrite.set(key, now());
    if (recordActivity(ctx, req.user.id, req.ip)) fail(403, 'account_suspended', suspendedMsg(getUser(db, req.user.id).status_until));
  });

  // 이메일
  app.post(`${A}/email/send-code`, (req, res) => {
    const b = req.body || {};
    const purpose = ['signup', 'reset', 'bind', 'change'].includes(b.purpose) ? b.purpose : fail(400, 'invalid_purpose', '알 수 없는 요청입니다');
    if (purpose === 'change') {
      // 이메일을 바꾸기 전에 지금 이메일로 본인 확인
      needSession(req);
      const to = req.user.email || fail(400, 'no_email', '연결된 이메일이 없습니다');
      return res.json(issueCode(db, cfg, req, { target: to, purpose, channel: 'email' }));
    }
    const email = normEmail(b.email);
    const owner = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (purpose === 'signup' && owner) fail(409, 'email_taken', '이미 가입된 이메일입니다. 로그인해 주세요');
    if (purpose === 'signup' && regionBlocked(db, { region: regionOf(req, null, cfg).region }, 'signup')) fail(403, 'region_blocked', REGION_BLOCKED_MSG);
    if (purpose === 'reset' && !owner) fail(404, 'email_not_found', '가입되지 않은 이메일입니다');
    if (purpose === 'bind') {
      needSession(req);
      if (owner) fail(409, 'email_taken', owner.id === req.user.id ? '이미 연결된 이메일입니다' : '다른 계정에서 쓰는 이메일입니다');
    }
    res.json(issueCode(db, cfg, req, { target: email, purpose, channel: 'email' }));
  });

  app.post(`${A}/email/signup`, (req, res) => {
    const b = req.body || {};
    const email = normEmail(b.email);
    const consent = consentOf(b);
    if (!consent.required) fail(400, 'terms_required', TERMS_MSG);
    if (!passwordValid(b.password)) fail(400, 'weak_password', '비밀번호는 문자·숫자·기호를 섞어 6~16자로 정해 주세요');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409, 'email_taken', '이미 가입된 이메일입니다. 로그인해 주세요');
    useCode(db, cfg, req, { target: email, purpose: 'signup', code: b.code });
    const u = createAccount(ctx, req, { email, password: b.password, via: 'email', inviteCode: b.inviteCode, marketing: consent.marketing });
    res.json({ user: login(ctx, req, res, u, 'email'), created: true });
  });

  app.post(`${A}/email/login`, (req, res) => {
    const b = req.body || {};
    res.json({ user: passwordLogin(ctx, req, res, 'email', normEmail(b.email), b.password, 'email') });
  });

  app.post(`${A}/password/reset`, (req, res) => {
    const b = req.body || {};
    const email = normEmail(b.email);
    if (!passwordValid(b.password)) fail(400, 'weak_password', '비밀번호는 문자·숫자·기호를 섞어 6~16자로 정해 주세요');
    const u = db.prepare('SELECT id FROM users WHERE email=?').get(email) || fail(404, 'email_not_found', '가입되지 않은 이메일입니다');
    useCode(db, cfg, req, { target: email, purpose: 'reset', code: b.code });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); // 다른 기기의 로그인도 모두 끊는다
    clearFails(db, `email:${email}`);
    audit(db, { userId: u.id, action: 'auth:password_reset', ip: req.ip });
    res.json({ ok: true });
  });

  // 휴대폰
  app.post(`${A}/phone/send-code`, (req, res) => {
    const b = req.body || {};
    if (b.purpose === 'change') {
      // 번호를 바꾸기 전에 지금 번호로 본인 확인
      needSession(req);
      const to = req.user.phone || fail(400, 'no_phone', '연결된 휴대폰 번호가 없습니다');
      return res.json(issueCode(db, cfg, req, { target: to, purpose: 'change', channel: 'sms' }));
    }
    const phone = normPhone(b.phone);
    const purpose = b.purpose === 'bind' ? 'bind' : 'login';
    const owner = db.prepare('SELECT id FROM users WHERE phone=?').get(phone);
    if (purpose === 'bind') {
      needSession(req);
      if (owner) fail(409, 'phone_taken', owner.id === req.user.id ? '이미 연결된 번호입니다' : '다른 계정에서 쓰는 번호입니다');
    } else if (!owner && ruleFor(db, phone, 'block_signup')) fail(403, 'region_blocked', '이 국가번호로는 새로 가입할 수 없습니다');
    res.json({ ...issueCode(db, cfg, req, { target: phone, purpose, channel: 'sms' }), isNew: purpose === 'login' && !owner });
  });

  app.post(`${A}/phone/verify`, (req, res) => {
    const b = req.body || {};
    const phone = normPhone(b.phone);
    let u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
    const consent = consentOf(b);
    if (!u) {
      if (ruleFor(db, phone, 'block_signup')) fail(403, 'region_blocked', '이 국가번호로는 새로 가입할 수 없습니다');
      if (!consent.required) fail(400, 'terms_required', TERMS_MSG);
    }
    useCode(db, cfg, req, { target: phone, purpose: 'login', code: b.code });
    const created = !u;
    if (!u) u = createAccount(ctx, req, { phone, via: 'phone', inviteCode: b.inviteCode, marketing: consent.marketing });
    res.json({ user: login(ctx, req, res, u, 'phone'), created });
  });

  app.post(`${A}/phone/password-login`, (req, res) => {
    const b = req.body || {};
    res.json({ user: passwordLogin(ctx, req, res, 'phone', normPhone(b.phone), b.password, 'phone_password') });
  });

  // 소셜 로그인
  const provider = (req) => (Object.hasOwn(PROVIDERS, req.params.provider) ? req.params.provider : fail(404, 'unknown_provider', '지원하지 않는 로그인 방식입니다'));
  // state 는 DB 와 시작한 브라우저의 쿠키 양쪽에 있어야 한다. 남이 받은 callback 주소를 열어도 쿠키가 없어 거절된다
  const takeState = (req, res, state, p) => {
    if (typeof state !== 'string' || !state || parseCookies(req.headers.cookie)[OAUTH_COOKIE] !== state) return null;
    res.clearCookie(OAUTH_COOKIE, { path: OAUTH_PATH });
    const row = db.prepare('SELECT * FROM auth_oauth_states WHERE id=? AND provider=?').get(sha256(state), p);
    if (row) db.prepare('DELETE FROM auth_oauth_states WHERE id=?').run(row.id);
    return row && row.created_at > now() - OAUTH_STATE_TTL ? row : null;
  };
  const oauthBack = (st, code) => (st?.user_id ? `/drive/account/social?error=${code}` : `/login?error=${code}`);

  function completeOAuth(req, res, p, prof, st) {
    const ident = db.prepare('SELECT * FROM identities WHERE provider=? AND subject=?').get(p, prof.subject);
    const addIdentity = (userId) => db.prepare('INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?,?,?,?,?)').run(p, prof.subject, userId, prof.email, now());
    if (st.user_id) {
      // 계정 및 보안 화면에서 연결: 연결을 시작한 계정의 웹 세션이 그대로 있어야 한다
      if (req.authKind !== 'session' || req.user?.id !== st.user_id) fail(403, 'oauth_session_mismatch', '연결을 시작한 계정으로 로그인한 상태에서만 연결할 수 있습니다');
      if (ident && ident.user_id !== st.user_id) fail(409, 'identity_in_use', '이미 다른 미믹 계정에 연결된 계정입니다');
      if (!ident) {
        if (db.prepare('SELECT 1 FROM identities WHERE user_id=? AND provider=?').get(st.user_id, p)) fail(409, 'already_linked', '이미 연결된 공급자입니다');
        addIdentity(st.user_id);
        audit(db, { userId: st.user_id, action: 'auth:identity_linked', detail: { provider: p }, ip: req.ip });
      }
      return `/drive/account/social?linked=${p}`;
    }
    // 공급자가 인증했다고 알린 이메일만 계정 이메일로 쓴다(Facebook 은 알 수 없어 identities.email 에만 남긴다).
    // 기존 계정 자동 연결도 그 계정 이메일이 인증된 주소(settings.verifiedEmail)일 때만: 남의 이메일로 먼저 가입해 두고 주인의 로그인을 가로채지 못하게
    const verified = prof.emailVerified && prof.email ? prof.email.toLowerCase() : null;
    let user = ident && getUser(db, ident.user_id);
    const owner = !user && verified ? db.prepare('SELECT * FROM users WHERE email=?').get(verified) : null;
    if (owner && getSettings(owner).verifiedEmail === verified) {
      user = owner;
      addIdentity(user.id);
      audit(db, { userId: user.id, action: 'auth:identity_linked', detail: { provider: p, auto: true }, ip: req.ip });
    }
    if (!user) {
      if (!(st.agree & 1)) fail(400, 'terms_required', TERMS_MSG);
      user = createAccount(ctx, req, { email: owner ? null : verified, name: prof.name, via: p, inviteCode: st.invite_code, marketing: !!(st.agree & 2) });
      addIdentity(user.id);
    }
    login(ctx, req, res, user, p);
    return safeNext(st.next_url);
  }

  app.get(`${A}/oauth/:provider/start`, (req, res) => {
    const p = provider(req);
    const link = req.query.link === '1';
    if (link) needSession(req);
    const configured = !!providerCfg(cfg, p).clientId;
    if (!configured && !cfg.dev) fail(503, 'oauth_not_configured', `${PROVIDERS[p].name} 로그인은 아직 설정되지 않았습니다`);
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    // agree 칸: 1 = 필수 동의 3가지 모두, 2 = 마케팅(선택) 동의
    const q = Object.fromEntries(['agreeAge14', 'agreeTerms', 'agreePrivacy', 'agreeMarketing'].map((k) => [k, req.query[k] === '1']));
    const consent = consentOf(q);
    db.prepare('INSERT INTO auth_oauth_states (id, provider, user_id, invite_code, next_url, agree, nonce, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      sha256(state),
      p,
      link ? req.user.id : null,
      cleanInvite(req.query.invite),
      safeNext(req.query.next),
      (consent.required ? 1 : 0) | (consent.marketing ? 2 : 0),
      nonce,
      now(),
    );
    res.cookie(OAUTH_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: !cfg.dev, maxAge: OAUTH_STATE_TTL, path: OAUTH_PATH });
    res.redirect(configured ? authorizeUrl(cfg, p, state, nonce) : `${A}/oauth/${p}/dev?state=${state}`);
  });

  app.get(`${A}/oauth/:provider/callback`, async (req, res) => {
    const p = provider(req);
    const src = req.query;
    const st = takeState(req, res, src.state, p);
    if (!st) return res.redirect(oauthBack(null, 'oauth_state'));
    if (src.error || !src.code) return res.redirect(oauthBack(st, 'oauth_denied'));
    try {
      const prof = await exchangeCode(cfg, p, String(src.code), { nonce: st.nonce, appleUser: json(src.user, null) });
      res.redirect(completeOAuth(req, res, p, prof, st));
    } catch (e) {
      if (!e.code) console.error(`[auth] ${p} 로그인 실패`, e.message);
      res.redirect(oauthBack(st, e.code || 'oauth_failed'));
    }
  });
  // Apple 은 form_post(다른 사이트에서 보내는 POST)라 Lax 쿠키가 실리지 않는다.
  // 같은 값을 GET 으로 다시 보내면(최상위 이동) state 쿠키·세션 쿠키가 함께 와서 위와 똑같이 확인된다. 이름만 넘기고 이메일은 ID 토큰에서 읽는다
  app.post(`${A}/oauth/:provider/callback`, (req, res) => {
    const p = provider(req);
    const b = req.body || {};
    const name = json(b.user, null)?.name;
    const q = { code: b.code, state: b.state, error: b.error, user: name ? JSON.stringify({ name }) : undefined };
    res.redirect(303, `${A}/oauth/${p}/callback?${new URLSearchParams(Object.entries(q).filter(([, v]) => typeof v === 'string'))}`);
  });

  // 개발용 소셜 로그인(공급자 키가 없을 때만). 실제 공급자 대신 이메일만 입력해 같은 흐름을 끝까지 확인한다
  const devOnly = (p) => {
    if (!cfg.dev || providerCfg(cfg, p).clientId) fail(404, 'not_found', '없는 API 입니다');
  };
  app.get(`${A}/oauth/:provider/dev`, (req, res) => {
    const p = provider(req);
    devOnly(p);
    const state = /^[\w-]{10,64}$/.test(req.query.state || '') ? req.query.state : '';
    const name = PROVIDERS[p].name;
    res.type('html').send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>개발용 ${name} 로그인 · 미믹</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/auth.css"></head>
<body class="auth-dev"><form class="card auth-dev-card" method="post" action="${A}/oauth/${p}/dev">
<span class="badge accent">개발용 화면 · 실제 ${name} 로그인이 아닙니다</span>
<h2>${name} 로그인 흉내 내기</h2>
<p class="muted">${name} 앱 키가 설정되지 않은 개발 서버라서, 이메일만 입력하면 ${name} 계정으로 로그인한 것처럼 처리합니다. 운영 서버에서는 이 화면이 열리지 않습니다.</p>
<input type="hidden" name="state" value="${state}">
<div class="field"><label for="e">${name} 계정 이메일</label><input class="input" id="e" name="email" type="email" required autofocus placeholder="tester@example.com"></div>
<div class="field"><label for="n">이름(선택)</label><input class="input" id="n" name="name" maxlength="30"></div>
<button class="btn primary block">이 계정으로 계속</button>
<p class="small muted"><a href="/login">로그인 화면으로 돌아가기</a></p></form></body></html>`);
  });
  app.post(`${A}/oauth/:provider/dev`, (req, res) => {
    const p = provider(req);
    devOnly(p);
    const st = takeState(req, res, req.body?.state, p);
    if (!st) return res.redirect(oauthBack(null, 'oauth_state'));
    try {
      const email = normEmail(req.body?.email);
      // 실제 공급자와 같게: Facebook 이메일은 인증 여부를 모른다
      const prof = { subject: `dev-${email}`, email, emailVerified: p !== 'facebook', name: String(req.body?.name || '').trim().slice(0, 30) };
      res.redirect(completeOAuth(req, res, p, prof, st));
    } catch (e) {
      res.redirect(oauthBack(st, e.code || 'oauth_failed'));
    }
  });

  // QR 로그인: 웹이 QR 을 띄우고, 로그인된 기기가 승인하면 웹에 세션을 준다
  app.post(`${A}/qr`, async (req, res) => {
    if (!rateLimit(`auth-qr:${req.ip}`, 60, 10 * MIN)) fail(429, 'too_many_requests', '요청이 너무 많습니다');
    const token = crypto.randomBytes(24).toString('base64url');
    const qrId = newId('qr_');
    const expiresAt = now() + QR_TTL;
    db.prepare('INSERT INTO auth_qr (id, token_hash, req_ip, req_ua, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(qrId, sha256(token), req.ip, req.get('user-agent') || null, now(), expiresAt);
    const approveUrl = `${cfg.baseUrl}/approve?qr=${token}`;
    res.json({ qrId, expiresAt, qrDataUrl: await QRCode.toDataURL(approveUrl, { margin: 1, width: 240 }), approveUrl: cfg.dev ? approveUrl : undefined });
  });
  app.get(`${A}/qr/:qrId/status`, (req, res) => {
    const q = db.prepare('SELECT * FROM auth_qr WHERE id=?').get(req.params.qrId);
    if (!q || q.status === 'consumed' || (q.status === 'pending' && q.expires_at < now())) return res.json({ status: 'expired' });
    if (q.status !== 'approved') return res.json({ status: q.status });
    db.prepare("UPDATE auth_qr SET status='consumed' WHERE id=?").run(q.id);
    const u = getUser(db, q.user_id);
    if (!u) return res.json({ status: 'expired' });
    res.json({ status: 'approved', user: login(ctx, req, res, u, 'qr') });
  });
  const qrByToken = (token) => db.prepare('SELECT * FROM auth_qr WHERE token_hash=?').get(sha256(String(token || '')));
  app.get(`${A}/qr/info`, sessionOnly, (req, res) => {
    const q = qrByToken(req.query.token);
    if (!q || q.status !== 'pending' || q.expires_at < now()) fail(410, 'qr_expired', 'QR 코드가 만료되었거나 이미 사용되었습니다');
    res.json({ requestedAt: q.created_at, expiresAt: q.expires_at, ip: q.req_ip, userAgent: q.req_ua });
  });
  app.post(`${A}/qr/approve`, sessionOnly, (req, res) => {
    const q = qrByToken(req.body?.token);
    if (!q || q.status !== 'pending' || q.expires_at < now()) fail(410, 'qr_expired', 'QR 코드가 만료되었거나 이미 사용되었습니다');
    const status = req.body?.approve === true ? 'approved' : 'denied'; // 명시적으로 true 일 때만 승인(실패 시 거절 쪽으로)
    db.prepare('UPDATE auth_qr SET status=?, user_id=?, approver_ip=?, approver_ua=? WHERE id=?').run(status, req.user.id, req.ip, req.get('user-agent') || null, q.id);
    audit(db, { userId: req.user.id, action: `auth:qr_${status}`, detail: { qrId: q.id, requesterIp: q.req_ip }, ip: req.ip });
    res.json({ ok: true, status });
  });

  // CLI·앱 기기 인가(RFC 8628 방식)
  const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
  const normUserCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z]/g, '');
  app.post(`${A}/device/code`, (req, res) => {
    if (!rateLimit(`auth-device:${req.ip}`, 30, 10 * MIN)) fail(429, 'too_many_requests', '요청이 너무 많습니다');
    const b = req.body || {};
    const clientName = String(b.clientName || 'Mimic CLI').trim().slice(0, 60) || 'Mimic CLI';
    const appId = b.appId || 'cli';
    if (!DEVICE_APPS.has(appId)) fail(400, 'invalid_app', '기기 인가로 연결할 수 없는 앱입니다');
    const asked = Array.isArray(b.scopes) ? b.scopes.filter((s) => SCOPES.includes(s)) : [];
    // 'extension' 은 요청한 쪽이 알린 값이라 누구나 댈 수 있는데 쿼터·출석에서 공식 앱으로 대우받는다(F-05).
    // 그래서 확장이 실제로 쓰는 클라우드 다운로드(services)만 준다. 파일 업로드·다운로드 권한이 없으니 연결 앱 상한을 피해 파일을 옮길 수 없다
    const scopes = appId === 'extension' ? ['services'] : asked.length ? [...new Set(asked)] : ['files:write', 'services'];
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const raw = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)]).join('');
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    db.prepare('INSERT INTO auth_device (id, user_code_hash, client_name, app_id, scopes, req_ip, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)').run(
      sha256(deviceCode),
      sha256(raw),
      clientName,
      appId,
      JSON.stringify(scopes),
      req.ip,
      now(),
      now() + DEVICE_TTL,
    );
    res.json({ deviceCode, userCode, verificationUri: `${cfg.baseUrl}/approve?code=${userCode}`, interval: DEVICE_INTERVAL, expiresIn: DEVICE_TTL / 1000 });
  });
  app.post(`${A}/device/token`, (req, res) => {
    const d = db.prepare('SELECT * FROM auth_device WHERE id=?').get(sha256(String(req.body?.deviceCode || '')));
    if (!d || d.status === 'consumed' || d.expires_at < now()) fail(400, 'expired_token', '연결 요청이 만료되었습니다. 다시 시작해 주세요');
    if (d.status === 'denied') fail(400, 'access_denied', '연결이 거절되었습니다');
    if (d.status !== 'approved') fail(400, 'authorization_pending', '브라우저에서 승인을 기다리는 중입니다');
    db.prepare("UPDATE auth_device SET status='consumed' WHERE id=?").run(d.id);
    const scopes = json(d.scopes, []);
    const { id, token } = createToken(db, d.user_id, { name: d.client_name, scopes, appId: d.app_id, days: 365 });
    // G-04·K-05: 다른 키 발급(개인 토큰·MCP·WebDAV)과 같게 이메일(없으면 SMS)과 사이트 알림으로 알린다
    const u = getUser(db, d.user_id);
    const body = `미믹 계정에 새 앱 "${d.client_name}"이(가) 연결되었습니다. 직접 연결한 것이 아니라면 설정 > 액세스 및 통합에서 즉시 폐기하고 비밀번호를 바꿔 주세요.`;
    if (u.email) sendMessage(db, cfg, { channel: 'email', to: u.email, subject: '[미믹] 새 앱이 연결되었습니다', body });
    else if (u.phone) sendMessage(db, cfg, { channel: 'sms', to: u.phone, body: `[미믹] ${body}` });
    notify(db, u.id, { kind: 'token', title: '새 앱이 연결되었습니다', body, link: '/drive/settings/integrations' });
    audit(db, { userId: u.id, action: 'token.create', detail: { id, appId: d.app_id, scopes }, ip: req.ip });
    res.json({ token, tokenId: id, tokenType: 'Bearer', scopes, user: publicUser(u) });
  });
  const deviceByCode = (code) => {
    const d = db.prepare('SELECT * FROM auth_device WHERE user_code_hash=?').get(sha256(normUserCode(code)));
    if (!d || d.status !== 'pending' || d.expires_at < now()) fail(404, 'code_not_found', '코드가 맞지 않거나 만료되었습니다');
    return d;
  };
  app.get(`${A}/device/info`, sessionOnly, (req, res) => {
    const d = deviceByCode(req.query.code);
    res.json({ clientName: d.client_name, appId: d.app_id, scopes: json(d.scopes, []), requestedAt: d.created_at, expiresAt: d.expires_at, ip: d.req_ip });
  });
  app.post(`${A}/device/approve`, sessionOnly, (req, res) => {
    const d = deviceByCode(req.body?.userCode);
    const status = req.body?.approve === true ? 'approved' : 'denied';
    db.prepare('UPDATE auth_device SET status=?, user_id=? WHERE id=?').run(status, req.user.id, d.id);
    audit(db, { userId: req.user.id, action: `auth:device_${status}`, detail: { client: d.client_name }, ip: req.ip });
    res.json({ ok: true, status });
  });

  app.post(`${A}/logout`, (req, res) => {
    const token = readToken(req);
    if (token?.startsWith('ms_')) destroySession(db, token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---------- H-02 계정 및 보안 ----------
  app.get(`${A}/account`, requireUser, (req, res) => {
    const u = req.user;
    res.json({
      user: publicUser(u),
      identities: db.prepare('SELECT provider, email, created_at AS createdAt FROM identities WHERE user_id=? ORDER BY created_at').all(u.id),
      providers: Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, !!providerCfg(cfg, p).clientId || cfg.dev])),
    });
  });

  app.patch(`${A}/account`, sessionOnly, (req, res) => {
    const b = req.body || {};
    const u = req.user;
    if (b.name !== undefined) {
      const name = String(b.name).replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!name || name.length > 30) fail(400, 'invalid_name', '이름은 1~30자로 정해 주세요');
      db.prepare('UPDATE users SET name=? WHERE id=?').run(name, u.id);
    }
    if (b.avatar !== undefined) {
      // 화면이 innerHTML 로 그리므로 base64 문자만 허용한다
      const ok = b.avatar === null || (typeof b.avatar === 'string' && b.avatar.length <= 200 * 1024 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(b.avatar));
      if (!ok) fail(400, 'invalid_avatar', '프로필 사진은 200KB 이하의 PNG·JPG·WEBP·GIF 이미지만 쓸 수 있습니다');
      db.prepare('UPDATE users SET avatar=? WHERE id=?').run(b.avatar, u.id);
    }
    res.json({ user: publicUser(getUser(db, u.id)) });
  });

  app.post(`${A}/account/password`, sessionOnly, (req, res) => {
    const b = req.body || {};
    const u = req.user;
    if (!passwordValid(b.password)) fail(400, 'weak_password', '비밀번호는 문자·숫자·기호를 섞어 6~16자로 정해 주세요');
    if (u.password_hash) {
      const key = `pw:${u.id}`;
      checkFails(db, key);
      if (!verifyPassword(String(b.current ?? ''), u.password_hash)) {
        addFail(db, key);
        fail(400, 'wrong_password', '지금 쓰는 비밀번호가 맞지 않습니다');
      }
      clearFails(db, key);
    }
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND id != ?').run(u.id, req.sessionId); // 이 기기만 남기고 로그아웃
    audit(db, { userId: u.id, action: 'auth:password_changed', ip: req.ip });
    res.json({ ok: true });
  });

  // 연락처 바꾸기: 이미 연결된 연락처가 있으면 그 연락처로 받은 코드(oldCode)도 확인하고, 바뀐 뒤 예전 연락처로 알린다
  app.post(`${A}/account/phone`, sessionOnly, (req, res) => {
    const u = req.user;
    const phone = normPhone(req.body?.phone);
    if (phone === u.phone) fail(409, 'phone_taken', '이미 연결된 번호입니다');
    if (db.prepare('SELECT 1 FROM users WHERE phone=? AND id != ?').get(phone, u.id)) fail(409, 'phone_taken', '다른 계정에서 쓰는 번호입니다');
    if (u.phone) useCode(db, cfg, req, { target: u.phone, purpose: 'change', code: req.body?.oldCode });
    useCode(db, cfg, req, { target: phone, purpose: 'bind', code: req.body?.code });
    // 현지 번호를 연결하면 지역 판정도 보정한다. 미인증 계정은 인증 완료
    db.prepare("UPDATE users SET phone=?, region=?, status=CASE WHEN status='unverified' THEN 'active' ELSE status END WHERE id=?").run(phone, regionOf(req, phone, cfg).region, u.id);
    if (u.phone) sendMessage(db, cfg, { channel: 'sms', to: u.phone, body: '[미믹] 계정에 연결된 휴대폰 번호가 바뀌었습니다. 직접 바꾸지 않았다면 바로 고객지원으로 알려 주세요.' });
    audit(db, { userId: u.id, action: u.phone ? 'auth:phone_changed' : 'auth:phone_bound', ip: req.ip });
    res.json({ user: publicUser(getUser(db, u.id)) });
  });

  app.post(`${A}/account/email`, sessionOnly, (req, res) => {
    const u = req.user;
    const email = normEmail(req.body?.email);
    if (email === u.email) fail(409, 'email_taken', '이미 연결된 이메일입니다');
    if (db.prepare('SELECT 1 FROM users WHERE email=? AND id != ?').get(email, u.id)) fail(409, 'email_taken', '다른 계정에서 쓰는 이메일입니다');
    if (u.email) useCode(db, cfg, req, { target: u.email, purpose: 'change', code: req.body?.oldCode });
    useCode(db, cfg, req, { target: email, purpose: 'bind', code: req.body?.code });
    db.prepare("UPDATE users SET email=?, status=CASE WHEN status='unverified' THEN 'active' ELSE status END WHERE id=?").run(email, u.id);
    saveSettings(db, u.id, { verifiedEmail: email }); // 코드로 확인한 주소 → 소셜 자동 연결 기준
    if (u.email) {
      const body = '미믹 계정에 연결된 이메일 주소가 바뀌어 이 주소로는 더 이상 로그인할 수 없습니다. 직접 바꾸지 않았다면 바로 고객지원으로 알려 주세요.';
      sendMessage(db, cfg, { channel: 'email', to: u.email, subject: '[미믹] 이메일 변경 안내', body });
    }
    audit(db, { userId: u.id, action: u.email ? 'auth:email_changed' : 'auth:email_bound', ip: req.ip });
    res.json({ user: publicUser(getUser(db, u.id)) });
  });

  app.delete(`${A}/account/identities/:provider`, sessionOnly, (req, res) => {
    const u = req.user;
    const p = req.params.provider;
    if (!db.prepare('SELECT 1 FROM identities WHERE user_id=? AND provider=?').get(u.id, p)) fail(404, 'not_linked', '연결되지 않은 계정입니다');
    const others = db.prepare('SELECT count(*) AS n FROM identities WHERE user_id=? AND provider != ?').get(u.id, p).n;
    if (!u.email && !u.phone && !others) fail(400, 'last_login_method', '로그인할 다른 방법(이메일·휴대폰)을 먼저 연결해 주세요');
    db.prepare('DELETE FROM identities WHERE user_id=? AND provider=?').run(u.id, p);
    audit(db, { userId: u.id, action: 'auth:identity_unlinked', detail: { provider: p }, ip: req.ip });
    res.json({ ok: true });
  });

  app.get(`${A}/sessions`, sessionOnly, (req, res) => {
    const items = db
      .prepare('SELECT id, device, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id=? AND expires_at > ? ORDER BY last_seen_at DESC')
      .all(req.user.id, now())
      .map((s) => ({ id: s.id, device: s.device, ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === req.sessionId }));
    res.json({ items });
  });
  app.delete(`${A}/sessions/:id`, sessionOnly, (req, res) => {
    const n = db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(req.params.id, req.user.id).changes;
    if (!n) fail(404, 'not_found', '이미 로그아웃된 기기입니다');
    res.json({ ok: true });
  });

  // 탈퇴: 즉시 오프라인 → 7일 안에 로그인하면 복구 → 이후 작업이 삭제
  app.post(`${A}/account/delete`, sessionOnly, (req, res) => {
    const confirm = String(req.body?.confirm || '').trim();
    if (confirm !== '탈퇴' && confirm !== 'DELETE') fail(400, 'confirm_required', "확인을 위해 '탈퇴'를 입력해 주세요");
    const u = req.user;
    db.prepare("UPDATE users SET status='pending_delete', delete_requested_at=? WHERE id=?").run(now(), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    const body = `계정 삭제 신청이 접수되었습니다. ${ACCOUNT_DELETE_GRACE_DAYS}일 안에 다시 로그인하면 계정이 그대로 돌아오고, 그 뒤에는 모든 파일과 기록이 지워집니다.`;
    if (u.email) sendMessage(db, cfg, { channel: 'email', to: u.email, subject: '[미믹] 계정 삭제 신청 안내', body });
    else if (u.phone) sendMessage(db, cfg, { channel: 'sms', to: u.phone, body: `[미믹] ${body}` });
    audit(db, { userId: u.id, action: 'auth:delete_requested', ip: req.ip });
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true, deleteAt: now() + ACCOUNT_DELETE_GRACE_DAYS * DAY });
  });

  // 관리자: 법 위반·도난 위험이 있는 계정의 탈퇴(삭제) 처리를 멈추거나 다시 진행
  app.post('/api/admin/auth/users/:id/delete-hold', requireAdmin, (req, res) => {
    const u = getUser(db, req.params.id) || fail(404, 'not_found', '없는 사용자입니다');
    if (typeof req.body?.hold !== 'boolean') fail(400, 'invalid_hold', 'hold 는 true 또는 false 여야 합니다');
    const settings = saveSettings(db, u.id, { deleteHold: req.body.hold });
    audit(db, { userId: req.user.id, action: req.body.hold ? 'auth:delete_hold_on' : 'auth:delete_hold_off', detail: { target: u.id, status: u.status }, ip: req.ip });
    res.json({ ok: true, status: u.status, deleteRequestedAt: u.delete_requested_at, deleteHold: settings.deleteHold });
  });
  // 관리자: 연락처 무효 표시(반송·없는 번호 등을 확인했을 때). 3년 이상 미로그인 계정은 휴면 작업이 바로 삭제한다(H-03)
  app.post('/api/admin/auth/users/:id/contact-invalid', requireAdmin, (req, res) => {
    const u = getUser(db, req.params.id) || fail(404, 'not_found', '없는 사용자입니다');
    if (typeof req.body?.invalid !== 'boolean') fail(400, 'invalid_flag', 'invalid 는 true 또는 false 여야 합니다');
    const settings = saveSettings(db, u.id, { contactInvalidAt: req.body.invalid ? now() : null });
    audit(db, { userId: req.user.id, action: req.body.invalid ? 'auth:contact_invalid_on' : 'auth:contact_invalid_off', detail: { target: u.id }, ip: req.ip });
    res.json({ ok: true, contactInvalidAt: settings.contactInvalidAt });
  });

  // ---------- H-05 피드백 ----------
  app.post(`${A}/feedback`, (req, res) => {
    const b = req.body || {};
    if (!rateLimit(`auth-feedback:${req.user?.id || req.ip}`, 10, 60 * MIN)) fail(429, 'too_many_requests', '잠시 뒤에 다시 보내 주세요');
    const category = FEEDBACK_CATEGORIES.includes(b.category) ? b.category : fail(400, 'invalid_category', '분류를 골라 주세요');
    const message = String(b.message || '').trim();
    if (message.length < 5 || message.length > 2000) fail(400, 'invalid_message', '내용은 5~2000자로 적어 주세요');
    const contact = String(b.contact || '').trim().slice(0, 200) || null;
    const id = newId('fb_');
    db.prepare('INSERT INTO auth_feedback (id, user_id, category, message, contact, ip, created_at) VALUES (?,?,?,?,?,?,?)').run(id, req.user?.id || null, category, message, contact, req.ip, now());
    res.json({ ok: true, id });
  });
  app.get('/api/admin/auth/feedback', requireAdmin, (_req, res) => {
    const items = db
      .prepare(
        `SELECT f.id, f.category, f.message, f.contact, f.created_at AS createdAt, f.user_id AS userId, u.email, u.phone, u.name
         FROM auth_feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 200`,
      )
      .all();
    res.json({ items });
  });

  // ---------- K-04 지역 정책 ----------
  app.get('/api/admin/auth/region-rules', requireAdmin, (_req, res) => {
    const items = db.prepare('SELECT country_code AS countryCode, block_signup AS blockSignup, block_download AS blockDownload, note, created_at AS createdAt FROM auth_region_rules ORDER BY country_code').all();
    res.json({ items: items.map((r) => ({ ...r, blockSignup: !!r.blockSignup, blockDownload: !!r.blockDownload })) });
  });
  app.post('/api/admin/auth/region-rules', requireAdmin, (req, res) => {
    const b = req.body || {};
    const code = String(b.countryCode || '').trim();
    if (!DIAL_CODES.has(code)) fail(400, 'invalid_country_code', '실제 국가번호를 +82 처럼 적어 주세요');
    db.prepare(
      `INSERT INTO auth_region_rules (country_code, block_signup, block_download, note, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(country_code) DO UPDATE SET block_signup=excluded.block_signup, block_download=excluded.block_download, note=excluded.note`,
    ).run(code, b.blockSignup === false ? 0 : 1, b.blockDownload ? 1 : 0, String(b.note || '').slice(0, 200) || null, now());
    audit(db, { userId: req.user.id, action: 'auth:region_rule_set', detail: { code, blockSignup: b.blockSignup !== false, blockDownload: !!b.blockDownload }, ip: req.ip });
    res.json({ ok: true });
  });
  app.delete('/api/admin/auth/region-rules/:code', requireAdmin, (req, res) => {
    const n = db.prepare('DELETE FROM auth_region_rules WHERE country_code=?').run(req.params.code).changes;
    if (!n) fail(404, 'not_found', '없는 규칙입니다');
    audit(db, { userId: req.user.id, action: 'auth:region_rule_deleted', detail: { code: req.params.code }, ip: req.ip });
    res.json({ ok: true });
  });
}
