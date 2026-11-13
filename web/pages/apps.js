// 앱 다운로드(K-02·K-09): /apps 전체, /apps/:platform(mobile|desktop|tv|extension|cli). 설치 파일이 아직 없으면 "준비 중"
import { bus, h, icon, t, toast } from '/ui.js';
import { setup } from '/pages/help.js';
import { installState, promptInstall, iosHint } from '/pwa.js';

const SOON = 'soon';
const PLATFORMS = {
  mobile: {
    icon: 'phone',
    title: ['모바일 앱', 'Mobile apps'],
    lead: ['휴대폰에서 링크를 넣고, 받은 영상을 이동 중에 바로 보세요.', 'Add links and watch on the go.'],
    pwa: true,
    features: [
      ['링크·토렌트 추가와 전송 현황', 'Add links and track transfers'],
      ['원본 화질 재생(프리미엄), HDR 재생', 'Original quality and HDR playback'],
      ['금고 생체 인증 잠금 해제', 'Unlock the vault with biometrics'],
      ['Android 11 이상에서 SD카드에 저장', 'Save to SD card on Android 11+'],
      ['QR 코드로 PC·TV 로그인 승인', 'Approve PC/TV logins by QR'],
    ],
    builds: [
      ['Android APK', '직접 설치 파일', 'Direct install', SOON],
      ['Google Play', 'Android', 'Android', SOON],
      ['Galaxy Store', '삼성 갤럭시', 'Samsung Galaxy', SOON],
      ['App Store', 'iPhone·iPad (애플 정책상 링크 추가 기능 제외)', 'iPhone·iPad (no link adding per Apple policy)', SOON],
    ],
    now: ['지금 바로: 휴대폰 브라우저로 미믹에 로그인한 뒤 "홈 화면에 추가"를 누르면 앱처럼 쓸 수 있어요.', 'Today: log in from your phone browser and choose "Add to Home Screen".'],
  },
  desktop: {
    icon: 'desktop',
    title: ['데스크톱 앱', 'Desktop apps'],
    lead: ['큰 화면에서 정리하고, 외부 플레이어로 바로 여세요.', 'Organize on a big screen and open in your favorite player.'],
    pwa: true,
    features: [
      ['클라우드 다운로드와 대용량 업로드', 'Cloud download and large uploads'],
      ['미믹 플레이어·VLC·PotPlayer로 열기', 'Open in Mimic player, VLC or PotPlayer'],
      ['폴더째로 기기에 내려받기, 이어받기', 'Download folders with resume'],
      ['마그넷 링크·.torrent 파일 자동 인식', 'Auto-detect magnet links and .torrent files'],
    ],
    builds: [
      ['Windows 10·11', '64비트', '64-bit', SOON],
      ['Windows 구버전', '7·8.1용 별도 빌드', 'Separate build for 7/8.1', SOON],
      ['macOS (Apple 칩)', 'M1 이후', 'M1 and later', SOON],
      ['macOS (Intel)', 'Intel 맥', 'Intel Macs', SOON],
    ],
    now: ['지금 바로: 데스크톱 브라우저에서 웹 드라이브를 그대로 쓸 수 있어요.', 'Today: use the web drive in your desktop browser.'],
  },
  tv: {
    icon: 'tv',
    title: ['TV 앱', 'TV app'],
    lead: ['소파에서 리모컨으로, 받은 영상을 큰 화면에.', 'Your cloud on the big screen, with a remote.'],
    features: [
      ['리모컨 방향키로 움직이는 큰 타일 화면', 'Big tiles, remote-friendly'],
      ['휴대폰 QR 승인으로 로그인', 'Log in by approving a QR on your phone'],
      ['최근 영상·모든 파일·시청 기록', 'Recent videos, all files, watch history'],
    ],
    builds: [['Android TV 전용 APK', 'Android TV·Google TV', 'Android TV·Google TV', SOON]],
    now: ['지금 바로: TV 브라우저에서 이 사이트 주소 뒤에 /tv 를 붙여 열면 TV용 화면을 쓸 수 있어요.', 'Today: open /tv on this site in your TV browser.'],
    action: ['/tv', ['TV 화면 열기', 'Open TV view']],
    steps: [
      ['TV 설정에서 "출처를 알 수 없는 앱" 설치를 허용해요.', 'Allow unknown apps in TV settings.'],
      ['다운로더 앱이나 USB로 미믹 TV APK를 옮겨 설치해요.', 'Install the Mimic TV APK via a downloader app or USB.'],
      ['앱을 열고 화면의 QR을 휴대폰 미믹 앱으로 찍어 승인해요.', 'Open it and approve the QR with your phone.'],
    ],
  },
  extension: {
    icon: 'puzzle',
    title: ['브라우저 확장', 'Browser extension'],
    lead: ['보고 있는 페이지의 링크와 영상을 한 번에 내 클라우드로.', 'Send links and videos from any page to your cloud.'],
    features: [
      ['페이지 속 마그넷·토렌트·파일 링크·영상 찾기', 'Finds magnets, torrents, file links and videos on the page'],
      ['고른 링크를 원클릭으로 클라우드 다운로드', 'One-click cloud download'],
      ['매일 출석 체크로 무료 프리미엄', 'Daily check-in for free Premium'],
    ],
    builds: [
      ['Chrome 웹 스토어', 'Chrome', 'Chrome', SOON],
      ['Edge 추가 기능', 'Microsoft Edge', 'Microsoft Edge', SOON],
      ['오프라인 설치 파일', 'Chrome·Edge 공용 zip', 'zip for Chrome·Edge', '/api/integrations/extension.zip'],
    ],
    steps: [
      ['오프라인 설치 파일(zip)을 받아 압축을 풀어요.', 'Download the zip and unpack it.'],
      ['브라우저 주소창에 chrome://extensions (Edge는 edge://extensions)를 열고 "개발자 모드"를 켜요.', 'Open chrome://extensions (or edge://extensions) and turn on Developer mode.'],
      ['"압축해제된 확장 프로그램 로드"를 눌러 푼 폴더를 골라요.', 'Click "Load unpacked" and choose the folder.'],
    ],
  },
  cli: {
    icon: 'terminal',
    title: ['CLI·WebDAV·MCP', 'CLI·WebDAV·MCP'],
    lead: ['명령줄, 네트워크 드라이브, AI 도구에서 미믹을 다루세요.', 'Use Mimic from the terminal, as a network drive, or from AI tools.'],
    features: [
      ['브라우저 승인으로 로그인(비밀번호를 터미널에 넣지 않음)', 'Browser-approved login, no password in the terminal'],
      ['목록·업로드·다운로드·공유·클라우드 다운로드 추가', 'List, upload, download, share, add cloud downloads'],
      ['개인 액세스 토큰으로 서버에서 무인 실행', 'Unattended runs with a personal access token'],
      ['AI 에이전트용 스킬 설치', 'Install skills for AI agents'],
    ],
    builds: [
      ['macOS·Linux 설치 스크립트', 'curl 한 줄 설치 · Node.js 20 이상', 'One-line curl install · Node.js 20+', '/api/integrations/cli/install.sh'],
      ['Windows', 'PowerShell 설치 · Node.js 20 이상', 'PowerShell install · Node.js 20+', '/api/integrations/cli/install.ps1'],
      ['Homebrew', 'macOS·Linux 공식(formula)', 'Formula for macOS·Linux', '/api/integrations/cli/mimic.rb'],
      ['npx', '설치 없이 실행 · Node.js 20 이상', 'Run without installing · Node.js 20+', '/api/integrations/cli/mimic-cli.tgz'],
    ],
    install: [
      ['macOS·Linux', 'macOS·Linux', `curl -fsSL ${location.origin}/api/integrations/cli/install.sh | sh`],
      ['Windows (PowerShell)', 'Windows (PowerShell)', `irm ${location.origin}/api/integrations/cli/install.ps1 | iex`],
      ['npx (설치 없이)', 'npx (no install)', `npx -y ${location.origin}/api/integrations/cli/mimic-cli.tgz auth login`],
      // Homebrew 는 탭 안의 공식만 설치하므로 로컬 탭에 공식을 받아 설치한다(cli/README.md 와 같은 순서)
      ['Homebrew', 'Homebrew', `brew tap-new --no-git mimic/local; F="$(brew --repository mimic/local)/Formula"; mkdir -p "$F" && curl -fsSL ${location.origin}/api/integrations/cli/mimic.rb -o "$F/mimic.rb" && brew install mimic/local/mimic`],
    ],
    commands: ['mimic auth login', 'mimic ls', 'mimic upload ./video.mp4', 'mimic offline add "magnet:?xt=urn:btih:…"', 'mimic share <파일ID> --days 7', 'mimic skill install'],
  },
};

