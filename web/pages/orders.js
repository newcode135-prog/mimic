// 구독 관리 · 구매 기록 · 쿠폰 사용 내역 · 출석 체크(/drive/orders). I-01, I-03, I-06
import { api, h, t, toast, toastError, confirmDialog, promptDialog, formatDate, loadCss, icon, callComponent, bus } from '/ui.js';
import { refreshShell } from '/layout.js';
import { METHODS, formatMoney } from '/pages/payment.js';

const TABS = [
  ['subs', '구독 관리', 'Subscriptions'],
  ['orders', '구매 기록', 'Purchases'],
  ['coupons', '쿠폰 사용 내역', 'Coupons'],
  ['checkin', '출석 체크', 'Check-in'],
];
const ORDER_STATUS = {
  paid: ['결제 완료', 'Paid', 'brand'],
  failed: ['결제 실패', 'Failed', 'danger'],
  refund_requested: ['환불 요청됨', 'Refund requested', 'accent'],
  refunded: ['환불됨', 'Refunded', ''],
};
const COUPON_KIND = { paid: ['유료 코드', 'Paid code'], trial: ['체험 코드', 'Trial code'], free: ['무료 코드', 'Free code'] };
const empty = (ic, text, extra = null) => h('div', { class: 'empty' }, h('div', { html: icon(ic) }), h('p', {}, text), extra);
const badge = ([ko, en, kind]) => h('span', { class: `badge ${kind || ''}` }, t(ko, en));

async function subsTab(box, redraw) {
  // autoRenewAvailable=false: 운영 결제에서 자동 결제 카드(빌링키)가 없어 구독이 기간제다(카드 외 수단으로 결제)
  const { items, premiumUntil, autoRenewAvailable } = await api('/api/billing/subscriptions');
  const active = items.filter((s) => s.status === 'active');
  const head = h(
    'div',
    { class: 'card' },
    h('div', { class: 'row' }, h('b', {}, t('프리미엄 이용 기간', 'Premium until')), h('div', { class: 'spacer' }), premiumUntil && premiumUntil > Date.now() ? h('span', {}, formatDate(premiumUntil)) : h('span', { class: 'muted' }, t('무료 이용 중', 'Free plan'))),
  );
  if (!items.length) return box.replaceChildren(head, empty('crown', t('구독한 상품이 없어요.', 'No subscriptions yet.'), h('a', { class: 'btn primary', href: '/drive/payment' }, t('프리미엄 둘러보기', 'See Premium'))));
  const card = (s) => {
    const st =
      s.status === 'active'
        ? s.autoRenew
          ? ['자동 갱신 중', 'Auto-renewing', 'brand']
          : autoRenewAvailable
            ? ['자동 갱신 꺼짐', 'Auto-renew off', 'accent']
            : ['기간제 · 자동 결제 카드 없음', 'Fixed term · no card on file', 'accent']
        : s.status === 'canceled'
          ? ['환불로 종료', 'Ended (refund)', '']
          : ['기간 종료', 'Ended', ''];
    const per = s.months === 12 ? t('년', 'yr') : t('월', 'mo');
    const toggle = s.status === 'active' && (s.autoRenew || autoRenewAvailable) ? h('button', { class: `btn sm ${s.autoRenew ? 'danger' : 'primary'}` }, s.autoRenew ? t('자동 갱신 끄기', 'Turn off auto-renew') : t('자동 갱신 다시 켜기', 'Turn on auto-renew')) : null;
    if (toggle)
      toggle.onclick = async () => {
        if (s.autoRenew && !(await confirmDialog(t('자동 갱신을 끌까요?', 'Turn off auto-renewal?'), t(`${formatDate(s.currentPeriodEnd, false)}까지는 프리미엄을 그대로 쓰고, 그 뒤에는 결제되지 않아요.`, `You keep Premium until ${formatDate(s.currentPeriodEnd, false)} and will not be charged again.`), { okLabel: t('끄기', 'Turn off'), danger: true })))
          return;
        try {
          await api(`/api/billing/subscriptions/${s.id}/${s.autoRenew ? 'cancel' : 'resume'}`, { method: 'POST' });
          toast(s.autoRenew ? t('자동 갱신을 껐어요', 'Auto-renewal turned off') : t('자동 갱신을 다시 켰어요', 'Auto-renewal is back on'), 'ok');
          redraw();
        } catch (e) {
          toastError(e);
        }
      };
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('h3', { style: { margin: 0 } }, t(s.label, s.labelEn)), badge(st), h('div', { class: 'spacer' }), toggle),
      h(
        'table',
        { class: 'table', style: { marginTop: '8px' } },
        h(
          'tbody',
          {},
          h('tr', {}, h('th', {}, t('시작일', 'Started')), h('td', {}, formatDate(s.createdAt, false))),
          h('tr', {}, h('th', {}, t('현재 기간 끝', 'Current period ends')), h('td', {}, formatDate(s.currentPeriodEnd, false))),
          s.status === 'active' ? h('tr', {}, h('th', {}, t('다음 결제', 'Next charge')), h('td', {}, s.autoRenew ? `${formatDate(s.nextChargeAt, false)} · ${formatMoney(s.renewPrice, s.currency)}/${per}` : autoRenewAvailable ? t('없음(자동 갱신 꺼짐)', 'None (auto-renew off)') : t('없음(기간이 끝나면 다시 구독해 주세요)', 'None (subscribe again when it ends)'))) : null,
        ),
      ),
    );
  };
  box.replaceChildren(head, ...active.map(card), ...items.filter((s) => s.status !== 'active').map(card), h('p', { class: 'small muted', style: { marginTop: '12px' } }, autoRenewAvailable ? t('자동 결제 7일 전에 알림과 이메일로 미리 알려 드려요.', 'We notify you 7 days before each renewal.') : t('등록된 자동 결제 카드가 없어 자동으로 청구되지 않아요. 기간이 끝나기 7일 전에 알림과 이메일로 알려 드리니, 계속 쓰려면 카드로 다시 구독해 주세요.', 'No card on file, so nothing renews automatically. We notify you 7 days before your plan ends; subscribe again with a card to continue.')));
}

