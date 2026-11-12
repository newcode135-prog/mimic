// 금고(E-01~E-05): 종단간 암호화. 서버는 암호문·감싼 키만 보관하고 평문·패스코드·키는 받지 않는다.
// 암호화 방식은 web/pages/vault-crypto.js 참고. 파일은 코어 files 테이블의 space='vault' 를 쓴다.
import fs from 'node:fs';
import crypto from 'node:crypto';
import busboy from 'busboy';
import { requireUser, requirePremium, quotaSource, verifyPassword } from '../../core/auth.js';
import { now, sha256, fail, json, rateLimit, periodKeys, DAY } from '../../core/util.js';
import { tx } from '../../core/db.js';
import { getNode, requireNode, listChildren, createFolder, createFileNode, usage, checkCapacity, descendantIds } from '../../core/files.js';
import { ingestStream, sendBlob, blobPath } from '../../core/storage.js';
import { VAULT_STORAGE, SHARE_EXPIRY_DAYS, SLOW_BPS, speedFor, isPremium } from '../../core/plans.js';
import { audit } from '../../core/notify.js';
import { checkTransfer, addUsage } from '../../core/quota.js';

export const migrations = `
CREATE TABLE IF NOT EXISTS vault_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt TEXT NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  wrapped_master TEXT NOT NULL,            -- 패스코드로 만든 키로 감싼 마스터키
  proof_hash TEXT NOT NULL,                -- sha256(마스터키에서 유도한 증명값): 잠금 해제한 기기만 금고 API 사용
  auto_lock_minutes INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,         -- 공유 주소 토큰은 해시로만 저장(원문은 만들 때 한 번만 응답)
  file_ids TEXT NOT NULL,                  -- JSON 배열
  wrapped_keys TEXT NOT NULL,              -- JSON { 파일ID: 공유키로 감싼 데이터키 }
  mode TEXT NOT NULL,                      -- separate | combined
  expires_at INTEGER,                      -- NULL = 영구
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS vault_shares_user ON vault_shares(user_id);
CREATE TABLE IF NOT EXISTS vault_prf (     -- 생체인증(WebAuthn PRF) 등록: 기기(인증기)마다 한 줄
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  salt TEXT NOT NULL,
  wrapped TEXT NOT NULL,                   -- PRF 출력으로 감싼 마스터키
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, credential_id)
);
CREATE TABLE IF NOT EXISTS vault_unlocks ( -- 서버 쪽 잠금 해제(E-03): 로그인 세션에 묶이고, 자동 잠금 시간 동안 안 쓰면 끝난다
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_unlocks_user ON vault_unlocks(user_id);
CREATE TABLE IF NOT EXISTS vault_share_traffic ( -- 공개 공유 하루 전송량(E-05)
  share_id TEXT NOT NULL REFERENCES vault_shares(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, day)
);
`;

const SPACE = 'vault';
const B64 = /^[A-Za-z0-9_-]+$/;
const enc = (v, max, field) => (typeof v === 'string' && v.length > 0 && v.length <= max && B64.test(v) ? v : fail(400, 'invalid_' + field, '암호화된 값의 형식이 올바르지 않습니다'));
const ids = (v, max = 1000) => (Array.isArray(v) && v.length > 0 && v.length <= max && v.every((x) => typeof x === 'string') ? [...new Set(v)] : fail(400, 'invalid_ids', '대상을 골라 주세요'));
const placeholder = () => 'enc_' + crypto.randomBytes(9).toString('base64url');
// 상위 폴더 id: 없음(null·'')은 맨 위, 문자열만 받는다(배열·객체가 DB 바인딩까지 가지 않게)
const parentOf = (v) => (v == null || v === '' ? null : typeof v === 'string' && v.length <= 200 ? v : fail(400, 'invalid_parent', '폴더 지정이 올바르지 않습니다'));
// 금고는 웹 로그인 세션 전용. 개인 액세스 토큰·연결 앱 토큰은 권한 범위와 상관없이 막는다
function sessionOnly(req, _res, next) {
  if (req.authKind !== 'session') fail(403, 'session_only', '금고는 미믹 웹에 로그인한 상태에서만 쓸 수 있습니다');
  next();
}
const RESET_FRESH_MS = 10 * 60_000; // 비밀번호 없는 계정은 이 시간 안에 로그인한 세션으로만 금고 초기화
const MAX_PRF = 20; // 한 사용자가 생체인증을 등록할 수 있는 기기 수
// 공개 공유 하나가 하루에 내려보내는 양은 담긴 파일 크기의 이 배수까지(E-05). 링크가 새도 소유자 다운스트림 쿼터를 다 쓰지 못하게 한다.
// ponytail: 공유별 상한만 둔다. 큰 공유 여러 개가 함께 새면 여전히 빨리 쓸 수 있다 — 필요하면 소유자별 공개 전송 하루 상한을 더할 것
const SHARE_DAILY_COPIES = 5;
// 정지·잠금·삭제 대기 계정의 공개 공유는 막는다(share 모듈과 같은 기준)
const ownerOff = (u) => !u || ['deleted', 'pending_delete', 'locked'].includes(u.status) || (u.status === 'suspended' && (!u.status_until || u.status_until > now()));

