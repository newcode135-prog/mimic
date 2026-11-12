// 블로그(K-02): /blog 목록, /blog/:slug 글
import { api, h, t } from '/ui.js';
import { setup, docBody, koOnly } from '/pages/help.js';

export async function render(root, ctx) {
  if (setup(ctx)) return;
  if (ctx.params.slug) {
    const { post } = await api(`/api/content/blog/${encodeURIComponent(ctx.params.slug)}`);
    document.title = `${t(post.title, post.en)} — ${t('미믹 블로그', 'Mimic blog')}`;
    root.replaceChildren(
      h(
        'div',
        { class: 'container narrow' },
        h('div', { class: 'mc-crumbs' }, h('a', { href: '/blog' }, t('블로그', 'Blog')), '›', h('span', {}, post.date)),
        h(
          'article',
          { class: 'mc-article' },
          h('div', { class: 'row', style: { marginBottom: '10px' } }, ...post.tags.map((x) => h('span', { class: 'badge brand' }, x)), h('span', { class: 'muted small' }, post.date)),
          h('h1', {}, t(post.title, post.en)),
          koOnly(),
          h('p', { class: 'mc-lead', style: { marginBottom: '22px' } }, post.summary),
          docBody(post.body),
        ),
        h('p', { style: { marginTop: '18px' } }, h('a', { href: '/blog' }, t('← 다른 글 보기', '← More posts'))),
      ),
    );
    return;
  }
  document.title = t('블로그 — 미믹', 'Blog — Mimic');
  const { posts } = await api('/api/content/blog');
  root.replaceChildren(
    h('div', { class: 'mc-page-title' }, h('span', { class: 'mc-eyebrow' }, 'Blog'), h('h1', {}, t('미믹 블로그', 'Mimic blog')), h('p', { class: 'mc-lead', style: { margin: '0 auto' } }, t('새 소식과 활용법을 전해요.', 'News and how-tos.')), koOnly()),
    h(
      'div',
      { class: 'container' },
      h(
        'div',
        { class: 'mc-grid' },
        ...posts.map((p) =>
          h(
            'a',
            { class: 'mc-tile', href: `/blog/${p.slug}` },
            h('div', { class: 'row' }, ...p.tags.map((x) => h('span', { class: 'badge brand' }, x)), h('span', { class: 'muted small' }, p.date)),
            h('h3', {}, t(p.title, p.en)),
            h('p', {}, p.summary),
            h('span', { class: 'small', style: { color: 'var(--brand-strong)', fontWeight: 600 } }, t('읽어 보기 →', 'Read →')),
          ),
        ),
      ),
    ),
  );
}
