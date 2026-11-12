// 작업 예상 시간 계산기(docs/estimates.json 실측값 기반). 작업을 시작하기 전에 실행해 결과를 먼저 보여 준다.
//   node scripts/eta.mjs A-01 B-02          기능 ID 로
//   node scripts/eta.mjs --module drive      모듈 전체
//   node scripts/eta.mjs --text "휴지통 보관 기간을 30일로"   요청 문장에서 기능을 찾아서
//   node scripts/eta.mjs --project           프로젝트 남은 작업
//   ISSUE_TITLE=... ISSUE_BODY=... node scripts/eta.mjs --from-env --markdown   GitHub 이슈 자동 댓글용
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const EST = read('../docs/estimates.json');
const FEATURES = read('../docs/features.json').features;
const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));
const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);
// 흔히 들어가 혼자서는 기능을 가리키지 못하는 낱말
const STOP = new Set(['저장', '설정', '기능', '관리', '화면', '파일', '링크', '기본', '정보', '상세', '생성', '구매', '추가', '전환', '처리', '버튼', '사람', '받는', '폴더', '사용', '표시', '가능', '불가', '전용', '모두', '여러', '선택', '변경']);
// 낱말 끝의 조사를 뗀다(예: 화면에 → 화면). ponytail: 단순 접미사 제거, 형태소 분석이 필요해지면 교체
const stem = (w) => (w.length > 2 ? w.replace(/(에서|으로|에게|하면|되면|이나|이고|에|을|를|은|는|이|가|로|와|과|의|도|만)$/, '') : w);

// 기능 하나에 드는 시간(분). 실제 기록(history)이 3건 이상 쌓이면 그 평균을 쓴다
export function perFeature(module, est = EST) {
  const done = est.history.filter((h) => h.module === module && h.minutes > 0 && h.features > 0);
  if (done.length >= 3) return done.reduce((s, h) => s + h.minutes / h.features, 0) / done.length;
  const m = est.modules[module];
  if (!m) return 15;
  return (m.build + m.verify + m.fix) / m.features;
}

// 기존 기능을 고치는 데 드는 시간 범위: 맥락 파악·테스트 기본 시간 + 기능 몫의 1~2배
export function estimate(feature, est = EST) {
  const per = perFeature(feature.module, est);
  return { lo: round5(est.overheadMin + per), hi: round5(est.overheadMin + per * 2) };
}

