// 영상·음악 플레이어(/play/:id) — C-01 재생, C-02 HDR 안내, C-03 외부 플레이어, C-04 플레이어 기능, C-06 이어보기, C-07 자막·오디오
import { api, h, t, toast, toastError, openMenu, callComponent, icon, formatDuration, loadCss, modal } from '/ui.js';

const RATES = [0.5, 1, 1.25, 1.5, 2, 3];
const SAVE_EVERY_MS = 10_000;
const IDLE_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rateLabel = (r) => `${Number.isInteger(r) ? r.toFixed(1) : r}x`;
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// 플레이어 전용 선 아이콘(ui.js 에 없는 것만)
const P = {
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  exitFull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  prev: '<path d="M6 5v14"/><path d="M18 5.5v13L8.5 12z"/>',
  next: '<path d="M18 5v14"/><path d="M6 5.5v13L15.5 12z"/>',
};
// 프리미엄 전용 기능 안내(미리보기 화면도 같이 쓴다)
export function premiumPrompt(ctx, title, text) {
  modal({
    title,
    body: h('p', {}, text),
    actions: [{ label: t('닫기', 'Close') }, { label: t('프리미엄 보기', 'See Premium'), kind: 'primary', onClick: () => ctx.navigate('/drive/payment') }],
  });
}
const svg = (name) => (P[name] ? `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>` : icon(name));
// 이전/다음은 드라이브 목록과 같은 순서(사용자가 고른 정렬). 목록을 못 받으면 서버가 준 이름순(미리보기 화면도 같이 쓴다)
export async function driveSiblings(info) {
  try {
    const q = info.file.parentId ? `?parentId=${encodeURIComponent(info.file.parentId)}` : '';
    const same = new Set(info.siblings.ids || []);
    const order = (await api(`/api/drive/list${q}`)).items.filter((x) => same.has(x.id)).map((x) => x.id);
    const i = order.indexOf(info.file.id);
    if (i >= 0) return { prevId: order[i - 1] || null, nextId: order[i + 1] || null };
  } catch {}
  return info.siblings;
}

