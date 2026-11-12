// 문의하기(K-01): 접수 → 지원 메일함(개발 모드는 outbox) + 접수 확인 메일
import { api, h, icon, t, toastError } from '/ui.js';
import { setup } from '/pages/help.js';

const CATS = [
  ['account', '계정·로그인', 'Account & login'],
  ['payment', '결제·환불', 'Billing & refunds'],
  ['download', '클라우드 다운로드', 'Cloud download'],
  ['playback', '재생', 'Playback'],
  ['share', '공유', 'Sharing'],
  ['bug', '오류 신고', 'Bug report'],
  ['partnership', '제휴·사업', 'Partnership'],
  ['other', '기타', 'Other'],
];

export async function render(root, ctx) {
  if (setup(ctx)) return;
  document.title = t('문의하기 — 미믹', 'Contact — Mimic');
  const u = ctx.user;
  const f = {
    name: h('input', { class: 'input', name: 'name', required: true, maxlength: 60, value: u?.name || '', autocomplete: 'name' }),
    email: h('input', { class: 'input', name: 'email', type: 'email', required: true, maxlength: 254, value: u?.email || '', autocomplete: 'email' }),
    category: h('select', { class: 'input', name: 'category' }, ...CATS.map(([v, ko, en]) => h('option', { value: v, selected: v === ctx.query.category }, t(ko, en)))),
    message: h('textarea', { class: 'input', name: 'message', required: true, minlength: 5, maxlength: 5000, rows: 7, placeholder: t('어떤 상황인지 자세히 적어 주세요. 결제 문의는 결제 시각과 주문번호가 있으면 빨리 확인할 수 있어요.', 'Describe what happened. For billing, include the time and order number.') }),
  };
  // label 을 입력란과 연결한다(스크린리더가 칸 이름을 읽게)
  const field = (label, el, hint) => ((el.id ||= `contact-${el.name}`), h('div', { class: 'field' }, h('label', { for: el.id }, label), el, hint ? h('span', { class: 'hint' }, hint) : null));
  const submit = h('button', { class: 'btn primary lg', type: 'submit' }, t('보내기', 'Send'));
  const form = h(
    'form',
    { class: 'mc-form' },
    h('div', { class: 'two' }, field(t('이름', 'Name'), f.name), field(t('답변받을 이메일', 'Reply-to email'), f.email)),
    field(t('문의 종류', 'Topic'), f.category),
    field(t('내용', 'Message'), f.message),
    h('p', { class: 'muted small' }, t('보내 주신 이름·이메일·내용은 답변을 위해서만 쓰고, 처리 후 법정 기간이 지나면 지워요.', 'We use your name, email and message only to reply.'), ' ', h('a', { href: '/policy/privacy' }, t('개인정보처리방침', 'Privacy policy'))),
    submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const r = await api('/api/content/contact', { method: 'POST', body: { name: f.name.value, email: f.email.value, category: f.category.value, message: f.message.value } });
      form.replaceWith(
        h(
          'div',
          { class: 'mc-form mc-ok', html: icon('check') },
          h('h2', {}, t('문의가 접수되었어요', 'Message received')),
          h('p', { class: 'muted' }, t(`접수번호 ${r.id}. 영업일 기준 2일 안에 ${f.email.value} 로 답변드릴게요.`, `Ticket ${r.id}. We will reply to ${f.email.value} within 2 business days.`)),
          h('a', { class: 'btn', href: '/help' }, t('도움말 센터로', 'Go to Help center')),
        ),
      );
    } catch (err) {
      toastError(err);
      submit.disabled = false;
    }
  });
  const mail = h('p', { class: 'muted small', style: { textAlign: 'center', marginTop: '16px' } });
  api('/api/content/support')
    .then((r) => mail.append(t('이메일로도 받아요: ', 'Or email us: '), h('a', { href: `mailto:${r.email}` }, r.email)))
    .catch(() => {});
  root.replaceChildren(
    h('div', { class: 'mc-page-title' }, h('span', { class: 'mc-eyebrow' }, 'Contact'), h('h1', {}, t('문의하기', 'Contact us')), h('p', { class: 'mc-lead', style: { margin: '0 auto' } }, t('먼저 도움말과 자주 묻는 질문을 확인하면 더 빨리 해결될 수 있어요.', 'The Help center and FAQ may answer you faster.'))),
    h(
      'div',
      { class: 'container narrow' },
      h('div', { class: 'row', style: { justifyContent: 'center', marginBottom: '20px', flexWrap: 'wrap' } }, h('a', { class: 'btn', href: '/help' }, t('도움말 센터', 'Help center')), h('a', { class: 'btn', href: '/faq' }, t('자주 묻는 질문', 'FAQ')), h('a', { class: 'btn', href: '/copyright' }, t('신고·저작권', 'Report & copyright'))),
      form,
      mail,
    ),
  );
}
