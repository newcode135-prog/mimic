// 연동 모듈(G-01~G-09, K-07): 환경설정, 개인 액세스 토큰, 연결 앱, WebDAV, MCP, 텔레그램, 확장 설치 파일
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { requireUser, requireScope, createToken, saveSettings, getSettings } from '../../core/auth.js';
import { now, fail, json, sha256 } from '../../core/util.js';
import { isPremium } from '../../core/plans.js';
import { sendMessage, notify, audit } from '../../core/notify.js';
import { registerWebdav } from './webdav.js';
import { registerMcp } from './mcp.js';
import { registerTelegram, telegramMigrations } from './telegram.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(here, '..', '..', '..', 'extension');
const cliDir = path.join(here, '..', '..', '..', 'cli');

export const migrations = telegramMigrations;

// ---------- K-07 환경설정 (BUILD_SPEC 2-2 의 키만) ----------
export const SETTING_DEFAULTS = {
  sortScope: 'folder', // drive 가 값이 없을 때 쓰는 기본과 같게
  viewScope: 'folder',
  sortPrefs: {},
  viewPrefs: {},
  shareCodeDisplay: 'direct',
  uploadConcurrency: 3,
  uploadAutoRetry: true,
  appFilesFolder: true,
  torrentAutoDetect: true,
  btSmartFilter: true,
  shareDefaultView: 'grid',
  webdavEnabled: false,
};
const oneOf = (...v) => (x) => v.includes(x);
const bool = (x) => typeof x === 'boolean';
const prefs = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && JSON.stringify(x).length <= 20_000;
const VALID = {
  lang: oneOf('ko', 'en'),
  sortScope: oneOf('folder', 'global'),
  viewScope: oneOf('folder', 'global'),
  sortPrefs: prefs,
  viewPrefs: prefs,
  shareCodeDisplay: oneOf('direct', 'warn'),
  uploadConcurrency: (x) => Number.isInteger(x) && x >= 1 && x <= 3, // B-06 동시 업로드 최대 3개
  uploadAutoRetry: bool,
  appFilesFolder: bool,
  torrentAutoDetect: bool,
  btSmartFilter: bool,
  shareDefaultView: oneOf('grid', 'list'),
  webdavEnabled: bool,
};
const settingsOf = (u) => ({ ...SETTING_DEFAULTS, ...getSettings(u), lang: u.lang });

// ---------- G-05 권한 6단계 ----------
export const SCOPES = ['files:read', 'files:write', 'files:manage', 'files:delete', 'services', 'account'];
// G-04: 개인 액세스 토큰에는 영구삭제·계정(초대) 권한을 줄 수 없다
export const TOKEN_SCOPES = ['files:read', 'files:write', 'files:manage', 'services'];
export function parseScopes(scopes, fallback) {
  if (scopes === undefined && fallback) return fallback;
  if (!Array.isArray(scopes) || !scopes.length) fail(400, 'invalid_scopes', '권한을 하나 이상 골라 주세요');
  const out = [...new Set(scopes)];
  for (const s of out) {
    if (s === 'files:delete' || s === 'account') fail(400, 'scope_not_allowed', '토큰에는 영구삭제·계정(초대) 권한을 줄 수 없습니다');
    if (!TOKEN_SCOPES.includes(s)) fail(400, 'invalid_scopes', `알 수 없는 권한입니다: ${s}`);
  }
  return out;
}

// ---------- G-06 연결 앱 ----------
export const APP_NAMES = { cli: '미믹 CLI', mcp: 'AI 도구 연결(MCP)', webdav: 'WebDAV', telegram: '텔레그램 봇', extension: '브라우저 확장' };

// 토큰·앱을 웹 로그인 세션에서만 만들고 지울 수 있게 한다(토큰으로 토큰을 만들 수 없음)
export function sessionOnly(req, _res, next) {
  if (req.authKind !== 'session') fail(403, 'session_required', '웹에 로그인한 상태에서만 할 수 있습니다');
  next();
}
export const userSession = [requireUser, sessionOnly];

