// 클라우드 다운로드 엔진(A-05). 프로세스 안 대기열: 브라우저·사용자 기기와 무관하게 서버에서 계속 진행한다.
// 흐름: queued → (즉시 완료 A-06 | 받기: URL·SNS·BT) → 결과를 사용자 드라이브에 노드로 연결 → done
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { lookup } from 'node:dns';
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import parseTorrent from 'parse-torrent'; // webtorrent 의 의존성으로 함께 설치되어 있다
import { now, json, DAY, isPrivateIp } from '../../core/util.js';
import { tx } from '../../core/db.js';
import { ingestStream, ingestFile, hasBlob } from '../../core/storage.js';
import { createFolder, createFileNode, getNode, usage, checkCapacity, validName } from '../../core/files.js';
import { LIMITS, limitsFor, capacityOf, BT_MAX_FILES } from '../../core/plans.js';
import { addUsage, checkTransfer } from '../../core/quota.js';
import { notify } from '../../core/notify.js';
import { getSettings } from '../../core/auth.js';

export const MAX_RUNNING = Number(process.env.MIMIC_OFFLINE_MAX_RUNNING || 10); // 서버 전체 동시 작업 상한
// Q-6(미결정): "우리 클라우드 안에만" 원칙. 받는 동안 업로드를 이 속도로 제한하고(0 = 제한 없음), 완료 즉시 토렌트를 지워 시딩하지 않는다
const BT_UPLOAD_KBPS = Number(process.env.MIMIC_BT_UPLOAD_KBPS ?? 64);
// 이 시간 동안 받은 바이트가 없으면 실패(느린 링크·피어 없는 토렌트가 자리를 계속 차지하지 않게). cfg.offlineStallMs 로 덮어쓴다
const STALL_MS = Number(process.env.MIMIC_OFFLINE_STALL_MS || 10 * 60_000);
// 대기열을 볼 때 사용자마다 앞쪽 이만큼만 본다. 한 사용자가 대기 작업을 아무리 쌓아도 다른 사용자 작업이 밀리지 않는다
const PER_USER_SCAN = 2 * Math.max(...Object.values(LIMITS).map((l) => l.concurrentTasks || 1));
export const MAX_TORRENT_BYTES = 4 * 1024 * 1024;

// A-05: 탈퇴 신청·정지·잠금 계정은 쓸 수 없다(requireUser 와 같은 기준). 대기 작업은 시작하지 않고(복구되면 이어서), 받던 작업은 저장하지 않는다
export const unavailable = (u) =>
  !u || ['pending_delete', 'deleted', 'locked'].includes(u.status) || (u.status === 'suspended' && (!u.status_until || u.status_until > now()));

const err = (code) => Object.assign(new Error(code), { code });
const blockedErr = (blockId) => Object.assign(err('blocked'), { blockId });
// 중단 사유: 멈춤 감시(stalled)인지 사용자 취소인지
const abortErr = (signal) => (signal.reason?.code === 'stalled' ? signal.reason : err('canceled'));
const state = (ctx) => (ctx.offline ??= { running: new Map(), client: null, closed: false, kickPending: false });

