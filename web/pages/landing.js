// 서비스 소개(K-02) — 미믹 고유 마케팅 페이지. 일러스트는 아래 SVG 로 직접 그린다.
import { api, h, icon, t, formatWon } from '/ui.js';
import { setup } from '/pages/help.js';

// 링크 한 줄이 구름(클라우드) 안의 파일 카드로 흘러 들어가고, 휴대폰·TV 로 재생되는 그림
const ART = `
<svg class="mc-art" viewBox="0 0 520 420" role="img" aria-label="링크가 미믹 클라우드로 들어가 여러 기기에서 재생되는 그림">
  <circle class="soft" cx="300" cy="200" r="170"/>
  <circle class="warm" cx="110" cy="330" r="60"/>
  <path class="flow" d="M120 92 C 200 92, 210 150, 250 170"/>
  <g class="float">
    <rect class="card" x="16" y="62" width="200" height="58" rx="29"/>
    <circle class="a" cx="46" cy="91" r="16"/>
    <path class="line" style="stroke:#fff" d="M40 94l12-12m-9 2-3 3a4 4 0 0 0 6 6m3-12 3-3a4 4 0 0 1 6 6l-3 3"/>
    <text x="72" y="96">magnet:?xt=…</text>
  </g>
  <path class="cloud" d="M170 300h250a62 62 0 0 0 8-123 92 92 0 0 0-176-20 70 70 0 0 0-82 143z"/>
  <g>
    <rect class="card" x="210" y="190" width="70" height="78" rx="12"/>
    <rect class="b" x="222" y="202" width="46" height="34" rx="7"/>
    <path class="wht" d="M240 210v18l14-9z"/>
    <rect class="soft" x="222" y="244" width="40" height="7" rx="3.5"/>
    <rect class="card" x="292" y="176" width="70" height="92" rx="12"/>
    <path class="a" d="M306 196a5 5 0 0 1 5-5h12l5 5h20a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5h-37a5 5 0 0 1-5-5z"/>
    <rect class="soft" x="304" y="240" width="46" height="7" rx="3.5"/>
    <rect class="warm" x="304" y="252" width="30" height="7" rx="3.5"/>
    <rect class="card" x="374" y="196" width="62" height="72" rx="12"/>
    <path class="line" d="M392 216h26M392 228h26M392 240h16"/>
  </g>
  <path class="flow" d="M330 304 C 330 340, 300 350, 262 360"/>
  <path class="flow" d="M380 304 C 390 330, 420 336, 440 346"/>
  <g>
    <rect class="card" x="206" y="330" width="56" height="78" rx="10"/>
    <rect class="b" x="214" y="342" width="40" height="50" rx="5"/>
    <path class="wht" d="M228 359v16l12-8z"/>
    <rect class="card" x="430" y="320" width="84" height="56" rx="8"/>
    <rect class="ink" x="438" y="328" width="68" height="40" rx="4"/>
    <path class="a" d="M466 340v16l13-8z"/>
    <path class="line" d="M460 388h24M472 376v12"/>
  </g>
</svg>`;

const FEATURES = [
  ['cloudDown', '클라우드 다운로드', 'Cloud download', '마그넷·토렌트·웹 주소·SNS 게시물 링크를 넘기면 서버가 대신 받아요. 기기를 꺼 둬도 계속 진행돼요.', 'Hand over a magnet, torrent, URL or social post. Our servers fetch it, even while your device is off.'],
  ['play', '받자마자 재생', 'Play instantly', '다 받은 영상은 내려받지 않고 바로 스트리밍. 자막·배속·이어보기까지 한 화면에서.', 'Stream without downloading, with subtitles, speed control and resume.'],
  ['cloud', '넉넉한 공간', 'Room to spare', (n) => `무료로 ${n.freeStorage}, 프리미엄은 ${n.premiumStorage}. 같은 파일은 한 벌만 보관해서 이미 있는 파일은 몇 초 만에 끝나요.`, (n) => `${n.freeStorage} free, ${n.premiumStorage} with Premium. Files we already have finish in seconds.`],
  ['lock', '나만 여는 금고', 'Private vault', '기기에서 암호화한 뒤 올리는 금고. 패스코드 없이는 운영자도 열 수 없어요.', 'Encrypted on your device before upload. Not even we can open it.'],
  ['desktop', '9개 접점', 'Nine ways in', '웹, Android, iOS, Windows, macOS, TV, 브라우저 확장, 텔레그램 봇, CLI·WebDAV·MCP.', 'Web, Android, iOS, Windows, macOS, TV, browser extension, Telegram bot, CLI·WebDAV·MCP.'],
  ['shield', '프라이버시 우선', 'Privacy first', '모든 통신은 암호화. 파일 내용을 광고나 AI 학습에 쓰지 않고, 받은 파일은 내 클라우드에만 저장돼요.', 'Encrypted in transit. Never used for ads or AI training. Saved only to your cloud.'],
];
const STEPS = [
  ['링크 붙여 넣기', 'Paste a link', '"클라우드 다운로드"를 누르고 링크를 넣어요. 여러 개는 한 줄에 하나씩.', 'Tap Cloud download and paste. One link per line for several.'],
  ['서버가 대신 받기', 'We fetch it', '이미 있는 파일은 즉시, 없는 파일은 서버가 받아 내 폴더에 넣어요.', 'Known files finish instantly; others are fetched into your folder.'],
  ['어디서든 보기', 'Watch anywhere', '휴대폰·PC·TV에서 바로 재생하고, 필요하면 공유하거나 기기로 내려받아요.', 'Play on phone, PC or TV, share it, or download to your device.'],
];
const PLATFORMS = [
  ['/apps/mobile', 'phone', '모바일', 'Mobile'],
  ['/apps/desktop', 'desktop', 'Windows·macOS', 'Windows·macOS'],
  ['/apps/tv', 'tv', 'TV', 'TV'],
  ['/apps/extension', 'puzzle', '브라우저 확장', 'Extension'],
  ['/apps/cli', 'terminal', 'CLI·WebDAV·MCP', 'CLI·WebDAV·MCP'],
  ['/help/telegram', 'send', '텔레그램 봇', 'Telegram bot'],
];
const FAQ_PICK = ['device-off', 'where-saved', 'free', 'quota-what'];

