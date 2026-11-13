// 재생·미리보기·자막·외부 플레이어·시청 기록·온라인 압축 해제(C-01~C-07, B-08).
// 변환본·썸네일·자막 캐시: dataDir/media/<blob hash>/ (본문이 지워지면 media:gc-cache 가 정리)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { now, fail, json } from '../../core/util.js';
import { requireUser, requireScope, quotaSource, getSettings } from '../../core/auth.js';
import { blobPath, ingestStream, tmpPath } from '../../core/storage.js';
import { toApi, requireNode, listChildren, createFolder, createFileNode, checkCapacity, validName } from '../../core/files.js';
import { isPremium, speedFor, SLOW_BPS, GB } from '../../core/plans.js';
import { addUsage, checkTransfer } from '../../core/quota.js';
import { tx } from '../../core/db.js';
import { readPrefs, sortRows } from '../drive/index.js';
import * as ff from './ff.js';

export const MAX_TRANSCODES = 2; // 동시 변환 수. 나머지는 대기열
export const MAX_JOBS_PER_USER = 2; // 한 사용자가 동시에 걸어 둘 수 있는 변환(실행+대기)
export const MAX_ENCODE_SEC = 4 * 3600; // 이보다 긴 영상은 다시 인코딩하지 않는다(외부 플레이어 안내)
const STALE_MS = 60_000; // 이 시간 동안 아무도 /prepare·HLS 를 부르지 않은 변환(대기·실행 중)은 버린다
const EXTERNAL_URL_MS = 6 * 3600_000; // 외부 플레이어용 임시 URL 유효 시간
const HIGH_BITRATE = 20e6; // 지역 프리미엄은 이보다 높은 원본 대신 변환본만(8-2)
const TEXT_PREVIEW_MAX = 5 * 1024 ** 2; // 외부 자막 파일 최대 크기
// ponytail: adm-zip 은 압축 파일 전체를 메모리에 올린다(한 번에 하나만 풀어 상한을 묶음). 더 큰 압축이 필요하면 스트리밍 해제(yauzl 등)로 바꿀 것
export const UNZIP_LIMITS = { archive: 1 * GB, entry: 1 * GB, total: 2 * GB, entries: 10_000, ratio: 200 };

export const migrations = `
CREATE TABLE IF NOT EXISTS media_probe (
  hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_id)
);
CREATE INDEX IF NOT EXISTS media_history_recent ON media_history(user_id, updated_at);
`;

// ---------- 파일 종류 ----------
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t',
  flv: 'video/x-flv', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp', rmvb: 'video/vnd.rn-realvideo',
  m2ts: 'video/mp2t', mts: 'video/mp2t', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', wma: 'audio/x-ms-wma',
  mka: 'audio/x-matroska', oga: 'audio/ogg', aiff: 'audio/aiff', aif: 'audio/aiff', ape: 'audio/ape', ac3: 'audio/ac3', dts: 'audio/vnd.dts',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', heic: 'image/heic',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', srt: 'text/plain', vtt: 'text/vtt',
};
const TEXT_EXT = new Set(['txt', 'md', 'srt', 'vtt', 'ass', 'ssa', 'smi', 'log', 'csv', 'json', 'xml', 'nfo', 'ini', 'yml', 'yaml', 'cue', 'html', 'htm', 'js', 'css']);
const SUB_EXT = new Set(['srt', 'vtt']);
const extOf = (name) => (/\.([^./\\]+)$/.exec(name || '')?.[1] || '').toLowerCase();
const baseOf = (name) => name.replace(/\.[^.]+$/, '') || name;

// 브라우저가 그대로 보여 주는 이미지만 'image'. SVG(스크립트 가능)·HEIC 등은 'other'(정보·다운로드)
const IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);
// 대소문자·매개변수(; charset=…)를 걷어 낸 MIME. 확장자가 알려진 것이면 확장자가 우선
const mimeOf = (n) => (MIME[extOf(n.name)] || n.mime || '').split(';')[0].trim().toLowerCase();

export function kindOf(n) {
  if (TEXT_EXT.has(extOf(n.name))) return 'text';
  const m = mimeOf(n);
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (IMAGES.has(m)) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}
const playable = (k) => k === 'video' || k === 'audio';
// 원본을 그대로 보낼 때의 Content-Type. 사용자 파일이 미믹 화면에서 스크립트로 실행되지 않게 HTML·SVG 등은 글자·바이너리로 보낸다
function safeMime(n, kind) {
  if (kind === 'text') return 'text/plain; charset=utf-8';
  if (kind === 'other') return 'application/octet-stream';
  return mimeOf(n); // 허용 목록 이미지·PDF·영상·음악
}

