#!/usr/bin/env node
// 미믹 CLI (G-02, G-09). Node 20 이상 내장 기능(fetch·FormData·parseArgs)만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

const CONF = path.join(os.homedir(), '.mimic-cli.json');
const DEFAULT_SERVER = 'http://localhost:4300';

const HELP = `미믹 CLI — 미믹 클라우드 드라이브를 명령줄에서 다룹니다

사용법: mimic <명령> [인자] [옵션]

계정
  auth login                 브라우저에서 승인해 로그인(비밀번호를 CLI 에 입력하지 않음)
  auth logout                이 컴퓨터에 저장된 로그인 정보 지우기
  whoami                     로그인한 계정 보기

파일 (ID 대신 /영상/a.mp4 같은 경로도 됩니다)
  ls [폴더]                  폴더 목록(비우면 최상위)
  upload <파일> [폴더]       파일 올리기
  download <파일> [경로]     파일 내려받기
  share <파일...>            공유 링크 만들기 (--days 0|7|14|30, --password)
  stream <파일>              외부 플레이어(VLC·PotPlayer 등)로 여는 재생 주소

클라우드 다운로드
  offline add <URL...>       마그넷·토렌트·URL 을 미믹 서버가 대신 받아 저장 (--parent 폴더)
  tasks                      클라우드 다운로드 작업 목록
  quota                      전송 쿼터 사용량

AI 에이전트
  skill install              AI 에이전트용 스킬 문서(SKILL.md) 설치 (--dir 경로, 기본 ~/.claude/skills/mimic)

옵션
  --server <주소>            미믹 서버 주소 (환경변수 MIMIC_SERVER, 기본 ${DEFAULT_SERVER})
  --json                     결과를 JSON 그대로 출력
  -h, --help                 이 도움말

무인 실행(서버·CI): 웹 설정 > 액세스 및 통합에서 만든 개인 액세스 토큰을 환경변수 MIMIC_TOKEN 에 넣으면
로그인 없이 동작합니다.`;

const { values: opt, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    dir: { type: 'string' },
    parent: { type: 'string' },
    days: { type: 'string' },
    password: { type: 'boolean' },
    'no-browser': { type: 'boolean' },
  },
});

const readConf = () => {
  try {
    return JSON.parse(fs.readFileSync(CONF, 'utf8'));
  } catch {
    return {};
  }
};
const conf = readConf();
const server = (opt.server || process.env.MIMIC_SERVER || conf.server || DEFAULT_SERVER).replace(/\/+$/, '');
const token = process.env.MIMIC_TOKEN || (conf.server === server || !conf.server ? conf.token : null);

class CliError extends Error {}
const die = (msg) => {
  throw new CliError(msg);
};

async function call(p, { method = 'GET', body, raw = false, auth = true } = {}) {
  if (auth && !token) die('로그인이 필요합니다. 먼저 `mimic auth login` 을 실행하세요');
  const headers = {};
  if (auth) headers.authorization = `Bearer ${token}`;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(server + p, { method, headers, body: payload });
  } catch (e) {
    die(`서버(${server})에 연결하지 못했습니다: ${e.cause?.code || e.message}`);
  }
  if (raw && r.ok) return r;
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : { message: await r.text() };
  if (!r.ok) {
    if (r.status === 401) die('로그인이 만료되었거나 토큰이 폐기되었습니다. `mimic auth login` 으로 다시 로그인하세요');
    throw Object.assign(new CliError(data.message || `요청 실패 (HTTP ${r.status})`), { code: data.error });
  }
  return data;
}

// "/영상/a.mp4" 같은 경로를 ID 로 바꾼다. "/" 로 시작하지 않으면 이미 ID 로 본다. 최상위는 null
async function resolveId(ref) {
  if (!ref || !ref.startsWith('/')) return ref || null;
  let id = null;
  for (const name of ref.split('/').filter(Boolean)) {
    const r = await call(`/api/drive/list${id ? `?parentId=${encodeURIComponent(id)}` : ''}`);
    const hit = (r.items || []).find((x) => x.name === name);
    if (!hit) die(`경로를 찾을 수 없습니다: ${ref}`);
    id = hit.id;
  }
  return id;
}

