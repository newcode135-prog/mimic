// 세션·토큰·권한 미들웨어와 비밀번호 해시. 로그인 화면·가입 흐름은 auth 모듈이 담당한다.
import crypto from 'node:crypto';
import { now, newId, sha256, fail, json, DAY } from './util.js';
import { isPremium } from './plans.js';

const SESSION_DAYS = 30;
export const COOKIE = 'mimic_sid';

// 비밀번호 규칙(H-01): 문자·숫자·기호를 섞은 6~16자
export const passwordValid = (pw) => typeof pw === 'string' && /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{6,16}$/.test(pw);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== 'string') return false;
  const [, s, h] = stored.split('$');
  const hash = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(h, 'base64'));
}

export function createSession(db, userId, req = null, device = 'web') {
  const token = 'ms_' + crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.prepare('INSERT INTO sessions (id, user_id, device, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?)').run(
    sha256(token),
    userId,
    device,
    req?.ip ?? null,
    req?.get?.('user-agent') ?? null,
    t,
    t,
    t + SESSION_DAYS * DAY,
  );
  db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(t, userId);
  return token;
}
export function setSessionCookie(res, token, cfg) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: !cfg.dev, maxAge: SESSION_DAYS * DAY, path: '/' });
}
export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id=?').run(sha256(token));
}

// 개인 액세스 토큰·연결 앱 토큰(G-04, G-05). 원문은 생성 시 한 번만 돌려준다
export function createToken(db, userId, { name, scopes = ['files:read'], appId = null, days = 90 }) {
  const token = 'mp_' + crypto.randomBytes(32).toString('base64url');
  const id = newId('t_');
  db.prepare('INSERT INTO personal_tokens (id, user_id, name, token_hash, scopes, app_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)').run(
    id,
    userId,
    name,
    sha256(token),
    JSON.stringify(scopes),
    appId,
    now(),
    days ? now() + days * DAY : null,
  );
  return { id, token };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function readToken(req) {
  const h = req.get('authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

const BLOCKED = new Set(['deleted', 'pending_delete']);

// 모든 요청에 붙는다: req.user, req.scopes, req.authKind('session'|'token'), req.appId
export function loadUser(db) {
  const userById = db.prepare('SELECT * FROM users WHERE id=?');
  return (req, _res, next) => {
    req.user = null;
    req.scopes = [];
    req.authKind = null;
    req.appId = null;
    const token = readToken(req);
    if (token?.startsWith('ms_')) {
      const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sha256(token));
      if (s && s.expires_at > now()) {
        const u = userById.get(s.user_id);
        if (u && !BLOCKED.has(u.status)) {
          req.user = u;
          req.scopes = ['*'];
          req.authKind = 'session';
          req.sessionId = s.id;
          if (now() - s.last_seen_at > 60_000) db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now(), s.id);
        }
      }
    } else if (token?.startsWith('mp_')) {
      const p = db.prepare('SELECT * FROM personal_tokens WHERE token_hash=? AND revoked_at IS NULL').get(sha256(token));
      // WebDAV 전용 비밀번호는 /webdav 에서만 쓴다(일반 API 토큰으로 인정하지 않음)
      if (p && p.app_id !== 'webdav' && (!p.expires_at || p.expires_at > now())) {
        const u = userById.get(p.user_id);
        if (u && !BLOCKED.has(u.status)) {
          req.user = u;
          req.scopes = json(p.scopes, []);
          req.authKind = 'token';
          req.appId = p.app_id || 'pat';
          req.tokenId = p.id;
          db.prepare('UPDATE personal_tokens SET last_used_at=? WHERE id=?').run(now(), p.id);
        }
      }
    }
    next();
  };
}

export function requireUser(req, _res, next) {
  const u = req.user;
  if (!u) fail(401, 'login_required', '로그인이 필요합니다');
  if (u.status === 'suspended' && (!u.status_until || u.status_until > now())) fail(403, 'account_suspended', '계정이 일시 정지되었습니다');
  if (u.status === 'locked') fail(403, 'account_locked', '계정이 잠겼습니다');
  next();
}
// 관리자 API 는 웹 세션으로만 쓸 수 있다(관리자 소유의 개인·연결 앱 토큰으로는 불가)
export function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (!req.user.is_admin) fail(403, 'admin_only', '관리자만 접근할 수 있습니다');
    if (req.authKind !== 'session') fail(403, 'session_required', '관리자 기능은 웹에서 로그인해 사용하세요');
    next();
  });
}
export function requirePremium(req, res, next) {
  requireUser(req, res, () => {
    if (!isPremium(req.user)) fail(403, 'premium_required', '프리미엄 전용 기능입니다');
    next();
  });
}

// 연결 앱 권한(G-05). 상위 권한이 하위 권한을 포함한다
const IMPLIED_BY = { 'files:read': ['files:write', 'files:manage'], 'files:write': ['files:manage'] };
export function hasScope(req, scope) {
  if (req.scopes.includes('*') || req.scopes.includes(scope)) return true;
  return (IMPLIED_BY[scope] || []).some((s) => req.scopes.includes(s));
}
export const requireScope = (scope) => (req, res, next) =>
  requireUser(req, res, () => {
    if (!hasScope(req, scope)) fail(403, 'insufficient_scope', `이 토큰에는 ${scope} 권한이 없습니다`);
    next();
  });

// 쿼터 출처: 토큰으로 들어온 요청은 모두 연결 앱(F-05). appId 'extension' 은 기기 인가에서 누구나 댈 수 있어 공식으로 세지 않는다
// (확장의 공식 대우는 출석 체크(I-06)에만 남는다, billing 모듈)
export const quotaSource = (req) => (req.authKind === 'token' ? 'app' : 'official');

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    name: u.name,
    avatar: u.avatar,
    lang: u.lang,
    region: u.region,
    tier: u.tier,
    premium: isPremium(u),
    premiumUntil: u.premium_until,
    extraStorage: u.extra_storage_bytes,
    isAdmin: !!u.is_admin,
    status: u.status,
    inviteCode: u.invite_code,
    hasPassword: !!u.password_hash,
    settings: json(u.settings, {}),
    createdAt: u.created_at,
  };
}

export function getSettings(user) {
  return json(user.settings, {});
}
export function saveSettings(db, userId, patch) {
  const cur = json(db.prepare('SELECT settings FROM users WHERE id=?').get(userId)?.settings, {});
  const next = { ...cur, ...patch };
  db.prepare('UPDATE users SET settings=? WHERE id=?').run(JSON.stringify(next), userId);
  return next;
}
