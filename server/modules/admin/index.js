// 관리자 백오피스 API(K-06): 통계, 회원 관리, 차단 목록, 신고 처리, 문의 답변, 공지 알림, 감사 로그, 쿼터 정책.
// 다른 모듈의 관리자 API(결제·쿠폰·이의제기 등)는 각 모듈이 /api/admin/<모듈>/* 에 둔다.
import fs from 'node:fs';
import { requireAdmin, publicUser } from '../../core/auth.js';
import { now, newId, fail, json, DAY } from '../../core/util.js';
import { valuesOf, resolveLocal as locate } from '../content/locate.js';
import { tx } from '../../core/db.js';
import { notify, audit, sendMessage } from '../../core/notify.js';
import { usage } from '../../core/files.js';
import { grant, summary } from '../../core/quota.js';
import { LIMITS, MONTHLY_QUOTA, APP_QUOTA_SHARE, FREE_APP_DAILY_DOWN, SLOW_BPS, SPEED_BPS, TRASH_DAYS, SIGNUP_BONUS_CLOUD, VAULT_STORAGE, SHARE_EXPIRY_DAYS, BT_MAX_FILES, PRODUCTS, REFERRAL, EXPIRY, DORMANT, ACCOUNT_DELETE_GRACE_DAYS } from '../../core/plans.js';

const PAGE = 20;
const BLOCK_KINDS = ['url', 'domain', 'infohash', 'blob'];
const QUOTA_KINDS = ['cloud', 'down', 'up', 'cloud_count'];
const RESOLVE_ACTIONS = ['dismiss', 'block', 'suspend', 'unblock'];
const REASON_KO = { copyright: '저작권 침해', child: '아동 보호', illegal_filming: '불법 촬영물', adult: '음란물', violence: '폭력·혐오', malware: '악성코드·피싱', spam: '스팸·사기', privacy: '개인정보 노출', other: '기타' };
const REASON_EN = { copyright: 'copyright infringement', child: 'child safety', illegal_filming: 'non-consensual imagery', adult: 'sexual content', violence: 'violence or hate', malware: 'malware or phishing', spam: 'spam or scam', privacy: 'exposure of personal information', other: 'other' };
const LABEL_EN = { report: 'report', copyright: 'copyright notice', appeal: 'appeal' };
const hostOf = (v) => {
  try {
    return new URL(v).host.toLowerCase();
  } catch {
    return null;
  }
};

const intIn = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
function int(v, field, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) fail(400, 'invalid_' + field, `${field} 는 ${lo}~${hi} 사이 정수여야 합니다`);
  return v;
}

// 32자 base32 infohash → 40자 hex
function base32ToHex(s) {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  const bits = [...s].map((c) => A.indexOf(c).toString(2).padStart(5, '0')).join('');
  return bits.match(/.{4}/g).map((b) => parseInt(b, 2).toString(16)).join('');
}
function normInfohash(v) {
  const s = v.toLowerCase();
  if (/^[0-9a-f]{40}$/.test(s)) return s;
  if (/^[a-z2-7]{32}$/.test(s)) return base32ToHex(s);
  return null;
}
// 차단 값 정리. 마그넷 URL 은 infohash 로 바꿔 저장한다(offline 모듈이 infohash 로 비교)
export function normBlock(kind, value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || v.length > 4096) fail(400, 'invalid_value', '차단할 값을 입력하세요');
  if (kind === 'url') {
    if (/^magnet:/i.test(v)) {
      const m = /xt=urn:btih:([0-9a-z]+)/i.exec(v);
      const h = m && normInfohash(m[1]);
      if (!h) fail(400, 'invalid_value', '마그넷 링크에서 infohash 를 찾지 못했습니다');
      return { kind: 'infohash', value: h };
    }
    // offline 모듈은 비교할 때 양쪽 주소를 모두 정규화한다(engine.js blockForm). 저장은 목록 표시·중복 확인용으로
    // new URL().href 에서 '#조각'과 빈 '?' 만 뗀 모양으로 한다(서버가 받는 요청은 같다)
    let href = null;
    try {
      if (/^(https?|ftp):\/\/\S+$/i.test(v)) {
        const u = new URL(v);
        u.hash = '';
        if (!u.search) u.search = '';
        href = u.href;
      }
    } catch {}
    if (!href) fail(400, 'invalid_value', 'http(s) 주소나 마그넷 링크를 입력하세요');
    return { kind, value: href };
  }
  if (kind === 'domain') {
    let host;
    try {
      host = new URL(v.includes('://') ? v : `http://${v}`).hostname.toLowerCase();
    } catch {}
    if (!host || !host.includes('.')) fail(400, 'invalid_value', '도메인을 확인하세요');
    return { kind, value: host };
  }
  if (kind === 'infohash') {
    const h = normInfohash(v);
    if (!h) fail(400, 'invalid_value', 'infohash 는 40자 hex 또는 32자 base32 입니다');
    return { kind, value: h };
  }
  if (kind === 'blob') {
    if (!/^[0-9a-f]{64}$/i.test(v)) fail(400, 'invalid_value', '파일 해시는 64자 SHA-256 hex 입니다');
    return { kind, value: v.toLowerCase() };
  }
  fail(400, 'invalid_kind', `종류는 ${BLOCK_KINDS.join('·')} 중 하나입니다`);
}