const codeLine = (text) =>
  h(
    'div',
    { class: 'mc-code' },
    h('code', {}, text),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => navigator.clipboard?.writeText(text).then(() => toast(t('복사했어요', 'Copied'), 'ok')) }, t('복사', 'Copy')),
  );

const soonBadge = () => h('span', { class: 'badge accent' }, t('준비 중', 'Coming soon'));

function buildCard([name, ko, en, status]) {
  const btn = status === SOON ? soonBadge() : h('a', { class: 'btn primary sm', href: status, download: '' }, h('span', { html: icon('download') }), t('내려받기', 'Download'));
  const card = h('div', { class: 'card' }, h('b', {}, name), h('span', { class: 'muted small' }, t(ko, en)), h('div', {}, btn));
  // 설치 파일이 서버에 실제로 있는지 확인하고, 없으면 준비 중으로 바꾼다
  if (status !== SOON) fetch(status, { method: 'HEAD' }).then((r) => !r.ok && btn.replaceWith(soonBadge())).catch(() => {});
  return card;
}

// 웹 앱(PWA) 설치 카드: 이 브라우저가 설치 창을 띄울 수 있으면 버튼, 아니면 지금 상태를 알려 준다
function webAppCard() {
  const card = h('div', { class: 'card' });
  const draw = (state = installState()) => {
    const install = async () => (await promptInstall()) === 'accepted' && toast(t('미믹 앱을 설치했어요', 'Mimic app installed'), 'ok');
    const note = {
      ready: t('홈 화면·바탕 화면에서 앱처럼 바로 열려요.', 'Opens like an app from your home screen or desktop.'),
      installed: t('이 기기에 미믹 앱이 설치되어 있어요.', 'Mimic is installed on this device.'),
      ios: iosHint(),
      // 설치 창을 닫은 뒤에도(Chrome·Edge 는 새로 고침 전까지 다시 띄울 수 없음) 맞는 안내
      unavailable: t(
        '지금은 이 화면에서 설치 창을 띄울 수 없어요. 브라우저 메뉴의 "앱 설치"·"홈 화면에 추가"를 쓰거나 새로 고침 후 다시 해 보세요. Android·PC 는 Chrome·Edge, iPhone 은 Safari 에서 설치할 수 있어요. 이미 설치했다면 설치된 앱을 여세요.',
        "Can't open the install prompt here right now. Use Install app or Add to Home screen in the browser menu, or reload and try again. Installs work in Chrome or Edge on Android/PC and Safari on iPhone. Already installed? Open the app.",
      ),
    }[state];
    const action =
      state === 'ready'
        ? h('button', { class: 'btn primary sm', type: 'button', onclick: install }, h('span', { html: icon('download') }), t('웹 앱 설치', 'Install web app'))
        : state === 'installed'
          ? h('span', { class: 'badge brand' }, t('설치됨', 'Installed'))
          : null;
    card.replaceChildren(h('b', {}, t('웹 앱', 'Web app')), h('span', { class: 'muted small' }, note), ...(action ? [h('div', {}, action)] : []));
  };
  draw();
  return { card, draw };
}

