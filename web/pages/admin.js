// 관리자 백오피스(K-06): /admin/:section — dashboard·users·orders·coupons(+Pro 신청)·reports·blocklist·quotas·logs
// 다른 모듈의 관리자 API(결제·쿠폰·이의제기·피드백·지역 규칙)가 아직 없으면(404) "준비 중"을 보여 준다.
import { api, h, icon, t, toast, toastError, modal, confirmDialog, promptDialog, formatBytes, formatDate, formatWon, loadCss } from '/ui.js';
import { REASONS } from '/pages/copyright.js';

const GB = 1024 ** 3;
const n = (v) => (v == null ? '—' : Number(v).toLocaleString('ko-KR'));
const soon = (what) => h('div', { class: 'ad-soon' }, h('h3', {}, t(`${what} 기능은 준비 중입니다`, `${what}: coming soon`)), h('p', { class: 'small' }, t('담당 모듈의 관리자 API 가 아직 없습니다.', 'The owning module has no admin API yet.')));
const stat = (v, label, warn) => h('div', { class: `ad-stat ${warn ? 'warn' : ''}` }, h('b', {}, v), h('span', {}, label));
const head = (title, ...right) => h('div', { class: 'page-head' }, h('h2', {}, title), h('div', { class: 'spacer' }), ...right);
const field = (label, el) => h('div', { class: 'field' }, h('label', {}, label), el);
const input = (attrs = {}) => h('input', { class: 'input', ...attrs });
const select = (opts, value) => h('select', { class: 'input' }, ...opts.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
const short = (v, len = 80) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > len ? s.slice(0, len) + '…' : s;
};

