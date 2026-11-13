// Q-6: 받은 토렌트를 계속 시딩(저장소 본문 하드 링크 배치, 다시 켜도 이어서, 지우거나 차단하면 멈춤)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import bencode from 'bencode';
import parseTorrent from 'parse-torrent';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { blobPath, ingestStream } from '../server/core/storage.js';
import { createFileNode } from '../server/core/files.js';
import { newId, now } from '../server/core/util.js';
import { linkLayout, syncSeeds, closeEngine } from '../server/modules/offline/engine.js';

// tracker·DHT 없이 같은 프로세스 안 클라이언트끼리 x.pe(직접 지정 피어)로만 주고받는다
const BT = { dht: false, lsd: false, natUpnp: false, natPmp: false, utPex: false, tracker: false };
const ino = (p) => fs.statSync(p, { bigint: true }).ino;

async function waitFor(fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const ready = (torrent) => (torrent.ready ? null : once(torrent, 'ready'));

// .torrent 를 선언된 bencode 로만 만든다: 파일을 이어 붙인 본문의 16KB 조각마다 SHA-1
function makeTorrent(name, list) {
  const PIECE = 16384;
  const all = Buffer.concat(list.map(([, body]) => Buffer.from(body)));
  const pieces = [];
  for (let i = 0; i < all.length; i += PIECE) pieces.push(crypto.createHash('sha1').update(all.subarray(i, i + PIECE)).digest());
  const files = list.map(([n, body]) => ({ length: Buffer.byteLength(body), path: [n] }));
  return Buffer.from(bencode.encode({ info: { name, 'piece length': PIECE, pieces: Buffer.concat(pieces), files } }));
}

// 토렌트를 만들고 본문을 저장소·드라이브에 넣은 뒤 시딩 기록을 남긴다(받기를 마친 것과 같은 상태)
async function seedOf(s, userId, name, list, at) {
  const buf = makeTorrent(name, list);
  const p = await parseTorrent(buf);
  const files = [];
  for (const [i, [n, body]] of list.entries()) {
    const blob = await ingestStream(s.db, s.cfg, Readable.from([Buffer.from(body)]));
    const node = createFileNode(s.db, userId, null, { name: `${name}-${n}`, size: blob.size, blobHash: blob.hash, origin: 'cloud' });
    s.db.prepare('INSERT INTO offline_seed_files (file_id, info_hash) VALUES (?,?)').run(node.id, p.infoHash);
    files.push({ path: p.files[i].path.split(/[\\/]/).join('/'), size: blob.size, hash: blob.hash, node: node.id });
  }
  s.db.prepare('INSERT INTO offline_seeds (info_hash, torrent, files, created_at) VALUES (?,?,?,?)').run(p.infoHash, buf, JSON.stringify(files), at);
  return { ih: p.infoHash, files };
}
const activeSeeds = (s) => s.db.prepare('SELECT info_hash FROM offline_seeds WHERE stopped_at IS NULL').all().map((r) => r.info_hash).sort();

test('[Q-6] 시딩 배치: 본문은 하드 링크, 패딩은 0, 받지 않은 파일·폴더 밖 경로는 두지 않음', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-seed-'));
  try {
    const cfg = { dataDir };
    const put = (hash, body) => {
      const p = blobPath(cfg, hash);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
      return p;
    };
    const a = put('a'.repeat(64), 'movie');
    const b = put('b'.repeat(64), 'subs');
    const dir = path.join(dataDir, 'seeding', 'x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale'), 'old');
    linkLayout(cfg, dir, [
      { path: 'Pack/movie.mkv', size: 5, hash: 'a'.repeat(64) },
      { path: 'Pack/.pad/3', size: 3, hash: null },
      { path: 'Pack/sub/subs.srt', size: 4, hash: 'b'.repeat(64) },
      { path: 'Pack/www.ads-site.com.txt', size: 9, hash: null },
      { path: '../escape.srt', size: 4, hash: 'b'.repeat(64) },
    ]);
    const movie = path.join(dir, 'Pack', 'movie.mkv');
    assert.equal(fs.readFileSync(movie, 'utf8'), 'movie');
    assert.equal(ino(movie), ino(a), '복사가 아니라 하드 링크');
    assert.equal(fs.statSync(a).nlink, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'Pack', 'sub', 'subs.srt'), 'utf8'), 'subs');
    assert.equal(fs.statSync(b).nlink, 2, '폴더 밖 경로는 링크하지 않음');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'Pack', '.pad', '3')), Buffer.alloc(3));
    assert.ok(!fs.existsSync(path.join(dir, 'Pack', 'www.ads-site.com.txt')));
    assert.ok(!fs.existsSync(path.join(dataDir, 'seeding', 'escape.srt')));
    assert.ok(!fs.existsSync(path.join(dir, 'stale')), '예전 배치는 지우고 다시 만든다');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[Q-6] 받은 토렌트를 서버가 시딩 → 다른 클라이언트가 서버에서 받음, 다시 켜도 이어서, 파일을 모두 지우면 멈춤', { timeout: 120_000 }, async (t) => {
  const { default: WebTorrent } = await import('webtorrent');
  const s = await startServer({ bt: BT, ytDlp: null });
  const seeder = new WebTorrent({ ...BT, utp: false });
  const leecher = new WebTorrent({ ...BT, utp: false });
  const leechDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-leech-'));
  t.after(async () => {
    for (const c of [seeder, leecher]) if (!c.destroyed) await new Promise((r) => c.destroy(() => r()));
    await s.close();
    fs.rmSync(leechDir, { recursive: true, force: true, maxRetries: 5 });
  });
  const movie = Buffer.alloc(300_000);
  for (let i = 0; i < movie.length; i++) movie[i] = (i * 31) % 251;
  const input = [Object.assign(Buffer.from(movie), { name: 'movie.mkv' }), Object.assign(Buffer.alloc(3000, 2), { name: 'subs.srt' })];
  const seeded = await new Promise((r) => seeder.seed(input, { name: 'Seed Pack', announce: [] }, r));
  if (!seeder.listening) await Promise.race([once(seeder, 'listening'), new Promise((res) => setTimeout(res, 5000))]);
  if (!seeder.listening) return t.skip('이 환경에서는 로컬 TCP 포트를 열 수 없음');
  const ih = seeded.infoHash;

  const u = createUser(s.db, { premium: true });
  const api = client(s.url, sessionFor(s.db, u.id));
  const r = await api.post('/api/offline/tasks', { urls: [`magnet:?xt=urn:btih:${ih}&dn=Seed+Pack&x.pe=127.0.0.1:${seeder.torrentPort}`] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const task = await waitFor(async () => {
    const x = (await api.get(`/api/offline/tasks/${r.body.tasks[0].id}`)).body.task;
    return ['done', 'error'].includes(x.status) && x;
  }, 60_000);
  assert.equal(task.status, 'done', task.error);
  await syncSeeds(s.ctx); // run 이 건 시딩이 끝날 때까지
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM offline_seed_files WHERE info_hash=?').get(ih).n, 2, '이 토렌트로 만든 파일을 기록');

  const row = s.db.prepare('SELECT * FROM offline_seeds WHERE info_hash=?').get(ih);
  assert.ok(row && row.stopped_at === null);
  const seedDir = path.join(s.dataDir, 'seeding', ih);
  const movieHash = s.db.prepare("SELECT blob_hash FROM files WHERE user_id=? AND name='movie.mkv'").get(u.id).blob_hash;
  assert.equal(ino(path.join(seedDir, 'Seed Pack', 'movie.mkv')), ino(blobPath(s.cfg, movieHash)), '저장소 본문을 하드 링크');
  const serverClient = await s.ctx.offline.client;
  const seeding = s.ctx.offline.seeds.get(ih).torrent;
  await ready(seeding);
  assert.equal(seeding.infoHash, ih);
  assert.ok(seeding.done, '모든 조각 확인됨');

  // 원래 시더를 끄면 서버만 가진 데이터: 새 클라이언트가 서버에서 받는다
  await new Promise((res) => seeder.destroy(() => res()));
  const lt = leecher.add(`magnet:?xt=urn:btih:${ih}&x.pe=127.0.0.1:${serverClient.torrentPort}`, { path: leechDir });
  await waitFor(() => lt.done, 60_000);
  assert.deepEqual(fs.readFileSync(path.join(leechDir, 'Seed Pack', 'movie.mkv')), movie);
  assert.ok(seeding.received < seeding.pieceLength, '시딩 쪽은 조각을 받지 않는다(프로토콜 메시지만)');

  const admin = client(s.url, sessionFor(s.db, createUser(s.db, { admin: true }).id));
  const stats = (await admin.get('/api/admin/offline/seeding')).body;
  assert.equal(stats.seeding, 1);
  assert.ok(stats.uploaded >= movie.length, `올려 준 바이트 ${stats.uploaded}`);
  assert.equal((await api.get('/api/admin/offline/seeding')).status, 403);

  // 서버를 다시 켠 것처럼: 엔진을 닫고 새 상태로 맞추면 기록에서 이어서 시딩(업로드 합계는 남는다)
  await closeEngine(s.ctx);
  delete s.ctx.offline;
  assert.ok(s.db.prepare('SELECT uploaded FROM offline_seeds WHERE info_hash=?').get(ih).uploaded >= movie.length);
  await syncSeeds(s.ctx);
  const resumed = s.ctx.offline.seeds.get(ih)?.torrent;
  assert.ok(resumed, '다시 시딩');
  await ready(resumed);
  assert.ok(resumed.done);
  assert.equal(resumed.path, seedDir);

  // 모든 사용자가 파일을 완전히 지우면(휴지통 비우기) 시딩을 멈추고 시딩 폴더(링크)를 지운다. 저장소 본문 정리는 gcBlobs 몫
  s.db.prepare('DELETE FROM files WHERE user_id=?').run(u.id);
  await syncSeeds(s.ctx);
  assert.ok(s.db.prepare('SELECT stopped_at FROM offline_seeds WHERE info_hash=?').get(ih).stopped_at);
  assert.ok(!s.ctx.offline.seeds.has(ih));
  assert.ok(resumed.destroyed);
  assert.ok(!fs.existsSync(seedDir));
  assert.ok(fs.existsSync(blobPath(s.cfg, movieHash)));
  assert.equal((await admin.get('/api/admin/offline/seeding')).body.seeding, 0);
});

