// 레이아웃 4종: drive(로그인 후), site(공개), auth(로그인), admin(관리자), bare(전체 화면)
import { h, icon, t, api, getMe, clearMe, openMenu, callComponent, useComponent, formatBytes, setLang, getLang, toastError } from './ui.js';

let current = null;

export async function mountLayout(name, ctx) {
  if (current?.name === name) {
    current.update?.(ctx);
    current.main.scrollTop = 0;
    return current.main;
  }
  const built = BUILDERS[name](ctx);
  document.getElementById('app').replaceChildren(built.root);
  current = { name, ...built };
  current.update?.(ctx);
  await current.ready?.();
  return current.main;
}
// 결제·업로드 뒤 용량 표시 등을 새로 고친다
export async function refreshShell() {
  if (!current?.update) return;
  const me = await getMe(true);
  current.update({ me, path: location.pathname });
}

const logo = (href = '/') => h('a', { class: 'logo', href }, h('img', { src: '/logo.svg', alt: '', width: 30, height: 30 }), t('미믹', 'Mimic'));

// ---------- 드라이브(로그인 후) ----------
const NAV = [
  ['/drive/all', 'folder', '모든 파일', 'All files'],
  ['/drive/recent', 'clock', '최근 저장됨', 'Recent'],
  ['/drive/trash', 'trash', '휴지통', 'Trash'],
  ['/drive/shared', 'share', '나의 공유', 'My shares'],
  ['/drive/watch-history', 'history', '시청 기록', 'Watch history'],
  ['/drive/star', 'star', '즐겨찾기', 'Starred'],
  ['/drive/vault', 'lock', '금고', 'Vault'],
];
function activeNav(path) {
  if (path.startsWith('/drive/folder/') || path.startsWith('/drive/search')) return '/drive/all';
  return NAV.find(([p]) => path.startsWith(p))?.[0];
}

