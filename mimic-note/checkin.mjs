#!/usr/bin/env node
// 미믹노트 체크인: 팀원의 투두리스트를 보여 주고 본인 텔레그램으로 보낸다.
// Node 18 이상, npm install 필요 없음.
//
//   node mimic-note/checkin.mjs 민호            투두 출력 + 텔레그램 발송
//   node mimic-note/checkin.mjs minho --dry     발송 없이 메시지만 출력
//   node mimic-note/checkin.mjs --chat-ids      봇에 말을 건 사람들의 chat id 확인(TELEGRAM_BOT_TOKEN 필요)
//
// 텔레그램 발송 순서
//   1) 이 컴퓨터에 TELEGRAM_BOT_TOKEN 과 그 팀원의 chat id 가 있으면 바로 보낸다.
//      chat id: TELEGRAM_CHAT_IDS='{"minho":"123"}' 또는 TELEGRAM_CHAT_ID_MINHO=123 (저장소 루트 .env 도 읽음)
//   2) 없으면 gh CLI 로 GitHub Actions(미믹노트 체크인)를 실행한다. 토큰은 저장소 비밀값에 있다.
//   3) 둘 다 안 되면 무엇이 빠졌는지 알려 준다. 투두 출력은 항상 된다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = 'newcode135-prog/mimic';
const WORKFLOW = 'mimic-checkin.yml';

export function loadMembers(dir = HERE) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'members.json'), 'utf8')).members;
}

// '민호', 'minho', 'Minho', '민호님' 모두 같은 사람으로 찾는다.
export function findMember(input, members) {
  const key = String(input || '').trim().replace(/님$/, '').toLowerCase();
  if (!key) return null;
  return members.find((m) => m.id === key || m.name === key || (m.github && m.github.toLowerCase() === key)) || null;
}

export function loadTodos(memberId, dir = HERE) {
  const file = path.join(dir, 'data', 'todos', `${memberId}.json`);
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (data.todos || []).filter((t) => t.status !== 'done');
}

export function buildMessage(member, todos) {
  if (!todos.length) return `${member.name}님, 지금 등록된 투두리스트가 없습니다.`;
  return todos.map((t, i) => `${member.name}님의 투두리스트 ${t.no ?? i + 1}번은 ${t.title}`).join('\n');
}

function readDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function chatIdFor(memberId, env) {
  const direct = env[`TELEGRAM_CHAT_ID_${memberId.toUpperCase()}`];
  if (direct) return direct;
  if (env.TELEGRAM_CHAT_IDS) {
    try { return JSON.parse(env.TELEGRAM_CHAT_IDS)[memberId] || null; } catch { return null; }
  }
  return null;
}

async function telegram(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`텔레그램 ${method} 실패: ${json.description || res.status}`);
  return json.result;
}

function dispatchViaActions(memberId) {
  try {
    execFileSync('gh', ['workflow', 'run', WORKFLOW, '-R', REPO, '-f', `member=${memberId}`], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    const msg = String(e.stderr || e.message || e).trim().split('\n')[0];
    return { ok: false, reason: e.code === 'ENOENT' ? 'gh CLI 가 설치되어 있지 않음' : msg };
  }
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const env = { ...readDotEnv(), ...process.env };

  if (flags.has('--chat-ids')) {
    if (!env.TELEGRAM_BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN 이 필요합니다.'); return 1; }
    const updates = await telegram(env.TELEGRAM_BOT_TOKEN, 'getUpdates');
    const seen = new Map();
    for (const u of updates) {
      const c = (u.message || u.my_chat_member || {}).chat;
      if (c) seen.set(c.id, [c.first_name, c.last_name, c.username && `@${c.username}`].filter(Boolean).join(' '));
    }
    if (!seen.size) console.log('아직 봇에 말을 건 사람이 없습니다. 팀원이 봇을 열고 /start 를 누르게 하세요.');
    for (const [id, who] of seen) console.log(`${id}\t${who}`);
    return 0;
  }

  const members = loadMembers();
  const member = findMember(args[0], members);
  if (!member) {
    console.error(`팀원을 찾지 못했습니다: "${args[0] || ''}". 가능한 이름: ${members.map((m) => `${m.name}(${m.id})`).join(', ')}`);
    return 1;
  }

  const message = buildMessage(member, loadTodos(member.id));
  console.log(`[미믹노트] ${member.name}(${member.id}) 체크인\n`);
  console.log(message + '\n');
  if (flags.has('--dry')) { console.log('텔레그램: 보내지 않음(--dry)'); return 0; }

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = chatIdFor(member.id, env);
  if (token && chatId) {
    await telegram(token, 'sendMessage', { chat_id: chatId, text: message });
    console.log(`텔레그램: ${member.name}님에게 보냈습니다.`);
    return 0;
  }
  if (flags.has('--no-dispatch')) {
    console.error(`텔레그램: 보낼 수 없음 — ${!token ? 'TELEGRAM_BOT_TOKEN' : `${member.id} 의 chat id(TELEGRAM_CHAT_IDS)`} 가 없습니다.`);
    return 1;
  }
  const r = dispatchViaActions(member.id);
  if (r.ok) {
    console.log(`텔레그램: GitHub Actions(${WORKFLOW})에 발송을 요청했습니다. 보통 30초~1분 안에 도착합니다.`);
    console.log(`         진행 확인: gh run list -R ${REPO} --workflow ${WORKFLOW} --limit 1`);
    return 0;
  }
  console.log('텔레그램: 아직 보내지 못했습니다.');
  console.log(`  - 이 컴퓨터에 토큰·chat id 없음, GitHub Actions 요청 실패(${r.reason})`);
  console.log('  - 해결: 관리자에게 저장소 쓰기 권한을 받고 `gh auth login` 하거나, mimic-note/README.md 의 "텔레그램 설정"을 따르세요.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
