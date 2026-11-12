// 알림(K-05): /drive/notifications — 최신순 목록, 읽음·모두 읽음, 링크 이동
import { api, h, icon, t, formatDate, toastError, loadCss } from '/ui.js';
import { refreshShell } from '/layout.js';

const KIND_ICON = { telegram: 'send', invite: 'gift', checkin: 'gift', expiry: 'clock', offline_appeal: 'flag', offline: 'cloudDown', download: 'cloudDown', share: 'share', premium: 'crown', payment: 'crown', billing: 'crown', quota: 'chart', account: 'shield', security: 'shield', token: 'shield', report: 'flag', notice: 'bell', support: 'mail', vault: 'lock' };

// 이 기기에서 앱 푸시 받기(K-05): 권한 → pushManager.subscribe → 서버에 구독 저장. 쓸 수 없으면 이유를 보여 준다
const b64 = (s) => Uint8Array.from(atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
function pushToggle() {
  const box = h('input', { type: 'checkbox', disabled: true });
  const note = h('span', { class: 'muted small' });
  const wrap = h('label', { class: 'check' }, box, t('이 기기에서 푸시 받기', 'Push notifications on this device'), ' ', note);
  const off = (why) => ((box.disabled = true), (note.textContent = why));
  (async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return off(t('이 브라우저는 푸시를 지원하지 않아요', 'This browser does not support push'));
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return off(t('서비스 워커가 꺼져 있어 푸시를 쓸 수 없어요(개발 주소에서는 기본으로 꺼짐)', 'Push needs the service worker, which is off here (disabled by default on dev hosts)'));
    const { publicKey } = await api('/api/notifications/push/key');
    if (!publicKey) return off(t('서버에 푸시 키(VAPID)가 아직 설정되지 않았어요', 'Push keys (VAPID) are not configured on the server yet'));
    if (Notification.permission === 'denied') return off(t('브라우저 설정에서 이 사이트의 알림이 차단되어 있어요', 'Notifications are blocked for this site in your browser'));
    box.checked = !!(await reg.pushManager.getSubscription());
    box.disabled = false;
    box.onchange = async () => {
      box.disabled = true;
      try {
        if (box.checked) {
          if ((await Notification.requestPermission()) !== 'granted') throw new Error(t('알림 권한을 허용해야 해요', 'Allow notifications to turn this on'));
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
          await api('/api/notifications/push-subscriptions', { method: 'POST', body: sub.toJSON() });
        } else {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            await api('/api/notifications/push-subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } });
            await sub.unsubscribe();
          }
        }
      } catch (e) {
        box.checked = !box.checked;
        toastError(e);
      } finally {
        box.disabled = false;
      }
    };
  })().catch(() => off(t('푸시 상태를 확인하지 못했어요', 'Could not check push status')));
  return wrap;
}

export async function render(root, ctx) {
  loadCss('/css/content.css');
  document.title = t('알림 — 미믹', 'Notifications — Mimic');
  let page = 0;
  const list = h('div', { class: 'card', style: { padding: 0, overflow: 'hidden' } });
  const more = h('button', { class: 'btn block', style: { marginTop: '12px' }, onclick: () => load() }, t('더 보기', 'Load more'));
  const allBtn = h('button', { class: 'btn sm', html: `${icon('check')}<span>${t('모두 읽음', 'Mark all read')}</span>` });
  const summary = h('span', { class: 'muted small' });

  async function markRead(body) {
    await api('/api/notifications/read', { method: 'POST', body });
    refreshShell().catch(() => {});
  }
  function open(n, el) {
    if (!n.readAt) {
      n.readAt = Date.now();
      el.classList.remove('unread');
      el.querySelector('.pip')?.remove();
      markRead({ ids: [n.id] }).catch(toastError);
    }
    const link = n.link || '';
    if (/^\/(?!\/)/.test(link)) ctx.navigate(link);
    else if (/^https?:\/\//i.test(link)) window.open(link, '_blank', 'noopener');
  }
  const item = (n) => {
    const el = h(
      'div',
      { class: `mc-noti ${n.readAt ? '' : 'unread'}`, role: 'button', tabindex: 0 },
      h('div', { class: 'ic', html: icon(KIND_ICON[n.kind] || 'bell') }),
      h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 't' }, n.title), n.body ? h('div', { class: 'b' }, n.body) : null, h('div', { class: 'd' }, formatDate(n.createdAt), n.link ? ' · ' + t('눌러서 이동', 'Open') : '')),
      n.readAt ? null : h('span', { class: 'pip', 'aria-label': t('안 읽음', 'Unread') }),
    );
    el.onclick = () => open(n, el);
    el.onkeydown = (e) => e.key === 'Enter' && open(n, el);
    return el;
  };
  async function load() {
    more.disabled = true;
    try {
      const r = await api(`/api/notifications?page=${++page}&limit=20`);
      if (page === 1 && !r.items.length) list.replaceWith(h('div', { class: 'empty', html: icon('bell') }, h('h3', {}, t('아직 알림이 없어요', 'No notifications yet')), h('p', {}, t('다운로드 완료, 만료 예정, 보안 알림 등이 여기에 모여요.', 'Download results, expiry notices and security alerts show up here.'))));
      list.append(...r.items.map(item));
      summary.textContent = t(`전체 ${r.total}개 · 안 읽음 ${r.unread}개`, `${r.total} total · ${r.unread} unread`);
      allBtn.disabled = !r.unread;
      more.classList.toggle('hidden', !r.hasMore);
    } catch (e) {
      toastError(e);
    } finally {
      more.disabled = false;
    }
  }
  allBtn.onclick = async () => {
    try {
      await markRead({ all: true });
      list.querySelectorAll('.unread').forEach((el) => {
        el.classList.remove('unread');
        el.querySelector('.pip')?.remove();
      });
      allBtn.disabled = true;
      summary.textContent = t('모두 읽었어요', 'All caught up');
    } catch (e) {
      toastError(e);
    }
  };
  root.replaceChildren(h('div', { class: 'page-head' }, h('h2', {}, t('알림', 'Notifications')), summary, h('div', { class: 'spacer' }), allBtn), h('div', { style: { margin: '0 0 12px' } }, pushToggle()), list, more);
  await load();
}
