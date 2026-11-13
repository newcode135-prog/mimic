// 정책 문서 7종(J-04): 초안 표시 + 문서 목록·목차. 영어본은 편의 번역이고 한국어본이 우선한다
import { api, h, icon, t } from '/ui.js';
import { setup, docBody } from '/pages/help.js';

export async function render(root, ctx) {
  if (setup(ctx)) return;
  const { policy, policies } = await api(`/api/content/policies/${encodeURIComponent(ctx.params.slug)}`);
  document.title = `${t(policy.title, policy.en)} — ${t('미믹', 'Mimic')}`;
  const side = h(
    'nav',
    { class: 'mc-side', 'aria-label': t('정책 문서', 'Policies') },
    h('h4', {}, t('정책 문서', 'Policies')),
    ...policies.map((p) => h('a', { href: `/policy/${p.slug}`, class: p.slug === policy.slug ? 'active' : '' }, t(p.title, p.en))),
    h('h4', {}, t('이 문서의 목차', 'On this page')),
    ...policy.sections.map((s) => h('a', { href: `#${s.id}`, onclick: (e) => (e.preventDefault(), document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' })) }, s.title)),
  );
  root.replaceChildren(
    h(
      'div',
      { class: 'container' },
      h(
        'div',
        { class: 'mc-split' },
        side,
        h(
          'article',
          { class: 'mc-article mc-policy' },
          h('h1', {}, policy.title),
          policy.draft ? h('div', { class: 'mc-draft', html: icon('info') }, h('span', {}, t('초안 — 법무 검토 필요. 정식 게시 전 내용이 바뀔 수 있어요.', 'Draft — pending legal review. Content may change before publication.'))) : null,
          h('p', { class: 'muted small' }, t(`최종 수정일 ${policy.updated}`, `Last updated ${policy.updated}`), t('', ' · This English version is a translation provided for convenience. If it differs from the Korean version, the Korean version prevails.')),
          ...policy.sections.map((s) => h('section', { id: s.id }, h('h2', {}, s.title), docBody(s.body))),
        ),
      ),
    ),
  );
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
