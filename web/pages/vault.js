// 금고 화면(/drive/vault, E-01~E-05). 암호화·복호화는 모두 이 브라우저에서 한다.
// 마스터키는 이 화면의 메모리에만 있고, 잠그거나(수동·자동) 화면을 떠나면 버린다.
import { api, h, t, getLang, toast, toastError, modal, confirmDialog, promptDialog, openMenu, formatBytes, formatDate, icon, loadCss, fileIcon } from '/ui.js';
import * as vc from '/pages/vault-crypto.js';

const LOCK_OPTIONS = [1, 5, 10, 30, 60];
const EXPIRY_OPTIONS = [
  [7, '7일', '7 days'],
  [14, '14일', '14 days'],
  [30, '30일', '30 days'],
  [0, '기한 없음', 'No expiry'],
];
const badName = (n) => !n || n.length > 255 || /[\\/\u0000]/.test(n);
const btn = (ic, label, onclick, kind = '') => h('button', { class: `btn sm ${kind}`, type: 'button', html: `${icon(ic)}<span>${label}</span>`, onclick });
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
const pw = (autocomplete = 'current-password') => h('input', { class: 'input', type: 'password', autocomplete });

// ---------- 패스코드 규칙(E-01): 서버는 패스코드를 못 보므로 이 화면에서 막는다 ----------
const passRule = () => t('10자 이상, 또는 8자 이상에 영문 소문자·대문자·숫자·기호 중 3가지를 섞어 주세요. 숫자만·흔한 단어·반복은 안 돼요.', 'Use 10+ characters, or 8+ mixing three of lowercase, uppercase, digits and symbols. No digits-only, common words or repeats.');
const offlineNote = () =>
  h('p', { class: 'small vault-warn' }, t('잠긴 금고 열쇠는 미믹 서버에 보관돼요. 패스코드가 약하면 그 열쇠를 손에 넣은 사람이 오프라인에서 하나씩 대입해 풀 수 있어요.', 'Your locked vault key is stored on Mimic servers. A weak passcode can be guessed offline by anyone who obtains it.'));
function passError(p) {
  const why = vc.passcodeProblem(p);
  if (!why) return '';
  const head = { short: t('너무 짧아요.', 'Too short.'), digits: t('숫자만으로는 쓸 수 없어요.', 'Digits only is not allowed.'), common: t('흔한 단어·반복·연속 문자가 너무 많아요.', 'Too many common words, repeats or sequences.'), simple: t('문자 종류를 더 섞어 주세요.', 'Mix more character types.') }[why];
  return `${head} ${passRule()}`;
}
function strengthMeter(input) {
  const labels = ['', t('약함 · 쓸 수 없음', 'Weak · not allowed'), t('보통', 'Fair'), t('좋음', 'Good'), t('강함', 'Strong')];
  const fill = h('span', { style: { width: '0%' } });
  const bar = h('div', { class: 'progress' }, fill);
  const label = h('span', { class: 'small muted' });
  input.addEventListener('input', () => {
    const sc = vc.passcodeScore(input.value);
    fill.style.width = `${sc * 25}%`;
    bar.classList.toggle('warn', sc === 1);
    label.textContent = labels[sc];
  });
  return h('div', { class: 'vault-meter', 'aria-live': 'polite' }, bar, label);
}

// vault-share.js 도 쓴다
export async function readWithProgress(res, onProgress) {
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  return new Blob(parts);
}
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
// 서버 메시지는 한국어라 금고 화면에 나오는 오류는 코드로 문구를 고른다(영어 화면). 모르는 코드는 한국어 화면에서만 서버 메시지
const ERRORS = {
  vault_locked: ['금고가 잠겼어요. 다시 잠금 해제해 주세요.', 'The vault is locked. Please unlock it again.'],
  vault_not_setup: ['금고가 초기화됐어요. 새로 만들어 주세요.', 'The vault was reset. Please set it up again.'],
  storage_full: ['금고 남은 공간이 모자라요', 'Not enough vault storage left'],
  quota_exceeded: ['이번 달 전송 쿼터를 모두 썼어요', 'Monthly transfer quota used up'],
  too_many_requests: ['요청이 너무 많아요. 잠시 후 다시 시도해 주세요', 'Too many requests. Please try again later'],
  share_revoked: ['공유한 사람이 공유를 취소했어요.', 'The sender revoked this share.'],
  share_expired: ['공유 기간이 끝났어요.', 'This share has expired.'],
  share_unavailable: ['공유한 사람의 금고를 지금은 열 수 없어요.', "The sender's vault is unavailable right now."],
  share_daily_limit: ['오늘 이 공유로 받을 수 있는 양을 다 썼어요. 내일 다시 받아 주세요.', 'This share reached its daily download limit. Please try again tomorrow.'],
};
export const errorMessage = (code, serverMsg, fallback) => (ERRORS[code] ? t(...ERRORS[code]) : (getLang() !== 'en' && serverMsg) || fallback);
export async function resError(res, fallback) {
  const d = await res.json().catch(() => ({}));
  return Object.assign(new Error(errorMessage(d.error, d.message, fallback)), { code: d.error, status: res.status });
}

