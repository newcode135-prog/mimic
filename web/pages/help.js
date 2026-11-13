// 도움말 센터(K-01): /help(카테고리·검색), /help/:slug(글). 다른 콘텐츠 화면이 쓰는 setup·docBody 도 여기 둔다.
import { api, h, esc, icon, t, loadCss, getLang, setLang } from '/ui.js';

// 공개 화면 공통 준비: 스타일 + 주소의 ?lang=ko|en 로 언어 바꾸기(K-03 URL 로케일)
export function setup(ctx) {
  loadCss('/css/content.css');
  const l = ctx.query?.lang;
  if ((l === 'ko' || l === 'en') && l !== getLang()) {
    setLang(l);
    location.reload();
    return true;
  }
  return false;
}

// 본문 안의 [화면 이름] 을 해당 화면 링크로 바꾼다(영어 본문은 영어 화면 이름)
const LINKS = {
  'Contact us': '/contact',
  'Copyright report': '/copyright',
  'Copyright notice': '/copyright',
  Report: '/copyright?tab=report',
  'Reports & appeals': '/copyright?tab=appeal',
  'Check-in guide': '/check-in-guide',
  Apps: '/apps',
  'Apps > Browser extension': '/apps/extension',
  'Invite friends': '/drive/invite',
  'Subscriptions & purchases': '/drive/orders',
  'Subscriptions & purchases > Subscriptions': '/drive/orders',
  'Subscriptions & purchases > Manage subscription': '/drive/orders',
  'Settings > Transfer quota': '/drive/quota',
  'My shares': '/drive/shared',
  'Account & security': '/drive/account',
  'Account & security > Password': '/drive/account/password',
  'Account & security > Connected apps': '/drive/account/apps',
  'Account & security > Close account': '/drive/account/delete',
  'Connected apps': '/drive/account/apps',
  'Settings > General': '/drive/settings/basic',
  'Settings > General > Share code display': '/drive/settings/basic',
  'Settings > Transfer': '/drive/settings/transfer',
  'Settings > Access & integrations': '/drive/settings/integrations',
  'Settings > Access & integrations > MCP': '/drive/settings/integrations',
  문의하기: '/contact',
  '저작권 신고': '/copyright',
  신고하기: '/copyright?tab=report',
  '신고·이의제기': '/copyright?tab=appeal',
  '출석 체크 안내': '/check-in-guide',
  '앱 다운로드': '/apps',
  '앱 다운로드 > 브라우저 확장': '/apps/extension',
  '친구 초대': '/drive/invite',
  '구독·구매 기록': '/drive/orders',
  '설정 > 전송 쿼터': '/drive/quota',
  '나의 공유': '/drive/shared',
  '계정 및 보안': '/drive/account',
  '계정 및 보안 > 비밀번호': '/drive/account/password',
  '계정 및 보안 > 연결된 앱': '/drive/account/apps',
  '계정 및 보안 > 계정 해제': '/drive/account/delete',
  '연결된 앱': '/drive/account/apps',
  '설정 > 기본': '/drive/settings/basic',
  '설정 > 기본 > 공유 코드 표시': '/drive/settings/basic',
  '설정 > 전송': '/drive/settings/transfer',
  '설정 > 액세스 및 통합': '/drive/settings/integrations',
  '설정 > 액세스 및 통합 > MCP': '/drive/settings/integrations',
  '구독·구매 기록 > 구독 관리': '/drive/orders',
};
function inline(text) {
  return text.split(/\[([^\]]+)\]/).map((part, i) => (i % 2 ? (LINKS[part] ? h('a', { href: LINKS[part] }, part) : h('strong', {}, part)) : part));
}
// 본문 표기: 빈 줄 = 문단, "- " = 목록, "1. " = 순서 목록, "## " = 소제목. 모든 글자는 텍스트 노드로 넣는다(HTML 해석 안 함)
export function docBody(text) {
  const root = h('div', { class: 'doc' });
  for (const block of String(text || '').split(/\n\s*\n/)) {
    let list = null;
    for (const line of block.split('\n')) {
      let m;
      if ((m = /^## (.*)/.exec(line))) {
        list = null;
        root.append(h('h3', {}, m[1]));
      } else if ((m = /^(- |\d+\. )(.*)/.exec(line))) {
        const tag = m[1] === '- ' ? 'UL' : 'OL';
        if (list?.tagName !== tag) root.append((list = h(tag.toLowerCase())));
        list.append(h('li', {}, inline(m[2])));
      } else if (line.trim()) {
        list = null;
        root.append(h('p', {}, inline(line)));
      }
    }
  }
  return root;
}

const searchBox = (navigate, value = '') => {
  const input = h('input', { class: 'input', type: 'search', value, placeholder: t('궁금한 내용을 검색해 보세요 (예: 휴지통, 환불)', 'Search help (e.g. trash, refund)'), 'aria-label': t('도움말 검색', 'Search help') });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && navigate(input.value.trim() ? `/help?q=${encodeURIComponent(input.value.trim())}` : '/help'));
  return h('div', { class: 'mc-search', html: icon('search') }, input);
};
const contactCard = () =>
  h(
    'div',
    { class: 'mc-note brand', style: { marginTop: '24px' }, html: icon('help') },
    h('div', {}, h('b', {}, t('원하는 답을 찾지 못했나요? ', "Didn't find an answer? ")), h('a', { href: '/contact' }, t('문의하기', 'Contact us')), ' · ', h('a', { href: '/faq' }, t('자주 묻는 질문', 'FAQ'))),
  );