function table(cols, rows, onRow) {
  return h(
    'div',
    { class: 'ad-wrap' },
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, c)))),
      h('tbody', {}, ...(rows.length ? rows.map((r) => (onRow ? Object.assign(r, { className: 'click' }) : r)) : [h('tr', {}, h('td', { colspan: cols.length, class: 'muted' }, t('항목이 없습니다', 'No items')))])),
    ),
  );
}
const tr = (cells, onclick) => h('tr', { onclick }, ...cells.map((c) => (c instanceof Node && c.tagName === 'TD' ? c : h('td', {}, c))));
function pager(r, go) {
  const pages = Math.max(1, Math.ceil((r.total || 0) / (r.pageSize || 20)));
  return h(
    'div',
    { class: 'ad-pager' },
    t(`${n(r.total)}건 · ${r.page}/${pages}쪽`, `${n(r.total)} items · page ${r.page}/${pages}`),
    h('button', { class: 'btn sm', disabled: r.page <= 1, onclick: () => go(r.page - 1) }, t('이전', 'Prev')),
    h('button', { class: 'btn sm', disabled: r.page >= pages, onclick: () => go(r.page + 1) }, t('다음', 'Next')),
  );
}
// 다른 모듈 API: 404 면 null
async function optional(path, opts) {
  try {
    return await api(path, opts);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
const listOf = (r) => r?.items || r?.appeals || [];
// 모양을 모르는 다른 모듈 데이터용 표
function autoTable(items, prefer, actions) {
  const keys = prefer.filter((k) => items.some((x) => x[k] != null));
  const cols = keys.length ? keys : Object.keys(items[0] || {}).slice(0, 6);
  const fmt = (k, v) => (/(_at|At)$/.test(k) && typeof v === 'number' ? formatDate(v) : typeof v === 'object' && v ? short(v) : v ?? '');
  return table(actions ? [...cols, ''] : cols, items.map((x) => tr([...cols.map((k) => h('td', { class: 'ad-trunc', title: String(x[k] ?? '') }, fmt(k, x[k]))), ...(actions ? [actions(x)] : [])])));
}

// ---------- 대시보드 + 공지 발송 ----------
async function dashboard(root) {
  const [s, bs] = await Promise.all([api('/api/admin/stats'), optional('/api/admin/billing/stats').catch(() => null)]);
  const u = s.users;
  const st = s.storage;
  const statusTable = (x, label) =>
    x
      ? h('div', { class: 'card' }, h('h3', {}, `${label} (${x.table})`), h('p', { class: 'muted small' }, `전체 ${n(x.total)}건${x.last7d != null ? ` · 최근 7일 ${n(x.last7d)}건` : ''}`), x.byStatus ? table(['상태', '건수', '금액'], x.byStatus.map((r) => tr([r.status, n(r.n), r.amount != null ? formatWon(r.amount) : '—']))) : null)
      : h('div', { class: 'card' }, h('h3', {}, label), h('p', { class: 'muted' }, '아직 테이블이 없습니다.'));

  const f = { target: select([['all', '전체 회원'], ['user', '특정 회원']], 'all'), userId: input({ placeholder: '회원 ID' }), title: input({ maxlength: 100 }), body: h('textarea', { class: 'input', rows: 3, maxlength: 2000 }), titleEn: input({ maxlength: 100 }), bodyEn: h('textarea', { class: 'input', rows: 2, maxlength: 2000 }), link: input({ placeholder: '/drive/all 또는 https://…' }), email: h('input', { type: 'checkbox' }) };
  f.userId.classList.add('hidden');
  f.target.onchange = () => f.userId.classList.toggle('hidden', f.target.value !== 'user');
  const send = h('button', { class: 'btn primary', html: `${icon('send')}<span>${t('보내기', 'Send')}</span>` });
  send.onclick = async () => {
    const all = f.target.value === 'all';
    if (all && !(await confirmDialog('전체 공지', '모든 회원에게 알림을 보냅니다. 계속할까요?', { okLabel: '보내기' }))) return;
    try {
      const r = await api('/api/admin/notifications', { method: 'POST', body: { all: all || undefined, userId: all ? undefined : f.userId.value.trim(), title: f.title.value, body: f.body.value, titleEn: f.titleEn.value, bodyEn: f.bodyEn.value, link: f.link.value.trim() || null, email: f.email.checked } });
      toast(`${n(r.sent)}명에게 보냈습니다`, 'ok');
      f.title.value = f.body.value = f.titleEn.value = f.bodyEn.value = f.link.value = '';
    } catch (e) {
      toastError(e);
    }
  };

  root.replaceChildren(
    head(t('대시보드', 'Dashboard'), h('button', { class: 'btn sm', onclick: () => dashboard(root).catch(toastError), html: `${icon('refresh')}<span>${t('새로 고침', 'Refresh')}</span>` })),
    h(
      'div',
      { class: 'ad-stats' },
      stat(n(u.total), t('가입자', 'Members')),
      stat(`${n(u.new1d)} / ${n(u.new7d)}`, t('신규 (1일 / 7일)', 'New (1d / 7d)')),
      stat(n(u.active7d), t('7일 내 로그인', 'Active (7d)')),
      stat(n(u.premium), t('프리미엄', 'Premium')),
      stat(n(u.suspended), t('정지 중', 'Suspended'), u.suspended > 0),
      stat(n(u.pendingDelete), t('탈퇴 유예 중', 'Pending deletion')),
      stat(formatBytes(st.logicalBytes), t(`사용자 저장량 (파일 ${n(st.files)}개)`, `User storage (${n(st.files)} files)`)),
      stat(formatBytes(st.physicalBytes), t(`실제 디스크 (blob ${n(st.blobs)}개)`, `Disk used (${n(st.blobs)} blobs)`)),
      stat(st.logicalBytes ? `${Math.max(0, Math.round((1 - st.physicalBytes / st.logicalBytes) * 100))}%` : '—', t('중복 제거 절약률', 'Dedup savings')),
      stat(n(s.openReports), t('처리 대기 신고', 'Open reports'), s.openReports > 0),
      stat(n(s.openMessages), t('답변 대기 문의', 'Open messages'), s.openMessages > 0),
      stat(n(s.blocklist), t('차단 항목', 'Blocklist entries')),
    ),
    // 매출·구독·쿠폰(billing 모듈 API)
    bs
      ? h(
          'div',
          { class: 'ad-stats' },
          stat(formatWon(bs.revenue.today), '오늘 매출'),
          stat(formatWon(bs.revenue.month), '이번 달 매출'),
          stat(formatWon(bs.revenue.refunded), '환불액'),
          stat(n(bs.orders.refundRequested), '환불 요청', bs.orders.refundRequested > 0),
          stat(`${n(bs.subscriptions.active)} (자동 ${n(bs.subscriptions.autoRenew)})`, '활성 구독'),
          stat(`${n(bs.coupons.redeemed)} / ${n(bs.coupons.issued)}`, '쿠폰 사용 / 발급'),
          h('a', { href: '/admin/coupons?tab=pro', style: { display: 'contents' } }, stat(n(bs.proPending), '추천 Pro 신청 대기', bs.proPending > 0)),
        )
      : null,
    h('div', { class: 'ad-cols' }, statusTable(s.tasks, '클라우드 다운로드 작업'), statusTable(s.orders, '주문')),
    h(
      'div',
      { class: 'ad-cols', style: { marginTop: '16px' } },
      h(
        'div',
        { class: 'card' },
        h('h3', {}, t('공지 알림 보내기', 'Send an announcement')),
        h('div', { class: 'row' }, f.target, f.userId),
        h('div', { style: { height: '10px' } }),
        field(t('제목', 'Title'), f.title),
        field(t('내용', 'Body'), f.body),
        field(t('영어 제목(선택, 영어 사용자에게)', 'English title (optional, for English users)'), f.titleEn),
        field(t('영어 내용(선택)', 'English body (optional)'), f.bodyEn),
        field(t('링크(선택)', 'Link (optional)'), f.link),
        h('label', { class: 'check', style: { marginBottom: '12px' } }, f.email, t('이메일로도 보내기(개발 모드는 발송함에 기록)', 'Also send by email (dev mode: written to the outbox)')),
        send,
      ),
      h('div', { class: 'card' }, h('h3', {}, t('모듈 상태', 'Modules')), h('p', {}, ...s.modules.map((m) => h('span', { class: 'badge brand', style: { margin: '0 4px 4px 0' } }, m))), s.failedModules.length ? h('p', {}, '불러오기 실패: ', ...s.failedModules.map((m) => h('span', { class: 'badge danger', style: { marginRight: '4px' } }, m))) : h('p', { class: 'muted small' }, '실패한 모듈 없음')),
    ),
  );
}

// ---------- 회원 ----------
async function users(root, ctx) {
  const q = input({ type: 'search', class: 'input grow', placeholder: t('이메일·휴대폰·이름·ID 검색', 'Search email, phone, name or ID'), value: ctx.query.q || '' });
  const status = select([['', '모든 상태'], ['active', '정상'], ['suspended', '정지'], ['pending_delete', '탈퇴 유예'], ['locked', '잠김'], ['unverified', '미인증']], ctx.query.status || '');
  const out = h('div');
  const load = async (page = 1) => {
    const r = await api(`/api/admin/users?q=${encodeURIComponent(q.value.trim())}&status=${status.value}&page=${page}`);
    out.replaceChildren(
      table(
        ['이메일·휴대폰', '이름', '상태', '프리미엄', '사용량', '가입', '최근 로그인'],
        r.items.map((u) =>
          tr(
            [u.email || u.phone || u.id, u.name, statusBadge(u), u.premium ? h('span', { class: 'badge brand' }, formatDate(u.premiumUntil, false) + '까지') : '무료', formatBytes(u.used), formatDate(u.createdAt, false), formatDate(u.lastLoginAt)],
            () => userDetail(u.id, () => load(r.page)),
          ),
        ),
        true,
      ),
      pager(r, load),
    );
  };
  q.addEventListener('keydown', (e) => e.key === 'Enter' && load().catch(toastError));
  status.onchange = () => load().catch(toastError);
  root.replaceChildren(head(t('회원', 'Members')), h('div', { class: 'ad-toolbar' }, q, status, h('button', { class: 'btn primary', onclick: () => load().catch(toastError) }, t('검색', 'Search'))), out);
  await load();
}
function statusBadge(u) {
  const map = { active: ['정상', 'brand'], suspended: ['정지', 'danger'], pending_delete: ['탈퇴 유예', 'accent'], locked: ['잠김', 'danger'], unverified: ['미인증', ''] };
  const [label, cls] = map[u.status] || [u.status, ''];
  return h('span', { class: `badge ${cls}` }, label, u.isAdmin ? ' · 관리자' : '', u.status === 'suspended' && u.statusUntil ? ` ~${formatDate(u.statusUntil)}` : '');
}

async function userDetail(id, reload) {
  const d = await api(`/api/admin/users/${encodeURIComponent(id)}`).catch(toastError);
  if (!d) return;
  const u = d.user;
  let close;
  const patch = async (body, msg) => {
    try {
      await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      toast(msg, 'ok');
      close?.();
      reload?.();
      userDetail(id, reload);
    } catch (e) {
      toastError(e);
    }
  };
  const box = (title, ...children) => h('div', { class: 'card' }, h('b', {}, title), ...children);

  const hours = select([['24', '24시간'], ['72', '3일'], ['168', '7일'], ['720', '30일'], ['8760', '1년']], '24');
  const reason = input({ placeholder: '사유(감사 로그에 남음)' });
  const days = input({ type: 'number', min: 1, max: 3650, value: 30 });
  const qKind = select([['cloud', '클라우드 다운로드 (GB)'], ['down', '다운스트림 (GB)'], ['up', '업로드 (GB)'], ['cloud_count', '무료 클라우드 횟수 (회)']], 'down');
  const qAmount = input({ type: 'number', min: 1, value: 100 });
  const qMonths = input({ type: 'number', min: 1, max: 12, value: 1, title: '개월' });
  const kv = (pairs) => h('dl', { class: 'ad-kv' }, ...pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
  const q = d.quota?.month || {};

  const body = h(
    'div',
    { class: 'col', style: { gap: '14px' } },
    kv([
      ['ID', h('span', { class: 'ad-mono' }, u.id)],
      ['이메일 / 휴대폰', `${u.email || '—'} / ${u.phone || '—'}`],
      ['상태', statusBadge(u)],
      ['프리미엄', u.premium ? `${formatDate(u.premiumUntil)}까지 (${u.tier})` : '무료'],
      ['파일', `${n(d.files.count)}개 (휴지통 ${n(d.files.trashed)}) · ${formatBytes(d.files.used)} · 금고 ${formatBytes(d.files.vaultUsed)}`],
      ['이번 달 쿼터', ['cloud', 'down', 'up'].map((k) => `${k} ${formatBytes(q[k]?.used || 0)}/${formatBytes(q[k]?.limit)}`).join(' · ')],
      ['토큰·연결 앱', `${n(d.tokens)}개`],
      ['받은 신고', `${n(d.reports)}건`],
      ['가입 / 최근 로그인', `${formatDate(u.createdAt)} / ${formatDate(u.lastLoginAt)}`],
      ['주문', d.orders ? `${n(d.orders.count)}건` : '결제 모듈 없음'],
    ]),
    d.sessions.length ? h('div', {}, h('b', {}, '로그인 세션'), table(['기기', 'IP', '마지막 접속'], d.sessions.map((s) => tr([s.device || '', s.ip || '', formatDate(s.lastSeenAt)])))) : null,
    d.grants.length ? h('div', {}, h('b', {}, '추가 쿼터 지급 내역'), table(['종류', '양', '기간', '사유'], d.grants.map((g) => tr([g.kind, g.kind === 'cloud_count' ? `${g.amount}회` : formatBytes(g.amount), `${formatDate(g.validFrom, false)} ~ ${g.validTo ? formatDate(g.validTo, false) : '상시'}`, g.reason])))) : null,
    d.orders?.recent?.length ? h('div', {}, h('b', {}, '최근 주문'), autoTable(d.orders.recent, ['id', 'product_id', 'amount', 'status', 'created_at'])) : null,
    h(
      'div',
      { class: 'ad-actions' },
      u.status === 'suspended'
        ? box(t('정지 해제', 'Lift suspension'), h('button', { class: 'btn', onclick: () => patch({ unsuspend: true }, t('정지를 해제했습니다', 'Suspension lifted')) }, t('지금 해제', 'Lift now')))
        : box(t('일시 정지', 'Suspend'), h('div', { class: 'row' }, hours), reason, h('button', { class: 'btn danger', onclick: () => patch({ suspendHours: Number(hours.value), reason: reason.value || undefined }, t('정지했습니다', 'Suspended')) }, t('정지', 'Suspend'))),
      // 탈퇴 처리 중인 계정: 법 위반·도난 위험 등으로 삭제를 보류하거나 다시 진행(auth 모듈 API)
      u.status === 'pending_delete'
        ? box(
            t('탈퇴 처리', 'Account deletion'),
            h('p', { class: 'small muted' }, t('7일 유예 뒤 자동 삭제됩니다. 조사가 필요하면 보류하세요.', 'Deleted automatically after the 7-day grace period. Put it on hold if you need to investigate.')),
            h(
              'div',
              { class: 'row' },
              ...[
                [true, t('삭제 보류', 'Hold deletion')],
                [false, t('보류 해제', 'Release hold')],
              ].map(([hold, label]) =>
                h(
                  'button',
                  {
                    class: `btn ${hold ? 'danger' : ''}`,
                    onclick: () =>
                      api(`/api/admin/auth/users/${encodeURIComponent(id)}/delete-hold`, { method: 'POST', body: { hold } })
                        .then(() => (toast(hold ? '삭제를 보류했습니다' : '보류를 해제했습니다', 'ok'), userDetail(id, reload)))
                        .catch(toastError),
                  },
                  label,
                ),
              ),
            ),
          )
        : null,
      // H-03: 연락처가 무효(반송·없는 번호)로 확인되면 표시한다. 3년 이상 로그인하지 않은 계정은 다음 휴면 정리(하루 1회) 때 바로 삭제된다
      box(
        t('연락처 무효', 'Contact invalid'),
        h(
          'p',
          { class: 'small muted' },
          u.settings?.contactInvalidAt
            ? t(`${formatDate(u.settings.contactInvalidAt)}에 무효로 표시됨`, `Marked invalid on ${formatDate(u.settings.contactInvalidAt)}`)
            : t('메일 반송·없는 번호처럼 연락할 수 없음을 확인했을 때 표시하세요.', 'Mark this when mail bounces or the number does not exist.'),
          ' ',
          t('3년 이상 로그인하지 않은 계정은 표시 다음 날(하루 1회 휴면 정리) 알림 없이 삭제됩니다.', 'Accounts inactive for 3+ years are then deleted without notice at the next daily dormant cleanup.'),
        ),
        h(
          'button',
          {
            class: `btn ${u.settings?.contactInvalidAt ? '' : 'danger'}`,
            onclick: () =>
              api(`/api/admin/auth/users/${encodeURIComponent(id)}/contact-invalid`, { method: 'POST', body: { invalid: !u.settings?.contactInvalidAt } })
                .then(() => (toast(t('바꿨습니다', 'Updated'), 'ok'), userDetail(id, reload)))
                .catch(toastError),
          },
          u.settings?.contactInvalidAt ? t('무효 표시 해제', 'Clear invalid mark') : t('연락처 무효로 표시', 'Mark contact invalid'),
        ),
      ),
      box(t('프리미엄 지급', 'Grant Premium'), h('div', { class: 'row' }, days, t('일', 'days')), h('button', { class: 'btn primary', onclick: () => patch({ premiumDays: Number(days.value), reason: reason.value || undefined }, t('프리미엄을 지급했습니다', 'Premium granted')) }, t('지급', 'Grant'))),
      box(
        t('쿼터 지급', 'Grant quota'),
        qKind,
        h('div', { class: 'row' }, qAmount, qMonths, '개월'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              const amt = Number(qAmount.value);
              patch({ grantQuota: { kind: qKind.value, amount: qKind.value === 'cloud_count' ? amt : Math.round(amt * GB), months: Number(qMonths.value) } }, t('쿼터를 지급했습니다', 'Quota granted'));
            },
          },
          t('지급', 'Grant'),
        ),
      ),
      box(
        t('기타', 'Other'),
        h('button', { class: 'btn', onclick: () => patch({ isAdmin: !u.isAdmin }, u.isAdmin ? t('관리자 권한을 해제했습니다', 'Admin removed') : t('관리자로 지정했습니다', 'Made admin')) }, u.isAdmin ? t('관리자 해제', 'Remove admin') : t('관리자로 지정', 'Make admin')),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const title = await promptDialog('알림 보내기', { label: '제목' });
              if (!title) return;
              api('/api/admin/notifications', { method: 'POST', body: { userId: id, title } })
                .then(() => toast('보냈습니다', 'ok'))
                .catch(toastError);
            },
          },
          t('알림 보내기', 'Send notification'),
        ),
        h(
          'button',
          {
            class: 'btn danger',
            onclick: async () => {
              if (!(await confirmDialog('회원 즉시 삭제', `${u.email || u.phone || u.id} 의 계정과 파일을 지금 삭제합니다. 되돌릴 수 없습니다.`, { okLabel: '영구 삭제', danger: true }))) return;
              try {
                await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
                toast('삭제했습니다', 'ok');
                close?.();
                reload?.();
              } catch (e) {
                toastError(e);
              }
            },
          },
          t('즉시 삭제', 'Delete now'),
        ),
      ),
    ),
  );
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  close = modal({ title: u.name || u.email || u.phone || '회원', body, wide: true });
}

