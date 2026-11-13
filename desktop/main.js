// 미믹 데스크톱 앱(K-09, Windows·macOS).
// 미믹 서버 화면을 창으로 열고, 트레이 메뉴·mimic:// 링크·magnet: 링크를 처리한다.
// Windows 7·8 용 구버전 빌드(Electron 22)에서도 돌도록 CommonJS·Node 16 문법만 쓴다.
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, net } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_SERVER = 'http://localhost:4300';
const ICON = path.join(__dirname, 'icon.png');
const EXTERNAL = ['http:', 'https:', 'mailto:', 'potplayer:', 'vlc:']; // 기본 앱으로 넘기는 링크(그 밖의 스킴은 무시)
// 개발 실행(electron .)이면 OS 에 "electron.exe <앱 폴더>" 로 등록해야 링크가 이 앱으로 온다
const protoArgs = process.defaultApp ? [process.execPath, [path.resolve(process.argv[1] || '.')]] : [];

let win = null;
let tray = null;
let quitting = false;
let pendingTask = null; // 클라우드 다운로드 작업 창에 채울 링크(로그인 전이면 로그인 뒤에 채운다)
let startLink = null;
let server = DEFAULT_SERVER;

const configPath = () => path.join(app.getPath('userData'), 'config.json');

// 서버 주소: --server=주소 > MIMIC_SERVER_URL > config.json 의 serverUrl > 기본값
function readServer() {
  const arg = process.argv.find((a) => a.startsWith('--server='));
  let raw = (arg && arg.slice('--server='.length)) || process.env.MIMIC_SERVER_URL;
  if (!raw) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')).serverUrl;
    } catch {}
  }
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {}
  return DEFAULT_SERVER;
}

function sameServer(url) {
  try {
    return new URL(url).origin === server;
  } catch {
    return false;
  }
}

function showMain() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// 링크 하나를 알맞은 곳으로 보낸다(창 안 링크·OS 에서 넘어온 링크 공용)
function route(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol === 'magnet:') return openTask(url);
  if (u.protocol === 'mimic:') return openMimic(u);
  if (EXTERNAL.includes(u.protocol)) shell.openExternal(url);
}

// mimic://play?id=<파일 id>&url=<재생 링크> → 앱 안 재생 창. 연결된 미믹 서버의 링크만 연다(다른 사이트가 임의 페이지를 띄우지 못하게).
// id 가 있고 이 앱에 로그인한 계정이 그 파일을 열 수 있으면 미믹 플레이어(/play/<id>)로 열어 서버 변환을 쓴다.
// 예전 링크(id 없음)·로그인 전·브라우저와 다른 계정이면 브라우저 사용자에게 만든 서명 재생 링크를 그대로 연다
function openMimic(u) {
  if (u.hostname !== 'play') return showMain();
  const url = u.searchParams.get('url') || '';
  if (!sameServer(url)) {
    dialog.showErrorBox('미믹', `연결된 미믹 서버(${server})의 재생 링크만 열 수 있어요.\n${url}`);
    return;
  }
  const id = u.searchParams.get('id') || '';
  if (!/^[\w-]{1,64}$/.test(id)) return openPlayer(url);
  const req = net.request({ url: `${server}/api/media/${id}/info`, useSessionCookies: true });
  req.on('response', (res) => {
    res.on('data', () => {});
    openPlayer(res.statusCode === 200 ? `${server}/play/${id}` : url);
  });
  req.on('error', () => openPlayer(url));
  req.end();
}

