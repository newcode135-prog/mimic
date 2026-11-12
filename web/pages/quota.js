// 전송 쿼터 상세(/drive/quota). F-01 월 기본 쿼터, F-02 무료 일일 한도, F-03 추가 쿼터, F-04 상세, F-05 연결 앱 상한
import { api, h, t, toastError, formatBytes, formatDate, loadCss, icon } from '/ui.js';
import { buyProduct, productLabel } from '/pages/payment.js';

const KINDS = [
  ['cloud', '클라우드 다운로드', 'Cloud download', '외부 링크를 미믹 서버가 받아 저장한 양', 'Data Mimic fetched into your cloud'],
  ['down', '다운스트림', 'Downstream', '클라우드에서 기기로 내려받은 양', 'Data downloaded to your devices'],
  ['up', '업로드', 'Upload', '기기에서 클라우드로 올린 양(압축 때문에 파일 크기보다 작게 잡힐 수 있어요)', 'Data uploaded (may count less than file size due to compression)'],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, ko, en]) => [k, [ko, en]]));
const REASON = { order: ['추가 쿼터 구매', 'Purchased'], invite_upload: ['초대 보너스', 'Invite bonus'], invite_carry: ['초대 보너스(이월)', 'Invite bonus (carried over)'] };
const pct = (u, l) => (l ? Math.min(100, (u / l) * 100) : 0);
const bar = (u, l, cls = '') => h('div', { class: `progress ${cls} ${pct(u, l) >= 90 ? 'warn' : ''}` }, h('span', { style: { width: `${pct(u, l)}%` } }));

