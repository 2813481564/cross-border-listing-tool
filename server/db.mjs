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
  `);
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
              (SELECT COUNT(*) FROM assets a WHERE a.offer_id = p.offer_id AND a.kind != 'video') AS media_total,
              (SELECT COUNT(*) FROM assets a WHERE a.offer_id = p.offer_id AND a.status = 'ok') AS media_ok,
              (SELECT COUNT(*) FROM assets a WHERE a.offer_id = p.offer_id AND a.status = 'failed') AS media_failed
       FROM products p
       ORDER BY p.collected_at DESC`
    )
    .all();

  return rows.map((r) => ({
    offerId: r.offer_id,
    title: r.title_draft || r.title || '',
    originalTitle: r.title || '',
    price: r.price_target,
    currency: r.currency,
    mediaTotal: r.media_total,
    mediaOk: r.media_ok,
    mediaFailed: r.media_failed,
    savedAt: r.collected_at
  }));
}

export async function deleteProduct(offerId) {
  const database = await openDb();
  database.prepare('DELETE FROM assets WHERE offer_id = ?').run(String(offerId));
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
