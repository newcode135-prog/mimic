// ffmpeg·ffprobe 실행 도우미. 바이너리 위치는 FFMPEG_PATH·FFPROBE_PATH 환경변수로 바꿀 수 있다.
import { spawn } from 'node:child_process';
import { HttpError } from '../../core/util.js';

const BIN = { ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.FFPROBE_PATH || 'ffprobe' };
const children = new Set();

const missing = (name) => new HttpError(503, `${name}_missing`, `서버에 ${name} 이(가) 설치되어 있지 않아 이 기능을 쓸 수 없습니다. 관리자에게 문의하세요.`);

// 실행 결과(stdout)를 Buffer 로 돌려준다. onLine 은 stdout 의 줄마다 불린다(-progress 진행률용). timeoutMs 를 넘기거나 signal 이 취소되면 강제 종료
export function run(name, args, { onLine, timeoutMs = 0, cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN[name], args, { windowsHide: true, cwd });
    children.add(p);
    let timedOut = false;
    const timer = timeoutMs && setTimeout(() => ((timedOut = true), p.kill('SIGKILL')), timeoutMs);
    const abort = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    p.on('close', () => (clearTimeout(timer), signal?.removeEventListener('abort', abort)));
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => {
      out.push(d);
      if (onLine) for (const l of d.toString().split('\n')) onLine(l);
    });
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => {
      children.delete(p);
      reject(e.code === 'ENOENT' ? missing(name) : e);
    });
    p.on('close', (code) => {
      children.delete(p);
      if (code === 0) return resolve(Buffer.concat(out));
      if (signal?.aborted) return reject(new HttpError(409, 'media_cancelled', '변환을 멈췄습니다')); // 프로세스가 끝난 뒤라 만들던 파일을 지울 수 있다
      if (timedOut) return reject(new HttpError(422, 'media_timeout', '처리 시간이 너무 오래 걸려 중단했습니다. 외부 플레이어로 열어 보세요.'));
      if (err) console.error(`[media] ${name} 실패: ${err.trim().split('\n').at(-1)}`);
      reject(new HttpError(422, 'media_failed', '이 파일을 처리하지 못했습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다.'));
    });
  });
}
export const killAll = () => children.forEach((p) => p.kill('SIGKILL'));

// 동시 실행 수 제한. limit(fn) → fn 결과 Promise. waiting() 은 대기 중인 수
export function semaphore(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    q.shift()();
  };
  const limit = (fn) =>
    new Promise((resolve, reject) => {
      q.push(() =>
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          }),
      );
      next();
    });
  limit.waiting = () => q.length;
  return limit;
}

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

// ffprobe 결과를 화면·변환에 필요한 값만 남겨 요약한다(media_probe 에 이 모양으로 캐시)
export async function probe(file) {
  const p = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])).toString());
  const st = p.streams || [];
  const v = st.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const tags = (s) => ({ lang: s.tags?.language || null, title: s.tags?.title || null });
  return {
    format: p.format?.format_name || '',
    duration: Number(p.format?.duration) || null,
    bitRate: Number(p.format?.bit_rate) || null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    videoCodec: v?.codec_name ?? null,
    hdr: ['smpte2084', 'arib-std-b67'].includes(v?.color_transfer),
    audio: st.filter((s) => s.codec_type === 'audio').map((s, i) => ({ index: i, codec: s.codec_name, ...tags(s) })),
    subs: st.filter((s) => s.codec_type === 'subtitle').map((s, i) => ({ index: i, codec: s.codec_name, text: TEXT_SUBS.has(s.codec_name), ...tags(s) })),
  };
}

// 브라우저(Chrome)가 원본 그대로 재생할 수 있는지
export function browserPlayable(kind, ext, p) {
  const mp4 = /mov|mp4/.test(p.format);
  const ac = p.audio[0]?.codec;
  if (kind === 'audio') return (ext === 'webm' || !/matroska|avi|asf/.test(p.format)) && ['mp3', 'aac', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le'].includes(ac);
  if (mp4) return p.videoCodec === 'h264' && (!ac || ['aac', 'mp3'].includes(ac));
  return ext === 'webm' && ['vp8', 'vp9', 'av1'].includes(p.videoCodec) && (!ac || ['opus', 'vorbis'].includes(ac));
}

// 화질 기준은 짧은 변(세로 영상 720x1280 도 720p)
export const shortSide = (p) => Math.min(p.width || 0, p.height || 0);
// 영상을 다시 인코딩하지 않고 복사만 하면 되는지(H.264·SDR 이고 목표 화질 이하). HDR 은 SDR 로 바꿔야 해서 항상 다시 인코딩
export const copiesVideo = (p, height) => p.videoCodec === 'h264' && !p.hdr && (!height || shortSide(p) <= height);

export const HLS_SEC = 6; // HLS 조각 길이
// HDR(PQ·HLG) → SDR(BT.709) 톤 매핑
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

// 변환본 만들기 인자. 코덱이 맞으면 스트림 복사(리먹스), 아니면 H.264/AAC 로 다시 인코딩.
// hls=false: MP4(faststart) 하나. hls=true: 같은 인코딩으로 HLS(index.m3u8 + seg-NNNNN.ts, 첫 조각부터 재생)와 완성본 MP4 를 함께 만든다.
// hls 일 때 ffmpeg 는 HLS 폴더에서 실행하고 out 은 그 폴더 기준 상대 경로(tee 구문에 윈도 경로를 넣지 않으려고)
export function transcodeArgs(src, out, p, { kind, height, audio }, hls = false) {
  const a = p.audio[audio];
  const copyV = copiesVideo(p, height);
  const args = ['-v', 'error', '-y', '-nostats', '-progress', 'pipe:1', '-i', src];
  if (kind === 'video' && p.videoCodec) {
    args.push('-map', '0:v:0', '-c:v');
    if (copyV) args.push('copy');
    else {
      const vf = [];
      if (height) vf.push(`scale=w='trunc(iw*min(1,${height}/min(iw,ih))/2)*2':h='trunc(ih*min(1,${height}/min(iw,ih))/2)*2'`);
      if (p.hdr) vf.push(TONEMAP);
      args.push('libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', ...(vf.length ? ['-vf', vf.join(',')] : []));
      if (p.hdr) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
      if (hls) args.push('-force_key_frames', `expr:gte(t,n_forced*${HLS_SEC})`);
    }
  } else args.push('-vn');
  if (a) args.push('-map', `0:a:${audio}`, '-c:a', ...(['aac', 'mp3'].includes(a.codec) ? ['copy'] : ['aac', '-b:a', '160k', '-ac', '2']));
  args.push('-sn', '-dn');
  if (!hls) return [...args, '-movflags', '+faststart', '-f', 'mp4', out];
  return [...args, '-f', 'tee', `[f=hls:hls_time=${HLS_SEC}:hls_playlist_type=event:hls_flags=temp_file+independent_segments:hls_segment_filename=seg-%05d.ts]index.m3u8|[f=mp4:movflags=+faststart]${out}`];
}

// 가로 320 썸네일(JPEG). 영상은 앞 10% 지점(최대 10초)의 한 프레임
export const thumbArgs = (src, out, seekSec) => [
  '-v', 'error', '-y',
  ...(seekSec ? ['-ss', String(seekSec)] : []),
  '-i', src, '-frames:v', '1', '-vf', "scale='min(320,iw)':-2", '-q:v', '4', '-f', 'mjpeg', out,
];

export const subtitleArgs = (src, n) => ['-v', 'error', '-i', src, '-map', `0:s:${n}`, '-f', 'webvtt', 'pipe:1'];