// 생체인증(WebAuthn PRF) 지원: 'yes' 브라우저가 PRF 지원을 알려 줌 / 'maybe' 알려 주지 않지만 생체 인증기는 있음(설정에서 시도만) / false
async function prfSupported() {
  try {
    if (!window.isSecureContext || !window.PublicKeyCredential) return false;
    const caps = await PublicKeyCredential.getClientCapabilities?.();
    if (caps && 'extension:prf' in caps) return caps['extension:prf'] ? 'yes' : false;
    return (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) ? 'maybe' : false;
  } catch {
    return false;
  }
}
async function prfEval(credentialId, salt) {
  const a = await navigator.credentials.get({
    publicKey: {
      challenge: vc.randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: vc.unb64(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const out = a.getClientExtensionResults().prf?.results?.first;
  if (!out) throw new Error(t('이 인증기에서 금고 열쇠를 받지 못했어요', 'This authenticator did not return a vault key'));
  return new Uint8Array(out);
}

function xhrUpload(url, form, token, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    signal.addEventListener('abort', () => x.abort(), { once: true });
    x.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    x.open('POST', url);
    x.setRequestHeader('x-vault-token', token);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    x.onload = () => {
      let d = {};
      try {
        d = JSON.parse(x.responseText);
      } catch {}
      if (x.status < 300) resolve(d);
      else reject(Object.assign(new Error(errorMessage(d.error, d.message, t('올리지 못했어요', 'Upload failed'))), { code: d.error }));
    };
    x.onerror = () => reject(new Error(t('네트워크 오류로 올리지 못했어요', 'Network error')));
    x.send(form);
  });
}

function premiumGate() {
  return h(
    'div',
    { class: 'vault-center' },
    h(
      'div',
      { class: 'card vault-lock' },
      h('div', { class: 'vault-badge', html: icon('lock') }),
      h('h2', {}, t('금고는 프리미엄 전용이에요', 'The vault is a Premium feature')),
      h('p', { class: 'muted' }, t('여권 사본·계약서처럼 나만 봐야 하는 파일을 이 기기에서 잠근 뒤 올려 두는 공간이에요.', 'A space for files only you should see, locked on your device before upload.')),
      h(
        'ul',
        { class: 'vault-points' },
        h('li', {}, t('열쇠는 내 기기에만 — 미믹 운영자도 내용을 열 수 없어요', 'Only your device holds the key — not even Mimic can open it')),
        h('li', {}, t('패스코드나 생체인증으로 열고, 자리를 비우면 저절로 잠겨요', 'Open with a passcode or biometrics; it locks itself when you step away')),
        h('li', {}, t('일반 드라이브와 따로 쓰는 금고 전용 용량', 'Storage separate from your drive')),
        h('li', {}, t('링크와 열쇠를 나눠 보내는 암호화 공유', 'Encrypted sharing with the key sent separately')),
      ),
      h('a', { class: 'btn accent lg block', href: '/drive/payment' }, t('프리미엄 살펴보기', 'See Premium')),
    ),
  );
}

export async function render(root, ctx) {
  loadCss('/css/vault.css');

  const s = { keys: null, master: null, token: null, beat: null, stopAuto: null, folderId: null, items: [], selected: new Set(), fileKeys: new Map(), bio: false, aborts: new Set() };
  // 다른 기기·탭에서 열쇠를 바꾸거나 금고를 초기화했거나 서버 쪽 잠금 시간이 지나면 서버가 거절한다 → 이 화면도 잠근다(E-02·E-03)
  function kicked(e) {
    if (e?.code !== 'vault_locked' && e?.code !== 'vault_not_setup') return e;
    if (s.master) {
      lock(false);
      showLocked();
    }
    return Object.assign(new Error(errorMessage(e.code)), { code: e.code, kicked: true });
  }
  const vapi = (p, o = {}) =>
    api('/api/vault' + p, { ...o, headers: { 'x-vault-token': s.token || '' } }).catch((e) => {
      throw kicked(e);
    });
  const jobs = h('div', { class: 'vault-jobs' }); // 진행률 줄. 화면을 다시 그려도 유지

  // 생체인증은 기기마다 등록한다(E-02). 이 기기에서 등록한 자격증명 id 만 기억해 두고, 서버 목록 중 그것만 쓴다
  const PRF_STORE = `mimic-vault-prf:${ctx.user?.id || ''}`;
  const localPrf = () => {
    try {
      return JSON.parse(localStorage.getItem(PRF_STORE)) || [];
    } catch {
      return [];
    }
  };
  const saveLocalPrf = (list) => {
    try {
      localStorage.setItem(PRF_STORE, JSON.stringify(list));
    } catch {}
  };
  const myPrf = () => {
    const mine = localPrf();
    return (s.keys?.prf || []).filter((p) => mine.includes(p.credentialId)).at(-1) || null;
  };

  // ---------- 잠금·해제(E-02·E-03) ----------
  function lock(redraw = true) {
    if (!s.master) return;
    // 서버의 잠금 해제 토큰도 버린다(E-03). 페이지를 떠날 때도 보내지도록 keepalive
    fetch('/api/vault/lock', { method: 'POST', headers: { 'x-vault-token': s.token }, credentials: 'same-origin', keepalive: true }).catch(() => {});
    s.master = s.token = null;
    clearInterval(s.beat);
    s.aborts.forEach((ac) => ac.abort()); // 진행 중인 올리기·내려받기도 끊는다(잠긴 뒤 평문 저장 방지)
    s.aborts.clear();
    s.fileKeys.clear();
    s.items = [];
    s.selected.clear();
    s.stopAuto?.();
    s.stopAuto = null;
    jobs.replaceChildren();
    document.querySelectorAll('.modal-backdrop, .menu').forEach((m) => m.remove()); // 열린 창에 남은 이름·키도 지운다
    if (redraw) {
      showLocked();
      toast(t('금고를 잠갔어요', 'Vault locked'));
    }
  }
  async function unlocked(master) {
    const r = await api('/api/vault/unlock', { method: 'POST', body: { proof: await vc.vaultProof(master) } }).catch((e) => {
      throw kicked(e);
    });
    s.master = master;
    s.token = r.token;
    s.keys.autoLockMinutes = r.autoLockMinutes;
    s.stopAuto?.();
    s.stopAuto = vc.autoLock(() => lock(), r.autoLockMinutes || 5);
    // 화면이 열려 있는 동안 서버 토큰을 이어 간다(서버는 자동 잠금 시간 동안 요청이 없으면 잠근다). 다른 곳에서 열쇠를 바꾸면 여기서 알아채 잠근다
    clearInterval(s.beat);
    s.beat = setInterval(() => vapi('/usage').catch((e) => e.kicked && toastError(e)), 30_000);
    await openFolder(null);
  }
  // 다른 기기·탭에서 패스코드를 바꾸거나 금고를 초기화했을 수 있어 잠긴 화면에서는 열쇠 정보를 새로 받는다(E-02). 초기화됐으면 만들기 화면
  async function freshKeys() {
    s.keys = await api('/api/vault/keys');
    if (s.keys.setup) return s.keys;
    if (!s.master) {
      drawSetup();
      toast(t('다른 곳에서 금고를 초기화했어요. 새로 만들어 주세요.', 'The vault was reset elsewhere. Please set it up again.'), 'error');
    }
    return null;
  }
  function showLocked() {
    drawLocked();
    freshKeys().catch(() => {});
  }
  // 전송 하나: 도는 동안 미사용 자동 잠금은 기다리고, 잠그면 끊긴다
  function startTransfer() {
    const ac = new AbortController();
    s.aborts.add(ac);
    const release = s.stopAuto?.hold();
    return { signal: ac.signal, end: () => (s.aborts.delete(ac), release?.()) };
  }
  // 파일 선택·생체인증 창이 떠 있는 동안(휴대폰에서는 탭이 숨겨짐) 바로 잠그지 않는다
  const shield = () => s.stopAuto?.defer() || (() => {});
  const center = (el) => root.replaceChildren(h('div', { class: 'vault-center' }, el));

  function resetVault() {
    const hasPw = !!ctx.user?.hasPassword;
    const pass = hasPw ? pw() : null;
    const agree = h('input', { type: 'checkbox' });
    modal({
      title: t('금고 초기화', 'Reset vault'),
      body: h(
        'div',
        {},
        h('p', {}, t('패스코드 없이는 미믹도 금고 파일을 열 수 없어요. 초기화하면 금고 안 파일과 금고 공유가 모두 영구 삭제되고, 새 패스코드로 빈 금고를 다시 만들 수 있어요.', 'Without the passcode, nobody — Mimic included — can open vault files. Resetting permanently deletes every vault file and share, then lets you start an empty vault with a new passcode.')),
        hasPw
          ? field(t('본인 확인: 로그인 비밀번호', 'Confirm with your login password'), pass)
          : h('p', { class: 'small muted' }, t('본인 확인을 위해 로그인한 지 10분 안에만 초기화할 수 있어요. 오래됐다면 로그아웃 후 다시 로그인해 주세요.', 'For your safety this works only within 10 minutes of signing in. Sign out and back in if needed.')),
        h('label', { class: 'check' }, agree, t('금고 파일이 모두 영구 삭제된다는 것을 이해했어요', 'I understand all vault files will be deleted forever')),
      ),
      actions: [
        { label: t('취소', 'Cancel') },
        {
          label: t('모두 지우고 초기화', 'Erase and reset'),
          kind: 'danger solid',
          onClick: async () => {
            if (!agree.checked) {
              toast(t('영구 삭제에 동의해 주세요', 'Please confirm the deletion'), 'error');
              return false; // 창을 닫지 않는다
            }
            await api('/api/vault', { method: 'DELETE', body: hasPw ? { password: pass.value } : {} });
            s.keys = await api('/api/vault/keys');
            toast(t('금고를 초기화했어요. 새 패스코드를 정해 주세요.', 'Vault reset. Choose a new passcode.'), 'ok');
            drawSetup();
          },
        },
      ],
    });
  }

  function drawSetup() {
    const pass = pw('new-password');
    const pass2 = pw('new-password');
    const bio = h('input', { type: 'checkbox' });
    const err = h('p', { class: 'vault-error', role: 'alert' });
    const go = h('button', { class: 'btn primary lg block', type: 'submit' }, t('금고 만들기', 'Create vault'));
    const form = h(
      'form',
      {
        class: 'card vault-lock',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          const bad = passError(pass.value);
          if (bad) return void (err.textContent = bad);
          if (pass.value !== pass2.value) return void (err.textContent = t('두 번 입력한 패스코드가 서로 달라요', 'Passcodes do not match'));
          go.disabled = true;
          try {
            const { master, body } = await vc.createVault(pass.value);
            await api('/api/vault/setup', { method: 'POST', body });
            s.keys = await api('/api/vault/keys');
            await unlocked(master);
            toast(t('금고를 만들었어요', 'Vault created'), 'ok');
            if (bio.checked) await enableBio().catch(toastError);
          } catch (e2) {
            toastError(e2);
          } finally {
            go.disabled = false;
          }
        },
      },
      h('div', { class: 'vault-badge', html: icon('shield') }),
      h('h2', {}, t('나만 여는 금고 만들기', 'Set up your private vault')),
      h(
        'p',
        { class: 'muted' },
        t(
          '금고 파일은 이 기기에서 암호화한 뒤 올라가서 미믹도 열어 볼 수 없어요. 그래서 패스코드를 잊으면 파일을 되찾을 수 없고, 금고를 비우고 새로 시작하는 것만 할 수 있어요.',
          'Vault files are encrypted on this device before upload, so Mimic cannot read them. A forgotten passcode cannot be recovered — you can only empty the vault and start over.',
        ),
      ),
      field(t('패스코드', 'Passcode'), pass, `${passRule()} ${t('로그인 비밀번호와 다르게 정하세요.', 'Make it different from your login password.')}`),
      strengthMeter(pass),
      field(t('패스코드 다시 입력', 'Confirm passcode'), pass2),
      offlineNote(),
      s.bio === 'yes' ? h('label', { class: 'check' }, bio, t('이 기기의 생체인증으로도 열기', 'Also unlock with biometrics on this device')) : null,
      err,
      go,
    );
    center(form);
    pass.focus();
  }

  function drawLocked() {
    const pass = pw();
    const err = h('p', { class: 'vault-error', role: 'alert' });
    const go = h('button', { class: 'btn primary lg block', type: 'submit' }, t('잠금 해제', 'Unlock'));
    const form = h(
      'form',
      {
        class: 'card vault-lock',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          go.disabled = true;
          try {
            const keys = await freshKeys();
            if (!keys) return;
            let master;
            try {
              master = await vc.unlockWithPasscode(keys, pass.value);
            } catch {
              err.textContent = t('패스코드가 맞지 않아요', 'Wrong passcode');
              pass.select();
              return;
            }
            await unlocked(master);
          } catch (e2) {
            toastError(e2);
          } finally {
            go.disabled = false;
          }
        },
      },
      h('div', { class: 'vault-badge', html: icon('lock') }),
      h('h2', {}, t('금고가 잠겨 있어요', 'Your vault is locked')),
      h('p', { class: 'muted' }, t('열 때마다 패스코드나 생체인증으로 본인임을 다시 확인해요.', 'We ask for your passcode or biometrics every time.')),
      field(t('금고 패스코드', 'Vault passcode'), pass),
      err,
      go,
      s.bio && myPrf() ? h('button', { class: 'btn lg block', type: 'button', html: `${icon('shield')}<span>${t('생체인증으로 열기', 'Unlock with biometrics')}</span>`, onclick: unlockBio }) : null,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: resetVault }, t('패스코드를 잊었어요', 'Forgot passcode?')),
    );
    center(form);
    pass.focus();
  }

  async function unlockBio() {
    let master;
    try {
      if (!(await freshKeys())) return;
      const p = myPrf(); // 다른 곳에서 열쇠를 바꿨으면 등록이 지워져 없다 → 아래 안내
      const out = await prfEval(p.credentialId, vc.unb64(p.salt));
      master = await vc.unwrapKey(await vc.prfKey(out), p.wrapped);
    } catch {
      if (!myPrf()) drawLocked(); // 쓸 수 없는 생체인증 버튼은 치운다
      return toast(t('생체인증으로 열지 못했어요. 패스코드를 입력해 주세요.', 'Biometric unlock failed. Please use your passcode.'), 'error');
    }
    await unlocked(master).catch(toastError);
  }

  async function enableBio() {
    const master = s.master;
    const salt = vc.randomBytes(32);
    const u = ctx.user || {};
    const release = shield();
    let credentialId, out;
    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: vc.randomBytes(32),
          rp: { name: t('미믹 금고', 'Mimic Vault') },
          user: { id: vc.randomBytes(16), name: u.email || u.phone || 'mimic', displayName: u.name || t('미믹 금고', 'Mimic Vault') },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
          extensions: { prf: { eval: { first: salt } } },
        },
      });
      const ext = cred.getClientExtensionResults().prf;
      credentialId = vc.b64(new Uint8Array(cred.rawId));
      if (!ext?.enabled && !ext?.results?.first) {
        try {
          await PublicKeyCredential.signalUnknownCredential?.({ rpId: location.hostname, credentialId }); // 쓸모없는 자격증명을 인증기에서 지우도록 알림(지원 브라우저만)
        } catch {}
        throw new Error(t('이 기기·브라우저는 금고 생체인증에 필요한 기능(WebAuthn PRF)을 지원하지 않아요. 패스코드로 열어 주세요.', 'This device or browser lacks the WebAuthn PRF feature the vault needs. Please use your passcode.'));
      }
      out = ext.results?.first ? new Uint8Array(ext.results.first) : await prfEval(credentialId, salt);
    } finally {
      release();
    }
    if (!master || s.master !== master) throw new Error(t('등록하는 사이 금고가 잠겼어요. 다시 열고 시도해 주세요.', 'The vault locked during setup. Unlock and try again.'));
    const wrapped = await vc.wrapKey(await vc.prfKey(out), master);
    await vapi('/prf', { method: 'PUT', body: { credentialId, salt: vc.b64(salt), wrapped } });
    saveLocalPrf([...localPrf(), credentialId]);
    s.keys = await api('/api/vault/keys');
    toast(t('생체인증으로도 열 수 있어요', 'Biometric unlock is on'), 'ok');
  }

  // ---------- 목록(E-01·E-04) ----------
  async function openFolder(folderId) {
    const master = s.master;
    if (!master) return;
    const [list, use] = await Promise.all([vapi(`/list?parentId=${encodeURIComponent(folderId || '')}`), vapi('/usage')]);
    const items = [];
    for (const it of list.items) {
      try {
        if (it.kind === 'folder') items.push({ ...it, name: await vc.openText(master, it.encName) });
        else {
          const key = await vc.unwrapKey(master, it.encKey);
          s.fileKeys.set(it.id, key);
          items.push({ ...it, ...(await vc.openFileMeta(key, it)) });
        }
      } catch {
        items.push({ ...it, name: t('(이름을 풀 수 없음)', '(unreadable)'), broken: true });
      }
    }
    const path = [];
    for (const p of list.path) path.push({ id: p.id, name: await vc.openText(master, p.encName).catch(() => '?') });
    if (s.master !== master) return; // 그사이 잠겼으면 그리지 않는다
    items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'ko') : a.kind === 'folder' ? -1 : 1));
    s.folderId = folderId;
    s.items = items;
    s.selected.clear();
    drawOpen(path, use);
  }
  const refresh = () => openFolder(s.folderId).catch(toastError);

  function drawOpen(path, use) {
    const input = h('input', { type: 'file', multiple: true, hidden: true });
    input.onchange = () => {
      upload([...input.files]);
      input.value = '';
    };
    const crumb = (id, name) => h('a', { href: '#', onclick: (e) => (e.preventDefault(), openFolder(id).catch(toastError)) }, name);
    const head = h(
      'div',
      { class: 'page-head' },
      h('div', { class: 'crumbs' }, h('span', { html: icon('lock') }), crumb(null, t('금고', 'Vault')), ...path.flatMap((p) => [h('span', { class: 'sep' }, '/'), crumb(p.id, p.name)])),
      h('div', { class: 'spacer' }),
      btn(
        'upload',
        t('올리기', 'Upload'),
        () => {
          const release = shield(); // 고르기 창을 닫으면(고름·취소·창으로 돌아옴) 풀린다
          input.addEventListener('change', release, { once: true });
          input.addEventListener('cancel', release, { once: true });
          window.addEventListener('focus', release, { once: true });
          input.click();
        },
        'primary',
      ),
      btn('folderPlus', t('새 폴더', 'New folder'), newFolder),
      btn('share', t('공유 관리', 'Shares'), showShares),
      btn('settings', t('설정', 'Settings'), showSettings),
      btn('lock', t('잠그기', 'Lock'), () => lock()),
      input,
    );
    const pct = use.total ? Math.min(100, (use.used / use.total) * 100) : 0;
    const usage = h(
      'div',
      { class: 'vault-usage' },
      h('div', { class: `progress ${pct > 90 ? 'warn' : ''}` }, h('span', { style: { width: `${pct}%` } })),
      h('span', { class: 'small muted' }, `${t('금고 용량', 'Vault storage')} ${formatBytes(use.used)} / ${formatBytes(use.total)} · ${t('남은 공간', 'Free')} ${formatBytes(Math.max(0, use.total - use.used))}`),
    );
    const selBar = h('div', { class: 'vault-selbar hidden' });
    const updateSel = () => {
      const picked = s.items.filter((i) => s.selected.has(i.id));
      selBar.classList.toggle('hidden', !picked.length);
      selBar.replaceChildren(
        h('b', {}, t(`${picked.length}개 선택됨`, `${picked.length} selected`)),
        h('div', { class: 'spacer' }),
        btn('move', t('이동', 'Move'), () => move(picked)),
        btn('share', t('암호화 공유', 'Share'), () => createShare(picked)),
        btn('trash', t('영구 삭제', 'Delete'), () => remove(picked), 'danger'),
      );
    };
    const rows = s.items.map((it) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': t('선택', 'Select') });
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => (cb.checked ? s.selected.add(it.id) : s.selected.delete(it.id), updateSel());
      const more = h('button', { class: 'btn ghost icon-btn', type: 'button', 'aria-label': t('더 보기', 'More'), html: icon('more') });
      more.onclick = (e) => (e.stopPropagation(), openMenu(more, menuFor(it)));
      return h(
        'tr',
        { onclick: () => (it.kind === 'folder' ? openFolder(it.id).catch(toastError) : download(it)), title: it.kind === 'file' ? t('눌러서 복호화해 내려받기', 'Click to decrypt and download') : '' },
        h('td', { class: 'vault-cb' }, cb),
        h('td', {}, h('span', { class: 'vault-name', html: icon(fileIcon(it)) }, it.name)),
        h('td', { class: 'muted vault-hide-sm' }, it.kind === 'file' ? formatBytes(it.size) : '—'),
        h('td', { class: 'muted vault-hide-sm' }, formatDate(it.updatedAt)),
        h('td', { class: 'vault-actions' }, more),
      );
    });
    const list = rows.length
      ? h(
          'table',
          { class: 'table vault-list' },
          h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, t('이름', 'Name')), h('th', { class: 'vault-hide-sm' }, t('크기', 'Size')), h('th', { class: 'vault-hide-sm' }, t('수정한 때', 'Modified')), h('th', {}))),
          h('tbody', {}, ...rows),
        )
      : h(
          'div',
          { class: 'empty' },
          h('div', { html: icon('lock') }),
          h('h3', {}, t('아직 비어 있어요', 'Nothing here yet')),
          h('p', { class: 'small' }, t('올리기를 누르거나 파일을 여기로 끌어다 놓으면 이 기기에서 암호화해 보관해요.', 'Upload or drop files here — they are encrypted on this device first.')),
        );
    const view = h('div', { class: 'vault-open' }, head, usage, jobs, selBar, list);
    view.addEventListener('dragover', (e) => (e.preventDefault(), view.classList.add('vault-dragover')));
    view.addEventListener('dragleave', (e) => e.target === view && view.classList.remove('vault-dragover'));
    view.addEventListener('drop', (e) => {
      e.preventDefault();
      view.classList.remove('vault-dragover');
      if (e.dataTransfer?.files?.length) upload([...e.dataTransfer.files]);
    });
    root.replaceChildren(view);
  }

  function menuFor(it) {
    const file = it.kind === 'file' && !it.broken;
    return [
      file && { label: t('복호화해 내려받기', 'Decrypt & download'), icon: 'download', onClick: () => download(it) },
      !it.broken && { label: t('이름 바꾸기', 'Rename'), icon: 'edit', onClick: () => rename(it) },
      { label: t('이동', 'Move'), icon: 'move', onClick: () => move([it]) },
      file && { label: t('암호화 공유', 'Encrypted share'), icon: 'share', onClick: () => createShare([it]) },
      '-',
      { label: t('영구 삭제', 'Delete forever'), icon: 'trash', danger: true, onClick: () => remove([it]) },
    ];
  }

  function track(name, label) {
    const fill = h('span', { style: { width: '0%' } });
    const status = h('span', { class: 'small muted' }, label);
    const row = h('div', { class: 'vault-job' }, h('div', { class: 'row' }, h('b', { class: 'vault-job-name' }, name), h('div', { class: 'spacer' }), status), h('div', { class: 'progress' }, fill));
    jobs.prepend(row);
    const set = (pct, text) => {
      fill.style.width = `${Math.round(pct)}%`;
      if (text) status.textContent = text;
    };
    set.done = (text) => (set(100, text), setTimeout(() => row.remove(), 4000));
    set.fail = (text) => ((status.textContent = text), row.classList.add('error'), setTimeout(() => row.remove(), 8000));
    return set;
  }

  const notUploaded = (n) => toast(t(`금고가 잠겨 파일 ${n}개를 올리지 못했어요. 다시 열고 올려 주세요.`, `The vault locked, so ${n} file(s) were not uploaded. Unlock and try again.`), 'error');

  async function upload(files) {
    const folderId = s.folderId;
    // 남은 금고 공간을 먼저 본다(E-04): 넘치는 파일은 메모리에서 암호화하기 전에 건너뛴다. 못 받아 오면 서버 검사에 맡긴다
    const use = await vapi('/usage').catch(() => null);
    let free = use ? use.total - use.used : Infinity;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const { master, token } = s;
      if (!master) return notUploaded(files.length - i);
      const need = vc.cipherSize(file.size);
      if (need > free) {
        track(file.name, '').fail(t(`금고 남은 공간(${formatBytes(Math.max(0, free))})이 모자라 올리지 않았어요`, `Skipped — not enough vault space (${formatBytes(Math.max(0, free))} left)`));
        continue;
      }
      const bar = track(file.name, t('암호화하는 중', 'Encrypting'));
      const tr = startTransfer();
      try {
        const key = await vc.newKey();
        const cipher = await vc.encryptBlob(key, file, (d, total) => (tr.signal.throwIfAborted(), bar(total ? (d / total) * 40 : 40)));
        const meta = await vc.sealFileMeta(master, key, { name: file.name, mime: file.type, size: file.size });
        tr.signal.throwIfAborted();
        const fd = new FormData();
        fd.append('parentId', folderId || '');
        fd.append('encMeta', JSON.stringify(meta));
        fd.append('file', cipher, 'blob');
        bar(40, t('올리는 중', 'Uploading'));
        await xhrUpload('/api/vault/upload', fd, token, tr.signal, (l, total) => bar(40 + (l / total) * 60));
        free -= need;
        bar.done(t('보관 완료', 'Stored'));
      } catch (e) {
        kicked(e); // 서버가 잠겼다고 하면 화면도 잠근다(전송은 아래에서 끊긴 것으로 처리)
        if (tr.signal.aborted) return notUploaded(files.length - i);
        bar.fail(e.message || t('올리지 못했어요', 'Upload failed'));
      } finally {
        tr.end();
      }
    }
    if (s.master && s.folderId === folderId) refresh();
  }

  async function download(it) {
    const key = s.fileKeys.get(it.id);
    if (!key) return;
    const bar = track(it.name, t('받는 중', 'Downloading'));
    const tr = startTransfer();
    try {
      const res = await fetch(`/api/vault/files/${encodeURIComponent(it.id)}/blob`, { headers: { 'x-vault-token': s.token }, credentials: 'same-origin', signal: tr.signal });
      if (!res.ok) throw kicked(await resError(res, t('내려받지 못했어요', 'Download failed')));
      const cipher = await readWithProgress(res, (p) => bar(p * 60));
      bar(60, t('복호화하는 중', 'Decrypting'));
      const plain = await vc.decryptBlob(key, cipher, (d, total) => (tr.signal.throwIfAborted(), bar(60 + (d / total) * 40)), it.mime);
      tr.signal.throwIfAborted(); // 잠긴 뒤에는 평문을 저장하지 않는다
      saveBlob(plain, it.name);
      bar.done(t('완료', 'Done'));
    } catch (e) {
      if (tr.signal.aborted) return void toast(t('금고가 잠겨 내려받기를 멈췄어요', 'The vault locked, so the download stopped'), 'error');
      bar.fail(e.name === 'OperationError' ? t('파일이 손상되어 풀 수 없어요', 'File is damaged') : e.message);
    } finally {
      tr.end();
    }
  }

  async function newFolder() {
    const name = await promptDialog(t('새 폴더', 'New folder'), { placeholder: t('폴더 이름', 'Folder name'), okLabel: t('만들기', 'Create') });
    if (name == null) return;
    if (badName(name)) return toast(t('쓸 수 없는 이름이에요', 'Invalid name'), 'error');
    try {
      await vapi('/folders', { method: 'POST', body: { parentId: s.folderId, encName: await vc.sealText(s.master, name) } });
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function rename(it) {
    const name = await promptDialog(t('이름 바꾸기', 'Rename'), { value: it.name, okLabel: t('바꾸기', 'Rename') });
    if (name == null || name === it.name) return;
    if (badName(name)) return toast(t('쓸 수 없는 이름이에요', 'Invalid name'), 'error');
    try {
      const encName = await vc.sealText(it.kind === 'folder' ? s.master : s.fileKeys.get(it.id), name);
      await vapi(`/files/${encodeURIComponent(it.id)}`, { method: 'PATCH', body: { encName } });
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  // 금고 안 폴더 고르기(이름이 암호화돼 있어 드라이브 폴더 선택 창 대신 여기서 복호화해 보여 준다)
  function pickFolder(excludeIds) {
    return new Promise((resolve) => {
      let picked;
      let cur = null;
      const body = h('div', { class: 'vault-picker' }, h('div', { class: 'spinner' }));
      const close = modal({
        title: t('어느 폴더로 옮길까요?', 'Move to which folder?'),
        body,
        onClose: () => resolve(picked),
        actions: [{ label: t('취소', 'Cancel') }, { label: t('여기로 옮기기', 'Move here'), kind: 'primary', onClick: () => void (picked = cur) }],
      });
      async function show(id) {
        const r = await vapi(`/list?parentId=${encodeURIComponent(id || '')}`);
        cur = id;
        const trail = [{ id: null, name: t('금고', 'Vault') }];
        for (const p of r.path) trail.push({ id: p.id, name: await vc.openText(s.master, p.encName).catch(() => '?') });
        const folders = [];
        for (const it of r.items) if (it.kind === 'folder' && !excludeIds.includes(it.id)) folders.push({ id: it.id, name: await vc.openText(s.master, it.encName).catch(() => '?') });
        body.replaceChildren(
          h('div', { class: 'row vault-picker-path' }, ...trail.flatMap((c, i) => [i ? h('span', { class: 'muted' }, '/') : null, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => show(c.id).catch(toastError) }, c.name)])),
          folders.length
            ? h('div', { class: 'col' }, ...folders.map((f) => h('button', { class: 'btn ghost vault-picker-item', type: 'button', html: icon('folder'), onclick: () => show(f.id).catch(toastError) }, f.name)))
            : h('p', { class: 'muted small' }, t('안에 폴더가 없어요', 'No folders inside')),
        );
      }
      show(null).catch((e) => (toastError(e), close()));
    });
  }
  async function move(items) {
    const target = await pickFolder(items.map((i) => i.id));
    if (target === undefined) return;
    try {
      await vapi('/move', { method: 'POST', body: { ids: items.map((i) => i.id), parentId: target } });
      toast(t('옮겼어요', 'Moved'), 'ok');
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function remove(items) {
    const ok = await confirmDialog(
      t('영구 삭제', 'Delete forever'),
      t(`${items.length}개 항목을 지울까요? 금고에는 휴지통이 없어서 지우면 되돌릴 수 없어요.`, `Delete ${items.length} item(s)? The vault has no trash, so this cannot be undone.`),
      { okLabel: t('영구 삭제', 'Delete'), danger: true },
    );
    if (!ok) return;
    try {
      for (const it of items) await vapi(`/files/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
      toast(t('지웠어요', 'Deleted'), 'ok');
    } catch (e) {
      toastError(e);
    }
    refresh();
  }

  // ---------- 암호화 공유(E-05) ----------
  function createShare(items) {
    const files = items.filter((i) => i.kind === 'file' && s.fileKeys.has(i.id));
    if (!files.length) return toast(t('공유는 파일만 할 수 있어요', 'Only files can be shared'), 'error');
    const mode = h(
      'select',
      { class: 'input' },
      h('option', { value: 'separate' }, t('링크와 키를 따로 보내기 (더 안전)', 'Send link and key separately (safer)')),
      h('option', { value: 'combined' }, t('키를 링크에 넣어 한 번에 보내기', 'Put the key inside the link')),
    );
    const exp = h('select', { class: 'input' }, ...EXPIRY_OPTIONS.map(([d, ko, en]) => h('option', { value: d }, t(ko, en))));
    modal({
      title: t('암호화 공유 만들기', 'Create encrypted share'),
      body: h(
        'div',
        {},
        h('p', { class: 'muted' }, t(`파일 ${files.length}개를 이번 공유만의 새 키로 잠가 공유해요. 키는 미믹 서버에 저장되지 않아요.`, `${files.length} file(s) will be shared under a brand-new key that never reaches Mimic's servers.`)),
        field(t('보내는 방법', 'Delivery'), mode),
        field(t('유효 기간', 'Expires after'), exp),
      ),
      actions: [
        { label: t('취소', 'Cancel') },
        {
          label: t('공유 만들기', 'Create'),
          kind: 'primary',
          onClick: async () => {
            const sk = await vc.makeShareKeys(files.map((f) => ({ id: f.id, key: s.fileKeys.get(f.id) })));
            const r = await vapi('/shares', { method: 'POST', body: { fileIds: files.map((f) => f.id), wrappedKeys: sk.wrappedKeys, mode: mode.value, expiresDays: Number(exp.value) } });
            showShareResult(r, sk.key);
          },
        },
      ],
    });
  }
  function copyRow(label, value) {
    const input = h('input', { class: 'input vault-mono', readonly: true, value });
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(value);
        toast(t('복사했어요', 'Copied'), 'ok');
      } catch {
        input.select();
      }
    };
    return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'button', onclick: copy }, t('복사', 'Copy'))));
  }
  function showShareResult(r, key) {
    const link = `${location.origin}/vs/${r.token}`;
    const until = r.share.expiresAt ? t(`${formatDate(r.share.expiresAt)}까지 열 수 있어요.`, `Available until ${formatDate(r.share.expiresAt)}.`) : t('기한 없이 열 수 있어요. 필요 없어지면 공유 관리에서 취소하세요.', 'No expiry — revoke it in Shares when done.');
    const body =
      r.share.mode === 'combined'
        ? [copyRow(t('공유 링크 (키 포함)', 'Share link (with key)'), `${link}#k=${key}`), h('p', { class: 'muted small' }, t('이 링크를 가진 사람은 누구나 파일을 열 수 있어요. 믿을 수 있는 사람에게만 보내세요.', 'Anyone with this link can open the files.'))]
        : [
            copyRow(t('공유 링크', 'Share link'), link),
            copyRow(t('공유 키', 'Share key'), key),
            h('p', { class: 'muted small' }, t('링크와 키를 서로 다른 길(예: 메일과 메신저)로 보내면 한쪽이 새어도 파일은 안전해요.', 'Send the link and key over different channels.')),
          ];
    modal({
      title: t('공유를 만들었어요', 'Share created'),
      wide: true,
      body: h('div', {}, ...body, h('p', { class: 'small' }, until), h('p', { class: 'small vault-warn' }, t('링크와 키는 지금 한 번만 보여 드려요. 창을 닫기 전에 복사해 두세요.', 'The link and key are shown only now — copy them before closing.'))),
      actions: [{ label: t('닫기', 'Close'), kind: 'primary' }],
    });
  }

  function showShares() {
    const body = h('div', {}, h('div', { class: 'spinner' }));
    modal({ title: t('금고 공유 관리', 'Vault shares'), body, wide: true });
    const STATUS = { active: ['brand', t('공유 중', 'Active')], expired: ['', t('기간 끝남', 'Expired')], revoked: ['danger', t('취소됨', 'Revoked')] };
    const draw = async () => {
      const { items, dailyCopies } = await vapi('/shares');
      if (!items.length) return void body.replaceChildren(h('p', { class: 'muted' }, t('아직 만든 공유가 없어요.', 'No shares yet.')));
      body.replaceChildren(
        h(
          'p',
          { class: 'small muted' },
          t(
            `링크와 키는 만들 때만 볼 수 있어요. 받아 간 양은 내 다운로드 쿼터에서 빠지고, 공유 하나는 하루에 담긴 파일 크기의 ${dailyCopies}배까지만 받을 수 있어요. 더 이상 필요 없는 공유는 취소하세요.`,
            `Links and keys are shown only once. Downloads count against your quota, and each share allows up to ${dailyCopies}× its size per day. Revoke shares you no longer need.`,
          ),
        ),
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, t('만든 때', 'Created')), h('th', {}, t('파일', 'Files')), h('th', {}, t('방법', 'Mode')), h('th', {}, t('기한', 'Expires')), h('th', {}, t('받아 간 양', 'Downloaded')), h('th', {}, t('상태', 'Status')), h('th', {}))),
          h(
            'tbody',
            {},
            ...items.map((x) =>
              h(
                'tr',
                {},
                h('td', {}, formatDate(x.createdAt)),
                h('td', {}, t(`${x.fileCount}개`, `${x.fileCount}`)),
                h('td', {}, x.mode === 'combined' ? t('링크에 키 포함', 'Key in link') : t('링크·키 따로', 'Separate key')),
                h('td', {}, x.expiresAt ? formatDate(x.expiresAt) : t('없음', 'None')),
                h('td', {}, formatBytes(x.sentBytes || 0)),
                h('td', {}, h('span', { class: `badge ${STATUS[x.status][0]}` }, STATUS[x.status][1])),
                h(
                  'td',
                  {},
                  x.status === 'active'
                    ? h(
                        'button',
                        {
                          class: 'btn sm danger',
                          type: 'button',
                          onclick: async () => {
                            try {
                              await vapi(`/shares/${encodeURIComponent(x.id)}`, { method: 'DELETE' });
                              toast(t('공유를 취소했어요', 'Share revoked'), 'ok');
                              await draw();
                            } catch (e) {
                              toastError(e);
                            }
                          },
                        },
                        t('취소', 'Revoke'),
                      )
                    : null,
                ),
              ),
            ),
          ),
        ),
      );
    };
    draw().catch(toastError);
  }

  // ---------- 설정(E-02·E-03) ----------
  function showSettings() {
    const minutes = h('select', { class: 'input' }, ...LOCK_OPTIONS.map((m) => h('option', { value: m, selected: m === s.keys.autoLockMinutes }, t(`${m}분 동안 조작이 없으면`, `After ${m} min idle`))));
    minutes.onchange = async () => {
      try {
        const r = await vapi('/settings', { method: 'PUT', body: { autoLockMinutes: Number(minutes.value) } });
        s.keys.autoLockMinutes = r.autoLockMinutes;
        s.stopAuto?.setMinutes(r.autoLockMinutes); // 새로 만들지 않는다: 진행 중인 전송·고르기 창 유예가 그대로 이어진다
        toast(t('저장했어요', 'Saved'), 'ok');
      } catch (e) {
        toastError(e);
      }
    };
    const cur = pw();
    const next = pw('new-password');
    const next2 = pw('new-password');
    const rotate = h('input', { type: 'checkbox', checked: true });
    const sw = s.bio ? h('input', { type: 'checkbox', checked: !!myPrf() }) : null;
    const change = h('button', { class: 'btn', type: 'button' }, t('패스코드 바꾸기', 'Change passcode'));
    change.onclick = async () => {
      const bad = passError(next.value);
      if (bad) return toast(bad, 'error');
      if (next.value !== next2.value) return toast(t('새 패스코드가 서로 달라요', 'New passcodes do not match'), 'error');
      if (rotate.checked && s.aborts.size) return toast(t('올리기·내려받기가 끝난 뒤 바꿔 주세요', 'Wait for uploads and downloads to finish'), 'error');
      change.disabled = true;
      try {
        const keys = await api('/api/vault/keys'); // 다른 곳에서 패스코드만 바꿨을 수 있다(E-02)
        try {
          await vc.unlockWithPasscode(keys, cur.value);
        } catch {
          return toast(t('지금 쓰는 패스코드가 맞지 않아요', 'Current passcode is wrong'), 'error');
        }
        const old = s.master;
        if (rotate.checked) {
          // 마스터키·증명값까지 새로(E-02): 예전 패스코드나 증명값을 손에 넣은 사람도 더는 못 연다
          const { items } = await vapi('/list?all=1');
          let r;
          try {
            r = await vc.rotateMaster(old, items, next.value);
          } catch {
            return toast(t('풀 수 없는 항목이 있어 열쇠를 바꾸지 못했어요. 그 항목을 지우거나, 열쇠 바꾸기를 끄고 패스코드만 바꿔 주세요.', 'Some items could not be decrypted, so the key was not replaced. Delete them, or change only the passcode.'), 'error');
          }
          await vapi('/keys', { method: 'PUT', body: r.body });
          if (s.master === old) s.master = r.master; // 그사이 잠겼으면 열지 않는다(파일 데이터키는 그대로라 fileKeys 유지, 이 탭의 서버 토큰도 유지)
          if (sw) sw.checked = false;
        } else await vapi('/keys', { method: 'PUT', body: await vc.wrapWithPasscode(old, next.value) });
        s.keys = await api('/api/vault/keys');
        cur.value = next.value = next2.value = '';
        toast(
          rotate.checked
            ? t('패스코드와 금고 열쇠를 바꿨어요. 예전 패스코드·열쇠로는 더 열 수 없어요. 생체인증은 기기마다 다시 켜 주세요.', 'Passcode and vault key replaced. The old passcode and key no longer work. Turn biometrics back on per device.')
            : t('패스코드를 바꿨어요', 'Passcode changed'),
          'ok',
        );
      } catch (e) {
        toastError(e);
      } finally {
        change.disabled = false;
      }
    };
    let bioRow = null;
    if (sw) {
      sw.onchange = async () => {
        sw.disabled = true;
        try {
          if (sw.checked) await enableBio();
          else {
            const p = myPrf();
            if (p) await vapi('/prf', { method: 'DELETE', body: { credentialId: p.credentialId } });
            saveLocalPrf(localPrf().filter((id) => id !== p?.credentialId));
            s.keys = await api('/api/vault/keys');
            toast(t('이 기기의 생체인증 잠금 해제를 껐어요', 'Biometric unlock off on this device'), 'ok');
          }
        } catch (e) {
          sw.checked = !sw.checked;
          toastError(e);
        } finally {
          sw.disabled = false;
        }
      };
      bioRow = h(
        'div',
        { class: 'vault-section' },
        h('h3', {}, t('생체인증', 'Biometrics')),
        h('label', { class: 'row' }, h('span', { class: 'switch' }, sw, h('span')), t('이 기기의 지문·얼굴 인식으로 금고 열기', 'Unlock with fingerprint or face on this device')),
        s.bio === 'maybe' && !myPrf()
          ? h('p', { class: 'small muted' }, t('이 브라우저는 금고 생체인증(WebAuthn PRF) 지원 여부를 미리 알려 주지 않아요. 켜 보면 등록 중에 확인하고, 안 되면 알려 드려요.', 'This browser does not say whether it supports the WebAuthn PRF feature. Turning this on will check during setup and tell you if it fails.'))
          : null,
      );
    }
    modal({
      title: t('금고 설정', 'Vault settings'),
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'vault-section' },
          h('h3', {}, t('자동 잠금', 'Auto-lock')),
          field(t('잠그는 때', 'Lock'), minutes, t('다른 탭·앱으로 가거나 이 화면을 떠나면 시간과 관계없이 바로 잠가요.', 'It also locks right away when you switch tabs or leave this page.')),
        ),
        h(
          'div',
          { class: 'vault-section' },
          h('h3', {}, t('패스코드 바꾸기', 'Change passcode')),
          field(t('지금 패스코드', 'Current passcode'), cur),
          field(t('새 패스코드', 'New passcode'), next, passRule()),
          strengthMeter(next),
          field(t('새 패스코드 다시 입력', 'Confirm new passcode'), next2),
          h('label', { class: 'check' }, rotate, t('금고 열쇠도 새로 바꾸기 (패스코드가 새었을 때 권장)', 'Also replace the vault key (recommended if the passcode leaked)')),
          h(
            'p',
            { class: 'small muted' },
            t(
              '열쇠를 바꾸지 않으면 패스코드만 바뀌어, 예전 패스코드나 열쇠를 이미 손에 넣은 사람은 계속 열 수 있어요. 열쇠를 바꾸면 다른 기기·탭은 다시 잠금 해제해야 하고 생체인증 등록이 모두 풀려요. 금고 공유 링크는 그대로 열려요.',
              'Without a new key only the passcode changes, so anyone who already has the old passcode or key can still open the vault. Replacing the key locks other devices and tabs and removes all biometric registrations. Vault share links keep working.',
            ),
          ),
          offlineNote(),
          change,
        ),
        bioRow,
      ),
    });
  }

  if (!ctx.me?.premium) {
    const gate = premiumGate();
    root.replaceChildren(gate);
    // 프리미엄이 끝나면 공개 링크는 멈추지만(서버 410), 다시 살아나기 전에 거둘 수 있게 공유 관리는 열어 둔다
    const { items = [] } = await api('/api/vault/shares').catch(() => ({}));
    if (items.some((x) => x.status === 'active'))
      gate.firstChild.append(
        h('p', { class: 'small muted' }, t('프리미엄 기간이 끝나 금고 공유 링크가 멈춰 있어요. 프리미엄을 다시 쓰면 링크도 다시 열리니, 필요 없는 공유는 지금 취소해 두세요.', 'Your vault share links are paused because Premium ended. They reopen if Premium resumes, so revoke any you no longer need.')),
        btn('share', t('금고 공유 관리', 'Manage vault shares'), showShares),
      );
    return;
  }

  [s.bio, s.keys] = await Promise.all([prfSupported(), api('/api/vault/keys')]);
  s.keys.setup ? drawLocked() : drawSetup();
  return () => lock(false); // 화면을 떠나면 잠근다(E-03)
}
