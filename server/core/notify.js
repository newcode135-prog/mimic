import { now, newId } from './util.js';

// 사이트 내 알림(K-05)
export function notify(db, userId, { kind, title, body = '', link = null }) {
  db.prepare('INSERT INTO notifications (id, user_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)').run(
    newId('n_'),
    userId,
    kind,
    title,
    body,
    link,
    now(),
  );
}

// 이메일·SMS·푸시·텔레그램 발송. 개발 모드에서는 outbox 에만 쌓고 콘솔에 출력한다(/dev/outbox 에서 확인).
// ponytail: 운영용 발송 대행사 연동은 맥미니 배포 단계에서 이 함수 안에 추가
export function sendMessage(db, cfg, { channel, to, subject = null, body }) {
  db.prepare('INSERT INTO outbox (id, channel, to_addr, subject, body, created_at) VALUES (?,?,?,?,?,?)').run(
    newId('o_'),
    channel,
    to,
    subject,
    body,
    now(),
  );
  if (cfg.dev && !cfg.quiet) console.log(`[outbox:${channel} → ${to}] ${subject ? subject + ' | ' : ''}${body}`);
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