// ---------- 결제·환불(billing 모듈 API: GET /api/admin/billing/orders?status=, POST …/:id/refund {note}) ----------
const ORDER_STATUS = [['', '모든 상태'], ['paid', '결제 완료'], ['refund_requested', '환불 요청'], ['refunded', '환불됨'], ['pending', '결제 대기'], ['failed', '실패']];
async function orders(root, ctx) {
  const out = h('div');
  const status = select(ORDER_STATUS, ctx.query.status || '');
  const load = async () => {
    const r = await optional(`/api/admin/billing/orders?status=${status.value}`);
    if (!r) return out.replaceChildren(soon('결제·환불'));
    const items = listOf(r);
    out.replaceChildren(
      table(
        ['주문', '회원', '상품', '금액', '수단', '상태', '결제 시각', ''],
        items.map((o) => {
          const refundable = o.status === 'paid' || o.status === 'refund_requested';
          return tr([
            h('span', { class: 'ad-mono' }, o.id, o.testMode ? h('span', { class: 'badge', style: { marginLeft: '4px' } }, '테스트') : null),
            o.user || o.userId || '',
            o.label || o.productId || '',
            typeof o.amount === 'number' ? formatWon(o.amount) : '',
            o.method || '',
            h('span', { class: `badge ${o.status === 'refunded' ? 'danger' : o.status === 'refund_requested' ? 'accent' : o.status === 'paid' ? 'brand' : ''}`, title: o.refundReason || '' }, ORDER_STATUS.find(([v]) => v === o.status)?.[1] || o.status),
            formatDate(o.paidAt || o.createdAt),
            refundable ? h('button', { class: 'btn sm danger', onclick: () => refund(o, load) }, t('환불', 'Refund')) : '',
          ]);
        }),
      ),
      h('p', { class: 'muted small' }, `최근 ${n(items.length)}건`),
    );
  };
  status.onchange = () => load().catch(toastError);
  root.replaceChildren(head(t('결제·환불', 'Payments & refunds')), h('div', { class: 'ad-toolbar' }, status), out);
  await load();
}
async function refund(o, reload) {
  const note = await promptDialog('환불', { label: `주문 ${o.id} (${formatWon(o.amount)}) 를 환불하고 남은 혜택을 회수합니다.${o.refundReason ? ` 요청 사유: ${o.refundReason}` : ''} 처리 메모를 적어 주세요.`, okLabel: '환불하기' });
  if (note == null) return;
  try {
    await api(`/api/admin/billing/orders/${encodeURIComponent(o.id)}/refund`, { method: 'POST', body: { note } });
    toast('환불 처리했습니다', 'ok');
    reload();
  } catch (e) {
    toastError(e);
  }
}

