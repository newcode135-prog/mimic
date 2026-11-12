// 드라이브 화면: 모든 파일·폴더·최근 저장됨·즐겨찾기·휴지통·검색 (B-01~B-12)
import { api, h, t, icon, fileIcon, toast, toastError, modal, confirmDialog, promptDialog, openMenu, formatBytes, formatDate, bus, loadCss, callComponent } from '/ui.js';
import { refreshShell } from '/layout.js';
import { pickFolder } from '/components/folder-picker.js';

// ---------- 업로드 큐(B-06): 화면을 옮겨도 계속 올라간다 ----------
const queue = [];
let running = 0;
let seq = 0;
let conf = { concurrency: 3, retry: true };
const up = (job, loaded, status, error) =>
  bus.emit('transfer:update', { id: job.id, type: 'upload', name: job.file.name, size: job.file.size, loaded, status, error });

let changeTimer = null;
const changed = (parentId = null) => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    bus.emit('drive:changed', { parentId });
    refreshShell().catch(() => {});
  }, 250);
};

function enqueueUploads(entries, parentId) {
  for (const { file, path } of entries) {
    const job = { id: `up_${Date.now().toString(36)}_${++seq}`, file, path, parentId, tries: 0 };
    queue.push(job);
    up(job, 0, 'running');
  }
  if (entries.length) toast(t(`${entries.length}개 파일을 올리기 시작했어요`, `Uploading ${entries.length} file(s)`));
  pump();
}
function pump() {
  while (running < conf.concurrency && queue.length) send(queue.shift());
}
function send(job) {
  running++;
  const fd = new FormData();
  if (job.parentId) fd.append('parentId', job.parentId);
  if (job.path) fd.append('path', job.path);
  fd.append('file', job.file, job.file.name);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/drive/upload');
  xhr.upload.onprogress = (e) => up(job, Math.min(e.loaded, job.file.size), 'running'); // 멀티파트 머리글만큼 넘치지 않게
  const finish = (err) => {
    running--;
    if (!err) {
      up(job, job.file.size, 'done');
      changed(job.parentId);
    } else if (err.retry && conf.retry && job.tries < 3) {
      job.tries++;
      up(job, 0, 'running');
      setTimeout(() => (queue.push(job), pump()), 1000 * job.tries);
    } else {
      up(job, 0, 'error', err.message);
      toast(`${job.file.name}: ${err.message}`, 'error');
    }
    pump();
  };
  xhr.onload = () => {
    if (xhr.status < 300) return finish();
    let message = t('올리지 못했어요', 'Upload failed');
    try {
      message = JSON.parse(xhr.responseText).message || message;
    } catch {}
    finish({ message, retry: xhr.status >= 500 }); // 용량·쿼터 같은 4xx 는 다시 해도 같으니 재시도하지 않는다
  };
  xhr.onerror = () => finish({ message: t('네트워크가 끊겨 올리지 못했어요', 'Network error'), retry: true });
  xhr.send(fd);
}
window.addEventListener('beforeunload', (e) => {
  if (running || queue.length) e.preventDefault();
});

