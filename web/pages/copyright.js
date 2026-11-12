// 저작권 신고(J-02) + 일반 신고·이의제기(J-01). 탭: ?tab=copyright|report|appeal, 미리 채우기: ?type=share&target=...
import { api, h, icon, t, toastError } from '/ui.js';
import { setup } from '/pages/help.js';

const TYPES = [
  ['share', '공유 링크', 'Share link'],
  ['file', '파일', 'File'],
  ['url', '웹 주소·마그넷', 'URL or magnet'],
  ['user', '사용자', 'User'],
];
export const REASONS = [
  ['copyright', '저작권 침해', 'Copyright'],
  ['child', '아동 보호', 'Child safety'],
  ['illegal_filming', '불법 촬영물', 'Non-consensual imagery'],
  ['adult', '음란물', 'Sexual content'],
  ['violence', '폭력·혐오', 'Violence or hate'],
  ['malware', '악성코드·피싱', 'Malware or phishing'],
  ['spam', '스팸·사기', 'Spam or scam'],
  ['privacy', '개인정보 노출', 'Privacy'],
  ['other', '기타', 'Other'],
];
const TABS = [
  ['copyright', '저작권 신고', 'Copyright notice'],
  ['report', '콘텐츠 신고', 'Report content'],
  ['appeal', '이의제기', 'Appeal'],
];

const field = (label, el, hint) => h('div', { class: 'field' }, h('label', {}, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
const select = (name, opts, value) => h('select', { class: 'input', name }, ...opts.map(([v, ko, en]) => h('option', { value: v, selected: v === value }, t(ko, en))));

function done(form, id, msg) {
  form.replaceWith(h('div', { class: 'mc-form mc-ok', html: icon('check') }, h('h2', {}, t('접수되었어요', 'Received')), h('p', { class: 'muted' }, t(`접수번호 ${id}. `, `Reference ${id}. `), msg)));
}
function onSubmit(form, fn) {
  const btn = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      toastError(err);
      btn.disabled = false;
    }
  });
}

function copyrightForm(ctx) {
  const f = {
    claimant: h('input', { class: 'input', required: true, maxlength: 120, value: ctx.user?.name || '' }),
    email: h('input', { class: 'input', type: 'email', required: true, value: ctx.user?.email || '' }),
    agent: h('input', { type: 'checkbox' }),
    work: h('textarea', { class: 'input', required: true, maxlength: 2000, rows: 3, placeholder: t('예: 영화 「제목」(2026), 정식 배포처 주소', 'e.g. Film "Title" (2026), official source URL') }),
    urls: h('textarea', { class: 'input', required: true, rows: 5, placeholder: t('침해 위치를 한 줄에 하나씩 (공유 링크, 마그넷, URL)', 'One location per line (share link, magnet, URL)') }),
    statement: h('input', { type: 'checkbox', required: true }),
  };
  if (ctx.query.target) f.urls.value = ctx.query.target;
  const form = h(
    'form',
    { class: 'mc-form' },
    h('div', { class: 'two' }, field(t('권리자 이름(회사명)', 'Rights holder'), f.claimant), field(t('연락받을 이메일', 'Contact email'), f.email)),
    h('label', { class: 'check', style: { marginBottom: '14px' } }, f.agent, t('권리자를 대리해 신고합니다', 'I am filing on behalf of the rights holder')),
    field(t('저작물 설명', 'Copyrighted work'), f.work),
    field(t('침해 위치', 'Infringing locations'), f.urls, t('최대 100개까지 적을 수 있어요.', 'Up to 100.')),
    h(
      'label',
      { class: 'check', style: { alignItems: 'flex-start', marginBottom: '18px' } },
      f.statement,
      h('span', {}, t('저는 이 저작물의 권리자이거나 권리자로부터 위임받았으며, 위 내용이 사실임을 확인합니다. 거짓 신고에 따른 책임은 신고인에게 있음을 이해합니다.', 'I own or am authorized to act for the rights in this work, and the information above is accurate. I understand I am responsible for false claims.')),
    ),
    h('button', { class: 'btn primary lg', type: 'submit' }, t('저작권 신고 보내기', 'Submit notice')),
  );
  onSubmit(form, async () => {
    const r = await api('/api/content/copyright', {
      method: 'POST',
      body: { claimant: f.claimant.value, email: f.email.value, agent: f.agent.checked, work: f.work.value, urls: f.urls.value.split('\n').map((x) => x.trim()).filter(Boolean), statement: f.statement.checked },
    });
    done(form, r.id, t('접수 확인 메일을 보냈어요. 검토가 끝나면 결과를 이메일로 알려 드릴게요.', 'We emailed a confirmation and will send the outcome by email.'));
  });
  return form;
}