function driveLayout() {
  const main = h('main', { class: 'drive-main', id: 'drive-main' });
  const navLinks = NAV.map(([href, ic, ko, en]) => h('a', { class: 'nav-item', href, 'data-href': href, html: `${icon(ic)}<span>${t(ko, en)}</span>` }));
  const meterBar = h('span', { style: { width: '0%' } });
  const meterText = h('span');
  const premiumLink = h('a', { href: '/drive/payment', class: 'row', html: `${icon('crown')}<b>Premium</b>` });
  const sidebar = h(
    'aside',
    { class: 'sidebar', id: 'sidebar' },
    logo('/drive/all'),
    h('button', { class: 'btn primary lg block cta', html: `${icon('cloudDown')}<span>${t('클라우드 다운로드', 'Cloud download')}</span>`, onclick: () => callComponent('offline', 'openCreateTask') }),
    ...navLinks,
    h('a', { class: 'promo', href: '/check-in-guide', html: `${icon('gift')}<span>${t('브라우저 확장으로 매일 출석하고 프리미엄 받기', 'Daily check-in for free Premium')}</span>` }),
    h('a', { class: 'promo brand', href: '/drive/invite', html: `${icon('gift')}<span>${t('친구 초대하고 프리미엄 일수 받기', 'Invite friends, earn Premium')}</span>` }),
    h('div', { class: 'storage-meter' }, h('div', { class: 'progress' }, meterBar), meterText, premiumLink),
    h(
      'div',
      { class: 'app-links' },
      h('a', { href: '/apps/mobile', title: t('모바일 앱', 'Mobile app'), html: icon('phone') }),
      h('a', { href: '/apps/desktop', title: t('데스크톱 앱', 'Desktop app'), html: icon('desktop') }),
      h('a', { href: '/apps/extension', title: t('브라우저 확장', 'Browser extension'), html: icon('puzzle') }),
      h('a', { href: '/apps/tv', title: t('TV 앱', 'TV app'), html: icon('tv') }),
    ),
  );

  const search = h('input', { class: 'input', type: 'search', placeholder: t('파일 검색  Ctrl+F', 'Search files  Ctrl+F'), 'aria-label': t('파일 검색', 'Search files') });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && search.value.trim()) navigateTo(`/drive/search?q=${encodeURIComponent(search.value.trim())}`);
  });
  const bellDot = h('span', { class: 'dot hidden' });
  const avatar = h('button', { class: 'avatar', 'aria-label': t('내 계정', 'My account') });
  avatar.onclick = (e) => {
    e.stopPropagation();
    const me = current?.me?.user;
    openMenu(avatar, [
      { label: me?.name || me?.email || me?.phone || t('내 계정', 'My account'), icon: 'user', onClick: () => navigateTo('/drive/account/basic') },
      '-',
      { label: t('계정 및 보안', 'Account & security'), icon: 'shield', onClick: () => navigateTo('/drive/account/basic') },
      { label: t('구독·구매 기록', 'Orders'), icon: 'ticket', onClick: () => navigateTo('/drive/orders') },
      { label: t('피드백', 'Feedback'), icon: 'send', onClick: () => callComponent('feedback', 'openFeedback') },
      me?.isAdmin ? { label: t('관리자', 'Admin'), icon: 'chart', onClick: () => navigateTo('/admin/dashboard') } : null,
      '-',
      { label: t('로그아웃', 'Log out'), icon: 'logout', danger: true, onClick: logout },
    ]);
  };
  const gear = h('button', { class: 'btn ghost icon-btn', 'aria-label': t('설정', 'Settings'), html: icon('settings') });
  gear.onclick = (e) => {
    e.stopPropagation();
    openMenu(gear, [
      { label: t('기본설정', 'Preferences'), icon: 'settings', onClick: () => navigateTo('/drive/settings/basic') },
      { label: t('전송 쿼터', 'Transfer quota'), icon: 'chart', onClick: () => navigateTo('/drive/quota') },
      { label: t('미믹 홈페이지', 'Mimic home'), icon: 'external', onClick: () => navigateTo('/') },
      // 휴대폰 폭에서는 상단바의 도움말·쿠폰 버튼을 숨기고 이 메뉴에 둔다(K-05)
      ...(matchMedia('(max-width: 860px)').matches
        ? ['-', { label: t('도움말', 'Help'), icon: 'help', onClick: () => navigateTo('/help') }, { label: t('쿠폰 코드', 'Coupon'), icon: 'ticket', onClick: () => callComponent('coupon', 'openCoupon') }]
        : []),
    ]);
  };
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('button', { class: 'btn ghost icon-btn mobile-only', 'aria-label': t('메뉴', 'Menu'), html: icon('menu'), onclick: () => sidebar.classList.toggle('open') }),
    h('div', { class: 'search', html: icon('search') }, search),
    h('div', { class: 'spacer' }),
    h('a', { class: 'btn ghost sm hide-narrow', href: '/help', html: `${icon('help')}<span>${t('도움말', 'Help')}</span>` }),
    h('button', { class: 'btn ghost sm hide-narrow', html: `${icon('ticket')}<span>${t('쿠폰 코드', 'Coupon')}</span>`, onclick: () => callComponent('coupon', 'openCoupon') }),
    h('a', { class: 'btn accent sm', href: '/drive/payment', html: `${icon('crown')}<span>Premium</span>` }),
    h('a', { class: 'btn ghost icon-btn', href: '/drive/notifications', style: { position: 'relative' }, 'aria-label': t('알림', 'Notifications'), html: icon('bell') }, bellDot),
    avatar,
    gear,
  );
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && current?.name === 'drive') {
      e.preventDefault();
      search.focus();
    }
  });
  const transfers = h('div', { id: 'transfers' });
  const root = h('div', { class: 'drive-shell' }, sidebar, topbar, main, transfers);
  main.addEventListener('click', () => sidebar.classList.remove('open'));

  return {
    root,
    main,
    async ready() {
      const mod = await useComponent('transfers');
      mod?.mount?.(transfers);
    },
    update(ctx) {
      this.me = ctx.me;
      current && (current.me = ctx.me);
      const act = activeNav(ctx.path || location.pathname);
      navLinks.forEach((a) => a.classList.toggle('active', a.dataset.href === act));
      sidebar.classList.remove('open');
      if (ctx.path?.startsWith('/drive/search')) search.value = new URLSearchParams(location.search).get('q') || '';
      const s = ctx.me?.storage;
      if (s) {
        const pct = s.total ? Math.min(100, (s.used / s.total) * 100) : 0;
        meterBar.style.width = `${pct}%`;
        meterBar.parentElement.classList.toggle('warn', pct > 90);
        meterText.textContent = `${formatBytes(s.used)} / ${formatBytes(s.total)}`;
      }
      premiumLink.innerHTML = ctx.me?.premium ? `${icon('crown')}<b>Premium</b> <span class="badge brand">${t('이용 중', 'Active')}</span>` : `${icon('crown')}<b>${t('Premium 업그레이드', 'Upgrade')}</b>`;
      const u = ctx.me?.user;
      avatar.innerHTML = u?.avatar ? `<img src="${u.avatar}" alt="">` : (u?.name || u?.email || 'M').trim().charAt(0).toUpperCase();
      api('/api/notifications/unread-count')
        .then((r) => bellDot.classList.toggle('hidden', !r?.count))
        .catch(() => {});
    },
  };
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    if (e.status !== 404) return toastError(e);
  }
  clearMe();
  navigateTo('/login');
}
function navigateTo(to) {
  import('./app.js').then((m) => m.navigate(to));
}

