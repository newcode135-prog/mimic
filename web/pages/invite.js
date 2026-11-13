// 친구 초대·보상(/drive/invite). I-04 초대 보상, I-05 추천 보상 Pro(스스로 전환·현금 보상·출금 요청)
import { api, h, t, toast, toastError, modal, confirmDialog, formatBytes, formatDate, loadCss, icon } from '/ui.js';
import { formatMoney } from '/pages/payment.js';

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('복사했어요', 'Copied'), 'ok');
  } catch {
    toast(t('복사하지 못했어요. 직접 선택해 복사해 주세요', 'Could not copy. Please copy it manually'), 'error');
  }
}
const copyRow = (value, label) => h('div', { class: 'bl-copy' }, h('input', { class: 'input', value, readonly: true, 'aria-label': label, onfocus: (e) => e.target.select() }), h('button', { class: 'btn primary', html: `${icon('copy')}<span>${t('복사', 'Copy')}</span>`, onclick: () => copy(value) }));

// ---------- 추천 보상 Pro(I-05) ----------
// 금액은 최소 단위(원·센트)
const minText = (pro) => `${formatMoney(pro.minWithdraw.KRW, 'KRW')} / ${formatMoney(pro.minWithdraw.USD, 'USD')}`;
const LEDGER = { reward: ['친구 결제 보상', 'Friend purchase'], release: ['보류됐던 보상 지급', 'Held reward released'], refund: ['환불로 회수', 'Taken back (refund)'], revoke: ['부정 참여로 회수', 'Taken back (abuse)'] };
const WD_STATUS = { pending: ['처리 중', 'Processing', 'accent'], paid: ['보냄', 'Sent', 'brand'], rejected: ['반려', 'Rejected', 'danger'] };

async function upgradePro(pro, done) {
  const ok = await confirmDialog(
    t('추천 보상 Pro로 전환할까요?', 'Upgrade to Referral Pro?'),
    t(
      `전환하면 이후 초대 보상은 프리미엄 일수 대신 현금(친구 결제 금액의 ${pro.cashPercent}%)으로만 받아요. 이미 받은 프리미엄 일수는 그대로지만, 전환은 되돌릴 수 없어 다시 프리미엄 일수 보상으로 바꿀 수 없어요.`,
      `From now on, invite rewards are paid in cash (${pro.cashPercent}% of what your friend pays) instead of Premium days. Days you already earned stay, but this cannot be undone: you can never switch back to Premium-day rewards.`,
    ),
    { okLabel: t('되돌릴 수 없음을 알고 전환', 'I understand, upgrade'), danger: true },
  );
  if (!ok) return;
  try {
    await api('/api/billing/invite/pro/upgrade', { method: 'POST', body: { confirm: true } });
    toast(t('추천 보상 Pro로 전환했어요', 'You are now on Referral Pro'), 'ok');
    done();
  } catch (e) {
    toastError(e);
  }
}

function openWithdraw(b, min, done) {
  const usd = b.currency === 'USD';
  const amount = h('input', { class: 'input', type: 'number', min: usd ? min / 100 : min, max: usd ? b.available / 100 : b.available, step: usd ? '0.01' : '1', value: usd ? (b.available / 100).toFixed(2) : b.available });
  const payout = h('textarea', { class: 'input', rows: 3, maxlength: 300, placeholder: t('PayPal 이메일, 또는 은행 이름·계좌번호·예금주', 'PayPal email, or bank name, account number and holder') });
  const field = (label, el) => h('div', { class: 'field' }, h('label', {}, label), el);
  modal({
    title: t('현금 보상 출금', 'Withdraw cash rewards'),
    body: h(
      'div',
      {},
      field(t(`금액 (출금 가능 ${formatMoney(b.available, b.currency)})`, `Amount (available ${formatMoney(b.available, b.currency)})`), amount),
      field(t('받을 곳', 'Send to'), payout),
      h('p', { class: 'small muted' }, t(`${formatMoney(min, b.currency)}부터 출금할 수 있어요. 운영팀이 확인한 뒤 보내 드리고 결과를 알림과 이메일로 알려 드려요.`, `Minimum ${formatMoney(min, b.currency)}. Our team reviews the request, sends the money and lets you know by notification and email.`)),
    ),
    actions: [
      { label: t('취소', 'Cancel') },
      {
        label: t('출금 요청', 'Request withdrawal'),
        kind: 'primary',
        onClick: async () => {
          const n = Math.round(Number(amount.value) * (usd ? 100 : 1));
          await api('/api/billing/invite/pro/withdrawals', { method: 'POST', body: { currency: b.currency, amount: n, payout: payout.value } });
          toast(t('출금 요청을 받았어요', 'Withdrawal requested'), 'ok');
          done();
        },
      },
    ],
  });
}

