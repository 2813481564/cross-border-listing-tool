/**
 * 读取本地图片的像素尺寸（不依赖第三方库）。
 * 支持 JPEG / PNG / WebP，读不懂返回 null。
 */

import fs from 'node:fs';

export function sizeFromBuffer(buf) {
  if (!buf || buf.length < 24) return null;

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }

  // JPEG：扫 SOFn 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          width: buf.readUInt16BE(i + 7),
          height: buf.readUInt16BE(i + 5),
          format: 'jpeg'
        };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }

  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    }
    if (fmt === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
    }
    if (fmt === 'VP8X') {
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1, format: 'webp' };
    }
  }

  return null;
}

/** 读文件尺寸与体积；失败返回 null。 */
export function readImageInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const buf = fs.readFileSync(filePath);
    const size = sizeFromBuffer(buf);
    if (!size) return null;
    return { ...size, bytes: stat.size, filePath };
  } catch {
    return null;
  }
}
