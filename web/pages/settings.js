// 환경설정(K-07): 기본 · 전송 · 액세스 및 통합 탭. 연동 기능(G-01~G-09)을 여기서 켜고 끈다.
import { api, h, t, toast, toastError, modal, confirmDialog, formatDate, loadCss, icon, setLang, getLang } from '/ui.js';

const TABS = [
  ['basic', '기본', 'General'],
  ['transfer', '전송', 'Transfer'],
  ['integrations', '액세스 및 통합', 'Access & integrations'],
];

// G-05 연결 앱 권한 6단계
const SCOPES = [
  ['files:read', '파일 읽기', 'Read files', '목록과 파일 정보를 보고 내려받아요.', 'View lists and file details, and download.'],
  ['files:write', '읽기·쓰기', 'Read & write', '파일 읽기에 더해 올리기, 폴더 만들기, 이름 바꾸기·옮기기를 해요.', 'Read, plus upload, create folders, rename and move.'],
  ['files:manage', '관리', 'Manage', '읽기·쓰기에 더해 휴지통으로 옮기고 되살려요.', 'Read & write, plus move to trash and restore.'],
  ['files:delete', '영구삭제', 'Delete forever', '휴지통 비우기·영구삭제. 처음부터 주지 않으며 토큰에는 줄 수 없어요.', 'Empty trash and delete forever. Never granted by default and not available for tokens.'],
  ['services', '서비스', 'Services', '공유 링크와 클라우드 다운로드 작업을 만들어요.', 'Create share links and cloud download tasks.'],
  ['account', '계정', 'Account', '친구 초대와 환경설정을 바꿔요. 토큰에는 줄 수 없어요.', 'Invites and preferences. Not available for tokens.'],
];
const TOKEN_SCOPES = ['files:read', 'files:write', 'files:manage', 'services'];
const scopeName = (s) => {
  const x = SCOPES.find(([k]) => k === s);
  return x ? t(x[1], x[2]) : s;
};
const scopeBadges = (list) => h('div', { class: 'ig-badges' }, ...(list || []).map((s) => h('span', { class: 'badge' }, scopeName(s))));

// ---------- 작은 화면 조각 ----------
const copy = (text) =>
  navigator.clipboard?.writeText(text).then(
    () => toast(t('복사했습니다', 'Copied'), 'ok'),
    () => toast(t('복사하지 못했습니다. 직접 선택해 복사해 주세요', 'Could not copy'), 'error'),
  );
const copyField = (value, { multiline = false } = {}) =>
  h(
    'div',
    { class: `ig-copy${multiline ? ' multi' : ''}` },
    h(multiline ? 'pre' : 'code', {}, value),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => copy(value), html: `${icon('copy')}<span>${t('복사', 'Copy')}</span>` }),
  );
// 행 제목을 그 행의 select·스위치 접근성 이름으로 붙인다
const row = (title, desc, control) => {
  const field = control.matches('input, select') ? control : control.querySelector('input, select');
  if (field && !field.getAttribute('aria-label')) field.setAttribute('aria-label', title);
  return h('div', { class: 'ig-row' }, h('div', { class: 'ig-text' }, h('div', { class: 'ig-title' }, title), desc ? h('div', { class: 'muted small' }, desc) : null), h('div', { class: 'ig-ctl' }, control));
};
const head = (ic, title, ...right) => h('div', { class: 'ig-head' }, h('span', { class: 'ig-ic', html: icon(ic) }), h('h3', {}, title), h('div', { class: 'spacer' }), ...right);
// DOM 의 replaceChildren 은 null 을 글자로 넣으므로 걸러서 넣는다
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const empty = (text) => h('p', { class: 'muted small ig-empty' }, text);
const when = (ts) => (ts ? formatDate(ts) : t('아직 없음', 'Never'));

function toggle(on, save, { disabled = false, label } = {}) {
  const input = h('input', { type: 'checkbox', checked: !!on, disabled, 'aria-label': label });
  input.onchange = () => save(input.checked).catch(() => (input.checked = !input.checked));
  return h('label', { class: 'switch' }, input, h('span'));
}
function choice(value, options, save, label) {
  const sel = h('select', { class: 'input ig-select', 'aria-label': label }, ...options.map(([v, ko, en]) => h('option', { value: v, selected: String(v) === String(value) }, t(ko, en))));
  let prev = sel.value;
  sel.onchange = () => save(sel.value).then(() => (prev = sel.value), () => (sel.value = prev));
  return sel;
}

// 비밀값은 만든 직후 한 번만 보여 준다(G-04)
function showSecret(title, secret, extra) {
  modal({
    title,
    wide: true,
    body: h(
      'div',
      { class: 'col' },
      h('p', { class: 'ig-warn', html: `${icon('info')}<span>${t('지금 한 번만 보여 드려요. 창을 닫으면 다시 볼 수 없으니 안전한 곳에 복사해 두세요.', 'Shown only once. Copy it somewhere safe before closing.')}</span>` }),
      copyField(secret),
      extra,
    ),
    actions: [{ label: t('복사해 두었어요', 'Done'), kind: 'primary' }],
  });
}