function proSection(pro, redraw) {
  const title = h('h3', { class: 'bl-section-title', style: { margin: 0 } }, t('추천 보상 Pro', 'Referral Pro'));
  if (!pro.pro) {
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, title, h('div', { class: 'spacer' }), h('button', { class: 'btn primary sm', onclick: () => upgradePro(pro, redraw) }, t('Pro로 전환', 'Upgrade to Pro'))),
      h(
        'p',
        { class: 'small muted', style: { margin: '8px 0 0' } },
        t(
          `Pro로 전환하면 친구가 프리미엄을 결제할 때마다 프리미엄 일수 대신 결제 금액의 ${pro.cashPercent}%를 그 결제 통화의 현금으로 적립해요. 적립금은 ${minText(pro)}부터 PayPal이나 은행 계좌로 출금할 수 있어요. 승인 없이 바로 전환되지만, 되돌릴 수 없어요.`,
          `With Pro, every time a friend pays for Premium you earn ${pro.cashPercent}% of the amount in cash (in the currency they paid) instead of Premium days. Withdraw from ${minText(pro)} to PayPal or a bank account. Upgrading is instant with no approval, but it cannot be undone.`,
        ),
      ),
    );
  }
  // 적립한 적이 있거나 내 통화인 잔액만
  const shown = pro.balances.filter((b) => b.earned || b.pending || b.paid || b.currency === pro.currency);
  const balances = h(
    'div',
    { class: 'bl-stats' },
    ...shown.map((b) => {
      const min = pro.minWithdraw[b.currency];
      return h(
        'div',
        { class: 'bl-stat', style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' } },
        h('b', {}, formatMoney(b.available, b.currency)),
        h('span', {}, t('출금 가능', 'Available')),
        h('span', { class: 'small muted' }, t(`처리 중 ${formatMoney(b.pending, b.currency)} · 보냄 ${formatMoney(b.paid, b.currency)}`, `Processing ${formatMoney(b.pending, b.currency)} · Sent ${formatMoney(b.paid, b.currency)}`)),
        h('button', { class: 'btn sm', style: { marginTop: '6px' }, disabled: b.available < min, title: b.available < min ? t(`${formatMoney(min, b.currency)}부터 출금할 수 있어요`, `Minimum ${formatMoney(min, b.currency)}`) : '', onclick: () => openWithdraw(b, min, redraw) }, t('출금', 'Withdraw')),
      );
    }),
  );
  const tableOf = (cols, rows, empty) =>
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, t(...c))))), h('tbody', {}, ...rows))) : h('p', { class: 'muted small', style: { margin: 0 } }, empty);
  const ledger = tableOf(
    [['날짜', 'Date'], ['내용', 'Details'], ['금액', 'Amount']],
    pro.ledger.map((x) => h('tr', {}, h('td', {}, formatDate(x.createdAt)), h('td', {}, t(...(LEDGER[x.reason] || [x.reason, x.reason]))), h('td', {}, `${x.amount > 0 ? '+' : '−'}${formatMoney(Math.abs(x.amount), x.currency)}`))),
    t('아직 적립한 현금 보상이 없어요.', 'No cash rewards yet.'),
  );
  const withdrawals = tableOf(
    [['요청일', 'Requested'], ['금액', 'Amount'], ['받을 곳', 'Send to'], ['상태', 'Status'], ['메모', 'Note']],
    pro.withdrawals.map((w) => {
      const [ko, en, cls] = WD_STATUS[w.status] || [w.status, w.status, ''];
      return h('tr', {}, h('td', {}, formatDate(w.createdAt)), h('td', {}, formatMoney(w.amount, w.currency)), h('td', { class: 'small' }, w.payout), h('td', {}, h('span', { class: `badge ${cls}` }, t(ko, en))), h('td', { class: 'small' }, w.note || ''));
    }),
    t('출금 요청 내역이 없어요.', 'No withdrawal requests yet.'),
  );
  return h(
    'section',
    { class: 'card col', style: { gap: '12px' } },
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, title, h('span', { class: 'badge brand' }, t('Pro 회원', 'Pro member'))),
    h(
      'p',
      { class: 'small muted', style: { margin: 0 } },
      t(
        `친구가 결제할 때마다 결제 금액의 ${pro.cashPercent}%를 현금으로 적립해요. ${minText(pro)}부터 출금할 수 있고, 친구의 결제가 환불되거나 부정 참여로 확인되면 그 보상은 회수돼요(이미 출금했다면 이후 적립금에서 빠져요).`,
        `You earn ${pro.cashPercent}% of each payment your friends make, in cash. Withdraw from ${minText(pro)}. Rewards from refunded or fraudulent purchases are taken back (deducted from future earnings if already withdrawn).`,
      ),
    ),
    balances,
    h('b', {}, t('적립 내역', 'Reward history')),
    ledger,
    h('b', {}, t('출금 내역', 'Withdrawals')),
    withdrawals,
  );
}