const safeLink = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (s.length > 500 || !(/^\/(?!\/)/.test(s) || /^https?:\/\//i.test(s))) fail(400, 'invalid_link', '링크는 / 로 시작하는 주소나 http(s) 주소여야 합니다');
  return s;
};

function adminUser(u, extra = {}) {
  return { ...publicUser(u), statusUntil: u.status_until, lastLoginAt: u.last_login_at, deleteRequestedAt: u.delete_requested_at, ...extra };
}

export const migrations = `CREATE TABLE IF NOT EXISTS admin_meta (k TEXT PRIMARY KEY, v TEXT);`;

// ---------- 데이터 디스크 경보·가입 멈춤(Q-5) ----------
// 프리미엄 표시 용량(10TB)은 그대로 두고, 실제 디스크가 차면 관리자에게 알리고 새 가입을 멈춘다.
// mode: 'auto'(사용률로 자동) · 'pause'(관리자가 멈춤) · 'resume'(관리자가 엶). autoPaused 는 자동 판단 결과
const envPct = (name, dflt) => {
  const v = Number(process.env[name]);
  return v > 0 && v <= 100 ? v : dflt;
};
export function diskLimits() {
  const alertPct = envPct('MIMIC_DISK_ALERT_PCT', 80);
  return { alertPct, resumePct: envPct('MIMIC_DISK_RESUME_PCT', 75), urgentPct: Math.max(90, alertPct) };
}
const readDisk = (db) => json(db.prepare("SELECT v FROM admin_meta WHERE k='disk'").get()?.v, {});
const saveDisk = (db, d) => db.prepare("INSERT INTO admin_meta (k, v) VALUES ('disk', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(d));
const pausedOf = (d) => d.mode === 'pause' || (d.mode !== 'resume' && !!d.autoPaused);
// auth 모듈이 ctx.modules.admin.signupPaused(db) 로 가입 직전에 확인한다
export const signupPaused = (db) => pausedOf(readDisk(db));
export function diskStatus(db) {
  const d = readDisk(db);
  return { pct: d.pct ?? null, totalBytes: d.totalBytes ?? null, freeBytes: d.freeBytes ?? null, checkedAt: d.checkedAt ?? null, mode: d.mode || 'auto', autoPaused: !!d.autoPaused, signupPaused: pausedOf(d), ...diskLimits() };
}
export function setDiskMode(db, mode) {
  saveDisk(db, { ...readDisk(db), mode });
}

const gb = (b) => `${(b / 1024 ** 3).toFixed(1)}GB`;
function alertAdmins(db, cfg, { title, titleEn, body, bodyEn }) {
  for (const u of db.prepare("SELECT id, email, lang FROM users WHERE is_admin=1 AND status NOT IN ('deleted','pending_delete')").all()) {
    notify(db, u.id, { kind: 'admin', title, titleEn, body, bodyEn, link: '/admin/dashboard' });
    const en = u.lang === 'en';
    if (u.email) sendMessage(db, cfg, { channel: 'email', to: u.email, subject: en ? `[Mimic] ${titleEn}` : `[미믹] ${title}`, body: `${en ? bodyEn : body}\n${cfg.baseUrl}/admin/dashboard` });
  }
}

// 10분마다(jobs) 그리고 관리자가 '지금 확인'을 누를 때. cfg.statfs 로 바꿔 끼울 수 있다(테스트)
export function checkDisk(ctx) {
  const { db, cfg } = ctx;
  const s = (cfg.statfs || fs.statfsSync)(cfg.dataDir);
  const totalBytes = s.blocks * s.bsize;
  const freeBytes = s.bavail * s.bsize;
  const pct = totalBytes ? Math.round((1 - freeBytes / totalBytes) * 1000) / 10 : 0;
  const { alertPct, resumePct, urgentPct } = diskLimits();
  const d = readDisk(db);
  const wasPaused = pausedOf(d);
  // 경보선 이상이면 멈추고, 재개선 미만으로 내려가야 다시 연다(그 사이는 그대로)
  d.autoPaused = pct >= alertPct ? true : pct < resumePct ? false : !!d.autoPaused;
  Object.assign(d, { pct, totalBytes, freeBytes, checkedAt: now() });
  d.alerts ||= {};
  const level = pct >= urgentPct ? 'urgent' : pct >= alertPct ? 'warn' : null;
  const paused = pausedOf(d);
  const left = `남은 공간 ${gb(freeBytes)} / ${gb(totalBytes)}`;
  const leftEn = `${gb(freeBytes)} free of ${gb(totalBytes)}`;
  const state = paused ? `새 가입을 멈췄어요(${resumePct}% 미만이 되면 자동으로 다시 열려요).` : '관리자 설정으로 새 가입은 열려 있어요.';
  const stateEn = paused ? `New sign-ups are paused (they reopen automatically below ${resumePct}%).` : 'New sign-ups stay open because of the admin setting.';
  // 같은 단계 경보는 24시간에 한 번
  if (level && now() - (d.alerts[level] || 0) >= DAY) {
    d.alerts[level] = now();
    const urgent = level === 'urgent';
    alertAdmins(db, cfg, {
      title: `${urgent ? '[긴급] ' : ''}데이터 디스크 사용량 ${pct}%`,
      titleEn: `${urgent ? '[Urgent] ' : ''}Data disk ${pct}% full`,
      body: `${left}. ${state} ${urgent ? '곧 가득 찹니다. 지금 디스크를 늘리거나 정리해 주세요.' : '디스크를 늘리거나 정리해 주세요.'}`,
      bodyEn: `${leftEn}. ${stateEn} ${urgent ? 'The disk will be full soon. Add or free up space now.' : 'Please add or free up disk space.'}`,
    });
  } else if (wasPaused && !paused) {
    alertAdmins(db, cfg, {
      title: '새 가입을 다시 열었어요',
      titleEn: 'New sign-ups reopened',
      body: `데이터 디스크 사용량이 ${pct}%로 내려가 새 가입을 자동으로 다시 열었어요. ${left}.`,
      bodyEn: `Data disk usage dropped to ${pct}%, so new sign-ups reopened automatically. ${leftEn}.`,
    });
  }
  saveDisk(db, d);
  return diskStatus(db);
}

export const jobs = [{ name: 'admin:disk', everyMs: 10 * 60_000, run: checkDisk }];

export function register(app, ctx) {
  const { db, cfg, events } = ctx;
  // 관리자 기능은 웹 로그인 세션으로만. 개인 액세스 토큰·연결 앱 토큰(CLI·MCP·WebDAV·텔레그램)은 scope 와 관계없이 막는다
  const sessionOnly = (req, _res, next) => {
    if (req.authKind !== 'session') fail(403, 'session_required', '관리자 기능은 웹에 로그인한 상태에서만 쓸 수 있습니다');
    next();
  };
  const r = (method, p, fn) => app[method]('/api/admin' + p, requireAdmin, sessionOnly, fn);
  const log = (req, action, detail) => audit(db, { userId: req.user.id, action: 'admin.' + action, detail, ip: req.ip });
  const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const columns = (table) => db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const findTable = (re) => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name).find((n) => re.test(n));
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id) || fail(404, 'not_found', '회원을 찾을 수 없습니다');
  // 받은 신고: 회원 자체 신고 + 소유자로 기록된(meta.owners) 파일·공유 신고. 이의제기는 빼고 센다(J-04 반복 침해 판단)
  const strikes = (u) =>
    hasTable('content_reports')
      ? db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(action='block'),0) AS blocked, COALESCE(SUM(action='suspend'),0) AS suspended FROM content_reports
             WHERE kind<>'appeal' AND (target IN (?, ?, ?) OR EXISTS (SELECT 1 FROM json_each(meta, '$.owners') WHERE value=?))`,
          )
          .get(u.id, u.email, u.phone, u.id)
      : { n: 0, blocked: 0, suspended: 0 };
  // 정지 해제: auth(H-04)와 같이 정지 전 상태(미인증 등)로 되돌린다
  const lift = (id) =>
    db
      .prepare("UPDATE users SET status=COALESCE(json_extract(settings, '$.suspendedFrom'), 'active'), status_until=NULL, settings=json_remove(settings, '$.suspendedFrom') WHERE id=? AND status='suspended'")
      .run(id).changes;

  // 다른 모듈 테이블(작업·주문)은 있을 때만 요약한다
  function tableStats(table) {
    if (!table) return null;
    const cols = columns(table);
    const amt = ['amount', 'price', 'total'].find((c) => cols.includes(c));
    const out = { table, total: db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n };
    if (cols.includes('status')) {
      const cur = amt && cols.includes('currency') ? ', currency' : ''; // 원화·달러(센트) 금액을 섞어 더하지 않게 통화별로
      out.byStatus = db.prepare(`SELECT status${cur}, COUNT(*) AS n${amt ? `, COALESCE(SUM("${amt}"),0) AS amount` : ''} FROM "${table}" GROUP BY status${cur}`).all();
    }
    if (cols.includes('created_at')) out.last7d = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE created_at>?`).get(now() - 7 * DAY).n;
    return out;
  }

  // ---------- 통계 ----------
  r('get', '/stats', (_req, res) => {
    const t = now();
    const users = db
      .prepare(
        `SELECT COUNT(*) AS total,
          COALESCE(SUM(premium_until > ?),0) AS premium,
          COALESCE(SUM(status='suspended' AND (status_until IS NULL OR status_until > ?)),0) AS suspended,
          COALESCE(SUM(status='pending_delete'),0) AS pendingDelete,
          COALESCE(SUM(is_admin=1),0) AS admins,
          COALESCE(SUM(created_at > ?),0) AS new1d,
          COALESCE(SUM(created_at > ?),0) AS new7d,
          COALESCE(SUM(last_login_at > ?),0) AS active7d
         FROM users`,
      )
      .get(t, t, t - DAY, t - 7 * DAY, t - 7 * DAY);
    const files = db.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS logical FROM files WHERE kind='file'").get();
    const blobs = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM blobs').get();
    const reports = hasTable('content_reports') ? db.prepare("SELECT COUNT(*) AS n FROM content_reports WHERE status='open'").get().n : null;
    const messages = hasTable('content_messages') ? db.prepare("SELECT COUNT(*) AS n FROM content_messages WHERE status='open'").get().n : null;
    res.json({
      users,
      storage: { files: files.files, logicalBytes: files.logical, blobs: blobs.count, physicalBytes: blobs.bytes },
      blocklist: db.prepare('SELECT COUNT(*) AS n FROM blocklist').get().n,
      openReports: reports,
      openMessages: messages,
      tasks: tableStats(findTable(/^offline_.*task/)),
      orders: tableStats(findTable(/^billing_.*order/)),
      modules: Object.keys(ctx.modules),
      failedModules: ctx.failedModules,
      disk: diskStatus(db),
      seeding: ctx.modules.offline?.seedingStats?.(ctx) ?? null, // Q-6 시딩 현황
    });
  });

  // 디스크 경보(Q-5): mode 를 주면 가입 멈춤 수동 설정을 바꾸고, 언제나 디스크를 지금 다시 확인해 돌려준다
  r('post', '/disk', (req, res) => {
    const mode = req.body?.mode;
    if (mode != null) {
      if (!['auto', 'pause', 'resume'].includes(mode)) fail(400, 'invalid_mode', 'mode 는 auto·pause·resume 중 하나입니다');
      setDiskMode(db, mode);
      log(req, 'disk.mode', { mode });
    }
    res.json(checkDisk(ctx));
  });

  // ---------- 회원 ----------
  r('get', '/users', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const page = intIn(req.query.page, 1, 1e6, 1);
    const status = ['active', 'suspended', 'pending_delete', 'locked', 'unverified'].includes(req.query.status) ? req.query.status : null;
    const where = [];
    const args = [];
    if (q) {
      where.push('(email LIKE ? OR phone LIKE ? OR name LIKE ? OR id = ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, q);
    }
    if (status) {
      where.push('status = ?');
      args.push(status);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${w}`).get(...args).n;
    const rows = db
      .prepare(
        `SELECT u.*, (SELECT COALESCE(SUM(size),0) FROM files f WHERE f.user_id=u.id AND f.kind='file' AND f.space='drive') AS used,
          (SELECT COALESCE(SUM(size),0) FROM files f WHERE f.user_id=u.id AND f.kind='file' AND f.space='vault') AS vault_used
         FROM users u ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, PAGE, (page - 1) * PAGE);
    res.json({ items: rows.map((u) => adminUser(u, { used: u.used, vaultUsed: u.vault_used })), total, page, pageSize: PAGE });
  });

  r('get', '/users/:id', (req, res) => {
    const u = getUser(req.params.id);
    const f = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(trashed_at IS NOT NULL),0) AS trashed FROM files WHERE user_id=? AND kind='file' AND space='drive'").get(u.id);
    const sessions = db
      .prepare('SELECT device, ip, user_agent AS userAgent, created_at AS createdAt, last_seen_at AS lastSeenAt FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen_at DESC LIMIT 20')
      .all(u.id, now());
    const tokens = db.prepare('SELECT COUNT(*) AS n FROM personal_tokens WHERE user_id=? AND revoked_at IS NULL').get(u.id).n;
    const grants = db.prepare('SELECT kind, amount, valid_from AS validFrom, valid_to AS validTo, reason, created_at AS createdAt FROM quota_grants WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(u.id);
    let orders = null;
    const ot = findTable(/^billing_.*order/);
    if (ot && columns(ot).includes('user_id')) {
      const order = columns(ot).includes('created_at') ? 'ORDER BY created_at DESC' : '';
      orders = { count: db.prepare(`SELECT COUNT(*) AS n FROM "${ot}" WHERE user_id=?`).get(u.id).n, recent: db.prepare(`SELECT * FROM "${ot}" WHERE user_id=? ${order} LIMIT 5`).all(u.id) };
    }
    const rc = strikes(u);
    res.json({
      user: adminUser(u),
      files: { count: f.n, trashed: f.trashed, used: usage(db, u.id), vaultUsed: usage(db, u.id, 'vault') },
      sessions,
      tokens,
      quota: summary(db, u),
      grants,
      orders,
      reports: rc.n,
      reportActions: { blocked: rc.blocked, suspended: rc.suspended },
    });
  });

  r('patch', '/users/:id', (req, res) => {
    const u = getUser(req.params.id);
    const b = req.body || {};
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : null;
    // 먼저 모든 입력을 검증하고, 바꾸는 일은 한 트랜잭션에서 한꺼번에 한다(일부만 반영되지 않게)
    const hours = b.suspendHours != null ? int(b.suspendHours, 'suspendHours', 1, 24 * 365 * 10) : null;
    if (hours && u.id === req.user.id) fail(400, 'self_suspend', '자기 자신은 정지할 수 없습니다');
    const unsuspend = b.unsuspend === true;
    const days = b.premiumDays != null ? int(b.premiumDays, 'premiumDays', 1, 3650) : null;
    if (b.isAdmin != null) {
      if (typeof b.isAdmin !== 'boolean') fail(400, 'invalid_isAdmin', 'isAdmin 은 true/false 입니다');
      if (u.id === req.user.id && !b.isAdmin) fail(400, 'self_demote', '자기 자신의 관리자 권한은 해제할 수 없습니다');
    }
    let g = null;
    if (b.grantQuota != null) {
      if (!QUOTA_KINDS.includes(b.grantQuota?.kind)) fail(400, 'invalid_kind', `쿼터 종류는 ${QUOTA_KINDS.join('·')} 입니다`);
      g = { kind: b.grantQuota.kind, amount: int(b.grantQuota.amount, 'amount', 1, Number.MAX_SAFE_INTEGER), months: int(b.grantQuota.months ?? 1, 'months', 1, 12) };
    }
    if (!hours && !unsuspend && !days && b.isAdmin == null && !g) fail(400, 'nothing_to_do', '바꿀 항목이 없습니다');

    const done = [];
    tx(db, () => {
      if (hours) {
        suspend(req, u, hours, reason);
        done.push('suspend');
      }
      if (unsuspend) {
        lift(u.id);
        log(req, 'user.unsuspend', { target: u.id });
        notify(db, u.id, { kind: 'account', title: '계정 이용 제한이 풀렸어요', body: '이제 미믹을 다시 이용할 수 있어요.', titleEn: 'Your account restriction was lifted', bodyEn: 'You can use Mimic again.' });
        done.push('unsuspend');
      }
      if (days) {
        const base = Math.max(now(), u.premium_until || 0);
        db.prepare('UPDATE users SET premium_until=?, premium_expired_at=NULL WHERE id=?').run(base + days * DAY, u.id);
        log(req, 'user.premium', { target: u.id, days, reason });
        notify(db, u.id, { kind: 'premium', title: `프리미엄 ${days}일이 지급되었어요`, titleEn: `You received ${days} days of Premium`, body: reason || '', link: '/drive/orders' });
        done.push('premium');
      }
      if (b.isAdmin != null) {
        db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(b.isAdmin ? 1 : 0, u.id);
        log(req, 'user.admin', { target: u.id, isAdmin: b.isAdmin });
        done.push('admin');
      }
      if (g) {
        // cloud_count(무료 횟수)는 기간 없이 쌓이고, 바이트 쿼터는 기간 동안 매월 한도에 더해진다
        grant(db, u.id, { kind: g.kind, amount: g.amount, validTo: g.kind === 'cloud_count' ? null : now() + g.months * 30 * DAY, reason: `admin:${req.user.id}` });
        log(req, 'user.grant_quota', { target: u.id, ...g });
        notify(db, u.id, { kind: 'quota', title: '추가 전송 쿼터가 지급되었어요', titleEn: 'You received extra transfer quota', body: g.kind === 'cloud_count' ? `클라우드 다운로드 ${g.amount}회` : '', bodyEn: g.kind === 'cloud_count' ? `${g.amount} cloud downloads` : '', link: '/drive/quota' });
        done.push('grantQuota');
      }
    });
    res.json({ done, user: adminUser(getUser(u.id)) });
  });

  r('delete', '/users/:id', (req, res) => {
    const u = getUser(req.params.id);
    if (u.id === req.user.id) fail(400, 'self_delete', '자기 자신은 삭제할 수 없습니다');
    try {
      db.exec('BEGIN');
      db.prepare('DELETE FROM quota_usage WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM quota_grants WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM users WHERE id=?').run(u.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      fail(409, 'delete_blocked', `삭제하지 못했습니다: ${e.message}`);
    }
    log(req, 'user.delete', { target: u.id, email: u.email, phone: u.phone });
    events.emit('user:deleted', { userId: u.id });
    res.json({ ok: true });
  });

  function suspend(req, u, hours, reason) {
    if (u.id === req.user.id) fail(400, 'self_suspend', '자기 자신은 정지할 수 없습니다');
    const until = now() + hours * 3600_000;
    // 정지 전 상태를 기억해 두고(이미 정지 중이면 처음 상태 유지), 풀릴 때 그 상태로 돌린다
    db.prepare("UPDATE users SET status='suspended', status_until=?, settings=CASE WHEN status='suspended' THEN settings ELSE json_set(settings, '$.suspendedFrom', status) END WHERE id=?").run(until, u.id);
    log(req, 'user.suspend', { target: u.id, hours, reason: reason || null });
    // 이의제기 폼을 '사용자 · 내 연락처'로 미리 채워 둔다(그대로 보내면 unblock 으로 정지가 풀리게)
    const appeal = appealLink('user', u.email || u.phone || u.id);
    const at = new Date(until).toISOString().slice(0, 16).replace('T', ' ');
    const body = `${at}(UTC)까지 제한됩니다. 이의가 있으면 이의제기로 알려 주세요.`;
    const bodyEn = `Restricted until ${at} (UTC). If you disagree, please file an appeal.`;
    notify(db, u.id, { kind: 'account', title: '계정 이용이 일시 제한되었어요', body, link: appeal, titleEn: 'Your account is temporarily restricted', bodyEn });
    // 정지된 회원은 사이트 알림 API(requireUser)를 못 쓰므로 이메일·문자로도 알린다
    tell(u, '[미믹] 계정 이용 제한 안내', `${body}\n이의제기: ${cfg.baseUrl}${appeal}`, ['[Mimic] Your account has been restricted', `${bodyEn}\nAppeal: ${cfg.baseUrl}${appeal}`]);
  }
  const appealLink = (type, target) => `/copyright?tab=appeal&type=${type}&target=${encodeURIComponent(String(target).split('#')[0])}`;
  // 이메일, 없으면 문자로 보낸다. en = [제목, 본문]: 회원 언어가 영어면 이쪽을 보낸다
  function tell(u, subject, body, en) {
    if (u.lang === 'en' && en) [subject, body] = en;
    if (u.email) sendMessage(db, cfg, { channel: 'email', to: u.email, subject, body });
    else if (u.phone) sendMessage(db, cfg, { channel: 'sms', to: u.phone, body: `${subject} ${body}` });
  }

  // ---------- 차단 목록(A-08 의 원본) ----------
  // 예전 코드는 url 을 '#조각'·빈 '?' 를 붙인 채 저장했다 → 시작할 때 지금 모양으로 맞춰 신고 해제(unblock)·중복 확인이 맞게 한다.
  // 맞춘 값이 이미 있으면 예전 행은 지운다(offline 비교는 둘을 같은 주소로 보므로 차단 범위는 그대로)
  for (const row of db.prepare("SELECT id, value FROM blocklist WHERE kind='url' AND (value LIKE '%#%' OR value LIKE '%?')").all()) {
    let v;
    try {
      v = normBlock('url', row.value).value;
    } catch {
      continue;
    }
    if (v === row.value) continue;
    try {
      db.prepare('UPDATE blocklist SET value=? WHERE id=?').run(v, row.id);
    } catch {
      db.prepare('DELETE FROM blocklist WHERE id=?').run(row.id);
    }
  }
  r('get', '/blocklist', (req, res) => {
    const kind = BLOCK_KINDS.includes(req.query.kind) ? req.query.kind : null;
    const q = String(req.query.q || '').trim().slice(0, 200);
    const page = intIn(req.query.page, 1, 1e6, 1);
    const where = [];
    const args = [];
    if (kind) {
      where.push('kind=?');
      args.push(kind);
    }
    if (q) {
      where.push('(value LIKE ? OR reason LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM blocklist ${w}`).get(...args).n;
    const items = db.prepare(`SELECT id, kind, value, reason, created_at AS createdAt FROM blocklist ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, PAGE, (page - 1) * PAGE);
    res.json({ items, total, page, pageSize: PAGE });
  });
  const addBlock = (req, { kind, value }, reason) => {
    const id = newId('bl_');
    const r = db.prepare('INSERT OR IGNORE INTO blocklist (id, kind, value, reason, created_at) VALUES (?,?,?,?,?)').run(id, kind, value, reason || null, now());
    if (r.changes) log(req, 'blocklist.add', { kind, value, reason: reason || null });
    return r.changes ? id : null;
  };
  r('post', '/blocklist', (req, res) => {
    const b = req.body || {};
    const entry = normBlock(b.kind, b.value);
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : null;
    const id = addBlock(req, entry, reason) || fail(409, 'duplicate', '이미 차단 목록에 있습니다');
    res.status(201).json({ id, ...entry, reason });
  });
  r('patch', '/blocklist/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM blocklist WHERE id=?').get(req.params.id) || fail(404, 'not_found', '차단 항목이 없습니다');
    const b = req.body || {};
    const entry = b.value != null || b.kind != null ? normBlock(b.kind ?? row.kind, b.value ?? row.value) : { kind: row.kind, value: row.value };
    const reason = b.reason !== undefined ? (typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : null) : row.reason;
    try {
      db.prepare('UPDATE blocklist SET kind=?, value=?, reason=? WHERE id=?').run(entry.kind, entry.value, reason, row.id);
    } catch {
      fail(409, 'duplicate', '같은 값이 이미 차단 목록에 있습니다');
    }
    log(req, 'blocklist.update', { id: row.id, from: { kind: row.kind, value: row.value }, to: entry, reason });
    res.json({ id: row.id, ...entry, reason });
  });
  r('delete', '/blocklist/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM blocklist WHERE id=?').get(req.params.id) || fail(404, 'not_found', '차단 항목이 없습니다');
    db.prepare('DELETE FROM blocklist WHERE id=?').run(row.id);
    log(req, 'blocklist.remove', { kind: row.kind, value: row.value });
    res.json({ ok: true });
  });

  // ---------- 신고·저작권 신고·이의제기 처리(J-01·J-02) ----------
  const needReports = () => hasTable('content_reports') || fail(503, 'content_unavailable', 'content 모듈이 없어 신고 기능을 쓸 수 없습니다');
  const reportApi = (x) => ({
    id: x.id,
    kind: x.kind,
    reporterId: x.reporter_id,
    reporterEmail: x.reporter_email,
    targetType: x.target_type,
    target: x.target,
    reason: x.reason,
    detail: x.detail,
    meta: json(x.meta, {}),
    status: x.status,
    action: x.action,
    note: x.note,
    resolvedBy: x.resolved_by,
    resolvedAt: x.resolved_at,
    createdAt: x.created_at,
  });
  r('get', '/reports', (req, res) => {
    needReports();
    const status = ['open', 'resolved'].includes(req.query.status) ? req.query.status : null;
    const kind = ['report', 'copyright', 'appeal'].includes(req.query.kind) ? req.query.kind : null;
    const page = intIn(req.query.page, 1, 1e6, 1);
    const where = [];
    const args = [];
    if (status) {
      where.push('status=?');
      args.push(status);
    }
    if (kind) {
      where.push('kind=?');
      args.push(kind);
    }
    if (REASON_KO[req.query.reason]) {
      where.push('reason=?');
      args.push(req.query.reason);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM content_reports ${w}`).get(...args).n;
    // 아동 보호·불법 촬영물 신고를 먼저, 그다음 공유 링크 신고(아동 보호 정책 2항)
    const items = db
      .prepare(`SELECT * FROM content_reports ${w} ORDER BY status='open' DESC, reason IN ('child','illegal_filming') DESC, target_type='share' DESC, created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, PAGE, (page - 1) * PAGE);
    // 대상 소유자와 그 회원이 받은 확정 조치 수(J-04 반복 침해 판단용)
    const owners = (x) => ownersOf(x).map((u) => ({ id: u.id, label: u.email || u.phone || u.id, ...strikes(u) }));
    res.json({ items: items.map((x) => ({ ...reportApi(x), owners: owners(x) })), total, page, pageSize: PAGE });
  });

  const resolveLocal = (v) => locate(db, v);
  // 신고 대상 → 처리 계획. entries: 차단 목록 값, vault: 취소할 금고 공유, owned: 소유자별 신고 위치, unresolved: 찾지 못한 미믹 내부 위치
  function planFor(rep, req) {
    const out = { entries: [], vault: [], owned: new Map(), unresolved: [] };
    if (rep.target_type === 'user') return out;
    const ownHosts = new Set([hostOf(cfg.baseUrl), String(req.get('host') || '').toLowerCase()]);
    for (const v of valuesOf(rep)) {
      if (/^[0-9a-f]{64}$/i.test(v)) {
        out.entries.push({ kind: 'blob', value: v.toLowerCase() });
        continue;
      }
      const local = resolveLocal(v);
      if (local) {
        if (!out.owned.has(local.userId)) out.owned.set(local.userId, { type: local.type, value: v });
        // 금고 파일은 공유마다 다르게 암호화된 암호문이라 해시 차단이 소용없다 → 공유 자체를 취소한다
        if (local.vaultShareId) {
          out.vault.push(local.vaultShareId);
          continue;
        }
        // share 모듈은 공유 트리 안 파일의 blob 차단을 검사한다 → 공유·폴더 안 파일 전체의 해시를 막는다
        const rows = db
          .prepare(
            `WITH RECURSIVE t(id) AS (SELECT value FROM json_each(?) UNION ALL SELECT f.id FROM files f JOIN t ON f.parent_id=t.id WHERE f.user_id=?)
             SELECT DISTINCT blob_hash FROM files WHERE user_id=? AND id IN t AND blob_hash IS NOT NULL`,
          )
          .all(local.fileIds, local.userId, local.userId);
        out.entries.push(...rows.map((x) => ({ kind: 'blob', value: x.blob_hash })));
      } else if (!/^[a-z]+:/i.test(v) || ownHosts.has(hostOf(v))) {
        // 미믹 안의 링크·ID 인데 못 찾았다: 아무도 검사하지 않는 url 항목을 넣지 않는다
        out.unresolved.push(v);
      } else {
        try {
          out.entries.push(normBlock('url', v));
        } catch {}
      }
    }
    return out;
  }
  // 신고 대상의 소유자들(정지 대상). 저작권 신고에 여러 회원의 공유가 있으면 모두
  function ownersOf(rep) {
    const byId = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (rep.target_type === 'user') {
      const v = rep.target.trim();
      const u = db.prepare('SELECT * FROM users WHERE id=? OR email=? OR phone=?').get(v, v.toLowerCase(), v);
      return u ? [u] : [];
    }
    const ids = new Set(valuesOf(rep).map((v) => resolveLocal(v)?.userId).filter(Boolean));
    return [...ids].map(byId).filter(Boolean);
  }
  // 차단된 콘텐츠의 소유자(복제·전송자)에게 사유·접수번호·이의제기 경로를 알린다(저작권법 제103조 제2항)
  function noticeOwners(rep, owned, note) {
    const label = { report: '신고', copyright: '저작권 신고', appeal: '이의제기' }[rep.kind] || '신고';
    for (const [uid, loc] of owned) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
      if (!u) continue;
      const link = appealLink(loc.type, loc.value);
      const [subj, obj] = loc.type === 'share' ? ['공유가', '공유를'] : ['파일이', '파일을'];
      const body = `${label}(접수번호 ${rep.id})에 따라 회원님의 ${obj} 차단했어요. 사유: ${REASON_KO[rep.reason] || rep.reason}${note ? ` — ${note}` : ''}. 잘못된 조치라면 이의제기해 주세요.`;
      const what = loc.type === 'share' ? 'share' : 'file';
      const bodyEn = `Following a ${LABEL_EN[rep.kind] || 'report'} (ref. ${rep.id}), we blocked your ${what}. Reason: ${REASON_EN[rep.reason] || rep.reason}${note ? ` — ${note}` : ''}. If you think this is a mistake, please file an appeal.`;
      notify(db, u.id, { kind: 'report', title: `신고로 ${subj} 차단되었어요`, titleEn: `Your ${what} was blocked after a report`, body, bodyEn, link });
      tell(u, '[미믹] 콘텐츠 차단 안내', `${body}\n대상: ${loc.value.split('#')[0]}\n이의제기: ${cfg.baseUrl}${link}`, [`[Mimic] Your ${what} was blocked`, `${bodyEn}\nBlocked item: ${loc.value.split('#')[0]}\nAppeal: ${cfg.baseUrl}${link}`]);
    }
  }

  r('post', '/reports/:id/resolve', (req, res) => {
    needReports();
    const rep = db.prepare('SELECT * FROM content_reports WHERE id=?').get(req.params.id) || fail(404, 'not_found', '신고를 찾을 수 없습니다');
    if (rep.status !== 'open') fail(409, 'already_resolved', '이미 처리된 신고입니다');
    const b = req.body || {};
    const action = RESOLVE_ACTIONS.includes(b.action) ? b.action : fail(400, 'invalid_action', `처리 방법은 ${RESOLVE_ACTIONS.join('·')} 중 하나입니다`);
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : '';
    const result = {};
    const owners = ownersOf(rep);
    const plan = action === 'block' || action === 'unblock' ? planFor(rep, req) : null;
    if (action === 'block' && !plan.entries.length && !plan.vault.length) {
      const msg = plan.unresolved.length ? `미믹 안에서 찾지 못한 위치입니다: ${plan.unresolved.join(', ')}` : '차단할 링크·파일을 찾지 못했습니다. 사용자 신고는 정지로 처리하세요';
      fail(400, 'nothing_to_block', msg);
    }
    let hours;
    if (action === 'suspend') {
      if (!owners.length) fail(400, 'no_owner', '정지할 회원을 찾지 못했습니다');
      hours = b.suspendHours == null ? 168 : int(b.suspendHours, 'suspendHours', 1, 24 * 365 * 10);
      if (owners.some((o) => o.id === req.user.id)) fail(400, 'self_suspend', '자기 자신은 정지할 수 없습니다');
    }
    tx(db, () => {
      if (action === 'block') {
        result.blocked = plan.entries.filter((t) => addBlock(req, t, `report:${rep.id}${note ? ' ' + note : ''}`));
        // 금고 공유는 해시 차단이 소용없어 공유 자체를 취소한다(vault 모듈의 취소와 같은 revoked_at)
        result.revoked = plan.vault.filter((id) => db.prepare('UPDATE vault_shares SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(), id).changes);
        noticeOwners(rep, plan.owned, note);
      } else if (action === 'suspend') {
        owners.forEach((o) => suspend(req, o, hours, `report:${rep.id}`));
        result.suspended = owners.map((o) => o.id);
      } else if (action === 'unblock') {
        result.unblocked = plan.entries.reduce((n, t) => n + Number(db.prepare('DELETE FROM blocklist WHERE kind=? AND value=?').run(t.kind, t.value).changes), 0);
        result.unsuspended = owners.filter((o) => o.status === 'suspended' && lift(o.id)).map((o) => o.id);
      }
      // 소유자를 남겨 회원 상세의 '받은 신고'·반복 침해 집계에 쓴다
      db.prepare("UPDATE content_reports SET status='resolved', action=?, note=?, resolved_by=?, resolved_at=?, meta=json_set(meta, '$.owners', json(?)) WHERE id=?").run(
        action,
        note || null,
        req.user.id,
        now(),
        JSON.stringify(owners.map((o) => o.id)),
        rep.id,
      );
    });
    log(req, 'report.resolve', { report: rep.id, kind: rep.kind, action, ...result });
    const title = { dismiss: '조치하지 않기로 했어요', block: '차단 조치했어요', suspend: '계정 제한 조치했어요', unblock: '차단을 풀었어요' }[action];
    const label = { report: '신고', copyright: '저작권 신고', appeal: '이의제기' }[rep.kind] || '신고';
    const titleEn = { dismiss: 'no action taken', block: 'blocked', suspend: 'account restricted', unblock: 'unblocked' }[action];
    const reporter = rep.reporter_id && db.prepare('SELECT * FROM users WHERE id=?').get(rep.reporter_id);
    if (reporter) {
      notify(db, reporter.id, { kind: 'report', title: `${label} 처리 결과: ${title}`, titleEn: `${rep.kind === 'appeal' ? 'Appeal' : 'Report'} result: ${titleEn}`, body: note });
      // 정지된 회원은 사이트 알림을 못 읽는다(403) → 이의제기 결과·정지 중인 신고자는 이메일·문자로도
      const suspended = reporter.status === 'suspended' && (!reporter.status_until || reporter.status_until > now());
      const labelEn = LABEL_EN[rep.kind] || 'report';
      if (rep.kind === 'appeal' || suspended)
        tell(reporter, `[미믹] ${label} 처리 결과`, `접수번호 ${rep.id}: ${title}${note ? `\n${note}` : ''}`, [`[Mimic] Result of your ${labelEn}`, `We reviewed your ${labelEn} (ref. ${rep.id}). Result: ${titleEn}.${note ? `\n${note}` : ''}`]);
    } else if (rep.reporter_email) sendMessage(db, cfg, { channel: 'email', to: rep.reporter_email, subject: `[미믹] ${label} 처리 결과`, body: `접수번호 ${rep.id}: ${title}${note ? `\n${note}` : ''}` });
    res.json({ report: reportApi(db.prepare('SELECT * FROM content_reports WHERE id=?').get(rep.id)), ...result });
  });

  // ---------- 문의(K-01) ----------
  r('get', '/messages', (req, res) => {
    if (!hasTable('content_messages')) return res.json({ items: [], total: 0, page: 1, pageSize: PAGE });
    const status = ['open', 'answered'].includes(req.query.status) ? req.query.status : null;
    const page = intIn(req.query.page, 1, 1e6, 1);
    const w = status ? 'WHERE status=?' : '';
    const args = status ? [status] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM content_messages ${w}`).get(...args).n;
    const items = db
      .prepare(`SELECT id, user_id AS userId, name, email, category, message, status, answer, answered_at AS answeredAt, created_at AS createdAt FROM content_messages ${w} ORDER BY status='open' DESC, created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, PAGE, (page - 1) * PAGE);
    res.json({ items, total, page, pageSize: PAGE });
  });
  r('post', '/messages/:id/reply', (req, res) => {
    const m = hasTable('content_messages') && db.prepare('SELECT * FROM content_messages WHERE id=?').get(req.params.id);
    if (!m) fail(404, 'not_found', '문의를 찾을 수 없습니다');
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > 5000) fail(400, 'invalid_body', '답변 내용을 입력하세요');
    const en = !!m.user_id && db.prepare('SELECT lang FROM users WHERE id=?').get(m.user_id)?.lang === 'en';
    sendMessage(db, cfg, en
      ? { channel: 'email', to: m.email, subject: '[Mimic Support] Reply to your inquiry', body: `${body}\n\n— Reference number ${m.id}` }
      : { channel: 'email', to: m.email, subject: '[미믹 고객지원] 문의에 답변드립니다', body: `${body}\n\n— 접수번호 ${m.id}` });
    if (m.user_id) notify(db, m.user_id, { kind: 'support', title: '문의에 답변이 도착했어요', titleEn: 'You have a reply to your inquiry', body: body.slice(0, 200) });
    db.prepare("UPDATE content_messages SET status='answered', answer=?, answered_at=? WHERE id=?").run(body, now(), m.id);
    log(req, 'message.reply', { message: m.id });
    res.json({ ok: true });
  });

  // ---------- 공지 알림 발송(K-05) ----------
  r('post', '/notifications', (req, res) => {
    const b = req.body || {};
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title || title.length > 100) fail(400, 'invalid_title', '제목은 1~100자입니다');
    const body = typeof b.body === 'string' ? b.body.trim().slice(0, 2000) : '';
    const link = safeLink(b.link);
    const titleEn = typeof b.titleEn === 'string' ? b.titleEn.trim().slice(0, 100) || null : null;
    const bodyEn = typeof b.bodyEn === 'string' ? b.bodyEn.trim().slice(0, 2000) || null : null;
    let targets;
    if (b.all === true) targets = db.prepare("SELECT id, email FROM users WHERE status NOT IN ('deleted','pending_delete')").all();
    else if (typeof b.userId === 'string') targets = [getUser(b.userId)];
    else fail(400, 'invalid_target', 'userId 또는 all:true 가 필요합니다');
    // ponytail: 전체 발송을 한 번에 넣는다. 회원이 수십만 명이 되면 작업 대기열로 나눌 것
    db.exec('BEGIN');
    try {
      for (const u of targets) {
        notify(db, u.id, { kind: 'notice', title, body, link, titleEn, bodyEn });
        if (b.email === true && u.email) sendMessage(db, cfg, { channel: 'email', to: u.email, subject: `[미믹] ${title}`, body: body + (link ? `\n${link.startsWith('/') ? cfg.baseUrl + link : link}` : '') });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    log(req, 'notify', { all: b.all === true, userId: b.all === true ? null : targets[0].id, title, count: targets.length, email: b.email === true });
    res.status(201).json({ sent: targets.length });
  });

  // ---------- 감사 로그 ----------
  r('get', '/logs', (req, res) => {
    const page = intIn(req.query.page, 1, 1e6, 1);
    const where = [];
    const args = [];
    if (req.query.action) {
      where.push('a.action LIKE ?');
      args.push(`${String(req.query.action).slice(0, 100)}%`);
    }
    if (req.query.userId) {
      where.push('a.user_id=?');
      args.push(String(req.query.userId));
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${w}`).get(...args).n;
    const items = db
      .prepare(`SELECT a.id, a.user_id AS userId, u.email AS userEmail, a.action, a.detail, a.ip, a.created_at AS createdAt FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ${w} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`)
      .all(...args, PAGE * 2, (page - 1) * PAGE * 2);
    res.json({ items: items.map((x) => ({ ...x, detail: json(x.detail, x.detail) })), total, page, pageSize: PAGE * 2 });
  });

  // ---------- 쿼터 정책(읽기 전용, plans.js 값) ----------
  r('get', '/quotas', (_req, res) => {
    const fin = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (v === Infinity ? null : v)));
    res.json(
      fin({
        limits: LIMITS,
        monthly: MONTHLY_QUOTA,
        appShare: APP_QUOTA_SHARE,
        freeAppDailyDown: FREE_APP_DAILY_DOWN,
        slowBps: SLOW_BPS,
        speedBps: SPEED_BPS,
        trashDays: TRASH_DAYS,
        signupBonusCloud: SIGNUP_BONUS_CLOUD,
        vaultStorage: VAULT_STORAGE,
        shareExpiryDays: SHARE_EXPIRY_DAYS,
        btMaxFiles: BT_MAX_FILES,
        referral: REFERRAL,
        expiry: EXPIRY,
        dormant: DORMANT,
        accountDeleteGraceDays: ACCOUNT_DELETE_GRACE_DAYS,
        products: PRODUCTS,
        premiumUsers: db.prepare('SELECT COUNT(*) AS n FROM users WHERE premium_until>?').get(now()).n,
      }),
    );
  });
}

