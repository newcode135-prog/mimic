// 상단 "쿠폰 코드" 등록 창(I-03). openCoupon()
import { api, h, t, toast, modal, loadCss, getMe, bus } from '/ui.js';
import { refreshShell } from '/layout.js';

export async function openCoupon() {
  loadCss('/css/billing.css');
  if (!(await getMe())) {
    const { navigate } = await import('/app.js');
    return navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  const input = h('input', { class: 'input bl-coupon-input', placeholder: 'XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: 'false', maxlength: 40, 'aria-label': t('쿠폰 코드', 'Coupon code') });
  const close = modal({
    title: t('쿠폰 코드 등록', 'Redeem a coupon'),
    body: h(
      'div',
      {},
      h('div', { class: 'field' }, h('label', {}, t('쿠폰 코드', 'Coupon code')), input, h('span', { class: 'hint' }, t('미믹 공식 판매처나 제휴처에서 받은 코드만 쓸 수 있어요. 한 코드는 계정마다 한 번만 등록됩니다.', 'Only codes from Mimic or official partners work. Each code can be used once per account.'))),
      // ponytail: 코드 판매처(공식 판매처·제휴처)가 아직 정해지지 않아 구매처 링크 대신 사유를 밝힌다. 판매처가 생기면 그 목록 페이지로 연결
      h('p', { class: 'small' }, t('코드는 어디서 사나요? 공식 판매처와 제휴처는 정해지는 대로 이곳에 안내할게요. 지금은 코드 대신 ', 'Where to buy codes? Official resellers and partners will be listed here once confirmed. For now you can '), h('a', { href: '/pricing', onclick: () => close() }, t('프리미엄을 직접 결제', 'buy Premium directly')), t('할 수 있어요.', '.')),
      h('p', { class: 'small muted' }, t('등록하면 ', 'By redeeming you agree to the '), h('a', { href: '/policy/membership', onclick: () => close() }, t('미믹 멤버십 약관', 'Mimic membership terms')), t('에 동의하는 것으로 봅니다. 체험 코드는 끝나도 자동으로 결제되지 않아요.', '. Trial codes never auto-charge.')),
    ),
    actions: [
      { label: t('취소', 'Cancel') },
      {
        label: t('등록', 'Redeem'),
        kind: 'primary',
        onClick: async () => {
          if (!input.value.trim()) {
            input.focus();
            return false;
          }
          const r = await api('/api/billing/coupons/redeem', { method: 'POST', body: { code: input.value } });
          toast(t(`프리미엄 ${r.days}일이 추가되었어요`, `${r.days} days of Premium added`), 'ok');
          await refreshShell();
          bus.emit('billing:changed');
        },
      },
    ],
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.closest('.modal').querySelector('.btn.primary').click());
}
