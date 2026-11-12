// 내용 주소 기반 파일 저장소: 파일 본문을 SHA-256 이름으로 한 벌만 보관한다(A-06 중복 제거의 바탕).
// ponytail: 로컬 디스크 구현. 저장소를 NAS·S3 로 옮길 때 이 파일만 교체한다(docs/MIMIC_PLAN.md 11-8)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { now, newId } from './util.js';

export const blobPath = (cfg, hash) => path.join(cfg.dataDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
export function tmpDir(cfg) {
  const d = path.join(cfg.dataDir, 'tmp');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
export const tmpPath = (cfg, prefix = 'tmp_') => path.join(tmpDir(cfg), newId(prefix));

function adopt(db, cfg, tmp, hash, size, mime) {
  const dest = blobPath(cfg, hash);
  const existed = fs.existsSync(dest);
  if (existed) fs.rmSync(tmp, { force: true });
  else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest);
  }
  db.prepare('INSERT OR IGNORE INTO blobs (hash, size, mime, created_at) VALUES (?,?,?,?)').run(hash, size, mime, now());
  return { hash, size, deduped: existed };
}

// 디스크의 임시 파일을 저장소로 옮긴다(원본 파일은 이동되거나 삭제된다)
export async function ingestFile(db, cfg, file, mime = null) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return adopt(db, cfg, file, h.digest('hex'), fs.statSync(file).size, mime);
}

// 스트림을 받으면서 해시한다. maxBytes 를 넘으면 413 storage_full
export async function ingestStream(db, cfg, readable, mime = null, { maxBytes = 0 } = {}) {
  const tmp = tmpPath(cfg, 'up_');
  const h = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) return cb(Object.assign(new Error('저장 공간이 부족합니다'), { status: 413, code: 'storage_full' }));
      h.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(readable, meter, fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return adopt(db, cfg, tmp, h.digest('hex'), size, mime);
}

export function hasBlob(db, cfg, hash) {
  return !!db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(hash) && fs.existsSync(blobPath(cfg, hash));
}

function meterStream(bps, count) {
  return new Transform({
    transform(chunk, _enc, cb) {
      count(chunk.length);
      if (!bps) return cb(null, chunk);
      setTimeout(() => cb(null, chunk), (chunk.length / bps) * 1000);
    },
  });
}

// 브라우저 안에서 바로 열어도 안전한 형식만 inline 으로 보낸다. HTML·SVG·스크립트 등은 항상 첨부로(미믹 도메인에서 실행 방지)
const SAFE_INLINE = /^(video|audio)\/|^image\/(?!svg)|^application\/pdf$|^text\/(plain|vtt)$/;

// Range(이어받기) 지원 전송. throttleBps 로 속도 제한, onBytes(실제 전송량)로 쿼터를 차감한다
export function sendBlob(req, res, cfg, hash, { name, mime, inline = true, throttleBps = 0, onBytes } = {}) {
  mime = String(mime || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (inline && !SAFE_INLINE.test(mime)) inline = false;
  res.set('X-Content-Type-Options', 'nosniff');
  const file = blobPath(cfg, hash);
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: 'not_found', message: '파일 본문이 없습니다' });
    return;
  }
  const st = fs.statSync(file);
  const total = st.size;
  // 본문은 내용 해시로 저장돼 바뀌지 않으므로 해시가 곧 강한 ETag. 브라우저가 실패한 다운로드를 이어받으려면 검증값이 필요하다(B-07)
  const etag = `"${hash}"`;
  const lastModified = st.mtime.toUTCString();
  res.set({ ETag: etag, 'Last-Modified': lastModified });
  // If-Range 가 지금 검증값과 다르면 Range 를 무시하고 전체(200)를 보낸다
  const ifRange = req.headers['if-range'];
  const rangeOk = !ifRange || ifRange === etag || ifRange === lastModified;
  let start = 0;
  let end = total - 1;
  let status = 200;
  const m = rangeOk && /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && total > 0) {
    if (m[1] === '') start = Math.max(0, total - Number(m[2] || 0));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= total) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    status = 206;
  }
  res.status(status).set({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(total === 0 ? 0 : end - start + 1),
    'Content-Type': mime || 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name || hash)}`,
  });
  if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  if (req.method === 'HEAD' || total === 0) {
    res.end();
    return;
  }
  let sent = 0;
  res.on('close', () => onBytes?.(sent));
  fs.createReadStream(file, { start, end })
    .pipe(meterStream(throttleBps, (n) => (sent += n)))
    .pipe(res);
}

// 어떤 파일도 참조하지 않는 본문을 지운다. 업로드 직후 경합을 피하려고 1시간 지난 것만
export function gcBlobs(db, cfg) {
  const rows = db
    .prepare('SELECT hash FROM blobs WHERE created_at < ? AND hash NOT IN (SELECT blob_hash FROM files WHERE blob_hash IS NOT NULL)')
    .all(now() - 3600_000);
  for (const { hash } of rows) {
    fs.rmSync(blobPath(cfg, hash), { force: true });
    db.prepare('DELETE FROM blobs WHERE hash=?').run(hash);
  }
  return rows.length;
}
