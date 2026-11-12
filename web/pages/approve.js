// 로그인된 기기에서 승인하는 화면: ?qr= 웹 QR 로그인, ?code= CLI·앱 연결(기기 인가)
import { api, h, t, toastError, formatDate, icon } from '/ui.js';
import { describeUA, SCOPE_TEXT } from '/pages/login.js';

const head = (ic, title, sub) => [h('div', { class: 'auth-approve-icon', html: icon(ic, 'lg') }), h('h2', {}, title), sub ? h('p', { class: 'muted' }, sub) : null];
const kv = (rows) => h('dl', { class: 'auth-kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v || '-')]));
// 기기 인가로 연결할 수 있는 앱 종류(서버 DEVICE_APPS 와 같음)
const APP_KIND = { cli: ['명령줄 도구(CLI)', 'Command-line tool (CLI)'], extension: ['브라우저 확장', 'Browser extension'] };
const result = (ic, title, sub) => h('div', { class: 'auth-card auth-result' }, ...head(ic, title, sub), h('a', { class: 'btn', href: '/drive/all' }, t('드라이브로 가기', 'Go to drive')));

export async function render(root, ctx) {
  if (ctx.query.qr) return approveQr(root, ctx.query.qr);
  return approveDevice(root, ctx.query.code || '');
}

async function approveQr(root, token) {
  let info;
  try {
    info = await api(`/api/auth/qr/info?token=${encodeURIComponent(token)}`);
  } catch {
    return root.replaceChildren(
      result('qr', t('QR 코드가 만료되었거나 이미 사용되었어요', 'This QR code has expired or was already used'), t('로그인하려는 화면에서 QR 코드를 새로 받은 뒤 다시 찍어 주세요.', 'Refresh the QR code on the other screen and scan again.')),
    );
  }
  const decide = async (approve, btn) => {
    btn.disabled = true;
    try {
      await api('/api/auth/qr/approve', { method: 'POST', body: { token, approve } });
      root.replaceChildren(
        approve
          ? result('check', t('로그인을 승인했어요', 'Login approved'), t('QR 코드를 띄운 화면이 곧 로그인됩니다.', 'The other screen will log in shortly.'))
          : result('close', t('로그인 요청을 거절했어요', 'Login declined'), t('요청한 화면은 로그인되지 않아요.', 'The other screen will not be logged in.')),
      );
    } catch (e) {
      btn.disabled = false;
      toastError(e);
    }
  };
  const no = h('button', { class: 'btn', type: 'button' }, t('거절', 'Decline'));
  const yes = h('button', { class: 'btn primary', type: 'button' }, t('승인', 'Approve'));
  no.onclick = () => decide(false, no);
  yes.onclick = () => decide(true, yes);
  root.replaceChildren(
    h(
      'div',
      { class: 'auth-card' },
      ...head('qr', t('이 기기에서 웹 로그인을 승인할까요?', 'Approve web login from this device?'), t('승인하면 QR 코드를 띄운 브라우저가 지금 이 계정으로 로그인됩니다.', 'The browser showing the QR code will be logged in to this account.')),
      kv([
        [t('요청한 기기', 'Requested by'), describeUA(info.userAgent)],
        ['IP', info.ip],
        [t('요청 시각', 'Requested at'), formatDate(info.requestedAt)],
      ]),
      h('p', { class: 'auth-warn' }, t('직접 띄운 QR 코드가 아니라면 거절하세요. 남이 보낸 QR 코드를 승인하면 그 사람이 내 계정에 들어오게 됩니다.', 'Decline if you did not open this QR code yourself. Approving someone else’s code lets them into your account.')),
      h('div', { class: 'row auth-actions' }, no, yes),
    ),
  );
}

function approveDevice(root, initial) {
  const input = h('input', { class: 'input auth-usercode', value: initial, maxlength: 9, placeholder: 'XXXX-XXXX', autocomplete: 'off', required: true });
  const detail = h('div', { class: 'col' });
  const card = h(
    'div',
    { class: 'auth-card' },
    ...head('terminal', t('기기·앱 연결 승인', 'Connect a device or app'), t('CLI 나 앱 화면에 나온 8자리 코드를 확인하고 연결을 허용해 주세요.', 'Check the 8-letter code shown in the CLI or app, then allow the connection.')),
    h(
      'form',
      {
        class: 'auth-code-row',
        onsubmit: (e) => {
          e.preventDefault();
          lookup();
        },
      },
      input,
      h('button', { class: 'btn', type: 'submit' }, t('코드 확인', 'Check code')),
    ),
    detail,
  );
  root.replaceChildren(card);

  async function lookup() {
    detail.replaceChildren();
    let info;
    try {
      info = await api(`/api/auth/device/info?code=${encodeURIComponent(input.value.trim())}`);
    } catch (e) {
      return toastError(e);
    }
    const decide = async (approve, btn) => {
      btn.disabled = true;
      try {
        await api('/api/auth/device/approve', { method: 'POST', body: { userCode: input.value.trim(), approve } });
        root.replaceChildren(
          approve
            ? result('check', t(`${info.clientName} 연결을 허용했어요`, `${info.clientName} is connected`), t('CLI·앱 화면으로 돌아가면 자동으로 이어집니다. 연결은 계정 및 보안 > 연결된 앱에서 언제든 끊을 수 있어요.', 'Return to the CLI or app. You can disconnect it anytime in Account & security > Connected apps.'))
            : result('close', t('연결 요청을 거절했어요', 'Connection declined'), null),
        );
      } catch (e) {
        btn.disabled = false;
        toastError(e);
      }
    };
    const no = h('button', { class: 'btn', type: 'button' }, t('거절', 'Decline'));
    const yes = h('button', { class: 'btn primary', type: 'button' }, t('연결 허용', 'Allow'));
    no.onclick = () => decide(false, no);
    yes.onclick = () => decide(true, yes);
    detail.replaceChildren(
      kv([
        [t('연결할 앱', 'App'), info.clientName],
        [t('앱 종류', 'App type'), APP_KIND[info.appId] ? t(...APP_KIND[info.appId]) : info.appId],
        ['IP', info.ip],
        [t('요청 시각', 'Requested at'), formatDate(info.requestedAt)],
      ]),
      h('div', {}, h('b', {}, t('이 앱이 할 수 있는 일', 'This app will be able to')), h('ul', { class: 'auth-scopes' }, ...info.scopes.map((s) => h('li', {}, SCOPE_TEXT[s] ? t(...SCOPE_TEXT[s]) : s)))),
      h(
        'p',
        { class: 'auth-warn' },
        t(
          '비밀번호는 앱에 전달되지 않아요. 앱 이름과 종류는 연결을 요청한 쪽이 알린 값이니, 내가 직접 실행한 앱이 아니라면 거절하세요.',
          'Your password is never shared with the app. The app name and type are reported by the requester, so decline if you did not start this yourself.',
        ),
      ),
      h('div', { class: 'row auth-actions' }, no, yes),
    );
  }
  if (initial) lookup();
}
