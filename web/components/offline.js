// "클라우드 다운로드 작업 만들기" 창(A-01·A-02·A-03·A-04). openCreateTask({ parentId })
import { api, h, t, icon, modal, toast, bus, loadCss, callComponent } from '/ui.js';

const MAX_UPLOADS = 20; // 서버의 한 번에 올리는 토렌트 파일 수 상한과 같다

// 이미 드라이브 폴더 화면에 있으면 그 폴더를 기본 저장 위치로 쓴다
const currentFolder = () => /^\/drive\/folder\/([^/]+)/.exec(location.pathname)?.[1] ?? null;

export function allowanceText(a) {
  if (!a) return '';
  if (a.unlimited) return t('프리미엄: 무제한', 'Premium: unlimited');
  const extra = a.bonusLeft ? t(` (보너스 ${a.bonusLeft}회 포함)`, ` (incl. ${a.bonusLeft} bonus)`) : '';
  return t(`오늘 남은 무료 횟수 ${a.remaining}회${extra}`, `${a.remaining} free left today${extra}`);
}

async function folderName(id) {
  if (!id) return t('내 드라이브', 'My drive');
  try {
    return (await api(`/api/drive/files/${encodeURIComponent(id)}`)).file?.name || t('선택한 폴더', 'Selected folder');
  } catch {
    return t('선택한 폴더', 'Selected folder');
  }
}

