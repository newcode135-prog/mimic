// 화면 라우터. 각 주소는 web/pages/<페이지>.js 의 render(main, ctx) 가 그린다(docs/BUILD_SPEC.md 3장).
import { getMe, h, icon, toast, setLang, getLang, hasSavedLang, t } from './ui.js';
import { mountLayout } from './layout.js';

// [주소, 페이지 모듈, 레이아웃, 접근(public|guest|user|admin)] — 담당 모듈은 docs/BUILD_SPEC.md 표 참고
export const ROUTES = [
  ['/', 'landing', 'site', 'public'],
  ['/bt', 'bt', 'site', 'public'],
  ['/pricing', 'payment', 'site', 'public'],
  ['/apps', 'apps', 'site', 'public'],
  ['/apps/:platform', 'apps', 'site', 'public'],
  ['/blog', 'blog', 'site', 'public'],
  ['/blog/:slug', 'blog', 'site', 'public'],
  ['/help', 'help', 'site', 'public'],
  ['/help/:slug', 'help', 'site', 'public'],
  ['/faq', 'faq', 'site', 'public'],
  ['/contact', 'contact', 'site', 'public'],
  ['/policy/:slug', 'policy', 'site', 'public'],
  ['/transparency', 'transparency', 'site', 'public'],
  ['/copyright', 'copyright', 'site', 'public'],
  ['/check-in-guide', 'checkin-guide', 'site', 'public'],
  ['/s/:token', 'share-view', 'site', 'public'],
  ['/vs/:token', 'vault-share', 'site', 'public'],
  ['/login', 'login', 'auth', 'guest'],
  ['/signup', 'login', 'auth', 'guest'],
  ['/reset-password', 'login', 'auth', 'guest'],
  ['/approve', 'approve', 'auth', 'user'],
  ['/drive', '=>/drive/all'],
  ['/drive/all', 'drive', 'drive', 'user'],
  ['/drive/folder/:id', 'drive', 'drive', 'user'],
  ['/drive/recent', 'drive', 'drive', 'user'],
  ['/drive/star', 'drive', 'drive', 'user'],
  ['/drive/trash', 'drive', 'drive', 'user'],
  ['/drive/search', 'drive', 'drive', 'user'],
  ['/drive/shared', 'shared', 'drive', 'user'],
  ['/drive/watch-history', 'history', 'drive', 'user'],
  ['/drive/vault', 'vault', 'drive', 'user'],
  ['/drive/payment', 'payment', 'drive', 'user'],
  ['/drive/orders', 'orders', 'drive', 'user'],
  ['/drive/quota', 'quota', 'drive', 'user'],
  ['/drive/invite', 'invite', 'drive', 'user'],
  ['/drive/notifications', 'notifications', 'drive', 'user'],
  ['/drive/account', '=>/drive/account/basic'],
  ['/drive/account/:tab', 'account', 'drive', 'user'],
  ['/drive/settings', '=>/drive/settings/basic'],
  ['/drive/settings/:tab', 'settings', 'drive', 'user'],
  ['/play/:id', 'player', 'bare', 'user'],
  ['/preview/:id', 'preview', 'bare', 'user'],
  ['/admin', '=>/admin/dashboard'],
  ['/admin/:section', 'admin', 'admin', 'admin'],
  ['/tv', 'tv', 'bare', 'public'],
  ['/dev/outbox', 'dev-outbox', 'site', 'public'],
];

const compiled = ROUTES.map(([pattern, page, layout, access]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  return { pattern, page, layout, access, keys, re };
});
function match(path) {
  for (const r of compiled) {
    const m = r.re.exec(path);
    if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export function navigate(to, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  render();
}
window.addEventListener('popstate', () => render());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/webdav')) return;
  e.preventDefault();
  if (url.pathname + url.search !== location.pathname + location.search) navigate(url.pathname + url.search + url.hash);
});

function comingSoon(page) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { html: icon('cloud') }),
    h('h3', {}, t('이 화면은 준비 중입니다', 'This page is coming soon')),
    h('p', { class: 'small' }, `${t('페이지 모듈', 'Page module')}: web/pages/${page}.js`),
  );
}

