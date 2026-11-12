// 공유(D-01~D-05): 공유 링크·만료·비밀번호, 공유 코드, 받는 사람 보기·재생·내 드라이브 저장, 저장한 공유 업데이트.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { now, newId, fail, json, rateLimit, DAY } from '../../core/util.js';
import { requireScope, requireUser, hasScope, hashPassword, verifyPassword, getSettings, parseCookies, quotaSource } from '../../core/auth.js';
import { getNode, requireNode, listChildren, createFolder, createFileNode, checkCapacity, toApi } from '../../core/files.js';
import { sendBlob, blobPath } from '../../core/storage.js';
import { checkTransfer, addUsage } from '../../core/quota.js';
import { SHARE_EXPIRY_DAYS, SLOW_BPS, speedFor, isPremium } from '../../core/plans.js';
import { tx } from '../../core/db.js';

export const migrations = `
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,                   -- 링크 주소 /s/<token>, 추측 불가 24자
  code TEXT UNIQUE COLLATE NOCASE,              -- 공유 코드(D-02). 대소문자 구분 없이 전역 고유
  title TEXT NOT NULL,                          -- 첫 항목 이름(나머지 개수는 화면이 붙인다)
  file_ids TEXT NOT NULL,                       -- JSON 배열: 공유한 파일·폴더 id
  expires_at INTEGER,                           -- NULL = 영구
  password_hash TEXT,
  view_mode TEXT NOT NULL DEFAULT 'grid',       -- grid | list (D-03)
  view_count INTEGER NOT NULL DEFAULT 0,
  save_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_links_user ON share_links(user_id);
-- 받는 사람이 내 드라이브로 저장한 기록(D-04). 저장한 공유 항목 하나당 한 줄
CREATE TABLE IF NOT EXISTS share_saves (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,                      -- 공유 쪽 원본 노드
  saved_root_id TEXT NOT NULL,                  -- 받는 사람 드라이브의 사본
  last_synced_at INTEGER NOT NULL,
  pw_ver TEXT,                                  -- 저장할 때의 비밀번호 기준값(pwVer). 비밀번호가 바뀌면 다시 풀어야 동기화된다
  copied TEXT,                                  -- JSON { 원본 노드 id: 사본 노드 id }: 이미 가져온 항목(D-04)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS share_saves_user ON share_saves(user_id);
`;

const P = '/api/share';
const COOKIE = 'mimic_share';
const CODE_RE = /^[A-Za-z0-9!@#$%^&*_-]{4,16}$/;
const PW_RE = /^[A-Za-z0-9]{4,16}$/;
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // 헷갈리는 글자(i l o 0 1) 제외

const genPassword = () => Array.from({ length: 4 }, () => PW_CHARS[crypto.randomInt(PW_CHARS.length)]).join('');
const statusOf = (s) => (s.revoked_at ? 'revoked' : s.expires_at && s.expires_at <= now() ? 'expired' : 'active');

function expiryOf(days) {
  if (!SHARE_EXPIRY_DAYS.includes(days)) fail(400, 'invalid_expiry', '만료 기간은 영구·7일·14일·30일 중에서 고릅니다');
  return days ? now() + days * DAY : null;
}
// true → 4자리 자동 생성, 문자열 → 직접 입력(영문·숫자 4~16자), null·false·'' → 없음
function passwordOf(v) {
  if (v === true) return genPassword();
  if (v == null || v === false || v === '') return null;
  if (typeof v !== 'string' || !PW_RE.test(v)) fail(400, 'invalid_password', '비밀번호는 영문·숫자 4~16자입니다');
  return v;
}
function viewModeOf(v) {
  if (v !== 'grid' && v !== 'list') fail(400, 'invalid_view', '보기 방식은 grid 또는 list 입니다');
  return v;
}
// 소유자 이름 일부 가림: 홍길동 → 홍*동, alice → a***e
function maskName(s) {
  const c = [...(s || '')];
  if (c.length <= 2) return (c[0] || '') + '*';
  return c[0] + '*'.repeat(c.length - 2) + c.at(-1);
}

// 제목은 첫 공유 항목의 지금 이름. 항목이 지워졌거나 휴지통에 있으면 만들 때 이름
function titleOf(db, s) {
  const n = getNode(db, s.user_id, json(s.file_ids, [])[0]);
  return n && n.space === 'drive' && !n.trashed_at ? n.name : s.title;
}
// 공유 항목 중 아직 남아 있는(휴지통·삭제 아님) 개수. 0 이면 받는 사람에게 보여 줄 것이 없다
const liveCount = (db, s) =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM files WHERE user_id=? AND space='drive' AND trashed_at IS NULL AND id IN (SELECT value FROM json_each(?))").get(s.user_id, s.file_ids).n);
const shareApi = (db, s) => ({
  id: s.id,
  token: s.token,
  url: `/s/${s.token}`,
  code: s.code,
  title: titleOf(db, s),
  fileIds: json(s.file_ids, []),
  liveCount: liveCount(db, s),
  expiresAt: s.expires_at,
  hasPassword: !!s.password_hash,
  viewMode: s.view_mode,
  viewCount: s.view_count,
  saveCount: s.save_count,
  createdAt: s.created_at,
  status: statusOf(s),
});
const pubNode = (n) => ({ id: n.id, kind: n.kind, name: n.name, size: n.size, mime: n.mime, updatedAt: n.updated_at });
const sorted = (rows) => rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));

