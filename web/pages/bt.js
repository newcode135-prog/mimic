// 클라우드 BT 소개(K-02): 개념·장점·사용 방법·저작권 준수 안내
import { api, h, icon, t } from '/ui.js';
import { setup } from '/pages/help.js';

const PROS = [
  ['clock', '기다리지 않아요', 'No waiting', '받는 동안 기기를 켜 둘 필요가 없어요. 노트북을 닫아도 서버는 계속 받아요.', 'No need to keep your device on — the server keeps going.'],
  ['cloudDown', '이미 있으면 즉시', 'Instant when cached', '서버에 같은 토렌트(infohash)가 있으면 다시 받지 않고 몇 초 만에 내 폴더에 연결해요.', 'If we already have the same torrent, it lands in seconds.'],
  ['shield', '내 기기를 드러내지 않아요', 'Your device stays out', '피어와 연결하는 건 미믹 서버예요. 내 기기는 미믹과 암호화된 연결만 맺어요.', 'Mimic talks to peers; your device only talks to Mimic over an encrypted link.'],
  ['play', '받자마자 재생', 'Play right away', '토렌트 속 영상도 내려받지 않고 바로 스트리밍해요.', 'Stream videos inside a torrent without downloading.'],
];

export async function render(root, ctx) {
  if (setup(ctx)) return;
  document.title = t('클라우드 BT — 미믹', 'Cloud BT — Mimic');
  const n = await api('/api/content/numbers'); // 작업당 최대 파일 수 등 plans.js 값
  root.replaceChildren(
    h(
      'section',
      { class: 'mc-hero' },
      h(
        'div',
        { class: 'inner', style: { gridTemplateColumns: '1fr' } },
        h(
          'div',
          { style: { textAlign: 'center', maxWidth: '760px', margin: '0 auto' } },
          h('span', { class: 'mc-eyebrow' }, 'Cloud BT'),
          h('h1', {}, t('토렌트를 내 컴퓨터 대신', 'Torrents, fetched by the cloud'), h('br'), h('em', {}, t('클라우드가 받아요', 'not your computer'))),
          h('p', { class: 'mc-lead', style: { margin: '0 auto' } }, t('마그넷 링크나 .torrent 파일을 미믹에 넘기면, 미믹 서버가 피어와 연결해 파일을 받고 내 드라이브에만 저장해요.', 'Give Mimic a magnet link or .torrent file. Our server connects to peers and saves the files only to your drive.')),
          h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '24px' } }, h('a', { class: 'btn primary lg', href: ctx.me ? '/drive/all' : '/signup' }, t('지금 써 보기', 'Try it now')), h('a', { class: 'btn lg', href: '/help/add-links' }, t('사용 방법', 'How to use'))),
        ),
      ),
    ),
    h(
      'section',
      { class: 'mc-section' },
      h(
        'div',
        { class: 'inner' },
        h('div', { class: 'mc-head' }, h('h2', {}, t('클라우드 BT가 다른 점', 'What makes Cloud BT different'))),
        h('div', { class: 'mc-grid' }, ...PROS.map(([ic, ko, en, dko, den]) => h('div', { class: 'mc-tile' }, h('div', { class: 'ic', html: icon(ic) }), h('h3', {}, t(ko, en)), h('p', {}, t(dko, den))))),
      ),
    ),
    h(
      'section',
      { class: 'mc-section alt' },
      h(
        'div',
        { class: 'inner' },
        h('div', { class: 'mc-head' }, h('h2', {}, t('이렇게 써요', 'How to use'))),
        h(
          'div',
          { class: 'mc-steps' },
          h('div', { class: 'mc-step' }, h('h3', {}, t('링크나 파일 넣기', 'Add a link or file')), h('p', {}, t('드라이브의 "클라우드 다운로드"에서 마그넷 링크를 붙이거나 .torrent 파일을 골라요.', 'In your drive, open Cloud download and paste a magnet or pick a .torrent.'))),
          h('div', { class: 'mc-step' }, h('h3', {}, t('저장 폴더 고르기', 'Choose a folder')), h('p', {}, t(`받은 파일이 들어갈 폴더를 정해요. 한 작업에 최대 ${n.btMax}개 파일까지 들어가요.`, `Pick where files go. Up to ${n.btMax} files per task.`))),
          h('div', { class: 'mc-step' }, h('h3', {}, t('완료 알림 받기', 'Get notified')), h('p', {}, t('전송 패널에서 진행 상황을 보고, 끝나면 알림을 받아 바로 재생해요.', 'Watch progress in the transfer panel and play as soon as it is done.'))),
        ),
        h(
          'div',
          { class: 'mc-note brand', style: { marginTop: '24px' }, html: icon('info') },
          h('div', {}, t('BT 스마트 필터가 홍보용 txt·url 파일이나 짧은 광고 영상처럼 보이는 부속 파일을 자동으로 걸러요. 설정 > 전송에서 끌 수 있어요.', 'The BT smart filter skips promo txt/url files and short ad clips. Turn it off in Settings > Transfer.')),
        ),
      ),
    ),
    h(
      'section',
      { class: 'mc-section' },
      h(
        'div',
        { class: 'inner' },
        h(
          'div',
          { class: 'mc-legal', html: icon('flag') },
          h(
            'div',
            {},
            h('h3', {}, t('저작권을 꼭 지켜 주세요', 'Please respect copyright')),
            h('p', { class: 'muted' }, t('토렌트는 기술일 뿐, 그 안의 콘텐츠에는 권리자가 있어요. 내가 권리를 가졌거나 공개 라이선스로 배포된 파일(오픈소스 배포판, 퍼블릭 도메인 영상 등)만 받아 주세요.', 'BitTorrent is just a technology; the content has owners. Only fetch files you own or that are openly licensed (open-source distros, public-domain films, etc.).')),
            h('p', { class: 'muted' }, t('권리자 신고가 들어온 링크·infohash·파일은 차단되고, 반복해서 침해하는 계정은 이용이 제한돼요.', 'Reported links, infohashes and files are blocked; repeat infringers are restricted.')),
            h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('a', { href: '/copyright' }, t('저작권 신고하기', 'File a copyright notice')), '·', h('a', { href: '/policy/copyright' }, t('저작권 정책', 'Copyright policy'))),
          ),
        ),
      ),
    ),
  );
}
