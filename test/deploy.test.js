// 맥미니 배포 키트(deploy/macmini, T-2·A-04): 셸 문법, launchd plist 템플릿, 운영 모드(.env) 실제 부팅
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const kit = path.join(root, 'deploy', 'macmini');
const read = (f) => fs.readFileSync(path.join(kit, f), 'utf8').replaceAll('\r\n', '\n'); // Windows 체크아웃(autocrlf)은 CRLF
const shells = fs.readdirSync(kit).filter((f) => f.endsWith('.sh'));
const plists = fs.readdirSync(kit).filter((f) => f.endsWith('.plist'));
// Windows 의 PATH 에 있는 bash 는 WSL 일 수 있어 Git Bash 를 먼저 쓴다
const gitBash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const bash = process.platform === 'win32' && fs.existsSync(gitBash) ? gitBash : 'bash';
const hasBash = spawnSync(bash, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

test('셸 스크립트: bash -n 문법 검사', (t) => {
  if (!hasBash) return t.skip('bash 가 없습니다');
  assert.deepEqual(shells.sort(), ['backup.sh', 'check.sh', 'setup.sh', 'update.sh']);
  for (const f of shells) {
    const src = read(f);
    assert.ok(src.startsWith('#!/bin/bash\n'), `${f}: macOS 기본 bash 로 실행`);
    const r = spawnSync(bash, ['-n'], { input: src, encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

// 임시 git 저장소 두 개(원격·설치본)에서 update.sh 를 실제로 돌린다. npm·sudo·curl·sleep 은 가짜 함수
test('update.sh: 새 버전의 npm ci 가 실패하면 이전 커밋으로 되돌린다', (t) => {
  if (!hasBash || spawnSync('git', ['--version']).status !== 0) return t.skip('bash 또는 git 이 없습니다');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  fs.writeFileSync(path.join(dir, 'update.sh'), read('update.sh'));
  const script = `set -e
    cd "$1"
    git init -q origin && cd origin
    mkdir -p deploy/macmini && cp ../update.sh deploy/macmini/ && git add -A && git commit -qm v1
    git clone -q -c core.autocrlf=false . ../app
    touch BROKEN && git add BROKEN && git commit -qm v2   # 이 커밋에서는 npm ci 가 실패한다
    cd ../app && git rev-parse HEAD >../prev
    npm() { [ ! -f BROKEN ]; }
    sudo() { :; }
    curl() { echo '{"ok":true,"failed":[]}'; }
    sleep() { :; }
    export -f npm sudo curl sleep
    bash deploy/macmini/update.sh`;
  const id = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const r = spawnSync(bash, ['-c', script, '_', dir.replaceAll('\\', '/')], { encoding: 'utf8', env: { ...process.env, ...id } });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.match(out, /의존성 설치\(npm ci\)에 실패해 이전 커밋 \w+ 로 되돌립니다/);
  assert.match(out, /되돌림 완료/);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(dir, 'app'), encoding: 'utf8' }).stdout;
  assert.equal(head, fs.readFileSync(path.join(dir, 'prev'), 'utf8'), '설치본이 이전 커밋으로 돌아가야 함');
  assert.ok(!fs.existsSync(path.join(dir, 'app', 'BROKEN')));
});

// 표준 라이브러리에 XML 파서가 없어 태그 짝·이스케이프만 본다(맥에서는 setup.sh 가 plutil -lint 로 다시 검사)
function assertWellFormed(f, xml) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist [^>]+>\n/, f);
  const body = xml
    .replace(/^<\?xml[^>]*\?>/, '')
    .replace(/<!DOCTYPE[^>]*>/, '')
    .replace(/<!--([\s\S]*?)-->/g, (_, c) => (assert.ok(!c.includes('--'), `${f}: 주석 안에 -- 를 쓸 수 없음`), ''));
  const stack = [];
  for (const [, close, name, self] of body.matchAll(/<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name, `${f}: </${name}> 짝이 맞지 않음`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], `${f}: 닫히지 않은 태그`);
  assert.doesNotMatch(body.replace(/<[^>]+>/g, ''), /[<>]/, `${f}: 태그 밖의 < >`);
  assert.doesNotMatch(body, /&(?!(amp|lt|gt|quot|apos);)/, `${f}: 이스케이프 안 된 &`);
}

test('launchd plist 템플릿: 형식·필수 키·setup.sh 가 채우는 자리', () => {
  const setup = read('setup.sh');
  const common = ['Label', 'UserName', 'ProgramArguments', 'EnvironmentVariables', 'StandardOutPath', 'StandardErrorPath'];
  const extra = {
    'com.mimic.server.plist': ['RunAtLoad', 'KeepAlive', 'ThrottleInterval', 'WorkingDirectory'],
    'com.mimic.telegram.plist': ['RunAtLoad', 'KeepAlive', 'ThrottleInterval', 'WorkingDirectory'],
    'com.mimic.caddy.plist': ['RunAtLoad', 'KeepAlive', 'ThrottleInterval'],
    'com.mimic.backup.plist': ['StartCalendarInterval'],
  };
  assert.deepEqual(plists.sort(), Object.keys(extra).sort());
  for (const f of plists) {
    const xml = read(f);
    assertWellFormed(f, xml);
    for (const k of [...common, ...extra[f]]) assert.match(xml, new RegExp(`<key>${k}</key>`), `${f}: ${k}`);
    assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${f.replace('.plist', '').replaceAll('.', '\\.')}</string>`), `${f}: Label = 파일 이름`);
    assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>__DATA__\/logs\//, `${f}: 로그는 데이터 폴더 logs/`);
    // 템플릿의 자리(__이름__)는 모두 setup.sh 가 채워야 한다
    for (const [ph] of xml.matchAll(/__[A-Z]+__/g)) assert.ok(setup.includes(`s|${ph}|`), `${f}: setup.sh 가 ${ph} 를 채우지 않음`);
  }
  assert.match(read('com.mimic.server.plist'), /<string>--env-file=__REPO__\/\.env<\/string>\s*<string>server\/index\.js<\/string>/);
  assert.match(read('com.mimic.telegram.plist'), /<string>tools\/telegram-bot\/bot\.js<\/string>/);
  assert.ok(fs.existsSync(path.join(root, 'tools', 'telegram-bot', 'bot.js')));
  assert.match(read('com.mimic.backup.plist'), /<string>__REPO__\/deploy\/macmini\/backup\.sh<\/string>/);
});

test('setup.sh 가 만드는 .env 에 config.js 의 설정 이름이 모두 있다', () => {
  const setup = read('setup.sh');
  const keys = new Set([...fs.readFileSync(path.join(root, 'server', 'core', 'config.js'), 'utf8').matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.ok(keys.has('MIMIC_SECRET') && keys.size > 20);
  for (const k of keys) assert.match(setup, new RegExp(`\\b${k}=`), `.env 에 ${k} 줄이 없음`);
});

// ── 운영 모드 실제 부팅: launchd 와 같은 방식(node --env-file=.env server/index.js) ──
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function boot(t, secret) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-deploy-'));
  const port = await freePort();
  const envFile = path.join(dir, '.env');
  const data = path.join(dir, 'data').replaceAll('\\', '/');
  fs.writeFileSync(envFile, `NODE_ENV=production\nMIMIC_BASE_URL=https://mimic.example\nMIMIC_DATA=${data}\nMIMIC_SECRET=${secret}\nPORT=${port}\n`);
  // --env-file 은 이미 있는 환경변수를 덮지 않으므로, 테스트 프로세스의 MIMIC_*·NODE_ENV 를 넘기지 않게 최소 환경만 준다
  const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: dir, USERPROFILE: dir }).filter(([, v]) => v));
  const child = spawn(process.execPath, [`--env-file=${envFile}`, 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (b) => (log += b));
  child.stderr.on('data', (b) => (log += b));
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { child, exited, url: `http://127.0.0.1:${port}`, log: () => log };
}

test('운영 모드 부팅: .env 로 시작하면 dev 꺼짐, 개발용 outbox 없음', async (t) => {
  const s = await boot(t, crypto.randomBytes(24).toString('hex'));
  let res;
  for (let i = 0; i < 150 && s.child.exitCode === null; i++) {
    res = await fetch(`${s.url}/api/config`).catch(() => null);
    if (res) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(res, `서버가 뜨지 않음:\n${s.log()}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dev, false);
  assert.equal((await fetch(`${s.url}/api/dev/outbox`)).status, 404);
  assert.deepEqual((await (await fetch(`${s.url}/api/health`)).json()).failed, [], '운영 모드에서 불러오지 못한 모듈');
});

test('운영 모드 부팅: MIMIC_SECRET 이 짧으면 시작을 거부한다', async (t) => {
  const s = await boot(t, 'too-short-secret');
  const timer = setTimeout(() => s.child.kill(), 20_000);
  const [code] = await s.exited;
  clearTimeout(timer);
  assert.ok(code !== null && code !== 0, `스스로 오류로 끝나야 함(code ${code}):\n${s.log()}`);
  assert.match(s.log(), /MIMIC_SECRET/);
});
