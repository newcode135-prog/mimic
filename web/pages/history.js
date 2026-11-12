// 시청 기록(/drive/watch-history) — C-06
import { api, h, t, toastError, icon, fileIcon, formatDate, formatDuration, loadCss, confirmDialog } from '/ui.js';

export async function render(root, ctx) {
  loadCss('/css/media.css');
  const content = h('div', {}, h('div', { class: 'page-loading' }, h('div', { class: 'spinner' })));
  const clearBtn = h('button', { class: 'btn sm danger hidden', html: `${icon('trash')}<span>${t('기록 모두 지우기', 'Clear all')}</span>` });
  root.replaceChildren(h('div', { class: 'page-head' }, h('h2', {}, t('시청 기록', 'Watch history')), h('div', { class: 'spacer' }), clearBtn), content);

  let items = [];
  try {
    items = (await api('/api/media/history')).items;
  } catch (e) {
    content.replaceChildren(h('div', { class: 'empty' }, h('p', {}, e.message)));
    return;
  }

  clearBtn.onclick = async () => {
    if (!(await confirmDialog(t('시청 기록을 모두 지울까요?', 'Clear all watch history?'), t('기록만 지워지고 파일은 그대로 남아요.', 'Only the history is cleared; your files stay.'), { okLabel: t('지우기', 'Clear'), danger: true }))) return;
    try {
      await api('/api/media/history', { method: 'DELETE' });
      items = [];
      draw();
    } catch (e) {
      toastError(e);
    }
  };

  function draw() {
    clearBtn.classList.toggle('hidden', !items.length);
    if (!items.length) {
      content.replaceChildren(
        h(
          'div',
          { class: 'empty', html: icon('history') },
          h('h3', {}, t('아직 본 영상이 없어요', 'Nothing watched yet')),
          h('p', { class: 'small' }, t('드라이브에서 영상이나 음악을 재생하면 여기에 남아서, 보던 곳부터 다시 볼 수 있어요.', 'Play a video or song from your drive and it shows up here so you can pick up where you left off.')),
        ),
      );
      return;
    }
    content.replaceChildren(h('div', { class: 'file-grid wh-grid' }, ...items.map(card)));
  }

  function card(it) {
    const open = () => ctx.navigate(`/play/${it.fileId}`);
    const pct = it.duration ? Math.min(100, (it.position / it.duration) * 100) : 0;
    const done = pct >= 95;
    const fallback = h('span', { html: icon(fileIcon(it.file)) });
    const img = h('img', { src: `/api/media/${it.fileId}/thumb`, alt: '', loading: 'lazy' });
    img.onerror = () => img.replaceWith(fallback);
    const del = h('button', { class: 'btn ghost icon-btn wh-del', title: t('기록 삭제', 'Remove'), 'aria-label': t('기록 삭제', 'Remove from history'), html: icon('close') });
    del.onclick = async (e) => {
      e.stopPropagation();
      try {
        await api(`/api/media/history/${encodeURIComponent(it.fileId)}`, { method: 'DELETE' });
        items = items.filter((x) => x !== it);
        draw();
      } catch (err) {
        toastError(err);
      }
    };
    return h(
      'div',
      { class: 'file-card wh-card', role: 'link', tabindex: '0', onclick: open, onkeydown: (e) => e.key === 'Enter' && open() },
      h(
        'div',
        { class: 'file-thumb wh-thumb' },
        img,
        h('span', { class: 'wh-play', html: icon('play') }),
        it.duration ? h('span', { class: 'wh-dur' }, formatDuration(it.duration)) : null,
        h('div', { class: 'wh-bar' }, h('span', { style: { width: `${pct}%` } })),
      ),
      h('div', { class: 'file-name', title: it.file.name }, it.file.name),
      h('div', { class: 'file-meta' }, `${t('마지막 시청', 'Last watched')} ${formatDate(it.updatedAt)}`),
      h(
        'div',
        { class: 'row' },
        done
          ? h('span', { class: 'badge' }, t('끝까지 봤어요', 'Finished'))
          : h('span', { class: 'badge brand' }, `${t('이어보기', 'Resume')} ${formatDuration(it.position)}`),
      ),
      del,
    );
  }

  draw();
}
