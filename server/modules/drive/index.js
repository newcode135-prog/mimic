// 드라이브 모듈: 폴더·파일 관리(B-01), 휴지통(B-02), 리소스 링크(B-04), 검색·정렬·보기 기억(B-05),
// 업로드(B-06), 기기로 다운로드(B-07), 최근 저장됨(B-10), 즐겨찾기(B-11), 일괄 작업(B-12), 온보딩(K-08)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import busboy from 'busboy';
import { now, fail, json, DAY } from '../../core/util.js';
import { tx } from '../../core/db.js';
import { requireScope, quotaSource, getSettings, saveSettings } from '../../core/auth.js';
import {
  toApi, getNode, requireNode, listChildren, uniqueName, createFolder, createFileNode,
  usage, checkCapacity, pathOf, descendantIds, copyTree, treeSize, validName,
} from '../../core/files.js';
import { ingestStream, ingestFile, sendBlob, tmpPath, hasBlob } from '../../core/storage.js';
import { TRASH_DAYS, SIGNUP_BONUS_CLOUD, SLOW_BPS, capacityOf, speedFor } from '../../core/plans.js';
import { addUsage, checkTransfer, grant, summary } from '../../core/quota.js';

export const migrations = `
CREATE TABLE IF NOT EXISTS drive_assets (
  key TEXT PRIMARY KEY,
  blob_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`;

const LINK_HOURS = 24;
const RECENT_DAYS = 30;
const BLOCKED_OWNER = new Set(['deleted', 'pending_delete', 'locked', 'suspended']);

// ---------- 정렬·보기 기억(B-05) ----------
const coll = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
export const SORTS = {
  name: (a, b) => coll.compare(a.name, b.name),
  name_desc: (a, b) => coll.compare(b.name, a.name),
  newest: (a, b) => b.updated_at - a.updated_at,
  oldest: (a, b) => a.updated_at - b.updated_at,
  largest: (a, b) => b.size - a.size,
  smallest: (a, b) => a.size - b.size,
};
export function sortRows(rows, { sort, foldersFirst }) {
  const cmp = SORTS[sort] || SORTS.name;
  return rows.sort((a, b) => (foldersFirst && a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : 0) || cmp(a, b) || coll.compare(a.name, b.name));
}

// 정렬 기억 범위가 'global' 이면 '*' 한 칸, 'folder' 면 폴더(또는 recent·star·search 같은 화면)마다 따로 저장한다.
// 값이 없으면 'folder'(설정 화면 integrations SETTING_DEFAULTS 와 같은 기본값). 폴더에 저장된 값이 없으면 '*' 값을 쓴다
const prefKey = (scope, key) => (scope === 'global' ? '*' : key);
export function readPrefs(settings, key) {
  const sortScope = settings.sortScope === 'global' ? 'global' : 'folder';
  const viewScope = settings.viewScope === 'global' ? 'global' : 'folder';
  const sp = settings.sortPrefs?.[prefKey(sortScope, key)] || settings.sortPrefs?.['*'] || {};
  const view = settings.viewPrefs?.[prefKey(viewScope, key)] || settings.viewPrefs?.['*'];
  return { sort: SORTS[sp.sort] ? sp.sort : 'name', foldersFirst: sp.foldersFirst !== false, view: view === 'list' ? 'list' : 'grid', sortScope, viewScope };
}
// 고정 화면 키이거나 내 폴더 id 만 받는다(settings 가 끝없이 커지지 않게)
const PREF_SCREENS = new Set(['root', 'recent', 'star', 'search', 'trash']);
function prefFolder(db, uid, v) {
  if (v == null || v === '') return 'root';
  if (typeof v !== 'string') fail(400, 'invalid_input', '폴더 값이 올바르지 않습니다');
  return PREF_SCREENS.has(v) ? v : driveNode(db, uid, v, { kind: 'folder' }).id;
}
// ?sort=&foldersFirst= 로 이번 요청만 바꿀 수 있다. 없으면 저장된 값
function pickSort(query, prefs) {
  const ff = query.foldersFirst;
  return { sort: SORTS[query.sort] ? query.sort : prefs.sort, foldersFirst: ff == null ? prefs.foldersFirst : ff !== '0' && ff !== 'false' };
}

