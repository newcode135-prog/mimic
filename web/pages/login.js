// 로그인·가입·비밀번호 재설정(/login /signup /reset-password). 휴대폰·코드 입력 도우미는 account.js·approve.js 도 같이 쓴다
import { api, h, t, toast, toastError, clearMe, loadCss, icon } from '/ui.js';

loadCss('/css/auth.css');

// 휴대폰 국가번호(서버 server/modules/auth/index.js 의 COUNTRIES 와 같은 15개국)
export const COUNTRIES = [
  ['+82', '대한민국', 'Korea'],
  ['+1', '미국·캐나다', 'US / Canada'],
  ['+81', '일본', 'Japan'],
  ['+86', '중국', 'China'],
  ['+852', '홍콩', 'Hong Kong'],
  ['+886', '대만', 'Taiwan'],
  ['+65', '싱가포르', 'Singapore'],
  ['+84', '베트남', 'Vietnam'],
  ['+66', '태국', 'Thailand'],
  ['+63', '필리핀', 'Philippines'],
  ['+62', '인도네시아', 'Indonesia'],
  ['+60', '말레이시아', 'Malaysia'],
  ['+91', '인도', 'India'],
  ['+44', '영국', 'United Kingdom'],
  ['+61', '호주', 'Australia'],
];
export const SCOPE_TEXT = {
  'files:read': ['파일 목록 보기와 내려받기', 'View and download files'],
  'files:write': ['파일 올리기·이름 바꾸기·옮기기(읽기 포함)', 'Upload, rename and move files (includes read)'],
  'files:manage': ['휴지통으로 옮기기·복원 같은 파일 관리', 'Manage files, including trash and restore'],
  'files:delete': ['파일 영구 삭제', 'Delete files permanently'],
  services: ['클라우드 다운로드 추가·공유 링크 만들기', 'Add cloud downloads and create share links'],
  account: ['초대·환경설정 같은 계정 기능', 'Account features such as invites and settings'],
};
const PW_RULE = () => t('문자·숫자·기호를 섞어 6~16자', '6–16 characters mixing letters, numbers and symbols');
export const pwValid = (pw) => /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{6,16}$/.test(pw);
const safeNext = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/login') ? v : '/drive/all');

export const field = (label, control, hint) =>
  h('div', { class: 'field' }, h('label', {}, label), control, hint ? (hint instanceof Node ? hint : h('div', { class: 'hint' }, hint)) : null);

// 국가번호 선택 + 번호 입력. value() → E.164(+821012345678) 또는 null
export function phoneField(initial = '+82') {
  const sel = h('select', { class: 'input', 'aria-label': t('국가번호', 'Country code') }, ...COUNTRIES.map(([code, ko, en]) => h('option', { value: code, selected: code === initial }, `${code} ${t(ko, en)}`)));
  const num = h('input', { class: 'input', type: 'tel', inputmode: 'numeric', autocomplete: 'tel-national', placeholder: t('휴대폰 번호', 'Phone number'), required: true });
  return {
    el: h('div', { class: 'auth-phone' }, sel, num),
    value() {
      const digits = num.value.replace(/\D/g, '').replace(/^0+/, '');
      return digits.length >= 6 ? sel.value + digits : null;
    },
  };
}

