// 공개 콘텐츠(도움말·FAQ·블로그·정책), 문의, 신고·저작권 신고, 투명성 통계, 사이트 내 알림(K-01·K-02·K-05·J-01~J-04)
import { requireScope } from '../../core/auth.js';
import { now, newId, fail, rateLimit, periodKeys, DAY } from '../../core/util.js';
import { sendMessage } from '../../core/notify.js';
import { N } from './data/numbers.js';
import { CATEGORIES, ARTICLES } from './data/help.js';
import { FAQ } from './data/faq.js';
import { POSTS } from './data/blog.js';
import { POLICIES } from './data/policies.js';
import { localOwners } from './locate.js';

// 신고는 신고자가 탈퇴해도 통계(J-03)에 남아야 하므로 SET NULL
export const migrations = `
CREATE TABLE IF NOT EXISTS content_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_email TEXT,
  target_type TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  action TEXT,
  note TEXT,
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_reports_status ON content_reports(status, created_at);
-- 회원 행이 지워지기 직전(탈퇴 유예 만료·관리자 즉시 삭제, 어느 모듈이 지우든) 신고자·문의자 개인정보를 지운다.
-- 투명성 통계에 쓰는 kind·status·action·created_at 은 남긴다. 결제 문의는 소비자 분쟁 기록(3년)이라 보존 작업이 지운다
CREATE TRIGGER IF NOT EXISTS content_scrub_deleted_user BEFORE DELETE ON users BEGIN
  UPDATE content_reports SET reporter_email=NULL, meta=json_remove(meta, '$.claimant') WHERE reporter_id=OLD.id;
  DELETE FROM content_messages WHERE user_id=OLD.id AND category<>'payment';
END;
`;

// 소비자 불만·분쟁 기록 보존 기간(전자상거래법 3년). 지나면 문의를 지우고 신고자 연락처를 비운다
const KEEP_MS = 3 * 365 * DAY;
export const jobs = [
  {
    name: 'content:purge-old',
    everyMs: DAY,
    run: ({ db }) => {
      const before = now() - KEEP_MS;
      db.prepare('DELETE FROM content_messages WHERE created_at<?').run(before);
      db.prepare("UPDATE content_reports SET reporter_email=NULL, meta=json_remove(meta, '$.claimant') WHERE created_at<? AND status<>'open'").run(before);
    },
  },
];

export const CONTACT_CATEGORIES = ['account', 'payment', 'download', 'playback', 'share', 'bug', 'partnership', 'other'];
export const REPORT_TARGETS = ['share', 'file', 'url', 'user'];
export const REPORT_REASONS = ['copyright', 'child', 'illegal_filming', 'adult', 'violence', 'malware', 'spam', 'privacy', 'other'];

export const supportEmail = (cfg) => cfg.supportEmail || process.env.MIMIC_SUPPORT_EMAIL || 'support@mimic.local';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v, field, { min = 1, max = 2000 } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) fail(400, 'invalid_' + field, `${field} 값을 확인해 주세요 (${min}~${max}자)`);
  return s;
}
// 메일 제목에 들어가는 한 줄 값: 줄바꿈·제어 문자를 공백으로(헤더 주입 방지)
const oneLine = (s) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
function email(v) {
  const s = str(v, 'email', { max: 254 });
  if (!EMAIL.test(s)) fail(400, 'invalid_email', '이메일 주소를 확인해 주세요');
  return s.toLowerCase();
}
const intIn = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
function limit(req, key, max) {
  if (!rateLimit(`${key}:${req.user?.id || req.ip}`, max, 3600_000)) fail(429, 'too_many_requests', '잠시 후 다시 시도해 주세요');
}

