// platforms 모듈(K-09): PWA(manifest·서비스 워커·아이콘), 데스크톱 앱(Electron) 설정 확인
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { startServer } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');
const web = (p) => path.join(root, 'web', p);
const manifest = JSON.parse(fs.readFileSync(web('manifest.webmanifest'), 'utf8'));

// PNG 머리(IHDR)에서 가로·세로
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} 은 PNG 가 아님`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

test('[K-09] manifest: 필수 키·주조색·시작 주소·아이콘 파일과 크기', () => {
  for (const k of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color', 'icons']) assert.ok(manifest[k], `${k} 없음`);
  assert.equal(manifest.name, '미믹');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/drive/all');
  assert.equal(manifest.theme_color, '#0f9d8f');
  const sizes = new Set();
  for (const icon of manifest.icons) {
    assert.equal(pngSize(web(icon.src)), icon.sizes, icon.src);
    sizes.add(`${icon.sizes}:${icon.purpose}`);
  }
  for (const s of ['192x192:any', '512x512:any', '512x512:maskable']) assert.ok(sizes.has(s), `${s} 아이콘 없음`);
  assert.equal(pngSize(web('icons/apple-touch-icon.png')), '180x180');
});

test('[K-09] index.html 에 manifest·apple-touch-icon·pwa.js', () => {
  const html = fs.readFileSync(web('index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /<script type="module" src="\/pwa\.js">/);
});

test('[K-09] 서비스 워커: 화면 파일만 캐시, /api·webdav·미디어·Range·POST 는 캐시하지 않음', () => {
  // sw.js 를 가짜 서비스 워커 환경에서 실행하고 fetch 처리기가 어떤 요청을 가로채는지 본다
  const listeners = {};
  const self = { location: { origin: 'https://m.test' }, addEventListener: (type, fn) => (listeners[type] = fn) };
  vm.runInNewContext(fs.readFileSync(web('sw.js'), 'utf8'), { self, URL, caches: { open: () => new Promise(() => {}) }, fetch: () => {} });
  const handled = (url, { method = 'GET', mode = 'cors', destination = '', headers = {} } = {}) => {
    let used = false;
    listeners.fetch({ request: { url: `https://m.test${url}`, method, mode, destination, headers: new Headers(headers) }, respondWith: () => (used = true) });
    return used;
  };
  for (const p of ['/app.js', '/pages/drive.js', '/styles.css', '/icons/icon-192.png', '/manifest.webmanifest']) assert.ok(handled(p), `${p} 는 캐시해야 함`);
  assert.ok(handled('/drive/all', { mode: 'navigate' }), '화면 주소(SPA)는 캐시한 index.html');
  for (const p of ['/api/me', '/api/drive/list?parentId=', '/api/media/f1/hls/index.m3u8', '/api/media/x/tok/a.mp4', '/api/share/s1/files/cover.png', '/webdav/notes.js', '/sw.js']) assert.ok(!handled(p), `${p} 는 캐시하면 안 됨`);
  assert.ok(!handled('/api/drive/files/f1/download', { mode: 'navigate' }), '파일 내려받기 이동');
  assert.ok(!handled('/logo.png', { mode: 'navigate' }), '확장자 있는 주소 이동');
  assert.ok(!handled('/videos/a.webm', { destination: 'video' }), '영상');
  assert.ok(!handled('/app.js', { headers: { range: 'bytes=0-' } }), 'Range 요청');
  assert.ok(!handled('/app.js', { method: 'POST' }), 'POST');
  let crossOrigin = false;
  listeners.fetch({ request: { url: 'https://other.test/app.js', method: 'GET', mode: 'cors', destination: 'script', headers: new Headers() }, respondWith: () => (crossOrigin = true) });
  assert.ok(!crossOrigin, '다른 사이트');
  assert.ok(listeners.install && listeners.activate, 'install·activate 처리기(새 버전 반영)');
});

test('[K-09] 서버가 PWA 파일을 알맞은 형식으로 보냄', async () => {
  const s = await startServer();
  try {
    const types = { '/manifest.webmanifest': /manifest\+json/, '/sw.js': /javascript/, '/pwa.js': /javascript/, '/icons/icon-512.png': /image\/png/, '/icons/maskable-512.png': /image\/png/ };
    for (const [p, re] of Object.entries(types)) {
      const r = await fetch(s.url + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), re, p);
    }
  } finally {
    await s.close();
  }
});

test('[K-09] 문법 확인: sw.js·pwa.js·desktop/main.js·preload.js', () => {
  for (const f of ['web/sw.js', 'web/pwa.js', 'desktop/main.js', 'desktop/preload.js']) execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
});

