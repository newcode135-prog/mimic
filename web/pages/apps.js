// 앱 다운로드(K-02·K-09): /apps 전체, /apps/:platform(mobile|desktop|tv|extension|cli). 설치 파일이 아직 없으면 "출시 예정"
import { h, icon, t, toast } from '/ui.js';
import { setup } from '/pages/help.js';

const SOON = 'soon';
const PLATFORMS = {
  mobile: {
    icon: 'phone',
    title: ['모바일 앱', 'Mobile apps'],
    lead: ['휴대폰에서 링크를 넣고, 받은 영상을 이동 중에 바로 보세요.', 'Add links and watch on the go.'],
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
      ['Homebrew', 'brew install', 'brew install', SOON],
      ['npx', 'Node.js 20 이상', 'Node.js 20+', SOON],
    ],
    install: [`curl -fsSL ${location.origin}/api/integrations/cli/install.sh | sh`, `irm ${location.origin}/api/integrations/cli/install.ps1 | iex`],
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

function buildCard([name, ko, en, status]) {
  const btn =
    status === SOON
      ? h('span', { class: 'badge accent' }, t('출시 예정', 'Coming soon'))
      : h('a', { class: 'btn primary sm', href: status, download: '' }, h('span', { html: icon('download') }), t('내려받기', 'Download'));
  const card = h('div', { class: 'card' }, h('b', {}, name), h('span', { class: 'muted small' }, t(ko, en)), h('div', {}, btn));
  // 설치 파일이 서버에 실제로 있는지 확인하고, 없으면 출시 예정으로 바꾼다
  if (status !== SOON) fetch(status, { method: 'HEAD' }).then((r) => !r.ok && btn.replaceWith(h('span', { class: 'badge accent' }, t('출시 예정', 'Coming soon')))).catch(() => {});
  return card;
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

  root.replaceChildren(
    h('div', { class: 'mc-page-title' }, h('div', { class: 'ic', style: { margin: '0 auto 12px', width: '56px', height: '56px', borderRadius: '16px', display: 'grid', placeItems: 'center', background: 'var(--brand-soft)', color: 'var(--brand-strong)' }, html: icon(p.icon, 'lg') }), h('h1', {}, t(...p.title)), h('p', { class: 'mc-lead', style: { margin: '0 auto' } }, t(...p.lead))),
    h(
      'div',
      { class: 'container' },
      pills,
      h('h2', {}, t('설치', 'Install')),
      h('div', { class: 'mc-req' }, ...p.builds.map(buildCard)),
      p.now ? h('div', { class: 'mc-note brand', style: { marginTop: '16px' }, html: icon('info') }, h('div', {}, t(...p.now), p.action ? [' ', h('a', { href: p.action[0] }, t(...p.action[1]))] : null)) : null,
      p.steps ? [h('h2', { style: { marginTop: '32px' } }, t('설치 방법', 'How to install')), h('ol', { class: 'doc' }, ...p.steps.map((s) => h('li', {}, t(...s))))] : null,
      p.install
        ? [
            h('h2', { style: { marginTop: '32px' } }, t('설치 명령', 'Install command')),
            h('p', { class: 'muted' }, t('macOS·Linux 는 터미널, Windows 는 PowerShell 에 붙여 넣으세요. 이 서버 주소가 미리 들어 있어요.', 'Paste into Terminal (macOS·Linux) or PowerShell (Windows). This server address is built in.')),
            h('div', { class: 'col' }, ...p.install.map(codeLine)),
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
}