// 인증코드 받기 버튼(60초 카운트다운). send() 가 false 를 돌려주면 보내지 않은 것으로 본다
export function codeButton(send, timers) {
  const btn = h('button', { class: 'btn auth-code-btn', type: 'button' }, t('인증코드 받기', 'Get code'));
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if ((await send()) === false) return (btn.disabled = false);
    } catch (e) {
      btn.disabled = false;
      return toastError(e);
    }
    toast(t('인증코드를 보냈어요. 5분 안에 입력해 주세요', 'Code sent. Enter it within 5 minutes'), 'ok');
    let left = 60;
    btn.textContent = t(`${left}초 뒤 재전송`, `Resend in ${left}s`);
    const id = setInterval(() => {
      if (--left > 0) return (btn.textContent = t(`${left}초 뒤 재전송`, `Resend in ${left}s`));
      clearInterval(id);
      timers.delete(id);
      btn.disabled = false;
      btn.textContent = t('다시 받기', 'Resend');
    }, 1000);
    timers.add(id);
  };
  return btn;
}
export const codeInput = () => h('input', { class: 'input', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', placeholder: t('인증코드 6자리', '6-digit code'), required: true });

export function describeUA(ua) {
  if (!ua) return t('알 수 없는 기기', 'Unknown device');
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua.split(/[\s/]/)[0].slice(0, 24);
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} · ${os}` : b;
}

// 제출 중 버튼을 잠그고 오류는 토스트로 보여 주는 폼
function formEl(children, label, onSubmit) {
  const btn = h('button', { class: 'btn primary lg block', type: 'submit' }, label);
  const f = h('form', { class: 'auth-form' }, ...children, btn);
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
const pwInput = (placeholder, autocomplete = 'current-password') => h('input', { class: 'input', type: 'password', autocomplete, maxlength: 16, placeholder, required: true });

const ERRORS = {
  signup_paused: ['지금은 새 가입을 잠시 멈췄어요. 나중에 다시 시도해 주세요', 'New sign-ups are temporarily paused. Please try again later'],
  oauth_state: ['로그인 요청 시간이 지났어요. 다시 시도해 주세요', 'The login request expired. Please try again'],
  oauth_denied: ['소셜 로그인을 취소했어요', 'Social login was cancelled'],
  oauth_failed: ['소셜 로그인에 실패했어요. 잠시 뒤 다시 시도해 주세요', 'Social login failed. Please try again later'],
  terms_required: ['처음 가입할 때는 아래 필수 항목에 모두 동의해 주세요', 'Please accept the required items below to sign up'],
  region_blocked: ['현재 지역에서는 새로 가입할 수 없어요', 'Sign-up is not available in your region'],
  account_suspended: ['계정 공유가 감지되어 잠시 이용이 정지된 계정이에요', 'This account is temporarily suspended'],
  account_locked: ['잠긴 계정이에요. 고객지원으로 문의해 주세요', 'This account is locked. Please contact support'],
  identity_in_use: ['이미 다른 미믹 계정에 연결된 소셜 계정이에요', 'That social account is linked to another Mimic account'],
};

export async function render(root, ctx) {
  const timers = new Set();
  const stopAll = () => {
    timers.forEach(clearInterval);
    timers.clear();
  };
  const cfg = await api('/api/config').catch(() => ({ dev: false, oauth: {} }));
  const invite = /^[\w-]{1,32}$/.test(ctx.query.invite || '') ? ctx.query.invite : '';
  const next = safeNext(ctx.query.next);
  // 가입 동의: 필수 3가지(만 14세 이상·이용약관·개인정보 수집·이용) + 선택(마케팅 수신). 각각 서버로 보내 서버가 확인한다
  const state = { consent: { age14: false, terms: false, privacy: false, marketing: false }, email: '' };
  const consentOk = () => state.consent.age14 && state.consent.terms && state.consent.privacy;
  const consentBody = () => ({ agreeAge14: state.consent.age14, agreeTerms: state.consent.terms, agreePrivacy: state.consent.privacy, agreeMarketing: state.consent.marketing });

  const done = (r) => {
    clearMe();
    toast(r?.created ? t('미믹에 오신 걸 환영해요!', 'Welcome to Mimic!') : t('로그인했어요', 'You are logged in'), 'ok');
    ctx.navigate(next, { replace: true });
  };
  const show = (view) => {
    stopAll();
    root.replaceChildren(h('div', { class: 'auth-card' }, ...VIEWS[view]()));
    root.querySelector('input:not([type=checkbox])')?.focus();
  };
  const back = (to = 'start') =>
    h('button', { class: 'btn ghost sm auth-back', type: 'button', onclick: () => show(to), html: `${icon('chevronLeft')}<span>${t('다른 방법으로', 'Other options')}</span>` });
  const link = (label, onclick) => h('button', { class: 'auth-link', type: 'button', onclick }, label);
  const devHint = () =>
    cfg.dev
      ? h(
          'p',
          { class: 'auth-dev-hint' },
          t('개발 모드라서 문자·이메일을 실제로 보내지 않아요. 인증코드는 ', 'Dev mode: no real SMS or email. Find codes at '),
          h('a', { href: '/dev/outbox', target: '_blank' }, '/dev/outbox'),
          t('에서 확인하세요.', '.'),
        )
      : null;
  const doc = (href, ko, en) => h('a', { href, target: '_blank' }, t(ko, en));
  const CONSENTS = () => [
    ['age14', [t('만 14세 이상입니다', 'I am 14 or older')], true],
    ['terms', [t('', 'I agree to the '), doc('/policy/terms', '이용약관', 'Terms of Service'), t('에 동의합니다', '')], true],
    ['privacy', [t('', 'I agree to the '), doc('/policy/privacy', '개인정보 수집·이용', 'collection and use of personal information'), t('에 동의합니다', '')], true],
    ['marketing', [t('혜택·이벤트 소식을 이메일·문자로 받겠습니다', 'Send me news and offers by email or SMS')], false],
  ];
  // note: 시작·휴대폰·소셜 화면은 기존 사용자도 거치므로 '처음 가입할 때만' 안내를 붙인다
  const consentBox = (note = true) => {
    const boxes = {};
    const all = h('input', { type: 'checkbox' });
    const sync = () => (all.checked = Object.values(state.consent).every(Boolean));
    const items = CONSENTS().map(([k, label, required]) => {
      const cb = (boxes[k] = h('input', { type: 'checkbox', checked: state.consent[k] }));
      cb.onchange = () => ((state.consent[k] = cb.checked), sync());
      return h('label', { class: 'check' }, cb, h('span', {}, ...label, ' ', h('span', { class: required ? 'auth-req' : 'muted' }, required ? t('(필수)', '(required)') : t('(선택)', '(optional)'))));
    });
    all.onchange = () => Object.entries(boxes).forEach(([k, cb]) => (state.consent[k] = cb.checked = all.checked));
    sync();
    return h(
      'div',
      { class: 'auth-consent' },
      note ? h('div', { class: 'auth-consent-note' }, t('처음 가입할 때만 필요해요', 'Needed only when creating a new account')) : null,
      h('label', { class: 'check auth-consent-all' }, all, h('b', {}, t('모두 동의', 'Agree to all'))),
      ...items,
    );
  };
  const flashConsent = () => {
    const el = root.querySelector('.auth-consent');
    el?.classList.remove('flash');
    void el?.offsetWidth;
    el?.classList.add('flash');
  };

  const SOCIAL = [
    ['google', 'Google로 계속하기', 'Continue with Google'],
    ['facebook', 'Facebook으로 계속하기', 'Continue with Facebook'],
    ['apple', 'Apple로 계속하기', 'Continue with Apple'],
  ];
  const socialBtn = ([p, ko, en]) => {
    const real = !!cfg.oauth?.[p];
    const ready = real || cfg.dev;
    return h(
      'button',
      {
        class: 'btn lg block auth-social-btn',
        type: 'button',
        disabled: !ready,
        onclick: () => {
          const q = new URLSearchParams({ next });
          for (const [k, v] of Object.entries(consentBody())) if (v) q.set(k, '1');
          if (invite) q.set('invite', invite);
          location.href = `/api/auth/oauth/${p}/start?${q}`;
        },
      },
      t(ko, en),
      !real && cfg.dev ? h('span', { class: 'badge accent' }, t('개발용', 'Dev')) : null,
      !ready ? h('span', { class: 'badge' }, t('설정 필요', 'Not set up')) : null,
    );
  };
  const method = (ic, label, onclick) => h('button', { class: 'auth-method', type: 'button', onclick }, h('span', { class: 'auth-method-icon', html: icon(ic) }), label);

  const VIEWS = {
    start: () => [
      h('h2', {}, t('가입 또는 로그인', 'Sign up or log in')),
      h('p', { class: 'muted' }, t('계정 하나로 웹·앱·TV 어디서든 내 클라우드를 이어서 써요.', 'One account for your cloud on the web, apps and TV.')),
      invite ? h('span', { class: 'badge brand' }, t(`초대코드 ${invite} 적용`, `Invite code ${invite} applied`)) : null,
      h('div', { class: 'col auth-social' }, ...SOCIAL.map(socialBtn)),
      h('div', { class: 'auth-divider' }, t('또는', 'or')),
      h(
        'div',
        { class: 'auth-methods' },
        method('phone', t('휴대폰', 'Phone'), () => show('phone')),
        method('mail', t('이메일', 'Email'), () => show('emailLogin')),
        method('qr', t('QR 코드', 'QR code'), () => show('qr')),
      ),
      consentBox(),
      devHint(),
    ],

    phone: () => {
      const pf = phoneField(t('+82', '+1'));
      const code = codeInput();
      const note = h('p', { class: 'small muted' }, t('처음 쓰는 번호라면 인증만 마치면 바로 미믹 계정이 만들어져요.', 'A new number gets a Mimic account as soon as it is verified.'));
      const send = codeButton(async () => {
        const phone = pf.value();
        if (!phone) return toast(t('휴대폰 번호를 확인해 주세요', 'Check your phone number'), 'error'), false;
        const r = await api('/api/auth/phone/send-code', { method: 'POST', body: { phone } });
        note.classList.toggle('auth-emph', !!r.isNew);
        if (r.isNew && !consentOk()) flashConsent();
      }, timers);
      return [
        back(),
        h('h2', {}, t('휴대폰으로 계속하기', 'Continue with phone')),
        formEl(
          [field(t('휴대폰 번호', 'Phone number'), pf.el), field(t('인증코드', 'Verification code'), h('div', { class: 'auth-code-row' }, code, send)), note, consentBox(), h('div', { style: { height: '12px' } })],
          t('계속하기', 'Continue'),
          async () => {
            try {
              done(await api('/api/auth/phone/verify', { method: 'POST', body: { phone: pf.value(), code: code.value.trim(), ...consentBody(), inviteCode: invite || undefined } }));
            } catch (e) {
              if (e.code === 'terms_required') flashConsent();
              throw e;
            }
          },
        ),
        h('div', { class: 'auth-links' }, link(t('비밀번호로 로그인', 'Log in with password'), () => show('phonePassword'))),
        devHint(),
      ];
    },

    phonePassword: () => {
      const pf = phoneField(t('+82', '+1'));
      const pw = pwInput(t('비밀번호', 'Password'));
      return [
        back(),
        h('h2', {}, t('휴대폰 번호와 비밀번호로 로그인', 'Log in with phone and password')),
        formEl([field(t('휴대폰 번호', 'Phone number'), pf.el), field(t('비밀번호', 'Password'), pw)], t('로그인', 'Log in'), async () =>
          done(await api('/api/auth/phone/password-login', { method: 'POST', body: { phone: pf.value(), password: pw.value } })),
        ),
        h('div', { class: 'auth-links' }, h('span', { class: 'small muted' }, t('비밀번호가 없거나 잊었나요?', 'No password yet?')), link(t('인증코드로 로그인', 'Use a code instead'), () => show('phone'))),
      ];
    },

    emailLogin: () => {
      const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'name@example.com', value: state.email, required: true });
      const pw = pwInput(t('비밀번호', 'Password'));
      return [
        back(),
        h('h2', {}, t('이메일로 로그인', 'Log in with email')),
        formEl([field(t('이메일', 'Email'), email), field(t('비밀번호', 'Password'), pw)], t('로그인', 'Log in'), async () =>
          done(await api('/api/auth/email/login', { method: 'POST', body: { email: (state.email = email.value.trim()), password: pw.value } })),
        ),
        h('div', { class: 'auth-links' }, link(t('비밀번호를 잊었어요', 'Forgot password?'), () => show('reset')), link(t('이메일로 새로 가입', 'Sign up with email'), () => show('emailSignup'))),
      ];
    },

    emailSignup: () => {
      const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'name@example.com', value: state.email, required: true });
      const code = codeInput();
      const pw = pwInput(t('비밀번호', 'Password'), 'new-password');
      const pw2 = pwInput(t('비밀번호 한 번 더', 'Confirm password'), 'new-password');
      const send = codeButton(async () => {
        const v = email.value.trim();
        if (!email.checkValidity() || !v) return toast(t('이메일 주소를 확인해 주세요', 'Check your email address'), 'error'), false;
        await api('/api/auth/email/send-code', { method: 'POST', body: { email: v, purpose: 'signup' } });
      }, timers);
      return [
        back('emailLogin'),
        h('h2', {}, t('이메일로 가입', 'Sign up with email')),
        invite ? h('span', { class: 'badge brand' }, t(`초대코드 ${invite} 적용`, `Invite code ${invite} applied`)) : null,
        formEl(
          [
            field(t('이메일', 'Email'), email),
            field(t('인증코드', 'Verification code'), h('div', { class: 'auth-code-row' }, code, send)),
            field(t('비밀번호', 'Password'), pw, PW_RULE()),
            field(t('비밀번호 확인', 'Confirm password'), pw2),
            consentBox(false),
            h('div', { style: { height: '12px' } }),
          ],
          t('가입하기', 'Create account'),
          async () => {
            if (!pwValid(pw.value)) return toast(t(`비밀번호는 ${PW_RULE()}로 정해 주세요`, `Password must be ${PW_RULE()}`), 'error');
            if (pw.value !== pw2.value) return toast(t('두 비밀번호가 서로 달라요', 'Passwords do not match'), 'error');
            if (!consentOk()) return flashConsent(), toast(t('필수 항목에 모두 동의해 주세요', 'Please accept the required items'), 'error');
            done(
              await api('/api/auth/email/signup', {
                method: 'POST',
                body: { email: email.value.trim(), code: code.value.trim(), password: pw.value, ...consentBody(), inviteCode: invite || undefined },
              }),
            );
          },
        ),
        h('div', { class: 'auth-links' }, h('span', { class: 'small muted' }, t('이미 계정이 있나요?', 'Already have an account?')), link(t('로그인', 'Log in'), () => show('emailLogin'))),
        devHint(),
      ];
    },

    reset: () => {
      const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'name@example.com', value: state.email, required: true });
      const code = codeInput();
      const pw = pwInput(t('새 비밀번호', 'New password'), 'new-password');
      const pw2 = pwInput(t('새 비밀번호 한 번 더', 'Confirm new password'), 'new-password');
      const send = codeButton(async () => {
        if (!email.checkValidity() || !email.value.trim()) return toast(t('이메일 주소를 확인해 주세요', 'Check your email address'), 'error'), false;
        await api('/api/auth/email/send-code', { method: 'POST', body: { email: email.value.trim(), purpose: 'reset' } });
      }, timers);
      return [
        back('emailLogin'),
        h('h2', {}, t('비밀번호 재설정', 'Reset password')),
        h('p', { class: 'muted' }, t('가입한 이메일로 인증코드를 보내 드려요. 재설정하면 다른 기기는 모두 로그아웃돼요.', 'We will email you a code. Other devices will be logged out.')),
        formEl(
          [field(t('이메일', 'Email'), email), field(t('인증코드', 'Verification code'), h('div', { class: 'auth-code-row' }, code, send)), field(t('새 비밀번호', 'New password'), pw, PW_RULE()), field(t('새 비밀번호 확인', 'Confirm'), pw2)],
          t('비밀번호 바꾸기', 'Change password'),
          async () => {
            if (!pwValid(pw.value)) return toast(t(`비밀번호는 ${PW_RULE()}로 정해 주세요`, `Password must be ${PW_RULE()}`), 'error');
            if (pw.value !== pw2.value) return toast(t('두 비밀번호가 서로 달라요', 'Passwords do not match'), 'error');
            await api('/api/auth/password/reset', { method: 'POST', body: { email: email.value.trim(), code: code.value.trim(), password: pw.value } });
            state.email = email.value.trim();
            toast(t('비밀번호를 바꿨어요. 새 비밀번호로 로그인해 주세요', 'Password changed. Please log in'), 'ok');
            show('emailLogin');
          },
        ),
        devHint(),
      ];
    },

    qr: () => {
      const box = h('div', { class: 'auth-qr' }, h('div', { class: 'spinner' }));
      const timer = h('div', { class: 'auth-qr-timer' });
      const devLink = h('p', { class: 'small' });
      const expired = (msg) => {
        stopAll();
        timer.textContent = '';
        box.append(
          h(
            'div',
            { class: 'auth-qr-cover' },
            msg,
            h('button', { class: 'btn primary sm', type: 'button', onclick: load, html: `${icon('refresh')}<span>${t('새 QR 코드 받기', 'Get a new QR code')}</span>` }),
          ),
        );
      };
      async function load() {
        stopAll();
        box.replaceChildren(h('div', { class: 'spinner' }));
        let q;
        try {
          q = await api('/api/auth/qr', { method: 'POST' });
        } catch (e) {
          toastError(e);
          return expired(t('QR 코드를 만들지 못했어요', 'Could not create a QR code'));
        }
        box.replaceChildren(h('img', { src: q.qrDataUrl, alt: t('로그인 QR 코드', 'Login QR code') }));
        devLink.replaceChildren(...(q.approveUrl ? [t('개발용: 휴대폰 대신 ', 'Dev: instead of a phone, open '), h('a', { href: q.approveUrl, target: '_blank' }, t('승인 화면', 'the approval page')), t('을 로그인된 다른 브라우저에서 여세요.', ' in another logged-in browser.')] : []));
        const tick = () => {
          const left = Math.max(0, Math.round((q.expiresAt - Date.now()) / 1000));
          timer.textContent = t(`${Math.floor(left / 60)}분 ${left % 60}초 뒤 만료`, `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
        };
        tick();
        timers.add(setInterval(tick, 1000));
        let busy = false;
        timers.add(
          setInterval(async () => {
            if (busy) return;
            busy = true;
            try {
              const r = await api(`/api/auth/qr/${encodeURIComponent(q.qrId)}/status`);
              if (r.status === 'approved') return stopAll(), done(r);
              if (r.status === 'denied') expired(t('다른 기기에서 로그인을 거절했어요', 'The login was declined'));
              else if (r.status === 'expired') expired(t('QR 코드가 만료되었어요', 'This QR code has expired'));
            } catch (e) {
              if (e.code === 'account_suspended' || e.code === 'account_locked') return expired(e.message);
            } finally {
              busy = false;
            }
          }, 2000),
        );
      }
      load();
      return [
        back(),
        h('h2', {}, t('QR 코드로 로그인', 'Log in with a QR code')),
        h('p', { class: 'muted' }, t('로그인된 미믹 앱으로 아래 코드를 찍고 승인하면, 이 화면이 저절로 로그인돼요.', 'Scan this code with a logged-in Mimic app and approve. This page will log in by itself.')),
        box,
        timer,
        cfg.dev ? devLink : null,
      ];
    },
  };

  if (ctx.query.error) toast(t(...(ERRORS[ctx.query.error] || ERRORS.oauth_failed)), 'error');
  show(ctx.path === '/reset-password' ? 'reset' : 'start');
  return stopAll;
}
