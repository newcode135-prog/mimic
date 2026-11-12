// 계정 및 보안(/drive/account/:tab) — 7개 탭(H-02)
import { api, h, t, toast, toastError, confirmDialog, formatDate, clearMe, icon } from '/ui.js';
import { refreshShell } from '/layout.js';
import { phoneField, codeButton, codeInput, describeUA, field, pwValid, SCOPE_TEXT } from '/pages/login.js';

const TABS = [
  ['basic', '계정 정보', 'Profile'],
  ['password', '비밀번호', 'Password'],
  ['phone', '휴대폰', 'Phone'],
  ['email', '이메일', 'Email'],
  ['social', '소셜 계정', 'Social accounts'],
  ['apps', '연결된 앱', 'Connected apps'],
  ['delete', '계정 해제', 'Delete account'],
];
const PROVIDERS = [
  ['google', 'Google'],
  ['facebook', 'Facebook'],
  ['apple', 'Apple'],
];
const ERRORS = {
  identity_in_use: ['이미 다른 미믹 계정에 연결된 소셜 계정이에요', 'That social account belongs to another Mimic account'],
  already_linked: ['이미 연결된 공급자예요', 'Already linked'],
  oauth_state: ['연결 요청 시간이 지났어요. 다시 시도해 주세요', 'The request expired. Try again'],
  oauth_denied: ['연결을 취소했어요', 'Linking was cancelled'],
  oauth_session_mismatch: ['연결을 시작한 계정으로 로그인한 상태에서 다시 시도해 주세요', 'Log in with the account that started linking, then try again'],
  oauth_failed: ['연결하지 못했어요. 잠시 뒤 다시 시도해 주세요', 'Could not link. Try again later'],
};

function submitForm(children, label, onSubmit, cls = 'btn primary') {
  const btn = h('button', { class: cls, type: 'submit' }, label);
  const f = h('form', { class: 'account-form' }, ...children, btn);
  f.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await onSubmit();
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
    }
  };
  return f;
}
const card = (title, ...children) => h('section', { class: 'card account-card' }, h('h3', {}, title), ...children);
// 이미 연결된 연락처를 바꿀 때: 지금 연락처로 받은 코드 입력칸(없으면 null)
function oldCodeField(label, sendPath, has, timers) {
  if (!has) return { el: null, value: () => undefined };
  const input = codeInput();
  const send = codeButton(() => api(sendPath, { method: 'POST', body: { purpose: 'change' } }), timers);
  return { el: field(label, h('div', { class: 'auth-code-row' }, input, send)), value: () => input.value.trim() };
}
const current = (ic, text) => h('div', { class: 'account-current', html: icon(ic) }, h('span', {}, text));

// 업로드한 사진을 256px 정사각형 JPEG 로 줄인다(서버 한도 200KB)
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export async function render(root, ctx) {
  const tab = TABS.some(([k]) => k === ctx.params.tab) ? ctx.params.tab : 'basic';
  const timers = new Set();
  const acc = await api('/api/auth/account');
  const body = h('div', { class: 'account-body' });
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h2', {}, t('계정 및 보안', 'Account & security'))),
    h('nav', { class: 'tabs' }, ...TABS.map(([k, ko, en]) => h('a', { href: `/drive/account/${k}`, class: k === tab ? 'active' : null }, t(ko, en)))),
    body,
  );
  const reload = () => ctx.navigate(`/drive/account/${tab}`, { replace: true });
  await PANES[tab]({ body, acc, ctx, timers, reload });
  if (ctx.query.error) toast(t(...(ERRORS[ctx.query.error] || ERRORS.oauth_failed)), 'error');
  return () => timers.forEach(clearInterval);
}

