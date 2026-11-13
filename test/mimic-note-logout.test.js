// 미믹노트 패시브 스킬 [1차 압축] + 액티브 스킬 [로그아웃]: 증분 읽기·비밀 지우기·형식/분량 검사·업로드
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTE_DIR, loadMembers, findMember } from '../mimic-note/lib.mjs';
import { scrub, extract, compressOnce, loadDraft } from '../mimic-note/passive/compress.mjs';
import { validate, prepare, upload, nextUploadName, FORMAT } from '../mimic-note/logout.mjs';
import { loadWork } from '../mimic-note/work.mjs';

const members = loadMembers();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-logout-'));
const line = (o) => JSON.stringify(o) + '\n';
const user = (text, at) => line({ type: 'user', timestamp: at, message: { content: text } });
const said = (text, at) => line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } });
const commit = (msg, at) => line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', input: { command: `git commit -q -m "${msg}"` } }] } });

test('비밀 지우기: 이메일·토큰·KEY=값·IP·긴 번호·홈 경로', () => {
  const s = scrub('a@b.com 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ghp_abcdefghijklmnopqrstuvwx TELEGRAM_BOT_TOKEN=xyz 100.66.1.2 -1001234567890 /Users/kim/x');
  for (const bad of ['a@b.com', 'AAAAAAAA', 'ghp_', 'xyz', '100.66', '1001234567890', 'kim']) assert.ok(!s.includes(bad), bad);
});

test('대화 한 줄 → 요청·답·커밋·[ ] 라벨', () => {
  assert.deepEqual(extract(user('[로그아웃] 해줘', 't')).map((e) => e.kind), ['ask', 'label']);
  assert.equal(extract(commit('[업로드] 창민', 't'))[0].text, '[업로드] 창민');
  assert.deepEqual(extract(line({ type: 'user', isMeta: true, message: { content: 'x' } })), []);
  assert.deepEqual(extract('{깨진 줄'), []);
});

test('1차 압축: 접속 전엔 아무것도 안 함, 새 줄만 읽고 반쯤 쓴 줄은 다음 번에', () => {
  const home = tmp();
  const tr = path.join(tmp(), 'sess1.jsonl');
  fs.writeFileSync(tr, user('옛날 대화', '2026-01-01T00:00:00Z'));
  assert.equal(compressOnce({ home, transcript: tr }).added, 0);
  fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify({ player: 'changmin', at: '2026-11-13T00:00:00Z' }));
  fs.appendFileSync(tr, user('유리 온보딩', '2026-11-13T01:00:00Z') + commit('대전제 v0.3', '2026-11-13T01:01:00Z'));
  fs.appendFileSync(tr, '{"type":"user","timestamp":"2026-11-13T02:00:00Z","message":{"content":"반');
  assert.equal(compressOnce({ home, transcript: tr }).added, 2); // 옛날 대화(접속 전)는 빼고
  fs.appendFileSync(tr, '쯤"}}\n');
  assert.equal(compressOnce({ home, transcript: tr }).added, 1);
  assert.equal(compressOnce({ home, transcript: tr }).added, 0);
  assert.deepEqual(loadDraft('changmin', 'sess1', home).map((e) => e.text), ['유리 온보딩', '대전제 v0.3', '반쯤']);
});

const good = (labels = 2, decisions = 3, next = 1, pad = 300) => [
  '# [업로드] 2026-11-13 대화 9 — 창민 × Claude Code', '',
  FORMAT.sections[0], '', '| 라벨 | 묶은 것들 | 공통점 |', '| --- | --- | --- |',
  ...Array.from({ length: labels }, (_, i) => `| [라벨${i}] | a | b |`), '',
  FORMAT.sections[1], '', ...Array.from({ length: decisions }, (_, i) => `${i + 1}. 결정 ${'가'.repeat(pad / decisions)}`), '',
  FORMAT.sections[2], '', ...Array.from({ length: next }, () => '- 다음'), '',
].join('\n');

test('형식 검사: 상한·하한·칸·비밀', () => {
  assert.equal(validate(good()).ok, true);
  assert.match(validate(good(0)).errors.join(), /라벨 0개/);
  assert.match(validate(good(7)).errors.join(), /라벨 7개/);
  assert.match(validate(good(2, 2)).errors.join(), /결정 2개/);
  assert.match(validate(good(2, 11)).errors.join(), /결정 11개/);
  assert.match(validate(good(2, 3, 4)).errors.join(), /다음 할 일 4개/);
  assert.match(validate(good(2, 3, 1, 30)).errors.join(), /자 —/);
  assert.match(validate(good(2, 3, 1, 3000)).errors.join(), /자 —/);
  assert.match(validate(good().replace('## 3. 다음', '## 3. 끝')).errors.join(), /다음" 칸이 없습니다/);
  assert.match(validate(good() + '\n연락 a@b.com').errors.join(), /비밀/);
});

test('실제 저장소: 지금까지 올린 대화 4 가 규칙 v1 을 통과', () => {
  const f = path.join(NOTE_DIR, 'data', 'players', 'changmin', 'uploads', '2026-11-13-대화-4.md');
  assert.deepEqual(validate(fs.readFileSync(f, 'utf8')).errors, []);
});

test('[로그아웃]: 미리 채운 최종본 → 업로드(번호 자동·작업 기록 3단계·접속 종료)', () => {
  const home = tmp();
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.copyFileSync(path.join(NOTE_DIR, 'data', 'members.json'), path.join(dir, 'data', 'members.json'));
  fs.mkdirSync(path.join(dir, 'data', 'players', 'changmin', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'players', 'changmin', 'uploads', '2026-11-13-대화-4.md'), 'x');
  assert.equal(nextUploadName('changmin', '2026-11-13', dir), '2026-11-13-대화-5.md');
  const tr = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify({ player: 'changmin', at: '2026-11-13T00:00:00Z' }));
  fs.writeFileSync(tr, user('[로그아웃 [업로드]] 만들자', '2026-11-13T01:00:00Z') + commit('a', '2026-11-13T01:00:01Z') + commit('b', '2026-11-13T01:00:02Z') + commit('c', '2026-11-13T01:00:03Z'));
  const me = findMember('창민', members);
  const p = prepare(me, { home, transcript: tr, dir, date: '2026-11-13' });
  const sk = fs.readFileSync(p.finalFile, 'utf8');
  assert.match(sk, /\| \[로그아웃 \[업로드\]\] \|/);
  assert.match(sk, /1\. a\n2\. b\n3\. c/);
  fs.writeFileSync(p.finalFile, good());
  const r = upload(me, p.finalFile, { dir, home, push: false, date: '2026-11-13' });
  assert.equal(r.name, '2026-11-13-대화-5.md');
  assert.equal(loadWork('changmin', dir).items.filter((i) => i.target === '대화-2026-11-13-5').length, 3);
  assert.ok(!fs.existsSync(path.join(home, 'session.json')));
  fs.writeFileSync(p.finalFile, good(0));
  assert.throws(() => upload(me, p.finalFile, { dir, home, push: false }), /형식 검사 실패/);
});
