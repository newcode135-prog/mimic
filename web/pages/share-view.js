// 공유 받는 사람 화면(/s/:token, 로그인 없이 열림): 만료·취소 안내, 비밀번호, 파일 목록(격자/목록), 폴더 이동,
// 미리보기·다운로드(로그인 필요), 내 드라이브에 저장, 가입 유도(공유한 사람의 초대 코드), 신고 링크
import { api, h, t, modal, toast, toastError, confirmDialog, loadCss, icon, fileIcon, formatBytes, formatDate, useComponent, openMenu, bus } from '/ui.js';
import { expiryLabel } from '/components/share.js';

const viewChoice = new Map(); // token → 이 탭에서 고른 보기 방식
// 글자로 보여 줄 파일(내용은 textContent 로만 넣으니 HTML·JS 도 실행되지 않는다). 앞부분만 받아 쿼터를 아낀다
const TEXT_EXT = /\.(txt|md|srt|vtt|ass|ssa|smi|log|csv|json|xml|nfo|ini|ya?ml|cue|html?|js|css)$/i;
const TEXT_MAX = 256 * 1024;
const isText = (n) => n.kind === 'file' && (TEXT_EXT.test(n.name) || /^text\//i.test(n.mime || ''));
const previewable = (n) => isText(n) || ['video', 'audio', 'image'].includes(fileIcon(n));

export async function render(root, ctx) {
  loadCss('/css/share.css');
  const token = ctx.params.token;
  const base = `/api/share/public/${encodeURIComponent(token)}`;
  const folderId = ctx.query.folder || null;
  const me = ctx.user;
  const here = location.pathname + location.search;
  const wrap = h('div', { class: 'container share-view' });
  root.replaceChildren(wrap, h('div', { class: 'page-loading' }, h('div', { class: 'spinner' })));

  let info;
  try {
    info = (await api(base)).share;
  } catch (e) {
    root.replaceChildren(wrap);
    return wrap.replaceChildren(closedView(e));
  }
  if (!info.unlocked) {
    root.replaceChildren(wrap);
    return wrap.replaceChildren(lockView(info, base, () => render(root, ctx)));
  }

  let list;
  try {
    list = await api(`${base}/list${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`);
  } catch (e) {
    root.replaceChildren(wrap);
    return wrap.replaceChildren(closedView(e));
  }
  root.replaceChildren(wrap);

  const signupHref = `/signup?${info.inviteCode ? `invite=${encodeURIComponent(info.inviteCode)}&` : ''}next=${encodeURIComponent(here)}`;
  const loginHref = `/login?next=${encodeURIComponent(here)}`;
  const fileUrl = (id, inline) => `${base}/files/${encodeURIComponent(id)}/download${inline ? '?inline=1' : ''}`;

  function needLogin(what) {
    modal({
      title: t('로그인이 필요해요', 'Please log in'),
      body: h('p', {}, t(`${what}은(는) 미믹 계정으로 할 수 있어요. 가입은 무료이고, 저장한 파일은 내 클라우드에서 바로 재생돼요.`, `${what} needs a Mimic account. Signing up is free.`)),
      actions: [
        { label: t('로그인', 'Log in'), onClick: () => ctx.navigate(loginHref) },
        { label: t('무료로 가입', 'Sign up free'), kind: 'primary', onClick: () => ctx.navigate(signupHref) },
      ],
    });
  }

  function download(n) {
    if (!me) return needLogin(t('다운로드', 'Downloading'));
    const a = h('a', { href: fileUrl(n.id), download: n.name, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    a.remove();
  }

  const quotaNote = () => h('p', { class: 'small muted' }, t('재생·미리보기에 쓴 데이터는 내 다운스트림 쿼터에서 빠져요.', 'Playback counts toward your downstream quota.'));

  async function showText(n) {
    const pre = h('pre', { class: 'share-text' }, t('불러오는 중…', 'Loading…'));
    modal({
      title: n.name,
      wide: true,
      body: h('div', { class: 'share-preview' }, pre, n.size > TEXT_MAX ? h('p', { class: 'small muted' }, t('앞부분 256KB만 보여요. 전체는 다운로드해 주세요.', 'Showing the first 256 KB. Download to see the rest.')) : null, quotaNote()),
      actions: [{ label: t('다운로드', 'Download'), onClick: () => download(n) }, { label: t('닫기', 'Close'), kind: 'primary' }],
    });
    if (!n.size) return (pre.textContent = '');
    try {
      const r = await fetch(fileUrl(n.id), { headers: { Range: `bytes=0-${TEXT_MAX - 1}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || t('불러오지 못했어요', 'Could not load'));
      pre.textContent = new TextDecoder().decode(await r.arrayBuffer());
    } catch (e) {
      pre.textContent = e.message;
    }
  }

  function open(n) {
    if (n.kind === 'folder') return ctx.navigate(`/s/${encodeURIComponent(token)}?folder=${encodeURIComponent(n.id)}`);
    if (!me) return needLogin(t('미리보기', 'Previewing'));
    if (isText(n)) return showText(n);
    // PDF·문서·압축 등: 바로 내려받지 않고 왜 내려받는지 먼저 알린다
    if (!previewable(n))
      return confirmDialog(t('미리 볼 수 없는 형식이에요', "This file can't be previewed"), t('공유 페이지에서는 이 형식을 미리 볼 수 없어 기기로 내려받아요. 내려받은 양은 내 다운스트림 쿼터에서 빠져요.', "This file type can't be previewed here, so it will be downloaded. It counts toward your downstream quota."), { okLabel: t('다운로드', 'Download') }).then((ok) => ok && download(n));
    const kind = fileIcon(n);
    const src = fileUrl(n.id, true);
    const media =
      kind === 'video'
        ? h('video', { src, controls: true, autoplay: true, playsinline: true, class: 'share-media' })
        : kind === 'audio'
          ? h('audio', { src, controls: true, autoplay: true, class: 'share-media' })
          : kind === 'image'
            ? h('img', { src, alt: n.name, class: 'share-media' })
            : null;
    if (!media) return download(n);
    // 브라우저가 못 여는 형식(avi·wmv·HEVC mkv 등)이거나 서버가 막으면(재생 제한 등) 이유와 저장·다운로드 길을 보여 준다
    media.addEventListener(
      'error',
      async () => {
        let msg = t('이 형식은 브라우저에서 바로 재생할 수 없어요. 내 드라이브에 저장하면 미믹 플레이어로 재생할 수 있고, 내려받아 볼 수도 있어요.', "This format can't play directly in the browser. Save it to your drive to play it there, or download it.");
        try {
          const r = await fetch(src, { headers: { Range: 'bytes=0-0' } });
          if (!r.ok) msg = (await r.json()).message || msg;
        } catch {}
        media.replaceWith(h('div', { class: 'empty share-media' }, h('div', { html: icon('info') }), h('p', {}, msg), h('button', { class: 'btn primary', onclick: () => save([n.id]) }, t('내 드라이브에 저장', 'Save to my drive'))));
      },
      { once: true },
    );
    modal({
      title: n.name,
      wide: true,
      body: h('div', { class: 'share-preview' }, media, quotaNote()),
      actions: [{ label: t('다운로드', 'Download'), onClick: () => download(n) }, { label: t('닫기', 'Close'), kind: 'primary' }],
    });
  }

  async function save(fileIds) {
    if (!me) return needLogin(t('내 드라이브에 저장', 'Saving to your drive'));
    const fp = await useComponent('folder-picker');
    const parentId = fp?.pickFolder ? await fp.pickFolder({ title: t('저장할 위치 고르기', 'Choose where to save') }) : null;
    if (parentId === undefined) return;
    try {
      const r = await api(`${base}/save`, { method: 'POST', body: { fileIds, parentId } });
      toast(t(`${r.items.length}개 항목을 내 드라이브에 저장했어요`, `Saved ${r.items.length} items to your drive`), 'ok');
      bus.emit('drive:changed', { parentId });
    } catch (e) {
      toastError(e);
    }
  }

  const more = (n) => (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      n.kind === 'folder' ? { label: t('열기', 'Open'), icon: 'folder', onClick: () => open(n) } : previewable(n) ? { label: t('미리보기·재생', 'Preview'), icon: 'play', onClick: () => open(n) } : null,
      n.kind === 'file' ? { label: t('다운로드', 'Download'), icon: 'download', onClick: () => download(n) } : null,
      { label: t('내 드라이브에 저장', 'Save to my drive'), icon: 'cloud', onClick: () => save([n.id]) },
    ]);
  };

  // ---------- 화면 ----------
  let mode = viewChoice.get(token) || info.viewMode || 'grid';
  const items = h('div');
  const drawItems = () => {
    // 맨 위가 비었으면 공유한 항목이 모두 휴지통·삭제된 것(파일 하나만 공유했을 수도 있으니 '폴더'라고 하지 않는다)
    if (!list.items.length)
      return items.replaceChildren(
        folderId
          ? h('div', { class: 'empty' }, h('div', { html: icon('folder') }), h('h3', {}, t('이 폴더는 비어 있어요', 'This folder is empty')))
          : h('div', { class: 'empty' }, h('div', { html: icon('info') }), h('h3', {}, t('공유한 파일이 더 이상 없어요', 'The shared files are gone')), h('p', { class: 'small' }, t('공유한 사람이 파일을 지웠거나 옮겼어요.', 'The owner deleted or moved them.'))),
      );
    if (mode === 'grid') {
      return items.replaceChildren(
        h(
          'div',
          { class: 'file-grid' },
          ...list.items.map((n) =>
            h(
              'div',
              { class: 'file-card', tabindex: 0, onclick: () => open(n), onkeydown: (e) => e.key === 'Enter' && open(n) },
              h('div', { class: 'file-thumb', html: icon(fileIcon(n)) }),
              h('div', { class: 'row' }, h('div', { class: 'file-name spacer', title: n.name }, n.name), h('button', { class: 'btn ghost icon-btn share-more', 'aria-label': t('더 보기', 'More'), html: icon('more'), onclick: more(n) })),
              h('div', { class: 'file-meta' }, n.kind === 'folder' ? t('폴더', 'Folder') : formatBytes(n.size)),
            ),
          ),
        ),
      );
    }
    items.replaceChildren(
      h(
        'div',
        { class: 'card file-list share-table' },
        h(
          'table',
          { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, t('이름', 'Name')), h('th', {}, t('크기', 'Size')), h('th', {}, t('수정한 날', 'Modified')), h('th'))),
          h(
            'tbody',
            {},
            ...list.items.map((n) =>
              h(
                'tr',
                { onclick: () => open(n) },
                h('td', {}, h('div', { class: 'row' }, h('span', { html: icon(fileIcon(n)) }), h('span', { class: 'share-name' }, n.name))),
                h('td', {}, n.kind === 'folder' ? '—' : formatBytes(n.size)),
                h('td', {}, formatDate(n.updatedAt, false)),
                h('td', { class: 'share-actions' }, h('button', { class: 'btn ghost icon-btn', 'aria-label': t('더 보기', 'More'), html: icon('more'), onclick: more(n) })),
              ),
            ),
          ),
        ),
      ),
    );
  };
  const toggle = h('div', { class: 'row share-toggle' });
  const drawToggle = () =>
    toggle.replaceChildren(
      ...[
        ['list', 'list', '목록', 'List'],
        ['grid', 'grid', '격자', 'Grid'],
      ].map(([m, ic, ko, en]) =>
        h('button', {
          class: `btn ghost icon-btn${mode === m ? ' on' : ''}`,
          title: t(ko, en),
          'aria-pressed': String(mode === m),
          html: icon(ic),
          onclick: () => {
            mode = m;
            viewChoice.set(token, m);
            drawToggle();
            drawItems();
          },
        }),
      ),
    );
  drawToggle();
  drawItems();

  const title = info.fileCount > 1 ? `${info.title} ${t(`외 ${info.fileCount - 1}개`, `+${info.fileCount - 1} more`)}` : info.title;
  const crumbs = h(
    'div',
    { class: 'crumbs share-crumbs' },
    h('a', { href: `/s/${encodeURIComponent(token)}` }, t('공유 파일', 'Shared files')),
    ...list.path.flatMap((p, i) => [h('span', { class: 'sep' }, '/'), i === list.path.length - 1 ? h('span', {}, p.name) : h('a', { href: `/s/${encodeURIComponent(token)}?folder=${encodeURIComponent(p.id)}` }, p.name)]),
  );

  // replaceChildren 은 null 을 글자로 넣으므로 h('div') 로 감싸 h 가 null 을 건너뛰게 한다
  wrap.replaceChildren(h('div', {},
    h(
      'section',
      { class: 'card share-hero' },
      h('div', { class: 'share-hero-icon', html: icon('share', 'lg') }),
      h(
        'div',
        { class: 'spacer' },
        h('h2', {}, title),
        h(
          'div',
          { class: 'row small muted share-meta' },
          h('span', {}, t(`${info.owner}님이 공유`, `Shared by ${info.owner}`)),
          h('span', {}, '·'),
          h('span', {}, t(`만료 ${expiryLabel(info.expiresAt)}`, `Expires ${expiryLabel(info.expiresAt)}`)),
          info.isOwner ? h('span', { class: 'badge brand' }, t('내가 만든 공유', 'Your share')) : null,
        ),
      ),
      h(
        'div',
        { class: 'row share-hero-actions' },
        h('button', { class: 'btn primary', html: `${icon('cloud')}<span>${folderId ? t('이 폴더 저장', 'Save this folder') : t('모두 내 드라이브에 저장', 'Save all to my drive')}</span>`, onclick: () => save(folderId ? [folderId] : undefined) }),
        h('a', { class: 'btn ghost sm', href: `/copyright?tab=report&type=share&target=${encodeURIComponent(location.href)}`, html: `${icon('flag')}<span>${t('신고', 'Report')}</span>` }),
      ),
    ),
    me
      ? null
      : h(
          'div',
          { class: 'share-join' },
          h('span', { html: icon('gift') }),
          h('span', { class: 'spacer' }, t('미믹에 무료로 가입하면 이 파일을 내 클라우드에 담고 어디서나 바로 재생할 수 있어요.', 'Join Mimic free to keep these files in your own cloud and play them anywhere.')),
          h('a', { class: 'btn sm', href: loginHref }, t('로그인', 'Log in')),
          h('a', { class: 'btn accent sm', href: signupHref }, t('무료로 가입', 'Sign up free')),
        ),
    h('div', { class: 'page-head' }, crumbs, h('div', { class: 'spacer' }), toggle),
    items,
  ));
}

function closedView(e) {
  const [ic, ko, en] =
    e.code === 'share_expired'
      ? ['clock', '공유 기간이 끝났어요', 'This share has expired']
      : e.code === 'share_revoked'
        ? ['close', '공유한 사람이 공유를 그만뒀어요', 'The owner stopped sharing this']
        : e.code === 'share_unavailable'
          ? ['lock', '지금은 이 공유를 열 수 없어요', 'This share is unavailable right now']
          : e.status === 404
          ? ['search', '공유를 찾을 수 없어요', 'Share not found']
          : ['info', e.message || '공유를 열지 못했어요', 'Could not open this share'];
  return h(
    'div',
    { class: 'empty' },
    h('div', { html: icon(ic) }),
    h('h2', {}, t(ko, en)),
    h('p', {}, t('공유한 사람에게 새 링크를 부탁해 보세요.', 'Ask the owner for a new link.')),
    h('a', { class: 'btn primary', href: '/' }, t('미믹 둘러보기', 'Explore Mimic')),
  );
}

function lockView(info, base, done) {
  const input = h('input', { class: 'input', maxlength: 16, autocomplete: 'off', placeholder: t('비밀번호', 'Password'), 'aria-label': t('비밀번호', 'Password') });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn primary block' }, t('열기', 'Open'));
  const go = async () => {
    err.textContent = '';
    btn.disabled = true;
    try {
      await api(`${base}/unlock`, { method: 'POST', body: { password: input.value.trim() } });
      done();
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
    }
  };
  btn.onclick = go;
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  setTimeout(() => input.focus(), 0);
  return h(
    'div',
    { class: 'card share-lock' },
    h('div', { class: 'share-hero-icon', html: icon('lock', 'lg') }),
    h('h2', {}, t('비밀번호로 잠긴 공유', 'Password-protected share')),
    h('p', { class: 'muted' }, t(`${info.owner}님이 보낸 비밀번호를 입력하면 파일을 볼 수 있어요.`, `Enter the password from ${info.owner} to see the files.`)),
    h('div', { class: 'field' }, input, err),
    btn,
    h('p', { class: 'small muted' }, t(`만료 ${expiryLabel(info.expiresAt)}`, `Expires ${expiryLabel(info.expiresAt)}`)),
  );
}