// 비밀번호를 푼 사람에게 주는 서명 토큰. 비밀번호를 바꾸면 기존 토큰은 무효가 된다
const sign = (cfg, s, exp) => crypto.createHmac('sha256', cfg.secret).update(`${s.id}.${exp}.${s.password_hash}`).digest('base64url');
function unlocked(req, cfg, s) {
  if (!s.password_hash || req.user?.id === s.user_id) return true;
  const [exp, sig = ''] = String(req.get('x-share-access') || parseCookies(req.headers.cookie)[COOKIE] || '').split('.');
  if (!(Number(exp) > now())) return false;
  const want = Buffer.from(sign(cfg, s, exp));
  const got = Buffer.from(sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// 비밀번호 기준값: 비밀번호가 바뀌면 달라진다(없으면 null)
const pwVer = (s) => (s.password_hash ? crypto.createHash('sha256').update(s.password_hash).digest('base64url') : null);
// 저장한 공유를 계속 따라가도 되는지: 비밀번호가 없거나, 소유자거나, 지금 비밀번호로 푼 적이 있을 때
const syncAllowed = (s, r, uid) => !s.password_hash || uid === s.user_id || r.pw_ver === pwVer(s);
// 미리보기(inline)는 영상·음성·이미지만. HTML·SVG 등은 내려받기로만 보내 미믹 출처에서 실행되지 않게 한다
const inlineSafe = (mime) => /^(video|audio|image)\//i.test(mime || '') && !/^image\/svg/i.test(mime);
// 공유한 사람이 탈퇴 신청·탈퇴·잠금·정지(기한 안) 상태면 공유를 열지 않는다(7장 '탈퇴 신청 즉시 오프라인', 신고 처리 정지)
const ownerOff = (u) => !u || ['deleted', 'pending_delete', 'locked'].includes(u.status) || (u.status === 'suspended' && (!u.status_until || u.status_until > now()));
// Range 요청은 요청한 길이만 쿼터 검사(drive 와 같은 기준)
function rangeLength(req, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) return size;
  if (m[1] === '') return Math.min(size, Number(m[2] || 0));
  const end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return Math.max(0, end - Number(m[1]) + 1);
}

// 공유 범위: 공유한 항목이거나 그 하위(휴지통 제외)인지. 맞으면 { node, path }(공유 항목 → node)
function scopeOf(db, s, nodeId) {
  const roots = new Set(json(s.file_ids, []));
  const path = [];
  let cur = getNode(db, s.user_id, nodeId);
  while (cur && cur.space === 'drive' && !cur.trashed_at) {
    path.unshift(cur);
    if (roots.has(cur.id)) return { node: path.at(-1), path };
    cur = cur.parent_id ? getNode(db, s.user_id, cur.parent_id) : null;
  }
  return null;
}
const inScope = (db, s, id) => scopeOf(db, s, String(id)) || fail(404, 'not_found', '공유된 파일을 찾을 수 없습니다');
const rootsOf = (db, s) => json(s.file_ids, []).map((id) => getNode(db, s.user_id, id)).filter((n) => n && n.space === 'drive' && !n.trashed_at);

// 휴지통을 뺀 하위 트리 질의
const TREE = 'WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM files f JOIN t ON f.parent_id = t.id WHERE f.user_id = ? AND f.trashed_at IS NULL)';
const liveSize = (db, uid, id) =>
  Number(db.prepare(`${TREE} SELECT COALESCE(SUM(size),0) AS n FROM files WHERE user_id=? AND kind='file' AND trashed_at IS NULL AND id IN t`).get(id, uid, uid).n);
const blockedIn = (db, uid, id) =>
  !!db.prepare(`${TREE} SELECT 1 FROM files JOIN blocklist b ON b.kind='blob' AND b.value=files.blob_hash WHERE files.user_id=? AND files.id IN t LIMIT 1`).get(id, uid, uid);

// D-04: 저장·동기화 때 가져온 원본 id → 사본 id 를 share_saves.copied 에 남기고, 기록에 없는 원본 항목만 '새 파일'로 본다.
// 받는 사람이 사본을 지우거나 이름을 바꿔도 업데이트가 아니고, 원본 파일의 내용만 바뀐 경우(같은 id)도 새 파일로 치지 않는다.
// ponytail: 기록은 JSON 한 칸이라 폴더 파일 수만큼 커진다. 수만 개짜리 저장이 흔해지면 share_save_items 표로 옮길 것
// copyTree 와 같은 복사(같은 core 함수로 노드를 만든다)에 id 기록만 더했다
function copyMapped(db, srcUid, src, dstUid, dstParentId, map) {
  const opts = { origin: 'share', meta: json(src.meta, {}) };
  const c =
    src.kind === 'folder'
      ? createFolder(db, dstUid, dstParentId, src.name, opts)
      : createFileNode(db, dstUid, dstParentId, { ...opts, name: src.name, size: src.size, mime: src.mime, blobHash: src.blob_hash });
  map[src.id] = c.id;
  if (src.kind === 'folder') for (const ch of listChildren(db, srcUid, src.id)) copyMapped(db, srcUid, ch, dstUid, c.id, map);
  return c;
}
// 원본 폴더에서 아직 가져오지 않은 항목. 받는 사람이 지운 하위 폴더 사본 아래는 따라가지 않는다. max 개를 찾으면 멈춘다
function diff(db, srcUid, srcId, dstUid, dstId, map, plan, max = Infinity) {
  for (const c of listChildren(db, srcUid, srcId)) {
    if (plan.length >= max) return;
    if (!map[c.id]) plan.push({ src: c, dstParentId: dstId });
    else if (c.kind === 'folder') {
      const d = getNode(db, dstUid, map[c.id]);
      if (d?.kind === 'folder' && d.space === 'drive' && !d.trashed_at) diff(db, srcUid, c.id, dstUid, d.id, map, plan, max);
    }
  }
}
// copied 가 없는 예전 저장 기록: 지금 사본과 이름·해시가 같은 항목을 가져온 것으로 보고 한 번 채운다
function matchByName(db, srcUid, srcId, dstUid, dstId, map) {
  const have = listChildren(db, dstUid, dstId);
  for (const c of listChildren(db, srcUid, srcId)) {
    const same = have.find((x) => x.kind === c.kind && x.name === c.name && (c.kind === 'folder' || x.blob_hash === c.blob_hash));
    if (!same) continue;
    map[c.id] = same.id;
    if (c.kind === 'folder') matchByName(db, srcUid, c.id, dstUid, same.id, map);
  }
}

// C-01·8-2: 원본 화질을 볼 수 없는 사람(무료, 지역 프리미엄의 고비트레이트 영상)은 공유 페이지에서도 720p 이하 영상만 바로 재생한다.
// 더 큰 영상은 내 드라이브에 저장하면 미믹 플레이어(media)가 720p 변환본으로 재생한다
const HIGH_BITRATE = 20e6; // media 모듈과 같은 기준
const VIDEO_EXT = /\.(mp4|mkv|avi|mov|webm|m4v|ts|flv|wmv)$/i; // 화면(fileIcon)이 영상으로 여는 확장자
const isVideo = (n) => /^video\//i.test(n.mime || '') || VIDEO_EXT.test(n.name || '');
const execFileP = promisify(execFile);
const probes = new Map(); // blob 해시 → { height, bitRate }. 본문은 해시별로 바뀌지 않으니 그대로 둔다
async function videoInfo(cfg, hash) {
  if (probes.has(hash)) return probes.get(hash);
  try {
    const args = ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=height:stream_disposition=attached_pic:format=bit_rate', '-of', 'json', blobPath(cfg, hash)];
    const p = JSON.parse((await execFileP('ffprobe', args, { timeout: 15_000 })).stdout);
    const v = (p.streams || []).find((x) => !x.disposition?.attached_pic);
    const info = { height: Number(v?.height) || 0, bitRate: Number(p.format?.bit_rate) || 0 };
    if (probes.size >= 1000) probes.delete(probes.keys().next().value);
    probes.set(hash, info);
    return info;
  } catch {
    return null; // 읽을 수 없는 영상: 아래에서 무료는 막고, 지역 프리미엄은 media 처럼 낮은 비트레이트로 본다
  }
}
async function assertQuality(cfg, user, node) {
  const premium = isPremium(user);
  if (premium && user.tier !== 'regional') return;
  const v = await videoInfo(cfg, node.blob_hash);
  if (premium && (v?.bitRate || 0) <= HIGH_BITRATE) return;
  if (v && v.height <= 720) return;
  if (premium) fail(403, 'quality_unavailable', '이 영상은 변환 화질로만 재생할 수 있어요. 내 드라이브에 저장하면 720p로 재생할 수 있어요.');
  fail(403, 'premium_required', '무료 계정은 공유 페이지에서 720p 이하 영상만 바로 재생돼요. 내 드라이브에 저장하면 720p로 볼 수 있고, 원본 화질은 프리미엄에서 볼 수 있어요.');
}

export function register(app, ctx) {
  const { db, cfg } = ctx;
  // 예전 개발 DB 에는 pw_ver·copied 열이 없다
  const cols = db.prepare('PRAGMA table_info(share_saves)').all().map((c) => c.name);
  for (const c of ['pw_ver', 'copied']) if (!cols.includes(c)) db.exec(`ALTER TABLE share_saves ADD COLUMN ${c} TEXT`);
  const api = (s) => shareApi(db, s);
  // 저장 기록의 '이미 가져온 항목'. 예전 기록이면 지금 사본에서 채워 저장해 둔다(src·dst 는 살아 있는 폴더)
  const copiedOf = (s, r, src, dst) => {
    if (r.copied) return json(r.copied, {});
    const map = { [src.id]: dst.id };
    matchByName(db, s.user_id, src.id, r.user_id, dst.id, map);
    db.prepare('UPDATE share_saves SET copied=? WHERE id=?').run(JSON.stringify(map), r.id);
    return map;
  };
  // 로그인한 받는 사람이 지금 비밀번호로 공유를 열면 저장 기록의 기준값도 새로 맞춘다
  const refreshSaves = (req, s) => {
    if (req.user && s.password_hash) db.prepare('UPDATE share_saves SET pw_ver=? WHERE share_id=? AND user_id=?').run(pwVer(s), s.id, req.user.id);
  };
  const mine = (req) =>
    db.prepare('SELECT * FROM share_links WHERE id=? AND user_id=? AND revoked_at IS NULL').get(String(req.params.id), req.user.id) ||
    fail(404, 'share_not_found', '공유를 찾을 수 없습니다');
  const ownerOffOf = (s) => ownerOff(db.prepare('SELECT status, status_until FROM users WHERE id=?').get(s.user_id));
  const unavailable = () => fail(410, 'share_unavailable', '공유한 사람의 계정을 지금 쓸 수 없어 공유가 멈췄습니다');
  // 공개 API 공통: 없음·취소·만료·소유자 계정 상태·비밀번호를 모두 여기서 막는다
  function openShare(req, { unlock = true } = {}) {
    const s = db.prepare('SELECT * FROM share_links WHERE token=?').get(String(req.params.token));
    if (!s) fail(404, 'share_not_found', '공유를 찾을 수 없습니다');
    const st = statusOf(s);
    if (st === 'revoked') fail(410, 'share_revoked', '공유한 사람이 공유를 취소했습니다');
    if (st === 'expired') fail(410, 'share_expired', '공유 기간이 끝났습니다');
    if (ownerOffOf(s)) unavailable();
    if (unlock && !unlocked(req, cfg, s)) fail(403, 'password_required', '비밀번호를 입력해 주세요');
    return s;
  }
  const busy = () => fail(429, 'too_many_requests', '잠시 후 다시 시도해 주세요');

  // ---------- 공유한 사람 ----------
  app.post(P, requireScope('services'), (req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.fileIds) ? [...new Set(b.fileIds.map(String))] : [];
    if (!ids.length || ids.length > 500) fail(400, 'invalid_files', '공유할 파일을 1~500개 고릅니다');
    const nodes = ids.map((id) => requireNode(db, req.user.id, id, { space: 'drive' }));
    const expiresAt = expiryOf(b.expiryDays ?? 0);
    const password = passwordOf(b.password);
    const viewMode = b.viewMode == null ? (getSettings(req.user).shareDefaultView === 'list' ? 'list' : 'grid') : viewModeOf(b.viewMode);
    const id = newId('sh_');
    db.prepare(
      'INSERT INTO share_links (id, user_id, token, title, file_ids, expires_at, password_hash, view_mode, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(id, req.user.id, crypto.randomBytes(18).toString('base64url'), nodes[0].name, JSON.stringify(ids), expiresAt, password && hashPassword(password), viewMode, now());
    const s = db.prepare('SELECT * FROM share_links WHERE id=?').get(id);
    res.json({ share: api(s), url: `/s/${s.token}`, password });
  });

  // 공유를 만드는 'services' 토큰도 자기 공유를 찾아 관리할 수 있게 둘 중 하나면 통과
  const canList = (req, res, next) =>
    requireUser(req, res, () => (hasScope(req, 'services') || hasScope(req, 'files:read') ? next() : fail(403, 'insufficient_scope', '이 토큰에는 services 또는 files:read 권한이 없습니다')));
  app.get(`${P}/mine`, canList, (req, res) => {
    res.json({ items: db.prepare('SELECT * FROM share_links WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC').all(req.user.id).map(api) });
  });

  // 수정: expiryDays 는 지금부터 다시 계산, password 는 true(새로 생성)·문자열(직접)·null(해제)·생략(유지)
  app.patch(`${P}/:id`, requireScope('services'), (req, res) => {
    const s = mine(req);
    const b = req.body || {};
    let password;
    if (b.expiryDays !== undefined) s.expires_at = expiryOf(b.expiryDays);
    if (b.viewMode !== undefined) s.view_mode = viewModeOf(b.viewMode);
    if (b.password !== undefined) {
      password = passwordOf(b.password);
      s.password_hash = password && hashPassword(password);
    }
    db.prepare('UPDATE share_links SET expires_at=?, view_mode=?, password_hash=? WHERE id=? AND user_id=?').run(s.expires_at, s.view_mode, s.password_hash, s.id, req.user.id);
    res.json({ share: api(s), password });
  });

  app.delete(`${P}/:id`, requireScope('services'), (req, res) => {
    const s = mine(req);
    db.prepare('UPDATE share_links SET revoked_at=?, code=NULL WHERE id=? AND user_id=?').run(now(), s.id, req.user.id);
    res.json({ ok: true });
  });

  // D-02 공유 코드: 빈 값이면 해제
  app.post(`${P}/:id/code`, requireScope('services'), (req, res) => {
    const s = mine(req);
    const raw = req.body?.code;
    const code = raw == null || raw === '' ? null : String(raw);
    if (code && !CODE_RE.test(code)) fail(400, 'invalid_code', '공유 코드는 영문·숫자·기호(!@#$%^&*_-) 4~16자입니다');
    if (code && statusOf(s) !== 'active') fail(410, 'share_expired', '기간이 끝난 공유에는 코드를 걸 수 없습니다');
    // 기간이 끝난 공유가 쥐고 있던 코드는 풀어 준다
    if (code) db.prepare('UPDATE share_links SET code=NULL WHERE code=? AND expires_at IS NOT NULL AND expires_at<=?').run(code, now());
    if (code && db.prepare('SELECT 1 FROM share_links WHERE code=? AND id<>?').get(code, s.id)) fail(409, 'code_taken', '이미 쓰이는 공유 코드입니다');
    db.prepare('UPDATE share_links SET code=? WHERE id=? AND user_id=?').run(code, s.id, req.user.id);
    res.json({ share: api({ ...s, code }) });
  });

  // /mine 과 같은 기준: services 토큰도 코드로 공유를 찾는다
  app.get(`${P}/lookup`, canList, (req, res) => {
    if (!rateLimit(`share-lookup:${req.user.id}`, 30, 60_000)) busy();
    const code = String(req.query.code || '').trim();
    const s = CODE_RE.test(code) && db.prepare('SELECT * FROM share_links WHERE code=?').get(code);
    if (!s || statusOf(s) !== 'active') fail(404, 'share_not_found', '이 코드로 찾은 공유가 없습니다');
    if (ownerOffOf(s)) unavailable(); // 공유 페이지(openShare)와 같은 기준
    res.json({ token: s.token, url: `/s/${s.token}`, warn: getSettings(req.user).shareCodeDisplay === 'warn' });
  });

  // ---------- 받는 사람(공개) ----------
  app.get(`${P}/public/:token`, (req, res) => {
    const s = openShare(req, { unlock: false });
    const open = unlocked(req, cfg, s);
    if (open) refreshSaves(req, s);
    const owner = db.prepare('SELECT name, email, invite_code FROM users WHERE id=?').get(s.user_id);
    res.json({
      share: {
        title: open ? titleOf(db, s) : null,
        fileCount: json(s.file_ids, []).length,
        owner: maskName(owner?.name || owner?.email?.split('@')[0]),
        expiresAt: s.expires_at,
        viewMode: s.view_mode,
        needsPassword: !!s.password_hash,
        unlocked: open,
        isOwner: req.user?.id === s.user_id,
        inviteCode: owner?.invite_code || null,
        createdAt: s.created_at,
      },
    });
  });

  app.post(`${P}/public/:token/unlock`, (req, res) => {
    const s = openShare(req, { unlock: false });
    if (!s.password_hash) return res.json({ ok: true, accessToken: null });
    if (!rateLimit(`share-unlock:${req.ip}:${s.id}`, 10, 10 * 60_000)) busy();
    if (!verifyPassword(String(req.body?.password ?? ''), s.password_hash)) fail(403, 'wrong_password', '비밀번호가 맞지 않습니다');
    const exp = now() + DAY;
    const accessToken = `${exp}.${sign(cfg, s, exp)}`;
    refreshSaves(req, s);
    res.cookie(COOKIE, accessToken, { httpOnly: true, sameSite: 'lax', secure: !cfg.dev, maxAge: DAY, path: `${P}/public/${s.token}` });
    res.json({ ok: true, accessToken });
  });

  // 공유 폴더는 지금 내용을 그대로 보여 준다(D-04)
  app.get(`${P}/public/:token/list`, (req, res) => {
    const s = openShare(req);
    if (!req.query.folderId) return res.json({ items: sorted(rootsOf(db, s)).map(pubNode), path: [] });
    const { node, path } = inScope(db, s, req.query.folderId);
    if (node.kind !== 'folder') fail(400, 'not_folder', '폴더가 아닙니다');
    res.json({ items: sorted(listChildren(db, s.user_id, node.id)).map(pubNode), path: path.map((n) => ({ id: n.id, name: n.name })) });
  });

  // 재생·다운로드: 로그인 필요, 받는 사람의 다운스트림 쿼터에서 차감
  app.get(`${P}/public/:token/files/:fileId/download`, requireScope('files:read'), async (req, res) => {
    const s = openShare(req);
    const { node } = inScope(db, s, req.params.fileId);
    if (node.kind !== 'file' || !node.blob_hash) fail(400, 'not_file', '파일만 받을 수 있습니다');
    if (blockedIn(db, s.user_id, node.id)) fail(451, 'blocked', '차단된 파일입니다');
    // 8-6: 프리미엄 만료 7일이 지나도록 용량 초과(expiryStage>=3)면 온라인 재생을 막고 다운로드는 감속
    const stage3 = Number(getSettings(req.user).expiryStage) >= 3;
    const inline = req.query.inline === '1' && inlineSafe(node.mime);
    if (stage3 && inline && /^(video|audio)\//i.test(node.mime))
      fail(403, 'playback_blocked', '프리미엄이 끝나고 7일이 지나도록 용량이 초과된 상태라 온라인 재생이 멈췄습니다. 파일을 정리하거나 프리미엄을 다시 시작하면 바로 재생할 수 있어요.');
    // 화질 제한(C-01·8-2). 첨부 다운로드(inline 아님)는 drive 다운로드처럼 원본 그대로
    if (req.query.inline === '1' && isVideo(node)) await assertQuality(cfg, req.user, node);
    const source = quotaSource(req);
    const q = checkTransfer(db, req.user, 'down', rangeLength(req, node.size), source);
    if (!q.ok && !q.slow) fail(403, q.reason, '전송 쿼터를 모두 사용했습니다');
    // 조회 수: HEAD·이어받기는 빼고, 같은 사람이 같은 파일을 10분 안에 다시 열면 한 번으로 센다
    if (req.method !== 'HEAD' && !/bytes=[1-9]/.test(req.headers.range || '') && rateLimit(`share-view:${s.id}:${req.user.id}:${node.id}`, 1, 10 * 60_000))
      db.prepare('UPDATE share_links SET view_count=view_count+1 WHERE id=?').run(s.id);
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; media-src 'self'; img-src 'self'" });
    sendBlob(req, res, cfg, node.blob_hash, {
      name: node.name,
      mime: node.mime,
      inline,
      throttleBps: q.ok && !stage3 ? speedFor(req.user) : SLOW_BPS,
      onBytes: (n) => addUsage(db, req.user.id, 'down', n, source),
    });
  });

  // D-05 내 드라이브로 저장: fileIds 가 없으면 공유 전체
  app.post(`${P}/public/:token/save`, requireScope('files:write'), (req, res) => {
    const s = openShare(req);
    const b = req.body || {};
    const parentId = b.parentId ? String(b.parentId) : null;
    if (parentId) requireNode(db, req.user.id, parentId, { kind: 'folder', space: 'drive' });
    const ids = Array.isArray(b.fileIds) ? [...new Set(b.fileIds.map(String))].slice(0, 500) : [];
    const srcs = ids.length ? ids.map((id) => inScope(db, s, id).node) : rootsOf(db, s);
    if (!srcs.length) fail(404, 'not_found', '저장할 파일이 없습니다');
    if (srcs.some((n) => blockedIn(db, s.user_id, n.id))) fail(451, 'blocked', '차단된 파일이 있어 저장할 수 없습니다');
    checkCapacity(db, req.user, srcs.reduce((sum, n) => sum + liveSize(db, s.user_id, n.id), 0));
    const t = now();
    const items = tx(db, () => {
      const ins = db.prepare('INSERT INTO share_saves (id, share_id, user_id, source_id, saved_root_id, last_synced_at, pw_ver, copied, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
      const out = srcs.map((n) => {
        const map = {};
        const c = copyMapped(db, s.user_id, n, req.user.id, parentId, map);
        ins.run(newId('ss_'), s.id, req.user.id, n.id, c.id, t, pwVer(s), JSON.stringify(map), t);
        return c;
      });
      db.prepare('UPDATE share_links SET save_count=save_count+1 WHERE id=?').run(s.id);
      return out;
    });
    res.json({ items: items.map(toApi), parentId });
  });

  // ---------- 저장한 공유(D-04) ----------
  app.get(`${P}/saved`, requireScope('files:read'), (req, res) => {
    const rows = db.prepare('SELECT * FROM share_saves WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
    const items = rows.map((r) => {
      const s = db.prepare('SELECT * FROM share_links WHERE id=?').get(r.share_id);
      const st = statusOf(s);
      const status = st === 'active' && ownerOffOf(s) ? 'unavailable' : st;
      const locked = status === 'active' && !syncAllowed(s, r, req.user.id);
      // 닫힌 공유·잠긴 공유는 원본의 지금 이름을 보여 주지 않는다(만들 때 이름만)
      const hidden = locked || status !== 'active';
      const src = hidden ? null : scopeOf(db, s, r.source_id)?.node;
      const dst = getNode(db, req.user.id, r.saved_root_id);
      const live = dst && !dst.trashed_at ? dst : null;
      // 동기화와 같은 비교라 이동·복원으로 들어온 파일도 잡는다(첫 차이에서 멈춤)
      const plan = [];
      if (src?.kind === 'folder' && live?.kind === 'folder') diff(db, s.user_id, src.id, req.user.id, live.id, copiedOf(s, r, src, live), plan, 1);
      return {
        id: r.id,
        title: hidden ? s.title : titleOf(db, s),
        url: `/s/${s.token}`,
        status,
        locked, // 공유 비밀번호가 바뀌어 공유 페이지에서 다시 풀어야 함
        kind: (src || dst)?.kind || 'file',
        sourceName: src?.name || null,
        savedRootId: r.saved_root_id,
        savedName: live ? live.name : null,
        lastSyncedAt: r.last_synced_at,
        createdAt: r.created_at,
        hasUpdates: plan.length > 0,
      };
    });
    res.json({ items });
  });

  // 공유 원본에 새로 생긴 파일만 저장한 폴더로 복사
  app.post(`${P}/saved/:id/sync`, requireScope('files:write'), (req, res) => {
    const r = db.prepare('SELECT * FROM share_saves WHERE id=? AND user_id=?').get(String(req.params.id), req.user.id) || fail(404, 'not_found', '저장 기록이 없습니다');
    const s = db.prepare('SELECT * FROM share_links WHERE id=?').get(r.share_id);
    if (statusOf(s) !== 'active') fail(410, 'share_closed', '취소되었거나 기간이 끝난 공유입니다');
    if (ownerOffOf(s)) unavailable();
    if (!syncAllowed(s, r, req.user.id)) fail(403, 'password_required', '공유 비밀번호가 바뀌었습니다. 공유 페이지에서 새 비밀번호를 입력해 주세요');
    const { node: src } = inScope(db, s, r.source_id);
    const dst = getNode(db, req.user.id, r.saved_root_id);
    if (!dst || dst.trashed_at) fail(404, 'saved_missing', '저장한 폴더를 찾을 수 없습니다');
    const plan = [];
    const map = src.kind === 'folder' && dst.kind === 'folder' ? copiedOf(s, r, src, dst) : null;
    if (map) diff(db, s.user_id, src.id, req.user.id, dst.id, map, plan);
    if (plan.some((p) => blockedIn(db, s.user_id, p.src.id))) fail(451, 'blocked', '차단된 파일이 있어 가져올 수 없습니다');
    checkCapacity(db, req.user, plan.reduce((n, p) => n + liveSize(db, s.user_id, p.src.id), 0));
    tx(db, () => {
      for (const p of plan) copyMapped(db, s.user_id, p.src, req.user.id, p.dstParentId, map);
      db.prepare('UPDATE share_saves SET last_synced_at=?, copied=COALESCE(?, copied) WHERE id=?').run(now(), map && JSON.stringify(map), r.id);
    });
    res.json({ added: plan.length });
  });

  app.delete(`${P}/saved/:id`, requireScope('files:write'), (req, res) => {
    db.prepare('DELETE FROM share_saves WHERE id=? AND user_id=?').run(String(req.params.id), req.user.id);
    res.json({ ok: true });
  });
}
