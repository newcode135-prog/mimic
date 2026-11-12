// 신고 위치 값 → 미믹 안의 대상(금고 공유·공유 링크·파일). content(접수 때 소유자 기록)와 admin(처리)이 같이 쓴다
import { sha256, json } from '../../core/util.js';

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// 신고에 적힌 위치 값들(저작권 신고는 여러 줄)
export const valuesOf = (rep) => (rep.kind === 'copyright' ? json(rep.meta, {}).urls || rep.target.split('\n') : [rep.target]).map((x) => String(x).trim()).filter(Boolean);

// 공유 링크(…/s/<token>)·토큰·공유 코드 → share 모듈의 share_links 행(모듈이 없으면 null)
export function findShare(db, v) {
  if (!hasTable(db, 'share_links')) return null;
  const key = /\/s\/([^/?#]+)/.exec(v)?.[1] || v;
  return db.prepare('SELECT * FROM share_links WHERE token=? OR code=?').get(key, key) || null;
}
// 금고 공유 링크(…/vs/<token>#키) → vault 모듈의 vault_shares 행. 토큰은 해시로만 저장되어 있다
export function findVaultShare(db, v) {
  const token = /\/vs\/([^/?#]+)/.exec(v)?.[1];
  if (!token || !hasTable(db, 'vault_shares')) return null;
  return db.prepare('SELECT * FROM vault_shares WHERE token_hash=?').get(sha256(token)) || null;
}
// 신고 종류와 관계없이 금고 공유·공유 링크·파일 ID 를 찾는다. 파일 해시(64자 hex)는 미믹 안의 대상이 아니다
export function resolveLocal(db, v) {
  if (/^[0-9a-f]{64}$/i.test(v)) return null;
  const vs = findVaultShare(db, v);
  if (vs) return { userId: vs.user_id, fileIds: vs.file_ids, type: 'share', vaultShareId: vs.id };
  const share = findShare(db, v);
  if (share) return { userId: share.user_id, fileIds: share.file_ids, type: 'share' };
  const f = !/^[a-z]+:/i.test(v) ? db.prepare('SELECT id, user_id FROM files WHERE id=?').get(v) : null;
  return f ? { userId: f.user_id, fileIds: JSON.stringify([f.id]), type: 'file' } : null;
}
// 위치 값들의 소유자 ID(중복 없이)
export const localOwners = (db, values) => [...new Set(values.map((v) => resolveLocal(db, v)?.userId).filter(Boolean))];