const words = (s) => [...new Set(s.toLowerCase().split(/[\s·()/,.~"'+\-:;|]+/).map(stem).filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d/.test(w)))];
const ALIASES = Object.entries(EST.aliases || {}).filter(([k]) => !k.startsWith('_'));
const VOCAB = FEATURES.map((f) => ({ f, title: words(f.title), rule: words(f.rule) }));
const DF = new Map();
for (const v of VOCAB) for (const w of new Set([...v.title, ...v.rule])) DF.set(w, (DF.get(w) || 0) + 1);

// 기능 ID 가 있으면 그대로, 없으면 요청 문장에 들어 있는 기능 낱말로 점수를 매겨 고른다.
// 드문 낱말일수록, 규칙보다 제목에 있을수록 점수가 높다. ponytail: 단순 낱말 일치, 형태소 분석이 필요해지면 교체
export function findFeatures(text = '') {
  const ids = [...new Set((text.toUpperCase().match(/\b[A-K]-\d{2}\b/g) || []).filter((id) => BY_ID.has(id)))];
  if (ids.length) return ids.map((id) => BY_ID.get(id));
  const t = text.toLowerCase();
  const hinted = new Set(ALIASES.filter(([k]) => t.includes(k)).flatMap(([, ids]) => ids));
  const scored = VOCAB.map(({ f, title, rule }) => {
    let score = (t.includes(f.title.toLowerCase()) ? 3 : 0) + (hinted.has(f.id) ? 3 : 0);
    for (const w of title) if (t.includes(w)) score += 2 / DF.get(w);
    for (const w of rule) if (!title.includes(w) && t.includes(w)) score += 1 / DF.get(w);
    return { f, score };
  }).filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  // 확신이 낮은 일치(규칙 문장의 흔한 낱말 하나뿐)는 버리고 일반 수정 기준으로 안내한다
  return scored
    .filter((x) => x.score >= Math.max(1, best * 0.3))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.f);
}

export function report({ features = [], module = null, text = '' } = {}) {
  let list = features;
  let guessed = false;
  if (module) list = FEATURES.filter((f) => f.module === module);
  if (!list.length && text) {
    list = findFeatures(text);
    guessed = !/\b[A-K]-\d{2}\b/i.test(text);
  }
  const rows = list.map((f) => ({ id: f.id, title: f.title, module: f.module, ...estimate(f) }));
  if (!rows.length) {
    const small = text.length > 0 && text.length <= 40 && /(문구|색|글자|오타|버튼|아이콘|여백)/.test(text);
    const g = small ? EST.generic.small : EST.generic.unknown;
    return { rows, total: { lo: g.lo, hi: g.hi }, note: `${g.label}: 기능 ID(예: B-02)를 알려 주면 더 정확합니다` };
  }
  // 같은 모듈 안의 여러 기능은 맥락 파악을 한 번만 하므로 기본 시간을 한 번만 더한다
  const modules = new Set(rows.map((r) => r.module));
  const lo = rows.reduce((s, r) => s + r.lo, 0) - EST.overheadMin * (rows.length - modules.size);
  const hi = rows.reduce((s, r) => s + r.hi, 0) - EST.overheadMin * (rows.length - modules.size);
  return { rows, total: { lo: round5(lo), hi: round5(hi) }, note: guessed ? '요청 문장에서 추정한 기능입니다. 다르면 기능 ID(예: B-02)로 다시 계산하세요' : null };
}

const fmt = (lo, hi) => {
  const f = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}` : `${m}분`);
  return lo === hi ? f(lo) : `${f(lo)}~${f(hi)}`;
};

export function render(r, { markdown = false } = {}) {
  const head = `예상 소요 시간: ${fmt(r.total.lo, r.total.hi)} (${EST.basis}, ${EST.measuredAt} 측정)`;
  const lines = r.rows.map((x) => (markdown ? `| ${x.id} | ${x.title} | \`${x.module}\` | ${fmt(x.lo, x.hi)} |` : `  ${x.id}  ${x.title.padEnd(16)} ${x.module.padEnd(14)} ${fmt(x.lo, x.hi)}`));
  if (!markdown) return [head, ...lines, r.note ? `  ※ ${r.note}` : null].filter(Boolean).join('\n');
  return [
    `### ⏱ ${head}`,
    '',
    ...(r.rows.length ? ['| 기능 | 이름 | 모듈 | 예상 |', '| --- | --- | --- | --- |', ...lines, ''] : []),
    r.note ? `> ${r.note}` : null,
    '<sub>docs/estimates.json 의 실측값으로 자동 계산했습니다. 사람이 직접 개발하는 시간은 측정하지 않았습니다.</sub>',
  ]
    .filter((x) => x !== null)
    .join('\n');
}

export function projectReport() {
  const left = EST.project.steps.filter((s) => !s.done);
  const lo = left.reduce((s, x) => s + x.lo, 0);
  const hi = left.reduce((s, x) => s + x.hi, 0);
  return [`프로젝트 남은 작업 예상: ${fmt(lo, hi)} (${EST.project.updated} 기준)`, ...EST.project.steps.map((s) => `  ${s.done ? '[완료]' : '[남음]'} ${s.name}  ${fmt(s.lo, s.hi)}`)].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes('--project')) {
    console.log(projectReport());
  } else {
    const fromEnv = args.includes('--from-env');
    const text = fromEnv ? `${process.env.ISSUE_TITLE || ''}\n${process.env.ISSUE_BODY || ''}` : opt('--text') || '';
    const ids = args.filter((a) => /^[A-K]-\d{2}$/i.test(a)).map((a) => BY_ID.get(a.toUpperCase())).filter(Boolean);
    console.log(render(report({ features: ids, module: opt('--module'), text }), { markdown: args.includes('--markdown') }));
  }
}
