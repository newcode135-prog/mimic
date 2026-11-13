// offline 모듈: 클라우드 다운로드(A-01~A-09). 외부 링크를 서버가 받아 요청한 사용자의 미믹 클라우드에만 저장한다.
import busboy from 'busboy';
import parseTorrent from 'parse-torrent'; // webtorrent 의 의존성으로 함께 설치되어 있다
import { now, newId, sha256, fail, json, rateLimit } from '../../core/util.js';
import { tx } from '../../core/db.js';
import { requireUser, requireScope, requireAdmin, hasScope, quotaSource } from '../../core/auth.js';
import { requireNode, usage } from '../../core/files.js';
import { capacityOf, isPremium, BT_MAX_FILES } from '../../core/plans.js';
import { checkTransfer, cloudTaskAllowance, consumeCloudTask } from '../../core/quota.js';
import { notify, audit } from '../../core/notify.js';
import { kick, tick, cancel, closeEngine, requeueStale, safeName, safeFetch, readLimited, findBlock, urlKey, tooManyFiles, ytDlpPath, syncSeeds, seedingStats, MAX_TORRENT_BYTES } from './engine.js';

export { isLikelyAd, pickFiles, findYtDlp, isPrivateIp, assertPublicUrl, stripPrivate, parseYtDlpProgress, seedingStats } from './engine.js';

export const migrations = `
CREATE TABLE IF NOT EXISTS offline_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                         -- magnet | torrent | url | social
  source TEXT NOT NULL,                       -- 링크 원문(.torrent 주소도 원래 주소, 올린 토렌트 파일이면 파일 이름)
  name TEXT NOT NULL,
  parent_id TEXT,                             -- 저장 폴더(NULL = 내 드라이브)
  status TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | error | blocked | canceled
  progress REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  downloaded INTEGER NOT NULL DEFAULT 0,
  speed INTEGER NOT NULL DEFAULT 0,
  error TEXT,                                 -- 실패·차단 사유 코드
  result_root_id TEXT,
  file_ids TEXT NOT NULL DEFAULT '[]',
  cache_key TEXT NOT NULL,                    -- 'bt:<infohash>' | 'url:<sha256(url)>' (A-06 즉시 완료 키)
  torrent BLOB,                               -- .torrent 원본
  quota_source TEXT NOT NULL DEFAULT 'official',
  block_id TEXT,                              -- 막은 blocklist 항목(done 이면 일부 파일만 차단됨)
  skipped_ads INTEGER NOT NULL DEFAULT 0,     -- 스마트 필터로 뺀 파일 수(A-09)
  skipped_blocked INTEGER NOT NULL DEFAULT 0, -- 차단된 파일 해시라 뺀 파일 수(A-08)
  charged INTEGER NOT NULL DEFAULT 1,         -- 무료 횟수를 썼는지(만들 때 차단된 작업은 0, 차단이 풀려 시작할 때 쓴다)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS offline_tasks_user ON offline_tasks(user_id, created_at);
CREATE INDEX IF NOT EXISTS offline_tasks_status ON offline_tasks(status);
CREATE TABLE IF NOT EXISTS offline_cache (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  files TEXT NOT NULL,                        -- [{ path, hash, size, mime }] (스마트 필터로 뺀 파일은 hash NULL)
  etag TEXT,                                  -- url: 키의 원본 검증값(A-06 즉시 완료 전에 바뀌었는지 확인)
  last_modified TEXT,
  length INTEGER,
  created_at INTEGER NOT NULL                 -- 받은 시각(검증값이 없으면 하루 동안만 즉시 완료)
);
CREATE TABLE IF NOT EXISTS offline_appeals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,                      -- 작업을 지워도 기록은 남긴다
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  block_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',        -- open | accepted | rejected
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS offline_appeals_status ON offline_appeals(status, created_at);
CREATE TABLE IF NOT EXISTS offline_seeds (     -- Q-6: 받은 뒤 계속 시딩하는 토렌트(서버를 다시 켜도 이어서)
  info_hash TEXT PRIMARY KEY,
  torrent BLOB NOT NULL,                      -- .torrent(정보 사전 + 원래 tracker)
  files TEXT NOT NULL,                        -- [{ path, size, hash }] 원래 파일 배치(hash NULL = 받지 않은 파일)
  uploaded INTEGER NOT NULL DEFAULT 0,        -- 시딩으로 올려 준 바이트 합계
  created_at INTEGER NOT NULL,                -- 시딩을 시작한 시각(상한을 넘으면 오래된 것부터 멈춤)
  stopped_at INTEGER                          -- 멈춘 시각(NULL = 시딩 중)
);
CREATE TABLE IF NOT EXISTS offline_seed_files ( -- Q-6: 그 토렌트로 받아 만든 드라이브 파일(모두 완전히 지워지면 시딩을 멈춤)
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  info_hash TEXT NOT NULL,
  PRIMARY KEY (file_id, info_hash)
);
`;