test('[Q-6] 일부 파일만 남으면 그 본문만 시딩, 상한을 넘으면 오래된 것부터, 차단된 infohash 는 멈춤', { timeout: 60_000 }, async (t) => {
  const s = await startServer({ bt: BT, ytDlp: null });
  t.after(() => s.close());
  const u = createUser(s.db);
  const t0 = now();
  const a = await seedOf(s, u.id, 'A', [
    ['a.bin', 'x'.repeat(40_000)],
    ['b.txt', 'y'.repeat(20_000)],
  ], t0);
  const b = await seedOf(s, u.id, 'B', [['c.bin', 'z'.repeat(30_000)]], t0 + 1);
  await syncSeeds(s.ctx);
  const seeds = s.ctx.offline.seeds;
  assert.deepEqual([...seeds.keys()].sort(), [a.ih, b.ih].sort());
  await ready(seeds.get(a.ih).torrent);
  assert.ok(seeds.get(a.ih).torrent.done);
  assert.equal(seeds.get(a.ih).torrent.skipVerify, true, '본문을 모두 가진 배치는 조각을 다시 확인하지 않음');

  // A 의 b.txt 를 지우면 그 링크만 빼고 다시 시딩(가진 조각만, 빠진 파일은 받지 않음)
  const before = seeds.get(a.ih).torrent;
  s.db.prepare('DELETE FROM files WHERE id=?').run(a.files[1].node);
  await syncSeeds(s.ctx);
  const after = seeds.get(a.ih).torrent;
  assert.notEqual(after, before);
  assert.ok(before.destroyed);
  await ready(after);
  assert.ok(!after.done);
  assert.equal(after.skipVerify, false, '일부만 있으면 조각을 확인');
  assert.ok(after.bitfield.get(0), 'a.bin 조각은 시딩');
  assert.equal(fs.statSync(blobPath(s.cfg, a.files[0].hash)).nlink, 2);
  assert.equal(fs.statSync(blobPath(s.cfg, a.files[1].hash)).nlink, 1, '지운 파일의 본문은 시딩 폴더에서 뺌');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(after.received, 0);

  // 상한 1: 오래된 A 를 멈춘다
  s.cfg.seedMax = 1;
  await syncSeeds(s.ctx);
  assert.deepEqual([...seeds.keys()], [b.ih]);
  assert.ok(s.db.prepare('SELECT stopped_at FROM offline_seeds WHERE info_hash=?').get(a.ih).stopped_at);
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'seeding', a.ih)));
  delete s.cfg.seedMax;

  // 관리자가 infohash 를 차단하면 멈춘다
  s.db.prepare('INSERT INTO blocklist (id, kind, value, reason, created_at) VALUES (?,?,?,?,?)').run(newId('b_'), 'infohash', b.ih.toUpperCase(), '테스트', now());
  await syncSeeds(s.ctx);
  assert.equal(seeds.size, 0);
  assert.ok(s.db.prepare('SELECT stopped_at FROM offline_seeds WHERE info_hash=?').get(b.ih).stopped_at);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM offline_seeds WHERE stopped_at IS NULL').get().n, 0);
});

