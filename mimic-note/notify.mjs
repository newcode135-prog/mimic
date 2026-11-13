#!/usr/bin/env node
// 미믹노트 알림 — GitHub Actions(.github/workflows/mimic-checkin.yml)에서 실행한다.
//
// 1) 장부(lastSha)부터 지금 main 까지를 push 단위로 나눈다. push 마다 그 push 를 한 GitHub 계정의 권한을
//    "push 전" 명부(members.json)로 확인한다: 미션 만들기·수정·후순위 = 관리자, 본인 미션 완료 = 본인,
//    삭제·명부 변경 = 대표관리자(저장소 주인 계정은 모두 가능). 권한 없는 변경은 알리지 않고 실행을 실패로 표시하며
//    대표관리자에게 경고를 보낸다.
// 2) 권한이 확인된 변경에서 텔레그램 메시지가 실제로 달라진 팀원만 고른다(안 바뀐 사람에게는 안 보냄).
// 3) 그 팀원의 "지금 main" 기준 남은 미션을 그 사람 chat id 로만 보낸다. sendMessage 응답(ok·message_id·chat.id)까지 확인.
// 4) 장부(.mimic-note-ledger/ledger.json, Actions 캐시)에 사람별 마지막 발송 메시지 해시를 남겨 같은 내용은 다시 안 보낸다.
//    미연결·토큰 없음·실패는 '보류'로 남겨 다음 실행(10분 정기 검사 포함)에서 다시 시도한다.
// 로그에는 토큰·chat id 를 쓰지 않는다. 팀원별 결과는 `MIMIC_RESULT {...}` 한 줄씩(Claude Code 가 읽음).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADMIN_ROLES, findMember, memberByGithub, openMissions, doneMissions, validateDb, validateMembers, chatIdFor, telegramApi } from './lib.mjs';

export const DATA = { db: 'mimic-note/data/missions.json', members: 'mimic-note/data/members.json' };
const WORKFLOW = 'mimic-checkin.yml';
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (i) => KEYCAPS[i] || `${i + 1}.`;

// 팀원 한 명의 텔레그램 메시지(HTML). 상위 3개는 크게, 설명과 4번부터는 눌러서 펼치기.
// 제목·순서·진행률은 모두 DB 에서 계산한다.
export function renderTelegram(member, db) {
  const open = openMissions(db, member.id);
  const done = doneMissions(db, member.id).length;
  const lines = ['🎯 <b>MIMIC NOTE</b>', '', `👤 <b>${esc(member.name)}님의 미션</b>`, ''];
  if (!open.length) lines.push('🎉 남은 미션이 없어요!', '');
  open.slice(0, 3).forEach((m, i) => {
    lines.push(`${num(i)} ${esc(clip(m.title, 200))}${m.priority === 'low' ? ' <i>(후순위)</i>' : ''}`);
    if (m.detail) lines.push(`<blockquote expandable>${esc(clip(m.detail, 600))}</blockquote>`);
    lines.push('');
  });
  const rest = open.slice(3);
  if (rest.length) {
    const shown = rest.slice(0, 30).map((m, i) => `${num(i + 3)} ${esc(clip(m.title, 120))}${m.priority === 'low' ? ' (후순위)' : ''}`);
    if (rest.length > 30) shown.push(`… 외 ${rest.length - 30}개`);
    lines.push(`➕ 추가 미션 ${rest.length}개 (눌러서 전체 보기)`, `<blockquote expandable>${shown.join('\n')}</blockquote>`, '');
  }
  lines.push('━━━━━━━━━━', '', `📊 진행률 ${done}/${open.length + done}`, `📌 남은 미션 ${open.length}개`);
  return lines.join('\n');
}

export const hashText = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

export function changedMembers(baseDb, headDb, members) {
  return members.filter((m) => renderTelegram(m, baseDb) !== renderTelegram(m, headDb)).map((m) => m.id);
}

