// TV 화면(/tv, K-02 TV 안내 + 10피트 UI): 큰 타일, 리모컨 방향키 이동·확인(Enter) 선택, 뒤로(Esc·Backspace).
// 로그인 전에는 QR 로그인(auth 모듈의 POST /api/auth/qr). 다른 모듈 API 가 없으면 안내만 보여 준다.
import { api, h, icon, t, fileIcon, formatBytes, formatDate, loadCss } from '/ui.js';

const isVideo = (n) => n.kind !== 'folder' && fileIcon(n) === 'video';
const listOf = (r) => r?.items || [];
// 다른 모듈 API 가 없거나 실패하면 null
const tryApi = (p) => api(p).catch(() => null);

export async function render(root, ctx) {
  loadCss('/css/content.css');
  document.title = t('미믹 TV', 'Mimic TV');
  const screen = h('div', { class: 'mc-tv' });
  const top = h('div', { class: 'top' }, h('a', { class: 'logo', href: '/tv', tabindex: -1 }, h('img', { src: '/logo.svg', alt: '' }), t('미믹', 'Mimic')), h('div', { class: 'spacer' }), h('span', { class: 'hint' }, t('방향키로 이동 · 확인으로 선택 · 뒤로 버튼으로 돌아가기', 'Arrows to move · OK to select · Back to return')));
  const body = h('div');
  screen.append(top, body);
  root.replaceChildren(screen);
  const stack = [];
  let timer = null;

  const tile = (label, sub, ic, onSelect, big = false) => h('button', { class: `tile ${big ? 'big' : ''}`, type: 'button', onclick: onSelect, html: icon(ic) }, h('b', {}, label), sub ? h('span', {}, sub) : null);
  const show = (...children) => {
    body.replaceChildren(...children);
    (body.querySelector('.tile:not([disabled])') || body.querySelector('.tile'))?.focus();
  };
  const go = (view) => {
    stack.push(view);
    view();
  };
  const back = () => {
    if (stack.length > 1) {
      stack.pop();
      stack[stack.length - 1]();
    }
  };
  const openNode = (n) => {
    if (n.kind === 'folder') return go(() => folder(n.id, n.name));
    ctx.navigate(isVideo(n) ? `/play/${n.id}` : `/preview/${n.id}`);
  };
  const nodeTile = (n) => tile(n.name, n.kind === 'folder' ? t('폴더', 'Folder') : formatBytes(n.size), fileIcon(n), () => openNode(n));
  const empty = (msg) => h('div', { class: 'empty-tv' }, msg);

  async function recentVideos() {
    const r = await tryApi('/api/drive/recent');
    return listOf(r).filter(isVideo);
  }

  async function home() {
    show(h('div', { class: 'row-tiles' }, tile(t('최근 영상', 'Recent videos'), '', 'video', () => go(recent), true), tile(t('모든 파일', 'All files'), '', 'folder', () => go(() => folder(null, t('모든 파일', 'All files'))), true), tile(t('시청 기록', 'Watch history'), '', 'history', () => go(history), true)));
    const vids = (await recentVideos()).slice(0, 8);
    if (stack[stack.length - 1] !== home || !vids.length) return;
    body.append(h('h2', {}, t('이어서 볼 만한 영상', 'Pick up a video')), h('div', { class: 'row-tiles' }, ...vids.map(nodeTile)));
  }
  async function recent() {
    show(h('h2', {}, t('최근 영상', 'Recent videos')), empty(t('불러오는 중…', 'Loading…')));
    const vids = await recentVideos();
    show(h('h2', {}, t('최근 영상', 'Recent videos')), vids.length ? h('div', { class: 'row-tiles' }, ...vids.map(nodeTile)) : empty(t('최근 저장한 영상이 없어요. 휴대폰이나 PC에서 클라우드 다운로드로 영상을 받아 보세요.', 'No recent videos. Add some via Cloud download on your phone or PC.')));
  }
  async function folder(id, name) {
    show(h('h2', {}, name), empty(t('불러오는 중…', 'Loading…')));
    let r = null;
    try {
      r = await api(`/api/drive/list?parentId=${encodeURIComponent(id || '')}`);
    } catch {}
    const items = listOf(r);
    show(h('h2', {}, name), r ? (items.length ? h('div', { class: 'row-tiles' }, ...items.map(nodeTile)) : empty(t('빈 폴더예요.', 'This folder is empty.'))) : empty(t('파일 목록을 불러오지 못했어요.', 'Could not load files.')));
  }
  async function history() {
    show(h('h2', {}, t('시청 기록', 'Watch history')), empty(t('불러오는 중…', 'Loading…')));
    const r = await tryApi('/api/media/history');
    const items = listOf(r);
    const tiles = items.map((x) => {
      const id = x.fileId;
      const sub = x.position && x.duration ? `${Math.round((x.position / x.duration) * 100)}% · ${formatDate(x.updatedAt)}` : formatDate(x.updatedAt);
      return tile(x.file?.name || t('영상', 'Video'), sub, 'video', () => ctx.navigate(`/play/${id}`));
    });
    show(h('h2', {}, t('시청 기록', 'Watch history')), r ? (tiles.length ? h('div', { class: 'row-tiles' }, ...tiles) : empty(t('아직 본 영상이 없어요.', 'Nothing watched yet.'))) : empty(t('시청 기록 기능을 준비 중이에요.', 'Watch history is coming soon.')));
  }

  // ---------- QR 로그인 ----------
  async function qrLogin() {
    clearInterval(timer);
    const box = h('div', { class: 'qr-box' }, t('QR 코드를 만드는 중…', 'Creating QR code…'));
    const info = h('div', {}, h('h2', { style: { marginTop: 0 } }, t('휴대폰으로 QR을 찍어 로그인하세요', 'Scan with your phone to sign in')), h('ol', { class: 'hint', style: { lineHeight: 2 } }, h('li', {}, t('휴대폰에서 미믹 앱을 열고 로그인해요.', 'Open Mimic on your phone and sign in.')), h('li', {}, t('QR 스캔으로 이 화면의 코드를 찍어요.', 'Scan this code.')), h('li', {}, t('휴대폰에서 "승인"을 누르면 TV가 바로 로그인돼요.', 'Tap Approve and the TV signs in.'))));
    const retry = tile(t('새 QR 만들기', 'New QR code'), '', 'refresh', qrLogin);
    const other = tile(t('다른 방법으로 로그인', 'Other sign-in options'), '', 'user', () => ctx.navigate('/login?next=/tv'));
    show(h('div', { class: 'qr' }, box, h('div', {}, info, h('div', { class: 'row-tiles', style: { marginTop: '24px' } }, retry, other))));
    let r;
    try {
      r = await api('/api/auth/qr', { method: 'POST', body: { device: 'tv' } });
    } catch {
      box.textContent = t('QR 로그인을 준비 중이에요. 휴대폰이나 PC에서 로그인 화면을 이용해 주세요.', 'QR sign-in is not available yet. Please use the sign-in page.');
      return;
    }
    // auth 모듈: { qrId, expiresAt, qrDataUrl, approveUrl(개발 모드) } → GET /api/auth/qr/:qrId/status 로 승인 확인(승인되면 세션 쿠키 발급)
    if (typeof r.qrDataUrl === 'string' && r.qrDataUrl.startsWith('data:image/')) box.replaceChildren(h('img', { src: r.qrDataUrl, alt: 'QR' }));
    else box.replaceChildren(h('div', {}, t('휴대폰에서 아래 주소를 열어 승인하세요', 'Open this address on your phone to approve'), h('p', { style: { wordBreak: 'break-all', fontWeight: 700 } }, r.approveUrl || '')));
    const expired = () => {
      clearInterval(timer);
      box.replaceChildren(h('div', {}, t('QR 코드가 만료되었어요. "새 QR 만들기"를 눌러 주세요.', 'The QR code expired. Choose "New QR code".')));
    };
    timer = setInterval(async () => {
      if (Date.now() > (r.expiresAt || 0)) return expired();
      try {
        const s = await api(`/api/auth/qr/${encodeURIComponent(r.qrId)}/status`);
        if (s.status === 'approved') {
          clearInterval(timer);
          ctx.me = await ctx.refreshMe();
          if (ctx.me) start();
        } else if (s.status !== 'pending') expired();
      } catch {}
    }, 2000);
  }

  function start() {
    stack.length = 0;
    if (ctx.me) go(home);
    else go(qrLogin);
  }

  // 리모컨 방향키: 지금 칸에서 그 방향으로 가장 가까운 타일로 옮긴다
  function move(dir) {
    const tiles = [...body.querySelectorAll('.tile')];
    const cur = document.activeElement;
    if (!tiles.includes(cur)) return tiles[0]?.focus();
    const a = cur.getBoundingClientRect();
    const horiz = dir === 'ArrowLeft' || dir === 'ArrowRight';
    let best = null;
    let bestD = Infinity;
    for (const el of tiles) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - (a.left + a.width / 2);
      const dy = b.top + b.height / 2 - (a.top + a.height / 2);
      const ok = { ArrowRight: dx > 10, ArrowLeft: dx < -10, ArrowDown: dy > 10, ArrowUp: dy < -10 }[dir];
      if (!ok) continue;
      const d = horiz ? Math.abs(dx) + 2 * Math.abs(dy) : Math.abs(dy) + 2 * Math.abs(dx);
      if (d < bestD) [best, bestD] = [el, d];
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  const onKey = (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      move(e.key);
    } else if (e.key === 'Escape' || e.key === 'GoBack' || (e.key === 'Backspace' && !/input|textarea/i.test(document.activeElement?.tagName))) {
      e.preventDefault();
      back();
    }
  };
  document.addEventListener('keydown', onKey);
  start();
  return () => {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
  };
}
