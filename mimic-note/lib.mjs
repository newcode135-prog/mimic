// 미믹노트 공통: 팀원 명부와 미션 데이터베이스(data/missions.json).
// Node 18 이상, 외부 패키지 없음. 데이터는 git 으로 공유되므로 바꾼 뒤 commit·push 해야 다른 사람에게 보인다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_ROLES = new Set(['owner', 'admin']);

export function loadMembers(dir = NOTE_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'members.json'), 'utf8')).members;
}

// '민호', 'minho', 'Minho', '민호님', '[민호' 모두 같은 사람으로 찾는다.
export function findMember(input, members) {
  const key = String(input || '').trim().replace(/^\[+|\]+$/g, '').trim().replace(/님$/, '').toLowerCase();
  if (!key) return null;
  return members.find((m) => m.id === key || m.name === key || (m.github && m.github.toLowerCase() === key)) || null;
}

export function requireMember(input, members) {
  const m = findMember(input, members);
  if (!m) throw new Error(`팀원을 찾지 못했습니다: "${input || ''}". 가능한 이름: ${members.map((x) => `${x.name}(${x.id})`).join(', ')}`);
  return m;
}

// ---- 환경변수(.env)와 텔레그램 ----

// 저장소 루트의 .env(git 에 안 올라감) + 실제 환경변수. 환경변수가 우선.
export function readEnv(rootDir = path.resolve(NOTE_DIR, '..'), env = process.env) {
  const out = {};
  const file = path.join(rootDir, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...out, ...env };
}

export function chatIdFor(memberId, env) {
  const direct = env[`TELEGRAM_CHAT_ID_${memberId.toUpperCase()}`];
  if (direct) return direct;
  if (env.TELEGRAM_CHAT_IDS) {
    try { return JSON.parse(env.TELEGRAM_CHAT_IDS)[memberId] || null; } catch { return null; }
  }
  return null;
}

export async function telegramApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`텔레그램 ${method} 실패: ${json.description || res.status}`);
  return json.result;
}

// ---- 대전제: 모든 체크인에서 가장 먼저 보여 주는 규칙 ----

export function loadPremise(dir = NOTE_DIR) {
  return fs.readFileSync(path.join(dir, 'premise.md'), 'utf8').trim();
}

// ---- 미션 데이터베이스 ----

export function dbPath(dir = NOTE_DIR) {
  return path.join(dir, 'data', 'missions.json');
}

export function loadDb(dir = NOTE_DIR) {
  const file = dbPath(dir);
  if (!fs.existsSync(file)) return { nextId: 1, missions: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 임시 파일에 쓴 뒤 바꿔치기해서, 쓰다가 끊겨도 파일이 깨지지 않게 한다.
export function saveDb(db, dir = NOTE_DIR) {
  const file = dbPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// 후순위(priority: 'low')는 맨 뒤로. 그다음 order 순.
const byOrder = (a, b) => (a.priority === 'low') - (b.priority === 'low') || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);

// 그 팀원의 아직 끝나지 않은 미션(번호 순). 화면의 1번·2번·3번이 이 순서다.
export function openMissions(db, memberId) {
  return db.missions.filter((m) => m.assignee === memberId && m.status !== 'done').sort(byOrder);
}

export function doneMissions(db, memberId) {
  return db.missions.filter((m) => m.assignee === memberId && m.status === 'done').sort(byOrder);
}

// 미션은 관리자(owner·admin)만 만든다.
export function addMission(db, { assignee, title, detail = '', by, top = false }, members, now = new Date().toISOString()) {
  const target = requireMember(assignee, members);
  const author = requireMember(by, members);
  if (!ADMIN_ROLES.has(author.role)) throw new Error(`${author.name}님은 관리자가 아니라 미션을 만들 수 없습니다.`);
  if (!String(title || '').trim()) throw new Error('미션 제목이 비어 있습니다.');
  const mine = db.missions.filter((m) => m.assignee === target.id);
  const mission = {
    id: `M-${String(db.nextId).padStart(4, '0')}`,
    assignee: target.id,
    // top: 최우선 — 그 사람의 1번으로 들어간다
    order: top ? mine.reduce((min, m) => Math.min(min, m.order ?? 0), 1) - 1 : mine.reduce((max, m) => Math.max(max, m.order ?? 0), 0) + 1,
    title: String(title).trim(),
    detail: String(detail || '').trim(),
    status: 'todo',
    createdBy: author.id,
    createdAt: now,
    doneAt: null,
  };
  db.nextId += 1;
  db.missions.push(mission);
  return mission;
}

// ref: 화면 번호(1, 2, 3 …) 또는 미션 ID(M-0001). 본인 미션만 완료할 수 있다.
export function completeMission(db, memberId, ref, now = new Date().toISOString()) {
  const open = openMissions(db, memberId);
  const key = String(ref || '').trim().toUpperCase();
  const mission = /^\d+$/.test(key) ? open[Number(key) - 1] : open.find((m) => m.id === key);
  if (!mission) throw new Error(`완료할 미션을 찾지 못했습니다: "${ref}". 남은 미션 번호: ${open.map((m, i) => `${i + 1}(${m.id})`).join(', ') || '없음'}`);
  mission.status = 'done';
  mission.doneAt = now;
  return mission;
}

// 후순위로 내리기(관리자만). 후순위 미션은 그 사람 목록 맨 뒤로 가고, 다른 관리자 체크인에도 뜬다.
export function setLowPriority(db, memberId, ref, by, members) {
  const author = requireMember(by, members);
  if (!ADMIN_ROLES.has(author.role)) throw new Error(`${author.name}님은 관리자가 아니라 우선순위를 바꿀 수 없습니다.`);
  const open = openMissions(db, memberId);
  const key = String(ref || '').trim().toUpperCase();
  const mission = /^\d+$/.test(key) ? open[Number(key) - 1] : open.find((m) => m.id === key);
  if (!mission) throw new Error(`미션을 찾지 못했습니다: "${ref}"`);
  mission.priority = 'low';
  return mission;
}

// 관리자에게 보여 줄 '다른 관리자의 후순위 미션'.
export function othersLowMissions(db, member, members) {
  if (!ADMIN_ROLES.has(member.role)) return [];
  const admins = new Set(members.filter((m) => ADMIN_ROLES.has(m.role) && m.id !== member.id).map((m) => m.id));
  return db.missions.filter((m) => m.priority === 'low' && m.status !== 'done' && admins.has(m.assignee));
}

// Claude Code 가 그대로 전달하는 문구.
export function formatMissions(member, missions) {
  if (!missions.length) return `${member.name}님, 지금 남은 미션이 없습니다.`;
  return missions
    .map((m, i) => {
      const head = `${member.name}님의 미션 ${i + 1}번은 ${m.title}${m.priority === 'low' ? ' (후순위)' : ''}`;
      return m.detail ? `${head}\n${m.detail.split('\n').map((l) => `   ${l}`).join('\n')}` : head;
    })
    .join('\n\n');
}