// 붙여 넣은 글에서 마그넷·.torrent 주소만 골라낸다(K-07 토렌트 링크 자동 인식)
export const torrentLinks = (text) => [...new Set(String(text || '').match(/magnet:\?[^\s"'<>]+|https?:\/\/[^\s"'<>]+?\.torrent(?:\?[^\s"'<>)]*)?(?=[\s"'<>),.;]|$)/gi) || [])];

const LINK_HINT = ['마그넷 링크, .torrent 주소, HTTP(S) 파일 주소, YouTube·X·TikTok·Facebook 게시물 주소를 넣을 수 있어요. 여러 개는 한 줄에 하나씩 적어 주세요.', 'Magnet links, .torrent URLs, direct HTTP(S) file URLs and YouTube, X, TikTok or Facebook post URLs. One per line for several.'];
const LINK_HINT_NO_SOCIAL = ['마그넷 링크, .torrent 주소, HTTP(S) 파일 주소를 넣을 수 있어요. 이 서버에는 SNS 저장 도구가 없어 YouTube·X·TikTok·Facebook 게시물은 저장할 수 없어요. 여러 개는 한 줄에 하나씩 적어 주세요.', 'Magnet links, .torrent URLs and direct HTTP(S) file URLs. Social posts (YouTube, X, TikTok, Facebook) are not available on this server. One per line for several.'];

// links: 미리 채울 링크(붙여 넣기 자동 인식)
export async function openCreateTask({ parentId, links: prefill } = {}) {
  loadCss('/css/offline.css');
  let target = parentId === undefined ? currentFolder() : parentId;
  let torrents = [];

  const quota = h('div', { class: 'ol-quota' }, t('남은 횟수를 확인하는 중…', 'Checking your allowance…'));
  const addMore = h('a', { class: 'btn sm accent hidden', href: '/drive/payment' }, t('횟수 추가', 'Get more'));
  const linkHint = h('div', { class: 'hint' }, t(...LINK_HINT));
  api('/api/offline/allowance')
    .then((a) => {
      quota.textContent = allowanceText(a);
      addMore.classList.toggle('hidden', a.unlimited || a.remaining > 0);
      if (a.social === false) linkHint.textContent = t(...LINK_HINT_NO_SOCIAL);
    })
    .catch(() => (quota.textContent = ''));

  const links = h('textarea', {
    class: 'input ol-links',
    rows: 6,
    spellcheck: 'false',
    placeholder: t('magnet:?xt=urn:btih:…\nhttps://example.com/video.mp4\nhttps://youtu.be/…', 'magnet:?xt=urn:btih:…\nhttps://example.com/video.mp4\nhttps://youtu.be/…'),
    'aria-label': t('저장할 링크', 'Links to save'),
  });
  if (prefill?.length) links.value = [].concat(prefill).join('\n');

  const where = h('span', { class: 'ol-where-name' }, '…');
  folderName(target).then((n) => (where.textContent = n));
  const whereBtn = h('button', {
    class: 'btn sm',
    type: 'button',
    onclick: async () => {
      const id = await callComponent('folder-picker', 'pickFolder', { title: t('저장할 폴더 고르기', 'Choose where to save') });
      if (id === undefined) return; // 취소
      target = id;
      where.textContent = await folderName(id);
    },
  }, t('바꾸기', 'Change'));

  const file = h('input', { type: 'file', accept: '.torrent,application/x-bittorrent', multiple: true, hidden: true });
  const chosen = h('div', { class: 'ol-chosen' });
  const drawChosen = () =>
    chosen.replaceChildren(
      ...torrents.map((f, i) =>
        h('span', { class: 'badge' }, f.name, h('button', { class: 'ol-x', type: 'button', 'aria-label': t('빼기', 'Remove'), html: icon('close'), onclick: () => (torrents.splice(i, 1), drawChosen()) })),
      ),
    );
  file.onchange = () => {
    torrents = [...torrents, ...file.files].filter((f, i, arr) => arr.findIndex((x) => x.name === f.name && x.size === f.size) === i);
    file.value = '';
    drawChosen();
  };

  const body = h(
    'div',
    { class: 'ol-create' },
    h('div', { class: 'row ol-quota-row' }, h('span', { html: icon('cloudDown') }), quota, h('div', { class: 'spacer' }), addMore),
    h(
      'div',
      { class: 'field' },
      h('label', {}, t('링크', 'Links')),
      links,
      linkHint,
    ),
    h(
      'div',
      { class: 'field' },
      h('label', {}, t('토렌트 파일', 'Torrent files')),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', html: `${icon('torrent')}<span>${t('토렌트 파일 선택', 'Choose .torrent files')}</span>`, onclick: () => file.click() }), file),
      chosen,
      h('div', { class: 'hint' }, t('토렌트 파일은 4MB까지 올릴 수 있어요. 토렌트 하나에 파일이 7,000개까지 들어 있을 수 있고, 안의 파일은 모두 함께 저장돼요.', 'Torrent files up to 4MB. Up to 7,000 files per torrent; every file in it is saved.')),
    ),
    h('div', { class: 'field' }, h('label', {}, t('저장 위치', 'Save to')), h('div', { class: 'row ol-where', html: icon('folder') }, where, h('div', { class: 'spacer' }), whereBtn)),
  );

  async function submit() {
    const text = links.value.trim();
    if (!text && !torrents.length) {
      toast(t('링크를 넣거나 토렌트 파일을 골라 주세요', 'Paste a link or choose a torrent file'), 'error');
      return false;
    }
    if (torrents.length > MAX_UPLOADS) {
      toast(t(`토렌트 파일은 한 번에 ${MAX_UPLOADS}개까지 올릴 수 있어요`, `Up to ${MAX_UPLOADS} torrent files at a time`), 'error');
      return false;
    }
    const made = [];
    const invalid = [];
    const report = () => {
      const blocked = made.filter((x) => x.status === 'blocked').length;
      toast(
        t(`클라우드 다운로드 ${made.length}건을 만들었어요`, `Created ${made.length} cloud download(s)`) +
          (blocked ? t(` · 차단 ${blocked}건`, ` · ${blocked} blocked`) : '') +
          (invalid.length ? t(` · 인식하지 못한 링크 ${invalid.length}개`, ` · ${invalid.length} unrecognized`) : ''),
        'ok',
      );
      bus.emit('offline:created', { tasks: made });
      bus.emit('transfers:open', { tab: 'cloud' });
    };
    if (text) {
      const r = await api('/api/offline/tasks', { method: 'POST', body: { text, parentId: target } });
      made.push(...r.tasks);
      invalid.push(...r.invalid);
      links.value = ''; // 아래 토렌트 업로드가 실패해 다시 눌러도 같은 링크로 작업을 또 만들지 않게
    }
    if (torrents.length) {
      const fd = new FormData();
      if (target) fd.append('parentId', target);
      torrents.forEach((f) => fd.append('file', f, f.name));
      try {
        const r = await api('/api/offline/torrent', { method: 'POST', body: fd });
        made.push(...r.tasks);
        invalid.push(...r.invalid);
      } catch (e) {
        if (made.length) report(); // 링크 작업은 이미 만들어졌다. 창은 토렌트 파일만 남긴 채 열어 둔다
        throw e;
      }
    }
    report();
  }

  const close = modal({
    title: t('클라우드 다운로드 작업 만들기', 'New cloud download'),
    body,
    actions: [
      { label: t('취소', 'Cancel') },
      { label: t('바로 만들기', 'Create now'), kind: 'primary', onClick: submit },
    ],
  });
  addMore.addEventListener('click', () => close());
  links.focus();
}
