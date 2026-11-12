// 소셜 로그인(Google OIDC · Facebook Graph · Sign in with Apple). 공급자 주소는 cfg.oauth.<공급자> 로 덮어쓸 수 있다(테스트의 모의 공급자용)
import crypto from 'node:crypto';

export const PROVIDERS = {
  google: {
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  },
  facebook: {
    name: 'Facebook',
    authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    profileUrl: 'https://graph.facebook.com/v19.0/me',
    scope: 'email,public_profile',
  },
  apple: {
    name: 'Apple',
    authUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    scope: 'name email',
    issuer: ['https://appleid.apple.com'],
  },
};

export const providerCfg = (cfg, p) => ({ ...PROVIDERS[p], ...cfg.oauth?.[p] });
export const redirectUri = (cfg, p) => `${cfg.baseUrl}/api/auth/oauth/${p}/callback`;

export function authorizeUrl(cfg, p, state, nonce) {
  const c = providerCfg(cfg, p);
  const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: redirectUri(cfg, p), response_type: 'code', scope: c.scope, state });
  if (p !== 'facebook') q.set('nonce', nonce);
  if (p === 'apple') q.set('response_mode', 'form_post'); // 이름·이메일을 받으려면 form_post 가 필요
  return `${c.authUrl}?${q}`;
}

// Apple client_secret: 팀 키(.p8)로 서명한 ES256 JWT
export function appleClientSecret(c, t = Date.now()) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(t / 1000);
  const head = b64({ alg: 'ES256', kid: c.keyId });
  const body = b64({ iss: c.teamId, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: c.clientId });
  const key = String(c.privateKey).replace(/\\n/g, '\n');
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const decodeJwt = (t) => JSON.parse(Buffer.from(String(t || '').split('.')[1] || '', 'base64url').toString() || '{}');

async function getJson(url, init) {
  const r = await fetch(url, { ...init, headers: { accept: 'application/json', ...init?.headers }, signal: AbortSignal.timeout(15_000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error?.message || data.error || `oauth http ${r.status}`);
  return data;
}

// 공급자가 돌려준 code 를 프로필로 바꾼다 → { subject, email, emailVerified, name }
export async function exchangeCode(cfg, p, code, { nonce, appleUser } = {}) {
  const c = providerCfg(cfg, p);
  const redirect_uri = redirectUri(cfg, p);
  if (p === 'facebook') {
    const tok = await getJson(`${c.tokenUrl}?${new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, redirect_uri, code })}`);
    const me = await getJson(`${c.profileUrl}?${new URLSearchParams({ fields: 'id,name,email', access_token: tok.access_token })}`);
    if (!me.id) throw new Error('facebook profile');
    // 페이스북 이메일은 인증 여부를 알 수 없어 계정 이메일·기존 계정 자동 연결에 쓰지 않는다(identities.email 에만 남김)
    return { subject: String(me.id), email: me.email || null, emailVerified: false, name: me.name || '' };
  }
  const client_secret = p === 'apple' ? appleClientSecret(c) : c.clientSecret;
  const tok = await getJson(c.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri, client_id: c.clientId, client_secret }),
  });
  // ID 토큰은 토큰 엔드포인트에서 TLS 로 직접 받았으므로 서명 대신 발급자·대상·만료·nonce 를 확인한다(OIDC Core 3.1.3.7)
  const id = decodeJwt(tok.id_token);
  const aud = Array.isArray(id.aud) ? id.aud : [id.aud];
  if (!c.issuer.includes(id.iss) || !aud.includes(c.clientId) || !(id.exp * 1000 > Date.now()) || id.nonce !== nonce || !id.sub) throw new Error('invalid id_token');
  const appleName = [appleUser?.name?.firstName, appleUser?.name?.lastName].filter(Boolean).join(' ');
  return { subject: String(id.sub), email: id.email || null, emailVerified: id.email_verified === true || id.email_verified === 'true', name: id.name || appleName || '' };
}
