// 공유 만들기 창(D-01·D-03·D-05). 다른 모듈이 callComponent('share', 'openShareDialog', fileIds)로 부른다.
import { api, h, t, modal, toast, toastError, loadCss, icon, fileIcon, formatBytes, formatDate, getMe } from '/ui.js';

export const EXPIRY_CHOICES = [
  [0, '영구', 'Never'],
  [7, '7일', '7 days'],
  [14, '14일', '14 days'],
  [30, '30일', '30 days'],
];
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export const genPassword = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => PW_CHARS[n % PW_CHARS.length]).join('');
export const shareUrl = (path) => location.origin + path;
export const expiryLabel = (ts) => (ts ? formatDate(ts) : t('영구', 'Never'));

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('복사했어요', 'Copied'), 'ok');
}
// 받는 사람에게 보낼 안내 문장(미믹 고유)
export const inviteText = (title, url, password) =>
  [t(`미믹으로 "${title}"을(를) 보냈어요.`, `Sent "${title}" with Mimic.`), `${t('링크', 'Link')}: ${url}`, password ? `${t('비밀번호', 'Password')}: ${password}` : null].filter(Boolean).join('\n');

// 만료 선택 칩. 값 읽기: el.value
export function expiryPicker(selected = 0, { keep = false } = {}) {
  const wrap = h('div', { class: 'share-chips', role: 'radiogroup' });
  wrap.value = keep ? undefined : selected;
  const opts = keep ? [[undefined, '그대로', 'Keep'], ...EXPIRY_CHOICES] : EXPIRY_CHOICES;
  for (const [days, ko, en] of opts) {
    const b = h('button', { type: 'button', class: `chip${days === wrap.value ? ' on' : ''}`, role: 'radio' }, t(ko, en));
    b.onclick = () => {
      wrap.value = days;
      wrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    };
    wrap.append(b);
  }
  return wrap;
}

// 비밀번호 스위치 + 코드 입력. el.read() → 문자열(새 비밀번호) | null(없음) | undefined(keep: 기존 비밀번호 유지)
// 비밀번호 원문은 저장하지 않으므로 수정 화면에서는 기존 값을 보여 주지 못하고 "새로 바꾸기"만 제공한다
export function passwordField(on = false, { keep = false } = {}) {
  const input = h('input', { class: 'input share-pw', maxlength: 16, value: genPassword(), 'aria-label': t('비밀번호', 'Password'), autocomplete: 'off' });
  const box = h('div', { class: 'row share-pw-row' }, input, h('button', { type: 'button', class: 'btn ghost icon-btn', title: t('새로 만들기', 'Regenerate'), html: icon('refresh'), onclick: () => (input.value = genPassword()) }));
  const check = h('input', { type: 'checkbox', checked: on });
  const renew = keep ? h('input', { type: 'checkbox' }) : null;
  const renewLabel = keep ? h('label', { class: 'check small' }, renew, t('새 비밀번호로 바꾸기', 'Change to a new password')) : null;
  const sync = () => {
    box.classList.toggle('hidden', !check.checked || (renew && !renew.checked));
    renewLabel?.classList.toggle('hidden', !check.checked);
  };
  check.onchange = sync;
  if (renew) renew.onchange = sync;
  sync();
  const el = h(
    'div',
    { class: 'field' },
    h('label', { class: 'row' }, h('span', { class: 'spacer' }, t('비밀번호로 잠그기', 'Lock with password')), h('span', { class: 'switch' }, check, h('span'))),
    h('div', { class: 'hint' }, t('끄면 링크를 아는 사람은 누구나 열 수 있어요.', 'When off, anyone with the link can open it.')),
    renewLabel,
    box,
  );
  el.read = () => {
    if (!check.checked) return null;
    if (renew && !renew.checked) return undefined;
    const v = input.value.trim();
    if (!/^[A-Za-z0-9]{4,16}$/.test(v)) throw new Error(t('비밀번호는 영문·숫자 4~16자로 적어 주세요', 'Password must be 4-16 letters or digits'));
    return v;
  };
  return el;
}

export function viewModeField(value = 'grid') {
  const sel = h(
    'select',
    { class: 'input' },
    h('option', { value: 'list', selected: value === 'list' }, t('목록', 'List')),
    h('option', { value: 'grid', selected: value === 'grid' }, t('격자', 'Grid')),
  );
  return h('div', { class: 'field' }, h('label', {}, t('받는 사람이 처음 보는 방식', 'How recipients see it first')), sel);
}

