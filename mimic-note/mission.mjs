#!/usr/bin/env node
// 미믹노트 미션 관리 (data/missions.json)
//
//   node mimic-note/mission.mjs list [이름]                          남은 미션 보기(이름 없으면 전체)
//   node mimic-note/mission.mjs add <이름> "제목" ["설명"] --by 창민   미션 추가(관리자만)
//   node mimic-note/mission.mjs add <이름> "제목" ["설명"] --by 창민 --top   최우선(그 사람의 1번)으로 추가
//   node mimic-note/mission.mjs done <이름> <번호|M-0001>            미션 완료
//
// 바꾼 내용은 git commit·push 해야 다른 팀원·Claude Code 에게 보인다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMembers, requireMember, loadDb, saveDb, openMissions, doneMissions, addMission, completeMission, formatMissions } from './lib.mjs';

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export function run(argv, dir) {
  const args = [...argv];
  const by = takeFlag(args, '--by');
  const top = args.includes('--top');
  if (top) args.splice(args.indexOf('--top'), 1);
  const [cmd, ...rest] = args;
  const members = loadMembers(dir);
  const db = loadDb(dir);
  const out = [];

  if (cmd === 'list' || !cmd) {
    const targets = rest[0] ? [requireMember(rest[0], members)] : members;
    for (const m of targets) {
      const open = openMissions(db, m.id);
      const done = doneMissions(db, m.id).length;
      if (!rest[0] && !open.length && !done) continue;
      out.push(`■ ${m.name}(${m.id}) — 남은 ${open.length} · 완료 ${done}`);
      open.forEach((x, i) => out.push(`  ${i + 1}. [${x.id}] ${x.title}`));
    }
    if (!out.length) out.push('등록된 미션이 없습니다.');
    return out.join('\n');
  }

  if (cmd === 'add') {
    const [who, title, detail] = rest;
    if (!by) throw new Error('누가 만드는지 --by <관리자 이름> 을 붙여 주세요. 예: --by 창민');
    const m = addMission(db, { assignee: who, title, detail, by, top }, members);
    saveDb(db, dir);
    const member = requireMember(who, members);
    const no = openMissions(db, member.id).findIndex((x) => x.id === m.id) + 1;
    return `추가했습니다: ${member.name}님의 미션 ${no}번 [${m.id}] ${m.title}\n→ git commit·push 해야 팀원에게 보입니다.`;
  }

  if (cmd === 'done') {
    const [who, ref] = rest;
    const member = requireMember(who, members);
    const m = completeMission(db, member.id, ref);
    saveDb(db, dir);
    const left = openMissions(db, member.id);
    return [
      `완료했습니다: [${m.id}] ${m.title}`,
      left.length ? `\n남은 미션:\n${formatMissions(member, left)}` : `\n${member.name}님, 모든 미션을 끝냈습니다!`,
      '\n→ git commit·push 해야 중앙(미믹노트)에 반영됩니다.',
    ].join('\n');
  }

  throw new Error(`모르는 명령: ${cmd}. list | add | done 중 하나를 쓰세요.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