// push 한 계정(actor)이 base → head 변경을 할 권한이 있었는지. 위반 문구 목록을 돌려준다(빈 배열이면 통과).
export function verifyChange({ base, head, actor, repoAdmin = false }) {
  if (repoAdmin) return [];
  const who = memberByGithub(actor, base.members);
  const label = who ? `${who.name}(${actor})` : `${actor}(명부에 없는 GitHub 아이디)`;
  const isOwner = who?.role === 'owner';
  const isAdmin = ADMIN_ROLES.has(who?.role);
  const v = [];
  if (JSON.stringify(base.members) !== JSON.stringify(head.members) && !isOwner) v.push(`${label}: 팀원 명부(members.json)는 대표관리자만 바꿀 수 있습니다`);
  if (head.db.nextId < base.db.nextId && !isOwner) v.push(`${label}: nextId 를 줄일 수 없습니다`);
  const before = new Map(base.db.missions.map((m) => [m.id, m]));
  const seen = new Set();
  for (const m of head.db.missions) {
    seen.add(m.id);
    const b = before.get(m.id);
    if (!b) {
      if (!isAdmin) v.push(`${label}: ${m.id} 추가(관리자만)`);
      continue;
    }
    if (isAdmin || JSON.stringify(b) === JSON.stringify(m)) continue;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(m)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(m[k]));
    const selfDone = who && b.assignee === who.id && m.assignee === who.id && b.status === 'todo' && m.status === 'done'
      && (m.doneBy == null || m.doneBy === who.id) && keys.every((k) => ['status', 'doneAt', 'doneBy'].includes(k));
    if (!selfDone) v.push(`${label}: ${m.id} 수정(${keys.join(', ')}) — 팀원은 본인 미션 완료만 가능`);
  }
  for (const id of before.keys()) if (!seen.has(id) && !isOwner) v.push(`${label}: ${id} 삭제(대표관리자만)`);
  return v;
}

// 한 커밋 시점의 데이터. 파일이 없으면 빈 DB, JSON 이 깨졌으면 error.
export function snapshot(git, sha) {
  try {
    return { db: git.json(sha, DATA.db) ?? { nextId: 1, missions: [] }, members: git.json(sha, DATA.members)?.members ?? [] };
  } catch (e) {
    return { db: { nextId: 1, missions: [] }, members: [], error: `JSON 깨짐: ${e.message}` };
  }
}
const schemaErrors = (s) => (s.error ? [s.error] : [...validateMembers(s.members), ...validateDb(s.db, s.members)]);

export function loadLedger(file) {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { lastSha: l.lastSha || null, members: l.members || {}, alerts: l.alerts || [] };
  } catch {
    return { lastSha: null, members: {}, alerts: [] };
  }
}

