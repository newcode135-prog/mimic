// 화면 공통 도구. 모든 페이지·컴포넌트가 여기서 가져다 쓴다(docs/BUILD_SPEC.md 3장).

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
// api('/api/drive/list', { method:'POST', body:{...} }) → JSON. FormData 는 그대로 보낸다
export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  if (body instanceof FormData || body instanceof Blob) opts.body = body;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const code = data?.error || 'http_' + res.status;
    // 서버 메시지는 한국어라 영어 화면에서는 자주 나오는 오류 코드를 영어 문장으로 바꾼다(K-03). 표에 없으면 서버 메시지 그대로
    const msg = (lang === 'en' && ERRORS_EN[code]) || data?.message || t('요청을 처리하지 못했습니다', 'The request could not be completed');
    throw new ApiError(res.status, code, msg);
  }
  return data;
}
const ERRORS_EN = {
  login_required: 'Please log in first',
  account_suspended: 'Your account is temporarily suspended',
  account_locked: 'Your account is locked',
  admin_only: 'Admins only',
  session_required: 'Please log in on the web to use admin features',
  premium_required: 'This is a Premium feature',
  insufficient_scope: 'This token does not have permission for that',
  not_found: 'Not found',
  invalid_input: 'Please check what you entered',
  invalid_name: 'That name cannot be used',
  invalid_value: 'That value is not allowed',
  invalid_email: 'Please enter a valid email address',
  invalid_code: 'The code is not valid',
  weak_password: 'Use 6–16 characters mixing letters, numbers and symbols',
  wrong_password: 'Wrong password',
  terms_required: 'Please agree to the required terms',
  email_taken: 'This email is already in use',
  phone_taken: 'This phone number is already in use',
  too_many_requests: 'Too many requests. Please try again later',
  too_many_attempts: 'Too many attempts. Please try again later',
  storage_full: 'Not enough storage space',
  quota_exceeded: 'Transfer quota exceeded',
  monthly_quota: 'Monthly transfer quota exceeded',
  daily_quota: 'Daily download quota exceeded',
  app_quota: 'Quota for connected apps exceeded',
  region_blocked: 'Not available in your region',
  blocked: 'This content has been blocked',
  share_expired: 'This share link has expired',
  share_not_found: 'Share link not found',
  payments_unavailable: 'Payments are temporarily unavailable',
  server_error: 'A server error occurred',
};

// ---------- 언어 ----------
const stored = () => {
  try {
    return localStorage.getItem('mimic_lang');
  } catch {
    return null;
  }
};
const saved = stored();
let lang = saved === 'ko' || saved === 'en' ? saved : navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
document.documentElement.lang = lang;
export const getLang = () => lang;
// 이 기기에서 언어를 직접 고른 적이 있는지(없으면 계정 언어를 따른다, K-03)
export const hasSavedLang = () => ['ko', 'en'].includes(stored());
export function setLang(l) {
  if (l !== 'ko' && l !== 'en') return;
  lang = l;
  document.documentElement.lang = l;
  try {
    localStorage.setItem('mimic_lang', l);
  } catch {}
}
// t('모든 파일', 'All files') — 한국어 문장과 영어 문장을 함께 적는다(K-03)
export const t = (ko, en) => (lang === 'en' && en ? en : ko);

// ---------- DOM ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// h('button', { class:'btn', onclick }, '텍스트', childEl)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const loadedCss = new Set();
export function loadCss(href) {
  if (loadedCss.has(href)) return;
  loadedCss.add(href);
  document.head.append(h('link', { rel: 'stylesheet', href }));
}

// ---------- 형식 ----------
export function formatBytes(n) {
  if (n == null) return t('무제한', 'Unlimited');
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}
export function formatDate(ts, withTime = true) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}
export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h_ = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h_ ? `${h_}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
export const formatWon = (n) => `₩${Number(n || 0).toLocaleString('ko-KR')}`;

// ---------- 이벤트 버스(모듈 간 화면 이벤트) ----------
// 예: bus.emit('transfer:update', { id, type:'upload'|'download', name, progress, status })
const target = new EventTarget();
export const bus = {
  on(type, fn) {
    const l = (e) => fn(e.detail);
    target.addEventListener(type, l);
    return () => target.removeEventListener(type, l);
  },
  emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  },
};

// ---------- 로그인 사용자 ----------
let meCache = null;
export async function getMe(force = false) {
  if (meCache && !force) return meCache;
  try {
    meCache = await api('/api/me');
  } catch (e) {
    if (e.status === 401) meCache = null;
    else throw e;
  }
  return meCache;
}
export const clearMe = () => (meCache = null);

// ---------- 토스트·모달·메뉴 ----------
export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}` }, message);
  box.append(el);
  setTimeout(() => el.remove(), 3200);
}
export const toastError = (e) => toast(e?.message || t('오류가 발생했습니다', 'Something went wrong'), 'error');