// 카드는 각자 데이터를 불러와 그린다. 실패해도 다른 카드는 보인다
function lazyCard(draw) {
  const card = h('section', { class: 'card ig-card' }, h('div', { class: 'spinner' }));
  card.redraw = () => draw(card).catch((e) => fill(card, h('p', { class: 'muted', role: 'alert' }, e.message || t('불러오지 못했습니다', 'Failed to load'))));
  card.redraw();
  return card;
}

// ---------- 기본 ----------
function basicTab(box, s, save) {
  box.append(
    h(
      'section',
      { class: 'card ig-card' },
      row(
        t('언어', 'Language'),
        t('화면에 쓰는 언어예요. 바꾸면 화면을 새로 불러와요.', 'Display language. The page reloads after changing.'),
        // 계정 값(users.lang)이 아니라 지금 화면에 쓰는 언어(이 기기의 선택)를 보여 준다. 고르면 둘 다 바뀐다
        choice(
          getLang(),
          [
            ['ko', '한국어', '한국어'],
            ['en', 'English', 'English'],
          ],
          async (v) => {
            await save({ lang: v });
            setLang(v);
            location.reload();
          },
          t('언어', 'Language'),
        ),
      ),
      row(
        t('공유 코드로 찾은 내용 보기', 'Opening share codes'),
        t('공유 코드로 찾은 파일을 바로 열지, 다른 사람이 올린 파일이라는 안내를 먼저 띄울지 정해요.', 'Open shares found by code right away, or show a notice first.'),
        choice(
          s.shareCodeDisplay,
          [
            ['direct', '바로 열기', 'Open right away'],
            ['warn', '안내 먼저 보기', 'Notice first'],
          ],
          (v) => save({ shareCodeDisplay: v }),
        ),
      ),
      row(
        t('정렬 방식 기억', 'Remember sorting'),
        t('정렬 기준을 모든 폴더에 똑같이 쓸지, 폴더마다 따로 기억할지 정해요.', 'Use one sort order everywhere, or remember it per folder.'),
        choice(
          s.sortScope,
          [
            ['global', '모든 폴더에 같게', 'All folders'],
            ['folder', '폴더마다 따로', 'Per folder'],
          ],
          (v) => save({ sortScope: v }),
        ),
      ),
      row(
        t('보기 방식 기억', 'Remember view mode'),
        t('격자·목록 보기를 모든 폴더에 똑같이 쓸지, 폴더마다 따로 기억할지 정해요.', 'Use one grid/list view everywhere, or remember it per folder.'),
        choice(
          s.viewScope,
          [
            ['global', '모든 폴더에 같게', 'All folders'],
            ['folder', '폴더마다 따로', 'Per folder'],
          ],
          (v) => save({ viewScope: v }),
        ),
      ),
      row(
        t('공유 페이지 기본 보기', 'Default share page view'),
        t('새로 만드는 공유 링크의 기본 보기예요. 이미 만든 공유는 나의 공유 > 수정에서 바꿔요.', 'Default view for new share links. Change existing shares in My shares > Edit.'),
        choice(
          s.shareDefaultView,
          [
            ['grid', '격자', 'Grid'],
            ['list', '목록', 'List'],
          ],
          (v) => save({ shareDefaultView: v }),
        ),
      ),
    ),
  );
}

// ---------- 전송 ----------
function transferTab(box, s, save) {
  box.append(
    h(
      'section',
      { class: 'card ig-card' },
      row(
        t('동시 업로드 수', 'Parallel uploads'),
        t('한 번에 함께 올리는 파일 수예요. 회선이 느리면 줄여 보세요.', 'Files uploaded at the same time. Lower it on slow connections.'),
        choice(
          s.uploadConcurrency,
          [1, 2, 3].map((n) => [n, `${n}개`, `${n}`]), // B-06 최대 3개
          (v) => save({ uploadConcurrency: Number(v) }),
        ),
      ),
      row(t('업로드 실패 시 자동 재시도', 'Retry failed uploads'), t('네트워크가 잠깐 끊겨 실패한 업로드를 알아서 다시 시도해요.', 'Automatically retry uploads that failed because of a brief network drop.'), toggle(s.uploadAutoRetry, (v) => save({ uploadAutoRetry: v }))),
      row(
        t('다른 앱 파일 전용 폴더', 'Folder for files from other apps'),
        t('텔레그램 봇처럼 다른 앱으로 저장한 파일을 "My telegram" 같은 전용 폴더에 모아요. 끄면 최상위에 저장해요.', 'Collect files saved from other apps (like the Telegram bot) in a dedicated folder such as "My telegram". Off: save to the top level.'),
        toggle(s.appFilesFolder, (v) => save({ appFilesFolder: v })),
      ),
      row(
        t('토렌트 링크 자동 인식', 'Detect torrent links'),
        t('붙여 넣은 글에서 마그넷·토렌트 링크를 찾아 클라우드 다운로드 창에 채워 줘요.', 'Find magnet and torrent links in pasted text and fill in the cloud download dialog.'),
        toggle(s.torrentAutoDetect, (v) => save({ torrentAutoDetect: v })),
      ),
      row(
        t('BT 하위 폴더 스마트 필터', 'Smart filter for torrent contents'),
        t('토렌트 안의 광고성 파일(홍보 txt·url 바로가기·짧은 광고 영상)은 저장하지 않아요. 끄면 모두 저장해요.', 'Ad-like files inside torrents are not saved. Turn off to save everything.'),
        toggle(s.btSmartFilter, (v) => save({ btSmartFilter: v })),
      ),
      row(t('전송 쿼터', 'Transfer quota'), t('클라우드 다운로드·다운스트림·업로드 사용량을 항목별로 봐요.', 'See cloud download, downstream and upload usage by item.'), h('a', { class: 'btn sm', href: '/drive/quota', html: `${icon('chart')}<span>${t('쿼터 상세', 'Details')}</span>` })),
    ),
  );
}

