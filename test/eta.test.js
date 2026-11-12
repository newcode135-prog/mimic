import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, findFeatures, report, render, perFeature } from '../scripts/eta.mjs';

test('예상 시간 계산기', () => {
  const r = estimate({ module: 'drive' });
  assert.ok(r.lo >= 10 && r.hi >= r.lo, '기본 시간 포함, 범위 순서');
  assert.deepEqual(findFeatures('휴지통 보관 기간을 30일로 바꿔줘').map((f) => f.id), ['B-02']);
  assert.deepEqual(findFeatures('[A-01] 마그넷 링크 저장').map((f) => f.id), ['A-01']);
  const many = report({ text: 'B-02 와 B-11 수정' });
  assert.equal(many.rows.length, 2);
  assert.ok(many.total.lo < many.rows[0].lo + many.rows[1].lo, '같은 모듈은 기본 시간을 한 번만');
  const none = report({ text: '전체적으로 좀 더 예쁘게' });
  assert.equal(none.rows.length, 0);
  assert.ok(none.note);
  assert.match(render(report({ text: 'C-04' }), { markdown: true }), /예상 소요 시간/);
  // 기록이 3건 이상이면 실제 평균을 쓴다
  const est = { modules: { x: { build: 90, verify: 0, fix: 0, features: 1 } }, history: [1, 2, 3].map(() => ({ module: 'x', minutes: 20, features: 2 })), overheadMin: 10 };
  assert.equal(perFeature('x', est), 10);
});