test('[K-09] 데스크톱 빌드 대상: Windows nsis(x64·ia32·구버전), macOS dmg(arm64·x64), mimic·magnet 링크', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  assert.equal(pkg.main, 'main.js');
  assert.ok(pkg.scripts.start && pkg.scripts.dist, 'npm start / npm run dist');
  assert.match(pkg.scripts['dist:win-legacy'], /electronVersion=22\./, 'Windows 7·8 용 Electron 22 빌드');
  const win = pkg.build.win.target.find((t) => t.target === 'nsis');
  assert.deepEqual([...win.arch].sort(), ['ia32', 'x64']);
  const mac = pkg.build.mac.target.find((t) => t.target === 'dmg');
  assert.deepEqual([...mac.arch].sort(), ['arm64', 'x64']);
  assert.deepEqual(pkg.build.protocols.flatMap((p) => p.schemes).sort(), ['magnet', 'mimic']);
  for (const f of pkg.build.files) assert.ok(fs.existsSync(path.join(root, 'desktop', f)), `${f} 없음`);
  assert.equal(pngSize(path.join(root, 'desktop', pkg.build.icon)), '512x512');
});

test('[K-09] 서비스 워커: 네트워크 우선(배포 직후에도 새 파일), 오프라인일 때만 캐시', async () => {
  const listeners = {};
  const store = new Map();
  const cache = { match: async (k) => store.get(k), put: async (k, r) => void store.set(k, r) };
  let net = null; // 다음 fetch 결과(null 이면 오프라인)
  const self = { location: { origin: 'https://m.test' }, addEventListener: (type, fn) => (listeners[type] = fn) };
  const fetch = async () => (net ? { ok: true, type: 'basic', body: net, clone() { return this; } } : Promise.reject(new TypeError('offline')));
  vm.runInNewContext(fs.readFileSync(web('sw.js'), 'utf8'), { self, URL, caches: { open: async () => cache }, fetch });
  const get = (url) => {
    let p;
    listeners.fetch({ request: { url: `https://m.test${url}`, method: 'GET', mode: 'cors', destination: 'script', headers: new Headers() }, respondWith: (x) => (p = x) });
    return p.then((r) => r.body);
  };
  net = 'v1';
  assert.equal(await get('/ui.js'), 'v1');
  net = 'v2';
  assert.equal(await get('/ui.js'), 'v2', '새 배포 파일이 바로 와야 함(옛 캐시 먼저 주면 화면 모듈과 섞임)');
  net = null;
  assert.equal(await get('/ui.js'), 'v2', '오프라인이면 마지막 캐시');
  await assert.rejects(get('/pages/never.js'), /offline/, '캐시에도 없으면 네트워크 오류 그대로');
});

test('[K-09] 데스크톱: 모든 창에 링크 규칙(같은 서버만 앱 안, 다른 사이트·서버 302 는 밖으로, OAuth 는 안내)', () => {
  // main.js 를 가짜 electron 으로 실행하고 web-contents-created 에 붙는 처리기를 확인한다
  const appOn = {};
  const calls = { external: [], dialog: 0 };
  const electron = {
    app: { on: (ev, fn) => (appOn[ev] = fn), requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), getPath: () => '' },
    shell: { openExternal: (u) => calls.external.push(u) },
    dialog: { showMessageBox: async () => (calls.dialog++, { response: 0 }) },
  };
  const req = (m) => (m === 'electron' ? electron : { fs, path }[m]);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8'), { require: req, process: { argv: [], env: {} }, __dirname: path.join(root, 'desktop'), URL, console });
  assert.ok(appOn['web-contents-created'], '모든 webContents 에 규칙을 붙여야 함(재생 창·window.open 창 포함)');
  const wc = { on: (ev, fn) => (wc[ev] = fn), setWindowOpenHandler: (fn) => (wc.open = fn) };
  appOn['web-contents-created']({}, wc);
  const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const S = 'http://localhost:4300';

  assert.equal(wc.open({ url: `${S}/policy/terms` }).action, 'allow');
  assert.equal(wc.open({ url: 'https://other.test/' }).action, 'deny');
  let e = ev();
  wc['will-navigate'](e, 'https://other.test/x');
  assert.ok(e.prevented);
  e = ev();
  wc['will-navigate'](e, `${S}/drive/all`);
  assert.ok(!e.prevented);
  assert.deepEqual(calls.external, ['https://other.test/', 'https://other.test/x'], '다른 사이트는 기본 브라우저로');

  e = ev();
  wc['will-redirect'](e, `${S}/api/auth/oauth/google/dev?state=x`, false, true);
  assert.ok(!e.prevented, '같은 서버 302 는 그대로');
  e = ev();
  wc['will-redirect'](e, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=c&response_type=code&state=s', false, true);
  assert.ok(e.prevented, 'OAuth 공급자 화면을 앱 창에 열지 않음');
  assert.equal(calls.dialog, 1, '이메일·QR 로그인 안내');
  e = ev();
  wc['will-redirect'](e, 'https://other.test/landing', false, true);
  assert.ok(e.prevented);
  assert.equal(calls.external.at(-1), 'https://other.test/landing', '서버가 보낸 다른 사이트는 기본 브라우저로');
  e = ev();
  wc['will-redirect'](e, 'https://other.test/frame', false, false);
  assert.ok(!e.prevented, '하위 프레임은 건드리지 않음');
});