export async function render(root, ctx) {
  loadCss('/css/billing.css');
  async function draw() {
    const [d, pro] = await Promise.all([api('/api/billing/invite'), api('/api/billing/invite/pro')]);
    const link = location.origin + d.link;
    const r = d.rules;
    const rate = Math.round(r.shareRate * 100);

    const hero = h(
      'section',
      { class: 'card bl-hero' },
      h('h2', {}, pro.pro ? t(`친구가 프리미엄을 결제하면, 결제 금액의 ${pro.cashPercent}%가 내 현금 보상으로`, `Earn ${pro.cashPercent}% of what your friends pay for Premium, in cash`) : t(`친구가 프리미엄을 사면, 그 기간의 ${rate}%가 내 프리미엄으로`, `Earn ${rate}% of the Premium days your friends buy`)),
      h('p', { class: 'muted' }, t(`친구가 가입 후 1년 안에 결제할 때마다 보상이 바로 쌓여요. 같은 달에 초대한 친구 ${r.uploadBonusEvery}명이 구매할 때마다 업로드 쿼터 ${formatBytes(r.uploadBonus)}도 더 드려요.`, `Rewards land right after each purchase within a year of sign-up, plus ${formatBytes(r.uploadBonus)} upload quota for every ${r.uploadBonusEvery} buyers invited in the same month.`)),
      h('div', { class: 'field', style: { margin: '12px 0 0' } }, h('label', {}, t('내 초대 링크', 'My invite link')), copyRow(link, t('초대 링크', 'Invite link'))),
      h('div', { class: 'field', style: { margin: '8px 0 0' } }, h('label', {}, t('내 추천인 코드', 'My referral code')), copyRow(d.inviteCode, t('추천인 코드', 'Referral code'))),
    );

    const ways = h(
      'section',
      {},
      h('h3', { class: 'bl-section-title' }, t('초대하는 세 가지 방법', 'Three ways to invite')),
      h(
        'div',
        { class: 'bl-ways' },
        h('div', { class: 'card bl-way' }, h('div', { html: icon('link') }), h('b', {}, t('설치 링크 보내기', 'Send the link')), h('p', {}, t('초대 링크로 들어와 가입하면 자동으로 내 초대로 기록돼요.', 'Friends who sign up through your link are linked to you automatically.')), h('button', { class: 'btn sm', onclick: () => copy(link) }, t('링크 복사', 'Copy link'))),
        h('div', { class: 'card bl-way' }, h('div', { html: icon('share') }), h('b', {}, t('파일 공유와 함께', 'Share a file')), h('p', {}, t('드라이브에서 파일을 공유할 때 공유 링크와 함께 내 초대 링크를 보내 보세요.', 'When you share files, send your invite link along with the share link.')), h('a', { class: 'btn sm', href: '/drive/all' }, t('드라이브로', 'Go to drive'))),
        h('div', { class: 'card bl-way' }, h('div', { html: icon('ticket') }), h('b', {}, t('추천인 코드 알려 주기', 'Share your code')), h('p', {}, t(`친구가 가입하고 ${r.bindHours}시간 안에 초대 화면에서 내 코드를 입력하면 돼요.`, `Friends can enter your code on this page within ${r.bindHours} hours of signing up.`)), h('button', { class: 'btn sm', onclick: () => copy(d.inviteCode) }, t('코드 복사', 'Copy code'))),
      ),
    );

    let bind = null;
    if (d.canBind) {
      const input = h('input', { class: 'input', placeholder: t('친구에게 받은 추천인 코드', "Your friend's code"), maxlength: 64, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
      const btn = h('button', { class: 'btn primary' }, t('등록', 'Apply'));
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api('/api/billing/invite/bind', { method: 'POST', body: { code: input.value.replace(/\s/g, '') } });
          toast(t('추천인 코드를 등록했어요', 'Referral code applied'), 'ok');
          draw();
        } catch (e) {
          toastError(e);
          btn.disabled = false;
        }
      };
      bind = h('section', { class: 'card' }, h('h3', { class: 'bl-section-title' }, t('받은 추천인 코드가 있나요?', 'Got a referral code?')), h('p', { class: 'small muted' }, t(`가입 후 ${r.bindHours}시간 안에 한 번만 등록할 수 있어요.`, `You can enter one code within ${r.bindHours} hours of signing up.`)), h('div', { class: 'bl-copy' }, input, btn));
    }

    const s = d.stats;
    const stats = h(
      'div',
      { class: 'bl-stats' },
      h('div', { class: 'bl-stat' }, h('b', {}, String(s.invited)), h('span', {}, t('초대한 친구', 'Friends invited'))),
      h('div', { class: 'bl-stat' }, h('b', {}, String(s.purchased)), h('span', {}, t('구매한 친구', 'Friends who bought'))),
      h('div', { class: 'bl-stat' }, h('b', {}, t(`${s.rewardDays}일`, `${s.rewardDays}d`)), h('span', {}, t('받은 프리미엄', 'Premium earned'))),
      h('div', { class: 'bl-stat' }, h('b', {}, formatBytes(s.uploadBonusThisMonth)), h('span', {}, t('이번 달 업로드 보너스', 'Upload bonus this month'))),
    );

    const records = h(
      'section',
      { class: 'card' },
      h('h3', { class: 'bl-section-title' }, t('초대 기록', 'Invite history')),
      d.records.length
        ? h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'table' },
              h('thead', {}, h('tr', {}, ...[['친구', 'Friend'], ['초대된 날', 'Joined'], ['방법', 'Via'], ['구매', 'Bought'], ['받은 보상', 'Reward']].map((x) => h('th', {}, t(...x))))),
              h(
                'tbody',
                {},
                ...d.records.map((x) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, x.name, x.suspicious ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, x.revoked ? t('보상 제외', 'No reward') : t('보상 보류 · 같은 기기 의심', 'Reward on hold · same device')) : null),
                    h('td', {}, formatDate(x.joinedAt, false)),
                    h('td', {}, x.via === 'signup' ? t('초대 링크', 'Link') : t('추천인 코드', 'Code')),
                    h('td', {}, x.purchased ? h('span', { class: 'badge brand' }, t('구매함', 'Yes')) : h('span', { class: 'muted' }, '—')),
                    h('td', {}, [x.rewardDays ? t(`${x.rewardDays}일`, `${x.rewardDays}d`) : '', x.rewardCash ? formatMoney(x.rewardCash, x.cashCurrency) : ''].filter(Boolean).join(' · ') || '—'),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted', style: { margin: 0 } }, t('아직 초대한 친구가 없어요. 위 링크를 보내 첫 초대를 시작해 보세요.', 'No invites yet. Share your link to get started.')),
    );

    const rules = h(
      'section',
      { class: 'card' },
      h('h3', { class: 'bl-section-title' }, t('보상 규칙', 'Reward rules')),
      h(
        'ul',
        { class: 'bl-guide' },
        h('li', {}, t(`친구가 가입하고 ${r.windowDays}일 안에 산 프리미엄 기간의 ${rate}%를 프리미엄 일수로 드려요. 소수점 아래는 반올림해서, 예를 들어 친구가 월 구독을 4번 결제하면 42일, 연간 구독이면 128일이에요.`, `You get ${rate}% (rounded) of the Premium days a friend buys within ${r.windowDays} days of joining — e.g. 42 days for four monthly payments, 128 days for an annual plan.`)),
        h('li', {}, t('구독, 1회 이용권, 유료 코드, 체험 코드 구매가 보상 대상이에요. 무료 코드나 이벤트로 받은 기간은 빠집니다.', 'Subscriptions, passes, paid codes and trial codes count. Free codes and gifted days do not.')),
        h('li', {}, t(`같은 달에 초대한 친구 중 ${r.uploadBonusEvery}명이 구매할 때마다 업로드 쿼터 ${formatBytes(r.uploadBonus)}를 드려요. 한 달 최대 ${formatBytes(r.uploadBonusMax)}이고 다음 달 말까지 쓸 수 있어요.`, `Every ${r.uploadBonusEvery} buyers invited in the same month add ${formatBytes(r.uploadBonus)} upload quota (up to ${formatBytes(r.uploadBonusMax)}/month), valid until the end of next month.`)),
        h('li', {}, t(`초대 관계는 친구가 가입하고 ${r.bindHours}시간 안에 맺어져야 인정돼요. 코드 등록 전에 친구가 먼저 결제했어도 보상에 들어가요.`, `The invite must be linked within ${r.bindHours} hours of sign-up. Purchases made before the code was entered still count.`)),
        h('li', {}, t('나와 같은 기기에서 가입한 친구는 보상을 보류하고 운영팀이 확인해요. 정상이면 보류한 보상을 드리고, 부정 참여면 이미 받은 보상도 거둡니다.', 'Friends who sign up on your device are held for review. Genuine invites get the held reward; abuse is excluded and reclaimed.')),
      ),
    );

    const proBox = proSection(pro, draw);

    root.replaceChildren(h('div', { class: 'bl-page col', style: { gap: '16px' } }, h('div', { class: 'bl-head', style: { margin: 0 } }, h('h2', {}, t('친구 초대', 'Invite friends'))), hero, ways, bind, stats, records, rules, proBox));
  }
  await draw();
}