// 'YYYY-MM' 의 앞 달
const prevMonth = (k) => {
  const [y, m] = k.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

const articleBrief = (a) => ({ slug: a.slug, title: a.title, category: a.category });
const policyBrief = (p) => ({ slug: p.slug, title: p.title, en: p.en, draft: p.draft, updated: p.updated });
const postBrief = ({ body, ...p }) => p;

export function register(app, ctx) {
  const { db, cfg } = ctx;

  // ---------- 도움말·FAQ·블로그·정책(공개) ----------
  app.get('/api/content/help', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
    const categories = CATEGORIES.map((c) => ({ ...c, articles: ARTICLES.filter((a) => a.category === c.id).map(articleBrief) }));
    const results = q ? ARTICLES.filter((a) => (a.title + '\n' + a.body).toLowerCase().includes(q)).map(articleBrief) : undefined;
    res.json({ categories, results });
  });
  app.get('/api/content/help/:slug', (req, res) => {
    const article = ARTICLES.find((a) => a.slug === req.params.slug) || fail(404, 'not_found', '도움말을 찾을 수 없습니다');
    const category = CATEGORIES.find((c) => c.id === article.category);
    const related = ARTICLES.filter((a) => a.category === article.category && a.slug !== article.slug).map(articleBrief);
    res.json({ article, category, related });
  });
  app.get('/api/content/faq', (_req, res) => res.json({ items: FAQ }));
  app.get('/api/content/support', (_req, res) => res.json({ email: supportEmail(cfg) }));
  app.get('/api/content/numbers', (_req, res) => res.json(N)); // 소개 화면 수치(plans.js 값)
  app.get('/api/content/blog', (_req, res) => res.json({ posts: POSTS.map(postBrief) }));
  app.get('/api/content/blog/:slug', (req, res) => {
    const post = POSTS.find((p) => p.slug === req.params.slug) || fail(404, 'not_found', '글을 찾을 수 없습니다');
    res.json({ post });
  });
  app.get('/api/content/policies', (_req, res) => res.json({ policies: POLICIES.map(policyBrief) }));
  app.get('/api/content/policies/:slug', (req, res) => {
    const policy = POLICIES.find((p) => p.slug === req.params.slug) || fail(404, 'not_found', '정책 문서를 찾을 수 없습니다');
    res.json({ policy, policies: POLICIES.map(policyBrief) });
  });

  // ---------- 문의(K-01) ----------
  app.post('/api/content/contact', (req, res) => {
    const b = req.body || {};
    const m = {
      name: oneLine(str(b.name, 'name', { max: 60 })),
      email: email(b.email),
      category: CONTACT_CATEGORIES.includes(b.category) ? b.category : fail(400, 'invalid_category', '문의 종류를 골라 주세요'),
      message: str(b.message, 'message', { min: 5, max: 5000 }),
    };
    limit(req, 'contact', 10);
    const id = newId('cm_');
    db.prepare('INSERT INTO content_messages (id, user_id, name, email, category, message, created_at) VALUES (?,?,?,?,?,?,?)').run(
      id,
      req.user?.id ?? null,
      m.name,
      m.email,
      m.category,
      m.message,
      now(),
    );
    sendMessage(db, cfg, {
      channel: 'email',
      to: supportEmail(cfg),
      subject: `[문의:${m.category}] ${m.name} <${m.email}>`,
      body: `${m.message}\n\n접수번호 ${id}${req.user ? ` · 회원 ${req.user.id}` : ''}`,
    });
    sendMessage(db, cfg, { channel: 'email', to: m.email, subject: '[미믹] 문의가 접수되었습니다', body: `접수번호 ${id}. 영업일 기준 2일 안에 답변드릴게요.` });
    res.status(201).json({ id });
  });

  // 이의제기 대상(공유 링크 등, # 뒤 키는 뺌)을 침해 위치로 적고 차단까지 된 저작권 신고
  const copyrightClaims = (target) => {
    const key = target.split('#')[0].trim();
    if (!key) return [];
    return db
      .prepare(
        `SELECT id, reporter_email FROM content_reports WHERE kind='copyright' AND action='block' AND reporter_email IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(meta, '$.urls') WHERE value=? OR substr(value, 1, ?)=?)`,
      )
      .all(key, key.length + 1, key + '#');
  };

  // ---------- 신고·이의제기(J-01) ----------
  // kind: report(콘텐츠 침해 신고) | appeal(차단·정지 이의제기). 신고는 로그인 없이도 가능, 이의제기는 연락처 필요
  app.post('/api/content/reports', (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'appeal' ? 'appeal' : 'report';
    const targetType = REPORT_TARGETS.includes(b.targetType) ? b.targetType : fail(400, 'invalid_target_type', '신고 대상을 골라 주세요');
    const target = str(b.target, 'target', { max: 2000 });
    const reason = kind === 'appeal' ? 'appeal' : REPORT_REASONS.includes(b.reason) ? b.reason : fail(400, 'invalid_reason', '신고 사유를 골라 주세요');
    const detail = typeof b.detail === 'string' ? b.detail.trim().slice(0, 5000) : '';
    const contact = req.user?.email || (b.email ? email(b.email) : null);
    if (kind === 'appeal' && !req.user && !contact) fail(400, 'invalid_email', '결과를 받을 이메일을 적어 주세요');
    limit(req, 'report', 30);
    const id = newId('r_');
    // 파일·공유 신고는 접수 때 소유자를 남겨 관리자 회원 상세의 '받은 신고'에 바로 잡히게 한다
    const owners = kind === 'report' && targetType !== 'user' ? localOwners(db, [target]) : [];
    const meta = owners.length ? { owners } : {};
    // 저작권 신고로 차단된 위치에 대한 이의제기: 원 신고인(권리자)에게 내용을 전달하고 기다릴 기한을 남긴다(저작권 정책 4항)
    const claims = kind === 'appeal' ? copyrightClaims(target) : [];
    if (claims.length) {
      meta.copyrightReports = claims.map((c) => c.id);
      meta.waitUntil = now() + N.counterWaitDays * DAY;
      for (const c of claims) {
        sendMessage(db, cfg, {
          channel: 'email',
          to: c.reporter_email,
          subject: '[미믹] 저작권 신고 대상에 이의제기가 접수되었습니다',
          body: `저작권 신고(접수번호 ${c.id})로 차단한 ${target.split('#')[0]} 에 대해 이의제기(접수번호 ${id})가 들어왔어요.
이의 내용: ${detail || '(없음)'}
${N.counterWaitDays}일 안에 소송 등 법적 조치를 했다는 사실을 ${supportEmail(cfg)} 로 알려 주지 않으면 검토 후 차단을 풀 수 있어요.`,
        });
      }
    }
    db.prepare(
      'INSERT INTO content_reports (id, kind, reporter_id, reporter_email, target_type, target, reason, detail, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(id, kind, req.user?.id ?? null, contact, targetType, target, reason, detail, JSON.stringify(meta), now());
    res.status(201).json({ id, status: 'open' });
  });

  // ---------- 저작권 신고(J-02) ----------
  app.post('/api/content/copyright', (req, res) => {
    const b = req.body || {};
    const claimant = oneLine(str(b.claimant, 'claimant', { max: 120 }));
    const mail = email(b.email);
    const work = str(b.work, 'work', { max: 2000 });
    const raw = Array.isArray(b.urls) ? b.urls : String(b.urls || '').split(/\r?\n/);
    const urls = [...new Set(raw.map((u) => String(u).trim()).filter(Boolean))];
    if (!urls.length || urls.length > 100 || urls.some((u) => u.length > 2000)) fail(400, 'invalid_urls', '침해 위치를 1~100개 적어 주세요');
    if (b.statement !== true) fail(400, 'statement_required', '권리 보유와 사실 확인 진술에 동의해 주세요');
    limit(req, 'copyright', 20);
    const id = newId('r_');
    db.prepare(
      'INSERT INTO content_reports (id, kind, reporter_id, reporter_email, target_type, target, reason, detail, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(id, 'copyright', req.user?.id ?? null, mail, 'url', urls.join('\n'), 'copyright', work, JSON.stringify({ claimant, work, urls, statement: true, agent: !!b.agent, owners: localOwners(db, urls) }), now());
    sendMessage(db, cfg, { channel: 'email', to: supportEmail(cfg), subject: `[저작권 신고] ${claimant}`, body: `${work}\n${urls.join('\n')}\n접수번호 ${id}` });
    sendMessage(db, cfg, { channel: 'email', to: mail, subject: '[미믹] 저작권 신고가 접수되었습니다', body: `접수번호 ${id}. 검토가 끝나면 결과를 이 주소로 알려 드릴게요.` });
    res.status(201).json({ id, status: 'open' });
  });

  // ---------- 투명성 보고서(J-03): 월별 접수·조치 통계 ----------
  app.get('/api/content/transparency', (req, res) => {
    const months = intIn(req.query.months, 1, 36, 12);
    let src = 'SELECT kind, reason, status, action, created_at FROM content_reports';
    // 클라우드 다운로드 차단 이의제기(offline 모듈, A-08)도 이의제기로 센다: 인용 → 차단 해제, 기각 → 조치 없음
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='offline_appeals'").get()) {
      src += ` UNION ALL SELECT 'appeal', 'appeal', CASE status WHEN 'open' THEN 'open' ELSE 'resolved' END,
        CASE status WHEN 'accepted' THEN 'unblock' WHEN 'rejected' THEN 'dismiss' END, created_at FROM offline_appeals`;
    }
    // 공개 API 라 행을 다 읽지 않고 SQL 에서 월(한국 시간)·종류·상태별로 묶어 센다
    const rows = db
      .prepare(`SELECT strftime('%Y-%m', (created_at + 32400000) / 1000, 'unixepoch') AS m, kind, reason, status, action, COUNT(*) AS n FROM (${src}) GROUP BY m, kind, reason, status, action`)
      .all();
    const byMonth = new Map();
    // 사유별 접수·조치(차단·정지) 수: 아동 보호·저작권 정책이 공개를 약속한 건수
    const byReason = {};
    const blank = () => ({ received: { report: 0, copyright: 0, appeal: 0 }, actions: { block: 0, suspend: 0, dismiss: 0, unblock: 0 }, pending: 0 });
    const totals = blank();
    for (const r of rows) {
      if (!byMonth.has(r.m)) byMonth.set(r.m, blank());
      for (const o of [byMonth.get(r.m), totals]) {
        o.received[r.kind] = (o.received[r.kind] || 0) + r.n;
        if (r.status === 'open') o.pending += r.n;
        else if (r.action) o.actions[r.action] = (o.actions[r.action] || 0) + r.n;
      }
      if (r.kind === 'appeal') continue;
      const x = (byReason[r.reason] ||= { received: 0, actioned: 0 });
      x.received += r.n;
      if (r.action === 'block' || r.action === 'suspend') x.actioned += r.n;
    }
    // 합계(totals)는 첫 접수 월(since)부터 전체 기간. 월별 표는 이번 달부터 거꾸로 months 개월(첫 접수 월 전은 빼고), 0건인 달도 넣는다
    const since = [...byMonth.keys()].sort()[0] || null;
    const periods = [];
    for (let k = periodKeys(now()).month.slice(2); since && k >= since && periods.length < months; k = prevMonth(k)) periods.push({ period: k, ...(byMonth.get(k) || blank()) });
    const blocklist = Object.fromEntries(db.prepare('SELECT kind, COUNT(*) AS n FROM blocklist GROUP BY kind').all().map((r) => [r.kind, r.n]));
    res.json({ generatedAt: now(), since, periods, totals, byReason, blocklist });
  });

  // ---------- 사이트 내 알림(K-05) ----------
  // 보안 경고가 담기므로 웹 세션(scope *)이나 account 권한 토큰만 쓴다(files:read 토큰으로 읽거나 읽음 처리해 숨기지 못하게)
  const requireUser = requireScope('account');
  app.get('/api/notifications', requireUser, (req, res) => {
    const size = intIn(req.query.limit, 1, 100, 20);
    const page = intIn(req.query.page, 1, 1e6, 1);
    const uid = req.user.id;
    // 영어 사용자는 영어 제목·본문이 있으면 그것을(없으면 한국어) 받는다(K-03)
    const en = req.user.lang === 'en';
    const items = db
      .prepare(
        `SELECT id, kind, ${en ? 'COALESCE(title_en, title)' : 'title'} AS title, ${en ? "COALESCE(NULLIF(body_en, ''), body)" : 'body'} AS body, link, read_at AS readAt, created_at AS createdAt
         FROM notifications WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(uid, size, (page - 1) * size);
    const { total, unread } = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(read_at IS NULL),0) AS unread FROM notifications WHERE user_id=?').get(uid);
    res.json({ items, page, total, unread, hasMore: page * size < total });
  });
  app.get('/api/notifications/unread-count', requireUser, (req, res) => {
    res.json({ count: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').get(req.user.id).n });
  });
  app.post('/api/notifications/read', requireUser, (req, res) => {
    const b = req.body || {};
    let r;
    if (b.all === true) r = db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), req.user.id);
    else {
      const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string').slice(0, 500) : fail(400, 'invalid_ids', 'ids 또는 all 이 필요합니다');
      r = db
        .prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))')
        .run(now(), req.user.id, JSON.stringify(ids));
    }
    res.json({ updated: Number(r.changes) });
  });

  // ---------- 앱 푸시 구독(K-05): 브라우저 Push API 구독을 저장하면 notify() 가 push 도 보낸다 ----------
  // VAPID 공개키가 없으면(설정 전) 화면이 이유를 안내한다
  app.get('/api/notifications/push/key', requireUser, (_req, res) => res.json({ publicKey: cfg.vapidPublicKey || process.env.MIMIC_VAPID_PUBLIC_KEY || null }));
  const B64URL = /^[A-Za-z0-9_-]+=*$/;
  const endpointOf = (v) => {
    const e = typeof v === 'string' ? v.trim() : '';
    let ok = false;
    try {
      ok = e.length <= 1000 && new URL(e).protocol === 'https:';
    } catch {}
    return ok ? e : fail(400, 'invalid_endpoint', '푸시 주소(https)를 확인해 주세요');
  };
  app.post('/api/notifications/push-subscriptions', requireUser, (req, res) => {
    const b = req.body || {};
    const endpoint = endpointOf(b.endpoint);
    const { p256dh, auth } = b.keys || {};
    const okKey = (k, lo, hi) => typeof k === 'string' && k.length >= lo && k.length <= hi && B64URL.test(k);
    if (!okKey(p256dh, 80, 100) || !okKey(auth, 16, 32)) fail(400, 'invalid_keys', '푸시 키(p256dh·auth)를 확인해 주세요');
    limit(req, 'push-sub', 60);
    // 같은 기기(endpoint)에 다른 계정으로 다시 켜면 그 계정으로 옮긴다. 한 사람당 최근 20대까지
    db.prepare(
      'INSERT INTO push_subscriptions (id, user_id, endpoint, keys, created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, keys=excluded.keys, created_at=excluded.created_at',
    ).run(newId('ps_'), req.user.id, endpoint, JSON.stringify({ p256dh, auth }), now());
    db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT 20)').run(req.user.id, req.user.id);
    res.status(201).json({ ok: true });
  });
  app.delete('/api/notifications/push-subscriptions', requireUser, (req, res) => {
    const endpoint = endpointOf(req.body?.endpoint ?? req.query.endpoint);
    res.json({ removed: Number(db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id, endpoint).changes) });
  });
}
