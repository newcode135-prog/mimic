import crypto from 'node:crypto';
import net from 'node:net';

export const now = () => Date.now();
export const newId = (prefix = '') => prefix + crypto.randomBytes(12).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomCode = (digits = 6) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
// 라우트 안에서 throw 하면 공통 오류 처리기가 { error, message } JSON 으로 응답한다
export const fail = (status, code, message) => {
  throw new HttpError(status, code, message);
};

export function json(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ponytail: 메모리 기반 속도 제한(프로세스 1개 기준). 서버를 여러 대로 늘리면 Redis 등으로 옮길 것
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const t = now();
  const hits = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(t);
  buckets.set(key, hits);
  return true;
}

// 쿼터 기간 키. 기본 KST(+9) 기준 하루·한 달
export function periodKeys(ts = now(), offsetMin = 540) {
  const iso = new Date(ts + offsetMin * 60000).toISOString();
  return { day: `d:${iso.slice(0, 10)}`, month: `m:${iso.slice(0, 7)}` };
}

export const DAY = 864e5;

// 내부망·루프백·링크로컬·멀티캐스트 주소인지(SSRF 차단: 클라우드 다운로드·웹 푸시가 같이 쓴다)
const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, p, 'ipv6');
export function isPrivateIp(ip) {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return net.isIPv4(v4) ? PRIVATE.check(v4, 'ipv4') : PRIVATE.check(ip, 'ipv6');
}
