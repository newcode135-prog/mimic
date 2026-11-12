// 우클릭 메뉴 "미믹 클라우드에 저장"과 계정 연결(팝업이 닫혀도 계속 기다림)
import { saveLinks, connectAccount } from './api.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'mimic-save', title: '미믹 클라우드에 저장', contexts: ['link', 'video', 'audio', 'image'] });
});

function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'mimic-save') return;
  const url = info.linkUrl || info.srcUrl;
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return badge('!', '#d64545');
  try {
    await saveLinks([url]);
    badge('OK', '#0f9d8f');
  } catch (e) {
    console.warn('미믹 저장 실패', e);
    badge(e.status === 401 ? '로그인' : '!', '#d64545');
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'connect') {
    connectAccount().then((user) => reply({ ok: true, user }), (e) => reply({ ok: false, message: e.message }));
    return true;
  }
  return false;
});