const PANES = {
  async basic({ body, acc }) {
    const u = acc.user;
    let avatar = u.avatar;
    const pic = h('div', { class: 'account-avatar' });
    const paint = () => pic.replaceChildren(avatar ? h('img', { src: avatar, alt: '' }) : (u.name || u.email || 'M').trim().charAt(0).toUpperCase());
    paint();
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    file.onchange = async () => {
      if (!file.files[0]) return;
      try {
        avatar = await shrinkImage(file.files[0]);
        paint();
      } catch {
        toast(t('이미지를 읽지 못했어요', 'Could not read that image'), 'error');
      }
      file.value = '';
    };
    const name = h('input', { class: 'input', value: u.name || '', maxlength: 30, required: true });
    const facts = h(
      'dl',
      { class: 'account-facts' },
      ...[
        [t('이메일', 'Email'), u.email || t('연결 안 됨', 'Not linked')],
        [t('휴대폰', 'Phone'), u.phone || t('연결 안 됨', 'Not linked')],
        [t('가입일', 'Joined'), formatDate(u.createdAt, false)],
        [t('초대코드', 'Invite code'), u.inviteCode || '-'],
      ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
    );
    body.append(
      card(
        t('프로필', 'Profile'),
        submitForm(
          [
            h(
              'div',
              { class: 'row account-profile' },
              pic,
              h(
                'div',
                { class: 'col' },
                h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => file.click() }, t('사진 바꾸기', 'Change photo')), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => ((avatar = null), paint()) }, t('지우기', 'Remove'))),
                h('span', { class: 'small muted' }, t('가운데를 정사각형으로 잘라 작게 저장해요.', 'Cropped to a small square.')),
              ),
              file,
            ),
            field(t('사용자 이름', 'Display name'), name),
          ],
          t('저장', 'Save'),
          async () => {
            await api('/api/auth/account', { method: 'PATCH', body: { name: name.value.trim(), avatar } });
            toast(t('프로필을 저장했어요', 'Profile saved'), 'ok');
            await refreshShell();
          },
        ),
        facts,
      ),
    );

    const list = h('div', { class: 'account-table-wrap' }, h('div', { class: 'spinner' }));
    body.append(card(t('로그인한 기기', 'Signed-in devices'), h('p', { class: 'small muted' }, t('모르는 기기가 보이면 로그아웃시키고 비밀번호를 바꿔 주세요.', 'If you see a device you do not recognise, log it out and change your password.')), list));
    const load = async () => {
      const { items } = await api('/api/auth/sessions');
      list.replaceChildren(
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, t('기기', 'Device')), h('th', {}, 'IP'), h('th', {}, t('마지막 사용', 'Last active')), h('th', {}))),
          h(
            'tbody',
            {},
            ...items.map((s) =>
              h(
                'tr',
                {},
                h('td', {}, describeUA(s.userAgent)),
                h('td', {}, s.ip || '-'),
                h('td', {}, formatDate(s.lastSeenAt)),
                h(
                  'td',
                  { style: { textAlign: 'right' } },
                  s.current
                    ? h('span', { class: 'badge brand' }, t('지금 이 기기', 'This device'))
                    : h(
                        'button',
                        {
                          class: 'btn sm danger',
                          onclick: async () => {
                            try {
                              await api(`/api/auth/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
                              toast(t('그 기기를 로그아웃시켰어요', 'Logged out that device'), 'ok');
                              load();
                            } catch (e) {
                              toastError(e);
                            }
                          },
                        },
                        t('로그아웃', 'Log out'),
                      ),
                ),
              ),
            ),
          ),
        ),
      );
    };
    await load().catch(toastError);
  },

  password({ body, acc, reload }) {
    const has = acc.user.hasPassword;
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: 16, required: true });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: 16, required: true });
    const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: 16, required: true });
    body.append(
      card(
        has ? t('비밀번호 바꾸기', 'Change password') : t('비밀번호 만들기', 'Create a password'),
        has ? null : h('p', { class: 'muted' }, t('소셜 계정으로 가입해서 아직 비밀번호가 없어요. 만들어 두면 이메일·휴대폰 번호와 비밀번호로도 로그인할 수 있어요.', 'You signed up with a social account, so there is no password yet. Create one to also log in with email or phone.')),
        submitForm(
          [has ? field(t('지금 비밀번호', 'Current password'), cur) : null, field(t('새 비밀번호', 'New password'), pw, t('문자·숫자·기호를 섞어 6~16자', '6–16 characters mixing letters, numbers and symbols')), field(t('새 비밀번호 확인', 'Confirm'), pw2)],
          t('저장', 'Save'),
          async () => {
            if (!pwValid(pw.value)) return toast(t('비밀번호는 문자·숫자·기호를 섞어 6~16자로 정해 주세요', 'Use 6–16 characters mixing letters, numbers and symbols'), 'error');
            if (pw.value !== pw2.value) return toast(t('두 비밀번호가 서로 달라요', 'Passwords do not match'), 'error');
            await api('/api/auth/account/password', { method: 'POST', body: { current: has ? cur.value : undefined, password: pw.value } });
            toast(t('비밀번호를 저장했어요. 다른 기기는 로그아웃됐어요', 'Password saved. Other devices were logged out'), 'ok');
            reload();
          },
        ),
      ),
    );
  },

  phone({ body, acc, timers, reload }) {
    const pf = phoneField(t('+82', '+1'));
    const code = codeInput();
    const old = oldCodeField(t('지금 번호로 받은 인증코드', 'Code sent to your current number'), '/api/auth/phone/send-code', !!acc.user.phone, timers);
    const send = codeButton(async () => {
      const phone = pf.value();
      if (!phone) return toast(t('휴대폰 번호를 확인해 주세요', 'Check your phone number'), 'error'), false;
      await api('/api/auth/phone/send-code', { method: 'POST', body: { phone, purpose: 'bind' } });
    }, timers);
    body.append(
      card(
        t('휴대폰 번호', 'Phone number'),
        current('phone', acc.user.phone || t('연결된 번호가 없어요', 'No phone linked')),
        submitForm([old.el, field(t('새 번호', 'New number'), pf.el), field(t('새 번호로 받은 인증코드', 'Code sent to the new number'), h('div', { class: 'auth-code-row' }, code, send))], acc.user.phone ? t('번호 바꾸기', 'Change number') : t('번호 연결', 'Link number'), async () => {
          await api('/api/auth/account/phone', { method: 'POST', body: { phone: pf.value(), code: code.value.trim(), oldCode: old.value() } });
          toast(t('휴대폰 번호를 연결했어요', 'Phone linked'), 'ok');
          reload();
        }),
        acc.user.phone
          ? h('p', { class: 'small muted', style: { marginTop: '14px' } }, t('번호를 바꾸려면 지금 번호와 새 번호 양쪽에서 인증코드를 받아야 해요. 지금 번호를 더 쓸 수 없다면 ', 'Changing needs a code from both your current and new number. If you can no longer use your current number, contact '), h('a', { href: '/contact' }, t('고객지원', 'support')), t('으로 본인 확인 자료를 보내 주세요.', ' with proof of identity.'))
          : null,
      ),
    );
  },

  email({ body, acc, timers, reload }) {
    const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'name@example.com', required: true });
    const code = codeInput();
    const old = oldCodeField(t('지금 이메일로 받은 인증코드', 'Code sent to your current email'), '/api/auth/email/send-code', !!acc.user.email, timers);
    const send = codeButton(async () => {
      if (!email.value.trim() || !email.checkValidity()) return toast(t('이메일 주소를 확인해 주세요', 'Check your email address'), 'error'), false;
      await api('/api/auth/email/send-code', { method: 'POST', body: { email: email.value.trim(), purpose: 'bind' } });
    }, timers);
    body.append(
      card(
        t('이메일', 'Email'),
        current('mail', acc.user.email || t('연결된 이메일이 없어요', 'No email linked')),
        submitForm([old.el, field(t('새 이메일', 'New email'), email), field(t('새 이메일로 받은 인증코드', 'Code sent to the new email'), h('div', { class: 'auth-code-row' }, code, send))], acc.user.email ? t('이메일 바꾸기', 'Change email') : t('이메일 연결', 'Link email'), async () => {
          await api('/api/auth/account/email', { method: 'POST', body: { email: email.value.trim(), code: code.value.trim(), oldCode: old.value() } });
          toast(t('이메일을 연결했어요', 'Email linked'), 'ok');
          reload();
        }),
        acc.user.email
          ? h('p', { class: 'small muted', style: { marginTop: '14px' } }, t('이메일을 바꾸려면 지금 주소와 새 주소 양쪽에서 인증코드를 받아야 해요. 바뀌면 지금 주소로 안내 메일이 가요. 지금 주소를 더 쓸 수 없다면 ', 'Changing needs a code from both addresses, and we notify the current one. If you can no longer use it, contact '), h('a', { href: '/contact' }, t('고객지원', 'support')), t('으로 문의해 주세요.', '.'))
          : null,
      ),
    );
  },

  social({ body, acc, ctx, reload }) {
    if (ctx.query.linked) toast(t('소셜 계정을 연결했어요', 'Social account linked'), 'ok');
    const rows = PROVIDERS.map(([p, name]) => {
      const linked = acc.identities.find((i) => i.provider === p);
      const available = acc.providers?.[p];
      return h(
        'div',
        { class: 'account-social' },
        h('b', {}, name),
        h('span', { class: linked ? '' : 'muted' }, linked ? `${linked.email || t('연결됨', 'Linked')} · ${formatDate(linked.createdAt, false)}` : t('연결 안 됨', 'Not linked')),
        h('div', { class: 'spacer' }),
        linked
          ? h(
              'button',
              {
                class: 'btn sm danger',
                onclick: async () => {
                  if (!(await confirmDialog(t(`${name} 연결 해제`, `Unlink ${name}`), t(`이제 ${name} 계정으로는 로그인할 수 없게 돼요. 해제할까요?`, `You will no longer be able to log in with ${name}. Unlink?`), { okLabel: t('해제', 'Unlink'), danger: true }))) return;
                  try {
                    await api(`/api/auth/account/identities/${p}`, { method: 'DELETE' });
                    toast(t('연결을 해제했어요', 'Unlinked'), 'ok');
                    reload();
                  } catch (e) {
                    toastError(e);
                  }
                },
              },
              t('연결 해제', 'Unlink'),
            )
          : h('button', { class: 'btn sm', disabled: !available, title: available ? null : t('설정 필요', 'Not set up'), onclick: () => (location.href = `/api/auth/oauth/${p}/start?link=1`) }, available ? t('연결하기', 'Link') : t('설정 필요', 'Not set up')),
      );
    });
    body.append(card(t('소셜 계정', 'Social accounts'), h('p', { class: 'small muted' }, t('연결해 두면 그 계정으로도 바로 로그인할 수 있어요.', 'Linked accounts can be used to log in.')), ...rows));
  },

  async apps({ body }) {
    const box = card(t('연결된 앱', 'Connected apps'), h('p', { class: 'small muted' }, t('CLI·브라우저 확장·텔레그램·AI 도구처럼 내 드라이브에 접근하도록 허용한 앱이에요. 해제하면 바로 접근이 끊겨요.', 'Apps you allowed to access your drive. Disconnecting takes effect immediately.')));
    body.append(box);
    let items;
    try {
      const r = await api('/api/integrations/apps');
      items = r.items || r.apps || [];
    } catch (e) {
      if (e.status === 404) return box.append(h('div', { class: 'empty' }, h('div', { html: icon('puzzle') }), h('p', {}, t('연결된 앱 관리는 준비 중이에요', 'Connected apps are coming soon'))));
      throw e;
    }
    if (!items.length) return box.append(h('div', { class: 'empty' }, h('div', { html: icon('puzzle') }), h('p', {}, t('연결된 앱이 없어요', 'No connected apps'))));
    const scopes = (s) => (Array.isArray(s) ? s : String(s || '').split(/[,\s]+/).filter(Boolean)).map((x) => (SCOPE_TEXT[x] ? t(...SCOPE_TEXT[x]) : x)).join(', ');
    box.append(
      h(
        'div',
        { class: 'account-table-wrap' },
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, t('앱', 'App')), h('th', {}, t('권한', 'Permissions')), h('th', {}, t('연결일', 'Connected')), h('th', {}))),
          h(
            'tbody',
            {},
            ...items.map((a) => {
              const tr = h(
                'tr',
                {},
                h('td', {}, h('b', {}, a.name || a.appId || '-')),
                h('td', { class: 'small' }, scopes(a.scopes)),
                h('td', { class: 'small' }, formatDate(a.createdAt || a.created_at, false)),
                h(
                  'td',
                  { style: { textAlign: 'right' } },
                  h(
                    'button',
                    {
                      class: 'btn sm danger',
                      onclick: async () => {
                        if (!(await confirmDialog(t('앱 연결 해제', 'Disconnect app'), t(`${a.name || a.appId} 의 접근을 끊을까요?`, `Disconnect ${a.name || a.appId}?`), { okLabel: t('해제', 'Disconnect'), danger: true }))) return;
                        try {
                          await api(`/api/integrations/apps/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
                          tr.remove();
                          toast(t('연결을 해제했어요', 'Disconnected'), 'ok');
                        } catch (e) {
                          if (e.status !== 404) return toastError(e);
                          tr.remove(); // 다른 곳에서 이미 해제된 연결
                          toast(t('이미 해제된 연결이에요', 'This app was already disconnected'));
                        }
                      },
                    },
                    t('연결 해제', 'Disconnect'),
                  ),
                ),
              );
              return tr;
            }),
          ),
        ),
      ),
    );
  },

  delete({ body, ctx }) {
    const word = t('탈퇴', 'DELETE');
    const input = h('input', { class: 'input', placeholder: word, autocomplete: 'off', required: true });
    body.append(
      h(
        'section',
        { class: 'card account-card account-danger' },
        h('h3', {}, t('계정 해제(탈퇴)', 'Delete account')),
        h(
          'ul',
          {},
          h('li', {}, t('신청하는 즉시 모든 기기에서 로그아웃되고, 계정을 쓸 수 없는 상태가 돼요.', 'You are logged out everywhere and the account goes offline right away.')),
          h('li', {}, t('7일 안에 어떤 방법으로든 다시 로그인하면 신청이 취소되고 모든 것이 그대로 돌아와요.', 'Log in any way within 7 days to cancel, and everything comes back as it was.')),
          h('li', {}, t('7일이 지나면 파일·공유·시청 기록·구매 기록이 모두 지워지고 되살릴 수 없어요.', 'After 7 days your files, shares, history and orders are erased for good.')),
          h('li', {}, t('삭제가 끝나면 쓰던 휴대폰 번호와 이메일로 다시 가입할 수 있어요.', 'After deletion, your phone number and email can be used to sign up again.')),
          h('li', {}, t('남은 프리미엄 기간과 추가 혜택도 함께 사라져요. 필요한 파일은 미리 내려받아 두세요.', 'Remaining Premium time and extras are lost too. Download what you need first.')),
        ),
        submitForm(
          [field(t(`확인을 위해 '${word}'를 입력해 주세요`, `Type '${word}' to confirm`), input)],
          t('탈퇴 신청', 'Delete my account'),
          async () => {
            if (input.value.trim() !== word) return toast(t(`'${word}'를 정확히 입력해 주세요`, `Type '${word}' exactly`), 'error');
            if (!(await confirmDialog(t('정말 탈퇴할까요?', 'Delete your account?'), t('7일이 지나면 되돌릴 수 없어요.', 'This cannot be undone after 7 days.'), { okLabel: t('탈퇴', 'Delete'), danger: true }))) return;
            await api('/api/auth/account/delete', { method: 'POST', body: { confirm: input.value.trim() } });
            clearMe();
            toast(t('탈퇴 신청을 받았어요. 7일 안에 로그인하면 취소돼요', 'Deletion requested. Log in within 7 days to cancel'), 'ok');
            ctx.navigate('/login', { replace: true });
          },
          'btn danger solid',
        ),
      ),
    );
  },
};
