// G-01 WebDAV: 프리미엄 + 설정에서 켠 사용자만. 앱 비밀번호(appId 'webdav' 토큰)로 Basic 인증.
// 삭제는 휴지통 이동만 한다(영구삭제·휴지통 비우기 불가). 전송량은 연결 앱 쿼터(source 'app', F-05)로 센다.
import crypto from 'node:crypto';
import { sha256, now, fail, json } from '../../core/util.js';
import { getSettings, hasScope } from '../../core/auth.js';
import { tx } from '../../core/db.js';
import { isPremium, capacityOf, speedFor, SLOW_BPS } from '../../core/plans.js';
import { createFolder, createFileNode, listChildren, usage, copyTree, treeSize, descendantIds, validName } from '../../core/files.js';
import { ingestStream, sendBlob } from '../../core/storage.js';
import { checkTransfer, addUsage } from '../../core/quota.js';
import { userSession, issueKey, revokeTokens } from './index.js';

const METHODS = 'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, MKCOL, MOVE, COPY, DELETE, LOCK, UNLOCK';
const MIME = { mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', srt: 'text/plain', json: 'application/json', zip: 'application/zip', torrent: 'application/x-bittorrent' };
const guessMime = (name, ct) => (ct && ct !== 'application/octet-stream' ? ct.split(';')[0] : MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream');
const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const hrefOf = (segs, dir) => '/webdav/' + segs.map(encodeURIComponent).join('/') + (dir && segs.length ? '/' : '');

export const webdavUsername = (u) => u.email || u.phone || u.id;

function authenticate(db, req) {
  const m = /^Basic\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const i = raw.indexOf(':');
  const name = raw.slice(0, i).trim();
  const pass = raw.slice(i + 1);
  if (i < 0 || !name || !pass) return null;
  const u = db.prepare('SELECT * FROM users WHERE id=? OR email=? COLLATE NOCASE OR phone=?').get(name, name, name);
  if (!u || ['deleted', 'pending_delete', 'locked'].includes(u.status)) return null;
  const tok = db.prepare("SELECT * FROM personal_tokens WHERE user_id=? AND app_id='webdav' AND token_hash=? AND revoked_at IS NULL").get(u.id, sha256(pass));
  if (!tok || (tok.expires_at && tok.expires_at <= now())) return null;
  db.prepare('UPDATE personal_tokens SET last_used_at=? WHERE id=?').run(now(), tok.id);
  return { user: u, token: tok };
}

// 이름 경로 → 노드. null = 루트, undefined = 없음
function resolve(db, uid, segs) {
  const q = db.prepare("SELECT * FROM files WHERE user_id=? AND parent_id IS ? AND space='drive' AND trashed_at IS NULL AND name=?");
  let node = null;
  for (const name of segs) {
    node = q.get(uid, node ? node.id : null, name);
    if (!node) return undefined;
  }
  return node;
}
const parseSegs = (p) => p.split('/').filter(Boolean).map(decodeURIComponent);
function destSegs(req) {
  try {
    const p = new URL(req.get('destination') || '', 'http://x').pathname;
    return p.startsWith('/webdav/') ? parseSegs(p.slice(8)) : null;
  } catch {
    return null;
  }
}

// 휴지통으로 이동(drive 의 휴지통과 같은 표시: 직접 넣은 항목 trash_root=1, 하위 항목은 같은 시각). 부르는 쪽이 tx 로 감싼다
function moveToTrash(db, uid, node) {
  const t = now();
  const up = db.prepare('UPDATE files SET trashed_at=?, trash_root=? WHERE id=? AND user_id=? AND trashed_at IS NULL');
  descendantIds(db, uid, node.id).forEach((id) => up.run(t, id === node.id ? 1 : 0, id, uid));
}

function propEntry(segs, node, quota) {
  const dir = !node || node.kind === 'folder';
  const p = [
    `<D:displayname>${xmlEsc(node ? node.name : '미믹')}</D:displayname>`,
    `<D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype>`,
    `<D:getlastmodified>${new Date(node?.updated_at ?? now()).toUTCString()}</D:getlastmodified>`,
    `<D:creationdate>${new Date(node?.created_at ?? now()).toISOString()}</D:creationdate>`,
    '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>',
  ];
  if (!dir) {
    p.push(`<D:getcontentlength>${node.size}</D:getcontentlength>`, `<D:getcontenttype>${xmlEsc(node.mime || 'application/octet-stream')}</D:getcontenttype>`);
    p.push(`<D:getetag>"${node.blob_hash || node.id}-${node.updated_at}"</D:getetag>`);
  } else if (quota) p.push(`<D:quota-used-bytes>${quota.used}</D:quota-used-bytes>`, `<D:quota-available-bytes>${quota.free}</D:quota-available-bytes>`);
  return `<D:response><D:href>${xmlEsc(hrefOf(segs, dir))}</D:href><D:propstat><D:prop>${p.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}
const multistatus = (res, parts, ns = '') =>
  res.status(207).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"${ns}>${parts.join('')}</D:multistatus>`);

// 이번 GET 이 보낼 바이트 수(Range 하나면 그 길이, 아니면 파일 전체)
function requestLength(req, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') || '');
  if (!m) return size;
  if (m[1] === '') return Math.min(size, Number(m[2] || 0));
  return Math.max(0, Math.min(size - 1, m[2] ? Number(m[2]) : size - 1) - Number(m[1]) + 1);
}

async function readText(req, max = 65536) {
  let s = '';
  for await (const c of req) if ((s += c).length > max) break;
  return s;
}

export function registerWebdav(app, ctx) {
  const { db, cfg } = ctx;

  // 설정 화면용: WebDAV 상태와 앱 비밀번호 발급(1회 표시)
  app.get('/api/integrations/webdav', userSession, (req, res) => {
    const u = req.user;
    const tok = db.prepare("SELECT created_at, last_used_at, expires_at FROM personal_tokens WHERE user_id=? AND app_id='webdav' AND revoked_at IS NULL ORDER BY created_at DESC").get(u.id);
    const password = tok && { createdAt: tok.created_at, lastUsedAt: tok.last_used_at, expiresAt: tok.expires_at, expired: !!tok.expires_at && tok.expires_at <= now() };
    res.json({ premium: isPremium(u), enabled: !!getSettings(u).webdavEnabled, path: '/webdav/', username: webdavUsername(u), password: password || null });
  });
  app.post('/api/integrations/webdav/password', userSession, (req, res) => {
    if (!isPremium(req.user)) fail(403, 'premium_required', 'WebDAV 는 프리미엄 전용입니다');
    revokeTokens(db, req.user.id, "app_id='webdav'");
    // mp_ 토큰이 아닌 mw_ 비밀번호: 공통 인증(loadUser)이 Bearer 로 받지 않아 /webdav 밖의 /api 에서는 쓸 수 없다
    const k = issueKey(ctx, req, { name: 'WebDAV 앱 비밀번호', scopes: ['files:manage'], appId: 'webdav', days: 365, prefix: 'mw_' });
    res.status(201).json({ password: k.token, username: webdavUsername(req.user), path: '/webdav/', expiresAt: k.expiresAt });
  });

  app.use('/webdav', async (req, res) => {
    res.set({ DAV: '1, 2', 'MS-Author-Via': 'DAV', Allow: METHODS });
    if (req.method === 'OPTIONS') return res.status(200).end();
    const auth = authenticate(db, req);
    if (!auth) {
      return res.status(401).set('WWW-Authenticate', 'Basic realm="Mimic WebDAV", charset="UTF-8"').json({ error: 'login_required', message: '이메일(또는 휴대폰·사용자 ID)과 WebDAV 앱 비밀번호로 로그인하세요' });
    }
    const user = auth.user;
    const uid = user.id;
    if (user.status === 'suspended' && (!user.status_until || user.status_until > now())) fail(403, 'account_suspended', '계정이 일시 정지되었습니다');
    if (!isPremium(user)) fail(403, 'premium_required', 'WebDAV 는 프리미엄 전용입니다');
    if (!getSettings(user).webdavEnabled) fail(403, 'webdav_disabled', '설정 > 액세스 및 통합에서 WebDAV 를 먼저 켜 주세요');
    const need = (scope) => {
      if (!hasScope({ scopes: json(auth.token.scopes, []) }, scope)) fail(403, 'insufficient_scope', `이 비밀번호에는 ${scope} 권한이 없습니다`);
    };

    let segs;
    try {
      segs = parseSegs(req.path);
    } catch {
      fail(400, 'bad_path', '잘못된 경로입니다');
    }
    const node = resolve(db, uid, segs);
    const parentOf = (s) => resolve(db, uid, s.slice(0, -1));
    const isFolderOrRoot = (n) => n === null || n?.kind === 'folder';

    switch (req.method) {
      case 'PROPFIND': {
        need('files:read');
        if (node === undefined) return res.status(404).end();
        const used = usage(db, uid);
        const quota = { used, free: Math.max(0, capacityOf(user) - used) };
        const parts = [propEntry(segs, node, quota)];
        if (req.get('depth') !== '0' && isFolderOrRoot(node)) {
          for (const c of listChildren(db, uid, node?.id ?? null)) parts.push(propEntry([...segs, c.name], c, quota));
        }
        return multistatus(res, parts);
      }
      case 'PROPPATCH': {
        // Windows 탐색기가 파일 시각을 바꾸려고 보낸다. 저장하지 않고 성공으로 응답한다
        need('files:write');
        if (node === undefined) return res.status(404).end();
        const names = [...new Set([...(await readText(req)).matchAll(/<(?:[\w-]+:)?(Win32\w+)/g)].map((m) => m[1]))];
        const props = names.map((n) => `<Z:${n}/>`).join('');
        return multistatus(
          res,
          [`<D:response><D:href>${xmlEsc(hrefOf(segs, isFolderOrRoot(node)))}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`],
          ' xmlns:Z="urn:schemas-microsoft-com:"',
        );
      }
      case 'GET':
      case 'HEAD': {
        need('files:read');
        if (node === undefined) return res.status(404).end();
        if (isFolderOrRoot(node)) {
          const names = listChildren(db, uid, node?.id ?? null).map((c) => c.name + (c.kind === 'folder' ? '/' : ''));
          return res.type('text/plain; charset=utf-8').send(names.join('\n'));
        }
        if (!node.blob_hash) return res.status(200).set('Content-Length', '0').end();
        // 연결 앱 다운로드 한도를 넘으면 막지 않고 약 100KB/s 로 감속(F-05). drive 처럼 요청한 길이로 검사해 한도를 넘길 요청은 처음부터 감속
        const q = req.method === 'GET' ? checkTransfer(db, user, 'down', requestLength(req, node.size), 'app') : { ok: true };
        const slow = !q.ok;
        if (slow) res.set('X-Mimic-Throttled', q.reason);
        return sendBlob(req, res, cfg, node.blob_hash, {
          name: node.name,
          mime: node.mime,
          inline: false,
          throttleBps: slow ? SLOW_BPS : speedFor(user),
          onBytes: (n) => addUsage(db, uid, 'down', n, 'app'),
        });
      }
      case 'PUT': {
        need('files:write');
        const parent = parentOf(segs);
        if (!segs.length || node?.kind === 'folder') return res.status(405).end();
        if (parent === undefined || !isFolderOrRoot(parent)) return res.status(409).end();
        const name = segs.at(-1);
        if (!validName(name)) fail(400, 'invalid_name', '사용할 수 없는 이름입니다');
        if (node) need('files:manage'); // 덮어쓰기는 이전 내용을 휴지통으로 보낸다
        // ponytail: 공통 본문 해석기(express.json·urlencoded)가 먼저 읽은 본문은 원래 바이트로 되살릴 수 없어 거절한다(다시 직렬화하면 내용이 바뀜). 코어가 /webdav 를 건너뛰면 필요 없음
        if (req.body !== undefined) fail(415, 'unsupported_content_type', 'WebDAV 로 올릴 때는 Content-Type 을 application/octet-stream 으로 보내 주세요');
        // 연결 앱 업로드 한도를 넘으면 업로드 차단(F-05). 길이를 모르는(chunked) 업로드는 받은 뒤 한 번 더 확인한다
        const appOk = (n) => checkTransfer(db, user, 'up', n, 'app').ok;
        const len = Number(req.get('content-length') || 0);
        if (!appOk(len)) fail(403, 'app_quota', '연결 앱 업로드 한도를 넘어 업로드할 수 없습니다');
        const free = capacityOf(user) - usage(db, uid); // 휴지통도 용량에 들어가므로 덮어쓸 파일 크기를 빼 주지 않는다
        if (len > free || (free <= 0 && len > 0)) return res.status(507).end();
        const mime = guessMime(name, req.get('content-type'));
        const blob = await ingestStream(db, cfg, req, mime, { maxBytes: Math.max(free, 1) });
        if (!appOk(blob.size)) fail(403, 'app_quota', '연결 앱 업로드 한도를 넘어 업로드할 수 없습니다'); // 남은 본문은 gcBlobs 가 치운다
        addUsage(db, uid, 'up', blob.size, 'app');
        tx(db, () => {
          if (node) moveToTrash(db, uid, node); // 이전 내용을 지우지 않고 휴지통에 남긴다(영구삭제 불가)
          createFileNode(db, uid, parent?.id ?? null, { name, size: blob.size, mime, blobHash: blob.hash, origin: 'upload', meta: { via: 'webdav' } });
        });
        return res.status(node ? 204 : 201).end();
      }
      case 'MKCOL': {
        need('files:write');
        if (node !== undefined) return res.status(405).end();
        const parent = parentOf(segs);
        if (parent === undefined || !isFolderOrRoot(parent)) return res.status(409).end();
        createFolder(db, uid, parent?.id ?? null, segs.at(-1));
        return res.status(201).end();
      }
      case 'MOVE':
      case 'COPY': {
        need('files:write');
        if (node === undefined) return res.status(404).end();
        const dest = destSegs(req);
        if (!node || !dest?.length) return res.status(403).end();
        const dParent = parentOf(dest);
        if (dParent === undefined || !isFolderOrRoot(dParent)) return res.status(409).end();
        const dName = dest.at(-1);
        if (!validName(dName)) fail(400, 'invalid_name', '사용할 수 없는 이름입니다');
        if (node.kind === 'folder' && dParent && descendantIds(db, uid, node.id).includes(dParent.id)) return res.status(403).end();
        const existing = resolve(db, uid, dest);
        if (existing?.id === node.id) return res.status(403).end();
        if (existing) {
          if ((req.get('overwrite') || 'T').toUpperCase() === 'F') return res.status(412).end();
          // 덮어쓸 대상이 원본의 상위 폴더면 원본까지 휴지통에 들어가 데이터를 잃는다
          if (descendantIds(db, uid, existing.id).includes(node.id)) return res.status(403).end();
          need('files:manage');
        }
        // 휴지통도 용량에 들어가므로 덮어쓸 대상을 휴지통에 넣기 전에 검사해도 같다
        if (req.method === 'COPY' && usage(db, uid) + (node.kind === 'folder' ? treeSize(db, uid, node.id) : node.size) > capacityOf(user)) return res.status(507).end();
        tx(db, () => {
          if (existing) moveToTrash(db, uid, existing); // 덮어쓰기도 영구삭제 대신 휴지통으로
          if (req.method === 'MOVE') {
            db.prepare('UPDATE files SET parent_id=?, name=?, updated_at=? WHERE id=? AND user_id=?').run(dParent?.id ?? null, dName, now(), node.id, uid);
          } else {
            const copy = copyTree(db, uid, node.id, uid, dParent?.id ?? null, { origin: 'copy' });
            db.prepare('UPDATE files SET name=? WHERE id=? AND user_id=?').run(dName, copy.id, uid);
          }
        });
        return res.status(existing ? 204 : 201).end();
      }
      case 'DELETE': {
        need('files:manage');
        if (node === undefined) return res.status(404).end();
        if (node === null) return res.status(403).end(); // 루트 전체 삭제·휴지통 비우기는 지원하지 않음
        tx(db, () => moveToTrash(db, uid, node));
        return res.status(204).end();
      }
      case 'LOCK': {
        // 실제 잠금은 하지 않는다. Windows 탐색기·macOS Finder·Office 가 쓰기 전에 요구하는 최소 응답
        const lock = `opaquelocktoken:${crypto.randomUUID()}`;
        return res
          .status(200)
          .set('Lock-Token', `<${lock}>`)
          .type('application/xml; charset=utf-8')
          .send(
            `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>${req.get('depth') === '0' ? '0' : 'infinity'}</D:depth><D:owner/><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${lock}</D:href></D:locktoken><D:lockroot><D:href>${xmlEsc(hrefOf(segs, isFolderOrRoot(node)))}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`,
          );
      }
      case 'UNLOCK':
        return res.status(204).end();
      default:
        return res.status(405).end();
    }
  });
}
