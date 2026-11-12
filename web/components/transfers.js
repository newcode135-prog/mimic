// 오른쪽 아래 전송 패널(A-07). 탭 3개: 클라우드 다운로드(서버 작업) · 업로드 · 다운로드(bus 'transfer:update')
import { api, h, t, icon, bus, loadCss, toast, toastError, modal, confirmDialog, formatBytes, getMe } from '/ui.js';
import { allowanceText, openCreateTask, torrentLinks } from '/components/offline.js';

const POLL_MS = 2000;
const KIND_ICON = { magnet: 'torrent', torrent: 'torrent', url: 'link', social: 'video' };
const ERRORS = {
  http_error: ['링크 쪽 서버가 파일을 내주지 않았어요', 'The source server refused the file'],
  download_failed: ['받는 도중 문제가 생겼어요', 'Something went wrong while downloading'],
  storage_full: ['저장 공간이 부족해요', 'Not enough storage'],
  too_many_files: ['파일이 7,000개를 넘는 토렌트예요', 'Torrent has more than 7,000 files'],
  no_peers: ['내려받을 상대를 찾지 못했어요', 'No peers found'],
  stalled: ['한동안 받은 데이터가 없어 멈췄어요. 다시 시도해 보세요', 'Stopped after receiving no data for a while. Try again'],
  social_unavailable: ['서버에 SNS 저장 도구가 설치되어 있지 않아요', 'The SNS download tool is not installed on the server'],
  social_failed: ['게시물에서 미디어를 꺼내지 못했어요', 'Could not extract media from the post'],
  blocked_address: ['내부망 주소는 받을 수 없어요', 'Private network addresses are not allowed'],
  too_many_redirects: ['주소가 너무 여러 번 넘어가요', 'Too many redirects'],
  invalid_link: ['지원하지 않는 링크예요', 'Unsupported link'],
  empty: ['저장할 파일이 없어요', 'Nothing to save'],
  blocked: ['관리자가 차단한 링크예요', 'This link is blocked'],
  blocked_file: ['차단된 파일이 들어 있어요', 'Contains a blocked file'],
  torrent_too_large: ['토렌트 파일이 4MB를 넘어요', 'The torrent file is over 4MB'],
  cloud_limit: ['오늘 남은 무료 횟수가 없어요', 'No free cloud downloads left today'],
  monthly_quota: ['이번 달 클라우드 다운로드 쿼터를 다 썼어요', 'Monthly cloud download quota used up'],
  app_quota: ['연결 앱에 허용된 쿼터를 다 썼어요', 'Connected-app quota used up'],
  account_unavailable: ['계정을 쓸 수 없는 상태라 저장하지 않았어요', 'Not saved: the account is unavailable'],
};
const errText = (code) => t(...(ERRORS[code] || ERRORS.download_failed));
const APPEAL = { open: ['이의제기 검토 중', 'Appeal under review'], accepted: ['이의제기 수락', 'Appeal accepted'], rejected: ['이의제기 반려', 'Appeal rejected'] };
const isActive = (x) => x.status === 'queued' || x.status === 'running';
const goTo = (p) => import('/app.js').then((m) => m.navigate(p));

