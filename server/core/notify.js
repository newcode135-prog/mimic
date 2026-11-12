import { now, newId } from './util.js';

// 사이트 내 알림 + 앱 푸시(K-05). titleEn·bodyEn 은 영어 화면용(K-03, 없으면 한국어를 보여 준다)
export function notify(db, userId, { kind, title, body = '', link = null, titleEn = null, bodyEn = null }) {
  db.prepare('INSERT INTO notifications (id, user_id, kind, title, body, link, created_at, title_en, body_en) VALUES (?,?,?,?,?,?,?,?,?)').run(
    newId('n_'),
    userId,
    kind,
    title,
    body,
    link,
    now(),
    titleEn,
    bodyEn,
  );
  // 푸시를 켠 기기(push_subscriptions)가 있는 사용자에게만. 실제 기기별 발송은 sendMessage 의 push 채널이 맡는다
  const u = db.prepare('SELECT lang FROM users WHERE id=? AND EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id=users.id)').get(userId);
  if (!u) return;
  const en = u.lang === 'en';
  sendMessage(db, { quiet: true }, { channel: 'push', to: userId, subject: (en && titleEn) || title, body: (en && bodyEn) || body || link || '' });
}

// 이메일·SMS·푸시·텔레그램 발송. 개발 모드에서는 outbox 에만 쌓고 콘솔에 출력한다(/dev/outbox 에서 확인).
// 운영 모드의 email·sms 는 설정한 발송 대행사(cfg.mail·cfg.sms, MIMIC_EMAIL_API·MIMIC_SMS_API)로 보낸다. 호출한 쪽을 막지 않도록 기다리지 않는다
// ponytail: 대행사 형식은 JSON { from, to, subject, text } + Bearer 한 가지, 실패는 로그만. 재시도·다른 형식이 필요하면 outbox 에 발송 상태 열을 두고 작업으로 다시 보낸다
export function sendMessage(db, cfg, { channel, to, subject = null, body }) {
  db.prepare('INSERT INTO outbox (id, channel, to_addr, subject, body, created_at) VALUES (?,?,?,?,?,?)').run(
    newId('o_'),
    channel,
    to,
    subject,
    body,
    now(),
  );
  if (cfg.dev) {
    if (!cfg.quiet) console.log(`[outbox:${channel} → ${to}] ${subject ? subject + ' | ' : ''}${body}`);
    return;
  }
  const p = channel === 'email' ? cfg.mail : channel === 'sms' ? cfg.sms : null;
  if (!p?.api) {
    if (p && !cfg.quiet) console.error(`[notify] ${channel} 발송 대행사가 설정되지 않아 ${to} 에게 보내지 못했습니다`);
    return;
  }
  const from = p.from || (channel === 'email' ? cfg.supportEmail : undefined);
  fetch(p.api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(p.key ? { authorization: `Bearer ${p.key}` } : {}) },
    body: JSON.stringify({ from, to, subject: subject ?? undefined, text: body }),
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (r) => {
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
    })
    .catch((e) => console.error(`[notify] ${channel} → ${to} 발송 실패: ${e.message}`));
}

export function audit(db, { userId = null, action, detail = null, ip = null }) {
  db.prepare('INSERT INTO audit_log (id, user_id, action, detail, ip, created_at) VALUES (?,?,?,?,?,?)').run(
    newId('a_'),
    userId,
    action,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    ip,
    now(),
  );
}