// deps: git(아래 makeGit 과 같은 모양), gh{pushRuns, isRepoAdmin}, send(token, chatId, text) → sendMessage 결과
export async function runNotify({ env, git, gh, send, ledger, now = () => new Date().toISOString() }) {
  const results = [];
  const problems = [];
  const head = git.head();
  const event = env.EVENT_NAME || 'workflow_dispatch';
  const usable = (s) => /^[0-9a-f]{40}$/.test(s || '') && !/^0+$/.test(s) && git.exists(s) && git.isAncestor(s, head);
  const start = usable(ledger.lastSha) ? ledger.lastSha : event === 'push' && usable(env.BEFORE_SHA) ? env.BEFORE_SHA : head;
  const candidates = new Set();
  const changed = (a, b) => git.blob(a, DATA.db) !== git.blob(b, DATA.db) || git.blob(a, DATA.members) !== git.blob(b, DATA.members);
  const owner = (env.GITHUB_REPOSITORY_OWNER || '').toLowerCase();

  // 1) 처리 안 한 구간을 push 단위로 확인
  let processed = start;
  if (start !== head) {
    const pushes = new Map((await gh.pushRuns()).map((r) => [r.head_sha, r.actor]));
    if (event === 'push' && env.AFTER_SHA) pushes.set(env.AFTER_SHA, env.ACTOR);
    let from = start;
    for (const c of git.firstParent(start, head)) {
      if (!pushes.has(c)) continue;
      const actor = pushes.get(c);
      if (changed(from, c)) {
        const base = snapshot(git, from);
        const next = snapshot(git, c);
        const bad = schemaErrors(next);
        if (bad.length) problems.push({ kind: 'schema', sha: c, actor, detail: bad.slice(0, 10) });
        else {
          const repoAdmin = (owner && String(actor).toLowerCase() === owner) || await gh.isRepoAdmin(actor);
          const v = verifyChange({ base, head: next, actor, repoAdmin });
          if (v.length) problems.push({ kind: 'unauthorized', sha: c, actor, detail: v });
          else changedMembers(base.db, next.db, next.members).forEach((id) => candidates.add(id));
        }
      }
      from = c;
    }
    // 마지막 push 뒤에 남은 커밋에 데이터 변경이 있으면, 그 push 의 실행이 아직 안 보이는 것 → 다음 실행에 맡긴다.
    processed = from === head || !changed(from, head) ? head : from;
  }

  // 2) 보류된 알림 + 수동 요청
  for (const [id, s] of Object.entries(ledger.members)) if (s.pending) candidates.add(id);
  const cur = snapshot(git, head);
  let forced = null;
  if (env.INPUT_MEMBER) {
    const m = findMember(env.INPUT_MEMBER, cur.members);
    if (!m) problems.push({ kind: 'unknown-member', detail: [`팀원을 찾지 못했습니다: ${env.INPUT_MEMBER}`] });
    else {
      candidates.add(m.id);
      if (env.INPUT_FORCE === 'true') forced = m.id;
    }
  }

  // 3) 발송
  const token = env.TELEGRAM_BOT_TOKEN;
  const curBad = schemaErrors(cur);
  if (curBad.length) problems.push({ kind: 'schema', sha: head, detail: curBad.slice(0, 10) });
  else {
    for (const id of candidates) {
      const member = cur.members.find((m) => m.id === id);
      if (!member) { delete ledger.members[id]; continue; }
      const st = (ledger.members[id] ||= {});
      const text = renderTelegram(member, cur.db);
      const hash = hashText(text);
      if (st.sentHash === hash && forced !== id) {
        st.pending = false;
        results.push({ member: id, status: 'already-sent' });
        continue;
      }
      const chatId = chatIdFor(id, env);
      if (!token || !chatId) {
        st.pending = true;
        results.push({ member: id, status: token ? 'unconnected' : 'unconfigured' });
        continue;
      }
      try {
        const r = await send(token, chatId, text);
        if (!r?.message_id || String(r.chat?.id) !== String(chatId)) throw new Error('sendMessage 응답이 올바르지 않음(message_id/chat 불일치)');
        Object.assign(st, { sentHash: hash, sentAt: now(), messageId: r.message_id, pending: false, lastError: null });
        results.push({ member: id, status: 'sent', messageId: r.message_id });
      } catch (e) {
        Object.assign(st, { pending: true, lastError: String(e.message).slice(0, 200) });
        results.push({ member: id, status: 'failed', error: String(e.message).slice(0, 200), code: e.code ?? null });
      }
    }
  }

  // 4) 권한 없는 변경 → 대표관리자에게 경고(같은 커밋은 한 번만)
  const ownerMember = cur.members.find((m) => m.role === 'owner');
  for (const p of problems.filter((x) => x.kind === 'unauthorized' && !ledger.alerts.includes(x.sha))) {
    const chatId = ownerMember && chatIdFor(ownerMember.id, env);
    if (!token || !chatId) continue;
    const text = ['⚠️ <b>MIMIC NOTE 경고</b>', '', '권한 없는 미션 변경을 감지해 팀원 알림을 보내지 않았어요.', ...p.detail.slice(0, 8).map((d) => `• ${esc(d)}`), '', `커밋 ${p.sha.slice(0, 7)}`].join('\n');
    try {
      await send(token, chatId, text);
      ledger.alerts = [...ledger.alerts, p.sha].slice(-50);
      results.push({ member: ownerMember.id, status: 'alert' });
    } catch (e) {
      results.push({ member: ownerMember.id, status: 'failed', error: `경고 발송 실패: ${String(e.message).slice(0, 150)}` });
    }
  }

  ledger.lastSha = processed;
  return { results, problems, ledger, head, processed };
}