// ---------- 쿠폰(billing 모듈 API: GET/POST /api/admin/billing/coupons {kind, days, count, maxUses, expiresAt}) ----------
const COUPON_KINDS = [['paid', '프리미엄 코드(구매 인정)'], ['trial', '체험 코드'], ['free', '무료 증정 코드']];
async function coupons(root, ctx) {
  const tab = ctx.query.tab === 'pro' ? 'pro' : 'coupons';
  const tabs = h('nav', { class: 'tabs' }, ...[['coupons', t('쿠폰', 'Coupons')], ['pro', t('추천 보상 Pro 신청', 'Referral Pro applications')]].map(([k, label]) => h('a', { href: `/admin/coupons?tab=${k}`, class: k === tab ? 'active' : '' }, label)));
  if (tab === 'pro') return proApplications(root, tabs);
  const out = h('div');
  const f = { kind: select(COUPON_KINDS, 'paid'), days: input({ type: 'number', min: 1, max: 3660, value: 30 }), count: input({ type: 'number', min: 1, max: 1000, value: 10 }), maxUses: input({ type: 'number', min: 1, value: 1 }), expiresAt: input({ type: 'date' }) };
  const load = async () => {
    const r = await optional('/api/admin/billing/coupons');
    if (!r) return out.replaceChildren(soon('쿠폰'));
    const items = listOf(r);
    out.replaceChildren(
      table(
        ['코드 끝자리', '종류', '일수', '사용', '만료', '묶음', '발급'],
        items.map((c) => tr([h('span', { class: 'ad-mono' }, `…${c.hint}`), COUPON_KINDS.find(([v]) => v === c.kind)?.[1] || c.kind, `${c.days}일`, `${n(c.usedCount)} / ${n(c.maxUses)}`, c.expiresAt ? formatDate(c.expiresAt, false) : '없음', h('span', { class: 'ad-mono' }, c.batch || ''), formatDate(c.createdAt)])),
      ),
    );
  };
  const create = h('button', { class: 'btn primary', html: `${icon('plus')}<span>${t('발급', 'Issue')}</span>` });
  create.onclick = async () => {
    try {
      const body = { kind: f.kind.value, days: Number(f.days.value), count: Number(f.count.value), maxUses: Number(f.maxUses.value), expiresAt: f.expiresAt.value ? new Date(f.expiresAt.value + 'T23:59:59+09:00').getTime() : null };
      const r = await api('/api/admin/billing/coupons', { method: 'POST', body });
      const codes = r.codes || [];
      modal({
        title: `쿠폰 ${codes.length}개 발급`,
        body: h('div', {}, h('p', { class: 'muted small' }, '코드 원문은 지금 한 번만 보여 줍니다(서버에는 해시만 저장). 복사해 두세요.'), h('textarea', { class: 'input ad-mono', rows: 8, readonly: true }, codes.join('\n'))),
        actions: [{ label: '복사', kind: 'primary', onClick: () => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('복사했습니다', 'ok')) }],
      });
      load();
    } catch (e) {
      toastError(e);
    }
  };
  root.replaceChildren(
    head(t('쿠폰', 'Coupons')),
    tabs,
    h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h3', {}, t('쿠폰 발급', 'Issue coupons')), h('div', { class: 'ad-toolbar' }, field('종류', f.kind), field('프리미엄 일수', f.days), field('발급 수', f.count), field('코드당 사용 횟수', f.maxUses), field('만료일(선택)', f.expiresAt)), create),
    out,
  );
  await load();
}

