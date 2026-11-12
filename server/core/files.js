// 드라이브 노드(폴더·파일) 공통 헬퍼. 이동·삭제·휴지통 같은 사용자 동작 API 는 drive 모듈이 담당한다.
import { now, newId, fail, json } from './util.js';
import { capacityOf, VAULT_STORAGE } from './plans.js';

export function toApi(n) {
  if (!n) return null;
  return {
    id: n.id,
    parentId: n.parent_id,
    kind: n.kind,
    name: n.name,
    size: n.size,
    mime: n.mime,
    hash: n.blob_hash,
    starred: !!n.starred,
    trashedAt: n.trashed_at,
    origin: n.origin,
    space: n.space,
    meta: json(n.meta, {}),
    createdAt: n.created_at,
    updatedAt: n.updated_at,
  };
}

export function validName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  return n.length > 0 && n.length <= 255 && n !== '.' && n !== '..' && !/[\\/\u0000]/.test(n);
}

export function getNode(db, userId, id) {
  return db.prepare('SELECT * FROM files WHERE id=? AND user_id=?').get(id, userId) ?? null;
}
export function requireNode(db, userId, id, { kind, space, allowTrashed = false } = {}) {
  const n = id ? getNode(db, userId, id) : null;
  if (!n || (kind && n.kind !== kind) || (space && n.space !== space) || (!allowTrashed && n.trashed_at)) {
    fail(404, 'not_found', '파일을 찾을 수 없습니다');
  }
  return n;
}

export function listChildren(db, userId, parentId, { space = 'drive' } = {}) {
  return db
    .prepare('SELECT * FROM files WHERE user_id=? AND parent_id IS ? AND space=? AND trashed_at IS NULL')
    .all(userId, parentId ?? null, space);
}

// 같은 폴더에 같은 이름이 있으면 "이름 (1).확장자" 형태로 바꾼다
export function uniqueName(db, userId, parentId, name, space = 'drive') {
  const taken = new Set(
    db.prepare('SELECT name FROM files WHERE user_id=? AND parent_id IS ? AND space=? AND trashed_at IS NULL').all(userId, parentId ?? null, space).map((r) => r.name),
  );
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const c = `${base} (${i})${ext}`;
    if (!taken.has(c)) return c;
  }
}

function insert(db, userId, parentId, { kind, name, size = 0, mime = null, blobHash = null, origin = null, meta = {}, space = 'drive' }) {
  if (!validName(name)) fail(400, 'invalid_name', '사용할 수 없는 이름입니다');
  if (parentId) requireNode(db, userId, parentId, { kind: 'folder', space });
  const id = newId('f_');
  const t = now();
  db.prepare(
    'INSERT INTO files (id, user_id, parent_id, space, kind, name, size, mime, blob_hash, origin, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, parentId ?? null, space, kind, uniqueName(db, userId, parentId, name.trim(), space), size, mime, blobHash, origin, JSON.stringify(meta), t, t);
  return getNode(db, userId, id);
}
export const createFolder = (db, userId, parentId, name, opts = {}) => insert(db, userId, parentId, { ...opts, kind: 'folder', name });
export const createFileNode = (db, userId, parentId, opts) => insert(db, userId, parentId, { ...opts, kind: 'file' });

// 루트부터 이름으로 폴더 경로를 찾고 없으면 만든다. 예: ensureFolderPath(db, uid, ['My telegram'])
export function ensureFolderPath(db, userId, names, space = 'drive') {
  let parent = null;
  for (const name of names) {
    const ex = db
      .prepare("SELECT id FROM files WHERE user_id=? AND parent_id IS ? AND space=? AND kind='folder' AND name=? AND trashed_at IS NULL")
      .get(userId, parent, space, name);
    parent = ex ? ex.id : createFolder(db, userId, parent, name, { space }).id;
  }
  return parent;
}

// 휴지통에 있는 파일도 영구 삭제 전까지는 용량에 포함된다(B-02)
export function usage(db, userId, space = 'drive') {
  return Number(db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM files WHERE user_id=? AND space=? AND kind='file'").get(userId, space).n);
}
export function checkCapacity(db, user, addBytes, space = 'drive') {
  const cap = space === 'vault' ? VAULT_STORAGE : capacityOf(user);
  if (usage(db, user.id, space) + addBytes > cap) fail(403, 'storage_full', '저장 공간이 부족합니다');
}

export function pathOf(db, userId, id) {
  const out = [];
  let cur = id ? getNode(db, userId, id) : null;
  while (cur) {
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? getNode(db, userId, cur.parent_id) : null;
  }
  return out;
}

export function descendantIds(db, userId, id) {
  return db
    .prepare('WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM files f JOIN t ON f.parent_id = t.id WHERE f.user_id = ?) SELECT id FROM t')
    .all(id, userId)
    .map((r) => r.id);
}

// 폴더·파일을 (다른 사용자에게도) 복사한다. 본문은 같은 blob 을 참조하므로 디스크를 더 쓰지 않는다
export function copyTree(db, srcUserId, srcId, dstUserId, dstParentId, { origin = 'copy', space = 'drive' } = {}) {
  const src = requireNode(db, srcUserId, srcId);
  const root = insert(db, dstUserId, dstParentId, {
    kind: src.kind,
    name: src.name,
    size: src.size,
    mime: src.mime,
    blobHash: src.blob_hash,
    origin,
    meta: json(src.meta, {}),
    space,
  });
  if (src.kind === 'folder') {
    for (const child of listChildren(db, srcUserId, src.id, { space: src.space })) copyTree(db, srcUserId, child.id, dstUserId, root.id, { origin, space });
  }
  return root;
}

export function treeSize(db, userId, id) {
  const ids = descendantIds(db, userId, id);
  const q = db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM files WHERE id=? AND kind='file'");
  return ids.reduce((s, x) => s + Number(q.get(x).n), 0);
}