function makeGit(cwd) {
  const g = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
  const ok = (...a) => { try { g(...a); return true; } catch { return false; } };
  return {
    fetch: () => g('fetch', '-q', 'origin', 'main'),
    head: () => g('rev-parse', 'origin/main'),
    exists: (s) => ok('cat-file', '-e', `${s}^{commit}`),
    isAncestor: (a, b) => ok('merge-base', '--is-ancestor', a, b),
    firstParent: (a, b) => g('rev-list', '--first-parent', '--reverse', `${a}..${b}`).split('\n').filter(Boolean),
    blob: (s, f) => { try { return g('rev-parse', `${s}:${f}`); } catch { return null; } },
    json(s, f) {
      if (!this.blob(s, f)) return undefined;
      return JSON.parse(g('show', `${s}:${f}`));
    },
  };
}

function makeGh(env) {
  const base = `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const get = async (p) => {
    const r = await fetch(base + p, { headers });
    if (!r.ok) throw new Error(`GitHub API ${p.split('?')[0]} → ${r.status}`);
    return r.json();
  };
  return {
    async pushRuns() {
      const j = await get(`/actions/workflows/${WORKFLOW}/runs?event=push&branch=main&per_page=100`);
      return j.workflow_runs.map((r) => ({ head_sha: r.head_sha, actor: r.actor?.login }));
    },
    async isRepoAdmin(login) {
      try { return (await get(`/collaborators/${encodeURIComponent(login)}/permission`)).permission === 'admin'; } catch { return false; }
    },
  };
}

const LABEL = { sent: '발송 성공', 'already-sent': '같은 내용 이미 보냄', unconnected: '미연결', unconfigured: '봇 토큰 미설정', failed: '실패', alert: '대표관리자 경고' };

async function main() {
  const env = process.env;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ledgerFile = path.join(root, '.mimic-note-ledger', 'ledger.json');
  const git = makeGit(root);
  git.fetch();
  const ledger = loadLedger(ledgerFile);
  const before = JSON.stringify(ledger);
  const r = await runNotify({ env, git, gh: makeGh(env), send: (token, chatId, text) => telegramApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }), ledger });

  console.log(`미믹노트 알림: 이벤트 ${env.EVENT_NAME} · main ${r.head.slice(0, 7)} · 처리 완료 ${String(r.processed).slice(0, 7)}`);
  for (const x of r.results) console.log(`MIMIC_RESULT ${JSON.stringify(x)}`);
  if (!r.results.length) console.log('보낼 대상 없음(바뀐 팀원·보류된 알림 없음)');
  for (const p of r.problems) console.log(`::error title=미믹노트 ${p.kind}::${[p.sha && `커밋 ${p.sha.slice(0, 7)}`, p.actor, ...(p.detail || [])].filter(Boolean).join(' / ')}`);
  for (const x of r.results.filter((y) => y.status === 'unconfigured' || y.status === 'unconnected')) console.log(`::warning title=미믹노트::${x.member}: ${LABEL[x.status]} — 보류해 두었다가 연결되면 보냅니다`);

  if (env.GITHUB_STEP_SUMMARY) {
    const rows = r.results.map((x) => `| ${x.member} | ${LABEL[x.status] || x.status} | ${x.error ? String(x.error).replace(/\|/g, '/') : ''} |`);
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, ['### 미믹노트 알림', '', '| 팀원 | 결과 | 비고 |', '| --- | --- | --- |', ...(rows.length ? rows : ['| - | 보낼 대상 없음 | |']), '',
      ...r.problems.map((p) => `- ❌ ${p.kind}: ${(p.detail || []).join(' / ')}`), ''].join('\n'));
  }
  const changedLedger = JSON.stringify(r.ledger) !== before;
  if (changedLedger) {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, `${JSON.stringify(r.ledger, null, 2)}\n`);
  }
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `ledger_changed=${changedLedger}\n`);
  const failed = r.problems.length > 0 || r.results.some((x) => x.status === 'failed');
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log(`::error title=미믹노트 알림 오류::${e.message}`);
    process.exitCode = 1;
  });
}