// ---------- 입력 검증 ----------
function idsOf(body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string' && x.length <= 64)) {
    fail(400, 'invalid_input', '대상 파일을 골라 주세요');
  }
  if (ids.length > 1000) fail(400, 'invalid_input', '한 번에 1000개까지 처리할 수 있어요');
  return [...new Set(ids)];
}
const driveNode = (db, uid, id, opts = {}) => requireNode(db, uid, id, { space: 'drive', ...opts });
function parentOf(db, uid, v) {
  if (v == null || v === '' || v === 'root') return null;
  if (typeof v !== 'string') fail(400, 'invalid_input', '폴더 값이 올바르지 않습니다');
  return driveNode(db, uid, v, { kind: 'folder' }).id;
}
const intoSelf = (db, uid, node, target) => target && node.kind === 'folder' && descendantIds(db, uid, node.id).includes(target);

// 폴더 업로드: parentId 아래에 상대 경로("사진/2026")의 폴더를 찾거나 만든다
function folderFor(db, uid, parentId, relPath) {
  let parent = parentOf(db, uid, parentId);
  const segs = String(relPath || '').split(/[\\/]/).map((s) => s.trim()).filter(Boolean);
  if (segs.length > 32) fail(400, 'invalid_input', '폴더가 너무 깊습니다');
  const find = db.prepare("SELECT id FROM files WHERE user_id=? AND parent_id IS ? AND space='drive' AND kind='folder' AND name=? AND trashed_at IS NULL");
  for (const name of segs) {
    if (!validName(name)) fail(400, 'invalid_name', '사용할 수 없는 폴더 이름입니다');
    parent = find.get(uid, parent, name)?.id ?? createFolder(db, uid, parent, name).id;
  }
  return parent;
}
// 이번 달 업로드 쿼터 남은 양(연결 앱은 25% 몫도 함께). Content-Length 없는 chunked 업로드도 여기서 막힌다
function upLeft(db, user, source) {
  const s = summary(db, user);
  const month = s.month.up.limit - s.month.up.used;
  const app = source === 'app' ? s.app.up.limit - s.app.up.used : Infinity;
  return app < month ? { left: app, reason: 'app_quota' } : { left: month, reason: 'monthly_quota' };
}
// 연결 앱 몫(25%)만 찬 경우 웹·공식 앱은 아직 올릴 수 있으니 그렇게 알려 준다
function upFail(reason, msg = '이번 달 업로드 한도를 모두 사용했습니다') {
  fail(429, reason, reason === 'app_quota' ? '연결 앱 업로드 한도(월 업로드 쿼터의 25%)를 모두 사용했습니다. 미믹 웹과 공식 앱에서는 계속 올릴 수 있어요' : msg);
}
function cleanName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop().trim().slice(0, 255);
  return validName(base) ? base : '이름 없는 파일';
}
// 명령줄·앱 업로드는 형식을 octet-stream 으로 보내는 일이 많아 흔한 확장자만 보정한다
const EXT_MIME = { mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain' };
function mimeOf(name, given) {
  if (given && given !== 'application/octet-stream') return given;
  return EXT_MIME[name.split('.').pop().toLowerCase()] || given || 'application/octet-stream';
}

// ---------- 다운로드(B-07)·서명 링크(B-04) ----------
function rangeLength(req, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) return size;
  if (m[1] === '') return Math.min(size, Number(m[2] || 0));
  const end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return Math.max(0, end - Number(m[1]) + 1);
}
const sign = (cfg, p) => crypto.createHmac('sha256', cfg.secret).update('drive-dl:' + p).digest('base64url');
// s: 쿼터 출처(연결 앱이 만든 링크는 'app' 몫으로 차감), t: 만든 토큰 id(토큰을 끊으면 링크도 끊긴다). 둘 다 서명 안에 있어 바꿀 수 없다
export function makeLink(cfg, userId, fileId, expiresAt, { source = 'official', tokenId } = {}) {
  const p = Buffer.from(JSON.stringify({ u: userId, f: fileId, e: expiresAt, s: source, t: tokenId })).toString('base64url');
  return `${p}.${sign(cfg, p)}`;
}
function readLink(cfg, token) {
  const [p, s] = String(token).split('.');
  if (!p || !s) return null;
  const want = Buffer.from(sign(cfg, p));
  const got = Buffer.from(s);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const v = json(Buffer.from(p, 'base64url').toString(), null);
  return v && typeof v.u === 'string' && typeof v.f === 'string' && v.e > now() ? v : null;
}

