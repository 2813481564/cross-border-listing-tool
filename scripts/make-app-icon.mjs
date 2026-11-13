/**
 * 生成阿里开放平台应用图标（64×64 PNG，圆角 5px）。
 *
 * 用法：node scripts/make-app-icon.mjs [输出路径]
 * 默认输出 dist/应用图标64.png
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIZE = 64;
const RADIUS = 5;
const BG = [31, 111, 235]; // #1F6FEB
const FG = [255, 255, 255];

const pixels = new Uint8Array(SIZE * SIZE * 4); // RGBA

function setPixel(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = a;
}

/** 圆角矩形填充（含抗锯齿的简化处理：边缘 1px 半透明） */
function roundRect(x0, y0, w, h, radius, color) {
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x0 + x;
      const py = y0 + y;
      // 距离最近的内角圆心
      const cx = Math.min(Math.max(px, x0 + radius), x0 + w - 1 - radius);
      const cy = Math.min(Math.max(py, y0 + radius), y0 + h - 1 - radius);
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius - 0.5) setPixel(px, py, color);
      else if (dist <= radius + 0.5) setPixel(px, py, color, 140);
    }
  }
}

// 背景：整块圆角矩形
roundRect(0, 0, SIZE, SIZE, RADIUS, BG);

// 图标主体：三条清单横条 + 一个勾
roundRect(16, 18, 26, 5, 2, FG);
roundRect(16, 30, 32, 5, 2, FG);
roundRect(16, 42, 20, 5, 2, FG);

// 右下角的勾（用两条斜线像素绘制）
for (let t = 0; t < 10; t += 1) {
  setPixel(44 + Math.round(t * 0.8), 40 + t, FG);
  setPixel(44 + Math.round(t * 0.8) + 1, 40 + t, FG);
}
for (let t = 0; t < 14; t += 1) {
  setPixel(51 + Math.round(t * 0.55), 47 - t, FG);
  setPixel(51 + Math.round(t * 0.55) + 1, 47 - t, FG);
}

/* ---------- PNG 编码 ---------- */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// 每行前置 filter 字节 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = process.argv[2] ?? path.join('dist', '应用图标64.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`已生成 ${out}（${SIZE}x${SIZE}，${(png.length / 1024).toFixed(1)}KB）`);
