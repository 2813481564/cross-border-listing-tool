import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, RESULT_DIR } from './config.mjs';

let mod = null;
let db = null;

async function loadSqlite() {
  if (mod) return mod;
  try {
    mod = await import('node:sqlite');
  } catch {
    throw new Error('需要 Node 内置 SQLite：请用 npm start 启动（脚本已带 --experimental-sqlite）');
  }
  return mod;
}

export async function openDb() {
  if (db) return db;
  const { DatabaseSync } = await loadSqlite();
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS products (
      offer_id      TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      title         TEXT,
      title_draft   TEXT,
      price_cny     REAL,
      price_target  REAL,
      currency      TEXT,
      product_json  TEXT NOT NULL,
      draft_json    TEXT,
      warnings_json TEXT,
      collected_at  TEXT,
      updated_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS assets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      seq         INTEGER NOT NULL DEFAULT 0,
      label       TEXT,
      remote_url  TEXT NOT NULL,
      local_path  TEXT,
      bytes       INTEGER,
      status      TEXT NOT NULL DEFAULT 'pending',
      error       TEXT,
      updated_at  TEXT,
      UNIQUE(offer_id, kind, remote_url)
    );

    CREATE INDEX IF NOT EXISTS idx_assets_offer ON assets(offer_id);
    CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);

    -- 上架标记：一个商品 × 一个平台 一条记录
    CREATE TABLE IF NOT EXISTS publish_marks (
      offer_id   TEXT NOT NULL,
      platform   TEXT NOT NULL,
      marked_at  TEXT,
      source     TEXT,
      PRIMARY KEY (offer_id, platform)
    );

    CREATE INDEX IF NOT EXISTS idx_marks_platform ON publish_marks(platform);
  `);
}

/* ---------------- 上架标记 ---------------- */

/** 支持的上架平台（前端下拉与校验共用） */
export const PUBLISH_PLATFORMS = ['pdd', 'douyin'];

/** 该商品在哪些平台已上架：{ pdd: {at, source}, douyin: {...} } */
export async function getPublishMarks(offerId) {
  const database = await openDb();
  const rows = database
    .prepare('SELECT platform, marked_at, source FROM publish_marks WHERE offer_id = ?')
    .all(String(offerId));
  const out = {};
  for (const row of rows) out[row.platform] = { at: row.marked_at, source: row.source };
  return out;
}

/** 一次取全量，列表页用：{ [offerId]: { pdd: {...}, ... } } */
export async function listPublishMarks() {
  const database = await openDb();
  const rows = database.prepare('SELECT offer_id, platform, marked_at, source FROM publish_marks').all();
  const out = {};
  for (const row of rows) {
    if (!out[row.offer_id]) out[row.offer_id] = {};
    out[row.offer_id][row.platform] = { at: row.marked_at, source: row.source };
  }
  return out;
}

/**
 * 设置 / 取消上架标记。
 * @param {string} offerId
 * @param {string} platform pdd | douyin
 * @param {boolean} marked true=已上架，false=取消
 * @param {string} source auto（填表成功后自动写）| manual（人工标记）
 */
export async function setPublishMark(offerId, platform, marked, source = 'manual') {
  const database = await openDb();
  if (!PUBLISH_PLATFORMS.includes(platform)) throw new Error(`不支持的平台：${platform}`);

  if (marked) {
    database
      .prepare(
        `INSERT INTO publish_marks (offer_id, platform, marked_at, source)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(offer_id, platform) DO UPDATE SET marked_at=excluded.marked_at, source=excluded.source`
      )
      .run(String(offerId), platform, nowIso(), source);
  } else {
    database
      .prepare('DELETE FROM publish_marks WHERE offer_id = ? AND platform = ?')
      .run(String(offerId), platform);
  }
  return getPublishMarks(offerId);
}

function nowIso() {
  return new Date().toISOString();
}

/* ---------------- products ---------------- */

export async function saveProduct(record) {
  const database = await openDb();
  database
    .prepare(
      `INSERT INTO products (offer_id, url, title, title_draft, price_cny, price_target, currency,
                             product_json, draft_json, warnings_json, collected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(offer_id) DO UPDATE SET
         url=excluded.url, title=excluded.title, title_draft=excluded.title_draft,
         price_cny=excluded.price_cny, price_target=excluded.price_target, currency=excluded.currency,
         product_json=excluded.product_json, draft_json=excluded.draft_json,
         warnings_json=excluded.warnings_json, collected_at=excluded.collected_at, updated_at=excluded.updated_at`
    )
    .run(
      record.offerId,
      record.product?.url ?? '',
      record.product?.title ?? null,
      record.draft?.title ?? null,
      record.product?.price?.min ?? null,
      record.draft?.price ?? null,
      record.draft?.currency_id ?? null,
      JSON.stringify(record.product ?? {}),
      JSON.stringify(record.draft ?? {}),
      JSON.stringify(record.warnings ?? []),
      record.savedAt ?? nowIso(),
      nowIso()
    );
}

export async function getProduct(offerId) {
  const database = await openDb();
  const row = database.prepare('SELECT * FROM products WHERE offer_id = ?').get(String(offerId));
  if (!row) return null;
  return rowToRecord(row);
}

function rowToRecord(row) {
  return {
    offerId: row.offer_id,
    product: safeJson(row.product_json, {}),
    draft: safeJson(row.draft_json, {}),
    warnings: safeJson(row.warnings_json, []),
    savedAt: row.collected_at,
    updatedAt: row.updated_at
  };
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function listProducts() {
  const database = await openDb();
  const rows = database
    .prepare(
      `SELECT p.offer_id, p.title, p.title_draft, p.price_target, p.currency, p.collected_at,
              p.warnings_json,
              (SELECT COUNT(*) FROM assets a WHERE a.offer_id = p.offer_id AND a.kind != 'video') AS media_total,
              (SELECT COUNT(*) FROM assets a
                 WHERE a.offer_id = p.offer_id AND a.kind != 'video' AND a.status = 'ok') AS media_ok,
              (SELECT COUNT(*) FROM assets a
                 WHERE a.offer_id = p.offer_id AND a.kind != 'video' AND a.status = 'failed') AS media_failed,
              (SELECT a.local_path FROM assets a
                 WHERE a.offer_id = p.offer_id AND a.kind = 'main' AND a.local_path IS NOT NULL
                 ORDER BY a.seq LIMIT 1) AS cover_local,
              (SELECT a.remote_url FROM assets a
                 WHERE a.offer_id = p.offer_id AND a.kind = 'main'
                 ORDER BY a.seq LIMIT 1) AS cover_remote
       FROM products p
       ORDER BY p.collected_at DESC`
    )
    .all();

  const marks = await listPublishMarks();

  return rows.map((r) => ({
    offerId: r.offer_id,
    title: r.title_draft || r.title || '',
    originalTitle: r.title || '',
    price: r.price_target,
    currency: r.currency,
    mediaTotal: r.media_total,
    mediaOk: r.media_ok,
    mediaFailed: r.media_failed,
    warningsCount: safeJson(r.warnings_json, []).length,
    // 上架标记：{ pdd: {...}, douyin: {...} }，未上架为空对象
    marks: marks[r.offer_id] ?? {},
    // 列表卡片用：优先本地副本，没下载成功就回落 1688 原图
    coverUrl: r.cover_local ? `/${String(r.cover_local).replace(/\\/g, '/')}` : r.cover_remote ?? null,
    // 卡片封面优先用 1688 CDN 的小图，几 KB 就能画一格；失败再回落本地原图
    thumbUrl: cdnThumbUrl(r.cover_remote, 240),
    savedAt: r.collected_at
  }));
}

/**
 * 阿里 CDN 取缩略图的方式是「原地址后面直接追加 `_240x240.jpg`」，
 * 不是替换扩展名——实测 `xxx-0-cib.jpg_240x240.jpg` 返回 200（26KB），
 * 而换成 `xxx-0-cib_240x240.jpg` 是 404。只对阿里自家域名拼，别的站点一律返回 null，
 * 前端拿不到就回落本地原图。
 */
function cdnThumbUrl(remoteUrl, size) {
  if (!remoteUrl) return null;
  const url = String(remoteUrl);
  if (url.includes('?') || !/^https?:\/\//i.test(url)) return null;

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!/(^|\.)alicdn\.com$/i.test(host)) return null;

  if (/_\d+x\d+\.(jpe?g|png|webp)$/i.test(url)) return url;
  return `${url}_${size}x${size}.jpg`;
}

export async function deleteProduct(offerId) {
  const database = await openDb();
  database.prepare('DELETE FROM assets WHERE offer_id = ?').run(String(offerId));
  database.prepare('DELETE FROM publish_marks WHERE offer_id = ?').run(String(offerId));
  database.prepare('DELETE FROM products WHERE offer_id = ?').run(String(offerId));
}

export async function countProducts() {
  const database = await openDb();
  return database.prepare('SELECT COUNT(*) AS c FROM products').get().c;
}

/* ---------------- assets ---------------- */

export async function replaceAssets(offerId, assets) {
  const database = await openDb();
  database.prepare('DELETE FROM assets WHERE offer_id = ?').run(String(offerId));

  // 兜底：即便上游漏了去重，也不让整次采集因为唯一约束失败
  const insert = database.prepare(
    `INSERT INTO assets (offer_id, kind, seq, label, remote_url, local_path, bytes, status, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(offer_id, kind, remote_url) DO UPDATE SET
       seq=excluded.seq, label=excluded.label, local_path=excluded.local_path,
       bytes=excluded.bytes, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at`
  );

  for (const asset of assets) {
    insert.run(
      String(offerId),
      asset.kind,
      asset.seq ?? 0,
      asset.label ?? null,
      asset.remoteUrl,
      asset.localPath ?? null,
      asset.bytes ?? null,
      asset.status ?? 'pending',
      asset.error ?? null,
      nowIso()
    );
  }
}

export async function getAssets(offerId) {
  const database = await openDb();
  const rows = database
    .prepare('SELECT * FROM assets WHERE offer_id = ? ORDER BY kind, seq')
    .all(String(offerId));

  return rows.map((r) => ({
    id: r.id,
    offerId: r.offer_id,
    kind: r.kind,
    seq: r.seq,
    label: r.label,
    remoteUrl: r.remote_url,
    localPath: r.local_path,
    localUrl: r.local_path ? `/${r.local_path.replace(/\\/g, '/')}` : null,
    bytes: r.bytes,
    status: r.status,
    error: r.error
  }));
}

export async function getAssetById(id) {
  const database = await openDb();
  const r = database.prepare('SELECT * FROM assets WHERE id = ?').get(Number(id));
  if (!r) return null;
  return {
    id: r.id,
    offerId: r.offer_id,
    kind: r.kind,
    seq: r.seq,
    label: r.label,
    remoteUrl: r.remote_url,
    localPath: r.local_path,
    localUrl: r.local_path ? `/${r.local_path.replace(/\\/g, '/')}` : null,
    bytes: r.bytes,
    status: r.status,
    error: r.error
  };
}

export async function updateAsset(id, patch) {
  const database = await openDb();
  const fields = [];
  const values = [];
  for (const key of ['local_path', 'bytes', 'status', 'error']) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  values.push(nowIso(), Number(id));
  database.prepare(`UPDATE assets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/** 批量删除指定 ID 的媒体记录 */
export async function deleteAssetsByIds(ids) {
  const list = (ids ?? []).map((id) => Number(id)).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return 0;
  const database = await openDb();
  const placeholders = list.map(() => '?').join(', ');
  const info = database.prepare(`DELETE FROM assets WHERE id IN (${placeholders})`).run(...list);
  return info.changes;
}

/** 删除单条媒体记录 */
export async function deleteAssetById(id) {
  return (await deleteAssetsByIds([id])) > 0;
}

/** 从商品与草稿数据中移除指定类型的图片链接（保持原采集时间不变） */
export async function removeImagesFromProduct(offerId, kind, remoteUrls) {
  const record = await getProduct(offerId);
  const urlSet = new Set((Array.isArray(remoteUrls) ? remoteUrls : [remoteUrls]).filter(Boolean));
  if (!record || !urlSet.size) return record;

  const product = { ...(record.product ?? {}) };
  const draft = { ...(record.draft ?? {}) };

  if (kind === 'main') {
    if (Array.isArray(product.images)) {
      product.images = product.images.filter((u) => !urlSet.has(u));
    }
    if (product.imageGroups && Array.isArray(product.imageGroups.main)) {
      product.imageGroups = {
        ...product.imageGroups,
        main: product.imageGroups.main.filter((u) => !urlSet.has(u))
      };
    }
    if (Array.isArray(draft.pictures)) {
      draft.pictures = draft.pictures.filter((p) => !urlSet.has(p?.source));
    }
    if (draft.image_summary && typeof draft.image_summary === 'object') {
      draft.image_summary = {
        ...draft.image_summary,
        main: Array.isArray(product.images) ? product.images.length : (draft.pictures?.length ?? 0)
      };
    }
  } else if (kind === 'detail') {
    if (product.imageGroups && Array.isArray(product.imageGroups.detail)) {
      product.imageGroups = {
        ...product.imageGroups,
        detail: product.imageGroups.detail.filter((u) => !urlSet.has(u))
      };
    }
    if (Array.isArray(draft.detail_images)) {
      draft.detail_images = draft.detail_images.filter((p) => !urlSet.has(p?.source));
    }
    if (draft.image_summary && typeof draft.image_summary === 'object') {
      draft.image_summary = {
        ...draft.image_summary,
        detail: product.imageGroups?.detail?.length ?? draft.detail_images?.length ?? 0
      };
    }
  } else if (kind === 'sku') {
    if (product.imageGroups && Array.isArray(product.imageGroups.sku)) {
      product.imageGroups = {
        ...product.imageGroups,
        sku: product.imageGroups.sku.filter((item) => !urlSet.has(item?.image))
      };
    }
    if (Array.isArray(draft.variations)) {
      draft.variations = draft.variations.map((v) =>
        urlSet.has(v?.picture_url) ? { ...v, picture_url: null } : v
      );
    }
    if (draft.image_summary && typeof draft.image_summary === 'object') {
      draft.image_summary = {
        ...draft.image_summary,
        sku: product.imageGroups?.sku?.length ?? 0
      };
    }
  }

  await saveProduct({ ...record, product, draft, savedAt: record.savedAt });
  return getProduct(offerId);
}

/** 规格键值对统一规范化，避免空格差异导致误判 */
function normSpecPair(prop, name) {
  const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
  return `${clean(prop)}=${clean(name)}`;
}

/** 删除指定 SKU，并识别已彻底不再被剩余 SKU 引用的规格图（兼容二维规格与共用图） */
export async function deleteSkuFromProduct(offerId, skuId) {
  const record = await getProduct(offerId);
  if (!record) return null;

  const skus = Array.isArray(record.product?.skus) ? record.product.skus : [];
  const targetIndex = skus.findIndex((s) => String(s?.skuId ?? '') === String(skuId));
  if (targetIndex < 0) return { notFound: true };

  const removedSku = skus[targetIndex];
  const remainingSkus = skus.filter((_, i) => i !== targetIndex);

  const usedSpecs = new Set();
  const usedSkuUrls = new Set();
  for (const s of remainingSkus) {
    if (s?.image) usedSkuUrls.add(s.image);
    for (const [k, v] of Object.entries(s?.specs ?? {})) {
      if (k && v) usedSpecs.add(normSpecPair(k, v));
    }
  }

  const product = { ...(record.product ?? {}), skus: remainingSkus };
  const oldSkuGroups = Array.isArray(product.imageGroups?.sku) ? product.imageGroups.sku : [];
  const keptSkuGroups = oldSkuGroups.filter((g) => {
    if (g?.prop && g?.name && usedSpecs.has(normSpecPair(g.prop, g.name))) return true;
    return !g?.prop && g?.image && usedSkuUrls.has(g.image);
  });
  if (product.imageGroups) {
    product.imageGroups = { ...product.imageGroups, sku: keptSkuGroups };
  }

  // 若剩余 SKU 带有有效价格，同步重算基准最低/最高价
  const skuPrices = remainingSkus.map((s) => Number(s?.price)).filter((p) => Number.isFinite(p) && p > 0);
  if (skuPrices.length) {
    product.price = {
      ...(product.price ?? {}),
      min: Math.min(...skuPrices),
      max: Math.max(...skuPrices)
    };
  }

  const draft = { ...(record.draft ?? {}) };
  if (Array.isArray(draft.variations)) {
    const targetVarSku = `${offerId}-${removedSku.skuId}`;
    draft.variations = draft.variations.filter((v) => String(v?.sku ?? '') !== targetVarSku);
  }
  if (draft.image_summary && typeof draft.image_summary === 'object') {
    draft.image_summary = { ...draft.image_summary, sku: keptSkuGroups.length };
  }

  await saveProduct({ ...record, product, draft, savedAt: record.savedAt });

  const database = await openDb();
  const skuAssets = (await getAssets(offerId)).filter((a) => a.kind === 'sku');
  const assetsToDelete = [];
  const keptGroupUrls = new Set(keptSkuGroups.map((g) => g?.image).filter(Boolean));
  const labelStmt = database.prepare('UPDATE assets SET label = ?, updated_at = ? WHERE id = ?');
  const now = nowIso();

  for (const asset of skuAssets) {
    const entries = String(asset.label ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    if (!entries.length) {
      if (!usedSkuUrls.has(asset.remoteUrl) && !keptGroupUrls.has(asset.remoteUrl)) {
        assetsToDelete.push(asset);
      }
      continue;
    }

    const keptEntries = entries.filter((entry) => {
      const idx = entry.indexOf('=');
      if (idx < 0) return false;
      return usedSpecs.has(normSpecPair(entry.slice(0, idx), entry.slice(idx + 1)));
    });

    if (keptEntries.length) {
      const nextLabel = keptEntries.join(';');
      if (nextLabel !== asset.label) labelStmt.run(nextLabel, now, asset.id);
    } else if (!usedSkuUrls.has(asset.remoteUrl)) {
      assetsToDelete.push(asset);
    }
  }

  return { removedSku, assetsToDelete };
}

/** 重排展示图顺序，并同步商品与草稿里的主图顺序 */
export async function reorderMainAssets(offerId, orderedIds) {
  const database = await openDb();
  const rows = database
    .prepare("SELECT id, remote_url FROM assets WHERE offer_id = ? AND kind = 'main' ORDER BY seq, id")
    .all(String(offerId));
  if (!rows.length) return [];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const finalRows = [];
  const seen = new Set();

  for (const rawId of orderedIds ?? []) {
    const id = Number(rawId);
    const row = byId.get(id);
    if (row && !seen.has(id)) {
      seen.add(id);
      finalRows.push(row);
    }
  }
  for (const row of rows) {
    if (!seen.has(row.id)) finalRows.push(row);
  }

  database.exec('BEGIN');
  try {
    const stmt = database.prepare('UPDATE assets SET seq = ?, updated_at = ? WHERE id = ?');
    const now = nowIso();
    finalRows.forEach((row, idx) => stmt.run(idx + 1, now, row.id));
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }

  const record = await getProduct(offerId);
  if (record) {
    const orderedUrls = finalRows.map((r) => r.remote_url);
    const orderedSet = new Set(orderedUrls);
    const product = { ...(record.product ?? {}) };
    const extraProduct = (product.images ?? []).filter((u) => !orderedSet.has(u));
    const nextUrls = [...orderedUrls, ...extraProduct];
    product.images = nextUrls;
    product.imageGroups = { ...(product.imageGroups ?? {}), main: nextUrls };

    const draft = { ...(record.draft ?? {}) };
    if (Array.isArray(draft.pictures)) {
      const picByUrl = new Map(draft.pictures.map((p) => [p?.source, p]));
      const extraPics = draft.pictures.filter((p) => !orderedSet.has(p?.source));
      draft.pictures = [...orderedUrls.map((u) => picByUrl.get(u) ?? { source: u }), ...extraPics];
    }
    await saveProduct({ ...record, product, draft, savedAt: record.savedAt });
  }

  return getAssets(offerId);
}

/** 追加本地上传的展示图记录，并同步商品与草稿主图列表 */
export async function insertUploadedMainAssets(offerId, items) {
  if (!items?.length) return getAssets(offerId);
  const database = await openDb();
  const maxRow = database
    .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM assets WHERE offer_id = ? AND kind = 'main'")
    .get(String(offerId));
  let nextSeq = Number(maxRow?.max_seq ?? 0);

  const stmt = database.prepare(
    `INSERT INTO assets (offer_id, kind, seq, label, remote_url, local_path, bytes, status, error, updated_at)
     VALUES (?, 'main', ?, NULL, ?, ?, ?, 'ok', NULL, ?)`
  );
  const now = nowIso();
  for (const item of items) {
    nextSeq += 1;
    stmt.run(String(offerId), nextSeq, item.remoteUrl, item.localPath, item.bytes, now);
  }

  const record = await getProduct(offerId);
  if (record) {
    const addedUrls = items.map((i) => i.remoteUrl);
    const product = { ...(record.product ?? {}) };
    const nextImages = [...(product.images ?? []), ...addedUrls];
    product.images = nextImages;
    product.imageGroups = { ...(product.imageGroups ?? {}), main: nextImages };

    const draft = { ...(record.draft ?? {}) };
    draft.pictures = [...(draft.pictures ?? []), ...addedUrls.map((u) => ({ source: u }))];
    if (draft.image_summary && typeof draft.image_summary === 'object') {
      draft.image_summary = { ...draft.image_summary, main: nextImages.length };
    }
    await saveProduct({ ...record, product, draft, savedAt: record.savedAt });
  }

  return getAssets(offerId);
}

export async function listPendingAssets(offerId) {
  const database = await openDb();
  const rows = database
    .prepare("SELECT * FROM assets WHERE offer_id = ? AND status != 'ok' ORDER BY kind, seq")
    .all(String(offerId));
  return rows.map((r) => ({
    id: r.id,
    offerId: r.offer_id,
    kind: r.kind,
    seq: r.seq,
    remoteUrl: r.remote_url,
    localPath: r.local_path,
    status: r.status
  }));
}

/* ---------------- 旧 JSON 迁移 ---------------- */

export async function importLegacyResults() {
  if (!fs.existsSync(RESULT_DIR)) return 0;
  const files = fs.readdirSync(RESULT_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) return 0;

  const existing = await countProducts();
  if (existing > 0) return 0;

  let imported = 0;
  for (const file of files) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(RESULT_DIR, file), 'utf8'));
      if (!record?.offerId) continue;
      await saveProduct(record);
      imported += 1;
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return imported;
}

export function dbPath() {
  return DB_FILE;
}