// ---------- 휴지통(B-02) ----------
export function purgeTrash(db, t = now()) {
  // 함께 버린 하위 항목은 같은 trashed_at 을 가지므로 한 문장으로 같이 지워진다
  return db.prepare("DELETE FROM files WHERE space='drive' AND trashed_at IS NOT NULL AND trashed_at < ?").run(t - TRASH_DAYS * DAY).changes;
}
export const jobs = [{ name: 'drive:purge-trash', everyMs: 3600_000, run: (ctx) => purgeTrash(ctx.db) }];

// ---------- 온보딩(K-08) ----------
const execFileP = promisify(execFile);
const tutorialJobs = new WeakMap();
const TUTORIAL_KEY = 'tutorial_v2'; // 내용을 바꾸면 올린다(예전 영상을 캐시에서 다시 쓰지 않게)
const TUTORIAL_SEC = 4;
// [제목, 설명, 영어 설명]. drawtext 에 넘기므로 ' : % \ 는 쓰지 않는다
const TUTORIAL = [
  ['미믹에 오신 걸 환영해요', '처음 쓰는 분을 위한 짧은 안내예요', 'Welcome to Mimic - a quick tour'],
  ['1. 올리기', '파일이나 폴더를 드라이브 화면에 끌어다 놓으세요', 'Upload - drop files or folders onto the drive'],
  ['2. 클라우드 다운로드', '링크나 토렌트를 붙여 넣으면 미믹이 대신 받아 둬요', 'Cloud download - paste a link or torrent and Mimic saves it'],
  ['3. 공유', '파일을 고르고 Shift+S 를 누르면 공유 링크가 생겨요', 'Share - select files and press Shift+S'],
  ['4. 재생', '영상은 두 번 눌러 바로 보고 외부 플레이어로도 열 수 있어요', 'Play - double-click a video or open it in another player'],
  ['이제 시작해 보세요', '이 영상은 필요 없으면 지워도 괜찮아요', 'You are all set. Feel free to delete this video'],
];
// 한글 글꼴(OS 마다 위치가 다르다). 없으면 글자 없는 시험 화면으로 대신한다
const TUTORIAL_FONTS = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'malgun.ttf'),
  '/System/Library/Fonts/AppleSDGothicNeo.ttc',
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
];
const ffq = (s) => `'${String(s).replace(/\\/g, '/').replace(/[:']/g, (c) => '\\' + c)}'`; // 필터 값 따옴표·이스케이프
function tutorialArgs(font, out) {
  const dur = font ? TUTORIAL.length * TUTORIAL_SEC : 10;
  const video = font ? `color=c=0x1e2347:size=960x540:rate=10:duration=${dur}` : 'testsrc2=size=640x360:rate=25:duration=10';
  const vf = font
    ? ['-vf', TUTORIAL.flatMap(([title, ko, en], i) => {
        const at = `fontfile=${ffq(font)}:expansion=none:x=(w-text_w)/2:enable='gte(t,${i * TUTORIAL_SEC})*lt(t,${(i + 1) * TUTORIAL_SEC})'`;
        return [
          `drawtext=${at}:text=${ffq(title)}:fontsize=48:fontcolor=white:y=h/2-80`,
          `drawtext=${at}:text=${ffq(ko)}:fontsize=28:fontcolor=0xc9d2ff:y=h/2+5`,
          `drawtext=${at}:text=${ffq(en)}:fontsize=20:fontcolor=0x8f9ad0:y=h/2+50`,
        ];
      }).join(',')]
    : [];
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', ...vf,
    '-t', String(dur), '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', out];
}
// 튜토리얼 영상은 처음 한 번만 ffmpeg 로 만들고 같은 blob 을 모든 신규 계정이 참조한다. ffmpeg 가 없으면 null
export function tutorialBlob(ctx) {
  const { db, cfg } = ctx;
  const row = db.prepare('SELECT blob_hash FROM drive_assets WHERE key=?').get(TUTORIAL_KEY);
  if (row && hasBlob(db, cfg, row.blob_hash)) return Promise.resolve(row.blob_hash);
  if (!tutorialJobs.has(db)) {
    const out = tmpPath(cfg, 'tutorial_') + '.mp4';
    const font = TUTORIAL_FONTS.find((f) => fs.existsSync(f));
    const run = (f) => execFileP('ffmpeg', tutorialArgs(f, out), { timeout: 120_000, windowsHide: true });
    // drawtext(libfreetype) 없는 ffmpeg 면 글자 없는 화면으로 한 번 더
    const job = run(font)
      .catch((e) => (font ? run(null) : Promise.reject(e)))
      .then(() => ingestFile(db, cfg, out, 'video/mp4'))
      .then(({ hash }) => {
        db.prepare('INSERT OR REPLACE INTO drive_assets (key, blob_hash, created_at) VALUES (?, ?, ?)').run(TUTORIAL_KEY, hash, now());
        return hash;
      })
      .catch((e) => {
        if (!cfg.quiet) console.warn('[drive] 튜토리얼 영상을 만들지 못해 건너뜁니다:', e.message);
        return null;
      })
      .finally(() => tutorialJobs.delete(db));
    tutorialJobs.set(db, job);
  }
  return tutorialJobs.get(db);
}