function item(n) {
  const m = json(n.meta, {});
  return { id: n.id, parentId: n.parent_id, kind: n.kind, size: n.size, encName: m.encName ?? null, encKey: m.encKey ?? null, encInfo: m.encInfo ?? null, createdAt: n.created_at, updatedAt: n.updated_at };
}
function shareApi(s) {
  const fileIds = json(s.file_ids, []);
  const status = s.revoked_at ? 'revoked' : s.expires_at && s.expires_at <= now() ? 'expired' : 'active';
  return { id: s.id, fileIds, fileCount: fileIds.length, mode: s.mode, expiresAt: s.expires_at, createdAt: s.created_at, revokedAt: s.revoked_at, status, sentBytes: s.sent ?? 0 };
}

// multipart: 필드(parentId, encMeta)를 파일보다 먼저 보내야 한다
function readUpload(req, onFile) {
  if (!req.is('multipart/form-data')) fail(400, 'multipart_required', '파일을 multipart 로 보내 주세요');
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { files: 1, fields: 10, fieldSize: 64 * 1024 } });
    const fields = {};
    let job = null;
    const bail = (e) => {
      req.unpipe(bb);
      req.resume();
      reject(e);
    };
    bb.on('field', (k, v) => (fields[k] = v));
    bb.on('file', (_name, stream) => {
      job = onFile(stream, fields).catch((e) => {
        stream.resume();
        bail(e);
      });
    });
    bb.on('close', () => (job ? job.then(resolve) : reject(Object.assign(new Error('파일이 없습니다'), { status: 400, code: 'no_file' }))));
    bb.on('error', bail);
    req.pipe(bb);
  });
}

