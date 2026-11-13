// G-07 텔레그램 봇: 웹에서 받은 8자리 연결 코드로 계정을 연결하고, 봇이 넘겨준 링크·파일을 "My telegram" 폴더에 저장한다.
// 봇 전용 API 는 X-Bot-Secret 헤더(env MIMIC_BOT_SECRET)로만 부를 수 있고, 값이 없으면 꺼진다.
import crypto from 'node:crypto';
import busboy from 'busboy';
import { getSettings, createSession, destroySession, createToken } from '../../core/auth.js';
import { now, sha256, fail, rateLimit } from '../../core/util.js';
import { capacityOf } from '../../core/plans.js';
import { ensureFolderPath, createFileNode, usage } from '../../core/files.js';
import { ingestStream } from '../../core/storage.js';
import { addUsage, summary } from '../../core/quota.js';
import { notify } from '../../core/notify.js';
import { userSession, revokeTokens, callApi } from './index.js';

export const telegramMigrations = `
CREATE TABLE IF NOT EXISTS integrations_telegram (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL UNIQUE,
  chat_id TEXT,
  token_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS integrations_bind_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);`;

const CODE_TTL = 10 * 60_000;
const LINK_TTL = 365 * 864e5;
export const TELEGRAM_FOLDER = 'My telegram';
// 연결 코드: 헷갈리는 글자(0·O·1·I)를 뺀 32글자 중 8자리(약 10^12 가지). 6자리 숫자는 텔레그램 계정을 여럿 쓰면 맞힐 수 있다
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const newCode = () => Array.from(crypto.randomBytes(CODE_LEN), (b) => CODE_CHARS[b % 32]).join('');
const linkAlive = (tok) => !!tok && !tok.revoked_at && !(tok.expires_at && tok.expires_at <= now());
// 봇 응답에는 계정을 가려서 보여 준다(a***@example.com, ***2222)
const maskAccount = (u) => (u.email ? u.email.replace(/^(.)[^@]*@/, '$1***@') : u.phone ? `***${u.phone.slice(-4)}` : '미믹 계정');

