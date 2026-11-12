import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { ingestStream, blobPath } from '../server/core/storage.js';
import { createFolder, createFileNode, listChildren } from '../server/core/files.js';
import { saveSettings, createToken } from '../server/core/auth.js';
import { addUsage } from '../server/core/quota.js';
import { LIMITS } from '../server/core/plans.js';
import { MAX_TRANSCODES, MAX_ENCODE_SEC } from '../server/modules/media/index.js';

const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file]).toString());
// tar 를 직접 만든다(ustar, 512 바이트 머리글)
const tarHeader = (name, size, type = '0') => {
  const b = Buffer.alloc(512);
  b.write(name, 0);
  b.write('0000644\0', 100);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write(type, 156);
  b.write('ustar\0' + '00', 257);
  b.fill(32, 148, 156);
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
};

test('media: 재생·자막·썸네일·외부 플레이어·시청 기록·압축 해제', async (t) => {
  const s = await startServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimic-media-'));
  t.after(async () => {
    await s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 테스트 재료: 자막·오디오 2개가 든 mkv, 360p mp4(브라우저 호환), 1080p mp4, HDR 표시 영상, 이미지, srt
  const f = (n) => path.join(tmp, n);
  fs.writeFileSync(f('in.srt'), '1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n\n2\n00:00:01,000 --> 00:00:02,000\nhello\n');
  const src = ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];
  ffmpeg(...src, '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-i', f('in.srt'), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:a:0', 'language=kor', '-metadata:s:a:1', 'language=eng', '-metadata:s:s:0', 'language=kor', f('movie.mkv'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', f('small.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('big.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=1', '-vf', 'setparams=color_trc=smpte2084:color_primaries=bt2020:colorspace=bt2020nc', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f('hdr.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', f('pic.jpg'));

  const free = createUser(s.db);
  const prem = createUser(s.db, { premium: true });
  const cf = client(s.url, sessionFor(s.db, free.id));
  const cp = client(s.url, sessionFor(s.db, prem.id));
  const add = async (user, parentId, name, file, mime = null) => {
    const r = await ingestStream(s.db, s.cfg, fs.createReadStream(file));
    return createFileNode(s.db, user.id, parentId, { name, size: r.size, mime, blobHash: r.hash, origin: 'upload' });
  };
  const fetchBin = async (url, token, headers = {}) => {
    const r = await fetch(s.url + url, { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  };
  const waitReady = async (c, url) => {
    for (let i = 0; i < 300; i++) {
      const r = await c.get(url);
      assert.notEqual(r.body.status, 'error', JSON.stringify(r.body));
      if (r.body.status === 'ready') return r.body;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error('변환이 끝나지 않음');
  };

  const freeTok = sessionFor(s.db, free.id);
  const premTok = sessionFor(s.db, prem.id);
  const dir = createFolder(s.db, free.id, null, '영상');
  const a1 = await add(free, dir.id, '01 small.mp4', f('small.mp4'), 'video/mp4');
  const movie = await add(free, dir.id, '02 movie.mkv', f('movie.mkv'));
  const big = await add(free, dir.id, '03 big.mp4', f('big.mp4'));
  const srt = await add(free, dir.id, '02 movie.ko.srt', f('in.srt'));
  const pic = await add(free, dir.id, 'pic.jpg', f('pic.jpg'));
  const premBig = await add(prem, null, 'big.mp4', f('big.mp4'));
  const premHdr = await add(prem, null, 'hdr.mp4', f('hdr.mp4'));

  await t.test('[C-01] 정보: 종류·길이·해상도·오디오·자막·화질·이전/다음', async () => {
    const r = await cf.get(`/api/media/${movie.id}/info`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'video');
    assert.ok(Math.abs(r.body.duration - 2) < 0.2);
    assert.equal(r.body.width, 1280);
    assert.equal(r.body.height, 720);
    assert.equal(r.body.videoCodec, 'h264');
    assert.deepEqual(r.body.audioTracks.map((x) => x.lang), ['kor', 'eng']);
    assert.deepEqual(r.body.qualities, ['720p']);
    assert.equal(r.body.siblings.prevId, a1.id);
    assert.equal(r.body.siblings.nextId, big.id);
    assert.equal((await cp.get(`/api/media/${premBig.id}/info`)).body.qualities.join(), '720p,original');
    // 분석 결과는 blob hash 로 캐시
    assert.ok(s.db.prepare('SELECT 1 FROM media_probe WHERE hash=?').get(movie.blob_hash));
    // 다른 사용자의 파일은 보이지 않는다
    assert.equal((await cp.get(`/api/media/${movie.id}/info`)).status, 404);
  });

  await t.test('[C-01] 호환 영상은 원본을 Range 로 보내고 다운스트림 쿼터를 차감', async () => {
    const r = await fetchBin(`/api/media/${a1.id}/stream`, freeTok, { range: 'bytes=0-99' });
    assert.equal(r.status, 206);
    assert.equal(r.buf.length, 100);
    assert.match(r.headers.get('content-range'), /^bytes 0-99\/\d+$/);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    await new Promise((ok) => setTimeout(ok, 50));
    const used = s.db.prepare("SELECT SUM(amount) AS n FROM quota_usage WHERE user_id=? AND kind='down' AND period LIKE 'd:%'").get(free.id).n;
    assert.ok(used >= 100);
  });

  await t.test('[C-01] 무료는 원본 화질 불가, 1080p 는 720p 로 변환 후 재생', async () => {
    assert.equal((await cf.get(`/api/media/${big.id}/stream?quality=original`)).body.error, 'premium_required');
    const first = await cf.get(`/api/media/${big.id}/stream?quality=720p`);
    assert.equal(first.status, 409);
    assert.equal(first.body.status, 'preparing');
    await waitReady(cf, `/api/media/${big.id}/prepare?quality=720p`);
    const r = await fetchBin(`/api/media/${big.id}/stream?quality=720p`, freeTok);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    fs.writeFileSync(f('out720.mp4'), r.buf);
    const v = probe(f('out720.mp4')).streams.find((x) => x.codec_type === 'video');
    assert.equal(v.height, 720);
    assert.equal(v.codec_name, 'h264');
    // 프리미엄은 원본을 그대로
    const o = await fetchBin(`/api/media/${premBig.id}/stream?quality=original`, premTok, { range: 'bytes=0-' });
    assert.equal(o.status, 206);
    assert.equal(o.buf.length, fs.statSync(f('big.mp4')).size);
  });

  await t.test('[C-01] 서버 변환 대기열: 동시 2개, 사용자당 2개, 너무 긴 영상 거절', async () => {
    assert.equal(MAX_TRANSCODES, 2);
    // 내용이 서로 다른 1080p 영상 4개(변환본이 따로 생기도록 소리 높이를 바꾼다)
    for (const hz of [300, 500, 700, 900]) {
      ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=24:duration=3', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f(`q${hz}.mp4`));
    }
    const ua = createUser(s.db);
    const ub = createUser(s.db);
    const ca = client(s.url, sessionFor(s.db, ua.id));
    const cb = client(s.url, sessionFor(s.db, ub.id));
    const v1 = await add(ua, null, 'q1.mp4', f('q300.mp4'));
    const v2 = await add(ua, null, 'q2.mp4', f('q500.mp4'));
    const v3 = await add(ua, null, 'q3.mp4', f('q700.mp4'));
    const w = await add(ub, null, 'w.mp4', f('q900.mp4'));
    for (const [c, v] of [[ca, v1], [ca, v2], [ca, v3], [cb, w]]) assert.equal((await c.get(`/api/media/${v.id}/info`)).status, 200); // 분석을 미리 캐시
    const prep = (c, v) => c.get(`/api/media/${v.id}/prepare?quality=720p`);
    assert.equal((await prep(ca, v1)).body.status, 'preparing');
    assert.equal((await prep(ca, v2)).body.status, 'preparing');
    const third = await prep(ca, v3);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'too_many_jobs');
    const other = await prep(cb, w); // 슬롯 2개가 찼으니 다른 사용자는 대기열
    assert.equal(other.body.status, 'preparing');
    assert.equal(other.body.queued, true);
    await waitReady(ca, `/api/media/${v1.id}/prepare?quality=720p`);
    await waitReady(ca, `/api/media/${v2.id}/prepare?quality=720p`);
    await waitReady(cb, `/api/media/${w.id}/prepare?quality=720p`);
    await waitReady(ca, `/api/media/${v3.id}/prepare?quality=720p`); // 앞선 변환이 끝나면 다시 받는다
    // 다시 인코딩해야 하는 아주 긴 영상은 거절(분석 결과를 직접 넣어 흉내)
    fs.writeFileSync(f('long.bin'), 'long-video');
    const long = await add(ua, null, 'long.mkv', f('long.bin'));
    s.db.prepare('INSERT OR REPLACE INTO media_probe (hash, data, created_at) VALUES (?,?,?)').run(
      long.blob_hash,
      JSON.stringify({ format: 'matroska,webm', duration: MAX_ENCODE_SEC + 60, bitRate: 1e6, width: 1920, height: 1080, videoCodec: 'hevc', hdr: false, audio: [], subs: [] }),
      Date.now(),
    );
    const lr = await prep(ca, long);
    assert.equal(lr.status, 422);
    assert.equal(lr.body.error, 'too_long');
  });

  await t.test('[C-01] 지역 프리미엄은 고비트레이트 원본 대신 720p', async () => {
    const reg = createUser(s.db, { premium: true, tier: 'regional' });
    const cr = client(s.url, sessionFor(s.db, reg.id));
    fs.writeFileSync(f('hi.bin'), 'high-bitrate');
    const v = await add(reg, null, 'hi.mp4', f('hi.bin'));
    s.db.prepare('INSERT OR REPLACE INTO media_probe (hash, data, created_at) VALUES (?,?,?)').run(
      v.blob_hash,
      JSON.stringify({ format: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 2, bitRate: 30e6, width: 1920, height: 1080, videoCodec: 'h264', hdr: false, audio: [{ index: 0, codec: 'aac' }], subs: [] }),
      Date.now(),
    );
    assert.deepEqual((await cr.get(`/api/media/${v.id}/info`)).body.qualities, ['720p']);
    const o = await cr.get(`/api/media/${v.id}/stream?quality=original`);
    assert.equal(o.status, 403);
    assert.equal(o.body.error, 'quality_unavailable');
  });

  await t.test('[C-01] 연결 앱 토큰 권한(G-05)과 비로그인 차단', async () => {
    const svc = createToken(s.db, free.id, { name: 'svc', scopes: ['services'] }).token;
    for (const p of [`/api/media/${a1.id}/stream`, `/api/media/${a1.id}/info`, `/api/media/${a1.id}/prepare`, `/api/media/${a1.id}/external-url`, `/api/media/${pic.id}/thumb`, `/api/media/${movie.id}/subtitles/e0.vtt`, '/api/media/history']) {
      assert.equal((await fetchBin(p, svc)).status, 403, p);
    }
    assert.equal((await fetchBin(`/api/media/${a1.id}/stream`, null, { range: 'bytes=0-9' })).status, 401);
    const cr = client(s.url, createToken(s.db, free.id, { name: 'rd', scopes: ['files:read'] }).token);
    assert.equal((await cr.get(`/api/media/${a1.id}/info`)).status, 200);
    assert.equal((await cr.post('/api/media/history', { fileId: a1.id, position: 1 })).status, 403);
    assert.equal((await cr.del('/api/media/history')).status, 403);
    assert.equal((await cr.del(`/api/media/history/${a1.id}`)).status, 403);
    const pr = client(s.url, createToken(s.db, prem.id, { name: 'rd', scopes: ['files:read'] }).token);
    assert.equal((await pr.post('/api/media/unzip', { fileId: premBig.id })).body.error, 'insufficient_scope');
  });

  await t.test('[C-01] 스트리밍 속도: 무료 연결당 2MB/s, 쿼터 초과·만료 후 초과면 감속', async () => {
    fs.writeFileSync(f('big.txt'), 'a'.repeat(3 * 1024 * 1024));
    const timed = async (user, range) => {
      const n = await add(user, null, 'big.txt', f('big.txt'));
      const t0 = Date.now();
      const r = await fetchBin(`/api/media/${n.id}/stream`, sessionFor(s.db, user.id), range ? { range } : {});
      assert.ok(r.status === 200 || r.status === 206, String(r.status));
      return Date.now() - t0;
    };
    assert.ok((await timed(free)) >= 1000); // 3MB ÷ 2MB/s ≈ 1.5초
    const over = createUser(s.db);
    addUsage(s.db, over.id, 'down', LIMITS.free.dailyDown + 1);
    assert.ok((await timed(over, 'bytes=0-199999')) >= 1500); // 200KB ÷ 100KB/s ≈ 2초
    const late = createUser(s.db);
    saveSettings(s.db, late.id, { expiryStage: 3 });
    assert.ok((await timed(late, 'bytes=0-199999')) >= 1500); // 재생 대상이 아닌 파일도 감속
  });

  await t.test('[C-02] HDR 영상 표시(웹은 SDR 재생)', async () => {
    const r = await cp.get(`/api/media/${premHdr.id}/info`);
    assert.equal(r.body.hdr, true);
    assert.equal((await cf.get(`/api/media/${a1.id}/info`)).body.hdr, false);
  });

  await t.test('[C-07] 내장·외부 자막 VTT, 오디오 트랙 선택 리먹스', async () => {
    const info = (await cf.get(`/api/media/${movie.id}/info`)).body;
    const ids = info.subtitles.map((x) => `${x.source}:${x.id}`);
    assert.deepEqual(ids, ['embedded:e0', `sidecar:${srt.id}`]);
    const emb = await cf.get(`/api/media/${movie.id}/subtitles/e0.vtt`);
    assert.equal(emb.status, 200);
    assert.match(emb.body, /^WEBVTT/);
    assert.match(emb.body, /안녕하세요/);
    const side = await cf.get(`/api/media/${movie.id}/subtitles/${srt.id}.vtt`);
    assert.match(side.body, /^WEBVTT/);
    assert.match(side.body, /00:00:01\.000 --> 00:00:02\.000/);
    assert.equal((await cf.get(`/api/media/${movie.id}/subtitles/e9.vtt`)).status, 404);
    assert.equal((await cf.get(`/api/media/${movie.id}/stream?audio=5`)).status, 400);
    await waitReady(cf, `/api/media/${movie.id}/prepare?quality=720p&audio=1`);
    const r = await fetchBin(`/api/media/${movie.id}/stream?quality=720p&audio=1`, freeTok);
    assert.equal(r.status, 200);
    fs.writeFileSync(f('track1.mp4'), r.buf);
    const st = probe(f('track1.mp4')).streams;
    assert.deepEqual(st.filter((x) => x.codec_type === 'audio').map((x) => x.tags?.language), ['eng']);
    assert.equal(st.find((x) => x.codec_type === 'video').height, 720);
  });

  await t.test('[C-05] 썸네일·이미지/텍스트/PDF 미리보기 정보', async () => {
    const usedDown = () => s.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM quota_usage WHERE user_id=? AND kind='down'").get(free.id).n;
    await new Promise((ok) => setTimeout(ok, 100));
    const before = usedDown();
    for (const id of [movie.id, pic.id]) {
      const r = await fetchBin(`/api/media/${id}/thumb`, freeTok);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'image/jpeg');
      fs.writeFileSync(f('thumb.jpg'), r.buf);
      assert.equal(probe(f('thumb.jpg')).streams[0].width, 320);
    }
    assert.equal((await cf.get(`/api/media/${srt.id}/thumb`)).status, 404);
    assert.equal(usedDown(), before); // 썸네일은 쿼터를 차감하지 않는다
    const img = await cf.get(`/api/media/${pic.id}/info`);
    assert.equal(img.body.kind, 'image');
    assert.equal(img.body.siblings.prevId, null); // 같은 폴더의 이미지는 하나뿐
    const txt = await cf.get(`/api/media/${srt.id}/info`);
    assert.equal(txt.body.kind, 'text');
    const body = await fetchBin(`/api/media/${srt.id}/stream`, freeTok, { range: 'bytes=0-1048575' });
    assert.equal(body.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(body.buf.toString(), /안녕하세요/);
    const html = await add(free, null, 'x.html', f('in.srt'), 'text/html');
    assert.equal((await fetchBin(`/api/media/${html.id}/stream`, freeTok)).headers.get('content-type'), 'text/plain; charset=utf-8');
    fs.writeFileSync(f('doc.pdf'), '%PDF-1.4\n%%EOF\n');
    const pdf = await add(free, null, 'doc.pdf', f('doc.pdf'));
    assert.equal((await cf.get(`/api/media/${pdf.id}/info`)).body.kind, 'pdf');
    assert.equal((await fetchBin(`/api/media/${pdf.id}/stream`, freeTok)).headers.get('content-type'), 'application/pdf');
    // 보내는 이미지에는 sandbox CSP 를 붙인다
    const pi = await fetchBin(`/api/media/${pic.id}/stream`, freeTok);
    assert.equal(pi.headers.get('content-type'), 'image/jpeg');
    assert.match(pi.headers.get('content-security-policy'), /sandbox/);
    // SVG 는 대소문자·매개변수가 달라도 미리보기·재생 대상이 아니다(저장형 XSS 방지)
    fs.writeFileSync(f('x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const [name, mime] of [['cat', 'image/SVG+XML'], ['pic2.dat', 'image/svg+xml; charset=utf-8'], ['logo.svg', null]]) {
      const n = await add(free, null, name, f('x.svg'), mime);
      assert.equal((await cf.get(`/api/media/${n.id}/info`)).body.kind, 'other', name);
      assert.equal((await fetchBin(`/api/media/${n.id}/stream`, freeTok)).status, 415, name);
      assert.equal((await cf.get(`/api/media/${n.id}/external-url`)).status, 400, name);
      assert.equal((await cf.get(`/api/media/${n.id}/thumb`)).status, 404, name);
    }
  });

  await t.test('[C-03] 외부 플레이어: 로그인 없이 쓰는 서명 URL', async () => {
    const r = await cf.get(`/api/media/${a1.id}/external-url`);
    assert.equal(r.status, 200);
    const { url } = r.body;
    assert.equal(r.body.potplayer, `potplayer://${url}`);
    assert.equal(r.body.vlc, `vlc://${url}`);
    assert.equal(r.body.mimic, `mimic://play?url=${encodeURIComponent(url)}`);
    assert.ok(r.body.expiresAt - Date.now() > 5.9 * 3600_000);
    const res = await fetch(url, { headers: { range: 'bytes=0-9' } });
    assert.equal(res.status, 206);
    assert.equal((await res.arrayBuffer()).byteLength, 10);
    // 영상은 sandbox 없이 media-src 만 연다(데스크톱 앱·브라우저 주소창에서 바로 재생)
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; media-src 'self'");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const bad = url.replace(/\.([A-Za-z0-9_-]+)\//, '.AAAA$1/');
    assert.equal((await fetch(bad)).status, 403);
    const multibyte = url.replace(/\.([A-Za-z0-9_-]+)\//, `.${encodeURIComponent('é'.repeat(43))}/`);
    assert.equal((await fetch(multibyte)).status, 403);
  });

  await t.test('[C-06] 시청 기록 저장·목록·삭제', async () => {
    assert.equal((await cf.post('/api/media/history', { fileId: movie.id, position: 'x' })).status, 400);
    assert.equal((await cp.post('/api/media/history', { fileId: movie.id, position: 1 })).status, 404);
    assert.equal((await cf.post('/api/media/history', { fileId: movie.id, position: 1.5, duration: 2 })).status, 200);
    assert.equal((await cf.post('/api/media/history', { fileId: a1.id, position: 0.5, duration: 2 })).status, 200);
    const list = (await cf.get('/api/media/history')).body.items;
    assert.deepEqual(list.map((x) => x.fileId), [a1.id, movie.id]);
    assert.equal(list[1].position, 1.5);
    assert.equal(list[1].file.name, '02 movie.mkv');
    assert.equal((await cp.get('/api/media/history')).body.items.length, 0);
    await cf.del(`/api/media/history/${a1.id}`);
    assert.deepEqual((await cf.get('/api/media/history')).body.items.map((x) => x.fileId), [movie.id]);
  });

  await t.test('[C-04] 플레이어: 이어보기 위치·화질 목록·이전/다음', async () => {
    const r = (await cf.get(`/api/media/${movie.id}/info`)).body;
    assert.equal(r.history.position, 1.5);
    assert.deepEqual(r.qualities, ['720p']);
    assert.ok(r.siblings.prevId && r.siblings.nextId);
    const last = (await cf.get(`/api/media/${big.id}/info`)).body;
    assert.equal(last.siblings.nextId, null);
    // 화면이 드라이브 목록 순서(사용자 정렬)로 이전/다음을 고르도록 같은 종류(영상·음악) 파일 id 를 준다. 자막·이미지는 빠진다
    assert.deepEqual(r.siblings.ids, [a1.id, movie.id, big.id]);
  });

  await t.test('[C-01] 만료 7일 후 초과 상태면 재생 차단', async () => {
    const u = createUser(s.db);
    saveSettings(s.db, u.id, { expiryStage: 3 });
    const c = client(s.url, sessionFor(s.db, u.id));
    const v = await add(u, null, 'v.mp4', f('small.mp4'));
    const r = await c.get(`/api/media/${v.id}/stream`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'playback_blocked');
    assert.equal((await c.get(`/api/media/${v.id}/info`)).body.playbackBlocked, true);
    assert.equal((await c.get(`/api/media/${v.id}/external-url`)).status, 403);
  });

  await t.test('[B-08] 온라인 압축 해제: 프리미엄 전용, 폴더 구조 유지, 경로 이탈 차단', async () => {
    const zip = new AdmZip();
    zip.addFile('사진/a.txt', Buffer.from('하나'));
    zip.addFile('사진/깊은/b.txt', Buffer.from('둘'));
    zip.addFile('c.txt', Buffer.from('셋'));
    zip.addFile('evil.txt', Buffer.from('nope'));
    zip.addFile('zeros.bin', Buffer.alloc(5 * 1024 * 1024)); // 압축률 1000:1 가량 → 압축 폭탄으로 보고 건너뜀
    zip.getEntry('c.txt').header.method = 0; // 압축하지 않고 저장된 항목
    zip.getEntries().find((e) => e.entryName === 'evil.txt').entryName = '../../evil.txt';
    zip.writeZip(f('pack.zip'));
    const zf = await add(free, null, '묶음.zip', f('pack.zip'));
    assert.equal((await cf.post('/api/media/unzip', { fileId: zf.id })).body.error, 'premium_required');
    const pz = await add(prem, null, '묶음.zip', f('pack.zip'));
    assert.equal((await cp.post('/api/media/unzip', { fileId: zf.id })).status, 404); // 남의 파일
    assert.equal((await cp.post('/api/media/unzip', { fileId: pz.id, parentId: { x: 1 } })).status, 400);
    const r = await cp.post('/api/media/unzip', { fileId: pz.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.files, 3);
    assert.equal(r.body.skipped, 2);
    assert.equal(r.body.folder.name, '묶음');
    assert.equal(r.body.folder.origin, 'unzip');
    const top = listChildren(s.db, prem.id, r.body.folder.id);
    assert.deepEqual(top.map((x) => x.name).sort(), ['c.txt', '사진']);
    const photos = listChildren(s.db, prem.id, top.find((x) => x.name === '사진').id);
    assert.deepEqual(photos.map((x) => x.name).sort(), ['a.txt', '깊은']);
    const blobText = (n) => fs.readFileSync(blobPath(s.cfg, n.blob_hash), 'utf8');
    assert.equal(blobText(top.find((x) => x.name === 'c.txt')), '셋');
    assert.equal(blobText(photos.find((x) => x.name === 'a.txt')), '하나');
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM files WHERE user_id=? AND name='evil.txt'").get(prem.id).n, 0);
    const txt = await add(prem, null, 'note.txt', f('in.srt'));
    assert.equal((await cp.post('/api/media/unzip', { fileId: txt.id })).body.error, 'unsupported_archive');
    // 건너뛴 이유: 경로 이탈(unsafe)·압축 폭탄(tooLarge)
    assert.deepEqual(r.body.skippedBy, { unsafe: 1, tooLarge: 1 });
  });

  await t.test('[B-08] tar·tar.gz·gz 도 풀고, 7z·rar 는 형식 안내', async () => {
    const hdr = tarHeader;
    const entry = (name, text) => {
      const d = Buffer.from(text);
      return [hdr(name, d.length), d, Buffer.alloc((512 - (d.length % 512)) % 512)];
    };
    const tar = Buffer.concat([hdr('docs/', 0, '5'), ...entry('docs/a.txt', '가나다'), ...entry('b.txt', 'b'.repeat(700)), ...entry('../x.txt', 'no'), hdr('link', 0, '2'), Buffer.alloc(1024)]);
    fs.writeFileSync(f('pack.tar'), tar);
    fs.writeFileSync(f('pack.tgz'), zlib.gzipSync(tar));
    fs.writeFileSync(f('note.txt.gz'), zlib.gzipSync('압축된 글'));
    fs.writeFileSync(f('x.7z'), 'not really');
    for (const name of ['pack.tar', 'pack.tgz']) {
      const n = await add(prem, null, name, f(name));
      assert.deepEqual((await cp.get(`/api/media/${n.id}/info`)).body.archive, { format: name === 'pack.tar' ? 'tar' : 'tgz', supported: true });
      const r = await cp.post('/api/media/unzip', { fileId: n.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.files, 2);
      assert.deepEqual(r.body.skippedBy, { unsafe: 1, unsupported: 1 });
      assert.match(r.body.folder.name, /^pack( \(\d\))?$/); // 두 번째는 같은 이름이 있어 번호가 붙는다
      const top = listChildren(s.db, prem.id, r.body.folder.id);
      assert.deepEqual(top.map((x) => x.name).sort(), ['b.txt', 'docs']);
      const a = listChildren(s.db, prem.id, top.find((x) => x.name === 'docs').id)[0];
      assert.equal(fs.readFileSync(blobPath(s.cfg, a.blob_hash), 'utf8'), '가나다');
      assert.equal(top.find((x) => x.name === 'b.txt').size, 700);
    }
    const gz = await add(prem, null, 'note.txt.gz', f('note.txt.gz'));
    const g = await cp.post('/api/media/unzip', { fileId: gz.id });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const gf = listChildren(s.db, prem.id, g.body.folder.id)[0];
    assert.equal(gf.name, 'note.txt');
    assert.equal(fs.readFileSync(blobPath(s.cfg, gf.blob_hash), 'utf8'), '압축된 글');
    const z7 = await add(prem, null, 'x.7z', f('x.7z'));
    assert.deepEqual((await cp.get(`/api/media/${z7.id}/info`)).body.archive, { format: '7z', supported: false });
    assert.equal((await cp.post('/api/media/unzip', { fileId: z7.id })).body.error, 'unsupported_archive');
    fs.writeFileSync(f('broken.tar'), 'x'.repeat(600));
    const broken = await add(prem, null, 'broken.tar', f('broken.tar'));
    assert.equal((await cp.post('/api/media/unzip', { fileId: broken.id })).body.error, 'bad_archive');
  });

  await t.test('[C-03] 연결 앱 토큰으로 만든 외부 링크는 연결 앱 쿼터로 세고, 토큰을 끊으면 닫힌다', async () => {
    const u = createUser(s.db);
    const v = await add(u, null, 'v.mp4', f('big.mp4'));
    addUsage(s.db, u.id, 'down', 6 * 1024 ** 3, 'app'); // 무료 연결 앱 하루 5GB 초과
    const tk = createToken(s.db, u.id, { name: 'player', scopes: ['files:read'], appId: 'kodi' });
    const ext = await client(s.url, tk.token).get(`/api/media/${v.id}/external-url`);
    assert.equal(ext.status, 200);
    const appUsed = () => s.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM quota_usage WHERE user_id=? AND kind='down' AND source='app' AND period LIKE 'd:%'").get(u.id).n;
    const before = appUsed();
    const t0 = Date.now();
    const r = await fetch(ext.body.url, { headers: { range: 'bytes=0-49999' } });
    assert.equal(r.status, 206);
    await r.arrayBuffer();
    assert.ok(Date.now() - t0 >= 300, '감속(100KB/s)되어야 함'); // 50KB ÷ 100KB/s ≈ 0.5초
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(appUsed() - before, 50000);
    s.db.prepare('UPDATE personal_tokens SET revoked_at=? WHERE id=?').run(Date.now(), tk.id);
    const gone = await fetch(ext.body.url, { headers: { range: 'bytes=0-9' } });
    assert.equal(gone.status, 403);
    // 웹(세션)에서 만든 링크는 공식 앱 출처라 연결 앱 한도와 무관
    const web = await client(s.url, sessionFor(s.db, u.id)).get(`/api/media/${v.id}/external-url`);
    const t1 = Date.now();
    const w = await fetch(web.body.url, { headers: { range: 'bytes=0-49999' } });
    assert.equal(w.status, 206);
    await w.arrayBuffer();
    assert.ok(Date.now() - t1 < 300);
  });

  await t.test('[C-01] 변환 중에도 HLS 첫 조각부터 재생, 무료는 원본 조각 불가', async () => {
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=24:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=1200:duration=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('long1080.mp4'));
    const u = createUser(s.db);
    const tok = sessionFor(s.db, u.id);
    const c = client(s.url, tok);
    const v = await add(u, null, 'long.mp4', f('long1080.mp4'));
    let st;
    for (let i = 0; i < 400; i++) {
      st = (await c.get(`/api/media/${v.id}/prepare?quality=720p`)).body;
      if (st.hls || st.status === 'ready') break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    assert.equal(st.status, 'preparing', '변환이 끝나기 전에 HLS 주소가 나와야 함');
    assert.equal(st.hls, `/api/media/${v.id}/hls/720p-a0/index.m3u8`);
    assert.ok(st.hlsSeconds >= 6);
    const pl = await fetchBin(st.hls, tok);
    assert.equal(pl.status, 200);
    assert.match(pl.headers.get('content-type'), /^application\/vnd\.apple\.mpegurl/);
    const text = pl.buf.toString();
    assert.match(text, /#EXT-X-START:TIME-OFFSET=0/);
    assert.match(text, /#EXT-X-PLAYLIST-TYPE:EVENT/);
    const seg = /^seg-\d{5}\.ts$/m.exec(text)[0];
    const sg = await fetchBin(st.hls.replace('index.m3u8', seg), tok);
    assert.equal(sg.status, 200);
    assert.equal(sg.headers.get('content-type'), 'video/mp2t');
    fs.writeFileSync(f('seg.ts'), sg.buf);
    assert.equal(probe(f('seg.ts')).streams.find((x) => x.codec_type === 'video').height, 720);
    assert.equal((await fetchBin(`/api/media/${v.id}/hls/original-a0/index.m3u8`, tok)).status, 403); // 무료는 원본 조각 불가
    assert.equal((await fetchBin(`/api/media/${v.id}/hls/720p-a0/..%2Findex.m3u8`, tok)).status, 404);
    await waitReady(c, `/api/media/${v.id}/prepare?quality=720p`);
    assert.match((await fetchBin(st.hls, tok)).buf.toString(), /#EXT-X-ENDLIST/);
  });

  await t.test('[C-01] 보던 화면이 떠나면 실행 중인 변환도 멈춘다', async () => {
    const u = createUser(s.db);
    const c = client(s.url, sessionFor(s.db, u.id));
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f('stale.mp4'));
    const sv = await add(u, null, 'stale.mp4', f('stale.mp4'));
    assert.equal((await c.get(`/api/media/${sv.id}/prepare?quality=720p`)).body.status, 'preparing');
    const hash = s.db.prepare('SELECT blob_hash FROM files WHERE id=?').get(sv.id).blob_hash;
    const dir = path.join(s.cfg.dataDir, 'media', hash);
    const realNow = Date.now;
    try {
      for (let i = 0; i < 100 && !(await c.get(`/api/media/${sv.id}/prepare?quality=720p`)).body.progress; i++) await new Promise((ok) => setTimeout(ok, 50));
      Date.now = () => realNow() + 120_000; // 아무도 /prepare·HLS 를 부르지 않은 채 2분이 지난 것처럼
      for (let i = 0; i < 100 && fs.existsSync(path.join(dir, '720p-a0.hls')); i++) await new Promise((ok) => setTimeout(ok, 50));
    } finally {
      Date.now = realNow;
    }
    assert.ok(!fs.existsSync(path.join(dir, '720p-a0.mp4')), '변환이 끝나지 않고 멈춰야 함');
    assert.ok(!fs.existsSync(path.join(dir, '720p-a0.hls')), '조각도 지움');
    // 다시 열면 처음부터 다시 준비한다(진행률 0 = 새 작업)
    const again = (await c.get(`/api/media/${sv.id}/prepare?quality=720p`)).body;
    assert.equal(again.status, 'preparing');
    assert.equal(again.progress, 0);
    await waitReady(c, `/api/media/${sv.id}/prepare?quality=720p`);
  });

  await t.test('[C-01] 세로 영상은 짧은 변 기준 720p', async () => {
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=24:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f('portrait.mp4'));
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=24:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f('tall.mp4'));
    const pv = await add(free, null, 'portrait.mp4', f('portrait.mp4'));
    const r = await fetchBin(`/api/media/${pv.id}/stream`, freeTok);
    assert.equal(r.status, 200);
    assert.equal(r.buf.length, fs.statSync(f('portrait.mp4')).size); // 720p 급이라 원본 그대로
    const tv = await add(free, null, 'tall.mp4', f('tall.mp4'));
    await waitReady(cf, `/api/media/${tv.id}/prepare?quality=720p`);
    fs.writeFileSync(f('tall720.mp4'), (await fetchBin(`/api/media/${tv.id}/stream?quality=720p`, freeTok)).buf);
    const st = probe(f('tall720.mp4')).streams.find((x) => x.codec_type === 'video');
    assert.deepEqual([st.width, st.height], [720, 1280]);
  });

  await t.test('[C-02] HDR 은 SDR(BT.709)로 톤 매핑, 다시 인코딩이 필요하면 프리미엄도 기본 720p', async () => {
    const info = (await cp.get(`/api/media/${premHdr.id}/info`)).body;
    assert.equal(info.defaultQuality, '720p');
    assert.equal((await cp.get(`/api/media/${premBig.id}/info`)).body.defaultQuality, 'original');
    await waitReady(cp, `/api/media/${premHdr.id}/prepare?quality=original`);
    fs.writeFileSync(f('sdr.mp4'), (await fetchBin(`/api/media/${premHdr.id}/stream?quality=original`, premTok)).buf);
    const st = probe(f('sdr.mp4')).streams.find((x) => x.codec_type === 'video');
    assert.equal(st.color_transfer, 'bt709');
    assert.equal(st.color_primaries, 'bt709');
  });

  await t.test('[C-07] 같은 폴더의 다른 자막 파일도 고를 수 있다', async () => {
    const other = await add(free, dir.id, 'korean_subs.srt', f('in.srt'));
    const info = (await cf.get(`/api/media/${movie.id}/info`)).body;
    assert.deepEqual(info.subtitleFiles.map((x) => x.id), [other.id]);
    assert.ok(!info.subtitles.some((x) => x.id === other.id));
    assert.equal((await cf.get(`/api/media/${movie.id}/subtitles/${other.id}.vtt`)).status, 200);
  });

  await t.test('[C-06] 영상·음악이 아닌 파일은 시청 기록에 남지 않는다', async () => {
    const r = await cf.post('/api/media/history', { fileId: pic.id, position: 1 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'not_playable');
  });

  await t.test('[B-08] 항목 수·경로가 지나친 zip·tar 는 중앙 디렉터리·머리글을 다 읽기 전에 거절', async () => {
    const up = async (name, buf) => {
      fs.writeFileSync(f(name), buf);
      return cp.post('/api/media/unzip', { fileId: (await add(prem, null, name, f(name))).id });
    };
    // 끝 머리글이 항목 6만 개라고 하는 zip: adm-zip 이 항목을 읽기 전에 413(읽었다면 손상 400)
    const one = new AdmZip();
    one.addFile('a.txt', Buffer.from('a'));
    const many = one.toBuffer();
    many.writeUInt16LE(60000, many.length - 22 + 8);
    many.writeUInt16LE(60000, many.length - 22 + 10);
    assert.equal((await up('many.zip', many)).body.error, 'archive_too_large');
    // 수천 단계 깊은 경로 하나(adm-zip 이 상위 폴더마다 큰 객체를 만든다)
    const deep = new AdmZip();
    deep.addFile('a/'.repeat(2000) + 'f.txt', Buffer.from('x'));
    assert.equal((await up('deep.zip', deep.toBuffer())).body.error, 'archive_too_large');
    // 각각은 짧아도 긴 경로가 많으면(이름마다 깊이×길이의 합) 거절
    const chain = Array.from({ length: 20 }, (_, j) => `d${j}`.padEnd(48, 'x')).join('/');
    const wide = new AdmZip();
    for (let k = 0; k < 2000; k++) wide.addFile(`${chain}/f${k}.txt`, Buffer.alloc(0));
    assert.equal((await up('wide.zip', wide.toBuffer())).body.error, 'archive_too_large');
    // 머리글만 가득한 tar
    const tar = Buffer.concat([...Array.from({ length: 10_002 }, (_, i) => tarHeader(`e${i}`, 0)), Buffer.alloc(1024)]);
    assert.equal((await up('headers.tar', tar)).body.error, 'archive_too_large');
  });

  await t.test('[C-05] 저장된 형식이 없어도 확장자로 영상·음악을 알아본다(mka·m2ts·ogv 등)', async () => {
    for (const [name, kind] of [['a.mka', 'audio'], ['b.m2ts', 'video'], ['c.mts', 'video'], ['d.ogv', 'video'], ['e.oga', 'audio'], ['f.aiff', 'audio'], ['g.aif', 'audio'], ['h.ape', 'audio'], ['i.ac3', 'audio'], ['j.dts', 'audio']]) {
      const n = await add(free, null, name, f('in.srt'), 'application/octet-stream');
      assert.equal((await cf.get(`/api/media/${n.id}/info`)).body.kind, kind, name);
    }
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=1', '-map', '0', '-map', '1', '-c:a', 'aac', f('two.mka'));
    const mka = await add(free, null, 'two.mka', f('two.mka'));
    const info = (await cf.get(`/api/media/${mka.id}/info`)).body;
    assert.equal(info.kind, 'audio');
    assert.equal(info.audioTracks.length, 2);
  });

  await t.test('[C-07] 그림 자막(PGS 등)은 목록에서 빠지되 개수를 알려 준다', async () => {
    assert.equal((await cf.get(`/api/media/${movie.id}/info`)).body.imageSubtitles, 0);
    fs.writeFileSync(f('bluray.mkv'), 'pgs only ' + Date.now());
    const v = await add(free, null, 'bluray.mkv', f('bluray.mkv'));
    const pr = { format: 'matroska,webm', duration: 1, bitRate: 1, width: 1920, height: 1080, videoCodec: 'h264', hdr: false, audio: [], subs: [{ index: 0, codec: 'hdmv_pgs_subtitle', text: false, lang: 'kor', title: null }] };
    s.db.prepare('INSERT OR REPLACE INTO media_probe (hash, data, created_at) VALUES (?,?,?)').run(v.blob_hash, JSON.stringify(pr), Date.now());
    const info = (await cf.get(`/api/media/${v.id}/info`)).body;
    assert.deepEqual(info.subtitles, []);
    assert.equal(info.imageSubtitles, 1);
  });

  await t.test('[C-03] 미믹 데스크톱 앱은 브라우저가 바로 재생하는 형식에만 권한다', async () => {
    assert.equal((await cf.get(`/api/media/${a1.id}/external-url`)).body.mimicPlayable, true); // H.264 mp4
    assert.equal((await cf.get(`/api/media/${movie.id}/external-url`)).body.mimicPlayable, false); // mkv
  });

  await t.test('[F-05] 미디어 전송도 요청한 길이로 쿼터를 본다(한도를 넘길 요청은 처음부터 감속)', async () => {
    const u = createUser(s.db);
    addUsage(s.db, u.id, 'down', LIMITS.free.dailyDown - 1000);
    const n = await add(u, null, 'big.txt', f('big.txt'));
    const tok = sessionFor(s.db, u.id);
    const head = (range) => fetch(`${s.url}/api/media/${n.id}/stream`, { method: 'HEAD', headers: { authorization: `Bearer ${tok}`, range } });
    assert.equal((await head('bytes=0-99')).headers.get('x-mimic-throttled'), null);
    assert.equal((await head('bytes=0-199999')).headers.get('x-mimic-throttled'), 'daily_quota');
    // 외부 플레이어 링크도 같은 규칙
    const v = await add(u, null, 'v.mp4', f('small.mp4'));
    const url = (await client(s.url, tok).get(`/api/media/${v.id}/external-url`)).body.url;
    assert.equal((await fetch(url, { method: 'HEAD', headers: { range: 'bytes=0-99' } })).headers.get('x-mimic-throttled'), null);
    assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('x-mimic-throttled'), 'daily_quota');
  });
});