// ---------- 공개 사이트 ----------
function siteLayout() {
  const main = h('main', { class: 'site-main' });
  const right = h('div', { class: 'row' });
  const header = h(
    'header',
    { class: 'site-header' },
    logo('/'),
    h(
      'nav',
      {},
      h('a', { href: '/' }, t('서비스 소개', 'About')),
      h('a', { href: '/bt' }, t('클라우드 BT', 'Cloud BT')),
      h('a', { href: '/pricing' }, t('요금', 'Pricing')),
      h('a', { href: '/apps' }, t('앱 다운로드', 'Apps')),
      h('a', { href: '/help' }, t('도움말', 'Help')),
    ),
    h('div', { class: 'spacer' }),
    right,
  );
  const col = (title, links) => h('div', {}, h('h4', {}, title), ...links.map(([href, label]) => h('a', { href }, label)));
  const footer = h(
    'footer',
    { class: 'site-footer' },
    h(
      'div',
      { class: 'cols' },
      col(t('미믹', 'Mimic'), [['/', t('서비스 소개', 'About')], ['/bt', t('클라우드 BT', 'Cloud BT')], ['/pricing', t('프리미엄·요금', 'Premium & pricing')], ['/blog', t('블로그', 'Blog')]]),
      col(t('앱', 'Apps'), [
        ['/apps/mobile', t('모바일 앱', 'Mobile app')],
        ['/apps/desktop', t('데스크톱 앱', 'Desktop app')],
        ['/apps/tv', t('TV 앱', 'TV app')],
        ['/apps/extension', t('브라우저 확장', 'Browser extension')],
        ['/apps/cli', t('명령줄 도구(CLI)', 'Command line (CLI)')],
      ]),
      col(t('지원', 'Support'), [
        ['/help', t('도움말 센터', 'Help center')],
        ['/faq', t('자주 묻는 질문', 'FAQ')],
        ['/contact', t('문의하기', 'Contact us')],
        ['/copyright', t('저작권 신고', 'Copyright report')],
        ['/transparency', t('투명성 보고서', 'Transparency report')],
      ]),
      // 영어 제목은 /api/content/policies 의 en 값과 같게
      col(t('정책', 'Policies'), [
        ['/policy/terms', t('이용약관', 'Terms of Service')],
        ['/policy/privacy', t('개인정보처리방침', 'Privacy Policy')],
        ['/policy/membership', t('멤버십 약관', 'Membership Terms')],
        ['/policy/anti-abuse', t('악용 방지 정책', 'Anti-Abuse Policy')],
        ['/policy/child-safety', t('아동 보호 정책', 'Child Safety Policy')],
        ['/policy/copyright', t('저작권 정책', 'Copyright Policy')],
        ['/policy/cookies', t('쿠키 정책', 'Cookie Policy')],
      ]),
    ),
    h(
      'div',
      { class: 'row', style: { maxWidth: '1080px', margin: '0 auto' } },
      h('span', {}, t('© 2026 미믹(Mimic). 사업자 정보는 정식 출시 전에 기재합니다.', '© 2026 Mimic. Business details will be listed before the official launch.')),
      h('div', { class: 'spacer' }),
      h(
        'select',
        {
          class: 'input',
          style: { width: '120px', height: '32px' },
          'aria-label': t('언어', 'Language'),
          // 주소의 ?lang 이 방금 고른 언어를 되돌리지 않게 지우고 다시 불러온다
          onchange: (e) => {
            setLang(e.target.value);
            const u = new URL(location.href);
            u.searchParams.delete('lang');
            history.replaceState({}, '', u);
            location.reload();
          },
        },
        h('option', { value: 'ko', selected: getLang() === 'ko' }, '한국어'),
        h('option', { value: 'en', selected: getLang() === 'en' }, 'English'),
      ),
    ),
  );
  return {
    root: h('div', {}, header, main, footer),
    main,
    update(ctx) {
      right.replaceChildren(
        ctx.me
          ? h('a', { class: 'btn primary', href: '/drive/all' }, t('내 드라이브', 'My drive'))
          : h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '/login' }, t('로그인', 'Log in')), h('a', { class: 'btn primary', href: '/signup' }, t('무료로 시작', 'Start free'))),
      );
    },
  };
}