let cleanup = null;
let seq = 0;
let langFromUrl = false; // 이번 페이지에서 주소(?lang)로 언어를 정했으면 계정 언어로 덮지 않는다
async function render() {
  const my = ++seq;
  try {
    cleanup?.();
  } catch {}
  cleanup = null;
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  // URL 로케일(K-03): /en/faq·/en-US/faq·/ko/... 는 접두어를 ?lang= 로 바꾸고, ?lang=ko|en 은 주소에 남겨 공유 링크에도 언어가 실린다
  const pre = /^\/(ko|en)(?:-[a-z]{2})?(?=\/|$)/i.exec(location.pathname);
  if (pre) {
    const sp = new URLSearchParams(location.search);
    sp.set('lang', pre[1].toLowerCase());
    history.replaceState({}, '', `${location.pathname.slice(pre[0].length) || '/'}?${sp}${location.hash}`);
  }
  const urlLang = new URLSearchParams(location.search).get('lang');
  if (urlLang === 'ko' || urlLang === 'en') {
    langFromUrl = true;
    if (urlLang !== getLang()) {
      setLang(urlLang);
      if (hasSavedLang()) return location.reload(); // 저장이 안 되는 브라우저면 다시 불러오지 않고 이번 화면만 바꾼다(무한 새로고침 방지)
    }
  }
  const path = location.pathname;
  const query = Object.fromEntries(new URLSearchParams(location.search));
  const m = match(path);
  if (m?.page?.startsWith('=>')) return navigate(m.page.slice(2), { replace: true });

  let me = null;
  try {
    me = await getMe();
  } catch (e) {
    console.error(e);
  }
  if (my !== seq) return;
  // 이 기기에서 언어를 고른 적이 없으면 계정에 저장된 언어를 따른다(K-03)
  const accountLang = me?.user?.lang;
  if ((accountLang === 'ko' || accountLang === 'en') && accountLang !== getLang() && !hasSavedLang() && !langFromUrl) {
    setLang(accountLang);
    if (hasSavedLang()) return location.reload(); // 저장이 안 되는 브라우저면 다시 불러오지 않고 이번 화면만 바꾼다(무한 새로고침 방지)
  }
  if (m?.access === 'user' && !me) return navigate(`/login?next=${encodeURIComponent(path + location.search)}`, { replace: true });
  if (m?.access === 'guest' && me) return navigate(query.next || '/drive/all', { replace: true });

  const ctx = { params: m?.params || {}, query, me, user: me?.user || null, path, navigate, refreshMe: () => getMe(true) };
  const main = await mountLayout(m ? m.layout : 'site', ctx);
  if (my !== seq) return;
  if (!m) return main.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, t('페이지를 찾을 수 없습니다', 'Page not found')), h('a', { href: '/' }, t('홈으로', 'Go home'))));
  if (m.access === 'admin' && !me?.user?.isAdmin) {
    if (!me) return navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true });
    return main.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, t('관리자만 볼 수 있는 화면입니다', 'Admins only'))));
  }
  let mod;
  try {
    mod = await import(`/pages/${m.page}.js`);
  } catch (e) {
    console.warn(`페이지 ${m.page} 불러오기 실패`, e);
    return main.replaceChildren(comingSoon(m.page));
  }
  if (my !== seq) return;
  // 페이지는 이 root 안에만 그린다(나중에 다시 그릴 때도 같은 root 를 쓴다)
  const root = h('div', { class: 'page', 'data-page': m.page });
  main.replaceChildren(root);
  try {
    const ret = await mod.render(root, ctx);
    if (my !== seq) return typeof ret === 'function' && ret();
    if (typeof ret === 'function') cleanup = ret;
  } catch (e) {
    console.error(e);
    main.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, t('화면을 불러오지 못했습니다', 'Could not load this page')), h('p', { class: 'small' }, e.message || '')));
    toast(e.message || t('오류가 발생했습니다', 'Something went wrong'), 'error');
  }
}

render();