export function register(app, ctx) {
  const { db, cfg } = ctx;
  const keysOf = (userId) => db.prepare('SELECT * FROM vault_keys WHERE user_id=?').get(userId);

  // 잠금 해제 확인(E-02·E-03): 증명값(마스터키를 가진 기기만 앎)으로 받은 잠금 해제 토큰을 요청마다 확인한다.
  // 토큰은 이 로그인 세션에서만 쓰이고, 자동 잠금 시간 동안 요청이 없으면 끝난다. 화면이 잠그면 POST /lock 으로 바로 버린다
  const LOCKED = () => fail(403, 'vault_locked', '금고가 잠겨 있습니다. 다시 잠금 해제해 주세요');
  function unlocked(req, res, next) {
    const k = keysOf(req.user.id);
    if (!k) fail(409, 'vault_not_setup', '금고를 먼저 만들어 주세요');
    const th = sha256(String(req.get('x-vault-token') || ''));
    const row = db.prepare('SELECT expires_at FROM vault_unlocks WHERE token_hash=? AND user_id=? AND session_id=?').get(th, req.user.id, req.sessionId);
    if (!row || row.expires_at <= now()) LOCKED();
    const touch = () => db.prepare('UPDATE vault_unlocks SET expires_at=? WHERE token_hash=?').run(now() + k.auto_lock_minutes * 60_000, th);
    touch();
    res.on('close', () => {
      try {
        touch(); // 긴 올리기·내려받기는 끝난 때부터 다시 센다
      } catch {}
    });
    req.vault = k;
    req.vaultToken = th;
    next();
  }
  const P = [requirePremium, sessionOnly];
  const V = [...P, unlocked];

  // 금고 파일을 바로 영구 삭제한다. 다른 곳에서 안 쓰는 본문도 즉시 지운다
  function purge(uid, ids) {
    const hashes = new Set();
    tx(db, () => {
      for (const id of ids) {
        const row = db.prepare("SELECT blob_hash FROM files WHERE id=? AND user_id=? AND space='vault'").get(id, uid);
        if (row?.blob_hash) hashes.add(row.blob_hash);
        db.prepare("DELETE FROM files WHERE id=? AND user_id=? AND space='vault'").run(id, uid);
      }
    });
    for (const h of hashes) {
      if (db.prepare('SELECT 1 FROM files WHERE blob_hash=?').get(h)) continue;
      fs.rmSync(blobPath(cfg, h), { force: true });
      db.prepare('DELETE FROM blobs WHERE hash=?').run(h);
    }
    return hashes.size;
  }

  // 다운스트림 쿼터: 한도를 넘으면 감속(slow) 또는 차단
  function sendCipher(req, res, user, node, source, onBytes) {
    const q = checkTransfer(db, user, 'down', node.size, source);
    if (!q.ok && !q.slow) fail(403, 'quota_exceeded', '이번 달 다운로드 쿼터를 모두 사용했습니다');
    res.set('Cache-Control', 'no-store');
    sendBlob(req, res, cfg, node.blob_hash, {
      name: node.name,
      mime: 'application/octet-stream',
      inline: false,
      throttleBps: q.ok ? speedFor(user) : SLOW_BPS,
      onBytes: (b) => (addUsage(db, user.id, 'down', b, source), onBytes?.(b)),
    });
  }

  // ---------- 키(E-02·E-03) ----------
  app.get('/api/vault/keys', ...P, (req, res) => {
    const k = keysOf(req.user.id);
    if (!k) return res.json({ setup: false, autoLockMinutes: 5 });
    const prf = db.prepare('SELECT credential_id AS credentialId, salt, wrapped FROM vault_prf WHERE user_id=? ORDER BY created_at').all(req.user.id);
    res.json({ setup: true, salt: k.salt, iterations: k.kdf_iterations, wrappedMaster: k.wrapped_master, prf, autoLockMinutes: k.auto_lock_minutes });
  });

  // 잠금 해제(E-02·E-03): 증명값은 여기서만 받고, 이후 요청은 짧은 수명의 토큰으로 한다
  app.post('/api/vault/unlock', ...P, (req, res) => {
    const k = keysOf(req.user.id);
    if (!k) fail(409, 'vault_not_setup', '금고를 먼저 만들어 주세요');
    if (sha256(String(req.body?.proof ?? '')) !== k.proof_hash) LOCKED();
    const token = crypto.randomBytes(24).toString('base64url');
    const t = now();
    db.prepare('DELETE FROM vault_unlocks WHERE expires_at<=?').run(t);
    db.prepare('INSERT INTO vault_unlocks (token_hash, user_id, session_id, expires_at) VALUES (?,?,?,?)').run(sha256(token), req.user.id, req.sessionId, t + k.auto_lock_minutes * 60_000);
    res.status(201).json({ token, autoLockMinutes: k.auto_lock_minutes });
  });
  // 수동·자동 잠금: 화면이 토큰을 버릴 때 서버에서도 지운다(프리미엄이 끝나도 지울 수 있게 세션만 확인)
  app.post('/api/vault/lock', requireUser, sessionOnly, (req, res) => {
    db.prepare('DELETE FROM vault_unlocks WHERE token_hash=? AND user_id=?').run(sha256(String(req.get('x-vault-token') || '')), req.user.id);
    res.json({ ok: true });
  });

  const kdfBody = (b) => {
    const iterations = Number(b?.iterations);
    if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) fail(400, 'invalid_iterations', '키 유도 반복 횟수가 올바르지 않습니다');
    return { salt: enc(b.salt, 64, 'salt'), iterations, wrappedMaster: enc(b.wrappedMaster, 256, 'wrapped') };
  };

  app.post('/api/vault/setup', ...P, (req, res) => {
    const { salt, iterations, wrappedMaster } = kdfBody(req.body);
    const proof = enc(req.body.proof, 128, 'proof');
    if (keysOf(req.user.id)) fail(409, 'vault_exists', '금고가 이미 만들어져 있습니다');
    const t = now();
    db.prepare('INSERT INTO vault_keys (user_id, salt, kdf_iterations, wrapped_master, proof_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
      req.user.id,
      salt,
      iterations,
      wrappedMaster,
      sha256(proof),
      t,
      t,
    );
    res.status(201).json({ ok: true });
  });

  // 금고 초기화(패스코드 분실): 로그인을 다시 확인한 뒤 금고 파일·공유·키를 모두 영구 삭제한다.
  // 프리미엄이 끝난 사용자도 묶인 금고를 비울 수 있게 requireUser 만 건다
  app.delete('/api/vault', requireUser, sessionOnly, (req, res) => {
    const u = req.user;
    if (!rateLimit(`vault-reset:${u.id}`, 5, 15 * 60_000)) fail(429, 'too_many_requests', '잠시 후 다시 시도해 주세요');
    if (u.password_hash) {
      if (!verifyPassword(req.body?.password, u.password_hash)) fail(403, 'wrong_password', '로그인 비밀번호가 맞지 않습니다');
    } else {
      const sess = db.prepare('SELECT created_at FROM sessions WHERE id=? AND user_id=?').get(req.sessionId, u.id);
      if (!sess || now() - sess.created_at > RESET_FRESH_MS) fail(403, 'reauth_required', '보안을 위해 로그아웃 후 다시 로그인하고 10분 안에 초기화해 주세요');
    }
    const ids = db.prepare("SELECT id FROM files WHERE user_id=? AND space='vault'").all(u.id).map((r) => r.id);
    const deleted = purge(u.id, ids);
    tx(db, () => {
      db.prepare('DELETE FROM vault_shares WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM vault_prf WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM vault_unlocks WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM vault_keys WHERE user_id=?').run(u.id);
    });
    audit(db, { userId: u.id, action: 'vault.reset', detail: { files: ids.length }, ip: req.ip });
    res.json({ ok: true, files: ids.length, blobs: deleted });
  });

  // 패스코드 변경. proof·items 가 없으면 마스터키는 그대로 두고 감싼 값만 바꾼다.
  // proof·items 를 보내면 마스터키도 바꾼다(E-02): 모든 폴더 이름·파일 데이터키를 새 마스터키로 감싼 값으로 한 번에 교체하고
  // 증명값도 바꾸므로, 예전 증명값·예전 패스코드로 얻은 키로는 더 이상 금고를 쓸 수 없다. 생체인증 등록은 예전 마스터키를 감싸고 있어 모두 지운다
  // ponytail: items 는 JSON 본문 한도(2MB, 대략 파일 1만 개)까지. 더 많아지면 나눠 올리는 단계형 교체로 바꿀 것
  app.put('/api/vault/keys', ...V, (req, res) => {
    const uid = req.user.id;
    const { salt, iterations, wrappedMaster } = kdfBody(req.body);
    if (req.body.proof == null) {
      db.prepare('UPDATE vault_keys SET salt=?, kdf_iterations=?, wrapped_master=?, updated_at=? WHERE user_id=?').run(salt, iterations, wrappedMaster, now(), uid);
      return res.json({ ok: true, rotated: false });
    }
    const proof = enc(req.body.proof, 128, 'proof');
    const items = Array.isArray(req.body.items) ? req.body.items : fail(400, 'invalid_items', '다시 감싼 키 목록이 없습니다');
    const byId = new Map(items.map((x) => [x?.id, x]));
    const changed = () => fail(409, 'vault_changed', '그사이 금고 내용이 바뀌었습니다. 다시 시도해 주세요');
    tx(db, () => {
      const nodes = db.prepare("SELECT id, kind, meta FROM files WHERE user_id=? AND space='vault'").all(uid);
      if (byId.size !== items.length || items.length !== nodes.length) changed();
      const upd = db.prepare('UPDATE files SET meta=? WHERE id=? AND user_id=?');
      for (const n of nodes) {
        const x = byId.get(n.id) ?? changed();
        const m = json(n.meta, {});
        if (n.kind === 'folder') m.encName = enc(x.encName, 4096, 'name');
        else m.encKey = enc(x.encKey, 512, 'key');
        upd.run(JSON.stringify(m), n.id, uid);
      }
      db.prepare('UPDATE vault_keys SET salt=?, kdf_iterations=?, wrapped_master=?, proof_hash=?, updated_at=? WHERE user_id=?').run(salt, iterations, wrappedMaster, sha256(proof), now(), uid);
      db.prepare('DELETE FROM vault_prf WHERE user_id=?').run(uid);
      db.prepare('DELETE FROM vault_unlocks WHERE user_id=? AND token_hash<>?').run(uid, req.vaultToken); // 다른 기기·탭은 다시 잠금 해제
    });
    audit(db, { userId: uid, action: 'vault.rotate', detail: { items: items.length }, ip: req.ip });
    res.json({ ok: true, rotated: true });
  });

  // 생체인증 등록은 기기(인증기)마다 따로(E-02). 같은 인증기로 다시 등록하면 덮어쓴다
  app.put('/api/vault/prf', ...V, (req, res) => {
    const uid = req.user.id;
    const credentialId = enc(req.body?.credentialId, 1024, 'credential');
    const salt = enc(req.body.salt, 128, 'salt');
    const wrapped = enc(req.body.wrapped, 256, 'wrapped');
    const exists = db.prepare('SELECT 1 FROM vault_prf WHERE user_id=? AND credential_id=?').get(uid, credentialId);
    if (!exists && db.prepare('SELECT COUNT(*) AS n FROM vault_prf WHERE user_id=?').get(uid).n >= MAX_PRF)
      fail(400, 'too_many_devices', `생체인증은 기기 ${MAX_PRF}대까지 등록할 수 있습니다. 쓰지 않는 기기에서 먼저 꺼 주세요`);
    db.prepare(
      'INSERT INTO vault_prf (user_id, credential_id, salt, wrapped, created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id, credential_id) DO UPDATE SET salt=excluded.salt, wrapped=excluded.wrapped, created_at=excluded.created_at',
    ).run(uid, credentialId, salt, wrapped, now());
    res.json({ ok: true });
  });
  app.delete('/api/vault/prf', ...V, (req, res) => {
    const credentialId = enc(req.body?.credentialId, 1024, 'credential');
    db.prepare('DELETE FROM vault_prf WHERE user_id=? AND credential_id=?').run(req.user.id, credentialId);
    res.json({ ok: true });
  });

  app.put('/api/vault/settings', ...V, (req, res) => {
    const m = Number(req.body?.autoLockMinutes);
    if (!Number.isInteger(m) || m < 1 || m > 60) fail(400, 'invalid_minutes', '자동 잠금 시간은 1~60분입니다');
    db.prepare('UPDATE vault_keys SET auto_lock_minutes=?, updated_at=? WHERE user_id=?').run(m, now(), req.user.id);
    res.json({ autoLockMinutes: m });
  });

  // ---------- 파일(E-01·E-04) ----------
  app.get('/api/vault/usage', ...V, (req, res) => res.json({ used: usage(db, req.user.id, SPACE), total: VAULT_STORAGE }));

  app.get('/api/vault/list', ...V, (req, res) => {
    const uid = req.user.id;
    // all=1: 마스터키 교체용으로 금고 전체 항목(폴더 구조 없이)
    if (req.query.all === '1') return res.json({ items: db.prepare("SELECT * FROM files WHERE user_id=? AND space='vault'").all(uid).map(item) });
    const parentId = parentOf(req.query.parentId);
    if (parentId) requireNode(db, uid, parentId, { kind: 'folder', space: SPACE });
    const path = [];
    for (let id = parentId; id; ) {
      const n = getNode(db, uid, id);
      path.unshift({ id: n.id, encName: json(n.meta, {}).encName ?? null });
      id = n.parent_id;
    }
    res.json({ items: listChildren(db, uid, parentId, { space: SPACE }).map(item), path });
  });

  app.post('/api/vault/folders', ...V, (req, res) => {
    const encName = enc(req.body?.encName, 4096, 'name');
    const node = createFolder(db, req.user.id, parentOf(req.body.parentId), placeholder(), { space: SPACE, origin: 'upload', meta: { v: 1, encName } });
    res.status(201).json({ item: item(node) });
  });

  app.post('/api/vault/upload', ...V, async (req, res) => {
    const u = req.user;
    const source = quotaSource(req);
    const declared = Number(req.get('content-length')) || 0;
    const up = checkTransfer(db, u, 'up', declared, source);
    if (!up.ok) fail(403, 'quota_exceeded', '이번 달 업로드 쿼터를 모두 사용했습니다');
    // 미리는 가득 찼는지만 본다(content-length 에는 multipart 경계·encMeta 가 섞여 있다). 실제 크기는 maxBytes 와 받은 뒤 검사가 지킨다
    checkCapacity(db, u, 1, SPACE);
    const node = await readUpload(req, async (stream, fields) => {
      const m = json(fields.encMeta, null);
      if (!m || typeof m !== 'object') fail(400, 'invalid_meta', '암호화 정보가 없습니다');
      const meta = { v: 1, encName: enc(m.encName, 4096, 'name'), encKey: enc(m.encKey, 512, 'key'), encInfo: enc(m.encInfo, 4096, 'info') };
      const parentId = parentOf(fields.parentId);
      if (parentId) requireNode(db, u.id, parentId, { kind: 'folder', space: SPACE });
      const room = VAULT_STORAGE - usage(db, u.id, SPACE);
      const blob = await ingestStream(db, cfg, stream, 'application/octet-stream', { maxBytes: Math.max(1, room) }); // 0 은 무제한이라 최소 1
      checkCapacity(db, u, blob.size, SPACE);
      addUsage(db, u.id, 'up', blob.size, source);
      return createFileNode(db, u.id, parentId, { name: placeholder(), size: blob.size, mime: 'application/octet-stream', blobHash: blob.hash, origin: 'upload', meta, space: SPACE });
    });
    res.status(201).json({ item: item(node) });
  });

  app.get('/api/vault/files/:id/blob', ...V, (req, res) => {
    const node = requireNode(db, req.user.id, req.params.id, { kind: 'file', space: SPACE });
    sendCipher(req, res, req.user, node, quotaSource(req));
  });

  app.patch('/api/vault/files/:id', ...V, (req, res) => {
    const n = requireNode(db, req.user.id, req.params.id, { space: SPACE });
    const meta = { ...json(n.meta, {}), encName: enc(req.body?.encName, 4096, 'name') };
    db.prepare('UPDATE files SET meta=?, updated_at=? WHERE id=? AND user_id=?').run(JSON.stringify(meta), now(), n.id, req.user.id);
    res.json({ item: item(getNode(db, req.user.id, n.id)) });
  });

  app.post('/api/vault/move', ...V, (req, res) => {
    const uid = req.user.id;
    const list = ids(req.body?.ids);
    const pid = parentOf(req.body.parentId);
    const target = pid ? requireNode(db, uid, pid, { kind: 'folder', space: SPACE }) : null;
    tx(db, () => {
      for (const id of list) {
        const n = requireNode(db, uid, id, { space: SPACE });
        if (target && n.kind === 'folder' && descendantIds(db, uid, n.id).includes(target.id)) fail(400, 'invalid_move', '폴더를 자기 안으로 옮길 수 없습니다');
        db.prepare('UPDATE files SET parent_id=?, updated_at=? WHERE id=? AND user_id=?').run(target?.id ?? null, now(), n.id, uid);
      }
    });
    res.json({ ok: true });
  });

  // 금고는 휴지통을 거치지 않고 바로 영구 삭제한다. 다른 곳에서 안 쓰는 본문도 즉시 지운다
  app.delete('/api/vault/files/:id', ...V, (req, res) => {
    const uid = req.user.id;
    const n = requireNode(db, uid, req.params.id, { space: SPACE });
    res.json({ ok: true, deleted: purge(uid, descendantIds(db, uid, n.id)) });
  });

  // ---------- 암호화 공유(E-05) ----------
  app.post('/api/vault/shares', ...V, (req, res) => {
    const uid = req.user.id;
    const fileIds = ids(req.body?.fileIds, 500);
    const wrapped = {};
    for (const id of fileIds) {
      requireNode(db, uid, id, { kind: 'file', space: SPACE });
      wrapped[id] = enc(req.body.wrappedKeys?.[id], 512, 'key');
    }
    const mode = req.body.mode === 'combined' ? 'combined' : req.body.mode === 'separate' ? 'separate' : fail(400, 'invalid_mode', '공유 방식이 올바르지 않습니다');
    const days = Number(req.body.expiresDays ?? 7);
    if (!SHARE_EXPIRY_DAYS.includes(days)) fail(400, 'invalid_expiry', '유효 기간이 올바르지 않습니다');
    const token = crypto.randomBytes(18).toString('base64url');
    const id = 'vs_' + crypto.randomBytes(9).toString('base64url');
    const t = now();
    db.prepare('INSERT INTO vault_shares (id, user_id, token_hash, file_ids, wrapped_keys, mode, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id,
      uid,
      sha256(token),
      JSON.stringify(fileIds),
      JSON.stringify(wrapped),
      mode,
      days ? t + days * DAY : null,
      t,
    );
    res.status(201).json({ share: shareApi(db.prepare('SELECT * FROM vault_shares WHERE id=?').get(id)), token });
  });

  // 공유 목록·취소는 세션만으로 된다(잠금 해제·프리미엄 불필요): 프리미엄이 끝났거나 패스코드를 잊어도 공유를 거둘 수 있게
  app.get('/api/vault/shares', requireUser, sessionOnly, (req, res) => {
    const rows = db.prepare('SELECT s.*, (SELECT SUM(bytes) FROM vault_share_traffic WHERE share_id=s.id) AS sent FROM vault_shares s WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
    res.json({ items: rows.map(shareApi), dailyCopies: SHARE_DAILY_COPIES });
  });

  app.delete('/api/vault/shares/:id', requireUser, sessionOnly, (req, res) => {
    const s = db.prepare('SELECT * FROM vault_shares WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!s) fail(404, 'not_found', '공유를 찾을 수 없습니다');
    if (!s.revoked_at) db.prepare('UPDATE vault_shares SET revoked_at=? WHERE id=? AND user_id=?').run(now(), s.id, req.user.id);
    res.json({ ok: true });
  });

  // 공개: 받는 사람은 암호문·감싼 키만 받고, 키는 주소 # 뒤나 직접 입력으로 브라우저에서만 쓴다
  function openShare(req, res) {
    res.set('Cache-Control', 'no-store'); // 410(취소·만료·이용 불가)도 브라우저가 기억하지 않게
    if (!rateLimit(`vault-public:${req.ip}`, 300, 60_000)) fail(429, 'too_many_requests', '잠시 후 다시 시도해 주세요');
    const s = db.prepare('SELECT * FROM vault_shares WHERE token_hash=?').get(sha256(String(req.params.token)));
    if (!s) fail(404, 'not_found', '공유를 찾을 수 없습니다');
    if (s.revoked_at) fail(410, 'share_revoked', '공유한 사람이 공유를 취소했습니다');
    if (s.expires_at && s.expires_at <= now()) fail(410, 'share_expired', '공유 기간이 끝났습니다');
    const owner = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
    if (ownerOff(owner) || !isPremium(owner)) fail(410, 'share_unavailable', '공유한 사람의 금고를 지금은 열 수 없습니다');
    return { s, owner };
  }
  app.get('/api/vault/public/:token', (req, res) => {
    const { s } = openShare(req, res);
    const wrapped = json(s.wrapped_keys, {});
    const files = json(s.file_ids, [])
      .map((id) => getNode(db, s.user_id, id))
      .filter((n) => n && n.space === SPACE && n.kind === 'file')
      .map((n) => {
        const { id, size, encName, encInfo } = item(n);
        return { id, size, encName, encInfo, wrappedKey: wrapped[id] };
      });
    res.json({ mode: s.mode, expiresAt: s.expires_at, createdAt: s.created_at, files });
  });
  // 공개 다운로드 전송량은 공유한 사람의 다운스트림 쿼터로 센다(받는 사람은 로그인 없이 받을 수 있으므로).
  // 그래서 공유마다 하루 상한(담긴 파일 크기 × SHARE_DAILY_COPIES)을 두고, 공유 관리에 받아 간 양을 보여 준다
  app.get('/api/vault/public/:token/files/:fileId/blob', (req, res) => {
    const { s, owner } = openShare(req, res);
    const fileIds = json(s.file_ids, []);
    if (!fileIds.includes(req.params.fileId)) fail(404, 'not_found', '파일을 찾을 수 없습니다');
    const node = requireNode(db, s.user_id, req.params.fileId, { kind: 'file', space: SPACE });
    const { day } = periodKeys();
    const sent = db.prepare('SELECT bytes FROM vault_share_traffic WHERE share_id=? AND day=?').get(s.id, day)?.bytes ?? 0;
    const total = fileIds.reduce((a, id) => a + (getNode(db, s.user_id, id)?.size || 0), 0);
    if (sent + node.size > total * SHARE_DAILY_COPIES) fail(429, 'share_daily_limit', '오늘 이 공유로 받을 수 있는 양을 모두 썼습니다. 내일 다시 받아 주세요');
    const count = db.prepare('INSERT INTO vault_share_traffic (share_id, day, bytes) VALUES (?,?,?) ON CONFLICT(share_id, day) DO UPDATE SET bytes=bytes+excluded.bytes');
    sendCipher(req, res, owner, node, 'official', (b) => count.run(s.id, day, b));
  });
}
