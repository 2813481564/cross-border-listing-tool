import fs from 'node:fs';
import path from 'node:path';

function imageSize(buf) {
  if (!buf || buf.length < 24) return null;

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  }

  // JPEG：扫描 SOFn 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), type: 'jpeg' };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
    return null;
  }

  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    if (fmt === 'VP8X') {
      return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1, type: 'webp' };
    }
  }
  return null;
}

const offerId = process.argv[2];
const kind = process.argv[3] ?? 'main';
const dir = path.join('data/media', offerId, kind);
if (!fs.existsSync(dir)) {
  console.log(`目录不存在：${dir}`);
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
console.log(`${offerId}/${kind} 共 ${files.length} 个文件\n`);

for (const file of files) {
  const buf = fs.readFileSync(path.join(dir, file));
  const size = imageSize(buf);
  if (!size) {
    console.log(`${file}  ？无法识别  ${(buf.length / 1024).toFixed(0)}KB`);
    continue;
  }
  const ratio = size.w / size.h;
  const okRatio = Math.abs(ratio - 1) < 0.02 || Math.abs(ratio - 0.75) < 0.02;
  const okSize = size.w > 480 && size.h > 480;
  const flag = okRatio && okSize ? 'OK ' : 'BAD';
  console.log(
    `${flag} ${file}  ${size.w}x${size.h} (${ratio.toFixed(2)})  ${(buf.length / 1024).toFixed(0)}KB`
  );
}