async function ordersTab(box, redraw) {
  const { items } = await api('/api/billing/orders');
  if (!items.length) return box.replaceChildren(empty('ticket', t('구매 기록이 없어요.', 'No purchases yet.')));
  const row = (o) => {
    const action =
      o.status === 'paid'
        ? h('button', {
            class: 'btn sm ghost',
            onclick: async () => {
              const reason = await promptDialog(t('환불 요청', 'Request a refund'), { label: t('환불을 원하는 이유를 적어 주세요', 'Tell us why you want a refund'), okLabel: t('요청하기', 'Send') });
              if (!reason) return;
              try {
                await api(`/api/billing/orders/${o.id}/refund-request`, { method: 'POST', body: { reason } });
                toast(t('환불 요청을 접수했어요. 확인 후 알려 드릴게요.', 'Refund request received.'), 'ok');
                redraw();
              } catch (e) {
                toastError(e);
              }
            },
          }, t('환불 요청', 'Request refund'))
        : null;
    return h(
      'tr',
      {},
      h('td', {}, formatDate(o.paidAt || o.createdAt)),
      h('td', {}, t(o.label, o.labelEn), ' ', o.renewal ? h('span', { class: 'badge' }, t('자동 갱신', 'Renewal')) : null, o.firstDiscount ? h('span', { class: 'badge accent' }, t('첫 결제 할인', 'First-time')) : null),
      h('td', {}, t(...(METHODS[o.method] || [o.method, o.method])), o.testMode ? h('span', { class: 'small muted' }, t(' (테스트)', ' (test)')) : null),
      h('td', {}, formatMoney(o.amount, o.currency)),
      h('td', {}, badge(ORDER_STATUS[o.status] || [o.status, o.status])),
      h('td', {}, action),
    );
  };
  box.replaceChildren(
    h(
      'div',
      { class: 'card table-scroll', style: { padding: '8px' } },
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ...[['일시', 'Date'], ['상품', 'Product'], ['결제 수단', 'Method'], ['금액', 'Amount'], ['상태', 'Status'], ['', '']].map((x) => h('th', {}, t(...x))))), h('tbody', {}, ...items.map(row))),
    ),
    h('p', { class: 'small muted', style: { marginTop: '12px' } }, t('환불 요청은 운영팀이 확인한 뒤 처리하며, 환불되면 그 주문으로 받은 남은 혜택 기간이 회수됩니다. 자세한 기준은 ', 'Refund requests are reviewed by our team; refunded orders remove the remaining benefit period. See the '), h('a', { href: '/policy/membership' }, t('멤버십 약관', 'membership terms')), t('을 확인해 주세요.', '.')),
  );
}

async function couponsTab(box) {
  const { items } = await api('/api/billing/coupons/history');
  const add = h('button', { class: 'btn primary sm', html: `${icon('ticket')}<span>${t('쿠폰 코드 등록', 'Redeem a code')}</span>`, onclick: () => callComponent('coupon', 'openCoupon') });
  if (!items.length) return box.replaceChildren(empty('ticket', t('등록한 쿠폰이 없어요.', 'No coupons redeemed yet.'), add));
  box.replaceChildren(
    h('div', { class: 'row', style: { marginBottom: '12px' } }, h('div', { class: 'spacer' }), add),
    h(
      'div',
      { class: 'card table-scroll', style: { padding: '8px' } },
      h(
        'table',
        { class: 'table' },
        h('thead', {}, h('tr', {}, ...[['등록일', 'Redeemed'], ['코드', 'Code'], ['종류', 'Type'], ['받은 기간', 'Days'], ['혜택 끝', 'Ends']].map((x) => h('th', {}, t(...x))))),
        h('tbody', {}, ...items.map((c) => h('tr', {}, h('td', {}, formatDate(c.createdAt)), h('td', {}, `••••-${c.hint}`), h('td', {}, t(...(COUPON_KIND[c.kind] || [c.kind, c.kind]))), h('td', {}, t(`${c.days}일`, `${c.days} days`)), h('td', {}, formatDate(c.endsAt, false))))),
      ),
    ),
  );
}