// 새 키가 생기면 이메일(없으면 SMS)과 사이트 알림으로 알린다(G-04, K-05)
export function alertNewKey(ctx, user, label) {
  const body = `미믹 계정에 새 접근 키 "${label}"이(가) 만들어졌습니다. 직접 만든 것이 아니라면 설정 > 액세스 및 통합에서 즉시 폐기하고 비밀번호를 바꿔 주세요.`;
  const titleEn = 'A new access key was created';
  const bodyEn = `A new access key "${label}" was created for your Mimic account. If you didn't create it, revoke it right away in Settings > Access & integrations and change your password.`;
  // K-03: 계정 언어가 영어면 이메일·SMS 도 영어로
  const en = user.lang === 'en';
  if (user.email) sendMessage(ctx.db, ctx.cfg, { channel: 'email', to: user.email, subject: en ? `[Mimic] ${titleEn}` : '[미믹] 새 접근 키가 만들어졌습니다', body: en ? bodyEn : body });
  else if (user.phone) sendMessage(ctx.db, ctx.cfg, { channel: 'sms', to: user.phone, body: en ? bodyEn : body });
  notify(ctx.db, user.id, { kind: 'token', title: '새 접근 키가 만들어졌습니다', body, link: '/drive/settings/integrations', titleEn, bodyEn });
}

// prefix: mp_ 가 아닌 비밀값(예: WebDAV 의 mw_)은 공통 인증이 Bearer 로 받지 않아 그 앱 경로에서만 쓸 수 있다
export function issueKey(ctx, req, { name, scopes, appId, days, prefix }) {
  let { id, token } = createToken(ctx.db, req.user.id, { name, scopes, appId, days });
  if (prefix) {
    token = prefix + crypto.randomBytes(32).toString('base64url');
    ctx.db.prepare('UPDATE personal_tokens SET token_hash=? WHERE id=? AND user_id=?').run(sha256(token), id, req.user.id);
  }
  alertNewKey(ctx, req.user, name);
  audit(ctx.db, { userId: req.user.id, action: 'token.create', detail: { id, appId, scopes }, ip: req.ip });
  return { id, token, name, scopes, appId, expiresAt: now() + days * 864e5 };
}

export function revokeTokens(db, userId, where, ...args) {
  return Number(db.prepare(`UPDATE personal_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND (${where})`).run(now(), userId, ...args).changes);
}