test('[Q-6] 같은 본문이 다른 토렌트에 있어도 이 토렌트 파일을 모두 지우면 멈춤, 상한은 남긴 시딩만 셈, 파일 수 상한, 멈추면 .torrent·배치를 비움', { timeout: 60_000 }, async (t) => {
  const s = await startServer({ bt: BT, ytDlp: null });
  t.after(() => s.close());
  const u = createUser(s.db);
  const v = createUser(s.db);
  const t0 = now();
  const nfo = ['Group.txt', 'release group '.repeat(50)]; // 릴리스 그룹 안내문: 여러 토렌트에 같은 본문
  const a = await seedOf(s, u.id, 'A', [['a.bin', 'a'.repeat(20_000)], nfo], t0);
  const b = await seedOf(s, v.id, 'B', [['b.bin', 'b'.repeat(20_000)], nfo], t0 + 1);
  const c = await seedOf(s, v.id, 'C', [['c.bin', 'c'.repeat(20_000)]], t0 + 2);
  await syncSeeds(s.ctx);
  assert.deepEqual(activeSeeds(s), [a.ih, b.ih, c.ih].sort());

  // A 를 받은 사용자가 A 의 파일을 모두 지우면, 다른 사용자의 B 에 같은 Group.txt 가 있어도 A 는 멈춘다
  s.db.prepare('UPDATE offline_seeds SET uploaded=7 WHERE info_hash=?').run(a.ih);
  s.db.prepare('DELETE FROM files WHERE user_id=?').run(u.id);
  await syncSeeds(s.ctx);
  assert.deepEqual(activeSeeds(s), [b.ih, c.ih].sort());
  assert.ok(!s.ctx.offline.seeds.has(a.ih));
  const row = s.db.prepare('SELECT * FROM offline_seeds WHERE info_hash=?').get(a.ih);
  assert.equal(row.torrent.length, 0, '.torrent 를 비움');
  assert.equal(row.files, '[]');
  assert.equal(row.uploaded, 7, '업로드 합계는 남김');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM offline_seed_files WHERE info_hash=?').get(a.ih).n, 0, '지운 파일의 기록도 함께 지워짐');

  // 상한 2: 이번에 멈춘 최신 D 는 세지 않으므로 B·C 가 모두 남는다
  const d = await seedOf(s, u.id, 'D', [['d.bin', 'd'.repeat(20_000)]], t0 + 3);
  s.db.prepare('DELETE FROM files WHERE user_id=?').run(u.id);
  s.cfg.seedMax = 2;
  await syncSeeds(s.ctx);
  assert.deepEqual(activeSeeds(s), [b.ih, c.ih].sort());
  assert.ok(s.db.prepare('SELECT stopped_at FROM offline_seeds WHERE info_hash=?').get(d.ih).stopped_at);
  delete s.cfg.seedMax;

  // 파일 수 합계 상한 2: 최신 C(1개)는 남기고 B(2개)는 넘으므로 멈춘다
  s.cfg.seedMaxFiles = 2;
  await syncSeeds(s.ctx);
  assert.deepEqual(activeSeeds(s), [c.ih]);
  assert.deepEqual([...s.ctx.offline.seeds.keys()], [c.ih]);
  delete s.cfg.seedMaxFiles;
});
