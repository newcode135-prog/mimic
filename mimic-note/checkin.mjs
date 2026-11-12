#!/usr/bin/env node
// 미믹노트 체크인: ① 대전제(premise.md)를 먼저 보여 주고 ② 미션 데이터베이스(data/missions.json)에서
// 그 팀원의 남은 미션을 꺼내 Claude Code 가 전달한다.
// Node 18 이상, npm install 필요 없음.
//
//   node mimic-note/checkin.mjs 민호              남은 미션 출력 (Claude Code 가 그대로 전달)
//   node mimic-note/checkin.mjs 민호 --telegram   + 텔레그램으로도 발송(봇 설정이 끝난 뒤)
//   node mimic-note/checkin.mjs --chat-ids        봇에 말을 건 사람들의 chat id 확인(TELEGRAM_BOT_TOKEN 필요)
//
// 텔레그램 발송 순서(--telegram 일 때)
//   1) 이 컴퓨터에 TELEGRAM_BOT_TOKEN 과 그 팀원의 chat id 가 있으면 바로 보낸다.
//      chat id: TELEGRAM_CHAT_IDS='{"minho":"123"}' 또는 TELEGRAM_CHAT_ID_MINHO=123 (저장소 루트 .env 도 읽음)
//   2) 없으면 gh CLI 로 GitHub Actions(미믹노트 체크인)를 실행한다. 토큰은 저장소 비밀값에 있다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, loadMembers, findMember, loadDb, openMissions, doneMissions, formatMissions, loadPremise } from './lib.mjs';

export { loadMembers, findMember } from './lib.mjs';

const ROOT = path.resolve(NOTE_DIR, '..');
const REPO = 'newcode135-prog/mimic';
const WORKFLOW = 'mimic-checkin.yml';

export function buildMessage(member, db = loadDb()) {
  return formatMissions(member, openMissions(db, member.id));
}

// 체크인 화면 전체: 대전제 → 미션 순서.
export function checkinText(member, db = loadDb(), premise = loadPremise()) {
  const open = openMissions(db, member.id);
  const lines = [
    '━━━━━━━━ ① 대전제 (모든 플레이어·관리자·AI 가 먼저 따르는 규칙) ━━━━━━━━',
    premise,
    '',
    `━━━━━━━━ ② ${member.name}(${member.id}) 체크인 — 남은 미션 ${open.length}개 · 완료 ${doneMissions(db, member.id).length}개 ━━━━━━━━`,
    '',
    formatMissions(member, open),
  ];
  if (open.length) lines.push('', `미션을 끝내면: node mimic-note/mission.mjs done ${member.id} <번호>  (그 뒤 git commit·push)`);
  else lines.push('', '미션은 관리자(창민·민호)가 등록합니다. 등록되면 같은 암호구로 다시 체크인하세요.');
  return lines.join('\n');
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

async function sendTelegram(member, message, env, flags) {
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
    return 0;
  }
  console.log(`텔레그램: 아직 보내지 못했습니다(이 컴퓨터에 토큰 없음, Actions 요청 실패: ${r.reason}). mimic-note/README.md 의 "텔레그램 설정" 참고.`);
  return 0;
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const env = { ...readDotEnv(), ...process.env };

  if (flags.has('--chat-ids')) {
    if (!env.TELEGRAM_BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN 이 필요합니다(저장소 폴더의 .env 에 넣거나 환경변수로).'); return 1; }
    const updates = await telegram(env.TELEGRAM_BOT_TOKEN, 'getUpdates');
    const seen = new Map();
    for (const u of updates) {
      const c = (u.message || u.my_chat_member || {}).chat;
      if (c) seen.set(c.id, [c.first_name, c.last_name, c.username && `@${c.username}`].filter(Boolean).join(' '));
    }
    if (!seen.size) console.log('아직 봇에 말을 건 사람이 없습니다. 봇을 열고 /start 를 누르세요.');
    for (const [id, who] of seen) console.log(`${id}\t${who}`);
    return 0;
  }

  const members = loadMembers();
  const member = findMember(args[0], members);
  if (!member) {
    console.error(`팀원을 찾지 못했습니다: "${args[0] || ''}". 가능한 이름: ${members.map((m) => `${m.name}(${m.id})`).join(', ')}`);
    return 1;
  }

  const db = loadDb();
  console.log(checkinText(member, db));

  if (!flags.has('--telegram')) return 0;
  console.log('');
  return sendTelegram(member, buildMessage(member, db), env, flags);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