export async function onboard(ctx, userId) {
  const { db } = ctx;
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) return;
  const findPack = db.prepare("SELECT * FROM files WHERE user_id=? AND parent_id IS NULL AND space='drive' AND kind='folder' AND origin='onboarding' AND json_extract(meta,'$.default')=1 AND trashed_at IS NULL"); // 복사본·공유 저장본은 meta 가 따라와도 원본이 아니다
  if (!findPack.get(userId)) createFolder(db, userId, null, 'My Pack', { origin: 'onboarding', meta: { default: true } });
  if (!db.prepare("SELECT 1 FROM quota_grants WHERE user_id=? AND kind='cloud_count' AND reason='signup_bonus'").get(userId)) {
    grant(db, userId, { kind: 'cloud_count', amount: SIGNUP_BONUS_CLOUD, reason: 'signup_bonus' });
  }
  const hash = await tutorialBlob(ctx);
  const pack = hash && findPack.get(userId);
  if (!pack || db.prepare('SELECT 1 FROM files WHERE user_id=? AND parent_id=? AND blob_hash=?').get(userId, pack.id, hash)) return;
  const size = Number(db.prepare('SELECT size FROM blobs WHERE hash=?').get(hash).size);
  createFileNode(db, userId, pack.id, { name: '미믹 시작하기.mp4', size, mime: 'video/mp4', blobHash: hash, origin: 'onboarding', meta: { tutorial: true } });
}

export async function close(ctx) {
  await tutorialJobs.get(ctx.db);
}

