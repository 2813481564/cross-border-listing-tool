import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MEDIA_DIR, RAW_DIR, RESULT_DIR } from './config.mjs';
import { replaceAssets, getAssets, updateAsset } from './db.mjs';
import { readImageInfo, sizeFromBuffer } from './image-info.mjs';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const LIMITS = {
  image: 25 * 1024 * 1024,
  video: 500 * 1024 * 1024
};

function extFrom(url, contentType, isVideo) {
  const clean = String(url).split('?')[0];
  const m = clean.match(/\.(jpg|jpeg|png|webp|gif|mp4|m3u8|mov)$/i);
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  if (contentType) {
    if (/png/i.test(contentType)) return '.png';
    if (/webp/i.test(contentType)) return '.webp';
    if (/gif/i.test(contentType)) return '.gif';
    if (/mp4/i.test(contentType)) return '.mp4';
  }
  return isVideo ? '.mp4' : '.jpg';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * 把商品里所有媒体（展示图/规格图/详情图/视频）展开成待下载清单。
 * 每个条目同时保存网络地址与（下载后才有）本地地址。
 */
export function buildAssets(product) {
  const groups = product.imageGroups ?? { main: product.images ?? [], sku: [], detail: [] };

  // 同一组内可能重复：多个规格值共用一张图、详情图重复引用同一张。
  // assets 表对 (offer_id, kind, remote_url) 有唯一约束，只能保留一份文件；
  // 但「一张图对应多个规格值」必须记下来，否则这些规格值会找不到图。
  const assets = [];
  const byKey = new Map();
  const counters = { main: 0, sku: 0, detail: 0, video: 0 };

  const push = (kind, remoteUrl, label = null) => {
    if (!remoteUrl) return;
    const key = `${kind}|${remoteUrl}`;
    const existing = byKey.get(key);
    if (existing) {
      if (label) {
        const labels = new Set(String(existing.label ?? '').split(';').filter(Boolean));
        if (!labels.has(label)) {
          labels.add(label);
          existing.label = [...labels].join(';');
        }
      }
      return;
    }
    counters[kind] += 1;
    const asset = { kind, seq: counters[kind], remoteUrl, label };
    byKey.set(key, asset);
    assets.push(asset);
  };

  for (const url of groups.main ?? []) push('main', url);
  for (const s of groups.sku ?? []) push('sku', s.image, `${s.prop}=${s.name}`);
  for (const url of groups.detail ?? []) push('detail', url);
  for (const v of product.videos ?? []) push('video', v.url, v.videoId ? `video ${v.videoId}` : 'video');

  return assets;
}

export async function downloadOne(asset) {
  const isVideo = asset.kind === 'video';
  const dir = path.join(MEDIA_DIR, String(asset.offerId), asset.kind);
  fs.mkdirSync(dir, { recursive: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isVideo ? 120000 : 20000);

  try {
    const res = await fetch(asset.remoteUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://detail.1688.com/',
        Accept: isVideo ? 'video/*,*/*' : 'image/*,*/*'
      },
      signal: controller.signal,
      redirect: 'follow'
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    const buffer = Buffer.from(await res.arrayBuffer());

    const limit = isVideo ? LIMITS.video : LIMITS.image;
    if (buffer.length > limit) throw new Error(`文件过大 ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
    if (buffer.length < 512) throw new Error('文件过小，可能不是有效媒体');

    const ext = extFrom(asset.remoteUrl, contentType, isVideo);
    const filename = `${pad(asset.seq)}${ext}`;
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, buffer);

    return {
      localPath: `media/${asset.offerId}/${asset.kind}/${filename}`.replace(/\\/g, '/'),
      bytes: buffer.length,
      status: 'ok',
      error: null
    };
  } catch (err) {
    return {
      localPath: null,
      bytes: null,
      status: 'failed',
      error: err.name === 'AbortError' ? '下载超时' : err.message
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 并发下载，默认 5 条流水线 */
export async function downloadMany(assets, { concurrency = 5, onDone } = {}) {
  const results = [];
  let index = 0;

  const worker = async () => {
    while (index < assets.length) {
      const current = assets[index++];
      const result = await downloadOne(current);
      results.push({ asset: current, result });
      if (onDone) await onDone(current, result);
    }
  };

  const size = Math.min(concurrency, Math.max(assets.length, 1));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

/**
 * 采集完成后：登记媒体清单 → 下载本地副本。
 * 图片同步下载，视频放后台，避免一次采集卡太久。
 *
 * options.onProgress(done, total)：图片下载进度回调，任务队列靠它显示「图片 3/8」。
 */
export async function persistMedia(offerId, product, options = {}) {
  const { onProgress } = options;
  await replaceAssets(offerId, buildAssets(product));
  const rows = await getAssets(offerId);

  const images = rows.filter((a) => a.kind !== 'video');
  const videos = rows.filter((a) => a.kind === 'video');

  const apply = async (asset, result) => {
    await updateAsset(asset.id, {
      local_path: result.localPath,
      bytes: result.bytes,
      status: result.status,
      error: result.error
    });
  };

  let done = 0;
  const applyImage = async (asset, result) => {
    await apply(asset, result);
    done += 1;
    if (onProgress) onProgress(done, images.length);
  };

  if (onProgress) onProgress(0, images.length);
  await downloadMany(images, { concurrency: 5, onDone: applyImage });
  if (videos.length) {
    downloadMany(videos, { concurrency: 2, onDone: apply }).catch(() => {});
  }

  return getAssets(offerId);
}

// 商品 ID 会拼进文件路径，必须先挡掉 ../ 这类越界值
const OFFER_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

export function isValidOfferId(offerId) {
  return OFFER_ID_RE.test(String(offerId ?? ''));
}

const dimCache = new Map();

/** 为已下载的本地图片附加像素尺寸（带内存缓存，失败返回 null） */
export function attachImageDimensions(assets) {
  return (assets ?? []).map((asset) => {
    if (asset.kind === 'video' || asset.status !== 'ok' || !asset.localPath) {
      return { ...asset, width: null, height: null };
    }
    const key = String(asset.localPath);
    let dims = dimCache.get(key);
    if (!dims) {
      const target = path.resolve(DATA_DIR, key);
      const base = path.resolve(MEDIA_DIR);
      if (target.startsWith(`${base}${path.sep}`)) {
        const info = readImageInfo(target);
        if (info) {
          dims = { width: info.width, height: info.height };
          if (dimCache.size > 5000) dimCache.clear();
          dimCache.set(key, dims);
        }
      }
    }
    return { ...asset, width: dims?.width ?? null, height: dims?.height ?? null };
  });
}

/** 删除单个本地媒体文件（严格限制在 MEDIA_DIR 内） */
export function removeAssetFile(localPath) {
  if (!localPath) return false;
  dimCache.delete(String(localPath));
  const target = path.resolve(DATA_DIR, String(localPath));
  const base = path.resolve(MEDIA_DIR);
  if (!target.startsWith(`${base}${path.sep}`)) return false;
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  return true;
}

const UPLOAD_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 保存前端上传的单张展示图到本地 media 目录 */
export function saveUploadedMainImage(offerId, { name, dataUrl }) {
  if (!isValidOfferId(offerId)) throw new Error('商品 ID 不合法');
  const match = UPLOAD_DATA_URL_RE.exec(String(dataUrl ?? ''));
  if (!match) throw new Error(`${name || '图片'} 格式不支持，请上传 JPG/PNG/WebP/GIF`);

  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (buffer.length < 256) throw new Error(`${name || '图片'} 内容过小，可能不是有效图片`);
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`${name || '图片'} 超过 10MB 上限`);

  const dir = path.join(MEDIA_DIR, String(offerId), 'main');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);

  const localPath = `media/${offerId}/main/${filename}`.replace(/\\/g, '/');
  const size = sizeFromBuffer(buffer);
  if (size) dimCache.set(localPath, { width: size.width, height: size.height });

  return {
    localPath,
    remoteUrl: `local://custom/${filename}`,
    bytes: buffer.length,
    width: size?.width ?? null,
    height: size?.height ?? null
  };
}

/** 删除某个商品的本地媒体目录 */
export function removeMediaDir(offerId) {
  if (!isValidOfferId(offerId)) return false;
  const dir = path.join(MEDIA_DIR, String(offerId));
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 彻底清掉一个商品在磁盘上的痕迹：
 * 媒体副本目录 + 采集原始存档（{offerId}-{时间}.json）+ 旧版 JSON 结果文件。
 */
export function removeOfferArtifacts(offerId) {
  const id = String(offerId);
  const removed = { media: false, raw: 0, legacy: false };
  if (!isValidOfferId(id)) return removed;

  removed.media = removeMediaDir(id);

  if (fs.existsSync(RAW_DIR)) {
    for (const name of fs.readdirSync(RAW_DIR)) {
      // 只认以「ID-」开头的存档，避免 ID 是另一个 ID 的前缀时误删
      if (!name.startsWith(`${id}-`)) continue;
      fs.rmSync(path.join(RAW_DIR, name), { force: true });
      removed.raw += 1;
    }
  }

  const legacy = path.join(RESULT_DIR, `${id}.json`);
  if (fs.existsSync(legacy)) {
    fs.rmSync(legacy, { force: true });
    removed.legacy = true;
  }

  return removed;
}
