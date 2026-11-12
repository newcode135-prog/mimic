// 친구 초대·보상(/drive/invite). I-04 초대 보상, I-05 추천 보상 Pro
import { api, h, t, toast, toastError, modal, formatBytes, formatDate, loadCss, icon } from '/ui.js';

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('복사했어요', 'Copied'), 'ok');
  } catch {
    toast(t('복사하지 못했어요. 직접 선택해 복사해 주세요', 'Could not copy. Please copy it manually'), 'error');
  }
}
const copyRow = (value, label) => h('div', { class: 'bl-copy' }, h('input', { class: 'input', value, readonly: true, 'aria-label': label, onfocus: (e) => e.target.select() }), h('button', { class: 'btn primary', html: `${icon('copy')}<span>${t('복사', 'Copy')}</span>`, onclick: () => copy(value) }));

function openProForm(done) {
  const channel = h('input', { class: 'input', maxlength: 300, placeholder: t('예: 유튜브 채널 주소, 블로그, 커뮤니티', 'e.g. YouTube channel, blog, community') });
  const audience = h('input', { class: 'input', maxlength: 100, placeholder: t('예: 구독자 2만 명', 'e.g. 20k subscribers') });
  const contact = h('input', { class: 'input', maxlength: 200, placeholder: t('이메일 또는 메신저 아이디', 'Email or messenger ID') });
  const field = (label, el) => h('div', { class: 'field' }, h('label', {}, label), el);
  modal({
    title: t('추천 보상 Pro 신청', 'Apply for Referral Pro'),
    body: h('div', {}, field(t('홍보 채널', 'Channel'), channel), field(t('구독자·방문자 규모', 'Audience size'), audience), field(t('연락처', 'Contact'), contact), h('p', { class: 'small muted' }, t('보내 주신 정보는 Pro 심사에만 쓰고, 결과는 알림과 이메일로 알려 드려요.', 'We use this only to review your application.'))),
    actions: [
      { label: t('취소', 'Cancel') },
      {
        label: t('신청하기', 'Apply'),
        kind: 'primary',
        onClick: async () => {
          await api('/api/billing/invite/pro/apply', { method: 'POST', body: { channel: channel.value, audience: audience.value, contact: contact.value } });
          toast(t('신청을 받았어요. 검토 후 알려 드릴게요', 'Application received'), 'ok');
          done();
        },
      },
    ],
  });
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
      h('h2', {}, t(`친구가 프리미엄을 사면, 그 기간의 ${rate}%가 내 프리미엄으로`, `Earn ${rate}% of the Premium days your friends buy`)),
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
                    h('td', {}, x.rewardDays ? t(`${x.rewardDays}일`, `${x.rewardDays}d`) : '—'),
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

    const a = pro.application;
    const proStatus = { pending: ['검토 중', 'Under review', 'accent'], approved: ['승인됨', 'Approved', 'brand'], rejected: ['반려됨', 'Not approved', 'danger'] };
    const proBox = h(
      'section',
      { class: 'card' },
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('h3', { class: 'bl-section-title', style: { margin: 0 } }, t('추천 보상 Pro', 'Referral Pro')), a ? h('span', { class: `badge ${proStatus[a.status][2]}` }, t(proStatus[a.status][0], proStatus[a.status][1])) : null, h('div', { class: 'spacer' }), !a || a.status === 'rejected' ? h('button', { class: 'btn primary sm', onclick: () => openProForm(draw) }, t('신청하기', 'Apply')) : null),
      h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, t(pro.description.ko, pro.description.en)),
      a?.note ? h('p', { class: 'small', style: { margin: '8px 0 0' } }, t('운영팀 메모: ', 'Note: '), a.note) : null,
    );

    root.replaceChildren(h('div', { class: 'bl-page col', style: { gap: '16px' } }, h('div', { class: 'bl-head', style: { margin: 0 } }, h('h2', {}, t('친구 초대', 'Invite friends'))), hero, ways, bind, stats, records, rules, proBox));
  }
  await draw();
}