function update(db, id, patch) {
  const keys = Object.keys(patch);
  db.prepare(`UPDATE offline_tasks SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...keys.map((k) => patch[k]), now(), id);
}

// 파일 이름으로 쓸 수 없는 문자를 바꾼다
export function safeName(s, fallback = 'download') {
  const n = String(s ?? '')
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 200);
  return validName(n) ? n : fallback;
}

// ---------- 대기열 ----------
// 서버가 다시 켜지면 하던 작업을 처음부터 다시 받는다
export function requeueStale(db) {
  db.prepare("UPDATE offline_tasks SET status='queued', speed=0 WHERE status='running'").run();
}

export function kick(ctx) {
  const st = state(ctx);
  if (st.closed || st.kickPending) return;
  st.kickPending = true;
  setImmediate(() => {
    st.kickPending = false;
    tick(ctx);
  });
}

// job(2초 간격)과 작업 생성·종료 때 불린다. 사용자별 동시 작업 수(무료 1·프리미엄 5)와 서버 전체 상한을 지킨다
export function tick(ctx) {
  const st = state(ctx);
  if (st.closed) return;
  const { db } = ctx;
  const queued = db
    .prepare(
      `SELECT * FROM (SELECT *, rowid AS rid, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, rowid) AS rn FROM offline_tasks WHERE status='queued')
       WHERE rn <= ? ORDER BY created_at, rid`,
    )
    .all(PER_USER_SCAN);
  if (!queued.length) return;
  const running = db.prepare("SELECT user_id, cache_key FROM offline_tasks WHERE status='running'").all();
  const keys = new Set(running.map((r) => r.cache_key));
  const perUser = new Map();
  for (const r of running) perUser.set(r.user_id, (perUser.get(r.user_id) || 0) + 1);
  let total = running.length;
  for (const task of queued) {
    if (total >= MAX_RUNNING) break;
    if (keys.has(task.cache_key)) continue; // 같은 링크를 이미 받는 중이면 기다렸다가 즉시 완료로 처리
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(task.user_id);
    if (unavailable(user) || (perUser.get(user.id) || 0) >= limitsFor(user).concurrentTasks) continue;
    update(db, task.id, { status: 'running' });
    perUser.set(user.id, (perUser.get(user.id) || 0) + 1);
    keys.add(task.cache_key);
    total++;
    start(ctx, task, user);
  }
}

function start(ctx, task, user) {
  const st = state(ctx);
  const ac = new AbortController();
  const p = run(ctx, task, user, ac.signal)
    .catch((e) => {
      if (ac.signal.aborted || st.closed) return; // 사용자가 지웠거나 서버 종료
      const code = /^[a-z_]+$/.test(e.code || '') ? e.code : 'download_failed';
      if (code === 'download_failed') console.warn(`[offline] ${task.id} 실패: ${e.message}`);
      // 차단(A-08)은 block_id 를 남겨 이의제기할 수 있게 한다
      update(ctx.db, task.id, { status: code === 'blocked' ? 'blocked' : 'error', error: code, block_id: e.blockId ?? null, speed: 0, finished_at: now() });
    })
    .finally(() => {
      st.running.delete(task.id);
      kick(ctx);
    });
  st.running.set(task.id, { ac, p });
}

export function cancel(ctx, taskId) {
  state(ctx).running.get(taskId)?.ac.abort();
}

export async function closeEngine(ctx) {
  const st = state(ctx);
  st.closed = true;
  for (const r of st.running.values()) r.ac.abort();
  await Promise.allSettled([...st.running.values()].map((r) => r.p));
  if (st.client) {
    const c = await st.client;
    await new Promise((r) => c.destroy(() => r()));
    st.client = null;
  }
}

// ---------- 차단 목록(A-08) ----------
// 즉시 완료 키(A-06)에 쓰는 주소 모양: '#조각'과 빈 '?' 를 뗀다(서버가 받는 요청은 같다)
export function urlKey(s) {
  const u = new URL(s);
  u.hash = '';
  if (!u.search) u.search = '';
  return u.href;
}

// 차단 비교용 주소 모양(A-08): 웹 서버가 같은 요청으로 받아들이는 표기 차이를 없앤다. '#조각'·빈 '?' 를 떼고,
// 인코딩할 필요 없는 문자의 %XX(%2D → -, %6F → o)를 풀고, 겹친 '/' 를 하나로, 전체를 소문자로(%ed = %ED, 대소문자를 안 가리는 서버) 맞춘다
const unreserved = (m, h) => {
  const c = String.fromCharCode(parseInt(h, 16));
  return /[\w.~-]/.test(c) ? c : m;
};
const pct = (s) => s.replace(/%([0-9a-f]{2})/gi, unreserved).toLowerCase();
function blockForm(u) {
  const base = u.origin + pct(u.pathname.replace(/\/{2,}/g, '/'));
  return { base, full: base + pct(u.search) };
}

// 관리자가 등록한 URL·도메인·infohash 와 맞으면 차단 항목을 돌려준다. 작업을 만들 때, 시작할 때(다시 시도 포함), 리다이렉트마다 확인한다
export function findBlock(db, infoHash, source) {
  const q = db.prepare('SELECT * FROM blocklist WHERE kind=? AND lower(value)=lower(?)');
  if (infoHash) {
    const b = q.get('infohash', infoHash);
    if (b) return b;
  }
  if (!source) return null;
  let u = null;
  try {
    if (/^https?:/i.test(source)) u = new URL(source);
  } catch {
    /* 주소가 아님 */
  }
  if (!u) return null;
  // 표기만 다른 같은 주소로 우회하지 못하게 양쪽을 blockForm 으로 맞춰 비교하고, 쿼리를 뺀 주소(origin+경로)로도 찾는다
  const k = blockForm(u);
  const byUrl = db
    .prepare("SELECT * FROM blocklist WHERE kind='url' AND instr(lower(value), ?) > 0")
    .all(u.hostname)
    .find((b) => {
      try {
        const f = blockForm(new URL(b.value)).full;
        return f === k.full || f === k.base;
      } catch {
        return false;
      }
    });
  if (byUrl) return byUrl;
  const host = u.hostname.toLowerCase();
  const parts = host.split('.').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const b = q.get('domain', parts.slice(i).join('.'));
    if (b) return b;
  }
  return null;
}
const taskBlock = (db, task) => findBlock(db, task.cache_key.startsWith('bt:') ? task.cache_key.slice(3) : null, task.source);

async function run(ctx, task, user, signal) {
  const block = taskBlock(ctx.db, task);
  if (block) throw blockedErr(block.id);
  // F-01: 만든 뒤 월 쿼터·연결 앱 상한을 다 썼으면 시작하지 않는다(이미 받는 중인 작업은 끝까지 진행, 8-7)
  const q = checkTransfer(ctx.db, user, 'cloud', 0, task.quota_source);
  if (!q.ok) throw err(q.reason);
  if (task.kind === 'torrent' && !task.torrent) task = await adoptTorrent(ctx, task, signal);
  if (await instant(ctx, task, user, signal)) return;
  const dir = path.join(ctx.cfg.dataDir, 'offline', task.id);
  const fetcher = { url: fetchUrl, social: fetchSocial, magnet: fetchTorrent, torrent: fetchTorrent }[task.kind];
  // 멈춤 감시: 받은 바이트가 있을 때마다 bump 로 타이머를 다시 맞춘다
  const stall = new AbortController();
  const timer = setTimeout(() => stall.abort(err('stalled')), ctx.cfg.offlineStallMs ?? STALL_MS);
  const bump = () => stall.signal.aborted || timer.refresh();
  try {
    const result = await fetcher(ctx, task, user, AbortSignal.any([signal, stall.signal]), dir, bump);
    if (signal.aborted) throw err('canceled');
    finish(ctx, task.id, result);
  } catch (e) {
    throw stall.signal.aborted && !/^[a-z_]+$/.test(e.code || '') ? err('stalled') : e;
  } finally {
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// 1초에 한 번만 DB 에 진행률을 쓴다. 부를 때마다 멈춤 감시 타이머를 다시 맞춘다
function reporter(ctx, id, bump) {
  let last = 0;
  let lastBytes = 0;
  return ({ downloaded, size, speed, progress }) => {
    bump();
    const t = now();
    if (t - last < 1000 || state(ctx).closed) return;
    if (speed == null) speed = last ? Math.round(((downloaded - lastBytes) * 1000) / (t - last)) : 0;
    last = t;
    lastBytes = downloaded;
    update(ctx.db, id, {
      downloaded,
      size: size || 0,
      speed: Math.max(0, speed),
      progress: progress ?? (size ? Math.min(99, Math.floor((downloaded * 100) / size)) : 0),
    });
  };
}

const roomOf = (db, user) => capacityOf(user) - usage(db, user.id);

// ---------- 즉시 완료(A-06) ----------
// 같은 infohash·URL 을 전에 받은 기록이 있고 본문이 모두 남아 있으면 받지 않고 노드만 만든다
async function instant(ctx, task, user, signal) {
  const row = ctx.db.prepare('SELECT * FROM offline_cache WHERE key=?').get(task.cache_key);
  if (!row) return false;
  const all = json(row.files, []);
  const save = task.kind === 'magnet' || task.kind === 'torrent' ? pickFiles(all, smartFilterOn(user)) : all;
  if (!save.length || !save.every((f) => f.hash && hasBlob(ctx.db, ctx.cfg, f.hash))) return false;
  if (task.cache_key.startsWith('url:') && !(await unchanged(ctx, task, row, signal))) return false; // infohash(bt:)는 내용 자체라 확인하지 않는다
  finish(ctx, task.id, { name: row.name, all, save, cached: true });
  return true;
}

// 원본 응답의 검증값(A-06)
const validators = (res) => ({ etag: res.headers.etag ?? null, last_modified: res.headers['last-modified'] ?? null, length: Number(res.headers['content-length']) || null });

// 주소로 찾은 기록은 원본이 그대로일 때만 쓴다(A-06). ETag·Last-Modified 가 있으면 조건부 요청으로 확인하고, 없으면(SNS 포함) 하루만 믿는다
async function unchanged(ctx, task, row, signal) {
  if (task.kind !== 'url' || (!row.etag && !row.last_modified)) return now() - row.created_at < DAY;
  const headers = row.etag ? { 'if-none-match': row.etag } : { 'if-modified-since': row.last_modified };
  const res = await safeFetch(ctx, task.source, AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers);
  res.destroy();
  if (res.statusCode === 304) return true;
  // 조건부 요청을 무시하고 200 을 주는 서버: 검증값이 그대로면 같은 파일
  const v = validators(res);
  return res.ok && (row.etag ? v.etag === row.etag : v.last_modified === row.last_modified) && v.length === row.length;
}

// ---------- 완료: 사용자 드라이브에 연결 ----------
function finish(ctx, taskId, { name, all, save, cached, cache }) {
  const { db } = ctx;
  const task = db.prepare('SELECT * FROM offline_tasks WHERE id=?').get(taskId);
  if (!task) return; // 받는 사이 작업이 지워짐(본문은 gcBlobs 가 정리)
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(task.user_id);
  // A-05: 받는 사이 탈퇴 신청·정지된 계정에는 저장하지 않는다(복구 뒤 다시 시도할 수 있다)
  if (unavailable(user)) {
    update(db, taskId, { status: 'error', error: 'account_unavailable', speed: 0, finished_at: now() });
    return;
  }
  // A-08: 관리자가 차단한 파일 해시는 저장하지 않는다
  const blockQ = db.prepare("SELECT id FROM blocklist WHERE kind='blob' AND value=?");
  let blockedBy = null;
  const ok = save.filter((f) => {
    const b = blockQ.get(f.hash);
    if (b) blockedBy ??= b.id;
    return !b;
  });
  if (!ok.length) {
    update(db, taskId, { status: blockedBy ? 'blocked' : 'error', error: blockedBy ? 'blocked_file' : 'empty', block_id: blockedBy, speed: 0, finished_at: now() });
    return;
  }
  const bytes = ok.reduce((s, f) => s + f.size, 0);
  // 스마트 필터로 뺀 파일 수(A-09)·차단돼 뺀 파일 수(A-08). 일부만 차단되면 block_id 를 남겨 이의제기할 수 있게 한다
  const skipped = { skipped_ads: Math.max(0, all.filter((f) => !isPadding(f)).length - save.length), skipped_blocked: save.length - ok.length, block_id: blockedBy };
  const parent = task.parent_id && getNode(db, user.id, task.parent_id);
  const parentId = parent && parent.kind === 'folder' && !parent.trashed_at ? parent.id : null; // 저장 폴더가 지워졌으면 루트에
  tx(db, () => {
    checkCapacity(db, user, bytes);
    const { rootId, ids, rootIsFolder } = saveTree(db, user.id, parentId, ok);
    addUsage(db, user.id, 'cloud', bytes, task.quota_source);
    // 즉시 완료(cached)는 기록을 그대로 둔다: 검증값이 없는 기록의 유효기간(하루)이 쓸 때마다 늘어나지 않게
    if (!cached) {
      db.prepare(
        `INSERT INTO offline_cache (key, name, files, etag, last_modified, length, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
         name=excluded.name, files=excluded.files, etag=excluded.etag, last_modified=excluded.last_modified, length=excluded.length, created_at=excluded.created_at`,
      ).run(
        task.cache_key,
        name,
        JSON.stringify(all.map(({ path: p, hash, size, mime }) => ({ path: p, hash: hash ?? null, size, mime: mime ?? null }))),
        cache?.etag ?? null,
        cache?.last_modified ?? null,
        cache?.length ?? null,
        now(),
      );
    }
    const t = now();
    update(db, taskId, { status: 'done', name: safeName(name), progress: 100, size: bytes, downloaded: bytes, speed: 0, error: null, result_root_id: rootId, file_ids: JSON.stringify(ids), finished_at: t, ...skipped });
    const link = rootIsFolder ? `/drive/folder/${rootId}` : parentId ? `/drive/folder/${parentId}` : '/drive/all';
    notify(db, user.id, { kind: 'offline', title: '클라우드 다운로드 완료', titleEn: 'Cloud download complete', body: safeName(name), link }); // 본문은 파일 이름이라 영어 본문을 따로 두지 않는다
  });
}

// 하위 경로를 그대로 폴더로 만든다. 여러 파일 토렌트는 "토렌트 이름/…" 경로라 토렌트 이름 폴더가 생긴다
function saveTree(db, userId, parentId, files) {
  const folders = new Map();
  let rootId = null;
  let rootIsFolder = false;
  const ids = [];
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean).map((p) => safeName(p, '_'));
    const name = parts.pop() || 'download';
    let pid = parentId;
    let key = '';
    for (const dir of parts) {
      key += '/' + dir;
      if (!folders.has(key)) {
        const node = createFolder(db, userId, pid, dir, { origin: 'cloud' });
        folders.set(key, node.id);
        if (!rootId) (rootId = node.id), (rootIsFolder = true);
      }
      pid = folders.get(key);
    }
    const node = createFileNode(db, userId, pid, { name, size: f.size, mime: f.mime || null, blobHash: f.hash, origin: 'cloud' });
    ids.push(node.id);
    rootId ??= node.id;
  }
  return { rootId, ids, rootIsFolder };
}

// ---------- BT 스마트 필터(A-09) ----------
const smartFilterOn = (user) => getSettings(user).btSmartFilter !== false;
const TEXTISH = /\.(txt|html?|mht(ml)?|nfo|rtf)$/i;
const IMAGE = /\.(jpe?g|png|gif|bmp|webp)$/i;
const VIDEO = /\.(mp4|mkv|avi|wmv|mov|flv|ts|m4v|webm|rmvb)$/i;
const SHORTCUT = /\.(url|lnk|website|webloc|desktop)$/i;
const DOMAINISH = /(www\.|https?[:_]|\.(com|net|org|info|xyz|top|cc|tv|me|io|co|club|vip|site|online|link|biz|app)(\b|_|$))/i;
const PROMO = /(광고|홍보|바로\s*가기|최신\s*주소|\b(ads?|advert\w*|promo\w*|sponsor\w*|visit)\b)/i;
const DOC = /^(readme|license|licence|copying|changelog|install)/i; // 설명서는 작아도 내용이다
const KB = 1024;
const MB = 1024 * KB;
const sizeOf = (f) => Number(f.length ?? f.size ?? 0);

// BEP 47 패딩 파일: 실제 내용이 아니므로 설정과 관계없이 저장하지 않는다
export const isPadding = (f) => /(^|\/)\.pad\//.test(normPath(f)) || /^_+padding_file/i.test(baseName(f));
const normPath = (f) => String(f.path || f.name || '').replace(/\\/g, '/');
const baseName = (f) => normPath(f).split('/').pop();
// A-02: 7,000개 상한은 실제 파일만 센다(v1/v2 하이브리드 토렌트는 파일마다 패딩 항목이 붙는다)
export const tooManyFiles = (files) => files.filter((f) => !isPadding(f)).length > BT_MAX_FILES;

// ponytail: 이름·크기 휴리스틱. 오탐이 문제 되면 운영자가 관리하는 광고 파일 해시 목록을 함께 쓸 것
export function isLikelyAd(f) {
  const name = baseName(f);
  const size = sizeOf(f);
  if (isPadding(f) || SHORTCUT.test(name)) return true;
  if (TEXTISH.test(name) && size <= 64 * KB && PROMO.test(name)) return true; // 홍보 낱말이 붙은 작은 문서
  if (DOMAINISH.test(name)) {
    if ((TEXTISH.test(name) || IMAGE.test(name)) && size <= 2 * MB) return true; // 사이트 주소가 박힌 작은 문서·이미지
    if (VIDEO.test(name) && size <= 30 * MB) return true; // 사이트 주소가 박힌 짧은 광고 영상
  }
  return false;
}

// 저장할 파일 고르기. 필터 결과가 비면 전부 저장한다(내용 전체가 작은 문서인 토렌트)
// 이름에 신호가 없는 작은 문서는 본 내용(문서가 아닌 가장 큰 파일)보다 100배 넘게 작은 부속일 때만 뺀다
export function pickFiles(files, filter = true) {
  const real = files.filter((f) => !isPadding(f));
  if (!filter) return real;
  const main = Math.max(0, ...real.filter((f) => !TEXTISH.test(baseName(f))).map(sizeOf));
  const tiny = (f) => TEXTISH.test(baseName(f)) && !DOC.test(baseName(f)) && sizeOf(f) <= 64 * KB && main >= 100 * Math.max(1, sizeOf(f));
  const kept = real.filter((f) => !isLikelyAd(f) && !tiny(f));
  return kept.length ? kept : real;
}

// ---------- URL(A-03) ----------
// 운영 모드에서는 내부망·루프백 주소로의 요청을 막는다(SSRF). 개발·테스트는 로컬 서버를 쓰므로 허용
export { isPrivateIp }; // 판정은 core/util.js(웹 푸시와 같이 씀)
const allowPrivate = (cfg) => cfg.offlineAllowPrivate ?? cfg.dev;
const bareHost = (u) => u.hostname.replace(/^\[|\]$/g, '');

// 소켓이 연결할 바로 그 조회 결과를 확인한다. 검사와 연결이 같은 주소를 쓰므로 DNS rebinding 으로 우회할 수 없다
function publicLookup(host, opts, cb) {
  lookup(host, opts, (e, address, family) => {
    if (e) return cb(e);
    const list = Array.isArray(address) ? address : [{ address }];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) return cb(err('blocked_address'));
    cb(null, address, family);
  });
}

// 주소 모양만 본다. 이름은 연결할 때 publicLookup 이 확인한다(IP 주소는 조회 없이 바로 연결되므로 여기서 막는다)
export async function assertPublicUrl(cfg, url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw err('invalid_link');
  if (!allowPrivate(cfg) && net.isIP(bareHost(u)) && isPrivateIp(bareHost(u))) throw err('blocked_address');
}

// tracker 는 webtorrent 가 직접 연결해 조회를 가로챌 수 없으므로, 한 번 확인한 공인 IP 로 주소를 고정한다.
// 운영 모드에서는 UDP tracker 만 쓴다(피어는 UDP tracker·DHT 로 찾음): http(s) tracker 는 클라이언트가 3xx 리다이렉트를 스스로 따라가
// 첫 주소를 고정해도 내부망으로 넘겨질 수 있고, https·wss 는 IP 로 고정하면 인증서 확인이 깨진다. UDP 는 리다이렉트가 없다.
// ponytail: http tracker 가 꼭 필요하면 연결마다 publicLookup 으로 확인하는 agent 를 tracker 클라이언트(proxyOpts)에 넘길 것
async function pinTracker(href) {
  const u = new URL(href);
  if (u.protocol !== 'udp:') return null;
  const host = bareHost(u);
  if (net.isIP(host)) return isPrivateIp(host) ? null : href;
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return null;
  u.hostname = net.isIPv6(addrs[0].address) ? `[${addrs[0].address}]` : addrs[0].address;
  return u.href;
}

// 운영 모드: 마그넷·토렌트의 tracker(tr)·웹 시드(ws·as)·xs·x.pe 로 내부망에 요청하지 않게 한다.
// UDP 가 아니거나 내부망인 tracker 는 빼고 나머지는 확인한 IP 로 고정하고, 웹 시드·xs·직접 지정 피어는 통째로 버린다(피어는 btClient 의 blocked 가 거른다)
export async function stripPrivate(cfg, t) {
  if (allowPrivate(cfg)) return t;
  delete t.xs;
  delete t.peerAddresses;
  t.urlList = [];
  const pinned = await Promise.all((t.announce || []).map((u) => pinTracker(u).catch(() => null)));
  t.announce = [...new Set(pinned.filter(Boolean))];
  return t;
}

// GET 한 번. 운영 모드에서는 연결할 때 내부망 주소를 막는다. agent: false — 다른 설정으로 연 연결을 다시 쓰지 않는다
function get(url, signal, cfg, headers) {
  return new Promise((resolve, reject) => {
    const opts = { signal, agent: false, lookup: allowPrivate(cfg) ? undefined : publicLookup, headers: { 'user-agent': 'MimicCloud/0.1', ...headers } };
    (url.startsWith('https:') ? https : http).get(url, opts, resolve).on('error', reject);
  });
}

// 리다이렉트를 직접 따라가며 매 단계 차단 목록(A-08)과 내부망 주소를 확인한다.
// 응답(IncomingMessage)에 ok 와 최종 주소 url 을 붙여 돌려준다
export async function safeFetch(ctx, url, signal, headers) {
  for (let hop = 0; hop < 6; hop++) {
    const block = findBlock(ctx.db, null, url);
    if (block) throw blockedErr(block.id);
    await assertPublicUrl(ctx.cfg, url);
    const res = await get(url, signal, ctx.cfg, headers);
    const loc = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
    if (!loc) return Object.assign(res, { url, ok: res.statusCode >= 200 && res.statusCode < 300 });
    res.destroy();
    url = new URL(loc, url).href;
  }
  throw err('too_many_redirects');
}

export function nameFromResponse(res, url) {
  const cd = res.headers['content-disposition'] || '';
  let m = /filename\*\s*=\s*(?:utf-8)?''([^;]+)/i.exec(cd);
  try {
    if (m) return safeName(decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')));
  } catch {
    /* 아래로 */
  }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (m) return safeName(m[1]);
  const u = new URL(url);
  const seg = u.pathname.split('/').filter(Boolean).pop();
  try {
    if (seg) return safeName(decodeURIComponent(seg), u.hostname);
  } catch {
    /* 아래로 */
  }
  return safeName(u.hostname);
}

// 성공 응답(.torrent) 본문을 max 바이트까지만 읽는다. 실패 응답이면 null, 넘으면 torrent_too_large(A-02)
export async function readLimited(res, max) {
  if (!res.ok || Number(res.headers['content-length']) > max) {
    res.destroy();
    if (res.ok) throw err('torrent_too_large');
    return null;
  }
  const chunks = [];
  let n = 0;
  for await (const c of res) {
    n += c.length;
    if (n > max) throw err('torrent_too_large'); // 반복을 빠져나가면 응답이 닫힌다
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function fetchUrl(ctx, task, user, signal, _dir, bump) {
  const { db, cfg } = ctx;
  const res = await safeFetch(ctx, task.source, signal);
  const size = Number(res.headers['content-length']) || 0;
  const room = roomOf(db, user);
  const fail = !res.ok ? 'http_error' : room <= 0 || size > room ? 'storage_full' : null;
  if (fail) {
    res.destroy();
    throw err(fail);
  }
  const name = nameFromResponse(res, res.url); // 리다이렉트를 거쳤으면 최종 주소의 이름(/download?id=… → movie.mp4)
  update(db, task.id, { name, size });
  const report = reporter(ctx, task.id, bump);
  let downloaded = 0;
  async function* counted() {
    for await (const chunk of res) {
      downloaded += chunk.length;
      report({ downloaded, size });
      yield chunk;
    }
  }
  const type = (res.headers['content-type'] || '').split(';')[0].trim();
  const mime = (type !== 'application/octet-stream' && type) || MEDIA_MIME[name.split('.').pop().toLowerCase()] || null;
  const blob = await ingestStream(db, cfg, Readable.from(counted(), { objectMode: false }), mime, { maxBytes: room });
  const files = [{ path: name, hash: blob.hash, size: blob.size, mime }];
  return { name, all: files, save: files, cache: validators(res) };
}

// ---------- 마그넷·토렌트(A-01·A-02) ----------
function btClient(ctx) {
  const st = state(ctx);
  st.client ??= import('webtorrent').then(({ default: WebTorrent }) => {
    // Q-6: 업로드 속도 제한 기본 64KB/s(MIMIC_BT_UPLOAD_KBPS). cfg.bt 로 dht·lsd 등 옵션을 덮어쓸 수 있다(테스트는 끔)
    const c = new WebTorrent({ utp: false, uploadLimit: BT_UPLOAD_KBPS > 0 ? BT_UPLOAD_KBPS * 1024 : -1, ...ctx.cfg.bt });
    // A-01: 운영 모드에서는 tracker·DHT·PEX 가 알려 준 내부망·이름 주소 피어에 연결하지 않는다.
    // webtorrent 의 blocklist 옵션(ip-set)은 IPv4 만 보므로 피어를 거를 때 쓰는 blocked.contains 를 직접 단다
    // ponytail: DHT 질의(UDP)는 노드 주소를 거르지 않는다. 막아야 하면 cfg.bt 로 dht 를 끄거나 k-rpc 소켓을 감쌀 것
    if (!allowPrivate(ctx.cfg)) c.blocked = { contains: (host) => !net.isIP(host) || isPrivateIp(host) };
    c.on('error', (e) => console.error('[offline] bt client', e.message));
    return c;
  });
  return st.client;
}

// 만들 때 차단돼 미리 받지 못한 .torrent 주소(이의제기로 풀린 경우): 지금 받아 작업에 붙인다.
// 안의 infohash 로 차단 목록을 다시 보고(A-08), 키를 'bt:<infohash>' 로 바꿔 즉시 완료·캐시를 마그넷과 함께 쓴다(A-06)
async function adoptTorrent(ctx, task, signal) {
  const res = await safeFetch(ctx, task.source, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
  const buf = await readLimited(res, MAX_TORRENT_BYTES);
  if (!buf) throw err('http_error');
  const p = await parseTorrent(buf).catch(() => null);
  if (!p?.infoHash || !Array.isArray(p.files)) throw err('invalid_link');
  const block = findBlock(ctx.db, p.infoHash, null);
  if (block) throw blockedErr(block.id);
  if (tooManyFiles(p.files)) throw err('too_many_files');
  const patch = { torrent: buf, cache_key: 'bt:' + p.infoHash, name: safeName(p.name, task.name) };
  update(ctx.db, task.id, patch);
  return { ...task, ...patch };
}

async function fetchTorrent(ctx, task, user, signal, dir, bump) {
  const { db, cfg } = ctx;
  const parsed = await stripPrivate(cfg, await parseTorrent(task.kind === 'magnet' ? task.source : Buffer.from(task.torrent)));
  const client = await btClient(ctx);
  let gotMeta = false;
  // 멈춤 감시에 걸렸을 때 토렌트 정보조차 못 받았으면 피어 없음
  const why = () => (signal.reason?.code === 'stalled' && !gotMeta ? err('no_peers') : abortErr(signal));
  if (signal.aborted) throw why();
  const room = roomOf(db, user);
  const report = reporter(ctx, task.id, bump);
  const torrent = client.add(parsed, { path: dir });
  let files;
  let stop;
  const onAbort = () => stop?.(why());
  try {
    await new Promise((resolve, reject) => {
      stop = reject;
      if (signal.aborted) return reject(why());
      signal.addEventListener('abort', onAbort, { once: true });
      torrent.on('error', (e) => reject(e.code ? e : err('download_failed')));
      torrent.once('metadata', () => {
        gotMeta = true;
        bump();
        if (tooManyFiles(torrent.files)) return reject(err('too_many_files'));
        if (torrent.length > room) return reject(err('storage_full'));
        update(db, task.id, { name: safeName(torrent.name), size: torrent.length });
      });
      torrent.on('download', () => report({ downloaded: torrent.downloaded, size: torrent.length, speed: Math.round(torrent.downloadSpeed) }));
      torrent.once('done', resolve);
    });
    files = torrent.files.map((f) => ({ path: f.path.split(/[\\/]/).join('/'), size: f.length, mime: f.type || null, disk: path.join(dir, f.path) }));
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Q-6: 완료(또는 취소) 즉시 토렌트를 지워 시딩하지 않는다. 파일 핸들을 닫아야 저장소로 옮길 수 있다
    await new Promise((r) => torrent.destroy({ destroyStore: false }, () => r()));
  }
  const save = pickFiles(files, smartFilterOn(user));
  for (const f of save) Object.assign(f, await ingestFile(db, cfg, f.disk, f.mime)); // hash·size 채움
  return { name: torrent.name, all: files, save };
}

// ---------- SNS(A-04): yt-dlp ----------
// PATH 에서 yt-dlp 실행 파일을 찾는다. 없으면 null
export function findYtDlp(env = process.env) {
  const file = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, file))) return path.join(dir, file);
  }
  return null;
}
// cfg.ytDlp: 실행 파일 경로, 또는 [명령, ...앞 인자](테스트의 가짜 yt-dlp), null 이면 없음.
// 운영(launchd 등 PATH 가 짧은 환경)은 YTDLP_PATH 로 경로를 줄 수 있다(media 의 FFMPEG_PATH 와 같은 방식)
export const ytDlpPath = (cfg, env = process.env) => ('ytDlp' in cfg ? cfg.ytDlp : env.YTDLP_PATH || findYtDlp(env));
// 게시물 하나에 미디어가 여러 개(X 등)인 것은 받되, 재생목록·채널 주소로 수백 개를 받지 않게 하는 상한
const MAX_SOCIAL_ITEMS = 4;

const MEDIA_MIME = { __proto__: null, mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', m4a: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

// "[download]  45.3% of ~ 12.34MiB at 1.23MiB/s ETA 00:05" → { pct, size, speed }(모르는 값은 null)
const bytesOf = (s) => {
  const m = /([\d.]+)\s*([KMGT]?)i?B/.exec(s || '');
  return m ? Math.round(Number(m[1]) * 1024 ** ' KMGT'.indexOf(m[2] || ' ')) : null;
};
export function parseYtDlpProgress(line) {
  const m = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\s*[KMGT]?i?B))?(?:.*?\sat\s+([\d.]+\s*[KMGT]?i?B)\/s)?/.exec(line);
  return m && { pct: Number(m[1]), size: bytesOf(m[2]), speed: bytesOf(m[3]) };
}

async function fetchSocial(ctx, task, user, signal, dir, bump) {
  const bin = ytDlpPath(ctx.cfg);
  if (!bin) throw err('social_unavailable'); // 서버에 SNS 저장 도구(yt-dlp)가 설치되어 있지 않음
  fs.mkdirSync(dir, { recursive: true });
  const room = roomOf(ctx.db, user);
  if (room <= 0) throw err('storage_full');
  const report = reporter(ctx, task.id, bump);
  const dirBytes = () => {
    try {
      return fs.readdirSync(dir).reduce((s, n) => s + fs.statSync(path.join(dir, n)).size, 0);
    } catch {
      return 0; // yt-dlp 가 파일 이름을 바꾸는 중
    }
  };
  let full = false; // 받은 합계가 남은 용량을 넘어 멈춤
  let skippedBig = false; // 남은 용량보다 큰 미디어라 yt-dlp 가 건너뜀(종료 코드는 0)
  await new Promise((resolve, reject) => {
    const [cmd, ...pre] = [].concat(bin);
    // 서버 운영자의 yt-dlp 설정 파일을 무시하고, 아무 주소나 따라가는 generic 추출기는 쓰지 않는다(SNS 사이트 전용 추출기만).
    // --no-playlist 는 영상+재생목록 주소에만 듣는다: 순수 재생목록·채널 주소도 앞쪽 MAX_SOCIAL_ITEMS 개만(--max-downloads 에 닿으면 종료 코드 101)
    // ponytail: yt-dlp 의 연결은 내부망 차단(publicLookup)을 거치지 않는다. 운영에서 더 막으려면 --proxy 로 나가는 길을 제한할 것
    const n = String(MAX_SOCIAL_ITEMS);
    const args = [...pre, '--ignore-config', '--use-extractors', 'default,-generic', '--no-playlist', '--playlist-items', `1:${n}`, '--max-downloads', n, '--newline', '--no-part', '--max-filesize', String(room), '-o', path.join(dir, '%(title).120B [%(id)s].%(ext)s'), '--', task.source];
    const p = spawn(cmd, args, { windowsHide: true, signal });
    // --max-filesize 는 파일 하나에만 걸린다. 받는 동안 합계가 남은 용량을 넘으면 멈춰 서버 디스크를 채우지 않게 한다
    const watch = setInterval(() => {
      if (dirBytes() <= room) return;
      full = true;
      p.kill();
    }, 1000);
    p.stdout.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (/larger than max-filesize/i.test(line)) skippedBig = true;
        const m = parseYtDlpProgress(line);
        if (m) report({ downloaded: m.size ? Math.round((m.size * m.pct) / 100) : 0, size: m.size, speed: m.speed, progress: Math.min(99, Math.floor(m.pct)) });
      }
    });
    p.stderr.resume();
    const fail = () => reject(signal.aborted ? abortErr(signal) : err(full ? 'storage_full' : 'social_failed'));
    p.on('error', () => {
      clearInterval(watch);
      fail();
    });
    p.on('close', (code) => {
      clearInterval(watch);
      if (!full && (code === 0 || code === 101)) resolve();
      else fail();
    });
  });
  if (dirBytes() > room) throw err('storage_full'); // 감시 주기보다 빨리 끝난 경우
  const names = fs.readdirSync(dir).filter((n) => !/\.(part|ytdl|temp)$/i.test(n));
  if (!names.length) throw err(skippedBig ? 'storage_full' : 'social_failed');
  const files = [];
  for (const n of names) {
    const mime = MEDIA_MIME[n.split('.').pop().toLowerCase()] || null;
    const b = await ingestFile(ctx.db, ctx.cfg, path.join(dir, n), mime);
    files.push({ path: safeName(n), hash: b.hash, size: b.size, mime });
  }
  return { name: files[0].path, all: files, save: files };
}
