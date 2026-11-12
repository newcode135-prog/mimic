// 개발 모드 전용: 실제로 보내지 않은 이메일·SMS 확인(인증코드 확인용)
import { api, h, formatDate } from '../ui.js';

export async function render(root) {
  let items = [];
  try {
    items = (await api('/api/dev/outbox')).items;
  } catch {
    root.replaceChildren(h('div', { class: 'empty' }, '개발 모드에서만 볼 수 있습니다'));
    return;
  }
  root.replaceChildren(
    h(
      'div',
      { class: 'container' },
      h('h1', {}, '개발용 발송함'),
      h('p', { class: 'muted' }, '개발 모드에서는 이메일·SMS 를 실제로 보내지 않고 여기에 쌓습니다. 인증코드를 여기서 확인하세요.'),
      h(
        'table',
        { class: 'table card' },
        h('thead', {}, h('tr', {}, h('th', {}, '시각'), h('th', {}, '채널'), h('th', {}, '받는 곳'), h('th', {}, '내용'))),
        h('tbody', {}, ...items.map((o) => h('tr', {}, h('td', {}, formatDate(o.created_at)), h('td', {}, o.channel), h('td', {}, o.to_addr), h('td', {}, [o.subject, o.body].filter(Boolean).join(' — '))))),
      ),
    ),
  );
}
