import { getConf, DEFAULT_SERVER } from './api.js';

const $ = (id) => document.getElementById(id);

async function load() {
  const c = await getConf();
  $('server').value = c.server;
  $('account').textContent = c.token ? c.account || '연결됨' : '연결된 계정이 없습니다';
  $('logout').disabled = !c.token;
}

$('save').onclick = async () => {
  let origin;
  try {
    origin = new URL($('server').value.trim() || DEFAULT_SERVER).origin;
  } catch {
    $('msg').textContent = '주소 형식이 올바르지 않습니다';
    return;
  }
  // localhost 가 아닌 서버는 접속 권한을 받아야 요청할 수 있다
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
    $('msg').textContent = '접속 권한을 허용해야 이 서버를 쓸 수 있습니다';
    return;
  }
  const prev = await getConf();
  await chrome.storage.local.set({ server: origin });
  if (prev.server !== origin) await chrome.storage.local.remove(['token', 'account']);
  $('msg').textContent = '저장했습니다';
  load();
};

$('logout').onclick = async () => {
  await chrome.storage.local.remove(['token', 'account']);
  load();
};

load();
