// 비공개 미리보기 접속 비밀번호(MIMIC_SITE_PASSWORD): 비밀번호 없이는 화면·API 모두 401
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const basic = (pw) => 'Basic ' + Buffer.from(`guest:${pw}`).toString('base64');

test('접속 비밀번호를 설정하면 맞는 비밀번호로만 들어온다', async () => {
  const s = await startServer({ sitePassword: '미믹-데모-2026' });
  try {
    for (const p of ['/', '/api/config', '/drive/all']) {
      const r = await fetch(s.url + p);
      assert.equal(r.status, 401, p);
      assert.match(r.headers.get('www-authenticate') || '', /^Basic /);
    }
    assert.equal((await fetch(s.url + '/api/config', { headers: { authorization: basic('틀림') } })).status, 401);
    const ok = await fetch(s.url + '/api/config', { headers: { authorization: basic('미믹-데모-2026') } });
    assert.equal(ok.status, 200);
  } finally {
    await s.close();
  }
});

test('설정하지 않으면 지금처럼 바로 열린다', async () => {
  const s = await startServer();
  try {
    assert.equal((await fetch(s.url + '/api/config')).status, 200);
  } finally {
    await s.close();
  }
});