function reportForm(ctx, kind) {
  const appeal = kind === 'appeal';
  const f = {
    targetType: select('targetType', TYPES, ctx.query.type || (appeal ? 'url' : 'share')),
    target: h('input', { class: 'input', required: true, maxlength: 2000, value: ctx.query.target || '', placeholder: t('공유 링크, 파일 ID, URL, 사용자 이메일 등', 'Share link, file ID, URL, user email…') }),
    reason: appeal ? null : select('reason', REASONS, ctx.query.reason || 'copyright'),
    detail: h('textarea', { class: 'input', rows: 5, maxlength: 5000, placeholder: appeal ? t('차단이 잘못되었다고 생각하는 이유를 적어 주세요.', 'Why do you think the block is a mistake?') : t('어떤 문제가 있는지 적어 주세요(선택).', 'Describe the problem (optional).') }),
    email: ctx.user ? null : h('input', { class: 'input', type: 'email', required: appeal, placeholder: appeal ? '' : t('결과를 받으려면 입력(선택)', 'Optional, to get the outcome') }),
  };
  const form = h(
    'form',
    { class: 'mc-form' },
    h('div', { class: 'two' }, field(appeal ? t('차단된 대상', 'Blocked item') : t('신고 대상', 'What are you reporting?'), f.targetType), f.reason ? field(t('사유', 'Reason'), f.reason) : h('div')),
    field(t('주소 또는 식별값', 'Link or identifier'), f.target),
    field(appeal ? t('이의 내용', 'Your appeal') : t('자세한 내용', 'Details'), f.detail),
    f.email ? field(t('이메일', 'Email'), f.email) : h('p', { class: 'muted small' }, t('처리 결과는 알림으로 알려 드려요.', 'We will notify you of the outcome.')),
    h('button', { class: 'btn primary lg', type: 'submit' }, appeal ? t('이의제기 보내기', 'Submit appeal') : t('신고 보내기', 'Submit report')),
  );
  onSubmit(form, async () => {
    const body = { kind, targetType: f.targetType.value, target: f.target.value, detail: f.detail.value };
    if (f.reason) body.reason = f.reason.value;
    if (f.email?.value) body.email = f.email.value;
    const r = await api('/api/content/reports', { method: 'POST', body });
    done(form, r.id, t('담당자가 확인한 뒤 조치하고 결과를 알려 드릴게요.', 'Our team will review it and let you know.'));
  });
  return form;
}

export async function render(root, ctx) {
  if (setup(ctx)) return;
  const tab = TABS.some(([k]) => k === ctx.query.tab) ? ctx.query.tab : 'copyright';
  document.title = t('신고·저작권 — 미믹', 'Reports & copyright — Mimic');
  const keep = (k) => `/copyright?tab=${k}`;
  const intro = {
    copyright: t('내가 권리를 가진 저작물이 미믹에서 허락 없이 공유되고 있다면 알려 주세요. 확인 후 해당 링크·infohash·파일을 차단하고, 반복 침해자는 이용을 제한해요.', 'If your work is shared on Mimic without permission, tell us. We block the links, infohashes and files, and restrict repeat infringers.'),
    report: t('불법 촬영물, 아동 학대물, 악성 파일, 사기 등 유해한 공유를 발견하면 알려 주세요. 로그인하지 않아도 신고할 수 있어요. 아동 보호 신고는 가장 먼저 처리해요.', 'Report illegal or harmful content. No login needed. Child-safety reports are handled first.'),
    appeal: t('내 링크·공유·계정이 잘못 차단되었다고 생각되면 다시 검토를 요청하세요. 클라우드 다운로드 작업이 막혔다면 전송 패널의 작업 상세에서도 이의제기할 수 있어요.', 'If your link, share or account was blocked by mistake, ask us to review it. Blocked cloud-download tasks can also be appealed from the transfer panel.'),
  }[tab];
  root.replaceChildren(
    h('div', { class: 'mc-page-title' }, h('span', { class: 'mc-eyebrow' }, 'Trust & safety'), h('h1', {}, t('신고·저작권', 'Reports & copyright'))),
    h(
      'div',
      { class: 'container narrow' },
      h('nav', { class: 'tabs' }, ...TABS.map(([k, ko, en]) => h('a', { href: keep(k), class: k === tab ? 'active' : '' }, t(ko, en)))),
      h('div', { class: 'mc-note brand', style: { marginBottom: '18px' }, html: icon('info') }, h('div', {}, intro)),
      tab === 'copyright' ? copyrightForm(ctx) : reportForm(ctx, tab),
      h(
        'p',
        { class: 'muted small', style: { marginTop: '16px' } },
        h('a', { href: '/policy/copyright' }, t('저작권 정책', 'Copyright policy')),
        ' · ',
        h('a', { href: '/policy/child-safety' }, t('아동 보호 정책', 'Child safety')),
        ' · ',
        h('a', { href: '/transparency' }, t('투명성 보고서', 'Transparency report')),
      ),
    ),
  );
}
