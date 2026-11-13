import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ROOT, MEDIA_DIR, CONFIG_FILE, loadConfig, writeDefaultConfig } from './config.mjs';
import { ensureChrome, connectBrowser, getCookiesFor, openWorkPage } from './chrome.mjs';
import { collectOffer } from './collector/index.mjs';
import { buildDraft, toCsv, reloadDictionary } from './draft/mercadolibre.mjs';
import {
  openDb,
  saveProduct,
  getProduct,
  listProducts,
  deleteProduct,
  getAssets,
  getAssetById,
  updateAsset,
  listPendingAssets,
  importLegacyResults
} from './db.mjs';
import { downloadMany, downloadOne, removeMediaDir, persistMedia } from './media.mjs';
import { fillPddProduct, localMainImagePaths, localDetailImagePaths } from './platforms/pdd/publish.mjs';
import {
  pushRecord,
  rememberFailedPush,
  listFailedPushes,
  retryFailedPushes,
  pendingCount
} from './remote.mjs';

writeDefaultConfig();
await openDb();
const imported = await importLegacyResults();
if (imported) console.log(`已从旧 JSON 导入 ${imported} 条记录到 SQLite`);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
// 本地媒体副本
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1h', fallthrough: true }));

let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

app.get('/api/health', async (_req, res) => {
  const config = loadConfig();
  let chromeReady = false;
  let loggedIn = false;
  try {
    const browser = await Promise.race([
      connectBrowser(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
    chromeReady = Boolean(browser);
    if (chromeReady) {
      const cookies = await getCookiesFor('1688.com');
      loggedIn = cookies.some((c) => /^(cookie2|_m_h5_tk|__cn_logon_id__)$/.test(c.name) && c.value);
    }
  } catch {
    chromeReady = false;
  }
  res.json({ chromeReady, loggedIn, config });
});

app.get('/api/settings', (_req, res) => res.json(loadConfig()));

app.post('/api/settings', (req, res) => {
  const current = loadConfig();
  const merged = { ...current, ...(req.body ?? {}) };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  res.json({ ok: true, config: loadConfig() });
});

app.post('/api/chrome/open', async (req, res) => {
  const url = req.body?.url || 'https://www.1688.com';
  try {
    await ensureChrome();
    const { page } = await openWorkPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    res.json({ ok: true, url: page.url() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/collect', async (req, res) => {
  const url = req.body?.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 url' });
  }

  const config = loadConfig();
  try {
    const record = await enqueue(async () => {
      const product = await collectOffer(url, {
        mode: req.body?.mode ?? config.collect.mode,
        waitTimeoutMs: config.collect.waitTimeoutMs,
        dumpRaw: config.collect.dumpRaw,
        imagesMax: config.images.maxCount
      });
      if (config.collect.intervalMs) {
        await new Promise((r) => setTimeout(r, config.collect.intervalMs));
      }
      const built = buildDraft(product, config.mercadolibre);
      if (product.apiFallback) {
        built.warnings.push({
          level: 'info',
          field: 'collect',
          message: product.apiFallback.message
        });
      }
      const item = {
        offerId: product.offerId,
        product,
        draft: built.draft,
        warnings: built.warnings,
        meta: built.meta,
        savedAt: new Date().toISOString()
      };
      await saveProduct(item);
      await persistMedia(product.offerId, product);
      return item;
    });

    // 采集端 -> 线上服务器
    let push = null;
    if (config.remote?.enabled) {
      push = await pushRecord(record, config);
      if (!push.ok) rememberFailedPush(record, push.error);
    }

    const assets = await getAssets(record.offerId);
    res.json({ ok: true, record, assets, push });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message || String(err) });
  }
});

/* ---------- 线上服务器：接收本地推送 ---------- */

app.post('/api/ingest', async (req, res) => {
  const config = loadConfig();
  const expected = config.remote?.token ?? '';
  if (!expected) return res.status(403).json({ ok: false, error: '接收端未配置 remote.token' });

  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${expected}`) return res.status(401).json({ ok: false, error: '推送令牌无效' });

  const record = req.body?.record;
  if (!record?.offerId || !record.product) {
    return res.status(400).json({ ok: false, error: '缺少 record' });
  }

  await saveProduct(record);
  // 媒体由服务器自行下载，不占用推送响应时间
  persistMedia(record.offerId, record.product).catch(() => {});

  res.json({ ok: true, offerId: record.offerId });
});

app.get('/api/remote/status', (_req, res) => {
  const config = loadConfig();
  res.json({
    enabled: Boolean(config.remote?.enabled),
    baseUrl: config.remote?.baseUrl ?? '',
    pending: pendingCount(),
    failures: listFailedPushes()
  });
});

app.post('/api/remote/retry', async (_req, res) => {
  const config = loadConfig();
  res.json({ ok: true, results: await retryFailedPushes(config) });
});

/* ---------- 拼多多半自动填表 ---------- */

app.post('/api/pdd/fill', async (req, res) => {
  const offerId = String(req.body?.offerId ?? '').trim();
  if (!offerId) return res.status(400).json({ ok: false, error: '缺少 offerId' });

  const record = await getProduct(offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到该商品，请先采集' });

  const config = loadConfig();
  const rules = { ...(config.platforms?.pdd?.publish ?? {}), ...(req.body?.rules ?? {}) };
  const assets = await getAssets(offerId);
  const images = localMainImagePaths(assets);
  const detailImages = localDetailImagePaths(assets);

  try {
    const report = await enqueue(() =>
      fillPddProduct({ product: record.product, images, detailImages, assets, rules })
    );
    res.json({ ok: true, ...report });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/results', async (_req, res) => {
  res.json(await listProducts());
});

app.get('/api/results/:offerId', async (req, res) => {
  const record = await getProduct(req.params.offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到结果' });
  res.json({ ok: true, record, assets: await getAssets(req.params.offerId) });
});

app.delete('/api/results/:offerId', async (req, res) => {
  await deleteProduct(req.params.offerId);
  removeMediaDir(req.params.offerId);
  res.json({ ok: true });
});

app.post('/api/results/:offerId/rebuild', async (req, res) => {
  const record = await getProduct(req.params.offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到结果' });

  const config = loadConfig();
  const built = buildDraft(record.product, config.mercadolibre);
  const updated = { ...record, draft: built.draft, warnings: built.warnings, meta: built.meta };
  await saveProduct(updated);
  res.json({ ok: true, record: updated });
});

/* ---------- 媒体补下载 ---------- */

app.post('/api/assets/:id/retry', async (req, res) => {
  const asset = await getAssetById(req.params.id);
  if (!asset) return res.status(404).json({ ok: false, error: '未找到该媒体' });

  const result = await downloadOne(asset);
  await updateAsset(asset.id, {
    local_path: result.localPath,
    bytes: result.bytes,
    status: result.status,
    error: result.error
  });
  const refreshed = await getAssetById(asset.id);
  res.json({ ok: result.status === 'ok', asset: refreshed, error: result.error });
});

app.post('/api/results/:offerId/retry', async (req, res) => {
  const pending = await listPendingAssets(req.params.offerId);
  if (!pending.length) return res.json({ ok: true, retried: 0, assets: await getAssets(req.params.offerId) });

  const apply = async (asset, result) => {
    await updateAsset(asset.id, {
      local_path: result.localPath,
      bytes: result.bytes,
      status: result.status,
      error: result.error
    });
  };

  await downloadMany(pending, { concurrency: 4, onDone: apply });
  const assets = await getAssets(req.params.offerId);
  res.json({ ok: true, retried: pending.length, assets });
});

/* ---------- 导出与词表 ---------- */

app.post('/api/export/csv', async (req, res) => {
  const ids = Array.isArray(req.body?.offerIds) ? req.body.offerIds : null;
  const targets = ids ?? (await listProducts()).map((r) => r.offerId);
  const records = [];
  for (const id of targets) {
    const record = await getProduct(id);
    if (record) records.push(record);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="listing-desk.csv"');
  res.send(`\uFEFF${toCsv(records)}`);
});

app.get('/api/dict', (_req, res) => {
  const file = path.join(ROOT, 'config', 'translate.zh-es.json');
  if (!fs.existsSync(file)) return res.json({});
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.post('/api/dict/reload', (_req, res) => {
  reloadDictionary();
  res.json({ ok: true });
});

const config = loadConfig();
const preferredPort = Number(config.server.port ?? 5173);

/** 端口被占用时自动往后找，最多试 10 个（便携包给非技术人员用，不能一启动就崩） */
function startServer(port, attempt = 0) {
  const server = app.listen(port);

  server.requestTimeout = 0;
  server.headersTimeout = 0;

  server.on('listening', () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log(`  listing-desk 已启动: ${url}`);
    console.log('  关闭本窗口即停止工具');
    console.log('');
    if (process.env.LISTING_DESK_OPEN === '1') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
        .on('error', () => {})
        .unref();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      console.warn(`端口 ${port} 被占用，改用 ${port + 1}`);
      startServer(port + 1, attempt + 1);
      return;
    }
    console.error('服务启动失败：', err.message);
    process.exitCode = 1;
  });
}

startServer(preferredPort);