export function registerTelegram(app, ctx) {
  const { db, cfg } = ctx;
  const secret = () => cfg.botSecret ?? process.env.MIMIC_BOT_SECRET;

  function botOnly(req, _res, next) {
    const s = secret();
    if (!s) fail(503, 'bot_disabled', '텔레그램 봇 연동이 꺼져 있습니다');
    if (!crypto.timingSafeEqual(Buffer.from(sha256(req.get('x-bot-secret') || '')), Buffer.from(sha256(s)))) fail(401, 'bad_bot_secret', '봇 인증에 실패했습니다');
    next();
  }
  // 연결된 사용자 찾기. 연결 앱 화면에서 폐기됐거나 만료된 연결이면 같이 정리한다(목록에 없는 연결이 살아 있지 않게)
  function linkedUser(telegramUserId) {
    const row = db.prepare('SELECT * FROM integrations_telegram WHERE telegram_user_id=?').get(String(telegramUserId || ''));
    const tok = row && db.prepare('SELECT revoked_at, expires_at FROM personal_tokens WHERE id=?').get(row.token_id);
    if (!row || !linkAlive(tok)) {
      if (row) db.prepare('DELETE FROM integrations_telegram WHERE user_id=?').run(row.user_id);
      fail(404, 'not_linked', '미믹 계정이 연결되어 있지 않습니다. 웹 설정에서 연결 코드를 받아 /bind 코드 로 연결하세요');
    }
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
    if (['deleted', 'pending_delete', 'locked'].includes(u.status) || (u.status === 'suspended' && (!u.status_until || u.status_until > now()))) {
      fail(403, 'account_unavailable', '연결된 미믹 계정을 지금 쓸 수 없습니다');
    }
    // 쓰는 동안에는 만료일을 1년 뒤로 미룬다: 1년 동안 쓰지 않은 연결만 끊긴다
    db.prepare('UPDATE personal_tokens SET last_used_at=?, expires_at=? WHERE id=?').run(now(), now() + LINK_TTL, row.token_id);
    return u;
  }
  const unlink = (userId) => {
    revokeTokens(db, userId, "app_id='telegram'");
    return Number(db.prepare('DELETE FROM integrations_telegram WHERE user_id=?').run(userId).changes);
  };
  // 다른 앱에서 받은 파일 전용 폴더(설정 appFilesFolder, 기본 켜짐)
  const targetFolder = (user) => (getSettings(user).appFilesFolder === false ? null : ensureFolderPath(db, user.id, [TELEGRAM_FOLDER]));

  // ----- 웹(로그인 사용자) -----
  app.post('/api/integrations/telegram/bind-code', userSession, (req, res) => {
    db.prepare('DELETE FROM integrations_bind_codes WHERE user_id=? OR expires_at<?').run(req.user.id, now());
    let code;
    do code = newCode();
    while (db.prepare('SELECT 1 FROM integrations_bind_codes WHERE code_hash=?').get(sha256(code)));
    const expiresAt = now() + CODE_TTL;
    db.prepare('INSERT INTO integrations_bind_codes (code_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(code), req.user.id, expiresAt);
    res.status(201).json({ code, expiresAt, botUsername: cfg.telegramBotUsername || process.env.TELEGRAM_BOT_USERNAME || null });
  });
  // 다른 연동 관리 API 처럼 웹 로그인 세션에서만(토큰으로 텔레그램 ID 를 읽을 수 없게)
  app.get('/api/integrations/telegram/status', userSession, (req, res) => {
    const row = db.prepare('SELECT t.*, p.id AS tok, p.revoked_at, p.expires_at FROM integrations_telegram t LEFT JOIN personal_tokens p ON p.id=t.token_id WHERE t.user_id=?').get(req.user.id);
    const bound = !!row?.tok && linkAlive(row);
    res.json({
      enabled: !!secret(),
      botUsername: cfg.telegramBotUsername || process.env.TELEGRAM_BOT_USERNAME || null,
      bound,
      telegramUserId: bound ? row.telegram_user_id : null,
      since: bound ? row.created_at : null,
      folder: getSettings(req.user).appFilesFolder === false ? null : TELEGRAM_FOLDER,
    });
  });
  app.delete('/api/integrations/telegram', userSession, (req, res) => {
    res.json({ ok: true, removed: unlink(req.user.id) > 0 });
  });

  // ----- 봇 전용 -----
  app.post('/api/integrations/telegram/bind', botOnly, (req, res) => {
    const { code, telegramUserId, chatId } = req.body || {};
    const tgId = String(telegramUserId || '');
    const c = String(code || '').trim().toUpperCase();
    if (!/^\d{1,20}$/.test(tgId) || !new RegExp(`^[${CODE_CHARS}]{${CODE_LEN}}$`).test(c)) fail(400, 'invalid_input', `연결 코드 ${CODE_LEN}자리를 확인해 주세요`);
    if (!rateLimit(`tg-bind:${tgId}`, 5, CODE_TTL)) fail(429, 'too_many_attempts', '시도 횟수를 넘었습니다. 잠시 뒤에 다시 해 주세요');
    const row = db.prepare('SELECT * FROM integrations_bind_codes WHERE code_hash=? AND expires_at>?').get(sha256(c), now());
    if (!row) fail(400, 'invalid_code', '코드가 틀렸거나 10분이 지났습니다. 웹 설정에서 새 코드를 받아 주세요');
    db.prepare('DELETE FROM integrations_bind_codes WHERE code_hash=?').run(row.code_hash);
    const other = db.prepare('SELECT user_id FROM integrations_telegram WHERE telegram_user_id=?').get(tgId);
    if (other) unlink(other.user_id);
    unlink(row.user_id);
    // 연결 앱 목록에 보이고 거기서 해제할 수 있도록 토큰 기록을 남긴다(원문은 버림)
    const { id } = createToken(db, row.user_id, { name: `텔레그램 ${tgId}`, scopes: ['files:write', 'services'], appId: 'telegram', days: 365 });
    db.prepare('INSERT INTO integrations_telegram (user_id, telegram_user_id, chat_id, token_id, created_at) VALUES (?,?,?,?,?)').run(row.user_id, tgId, chatId == null ? null : String(chatId), id, now());
    notify(db, row.user_id, {
      kind: 'telegram',
      title: '텔레그램 봇이 연결되었습니다',
      body: '봇에게 보낸 링크와 파일이 미믹 드라이브에 저장됩니다.',
      titleEn: 'Telegram bot connected',
      bodyEn: 'Links and files you send to the bot will be saved to your Mimic drive.',
      link: '/drive/settings/integrations',
    });
    res.json({ ok: true, account: maskAccount(db.prepare('SELECT email, phone FROM users WHERE id=?').get(row.user_id)) });
  });
  app.post('/api/integrations/telegram/unbind', botOnly, (req, res) => {
    const row = db.prepare('SELECT user_id FROM integrations_telegram WHERE telegram_user_id=?').get(String(req.body?.telegramUserId || ''));
    res.json({ ok: true, removed: row ? unlink(row.user_id) > 0 : false });
  });
  app.post('/api/integrations/telegram/quota', botOnly, (req, res) => {
    const u = linkedUser(req.body?.telegramUserId);
    res.json({ quota: summary(db, u), storage: { used: usage(db, u.id), total: capacityOf(u) } });
  });
  // 링크 → 클라우드 다운로드 작업(offline 모듈 API). 텔레그램 봇은 미믹 공식 앱이라 잠깐 쓰는 세션으로 부른다
  app.post('/api/integrations/telegram/links', botOnly, async (req, res) => {
    const u = linkedUser(req.body?.telegramUserId);
    const urls = Array.isArray(req.body?.urls) ? req.body.urls.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 50) : [];
    if (!urls.length) fail(400, 'no_urls', '저장할 링크가 없습니다');
    const parentId = targetFolder(u);
    const relay = createSession(db, u.id, null, 'telegram');
    try {
      res.json({ ...(await callApi(ctx, relay, 'POST', '/api/offline/tasks', { urls, parentId })), folderId: parentId });
    } finally {
      destroySession(db, relay);
    }
  });
  // 파일 → "My telegram" 폴더. multipart 필드 telegramUserId 를 파일보다 먼저 보낸다(또는 X-Telegram-User-Id 헤더)
  app.post('/api/integrations/telegram/upload', botOnly, async (req, res) => {
    if (!(req.get('content-type') || '').includes('multipart/form-data')) fail(400, 'multipart_required', 'multipart/form-data 로 보내 주세요');
    let tgId = req.get('x-telegram-user-id') || null;
    let saving = null;
    const bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1 } });
    await new Promise((resolve, reject) => {
      bb.on('field', (name, val) => name === 'telegramUserId' && (tgId = val));
      bb.on('file', (_name, stream, info) => {
        saving = (async () => {
          const u = linkedUser(tgId);
          // 남은 월 업로드 쿼터를 상한으로 받는다(drive 업로드와 같게, 한도를 넘겨 올릴 수 없음)
          const up = summary(db, u).month.up;
          const upLeft = up.limit - up.used;
          if (upLeft <= 0) fail(403, 'upload_quota', '이번 달 업로드 쿼터를 모두 사용했습니다');
          const free = capacityOf(u) - usage(db, u.id);
          if (free <= 0) fail(403, 'storage_full', '저장 공간이 부족합니다');
          const mime = info.mimeType || 'application/octet-stream';
          const blob = await ingestStream(db, cfg, stream, mime, { maxBytes: Math.min(free, upLeft) }).catch((e) => {
            if (e.code === 'storage_full' && upLeft < free) fail(403, 'upload_quota', '이번 달 남은 업로드 쿼터보다 큰 파일입니다');
            throw e;
          });
          addUsage(db, u.id, 'up', blob.size, 'official');
          const name = (info.filename || '').trim() || `telegram_${now()}`;
          return createFileNode(db, u.id, targetFolder(u), { name, size: blob.size, mime, blobHash: blob.hash, origin: 'telegram' });
        })();
        saving.catch((e) => {
          stream.resume();
          reject(e);
        });
      });
      bb.on('close', resolve);
      bb.on('error', reject);
      req.pipe(bb);
    });
    if (!saving) fail(400, 'no_file', '파일이 없습니다');
    const node = await saving;
    res.status(201).json({ file: { id: node.id, name: node.name, size: node.size, parentId: node.parent_id } });
  });
}
