// 앱 아이콘 PNG 생성(K-09). web/logo.svg 와 같은 도형을 직접 그려 PNG 로 저장한다.
// 이 PC 의 ffmpeg 는 SVG 를 읽지 못해(librsvg 없음) node:zlib 으로 PNG 를 만든다.
// 실행: node scripts/make-icons.mjs  → web/icons/*.png, desktop/icon.png
// logo.svg 를 바꾸면 아래 도형 값도 같이 바꾸고 다시 실행한다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const TEAL = [15, 157, 143];
const WHITE = [255, 255, 255];
const ORANGE = [255, 138, 61];
const SS = 4; // 픽셀당 4x4 표본(가장자리 부드럽게)

// logo.svg (64x64 좌표): 둥근 사각형, "m" 모양 선(굵기 5, 둥근 끝), 주황 점
const segs = [
  [15, 44, 15, 27],
  [29, 27, 29, 44],
  [43, 27, 43, 44],
];
const arcs = [
  [22, 27, 7],
  [36, 27, 7],
]; // 위쪽 반원(중심 x, y, 반지름)

const distSeg = (x, y, [ax, ay, bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const distArc = (x, y, [cx, cy, r]) => (y <= cy ? Math.abs(Math.hypot(x - cx, y - cy) - r) : Math.min(Math.hypot(x - cx + r, y - cy), Math.hypot(x - cx - r, y - cy)));
const inRoundRect = (x, y, x0, y0, x1, y1, rr) => {
  const qx = Math.max(x0 + rr - x, 0, x - (x1 - rr)), qy = Math.max(y0 + rr - y, 0, y - (y1 - rr));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && qx * qx + qy * qy <= rr * rr;
};

// 한 점(64 좌표)의 색 [r,g,b,a]. bleed: 배경을 가장자리까지 채움(maskable·iOS), scale: 글자 축소 비율
function colorAt(x, y, { bleed, scale }) {
  const gx = 32 + (x - 32) / scale, gy = 32 + (y - 32) / scale;
  if (!bleed && !inRoundRect(x, y, 2, 2, 62, 62, 18)) return [0, 0, 0, 0];
  if (Math.hypot(gx - 49, gy - 20) <= 5) return [...ORANGE, 255];
  if (Math.min(...segs.map((s) => distSeg(gx, gy, s)), ...arcs.map((a) => distArc(gx, gy, a))) <= 2.5) return [...WHITE, 255];
  return [...TEAL, 255];
}

export function render(size, opts) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    rows[py * (size * 4 + 1)] = 0; // 필터 없음
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt(((px + (sx + 0.5) / SS) * 64) / size, ((py + (sy + 0.5) / SS) * 64) / size, opts);
          r += c[0] * c[3], g += c[1] * c[3], b += c[2] * c[3], a += c[3];
        }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      rows[o] = a ? Math.round(r / a) : 0;
      rows[o + 1] = a ? Math.round(g / a) : 0;
      rows[o + 2] = a ? Math.round(b / a) : 0;
      rows[o + 3] = Math.round(a / (SS * SS));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8비트 RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const plain = { bleed: false, scale: 1 };
const full = { bleed: true, scale: 0.8 }; // maskable 안전 영역(지름 80%) 안에 글자가 들어가게
const out = [
  ['web/icons/icon-192.png', 192, plain],
  ['web/icons/icon-512.png', 512, plain],
  ['web/icons/maskable-512.png', 512, full],
  ['web/icons/apple-touch-icon.png', 180, full], // iOS 는 투명 배경을 검게 칠하므로 가득 채움
  ['desktop/icon.png', 512, plain], // electron-builder 설치본·트레이 아이콘
];
for (const [file, size, opts] of out) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), render(size, opts));
  console.log(`${file} ${size}x${size}`);
}
