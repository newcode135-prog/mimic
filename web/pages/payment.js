// 프리미엄 결제 화면: /pricing(공개) · /drive/payment(로그인). I-01 구독·1회권, I-02 추가 저장공간, F-03 추가 쿼터
import { api, h, t, toast, toastError, modal, formatWon, formatDate, formatBytes, loadCss, icon, callComponent, getMe, bus } from '/ui.js';
import { refreshShell } from '/layout.js';

export const METHODS = { card: ['신용·체크카드', 'Card'], paypal: ['PayPal', 'PayPal'], crypto: ['암호화폐', 'Crypto'], alipay: ['Alipay', 'Alipay'], unionpay: ['UnionPay', 'UnionPay'] };
const PLAN_IDS = ['sub_month', 'sub_year', 'once_month', 'once_year'];
const ADDON_IDS = ['storage_10tb_year', 'quota_month', 'quota_year'];
// 운영(토스페이먼츠 v1 결제창)에서 쓰는 수단을 통화별로. 원화 카드 결제창에는 국내 간편결제도 들어 있다.
// 달러는 해외 카드 전용 결제창(Visa·Master·JCB·UnionPay·AMEX)과 해외간편결제. ponytail: Alipay provider 코드는 토스 계약 때 확인
const INTL_CARD = ['카드', { useInternationalCardOnly: true }];
const TOSS_METHOD = {
  KRW: { card: ['카드', {}] },
  USD: { card: INTL_CARD, unionpay: INTL_CARD, paypal: ['해외간편결제', { provider: 'PAYPAL' }], alipay: ['해외간편결제', { provider: 'ALIPAY' }] },
};

// 금액은 최소 단위(원·센트). 원화 외에는 달러만 받는다
export const formatMoney = (n, currency = 'KRW') => (currency === 'USD' ? `$${(Number(n || 0) / 100).toFixed(2)}` : formatWon(n));
export const productLabel = (p) => t(p.label, p.labelEn);
const unit = (p) => (p.kind === 'subscription' ? (p.months === 12 ? t('/년', '/yr') : t('/월', '/mo')) : '');
// autoRenew: 자동 결제가 되는 결제 방식인지(테스트 결제, 운영은 원화 카드 구독·PayPal 구독. 다른 수단은 결제한 기간만)
const autoRenewFor = (d, method) => d.testMode || (!!d.available && ((method === 'card' && d.currency === 'KRW') || (method === 'paypal' && d.provider === 'paypal')));
function thenText(p, autoRenew, cur) {
  if (p.kind === 'subscription') {
    const per = p.months === 12 ? t('년', 'yr') : t('월', 'mo');
    const price = formatMoney(p.price, cur);
    if (!autoRenew) return t(`${p.days}일 이용 · 이 수단은 자동 갱신 없음(기간이 끝나면 다시 결제)`, `${p.days} days · no auto-renewal with this method`);
    return p.firstDiscount ? t(`이후 ${price}/${per} 자동 결제`, `Then ${price}/${per}`) : t(`${price}/${per} 자동 결제`, `Renews at ${price}/${per}`);
  }
  if (p.kind === 'once') return t(`${p.days}일 이용 · 자동 결제 없음`, `${p.days} days · no auto-renewal`);
  return '';
}

