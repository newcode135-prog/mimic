// 테스트 도우미: 임시 데이터 폴더로 서버를 띄우고, 사용자·세션을 DB 에 바로 만든다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/index.js';
import { createSession, hashPassword } from '../server/core/auth.js';
import { newId, now, DAY } from '../server/core/util.js';

export async function startServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-test-'));
  // 운영 모드(dev:false) 테스트도 띄울 수 있게 기본값이 아닌 32자 이상 비밀값을 준다(B-04 시작 거부 규칙)
  const inst = await createApp({ dataDir, dev: true, quiet: true, runJobs: false, secret: 'test-secret-0123456789abcdef0123456789', ...overrides });
  const server = inst.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  inst.ctx.server = server;
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    ...inst,
    url,
    dataDir,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await inst.close();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

export function createUser(db, { email = `${newId('u')}@test.local`, phone = null, password = null, name = '테스트', premium = false, admin = false, tier = 'global' } = {}) {
  const id = newId('u_');
  db.prepare(
    'INSERT INTO users (id, email, phone, password_hash, name, tier, premium_until, is_admin, invite_code, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(id, email, phone, password ? hashPassword(password) : null, name, tier, premium ? now() + 30 * DAY : null, admin ? 1 : 0, newId('').slice(0, 8), now());
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

export const sessionFor = (db, userId) => createSession(db, userId, null, 'test');

// fetch 래퍼: client(url, token).get('/api/me') → { status, body, headers }
export function client(base, token = null) {
  const call = async (method, p, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData) && !(body instanceof Uint8Array) && typeof body !== 'string') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body: data, headers: res.headers };
  };
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    put: (p, b, h) => call('PUT', p, b, h),
    patch: (p, b, h) => call('PATCH', p, b, h),
    del: (p, b, h) => call('DELETE', p, b, h),
  };
}
