// 출석 체크 안내(I-06 안내 화면): 브라우저 확장으로 매일 출석하고 무료 프리미엄 받기 — 미믹 문장
import { api, h, icon, t } from '/ui.js';
import { setup } from '/pages/help.js';

export async function render(root, ctx) {
  if (setup(ctx)) return;
  document.title = t('출석 체크 안내 — 미믹', 'Daily check-in — Mimic');
  // 보상 규칙은 서버 값(plans.js CHECKIN)을 그대로 쓴다
  const n = await api('/api/content/numbers');
  const every = n.checkinEvery;
  const days = n.checkinDays;
  const step = (title, body, extra) => h('div', { class: 'mc-step' }, h('h3', {}, title), h('p', {}, body), extra || null);
  root.replaceChildren(
    h(
      'div',
      { class: 'mc-page-title' },
      h('span', { class: 'mc-eyebrow' }, 'Daily check-in'),
      h('h1', {}, t('매일 한 번, 출석하고 프리미엄 받기', 'Check in daily, earn Premium')),
      h('p', { class: 'mc-lead', style: { margin: '0 auto' } }, t(`미믹 브라우저 확장에서 하루 한 번 출석하고, ${every}일 연속으로 채울 때마다 프리미엄 ${days}일을 받아요.`, `Check in once a day in the Mimic browser extension. Every ${every} days in a row earns ${days} day(s) of Premium.`)),
    ),
    h(
      'div',
      { class: 'container' },
      h(
        'div',
        { class: 'mc-steps', style: { marginTop: '24px' } },
        step(t('확장 설치하기', 'Install the extension'), t('Chrome 또는 Edge에 미믹 확장을 설치해요. 스토어가 어렵다면 오프라인 설치 파일도 있어요.', 'Add the Mimic extension to Chrome or Edge, or use the offline package.'), h('a', { class: 'btn sm', href: '/apps/extension', style: { marginTop: '10px' } }, t('설치 안내 보기', 'How to install'))),
        step(t('미믹 계정으로 로그인', 'Sign in'), t('브라우저 도구 막대의 미믹 아이콘을 눌러 로그인해요. 이미 웹에서 로그인했다면 한 번 승인만 하면 돼요.', 'Click the Mimic icon in the toolbar and sign in, or just approve if you are already signed in on the web.')),
        step(t('매일 출석 버튼 누르기', 'Tap check-in daily'), t(`확장 창의 "출석 체크" 버튼을 눌러요. 연속 출석이 ${every}일을 채울 때마다 프리미엄 ${days}일이 바로 내 계정에 더해지고, 날짜는 한국 시간 자정에 바뀌어요.`, `Press "출석 체크" (Check in) in the extension. Each time your streak reaches a multiple of ${every} days, ${days} day(s) of Premium is added right away; the day resets at midnight KST.`)),
      ),
      h(
        'div',
        { class: 'card', style: { marginTop: '28px' } },
        h('h3', {}, t('알아 두세요', 'Good to know')),
        h(
          'ul',
          { class: 'doc' },
          h('li', {}, t('출석은 계정당 하루 한 번만 인정돼요.', 'One check-in per account per day.')),
          h('li', {}, t('하루라도 빠지면 연속 출석 일수가 처음부터 다시 시작돼요.', 'Missing a day resets your streak to zero.')),
          h('li', {}, t('출석 보상으로 받은 프리미엄은 현금으로 바꾸거나 환불할 수 없어요.', 'Check-in rewards cannot be exchanged for cash or refunded.')),
          h('li', {}, t('자동 클릭 프로그램이나 여러 계정을 이용한 출석은 보상이 회수될 수 있어요.', 'Rewards gained by bots or multiple accounts may be revoked.')),
          h('li', {}, t('보상 수치와 기간은 이벤트에 따라 바뀔 수 있고, 바뀌면 미리 알려 드려요.', 'Reward amounts may change; we will announce changes in advance.')),
        ),
      ),
      h('div', { class: 'mc-note brand', style: { marginTop: '16px' }, html: icon('gift') }, h('div', {}, t(`친구를 초대하면 친구가 산 프리미엄 일수의 ${n.refRate}%도 받을 수 있어요. `, `Invite friends and earn ${n.refRate}% of the Premium days they buy. `), h('a', { href: '/drive/invite' }, t('친구 초대하기', 'Invite friends')))),
    ),
  );
}