// 달러 가격에 쓴 환율 안내(date 가 없으면 기본 환율)
const fxText = (fx) => {
  const rate = `₩${Number(fx.rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return fx.date ? t(`환율 $1 = ${rate} (${fx.date} 기준)`, `Rate $1 = ${rate} (as of ${fx.date})`) : t(`환율 $1 = ${rate} (기본 환율)`, `Rate $1 = ${rate} (default rate)`);
};

// 주문 → (테스트) 결제 창 → 결과 반영. 쿼터 화면도 이 함수를 쓴다
export async function buyProduct(ctx, productId, method = 'card', onDone) {
  if (!ctx.me) return ctx.navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  const o = await api('/api/billing/orders', { method: 'POST', body: { productId, method } });
  if (!o.testMode) return o.approveUrl ? location.assign(o.approveUrl) : livePay(o, method); // PayPal: 승인 화면으로
  const amount = formatMoney(o.amount, o.currency);
  return new Promise((resolve) => {
    const finish = async (result) => {
      const r = await api(`/api/billing/orders/${o.orderId}/confirm`, { method: 'POST', body: { result } });
      if (r.ok) {
        toast(t('결제가 끝났어요. 혜택이 바로 적용됩니다.', 'Payment complete. Your benefits are active now.'), 'ok');
        await refreshShell();
        await onDone?.();
      } else toast(t('결제에 실패했어요. 요금은 청구되지 않았습니다.', 'Payment failed. You were not charged.'), 'error');
      resolve(r.ok);
    };
    modal({
      title: t('테스트 결제', 'Test payment'),
      body: h(
        'div',
        { class: 'col' },
        h('div', { class: 'bl-notice', html: `${icon('info')}<span>${t('개발 모드라 실제로 돈이 나가지 않아요. 결과를 골라 흐름을 확인하세요.', 'Development mode: no real charge. Pick a result to continue.')}</span>` }),
        h('table', { class: 'table' }, h('tbody', {}, h('tr', {}, h('th', {}, t('상품', 'Product')), h('td', {}, t(o.order.label, o.order.labelEn))), h('tr', {}, h('th', {}, t('결제 수단', 'Method')), h('td', {}, t(...METHODS[method]))), h('tr', {}, h('th', {}, t('금액', 'Amount')), h('td', {}, h('b', {}, amount))))),
      ),
      onClose: () => resolve(false),
      actions: [
        { label: t('실패로 처리', 'Simulate failure'), kind: 'danger', onClick: () => finish('fail') },
        { label: t('성공으로 처리', 'Simulate success'), kind: 'primary', onClick: () => finish('success') },
      ],
    });
  });
}

async function livePay(o, method) {
  const m = TOSS_METHOD[o.currency]?.[method];
  if (!m) return toast(t('이 결제 수단은 아직 준비 중이에요', 'This payment method is not available yet'), 'error');
  const { tossClientKey, region } = await api('/api/billing/products');
  if (!window.TossPayments) {
    await new Promise((ok, no) => document.head.append(h('script', { src: 'https://js.tosspayments.com/v1/payment', onload: ok, onerror: no })));
  }
  const back = `${location.origin}/drive/payment`;
  const toss = window.TossPayments(tossClientKey);
  // 원화 카드 구독: 자동 결제 카드를 등록(빌링 인증)하고 돌아오면 서버가 빌링키로 첫 결제와 이후 갱신을 청구한다
  if (o.customerKey) return toss.requestBillingAuth('카드', { customerKey: o.customerKey, successUrl: `${back}?toss=billing&orderId=${encodeURIComponent(o.orderId)}`, failUrl: `${back}?toss=fail` });
  // 달러는 소수 금액(4.31)으로 보낸다. 해외간편결제는 나라 코드가 필요하고, PayPal 은 보류(검토) 때 pendingUrl 로 돌아온다
  const usd = o.currency === 'USD';
  const extra = usd ? { currency: 'USD', ...(m[0] === '해외간편결제' ? { country: region || 'US', pendingUrl: `${back}?toss=pending` } : {}) } : {};
  await toss.requestPayment(m[0], { ...m[1], ...extra, amount: usd ? o.amount / 100 : o.amount, orderId: o.orderId, orderName: t(o.order.label, o.order.labelEn), successUrl: `${back}?toss=success`, failUrl: `${back}?toss=fail` });
}

// 토스 결제창에서 돌아왔을 때 승인 요청(billing: 자동 결제 카드 등록 뒤 첫 결제, pending: 결제사 확인 중이라 웹훅이 반영)
async function finishToss(q) {
  history.replaceState({}, '', location.pathname);
  if (q.toss === 'fail') return toast(q.message || t('결제가 취소되었어요', 'Payment was cancelled'), 'error');
  if (q.toss === 'pending') return toast(t('결제사가 결제를 확인하고 있어요. 끝나면 혜택이 적용되고 알림으로 알려 드릴게요.', 'Your payment is being reviewed. Benefits apply once it completes, and we will notify you.'), 'ok');
  const body = q.toss === 'billing' ? { authKey: q.authKey, customerKey: q.customerKey } : { paymentKey: q.paymentKey };
  try {
    const r = await api(`/api/billing/orders/${encodeURIComponent(q.orderId)}/confirm`, { method: 'POST', body });
    if (r.status === 'pending') return toast(t('결제사가 결제를 마무리하고 있어요. 끝나면 혜택이 적용되고 알림으로 알려 드릴게요.', 'Your payment is being finalized. Benefits apply once it completes, and we will notify you.'), 'ok');
    toast(t('결제가 끝났어요. 혜택이 바로 적용됩니다.', 'Payment complete.'), 'ok');
    await refreshShell();
  } catch (e) {
    toastError(e);
  }
}

// PayPal 승인 화면에서 돌아옴(?paypal=order|sub|cancel&orderId=…): 서버가 캡처·구독 확인
async function finishPaypal(q) {
  history.replaceState({}, '', location.pathname);
  if (q.paypal === 'cancel' || !q.orderId) return toast(t('결제가 취소되었어요', 'Payment was cancelled'), 'error');
  try {
    const r = await api(`/api/billing/orders/${encodeURIComponent(q.orderId)}/confirm`, { method: 'POST', body: {} });
    if (r.status === 'pending') return toast(t('PayPal 이 결제를 마무리하고 있어요. 끝나면 혜택이 적용되고 알림으로 알려 드릴게요.', 'PayPal is finalizing your payment. Benefits apply once it completes, and we will notify you.'), 'ok');
    toast(t('결제가 끝났어요. 혜택이 바로 적용됩니다.', 'Payment complete.'), 'ok');
    await refreshShell();
  } catch (e) {
    toastError(e);
  }
}

function compareTable(head, rows, keys) {
  return h(
    'div',
    { class: 'table-scroll' },
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, h('b', {}, t(...r.item))), ...keys.map((k) => h('td', {}, t(...r[k])))))),
    ),
  );
}
function openCompare(cmp, tier) {
  modal({
    wide: true,
    title: t('혜택 자세히 비교', 'Compare plans'),
    body: h(
      'div',
      { class: 'col' },
      h('h4', {}, t('무료와 프리미엄', 'Free vs Premium')),
      compareTable([t('항목', 'Item'), t('무료', 'Free'), t('프리미엄', 'Premium')], cmp.premium, ['free', 'premium']),
      h('h4', { style: { marginTop: '16px' } }, t('글로벌 프리미엄과 지역 프리미엄', 'Global vs Regional Premium')),
      h('p', { class: 'small muted' }, t(`가입 지역에 따라 등급이 정해져요. 지금 내 등급: ${tier === 'regional' ? '지역' : '글로벌'}`, `Your tier depends on your region. Current: ${tier}`)),
      compareTable([t('항목', 'Item'), t('글로벌', 'Global'), t('지역', 'Regional')], cmp.tier, ['global', 'regional']),
    ),
  });
}

const BENEFITS = (storage) => [
  ['cloud', t(`저장공간 ${storage}`, `${storage} of storage`)],
  ['cloudDown', t('클라우드 다운로드 횟수 무제한', 'Unlimited cloud downloads')],
  ['play', t('원본 화질 그대로 재생', 'Play in original quality')],
  ['download', t('고속 다운로드 · 동시 작업 5개', 'Fast downloads · 5 tasks at once')],
  ['lock', t('금고 · WebDAV · 온라인 압축 해제', 'Vault · WebDAV · online unzip')],
  ['shield', t('광고 없이 깔끔하게', 'No ads')],
];

export async function render(root, ctx) {
  loadCss('/css/billing.css');
  const site = ctx.path === '/pricing';
  if (ctx.query.toss && ctx.me) await finishToss(ctx.query);
  if (ctx.query.paypal && ctx.me) await finishPaypal(ctx.query);
  let selected = 'sub_year';
  let method = 'card';

  async function draw() {
    const [d, me] = await Promise.all([api('/api/billing/products'), getMe()]);
    ctx.me = me;
    const byId = Object.fromEntries(d.products.map((p) => [p.id, p]));
    const cur = d.currency || 'KRW';
    const money = (n) => formatMoney(n, cur);
    if (!d.methods.includes(method)) method = d.methods[0];
    const autoSub = d.activeSubscription?.autoRenew ? d.activeSubscription : null;
    const storage = d.compare.premium[0].premium[0];

    const planCards = h('div', { class: 'bl-plans' });
    const methodList = h('div', { class: 'bl-methods', role: 'radiogroup', 'aria-label': t('결제 수단', 'Payment method') });
    const summary = h('div', { class: 'bl-summary' });
    const addons = h('div', { class: 'bl-addons' });

    const buy = async (productId, btn) => {
      btn.disabled = true;
      try {
        await buyProduct(ctx, productId, method, draw);
      } catch (e) {
        toastError(e);
      } finally {
        btn.disabled = false;
      }
    };

    function paint() {
      planCards.replaceChildren(
        ...PLAN_IDS.map((id) => {
          const p = byId[id];
          const off = p.firstDiscount ? Math.round((1 - p.payNow / p.price) * 100) : 0;
          const mine = autoSub?.productId === id;
          return h(
            'button',
            { class: `bl-plan ${selected === id ? 'selected' : ''}`, type: 'button', 'aria-pressed': String(selected === id), onclick: () => ((selected = id), paint()) },
            mine ? h('span', { class: 'badge brand' }, t('구독 중', 'Current')) : off ? h('span', { class: 'badge accent' }, t(`첫 결제 ${off}% 할인`, `${off}% off first`)) : p.kind === 'once' ? h('span', { class: 'badge' }, t('1회 구매', 'One-time')) : null,
            h('span', { class: 'bl-plan-name' }, productLabel(p)),
            h('span', { class: 'bl-price' }, money(p.payNow), h('small', {}, unit(p))),
            p.firstDiscount ? h('span', { class: 'bl-strike' }, money(p.price)) : null,
            h('span', { class: 'bl-then' }, thenText(p, autoRenewFor(d, method), cur)),
          );
        }),
      );
      methodList.replaceChildren(
        ...d.methods.map((m) => {
          const off = !d.testMode && !TOSS_METHOD[cur]?.[m];
          return h(
            'label',
            { class: `bl-method ${method === m ? 'selected' : ''} ${off ? 'disabled' : ''}` },
            h('input', { type: 'radio', name: 'bl-method', value: m, checked: method === m, disabled: off, onchange: () => ((method = m), paint()) }),
            t(...METHODS[m]),
            off ? h('span', { class: 'small muted' }, t('준비 중', 'Soon')) : null,
          );
        }),
      );
      const p = byId[selected];
      const blocked = p.kind === 'subscription' && autoSub;
      const btn = h('button', { class: 'btn primary lg', disabled: !!blocked }, ctx.me ? t(`${money(p.payNow)} 결제하기`, `Pay ${money(p.payNow)}`) : t('로그인하고 결제하기', 'Log in to pay'));
      btn.onclick = () => buy(p.id, btn);
      summary.replaceChildren(
        h('div', { class: 'col', style: { gap: '2px' } }, h('span', { class: 'small muted' }, t('결제 금액', 'Total')), h('span', { class: 'bl-total' }, money(p.payNow)), h('span', { class: 'bl-then' }, thenText(p, autoRenewFor(d, method), cur))),
        h('div', { class: 'spacer' }),
        btn,
      );
      if (blocked) summary.append(h('p', { class: 'small muted', style: { width: '100%', margin: 0 } }, t('자동 갱신 중인 구독이 있어요. 구독 관리에서 자동 갱신을 끄면 다른 구독으로 바꿀 수 있고, 1회 상품은 지금 바로 더할 수 있습니다.', 'You already have an auto-renewing plan. Turn it off in Subscriptions to switch, or add a one-time pass.')));
      addons.replaceChildren(
        ...ADDON_IDS.map((id) => {
          const p = byId[id];
          const needPremium = p.kind === 'addon_storage' && !d.premium;
          const desc =
            p.kind === 'addon_storage'
              ? t('프리미엄 저장공간에 10TB를 더해 1년 동안 씁니다. 웹에서만 살 수 있고, 프리미엄이 끝나면 늘어난 공간은 동결돼요.', 'Adds 10TB to Premium storage for one year. Web only; frozen if Premium ends.')
              : t(
                  `클라우드 다운로드 ${formatBytes(p.amounts.cloud)} · 다운스트림 ${formatBytes(p.amounts.down)} · 업로드 ${formatBytes(p.amounts.up)}를 ${p.months === 12 ? '12개월 동안 매달' : '구매한 달에'} 더 드려요.`,
                  `Adds ${formatBytes(p.amounts.cloud)} cloud · ${formatBytes(p.amounts.down)} down · ${formatBytes(p.amounts.up)} up ${p.months === 12 ? 'every month for 12 months' : 'for this month'}.`,
                );
          const b = h('button', { class: 'btn sm', disabled: needPremium }, needPremium ? t('프리미엄 전용', 'Premium only') : t('구매', 'Buy'));
          b.onclick = () => buy(id, b);
          return h('div', { class: 'bl-addon' }, h('b', {}, productLabel(p)), h('p', {}, desc), h('div', { class: 'row' }, h('span', { class: 'bl-price', style: { fontSize: '18px' } }, money(p.payNow)), h('div', { class: 'spacer' }), b));
        }),
      );
    }
    paint();

    const status = d.premium
      ? h('span', { class: 'badge brand' }, t(`프리미엄 이용 중 · ${formatDate(d.premiumUntil, false)}까지`, `Premium until ${formatDate(d.premiumUntil, false)}`))
      : ctx.me
        ? h('span', { class: 'badge' }, t('무료 이용 중', 'Free plan'))
        : null;

    const left = h(
      'aside',
      { class: 'card bl-benefits' },
      h('h3', {}, t('프리미엄이면 이렇게 달라져요', 'What Premium unlocks')),
      h('ul', {}, ...BENEFITS(storage).map(([ic, txt]) => h('li', { html: `${icon(ic)}<span>${txt}</span>` }))),
      h('button', { class: 'btn block', onclick: () => openCompare(d.compare, d.tier) }, t('자세히 비교', 'Compare in detail')),
    );

    const right = h(
      'div',
      { class: 'col', style: { gap: '16px' } },
      h('section', { class: 'card' }, h('h3', { class: 'bl-section-title' }, t('멤버십 고르기', 'Choose a plan')), planCards),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h3', { class: 'bl-section-title', style: { margin: 0 } }, t('결제 수단', 'Payment method')), d.testMode ? h('span', { class: 'badge accent' }, t('테스트 결제', 'Test mode')) : null),
        methodList,
        d.testMode ? h('p', { class: 'small muted', style: { margin: '10px 0 0' } }, t('지금은 테스트 결제 모드라 실제로 청구되지 않아요.', 'Test mode: you will not be charged.')) : null,
        d.fx ? h('p', { class: 'small muted', style: { margin: '10px 0 0' } }, fxText(d.fx)) : null,
        d.available === false ? h('p', { class: 'small', style: { margin: '10px 0 0' } }, t('결제 시스템을 준비하고 있어요. 지금은 구매할 수 없습니다.', 'Payments are being set up. Purchases are not available right now.')) : null,
      ),
      h(
        'section',
        { class: 'card' },
        summary,
        h('p', { class: 'bl-agree' }, t('결제 버튼을 누르면 ', 'By paying you agree to the '), h('a', { href: '/policy/membership' }, t('미믹 멤버십 약관', 'Mimic membership terms')), t('에 동의하는 것으로 봅니다.', '.')),
        h(
          'div',
          { class: 'bl-links' },
          h('a', { href: '/drive/orders?tab=subs' }, t('구독 관리', 'Subscriptions')),
          h('a', { href: '/drive/orders?tab=orders' }, t('구매 기록', 'Purchase history')),
          h('a', { href: '#', onclick: (e) => (e.preventDefault(), callComponent('coupon', 'openCoupon')) }, t('쿠폰 코드 등록', 'Redeem a code')),
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('h3', { class: 'bl-section-title' }, t('구매 전에 확인해 주세요', 'Before you buy')),
        h(
          'ul',
          { class: 'bl-guide' },
          d.provider === 'paypal'
            ? h('li', {}, t('모든 금액은 미국 달러($)로, PayPal 로 결제됩니다. PayPal 계정이나 PayPal 결제창의 카드로 낼 수 있어요.', 'All prices are in US dollars ($) and paid with PayPal — your PayPal balance or a card in the PayPal checkout.'))
            : cur === 'USD'
            ? h('li', {}, t('해외 지역은 모든 금액을 미국 달러($)로 결제하며, 원화 가격을 그날 환율로 환산해 가격이 매일 조금씩 달라질 수 있어요. ', 'Outside Korea all prices are charged in US dollars ($), converted from our KRW prices at the daily exchange rate, so they may change slightly each day. '), fxText(d.fx))
            : h('li', {}, t('모든 금액은 원화(₩)로 결제됩니다.', 'All prices are charged in Korean won (₩).')),
          d.testMode
            ? h('li', {}, t('구독은 기간이 끝날 때마다 같은 수단으로 자동 청구되고, 청구 7일 전에 미리 알려 드려요. 구독 관리에서 언제든 자동 갱신을 끌 수 있고, 끈 뒤에도 남은 기간은 그대로 씁니다.', 'Plans renew automatically with the same method; we remind you 7 days before. Turn off auto-renewal anytime and keep the remaining time.'))
            : d.provider === 'paypal'
              ? h('li', {}, t('구독은 기간이 끝날 때마다 PayPal 로 자동 청구되고, 청구 7일 전에 미리 알려 드려요. 구독 관리(또는 PayPal 계정)에서 언제든 자동 갱신을 끌 수 있고, 끈 뒤에도 남은 기간은 그대로 씁니다.', 'Plans renew automatically through PayPal at the end of each period; we remind you 7 days before. Turn off auto-renewal anytime in Subscriptions (or your PayPal account) and keep the remaining time.'))
            : cur === 'USD'
              ? h('li', {}, t('해외 결제(해외 카드·PayPal·Alipay)로 산 구독은 결제한 기간만 이용하고 자동으로 청구되지 않아요. 기간이 끝나기 7일 전에 알려 드립니다.', 'Plans bought with overseas payments (international card, PayPal, Alipay) cover the paid period only and never renew automatically. We remind you 7 days before they end.'))
              : h('li', {}, t('카드로 결제한 구독은 결제창에서 등록한 카드로 기간이 끝날 때마다 자동 청구되고, 청구 7일 전에 미리 알려 드려요. 다른 수단으로 결제한 구독은 결제한 기간만 이용하고 자동으로 청구되지 않아요. 구독 관리에서 언제든 자동 갱신을 끌 수 있어요.', 'Card subscriptions renew automatically on the card you register at checkout; we remind you 7 days before. Other methods cover the paid period only. Turn off auto-renewal anytime in Subscriptions.')),
          h('li', {}, t('자동 갱신 결제가 실패하면 하루 간격으로 다시 시도하고, 3번 실패하면 자동 갱신이 멈춰요. 그때마다 알림과 이메일로 알려 드립니다.', 'If a renewal payment fails we retry daily; after 3 failures auto-renewal stops. We notify you each time.')),
          h('li', {}, t('첫 결제 할인은 구독 상품 중 처음 한 번만(월·연 합산) 적용돼요. 해지 후 다시 구독하면 정가로 결제됩니다.', 'The first-time discount applies to your first subscription only (monthly or annual). Re-subscribing is charged at the regular price.')),
          h('li', {}, t('1회 상품은 자동 결제되지 않으며, 이용 중인 멤버십이 있으면 그 기간 뒤로 이어서 늘어나요.', 'One-time passes never auto-renew and extend any current membership.')),
          h('li', {}, t(`프리미엄은 글로벌과 지역 두 등급이 있고 가입 지역에 따라 정해져요. 지금 표시된 가격은 ${d.tier === 'regional' ? '지역' : '글로벌'} 등급 기준입니다.`, `Premium has Global and Regional tiers set by your region. Prices shown are for the ${d.tier} tier.`)),
          h('li', {}, t('결제 후 혜택이 보이지 않으면 ', 'If benefits do not appear after paying, '), h('a', { href: '/contact' }, t('문의하기', 'contact us')), t('로 알려 주세요.', '.')),
        ),
      ),
      h('section', { class: 'card' }, h('h3', { class: 'bl-section-title' }, t('추가 상품', 'Add-ons')), addons),
    );

    root.replaceChildren(
      h(
        'div',
        { class: `bl-page ${site ? 'site' : ''}` },
        h('div', { class: 'bl-head' }, h(site ? 'h1' : 'h2', {}, t('미믹 프리미엄', 'Mimic Premium')), status),
        h('p', { class: 'bl-sub' }, t('더 큰 공간, 무제한 클라우드 다운로드, 원본 화질 재생을 한 번에.', 'More space, unlimited cloud downloads and original-quality playback.')),
        h('div', { class: 'bl-grid' }, left, right),
      ),
    );
  }
  await draw();
  return bus.on('billing:changed', draw);
}
