// 미리보기(/preview/:id) — C-05 이미지·PDF·텍스트(자막 포함), 그 밖의 파일은 정보·다운로드, zip·tar·tar.gz·gz 는 B-08 압축 풀기
import { api, h, t, toast, toastError, icon, fileIcon, formatBytes, formatDate, loadCss, bus, callComponent } from '/ui.js';
import { premiumPrompt, driveSiblings } from '/pages/player.js';

const TEXT_MAX = 1024 * 1024; // 텍스트는 앞부분 1MB 만 보여 준다

// UTF-8 이 아니면 한국어 윈도우 인코딩(CP949)으로 읽는다. 잘린 끝 글자는 stream 옵션으로 오류 없이 넘긴다
function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true });
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
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
  if (info.kind === 'video' || info.kind === 'audio') return ctx.navigate(`/play/${id}`, { replace: true });

  const f = info.file;
  const src = `/api/media/${id}/stream`;
  const folderUrl = f.parentId ? `/drive/folder/${f.parentId}` : '/drive/all';
  const btn = (label, ic, onclick) => h('button', { class: 'mp-btn', title: label, 'aria-label': label, html: icon(ic), onclick });
  const download = () => h('a', { href: `/api/drive/files/${id}/download`, download: '' }).click();
  const body = h('div', { class: 'pv-body' });
  root.replaceChildren(
    h(
      'div',
      { class: 'mp-shell pv-shell' },
      h(
        'div',
        { class: 'mp-top' },
        btn(t('뒤로', 'Back'), 'chevronLeft', () => (history.length > 1 ? history.back() : ctx.navigate(folderUrl))),
        h('div', { class: 'mp-title', title: f.name }, f.name),
        h('div', { class: 'spacer' }),
        btn(t('공유', 'Share'), 'share', () => callComponent('share', 'openShareDialog', [id])),
        btn(t('기기에 다운로드', 'Download to device'), 'download', download),
      ),
      body,
    ),
  );

  // 미리 볼 수 없는 파일: 정보와 다운로드(+ zip 이면 압축 풀기)
  const cantPreview = t('이 형식은 미리 볼 수 없어요. 기기에 내려받아 열어 보세요.', "This format can't be previewed. Download it to open on your device.");
  const card = (note, extra = null) =>
    h(
      'div',
      { class: 'pv-card' },
      h('div', { class: 'pv-card-icon', html: icon(fileIcon(f), 'lg') }),
      h('h3', {}, f.name),
      h('p', { class: 'muted' }, `${formatBytes(f.size)} · ${formatDate(f.updatedAt || f.createdAt)}`),
      h('p', { class: 'muted small' }, note),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', html: `${icon('download')}<span>${t('다운로드', 'Download')}</span>`, onclick: download }), extra),
    );

  if (info.kind === 'image') return imageViewer(body, info, src, ctx, () => body.replaceChildren(card(cantPreview)));
  if (info.kind === 'pdf') return void body.append(h('iframe', { class: 'pv-pdf', src, title: f.name }));
  if (info.kind === 'text') return void textViewer(body, src, f.size);

  const unzipBtn = h('button', { class: 'btn', html: `${icon('zip')}<span>${t('압축 풀기', 'Extract')}</span>` });
  unzipBtn.onclick = async () => {
    if (!ctx.me?.premium) return premiumPrompt(ctx, t('온라인 압축 풀기는 프리미엄 전용이에요', 'Online extraction is a Premium feature'), t('프리미엄이면 내려받지 않고 클라우드 안에서 바로 압축을 풀 수 있어요.', 'With Premium you can extract archives right in the cloud without downloading them.'));
    unzipBtn.disabled = true;
    unzipBtn.lastChild.textContent = t('푸는 중…', 'Extracting…');
    try {
      const r = await api('/api/media/unzip', { method: 'POST', body: { fileId: id } });
      bus.emit('drive:changed', { parentId: r.folder.parentId });
      const why = Object.entries(r.skippedBy || {})
        .map(([k, n]) => `${skipReason(k)} ${n}`)
        .join(', ');
      toast(r.skipped ? t(`${r.files}개를 풀었어요. 건너뜀: ${why}`, `Extracted ${r.files}. Skipped: ${why}`) : t(`${r.files}개를 풀었어요`, `Extracted ${r.files} files`), 'ok');
      ctx.navigate(`/drive/folder/${r.folder.id}`);
    } catch (e) {
      if (e.code === 'premium_required') premiumPrompt(ctx, t('온라인 압축 풀기는 프리미엄 전용이에요', 'Online extraction is a Premium feature'), e.message);
      else toastError(e);
      unzipBtn.disabled = false;
      unzipBtn.lastChild.textContent = t('압축 풀기', 'Extract');
    }
  };
  const arc = info.archive;
  body.append(
    arc?.supported
      ? card(t('압축 파일이에요. 프리미엄이면 클라우드 안에서 바로 풀 수 있어요.', 'This is an archive. Premium members can extract it in the cloud.'), unzipBtn)
      : arc
        ? card(t(`${arc.format} 압축은 아직 클라우드에서 풀 수 없어요. zip·tar·tar.gz·gz 만 풀 수 있으니, 이 파일은 내려받아 기기에서 풀어 주세요.`, `${arc.format} archives can't be extracted in the cloud yet (zip, tar, tar.gz and gz only). Download it and extract it on your device.`))
        : card(cantPreview),
  );
}

