import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { createApp } from '../server/index.js';
import { createFileNode } from '../server/core/files.js';
import { normBlock } from '../server/modules/admin/index.js';
import { findBlock } from '../server/modules/offline/engine.js';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const src = (p) => fs.readFileSync(path.join(web, p), 'utf8');

test('[A-08] normBlock: URL 의 #조각과 빈 ? 를 떼고 저장한다', () => {
  assert.equal(normBlock('url', 'https://a.example.com/x.zip#part').value, 'https://a.example.com/x.zip');
  assert.equal(normBlock('url', 'https://a.example.com/x.zip?').value, 'https://a.example.com/x.zip');
  assert.equal(normBlock('url', 'https://a.example.com/x.zip?#p').value, 'https://a.example.com/x.zip');
  assert.equal(normBlock('url', 'https://a.example.com/x.zip?k=1#p').value, 'https://a.example.com/x.zip?k=1');
});

test('[A-08] 예전 모양(#조각·빈 ?)으로 저장된 url 차단은 시작할 때 지금 모양으로 맞춰진다(신고 해제·중복 확인이 맞게)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-test-'));
  const opts = { dataDir, dev: true, quiet: true, runJobs: false, secret: 'test-secret-0123456789abcdef0123456789' };
  try {
    let inst = await createApp(opts);
    const add = (id, value) => inst.db.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES (?, 'url', ?, 0)").run(id, value);
    add('bl_old1', 'https://c.example.com/a.zip#part');
    add('bl_old2', 'https://c.example.com/b.zip?');
    add('bl_new3', 'https://c.example.com/b.zip'); // 이미 맞춘 값이 있다 → bl_old2 는 지워진다
    add('bl_keep', 'https://c.example.com/c.zip?k=1');
    await inst.close();
    inst = await createApp(opts);
    const rows = inst.db.prepare("SELECT id, value FROM blocklist WHERE kind='url' ORDER BY id").all().map((x) => ({ ...x }));
    assert.deepEqual(rows, [
      { id: 'bl_keep', value: 'https://c.example.com/c.zip?k=1' },
      { id: 'bl_new3', value: 'https://c.example.com/b.zip' },
      { id: 'bl_old1', value: 'https://c.example.com/a.zip' },
    ]);
    await inst.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('admin-followup: 차단 비교, 영어 회원 안내 메일, 관리자 화면', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const admin = createUser(s.db, { admin: true });
  const A = client(s.url, sessionFor(s.db, admin.id));
  const outbox = (to) => s.db.prepare('SELECT * FROM outbox WHERE to_addr=? ORDER BY created_at, rowid').all(to);
  const english = (opts) => {
    const u = createUser(s.db, opts);
    s.db.prepare("UPDATE users SET lang='en' WHERE id=?").run(u.id);
    return u;
  };
  const korean = /[가-힣]/;

  await t.test('[A-08] 정리해 저장한 URL 도 offline 차단 비교에 그대로 걸린다', async () => {
    const r = await A.post('/api/admin/blocklist', { kind: 'url', value: 'https://b.example.com/f.zip?#x' });
    assert.equal(r.status, 201);
    assert.equal(r.body.value, 'https://b.example.com/f.zip');
    assert.equal(findBlock(s.db, null, 'https://b.example.com/f.zip#other')?.id, r.body.id);
    assert.equal(findBlock(s.db, null, 'https://b.example.com/f.zip?')?.id, r.body.id);
    // 같은 주소를 #조각만 바꿔 다시 넣으면 중복
    assert.equal((await A.post('/api/admin/blocklist', { kind: 'url', value: 'https://b.example.com/f.zip#y' })).status, 409);
  });

  await t.test('계정 제한 메일: 영어 회원은 영어, 한국어 회원은 한국어', async () => {
    const en = english({ email: 'en-sus@test.local' });
    const ko = createUser(s.db, { email: 'ko-sus@test.local' });
    for (const u of [en, ko]) assert.equal((await A.patch(`/api/admin/users/${u.id}`, { suspendHours: 24 })).status, 200);
    const e = outbox(en.email).at(-1);
    assert.equal(e.subject, '[Mimic] Your account has been restricted');
    assert.match(e.body, /Restricted until .+ \(UTC\)/);
    assert.match(e.body, /Appeal: http.+\/copyright\?tab=appeal/);
    assert.ok(!korean.test(e.subject + e.body));
    assert.equal(outbox(ko.email).at(-1).subject, '[미믹] 계정 이용 제한 안내');
  });

  await t.test('콘텐츠 차단 메일과 이의제기 결과 메일도 영어 회원에게는 영어로', async () => {
    const owner = english({ email: 'en-owner@test.local' });
    const hash = 'b'.repeat(64);
    s.db.prepare('INSERT INTO blobs (hash, size, created_at) VALUES (?,?,?)').run(hash, 5, Date.now());
    const file = createFileNode(s.db, owner.id, null, { name: 'clip.mp4', size: 5, blobHash: hash });
    const R = client(s.url, sessionFor(s.db, createUser(s.db).id));
    const rep = await R.post('/api/content/reports', { targetType: 'file', target: file.id, reason: 'illegal_filming' });
    assert.equal(rep.status, 201);
    assert.equal((await A.post(`/api/admin/reports/${rep.body.id}/resolve`, { action: 'block', note: 'confirmed' })).status, 200);
    const m = outbox(owner.email).at(-1);
    assert.equal(m.subject, '[Mimic] Your file was blocked');
    assert.match(m.body, new RegExp(`Following a report \\(ref\\. ${rep.body.id}\\), we blocked your file\\. Reason: non-consensual imagery — confirmed\\.`));
    assert.match(m.body, /Appeal: http/);
    assert.ok(!korean.test(m.subject + m.body));
    // 사이트 알림·웹 푸시도 영어 본문을 갖는다
    const n = s.db.prepare("SELECT * FROM notifications WHERE user_id=? AND kind='report' ORDER BY created_at DESC, rowid DESC").get(owner.id);
    assert.equal(n.title_en, 'Your file was blocked after a report');
    assert.match(n.body_en, /^Following a report \(ref\. .+\), we blocked your file\. Reason: non-consensual imagery — confirmed\./);

    const O = client(s.url, sessionFor(s.db, owner.id));
    const ap = await O.post('/api/content/reports', { kind: 'appeal', targetType: 'file', target: file.id, detail: 'mine' });
    assert.equal(ap.status, 201);
    assert.equal((await A.post(`/api/admin/reports/${ap.body.id}/resolve`, { action: 'dismiss', note: 'kept' })).status, 200);
    const res = outbox(owner.email).at(-1);
    assert.equal(res.subject, '[Mimic] Result of your appeal');
    assert.equal(res.body, `We reviewed your appeal (ref. ${ap.body.id}). Result: no action taken.\nkept`);
  });

  await t.test('관리자 화면: 추천 보상 메뉴·초대 검토·보관 주문·연락처 무효·지역 안내·이의 인용 경고', async () => {
    for (const p of ['pages/admin.js', 'layout.js']) execFileSync(process.execPath, ['--check', path.join(web, p)]);
    const icon = /\['pro', '(\w+)'/.exec(src('layout.js'))?.[1];
    assert.ok(icon && new RegExp(`\\n\\s+${icon}: '`).test(src('ui.js')), '메뉴 아이콘이 ui.js 에 있어야 한다');
    const admin = src('pages/admin.js');
    assert.match(admin, /SECTIONS = \{[^}]*\bpro\b/);
    assert.match(admin, /tab === 'pro'\) return ctx\.navigate\('\/admin\/pro'/); // 예전 주소
    for (const s of ['/api/admin/billing/invites', 'archived=1', '/contact-invalid', '/delete-hold', 'MIMIC_COUNTRY_HEADER', 'every user']) assert.ok(admin.includes(s), s);
    // 화면이 쓰는 billing 응답 모양
    const inv = await A.get('/api/admin/billing/invites?suspicious=1');
    assert.equal(inv.status, 200);
    assert.ok(Array.isArray(inv.body.items));
    assert.ok(Array.isArray((await A.get('/api/admin/billing/orders?archived=1')).body.items));
  });
});
