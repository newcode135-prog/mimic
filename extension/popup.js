import { getConf, call, saveLinks } from './api.js';

const main = document.getElementById('main');
const KIND = { magnet: '마그넷', torrent: '토렌트', media: '미디어', file: '파일', page: '페이지' };
const el = (tag, attrs = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), attrs);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const msg = (box, text, error = false) => box.replaceChildren(el('p', { className: `msg${error ? ' error' : ''}`, textContent: text }));

async function connectView() {
  const { pendingCode } = await chrome.storage.session.get('pendingCode');
  const out = el('div');
  const btn = el('button', { className: 'primary', textContent: '미믹 계정 연결' });
  btn.onclick = () => {
    btn.disabled = true;
    msg(out, '새로 열린 탭에서 승인해 주세요. 승인한 뒤 이 창을 다시 열면 됩니다.');
    chrome.runtime.sendMessage({ type: 'connect' }).then((r) => (r?.ok ? render() : msg(out, r?.message || '연결하지 못했습니다', true)));
  };
  main.replaceChildren(
    el(
      'section',
      {},
      el('h3', { textContent: '계정 연결' }),
      el('p', { className: 'muted', textContent: '비밀번호는 확장에 입력하지 않습니다. 미믹 웹에서 승인하면 이 브라우저가 연결됩니다.' }),
      pendingCode ? el('div', {}, el('p', { className: 'muted', textContent: '승인을 기다리는 코드' }), el('div', { className: 'code', textContent: pendingCode })) : null,
      btn,
      out,
    ),
  );
}

function checkinSection() {
  const box = el('section', {}, el('h3', { textContent: '매일 출석 체크' }));
  const body = el('div', { className: 'muted', textContent: '불러오는 중…' });
  box.append(body);
  const draw = (s) => {
    const note = el('div');
    const btn = el('button', { className: 'primary', textContent: s.checkedToday ? '오늘 출석 완료' : '출석 체크', disabled: !!s.checkedToday });
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await call('/api/billing/checkin', { method: 'POST' });
        draw(r);
        if (r.rewarded) msg(box.querySelector('.note'), `연속 출석 보상으로 프리미엄 ${r.rewarded}일을 받았어요!`);
      } catch (e) {
        msg(note, e.message, true);
        btn.disabled = false;
      }
    };
    note.className = 'note';
    body.className = '';
    body.replaceChildren(
      el('div', { className: 'row' }, el('span', { className: 'streak', textContent: `${s.streak || 0}일` }), el('span', { className: 'muted', textContent: '연속 출석' }), el('span', { className: 'spacer' }), btn),
      s.nextRewardIn ? el('p', { className: 'muted', textContent: `${s.nextRewardIn}일 더 출석하면 프리미엄 ${s.rewardDays || ''}일` }) : null,
      note,
    );
  };
  call('/api/billing/checkin').then(draw, (e) => msg(body, e.status === 404 ? '출석 체크를 아직 쓸 수 없습니다' : e.message, true));
  return box;
}

async function linksSection() {
  const box = el('section', {}, el('h3', { textContent: '이 페이지에서 찾은 링크' }));
  const list = el('ul');
  const out = el('div');
  box.append(list, out);
  let items = [];
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    items = res?.result || [];
  } catch {
    msg(out, '이 페이지는 읽을 수 없습니다(브라우저 설정·확장 스토어 페이지 등).', true);
    return box;
  }
  if (!items.some((i) => i.kind !== 'page')) list.append(el('li', { className: 'muted', textContent: '저장할 만한 링크를 찾지 못했습니다. 현재 페이지 주소는 저장할 수 있어요.' }));
  const checks = items.map((it) => {
    const cb = el('input', { type: 'checkbox', checked: it.kind !== 'page' });
    list.append(
      el(
        'li',
        {},
        el('label', {}, cb, el('span', { className: 'kind', textContent: KIND[it.kind] || it.kind }), el('span', { className: 'url', textContent: it.url }, it.label ? el('span', { className: 'label', textContent: it.label }) : null)),
      ),
    );
    return [cb, it.url];
  });
  const save = el('button', { className: 'primary', textContent: '선택한 링크 저장' });
  save.onclick = async () => {
    const urls = checks.filter(([cb]) => cb.checked).map(([, u]) => u);
    if (!urls.length) return msg(out, '저장할 링크를 골라 주세요', true);
    save.disabled = true;
    try {
      await saveLinks(urls);
      msg(out, `${urls.length}개를 클라우드 다운로드 작업으로 보냈습니다. 진행 상황은 미믹 웹의 전송 목록에서 볼 수 있어요.`);
    } catch (e) {
      msg(out, e.message, true);
    } finally {
      save.disabled = false;
    }
  };
  box.insertBefore(el('div', { className: 'row' }, el('span', { className: 'muted', textContent: `${items.length}개` }), el('span', { className: 'spacer' }), save), out);
  return box;
}

async function render() {
  const { token, account } = await getConf();
  document.getElementById('who').textContent = token ? account || '연결됨' : '';
  if (!token) return connectView();
  main.replaceChildren(checkinSection(), await linksSection());
}

render();
