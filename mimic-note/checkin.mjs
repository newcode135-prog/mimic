#!/usr/bin/env node
// 미믹노트 체크인: ① 대전제(premise.md)를 먼저 보여 주고 ② 미션 데이터베이스(data/missions.json)에서
// 그 팀원의 남은 미션을 꺼내 Claude Code 가 전달한다.
// Node 18 이상, npm install 필요 없음.
//
//   node mimic-note/checkin.mjs 민호                 남은 미션 출력(Claude Code 가 그대로 전달) + 텔레그램 발송 요청·결과 확인
//   node mimic-note/checkin.mjs 민호 --no-telegram   화면 출력만
//   node mimic-note/checkin.mjs 민호 --no-wait       텔레그램 발송만 요청하고 결과는 기다리지 않음
//
// 텔레그램은 항상 GitHub Actions(mimic-checkin.yml)가 보낸다: 토큰이 팀원 컴퓨터에 없어도 되고,
// 같은 내용을 이미 보냈으면 다시 보내지 않는다(중복 방지). 이 컴퓨터의 gh 계정에 저장소 쓰기 권한이 있어야 요청할 수 있다.
// 연결: node mimic-note/telegram.mjs connect (저장소 주인이 한 번)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_DIR, loadMembers, findMember, loadDb, openMissions, doneMissions, formatMissions, othersLowMissions, loadPremise, chatIdFor } from './lib.mjs';
import { loadGames, latestGame, formatGame } from './game.mjs';
import { HOME_DIR } from './passive/compress.mjs';
import { createGithub, waitForNotify, formatNotify } from './github.mjs';

export { loadMembers, findMember } from './lib.mjs';

export function buildMessage(member, db = loadDb()) {
  return formatMissions(member, openMissions(db, member.id));
}

// 체크인 화면 전체: 대전제 → 미션 순서.
export function checkinText(member, db = loadDb(), premise = loadPremise(), auto = loadAuto(), games = loadGames(member.id)) {
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
  else lines.push('', '미션은 관리자가 등록합니다. 등록되면 같은 암호구로 다시 체크인하세요.');
  const members = loadMembers();
  const others = othersLowMissions(db, member, members);
  if (others.length) {
    lines.push('', '↪ 다른 관리자의 후순위 미션 (맡을 수 있으면 그 관리자에게 말하기)');
    others.forEach((m) => lines.push(`• [${m.id}] ${members.find((x) => x.id === m.assignee)?.name || m.assignee} — ${m.title}`));
  }
  const mine = auto?.players?.[member.id];
  lines.push('', `━━━━━━━━ ③ 패시브 스킬 [자동 다운로드] — 모두의 기록을 모은 투두${auto?.generatedAt ? ` (${auto.generatedAt.slice(0, 16).replace('T', ' ')} UTC 계산)` : ''} ━━━━━━━━`, '');
  if (!mine) lines.push('아직 계산된 결과가 없습니다(타이머가 돌기 시작하면 10분마다 갱신).');
  else {
    if (mine.important.length) { lines.push('⚡ 더 중요한 일'); mine.important.forEach((x) => lines.push(`• ${x}`)); lines.push(''); }
    if (mine.todos.length) mine.todos.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    else lines.push('남은 투두가 없습니다.');
  }
  lines.push('', `작업을 기록하려면: node mimic-note/work.mjs ${member.id} <라벨링|압축|업로드> <대상> <시작|완료>  (그 뒤 git commit·push)`);
  const game = latestGame(games);
  lines.push('', '━━━━━━━━ ④ 마지막 [사고력 게임] ━━━━━━━━', '', formatGame(member, game));
  return lines.join('\n');
}

export function loadAuto(dir = NOTE_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'auto', 'todos.json'), 'utf8')); } catch { return null; }
}

export { chatIdFor };

// GitHub Actions 에 이 팀원 발송을 요청하고(같은 내용이면 Actions 가 건너뜀) 실제 결과를 돌려준다.
export async function telegramViaActions(member, { github = createGithub(), wait = true, sleep } = {}) {
  let login;
  try {
    login = github.whoami();
    if (!github.access().push) return `📨 텔레그램: 건너뜀 — GitHub 계정 ${login} 에 저장소 쓰기 권한이 없어 발송을 요청할 수 없습니다(초대 수락 필요).`;
    const after = github.latestRunId();
    github.dispatch(member.id, false);
    if (!wait) return '📨 텔레그램: GitHub Actions 에 발송을 요청했습니다(결과 미확인 — --no-wait).';
    return formatNotify(await waitForNotify(github, { afterRunId: after, actor: login, sleep }), loadMembers());
  } catch (e) {
    return `📨 텔레그램: 요청하지 못했습니다 — ${e.message}`;
  }
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const members = loadMembers();
  const member = findMember(args[0], members);
  if (!member) {
    console.error(`팀원을 찾지 못했습니다: "${args[0] || ''}". 가능한 이름: ${members.map((m) => `${m.name}(${m.id})`).join(', ')}`);
    return 1;
  }
  // 접속 기록(이 컴퓨터에만): 패시브 스킬 [1차 압축]이 누구의 초안에 쌓을지 안다. [로그아웃]하면 지워진다.
  try {
    fs.mkdirSync(HOME_DIR(), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR(), 'session.json'), JSON.stringify({ player: member.id, at: new Date().toISOString() }));
  } catch { /* 접속 기록을 못 남겨도 체크인은 계속 */ }

  const db = loadDb();
  console.log(checkinText(member, db));

  if (flags.has('--no-telegram')) return 0;
  console.log('');
  console.log(await telegramViaActions(member, { wait: !flags.has('--no-wait') }));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