// 같은 서버의 다른 모듈 API 를 HTTP 로 부른다(offline·share). 테스트는 cfg.internalApiBase 로 대역 서버를 지정한다
export async function callApi(ctx, token, method, p, body) {
  const base = ctx.cfg.internalApiBase || `http://127.0.0.1:${ctx.server?.address?.()?.port ?? ctx.cfg.port}`;
  const r = await fetch(base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : { message: await r.text() };
  if (!r.ok) {
    const missing = r.status === 404 && data?.message === '없는 API 입니다';
    fail(missing ? 503 : r.status, missing ? 'module_unavailable' : data?.error || 'upstream_error', missing ? '이 기능을 맡은 서비스가 아직 준비되지 않았습니다' : data?.message || '요청을 처리하지 못했습니다');
  }
  return data;
}

// G-02 npm 패키지 형식(package/…) tar.gz. mimic.js 의 기본 서버 주소를 이 서버로 바꿔 넣는다
const TAR_MTIME = 499162500; // npm pack 과 같은 고정 시각(1985-10-26)
export function cliTarball(baseUrl) {
  const entries = [
    ['package.json', 0o644],
    ['README.md', 0o644],
    ['mimic.js', 0o755],
  ].map(([name, mode]) => {
    let data = fs.readFileSync(path.join(cliDir, name));
    if (name === 'mimic.js') data = Buffer.from(data.toString('utf8').replace(/^const DEFAULT_SERVER = .*$/m, `const DEFAULT_SERVER = ${JSON.stringify(baseUrl)};`));
    return [`package/${name}`, data, mode];
  });
  const parts = [];
  for (const [name, data, mode] of entries) {
    const head = Buffer.alloc(512); // ustar 헤더
    const put = (text, at) => head.write(text, at, 'ascii');
    const oct = (n, width) => n.toString(8).padStart(width, '0') + '\0';
    put(name, 0);
    put(oct(mode, 7), 100);
    put(oct(0, 7), 108);
    put(oct(0, 7), 116);
    put(oct(data.length, 11), 124);
    put(oct(TAR_MTIME, 11), 136);
    put('        ', 148);
    put('0', 156);
    put('ustar\0', 257);
    put('00', 263);
    put(oct(head.reduce((a, b) => a + b, 0), 6) + ' ', 148);
    parts.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

const tokenApi = (r) => ({
  id: r.id,
  name: r.name,
  scopes: json(r.scopes, []),
  appId: r.app_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  expired: !!r.expires_at && r.expires_at <= now(),
});

export function register(app, ctx) {
  const { db } = ctx;

  // K-07 설정
  app.get('/api/integrations/settings', requireScope('account'), (req, res) => {
    res.json({ settings: settingsOf(req.user), premium: isPremium(req.user) });
  });
  app.put('/api/integrations/settings', requireScope('account'), (req, res) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'invalid_settings', '설정 값이 올바르지 않습니다');
    for (const [k, v] of Object.entries(patch)) {
      // Object.hasOwn: constructor·toString·__proto__ 같은 상속 이름으로 검사를 빠져나가지 못하게
      if (!Object.hasOwn(VALID, k)) fail(400, 'unknown_setting', `바꿀 수 없는 설정입니다: ${k}`);
      if (!VALID[k](v)) fail(400, 'invalid_setting', `설정 값이 올바르지 않습니다: ${k}`);
    }
    if (patch.webdavEnabled === true && !isPremium(req.user)) fail(403, 'premium_required', 'WebDAV 는 프리미엄 전용입니다');
    const { lang, ...rest } = patch;
    if (lang) db.prepare('UPDATE users SET lang=? WHERE id=?').run(lang, req.user.id);
    if (Object.keys(rest).length) saveSettings(db, req.user.id, rest);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    res.json({ settings: settingsOf(u) });
  });

  // G-04 개인 액세스 토큰
  app.get('/api/integrations/tokens', userSession, (req, res) => {
    const rows = db.prepare('SELECT * FROM personal_tokens WHERE user_id=? AND app_id IS NULL AND revoked_at IS NULL ORDER BY created_at DESC').all(req.user.id);
    res.json({ items: rows.map(tokenApi), scopes: TOKEN_SCOPES });
  });
  app.post('/api/integrations/tokens', userSession, (req, res) => {
    const { name, scopes, days = 90 } = req.body || {};
    const nm = typeof name === 'string' ? name.trim() : '';
    if (!nm || nm.length > 50) fail(400, 'invalid_name', '토큰 이름을 1~50자로 적어 주세요');
    const d = Number(days);
    if (!Number.isInteger(d) || d < 30 || d > 365) fail(400, 'invalid_days', '만료 기간은 30일에서 365일 사이로 정해 주세요');
    res.status(201).json(issueKey(ctx, req, { name: nm, scopes: parseScopes(scopes), appId: null, days: d }));
  });
  app.delete('/api/integrations/tokens/:id', userSession, (req, res) => {
    if (!revokeTokens(db, req.user.id, 'id=? AND app_id IS NULL', req.params.id)) fail(404, 'not_found', '토큰을 찾을 수 없습니다');
    audit(db, { userId: req.user.id, action: 'token.revoke', detail: { id: req.params.id }, ip: req.ip });
    res.json({ ok: true });
  });

  // G-06 연결 앱: 앱별로 묶은 목록
  app.get('/api/integrations/apps', userSession, (req, res) => {
    const rows = db
      .prepare('SELECT * FROM personal_tokens WHERE user_id=? AND app_id IS NOT NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at')
      .all(req.user.id, now());
    const groups = new Map();
    for (const r of rows) {
      const g = groups.get(r.app_id) || { id: r.app_id, kind: APP_NAMES[r.app_id] ? r.app_id : 'other', name: APP_NAMES[r.app_id] || r.app_id, scopes: [], connections: [], createdAt: r.created_at, lastUsedAt: null };
      for (const s of json(r.scopes, [])) if (!g.scopes.includes(s)) g.scopes.push(s);
      g.connections.push(tokenApi(r));
      g.lastUsedAt = Math.max(g.lastUsedAt || 0, r.last_used_at || 0) || null;
      groups.set(r.app_id, g);
    }
    res.json({ items: [...groups.values()] });
  });
  // :id 는 앱 ID(그 앱의 모든 연결 해제) 또는 연결 하나의 토큰 ID
  app.delete('/api/integrations/apps/:id', userSession, (req, res) => {
    const uid = req.user.id;
    const one = db.prepare('SELECT app_id FROM personal_tokens WHERE id=? AND user_id=? AND app_id IS NOT NULL').get(req.params.id, uid);
    const appId = one ? one.app_id : req.params.id;
    const n = one ? revokeTokens(db, uid, 'id=?', req.params.id) : revokeTokens(db, uid, 'app_id=?', appId);
    if (appId === 'telegram') db.prepare('DELETE FROM integrations_telegram WHERE user_id=?').run(uid);
    if (!n && appId !== 'telegram') fail(404, 'not_found', '연결된 앱을 찾을 수 없습니다');
    audit(db, { userId: uid, action: 'app.revoke', detail: { id: req.params.id, appId }, ip: req.ip });
    res.json({ ok: true, revoked: n });
  });

  // G-08 브라우저 확장 오프라인 설치 파일. 기본 서버 주소와 접근 권한에 이 서버(cfg.baseUrl)를 넣어 준다
  app.get('/api/integrations/extension.zip', (_req, res) => {
    if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) fail(404, 'not_found', '확장 설치 파일이 없습니다');
    const zip = new AdmZip();
    zip.addLocalFolder(extensionDir, 'mimic-extension');
    const base = new URL(ctx.cfg.baseUrl);
    const api = zip.readAsText('mimic-extension/api.js').replace(/^export const DEFAULT_SERVER = .*$/m, `export const DEFAULT_SERVER = ${JSON.stringify(base.origin)};`);
    zip.updateFile('mimic-extension/api.js', Buffer.from(api));
    const manifest = JSON.parse(zip.readAsText('mimic-extension/manifest.json'));
    const host = `${base.protocol}//${base.hostname}/*`; // Chrome 패턴은 포트를 가리지 않는다
    if (!manifest.host_permissions.includes(host)) manifest.host_permissions.push(host);
    zip.updateFile('mimic-extension/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="mimic-extension.zip"' }).send(zip.toBuffer());
  });

  // G-02 CLI 설치 스크립트가 내려받는 파일. 설치 스크립트에는 이 서버 주소를 넣어 준다.
  // 요청의 Host 헤더가 아니라 설정(cfg.baseUrl)을 쓴다: curl | sh 로 바로 실행되므로 캐시 오염·명령 주입을 막는다
  const CLI_FILES = { 'mimic.js': 'text/javascript', 'package.json': 'application/json', 'install.sh': 'text/x-shellscript', 'install.ps1': 'text/plain' };
  // npx <서버>/api/integrations/cli/mimic-cli.tgz 로 바로 실행하는 npm 패키지 tarball
  app.get('/api/integrations/cli/mimic-cli.tgz', (_req, res) => {
    res.type('application/gzip').set('Content-Disposition', 'attachment; filename="mimic-cli.tgz"').send(cliTarball(ctx.cfg.baseUrl));
  });
  // Homebrew 공식: 위 tarball 과 그 sha256 을 담는다(tarball 은 고정 시각으로 만들어 내용이 같으면 해시도 같다)
  app.get('/api/integrations/cli/mimic.rb', (_req, res) => {
    const base = ctx.cfg.baseUrl;
    const { version } = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8'));
    const q = JSON.stringify;
    res.type('text/x-ruby; charset=utf-8').send(`class Mimic < Formula
  desc "Command-line tool for the Mimic cloud drive"
  homepage ${q(base)}
  url ${q(`${base}/api/integrations/cli/mimic-cli.tgz`)}
  version ${q(version)}
  sha256 ${q(sha256(cliTarball(base)))}
  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"mimic").write_env_script Formula["node"].opt_bin/"node", "#{libexec}/mimic.js", {}
  end

  test do
    assert_match "mimic", shell_output("#{bin}/mimic --help")
  end
end
`);
  });
  app.get('/api/integrations/cli/:file', (req, res) => {
    const type = CLI_FILES[req.params.file];
    if (!type) fail(404, 'not_found', '없는 파일입니다');
    const text = fs.readFileSync(path.join(cliDir, req.params.file), 'utf8').replaceAll('__MIMIC_SERVER__', ctx.cfg.baseUrl);
    res.type(`${type}; charset=utf-8`).send(text);
  });

  registerWebdav(app, ctx);
  registerMcp(app, ctx);
  registerTelegram(app, ctx);
}