// ---------- API ----------
export function register(app, ctx) {
  const { db, cfg, events } = ctx;
  const R = requireScope('files:read');
  const W = requireScope('files:write');
  const M = requireScope('files:manage'); // 휴지통 이동·복원(G-05)
  const D = requireScope('files:delete'); // 영구삭제·비우기: 토큰·WebDAV 에는 줄 수 없다(G-01, G-04)
  const settingsOf = (req) => getSettings(req.user);
  const listOut = (req, rows, key, sortable = true) => {
    const prefs = readPrefs(settingsOf(req), key);
    return { items: (sortable ? sortRows(rows, pickSort(req.query, prefs)) : rows).map(toApi), prefs };
  };

  events.on('user:created', ({ userId } = {}) => {
    onboard(ctx, userId).catch((e) => console.error('[drive] 온보딩 실패', e));
  });

  app.get('/api/drive/list', R, (req, res) => {
    const uid = req.user.id;
    const parentId = parentOf(db, uid, req.query.parentId);
    res.json({
      ...listOut(req, listChildren(db, uid, parentId), parentId || 'root'),
      path: pathOf(db, uid, parentId),
      folder: parentId ? toApi(getNode(db, uid, parentId)) : null,
    });
  });

  app.get('/api/drive/files/:id', R, (req, res) => {
    const n = driveNode(db, req.user.id, req.params.id);
    res.json({ file: toApi(n), path: pathOf(db, req.user.id, n.parent_id) });
  });

  app.post('/api/drive/folders', W, (req, res) => {
    const parentId = parentOf(db, req.user.id, req.body?.parentId);
    if (!validName(req.body?.name)) fail(400, 'invalid_name', '사용할 수 없는 이름입니다');
    res.status(201).json({ folder: toApi(createFolder(db, req.user.id, parentId, req.body.name)) });
  });

  // 업로드(B-06): 필드 parentId·path 를 파일보다 먼저 보낸다(쿼리스트링도 가능). 한 요청에 여러 파일 가능.
  // 다 받은 뒤 한꺼번에 저장한다: 하나라도 실패하면 이 요청의 파일은 하나도 남지 않고 쿼터도 빠지지 않는다
  app.post('/api/drive/upload', W, async (req, res) => {
    const user = req.user;
    const source = quotaSource(req);
    if (!req.is('multipart/form-data')) fail(400, 'invalid_input', '파일을 multipart/form-data 로 보내 주세요');
    const q = checkTransfer(db, user, 'up', Number(req.get('content-length')) || 0, source);
    if (!q.ok) upFail(q.reason);
    const fields = { parentId: req.query.parentId, path: req.query.path };
    let bb;
    try {
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 100, fields: 20, fieldSize: 4096 } });
    } catch {
      fail(400, 'invalid_input', '업로드 형식이 올바르지 않습니다');
    }
    const got = await new Promise((resolve, reject) => {
      const jobs = [];
      const streams = new Set(); // 받는 중인 파일 스트림: 중단되면 오류로 끊어 ingestStream 이 임시 파일을 지우게 한다
      let done = false;
      const abort = (e) => {
        if (done) return;
        done = true;
        req.unpipe(bb);
        req.resume();
        bb.destroy();
        for (const st of streams) st.destroy(); // 받는 중이면 pipeline 이 premature close 로 끝난다
        reject(e);
      };
      // 클라이언트가 중간에 끊으면 busboy 가 끝나지 않으므로 직접 정리한다(본문을 다 받은 뒤의 close 는 정상)
      req.on('close', () => req.complete || abort(Object.assign(new Error('업로드가 중단되었습니다'), { status: 400, code: 'aborted' })));
      bb.on('field', (k, v) => {
        if (k === 'parentId' || k === 'path') fields[k] = v;
      });
      bb.on('file', (_field, stream, info) => {
        streams.add(stream);
        const at = { parentId: fields.parentId, path: fields.path }; // 이 파일 앞에 온 값
        const job = (async () => {
          parentOf(db, user.id, at.parentId); // 없는 폴더면 받기 전에 404
          const left = capacityOf(user) - usage(db, user.id);
          if (left <= 0) fail(403, 'storage_full', '저장 공간이 부족합니다');
          const quota = upLeft(db, user, source);
          if (quota.left <= 0) upFail(quota.reason);
          const name = cleanName(info.filename);
          const mime = mimeOf(name, info.mimeType);
          const { hash, size } = await ingestStream(db, cfg, stream, mime, { maxBytes: Math.min(left, quota.left) }).catch((e) => {
            if (e.code === 'storage_full' && quota.left < left) upFail(quota.reason, '이번 달 업로드 한도를 넘었습니다');
            throw e;
          });
          streams.delete(stream);
          return { ...at, name, mime, hash, size };
        })();
        job.catch((e) => {
          stream.resume();
          abort(e);
        });
        jobs.push(job);
      });
      bb.on('close', () => Promise.all(jobs).then((r) => ((done = true), resolve(r)), abort));
      bb.on('error', (e) => abort(Object.assign(e, { status: 400 })));
      req.pipe(bb);
    });
    if (!got.length) fail(400, 'no_file', '올릴 파일이 없습니다');
    // 같은 요청의 앞 파일이나 동시에 온 다른 요청이 먼저 자리·쿼터를 차지했을 수 있어 합계로 다시 본다
    const files = tx(db, () => {
      const total = got.reduce((n, g) => n + g.size, 0);
      checkCapacity(db, user, total);
      const q2 = checkTransfer(db, user, 'up', total, source);
      if (!q2.ok) upFail(q2.reason, '이번 달 업로드 한도를 넘었습니다');
      return got.map((g) => {
        const node = createFileNode(db, user.id, folderFor(db, user.id, g.parentId, g.path), { name: g.name, size: g.size, mime: g.mime, blobHash: g.hash, origin: 'upload' });
        addUsage(db, user.id, 'up', g.size, source);
        return toApi(node);
      });
    });
    res.status(201).json({ files, file: files[0] });
  });

  app.patch('/api/drive/files/:id', W, (req, res) => {
    const uid = req.user.id;
    const n = driveNode(db, uid, req.params.id);
    const name = req.body?.name;
    if (!validName(name)) fail(400, 'invalid_name', '사용할 수 없는 이름입니다');
    if (name.trim() !== n.name) {
      db.prepare('UPDATE files SET name=?, updated_at=? WHERE id=? AND user_id=?').run(uniqueName(db, uid, n.parent_id, name.trim()), now(), n.id, uid);
    }
    res.json({ file: toApi(getNode(db, uid, n.id)) });
  });

  app.post('/api/drive/move', W, (req, res) => {
    const uid = req.user.id;
    const ids = idsOf(req.body);
    const target = parentOf(db, uid, req.body.parentId);
    const items = tx(db, () =>
      ids.map((id) => {
        const n = driveNode(db, uid, id);
        if (intoSelf(db, uid, n, target)) fail(400, 'invalid_target', '폴더를 자기 자신이나 그 안으로 옮길 수 없습니다');
        if (n.parent_id !== target) db.prepare('UPDATE files SET parent_id=?, name=? WHERE id=? AND user_id=?').run(target, uniqueName(db, uid, target, n.name), n.id, uid);
        return toApi(getNode(db, uid, n.id));
      }),
    );
    res.json({ items });
  });

  app.post('/api/drive/copy', W, (req, res) => {
    const uid = req.user.id;
    const ids = idsOf(req.body);
    const target = parentOf(db, uid, req.body.parentId);
    const nodes = ids.map((id) => driveNode(db, uid, id));
    if (nodes.some((n) => intoSelf(db, uid, n, target))) fail(400, 'invalid_target', '폴더를 자기 자신 안으로 복사할 수 없습니다');
    checkCapacity(db, req.user, nodes.reduce((s, n) => s + treeSize(db, uid, n.id), 0));
    const items = tx(db, () => nodes.map((n) => toApi(copyTree(db, uid, n.id, uid, target, { origin: 'copy' }))));
    res.status(201).json({ items });
  });

  // 상위 폴더와 그 안의 항목을 한 요청에 보내도 상위부터 처리한다(휴지통에 하위가 따로 보이거나, 복원 때 루트로 가지 않게)
  const shallowFirst = (uid, ids) => ids.map((id) => [pathOf(db, uid, id).length, id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

  app.post('/api/drive/trash', M, (req, res) => {
    const uid = req.user.id;
    const ids = shallowFirst(uid, idsOf(req.body));
    const t = now();
    const hide = db.prepare('UPDATE files SET trashed_at=?, trash_root=0 WHERE id=? AND user_id=? AND trashed_at IS NULL');
    tx(db, () => {
      for (const id of ids) {
        const n = driveNode(db, uid, id, { allowTrashed: true });
        if (n.trashed_at) continue; // 같은 요청에서 상위 폴더와 함께 이미 들어갔다
        for (const d of descendantIds(db, uid, n.id)) hide.run(t, d, uid);
        db.prepare('UPDATE files SET trash_root=1 WHERE id=? AND user_id=?').run(n.id, uid);
      }
    });
    res.json({ ok: true, trashedAt: t, expiresAt: t + TRASH_DAYS * DAY });
  });

  app.get('/api/drive/trash', R, (req, res) => {
    const rows = db
      .prepare("SELECT * FROM files WHERE user_id=? AND space='drive' AND trash_root=1 AND trashed_at IS NOT NULL ORDER BY trashed_at DESC")
      .all(req.user.id);
    res.json({ items: rows.map((r) => ({ ...toApi(r), expiresAt: r.trashed_at + TRASH_DAYS * DAY })), days: TRASH_DAYS, prefs: readPrefs(settingsOf(req), 'trash') });
  });

  app.post('/api/drive/restore', M, (req, res) => {
    const uid = req.user.id;
    const ids = idsOf(req.body);
    const items = tx(db, () => {
      for (const id of shallowFirst(uid, ids)) {
        const n = driveNode(db, uid, id, { allowTrashed: true });
        if (!n.trashed_at) continue; // 같은 요청에서 상위 폴더와 함께 이미 되살아났다
        const parent = n.parent_id ? getNode(db, uid, n.parent_id) : null;
        const parentId = parent && !parent.trashed_at ? parent.id : null; // 원래 폴더가 없거나 휴지통이면 루트로
        const name = uniqueName(db, uid, parentId, n.name);
        const show = db.prepare('UPDATE files SET trashed_at=NULL, trash_root=0 WHERE id=? AND user_id=? AND trashed_at=?');
        for (const d of descendantIds(db, uid, n.id)) show.run(d, uid, n.trashed_at);
        db.prepare('UPDATE files SET parent_id=?, name=? WHERE id=? AND user_id=?').run(parentId, name, n.id, uid);
      }
      return ids.map((id) => toApi(getNode(db, uid, id)));
    });
    res.json({ items });
  });

  app.post('/api/drive/delete-forever', D, (req, res) => {
    const uid = req.user.id;
    const ids = idsOf(req.body);
    const del = db.prepare('DELETE FROM files WHERE id=? AND user_id=? AND trashed_at=?'); // 함께 버린 하위만. 따로 먼저 버린 하위는 휴지통에 남는다
    let deleted = 0;
    tx(db, () => {
      for (const id of ids) {
        const n = getNode(db, uid, id);
        if (!n) continue; // 같은 요청에서 상위 폴더와 함께 이미 지워졌다
        if (n.space !== 'drive') fail(404, 'not_found', '파일을 찾을 수 없습니다');
        if (!n.trashed_at) fail(400, 'not_in_trash', '휴지통에 있는 항목만 완전히 지울 수 있습니다');
        for (const d of descendantIds(db, uid, n.id)) deleted += Number(del.run(d, uid, n.trashed_at).changes);
      }
    });
    res.json({ deleted });
  });

  app.post('/api/drive/trash/empty', D, (req, res) => {
    const r = db.prepare("DELETE FROM files WHERE user_id=? AND space='drive' AND trashed_at IS NOT NULL").run(req.user.id);
    res.json({ deleted: Number(r.changes) });
  });

  app.post('/api/drive/star', W, (req, res) => {
    const uid = req.user.id;
    const ids = idsOf(req.body);
    if (typeof req.body.starred !== 'boolean') fail(400, 'invalid_input', 'starred 는 true/false 여야 합니다');
    tx(db, () => {
      for (const id of ids) db.prepare('UPDATE files SET starred=? WHERE id=? AND user_id=?').run(req.body.starred ? 1 : 0, driveNode(db, uid, id).id, uid);
    });
    res.json({ ok: true });
  });

  app.get('/api/drive/starred', R, (req, res) => {
    const rows = db.prepare("SELECT * FROM files WHERE user_id=? AND space='drive' AND starred=1 AND trashed_at IS NULL").all(req.user.id);
    res.json(listOut(req, rows, 'star'));
  });

  app.get('/api/drive/recent', R, (req, res) => {
    const rows = db
      .prepare("SELECT * FROM files WHERE user_id=? AND space='drive' AND kind='file' AND trashed_at IS NULL AND created_at>=? ORDER BY created_at DESC LIMIT 500")
      .all(req.user.id, now() - RECENT_DAYS * DAY);
    res.json(listOut(req, rows, 'recent', false));
  });

  // 검색은 500개까지. 자르기 전에 SQL 에서 같은 정렬을 적용해 '큰 파일·최신' 등이 전체에서 고른 앞부분이 되게 하고, 잘렸으면 truncated 로 알린다
  const SEARCH_MAX = 500;
  const SQL_ORDER = { name: 'name COLLATE NOCASE', name_desc: 'name COLLATE NOCASE DESC', newest: 'updated_at DESC', oldest: 'updated_at', largest: 'size DESC', smallest: 'size' };
  app.get('/api/drive/search', R, (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const { sort, foldersFirst } = pickSort(req.query, readPrefs(settingsOf(req), 'search'));
    const order = (foldersFirst ? "kind='folder' DESC, " : '') + SQL_ORDER[sort];
    const rows = q
      ? db.prepare(`SELECT * FROM files WHERE user_id=? AND space='drive' AND trashed_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY ${order} LIMIT ?`).all(req.user.id, like, SEARCH_MAX + 1)
      : [];
    const truncated = rows.length > SEARCH_MAX;
    res.json({ ...listOut(req, rows.slice(0, SEARCH_MAX), 'search'), q, truncated });
  });

  // 다운스트림 쿼터: 한도를 넘으면 막지 않고 SLOW_BPS 로 감속, 만료 3단계(8-6)도 감속.
  // 사용량은 연결이 끝날 때 적히므로, 보내는 중인 바이트를 함께 세어 동시 연결(분할 다운로드)로 한도를 넘지 못하게 한다.
  // ponytail: 사용자별 합계 하나라 연결 앱 몫(app_quota) 검사에도 공식 다운로드 진행분이 더해진다(감속 쪽으로만 어긋남). 정확히 하려면 source 별로 나눈다
  const inflight = new Map(); // userId → 보내는 중인 바이트
  function sendDownload(req, res, owner, node, source) {
    if (node.kind !== 'file') fail(400, 'not_a_file', '폴더는 바로 내려받을 수 없습니다');
    if (!node.blob_hash) fail(409, 'not_ready', '아직 받는 중인 파일입니다');
    const len = rangeLength(req, node.size);
    const busy = inflight.get(owner.id) || 0;
    const q = checkTransfer(db, owner, 'down', busy + len, source);
    if (!q.ok && !q.slow) fail(429, q.reason, '다운로드 한도를 모두 사용했습니다');
    inflight.set(owner.id, busy + len);
    res.once('close', () => {
      const left = (inflight.get(owner.id) || 0) - len;
      if (left > 0) inflight.set(owner.id, left);
      else inflight.delete(owner.id);
    });
    const slow = !q.ok || Number(getSettings(owner).expiryStage) >= 3;
    if (slow) res.set('X-Mimic-Throttled', q.ok ? 'expiry' : q.reason); // 웹이 HEAD 로 읽어 감속 이유를 알려 준다
    sendBlob(req, res, cfg, node.blob_hash, {
      name: node.name,
      mime: node.mime,
      inline: false,
      throttleBps: slow ? SLOW_BPS : speedFor(owner),
      onBytes: (n) => addUsage(db, owner.id, 'down', n, source),
    });
  }

  app.get('/api/drive/files/:id/download', R, (req, res) => {
    sendDownload(req, res, req.user, driveNode(db, req.user.id, req.params.id), quotaSource(req));
  });

  app.get('/api/drive/files/:id/link', R, (req, res) => {
    const n = driveNode(db, req.user.id, req.params.id, { kind: 'file' });
    const expiresAt = now() + LINK_HOURS * 3600_000;
    const link = makeLink(cfg, req.user.id, n.id, expiresAt, { source: quotaSource(req), tokenId: req.tokenId });
    res.json({ url: `/api/drive/dl/${link}`, expiresAt });
  });

  // 서명된 임시 링크: 로그인 없이 받되 쿼터는 소유자에게서, 링크를 만든 쪽(공식·연결 앱) 몫으로 차감
  const liveToken = db.prepare('SELECT 1 FROM personal_tokens WHERE id=? AND user_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)');
  app.get('/api/drive/dl/:token', (req, res) => {
    const v = readLink(cfg, req.params.token);
    const owner = v && (!v.t || liveToken.get(v.t, v.u, now())) && db.prepare('SELECT * FROM users WHERE id=?').get(v.u);
    const node = owner && !BLOCKED_OWNER.has(owner.status) ? getNode(db, owner.id, v.f) : null;
    if (!node || node.space !== 'drive' || node.trashed_at) fail(404, 'link_invalid', '링크가 만료되었거나 파일이 없습니다');
    sendDownload(req, res, owner, node, v.s === 'app' ? 'app' : 'official');
  });

  app.get('/api/drive/prefs', R, (req, res) => {
    res.json({ prefs: readPrefs(settingsOf(req), prefFolder(db, req.user.id, req.query.folderId)) });
  });

  app.put('/api/drive/prefs', W, (req, res) => {
    const b = req.body || {};
    const key = prefFolder(db, req.user.id, b.folderId);
    const s = settingsOf(req);
    const patch = {};
    for (const k of ['sortScope', 'viewScope']) {
      if (b[k] === undefined) continue;
      if (b[k] !== 'folder' && b[k] !== 'global') fail(400, 'invalid_input', `${k} 값이 올바르지 않습니다`);
      patch[k] = b[k];
    }
    const merged = { ...s, ...patch };
    const cur = readPrefs(merged, key);
    if (b.sort !== undefined || b.foldersFirst !== undefined) {
      if (b.sort !== undefined && !SORTS[b.sort]) fail(400, 'invalid_input', '정렬 방식이 올바르지 않습니다');
      if (b.foldersFirst !== undefined && typeof b.foldersFirst !== 'boolean') fail(400, 'invalid_input', 'foldersFirst 는 true/false 여야 합니다');
      patch.sortPrefs = { ...s.sortPrefs, [prefKey(cur.sortScope, key)]: { sort: b.sort ?? cur.sort, foldersFirst: b.foldersFirst ?? cur.foldersFirst } };
    }
    if (b.view !== undefined) {
      if (b.view !== 'grid' && b.view !== 'list') fail(400, 'invalid_input', '보기 방식이 올바르지 않습니다');
      patch.viewPrefs = { ...s.viewPrefs, [prefKey(cur.viewScope, key)]: b.view };
    }
    res.json({ prefs: readPrefs(saveSettings(db, req.user.id, patch), key) });
  });
}