const section = (cls, ...children) => h('section', { class: `mc-section ${cls || ''}` }, h('div', { class: 'inner' }, ...children));
const head = (eyebrow, title, lead) => h('div', { class: 'mc-head' }, h('span', { class: 'mc-eyebrow' }, eyebrow), h('h2', {}, title), lead ? h('p', { class: 'mc-lead' }, lead) : null);
const check = (text) => h('li', { html: icon('check') }, text);

export async function render(root, ctx) {
  if (setup(ctx)) return;
  // 요금·용량 수치는 서버 정책(plans.js)에서 받는다. 운영 설정으로 한도를 바꾸면 소개 화면도 함께 바뀐다
  const n = await api('/api/content/numbers');
  document.title = t('미믹 — 링크만 붙이면 내 클라우드로', 'Mimic — Paste a link, it lands in your cloud');
  const start = ctx.me ? ['/drive/all', t('내 드라이브 열기', 'Open my drive')] : ['/signup', t('무료로 시작하기', 'Start for free')];

  const hero = h(
    'section',
    { class: 'mc-hero' },
    h(
      'div',
      { class: 'inner' },
      h(
        'div',
        {},
        h('span', { class: 'mc-eyebrow' }, t('클라우드 다운로드 · 스트리밍 드라이브', 'Cloud download · Streaming drive')),
        h('h1', {}, t('링크만 붙이면,', 'Paste a link,'), h('br'), h('em', {}, t('내 클라우드로.', 'into your cloud.'))),
        h('p', { class: 'mc-lead' }, t('받는 건 미믹 서버가, 보는 건 어디서나. 기기를 켜 두고 기다릴 필요 없이 링크 하나로 저장하고 바로 재생하세요.', 'Our servers do the downloading; you watch anywhere. No more leaving your computer on — one link saves and plays.')),
        h('div', { class: 'cta' }, h('a', { class: 'btn primary lg', href: start[0] }, start[1]), h('a', { class: 'btn lg', href: '/pricing' }, t('요금 보기', 'See pricing'))),
        h('div', { class: 'mc-paste', 'aria-hidden': 'true' }, h('span', {}, 'https://example.com/lecture-01.mp4'), h('span', { class: 'btn primary sm', style: { flex: 'none' } }, t('저장', 'Save'))),
      ),
      h('div', { html: ART }),
    ),
  );

  const features = section(
    '',
    head('Why Mimic', t('링크에서 재생까지, 한 곳에서', 'From link to playback, in one place'), t('미믹은 파일을 "받는 일"과 "보는 일"을 서버와 클라우드로 옮겼어요.', 'Mimic moves fetching and watching to the cloud.')),
    h(
      'div',
      { class: 'mc-grid' },
      ...FEATURES.map(([ic, ko, en, dko, den], i) => h('div', { class: 'mc-tile' }, h('div', { class: `ic ${i % 3 === 1 ? 'accent' : ''}`, html: icon(ic) }), h('h3', {}, t(ko, en)), h('p', {}, typeof dko === 'function' ? t(dko(n), den(n)) : t(dko, den)))),
    ),
  );

  const steps = section(
    'alt',
    head('How it works', t('세 단계면 충분해요', 'Three steps')),
    h('div', { class: 'mc-steps' }, ...STEPS.map(([ko, en, dko, den]) => h('div', { class: 'mc-step' }, h('h3', {}, t(ko, en)), h('p', {}, t(dko, den))))),
  );

  const platforms = section('', head('Everywhere', t('쓰던 기기 그대로', 'On the devices you already use')), h('div', { class: 'mc-platforms' }, ...PLATFORMS.map(([href, ic, ko, en]) => h('a', { href, html: `${icon(ic)}<span>${t(ko, en)}</span>` }))));

  const premiumPrice = h('div', { class: 'price' }, t('프리미엄', 'Premium'));
  const plans = section(
    'alt',
    head('Pricing', t('무료로 시작하고, 필요할 때 넓히세요', 'Start free, grow when you need')),
    h(
      'div',
      { class: 'mc-plans' },
      h(
        'div',
        { class: 'mc-plan' },
        h('div', { class: 'price' }, t('무료', 'Free')),
        h('ul', {}, check(t(`저장공간 ${n.freeStorage}`, `${n.freeStorage} storage`)), check(t(`클라우드 다운로드 하루 ${n.freePerDay}회 + 가입 보너스 ${n.signupBonus}회`, `${n.freePerDay} cloud downloads a day + ${n.signupBonus} bonus`)), check(t('720p 재생', '720p playback')), check(t(`하루 다운스트림 ${n.freeDailyDown}`, `${n.freeDailyDown} downstream a day`))),
        h('a', { class: 'btn', href: start[0] }, start[1]),
      ),
      h(
        'div',
        { class: 'mc-plan premium' },
        h('div', { class: 'row' }, premiumPrice, h('span', { class: 'badge brand' }, t('추천', 'Popular'))),
        h('ul', {}, check(t(`저장공간 ${n.premiumStorage}`, `${n.premiumStorage} storage`)), check(t(`클라우드 다운로드 무제한, 동시 ${n.premiumTasks}개`, `Unlimited cloud downloads, ${n.premiumTasks} at once`)), check(t('원본 화질 재생', 'Original-quality playback')), check(t('금고·WebDAV·온라인 압축 풀기', 'Vault, WebDAV, online unzip')), check(t('광고 없음', 'No ads'))),
        h('a', { class: 'btn primary', href: '/pricing' }, t('요금 자세히 보기', 'View plans')),
      ),
    ),
    h('p', { class: 'muted small', style: { textAlign: 'center', marginTop: '14px' } }, t(`모든 회원에게 매월 클라우드 다운로드 ${n.mCloud} · 다운스트림 ${n.mDown} · 업로드 ${n.mUp} 전송 쿼터가 주어져요.`, `Every member gets a monthly quota: ${n.mCloud} cloud download, ${n.mDown} downstream, ${n.mUp} upload.`)),
  );

  const faqList = h('div', { class: 'mc-faq', style: { maxWidth: '760px', margin: '0 auto' } });
  const faq = section('', head('FAQ', t('자주 묻는 질문', 'Frequently asked')), faqList, h('p', { style: { textAlign: 'center', marginTop: '16px' } }, h('a', { href: '/faq' }, t('질문 모두 보기 →', 'See all questions →'))));

  const legal = section(
    'alt',
    h(
      'div',
      { class: 'mc-legal', html: icon('shield') },
      h(
        'div',
        {},
        h('h3', {}, t('저작권을 지키는 클라우드', 'A copyright-respecting cloud')),
        h('p', { class: 'muted' }, t('미믹은 내가 권리를 가졌거나 허락받은 콘텐츠를 개인적으로 보관하기 위한 서비스예요. 권리자 신고가 들어온 링크와 파일은 차단하고, 반복해서 침해하는 계정은 이용을 제한해요.', 'Mimic is for keeping content you own or are licensed to use. We block links and files reported by rights holders and restrict repeat infringers.')),
        h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('a', { href: '/copyright' }, t('저작권 신고', 'Copyright notice')), '·', h('a', { href: '/policy/copyright' }, t('저작권 정책', 'Copyright policy')), '·', h('a', { href: '/transparency' }, t('투명성 보고서', 'Transparency report'))),
      ),
    ),
  );

  const final = h(
    'section',
    { class: 'mc-final' },
    h('h2', {}, t('다음 링크는 미믹에 맡겨 보세요', 'Let Mimic handle your next link')),
    h('p', {}, t('가입은 1분, 카드 등록 없이 무료로 시작해요.', 'Sign up in a minute. No card required.')),
    h('a', { class: 'btn lg', href: start[0] }, start[1]),
  );

  root.replaceChildren(hero, features, steps, platforms, plans, faq, legal, final);

  // 부가 정보: 실패해도 페이지는 그대로
  api('/api/content/faq')
    .then(({ items }) => faqList.append(...items.filter((f) => FAQ_PICK.includes(f.id)).map((f) => h('details', {}, h('summary', {}, f.q), h('div', { class: 'ans' }, f.a)))))
    .catch(() => faq.remove());
  api('/api/billing/products')
    .then((r) => {
      const list = r.products || r.items || r;
      const monthly = Array.isArray(list) && list.find((p) => p.id === 'sub_month');
      const price = monthly?.price?.global ?? monthly?.price;
      if (typeof price === 'number') premiumPrice.textContent = t(`월 ${formatWon(price)}부터`, `From ${formatWon(price)}/mo`);
    })
    .catch(() => {});
}