async function checkinTab(box, redraw) {
  const c = await api('/api/billing/checkin');
  const pct = ((c.streak % c.rewardEvery) / c.rewardEvery) * 100;
  const btn = h('button', { class: 'btn primary lg', disabled: c.checkedToday }, c.checkedToday ? t('오늘 출석 완료', 'Checked in today') : t('오늘 출석하기', 'Check in today'));
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await api('/api/billing/checkin', { method: 'POST' });
      toast(r.rewarded ? t(`${r.streak}일 연속 출석! 프리미엄 ${r.rewarded}일을 받았어요`, `${r.streak}-day streak! +${r.rewarded} day Premium`) : t(`출석 완료 · ${r.streak}일 연속`, `Checked in · ${r.streak}-day streak`), 'ok');
      if (r.rewarded) await refreshShell();
      redraw();
    } catch (e) {
      toastError(e);
      btn.disabled = false;
    }
  };
  box.replaceChildren(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('div', { class: 'col', style: { gap: '2px' } }, h('h3', { style: { margin: 0 } }, t(`${c.streak}일 연속 출석 중`, `${c.streak}-day streak`)), h('span', { class: 'small muted' }, t(`${c.rewardEvery}일 연속으로 출석할 때마다 프리미엄 ${c.rewardDays}일을 드려요. 다음 보상까지 ${c.nextRewardIn}일`, `Every ${c.rewardEvery} days in a row earns ${c.rewardDays} day of Premium. ${c.nextRewardIn} to go`))), h('div', { class: 'spacer' }), btn),
      h('div', { class: 'progress', style: { marginTop: '14px', height: '10px' } }, h('span', { style: { width: `${pct}%` } })),
    ),
    h('div', { class: 'bl-stats', style: { margin: '16px 0' } }, h('div', { class: 'bl-stat' }, h('b', {}, String(c.total)), h('span', {}, t('전체 출석일', 'Total days'))), h('div', { class: 'bl-stat' }, h('b', {}, t(`${c.earnedDays}일`, `${c.earnedDays}d`)), h('span', {}, t('받은 프리미엄', 'Premium earned')))),
    c.recent.length ? h('div', { class: 'card' }, h('h3', { class: 'bl-section-title' }, t('최근 출석', 'Recent check-ins')), h('div', { class: 'bl-chips' }, ...c.recent.map((r) => h('span', { class: `bl-chip ${r.rewardDays ? 'reward' : ''}` }, r.day, r.rewardDays ? ` +${r.rewardDays}` : '')))) : '',
    h('p', { class: 'small muted', style: { marginTop: '12px' } }, t('미믹 브라우저 확장을 설치하면 브라우저를 열 때 바로 출석할 수 있어요. ', 'With the Mimic browser extension you can check in right from your browser. '), h('a', { href: '/check-in-guide' }, t('출석 체크 안내', 'How it works'))),
  );
}

const DRAW = { subs: subsTab, orders: ordersTab, coupons: couponsTab, checkin: checkinTab };

export async function render(root, ctx) {
  loadCss('/css/billing.css');
  let tab = DRAW[ctx.query.tab] ? ctx.query.tab : 'subs';
  const box = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const redraw = async () => {
    tabs.replaceChildren(...TABS.map(([k, ko, en]) => h('button', { class: k === tab ? 'active' : '', role: 'tab', 'aria-selected': String(k === tab), onclick: () => ((tab = k), history.replaceState({}, '', `/drive/orders?tab=${k}`), redraw()) }, t(ko, en))));
    box.replaceChildren(h('div', { class: 'page-loading' }, h('div', { class: 'spinner' })));
    try {
      await DRAW[tab](box, redraw);
    } catch (e) {
      box.replaceChildren(empty('info', e.message));
    }
  };
  root.replaceChildren(h('div', { class: 'bl-page' }, h('div', { class: 'bl-head' }, h('h2', {}, t('구독·구매 기록', 'Subscriptions & purchases')), h('div', { class: 'spacer' }), h('a', { class: 'btn accent sm', href: '/drive/payment', html: `${icon('crown')}<span>Premium</span>` })), tabs, box));
  await redraw();
  return bus.on('billing:changed', redraw); // 쿠폰 등록 창에서 바뀌면 다시 그림
}