export async function render(root, ctx) {
  if (setup(ctx)) return;
  const key = ctx.params.platform;
  const pills = h('nav', { class: 'mc-tabs-pills' }, h('a', { href: '/apps', class: key ? '' : 'active' }, t('전체', 'All')), ...Object.entries(PLATFORMS).map(([k, p]) => h('a', { href: `/apps/${k}`, class: k === key ? 'active' : '', html: `${icon(p.icon)}<span>${t(...p.title)}</span>` })));

  if (!key) {
    document.title = t('앱 다운로드 — 미믹', 'Apps — Mimic');
    root.replaceChildren(
      h('div', { class: 'mc-page-title' }, h('span', { class: 'mc-eyebrow' }, 'Apps'), h('h1', {}, t('어디서나 미믹', 'Mimic, everywhere')), h('p', { class: 'mc-lead', style: { margin: '0 auto' } }, t('웹을 포함해 9개 접점에서 같은 클라우드를 써요.', 'One cloud across nine touchpoints, web included.'))),
      h(
        'div',
        { class: 'container' },
        pills,
        h(
          'div',
          { class: 'mc-grid' },
          ...Object.entries(PLATFORMS).map(([k, p]) => h('a', { class: 'mc-tile', href: `/apps/${k}` }, h('div', { class: 'ic', html: icon(p.icon) }), h('h3', {}, t(...p.title)), h('p', {}, t(...p.lead)))),
          h('a', { class: 'mc-tile', href: '/help/telegram' }, h('div', { class: 'ic accent', html: icon('send') }), h('h3', {}, t('텔레그램 봇', 'Telegram bot')), h('p', {}, t('봇에게 링크나 파일을 보내면 내 드라이브에 저장돼요.', 'Send links or files to the bot to save them.'))),
        ),
      ),
    );
    return;
  }
  const p = PLATFORMS[key];
  if (!p) return root.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, t('없는 플랫폼이에요', 'Unknown platform')), h('a', { href: '/apps' }, t('앱 목록으로', 'All apps'))));
  document.title = `${t(...p.title)} — ${t('미믹', 'Mimic')}`;
  const web = p.pwa ? webAppCard() : null;

  root.replaceChildren(
    h('div', { class: 'mc-page-title' }, h('div', { class: 'ic', style: { margin: '0 auto 12px', width: '56px', height: '56px', borderRadius: '16px', display: 'grid', placeItems: 'center', background: 'var(--brand-soft)', color: 'var(--brand-strong)' }, html: icon(p.icon, 'lg') }), h('h1', {}, t(...p.title)), h('p', { class: 'mc-lead', style: { margin: '0 auto' } }, t(...p.lead))),
    h(
      'div',
      { class: 'container' },
      pills,
      h('h2', {}, t('설치', 'Install')),
      h('div', { class: 'mc-req' }, web?.card, ...p.builds.map(buildCard)),
      p.now ? h('div', { class: 'mc-note brand', style: { marginTop: '16px' }, html: icon('info') }, h('div', {}, t(...p.now), p.action ? [' ', h('a', { href: p.action[0] }, t(...p.action[1]))] : null)) : null,
      p.steps ? [h('h2', { style: { marginTop: '32px' } }, t('설치 방법', 'How to install')), h('ol', { class: 'doc' }, ...p.steps.map((s) => h('li', {}, t(...s))))] : null,
      p.install
        ? [
            h('h2', { style: { marginTop: '32px' } }, t('설치 명령', 'Install command')),
            h('p', { class: 'muted' }, t('환경에 맞는 명령 하나를 터미널(Windows 는 PowerShell)에 붙여 넣으세요. 이 서버 주소가 미리 들어 있어요.', 'Paste one command into your terminal (PowerShell on Windows). This server address is built in.')),
            h('div', { class: 'col' }, ...p.install.map(([ko, en, cmd]) => [h('span', { class: 'muted small' }, t(ko, en)), codeLine(cmd)])),
          ]
        : null,
      p.commands
        ? [
            h('h2', { style: { marginTop: '32px' } }, t('주요 명령', 'Key commands')),
            h('div', { class: 'col' }, ...p.commands.map(codeLine)),
            h('h2', { style: { marginTop: '32px' } }, 'WebDAV'),
            h('p', { class: 'muted' }, t('프리미엄 회원은 설정 > 액세스 및 통합에서 WebDAV를 켠 뒤 아래 주소로 연결할 수 있어요.', 'Premium members can enable WebDAV in Settings > Access & integrations and connect to:')),
            codeLine(`${location.origin}/webdav`),
            h('h2', { style: { marginTop: '32px' } }, 'MCP'),
            h('p', { class: 'muted' }, t('Claude·ChatGPT 같은 AI 도구에 미믹을 연결하려면 설정 > 액세스 및 통합 > MCP에서 연결 정보를 확인하세요.', 'To connect AI tools like Claude or ChatGPT, see Settings > Access & integrations > MCP.')),
          ]
        : null,
      h('h2', { style: { marginTop: '32px' } }, t('주요 기능', 'Highlights')),
      h('ul', { class: 'doc' }, ...p.features.map((f) => h('li', {}, t(...f)))),
    ),
  );
  return web && bus.on('pwa:install', web.draw); // 설치 가능·설치됨으로 바뀌면 카드를 다시 그림(화면을 떠나면 해제)
}