// 자막·텍스트: UTF-8 이 아니면 한국어 윈도우 인코딩(CP949)으로 읽는다
export function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}
export function srtToVtt(text) {
  const s = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (s.startsWith('WEBVTT')) return s;
  return 'WEBVTT\n\n' + s.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// ---------- Range 전송(원본·변환본 공용) ----------
// ponytail: core sendBlob 과 같은 동작을 임의 경로에 대해 한다. core 에 경로용 함수가 생기면 그걸로 바꿀 것
// transfer(보낼 바이트 수) → { throttleBps, onBytes }: 이번 요청 길이로 쿼터를 보고 속도를 정한다
function sendRange(req, res, file, { name, mime, transfer }) {
  const total = fs.statSync(file).size;
  let start = 0;
  let end = total - 1;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && total > 0) {
    if (m[1] === '') start = Math.max(0, total - Number(m[2] || 0));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= total) return res.status(416).set('Content-Range', `bytes */${total}`).end();
  }
  const { throttleBps = 0, onBytes } = transfer?.(total === 0 ? 0 : end - start + 1) || {};
  res.status(m && total > 0 ? 206 : 200).set({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(total === 0 ? 0 : end - start + 1),
    'Content-Type': mime || 'application/octet-stream',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-transform',
  });
  // 주소창에서 바로 열려도 미믹 출처의 스크립트로 실행되지 않게 한다. PDF 는 sandbox 면 Chrome 내장 뷰어가 막혀서 뺀다(PDF 는 스크립트로 미믹 화면에 닿지 못함).
  // 영상·음악도 sandbox 면 Chromium(데스크톱 앱·브라우저 주소창)의 미디어 화면이 자기 영상을 못 불러온다. nosniff 미디어는 스크립트로 실행되지 않으니 media-src 만 연다
  if (/^(video|audio)\//.test(mime)) res.set('Content-Security-Policy', "default-src 'none'; media-src 'self'");
  else if (mime !== 'application/pdf') res.set('Content-Security-Policy', "sandbox; default-src 'none'");
  if (m && total > 0) res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  if (req.method === 'HEAD' || total === 0) return res.end();
  let sent = 0;
  res.on('close', () => onBytes?.(sent));
  const meter = new Transform({
    transform(chunk, _e, cb) {
      sent += chunk.length;
      if (!throttleBps) return cb(null, chunk);
      setTimeout(() => cb(null, chunk), (chunk.length / throttleBps) * 1000);
    },
  });
  const src = fs.createReadStream(file, { start, end });
  src.on('error', () => res.destroy());
  src.pipe(meter).pipe(res);
}

// 같은 키의 작업은 한 번만 실행한다(동시에 들어온 썸네일·자막 요청 등)
const inflight = new Map();
function single(key, fn) {
  if (!inflight.has(key)) inflight.set(key, Promise.resolve().then(fn).finally(() => inflight.delete(key)));
  return inflight.get(key);
}
// 다 만든 다음 이름을 바꿔 넣어서, 만들다 만 파일이 캐시로 쓰이지 않게 한다
async function makeCached(out, make) {
  if (fs.existsSync(out)) return out;
  return single(out, async () => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const part = `${out}.${crypto.randomBytes(4).toString('hex')}.part`;
    try {
      await make(part);
      fs.renameSync(part, out);
    } finally {
      fs.rmSync(part, { force: true });
    }
    return out;
  });
}