export const jobs = [
  { name: 'offline:engine', everyMs: 2000, run: (ctx) => tick(ctx) },
  { name: 'offline:seeding', everyMs: 60_000, run: (ctx) => syncSeeds(ctx) },
];
export const close = (ctx) => closeEngine(ctx);

const MAX_LINKS = 50;
const MAX_UPLOADS = 20;
const PREFETCH_MS = 20_000; // 한 요청의 .torrent 주소들을 미리 받는 전체 시간 상한
const SOCIAL = ['youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'tiktok.com', 'facebook.com', 'fb.watch'];
const STATUSES = ['queued', 'running', 'done', 'error', 'blocked', 'canceled'];
const QUOTA_MSG = {
  cloud_limit: '오늘의 무료 클라우드 다운로드 횟수를 모두 사용했습니다',
  monthly_quota: '이번 달 클라우드 다운로드 쿼터를 모두 사용했습니다',
  app_quota: '연결 앱에서 쓸 수 있는 클라우드 다운로드 쿼터를 모두 사용했습니다',
};

const TOO_LARGE_MSG = `토렌트 파일은 ${MAX_TORRENT_BYTES / 1024 / 1024}MB 이하만 쓸 수 있습니다`;

// ---------- 링크 분류 ----------
async function torrentItem(buf, source) {
  let p;
  try {
    p = await parseTorrent(buf);
  } catch {
    return null;
  }
  if (!p?.infoHash || !Array.isArray(p.files)) return null;
  if (tooManyFiles(p.files)) fail(400, 'too_many_files', `토렌트 하나에 파일이 ${BT_MAX_FILES.toLocaleString()}개를 넘으면 저장할 수 없습니다`);
  return { kind: 'torrent', source, name: safeName(p.name, p.infoHash), infoHash: p.infoHash, cacheKey: 'bt:' + p.infoHash, torrent: buf };
}

// 링크 한 줄 → 작업 항목. 지원하지 않거나 잘못된 링크면 null. 항목에 block 이 있으면 차단으로 기록한다
export async function classify(ctx, link, signal) {
  const s = String(link).trim();
  if (/^magnet:/i.test(s)) {
    let p;
    try {
      p = await parseTorrent(s);
    } catch {
      return null;
    }
    if (!/^[a-f0-9]{40}$/.test(p.infoHash || '')) return null;
    return { kind: 'magnet', source: s, name: safeName(p.name, p.infoHash), infoHash: p.infoHash, cacheKey: 'bt:' + p.infoHash };
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
  u.hash = ''; // 조각은 서버로 가지 않는다. 차단 비교·즉시 완료 키와 모양을 맞춘다(A-08·A-06)
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean).pop();
  const cacheKey = 'url:' + sha256(urlKey(u.href));
  if (u.pathname.toLowerCase().endsWith('.torrent')) {
    // .torrent 주소는 만들 때 바로 받아 infohash·파일 수를 확인한다. 차단된 주소(리다이렉트 포함)는 받지 않는다
    const blocked = (block) => ({ kind: 'torrent', source: u.href, name: safeName(seg, host), cacheKey, block });
    const block = findBlock(ctx.db, null, u.href);
    if (block) return blocked(block);
    try {
      const buf = await readLimited(await safeFetch(ctx, u.href, signal), MAX_TORRENT_BYTES);
      return buf ? await torrentItem(buf, u.href) : null;
    } catch (e) {
      if (e.code === 'too_many_files') throw e;
      if (e.code === 'torrent_too_large') fail(400, 'torrent_too_large', TOO_LARGE_MSG);
      if (e.code === 'blocked') return blocked({ id: e.blockId });
      return null;
    }
  }
  const social = SOCIAL.some((d) => host === d || host.endsWith('.' + d));
  let name = host;
  try {
    if (seg && !social) name = decodeURIComponent(seg);
  } catch {
    /* 그대로 */
  }
  return { kind: social ? 'social' : 'url', source: u.href, name: safeName(name, host), cacheKey };
}

// ---------- 작업 ----------
function taskApi(r) {
  return {
    id: r.id,
    kind: r.kind,
    source: r.source,
    name: r.name,
    parentId: r.parent_id,
    status: r.status,
    progress: r.progress,
    size: r.size,
    downloaded: r.downloaded,
    speed: r.speed,
    error: r.error,
    resultRootId: r.result_root_id,
    resultKind: r.result_kind ?? null,
    fileIds: json(r.file_ids, []),
    appeal: r.appeal_status ?? null,
    skippedAds: r.skipped_ads ?? 0,
    skippedBlocked: r.skipped_blocked ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}
const TASK_SELECT = `SELECT t.*,
  (SELECT kind FROM files f WHERE f.id=t.result_root_id AND f.user_id=t.user_id) AS result_kind,
  (SELECT status FROM offline_appeals a WHERE a.task_id=t.id ORDER BY a.created_at DESC LIMIT 1) AS appeal_status
  FROM offline_tasks t`;
const getTask = (db, userId, id) => db.prepare(`${TASK_SELECT} WHERE t.id=? AND t.user_id=?`).get(id, userId);
function requireTask(db, userId, id) {
  const t = getTask(db, userId, id);
  if (!t) fail(404, 'not_found', '작업을 찾을 수 없습니다');
  return t;
}

// social: 서버에 SNS 저장 도구(yt-dlp)가 있는지(A-04). 만들기 창이 안내 문구를 바꾼다
const allowanceOf = (ctx, user) => ({ ...cloudTaskAllowance(ctx.db, user), premium: isPremium(user), social: !!ytDlpPath(ctx.cfg) });

// 새 클라우드 다운로드(만들기·다시 시도)를 시작해도 되는지: 저장 공간·월 쿼터·연결 앱 상한
function checkRoom(db, user, src) {
  if (usage(db, user.id) >= capacityOf(user)) fail(403, 'storage_full', '저장 공간이 가득 차서 새 클라우드 다운로드를 만들 수 없습니다');
  const q = checkTransfer(db, user, 'cloud', 0, src);
  if (!q.ok) fail(403, q.reason, QUOTA_MSG[q.reason] || '클라우드 다운로드 쿼터를 모두 사용했습니다');
}

function createTasks(ctx, req, items, parentId) {
  const { db } = ctx;
  const user = req.user;
  if (parentId) requireNode(db, user.id, parentId, { kind: 'folder', space: 'drive' });
  const src = quotaSource(req);
  checkRoom(db, user, src);
  // 차단된 링크는 횟수를 쓰지 않는다. 남은 무료 횟수보다 많으면 하나도 만들지 않고 몇 개까지 되는지 알려 준다(A-01)
  const blocks = items.map((it) => it.block ?? findBlock(db, it.infoHash, it.source));
  const need = blocks.filter((b) => !b).length;
  const left = cloudTaskAllowance(db, user);
  if (!left.unlimited && need > left.remaining) {
    fail(403, 'cloud_limit', left.remaining ? `오늘 남은 무료 횟수는 ${left.remaining}회입니다. ${left.remaining}개 이하로 줄이거나 프리미엄을 이용하세요` : QUOTA_MSG.cloud_limit);
  }
  const ins = db.prepare(
    `INSERT INTO offline_tasks (id, user_id, kind, source, name, parent_id, status, error, block_id, cache_key, torrent, quota_source, charged, created_at, updated_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ids = tx(db, () =>
    items.map((it, i) => {
      const block = blocks[i];
      if (!block) consumeCloudTask(db, user);
      const id = newId('ot_');
      const t = now();
      ins.run(id, user.id, it.kind, it.source, it.name, parentId, block ? 'blocked' : 'queued', block ? 'blocked' : null, block?.id ?? null, it.cacheKey, it.torrent ?? null, src, block ? 0 : 1, t, t, block ? t : null);
      return id;
    }),
  );
  kick(ctx);
  return { tasks: ids.map((id) => taskApi(getTask(db, user.id, id))), allowance: allowanceOf(ctx, user) };
}

function guard(ctx, req) {
  if (!rateLimit(`offline:${req.user.id}`, 60, 60_000)) fail(429, 'rate_limited', '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요');
  // K-04: 관리자가 다운로드를 막은 국가의 사용자는 클라우드 다운로드를 만들 수 없다
  if (ctx.modules.auth?.regionBlocked?.(ctx.db, req.user, 'download', req)) fail(403, 'region_blocked', '현재 지역에서는 클라우드 다운로드를 사용할 수 없습니다');
}

function readTorrentUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: MAX_UPLOADS, fileSize: MAX_TORRENT_BYTES, fields: 10 } });
    } catch {
      return reject(Object.assign(new Error('multipart/form-data 형식으로 보내야 합니다'), { status: 400, code: 'invalid_upload' }));
    }
    const files = [];
    const fields = {};
    let tooMany = false;
    bb.on('filesLimit', () => (tooMany = true));
    bb.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => files.push({ filename: info.filename || 'file.torrent', buf: Buffer.concat(chunks), truncated: stream.truncated }));
    });
    bb.on('field', (k, v) => (fields[k] = v));
    bb.on('close', () => resolve({ files, fields, tooMany }));
    bb.on('error', (e) => reject(Object.assign(e, { status: 400, code: 'invalid_upload' })));
    req.pipe(bb);
  });
}

export function register(app, ctx) {
  const { db } = ctx;
  // 예전 DB 에 나중에 생긴 열을 더한다(CREATE TABLE IF NOT EXISTS 는 열을 추가하지 않음)
  const addCols = (table, defs) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const [col, def] of defs) if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCols('offline_tasks', [['skipped_ads', 'INTEGER NOT NULL DEFAULT 0'], ['skipped_blocked', 'INTEGER NOT NULL DEFAULT 0'], ['charged', 'INTEGER NOT NULL DEFAULT 1']]);
  addCols('offline_cache', [['etag', 'TEXT'], ['last_modified', 'TEXT'], ['length', 'INTEGER']]);
  requeueStale(db);
  kick(ctx);
  syncSeeds(ctx); // Q-6: 하던 시딩을 이어서

  // G-05: 'services' = 클라우드 다운로드 만들기·관리. 목록 보기는 services 또는 files:read 둘 중 하나면 된다(share 모듈과 같음)
  const write = requireScope('services');
  const read = (req, res, next) =>
    requireUser(req, res, () => (hasScope(req, 'services') || hasScope(req, 'files:read') ? next() : fail(403, 'insufficient_scope', '이 토큰에는 services 또는 files:read 권한이 없습니다')));

  // A-01·A-03·A-04: 링크 여러 개(줄바꿈) → 작업
  app.post('/api/offline/tasks', write, async (req, res) => {
    guard(ctx, req);
    const { urls, text } = req.body || {};
    const parentId = req.body?.parentId || null;
    if (parentId !== null && typeof parentId !== 'string') fail(400, 'invalid_parent', '저장 폴더가 올바르지 않습니다');
    const lines = [...(Array.isArray(urls) ? urls : []), ...(typeof text === 'string' ? text.split(/\r?\n/) : [])]
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean);
    const unique = [...new Set(lines)];
    if (!unique.length) fail(400, 'no_links', '저장할 링크를 입력하세요');
    if (unique.length > MAX_LINKS) fail(400, 'too_many_links', `한 번에 ${MAX_LINKS}개까지 만들 수 있습니다`);
    // .torrent 주소를 미리 받기 전에 만들 수 있는 요청인지부터 본다(외부 요청을 헛되이 보내지 않게). 실제 차감은 createTasks 의 트랜잭션에서
    if (parentId) requireNode(db, req.user.id, parentId, { kind: 'folder', space: 'drive' });
    checkRoom(db, req.user, quotaSource(req));
    const left = cloudTaskAllowance(db, req.user);
    if (!left.unlimited && left.remaining <= 0) fail(403, 'cloud_limit', QUOTA_MSG.cloud_limit);
    // .torrent 주소는 동시에 받고, 전체에 시간 상한 하나를 건다
    const signal = AbortSignal.timeout(PREFETCH_MS);
    const found = await Promise.all(unique.map((line) => classify(ctx, line, signal)));
    // SNS 저장 도구가 없으면 SNS 링크는 작업을 만들지 않는다(반드시 실패할 작업에 무료 횟수를 쓰지 않게)
    const noSocial = !ytDlpPath(ctx.cfg);
    const usable = (x) => x && !(noSocial && x.kind === 'social');
    const items = found.filter(usable);
    const invalid = unique.filter((_, i) => !usable(found[i]));
    if (!items.length && found.some((x) => x?.kind === 'social')) fail(400, 'social_unavailable', '서버에 SNS 저장 도구가 설치되어 있지 않아 SNS 게시물은 저장할 수 없습니다');
    if (!items.length) fail(400, 'invalid_link', '지원하지 않거나 잘못된 링크입니다');
    res.status(201).json({ ...createTasks(ctx, req, items, parentId), invalid });
  });

  // A-02: .torrent 파일 업로드(여러 개). 파일 7,000개 초과는 거절, 개별 파일 선택 없이 전체를 받는다
  app.post('/api/offline/torrent', write, async (req, res) => {
    guard(ctx, req);
    const { files, fields, tooMany } = await readTorrentUpload(req);
    if (tooMany) fail(400, 'too_many_uploads', `토렌트 파일은 한 번에 ${MAX_UPLOADS}개까지 올릴 수 있습니다`);
    if (!files.length) fail(400, 'no_files', '토렌트 파일을 선택하세요');
    const big = files.find((f) => f.truncated);
    if (big) fail(400, 'torrent_too_large', `${TOO_LARGE_MSG}(${safeName(big.filename, 'torrent')})`);
    const items = [];
    const invalid = [];
    for (const f of files) {
      const it = await torrentItem(f.buf, safeName(f.filename, 'torrent'));
      if (it) items.push(it);
      else invalid.push(f.filename);
    }
    if (!items.length) fail(400, 'invalid_torrent', '올바른 토렌트 파일이 아닙니다');
    res.status(201).json({ ...createTasks(ctx, req, items, fields.parentId || null), invalid });
  });

  // A-07: 전송 패널
  app.get('/api/offline/tasks', read, (req, res) => {
    const want = String(req.query.status || '');
    const list = want === 'active' ? ['queued', 'running'] : want.split(',').filter((s) => STATUSES.includes(s));
    const where = list.length ? ` AND t.status IN (${list.map(() => '?').join(',')})` : '';
    const rows = db.prepare(`${TASK_SELECT} WHERE t.user_id=?${where} ORDER BY t.created_at DESC, t.rowid DESC LIMIT 200`).all(req.user.id, ...list);
    res.json({ tasks: rows.map(taskApi), allowance: allowanceOf(ctx, req.user) });
  });
  app.get('/api/offline/allowance', read, (req, res) => res.json(allowanceOf(ctx, req.user)));
  app.get('/api/offline/tasks/:id', read, (req, res) => res.json({ task: taskApi(requireTask(db, req.user.id, req.params.id)) }));

  // 취소·삭제(받아 둔 파일은 드라이브에 그대로 남는다)
  app.delete('/api/offline/tasks/:id', write, (req, res) => {
    const t = requireTask(db, req.user.id, req.params.id);
    cancel(ctx, t.id);
    db.prepare('DELETE FROM offline_tasks WHERE id=? AND user_id=?').run(t.id, req.user.id);
    kick(ctx); // 비운 자리로 대기 작업을 바로 시작
    res.json({ ok: true });
  });

  // 다시 시도도 새로 받는 일이다: 요청 수·지역 차단(K-04)·저장 공간·월 쿼터·연결 앱 상한(F-05)을 만들 때처럼 확인한다(횟수는 쓰지 않음).
  // 다시 시도한 쪽(공식·연결 앱)의 쿼터로 센다
  app.post('/api/offline/tasks/:id/retry', write, (req, res) => {
    guard(ctx, req);
    const t = requireTask(db, req.user.id, req.params.id);
    if (!['error', 'canceled'].includes(t.status)) fail(400, 'not_retryable', '실패한 작업만 다시 시도할 수 있습니다');
    const src = quotaSource(req);
    checkRoom(db, req.user, src);
    tx(db, () => {
      if (!t.charged) consumeCloudTask(db, req.user); // 만들 때 차단돼 아직 무료 횟수를 쓰지 않은 작업(A-08)
      db.prepare(
        "UPDATE offline_tasks SET status='queued', progress=0, downloaded=0, speed=0, error=NULL, finished_at=NULL, quota_source=?, charged=1, updated_at=? WHERE id=? AND user_id=?",
      ).run(src, now(), t.id, req.user.id);
    });
    kick(ctx);
    res.json({ task: taskApi(getTask(db, req.user.id, t.id)) });
  });

  app.post('/api/offline/tasks/clear', write, (req, res) => {
    const s = req.body?.status || 'done';
    const list = s === 'finished' ? ['done', 'error', 'canceled', 'blocked'] : [s];
    if (!list.every((x) => ['done', 'error', 'canceled', 'blocked'].includes(x))) fail(400, 'invalid_status', '지울 수 없는 상태입니다');
    const r = db.prepare(`DELETE FROM offline_tasks WHERE user_id=? AND status IN (${list.map(() => '?').join(',')})`).run(req.user.id, ...list);
    res.json({ deleted: Number(r.changes) });
  });

  // A-08: 차단된 작업 이의제기
  app.post('/api/offline/tasks/:id/appeal', write, (req, res) => {
    guard(ctx, req);
    const t = requireTask(db, req.user.id, req.params.id);
    // 일부 파일만 차단돼 완료된 작업(done + block_id)도 이의제기할 수 있다
    if (t.status !== 'blocked' && !(t.status === 'done' && t.block_id)) fail(400, 'not_blocked', '차단된 작업만 이의를 제기할 수 있습니다');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 2 || reason.length > 1000) fail(400, 'invalid_reason', '이의제기 사유를 2~1000자로 적어 주세요');
    if (db.prepare("SELECT 1 FROM offline_appeals WHERE task_id=? AND status='open'").get(t.id)) fail(409, 'appeal_exists', '이미 검토 중인 이의제기가 있습니다');
    const id = newId('oa_');
    db.prepare('INSERT INTO offline_appeals (id, user_id, task_id, kind, source, block_id, reason, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id,
      req.user.id,
      t.id,
      t.kind,
      t.source,
      t.block_id,
      reason,
      now(),
    );
    res.status(201).json({ appeal: { id, taskId: t.id, status: 'open' } });
  });

  // Q-6: 시딩 중인 토렌트 수와 시딩으로 올려 준 바이트 합계
  app.get('/api/admin/offline/seeding', requireAdmin, (_req, res) => res.json(seedingStats(ctx)));

  app.get('/api/admin/offline/appeals', requireAdmin, (req, res) => {
    const status = ['open', 'accepted', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const rows = db
      .prepare(
        `SELECT a.*, u.email, u.phone, b.kind AS block_kind, b.value AS block_value, b.reason AS block_reason
         FROM offline_appeals a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN blocklist b ON b.id=a.block_id
         ${status ? 'WHERE a.status=?' : ''} ORDER BY a.created_at DESC LIMIT 200`,
      )
      .all(...(status ? [status] : []));
    res.json({
      appeals: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        user: r.email || r.phone,
        taskId: r.task_id,
        kind: r.kind,
        source: r.source,
        reason: r.reason,
        status: r.status,
        block: r.block_id ? { id: r.block_id, kind: r.block_kind, value: r.block_value, reason: r.block_reason } : null,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      })),
    });
  });

  // 차단이 풀린 작업을 다시 대기열에 넣는다. 새로 받는 일이므로 저장 공간·월 쿼터를 만들 때처럼 확인하고, 만들 때 차단돼 쓰지 않은
  // 무료 횟수는 지금 쓴다. 모자라면 그 사유로 실패 처리(사용자가 다시 시도할 때 다시 확인·차감)
  function requeueLifted(t) {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(t.user_id);
    let error = null;
    try {
      checkRoom(db, user, t.quota_source);
      if (!t.charged) consumeCloudTask(db, user);
    } catch (e) {
      error = e.code || 'download_failed';
    }
    db.prepare('UPDATE offline_tasks SET status=?, error=?, block_id=NULL, charged=?, finished_at=?, updated_at=? WHERE id=?').run(
      error ? 'error' : 'queued',
      error,
      error ? t.charged : 1,
      error ? now() : null,
      now(),
      t.id,
    );
  }

  // unblock: 차단 항목을 지우고 그 항목에 막혀 있던 작업(다른 사용자 것 포함)을 다시 대기열에 넣는다. reject: 차단 유지
  app.post('/api/admin/offline/appeals/:id/resolve', requireAdmin, (req, res) => {
    const action = req.body?.action;
    if (!['unblock', 'reject'].includes(action)) fail(400, 'invalid_action', 'action 은 unblock 또는 reject 입니다');
    const a = db.prepare('SELECT * FROM offline_appeals WHERE id=?').get(req.params.id);
    if (!a) fail(404, 'not_found', '이의제기를 찾을 수 없습니다');
    if (a.status !== 'open') fail(409, 'already_resolved', '이미 처리된 이의제기입니다');
    // ponytail: 일부만 차단됐던 완료 작업은 다시 받지 않는다(드라이브에 같은 파일이 겹치므로). 빠진 파일만 이어 붙이려면 offline_cache 의 경로로 노드를 만들 것
    const partial = db.prepare('SELECT status FROM offline_tasks WHERE id=?').get(a.task_id)?.status === 'done';
    tx(db, () => {
      db.prepare('UPDATE offline_appeals SET status=?, resolved_at=?, resolved_by=? WHERE id=?').run(action === 'unblock' ? 'accepted' : 'rejected', now(), req.user.id, a.id);
      if (action === 'unblock') {
        if (a.block_id) db.prepare('DELETE FROM blocklist WHERE id=?').run(a.block_id);
        const lifted = db.prepare("SELECT * FROM offline_tasks WHERE status='blocked' AND ((id=? AND user_id=?) OR block_id=?)").all(a.task_id, a.user_id, a.block_id);
        for (const t of lifted) requeueLifted(t);
      }
      const held = db.prepare('SELECT status FROM offline_tasks WHERE id=?').get(a.task_id)?.status === 'error'; // 횟수·용량이 모자라 시작하지 못함
      const [body, bodyEn] =
        action !== 'unblock'
          ? ['검토 결과 차단을 유지합니다.', 'After review, the block stays in place.']
          : partial
            ? ['차단이 풀렸습니다. 같은 링크로 다시 받으면 빠졌던 파일도 저장됩니다.', 'The block was lifted. Download the same link again to also save the files that were left out.']
            : held
              ? [
                  '차단이 풀렸지만 남은 무료 횟수나 저장 공간이 모자라 시작하지 못했습니다. 전송 목록에서 다시 시도해 주세요.',
                  "The block was lifted, but the download couldn't start because you're out of free downloads or storage. Please retry from the transfer list.",
                ]
              : ['차단이 풀려 클라우드 다운로드를 다시 진행합니다.', 'The block was lifted and your cloud download will continue.'];
      notify(db, a.user_id, {
        kind: 'offline_appeal',
        title: action === 'unblock' ? '이의제기가 받아들여졌습니다' : '이의제기가 반려되었습니다',
        titleEn: action === 'unblock' ? 'Your appeal was accepted' : 'Your appeal was rejected',
        body,
        bodyEn,
        link: '/drive/all',
      });
      audit(db, { userId: req.user.id, action: `offline.appeal.${action}`, detail: { appealId: a.id, taskId: a.task_id, blockId: a.block_id }, ip: req.ip });
    });
    kick(ctx);
    res.json({ ok: true, status: action === 'unblock' ? 'accepted' : 'rejected' });
  });
}
