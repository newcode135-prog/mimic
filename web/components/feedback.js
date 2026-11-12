// 피드백 보내기 창(H-05). 레이아웃의 계정 메뉴가 callComponent('feedback', 'openFeedback') 로 연다
import { api, h, t, modal, toast, getMe, loadCss } from '/ui.js';

const CATEGORIES = [
  ['bug', '오류 신고', 'Something is broken'],
  ['feature', '기능 제안', 'Feature idea'],
  ['download', '클라우드 다운로드', 'Cloud download'],
  ['playback', '재생·미리보기', 'Playback & preview'],
  ['account', '계정·로그인', 'Account & login'],
  ['payment', '결제·쿼터', 'Billing & quota'],
  ['other', '기타', 'Other'],
];

export async function openFeedback() {
  loadCss('/css/auth.css');
  const me = await getMe().catch(() => null);
  const category = h('select', { class: 'input' }, ...CATEGORIES.map(([v, ko, en]) => h('option', { value: v }, t(ko, en))));
  const message = h('textarea', {
    class: 'input',
    maxlength: 2000,
    rows: 6,
    placeholder: t('불편했던 점이나 있었으면 하는 기능을 편하게 적어 주세요. 어느 화면에서 무엇을 하다가 생긴 일인지 알려 주시면 더 빨리 살펴볼 수 있어요.', 'Tell us what went wrong or what you would like. Mention the screen and what you were doing.'),
  });
  const count = h('div', { class: 'hint' }, '0 / 2000');
  message.oninput = () => (count.textContent = `${message.value.length} / 2000`);
  const contact = h('input', { class: 'input', maxlength: 200, value: me?.user?.email || me?.user?.phone || '', placeholder: t('답변 받을 이메일 또는 번호', 'Email or phone for a reply') });
  const field = (label, control, extra) => h('div', { class: 'field' }, h('label', {}, label), control, extra);
  modal({
    title: t('피드백 보내기', 'Send feedback'),
    body: h(
      'div',
      { class: 'feedback-form' },
      h('p', { class: 'small muted' }, t('보내 주신 의견은 미믹 팀이 하나하나 읽고 다음 개선에 반영해요.', 'The Mimic team reads every message.')),
      field(t('분류', 'Category'), category),
      field(t('내용', 'Message'), message, count),
      field(t('연락처(선택)', 'Contact (optional)'), contact),
    ),
    actions: [
      { label: t('취소', 'Cancel') },
      {
        label: t('보내기', 'Send'),
        kind: 'primary',
        onClick: async () => {
          if (message.value.trim().length < 5) {
            toast(t('내용을 5자 이상 적어 주세요', 'Please write at least 5 characters'), 'error');
            return false;
          }
          await api('/api/auth/feedback', { method: 'POST', body: { category: category.value, message: message.value.trim(), contact: contact.value.trim() || undefined } });
          toast(t('의견 고마워요! 잘 받았어요', 'Thanks! We got your feedback'), 'ok');
        },
      },
    ],
  });
}