// ---------- 액세스 및 통합 ----------
function integrationsTab(box, s, save, timers) {
  const origin = location.origin;
  // 연결을 만들거나 끊으면 같은 연결이 보이는 카드(WebDAV·MCP·연결된 앱·텔레그램)를 모두 다시 그린다
  const refreshAll = () => [webdav, mcp, apps, telegram].forEach((c) => c.redraw());

  const webdav = lazyCard(async function draw(card) {
    const w = await api('/api/integrations/webdav');
    const on = w.premium && w.enabled;
    const pw = w.password;
    const newPassword = async () => {
      if (pw && !pw.expired && !(await confirmDialog(t('새 앱 비밀번호', 'New app password'), t('새로 만들면 지금 쓰는 WebDAV 비밀번호는 바로 쓸 수 없게 돼요. 계속할까요?', 'The current WebDAV password will stop working. Continue?'), { okLabel: t('새로 만들기', 'Create') })))
        return;
      try {
        const r = await api('/api/integrations/webdav/password', { method: 'POST' });
        showSecret(t('WebDAV 앱 비밀번호', 'WebDAV app password'), r.password, h('p', { class: 'muted small' }, t(`사용자 이름은 ${r.username} 이에요. 계정 비밀번호 대신 이 값을 WebDAV 앱에 넣으세요.`, `Username: ${r.username}. Use this instead of your account password.`)));
        refreshAll();
      } catch (e) {
        toastError(e);
      }
    };
    fill(card, 
      head(
        'desktop',
        'WebDAV',
        h('span', { class: 'badge accent', html: `${icon('crown')}<span>Premium</span>` }),
        toggle(
          w.enabled,
          async (v) => {
            await save({ webdavEnabled: v });
            draw(card);
          },
          { disabled: !w.premium, label: 'WebDAV' },
        ),
      ),
      h('p', { class: 'muted' }, t('Windows 탐색기, macOS Finder, 동영상 플레이어 같은 앱에서 미믹 드라이브를 네트워크 드라이브처럼 열어요. WebDAV 에서 지우거나 덮어쓴 파일은 휴지통으로 가고, 영구삭제와 휴지통 비우기는 할 수 없어요.', 'Open your Mimic drive like a network drive in Explorer, Finder or media players. Deleted or overwritten files go to the trash; permanent delete and emptying the trash are not available.')),
      !w.premium ? h('div', { class: 'ig-note' }, t('프리미엄 회원 전용 기능이에요. ', 'Premium only. '), h('a', { href: '/drive/payment' }, t('프리미엄 알아보기', 'See Premium'))) : null,
      on
        ? h(
            'div',
            { class: 'ig-grid' },
            h('span', { class: 'ig-label' }, t('서버 주소', 'Server')),
            copyField(origin + w.path),
            h('span', { class: 'ig-label' }, t('사용자 이름', 'Username')),
            copyField(w.username),
            h('span', { class: 'ig-label' }, t('비밀번호', 'Password')),
            h(
              'div',
              { class: 'row' },
              // G-01: 만료된 비밀번호는 접속이 막히므로 만료를 드러내고 새로 만들게 한다
              pw?.expired ? h('span', { class: 'badge danger' }, t('만료됨', 'Expired')) : null,
              h(
                'span',
                { class: 'muted small' },
                !pw
                  ? t('아직 만들지 않았어요', 'Not created yet')
                  : pw.expired
                    ? t(`${formatDate(pw.expiresAt, false)}에 만료되어 접속할 수 없어요. 새로 만들어 주세요.`, `Expired on ${formatDate(pw.expiresAt, false)}. Create a new one to connect.`)
                    : t(`앱 비밀번호 사용 중 · ${formatDate(pw.createdAt, false)} 만듦 · ${formatDate(pw.expiresAt, false)} 만료 · 마지막 사용 ${when(pw.lastUsedAt)}`, `In use · created ${formatDate(pw.createdAt, false)} · expires ${formatDate(pw.expiresAt, false)}`),
              ),
              h('div', { class: 'spacer' }),
              h('button', { class: 'btn sm primary', onclick: newPassword }, pw ? t('새로 만들기', 'Regenerate') : t('앱 비밀번호 만들기', 'Create app password')),
            ),
          )
        : null,
      on ? h('p', { class: 'muted small' }, t('사용자 이름은 이메일·휴대폰 번호·사용자 ID 중 무엇이든 돼요. 연결 앱 전송량은 월 쿼터의 25% 까지 쓸 수 있어요. Windows 탐색기는 https 주소에서 가장 안정적으로 연결돼요.', 'Username can be your email, phone or user ID. Connected apps can use up to 25% of each monthly quota.')) : null,
    );
  });

  const mcp = lazyCard(async function draw(card) {
    const endpoint = `${origin}/api/integrations/mcp`;
    const conns = (await api('/api/integrations/apps')).items.find((a) => a.id === 'mcp')?.connections || [];
    const connect = () => {
      const client = h(
        'select',
        { class: 'input', 'aria-label': t('연결할 도구', 'Tool') },
        // 헤더로 토큰을 넣을 수 있는 MCP 클라이언트만(OAuth 만 받는 웹 커넥터는 아직 연결할 수 없다)
        ...['Claude Code', 'Cursor', 'Claude Desktop', t('기타 MCP 클라이언트', 'Other MCP client')].map((n) => h('option', { value: n }, n)),
      );
      const checks = TOKEN_SCOPES.map((k) => [k, h('input', { type: 'checkbox', checked: k === 'files:write' || k === 'services' })]);
      modal({
        title: t('AI 도구 연결', 'Connect an AI tool'),
        body: h(
          'div',
          {},
          h('div', { class: 'field' }, h('label', {}, t('연결할 도구', 'Tool')), client),
          h('div', { class: 'field' }, h('label', {}, t('허용할 권한', 'Permissions')), ...checks.map(([k, cb]) => h('label', { class: 'check' }, cb, scopeName(k)))),
          h('p', { class: 'muted small' }, t('연결 정보(토큰)는 1년 동안 쓸 수 있고, 이 화면에서 언제든 끊을 수 있어요.', 'The connection token lasts one year and can be revoked here any time.')),
        ),
        actions: [
          { label: t('취소', 'Cancel') },
          {
            label: t('연결 정보 만들기', 'Create'),
            kind: 'primary',
            onClick: async () => {
              const scopes = checks.filter(([, cb]) => cb.checked).map(([k]) => k);
              if (!scopes.length) return toast(t('권한을 하나 이상 골라 주세요', 'Pick at least one permission'), 'error'), false;
              const r = await api('/api/integrations/mcp/connect', { method: 'POST', body: { client: client.value, scopes } });
              const views = [
                [t('설정 JSON', 'Config JSON'), JSON.stringify(r.config, null, 2), t('Cursor·Claude Code(.mcp.json) 같은 원격 MCP 설정에 붙여 넣어요.', 'Paste into remote MCP config (Cursor, .mcp.json).')],
                ['Claude Code', r.claudeCode, t('터미널에서 실행해요.', 'Run in your terminal.')],
                ['Claude Desktop', JSON.stringify(r.claudeDesktop, null, 2), t('claude_desktop_config.json 에 넣어요(Node.js 필요).', 'Add to claude_desktop_config.json (needs Node.js).')],
              ];
              showSecret(
                t('AI 도구 연결 정보', 'AI tool connection'),
                r.token,
                h(
                  'div',
                  { class: 'col' },
                  h('p', { class: 'muted small' }, t('위 값은 토큰이에요. 직접 설정하는 MCP 클라이언트에는 아래 주소와 함께 "Authorization: Bearer 토큰" 헤더로 넣으세요.', 'This is the token. For other MCP clients, send it as an "Authorization: Bearer <token>" header with the endpoint below.')),
                  copyField(r.endpoint),
                  ...views.map(([title, text, hint]) => h('div', {}, h('b', {}, title), h('div', { class: 'muted small' }, hint), copyField(text, { multiline: true }))),
                ),
              );
              refreshAll();
            },
          },
        ],
      });
    };
    fill(card,
      head('link', t('AI 도구 연결 (MCP)', 'AI tools (MCP)'), h('button', { class: 'btn sm primary', onclick: connect, html: `${icon('plus')}<span>${t('연결', 'Connect')}</span>` })),
      h('p', { class: 'muted' }, t('Claude Code·Cursor·Claude Desktop 같은 AI 도구가 내 드라이브에서 파일을 찾고, 폴더를 만들고, 이름을 바꾸거나 옮기고, 휴지통으로 보내거나 되살리고, 클라우드 다운로드와 공유 링크를 만들 수 있게 해요. 도구마다 따로 연결하고 언제든 끊을 수 있어요.', 'Let AI tools such as Claude Code, Cursor and Claude Desktop find, organize, rename, move, trash and restore files, add cloud downloads and create share links. Connect each tool separately and revoke any time.')),
      h('p', { class: 'muted small' }, t('토큰을 헤더로 넣을 수 있는 도구만 연결돼요. OAuth 로그인만 받는 웹 커넥터(ChatGPT, claude.ai 웹)는 아직 연결할 수 없어요.', 'Only tools that accept a token header can connect. Web connectors that only support OAuth sign-in (ChatGPT, claude.ai on the web) are not supported yet.')),
      h('div', { class: 'ig-grid' }, h('span', { class: 'ig-label' }, t('MCP 주소', 'Endpoint')), copyField(endpoint)),
      conns.length
        ? h(
            'div',
            { class: 'ig-list' },
            ...conns.map((c) =>
              h(
                'div',
                { class: 'ig-item' },
                h('div', {}, h('b', {}, c.name), h('div', { class: 'muted small' }, t(`연결 ${formatDate(c.createdAt, false)} · 마지막 사용 ${when(c.lastUsedAt)} · 만료 ${formatDate(c.expiresAt, false)}`, `Connected ${formatDate(c.createdAt, false)} · last used ${when(c.lastUsedAt)}`)), scopeBadges(c.scopes)),
                h('button', {
                  class: 'btn sm danger',
                  onclick: async () => {
                    if (!(await confirmDialog(t('연결 끊기', 'Disconnect'), t(`${c.name} 의 연결을 끊을까요? 바로 접근할 수 없게 돼요.`, `Disconnect ${c.name}? Access stops immediately.`), { okLabel: t('끊기', 'Disconnect'), danger: true }))) return;
                    await api(`/api/integrations/apps/${encodeURIComponent(c.id)}`, { method: 'DELETE' }).catch(toastError);
                    refreshAll();
                  },
                }, t('연결 끊기', 'Disconnect')),
              ),
            ),
          )
        : empty(t('연결된 AI 도구가 없어요.', 'No AI tools connected.')),
    );
  });

  const tokens = lazyCard(async function draw(card) {
    const { items } = await api('/api/integrations/tokens');
    const create = () => {
      const name = h('input', { class: 'input', maxlength: 50, 'aria-label': t('이름', 'Name'), placeholder: t('예: NAS 백업 스크립트', 'e.g. NAS backup script') });
      const checks = SCOPES.map(([k, ko, en, dko, den]) => {
        const allowed = TOKEN_SCOPES.includes(k);
        const cb = h('input', { type: 'checkbox', checked: k === 'files:read', disabled: !allowed });
        return [k, cb, h('label', { class: `check ig-scope${allowed ? '' : ' off'}` }, cb, h('span', {}, h('b', {}, t(ko, en)), h('span', { class: 'muted small' }, ` — ${t(dko, den)}`)))];
      });
      const days = h(
        'select',
        { class: 'input', 'aria-label': t('만료', 'Expires in') },
        ...[
          [30, '30일', '30 days'],
          [60, '60일', '60 days'],
          [90, '90일(권장)', '90 days (recommended)'],
          [180, '180일', '180 days'],
          [365, '1년', '1 year'],
        ].map(([v, ko, en]) => h('option', { value: v, selected: v === 90 }, t(ko, en))),
      );
      modal({
        title: t('개인 액세스 토큰 만들기', 'New personal access token'),
        wide: true,
        body: h(
          'div',
          {},
          h('div', { class: 'field' }, h('label', {}, t('이름', 'Name')), name),
          h('div', { class: 'field' }, h('label', {}, t('권한', 'Permissions')), ...checks.map(([, , el]) => el)),
          h('div', { class: 'field' }, h('label', {}, t('만료', 'Expires in')), days, h('span', { class: 'hint' }, t('만료 없는 토큰은 만들 수 없어요(30일~1년).', 'Tokens must expire (30 days to 1 year).'))),
          h('p', { class: 'muted small' }, t('토큰을 만들면 계정 이메일로 알림을 보내요.', 'We email you when a token is created.')),
        ),
        actions: [
          { label: t('취소', 'Cancel') },
          {
            label: t('만들기', 'Create'),
            kind: 'primary',
            onClick: async () => {
              const scopes = checks.filter(([, cb]) => cb.checked).map(([k]) => k);
              if (!name.value.trim()) return toast(t('이름을 적어 주세요', 'Enter a name'), 'error'), false;
              if (!scopes.length) return toast(t('권한을 하나 이상 골라 주세요', 'Pick at least one permission'), 'error'), false;
              const r = await api('/api/integrations/tokens', { method: 'POST', body: { name: name.value.trim(), scopes, days: Number(days.value) } });
              showSecret(t('새 개인 액세스 토큰', 'New personal access token'), r.token, h('p', { class: 'muted small' }, t('CLI 에서는 MIMIC_TOKEN 환경변수에, 다른 프로그램에서는 Authorization: Bearer 헤더에 넣어 쓰세요.', 'Use it as MIMIC_TOKEN for the CLI, or in an Authorization: Bearer header.')));
              draw(card);
            },
          },
        ],
      });
    };
    fill(card, 
      head('shield', t('개인 액세스 토큰', 'Personal access tokens'), h('button', { class: 'btn sm primary', onclick: create, html: `${icon('plus')}<span>${t('토큰 만들기', 'New token')}</span>` })),
      h('p', { class: 'muted' }, t('직접 만든 스크립트나 서버에서 미믹을 쓸 때 비밀번호 대신 쓰는 열쇠예요. 만든 직후에 한 번만 보여 드리고, 폐기하면 바로 쓸 수 없게 돼요.', 'A key for your own scripts and servers instead of a password. Shown once; revoking takes effect immediately.')),
      items.length
        ? h(
            'div',
            { class: 'ig-table' },
            h(
              'table',
              { class: 'table' },
              h('thead', {}, h('tr', {}, h('th', {}, t('이름', 'Name')), h('th', {}, t('권한', 'Permissions')), h('th', {}, t('만료', 'Expires')), h('th', {}, t('마지막 사용', 'Last used')), h('th', {}))),
              h(
                'tbody',
                {},
                ...items.map((k) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('b', {}, k.name)),
                    h('td', {}, scopeBadges(k.scopes)),
                    h('td', { class: 'small' }, formatDate(k.expiresAt, false), k.expired ? h('span', { class: 'badge danger' }, t('만료됨', 'Expired')) : null),
                    h('td', { class: 'small muted' }, when(k.lastUsedAt)),
                    h(
                      'td',
                      { style: { textAlign: 'right' } },
                      h('button', {
                        class: 'btn sm danger',
                        onclick: async () => {
                          if (!(await confirmDialog(t('토큰 폐기', 'Revoke token'), t(`"${k.name}" 토큰을 폐기할까요? 이 토큰을 쓰는 프로그램은 바로 멈춰요.`, `Revoke "${k.name}"? Programs using it stop immediately.`), { okLabel: t('폐기', 'Revoke'), danger: true }))) return;
                          await api(`/api/integrations/tokens/${encodeURIComponent(k.id)}`, { method: 'DELETE' }).catch(toastError);
                          draw(card);
                        },
                      }, t('폐기', 'Revoke')),
                    ),
                  ),
                ),
              ),
            ),
          )
        : empty(t('만든 토큰이 없어요.', 'No tokens yet.')),
      h(
        'details',
        { class: 'ig-scopes' },
        h('summary', {}, t('연결 앱 권한 6단계 안내', 'The six permission levels')),
        h('ul', {}, ...SCOPES.map(([k, ko, en, dko, den]) => h('li', {}, h('b', {}, t(ko, en)), h('code', {}, k), h('span', { class: 'muted' }, t(dko, den))))),
      ),
    );
  });

  const apps = lazyCard(async function draw(card) {
    const { items } = await api('/api/integrations/apps');
    fill(card, 
      head('puzzle', t('연결된 앱', 'Connected apps')),
      h('p', { class: 'muted' }, t('CLI·브라우저 확장·텔레그램·WebDAV·AI 도구처럼 내 드라이브에 접근하도록 허용한 앱이에요. 끊으면 바로 접근이 막혀요.', 'Apps you allowed to access your drive. Disconnecting takes effect immediately.')),
      items.length
        ? h(
            'div',
            { class: 'ig-list' },
            ...items.map((a) =>
              h(
                'div',
                { class: 'ig-item' },
                h(
                  'div',
                  {},
                  h('b', {}, a.name),
                  a.connections.length > 1 ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, t(`${a.connections.length}개 연결`, `${a.connections.length} connections`)) : null,
                  h('div', { class: 'muted small' }, t(`처음 연결 ${formatDate(a.createdAt, false)} · 마지막 사용 ${when(a.lastUsedAt)}`, `Since ${formatDate(a.createdAt, false)} · last used ${when(a.lastUsedAt)}`)),
                  scopeBadges(a.scopes),
                ),
                h('button', {
                  class: 'btn sm danger',
                  onclick: async () => {
                    if (!(await confirmDialog(t('앱 연결 해제', 'Disconnect app'), t(`${a.name} 의 모든 연결을 끊을까요?`, `Disconnect all of ${a.name}?`), { okLabel: t('해제', 'Disconnect'), danger: true }))) return;
                    try {
                      await api(`/api/integrations/apps/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
                      toast(t('연결을 끊었습니다', 'Disconnected'), 'ok');
                    } catch (e) {
                      toastError(e);
                    }
                    refreshAll(); // MCP·WebDAV·텔레그램 카드에도 바로 반영
                  },
                }, t('연결 해제', 'Disconnect')),
              ),
            ),
          )
        : empty(t('연결된 앱이 없어요.', 'No connected apps.')),
    );
  });

  // 연결 코드 카운트다운·연결 확인 타이머는 하나만 돈다(새 코드를 받거나 카드를 다시 그리면 이전 것을 멈춘다)
  let codeTimer = null;
  const stopCode = () => {
    clearInterval(codeTimer);
    timers.delete(codeTimer);
    codeTimer = null;
  };
  const telegram = lazyCard(async function draw(card) {
    stopCode();
    const st = await api('/api/integrations/telegram/status');
    const bot = st.botUsername ? `@${st.botUsername}` : t('미믹 텔레그램 봇', 'the Mimic Telegram bot');
    const codeBox = h('div');
    const getCode = async () => {
      const r = await api('/api/integrations/telegram/bind-code', { method: 'POST' });
      stopCode(); // 이전 코드는 서버에서 이미 무효
      const left = h('span', { class: 'muted small' });
      const timer = setInterval(() => tick(), 1000);
      codeTimer = timer;
      timers.add(timer);
      const tick = async () => {
        const ms = r.expiresAt - Date.now();
        left.textContent = ms > 0 ? t(`${Math.floor(ms / 60000)}분 ${Math.floor((ms % 60000) / 1000)}초 남음`, `${Math.ceil(ms / 1000)}s left`) : t('코드가 만료되었어요. 새로 받아 주세요.', 'Expired. Get a new code.');
        if (ms <= 0) return stopCode();
        if (Math.floor(ms / 1000) % 4 === 0 && (await api('/api/integrations/telegram/status').catch(() => ({}))).bound && codeTimer === timer) {
          stopCode();
          toast(t('텔레그램이 연결되었습니다', 'Telegram connected'), 'ok');
          refreshAll();
        }
      };
      fill(codeBox, 
        h('div', { class: 'ig-code' }, r.code),
        h('p', {}, t(`텔레그램에서 ${bot} 에게 `, `In Telegram, send `), h('code', {}, `/bind ${r.code}`), t(' 를 보내세요.', ` to ${bot}.`), ' ', left),
        r.botUsername ? h('a', { class: 'btn sm', href: `https://t.me/${r.botUsername}`, target: '_blank', rel: 'noopener', html: `${icon('send')}<span>${t('텔레그램 열기', 'Open Telegram')}</span>` }) : null,
      );
      tick();
    };
    fill(card, 
      head('send', t('텔레그램 봇', 'Telegram bot'), st.bound ? h('span', { class: 'badge brand' }, t('연결됨', 'Connected')) : null),
      h('p', { class: 'muted' }, t('봇에게 링크를 보내거나 파일·사진·영상을 전달하면 미믹 클라우드에 저장돼요. 텔레그램 봇은 20MB 보다 큰 파일은 받을 수 없으니 큰 파일은 링크로 보내세요.', 'Send links or forward files to the bot to save them. The bot cannot fetch files over 20MB—send links instead.')),
      !st.enabled
        ? h('div', { class: 'ig-note' }, t('이 서버에는 아직 텔레그램 봇이 설정되지 않았어요.', 'The Telegram bot is not configured on this server.'))
        : st.bound
          ? h(
              'div',
              { class: 'ig-item' },
              h('div', {}, h('b', {}, t(`텔레그램 ID ${st.telegramUserId}`, `Telegram ID ${st.telegramUserId}`)), h('div', { class: 'muted small' }, t(`${formatDate(st.since, false)} 연결 · 저장 폴더: ${st.folder || '최상위'}`, `Since ${formatDate(st.since, false)} · folder: ${st.folder || 'top level'}`))),
              h('button', {
                class: 'btn sm danger',
                onclick: async () => {
                  if (!(await confirmDialog(t('텔레그램 연동 해제', 'Disconnect Telegram'), t('봇으로 더는 저장되지 않아요. 해제할까요?', 'The bot will stop saving to your drive. Disconnect?'), { okLabel: t('해제', 'Disconnect'), danger: true }))) return;
                  await api('/api/integrations/telegram', { method: 'DELETE' }).catch(toastError);
                  refreshAll();
                },
              }, t('연동 해제', 'Disconnect')),
            )
          : h('div', {}, h('button', { class: 'btn primary sm', onclick: () => getCode().catch(toastError) }, t('연결 코드 받기', 'Get a link code')), h('span', { class: 'muted small', style: { marginLeft: '8px' } }, t('코드는 10분 동안 쓸 수 있어요.', 'Codes last 10 minutes.')), codeBox),
    );
  });

  const tools = h(
    'section',
    { class: 'card ig-card' },
    head('terminal', t('CLI · 브라우저 확장', 'CLI · Browser extension')),
    h('p', { class: 'muted' }, t('터미널에서 미믹을 다루는 CLI 예요. 로그인은 브라우저 승인으로 하니 비밀번호를 터미널에 넣지 않아요.', 'Use Mimic from the terminal. Login is approved in the browser—no password in the terminal.')),
    h(
      'div',
      { class: 'ig-grid' },
      h('span', { class: 'ig-label' }, 'macOS · Linux'),
      copyField(`curl -fsSL ${origin}/api/integrations/cli/install.sh | sh`),
      h('span', { class: 'ig-label' }, 'Windows'),
      copyField(`irm ${origin}/api/integrations/cli/install.ps1 | iex`),
      h('span', { class: 'ig-label' }, t('npx (설치 없이)', 'npx (no install)')),
      copyField(`npx -y ${origin}/api/integrations/cli/mimic-cli.tgz auth login`),
      h('span', { class: 'ig-label' }, 'Homebrew'),
      // Homebrew 는 탭 안의 공식만 설치하므로 로컬 탭에 받아 설치한다
      copyField(
        `brew tap-new --no-git mimic/local\nF="$(brew --repository mimic/local)/Formula"; mkdir -p "$F"\ncurl -fsSL ${origin}/api/integrations/cli/mimic.rb -o "$F/mimic.rb"\nbrew install mimic/local/mimic`,
        { multiline: true },
      ),
      h('span', { class: 'ig-label' }, t('로그인', 'Log in')),
      copyField('mimic auth login'),
      h('span', { class: 'ig-label' }, t('AI 에이전트 스킬', 'AI agent skill')),
      copyField('mimic skill install'),
    ),
    h('p', { class: 'muted small' }, t('mimic skill install 은 Claude Code 같은 AI 에이전트가 CLI 로 드라이브를 다루도록 사용법 문서(SKILL.md)를 설치해요.', '"mimic skill install" adds a SKILL.md so AI agents like Claude Code can use your drive via the CLI.')),
    h('hr', { class: 'ig-hr' }),
    h('p', { class: 'muted' }, t('브라우저 확장은 웹페이지의 마그넷·토렌트·영상·파일 링크를 찾아 한 번에 저장하고, 매일 출석 체크로 프리미엄을 받게 해 줘요(Chrome·Edge).', 'The extension finds magnet, torrent, video and file links on any page, saves them in one click, and lets you check in daily (Chrome, Edge).')),
    h(
      'div',
      { class: 'row' },
      h('a', { class: 'btn sm primary', href: '/api/integrations/extension.zip', download: 'mimic-extension.zip', html: `${icon('download')}<span>${t('설치 파일 받기 (zip)', 'Download (zip)')}</span>` }),
      h('a', { class: 'btn sm ghost', href: '/apps/extension' }, t('설치 방법 보기', 'How to install')),
    ),
    h('ol', { class: 'small muted ig-steps' }, h('li', {}, t('zip 을 풀어 둡니다.', 'Unzip the file.')), h('li', {}, t('chrome://extensions(Edge 는 edge://extensions)에서 개발자 모드를 켭니다.', 'Turn on developer mode in chrome://extensions (edge://extensions).')), h('li', {}, t('"압축해제된 확장 프로그램 로드"로 mimic-extension 폴더를 고르고, 확장 아이콘에서 계정을 연결합니다.', 'Load the unpacked mimic-extension folder and connect your account from the toolbar icon.'))),
  );

  box.append(webdav, mcp, tokens, apps, telegram, tools);
}

export async function render(root, ctx) {
  loadCss('/css/integrations.css');
  const tab = TABS.some(([k]) => k === ctx.params.tab) ? ctx.params.tab : null;
  if (!tab) return ctx.navigate('/drive/settings/basic', { replace: true });
  root.replaceChildren(h('div', { class: 'page-loading' }, h('div', { class: 'spinner' })));
  const { settings } = await api('/api/integrations/settings');
  const save = (patch) =>
    api('/api/integrations/settings', { method: 'PUT', body: patch }).then(
      (r) => {
        Object.assign(settings, r.settings);
        toast(t('저장했습니다', 'Saved'), 'ok');
        ctx.refreshMe?.().catch(() => {}); // drive 가 읽는 내 정보(업로드 동시 수·자동 재시도 등)를 새 값으로
        return r;
      },
      (e) => {
        toastError(e);
        throw e;
      },
    );
  const body = h('div', { class: 'ig-body' });
  root.replaceChildren(
    h(
      'div',
      { class: 'ig-page' },
      h('div', { class: 'page-head' }, h('h2', {}, t('환경설정', 'Preferences'))),
      h('nav', { class: 'tabs' }, ...TABS.map(([k, ko, en]) => h('a', { href: `/drive/settings/${k}`, class: k === tab ? 'active' : '' }, t(ko, en)))),
      body,
    ),
  );
  const timers = new Set();
  if (tab === 'basic') basicTab(body, settings, save);
  else if (tab === 'transfer') transferTab(body, settings, save);
  else integrationsTab(body, settings, save, timers);
  return () => timers.forEach(clearInterval);
}
