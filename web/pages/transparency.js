// 투명성 보고서(J-03): 월별 신고·저작권 요청·이의제기 접수 수와 조치 결과
import { api, h, t, formatDate } from '/ui.js';
import { setup } from '/pages/help.js';
import { REASONS } from '/pages/copyright.js';

const n = (v) => (v || 0).toLocaleString('ko-KR');

export async function render(root, ctx) {
  if (setup(ctx)) return;
  document.title = t('투명성 보고서 — 미믹', 'Transparency report — Mimic');
  const r = await api('/api/content/transparency');
  const T = r.totals;
  const stat = (v, label) => h('div', { class: 'mc-stat' }, h('b', {}, n(v)), h('span', {}, label));
  const th = (x, num) => h('th', { class: num ? 'num' : '' }, x);
  const td = (x, num) => h('td', { class: num ? 'num' : '' }, x);
  root.replaceChildren(
    h('div', { class: 'mc-page-title' }, h('span', { class: 'mc-eyebrow' }, 'Transparency'), h('h1', {}, t('투명성 보고서', 'Transparency report')), h('p', { class: 'mc-lead', style: { margin: '0 auto' } }, t('미믹이 받은 신고·저작권 요청과 그에 따른 조치를 숫자로 공개해요.', 'The reports and copyright requests we received, and what we did about them.'))),
    h(
      'div',
      { class: 'container' },
      h('h2', {}, r.since ? t(`전체 기간 합계 (${r.since}~)`, `All-time totals (since ${r.since})`) : t('전체 기간 합계', 'All-time totals')),
      h(
        'div',
        { class: 'mc-stats' },
        stat(T.received.report, t('콘텐츠 신고', 'Content reports')),
        stat(T.received.copyright, t('저작권 요청', 'Copyright requests')),
        stat(T.received.appeal, t('이의제기', 'Appeals')),
        stat(T.actions.block, t('차단 조치', 'Blocked')),
        stat(T.actions.suspend, t('계정 제한', 'Accounts restricted')),
        stat(T.actions.dismiss, t('조치 없음', 'No action')),
        stat(T.actions.unblock, t('이의 인용(차단 해제)', 'Appeals granted')),
        stat(T.pending, t('검토 중', 'Pending')),
      ),
      h('h2', {}, t('월별 통계 (최근 12개월)', 'By month (last 12 months)')),
      r.periods.length
        ? h(
            'div',
            { class: 'mc-table-wrap' },
            h(
              'table',
              { class: 'table' },
              h('thead', {}, h('tr', {}, th(t('기간', 'Period')), th(t('콘텐츠 신고', 'Reports'), 1), th(t('저작권 요청', 'Copyright'), 1), th(t('이의제기', 'Appeals'), 1), th(t('차단', 'Blocked'), 1), th(t('계정 제한', 'Restricted'), 1), th(t('조치 없음', 'No action'), 1), th(t('차단 해제', 'Unblocked'), 1), th(t('검토 중', 'Pending'), 1))),
              h(
                'tbody',
                {},
                ...r.periods.map((p) => h('tr', {}, td(p.period), td(n(p.received.report), 1), td(n(p.received.copyright), 1), td(n(p.received.appeal), 1), td(n(p.actions.block), 1), td(n(p.actions.suspend), 1), td(n(p.actions.dismiss), 1), td(n(p.actions.unblock), 1), td(n(p.pending), 1))),
              ),
            ),
          )
        : h('div', { class: 'empty' }, t('아직 공개할 통계가 없어요.', 'No data yet.')),
      h('h2', { style: { marginTop: '28px' } }, t('사유별 통계', 'By reason')),
      h(
        'div',
        { class: 'mc-table-wrap' },
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, th(t('사유', 'Reason')), th(t('접수', 'Received'), 1), th(t('차단·계정 제한', 'Actioned'), 1))),
          h('tbody', {}, ...REASONS.map(([k, ko, en]) => h('tr', {}, td(t(ko, en)), td(n(r.byReason?.[k]?.received), 1), td(n(r.byReason?.[k]?.actioned), 1)))),
        ),
      ),
      h('h2', { style: { marginTop: '28px' } }, t('차단 목록 현황', 'Blocklist')),
      h(
        'div',
        { class: 'mc-stats' },
        stat(r.blocklist.url, t('차단된 웹 주소', 'Blocked URLs')),
        stat(r.blocklist.infohash, t('차단된 토렌트(infohash)', 'Blocked torrents')),
        stat(r.blocklist.blob, t('차단된 파일 해시', 'Blocked file hashes')),
        stat(r.blocklist.domain, t('차단된 도메인', 'Blocked domains')),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, t('집계 기준', 'Methodology')),
        h(
          'ul',
          { class: 'doc' },
          h('li', {}, t('기간은 접수 시각(한국 시간) 기준 월이에요.', 'Periods are by month of receipt (KST).')),
          h('li', {}, t('조치는 신고 한 건당 하나로 셉니다. 저작권 요청 한 건에 여러 주소가 있어도 1건이에요.', 'One action per report; a copyright request with several URLs counts once.')),
          h('li', {}, t('검토 중은 아직 처리하지 않은 건수예요.', 'Pending means not yet resolved.')),
          h('li', {}, t('맨 위 합계는 첫 접수 월부터 지금까지 전체 기간이고, 월별 표는 최근 12개월(접수가 없는 달은 0)만 보여 줘요. 그래서 12개월이 지나면 월별 표의 합이 합계보다 작을 수 있어요.', 'The totals at the top cover all time since the first report; the monthly table shows only the last 12 months (months with no reports show 0), so after a year its sum can be smaller than the totals.')),
          h('li', {}, t('이의제기에는 신고 화면의 이의제기와 클라우드 다운로드 작업에서 낸 차단 이의제기가 모두 들어가요. 인용은 차단 해제, 기각은 조치 없음으로 셉니다.', 'Appeals include those filed on the report page and those filed on blocked cloud-download tasks. Granted appeals count as unblocked, rejected ones as no action.')),
          h('li', {}, t('사유별 통계는 콘텐츠 신고와 저작권 요청을 신고자가 고른 사유로 나눈 것이고, 이의제기는 빼요.', 'The by-reason table splits content reports and copyright requests by the reason chosen by the reporter; appeals are excluded.')),
        ),
        h('p', { class: 'muted small' }, t(`생성 시각 ${formatDate(r.generatedAt)}`, `Generated ${formatDate(r.generatedAt)}`), ' · ', h('a', { href: '/copyright' }, t('신고하기', 'Report'))),
      ),
    ),
  );
}
