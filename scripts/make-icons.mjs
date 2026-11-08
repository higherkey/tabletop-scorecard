import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');
const GREEN = [0x1f, 0x6f, 0x5c];
const WHITE = [255, 255, 255];
const SUPERSAMPLE = 4;
const DESIGN = 512;

const BARS = [143, 205, 267, 329].map((x) => ({ x, y: 143, w: 30, h: 226, r: 15 }));
const STROKE = { x1: 113, y1: 338, x2: 399, y2: 174, half: 15 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function distToSegment(px, py, s) {
  const vx = s.x2 - s.x1;
  const vy = s.y2 - s.y1;
  const t = Math.min(1, Math.max(0, ((px - s.x1) * vx + (py - s.y1) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(s.x1 + t * vx - px, s.y1 + t * vy - py);
}

function inArtwork(px, py) {
  for (const b of BARS) {
    if (inRoundRect(px, py, b.x, b.y, b.w, b.h, b.r)) return true;
  }
  return distToSegment(px, py, STROKE) <= STROKE.half;
}

function inBackground(px, py, rounded) {
  return rounded ? inRoundRect(px, py, 0, 0, DESIGN, DESIGN, 112) : true;
}

function render(size, { rounded, artScale }) {
  const out = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = ((x + (sx + 0.5) / SUPERSAMPLE) / size) * DESIGN;
          const py = ((y + (sy + 0.5) / SUPERSAMPLE) / size) * DESIGN;
          const qx = (px - DESIGN / 2) / artScale + DESIGN / 2;
          const qy = (py - DESIGN / 2) / artScale + DESIGN / 2;
          let color;
          if (inArtwork(qx, qy)) color = WHITE;
          else if (inBackground(px, py, rounded)) color = GREEN;
          else continue;
          r += color[0];
          g += color[1];
          b += color[2];
          hits++;
        }
      }
      if (hits === 0) continue;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / hits);
      out[i + 1] = Math.round(g / hits);
      out[i + 2] = Math.round(b / hits);
      out[i + 3] = Math.round((255 * hits) / samples);
    }
  }
  return out;
}

const OUTPUTS = [
  { file: 'icon-192.png', size: 192, rounded: true, artScale: 1 },
  { file: 'icon-512.png', size: 512, rounded: true, artScale: 1 },
  { file: 'apple-touch-icon.png', size: 180, rounded: false, artScale: 1 },
  { file: 'icon-maskable-512.png', size: 512, rounded: false, artScale: 0.7 },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, rounded, artScale } of OUTPUTS) {
  const png = encodePng(size, size, render(size, { rounded, artScale }));
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`Wrote icons/${file} (${size}x${size}, ${png.length} bytes)`);
}
