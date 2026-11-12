// docs/features.json 으로 GitHub 라벨·마일스톤·이슈를 만든다. 다시 실행해도 같은 제목의 이슈는 건너뛴다.
// 사용법: node scripts/github-setup.mjs <owner/repo>   (gh CLI 로그인 필요)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { estimate } from './eta.mjs';

const repo = process.argv[2];
if (!repo) {
  console.error('사용법: node scripts/github-setup.mjs <owner/repo>');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(new URL('../docs/features.json', import.meta.url), 'utf8'));
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
// GitHub 의 콘텐츠 생성 속도 제한(분당 약 80건)을 넘지 않도록 이슈 사이에 쉰다
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const labels = [
  ['P0', 'd73a4a', '출시 필수'],
  ['P1', 'fb8c00', '2차 개발'],
  ['P2', 'fbca04', '3차 개발'],
  ['feature', '0e8a16', '기능 구현'],
  ['decision', '5319e7', '사용자 결정 필요'],
  ['task', '1d76db', '기반·운영 작업'],
  ['needs-verification', 'c5def5', 'PikPak 세부 동작 미확인'],
  ...Object.entries(data.areas).map(([k, v]) => [`area:${k}`, 'bfd4f2', v]),
  ...Object.entries(data.modules).map(([k, v]) => [`module:${k}`, 'ededed', v]),
];
for (const [name, color, desc] of labels) {
  gh('label', 'create', name, '--repo', repo, '--color', color, '--description', desc.slice(0, 100), '--force');
}
console.log(`라벨 ${labels.length}개 준비`);

const existingMilestones = new Set(JSON.parse(gh('api', `repos/${repo}/milestones?state=all&per_page=100`)).map((m) => m.title));
for (const m of data.milestones) {
  if (!existingMilestones.has(m.title)) gh('api', `repos/${repo}/milestones`, '-f', `title=${m.title}`, '-f', `description=${m.description}`);
}
const milestoneTitle = Object.fromEntries(data.milestones.map((m) => [m.id, m.title]));
const milestoneFor = { P0: 'M1', P1: 'M2', P2: 'M3' };
console.log(`마일스톤 ${data.milestones.length}개 준비`);

// --sync: 이미 있는 기능 이슈의 본문도 최신 내용(예상 시간 포함)으로 고친다
const sync = process.argv.includes('--sync');
const existing = new Map(JSON.parse(gh('issue', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'title,number')).map((i) => [i.title, i.number]));
let created = 0;
let updated = 0;
function issue(title, body, labelList, milestone, { syncBody = false } = {}) {
  if (existing.has(title)) {
    if (sync && syncBody) {
      gh('issue', 'edit', String(existing.get(title)), '--repo', repo, '--body', body);
      updated++;
      pause(1200);
    }
    return;
  }
  gh('issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', labelList.join(','), '--milestone', milestone);
  created++;
  pause(1200);
}
const fmtMin = ({ lo, hi }) => (lo === hi ? `${lo}분` : `${lo}~${hi}분`);

for (const f of data.features) {
  const body = [
    `**영역** ${f.area} ${data.areas[f.area]} · **모듈** \`${f.module}\` · **우선순위** ${f.priority} · **근거** ${f.verification}`,
    '',
    `**⏱ 예상 수정 시간** ${fmtMin(estimate(f))} — AI 에이전트 실측 기준(\`docs/estimates.json\`), 다시 계산: \`node scripts/eta.mjs ${f.id}\``,
    '',
    '### 구현 기준',
    f.rule,
    '',
    '### 완료 조건',
    '- [ ] 구현 기준대로 동작',
    `- [ ] \`test/${f.module}.test.js\` 에 테스트 추가`,
    '- [ ] PikPak 로고·문구·이미지를 쓰지 않음(미믹 고유)',
    `- [ ] \`docs/features.json\` 의 ${f.id} status 를 done 으로 변경`,
    '',
    '자세한 명세: `docs/MIMIC_PLAN.md` 6장',
  ].join('\n');
  const l = ['feature', f.priority, `area:${f.area}`, `module:${f.module}`];
  if (f.verification === '미확인') l.push('needs-verification');
  issue(`[${f.id}] ${f.title}`, body, l, milestoneTitle[milestoneFor[f.priority]], { syncBody: true });
}
for (const d of data.decisions) {
  issue(`[결정 ${d.id}] ${d.title}`, `${d.detail}\n\n결정되면 이 이슈에 결과를 남기고 \`docs/MIMIC_PLAN.md\` 2장(확정)으로 옮긴다.`, ['decision'], milestoneTitle.M0);
}
for (const t of data.tasks) {
  issue(`[${t.id}] ${t.title}`, t.detail, ['task', `module:${t.module}`], milestoneTitle[t.milestone]);
}
console.log(`이슈 ${created}개 새로 생성${sync ? `, ${updated}개 본문 갱신` : ''}`);