// 압축을 풀 때 건너뛴 이유(서버 skippedBy 키)
const skipReason = (k) =>
  ({
    encrypted: t('암호 걸린 파일', 'password-protected'),
    unsafe: t('안전하지 않은 경로', 'unsafe path'),
    tooLarge: t('너무 크거나 압축률이 비정상인 파일', 'too large'),
    unsupported: t('지원하지 않는 항목(링크 등)', 'unsupported entry'),
    damaged: t('손상된 파일', 'damaged'),
  })[k] || k;

async function textViewer(body, src, size) {
  const pre = h('pre', { class: 'pv-text' }, t('불러오는 중…', 'Loading…'));
  body.append(pre);
  try {
    const r = await fetch(src, { headers: { range: `bytes=0-${TEXT_MAX - 1}` }, credentials: 'same-origin' });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || t('내용을 불러오지 못했어요', 'Could not load the file'));
    pre.textContent = decode(await r.arrayBuffer());
    if (size > TEXT_MAX) body.prepend(h('div', { class: 'pv-note' }, t('앞부분 1MB 만 보여 줘요. 전체 내용은 내려받아 확인하세요.', 'Showing the first 1 MB only. Download the file to see everything.')));
  } catch (e) {
    pre.textContent = e.message;
  }
}

function imageViewer(body, info, src, ctx, onFail) {
  let scale = 1;
  let base = 0;
  const img = h('img', { class: 'pv-img', src, alt: info.file.name, draggable: 'false' });
  img.onload = () => (base = img.clientWidth);
  img.onerror = onFail; // 손상되었거나 브라우저가 못 여는 이미지는 정보·다운로드로
  const zoomText = h('span', { class: 'mp-time' }, '100%');
  const apply = () => {
    img.classList.toggle('zoomed', scale !== 1);
    img.style.width = scale === 1 ? '' : `${base * scale}px`;
    zoomText.textContent = `${Math.round(scale * 100)}%`;
  };
  const zoom = (k) => {
    scale = k ? Math.min(8, Math.max(0.1, scale * k)) : 1;
    apply();
  };
  const go = (fid) => fid && ctx.navigate(`/preview/${fid}`, { replace: true });
  let { prevId, nextId } = info.siblings;
  const tool = (label, ic, onclick, disabled = false) => h('button', { class: 'mp-btn', title: label, 'aria-label': label, html: icon(ic), onclick, disabled });
  const prevBtn = tool(t('이전 이미지', 'Previous image'), 'chevronLeft', () => go(prevId), !prevId);
  const nextBtn = tool(t('다음 이미지', 'Next image'), 'chevronRight', () => go(nextId), !nextId);
  let gone = false;
  driveSiblings(info).then((s) => {
    if (gone) return;
    ({ prevId, nextId } = s);
    prevBtn.disabled = !prevId;
    nextBtn.disabled = !nextId;
  });
  const stage = h('div', { class: 'pv-stage' }, img);
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false },
  );
  body.append(
    stage,
    h(
      'div',
      { class: 'pv-tools' },
      prevBtn,
      h('button', { class: 'mp-btn text', 'aria-label': t('축소', 'Zoom out'), onclick: () => zoom(1 / 1.25) }, '−'),
      zoomText,
      h('button', { class: 'mp-btn text', 'aria-label': t('확대', 'Zoom in'), onclick: () => zoom(1.25) }, '+'),
      h('button', { class: 'mp-btn text', onclick: () => zoom(0) }, t('맞춤', 'Fit')),
      nextBtn,
    ),
  );
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-backdrop')) return;
    if (e.key === 'ArrowLeft') go(prevId);
    else if (e.key === 'ArrowRight') go(nextId);
    else if (e.key === '+' || e.key === '=') zoom(1.25);
    else if (e.key === '-') zoom(1 / 1.25);
    else if (e.key === '0') zoom(0);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  return () => {
    gone = true;
    document.removeEventListener('keydown', onKey);
  };
}