export async function render(root, ctx) {
  loadCss('/css/media.css');
  const id = ctx.params.id;
  root.replaceChildren(h('div', { class: 'mp-shell' }, h('div', { class: 'mp-overlay' }, h('div', { class: 'spinner' }))));
  let info;
  try {
    info = await api(`/api/media/${id}/info`);
  } catch (e) {
    root.replaceChildren(h('div', { class: 'mp-shell' }, h('div', { class: 'mp-overlay' }, h('p', {}, e.message), h('a', { class: 'btn', href: '/drive/all' }, t('드라이브로 돌아가기', 'Back to drive')))));
    return;
  }
  if (info.kind !== 'video' && info.kind !== 'audio') return ctx.navigate(`/preview/${id}`, { replace: true });

  const isVideo = info.kind === 'video';
  const premium = !!ctx.me?.premium;
  // 서버가 정한 기본 화질: 원본을 다시 인코딩해야 하면(비호환 코덱·HDR) 프리미엄도 720p 부터
  let quality = info.defaultQuality || (info.qualities.includes('original') ? 'original' : '720p');
  // 변환 중에는 HLS 조각으로 먼저 재생한다(브라우저가 HLS 를 바로 재생할 때만. 아니면 변환이 끝날 때까지 기다림)
  const canHls = isVideo && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  let hlsMode = false;
  let keepAlive = 0;
  let audio = 0;
  let sub = -1;
  let rate = 1;
  let starred = !!info.file.starred;
  let disposed = false;
  let loadSeq = 0;
  let lastSaved = 0;
  let idleTimer = 0;
  let pendingAt = 0; // 영상이 열리면 이동할 위치('처음부터'를 누르면 0)

  // ---------- 화면 ----------
  const video = h('video', { class: 'mp-video', playsinline: true, preload: 'metadata' });
  const subs = []; // 붙인 자막 목록(textTracks 와 같은 순서)
  const addTrack = (label, src, lang = null) => {
    subs.push(label);
    video.append(h('track', { kind: 'subtitles', label, srclang: lang, src }));
    return subs.length - 1;
  };
  info.subtitles.forEach((s) => addTrack(`${s.label}${s.source === 'sidecar' ? '' : t(' (내장)', ' (embedded)')}`, `/api/media/${id}/subtitles/${s.id}.vtt`, s.lang || null));
  const savedVol = Number(store.get('mimic_volume'));
  if (store.get('mimic_volume') !== null && savedVol >= 0 && savedVol <= 1) video.volume = savedVol;

  const ovSpin = h('div', { class: 'spinner' });
  const ovText = h('p', {});
  const ovBar = h('span', { style: { width: '0%' } });
  const ovProg = h('div', { class: 'progress mp-prog' }, ovBar);
  const ovActions = h('div', { class: 'row' });
  const overlay = h('div', { class: 'mp-overlay hidden', role: 'status' }, ovSpin, ovText, ovProg, ovActions);
  const resumeChip = h('div', { class: 'mp-chip hidden' });
  const center = h('button', { class: 'mp-center', 'aria-label': t('재생', 'Play'), html: icon('play'), onclick: () => togglePlay() });
  const art = isVideo ? null : h('div', { class: 'mp-art', html: icon('audio') }, h('div', { class: 'mp-art-name' }, info.file.name));
  const stage = h('div', { class: 'mp-stage' }, video, art, center, overlay, resumeChip);
  stage.addEventListener('click', (e) => e.target === video && togglePlay());
  stage.addEventListener('dblclick', (e) => e.target === video && toggleFull());

  const btn = (label, html, onclick, cls = '') => h('button', { class: `mp-btn ${cls}`, title: label, 'aria-label': label, html, onclick });
  const starBtn = btn(t('즐겨찾기', 'Star'), icon('star'), toggleStar);
  const moreBtn = btn(t('더 보기', 'More'), icon('more'), (e) => {
    e.stopPropagation();
    openMenu(moreBtn, [
      { label: t('외부 플레이어로 열기', 'Open in external player'), icon: 'external', onClick: openExternal },
      { label: t('기기에 다운로드', 'Download to device'), icon: 'download', onClick: download },
    ]);
  });
  const folderUrl = info.file.parentId ? `/drive/folder/${info.file.parentId}` : '/drive/all';
  const top = h(
    'div',
    { class: 'mp-top' },
    btn(t('뒤로', 'Back'), icon('chevronLeft'), () => (history.length > 1 ? history.back() : ctx.navigate(folderUrl))),
    h('div', { class: 'mp-title', title: info.file.name }, info.file.name),
    info.hdr ? hdrBadge() : null,
    h('div', { class: 'spacer' }),
    btn(t('공유', 'Share'), icon('share'), () => callComponent('share', 'openShareDialog', [id])),
    starBtn,
    moreBtn,
  );

  const seek = h('input', { type: 'range', class: 'mp-seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': t('재생 위치', 'Seek') });
  seek.addEventListener('input', () => {
    const d = duration();
    if (d) seekTo((seek.value / 1000) * d);
    paintSeek();
  });
  const timeEl = h('span', { class: 'mp-time' }, '0:00 / 0:00');
  const playBtn = btn(t('재생', 'Play'), icon('play'), () => togglePlay());
  let sib = info.siblings;
  const prevBtn = btn(t('이전 파일', 'Previous file'), svg('prev'), () => go(sib.prevId));
  const nextBtn = btn(t('다음 파일', 'Next file'), svg('next'), () => go(sib.nextId));
  const paintSib = () => {
    prevBtn.disabled = !sib.prevId;
    nextBtn.disabled = !sib.nextId;
  };
  paintSib();
  driveSiblings(info).then((s) => !disposed && ((sib = s), paintSib()));
  const muteBtn = btn(t('음소거', 'Mute'), svg('volume'), () => {
    video.muted = !video.muted;
  });
  const vol = h('input', { type: 'range', class: 'mp-vol', min: 0, max: 1, step: 0.05, value: video.volume, 'aria-label': t('볼륨', 'Volume') });
  vol.addEventListener('input', () => setVolume(Number(vol.value)));
  const textBtn = (label, onclick) => h('button', { class: 'mp-btn text', onclick }, label);
  const rateBtn = textBtn(rateLabel(rate), (e) => pick(e, RATES.map((r) => ({ label: rateLabel(r), on: r === rate, run: () => setRate(r) }))));
  const qualityBtn = textBtn('', (e) =>
    pick(e, [
      { label: '720p', on: quality === '720p', run: () => switchTo({ quality: '720p' }) },
      { label: info.qualities.includes('original') ? t('원본', 'Original') : t('원본 · 프리미엄', 'Original · Premium'), on: quality === 'original', run: chooseOriginal },
    ]),
  );
  // 자막: 내장·이름이 같은 자막은 바로, 같은 폴더의 다른 srt·vtt 나 기기의 자막 파일은 골라서 붙인다
  const others = [...(info.subtitleFiles || [])];
  const subBtn = textBtn(t('자막', 'Subtitles'), (e) =>
    pick(e, [
      { label: t('끄기', 'Off'), on: sub < 0, run: () => setSub(-1) },
      ...subs.map((label, i) => ({ label, on: sub === i, run: () => setSub(i) })),
      ...others.map((s) => ({
        label: `${s.label} ${t('붙이기', '(add)')}`,
        run: () => {
          others.splice(others.indexOf(s), 1);
          setSub(addTrack(s.label, `/api/media/${id}/subtitles/${s.id}.vtt`));
        },
      })),
      { label: t('기기에서 자막 파일 열기(srt·vtt)…', 'Open subtitle file from device (srt, vtt)…'), run: openLocalSub },
      // PGS·DVD 같은 그림 자막은 웹에서 그릴 수 없어 목록에서 빠진다. 왜 없는지 알리고 외부 플레이어로 안내
      ...(info.imageSubtitles
        ? [{ label: t(`그림 자막 ${info.imageSubtitles}개는 웹에서 표시할 수 없어요 — 외부 플레이어로 열기`, `${info.imageSubtitles} image subtitle(s) can't be shown on the web — open in external player`), run: openExternal }]
        : []),
    ]),
  );
  function openLocalSub() {
    const input = h('input', { type: 'file', accept: '.srt,.vtt' });
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder('euc-kr').decode(buf); // 한국어 윈도우 자막(CP949)
      }
      text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      if (!text.startsWith('WEBVTT')) text = 'WEBVTT\n\n' + text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      setSub(addTrack(file.name, URL.createObjectURL(new Blob([text], { type: 'text/vtt' }))));
    };
    input.click();
  }
  const trackName = (a) => a.title || a.lang || t(`트랙 ${a.index + 1}`, `Track ${a.index + 1}`);
  const audioBtn = textBtn(t('오디오', 'Audio'), (e) =>
    pick(e, info.audioTracks.map((a) => ({ label: trackName(a), on: audio === a.index, run: () => switchTo({ audio: a.index }) }))),
  );
  const fullBtn = btn(t('전체 화면', 'Full screen'), svg('full'), () => toggleFull());
  const bottom = h(
    'div',
    { class: 'mp-bottom' },
    seek,
    h(
      'div',
      { class: 'mp-controls' },
      prevBtn,
      playBtn,
      nextBtn,
      h('div', { class: 'mp-volume' }, muteBtn, vol),
      timeEl,
      h('div', { class: 'spacer' }),
      rateBtn,
      isVideo ? qualityBtn : null,
      isVideo || info.subtitles.length ? subBtn : null,
      info.audioTracks.length > 1 ? audioBtn : null,
      isVideo ? fullBtn : null,
    ),
  );
  // 마우스로 누른 버튼이 포커스를 잡지 않게 해서 스페이스 키가 재생/일시정지로만 쓰이게 한다
  bottom.addEventListener('mousedown', (e) => e.target.closest('button') && e.preventDefault());
  top.addEventListener('mousedown', (e) => e.target.closest('button') && e.preventDefault());

  const shell = h('div', { class: `mp-shell ${isVideo ? '' : 'is-audio'}` }, top, stage, bottom);
  root.replaceChildren(shell);
  const oldTitle = document.title;
  document.title = `${info.file.name} · 미믹`;

  // ---------- 동작 ----------
  // 좁은 화면에서는 짧은 'HDR' 만 보이고, 누르면 전체 안내가 뜬다
  function hdrBadge() {
    const long = t('HDR 영상 — 모바일 앱에서 HDR 로 재생 예정', 'HDR video — HDR playback coming in the mobile app');
    const note = `${long}. ${t('웹 브라우저에서는 일반 화질(SDR)로 보여요.', 'Shown in SDR on the web.')}`;
    return h('button', { class: 'mp-badge', type: 'button', title: note, 'aria-label': note, onclick: () => toast(note) }, h('span', { class: 'mp-badge-long' }, long), h('span', { class: 'mp-badge-short' }, 'HDR'));
  }
  function duration() {
    if (hlsMode && info.duration) return info.duration; // 변환 중인 HLS 는 지금까지 만든 길이만 알려 주므로 전체 길이로 표시
    return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : info.duration || 0;
  }
  // HLS 로 보는 중에는 아직 변환되지 않은 곳으로 넘어가지 않게 만든 데까지만
  function seekTo(at) {
    const r = video.seekable;
    const end = hlsMode && r.length ? r.end(r.length - 1) : Infinity;
    if (at > end) toast(t('아직 변환하지 않은 부분이에요. 조금 뒤에 다시 넘겨 보세요.', 'That part is still converting. Try again in a moment.'));
    video.currentTime = Math.max(0, Math.min(at, end - 1));
  }
  function paintSeek() {
    const d = duration();
    const pct = d ? (video.currentTime / d) * 100 : 0;
    if (document.activeElement !== seek) seek.value = String(Math.round(pct * 10));
    seek.style.setProperty('--p', `${pct}%`);
    timeEl.textContent = `${formatDuration(video.currentTime)} / ${formatDuration(d)}`;
  }
  function paint() {
    playBtn.innerHTML = icon(video.paused ? 'play' : 'pause');
    playBtn.title = video.paused ? t('재생', 'Play') : t('일시정지', 'Pause');
    center.classList.toggle('hidden', !video.paused || !overlay.classList.contains('hidden'));
    muteBtn.innerHTML = svg(video.muted || video.volume === 0 ? 'mute' : 'volume');
    vol.value = String(video.muted ? 0 : video.volume);
    vol.style.setProperty('--p', `${(video.muted ? 0 : video.volume) * 100}%`);
    rateBtn.textContent = rateLabel(rate);
    qualityBtn.textContent = quality === 'original' ? t('원본', 'Original') : '720p';
    subBtn.classList.toggle('on', sub >= 0);
    starBtn.classList.toggle('on', starred);
    starBtn.setAttribute('aria-pressed', String(starred));
    fullBtn.innerHTML = svg(document.fullscreenElement ? 'exitFull' : 'full');
  }
  function pick(e, items) {
    e.stopPropagation();
    openMenu(e.currentTarget, items.map((it) => ({ label: it.label, icon: it.on ? 'check' : null, onClick: it.run })));
  }
  function togglePlay() {
    if (!video.src) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  function setVolume(v) {
    video.volume = Math.min(1, Math.max(0, v));
    video.muted = video.volume === 0;
    store.set('mimic_volume', String(video.volume));
  }
  function setRate(r) {
    rate = r;
    video.playbackRate = r;
    paint();
  }
  function setSub(i) {
    sub = i;
    [...video.textTracks].forEach((tr, j) => (tr.mode = j === i ? 'showing' : 'disabled'));
    paint();
  }
  function toggleFull() {
    // 메뉴·창이 전체 화면에서도 보이도록 문서 전체를 전체 화면으로 만든다
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  function chooseOriginal() {
    if (info.qualities.includes('original')) return switchTo({ quality: 'original' });
    if (premium) return toast(t('이 영상은 변환 화질로만 재생할 수 있어요', 'This video plays in converted quality only'));
    premiumPrompt(ctx, t('원본 화질은 프리미엄 전용이에요', 'Original quality is a Premium feature'), t('무료 계정은 720p 로 재생돼요. 프리미엄으로 올리면 원본 화질 그대로 볼 수 있어요.', 'Free accounts play in 720p. Upgrade to Premium to watch in original quality.'));
  }
  function switchTo(patch) {
    if ((patch.quality ?? quality) === quality && (patch.audio ?? audio) === audio) return;
    quality = patch.quality ?? quality;
    audio = patch.audio ?? audio;
    const resume = !video.paused || !video.src;
    video.pause(); // 새 변환본이 준비될 때까지 멈춰 두고 같은 위치에서 이어 간다
    paint();
    load(video.currentTime, resume);
  }
  function go(fileId) {
    if (!fileId) return;
    save(true);
    ctx.navigate(`/play/${fileId}`);
  }
  async function toggleStar() {
    starred = !starred;
    paint();
    try {
      await api('/api/drive/star', { method: 'POST', body: { ids: [id], starred } });
      toast(starred ? t('즐겨찾기에 넣었어요', 'Starred') : t('즐겨찾기에서 뺐어요', 'Unstarred'));
    } catch {
      starred = !starred; // 실패하면 조용히 되돌린다
      paint();
    }
  }
  function download() {
    h('a', { href: `/api/drive/files/${id}/download`, download: '' }).click();
  }
  async function openExternal() {
    try {
      const r = await api(`/api/media/${id}/external-url`);
      const link = (label, href) => h('a', { class: 'btn block', href }, label);
      const copy = () => navigator.clipboard.writeText(r.url).then(() => toast(t('재생 링크를 복사했어요', 'Stream link copied'), 'ok'), toastError);
      modal({
        title: t('외부 플레이어로 열기', 'Open in external player'),
        body: h(
          'div',
          { class: 'col' },
          h('p', { class: 'muted small' }, t('컴퓨터에 설치된 플레이어를 고르세요. 이 재생 링크는 6시간 동안만 열려요.', 'Pick a player installed on this computer. The stream link works for 6 hours.')),
          link('PotPlayer', r.potplayer),
          link('VLC', r.vlc),
          // 데스크톱 앱은 링크를 Chromium 창에서 그대로 열어 브라우저 형식만 재생한다
          r.mimicPlayable
            ? link(t('미믹 데스크톱 앱', 'Mimic desktop app'), r.mimic)
            : h('p', { class: 'muted small' }, t('미믹 데스크톱 앱은 브라우저가 바로 재생하는 형식(mp4·webm·mp3 등)만 열 수 있어요. 이 파일은 PotPlayer·VLC 로 여세요.', 'The Mimic desktop app only plays browser formats (mp4, webm, mp3, etc.). Use PotPlayer or VLC for this file.')),
          h(
            'p',
            { class: 'muted small' },
            t(
              '눌러도 아무 일이 없거나 목록에 없는 플레이어라면, 아래 주소를 복사해 플레이어의 "네트워크 스트림 열기"(VLC: 미디어 → 네트워크 스트림 열기, PotPlayer: 열기 → 주소 열기)에 붙여 넣으세요.',
              'If nothing happens or your player is not listed, copy the address below and paste it into your player\'s "Open network stream" (VLC: Media → Open Network Stream; PotPlayer: Open → Open URL).',
            ),
          ),
          h('input', { class: 'input', readonly: true, value: r.url, 'aria-label': t('재생 주소', 'Stream address'), onfocus: (e) => e.target.select() }),
        ),
        actions: [{ label: t('닫기', 'Close') }, { label: t('주소 복사', 'Copy address'), kind: 'primary', onClick: () => (copy(), false) }],
      });
    } catch (e) {
      toastError(e);
    }
  }
  // keepalive: 탭·창을 닫을 때(pagehide)도 브라우저가 요청을 끝까지 보내게 한다
  function save(force, keepalive = false) {
    const pos = video.currentTime;
    if (!pos || (!force && Date.now() - lastSaved < SAVE_EVERY_MS)) return;
    lastSaved = Date.now();
    fetch('/api/media/history', {
      method: 'POST',
      keepalive,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileId: id, position: pos, duration: duration() }),
    }).catch(() => {});
  }

  function showOverlay({ spin = false, text = '', progress = null, actions = [] }) {
    overlay.classList.remove('hidden');
    ovSpin.classList.toggle('hidden', !spin);
    ovText.textContent = text;
    ovProg.classList.toggle('hidden', progress == null);
    ovBar.style.width = `${progress || 0}%`;
    ovActions.replaceChildren(...actions);
    paint();
  }
  function showError(e) {
    const actions =
      e.code === 'playback_blocked'
        ? [h('a', { class: 'btn primary', href: '/drive/payment' }, t('프리미엄 보기', 'See Premium')), h('a', { class: 'btn', href: '/drive/quota' }, t('용량 확인', 'Check storage'))]
        : [h('button', { class: 'btn', onclick: () => load(video.currentTime || 0) }, t('다시 시도', 'Try again')), h('button', { class: 'btn', onclick: openExternal }, t('외부 플레이어로 열기', 'Open in external player'))];
    showOverlay({ text: e.message || t('재생하지 못했어요', 'Could not play this file'), actions });
  }

  // 변환이 필요하면 진행률을 보여 주며 기다린 뒤 재생한다. HLS 조각이 보려는 위치보다 12초(두 조각) 넘게 앞서 있으면 바로 HLS 로 재생
  async function load(at = 0, autoplay = true) {
    const my = ++loadSeq;
    pendingAt = at;
    hlsMode = false;
    clearInterval(keepAlive);
    const qs = new URLSearchParams(isVideo ? { quality, audio } : { audio }).toString();
    showOverlay({ spin: true, text: t('재생을 준비하고 있어요', 'Getting ready to play') });
    let src = `/api/media/${id}/stream?${qs}`;
    for (;;) {
      let st;
      try {
        st = await api(`/api/media/${id}/prepare?${qs}`);
      } catch (e) {
        if (my === loadSeq && !disposed) showError(e);
        return;
      }
      if (my !== loadSeq || disposed) return;
      if (st.status === 'ready') break;
      if (st.status === 'error') return showError({ message: st.message });
      if (canHls && st.hls && st.hlsSeconds >= pendingAt + 12) {
        hlsMode = true;
        src = st.hls;
        // 화면을 보는 동안 서버 변환이 버려지지 않게 알려 준다(일시정지 중에는 브라우저가 재생 목록을 다시 받지 않을 수 있음)
        keepAlive = setInterval(() => {
          if (my !== loadSeq || disposed) return clearInterval(keepAlive);
          api(`/api/media/${id}/prepare?${qs}`).then((s) => s.status !== 'preparing' && clearInterval(keepAlive), () => {});
        }, 15_000);
        break;
      }
      showOverlay({
        spin: true,
        text: st.queued
          ? t('앞선 변환이 끝나기를 기다리는 중이에요', 'Waiting for other conversions to finish')
          : t(`브라우저에서 바로 볼 수 있게 바꾸는 중… ${st.progress}%`, `Converting for your browser… ${st.progress}%`),
        progress: st.queued ? null : st.progress,
      });
      await sleep(1000);
      if (my !== loadSeq || disposed) return;
    }
    overlay.classList.add('hidden');
    video.src = src;
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (my !== loadSeq) return;
        // 끝나지 않은 HLS 목록은 브라우저에 따라 끝 쪽에서 시작하므로 처음(또는 이어보기 위치)으로 옮긴다
        if (hlsMode ? Math.abs(video.currentTime - pendingAt) > 1 : pendingAt > 0 && pendingAt < duration() - 3) video.currentTime = pendingAt;
        video.playbackRate = rate;
        setSub(sub);
        if (autoplay) video.play().catch(() => paint());
        paintSeek();
      },
      { once: true },
    );
  }

  video.addEventListener('timeupdate', () => {
    paintSeek();
    save(false);
  });
  video.addEventListener('durationchange', paintSeek);
  video.addEventListener('play', paint);
  video.addEventListener('pause', () => {
    paint();
    save(true);
    poke();
  });
  video.addEventListener('ended', () => save(true));
  video.addEventListener('volumechange', paint);
  video.addEventListener('error', () => video.src && showError({ message: t('이 파일을 재생하지 못했어요', 'Could not play this file') }));
  document.addEventListener('fullscreenchange', paint);

  // 조작이 없으면 위·아래 막대를 숨긴다
  function poke() {
    shell.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => !video.paused && shell.classList.add('idle'), IDLE_MS);
  }
  shell.addEventListener('mousemove', poke);

  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-backdrop')) return;
    if (e.target.closest?.('textarea, select, input:not([type=range])')) return;
    if (e.code === 'Space' && e.target.closest?.('button, a')) return;
    const d = duration();
    if (e.code === 'Space') togglePlay();
    else if (e.key === 'ArrowLeft') seekTo(video.currentTime - 5);
    else if (e.key === 'ArrowRight') seekTo(Math.min(d || Infinity, video.currentTime + 5));
    else if (e.key === 'ArrowUp') setVolume(video.volume + 0.1);
    else if (e.key === 'ArrowDown') setVolume(video.volume - 0.1);
    else if (e.code === 'KeyF' && isVideo) toggleFull();
    else return;
    e.preventDefault();
    poke();
  };
  document.addEventListener('keydown', onKey);
  const onHide = () => save(true, true);
  window.addEventListener('pagehide', onHide);

  paint();
  if (info.playbackBlocked) {
    showError({ code: 'playback_blocked', message: t('프리미엄이 끝나고 7일이 지나도록 용량이 초과된 상태라 온라인 재생이 멈췄어요.', 'Online playback is paused because storage has been over the limit for 7 days after Premium ended.') });
  } else {
    // 이어보기: 마지막 위치가 끝나기 직전이 아니면 거기서부터
    const h0 = info.history;
    const at = h0 && h0.position > 5 && (!h0.duration || h0.duration - h0.position > 10) ? h0.position : 0;
    load(at);
    if (at) {
      resumeChip.replaceChildren(
        h('span', {}, t(`${formatDuration(at)}부터 이어서 재생해요`, `Resuming from ${formatDuration(at)}`)),
        h('button', { class: 'mp-btn text', onclick: () => ((pendingAt = 0), (video.currentTime = 0), resumeChip.classList.add('hidden')) }, t('처음부터', 'Start over')),
      );
      resumeChip.classList.remove('hidden');
      setTimeout(() => resumeChip.classList.add('hidden'), 6000);
    }
  }

  return () => {
    save(true);
    disposed = true;
    loadSeq++;
    clearTimeout(idleTimer);
    clearInterval(keepAlive);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', paint);
    window.removeEventListener('pagehide', onHide);
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.title = oldTitle;
  };
}