export function mount(el) {
  loadCss('/css/offline.css');
  let open = false;
  let collapsed = false;
  let tab = 'cloud';
  let tasks = [];
  let allowance = null;
  let timer = null;
  let stopped = false;
  let lastSig = ''; // 바뀐 게 없으면 다시 그리지 않는다(누르려던 버튼이 사라지지 않게)
  const seen = new Map(); // 작업 id → 직전 상태(완료 순간을 잡아 drive:changed 를 보낸다)
  const local = new Map(); // 업로드·다운로드(브라우저 쪽 전송)

  const badge = h('span', { class: 'tr-badge hidden' });
  const fab = h('button', { class: 'tr-fab', title: t('전송 목록', 'Transfers'), 'aria-label': t('전송 목록 열기', 'Open transfers'), html: icon('cloudDown'), onclick: () => setOpen(true) }, badge);
  const quota = h('span', { class: 'tr-quota' });
  const more = h('a', { class: 'btn sm accent hidden', href: '/drive/payment' }, t('횟수 추가', 'Get more'));
  const tabsEl = h('div', { class: 'tabs tr-tabs', role: 'tablist' });
  const tools = h('div', { class: 'tr-tools' });
  const list = h('div', { class: 'tr-list' });
  const collapseBtn = h('button', { class: 'btn ghost icon-btn tr-collapse', 'aria-label': t('접기', 'Collapse'), html: icon('chevronDown'), onclick: () => ((collapsed = !collapsed), draw()) });
  const panel = h(
    'section',
    { class: 'tr-panel hidden', 'aria-label': t('전송 목록', 'Transfers') },
    h(
      'header',
      { class: 'tr-head' },
      h('b', {}, t('전송 목록', 'Transfers')),
      h('div', { class: 'spacer' }),
      collapseBtn,
      h('button', { class: 'btn ghost icon-btn', 'aria-label': t('닫기', 'Close'), html: icon('close'), onclick: () => setOpen(false) }),
    ),
    h('div', { class: 'tr-body' }, h('div', { class: 'tr-quota-row' }, h('span', { html: icon('cloudDown') }), quota, h('div', { class: 'spacer' }), more), tabsEl, tools, list),
  );
  el.replaceChildren(fab, panel);

  const offs = [
    bus.on('transfer:update', (d) => {
      if (!alive() || !d?.id) return;
      const isNew = !local.has(d.id);
      local.set(d.id, { ...local.get(d.id), ...d });
      if (isNew && d.status === 'running') {
        tab = d.type === 'download' ? 'download' : 'upload';
        setOpen(true);
      } else draw();
    }),
    bus.on('offline:created', (d) => {
      if (!alive()) return;
      for (const x of d?.tasks || []) seen.set(x.id, x.status);
      refresh();
    }),
    bus.on('transfers:open', (d) => {
      if (!alive()) return;
      if (d?.tab) tab = d.tab;
      setOpen(true);
    }),
  ];
  // K-07 토렌트 링크 자동 인식: 입력 칸 밖에서 붙여 넣은 글에 마그넷·.torrent 주소가 있으면 만들기 창을 그 링크로 연다
  async function onPaste(e) {
    if (!alive() || e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const found = torrentLinks(e.clipboardData?.getData('text'));
    if (!found.length) return;
    const me = await getMe(true).catch(() => null);
    if (me?.user?.settings?.torrentAutoDetect === false) return;
    openCreateTask({ links: found });
  }
  document.addEventListener('paste', onPaste);
  offs.push(() => document.removeEventListener('paste', onPaste));
  function alive() {
    if (el.isConnected && !stopped) return true;
    stopped = true;
    clearTimeout(timer);
    offs.forEach((off) => off());
    return false;
  }

  function setOpen(v) {
    open = v;
    if (v) collapsed = false;
    draw();
    if (v) refresh();
    else schedule();
  }

  // 패널이 열려 있거나 진행 중인 작업이 있으면 2초마다 새로 고친다
  function schedule() {
    clearTimeout(timer);
    if (!stopped && (open || tasks.some(isActive))) timer = setTimeout(refresh, POLL_MS);
  }
  async function refresh() {
    clearTimeout(timer);
    if (!alive()) return;
    try {
      const r = await api('/api/offline/tasks');
      const sig = JSON.stringify(r);
      if (sig === lastSig) return schedule();
      lastSig = sig;
      tasks = r.tasks;
      allowance = r.allowance;
      for (const x of tasks) {
        const prev = seen.get(x.id);
        if (prev && prev !== 'done' && x.status === 'done') {
          bus.emit('drive:changed', { parentId: x.parentId });
          toast(t(`클라우드 다운로드 완료: ${x.name}`, `Cloud download finished: ${x.name}`), 'ok');
          import('/layout.js').then((m) => m.refreshShell()).catch(() => {});
        }
        seen.set(x.id, x.status);
      }
    } catch (e) {
      if (e.status === 401) {
        stopped = true;
        alive();
        return;
      }
    }
    if (!alive()) return;
    draw();
    schedule();
  }

  async function act(fn) {
    try {
      await fn();
    } catch (e) {
      toastError(e);
    }
    refresh();
  }

  function appeal(x) {
    const reason = h('textarea', { class: 'input', rows: 4, maxlength: 1000, placeholder: t('예: 제가 직접 만든 영상이에요', 'e.g. This is my own video') });
    modal({
      title: t('차단 이의제기', 'Appeal a block'),
      body: h(
        'div',
        {},
        h(
          'p',
          { class: 'small muted' },
          x.status === 'done'
            ? t('이 작업의 파일 일부가 관리자 차단 목록과 일치해 저장하지 않았어요. 차단이 잘못되었다고 생각하면 이유를 적어 보내 주세요. 검토 결과는 알림으로 알려 드려요.', 'Some files in this task matched the block list and were not saved. If you think this is a mistake, tell us why. We will notify you of the result.')
            : t('이 링크는 관리자 차단 목록과 일치해 저장하지 않았어요. 차단이 잘못되었다고 생각하면 이유를 적어 보내 주세요. 검토 결과는 알림으로 알려 드려요.', 'This link matched the block list and was not saved. If you think this is a mistake, tell us why. We will notify you of the result.'),
        ),
        h('div', { class: 'tr-src small' }, x.source),
        h('div', { class: 'field' }, h('label', {}, t('사유', 'Reason')), reason),
      ),
      actions: [
        { label: t('취소', 'Cancel') },
        {
          label: t('보내기', 'Submit'),
          kind: 'primary',
          onClick: async () => {
            await api(`/api/offline/tasks/${x.id}/appeal`, { method: 'POST', body: { reason: reason.value } });
            toast(t('이의제기를 접수했어요', 'Appeal submitted'), 'ok');
            refresh();
          },
        },
      ],
    });
  }

  const btn = (ic, label, onclick, cls = '') => h('button', { class: `btn ghost icon-btn sm ${cls}`, title: label, 'aria-label': label, html: icon(ic), onclick });

  function cloudStatus(x, pct) {
    if (x.status === 'queued') return t('대기 중', 'Waiting');
    if (x.status === 'running') return t(`받는 중 ${pct}%`, `Downloading ${pct}%`);
    if (x.status === 'done') return t('완료', 'Done');
    if (x.status === 'blocked') return t('차단됨', 'Blocked') + ' · ' + errText(x.error || 'blocked');
    if (x.status === 'canceled') return t('취소됨', 'Canceled');
    return t('실패', 'Failed') + ' · ' + errText(x.error);
  }

  function cloudRow(x) {
    const pct = x.status === 'done' ? 100 : Math.floor(x.progress || 0);
    const meta = [cloudStatus(x, pct)];
    if (x.status === 'running' && x.speed) meta.push(`${formatBytes(x.speed)}/s`);
    if (x.size) meta.push(x.status === 'running' ? `${formatBytes(x.downloaded)} / ${formatBytes(x.size)}` : formatBytes(x.size));
    if (x.status === 'done' && x.skippedAds) meta.push(t(`광고성 파일 ${x.skippedAds}개 제외`, `${x.skippedAds} ad file(s) skipped`));
    if (x.status === 'done' && x.skippedBlocked) meta.push(t(`차단된 파일 ${x.skippedBlocked}개 제외`, `${x.skippedBlocked} blocked file(s) skipped`));
    const acts = [];
    if (x.status === 'done') {
      const to = x.resultKind === 'folder' ? `/drive/folder/${x.resultRootId}` : x.parentId ? `/drive/folder/${x.parentId}` : '/drive/all';
      acts.push(btn('folder', t('열기', 'Open'), () => goTo(to)));
    }
    if (x.status === 'error' || x.status === 'canceled') acts.push(btn('refresh', t('다시 시도', 'Retry'), () => act(() => api(`/api/offline/tasks/${x.id}/retry`, { method: 'POST' }))));
    if ((x.status === 'blocked' || (x.status === 'done' && x.skippedBlocked)) && !x.appeal) acts.push(btn('flag', t('이의제기', 'Appeal'), () => appeal(x)));
    acts.push(
      btn('trash', isActive(x) ? t('취소', 'Cancel') : t('삭제', 'Delete'), async () => {
        if (isActive(x) && !(await confirmDialog(t('작업 취소', 'Cancel task'), t('진행 중인 클라우드 다운로드를 취소할까요?', 'Cancel this cloud download?'), { okLabel: t('취소하기', 'Cancel it'), danger: true }))) return;
        act(() => api(`/api/offline/tasks/${x.id}`, { method: 'DELETE' }));
      }),
    );
    return h(
      'div',
      { class: `tr-row is-${x.status}` },
      h('span', { class: 'tr-ic', html: icon(KIND_ICON[x.kind] || 'file') }),
      h(
        'div',
        { class: 'tr-main' },
        h('div', { class: 'tr-name', title: x.source }, x.name),
        isActive(x) ? h('div', { class: 'progress' }, h('span', { style: { width: `${pct}%` } })) : null,
        h('div', { class: 'tr-meta' }, meta.join(' · '), x.appeal ? h('span', { class: 'badge' }, t(...APPEAL[x.appeal])) : null),
      ),
      h('div', { class: 'tr-acts' }, ...acts),
    );
  }

  function localRow(x) {
    const pct = x.status === 'done' ? 100 : x.size ? Math.min(100, Math.floor(((x.loaded || 0) * 100) / x.size)) : 0;
    // handoff: 실제 저장은 브라우저가 맡아 끝났는지 알 수 없다(drive 가 보냄). '완료'로 보이지 않게 한다
    const status =
      x.status === 'running'
        ? t(`${x.type === 'upload' ? '올리는 중' : '받는 중'} ${pct}%`, `${x.type === 'upload' ? 'Uploading' : 'Downloading'} ${pct}%`)
        : x.status === 'done' && x.handoff
          ? t('브라우저로 넘김 · 브라우저 다운로드 목록에서 확인하세요', 'Handed to browser · check your browser downloads')
          : x.status === 'done'
            ? t('완료', 'Done')
            : t('실패', 'Failed') + (x.error ? ` · ${x.error}` : '');
    return h(
      'div',
      { class: `tr-row is-${x.status}` },
      h('span', { class: 'tr-ic', html: icon(x.type === 'upload' ? 'upload' : 'download') }),
      h(
        'div',
        { class: 'tr-main' },
        h('div', { class: 'tr-name' }, x.name),
        x.status === 'running' ? h('div', { class: 'progress' }, h('span', { style: { width: `${pct}%` } })) : null,
        h('div', { class: 'tr-meta' }, [status, x.size ? formatBytes(x.size) : ''].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'tr-acts' }, x.status !== 'running' ? btn('close', t('목록에서 지우기', 'Remove from list'), () => (local.delete(x.id), draw())) : null),
    );
  }

  function draw() {
    const mine = (type) => [...local.values()].filter((x) => x.type === type).reverse();
    const active = tasks.filter(isActive).length + [...local.values()].filter((x) => x.status === 'running').length;
    badge.textContent = active > 99 ? '99+' : String(active);
    badge.classList.toggle('hidden', !active);
    fab.classList.toggle('hidden', open);
    panel.classList.toggle('hidden', !open);
    panel.classList.toggle('collapsed', collapsed);
    collapseBtn.setAttribute('aria-label', collapsed ? t('펼치기', 'Expand') : t('접기', 'Collapse'));
    quota.textContent = allowanceText(allowance);
    more.classList.toggle('hidden', !allowance || allowance.unlimited);
    if (collapsed || !open) return;

    const TABS = [
      ['cloud', t('클라우드 다운로드', 'Cloud'), tasks.length],
      ['upload', t('업로드', 'Uploads'), mine('upload').length],
      ['download', t('다운로드', 'Downloads'), mine('download').length],
    ];
    tabsEl.replaceChildren(
      ...TABS.map(([key, label, n]) =>
        h('button', { class: tab === key ? 'active' : '', role: 'tab', 'aria-selected': String(tab === key), onclick: () => ((tab = key), draw()) }, label, n ? h('span', { class: 'tr-count' }, String(n)) : null),
      ),
    );

    if (tab === 'cloud') {
      tools.replaceChildren(
        h('button', { class: 'btn sm', html: `${icon('plus')}<span>${t('새 작업', 'New task')}</span>`, onclick: () => openCreateTask() }),
        h('div', { class: 'spacer' }),
        tasks.some((x) => x.status === 'done')
          ? h('button', { class: 'btn ghost sm', onclick: () => act(() => api('/api/offline/tasks/clear', { method: 'POST', body: { status: 'done' } })) }, t('완료 항목 지우기', 'Clear finished'))
          : null,
      );
      list.replaceChildren(...(tasks.length ? tasks.map(cloudRow) : [h('p', { class: 'tr-empty' }, t('아직 클라우드 다운로드가 없어요. 링크를 붙여 넣어 시작해 보세요.', 'No cloud downloads yet. Paste a link to start.'))]));
    } else {
      const rows = mine(tab);
      tools.replaceChildren(
        h('div', { class: 'spacer' }),
        rows.some((x) => x.status !== 'running')
          ? h('button', { class: 'btn ghost sm', onclick: () => (rows.forEach((x) => x.status !== 'running' && local.delete(x.id)), draw()) }, t('끝난 항목 지우기', 'Clear finished'))
          : null,
      );
      list.replaceChildren(
        ...(rows.length
          ? rows.map(localRow)
          : [h('p', { class: 'tr-empty' }, tab === 'upload' ? t('올리고 있는 파일이 없어요.', 'Nothing uploading.') : t('내려받고 있는 파일이 없어요.', 'Nothing downloading.'))]),
      );
    }
  }

  draw();
  refresh();
  return () => {
    stopped = true;
    alive();
  };
}
