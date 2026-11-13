// 나의 공유(/drive/shared): 내가 만든 공유와 내가 저장한 공유(D-01~D-05), 공유 코드로 찾기(D-02)
import { api, h, t, modal, toast, toastError, loadCss, icon, openMenu, confirmDialog, formatDate, bus } from '/ui.js';
import { copyText, shareUrl, expiryLabel, expiryPicker, passwordField, viewModeField, codeField, resultView } from '/components/share.js';

const STATUS = { active: ['badge brand', '공유 중', 'Active'], expired: ['badge', '기간 끝남', 'Expired'], revoked: ['badge danger', '취소됨', 'Cancelled'], unavailable: ['badge danger', '열 수 없음', 'Unavailable'] };
const statusBadge = (st) => h('span', { class: STATUS[st][0] }, t(STATUS[st][1], STATUS[st][2]));
// 신고 처리로 차단된 공유(J-01): 배지와 이의제기 링크(대상 칸에 이 공유 링크를 채워 연다)
const blockedNotice = (s) => [
  h('span', { class: 'badge danger', title: t('신고 처리로 이 공유의 파일이 차단되어 받는 사람이 열거나 저장할 수 없어요', 'Files in this share were blocked after a report, so recipients cannot open or save them') }, t('차단됨', 'Blocked')),
  h('a', { class: 'small', href: `/copyright?tab=appeal&type=share&target=${encodeURIComponent(shareUrl(s.url))}` }, t('이의제기', 'Appeal')),
];
const titleOf = (s) => (s.fileIds?.length > 1 ? `${s.title} ${t(`외 ${s.fileIds.length - 1}개`, `+${s.fileIds.length - 1}`)}` : s.title);