// ---------- 추천 보상 Pro 신청(I-05, billing 모듈 API: GET /api/admin/billing/pro-applications, POST …/:id {status, note}) ----------
const PRO_STATUS = { pending: ['심사 대기', 'accent'], approved: ['승인', 'brand'], rejected: ['반려', 'danger'] };
async function proApplications(root, tabs) {
  const out = h('div');
  const load = async () => {
    const r = await optional('/api/admin/billing/pro-applications');
    if (!r) return out.replaceChildren(soon('추천 보상 Pro 신청'));
    const decide = async (a, status) => {
      const note = await promptDialog(status === 'approved' ? '승인' : '반려', { label: `${a.user} 님에게 결과와 함께 보낼 메모${status === 'rejected' ? '(반려 사유)' : '(선택)'}`, okLabel: status === 'approved' ? '승인' : '반려' });
      if (note == null) return;
      try {
        await api(`/api/admin/billing/pro-applications/${encodeURIComponent(a.id)}`, { method: 'POST', body: { status, note } });
        toast('처리하고 신청자에게 알렸습니다', 'ok');
        load();
      } catch (e) {
        toastError(e);
      }
    };
    out.replaceChildren(
      table(
        ['신청자', '채널', '규모', '연락처', '신청', '상태', ''],
        listOf(r).map((a) => {
          const [label, cls] = PRO_STATUS[a.status] || [a.status, ''];
          return tr([
            a.user || a.userId,
            h('div', { class: 'ad-trunc', title: a.channel || '' }, a.channel || ''),
            a.audience || '',
            a.contact || '',
            formatDate(a.createdAt),
            h('span', { class: `badge ${cls}`, title: a.note || '' }, label, a.note ? ` · ${short(a.note, 30)}` : ''),
            a.status === 'pending' ? h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: () => decide(a, 'approved') }, '승인'), h('button', { class: 'btn sm danger', onclick: () => decide(a, 'rejected') }, '반려')) : '',
          ]);
        }),
      ),
    );
  };
  root.replaceChildren(head(t('쿠폰', 'Coupons')), tabs, h('p', { class: 'muted' }, t('승인·반려하면 신청자에게 사이트 알림과 이메일로 결과와 메모가 갑니다.', 'Approving or rejecting sends the result and note to the applicant by site notification and email.')), out);
  await load();
}

