// 앱 다운로드 화면 후속(K-09·G-02·G-08): 웹 앱 설치 카드, Homebrew·npx 명령, 확장 권한, Android 앱 링크
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from './helpers.js';
import { loadConfig } from '../server/core/config.js';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('[K-09] assetlinks.json: 설정이 없으면 빈 목록(JSON)', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`${s.url}/.well-known/assetlinks.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await r.json(), []);
  } finally {
    await s.close();
  }
});

test('[K-09] assetlinks.json: 환경변수의 패키지·지문(쉼표 구분)으로 TWA 위임 선언, 지문은 AA:BB:… 형식으로 맞춤', async () => {
  const saved = { p: process.env.MIMIC_ANDROID_PACKAGE, k: process.env.MIMIC_ANDROID_SHA256 };
  const a = 'ab'.repeat(32); // apksigner 출력처럼 콜론 없는 소문자 64자
  const b = Array(32).fill('CD').join(':'); // keytool 출력처럼 콜론 구분
  process.env.MIMIC_ANDROID_PACKAGE = ' app.mimic.twa ';
  process.env.MIMIC_ANDROID_SHA256 = ` ${a} , ${b},`;
  let s;
  try {
    s = await startServer();
    const r = await fetch(`${s.url}/.well-known/assetlinks.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await r.json(), [
      { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'app.mimic.twa', sha256_cert_fingerprints: [Array(32).fill('AB').join(':'), b] } },
    ]);
    // 길이가 틀리거나 라벨이 붙은 지문은 조용히 내보내지 않고 시작을 거부
    for (const bad of ['aa:bb:cc', `SHA256: ${b}`]) {
      process.env.MIMIC_ANDROID_SHA256 = bad;
      assert.throws(() => loadConfig(), /MIMIC_ANDROID_SHA256/, bad);
    }
  } finally {
    for (const [k, v] of [['MIMIC_ANDROID_PACKAGE', saved.p], ['MIMIC_ANDROID_SHA256', saved.k]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await s?.close();
  }
});

test('[K-09] 앱 화면: pwa.js 설치 함수로 웹 앱 카드, 네이티브 설치 파일은 준비 중', () => {
  const apps = read('web/pages/apps.js');
  execFileSync(process.execPath, ['--check', path.join(root, 'web/pages/apps.js')]);
  const pwa = read('web/pwa.js');
  for (const fn of ['installState', 'promptInstall', 'iosHint']) {
    assert.match(pwa, new RegExp(`export (const|async function|function) ${fn}\\b`), `pwa.js 가 ${fn} 을 내보냄`);
    assert.ok(apps.includes(fn), `apps.js 가 ${fn} 을 씀`);
  }
  for (const st of ['ready', 'installed', 'ios', 'unavailable']) assert.ok(apps.includes(`${st}:`) || apps.includes(`'${st}'`), `상태 ${st} 처리`);
  // 아직 빌드하지 않은 네이티브 설치 파일(K-09)은 가짜 링크 없이 준비 중
  for (const name of ['Android APK', 'Google Play', 'Galaxy Store', 'App Store', 'Windows 10·11', 'Windows 구버전', 'macOS (Apple 칩)', 'macOS (Intel)', 'Android TV 전용 APK']) {
    assert.match(apps, new RegExp(`\\['${name.replace(/[()]/g, '\\$&')}',[^\\]]*, SOON\\]`), `${name} 은 준비 중`);
  }
  assert.ok(!/\.(exe|dmg|apk)\b/.test(apps), '설치 파일 링크 없음');
});

test('[G-02] 앱 화면의 CLI 명령(Homebrew·npx 포함)이 가리키는 서버 파일이 모두 있음', async () => {
  const apps = read('web/pages/apps.js');
  assert.ok(!/\['(Homebrew|npx)',[^\]]*SOON\]/.test(apps), 'Homebrew·npx 는 준비 중이 아님');
  assert.ok(apps.includes('npx -y ${location.origin}/api/integrations/cli/mimic-cli.tgz '), 'npx 는 서버 tarball 을 바로 실행');
  assert.ok(apps.includes('curl -fsSL ${location.origin}/api/integrations/cli/mimic.rb -o "$F/mimic.rb" && brew install mimic/local/mimic'), 'Homebrew 는 로컬 탭에 공식을 받아 설치');
  const paths = [...new Set(apps.match(/\/api\/integrations\/[\w./-]+/g))];
  for (const p of ['/api/integrations/cli/mimic.rb', '/api/integrations/cli/mimic-cli.tgz', '/api/integrations/cli/install.sh', '/api/integrations/cli/install.ps1']) assert.ok(paths.includes(p), p);
  const s = await startServer();
  try {
    for (const p of paths) assert.equal((await fetch(s.url + p)).status, 200, p);
    // brew install mimic/local/mimic 은 mimic.rb 안의 Mimic 클래스를 찾는다
    assert.match(await (await fetch(`${s.url}/api/integrations/cli/mimic.rb`)).text(), /^class Mimic < Formula$/m);
  } finally {
    await s.close();
  }
});

test('[G-08] 브라우저 확장은 services 권한만 요청(files:write 는 쓰지 않음)', () => {
  assert.match(read('extension/api.js'), /appId: 'extension', scopes: \['services'\]/);
  for (const f of fs.readdirSync(path.join(root, 'extension')).filter((f) => f.endsWith('.js'))) assert.ok(!read(`extension/${f}`).includes('files:write'), f);
});