// 끌어다 놓은 폴더는 안쪽까지 훑어 상대 경로를 붙인다
async function collectDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: '' }));
  const out = [];
  const walk = async (entry, dir) => {
    if (entry.isFile) out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path: dir });
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      const sub = dir ? `${dir}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, sub);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

// ---------- 기기로 다운로드(B-07) ----------
// 한도를 넘으면 서버는 막지 않고 감속하며 X-Mimic-Throttled 머리글로 이유를 알려 준다
const SLOW_MSG = {
  expiry: ['프리미엄이 끝나 다운로드 속도가 느려졌어요', 'Premium has ended, so downloads are slowed down'],
  daily_quota: ['오늘 다운로드 한도를 다 써서 속도가 느려졌어요', "Today's download limit is used up, so the speed is reduced"],
  monthly_quota: ['이번 달 다운로드 쿼터를 다 써서 속도가 느려졌어요', "This month's download quota is used up, so the speed is reduced"],
};
async function download(items) {
  const files = items.filter((x) => x.kind === 'file');
  if (files.length < items.length) toast(t('폴더는 안의 파일을 골라서 내려받아 주세요', 'Open the folder and pick files to download'));
  let handed = 0;
  let slow = null;
  for (const f of files) {
    const id = `down_${f.id}_${Date.now().toString(36)}`;
    const url = `/api/drive/files/${f.id}/download`;
    // handoff: 실제 저장은 브라우저가 맡아 진행률을 알 수 없다(전송 패널이 '브라우저로 넘김'으로 보여 줄 수 있게)
    const ev = (status, loaded, error) => bus.emit('transfer:update', { id, type: 'download', name: f.name, size: f.size, loaded, status, error, handoff: status === 'done' });
    ev('running', 0);
    try {
      const r = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
      if (!r.ok) throw new Error(t('이 파일은 지금 내려받을 수 없어요', 'This file cannot be downloaded now'));
      slow ||= r.headers.get('x-mimic-throttled');
      const a = h('a', { href: url, download: f.name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      handed++;
      ev('done', f.size);
    } catch (e) {
      ev('error', 0, e.message);
      toastError(e);
    }
  }
  if (slow) {
    const msg = SLOW_MSG[slow] || SLOW_MSG.monthly_quota;
    toast(h('span', {}, t(...msg), ' ', h('a', { href: '/drive/quota', style: { color: 'inherit', textDecoration: 'underline' } }, t('쿼터 보기', 'View quota'))), 'error');
  } else if (handed) {
    toast(t('브라우저가 내려받기를 이어받았어요. 진행 상황은 브라우저의 다운로드 목록에서 볼 수 있어요', 'Your browser has taken over. Check its download list for progress'));
  }
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast(t('복사했어요', 'Copied'), 'ok'),
    () => toast(t('복사하지 못했어요. 직접 선택해서 복사해 주세요', 'Copy failed, please copy manually'), 'error'),
  );
}

const SORTS = [
  ['name', '이름 (가나다순)', 'Name (A to Z)'],
  ['name_desc', '이름 (역순)', 'Name (Z to A)'],
  ['newest', '최근에 바뀐 순', 'Newest first'],
  ['oldest', '오래된 순', 'Oldest first'],
  ['largest', '큰 파일부터', 'Largest first'],
  ['smallest', '작은 파일부터', 'Smallest first'],
];
const ORIGINS = {
  upload: ['직접 올린 파일', 'Uploaded'],
  cloud: ['클라우드 다운로드', 'Cloud download'],
  share: ['공유받아 저장', 'Saved from a share'],
  telegram: ['텔레그램', 'Telegram'],
  onboarding: ['미믹 기본 제공', 'Provided by Mimic'],
  unzip: ['압축 해제', 'Extracted'],
  copy: ['복사본', 'Copy'],
};
const DEL_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⌫' : 'Delete';
const daysLeft = (it) => Math.max(0, Math.ceil((it.expiresAt - Date.now()) / 864e5));
const isTyping = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName) || el?.isContentEditable;

export async function render(root, ctx) {
  loadCss('/css/drive.css');
  const s = ctx.me?.user?.settings || {};
  conf = { concurrency: Math.min(3, Math.max(1, Number(s.uploadConcurrency) || 3)), retry: s.uploadAutoRetry !== false };

  const p = ctx.path;
  const mode = p.startsWith('/drive/recent') ? 'recent' : p.startsWith('/drive/star') ? 'star' : p.startsWith('/drive/trash') ? 'trash' : p.startsWith('/drive/search') ? 'search' : 'folder';
  const folderId = mode === 'folder' ? ctx.params.id || null : null;
  const q = (ctx.query.q || '').trim();
  const prefKey = mode === 'folder' ? folderId || 'root' : mode;
  const touch = matchMedia('(pointer: coarse)').matches;
  const kb = (label, key) => (touch ? label : `${label} (${key})`); // 메뉴에 단축키 표시(B-12), 터치 기기는 생략

  const st = { items: [], path: [], prefs: { sort: 'name', foldersFirst: true, view: 'grid', sortScope: 'folder' }, sel: new Set(), anchor: null, error: null, loaded: false, truncated: false };
  const els = new Map();
  const selected = () => st.items.filter((x) => st.sel.has(x.id));

  const head = h('div', { class: 'page-head drive-head' });
  const body = h('div', { class: 'drive-body' }, h('div', { class: 'page-loading' }, h('div', { class: 'spinner' })));
  const selBar = h('div', { class: 'sel-bar', role: 'toolbar', 'aria-label': t('선택한 파일 도구', 'Selection tools') });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  const dirInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true });
  fileInput.onchange = () => (enqueueUploads([...fileInput.files].map((file) => ({ file, path: '' })), folderId), (fileInput.value = ''));
  dirInput.onchange = () => (enqueueUploads([...dirInput.files].map((file) => ({ file, path: file.webkitRelativePath.split('/').slice(0, -1).join('/') })), folderId), (dirInput.value = ''));
  const notice =
    mode === 'trash'
      ? h('div', { class: 'drive-notice', html: icon('info') }, h('span', {}, t('휴지통에 넣은 항목은 15일이 지나면 저절로 완전히 지워져요. 완전히 지워야 저장 공간이 돌아옵니다.', 'Items in the trash are erased for good after 15 days. Storage is freed only after erasing.')))
      : null;
  root.classList.add('drive-page');
  root.replaceChildren(...[head, notice, body, selBar, fileInput, dirInput].filter(Boolean));

  // ---------- 불러오기 ----------
  async function load() {
    const url = {
      folder: `/api/drive/list?parentId=${encodeURIComponent(folderId || '')}`,
      recent: '/api/drive/recent',
      star: '/api/drive/starred',
      trash: '/api/drive/trash',
      search: `/api/drive/search?q=${encodeURIComponent(q)}`,
    }[mode];
    try {
      const r = await api(url);
      Object.assign(st, { items: r.items, path: r.path || [], error: null, loaded: true, truncated: !!r.truncated });
      if (r.prefs) st.prefs = r.prefs;
    } catch (e) {
      Object.assign(st, { items: [], error: e, loaded: true });
    }
    const live = new Set(st.items.map((x) => x.id));
    for (const id of st.sel) if (!live.has(id)) st.sel.delete(id);
    draw();
  }
  let reloadTimer = null;
  const reload = () => (clearTimeout(reloadTimer), (reloadTimer = setTimeout(load, 150)));

  async function savePrefs(patch) {
    try {
      st.prefs = (await api('/api/drive/prefs', { method: 'PUT', body: { folderId: prefKey, ...patch } })).prefs;
      'view' in patch ? draw() : load();
    } catch (e) {
      toastError(e);
    }
  }

  // ---------- 동작 ----------
  // 일괄 API 는 한 번에 1000개까지 받는다(B-12): 큰 폴더를 전체 선택하면 나눠 보낸다
  async function bulk(path, list, extra = {}) {
    try {
      for (let i = 0; i < list.length; i += 1000) await api(path, { method: 'POST', body: { ...extra, ids: list.slice(i, i + 1000).map((x) => x.id) } });
    } catch (e) {
      if (list.length > 1000) changed(folderId); // 앞 묶음은 이미 반영됐을 수 있다
      throw e;
    }
  }
  const share = (list) => callComponent('share', 'openShareDialog', list.map((x) => x.id));
  // 영상은 플레이어로, 나머지는 미리보기로: 미리보기가 서버의 형식 판단으로 뷰어(텍스트·음악·압축 풀기 등)를 고르고, 못 보여 주면 정보·다운로드를 띄운다
  function open(it) {
    if (it.kind === 'folder') ctx.navigate(`/drive/folder/${it.id}`);
    else ctx.navigate(fileIcon(it) === 'video' ? `/play/${it.id}` : `/preview/${it.id}`);
  }
  async function external(it) {
    let r;
    try {
      r = await api(`/api/media/${it.id}/external-url`);
    } catch (e) {
      return toastError(e); // 재생 중지(403)·재생할 수 없는 파일(400) 같은 서버 안내를 그대로
    }
    const url = new URL(r.url, location.origin).href;
    const link = (label, href) => h('a', { class: 'btn block', href }, label);
    modal({
      title: t('외부 플레이어로 열기', 'Open in another player'),
      body: h(
        'div',
        { class: 'col' },
        h('p', { class: 'small muted' }, t('컴퓨터에 설치된 플레이어를 고르세요. 목록에 없으면 주소를 복사해 플레이어의 "네트워크 주소 열기"에 붙여 넣으세요. 주소는 잠시 뒤 만료돼요.', 'Pick a player installed on this computer, or copy the address into "Open network stream" in your player. It expires soon.')),
        link('PotPlayer', r.potplayer),
        link('VLC', r.vlc),
        link(t('미믹 데스크톱 앱', 'Mimic desktop app'), r.mimic),
        h('input', { class: 'input', readonly: true, value: url, onfocus: (e) => e.target.select() }),
      ),
      actions: [{ label: t('닫기', 'Close') }, { label: t('주소 복사', 'Copy address'), kind: 'primary', onClick: () => (copyText(url), false) }],
    });
  }
  async function star(list, value) {
    try {
      await bulk('/api/drive/star', list, { starred: value });
      toast(value ? t('즐겨찾기에 넣었어요', 'Added to starred') : t('즐겨찾기에서 뺐어요', 'Removed from starred'), 'ok');
      changed(folderId);
    } catch (e) {
      toastError(e);
    }
  }
  async function rename(it) {
    const name = await promptDialog(t('이름 바꾸기', 'Rename'), { value: it.name, okLabel: t('바꾸기', 'Rename') });
    if (!name || name === it.name) return;
    try {
      await api(`/api/drive/files/${it.id}`, { method: 'PATCH', body: { name } });
      changed(folderId);
    } catch (e) {
      toastError(e);
    }
  }
  async function moveOrCopy(list, kind) {
    const dest = await pickFolder({
      title: kind === 'move' ? t('어디로 옮길까요?', 'Move to') : t('어디에 복사할까요?', 'Copy to'),
      okLabel: kind === 'move' ? t('여기로 옮기기', 'Move here') : t('여기에 복사', 'Copy here'),
      exclude: list.filter((x) => x.kind === 'folder').map((x) => x.id),
    });
    if (dest === undefined) return;
    try {
      await bulk(`/api/drive/${kind}`, list, { parentId: dest });
      toast(kind === 'move' ? t(`${list.length}개 항목을 옮겼어요`, `Moved ${list.length} item(s)`) : t(`${list.length}개 항목을 복사했어요`, `Copied ${list.length} item(s)`), 'ok');
      clearSel();
      changed(folderId);
    } catch (e) {
      toastError(e);
    }
  }
  async function trash(list) {
    try {
      await bulk('/api/drive/trash', list);
      toast(t(`${list.length}개 항목을 휴지통에 넣었어요`, `Moved ${list.length} item(s) to trash`), 'ok');
      clearSel();
      changed(folderId);
    } catch (e) {
      toastError(e);
    }
  }
  async function restore(list) {
    try {
      await bulk('/api/drive/restore', list);
      toast(t(`${list.length}개 항목을 되살렸어요`, `Restored ${list.length} item(s)`), 'ok');
      clearSel();
      changed();
    } catch (e) {
      toastError(e);
    }
  }
  async function eraseForever(list) {
    const ok = await confirmDialog(t('완전히 지울까요?', 'Erase for good?'), t(`${list.length}개 항목을 지우면 되살릴 수 없어요.`, `${list.length} item(s) will be gone for good.`), { okLabel: t('완전히 지우기', 'Erase'), danger: true });
    if (!ok) return;
    try {
      await bulk('/api/drive/delete-forever', list);
      clearSel();
      changed();
    } catch (e) {
      toastError(e);
    }
  }
  async function emptyTrash() {
    const ok = await confirmDialog(t('휴지통을 비울까요?', 'Empty the trash?'), t('휴지통의 모든 항목이 완전히 지워지고 되살릴 수 없어요.', 'Everything in the trash will be erased for good.'), { okLabel: t('비우기', 'Empty'), danger: true });
    if (!ok) return;
    try {
      await api('/api/drive/trash/empty', { method: 'POST' });
      changed();
    } catch (e) {
      toastError(e);
    }
  }
  async function newFolder() {
    const name = await promptDialog(t('새 폴더', 'New folder'), { value: t('새 폴더', 'New folder'), okLabel: t('만들기', 'Create') });
    if (!name) return;
    try {
      await api('/api/drive/folders', { method: 'POST', body: { parentId: folderId, name } });
      changed(folderId);
    } catch (e) {
      toastError(e);
    }
  }
  async function details(it) {
    let info;
    try {
      info = await api(`/api/drive/files/${it.id}`);
    } catch (e) {
      return toastError(e);
    }
    const f = info.file;
    const source = f.meta?.source || f.meta?.sourceUrl || f.meta?.url;
    const origin = ORIGINS[f.origin];
    const rows = [
      [t('이름', 'Name'), f.name],
      [t('종류', 'Type'), f.kind === 'folder' ? t('폴더', 'Folder') : f.mime || t('알 수 없음', 'Unknown')],
      f.kind === 'file' && [t('크기', 'Size'), `${formatBytes(f.size)} (${Number(f.size).toLocaleString()} B)`],
      [t('위치', 'Location'), [t('모든 파일', 'All files'), ...info.path.map((x) => x.name)].join(' / ')],
      [t('저장한 날', 'Saved'), formatDate(f.createdAt)],
      [t('바뀐 날', 'Modified'), formatDate(f.updatedAt)],
      f.hash && ['SHA-256', h('code', { class: 'hash' }, f.hash)],
      [t('출처', 'Source'), h('div', { class: 'col' }, origin ? t(...origin) : f.origin || t('알 수 없음', 'Unknown'), source ? h('span', { class: 'small muted break' }, String(source)) : null)],
    ].filter(Boolean);
    const linkBox = h('div', { class: 'col' });
    const makeLink = h('button', {
      class: 'btn sm',
      html: `${icon('link')}<span>${t('다운로드 링크 만들기', 'Create download link')}</span>`,
      onclick: async () => {
        try {
          const r = await api(`/api/drive/files/${f.id}/link`);
          const url = new URL(r.url, location.origin).href;
          linkBox.replaceChildren(
            h('div', { class: 'row' }, h('input', { class: 'input', readonly: true, value: url, onfocus: (e) => e.target.select() }), h('button', { class: 'btn primary sm', onclick: () => copyText(url) }, t('복사', 'Copy'))),
            h('span', { class: 'small muted' }, t(`${formatDate(r.expiresAt)}까지 쓸 수 있어요`, `Valid until ${formatDate(r.expiresAt)}`)),
          );
          makeLink.remove();
        } catch (e) {
          toastError(e);
        }
      },
    });
    const close = modal({
      title: t('자세한 정보', 'Details'),
      body: h(
        'div',
        { class: 'col drive-details' },
        h('table', { class: 'table' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))),
        f.kind === 'file'
          ? h(
              'div',
              { class: 'link-card' },
              h('b', {}, t('다운로드 링크', 'Download link')),
              h('p', { class: 'small muted' }, t('로그인 없이 24시간 동안 받을 수 있는 주소예요. 다운로드 관리자에 붙여 넣어도 되고, 받은 만큼 내 다운로드 쿼터에서 빠져요.', 'A sign-in-free address valid for 24 hours. Works in download managers; transfers count toward your download quota.')),
              linkBox,
              makeLink,
            )
          : null,
        f.kind === 'file'
          ? h(
              'p',
              { class: 'small muted' },
              t('웹에서는 브라우저의 다운로드 폴더에 저장돼요. 저장 위치는 브라우저 설정에서 바꿀 수 있어요. SD카드에 바로 저장하는 기능은 미믹 Android 앱(출시 예정)에서 제공돼요. ', 'On the web, files go to your browser download folder (change it in browser settings). Saving straight to an SD card comes with the Mimic Android app (coming soon). '),
              h('a', { href: '/apps/mobile', onclick: () => close() }, t('모바일 앱 보기', 'About the mobile app')),
            )
          : null,
      ),
      actions: [f.kind === 'file' && { label: t('기기에 다운로드', 'Download'), onClick: () => download([f]) }, { label: t('닫기', 'Close'), kind: 'primary' }].filter(Boolean),
    });
  }

  function menuItems(list) {
    if (mode === 'trash') {
      return [
        { label: t('되살리기', 'Restore'), icon: 'restore', onClick: () => restore(list) },
        { label: kb(t('완전히 지우기', 'Erase for good'), DEL_KEY), icon: 'trash', danger: true, onClick: () => eraseForever(list) },
      ];
    }
    const one = list.length === 1 ? list[0] : null;
    const allStar = list.every((x) => x.starred);
    return [
      { label: kb(t('공유', 'Share'), 'Shift+S'), icon: 'share', onClick: () => share(list) },
      one && { label: kb(t('열기', 'Open'), 'Enter'), icon: one.kind === 'folder' ? 'folder' : 'external', onClick: () => open(one) },
      one && fileIcon(one) === 'video' && { label: t('외부 플레이어로 열기', 'Open in another player'), icon: 'play', onClick: () => external(one) },
      one && mode !== 'folder' && { label: t('들어 있는 폴더로 가기', 'Go to folder'), icon: 'folder', onClick: () => ctx.navigate(one.parentId ? `/drive/folder/${one.parentId}` : '/drive/all') },
      { label: allStar ? t('즐겨찾기에서 빼기', 'Unstar') : t('즐겨찾기에 넣기', 'Star'), icon: 'star', onClick: () => star(list, !allStar) },
      one && { label: t('자세한 정보', 'Details'), icon: 'info', onClick: () => details(one) },
      '-',
      list.some((x) => x.kind === 'file') && { label: t('기기에 다운로드', 'Download'), icon: 'download', onClick: () => download(list) },
      { label: t('이동', 'Move'), icon: 'move', onClick: () => moveOrCopy(list, 'move') },
      { label: t('복사', 'Copy'), icon: 'copy', onClick: () => moveOrCopy(list, 'copy') },
      one && { label: kb(t('이름 바꾸기', 'Rename'), 'F2'), icon: 'edit', onClick: () => rename(one) },
      '-',
      { label: kb(t('휴지통에 넣기', 'Move to trash'), DEL_KEY), icon: 'trash', danger: true, onClick: () => trash(list) },
    ];
  }

  // ---------- 선택(B-12) ----------
  function updateSel() {
    for (const [id, el] of els) {
      const on = st.sel.has(id);
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    body.classList.toggle('has-sel', st.sel.size > 0);
    drawSelBar();
  }
  function clearSel() {
    st.sel.clear();
    st.anchor = null;
    updateSel();
  }
  function toggle(id) {
    st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id);
    st.anchor = id;
    updateSel();
  }
  function clickItem(e, it) {
    // 휴지통 항목은 열 수 없으니 터치로 눌러도 선택만 한다
    if (touch && mode !== 'trash' && !st.sel.size && !e.ctrlKey && !e.shiftKey) return open(it);
    const a = st.items.findIndex((x) => x.id === st.anchor);
    if (e.shiftKey && a >= 0) {
      const b = st.items.findIndex((x) => x.id === it.id);
      if (!(e.ctrlKey || e.metaKey)) st.sel.clear();
      st.items.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => st.sel.add(x.id));
      return updateSel();
    }
    if (e.ctrlKey || e.metaKey || (touch && st.sel.size)) return toggle(it.id);
    st.sel = new Set([it.id]);
    st.anchor = it.id;
    updateSel();
  }
  function bindItem(el, it) {
    els.set(it.id, el);
    // 키보드: Tab 으로 항목에 와서 Space 는 선택 토글, Enter 는 선택(이미 선택돼 있으면 아래 onKey 가 연다)
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      if (e.target !== el || !(e.key === ' ' || (e.key === 'Enter' && !st.sel.has(it.id)))) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === ' ') return toggle(it.id);
      st.sel = new Set([it.id]);
      st.anchor = it.id;
      updateSel();
    });
    el.addEventListener('click', (e) => clickItem(e, it));
    el.addEventListener('dblclick', () => mode !== 'trash' && open(it));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!st.sel.has(it.id)) {
        st.sel = new Set([it.id]);
        st.anchor = it.id;
        updateSel();
      }
      openMenu({ x: e.clientX, y: e.clientY }, menuItems(selected()));
    });
  }
  const pickBtn = (it) =>
    h('button', { class: 'pick', 'aria-label': t('선택', 'Select'), html: icon('check'), onclick: (e) => (e.stopPropagation(), toggle(it.id)) });
  const moreBtn = (it) =>
    h('button', {
      class: 'btn ghost icon-btn more',
      'aria-label': t('메뉴 열기', 'Open menu'),
      html: icon('more'),
      onclick: (e) => {
        e.stopPropagation();
        if (!st.sel.has(it.id)) {
          st.sel = new Set([it.id]);
          st.anchor = it.id;
          updateSel();
        }
        openMenu(e.currentTarget, menuItems(selected()));
      },
    });

  // ---------- 그리기 ----------
  const badges = (it) => [
    it.origin === 'onboarding' && it.meta?.default ? h('span', { class: 'badge brand' }, t('기본', 'Default')) : null,
    it.starred && mode !== 'trash' ? h('span', { class: 'star-on', title: t('즐겨찾기', 'Starred'), html: icon('star') }) : null,
  ];
  function metaText(it) {
    if (mode === 'trash') return t(`${daysLeft(it)}일 뒤 완전히 지워짐`, `Erased in ${daysLeft(it)} day(s)`);
    const when = formatDate(mode === 'recent' ? it.createdAt : it.updatedAt, false);
    return it.kind === 'folder' ? when : `${formatBytes(it.size)} · ${when}`;
  }
  function thumb(it) {
    const ic = fileIcon(it);
    const fallback = () => h('span', { class: `kind-icon k-${ic}`, html: icon(ic) });
    if (mode === 'trash' || (ic !== 'video' && ic !== 'image')) return fallback();
    const img = h('img', { src: `/api/media/${it.id}/thumb`, alt: '', loading: 'lazy', draggable: 'false' });
    img.onerror = () => img.replaceWith(fallback());
    return img;
  }
  function card(it) {
    const el = h(
      'div',
      { class: 'file-card', role: 'option', 'aria-selected': 'false', title: it.name },
      pickBtn(it),
      h('div', { class: 'file-thumb' }, thumb(it)),
      h('div', { class: 'file-name' }, it.name),
      h('div', { class: 'file-meta row' }, h('span', {}, metaText(it)), ...badges(it)),
      moreBtn(it),
    );
    bindItem(el, it);
    return el;
  }
  function row(it) {
    const ic = fileIcon(it);
    const el = h(
      'tr',
      { 'aria-selected': 'false' },
      h('td', { class: 'cell-pick' }, pickBtn(it)),
      h('td', {}, h('div', { class: 'row name-cell' }, h('span', { class: `kind-icon k-${ic}`, html: icon(ic) }), h('span', { class: 'name', title: it.name }, it.name), ...badges(it))),
      h('td', { class: 'muted nowrap' }, it.kind === 'folder' ? '—' : formatBytes(it.size)),
      h('td', { class: 'muted nowrap hide-sm' }, formatDate(mode === 'trash' ? it.trashedAt : mode === 'recent' ? it.createdAt : it.updatedAt)),
      mode === 'trash' ? h('td', { class: 'muted nowrap' }, t(`${daysLeft(it)}일 남음`, `${daysLeft(it)} day(s) left`)) : null,
      h('td', { class: 'cell-more' }, moreBtn(it)),
    );
    bindItem(el, it);
    return el;
  }
  function emptyState() {
    if (st.error) {
      const gone = st.error.status === 404;
      return h(
        'div',
        { class: 'empty' },
        h('div', { html: icon(gone ? 'folder' : 'cloud') }),
        h('h3', {}, gone ? t('이 폴더를 찾을 수 없어요', 'Folder not found') : t('목록을 불러오지 못했어요', 'Could not load files')),
        h('p', { class: 'small' }, gone ? t('지워졌거나 휴지통으로 옮겨졌을 수 있어요.', 'It may have been deleted or moved to trash.') : st.error.message),
        gone ? h('a', { class: 'btn', href: '/drive/all' }, t('모든 파일로', 'All files')) : h('button', { class: 'btn', onclick: load }, t('다시 시도', 'Retry')),
      );
    }
    const [ic, title, sub] = {
      folder: folderId
        ? ['folder', t('빈 폴더예요', 'This folder is empty'), t('파일을 여기에 끌어다 놓으면 이 폴더로 바로 올라가요.', 'Drop files here to upload them into this folder.')]
        : ['cloud', t('아직 아무것도 없어요', 'Nothing here yet'), t('파일을 끌어다 놓거나 "올리기"를 눌러 보세요. 링크로 받으려면 왼쪽의 "클라우드 다운로드"를 쓰면 돼요.', 'Drop files or press Upload. To save from a link, use Cloud download on the left.')],
      recent: ['clock', t('최근 30일 동안 저장한 파일이 없어요', 'Nothing saved in the last 30 days'), t('새로 올리거나 받은 파일이 여기에 차례로 쌓여요.', 'Newly saved files show up here.')],
      star: ['star', t('별표한 파일이 여기 모여요', 'Starred files gather here'), t('파일 메뉴에서 "즐겨찾기에 넣기"를 눌러 보세요.', 'Choose "Star" from a file menu.')],
      trash: ['trash', t('휴지통이 비어 있어요', 'Trash is empty'), t('지운 파일은 15일 동안 여기에서 되살릴 수 있어요.', 'Deleted files can be restored here for 15 days.')],
      search: ['search', q ? t(`"${q}"에 맞는 파일이 없어요`, `No files match "${q}"`) : t('찾을 낱말을 입력해 주세요', 'Type something to search'), t('다른 낱말로 다시 찾아보세요.', 'Try a different word.')],
    }[mode];
    return h('div', { class: 'empty' }, h('div', { html: icon(ic) }), h('h3', {}, title), h('p', { class: 'small' }, sub));
  }

  function drawHead() {
    let title;
    if (mode === 'folder') {
      const trail = [{ id: null, name: t('모든 파일', 'All files') }, ...st.path];
      title = h(
        'nav',
        { class: 'crumbs', 'aria-label': t('경로', 'Path') },
        ...trail.flatMap((x, i) => [
          i ? h('span', { class: 'sep', html: icon('chevronRight') }) : null,
          i === trail.length - 1 ? h('span', { class: 'here' }, x.name) : h('a', { href: x.id ? `/drive/folder/${x.id}` : '/drive/all' }, x.name),
        ]),
      );
    } else {
      const label = { recent: t('최근 저장됨', 'Recent'), star: t('즐겨찾기', 'Starred'), trash: t('휴지통', 'Trash'), search: q ? t(`"${q}" 검색 결과`, `Results for "${q}"`) : t('검색', 'Search') }[mode];
      const n = st.items.length;
      const count = st.truncated ? t(`앞의 ${n}개만 보여요 · 검색어를 더 좁혀 보세요`, `Showing the first ${n} · try a narrower search`) : t(`${n}개`, `${n}`);
      title = h('div', { class: 'crumbs' }, h('span', { class: 'here' }, label), st.loaded && !st.error ? h('span', { class: 'count' }, count) : null);
    }
    const tools = [];
    if (mode === 'folder') {
      const upBtn = h('button', { class: 'btn primary', html: `${icon('upload')}<span>${t('올리기', 'Upload')}</span>` });
      upBtn.onclick = (e) => {
        e.stopPropagation();
        openMenu(upBtn, [
          { label: t('파일 올리기', 'Upload files'), icon: 'file', onClick: () => fileInput.click() },
          { label: t('폴더 올리기', 'Upload a folder'), icon: 'folder', onClick: () => dirInput.click() },
        ]);
      };
      tools.push(upBtn, h('button', { class: 'btn', onclick: newFolder, html: `${icon('folderPlus')}<span>${t('새 폴더', 'New folder')}</span>` }));
    }
    if (mode === 'trash' && st.items.length) tools.push(h('button', { class: 'btn danger', onclick: emptyTrash, html: `${icon('trash')}<span>${t('휴지통 비우기', 'Empty trash')}</span>` }));
    if (mode === 'folder' || mode === 'star' || mode === 'search') {
      const sortBtn = h('button', { class: 'btn ghost', 'aria-label': t('정렬', 'Sort'), html: `${icon('sort')}<span class="hide-sm">${t(...SORTS.find((x) => x[0] === st.prefs.sort).slice(1))}</span>` });
      sortBtn.onclick = (e) => {
        e.stopPropagation();
        const mark = (on) => (on ? 'check' : null);
        openMenu(sortBtn, [
          ...SORTS.map(([k, ko, en]) => ({ label: t(ko, en), icon: mark(st.prefs.sort === k), onClick: () => savePrefs({ sort: k }) })),
          '-',
          { label: t('폴더를 항상 위에', 'Folders on top'), icon: mark(st.prefs.foldersFirst), onClick: () => savePrefs({ foldersFirst: !st.prefs.foldersFirst }) },
          '-',
          { label: t('폴더마다 따로 기억', 'Remember per folder'), icon: mark(st.prefs.sortScope !== 'global'), onClick: () => savePrefs({ sortScope: 'folder' }) },
          { label: t('모든 폴더에 똑같이', 'Same for every folder'), icon: mark(st.prefs.sortScope === 'global'), onClick: () => savePrefs({ sortScope: 'global', sort: st.prefs.sort, foldersFirst: st.prefs.foldersFirst }) },
        ]).classList.add('drive-check-menu');
      };
      tools.push(sortBtn);
    }
    const grid = st.prefs.view !== 'list';
    tools.push(
      h('button', {
        class: 'btn ghost icon-btn',
        title: grid ? t('목록으로 보기', 'List view') : t('격자로 보기', 'Grid view'),
        'aria-label': grid ? t('목록으로 보기', 'List view') : t('격자로 보기', 'Grid view'),
        html: icon(grid ? 'list' : 'grid'),
        onclick: () => savePrefs({ view: grid ? 'list' : 'grid' }),
      }),
    );
    head.replaceChildren(title, h('div', { class: 'spacer' }), h('div', { class: 'row drive-tools' }, ...tools));
  }

  function drawSelBar() {
    const list = selected();
    selBar.classList.toggle('show', list.length > 0);
    if (!list.length) return selBar.replaceChildren();
    const b = (ic, label, fn, cls = '', key) => h('button', { class: `btn ghost sm ${cls}`, title: key ? kb(label, key) : label, onclick: () => fn(list), html: `${icon(ic)}<span class="hide-sm">${label}</span>` });
    const allStar = list.every((x) => x.starred);
    const tools =
      mode === 'trash'
        ? [b('restore', t('되살리기', 'Restore'), restore), b('trash', t('완전히 지우기', 'Erase'), eraseForever, 'danger', DEL_KEY)]
        : [
            b('share', t('공유', 'Share'), share, '', 'Shift+S'),
            list.some((x) => x.kind === 'file') ? b('download', t('다운로드', 'Download'), download) : null,
            b('move', t('이동', 'Move'), (l) => moveOrCopy(l, 'move')),
            b('copy', t('복사', 'Copy'), (l) => moveOrCopy(l, 'copy')),
            b('star', allStar ? t('즐겨찾기 빼기', 'Unstar') : t('즐겨찾기', 'Star'), (l) => star(l, !allStar)),
            b('trash', t('삭제', 'Delete'), trash, 'danger', DEL_KEY),
          ];
    selBar.replaceChildren(
      h('span', { class: 'sel-count' }, t(`${list.length}개 선택`, `${list.length} selected`)),
      ...tools.filter(Boolean),
      h('button', { class: 'btn ghost icon-btn sm', title: t('선택 해제', 'Clear selection'), 'aria-label': t('선택 해제', 'Clear selection'), onclick: clearSel, html: icon('close') }),
    );
  }

  function draw() {
    drawHead();
    els.clear();
    if (!st.items.length) body.replaceChildren(emptyState());
    else if (st.prefs.view === 'list') {
      body.replaceChildren(
        h(
          'div',
          { class: 'file-list card' },
          h(
            'table',
            { class: 'table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { class: 'cell-pick' }),
                h('th', {}, t('이름', 'Name')),
                h('th', {}, t('크기', 'Size')),
                h('th', { class: 'hide-sm' }, mode === 'trash' ? t('지운 날', 'Deleted') : mode === 'recent' ? t('저장한 날', 'Saved') : t('바뀐 날', 'Modified')),
                mode === 'trash' ? h('th', {}, t('남은 기간', 'Left')) : null,
                h('th', { class: 'cell-more' }),
              ),
            ),
            h('tbody', {}, ...st.items.map(row)),
          ),
        ),
      );
    } else body.replaceChildren(h('div', { class: 'file-grid', role: 'listbox', 'aria-multiselectable': 'true' }, ...st.items.map(card)));
    updateSel();
  }

  // ---------- 바탕 클릭·우클릭·끌어다 놓기 ----------
  body.addEventListener('click', (e) => {
    if (!e.target.closest('.file-card, tr, button')) clearSel();
  });
  body.addEventListener('contextmenu', (e) => {
    if (mode !== 'folder' || e.target.closest('.file-card, tbody tr')) return;
    e.preventDefault();
    openMenu({ x: e.clientX, y: e.clientY }, [
      { label: t('파일 올리기', 'Upload files'), icon: 'upload', onClick: () => fileInput.click() },
      { label: t('폴더 올리기', 'Upload a folder'), icon: 'folder', onClick: () => dirInput.click() },
      { label: t('새 폴더', 'New folder'), icon: 'folderPlus', onClick: newFolder },
    ]);
  });
  if (mode === 'folder') {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    root.addEventListener('dragenter', (e) => hasFiles(e) && (e.preventDefault(), depth++, root.classList.add('dropping')));
    root.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
    root.addEventListener('dragleave', () => --depth <= 0 && ((depth = 0), root.classList.remove('dropping')));
    root.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      root.classList.remove('dropping');
      try {
        enqueueUploads(await collectDrop(e.dataTransfer), folderId);
      } catch (err) {
        toastError(err);
      }
    });
  }

  // ---------- 단축키(B-12) ----------
  function onKey(e) {
    if (document.querySelector('.modal-backdrop') || isTyping(e.target)) return;
    // 버튼·링크·메뉴에 포커스가 있으면 Enter 는 그 버튼을 누르는 키다
    if (e.key === 'Enter' && e.target.closest?.('button, a, [role=menu]')) return;
    const list = selected();
    // 글자 키는 라틴 문자가 아니면(한글 입력 상태 'ㅆ' 등) 물리 키 위치로 본다
    const key = e.key.toLowerCase();
    const k = /^[a-z]$/.test(key) || !e.code?.startsWith('Key') ? key : e.code.slice(3).toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'a') {
      e.preventDefault();
      st.sel = new Set(st.items.map((x) => x.id));
      return updateSel();
    }
    if (e.key === 'Escape') return clearSel();
    if (!list.length || e.altKey) return;
    // Mac 키보드에는 Delete 키가 없어 ⌘⌫ 도 받는다
    if (e.metaKey ? e.key === 'Backspace' : e.key === 'Delete' && !e.ctrlKey) {
      e.preventDefault();
      mode === 'trash' ? eraseForever(list) : trash(list);
    } else if (e.ctrlKey || e.metaKey || mode === 'trash') {
      return;
    } else if (e.key === 'F2' && list.length === 1) {
      e.preventDefault();
      rename(list[0]);
    } else if (e.key === 'Enter' && list.length === 1) {
      e.preventDefault();
      open(list[0]);
    } else if (e.shiftKey && k === 's') {
      e.preventDefault();
      share(list);
    }
  }
  document.addEventListener('keydown', onKey);
  const offChanged = bus.on('drive:changed', reload);

  drawHead();
  await load();
  return () => {
    document.removeEventListener('keydown', onKey);
    offChanged();
    clearTimeout(reloadTimer);
  };
}
