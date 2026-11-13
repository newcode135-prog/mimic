// 비공개 미리보기 접속 키(MIMIC_SITE_PASSWORD)와 체험 모드(MIMIC_DEMO) 인증코드 표시
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { assertPublicUrl } from '../server/modules/offline/engine.js';
import { pushEndpointOk } from '../server/core/notify.js';

const KEY = 'demo-key-0123456789';
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

test('접속 키: 링크(?key=)로 한 번에 들어오고, 키 없으면 입력 화면·API 는 401', async () => {
  const s = await startServer({ sitePassword: KEY });
  try {
    const home = await fetch(s.url + '/');
    assert.equal(home.status, 401);
    assert.match(await home.text(), /<form method="post" action="\/__site-login">/);
    assert.equal((await fetch(s.url + '/api/config')).status, 401);
    assert.equal((await fetch(s.url + '/?key=wrong', { redirect: 'manual' })).status, 401);

    const go = await fetch(s.url + '/drive/all?key=' + KEY + '&x=1', { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), '/drive/all?x=1'); // 키는 주소에서 지운다
    const cookie = cookieOf(go);
    assert.match(cookie, /^mimic_site=/);
    const conf = await fetch(s.url + '/api/config', { headers: { cookie } });
    assert.equal(conf.status, 200);
    assert.equal((await conf.json()).siteKey, KEY); // 키를 아는 사람에게만: 공유 링크에 붙여 받는 사람이 바로 열게
    assert.equal((await fetch(s.url + '/api/config', { headers: { cookie: 'mimic_site=forged' } })).status, 401);
    // 공유 링크(?key= 붙은 /s/<토큰>)는 키를 지우고 공유 화면으로 바로 보낸다
    const sh = await fetch(s.url + '/s/abc123?key=' + KEY, { redirect: 'manual' });
    assert.equal(sh.status, 302);
    assert.equal(sh.headers.get('location'), '/s/abc123');
    // 주소가 // 로 시작해도 다른 사이트(//evil.example)로 보내지 않는다
    for (const evil of ['//x//evil.example', '/.//evil.example/', '/x/..//evil.example']) {
      const r = await fetch(s.url + evil + '?key=' + KEY, { redirect: 'manual' });
      assert.equal(r.status, 302);
      assert.doesNotMatch(r.headers.get('location'), /^\/[/\\]/, evil);
    }
  } finally {
    await s.close();
  }
});

test('접속 키 입력 화면: 맞으면 원래 화면으로, 다른 사이트로는 보내지 않는다', async () => {
  const s = await startServer({ sitePassword: KEY });
  try {
    const post = (body) => fetch(s.url + '/__site-login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const bad = await post({ key: 'nope', next: '/drive/all' });
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /Wrong key/);
    const ok = await post({ key: KEY, next: '/drive/all' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/drive/all');
    for (const evil of ['//evil.example', '/\\evil.example', 'https://evil.example']) assert.equal((await post({ key: KEY, next: evil })).headers.get('location'), '/');
  } finally {
    await s.close();
  }
});

test('접속 키를 설정하지 않으면 지금처럼 바로 열린다', async () => {
  const s = await startServer();
  try {
    const conf = await fetch(s.url + '/api/config');
    assert.equal(conf.status, 200);
    assert.equal((await conf.json()).siteKey, undefined); // 접속 키가 없는 서버는 알려 줄 키도 없다
  } finally {
    await s.close();
  }
});

test('체험 모드: 새 가입 인증코드만 화면으로 돌려주고, 기존 계정 코드는 절대 안 준다', async () => {
  const s = await startServer({ demo: true });
  const post = (p, body) => fetch(s.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  try {
    assert.equal((await fetch(s.url + '/api/config').then((r) => r.json())).demo, true);
    const [st, r] = await post('/api/auth/email/send-code', { email: 'new@example.com', purpose: 'signup' });
    assert.equal(st, 200);
    assert.match(r.demoCode, /^\d{6}$/);
    const [st2] = await post('/api/auth/email/signup', { email: 'new@example.com', code: r.demoCode, password: 'Abc123!x', agreeAge14: true, agreeTerms: true, agreePrivacy: true });
    assert.equal(st2, 200);
    const [, reset] = await post('/api/auth/email/send-code', { email: 'new@example.com', purpose: 'reset' });
    assert.equal(reset.demoCode, undefined);
    const [, phoneNew] = await post('/api/auth/phone/send-code', { phone: '+821012345678' });
    assert.match(phoneNew.demoCode, /^\d{6}$/);
    // 가입 전에 받은(화면에 보인) 코드로, 그사이 다른 사람이 가입한 번호의 계정에 들어갈 수 없다
    const P = '+821055551234';
    const agree = { agreeAge14: true, agreeTerms: true, agreePrivacy: true };
    const [, early] = await post('/api/auth/phone/send-code', { phone: P });
    s.db.prepare('UPDATE auth_codes SET created_at=created_at-61000 WHERE target=?').run(P);
    const [, mine] = await post('/api/auth/phone/send-code', { phone: P });
    const [vst, victim] = await post('/api/auth/phone/verify', { phone: P, code: mine.demoCode, ...agree });
    assert.equal(vst, 200);
    assert.equal(victim.created, true);
    const [ast, attacker] = await post('/api/auth/phone/verify', { phone: P, code: early.demoCode });
    assert.equal(ast, 400, JSON.stringify(attacker));
    assert.equal(attacker.user, undefined);
    // 체험 서버는 개발 모드여도 내부망(이 PC의 다른 서버·공유기)으로 받기·푸시를 보내지 않는다
    await assert.rejects(assertPublicUrl({ dev: true, demo: true }, 'http://127.0.0.1:4300/api/dev/outbox'), /blocked_address/);
    assert.equal(pushEndpointOk({ dev: true, demo: true }, 'http://127.0.0.1:4300/x'), false);
    await assertPublicUrl({ dev: true }, 'http://127.0.0.1:4300/'); // 일반 개발 모드는 그대로 허용
  } finally {
    await s.close();
  }
  const plain = await startServer();
  try {
    const r = await fetch(plain.url + '/api/auth/email/send-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', purpose: 'signup' }) }).then((x) => x.json());
    assert.equal(r.demoCode, undefined);
  } finally {
    await plain.close();
  }
});