function openPlayer(target) {
  const player = new BrowserWindow({
    width: 1024,
    height: 600,
    title: '미믹 재생',
    icon: ICON,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  player.loadURL(target);
}

// 모든 창(메인·재생·window.open 으로 열린 창)에 같은 규칙: 같은 서버 주소는 앱 안에서, 그 밖은 기본 브라우저·플레이어로
function guard(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (sameServer(url)) return { action: 'allow' };
    route(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (sameServer(url)) return;
    e.preventDefault();
    route(url);
  });
  // 서버가 다른 사이트로 보내는 302 는 will-navigate 가 아니라 여기로 온다(소셜 로그인 공급자 화면 등)
  wc.on('will-redirect', (e, url, _inPlace, isMainFrame) => {
    if (!isMainFrame || sameServer(url)) return;
    e.preventDefault();
    if (!isOAuth(url)) return route(url);
    // Google 등은 앱 안 브라우저 로그인을 거부하고, 기본 브라우저에서 로그인하면 세션이 앱에 오지 않는다
    // ponytail: 안내만 함. 브라우저 로그인 → mimic:// 로 세션 넘기기는 auth 의 일회용 코드 API 가 생기면
    dialog.showMessageBox({
      type: 'info',
      title: '미믹',
      message: '데스크톱 앱에서는 소셜 로그인을 쓸 수 없어요.',
      detail: '이메일·휴대폰 번호 또는 QR 코드로 로그인하세요.',
    });
  });
}

// OAuth 공급자 로그인 주소(모든 공급자가 client_id·response_type 을 붙인다)
function isOAuth(url) {
  try {
    const q = new URL(url).searchParams;
    return q.has('client_id') && q.has('response_type');
  } catch {
    return false;
  }
}

// 웹 화면의 "클라우드 다운로드 작업 생성" 창(offline 컴포넌트)을 열고 링크를 채운다. 로그인 전이면 false
const FILL_TASK = `(async (link) => {
  const ui = await import('/ui.js');
  if (!(await ui.getMe())) return false;
  ui.callComponent('offline', 'openCreateTask');
  for (let i = 0; i < 50 && link; i++) {
    const box = document.querySelector('.ol-links');
    if (box) {
      box.value = box.value ? box.value + '\\n' + link : link;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.focus();
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
})`;

function openTask(link) {
  pendingTask = link;
  showMain();
  if (win.webContents.isLoading()) return; // did-finish-load 에서 채운다
  if (sameServer(win.webContents.getURL())) fillTask();
  else win.loadURL(`${server}/drive/all`);
}

async function fillTask() {
  const link = pendingTask;
  pendingTask = null;
  if (link === null) return;
  const ok = await win.webContents.executeJavaScript(`${FILL_TASK}(${JSON.stringify(link)})`).catch(() => false);
  if (!ok) pendingTask = link; // 로그인 뒤 /drive 로 들어오면 다시
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: '미믹',
    icon: ICON,
    show: false,
    backgroundColor: '#faf8f4',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // 창을 닫으면 트레이로(다운로드 작업은 서버에서 계속)
    win.hide();
  });
  const wc = win.webContents; // 링크 규칙은 guard()(web-contents-created)
  wc.on('did-finish-load', () => pendingTask !== null && fillTask());
  wc.on('did-navigate-in-page', (_e, url) => {
    if (pendingTask !== null && sameServer(url) && new URL(url).pathname.startsWith('/drive')) fillTask();
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
    if (!isMain || code === -3) return; // -3: 다른 주소로 바뀌며 취소됨
    const html = `<meta charset="utf-8"><body style="font:15px sans-serif;padding:40px;background:#faf8f4;color:#222">
<h2>미믹 서버에 연결할 수 없어요</h2><p>${server} (${desc})</p>
<p>서버가 켜져 있는지 확인하거나, 트레이 메뉴의 "서버 주소 바꾸기"에서 주소를 바꾸세요.</p>
<p><a href="${server}/drive/all">다시 시도</a></p>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
  win.loadURL(`${server}/drive/all`);
}

function setProtocol(scheme, on) {
  if (on) app.setAsDefaultProtocolClient(scheme, ...protoArgs);
  else app.removeAsDefaultProtocolClient(scheme, ...protoArgs);
}

async function editServer() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  if (!fs.existsSync(configPath())) fs.writeFileSync(configPath(), `${JSON.stringify({ serverUrl: server }, null, 2)}\n`);
  await shell.openPath(configPath());
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '미믹 서버 주소',
    message: '열린 config.json 의 serverUrl 을 바꿔 저장한 뒤 [다시 연결]을 누르세요.',
    detail: `지금 주소: ${server}`,
    buttons: ['다시 연결', '취소'],
  });
  if (response !== 0) return;
  server = readServer();
  refreshTray();
  win.loadURL(`${server}/drive/all`);
  showMain();
}

function refreshTray() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '미믹 열기', click: showMain },
      { label: '클라우드 다운로드…', click: () => openTask('') },
      { type: 'separator' },
      {
        label: 'magnet 링크를 미믹으로 열기',
        type: 'checkbox',
        checked: app.isDefaultProtocolClient('magnet', ...protoArgs),
        click: (item) => setProtocol('magnet', item.checked),
      },
      { label: `서버: ${server}`, enabled: false },
      { label: '서버 주소 바꾸기…', click: editServer },
      { type: 'separator' },
      { label: '종료', click: () => ((quitting = true), app.quit()) },
    ]),
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('미믹');
  tray.on('click', showMain);
  refreshTray();
}

const linkIn = (argv) => argv.find((a) => /^(mimic|magnet):/i.test(a));
const handleLink = (url) => (win ? route(url) : (startLink = url)); // 창이 생기기 전에 온 링크는 시작할 때 처리

if (!app.requestSingleInstanceLock()) {
  app.quit(); // 이미 켜져 있으면 그 창이 링크를 받는다(second-instance)
} else {
  app.on('second-instance', (_e, argv) => {
    const link = linkIn(argv);
    if (link) handleLink(link);
    else showMain();
  });
  // macOS 는 링크를 open-url 로 준다(앱이 준비되기 전에 올 수도 있음)
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleLink(url);
  });
  app.on('web-contents-created', (_e, wc) => guard(wc));
  app.on('activate', showMain);
  app.on('before-quit', () => (quitting = true));
  app.whenReady().then(() => {
    server = readServer();
    setProtocol('mimic', true);
    createWindow();
    createTray();
    const link = startLink || linkIn(process.argv);
    if (link) route(link);
  });
}