export function register(app, ctx) {
  const { db, cfg } = ctx;
  const mediaDir = (hash) => path.join(cfg.dataDir, 'media', hash);
  const transcodeSlots = ff.semaphore(MAX_TRANSCODES);
  const thumbSlots = ff.semaphore(4);
  const unzipSlot = ff.semaphore(1); // 압축 해제는 서버 전체에서 한 번에 하나
  const unzipBusy = new Set(); // 압축 해제를 걸어 둔 사용자
  const work = new Map(); // 변환본 경로 → { status: queued|running|error, progress, message, userId, seen }
  const R = requireScope('files:read'); // 연결 앱 토큰 권한(G-05)
  const W = requireScope('files:write');

  function fileOf(req, id = req.params.id) {
    if (typeof id !== 'string' || !id) fail(400, 'invalid_input', '파일을 지정하세요');
    const n = requireNode(db, req.user.id, id, { kind: 'file', space: 'drive' });
    if (!n.blob_hash) fail(404, 'not_found', '파일 본문이 없습니다');
    return n;
  }
  async function probeOf(n) {
    const row = db.prepare('SELECT data FROM media_probe WHERE hash=?').get(n.blob_hash);
    if (row) return JSON.parse(row.data);
    return single(`probe:${n.blob_hash}`, async () => {
      const p = await ff.probe(blobPath(cfg, n.blob_hash));
      db.prepare('INSERT OR REPLACE INTO media_probe (hash, data, created_at) VALUES (?,?,?)').run(n.blob_hash, JSON.stringify(p), now());
      return p;
    });
  }
  const blocked = (user) => Number(getSettings(user).expiryStage) >= 3;
  function assertPlayback(user) {
    if (blocked(user)) fail(403, 'playback_blocked', '프리미엄이 끝나고 7일이 지나도록 용량이 초과된 상태라 온라인 재생이 멈췄습니다. 파일을 정리하거나 프리미엄을 다시 시작하면 바로 재생할 수 있어요.');
  }
  function qualitiesFor(user, kind, p) {
    if (kind !== 'video') return [];
    if (!isPremium(user)) return ['720p'];
    if (user.tier === 'regional' && (p?.bitRate || 0) > HIGH_BITRATE) return ['720p'];
    return ['720p', 'original'];
  }
  // 원본 화질이 기본. 단 원본을 보려면 다시 인코딩해야 하면(비호환 코덱·HDR) 오래 기다리지 않게 720p 가 기본
  function defaultQuality(user, n, kind, p) {
    if (!qualitiesFor(user, kind, p).includes('original')) return '720p';
    return !p.hdr && (ff.browserPlayable(kind, extOf(n.name), p) || ff.copiesVideo(p, null)) ? 'original' : '720p';
  }
  // 요청한 화질·오디오 트랙을 검사하고, 원본을 그대로 보낼 수 없으면 만들 변환본을 정한다
  function pickVariant(user, n, kind, p, q) {
    const allowed = qualitiesFor(user, kind, p);
    const quality = q.quality || defaultQuality(user, n, kind, p);
    if (!['720p', 'original'].includes(quality)) fail(400, 'invalid_quality', '화질은 720p 또는 original 입니다');
    if (kind === 'video' && !allowed.includes(quality)) {
      fail(403, isPremium(user) ? 'quality_unavailable' : 'premium_required', isPremium(user) ? '이 영상은 변환 화질로만 재생할 수 있습니다' : '원본 화질은 프리미엄 전용입니다');
    }
    const audio = Number(q.audio ?? 0);
    if (!Number.isInteger(audio) || audio < 0 || (audio > 0 && audio >= p.audio.length)) fail(400, 'invalid_audio', '없는 오디오 트랙입니다');
    const asIs = ff.browserPlayable(kind, extOf(n.name), p) && audio === 0 && (kind === 'audio' || (!p.hdr && (quality === 'original' || ff.shortSide(p) <= 720)));
    if (asIs) return null;
    const label = kind === 'audio' ? 'audio' : quality;
    const base = path.join(mediaDir(n.blob_hash), `${label}-a${audio}`);
    // 영상은 HLS 조각도 같이 만들어 변환이 끝나기 전에 첫 조각부터 재생한다(완성본 MP4 는 끝난 뒤 Range 재생·이어보기용)
    return { kind, height: kind === 'video' && quality === '720p' ? 720 : null, audio, out: `${base}.mp4`, hls: kind === 'video' ? `${base}.hls` : null, name: `${label}-a${audio}` };
  }
  const rmQuiet = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    } catch {} // 윈도에서 읽는 중인 조각이 있으면 다음 정리 때 지운다
  };
  // 지금까지 만들어진 HLS 조각의 길이(초)
  function hlsSeconds(dir) {
    try {
      return [...fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((s, m) => s + Number(m[1]), 0);
    } catch {
      return 0;
    }
  }
  // 변환본이 있으면 ready, 없으면 대기열에 넣고 진행 상황을 돌려준다(HLS 조각이 생기면 그 주소도)
  function prepare(user, n, p, v) {
    if (fs.existsSync(v.out)) return { status: 'ready' };
    let j = work.get(v.out);
    if (j?.status === 'error') {
      work.delete(v.out); // 다음 요청 때 다시 시도
      return { status: 'error', message: j.message };
    }
    if (!j) {
      if ([...work.values()].filter((x) => x.userId === user.id && x.status !== 'error').length >= MAX_JOBS_PER_USER) {
        fail(429, 'too_many_jobs', '이미 변환 중인 영상이 있습니다. 앞선 변환이 끝난 뒤 다시 시도하세요.');
      }
      if (v.kind === 'video' && p.videoCodec && !ff.copiesVideo(p, v.height) && (p.duration || 0) > MAX_ENCODE_SEC) {
        fail(422, 'too_long', '너무 긴 영상이라 웹용으로 바꿀 수 없습니다. 외부 플레이어로 열어 보세요.');
      }
      j = { status: 'queued', progress: 0, userId: user.id, seen: now() };
      work.set(v.out, j);
      const src = blobPath(cfg, n.blob_hash);
      const ac = new AbortController();
      transcodeSlots(() => {
        if (now() - j.seen > STALE_MS) return; // 기다리던 화면이 떠났으면 버린다
        j.status = 'running';
        if (v.hls) {
          rmQuiet(v.hls); // 지난번에 멈춘 조각이 남아 있으면 지우고 새로
          fs.mkdirSync(v.hls, { recursive: true });
        }
        return makeCached(v.out, (part) =>
          ff.run('ffmpeg', ff.transcodeArgs(src, v.hls ? path.relative(v.hls, part).replaceAll('\\', '/') : part, p, v, !!v.hls), {
            cwd: v.hls || undefined,
            signal: ac.signal,
            timeoutMs: (120 + 2 * (p.duration || 0)) * 1000, // ponytail: 길이에 비례한 상한. 느린 서버면 계수를 늘릴 것
            onLine: (l) => {
              if (now() - j.seen > STALE_MS) return ac.abort(); // 보던 화면이 떠났으면 실행 중이어도 멈춰 슬롯을 비운다
              const us = /^out_time_us=(\d+)/.exec(l)?.[1];
              if (us && p.duration) j.progress = Math.min(99, (Number(us) / 1e6 / p.duration) * 100);
            },
          }),
        );
      }).then(
        () => work.delete(v.out),
        (e) => {
          if (!ac.signal.aborted) return Object.assign(j, { status: 'error', message: e.message });
          work.delete(v.out); // 버린 작업: 다음에 다시 열면 처음부터
          if (v.hls) rmQuiet(v.hls);
        },
      );
    }
    j.seen = now();
    const st = { status: 'preparing', progress: Math.floor(j.progress), queued: j.status === 'queued' };
    const sec = v.hls && j.status === 'running' ? hlsSeconds(v.hls) : 0;
    return sec ? { ...st, hls: `/api/media/${n.id}/hls/${v.name}/index.m3u8`, hlsSeconds: sec } : st;
  }
  // drive 다운로드와 같은 속도 규칙: 연결당 속도(무료 2MB/s). 쿼터를 넘었거나 이번 요청(len 바이트)으로 넘게 되면 처음부터 SLOW_BPS, 만료 후 초과 상태도 감속
  const transferOpts = (req, res) => (len) => {
    const source = quotaSource(req);
    const q = checkTransfer(db, req.user, 'down', len, source);
    const slow = !q.ok || blocked(req.user);
    if (slow) res.set('X-Mimic-Throttled', q.ok ? 'expiry' : q.reason);
    return { throttleBps: slow ? SLOW_BPS : speedFor(req.user), onBytes: (b) => addUsage(db, req.user.id, 'down', b, source) };
  };
  async function stream(req, res, n) {
    const kind = kindOf(n);
    if (kind === 'other') fail(415, 'not_previewable', '미리 볼 수 없는 형식입니다. 다운로드해서 열어 주세요.');
    let file = blobPath(cfg, n.blob_hash);
    let mime = safeMime(n, kind);
    if (playable(kind)) {
      assertPlayback(req.user);
      const p = await probeOf(n);
      const v = pickVariant(req.user, n, kind, p, req.query);
      if (v) {
        const st = prepare(req.user, n, p, v);
        if (st.status === 'error') fail(422, 'media_failed', st.message);
        if (st.status !== 'ready') return res.status(409).json({ error: 'preparing', message: '재생 준비 중입니다', ...st });
        file = v.out;
        mime = kind === 'audio' ? 'audio/mp4' : 'video/mp4';
      }
    }
    sendRange(req, res, file, { name: n.name, mime, transfer: transferOpts(req, res) });
  }

  // ---------- 외부 플레이어용 임시 URL(C-03): 로그인 없이 원본을 Range 로 받는다 ----------
  const sign = (body) => crypto.createHmac('sha256', cfg.secret).update(`media-ext:${body}`).digest('base64url');
  function readExtToken(token) {
    const [body, sig] = String(token).split('.');
    if (!body || !/^[A-Za-z0-9_-]{43}$/.test(sig || '')) return null; // SHA-256 base64url 길이. 멀티바이트 문자는 여기서 걸러진다
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(body)))) return null;
    const v = json(Buffer.from(body, 'base64url').toString(), null);
    if (!Array.isArray(v)) return null;
    const [userId, fileId, exp, tokenId = null] = v;
    return typeof userId === 'string' && typeof fileId === 'string' && exp > now() ? { userId, fileId, tokenId } : null;
  }
  // 외부 플레이어 링크는 영상·음악만 보낸다
  function playableFile(req, id) {
    const n = fileOf(req, id);
    if (!playable(kindOf(n))) fail(400, 'not_playable', '영상·음악 파일만 외부 플레이어로 열 수 있습니다');
    assertPlayback(req.user);
    return n;
  }
  app.get('/api/media/x/:token/:name', async (req, res) => {
    const tk = readExtToken(req.params.token);
    if (!tk) fail(403, 'link_expired', '재생 링크가 만료되었거나 올바르지 않습니다');
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(tk.userId);
    if (!u || ['deleted', 'pending_delete'].includes(u.status)) fail(404, 'not_found', '파일을 찾을 수 없습니다');
    req.user = u;
    // 연결 앱 토큰으로 받은 링크는 그 토큰이 살아 있는 동안만 열리고, 받은 바이트는 연결 앱 쿼터(감속 포함)로 센다
    if (tk.tokenId) {
      const t = db.prepare('SELECT app_id, expires_at FROM personal_tokens WHERE id=? AND user_id=? AND revoked_at IS NULL').get(tk.tokenId, u.id);
      if (!t || (t.expires_at && t.expires_at <= now())) fail(403, 'link_expired', '재생 링크를 만든 앱 연결이 해제되어 더 이상 열 수 없습니다');
      Object.assign(req, { authKind: 'token', appId: t.app_id || 'pat', tokenId: tk.tokenId });
    }
    requireUser(req, res, () => {});
    const n = playableFile(req, tk.fileId);
    sendRange(req, res, blobPath(cfg, n.blob_hash), { name: n.name, mime: safeMime(n, kindOf(n)), transfer: transferOpts(req, res) });
  });
  app.get('/api/media/:id/external-url', R, async (req, res) => {
    const n = playableFile(req, req.params.id);
    const body = Buffer.from(JSON.stringify([req.user.id, n.id, now() + EXTERNAL_URL_MS, req.authKind === 'token' ? req.tokenId : null])).toString('base64url');
    const url = `${req.protocol}://${req.get('host')}/api/media/x/${body}.${sign(body)}/${encodeURIComponent(n.name)}`;
    // 데스크톱 앱은 id 가 있으면 미믹 플레이어(/play/<id>, 서버 변환)로, 예전 앱은 url 을 Chromium 창에서 그대로 연다(브라우저 형식만 재생)
    const p = await probeOf(n).catch(() => null);
    const mimicPlayable = !!p && ff.browserPlayable(kindOf(n), extOf(n.name), p);
    const mimic = `mimic://play?id=${encodeURIComponent(n.id)}&url=${encodeURIComponent(url)}`;
    res.json({ url, expiresAt: now() + EXTERNAL_URL_MS, potplayer: `potplayer://${url}`, vlc: `vlc://${url}`, mimic, mimicPlayable });
  });

  // ---------- 시청 기록(C-06) ----------
  app.get('/api/media/history', R, (req, res) => {
    const rows = db
      .prepare(
        `SELECT h.position AS w_pos, h.duration AS w_dur, h.updated_at AS w_at, f.* FROM media_history h
         JOIN files f ON f.id = h.file_id AND f.user_id = h.user_id
         WHERE h.user_id = ? AND f.trashed_at IS NULL ORDER BY h.updated_at DESC LIMIT 200`,
      )
      .all(req.user.id);
    res.json({ items: rows.map((r) => ({ fileId: r.id, position: r.w_pos, duration: r.w_dur, updatedAt: r.w_at, file: toApi(r) })) });
  });
  app.post('/api/media/history', W, (req, res) => {
    const { fileId, position, duration } = req.body || {};
    const ok = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 1e7;
    if (!ok(position) || (duration != null && !ok(duration))) fail(400, 'invalid_input', '재생 위치가 올바르지 않습니다');
    const n = fileOf(req, fileId);
    if (!playable(kindOf(n))) fail(400, 'not_playable', '영상·음악만 시청 기록에 남습니다');
    db.prepare(
      `INSERT INTO media_history (user_id, file_id, position, duration, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT (user_id, file_id) DO UPDATE SET position=excluded.position, duration=excluded.duration, updated_at=excluded.updated_at`,
    ).run(req.user.id, n.id, position, duration ?? 0, now());
    res.json({ ok: true });
  });
  app.delete('/api/media/history', W, (req, res) => {
    db.prepare('DELETE FROM media_history WHERE user_id=?').run(req.user.id);
    res.json({ ok: true });
  });
  app.delete('/api/media/history/:fileId', W, (req, res) => {
    db.prepare('DELETE FROM media_history WHERE user_id=? AND file_id=?').run(req.user.id, req.params.fileId);
    res.json({ ok: true });
  });

  // ---------- 정보·재생·자막·썸네일 ----------
  app.get('/api/media/:id/info', R, async (req, res) => {
    const n = fileOf(req);
    const kind = kindOf(n);
    let p = null;
    let probeError = null;
    if (playable(kind)) {
      try {
        p = await probeOf(n);
      } catch (e) {
        probeError = e.message;
      }
    }
    const group = (k) => (playable(k) ? 'play' : k === 'image' ? 'image' : null);
    const siblings = listChildren(db, req.user.id, n.parent_id)
      .filter((x) => x.kind === 'file')
      .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    // 이전/다음은 드라이브 목록(/api/drive/list)과 같은 저장된 정렬
    const same = group(kind) ? sortRows(siblings.filter((x) => x.id === n.id || group(kindOf(x)) === group(kind)), readPrefs(getSettings(req.user), n.parent_id || 'root')) : [];
    const i = same.findIndex((x) => x.id === n.id);
    const base = baseOf(n.name).toLowerCase();
    // 이름이 같은 자막은 자동으로 붙이고, 같은 폴더의 다른 srt·vtt 는 플레이어에서 골라 붙인다
    const subFiles = playable(kind) ? siblings.filter((x) => SUB_EXT.has(extOf(x.name))) : [];
    const matches = (x) => baseOf(x.name).toLowerCase() === base || x.name.toLowerCase().startsWith(base + '.');
    const sidecars = subFiles
      .filter(matches)
      .map((x) => ({ id: x.id, label: x.name, lang: /\.([a-z]{2,3}(?:-[a-z]{2})?)\.(srt|vtt)$/i.exec(x.name)?.[1] || null, source: 'sidecar' }));
    const history = db.prepare('SELECT position, duration, updated_at AS updatedAt FROM media_history WHERE user_id=? AND file_id=?').get(req.user.id, n.id) || null;
    res.json({
      file: toApi(n),
      kind,
      mime: safeMime(n, kind),
      archive: archiveOf(n.name), // null | { format, supported }
      duration: p?.duration ?? null,
      width: p?.width ?? null,
      height: p?.height ?? null,
      videoCodec: p?.videoCodec ?? null,
      audioTracks: (p?.audio || []).map(({ index, lang, title, codec }) => ({ index, lang, title, codec })),
      subtitles: [...(p?.subs || []).filter((s) => s.text).map((s) => ({ id: `e${s.index}`, label: s.title || s.lang || `#${s.index + 1}`, lang: s.lang, source: 'embedded' })), ...sidecars],
      imageSubtitles: (p?.subs || []).filter((s) => !s.text).length, // PGS·DVD 같은 그림 자막: 웹에서는 못 그려 외부 플레이어 안내만
      subtitleFiles: subFiles.filter((x) => !matches(x)).map((x) => ({ id: x.id, label: x.name })),
      hdr: !!p?.hdr,
      qualities: qualitiesFor(req.user, kind, p),
      defaultQuality: kind === 'video' && p ? defaultQuality(req.user, n, kind, p) : null,
      // prevId·nextId·ids(같은 종류 파일)는 사용자가 드라이브에 저장한 정렬 순서
      siblings: { prevId: i > 0 ? same[i - 1].id : null, nextId: i >= 0 && i < same.length - 1 ? same[i + 1].id : null, ids: same.map((x) => x.id) },
      history,
      playbackBlocked: playable(kind) && blocked(req.user),
      probeError,
    });
  });

  app.get('/api/media/:id/prepare', R, async (req, res) => {
    const n = fileOf(req);
    const kind = kindOf(n);
    if (!playable(kind)) return res.json({ status: 'ready' });
    assertPlayback(req.user);
    const p = await probeOf(n);
    const v = pickVariant(req.user, n, kind, p, req.query);
    res.json(v ? prepare(req.user, n, p, v) : { status: 'ready' });
  });

  app.get('/api/media/:id/stream', R, async (req, res) => stream(req, res, fileOf(req)));

  // 변환 중인 영상의 HLS 재생 목록·조각(C-01). 재생 목록을 받을 때마다 변환 작업이 살아 있게 한다
  app.get('/api/media/:id/hls/:variant/:file', R, async (req, res) => {
    const n = fileOf(req);
    const vm = /^(720p|original)-a(\d{1,2})$/.exec(req.params.variant);
    const fm = /^(?:index\.m3u8|seg-\d{5}\.ts)$/.exec(req.params.file);
    if (kindOf(n) !== 'video' || !vm || !fm) fail(404, 'not_found', '재생 조각을 찾을 수 없습니다');
    assertPlayback(req.user);
    const p = await probeOf(n);
    const v = pickVariant(req.user, n, 'video', p, { quality: vm[1], audio: vm[2] }); // 같은 본문을 가진 다른 사람의 원본 화질 조각을 무료 계정이 받지 못하게 화질 권한을 다시 본다
    const file = v && path.join(v.hls, fm[0]);
    if (!file || !fs.existsSync(file)) fail(404, 'not_found', '재생 조각이 없습니다. 다시 시도해 주세요.');
    const j = work.get(v.out);
    if (j) j.seen = now();
    if (fm[0] !== 'index.m3u8') return sendRange(req, res, file, { name: fm[0], mime: 'video/mp2t', transfer: transferOpts(req, res) });
    // 끝나지 않은(EVENT) 목록이라도 처음부터 재생하게 시작 위치를 붙인다
    const text = fs.readFileSync(file, 'utf8').replace(/^#EXTM3U\r?\n/, '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n');
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).type('application/vnd.apple.mpegurl').send(text);
  });

  app.get('/api/media/:id/subtitles/:sub.vtt', R, async (req, res) => {
    const n = fileOf(req);
    const sub = req.params.sub;
    let vtt;
    const emb = /^e(\d{1,3})$/.exec(sub);
    if (emb) {
      const p = await probeOf(n);
      if (!p.subs.some((s) => s.index === Number(emb[1]) && s.text)) fail(404, 'not_found', '자막을 찾을 수 없습니다');
      // 원본 전체를 읽는 작업이라 썸네일과 같은 동시 실행 상한·길이 비례 시간 상한을 둔다
      const out = await thumbSlots(() =>
        makeCached(path.join(mediaDir(n.blob_hash), `sub-${sub}.vtt`), async (part) =>
          fs.writeFileSync(part, await ff.run('ffmpeg', ff.subtitleArgs(blobPath(cfg, n.blob_hash), Number(emb[1])), { timeoutMs: (60 + (p.duration || 0) / 4) * 1000 })),
        ),
      );
      vtt = fs.readFileSync(out, 'utf8');
    } else {
      const s = fileOf(req, sub);
      if (!SUB_EXT.has(extOf(s.name))) fail(404, 'not_found', '자막 파일이 아닙니다');
      if (s.size > TEXT_PREVIEW_MAX) fail(413, 'too_large', '자막 파일이 너무 큽니다');
      vtt = srtToVtt(decodeText(fs.readFileSync(blobPath(cfg, s.blob_hash))));
    }
    res.set('Cache-Control', 'private, max-age=3600').type('text/vtt; charset=utf-8').send(vtt);
  });

  // 썸네일은 전송 쿼터를 차감하지 않는다(드라이브 목록이 쓴다)
  app.get('/api/media/:id/thumb', R, async (req, res) => {
    const n = fileOf(req);
    const kind = kindOf(n);
    if (kind !== 'video' && kind !== 'image') fail(404, 'no_thumb', '미리보기 이미지가 없는 파일입니다');
    const out = path.join(mediaDir(n.blob_hash), 'thumb.jpg');
    if (!fs.existsSync(out)) {
      const seek = kind === 'video' ? Math.min(10, ((await probeOf(n)).duration || 0) * 0.1) : 0;
      await thumbSlots(() => makeCached(out, (part) => ff.run('ffmpeg', ff.thumbArgs(blobPath(cfg, n.blob_hash), part, seek))));
    }
    res.set('Cache-Control', 'private, max-age=86400');
    res.type('image/jpeg').send(fs.readFileSync(out));
  });

  // ---------- 온라인 압축 해제(B-08, 프리미엄) ----------
  app.post('/api/media/unzip', W, async (req, res) => {
    if (!isPremium(req.user)) fail(403, 'premium_required', '프리미엄 전용 기능입니다');
    const { fileId, parentId } = req.body || {};
    if (parentId != null && typeof parentId !== 'string') fail(400, 'invalid_input', '풀어 넣을 폴더를 잘못 지정했습니다');
    const uid = req.user.id;
    const node = fileOf(req, fileId);
    const arc = archiveOf(node.name);
    if (!arc?.supported) fail(400, 'unsupported_archive', '지금은 zip·tar·tar.gz·gz 파일만 풀 수 있습니다');
    if (node.size > UNZIP_LIMITS.archive) fail(413, 'archive_too_large', '압축 파일이 너무 커서 온라인으로 풀 수 없습니다');
    const target = parentId === undefined ? node.parent_id : parentId;
    if (target) requireNode(db, uid, target, { kind: 'folder', space: 'drive' });
    if (unzipBusy.has(uid)) fail(429, 'unzip_busy', '이미 압축을 푸는 중입니다. 끝난 뒤 다시 시도하세요.');
    unzipBusy.add(uid);
    try {
      res.json(await unzipSlot(() => extract(req.user, node, target, arc.format)));
    } finally {
      unzipBusy.delete(uid);
    }
  });

  const tooBig = (msg = '압축을 푼 크기가 너무 큽니다') => fail(413, 'archive_too_large', msg);
  const badArchive = () => fail(400, 'bad_archive', '압축 파일이 손상되었거나 읽을 수 없습니다');
  function checkDeclared(user, declared) {
    if (declared > UNZIP_LIMITS.total) tooBig();
    checkCapacity(db, user, declared);
  }
  // 메모리에 다 올리지 않고 풀면서 바로 저장한다. 선언된 크기를 넘으면 중단(maxBytes)
  async function ingestInto(it, skipped, src, maxBytes) {
    try {
      const r = await ingestStream(db, cfg, src(), MIME[extOf(it.parts.at(-1))] || null, { maxBytes: Math.max(1, maxBytes) });
      Object.assign(it, { hash: r.hash, size: r.size });
    } catch {
      it.parts = null; // 손상되었거나 선언보다 큰 항목
      skipped.damaged++;
    }
  }

  async function readZip(user, node, skipped) {
    let entries;
    try {
      const zip = new AdmZip(await fs.promises.readFile(blobPath(cfg, node.blob_hash)), { decoder: zipNameGuard(), noSort: true }); // 끝 머리글만 읽는다. 순서는 상관없어 이름 정렬(긴 이름이면 느림)은 끈다
      // 중앙 디렉터리를 읽기 전에 항목 수부터 본다(adm-zip 이 읽을 항목 수 그대로). 항목 수십만 개는 읽는 것만으로 메인 스레드·메모리를 오래 잡는다
      if (zip.getEntryCount() > UNZIP_LIMITS.entries) tooBig('압축 안의 파일 수가 너무 많습니다');
      entries = zip.getEntries();
    } catch (e) {
      if (e.status) throw e;
      badArchive();
    }
    if (entries.length > UNZIP_LIMITS.entries) tooBig('압축 안의 파일 수가 너무 많습니다');
    const items = [];
    let declared = 0;
    for (const e of entries) {
      const parts = safeParts(decodeText(e.rawEntryName));
      if (parts?.[0] === '__MACOSX') continue; // 맥이 붙이는 부가 정보
      const h = e.header;
      // 압축 폭탄 방지: 항목 크기 상한과 압축률 상한. 암호·지원하지 않는 압축 방식(저장·deflate 외)도 건너뛴다
      const why = !parts ? 'unsafe' : e.isDirectory ? null : h.encrypted ? 'encrypted' : ![0, 8].includes(h.method) ? 'unsupported' : h.size > UNZIP_LIMITS.entry || h.size > UNZIP_LIMITS.ratio * Math.max(h.compressedSize, 1) ? 'tooLarge' : null;
      if (why) {
        skipped[why]++;
        continue;
      }
      if (!e.isDirectory) declared += h.size;
      items.push({ parts, entry: e.isDirectory ? null : e });
    }
    checkDeclared(user, declared);
    // ponytail: CRC 는 확인하지 않는다(손상 항목은 손상된 채 저장). 필요하면 zlib.crc32 로 미터링
    for (const it of items) {
      if (!it.entry) continue;
      await ingestInto(it, skipped, () => {
        const raw = it.entry.getCompressedData();
        return it.entry.header.method === 0 ? Readable.from([raw]) : zlib.createInflateRaw().end(raw);
      }, it.entry.header.size);
    }
    return items;
  }

  // tar·tar.gz: gz 는 임시 파일로 먼저 풀고(크기·압축률 상한), tar 머리글을 읽어 항목 본문을 범위 읽기로 저장한다
  async function readTar(user, node, skipped, gz) {
    let file = blobPath(cfg, node.blob_hash);
    const tmp = gz ? tmpPath(cfg, 'untar_') : null;
    try {
      if (gz) {
        const cap = Math.min(UNZIP_LIMITS.total + 64 * 1024 ** 2, UNZIP_LIMITS.ratio * Math.max(node.size, 1));
        let n = 0;
        const limit = new Transform({ transform: (c, _e, cb) => ((n += c.length), cb(n > cap ? new Error('too_big') : null, c)) });
        await pipeline(fs.createReadStream(file), zlib.createGunzip(), limit, fs.createWriteStream(tmp)).catch(() => (n > cap ? tooBig() : badArchive()));
        file = tmp;
      }
      const entries = await tarEntries(file, skipped);
      if (entries.length > UNZIP_LIMITS.entries) tooBig('압축 안의 파일 수가 너무 많습니다');
      const items = [];
      let declared = 0;
      for (const e of entries) {
        const parts = safeParts(e.name);
        const why = !parts ? 'unsafe' : !['0', '5', '7'].includes(e.type) ? 'unsupported' : e.size > UNZIP_LIMITS.entry ? 'tooLarge' : null; // 링크·장치 파일은 건너뜀
        if (why) {
          skipped[why]++;
          continue;
        }
        if (e.type !== '5') declared += e.size;
        items.push({ parts, entry: e.type === '5' ? null : e });
      }
      checkDeclared(user, declared);
      for (const it of items) {
        if (!it.entry) continue;
        const { at, size } = it.entry;
        await ingestInto(it, skipped, () => (size ? fs.createReadStream(file, { start: at, end: at + size - 1 }) : Readable.from([])), size);
      }
      return items;
    } finally {
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  }

  // 압축 하나에 파일 하나(.gz)
  async function readGz(user, node, skipped) {
    const it = { parts: safeParts(node.name.replace(/\.gz$/i, '')) || ['file'] };
    await ingestInto(it, skipped, () => {
      const gz = zlib.createGunzip();
      return fs.createReadStream(blobPath(cfg, node.blob_hash)).on('error', (e) => gz.destroy(e)).pipe(gz);
    }, Math.min(UNZIP_LIMITS.entry, UNZIP_LIMITS.ratio * Math.max(node.size, 1)));
    if (!it.hash) fail(400, 'bad_archive', '압축 파일이 손상되었거나, 풀었을 때 너무 커서 풀 수 없습니다');
    return [it];
  }

  // 압축 이름의 새 폴더 안에 같은 구조로 만든다. skippedBy 는 건너뛴 이유별 수(encrypted·unsafe·tooLarge·unsupported·damaged)
  async function extract(user, node, target, format) {
    const uid = user.id;
    const skipped = { encrypted: 0, unsafe: 0, tooLarge: 0, unsupported: 0, damaged: 0 };
    const items = format === 'zip' ? await readZip(user, node, skipped) : format === 'gz' ? await readGz(user, node, skipped) : await readTar(user, node, skipped, format === 'tgz');
    const files = items.filter((it) => it.hash);
    checkCapacity(db, user, files.reduce((s, it) => s + it.size, 0));
    const root = tx(db, () => {
      const folder = createFolder(db, uid, target, node.name.replace(/(\.tar)?\.[^.]+$/i, '') || node.name, { origin: 'unzip' });
      const dirs = new Map();
      const dirOf = (parts) =>
        parts.reduce((parent, name, i) => {
          const key = parts.slice(0, i + 1).join('/');
          if (!dirs.has(key)) dirs.set(key, createFolder(db, uid, parent, name, { origin: 'unzip' }).id);
          return dirs.get(key);
        }, folder.id);
      for (const it of items) {
        if (!it.parts) continue;
        if (!it.hash) dirOf(it.parts);
        else createFileNode(db, uid, dirOf(it.parts.slice(0, -1)), { name: it.parts.at(-1), size: it.size, mime: MIME[extOf(it.parts.at(-1))] || null, blobHash: it.hash, origin: 'unzip' });
      }
      return folder;
    });
    const skippedBy = Object.fromEntries(Object.entries(skipped).filter(([, n]) => n));
    return { folder: toApi(root), files: files.length, skipped: Object.values(skipped).reduce((a, b) => a + b, 0), skippedBy };
  }
}

