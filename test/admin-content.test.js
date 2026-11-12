import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { createFileNode, createFolder } from '../server/core/files.js';
import { notify } from '../server/core/notify.js';
import { createToken } from '../server/core/auth.js';
import { N } from '../server/modules/content/data/numbers.js';
import { monthlyLimit, cloudTaskAllowance } from '../server/core/quota.js';
import { MONTHLY_QUOTA, GB } from '../server/core/plans.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HASH = 'a'.repeat(64);

test('admin-content: 관리자·신고·알림·콘텐츠', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const admin = createUser(s.db, { admin: true, email: 'admin@test.local' });
  const user = createUser(s.db, { email: 'user@test.local' });
  const A = client(s.url, sessionFor(s.db, admin.id));
  const U = client(s.url, sessionFor(s.db, user.id));
  const anon = client(s.url);
  const outbox = (to) => s.db.prepare('SELECT * FROM outbox WHERE to_addr=? ORDER BY created_at').all(to);
  const blocked = (kind, value) => !!s.db.prepare('SELECT 1 FROM blocklist WHERE kind=? AND value=?').get(kind, value);

  await t.test('[K-06] 관리자 아닌 사용자는 403, 로그인 안 하면 401', async () => {
    for (const p of ['/api/admin/stats', '/api/admin/users', '/api/admin/blocklist', '/api/admin/reports', '/api/admin/logs', '/api/admin/quotas']) {
      assert.equal((await U.get(p)).status, 403, p);
      assert.equal((await anon.get(p)).status, 401, p);
    }
    assert.equal((await U.patch(`/api/admin/users/${user.id}`, { premiumDays: 30 })).status, 403);
  });

  await t.test('[K-06] 관리자 계정의 액세스 토큰(CLI·MCP 등)으로는 관리자 API 를 쓸 수 없다', async () => {
    const victim = createUser(s.db);
    for (const scopes of [['files:read'], ['files:manage'], ['*']]) {
      const T = client(s.url, createToken(s.db, admin.id, { name: 'cli', scopes }).token);
      assert.equal((await T.get('/api/admin/stats')).status, 403, scopes.join());
      assert.equal((await T.patch(`/api/admin/users/${victim.id}`, { premiumDays: 30 })).status, 403);
      assert.equal((await T.del(`/api/admin/users/${victim.id}`)).status, 403);
      assert.equal((await T.post('/api/admin/blocklist', { kind: 'domain', value: 'x.example.com' })).status, 403);
      assert.equal((await T.post('/api/admin/notifications', { all: true, title: '가짜 공지' })).status, 403);
    }
    const v = s.db.prepare('SELECT * FROM users WHERE id=?').get(victim.id);
    assert.ok(v && !v.premium_until);
    assert.ok(!blocked('domain', 'x.example.com'));
  });

  await t.test('[K-06] 통계·회원 검색·상세·쿼터 정책', async () => {
    createFileNode(s.db, user.id, null, { name: 'a.mp4', size: 1000 });
    const st = await A.get('/api/admin/stats');
    assert.equal(st.status, 200);
    assert.ok(st.body.users.total >= 2);
    assert.equal(st.body.users.admins, 1);
    assert.equal(st.body.storage.logicalBytes, 1000);
    const list = await A.get('/api/admin/users?q=user@test');
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].used, 1000);
    const d = await A.get(`/api/admin/users/${user.id}`);
    assert.equal(d.body.files.count, 1);
    assert.ok(d.body.sessions.length >= 1);
    assert.equal(d.body.quota.month.cloud.limit, MONTHLY_QUOTA.cloud);
    const q = await A.get('/api/admin/quotas');
    assert.equal(q.body.monthly.down, MONTHLY_QUOTA.down);
    assert.equal(q.body.limits.premium.cloudPerDay, null); // Infinity → null(무제한)
  });

  await t.test('[K-06] 회원 정지·해제, 프리미엄 지급, 쿼터 지급, 관리자 지정', async () => {
    assert.equal((await A.patch(`/api/admin/users/${user.id}`, { suspendHours: 0 })).status, 400);
    // 일부 값이 틀리면 아무것도 반영하지 않는다(정지만 먼저 적용되지 않게)
    const logsBefore = s.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    assert.equal((await A.patch(`/api/admin/users/${user.id}`, { suspendHours: 24, premiumDays: '30' })).status, 400);
    assert.equal(s.db.prepare('SELECT status FROM users WHERE id=?').get(user.id).status, 'active');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, logsBefore);
    assert.equal((await A.patch(`/api/admin/users/${user.id}`, { suspendHours: 24 })).status, 200);
    assert.equal((await U.get('/api/me')).status, 403);
    // 정지된 회원은 사이트 알림을 못 읽으므로 이메일로도 알리고, 링크는 이의제기 탭
    assert.match(outbox(user.email).at(-1).body, /\/copyright\?tab=appeal/);
    // 이의제기 폼을 '사용자 · 내 연락처'로 미리 채운 링크
    assert.equal(s.db.prepare("SELECT link FROM notifications WHERE user_id=? AND kind='account'").get(user.id).link, '/copyright?tab=appeal&type=user&target=user%40test.local');
    assert.equal((await A.patch(`/api/admin/users/${user.id}`, { unsuspend: true })).status, 200);
    assert.equal((await U.get('/api/me')).status, 200);
    // [H-04] 정지 전 상태로 되돌린다: 미인증 회원은 해제 뒤에도 미인증(72시간 잠금 규칙 유지)
    const unv = createUser(s.db);
    s.db.prepare("UPDATE users SET status='unverified' WHERE id=?").run(unv.id);
    await A.patch(`/api/admin/users/${unv.id}`, { suspendHours: 24 });
    await A.patch(`/api/admin/users/${unv.id}`, { unsuspend: true });
    const back = s.db.prepare('SELECT status, settings FROM users WHERE id=?').get(unv.id);
    assert.equal(back.status, 'unverified');
    assert.ok(!JSON.parse(back.settings).suspendedFrom);

    const p = await A.patch(`/api/admin/users/${user.id}`, { premiumDays: 30 });
    assert.equal(p.body.user.premium, true);
    assert.equal((await U.get('/api/me')).body.premium, true);

    assert.equal((await A.patch(`/api/admin/users/${user.id}`, { grantQuota: { kind: 'bogus', amount: 1 } })).status, 400);
    await A.patch(`/api/admin/users/${user.id}`, { grantQuota: { kind: 'down', amount: 100 * GB, months: 2 } });
    assert.equal(monthlyLimit(s.db, user.id, 'down'), MONTHLY_QUOTA.down + 100 * GB);
    const free = createUser(s.db);
    await A.patch(`/api/admin/users/${free.id}`, { grantQuota: { kind: 'cloud_count', amount: 5 } });
    assert.equal(cloudTaskAllowance(s.db, free).bonusLeft, 5);

    assert.equal((await A.patch(`/api/admin/users/${admin.id}`, { isAdmin: false })).status, 400);
    await A.patch(`/api/admin/users/${free.id}`, { isAdmin: true });
    assert.equal((await client(s.url, sessionFor(s.db, free.id)).get('/api/admin/stats')).status, 200);
    // 지급 사실은 사용자 알림으로 남는다
    assert.ok(s.db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind='premium'").get(user.id));
  });

  await t.test('[K-06] 회원 즉시 삭제', async () => {
    const v = createUser(s.db);
    createFileNode(s.db, v.id, null, { name: 'x.txt', size: 3 });
    assert.equal((await A.del(`/api/admin/users/${admin.id}`)).status, 400);
    assert.equal((await A.del(`/api/admin/users/${v.id}`)).status, 200);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users WHERE id=?').get(v.id).n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id=?').get(v.id).n, 0);
  });

  await t.test('[K-06] 차단 목록 CRUD(마그넷은 infohash 로 저장)', async () => {
    const bad = await A.post('/api/admin/blocklist', { kind: 'blob', value: 'xyz' });
    assert.equal(bad.status, 400);
    const c = await A.post('/api/admin/blocklist', { kind: 'url', value: 'magnet:?xt=urn:btih:' + 'B'.repeat(40) + '&dn=x' });
    assert.equal(c.status, 201);
    assert.equal(c.body.kind, 'infohash');
    assert.equal(c.body.value, 'b'.repeat(40));
    assert.equal((await A.post('/api/admin/blocklist', { kind: 'infohash', value: 'b'.repeat(40) })).status, 409);
    // URL 은 offline 모듈이 비교하는 new URL().href 형태로 저장
    assert.equal((await A.post('/api/admin/blocklist', { kind: 'url', value: 'HTTPS://Cdn.Example.com/A.zip' })).body.value, 'https://cdn.example.com/A.zip');
    const d = await A.post('/api/admin/blocklist', { kind: 'domain', value: 'https://Bad.Example.com/path' });
    assert.equal(d.body.value, 'bad.example.com');
    const list = await A.get('/api/admin/blocklist?kind=domain');
    assert.equal(list.body.items.length, 1);
    const up = await A.patch(`/api/admin/blocklist/${d.body.id}`, { value: 'worse.example.com', reason: '피싱' });
    assert.equal(up.body.value, 'worse.example.com');
    assert.ok(blocked('domain', 'worse.example.com'));
    assert.equal((await A.del(`/api/admin/blocklist/${d.body.id}`)).status, 200);
    assert.ok(!blocked('domain', 'worse.example.com'));
  });

  await t.test('[J-01] 신고 접수(로그인 선택)와 처리: block 이면 차단 목록에 추가, 신고자에게 결과 알림', async () => {
    assert.equal((await anon.post('/api/content/reports', { targetType: 'nope', target: 'x', reason: 'spam' })).status, 400);
    const a = await anon.post('/api/content/reports', { targetType: 'url', target: 'https://bad.example.com/file.zip', reason: 'malware', detail: '악성' });
    assert.equal(a.status, 201);
    const file = createFileNode(s.db, user.id, null, { name: 'leak.mp4', size: 5, blobHash: null });
    s.db.prepare('INSERT INTO blobs (hash, size, created_at) VALUES (?,?,?)').run(HASH, 5, Date.now());
    s.db.prepare('UPDATE files SET blob_hash=? WHERE id=?').run(HASH, file.id);
    const reporter = createUser(s.db);
    const R = client(s.url, sessionFor(s.db, reporter.id));
    const b = await R.post('/api/content/reports', { targetType: 'file', target: file.id, reason: 'illegal_filming' });
    // 파일 신고는 접수 때 소유자에게 잡힌다
    assert.equal((await A.get(`/api/admin/users/${user.id}`)).body.reports, 1);

    const open = await A.get('/api/admin/reports?status=open');
    assert.equal(open.body.total, 2);
    assert.equal((await A.post(`/api/admin/reports/${a.body.id}/resolve`, { action: 'nuke' })).status, 400);
    const ra = await A.post(`/api/admin/reports/${a.body.id}/resolve`, { action: 'block', note: '확인됨' });
    assert.equal(ra.status, 200);
    assert.ok(blocked('url', 'https://bad.example.com/file.zip'));
    assert.equal((await A.post(`/api/admin/reports/${a.body.id}/resolve`, { action: 'dismiss' })).status, 409);

    // 불법 촬영물 신고가 먼저 오고, 소유자의 확정 조치 수가 함께 보인다
    const queue = await A.get('/api/admin/reports?status=open');
    assert.equal(queue.body.items[0].id, b.body.id);
    assert.deepEqual(queue.body.items[0].owners.map((o) => o.id), [user.id]);
    await A.post(`/api/admin/reports/${b.body.id}/resolve`, { action: 'block' });
    assert.ok(blocked('blob', HASH));
    assert.ok(s.db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND kind='report'").get(reporter.id));
    // 소유자에게 차단 사실과 이의제기 경로를 알린다
    assert.match(s.db.prepare("SELECT link FROM notifications WHERE user_id=? AND kind='report'").get(user.id).link, /^\/copyright\?tab=appeal&type=file&target=/);
    assert.equal((await A.get(`/api/admin/users/${user.id}`)).body.reportActions.blocked, 1);
  });

  await t.test('[J-01] 사용자 신고 → 정지, 이의제기 → 차단 해제', async () => {
    const bad = createUser(s.db, { email: 'bad@test.local' });
    const rep = await anon.post('/api/content/reports', { targetType: 'user', target: 'bad@test.local', reason: 'spam' });
    assert.equal((await A.post(`/api/admin/reports/${rep.body.id}/resolve`, { action: 'block' })).status, 400);
    const r = await A.post(`/api/admin/reports/${rep.body.id}/resolve`, { action: 'suspend', suspendHours: 24 });
    assert.deepEqual(r.body.suspended, [bad.id]);
    assert.equal(s.db.prepare('SELECT status FROM users WHERE id=?').get(bad.id).status, 'suspended');

    assert.equal((await anon.post('/api/content/reports', { kind: 'appeal', targetType: 'url', target: 'https://bad.example.com/file.zip' })).status, 400);
    const ap = await U.post('/api/content/reports', { kind: 'appeal', targetType: 'url', target: 'https://bad.example.com/file.zip', detail: '내 자료입니다' });
    assert.equal(ap.status, 201);
    const done = await A.post(`/api/admin/reports/${ap.body.id}/resolve`, { action: 'unblock' });
    assert.equal(done.body.unblocked, 1);
    assert.ok(!blocked('url', 'https://bad.example.com/file.zip'));
  });

  await t.test('[J-02] 저작권 신고: 진술 동의 필수, 접수 메일, 처리 시 모든 침해 위치 차단', async () => {
    const body = { claimant: '권리자 주식회사', email: 'rights@example.com', work: '영화 「테스트」', urls: ['https://pirate.example.com/a.mkv', 'magnet:?xt=urn:btih:' + 'c'.repeat(40)] };
    assert.equal((await anon.post('/api/content/copyright', { ...body, statement: false })).status, 400);
    assert.equal((await anon.post('/api/content/copyright', { ...body, urls: [], statement: true })).status, 400);
    const c = await anon.post('/api/content/copyright', { ...body, statement: true });
    assert.equal(c.status, 201);
    assert.equal(outbox('rights@example.com').length, 1);
    const list = await A.get('/api/admin/reports?kind=copyright');
    assert.deepEqual(list.body.items[0].meta.urls, body.urls);
    const r = await A.post(`/api/admin/reports/${c.body.id}/resolve`, { action: 'block' });
    assert.equal(r.body.blocked.length, 2);
    assert.ok(blocked('url', 'https://pirate.example.com/a.mkv'));
    assert.ok(blocked('infohash', 'c'.repeat(40)));
    assert.equal(outbox('rights@example.com').length, 2); // 비회원 신고자는 결과를 이메일로 받는다
  });

  await t.test('[J-03] 투명성 보고서: 기간별 접수·조치 통계', async () => {
    const r = await anon.get('/api/content/transparency');
    assert.equal(r.status, 200);
    assert.equal(r.body.totals.received.copyright, 1);
    assert.equal(r.body.totals.received.report, 3);
    assert.equal(r.body.totals.received.appeal, 1);
    assert.equal(r.body.totals.actions.block, 3);
    assert.equal(r.body.totals.actions.suspend, 1);
    assert.equal(r.body.totals.actions.unblock, 1);
    assert.match(r.body.periods[0].period, /^\d{4}-\d{2}$/);
    assert.ok(r.body.blocklist.infohash >= 1);
    assert.deepEqual(r.body.byReason.illegal_filming, { received: 1, actioned: 1 });
    assert.deepEqual(r.body.byReason.spam, { received: 1, actioned: 1 }); // 사용자 신고 → 정지
  });

  await t.test('[J-02] 저작권 신고의 미믹 공유 링크: block 은 공유 파일 해시를 막고(다운로드 451), suspend 는 공유 소유자를 정지', async (tt) => {
    if (!s.ctx.modules.share) return tt.skip('share 모듈 없음');
    const owner = createUser(s.db);
    const H2 = 'd'.repeat(64);
    const folder = createFolder(s.db, owner.id, null, '폴더');
    const f = createFileNode(s.db, owner.id, folder.id, { name: 'movie.mkv', size: 7, blobHash: null });
    s.db.prepare('INSERT INTO blobs (hash, size, created_at) VALUES (?,?,?)').run(H2, 7, Date.now());
    s.db.prepare('UPDATE files SET blob_hash=? WHERE id=?').run(H2, f.id);
    const token = 'tok' + 'x'.repeat(21);
    s.db.prepare('INSERT INTO share_links (id, user_id, token, title, file_ids, created_at) VALUES (?,?,?,?,?,?)').run('sh_t1', owner.id, token, '폴더', JSON.stringify([folder.id]), Date.now());
    const body = { claimant: '권리자', email: 'rights2@example.com', work: '드라마', urls: [`${s.url}/s/${token}`], statement: true };
    const c1 = await anon.post('/api/content/copyright', body);
    const r1 = await A.post(`/api/admin/reports/${c1.body.id}/resolve`, { action: 'block' });
    assert.equal(r1.status, 200);
    assert.ok(blocked('blob', H2));
    const viewer = client(s.url, sessionFor(s.db, createUser(s.db).id));
    assert.equal((await viewer.get(`/api/share/public/${token}/files/${f.id}/download`)).status, 451);
    // 반복 침해: 같은 공유를 다시 신고 → 소유자 정지
    const c2 = await anon.post('/api/content/copyright', { ...body, urls: [token] });
    const r2 = await A.post(`/api/admin/reports/${c2.body.id}/resolve`, { action: 'suspend', suspendHours: 24 });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body.suspended, [owner.id]);
    assert.equal(s.db.prepare('SELECT status FROM users WHERE id=?').get(owner.id).status, 'suspended');
  });

  await t.test('[J-01] 회원이 지워지면 신고자 연락처·문의 개인정보를 지운다(결제 문의는 분쟁 기록으로 보존)', async () => {
    const m = createUser(s.db, { email: 'leaver@test.local' });
    const M = client(s.url, sessionFor(s.db, m.id));
    const rep = await M.post('/api/content/reports', { targetType: 'url', target: 'https://spam.example.com/', reason: 'spam' });
    const q1 = await M.post('/api/content/contact', { name: '탈퇴자', email: 'leaver@test.local', category: 'bug', message: '버그 신고합니다' });
    const q2 = await M.post('/api/content/contact', { name: '탈퇴자', email: 'leaver@test.local', category: 'payment', message: '환불 요청합니다' });
    assert.equal((await A.del(`/api/admin/users/${m.id}`)).status, 200);
    const row = s.db.prepare('SELECT * FROM content_reports WHERE id=?').get(rep.body.id);
    assert.ok(row); // 통계용 행은 남는다
    assert.equal(row.reporter_email, null);
    assert.equal(row.reporter_id, null);
    assert.ok(!s.db.prepare('SELECT 1 FROM content_messages WHERE id=?').get(q1.body.id));
    assert.ok(s.db.prepare('SELECT 1 FROM content_messages WHERE id=?').get(q2.body.id));
    // 보존 기간(3년)이 지난 문의는 정리 작업이 지운다
    s.db.prepare('UPDATE content_messages SET created_at=? WHERE id=?').run(Date.now() - 4 * 365 * 864e5, q2.body.id);
    const mod = await import('../server/modules/content/index.js');
    for (const j of mod.jobs) await j.run(s.ctx);
    assert.ok(!s.db.prepare('SELECT 1 FROM content_messages WHERE id=?').get(q2.body.id));
  });

  await t.test('[K-05] 알림 목록·안 읽은 수·읽음 처리, 관리자 공지 발송', async () => {
    const v = createUser(s.db);
    const V = client(s.url, sessionFor(s.db, v.id));
    notify(s.db, v.id, { kind: 'offline', title: '다운로드 완료', link: '/drive/all' });
    assert.equal((await A.post('/api/admin/notifications', { userId: v.id, title: '점검 안내', link: 'javascript:alert(1)' })).status, 400);
    assert.equal((await A.post('/api/admin/notifications', { userId: v.id, title: '점검 안내', body: '오늘 밤 점검', link: '/help', email: true })).status, 201);
    const all = await A.post('/api/admin/notifications', { all: true, title: '전체 공지' });
    assert.ok(all.body.sent >= 3);
    assert.equal((await V.get('/api/notifications/unread-count')).body.count, 3);
    const list = await V.get('/api/notifications?limit=2');
    assert.equal(list.body.items.length, 2);
    assert.equal(list.body.items[0].title, '전체 공지'); // 최신순
    assert.equal(list.body.hasMore, true);
    await V.post('/api/notifications/read', { ids: [list.body.items[0].id] });
    assert.equal((await V.get('/api/notifications/unread-count')).body.count, 2);
    // 다른 사람 알림은 읽음 처리할 수 없다
    const mine = s.db.prepare('SELECT id FROM notifications WHERE user_id=?').get(user.id).id;
    assert.equal((await V.post('/api/notifications/read', { ids: [mine] })).body.updated, 0);
    await V.post('/api/notifications/read', { all: true });
    assert.equal((await V.get('/api/notifications/unread-count')).body.count, 0);
    assert.equal((await anon.get('/api/notifications')).status, 401);
    assert.equal(outbox(v.email).length, 1);
    // 알림에는 보안 경고가 있어 account 권한이 없는 토큰은 읽거나 읽음 처리할 수 없다
    const T = client(s.url, createToken(s.db, v.id, { name: 'cli', scopes: ['files:read'] }).token);
    for (const p of ['/api/notifications', '/api/notifications/unread-count']) assert.equal((await T.get(p)).status, 403, p);
    assert.equal((await T.post('/api/notifications/read', { all: true })).status, 403);
    assert.equal((await client(s.url, createToken(s.db, v.id, { name: 'acc', scopes: ['account'] }).token).get('/api/notifications/unread-count')).status, 200);
  });

  await t.test('[K-01] 도움말 카테고리 12개 이상·글·검색, FAQ 20개 이상, 문의 접수 시 outbox 기록', async () => {
    const h = await anon.get('/api/content/help');
    assert.ok(h.body.categories.length >= 12);
    assert.ok(h.body.categories.every((c) => c.articles.length >= 1));
    const a = await anon.get('/api/content/help/monthly-quota');
    assert.match(a.body.article.body, /40TB/);
    assert.equal((await anon.get('/api/content/help/nope')).status, 404);
    const sr = await anon.get('/api/content/help?q=' + encodeURIComponent('휴지통'));
    assert.ok(sr.body.results.some((x) => x.slug === 'trash'));
    assert.ok((await anon.get('/api/content/faq')).body.items.length >= 20);

    assert.equal((await anon.post('/api/content/contact', { name: '홍길동', email: 'bad', category: 'bug', message: '안녕하세요 문의' })).status, 400);
    const c = await anon.post('/api/content/contact', { name: '홍길동', email: 'hong@example.com', category: 'payment', message: '결제가 반영되지 않았어요' });
    assert.equal(c.status, 201);
    assert.ok(s.db.prepare('SELECT 1 FROM content_messages WHERE id=?').get(c.body.id));
    assert.equal(outbox('support@mimic.local').filter((o) => o.subject.includes('문의') && o.subject.includes('홍길동')).length, 1);
    assert.equal(outbox('hong@example.com').length, 1);
    const msgs = await A.get('/api/admin/messages?status=open');
    assert.equal(msgs.body.items[0].id, c.body.id);
    await A.post(`/api/admin/messages/${c.body.id}/reply`, { body: '확인 후 반영했습니다' });
    assert.equal(outbox('hong@example.com').length, 2);
    // 메일 제목에 들어가는 이름은 줄바꿈을 지운다(헤더 주입 방지)
    await anon.post('/api/content/contact', { name: '악성\r\nBcc: evil@example.com', email: 'inj@example.com', category: 'other', message: '헤더 주입 시도' });
    assert.ok(!/[\r\n]/.test(outbox('support@mimic.local').at(-1).subject));
    const cr = await anon.post('/api/content/copyright', { claimant: '권리자\nBcc: evil@example.com', email: 'inj@example.com', work: 'w', urls: ['https://z.example.com/'], statement: true });
    assert.equal(cr.status, 201);
    assert.ok(!/[\r\n]/.test(outbox('support@mimic.local').at(-1).subject));
  });

  await t.test('[J-04] 정책 문서 7종 모두 초안 표시와 함께 제공', async () => {
    for (const slug of ['terms', 'privacy', 'membership', 'anti-abuse', 'child-safety', 'copyright', 'cookies']) {
      const p = await anon.get('/api/content/policies/' + slug);
      assert.equal(p.status, 200, slug);
      assert.equal(p.body.policy.draft, true);
      assert.ok(p.body.policy.sections.length >= 4, slug);
    }
    const m = await anon.get('/api/content/policies/membership');
    assert.match(JSON.stringify(m.body.policy.sections), /7일/); // 청약철회 7일
    assert.equal((await anon.get('/api/content/policies')).body.policies.length, 7);
  });

  await t.test('[K-02] 블로그 3편과 소개·앱·BT·TV 페이지 파일', async () => {
    const b = await anon.get('/api/content/blog');
    assert.equal(b.body.posts.length, 3);
    for (const p of b.body.posts) assert.ok((await anon.get('/api/content/blog/' + p.slug)).body.post.body.length > 100);
    // 소개 화면 수치는 plans.js 값을 그대로 쓴다
    assert.deepEqual((await anon.get('/api/content/numbers')).body, JSON.parse(JSON.stringify(N)));
    const landing = fs.readFileSync(path.join(here, '..', 'web', 'pages', 'landing.js'), 'utf8');
    assert.ok(!/\d+(GB|TB)/.test(landing), 'landing.js 에 용량 수치를 직접 적지 않는다');
    const bt = fs.readFileSync(path.join(here, '..', 'web', 'pages', 'bt.js'), 'utf8');
    assert.ok(!bt.includes(N.btMax), 'bt.js 에 작업당 파일 수를 직접 적지 않는다(/api/content/numbers 사용)');
    // CLI 는 실제 설치 스크립트 명령을 안내한다(README 와 같은 Node 20)
    const apps = fs.readFileSync(path.join(here, '..', 'web', 'pages', 'apps.js'), 'utf8');
    assert.ok(apps.includes('curl -fsSL ${location.origin}/api/integrations/cli/install.sh | sh'));
    assert.ok(apps.includes('irm ${location.origin}/api/integrations/cli/install.ps1 | iex'));
    assert.ok(!apps.includes('Node.js 24'));
    for (const page of ['landing', 'bt', 'apps', 'tv', 'blog']) {
      const r = await anon.get(`/pages/${page}.js`);
      assert.equal(r.status, 200, page);
    }
  });

  await t.test('[K-03] 공개 화면 파일은 문법 오류가 없고 주요 문구에 영어(t) 제공', () => {
    const pages = ['landing', 'bt', 'apps', 'blog', 'help', 'faq', 'contact', 'policy', 'transparency', 'copyright', 'checkin-guide', 'notifications', 'tv', 'admin'];
    for (const p of pages) {
      const file = path.join(here, '..', 'web', 'pages', p + '.js');
      execFileSync(process.execPath, ['--check', file]);
      const src = fs.readFileSync(file, 'utf8');
      assert.ok((src.match(/\bt\('/g) || []).length >= 3, `${p}: t() 영어 문구 부족`);
    }
  });

  await t.test('[K-06] 관리자 동작은 감사 로그에 남는다', async () => {
    const logs = await A.get('/api/admin/logs?action=admin.');
    const actions = new Set(logs.body.items.map((x) => x.action));
    for (const a of ['admin.user.suspend', 'admin.user.unsuspend', 'admin.user.premium', 'admin.user.grant_quota', 'admin.user.delete', 'admin.blocklist.add', 'admin.blocklist.remove', 'admin.report.resolve', 'admin.notify']) {
      assert.ok(actions.has(a), a);
    }
    assert.equal(logs.body.items[0].userEmail, 'admin@test.local');
  });

  await t.test('[J-01] 정지된 회원의 이의제기 결과는 이메일로도 간다(사이트 알림을 못 읽으므로), 공유·파일 차단 알림의 조사', async () => {
    const sus = createUser(s.db, { email: 'sus@test.local' });
    const S = client(s.url, sessionFor(s.db, sus.id));
    const rep = await anon.post('/api/content/reports', { targetType: 'user', target: 'sus@test.local', reason: 'spam' });
    assert.equal((await A.post(`/api/admin/reports/${rep.body.id}/resolve`, { action: 'suspend', suspendHours: 87600 })).status, 200);
    const ap = await S.post('/api/content/reports', { kind: 'appeal', targetType: 'user', target: 'sus@test.local', detail: '오해입니다' });
    assert.equal(ap.status, 201);
    const before = outbox('sus@test.local').length;
    assert.equal((await A.post(`/api/admin/reports/${ap.body.id}/resolve`, { action: 'dismiss', note: '기각합니다' })).status, 200);
    const mails = outbox('sus@test.local');
    assert.equal(mails.length, before + 1);
    assert.match(mails.at(-1).subject, /이의제기 처리 결과/);
    assert.match(mails.at(-1).body, /기각합니다/);
    // 앞 테스트에서 차단된 user 의 파일: '파일이' (공유는 '공유가')
    assert.ok(s.db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title='신고로 파일이 차단되었어요'").get(user.id));
    assert.ok(!s.db.prepare("SELECT 1 FROM notifications WHERE title LIKE '%공유이%' OR body LIKE '%공유을%'").get());
  });

  await t.test('[J-04] 저작권 차단에 대한 이의제기는 권리자에게 전달되고 기다릴 기한이 남는다, 정책 문구는 실제 흐름과 같다', async () => {
    const url = 'https://pirate3.example.com/b.mkv';
    const c = await anon.post('/api/content/copyright', { claimant: '권리자3', email: 'rights3@example.com', work: '드라마', urls: [url], statement: true });
    assert.equal((await A.post(`/api/admin/reports/${c.body.id}/resolve`, { action: 'block' })).status, 200);
    const n0 = outbox('rights3@example.com').length;
    const ap = await U.post('/api/content/reports', { kind: 'appeal', targetType: 'url', target: url, detail: '제가 산 자료입니다' });
    assert.equal(ap.status, 201);
    const mails = outbox('rights3@example.com');
    assert.equal(mails.length, n0 + 1);
    assert.match(mails.at(-1).body, /제가 산 자료입니다/);
    assert.ok(mails.at(-1).body.includes(`${N.counterWaitDays}일`));
    const row = (await A.get('/api/admin/reports?kind=appeal&status=open')).body.items.find((x) => x.id === ap.body.id);
    assert.deepEqual(row.meta.copyrightReports, [c.body.id]);
    assert.ok(row.meta.waitUntil > Date.now());
    // 저작권과 상관없는 이의제기는 아무에게도 전달하지 않는다
    const other = await U.post('/api/content/reports', { kind: 'appeal', targetType: 'url', target: 'https://unrelated.example.com/', detail: 'x' });
    assert.deepEqual(s.db.prepare('SELECT meta FROM content_reports WHERE id=?').get(other.body.id).meta, '{}');
    const policy = async (slug) => JSON.stringify((await anon.get('/api/content/policies/' + slug)).body.policy.sections);
    assert.ok((await policy('copyright')).includes(`${N.counterWaitDays}일`));
    assert.match(await policy('privacy'), /권리자 이름/);
    for (const slug of ['terms', 'privacy', 'child-safety']) assert.ok(!(await policy(slug)).includes('법정대리인'), slug);
  });

  await t.test('[K-05] 앱 푸시 구독: https·키를 검사해 저장하면 알림이 push 로도 가고, 끄면 멈춘다', async () => {
    const v = createUser(s.db);
    const V = client(s.url, sessionFor(s.db, v.id));
    assert.ok('publicKey' in (await V.get('/api/notifications/push/key')).body);
    const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
    assert.equal((await anon.post('/api/notifications/push-subscriptions', sub)).status, 401);
    assert.equal((await V.post('/api/notifications/push-subscriptions', { ...sub, endpoint: 'http://push.example.com/x' })).status, 400);
    assert.equal((await V.post('/api/notifications/push-subscriptions', { ...sub, keys: { p256dh: 'x', auth: 'y' } })).status, 400);
    assert.equal((await V.post('/api/notifications/push-subscriptions', sub)).status, 201);
    const pushes = () => s.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel='push' AND to_addr=?").get(v.id).n;
    notify(s.db, v.id, { kind: 'notice', title: '푸시 시험' });
    assert.equal(pushes(), 1);
    assert.equal((await U.del('/api/notifications/push-subscriptions', { endpoint: sub.endpoint })).body.removed, 0); // 남의 구독은 못 지움
    assert.equal((await V.del('/api/notifications/push-subscriptions', { endpoint: sub.endpoint })).body.removed, 1);
    notify(s.db, v.id, { kind: 'notice', title: '푸시 시험 2' });
    assert.equal(pushes(), 1);
  });

  await t.test('[K-03] 알림 목록은 회원 언어를 따른다(영어가 없으면 한국어), 관리자 공지는 영어 제목·본문을 받는다', async () => {
    const e = createUser(s.db);
    s.db.prepare("UPDATE users SET lang='en' WHERE id=?").run(e.id);
    const E = client(s.url, sessionFor(s.db, e.id));
    assert.equal((await A.post('/api/admin/notifications', { userId: e.id, title: '점검 안내', titleEn: 'Maintenance', body: '오늘 밤', bodyEn: 'Tonight' })).status, 201);
    notify(s.db, e.id, { kind: 'offline', title: '다운로드 완료' });
    const items = (await E.get('/api/notifications')).body.items;
    assert.equal(items[0].title, '다운로드 완료');
    assert.deepEqual([items[1].title, items[1].body], ['Maintenance', 'Tonight']);
    s.db.prepare("UPDATE users SET lang='ko' WHERE id=?").run(e.id);
    assert.equal((await E.get('/api/notifications')).body.items[1].title, '점검 안내');
  });

  await t.test('[J-03] 투명성: 합계는 첫 접수 월(since)부터 전체 기간, 월별 표는 빈 달도 0으로 채운다', async () => {
    const r0 = await anon.post('/api/content/reports', { targetType: 'url', target: 'https://old.example.com/', reason: 'spam' });
    s.db.prepare('UPDATE content_reports SET created_at=? WHERE id=?').run(Date.now() - 100 * 864e5, r0.body.id);
    const r = (await anon.get('/api/content/transparency')).body;
    assert.ok(r.periods.length >= 4, String(r.periods.length));
    assert.equal(r.since, r.periods.at(-1).period);
    assert.ok(r.periods.some((p) => p.received.report + p.received.copyright + p.received.appeal === 0));
    const sum = (k) => r.periods.reduce((a, p) => a + p.received[k], 0);
    for (const k of ['report', 'copyright', 'appeal']) assert.equal(sum(k), r.totals.received[k], k);
    const one = (await anon.get('/api/content/transparency?months=1')).body;
    assert.equal(one.periods.length, 1);
    assert.equal(one.totals.received.report, r.totals.received.report);
  });
});