// 공유 코드 입력(D-02). onSaved(code)
export function codeField(share, onSaved) {
  const input = h('input', { class: 'input', maxlength: 16, value: share.code || '', placeholder: t('예: trip2026!', 'e.g. trip2026!') });
  const err = h('div', { class: 'error' });
  const save = h('button', { class: 'btn sm', type: 'button' }, t('코드 저장', 'Save code'));
  save.onclick = async () => {
    err.textContent = '';
    try {
      const r = await api(`/api/share/${share.id}/code`, { method: 'POST', body: { code: input.value.trim() || null } });
      share.code = r.share.code;
      toast(r.share.code ? t('공유 코드를 저장했어요', 'Share code saved') : t('공유 코드를 지웠어요', 'Share code removed'), 'ok');
      onSaved?.(r.share.code);
    } catch (e) {
      err.textContent = e.message;
    }
  };
  return h(
    'div',
    { class: 'field' },
    h('label', {}, t('공유 코드(선택)', 'Share code (optional)')),
    h('div', { class: 'row' }, input, save),
    h('div', { class: 'hint' }, t('영문·숫자·기호(!@#$%^&*_-) 4~16자. 이 코드만 알려 줘도 공유를 찾을 수 있어요.', '4-16 letters, digits or !@#$%^&*_-. Others can find the share with this code.')),
    err,
  );
}

// 공유 결과(링크·비밀번호·복사·코드)
export function resultView(share, password) {
  const url = shareUrl(share.url);
  return h(
    'div',
    { class: 'share-result' },
    h('div', { class: 'share-done', html: `${icon('check')}<span>${t('공유 링크가 준비됐어요', 'Your share link is ready')}</span>` }),
    h('div', { class: 'field' }, h('label', {}, t('링크', 'Link')), h('div', { class: 'row' }, h('input', { class: 'input', readonly: true, value: url, onfocus: (e) => e.target.select() }), h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(url) }, t('복사', 'Copy')))),
    password ? h('div', { class: 'field' }, h('label', {}, t('비밀번호', 'Password')), h('div', { class: 'share-pw-show' }, password)) : null,
    h('p', { class: 'small muted' }, t(`만료: ${expiryLabel(share.expiresAt)}`, `Expires: ${expiryLabel(share.expiresAt)}`)),
    h('button', { class: 'btn primary block', type: 'button', html: `${icon('copy')}<span>${password ? t('링크와 비밀번호 함께 복사', 'Copy link with password') : t('안내 문장과 함께 복사', 'Copy with message')}</span>`, onclick: () => copyText(inviteText(share.title, url, password)) }),
    h('hr', { class: 'share-sep' }),
    codeField(share),
  );
}

async function summary(fileIds) {
  if (fileIds.length > 1) return h('div', { class: 'share-summary', html: `${icon('copy')}<b>${t(`${fileIds.length}개 항목`, `${fileIds.length} items`)}</b>` });
  try {
    const { file } = await api(`/api/drive/files/${encodeURIComponent(fileIds[0])}`);
    return h('div', { class: 'share-summary' }, h('span', { html: icon(fileIcon(file)) }), h('b', { class: 'share-name' }, file.name), file.kind === 'file' ? h('span', { class: 'muted small' }, formatBytes(file.size)) : null);
  } catch {
    return h('div', { class: 'share-summary', html: `${icon('file')}<b>${t('1개 항목', '1 item')}</b>` });
  }
}

// openShareDialog(fileIds) → 만든 공유(닫으면 null)
export async function openShareDialog(fileIds) {
  loadCss('/css/share.css');
  fileIds = [].concat(fileIds || []).filter(Boolean);
  if (!fileIds.length) return toast(t('공유할 파일을 골라 주세요', 'Select files to share'));
  // 설정에서 '공유 페이지 기본 보기'를 바꾼 직후에도 새 값을 쓰도록 캐시를 건너뛴다
  const me = await getMe(true).catch(() => null);
  const expiry = expiryPicker(0);
  const pw = passwordField(false);
  const view = viewModeField(me?.user?.settings?.shareDefaultView === 'list' ? 'list' : 'grid');
  const err = h('div', { class: 'error' });
  const body = h(
    'div',
    { class: 'share-dialog' },
    await summary(fileIds),
    h('div', { class: 'field' }, h('label', {}, t('만료', 'Expires')), expiry),
    pw,
    view,
    err,
  );
  let created = null;
  return new Promise((resolve) => {
    modal({
      title: t('공유하기', 'Share'),
      body,
      onClose: () => resolve(created),
      actions: [
        { label: t('취소', 'Cancel') },
        {
          label: t('공유 만들기', 'Create link'),
          kind: 'primary',
          onClick: async () => {
            err.textContent = '';
            let password;
            try {
              password = pw.read();
            } catch (e) {
              err.textContent = e.message;
              return false;
            }
            try {
              const r = await api('/api/share', { method: 'POST', body: { fileIds, expiryDays: expiry.value, password, viewMode: view.querySelector('select').value } });
              created = r.share;
              const box = body.closest('.modal');
              box.querySelector('.modal-foot')?.remove();
              box.querySelector('.modal-head h3').textContent = t('공유 링크', 'Share link');
              body.replaceChildren(resultView(r.share, r.password));
            } catch (e) {
              toastError(e);
            }
            return false;
          },
        },
      ],
    });
  });
}
