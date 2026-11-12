// 자주 묻는 질문(K-01): 분류별 펼치기 + 바로 거르기
import { api, h, icon, t } from '/ui.js';
import { setup, koOnly } from '/pages/help.js';

export async function render(root, ctx) {
  if (setup(ctx)) return;
  document.title = t('자주 묻는 질문 — 미믹', 'FAQ — Mimic');
  const { items } = await api('/api/content/faq');
  const list = h('div', { class: 'mc-faq' });
  const draw = (q = '') => {
    const shown = items.filter((f) => !q || (f.q + f.a).toLowerCase().includes(q.toLowerCase()));
    const cats = [...new Set(shown.map((f) => f.cat))];
    list.replaceChildren(
      ...cats.flatMap((c) => [
        h('h3', {}, c),
        ...shown
          .filter((f) => f.cat === c)
          .map((f) => h('details', { id: f.id, open: f.id === location.hash.slice(1) }, h('summary', {}, f.q), h('div', { class: 'ans' }, h('p', {}, f.a), f.help ? h('a', { href: `/help/${f.help}` }, t('자세한 도움말 보기 →', 'Read the full article →')) : null))),
      ]),
      ...(shown.length ? [] : [h('div', { class: 'empty' }, t('맞는 질문이 없어요.', 'No matching questions.'))]),
    );
  };
  const filter = h('input', { class: 'input', type: 'search', placeholder: t('질문 거르기', 'Filter questions'), 'aria-label': t('질문 거르기', 'Filter questions'), oninput: (e) => draw(e.target.value.trim()) });
  draw();
  root.replaceChildren(
    h('div', { class: 'mc-page-title' }, h('span', { class: 'mc-eyebrow' }, 'FAQ'), h('h1', {}, t('자주 묻는 질문', 'Frequently asked questions')), h('div', { class: 'mc-search', html: icon('search') }, filter)),
    h(
      'div',
      { class: 'container narrow' },
      koOnly(),
      list,
      h('div', { class: 'mc-note brand', style: { marginTop: '24px' }, html: icon('help') }, h('div', {}, t('더 궁금한 점이 있다면 ', 'Still have questions? '), h('a', { href: '/help' }, t('도움말 센터', 'Help center')), ' · ', h('a', { href: '/contact' }, t('문의하기', 'Contact us')))),
    ),
  );
}