// ---------- 압축 형식 ----------
// 온라인으로 풀 수 있는 형식. 그 밖의 압축(7z·rar 등)은 형식만 알려 준다
const ARCHIVES = [
  [/\.zip$/i, 'zip'],
  [/\.(tar\.gz|tgz)$/i, 'tgz'],
  [/\.tar$/i, 'tar'],
  [/\.gz$/i, 'gz'],
  [/\.(7z|rar|bz2|tbz2?|xz|txz|zst|lzh|alz|egg|cab|arj)$/i, null],
];
export function archiveOf(name) {
  for (const [re, format] of ARCHIVES) if (re.test(name || '')) return { format: format || extOf(name), supported: !!format };
  return null;
}
// 경로 이탈(zip slip) 방지: .. 이나 쓸 수 없는 이름·드라이브 문자가 있으면 null. 결과는 새 폴더 안에만 만든다
function safeParts(name) {
  const parts = name.split(/[\\/]+/).filter((x) => x && x !== '.');
  return parts.length && !parts.some((x) => x === '..' || !validName(x) || /^[a-z]:$/i.test(x)) ? parts : null;
}
// adm-zip 은 항목 이름마다 decoder.decode 를 부르고, 다 읽은 뒤 이름에 나온 상위 폴더마다 큰 항목 객체를 만든다.
// 깊은 경로 하나(수만 단계, 120KB zip)만으로 25초·2GB 를 쓴다. 그 일의 양(이름마다 깊이×길이)·이름 길이·상위 폴더 수를 여기서 세어 넘으면 바로 멈춘다.
// latin1 은 바이트를 그대로 오가게 해서 adm-zip 이 만든 상위 폴더도 원래 이름 바이트(rawEntryName)를 지킨다
export const ZIP_NAME_LIMITS = { bytes: 1024, work: 32 * 1024 ** 2 };
function zipNameGuard() {
  const seen = new Set();
  const dirs = new Set();
  let work = 0;
  const tooBig = () => fail(413, 'archive_too_large', '압축 안의 경로가 너무 길거나 폴더가 너무 많습니다');
  return {
    encode: (s) => Buffer.from(s, 'latin1'),
    decode: (b) => {
      if (b.length > ZIP_NAME_LIMITS.bytes) tooBig();
      const s = b.toString('latin1');
      if (seen.has(s)) return s;
      seen.add(s);
      for (let i = s.indexOf('/'); i >= 0; i = s.indexOf('/', i + 1)) {
        dirs.add(s.slice(0, i));
        work += s.length;
      }
      if (work > ZIP_NAME_LIMITS.work || dirs.size > UNZIP_LIMITS.entries) tooBig();
      return s;
    },
  };
}
// tar 머리글 목록: { name, type('0' 파일·'5' 폴더·그 밖), size, at(본문 위치) }. GNU 긴 이름(L)·pax 경로(x)를 반영한다.
// 항목 수 상한을 읽는 도중에 확인하고(머리글만 가득한 tar 로 이벤트 루프를 오래 잡지 못하게), 1000 머리글마다 다른 요청에 차례를 넘긴다
export async function tarEntries(file, skipped) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    if (total < 512) fail(400, 'bad_archive', '압축 파일이 손상되었거나 읽을 수 없습니다');
    const hdr = Buffer.alloc(512);
    const field = (a, b) => {
      const s = hdr.subarray(a, b);
      const z = s.indexOf(0);
      return z < 0 ? s : s.subarray(0, z);
    };
    const out = [];
    let off = 0;
    let longName = null;
    let headers = 0;
    while (off + 512 <= total) {
      // 긴 이름(L)·pax(x·g) 머리글은 항목마다 붙을 수 있어 항목 수 상한의 3배까지 둔다
      if (out.length > UNZIP_LIMITS.entries || ++headers > 3 * UNZIP_LIMITS.entries) fail(413, 'archive_too_large', '압축 안의 파일 수가 너무 많습니다');
      if (headers % 1000 === 0) await new Promise((r) => setImmediate(r));
      fs.readSync(fd, hdr, 0, 512, off);
      if (hdr.every((b) => b === 0)) break; // 끝 표시
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : hdr[i];
      const size = parseInt(field(124, 136).toString().trim() || '0', 8);
      const at = off + 512;
      if (sum !== parseInt(field(148, 156).toString().trim(), 8) || !Number.isSafeInteger(size) || at + size > total) {
        if (!off) fail(400, 'bad_archive', '압축 파일이 손상되었거나 읽을 수 없습니다');
        skipped.damaged++; // 중간이 깨졌으면 거기까지만
        break;
      }
      off = at + Math.ceil(size / 512) * 512;
      const type = hdr[156] ? String.fromCharCode(hdr[156]) : '0';
      if (type === 'L' || type === 'x') {
        const b = Buffer.alloc(Math.min(size, 64 * 1024));
        fs.readSync(fd, b, 0, b.length, at);
        const text = decodeText(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
        longName = type === 'L' ? text : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? longName);
        continue;
      }
      if (type === 'g') continue;
      const posix = hdr.toString('latin1', 257, 263) === 'ustar\0'; // 옛 GNU 형식은 이 자리에 다른 값을 둔다
      const prefix = posix && field(345, 500).length ? decodeText(field(345, 500)) + '/' : '';
      out.push({ name: longName ?? prefix + decodeText(field(0, 100)), type, size, at });
      longName = null;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// 본문이 지워진 파일의 변환본·썸네일·분석 결과를 정리한다
export const jobs = [
  {
    name: 'media:gc-cache',
    everyMs: 6 * 3600_000,
    run: ({ db, cfg }) => {
      const dir = path.join(cfg.dataDir, 'media');
      for (const hash of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(hash)) {
          // 변환이 끝난 뒤의 HLS 조각은 완성본 MP4 가 대신하므로, 6시간 넘게 바뀌지 않은 것은 지운다
          for (const f of fs.readdirSync(path.join(dir, hash))) {
            const p = path.join(dir, hash, f);
            if (f.endsWith('.hls') && fs.statSync(p).mtimeMs < Date.now() - 6 * 3600_000) fs.rmSync(p, { recursive: true, force: true });
          }
          continue;
        }
        fs.rmSync(path.join(dir, hash), { recursive: true, force: true });
        db.prepare('DELETE FROM media_probe WHERE hash=?').run(hash);
      }
    },
  },
];

export async function close() {
  ff.killAll();
}