// modal({ title, body: Node|string, wide, actions:[{ label, kind:'primary'|'danger', onClick(close) → false 면 닫지 않음 }] }) → close()
export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const foot = h('div', { class: 'modal-foot' });
  for (const a of actions) {
    const b = h('button', { class: `btn ${a.kind || ''}` }, a.label);
    b.onclick = async () => {
      b.disabled = true;
      try {
        if ((await a.onClick?.(close)) !== false) close();
      } catch (e) {
        toastError(e);
      } finally {
        b.disabled = false;
      }
    };
    foot.append(b);
  }
  const box = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h3', {}, title || ''), h('button', { class: 'btn ghost icon-btn', 'aria-label': t('닫기', 'Close'), onclick: close, html: icon('close') })),
    h('div', { class: 'modal-body' }, typeof body === 'string' ? h('div', { html: body }) : body),
    actions.length ? foot : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => e.target === backdrop && close() }, box);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  box.querySelector('input,textarea,select')?.focus();
  return close;
}
export function confirmDialog(title, message, { okLabel = t('확인', 'OK'), danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: h('p', {}, message),
      onClose: () => !done && resolve(false),
      actions: [
        { label: t('취소', 'Cancel'), onClick: () => ((done = true), resolve(false)) },
        { label: okLabel, kind: danger ? 'danger solid' : 'primary', onClick: () => ((done = true), resolve(true)) },
      ],
    });
  });
}
export function promptDialog(title, { label = '', value = '', placeholder = '', okLabel = t('확인', 'OK') } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder });
    modal({
      title,
      body: h('div', { class: 'field' }, label ? h('label', {}, label) : null, input),
      onClose: () => !done && resolve(null),
      actions: [
        { label: t('취소', 'Cancel'), onClick: () => ((done = true), resolve(null)) },
        { label: okLabel, kind: 'primary', onClick: () => ((done = true), resolve(input.value.trim())) },
      ],
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.closest('.modal').querySelector('.btn.primary').click());
    input.select();
  });
}
// openMenu(anchorEl|{x,y}, [{ label, icon, onClick, danger } | '-'])
export function openMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') menu.append(h('hr'));
    else if (it)
      menu.append(
        h('button', { class: it.danger ? 'danger' : '', onclick: () => (menu.remove(), it.onClick?.()) }, it.icon ? h('span', { html: icon(it.icon) }) : null, it.label),
      );
  }
  document.body.append(menu);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, bottom: anchor.y, top: anchor.y };
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8, r.left))}px`;
  menu.style.top = `${r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  return menu;
}

// ---------- 다른 모듈의 화면 컴포넌트를 불러온다(없으면 준비 중 안내) ----------
export async function useComponent(name) {
  try {
    return await import(`/components/${name}.js`);
  } catch (e) {
    console.warn(`컴포넌트 ${name} 없음`, e);
    return null;
  }
}
export async function callComponent(name, fn, ...args) {
  const mod = await useComponent(name);
  if (!mod?.[fn]) return toast(t('이 기능은 준비 중입니다', 'This feature is coming soon'));
  return mod[fn](...args);
}

// ---------- 아이콘(미믹 자체 선 아이콘) ----------
const P = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 9"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  doc: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M9 13h6M9 17h6M9 9h2"/>',
  zip: '<path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M12 3v2m0 2v2m0 2v2m-2 2h4v3h-4z"/>',
  torrent: '<path d="M12 3v10m-4-4 4 4 4-4"/><path d="M5 15v2a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .7-7.9A6 6 0 0 0 6.2 9.5 4.3 4.3 0 0 0 7 18z"/>',
  cloudDown: '<path d="M7 18h10a4 4 0 0 0 .7-7.9A6 6 0 0 0 6.2 9.5 4.3 4.3 0 0 0 7 18z"/><path d="M12 10v6m-2.5-2.5L12 16l2.5-2.5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  download: '<path d="M12 4v12m-5-5 5 5 5-5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6m-7.6 6 7.6 3.6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  history: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M12 9v3.2l2 1.3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6m-3-3h6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  sort: '<path d="M7 4v16m-3-3 3 3 3-3M17 20V4m-3 3 3-3 3 3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4m0 13.6v2.4M4.2 6.5l2 1.2m11.6 6.6 2 1.2M4.2 17.5l2-1.2m11.6-6.6 2-1.2"/><circle cx="12" cy="12" r="7"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  crown: '<path d="m4 8 4 4 4-6 4 6 4-4-1.5 10h-13z"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M3 9h18M12 9v11M12 9c-2-4-6-4-6-1.5S12 9 12 9zm0 0c2-4 6-4 6-1.5S12 9 12 9z"/>',
  ticket: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.8M12 16.5v.1"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  tv: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m9 3 3 3 3-3"/>',
  puzzle: '<path d="M10 4h4v2a2 2 0 1 0 4 0V4h2v6h-2a2 2 0 1 0 0 4h2v6h-6v-2a2 2 0 1 0-4 0v2H4v-6h2a2 2 0 1 0 0-4H4V4z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M12 15h5"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13h6m-2-2 2 2-2 2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.6"/><path d="M20 4v4.6h-4.6"/>',
  shield: '<path d="M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6z"/>',
  chart: '<path d="M4 20V10m6 10V4m6 16v-7m4 7H3"/>',
  flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m5 9 7 7 7-7"/>',
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.file}</svg>`;
export const iconEl = (name, cls = '') => h('span', { class: 'row', html: icon(name, cls) }).firstChild;

// 파일 종류별 아이콘
export function fileIcon(node) {
  if (node.kind === 'folder') return 'folder';
  const m = node.mime || '';
  const n = (node.name || '').toLowerCase();
  if (m.startsWith('video/') || /\.(mp4|mkv|avi|mov|webm|m4v|ts|flv|wmv)$/.test(n)) return 'video';
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/.test(n)) return 'image';
  if (m.startsWith('audio/') || /\.(mp3|flac|wav|aac|m4a|ogg)$/.test(n)) return 'audio';
  if (/\.(zip|rar|7z|tar|gz|bz2)$/.test(n)) return 'zip';
  if (/\.torrent$/.test(n)) return 'torrent';
  if (/\.(pdf|txt|md|docx?|xlsx?|pptx?|hwp|srt|vtt|ass)$/.test(n)) return 'doc';
  return 'file';
}