// ---------- 신고·문의·이의제기·피드백 ----------
const REASON = Object.fromEntries(REASONS.map(([v, ko]) => [v, ko]));
const reasonLabel = (r) => REASON[r] || (r === 'appeal' ? '이의제기' : r);
// 대상 소유자와 확정 조치 수. 저작권 정책: 3회 이상 확인되면 원칙적으로 계정 해지
const ownerLine = (o) => h('div', { class: `small ${o.blocked + o.suspended >= 3 ? 'ad-danger' : 'muted'}` }, `${o.label}: 받은 신고 ${n(o.n)} · 차단 ${n(o.blocked)} · 정지 ${n(o.suspended)}${o.blocked + o.suspended >= 3 ? ' (반복 침해)' : ''}`);
const KIND = { report: ['콘텐츠 신고', ''], copyright: ['저작권', 'accent'], appeal: ['이의제기', 'brand'] };
const ACTIONS = [['dismiss', '조치 없음'], ['block', '차단 목록에 추가'], ['suspend', '소유자 정지'], ['unblock', '차단 해제(이의 인용)']];
async function reports(root, ctx) {
  const tab = ['reports', 'messages', 'appeals', 'feedback'].includes(ctx.query.tab) ? ctx.query.tab : 'reports';
  const tabs = h('nav', { class: 'tabs' }, ...[['reports', t('신고·저작권·이의제기', 'Reports, copyright & appeals')], ['messages', t('문의', 'Messages')], ['appeals', t('클라우드 다운로드 이의제기', 'Cloud download appeals')], ['feedback', t('피드백', 'Feedback')]].map(([k, label]) => h('a', { href: `/admin/reports?tab=${k}`, class: k === tab ? 'active' : '' }, label)));
  const out = h('div');
  root.replaceChildren(head(t('신고·이의제기', 'Reports & appeals')), tabs, out);
  if (tab === 'reports') {
    const status = select([['open', '처리 대기'], ['resolved', '처리 완료'], ['', '전체']], ctx.query.status ?? 'open');
    const kind = select([['', '모든 종류'], ['report', '콘텐츠 신고'], ['copyright', '저작권'], ['appeal', '이의제기']], ctx.query.kind || '');
    const reason = select([['', '모든 사유'], ...REASONS.map(([v, ko]) => [v, ko])], ctx.query.reason || '');
    const list = h('div');
    const load = async (page = 1) => {
      const r = await api(`/api/admin/reports?status=${status.value}&kind=${kind.value}&reason=${reason.value}&page=${page}`);
      list.replaceChildren(
        table(
          ['종류', '대상', '사유·내용', '신고자', '접수', '상태', ''],
          r.items.map((x) =>
            tr([
              h('span', { class: `badge ${KIND[x.kind]?.[1] || ''}` }, KIND[x.kind]?.[0] || x.kind),
              h('div', {}, h('span', { class: 'muted small' }, x.targetType), h('div', { class: 'ad-mono ad-trunc', title: x.target }, x.target), ...(x.owners || []).map(ownerLine)),
              h('div', {}, h('b', { class: x.reason === 'child' || x.reason === 'illegal_filming' ? 'ad-danger' : '' }, reasonLabel(x.reason)), x.meta?.claimant ? h('div', { class: 'small' }, `권리자: ${x.meta.claimant}`) : null, x.meta?.waitUntil ? h('div', { class: 'small' }, t(`저작권 신고인에게 전달함 · ${formatDate(x.meta.waitUntil)}까지 법적 조치 통지를 기다린 뒤 처리`, `Forwarded to the copyright claimant · wait for notice of legal action until ${formatDate(x.meta.waitUntil)}`)) : null, x.detail ? h('div', { class: 'ad-detail' }, x.detail) : null),
              x.reporterEmail || (x.reporterId ? '회원' : '익명'),
              formatDate(x.createdAt),
              x.status === 'open' ? h('span', { class: 'badge accent' }, '대기') : h('span', { class: 'badge' }, `${x.action}${x.note ? ` · ${short(x.note, 30)}` : ''}`),
              x.status === 'open' ? h('button', { class: 'btn sm primary', onclick: () => resolveReport(x, () => load(r.page)) }, t('처리', 'Resolve')) : '',
            ]),
          ),
        ),
        pager(r, load),
      );
    };
    status.onchange = kind.onchange = reason.onchange = () => load().catch(toastError);
    out.replaceChildren(h('div', { class: 'ad-toolbar' }, status, kind, reason), h('p', { class: 'muted small' }, t('대기 중인 신고는 아동 보호·불법 촬영물, 공유 링크 순으로 먼저 보여 줍니다.', 'Open reports are listed with child safety and illegal filming first, then share links.')), list);
    await load();
  } else if (tab === 'messages') {
    const load = async (page = 1) => {
      const r = await api(`/api/admin/messages?page=${page}`);
      out.replaceChildren(
        table(
          ['종류', '보낸 사람', '내용', '접수', '상태', ''],
          r.items.map((m) =>
            tr([
              m.category,
              h('div', {}, m.name, h('div', { class: 'muted small' }, m.email)),
              h('div', { class: 'ad-detail' }, m.message),
              formatDate(m.createdAt),
              m.status === 'open' ? h('span', { class: 'badge accent' }, '대기') : h('span', { class: 'badge brand', title: m.answer }, '답변 완료'),
              h('button', { class: 'btn sm', onclick: () => reply(m, () => load(r.page)) }, m.status === 'open' ? t('답변', 'Reply') : t('다시 답변', 'Reply again')),
            ]),
          ),
        ),
        pager(r, load),
      );
    };
    await load();
  } else if (tab === 'appeals') {
    const load = async () => {
      const r = await optional('/api/admin/offline/appeals');
      if (!r) return out.replaceChildren(soon('클라우드 다운로드 이의제기'));
      const items = listOf(r);
      const act = (x, action) =>
        api(`/api/admin/offline/appeals/${encodeURIComponent(x.id)}/resolve`, { method: 'POST', body: { action } })
          .then(() => (toast('처리했습니다', 'ok'), load()))
          .catch(toastError);
      out.replaceChildren(
        items.length
          ? table(
              ['회원', '링크', '차단 항목', '이의 내용', '접수', '상태', ''],
              items.map((x) =>
                tr([
                  x.user || x.userId || '',
                  h('div', { class: 'ad-mono ad-trunc', title: x.source || '' }, x.source || ''),
                  x.block ? h('div', {}, h('span', { class: 'badge' }, x.block.kind), h('div', { class: 'ad-mono ad-trunc', title: x.block.value }, x.block.value)) : '—',
                  h('div', { class: 'ad-detail' }, x.reason || ''),
                  formatDate(x.createdAt),
                  h('span', { class: `badge ${x.status === 'open' ? 'accent' : x.status === 'accepted' ? 'brand' : ''}` }, { open: '대기', accepted: '인용', rejected: '기각' }[x.status] || x.status),
                  x.status === 'open' ? h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: () => act(x, 'unblock') }, '차단 해제'), h('button', { class: 'btn sm', onclick: () => act(x, 'reject') }, '기각')) : '',
                ]),
              ),
            )
          : h('div', { class: 'ad-soon' }, '이의제기가 없습니다'),
      );
    };
    await load();
  } else {
    const r = await optional('/api/admin/auth/feedback');
    const items = listOf(r);
    out.replaceChildren(!r ? soon('피드백') : items.length ? table(['보낸 사람', '종류', '내용', '연락처', '시각'], items.map((x) => tr([x.email || x.phone || x.name || '비회원', x.category || '', h('div', { class: 'ad-detail' }, x.message || ''), x.contact || '', formatDate(x.createdAt)]))) : h('div', { class: 'ad-soon' }, '피드백이 없습니다'));
  }
}
function resolveReport(x, reload) {
  const action = select(ACTIONS, x.kind === 'appeal' ? 'unblock' : x.targetType === 'user' ? 'suspend' : 'block');
  const hours = select([['24', '24시간'], ['72', '3일'], ['168', '7일'], ['720', '30일'], ['87600', '사실상 영구(10년)']], '168');
  const hoursField = field('정지 기간', hours);
  const note = h('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: '처리 메모(신고자에게도 전달)' });
  const sync = () => hoursField.classList.toggle('hidden', action.value !== 'suspend');
  action.onchange = sync;
  sync();
  modal({
    title: `${KIND[x.kind]?.[0] || '신고'} 처리`,
    body: h(
      'div',
      {},
      h(
        'dl',
        { class: 'ad-kv', style: { marginBottom: '14px' } },
        h('dt', {}, '대상'),
        h('dd', { class: 'ad-mono' }, x.target),
        h('dt', {}, '사유'),
        h('dd', {}, reasonLabel(x.reason)),
        h('dt', {}, '내용'),
        h('dd', {}, x.detail || '—'),
        h('dt', {}, '소유자 이력'),
        h('dd', {}, ...(x.owners?.length ? x.owners.map(ownerLine) : ['미믹 안의 소유자 없음'])),
      ),
      field('처리', action),
      hoursField,
      field('메모', note),
      h('p', { class: 'muted small' }, '차단: URL·마그넷(infohash)·파일 해시를 차단 목록에 넣고, 금고 공유는 취소하며, 소유자에게 사유와 이의제기 경로를 알립니다. 정지: 파일·사용자 신고의 소유자를 정지합니다. 확정 조치가 3회 이상인 소유자는 저작권 정책상 해지 검토 대상입니다.'),
    ),
    actions: [
      { label: '취소' },
      {
        label: '처리',
        kind: 'primary',
        onClick: async () => {
          const r = await api(`/api/admin/reports/${encodeURIComponent(x.id)}/resolve`, { method: 'POST', body: { action: action.value, note: note.value, suspendHours: action.value === 'suspend' ? Number(hours.value) : undefined } });
          toast(r.blocked ? `차단 ${r.blocked.length}건 추가${r.revoked?.length ? ` · 금고 공유 ${r.revoked.length}건 취소` : ''}` : '처리했습니다', 'ok');
          reload();
        },
      },
    ],
  });
}
function reply(m, reload) {
  const text = h('textarea', { class: 'input', rows: 6, maxlength: 5000 }, m.answer || '');
  modal({
    title: `${m.name} 님께 답변`,
    wide: true,
    body: h('div', {}, h('div', { class: 'card', style: { marginBottom: '12px' } }, h('div', { class: 'ad-detail' }, m.message)), field(`받는 사람: ${m.email}`, text)),
    actions: [
      { label: '취소' },
      {
        label: '이메일로 보내기',
        kind: 'primary',
        onClick: async () => {
          await api(`/api/admin/messages/${encodeURIComponent(m.id)}/reply`, { method: 'POST', body: { body: text.value } });
          toast('답변을 보냈습니다', 'ok');
          reload();
        },
      },
    ],
  });
}

// ---------- 차단 목록 ----------
const BLOCK_KINDS = [['url', 'URL·마그넷'], ['domain', '도메인'], ['infohash', '토렌트 infohash'], ['blob', '파일 해시(SHA-256)']];
async function blocklist(root, ctx) {
  const f = { kind: select(BLOCK_KINDS, 'url'), value: input({ class: 'input grow', placeholder: 'https://… / magnet:?… / example.com / 해시' }), reason: input({ placeholder: '사유' }) };
  const filterKind = select([['', '모든 종류'], ...BLOCK_KINDS], ctx.query.kind || '');
  const q = input({ type: 'search', placeholder: '값·사유 검색' });
  const list = h('div');
  const load = async (page = 1) => {
    const r = await api(`/api/admin/blocklist?kind=${filterKind.value}&q=${encodeURIComponent(q.value.trim())}&page=${page}`);
    list.replaceChildren(
      table(
        ['종류', '값', '사유', '등록', ''],
        r.items.map((b) =>
          tr([
            h('span', { class: 'badge' }, b.kind),
            h('div', { class: 'ad-mono' }, b.value),
            b.reason || '',
            formatDate(b.createdAt),
            h(
              'div',
              { class: 'row' },
              h(
                'button',
                {
                  class: 'btn sm',
                  onclick: async () => {
                    const reason = await promptDialog('사유 수정', { value: b.reason || '' });
                    if (reason == null) return;
                    api(`/api/admin/blocklist/${b.id}`, { method: 'PATCH', body: { reason } })
                      .then(() => load(r.page))
                      .catch(toastError);
                  },
                },
                t('수정', 'Edit'),
              ),
              h(
                'button',
                {
                  class: 'btn sm danger',
                  onclick: async () => {
                    if (!(await confirmDialog('차단 해제', `${b.value} 를 차단 목록에서 뺄까요?`, { okLabel: '해제', danger: true }))) return;
                    api(`/api/admin/blocklist/${b.id}`, { method: 'DELETE' })
                      .then(() => load(r.page))
                      .catch(toastError);
                  },
                },
                t('해제', 'Remove'),
              ),
            ),
          ]),
        ),
      ),
      pager(r, load),
    );
  };
  const add = h('button', { class: 'btn primary', html: `${icon('plus')}<span>${t('추가', 'Add')}</span>` });
  add.onclick = async () => {
    try {
      const r = await api('/api/admin/blocklist', { method: 'POST', body: { kind: f.kind.value, value: f.value.value, reason: f.reason.value } });
      toast(`${r.kind} 차단을 추가했습니다`, 'ok');
      f.value.value = f.reason.value = '';
      load();
    } catch (e) {
      toastError(e);
    }
  };
  filterKind.onchange = () => load().catch(toastError);
  q.addEventListener('keydown', (e) => e.key === 'Enter' && load().catch(toastError));
  root.replaceChildren(
    head(t('차단 목록', 'Blocklist')),
    h('p', { class: 'muted' }, t('여기에 있는 URL·도메인·infohash·파일 해시는 클라우드 다운로드와 공유에서 저장이 거부됩니다. 마그넷 링크는 infohash 로 바꿔 저장합니다.', 'URLs, domains, infohashes and file hashes listed here are refused by cloud download and sharing. Magnet links are stored as infohashes.')),
    h('div', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'ad-toolbar', style: { margin: 0 } }, f.kind, f.value, f.reason, add)),
    h('div', { class: 'ad-toolbar' }, filterKind, q),
    list,
  );
  await load();
}