export async function render(root, ctx) {
  if (setup(ctx)) return;
  const { categories, results } = await api('/api/content/help' + (ctx.query.q ? `?q=${encodeURIComponent(ctx.query.q)}` : ''));
  const title = (c) => t(c.title, c.en);

  if (ctx.params.slug) {
    const { article, category, related } = await api(`/api/content/help/${encodeURIComponent(ctx.params.slug)}`);
    document.title = `${article.title} — ${t('미믹 도움말', 'Mimic help')}`;
    const side = h('nav', { class: 'mc-side', 'aria-label': t('도움말 분류', 'Help categories') }, h('h4', {}, t('분류', 'Categories')));
    for (const c of categories) {
      side.append(h('a', { href: `/help/${c.articles[0]?.slug}`, class: c.id === category.id ? 'active' : '', html: `${icon(c.icon)}<span>${esc(title(c))}</span>` }));
    }
    root.replaceChildren(
      h(
        'div',
        { class: 'container' },
        h(
          'div',
          { class: 'mc-split' },
          side,
          h(
            'div',
            {},
            h('div', { class: 'mc-crumbs' }, h('a', { href: '/help' }, t('도움말 센터', 'Help center')), '›', h('span', {}, title(category))),
            h('article', { class: 'mc-article' }, h('h1', {}, article.title), docBody(article.body)),
            related.length
              ? h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', {}, t('같은 분류의 다른 글', 'Related articles')), h('div', { class: 'col' }, ...related.map((a) => h('a', { href: `/help/${a.slug}` }, a.title))))
              : null,
            contactCard(),
          ),
        ),
      ),
    );
    return;
  }

  document.title = t('도움말 센터 — 미믹', 'Help center — Mimic');
  const head = h(
    'div',
    { class: 'mc-page-title' },
    h('span', { class: 'mc-eyebrow' }, 'Help center'),
    h('h1', {}, t('무엇을 도와드릴까요?', 'How can we help?')),
    searchBox(ctx.navigate, ctx.query.q || ''),
  );
  let bodyEl;
  if (results) {
    bodyEl = h(
      'div',
      { class: 'container narrow' },
      h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h3', { style: { margin: 0 } }, t(`"${ctx.query.q}" 검색 결과 ${results.length}건`, `${results.length} results for "${ctx.query.q}"`)), h('div', { class: 'spacer' }), h('a', { href: '/help' }, t('전체 분류 보기', 'All categories'))),
      results.length
        ? h('div', { class: 'card col' }, ...results.map((a) => h('a', { href: `/help/${a.slug}` }, a.title, ' ', h('span', { class: 'muted small' }, title(categories.find((c) => c.id === a.category))))))
        : h('div', { class: 'empty' }, t('찾는 글이 없어요. 다른 단어로 검색하거나 문의해 주세요.', 'No results. Try other words or contact us.')),
      contactCard(),
    );
  } else {
    bodyEl = h(
      'div',
      { class: 'container' },
      h(
        'div',
        { class: 'mc-grid' },
        ...categories.map((c) =>
          h(
            'div',
            { class: 'mc-tile' },
            h('div', { class: 'row' }, h('div', { class: 'ic', html: icon(c.icon) }), h('div', {}, h('h3', { style: { margin: 0 } }, title(c)), h('div', { class: 'muted small' }, t(`${c.articles.length}개 글`, `${c.articles.length} articles`)))),
            h('p', { class: 'small' }, c.desc),
            h('div', { class: 'mc-cat-links' }, ...c.articles.map((a) => h('a', { href: `/help/${a.slug}` }, a.title))),
          ),
        ),
      ),
      contactCard(),
    );
  }
  root.replaceChildren(head, bodyEl);
}