export async function render(root, ctx) {
  loadCss('/css/billing.css');
  async function draw() {
    const [q, p] = await Promise.all([api('/api/billing/quota'), api('/api/billing/products')]);
    const appPct = Math.round(q.appShare * 100);

    const month = h(
      'section',
      { class: 'card' },
      h('div', { class: 'row' }, h('h3', { class: 'bl-section-title', style: { margin: 0 } }, t(`이번 달 사용량 (${q.monthKey})`, `This month (${q.monthKey})`)), h('div', { class: 'spacer' }), h('span', { class: 'small muted' }, t('매월 1일 0시(한국 시간)에 초기화 · 이월 없음', 'Resets on the 1st (KST) · no rollover'))),
      ...KINDS.map(([k, ko, en, dko, den]) =>
        h(
          'div',
          { class: 'bl-meter' },
          h('div', { class: 'row' }, h('b', {}, t(ko, en)), h('div', { class: 'spacer' }), h('span', {}, `${formatBytes(q.month[k].used)} / ${formatBytes(q.month[k].limit)}`)),
          bar(q.month[k].used, q.month[k].limit),
          h('span', { class: 'small muted' }, t(dko, den)),
          h('div', { class: 'bl-app' }, h('span', {}, t(`연결 앱 (${appPct}% 상한)`, `Connected apps (${appPct}% cap)`)), bar(q.app[k].used, q.app[k].limit, 'app'), h('span', {}, `${formatBytes(q.app[k].used)} / ${formatBytes(q.app[k].limit)}`)),
        ),
      ),
    );

    const ct = q.today.cloudTasks;
    const today = h(
      'section',
      { class: 'card' },
      h('h3', { class: 'bl-section-title' }, t('오늘', 'Today')),
      h(
        'div',
        { class: 'bl-stats' },
        h('div', { class: 'bl-stat' }, h('b', {}, q.today.down.limit ? `${formatBytes(q.today.down.used)} / ${formatBytes(q.today.down.limit)}` : formatBytes(q.today.down.used)), h('span', {}, q.today.down.limit ? t('오늘 다운스트림 (무료 하루 한도)', "Today's downstream (free daily cap)") : t('오늘 다운스트림 (프리미엄은 하루 한도 없음)', "Today's downstream (no daily cap)"))),
        q.today.appDown?.limit ? h('div', { class: 'bl-stat' }, h('b', {}, `${formatBytes(q.today.appDown.used)} / ${formatBytes(q.today.appDown.limit)}`), h('span', {}, t('오늘 연결 앱 다운로드 (무료 하루 한도)', "Today's connected-app downloads (free daily cap)"))) : null,
        h('div', { class: 'bl-stat' }, h('b', {}, ct.unlimited ? t('무제한', 'Unlimited') : t(`${ct.remaining}회`, `${ct.remaining}`)), h('span', {}, ct.unlimited ? t('클라우드 다운로드 횟수', 'Cloud downloads') : t(`남은 무료 클라우드 다운로드 (오늘 ${ct.dailyLeft} + 보너스 ${ct.bonusLeft})`, `Free cloud downloads left (today ${ct.dailyLeft} + bonus ${ct.bonusLeft})`))),
      ),
      q.premium ? null : h('p', { class: 'small muted', style: { margin: '10px 0 0' } }, t('무료 회원의 하루 한도는 한국 시간 0시에 다시 채워져요.', 'Free daily limits refill at midnight KST.')),
    );

    const grants = h(
      'section',
      { class: 'card' },
      h('h3', { class: 'bl-section-title' }, t('추가 쿼터 내역', 'Extra quota')),
      q.grants.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'table' },
              h('thead', {}, h('tr', {}, ...[['항목', 'Type'], ['양', 'Amount'], ['적용 기간', 'Applies to'], ['받은 이유', 'Source']].map((x) => h('th', {}, t(...x))))),
              h(
                'tbody',
                {},
                ...q.grants.map((g) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, t(...KIND_LABEL[g.kind])),
                    h('td', {}, formatBytes(g.amount)),
                    h('td', {}, g.period ? g.period : g.validTo ? t(`${formatDate(g.validTo - 1, false)}까지`, `Until ${formatDate(g.validTo - 1, false)}`) : t('기간 제한 없음', 'No end date')),
                    h('td', {}, t(...(REASON[g.reason] || ['기타', 'Other']))),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted', style: { margin: 0 } }, t('받은 추가 쿼터가 없어요. 기본 쿼터를 다 쓰면 추가 쿼터가 이어서 쓰입니다.', 'No extra quota yet. Extra quota is used after the base quota.')),
      h(
        'div',
        { class: 'bl-addons', style: { marginTop: '14px' } },
        ...p.products
          .filter((x) => x.kind === 'addon_quota')
          .map((x) => {
            const b = h('button', { class: 'btn primary sm' }, t('구매', 'Buy'));
            b.onclick = async () => {
              b.disabled = true;
              try {
                await buyProduct(ctx, x.id, 'card', draw);
              } catch (e) {
                toastError(e);
              } finally {
                b.disabled = false;
              }
            };
            return h(
              'div',
              { class: 'bl-addon' },
              h('b', {}, productLabel(x)),
              h('p', {}, t(`클라우드 ${formatBytes(x.amounts.cloud)} · 다운스트림 ${formatBytes(x.amounts.down)} · 업로드 ${formatBytes(x.amounts.up)} · ${x.months === 12 ? '12개월 동안 매달 지급' : '구매한 달에만 사용'}`, `Cloud ${formatBytes(x.amounts.cloud)} · down ${formatBytes(x.amounts.down)} · up ${formatBytes(x.amounts.up)} · ${x.months === 12 ? 'every month for 12 months' : 'this month only'}`)),
              h('div', { class: 'row' }, h('b', {}, `₩${x.payNow.toLocaleString('ko-KR')}`), h('div', { class: 'spacer' }), b),
            );
          }),
      ),
      h('p', { class: 'small muted', style: { margin: '10px 0 0' } }, t('다른 결제 수단은 ', 'Other payment methods are on the '), h('a', { href: '/drive/payment' }, t('결제 화면', 'payment page')), t('에서 고를 수 있어요.', '.')),
    );

    const rules = h(
      'section',
      { class: 'card' },
      h('h3', { class: 'bl-section-title' }, t('쿼터는 이렇게 계산돼요', 'How quota works')),
      h(
        'ul',
        { class: 'bl-guide' },
        h('li', {}, t(`모든 회원에게 매달 클라우드 다운로드 ${formatBytes(q.base.cloud)}, 다운스트림 ${formatBytes(q.base.down)}, 업로드 ${formatBytes(q.base.up)}를 드려요. 남은 양은 다음 달로 넘어가지 않습니다.`, `Everyone gets ${formatBytes(q.base.cloud)} cloud, ${formatBytes(q.base.down)} down and ${formatBytes(q.base.up)} up each month. Unused quota does not roll over.`)),
        h('li', {}, t('기본 쿼터를 먼저 쓰고, 다 쓰면 추가 쿼터가 이어서 쓰여요.', 'Base quota is used first, then extra quota.')),
        h('li', {}, t('무료 회원은 하루 다운스트림 20GB, 클라우드 다운로드 하루 3회까지 쓸 수 있어요.', 'Free members: 20GB downstream and 3 cloud downloads per day.')),
        h('li', {}, t(`WebDAV·CLI 같은 연결 앱으로 쓴 양은 합쳐서 각 쿼터의 ${appPct}%까지예요. 넘으면 연결 앱 다운로드는 약 100KB/s로 느려지고, 연결 앱의 업로드와 새 클라우드 다운로드는 멈춥니다(진행 중인 작업은 계속). 미믹 웹과 공식 앱은 이 상한이 없어요.`, `Connected apps (WebDAV, CLI…) share ${appPct}% of each quota. Beyond it, app downloads slow to ~100KB/s and app uploads and new cloud downloads stop. Official Mimic apps are not capped.`)),
        h('li', {}, t(`무료 회원의 연결 앱 다운로드는 하루 ${formatBytes(q.freeAppDailyDown)}까지예요.`, `Free members can download up to ${formatBytes(q.freeAppDailyDown)} per day via connected apps.`)),
        h('li', {}, t('예상보다 빨리 한도에 닿았다면 계정이 공유되거나 모르는 앱이 연결되지 않았는지 계정 및 보안에서 확인해 주세요.', 'If you hit limits unexpectedly, check Account & security for shared sessions or unknown apps.')),
      ),
    );

    root.replaceChildren(
      h(
        'div',
        { class: 'bl-page col', style: { gap: '16px' } },
        h('div', { class: 'bl-head', style: { margin: 0 } }, h('h2', {}, t('전송 쿼터', 'Transfer quota')), h('div', { class: 'spacer' }), h('a', { class: 'btn sm', href: '/drive/settings/transfer', html: `${icon('settings')}<span>${t('전송 설정', 'Transfer settings')}</span>` })),
        month,
        today,
        grants,
        rules,
      ),
    );
  }
  await draw();
}