// ---------- 쿼터 정책 + 지역 규칙 ----------
async function quotas(root) {
  const p = await api('/api/admin/quotas');
  const b = (v) => (v == null ? '무제한' : formatBytes(v));
  const L = p.limits;
  const rows = [
    ['저장공간', b(L.free.storage), b(L.premium.storage)],
    ['클라우드 다운로드 / 일', L.free.cloudPerDay ?? '무제한', L.premium.cloudPerDay ?? '무제한'],
    ['동시 작업', L.free.concurrentTasks, L.premium.concurrentTasks],
    ['다운스트림 / 일', b(L.free.dailyDown), b(L.premium.dailyDown)],
    ['재생 화질', L.free.playback, L.premium.playback],
    ['압축 해제·WebDAV·금고', [L.free.unzip, L.free.webdav, L.free.vault].map((x) => (x ? 'O' : 'X')).join(' / '), [L.premium.unzip, L.premium.webdav, L.premium.vault].map((x) => (x ? 'O' : 'X')).join(' / ')],
    ['연결당 속도', `${b(p.speedBps.free)}/s`, `글로벌 ${b(p.speedBps.global)}/s · 지역 ${b(p.speedBps.regional)}/s`],
  ];
  const regions = h('div');
  root.replaceChildren(
    head(t('쿼터 정책', 'Quota policy')),
    h('p', { class: 'muted' }, t('값은 server/core/plans.js(billing 모듈)에서 정하며 여기서는 읽기만 합니다. 회원별 추가 쿼터는 회원 상세에서 지급하세요.', 'Values are set in server/core/plans.js (billing module) and are read-only here. Grant extra quota per member from the member detail.')),
    h('div', { class: 'ad-stats' }, stat(b(p.monthly.cloud), '월 클라우드 다운로드'), stat(b(p.monthly.down), '월 다운스트림'), stat(b(p.monthly.up), '월 업로드'), stat(`${Math.round(p.appShare * 100)}%`, '연결 앱 상한'), stat(b(p.freeAppDailyDown), '무료 연결 앱 다운로드 / 일'), stat(`${b(p.slowBps)}/s`, '한도 초과 감속'), stat(n(p.premiumUsers), '현재 프리미엄 회원')),
    h('div', { class: 'ad-cols' }, h('div', {}, h('h3', {}, '무료 vs 프리미엄'), table(['항목', '무료', '프리미엄'], rows.map((r) => tr(r)))), h('div', {}, h('h3', {}, '기타 정책'), table(['항목', '값'], [['휴지통 보관', `${p.trashDays}일`], ['가입 보너스', `클라우드 다운로드 ${p.signupBonusCloud}회`], ['금고 용량', b(p.vaultStorage)], ['공유 만료(일)', p.shareExpiryDays.map((d) => d || '영구').join(' · ')], ['BT 작업당 파일', n(p.btMaxFiles)], ['초대 보상', `${Math.round(p.referral.shareRate * 100)}% · ${p.referral.windowDays}일 · ${p.referral.uploadBonusEvery}명마다 ${b(p.referral.uploadBonus)}`], ['만료 후 재생 중지', `${p.expiry.playbackStopDays}일`], ['휴면 정리', `무료 ${p.dormant.freeInactiveMonths}개월 + 유예 ${p.dormant.graceDays}일`], ['탈퇴 유예', `${p.accountDeleteGraceDays}일`]].map((r) => tr(r))))),
    h('h3', { style: { marginTop: '20px' } }, t('상품', 'Products')),
    table(['ID', '이름', '종류', '기간', '글로벌', '지역'], p.products.map((x) => tr([h('span', { class: 'ad-mono' }, x.id), x.label, x.kind, `${x.months}개월`, formatWon(x.price.global), formatWon(x.price.regional)]))),
    h('h3', { style: { marginTop: '20px' } }, t('지역 규칙(K-04)', 'Region rules (K-04)')),
    regions,
  );
  const loadRegions = async () => {
    const r = await optional('/api/admin/auth/region-rules');
    if (!r) return regions.replaceChildren(soon('지역 규칙'));
    const items = listOf(r);
    const f = { code: input({ placeholder: '국가번호 (예: +86)', maxlength: 5, style: { maxWidth: '160px' } }), signup: h('input', { type: 'checkbox', checked: true }), download: h('input', { type: 'checkbox' }), note: input({ placeholder: '메모' }) };
    const add = h('button', { class: 'btn primary' }, '규칙 저장');
    add.onclick = () =>
      api('/api/admin/auth/region-rules', { method: 'POST', body: { countryCode: f.code.value.trim(), blockSignup: f.signup.checked, blockDownload: f.download.checked, note: f.note.value } })
        .then(() => (toast('저장했습니다', 'ok'), loadRegions()))
        .catch(toastError);
    const del = (x) =>
      h('button', { class: 'btn sm danger', onclick: () => api(`/api/admin/auth/region-rules/${encodeURIComponent(x.countryCode)}`, { method: 'DELETE' }).then(loadRegions).catch(toastError) }, '삭제');
    regions.replaceChildren(
      h('div', { class: 'ad-toolbar' }, f.code, h('label', { class: 'check' }, f.signup, '가입 차단'), h('label', { class: 'check' }, f.download, '클라우드 다운로드 차단'), f.note, add),
      table(['국가번호', '가입', '클라우드 다운로드', '메모', '등록', ''], items.map((x) => tr([h('b', {}, x.countryCode), x.blockSignup ? '차단' : '허용', x.blockDownload ? '차단' : '허용', x.note || '', formatDate(x.createdAt), del(x)]))),
    );
  };
  await loadRegions();
}

