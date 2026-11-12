// 확장 공통: 서버 주소·토큰 보관과 API 호출
export const DEFAULT_SERVER = 'http://localhost:4300';

export async function getConf() {
  const c = await chrome.storage.local.get(['server', 'token', 'account']);
  return { server: (c.server || DEFAULT_SERVER).replace(/\/+$/, ''), token: c.token || null, account: c.account || null };
}

export async function call(path, { method = 'GET', body, auth = true } = {}) {
  const { server, token } = await getConf();
  const headers = {};
  if (auth && token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(server + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : {};
  if (!r.ok) {
    if (r.status === 401 && auth) await chrome.storage.local.remove(['token', 'account']);
    throw Object.assign(new Error(data.message || `요청 실패 (HTTP ${r.status})`), { status: r.status, code: data.error });
  }
  return data;
}

// 클라우드 다운로드 작업 만들기(offline 모듈). 저장 폴더는 최상위
export const saveLinks = (urls) => call('/api/offline/tasks', { method: 'POST', body: { urls, parentId: null } });

// 기기 인가로 계정 연결: 브라우저 탭에서 승인하면 토큰을 받아 저장한다
export async function connectAccount() {
  const d = await call('/api/auth/device/code', { method: 'POST', auth: false, body: { clientName: '미믹 브라우저 확장', appId: 'extension', scopes: ['files:write', 'services'] } });
  await chrome.storage.session.set({ pendingCode: d.userCode });
  await chrome.tabs.create({ url: d.verificationUri });
  const until = Date.now() + (d.expiresIn || 600) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, (d.interval || 5) * 1000));
    await chrome.storage.session.set({ pendingCode: d.userCode }); // 확장 API 호출이 서비스 워커를 깨어 있게 한다
    try {
      const r = await call('/api/auth/device/token', { method: 'POST', auth: false, body: { deviceCode: d.deviceCode } });
      await chrome.storage.local.set({ token: r.token, account: r.user?.name || r.user?.email || r.user?.phone || '' });
      await chrome.storage.session.remove('pendingCode');
      return r.user;
    } catch (e) {
      if (e.code !== 'authorization_pending') {
        await chrome.storage.session.remove('pendingCode');
        throw e;
      }
    }
  }
  await chrome.storage.session.remove('pendingCode');
  throw new Error('승인 시간이 지났습니다. 다시 연결해 주세요');
}