const out = (data, human) => (opt.json || !human ? console.log(JSON.stringify(data, null, 2)) : human(data));
const size = (n) => {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

const SKILL = `---
name: mimic
description: 미믹(Mimic) 클라우드 드라이브를 mimic CLI 로 다룬다. 링크(마그넷·토렌트·URL·SNS)를 클라우드에 저장하거나, 파일 목록·업로드·내려받기·공유·재생 주소·쿼터를 확인할 때 사용한다.
---

# 미믹 클라우드 드라이브 (mimic CLI)

미믹은 사용자가 준 외부 링크를 미믹 서버가 대신 받아 **그 사용자의 미믹 클라우드에만** 저장하는 드라이브다.
모든 작업은 \`mimic\` 명령으로 한다. 결과를 프로그램으로 읽을 때는 \`--json\` 을 붙인다.

## 준비
- 로그인 확인: \`mimic whoami\` — 실패하면 사용자에게 \`mimic auth login\` 실행(브라우저 승인)을 부탁한다.
- 무인 환경에서는 환경변수 \`MIMIC_TOKEN\`(개인 액세스 토큰)과 \`MIMIC_SERVER\` 를 쓴다.

## 자주 쓰는 명령
| 하려는 일 | 명령 |
| --- | --- |
| 최상위 목록 | \`mimic ls --json\` |
| 폴더 목록 | \`mimic ls <폴더ID> --json\` |
| 링크를 클라우드에 저장 | \`mimic offline add "<마그넷 또는 URL>" [--parent <폴더ID>]\` |
| 작업 진행 확인 | \`mimic tasks --json\` |
| 파일 올리기 | \`mimic upload <로컬 파일> [폴더ID]\` |
| 파일 내려받기 | \`mimic download <파일ID> [저장 경로]\` |
| 공유 링크 | \`mimic share <파일ID> [--days 7] [--password]\` |
| 외부 플레이어 재생 주소 | \`mimic stream <파일ID>\` |
| 전송 쿼터 | \`mimic quota --json\` |

## 지켜야 할 것
- 파일·폴더는 \`ls\` 결과의 \`id\` 또는 \`/영상/a.mp4\` 같은 전체 경로로 지정한다. 이름을 추측하지 말고 먼저 \`ls\` 로 확인한다.
- 공유 링크 만들기·파일 올리기처럼 밖으로 보이거나 용량을 쓰는 일은 사용자가 요청한 경우에만 한다.
- 영구삭제는 CLI 에 없다. 지우려면 사용자가 웹에서 직접 하도록 안내한다.
- 모든 계정(프리미엄 포함)은 CLI 같은 연결 앱 전송량이 월 쿼터의 25%로 제한되고, 무료 계정은 추가로 하루 클라우드 다운로드 횟수와 연결 앱 다운로드 하루 5GB 제한이 있다. \`cloud_limit\`·\`app_quota\`·\`app_daily_quota\` 오류가 나면 그대로 사용자에게 알린다.
`;

async function main() {
  const [cmd, sub, ...rest] = args;
  if (opt.help || !cmd || cmd === 'help') return console.log(HELP);

  switch (cmd) {
    case 'auth': {
      if (sub === 'logout') {
        fs.rmSync(CONF, { force: true });
        return console.log('로그아웃했습니다. 서버에 남은 토큰은 웹 설정 > 액세스 및 통합 > 연결된 앱에서 폐기할 수 있습니다.');
      }
      if (sub !== 'login') die('사용법: mimic auth login | mimic auth logout');
      const d = await call('/api/auth/device/code', { method: 'POST', auth: false, body: { clientName: `미믹 CLI (${os.hostname()})`, appId: 'cli', scopes: ['files:write', 'services'] } });
      console.log(`브라우저에서 아래 주소를 열고 코드 ${d.userCode} 를 확인해 승인하세요.\n  ${d.verificationUri}`);
      if (!opt['no-browser']) openBrowser(d.verificationUri);
      const until = Date.now() + (d.expiresIn || 600) * 1000;
      while (Date.now() < until) {
        await sleep((d.interval || 5) * 1000);
        try {
          const r = await call('/api/auth/device/token', { method: 'POST', auth: false, body: { deviceCode: d.deviceCode } });
          fs.writeFileSync(CONF, JSON.stringify({ server, token: r.token, user: r.user?.email || r.user?.phone || r.user?.id }, null, 2), { mode: 0o600 });
          return console.log(`로그인했습니다: ${r.user?.name || r.user?.email || r.user?.phone || ''}\n로그인 정보 저장 위치: ${CONF}`);
        } catch (e) {
          if (e.code !== 'authorization_pending' && e.code !== 'slow_down') throw e;
        }
      }
      return die('승인 시간이 지났습니다. 다시 실행해 주세요');
    }
    case 'whoami':
      return out(await call('/api/me'), (m) => {
        const u = m.user;
        console.log(`${u.name || '(이름 없음)'}  ${u.email || u.phone || u.id}`);
        console.log(`등급: ${m.premium ? 'Premium' : '무료'}   저장공간: ${size(m.storage?.used)} / ${size(m.storage?.total)}`);
      });
    case 'ls': {
      const id = await resolveId(sub);
      const r = await call(`/api/drive/list${id ? `?parentId=${encodeURIComponent(id)}` : ''}`);
      return out(r, (x) => {
        const where = (x.path || []).map((p) => p.name).join('/') || '(최상위)';
        console.log(`/${where === '(최상위)' ? '' : where}`);
        for (const f of x.items || []) console.log(`${f.kind === 'folder' ? 'DIR ' : 'FILE'}  ${String(f.kind === 'folder' ? '-' : size(f.size)).padStart(9)}  ${f.id}  ${f.name}`);
        if (!x.items?.length) console.log('(비어 있음)');
      });
    }
    case 'upload': {
      if (!sub) die('사용법: mimic upload <파일> [폴더ID]');
      if (!fs.existsSync(sub) || !fs.statSync(sub).isFile()) die(`파일을 찾을 수 없습니다: ${sub}`);
      const fd = new FormData();
      fd.append('file', await fs.openAsBlob(sub), path.basename(sub));
      const parent = await resolveId(rest[0] || opt.parent);
      const r = await call(`/api/drive/upload${parent ? `?parentId=${encodeURIComponent(parent)}` : ''}`, { method: 'POST', body: fd });
      return out(r, (x) => console.log(`올렸습니다: ${x.file?.name} (${size(x.file?.size)})  ID ${x.file?.id}`));
    }
    case 'download': {
      if (!sub) die('사용법: mimic download <파일ID> [저장 경로]');
      const r = await call(`/api/drive/files/${encodeURIComponent(await resolveId(sub))}/download`, { raw: true });
      const cd = r.headers.get('content-disposition') || '';
      const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] || sub);
      let dest = rest[0] || name;
      if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) dest = path.join(dest, name);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
      return console.log(`내려받았습니다: ${dest} (${size(fs.statSync(dest).size)})`);
    }
    case 'share': {
      const ids = await Promise.all([sub, ...rest].filter(Boolean).map(resolveId));
      if (!ids.length) die('사용법: mimic share <파일ID...> [--days 0|7|14|30] [--password]');
      const r = await call('/api/share', { method: 'POST', body: { fileIds: ids, expiryDays: Number(opt.days || 0), password: !!opt.password } });
      return out(r, (x) => {
        console.log(`공유 링크: ${x.url?.startsWith('/') ? server + x.url : x.url}`);
        if (x.password) console.log(`비밀번호: ${x.password}`);
      });
    }
    case 'stream': {
      if (!sub) die('사용법: mimic stream <파일ID>');
      return out(await call(`/api/media/${encodeURIComponent(await resolveId(sub))}/external-url`), (x) => {
        console.log(x.url);
        if (x.vlc) console.log(`VLC: ${x.vlc}`);
      });
    }
    case 'offline': {
      if (sub !== 'add' || !rest.length) die('사용법: mimic offline add <URL...> [--parent 폴더ID]');
      const r = await call('/api/offline/tasks', { method: 'POST', body: { urls: rest, parentId: await resolveId(opt.parent) } });
      return out(r, (x) => {
        const list = x.tasks || x.items || [];
        console.log(`클라우드 다운로드 작업 ${list.length || rest.length}개를 만들었습니다. 진행 상황: mimic tasks`);
        for (const t of list) console.log(`  ${t.id}  ${t.status || ''}  ${t.name || t.url || ''}`);
      });
    }
    case 'tasks':
      return out(await call('/api/offline/tasks'), (x) => {
        const list = x.tasks || x.items || [];
        if (!list.length) return console.log('작업이 없습니다');
        for (const t of list) console.log(`${t.id}  ${(t.status || '').padEnd(9)} ${t.progress != null ? `${Math.round(t.progress * (t.progress <= 1 ? 100 : 1))}%` : ''}  ${t.name || t.url || ''}`);
      });
    case 'quota':
      return out(await call('/api/billing/quota'), (x) => {
        const q = x.quota || x;
        const label = { cloud: '클라우드 다운로드', down: '다운스트림', up: '업로드' };
        for (const k of ['cloud', 'down', 'up']) if (q.month?.[k]) console.log(`${label[k].padEnd(10)} ${size(q.month[k].used)} / ${size(q.month[k].limit)}  (연결 앱 ${size(q.app?.[k]?.used)} / ${size(q.app?.[k]?.limit)})`);
        const ct = q.today?.cloudTasks;
        if (ct) console.log(`오늘 남은 클라우드 다운로드: ${ct.unlimited ? '무제한' : `${ct.remaining}회`}`);
      });
    case 'skill': {
      if (sub !== 'install') die('사용법: mimic skill install [--dir 경로]');
      const dir = opt.dir || path.join(os.homedir(), '.claude', 'skills', 'mimic');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL);
      return console.log(`AI 에이전트 스킬을 설치했습니다: ${path.join(dir, 'SKILL.md')}\n다른 에이전트용 폴더가 필요하면 --dir 로 지정하세요(예: ~/.codex/skills/mimic).`);
    }
    default:
      die(`알 수 없는 명령입니다: ${cmd}\n도움말: mimic --help`);
  }
}

main().catch((e) => {
  console.error(e instanceof CliError ? `오류: ${e.message}` : e);
  process.exitCode = 1;
});