// ---------- 감사 로그 ----------
async function logs(root, ctx) {
  const action = input({ placeholder: '동작 (예: admin.user)', value: ctx.query.action || '' });
  const userId = input({ placeholder: '수행자 회원 ID', value: ctx.query.userId || '' });
  const list = h('div');
  const load = async (page = 1) => {
    const r = await api(`/api/admin/logs?action=${encodeURIComponent(action.value.trim())}&userId=${encodeURIComponent(userId.value.trim())}&page=${page}`);
    list.replaceChildren(table(['시각', '수행자', '동작', '내용', 'IP'], r.items.map((x) => tr([formatDate(x.createdAt), x.userEmail || x.userId || '시스템', h('span', { class: 'badge' }, x.action), h('div', { class: 'ad-mono ad-trunc', title: short(x.detail, 2000) }, short(x.detail, 120)), x.ip || '']))), pager(r, load));
  };
  for (const el of [action, userId]) el.addEventListener('keydown', (e) => e.key === 'Enter' && load().catch(toastError));
  root.replaceChildren(head(t('감사 로그', 'Audit log')), h('div', { class: 'ad-toolbar' }, action, userId, h('button', { class: 'btn primary', onclick: () => load().catch(toastError) }, t('검색', 'Search'))), list);
  await load();
}

const SECTIONS = { dashboard, users, orders, coupons, reports, blocklist, quotas, logs };

export async function render(root, ctx) {
  loadCss('/css/admin.css');
  const fn = SECTIONS[ctx.params.section];
  document.title = t('미믹 관리자', 'Mimic admin');
  if (!fn) return root.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, t('없는 관리자 메뉴입니다', 'No such admin page')), h('a', { href: '/admin/dashboard' }, t('대시보드로', 'Go to dashboard'))));
  root.replaceChildren(h('div', { class: 'page-loading' }, h('div', { class: 'spinner' })));
  await fn(root, ctx);
  return () => document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
}