// ---------- 로그인·가입 ----------
function authLayout() {
  const main = h('div');
  return {
    root: h(
      'div',
      { class: 'auth-shell' },
      h(
        'section',
        { class: 'auth-art' },
        logo('/'),
        h('h1', {}, t('링크만 붙이면,', 'Paste a link,'), h('br'), t('내 클라우드로.', 'it lands in your cloud.')),
        h('p', { class: 'muted' }, t('기기를 꺼 두어도 미믹 서버가 대신 받아 두고, 받자마자 바로 재생할 수 있어요.', 'Mimic downloads for you even when your device is off, and you can play right away.')),
        h('div', { class: 'col' }, ...[
          ['cloudDown', t('마그넷·토렌트·URL·SNS 링크 저장', 'Save magnet, torrent, URL and social links')],
          ['play', t('받은 영상은 바로 스트리밍', 'Stream videos as soon as they land')],
          ['shield', t('내 클라우드에만 안전하게 보관', 'Kept safely in your own cloud')],
        ].map(([ic, txt]) => h('div', { class: 'row', html: `${icon(ic)}<span>${txt}</span>` }))),
      ),
      h('section', { class: 'auth-panel' }, main),
    ),
    main,
  };
}

// ---------- 관리자 ----------
const ADMIN_NAV = [
  ['dashboard', 'chart', '대시보드'],
  ['users', 'user', '회원'],
  ['orders', 'ticket', '결제·환불'],
  ['coupons', 'gift', '쿠폰'],
  ['reports', 'flag', '신고·이의제기'],
  ['blocklist', 'shield', '차단 목록'],
  ['quotas', 'settings', '쿼터 정책'],
  ['logs', 'list', '감사 로그'],
];
function adminLayout() {
  const main = h('main', { class: 'admin-main' });
  const links = ADMIN_NAV.map(([key, ic, label]) => h('a', { class: 'nav-item', href: `/admin/${key}`, 'data-key': key, html: `${icon(ic)}<span>${label}</span>` }));
  const aside = h('aside', { class: 'sidebar' }, logo('/admin/dashboard'), h('div', { class: 'badge accent', style: { margin: '0 6px 12px' } }, '관리자'), ...links, h('a', { class: 'nav-item', href: '/drive/all', html: `${icon('chevronLeft')}<span>드라이브로</span>` }));
  // 휴대폰 화면에서 관리자 메뉴를 여는 버튼
  const bar = h('div', { class: 'admin-mobile-bar mobile-only' }, h('button', { class: 'btn ghost icon-btn', 'aria-label': '관리자 메뉴', html: icon('menu'), onclick: () => aside.classList.toggle('open') }), h('b', {}, '관리자'));
  const wrap = h('div', { class: 'admin-content' }, bar, main);
  main.addEventListener('click', () => aside.classList.remove('open'));
  return {
    root: h('div', { class: 'admin-shell' }, aside, wrap),
    main,
    update(ctx) {
      links.forEach((a) => a.classList.toggle('active', a.dataset.key === ctx.params?.section));
      aside.classList.remove('open');
    },
  };
}

function bareLayout() {
  const main = h('div', { class: 'bare' });
  return { root: main, main };
}

const BUILDERS = { drive: driveLayout, site: siteLayout, auth: authLayout, admin: adminLayout, bare: bareLayout };
