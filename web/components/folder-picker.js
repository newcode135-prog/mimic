// 폴더 고르기 창(이동·복사·저장 위치). pickFolder({ title }) → 폴더 id(루트는 null), 취소하면 undefined
import { api, h, t, icon, modal, promptDialog, toastError, loadCss } from '/ui.js';

export function pickFolder({ title = t('폴더 고르기', 'Choose a folder'), okLabel = t('이 폴더로', 'Choose this folder'), exclude = [] } = {}) {
  loadCss('/css/drive.css');
  return new Promise((resolve) => {
    let current = null;
    let picked = false;
    const crumbs = h('div', { class: 'picker-crumbs' });
    const list = h('div', { class: 'picker-list' });

    async function go(id) {
      list.replaceChildren(h('div', { class: 'page-loading' }, h('div', { class: 'spinner' })));
      try {
        const r = await api(`/api/drive/list?parentId=${encodeURIComponent(id || '')}&sort=name&foldersFirst=1`);
        current = id;
        const trail = [{ id: null, name: t('모든 파일', 'All files') }, ...r.path];
        crumbs.replaceChildren(
          ...trail.flatMap((p, i) => [
            i ? h('span', { class: 'sep' }, '›') : null,
            i === trail.length - 1 ? h('b', {}, p.name) : h('button', { class: 'linkish', onclick: () => go(p.id) }, p.name),
          ]).filter(Boolean),
        );
        const folders = r.items.filter((x) => x.kind === 'folder' && !exclude.includes(x.id));
        list.replaceChildren(
          ...(folders.length
            ? folders.map((f) => h('button', { class: 'picker-item', onclick: () => go(f.id), html: icon('folder') }, h('span', {}, f.name), h('span', { class: 'chev', html: icon('chevronRight') })))
            : [h('p', { class: 'muted small picker-empty' }, t('안에 다른 폴더가 없어요. 이 폴더를 그대로 고르거나 새로 만들어 보세요.', 'No folders inside. Pick this one or create a new folder.'))]),
        );
      } catch (e) {
        list.replaceChildren(h('p', { class: 'muted small picker-empty' }, t('폴더를 불러오지 못했어요.', 'Could not load folders.')));
        toastError(e);
      }
    }

    const newFolder = h('button', {
      class: 'btn sm',
      html: `${icon('folderPlus')}<span>${t('새 폴더', 'New folder')}</span>`,
      onclick: async () => {
        const name = await promptDialog(t('새 폴더', 'New folder'), { placeholder: t('폴더 이름', 'Folder name') });
        if (!name) return;
        try {
          const r = await api('/api/drive/folders', { method: 'POST', body: { parentId: current, name } });
          go(r.folder.id);
        } catch (e) {
          toastError(e);
        }
      },
    });

    modal({
      title,
      body: h('div', { class: 'picker' }, crumbs, list, newFolder),
      onClose: () => !picked && resolve(undefined),
      actions: [
        { label: t('취소', 'Cancel') },
        { label: okLabel, kind: 'primary', onClick: () => ((picked = true), resolve(current)) },
      ],
    });
    go(null);
  });
}