export async function render(root, ctx) {
  loadCss('/css/share.css');
  let tab = ctx.query.tab === 'saved' ? 'saved' : 'mine';
  const body = h('div');
  const tabs = h('div', { class: 'tabs' });
  const codeInput = h('input', { class: 'input', maxlength: 16, placeholder: t('공유 코드로 찾기', 'Find by share code'), 'aria-label': t('공유 코드', 'Share code') });
  const find = async () => {
    const code = codeInput.value.trim();
    if (!code) return;
    try {
      const r = await api(`/api/share/lookup?code=${encodeURIComponent(code)}`);
      if (r.warn) {
        const ok = await confirmDialog(t('공유 열기 전에 확인', 'Before opening'), t('이 코드로 찾은 공유는 다른 사람이 올린 파일이에요. 믿을 수 있는 사람에게 받은 코드인지 확인하고 열어 주세요.', 'This share was uploaded by someone else. Open it only if you trust the person who gave you the code.'), { okLabel: t('열기', 'Open') });
        if (!ok) return;
      }
      ctx.navigate(r.url);
    } catch (e) {
      toastError(e);
    }
  };
  codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && find());

  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('h2', {}, t('나의 공유', 'My shares')),
      h('div', { class: 'spacer' }),
      h('div', { class: 'row share-find' }, codeInput, h('button', { class: 'btn', onclick: find, html: `${icon('search')}<span>${t('찾기', 'Find')}</span>` })),
    ),
    tabs,
    body,
  );

  async function draw() {
    tabs.replaceChildren(
      ...[
        ['mine', '내가 만든 공유', 'Shared by me'],
        ['saved', '저장한 공유', 'Saved shares'],
      ].map(([k, ko, en]) => h('button', { class: tab === k ? 'active' : '', onclick: () => ((tab = k), history.replaceState({}, '', `/drive/shared${k === 'saved' ? '?tab=saved' : ''}`), draw()) }, t(ko, en))),
    );
    body.replaceChildren(h('div', { class: 'page-loading' }, h('div', { class: 'spinner' })));
    try {
      body.replaceChildren(tab === 'mine' ? await mineView() : await savedView());
    } catch (e) {
      body.replaceChildren(h('div', { class: 'empty' }, e.message));
    }
  }

  // ---------- 내가 만든 공유 ----------
  async function mineView() {
    const { items } = await api('/api/share/mine');
    if (!items.length) return empty('share', t('아직 공유한 파일이 없어요', 'Nothing shared yet'), t('드라이브에서 파일을 고르고 "공유"를 누르면 링크가 만들어져요.', 'Pick files in your drive and choose "Share".'));
    return h(
      'div',
      { class: 'card share-table' },
      h(
        'table',
        { class: 'table' },
        h('thead', {}, h('tr', {}, ...[t('이름', 'Name'), t('만든 날', 'Created'), t('만료', 'Expires'), t('비밀번호', 'Password'), t('조회', 'Views'), t('저장', 'Saves'), ''].map((x) => h('th', {}, x)))),
        h(
          'tbody',
          {},
          ...items.map((s) =>
            h(
              'tr',
              {},
              h('td', {}, h('div', { class: 'row' }, h('a', { href: s.url, class: 'share-name' }, titleOf(s)), s.status !== 'active' ? statusBadge(s.status) : s.blocked ? blockedNotice(s) : s.liveCount === 0 ? h('span', { class: 'badge danger', title: t('공유한 파일이 모두 휴지통에 있거나 지워져 받는 사람에게 보이는 것이 없어요', 'All shared items are in the trash or deleted, so recipients see nothing') }, t('원본 없음', 'Source gone')) : null, s.code ? h('span', { class: 'badge', title: t('공유 코드', 'Share code') }, s.code) : null)),
              h('td', {}, formatDate(s.createdAt, false)),
              h('td', {}, expiryLabel(s.expiresAt)),
              h('td', {}, s.hasPassword ? h('span', { class: 'row', html: `${icon('lock')}<span>${t('있음', 'On')}</span>` }) : t('없음', 'Off')),
              h('td', {}, s.viewCount),
              h('td', {}, s.saveCount),
              h(
                'td',
                { class: 'share-actions' },
                h('button', { class: 'btn sm', onclick: () => copyText(shareUrl(s.url)), html: `${icon('link')}<span>${t('링크 복사', 'Copy link')}</span>` }),
                h('button', {
                  class: 'btn ghost icon-btn',
                  'aria-label': t('더 보기', 'More'),
                  html: icon('more'),
                  onclick: (e) => {
                    e.stopPropagation();
                    openMenu(e.currentTarget, [
                      { label: t('수정', 'Edit'), icon: 'edit', onClick: () => editShare(s) },
                      { label: t('공유 코드', 'Share code'), icon: 'ticket', onClick: () => codeDialog(s) },
                      '-',
                      { label: t('공유 취소', 'Cancel share'), icon: 'trash', danger: true, onClick: () => revoke(s) },
                    ]);
                  },
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function editShare(s) {
    const expiry = expiryPicker(0, { keep: true });
    const pw = passwordField(s.hasPassword, { keep: s.hasPassword });
    const view = viewModeField(s.viewMode);
    modal({
      title: t('공유 수정', 'Edit share'),
      body: h(
        'div',
        { class: 'share-dialog' },
        h('div', { class: 'field' }, h('label', {}, t('만료(지금부터 다시 계산)', 'Expires (counted from now)')), expiry),
        pw,
        view,
      ),
      actions: [
        { label: t('취소', 'Cancel') },
        {
          label: t('저장', 'Save'),
          kind: 'primary',
          onClick: async () => {
            const body = { viewMode: view.querySelector('select').value };
            if (expiry.value !== undefined) body.expiryDays = expiry.value;
            const next = pw.read();
            if (next !== undefined) body.password = next;
            const r = await api(`/api/share/${s.id}`, { method: 'PATCH', body });
            toast(t('공유를 수정했어요', 'Share updated'), 'ok');
            if (r.password) modal({ title: t('새 비밀번호', 'New password'), body: resultView(r.share, r.password) });
            draw();
          },
        },
      ],
    });
  }

  function codeDialog(s) {
    modal({ title: t('공유 코드', 'Share code'), body: codeField(s, () => draw()), actions: [{ label: t('닫기', 'Close') }] });
  }

  async function revoke(s) {
    const ok = await confirmDialog(t('공유 취소', 'Cancel share'), t('링크와 공유 코드가 더 이상 열리지 않아요. 받는 사람이 이미 저장한 파일은 그대로 남아요.', 'The link and code will stop working. Copies already saved by others stay.'), { okLabel: t('공유 취소', 'Cancel share'), danger: true });
    if (!ok) return;
    try {
      await api(`/api/share/${s.id}`, { method: 'DELETE' });
      toast(t('공유를 취소했어요', 'Share cancelled'), 'ok');
      draw();
    } catch (e) {
      toastError(e);
    }
  }

  // ---------- 저장한 공유(D-04) ----------
  async function savedView() {
    const { items } = await api('/api/share/saved');
    if (!items.length) return empty('download', t('저장한 공유가 없어요', 'No saved shares'), t('받은 공유 링크에서 "내 드라이브에 저장"을 누르면 여기에 모여요.', 'Shares you save to your drive show up here.'));
    return h(
      'div',
      { class: 'card share-table' },
      h(
        'table',
        { class: 'table' },
        h('thead', {}, h('tr', {}, ...[t('저장한 항목', 'Saved item'), t('공유', 'Share'), t('마지막 동기화', 'Last synced'), ''].map((x) => h('th', {}, x)))),
        h(
          'tbody',
          {},
          ...items.map((v) =>
            h(
              'tr',
              {},
              h(
                'td',
                {},
                h(
                  'div',
                  { class: 'row' },
                  h('span', { html: icon(v.kind === 'folder' ? 'folder' : 'file') }),
                  v.savedName
                    ? v.kind === 'folder'
                      ? h('a', { href: `/drive/folder/${v.savedRootId}` }, v.savedName)
                      : h('span', {}, v.savedName)
                    : h('span', { class: 'muted' }, t('내 드라이브에서 지워짐', 'Removed from drive')),
                  v.hasUpdates ? h('span', { class: 'badge accent' }, t('새 파일 있음', 'New files')) : null,
                  v.locked ? h('span', { class: 'badge' }, t('비밀번호 바뀜', 'Password changed')) : null,
                ),
              ),
              h('td', {}, h('div', { class: 'row' }, v.status === 'active' ? h('a', { href: v.url }, v.title) : h('span', {}, v.title), v.status !== 'active' ? statusBadge(v.status) : null)),
              h('td', {}, formatDate(v.lastSyncedAt)),
              h(
                'td',
                { class: 'share-actions' },
                v.locked
                  ? h('a', { class: 'btn sm', href: v.url, html: `${icon('lock')}<span>${t('새 비밀번호 입력', 'Enter new password')}</span>` })
                  : v.kind === 'folder' && v.status === 'active' && v.savedName
                    ? h('button', { class: `btn sm${v.hasUpdates ? ' primary' : ''}`, onclick: (e) => sync(v, e.currentTarget), html: `${icon('refresh')}<span>${t('동기화', 'Sync')}</span>` })
                    : null,
                h('button', { class: 'btn ghost sm', onclick: () => forget(v) }, t('목록에서 빼기', 'Remove')),
              ),
            ),
          ),
        ),
      ),
    );
  }

  async function sync(v, btn) {
    btn.disabled = true;
    try {
      const r = await api(`/api/share/saved/${v.id}/sync`, { method: 'POST', body: {} });
      toast(r.added ? t(`새 항목 ${r.added}개를 가져왔어요`, `Added ${r.added} new items`) : t('이미 최신 상태예요', 'Already up to date'), 'ok');
      if (r.added) bus.emit('drive:changed', { parentId: v.savedRootId });
      draw();
    } catch (e) {
      // 공유 비밀번호가 바뀌었으면 공유 페이지에서 다시 풀게 한다
      if (e.code === 'password_required') return ctx.navigate(v.url);
      toastError(e);
      btn.disabled = false;
    }
  }

  async function forget(v) {
    try {
      await api(`/api/share/saved/${v.id}`, { method: 'DELETE' });
      draw();
    } catch (e) {
      toastError(e);
    }
  }

  await draw();
}

function empty(ic, title, hint) {
  return h('div', { class: 'empty' }, h('div', { html: icon(ic) }), h('h3', {}, title), h('p', { class: 'small' }, hint));
}
