import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ROOT, MEDIA_DIR, CONFIG_FILE, loadConfig, writeDefaultConfig } from './config.mjs';
import { ensureChrome, connectBrowser, getCookiesFor, openWorkPage } from './chrome.mjs';
import {
  SNAPSHOT_FILE,
  snapshotInfo,
  exportSnapshot,
  importSnapshot,
  maybeRestore,
  probeLogin,
  backupIfLoggedIn
} from './auth.mjs';
import { collectOffer } from './collector/index.mjs';
import { scanCart } from './collector/cart.mjs';
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
  deleteAssetsByIds,
  removeImagesFromProduct,
  deleteSkuFromProduct,
  reorderMainAssets,
  insertUploadedMainAssets,
  listPendingAssets,
  importLegacyResults,
  getPublishMarks,
  setPublishMark,
  PUBLISH_PLATFORMS
} from './db.mjs';
import {
  downloadMany,
  downloadOne,
  attachImageDimensions,
  saveUploadedMainImage,
  removeAssetFile,
  removeOfferArtifacts,
  isValidOfferId,
  persistMedia
} from './media.mjs';
import { fillPddProduct, localMainImagePaths, localDetailImagePaths } from './platforms/pdd/publish.mjs';
import { fillDouyinProduct } from './platforms/douyin/publish.mjs';
import {
  pushRecord,
  rememberFailedPush,
  listFailedPushes,
  retryFailedPushes,
  pendingCount
} from './remote.mjs';
import {
  setJobHandler,
  enqueueJob,
  listJobs,
  retryJob,
  clearFinishedJobs,
  jobStats
} from './jobs.mjs';

writeDefaultConfig();
await openDb();
const imported = await importLegacyResults();
if (imported) console.log(`已从旧 JSON 导入 ${imported} 条记录到 SQLite`);

const app = express();
// 上传本地展示图支持较大 base64 载荷，需放在全局 2mb 限制之前
app.use('/api/results/:offerId/assets/upload', express.json({ limit: '30mb' }));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一次提交可能带多行链接，统一拆成数组 */
function normalizeUrls(body) {
  const raw = Array.isArray(body?.urls)
    ? body.urls
    : typeof body?.url === 'string'
      ? [body.url]
      : [];
  return raw
    .flatMap((s) => String(s).split(/\r?\n/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 采一条链接的完整流程：取数 → 生成草稿 → 落库 → 下载媒体 → 推送线上。
 * 同步接口和任务队列都调这里，区别只是传不传 job（传了就回写进度）。
 */
async function runCollect(url, body = {}, job = null) {
  const config = loadConfig();

  if (job) {
    job.stage = '采集中';
    job.detail = '';
  }

  const product = await collectOffer(url, {
    mode: body.mode ?? config.collect.mode,
    waitTimeoutMs: config.collect.waitTimeoutMs,
    dumpRaw: config.collect.dumpRaw,
    imagesMax: config.images.maxCount
  });

  if (job) {
    job.offerId = product.offerId ?? null;
    job.stage = '生成草稿';
    job.detail = (product.title ?? '').slice(0, 60);
  }

  if (config.collect.intervalMs) {
    if (job) job.stage = '节流等待';
    await sleep(config.collect.intervalMs);
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

  if (job) {
    job.stage = '下载图片';
    job.detail = '';
  }
  await persistMedia(product.offerId, product, {
    onProgress: (done, total) => {
      if (!job) return;
      job.progress = { done, total };
      job.detail = `图片 ${done}/${total}`;
    }
  });

  // 采集端 -> 线上服务器
  let push = null;
  if (config.remote?.enabled) {
    if (job) {
      job.stage = '推送线上';
      job.detail = '';
    }
    push = await pushRecord(item, config);
    if (!push.ok) rememberFailedPush(item, push.error);
  }

  return { record: item, push };
}

// 任务队列的执行体：仍在同一条串行锁里跑，避免和拼多多填表抢同一个浏览器页面
setJobHandler(async (job) => {
  job.stage = '等待浏览器空闲';
  const { record } = await enqueue(() => runCollect(job.url, job.options ?? {}, job));
  job.offerId = record.offerId;
  job.title = record.draft?.title || record.product?.title || '';
  job.price = record.draft?.price ?? null;
  job.currency = record.draft?.currency_id ?? null;
  return { offerId: record.offerId };
});

async function checkLogin() {
  const cookies = await getCookiesFor('1688.com');
  return cookies.some((c) => /^(cookie2|_m_h5_tk|__cn_logon_id__)$/.test(c.name) && c.value);
}

// 登录态快照的运行态：自动恢复每个进程只试一次，结果留给前端展示
let restoreTried = false;
let restoreResult = null;

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
      loggedIn = await checkLogin();

      // 新 profile（同事刚解压便携包、或换了电脑）：套用随包附带的登录态快照
      if (!loggedIn && !restoreTried) {
        restoreTried = true;
        restoreResult = await maybeRestore().catch((err) => ({
          restored: false,
          reason: 'ERROR',
          message: err.message
        }));
        if (restoreResult.restored) loggedIn = await checkLogin();
      }

      // 已登录就顺手刷新快照（内部节流，10 分钟最多写一次）
      if (loggedIn) backupIfLoggedIn().catch(() => {});
    }
  } catch {
    chromeReady = false;
  }
  res.json({
    chromeReady,
    loggedIn,
    snapshot: snapshotInfo(),
    restore: restoreResult,
    config,
    queue: jobStats()
  });
});

/* ---------- 登录态快照 ---------- */

app.get('/api/auth/snapshot', (_req, res) => {
  res.json({ ok: true, ...snapshotInfo(), restore: restoreResult });
});

/** 备份当前 1688 会话；body.pass 非空则加密落盘 */
app.post('/api/auth/export', async (req, res) => {
  try {
    const result = await exportSnapshot({ pass: String(req.body?.pass ?? '') });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

/** 把 data/auth/1688.state.json 套回浏览器 */
app.post('/api/auth/import', async (req, res) => {
  try {
    const result = await importSnapshot({ pass: String(req.body?.pass ?? '') });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

/** 下载快照文件（发给同事 / 单独备份） */
app.get('/api/auth/snapshot/download', (_req, res) => {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    return res.status(404).json({ ok: false, error: '还没有快照，请先点「备份登录态」' });
  }
  res.download(SNAPSHOT_FILE, path.basename(SNAPSHOT_FILE));
});

/** 真实探测：打开购物车页看是否被踢回登录页 */
app.post('/api/auth/probe', async (_req, res) => {
  try {
    const result = await enqueue(() => probeLogin());
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
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

/** 同步采集：老接口，一次请求跑完全程。网页已改走任务队列，这里保留给脚本和兼容调用 */
app.post('/api/collect', async (req, res) => {
  const url = req.body?.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 url' });
  }

  try {
    const { record, push } = await enqueue(() => runCollect(url, req.body));
    const assets = await getAssets(record.offerId);
    res.json({ ok: true, record, assets, push });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message || String(err) });
  }
});

/* ---------- 任务队列 ---------- */

function jobPayload(extra = {}) {
  return { ok: true, ...jobStats(), jobs: listJobs(), ...extra };
}

/** 提交采集任务：立刻返回，采集在后台排队跑 */
app.post('/api/jobs', (req, res) => {
  const urls = normalizeUrls(req.body);
  if (!urls.length) return res.status(400).json({ ok: false, error: '缺少 url' });

  const options = { mode: req.body?.mode };
  const created = urls.map((url) => enqueueJob({ url, options }));
  res.json(jobPayload({ created: created.map((j) => j.id) }));
});

app.get('/api/jobs', (_req, res) => res.json(jobPayload()));

app.post('/api/jobs/clear', (_req, res) => {
  clearFinishedJobs();
  res.json(jobPayload());
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const job = retryJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: '未找到该任务' });
  res.json(jobPayload({ created: [job.id] }));
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
    // 填表成功即标记「已上架拼多多」（人工可撤销或补标）
    const marks = await setPublishMark(offerId, 'pdd', true, 'auto');
    res.json({ ok: true, marks, ...report });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------- 采集购物车 ---------- */

app.post('/api/cart/scan', async (_req, res) => {
  try {
    // 和采集共用串行锁：读购物车也要占那个浏览器页面
    const scanned = await enqueue(() => scanCart());
    const existing = new Set((await listProducts()).map((p) => p.offerId));
    const items = scanned.items.map((item) => ({ ...item, exists: existing.has(item.offerId) }));

    res.json({
      ok: true,
      cartUrl: scanned.cartUrl,
      hasInvalid: scanned.hasInvalid,
      total: items.length,
      newCount: items.filter((i) => !i.exists).length,
      items
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message || String(err) });
  }
});

/* ---------- 抖店半自动填表 ---------- */

app.post('/api/dy/fill', async (req, res) => {
  const offerId = String(req.body?.offerId ?? '').trim();
  if (!offerId) return res.status(400).json({ ok: false, error: '缺少 offerId' });

  const record = await getProduct(offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到该商品，请先采集' });

  const config = loadConfig();
  const rules = { ...(config.platforms?.douyin?.publish ?? {}), ...(req.body?.rules ?? {}) };
  const assets = await getAssets(offerId);
  const images = localMainImagePaths(assets);
  const detailImages = localDetailImagePaths(assets);

  try {
    const report = await enqueue(() =>
      fillDouyinProduct({ product: record.product, images, detailImages, assets, rules })
    );
    // 填表成功即标记「已上架抖音」（人工可撤销或补标）
    const marks = await setPublishMark(offerId, 'douyin', true, 'auto');
    res.json({ ok: true, marks, ...report });
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
  res.json({
    ok: true,
    record,
    marks: await getPublishMarks(req.params.offerId),
    assets: attachImageDimensions(await getAssets(req.params.offerId))
  });
});

/** 手动标记 / 取消「已上架某平台」 */
app.post('/api/marks', async (req, res) => {
  const offerId = String(req.body?.offerId ?? '').trim();
  const platform = String(req.body?.platform ?? '').trim();
  const marked = Boolean(req.body?.marked);

  if (!offerId) return res.status(400).json({ ok: false, error: '缺少 offerId' });
  if (!PUBLISH_PLATFORMS.includes(platform)) {
    return res.status(400).json({ ok: false, error: `不支持的平台：${platform || '(空)'}` });
  }

  const record = await getProduct(offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到该商品，请先采集' });

  try {
    const marks = await setPublishMark(offerId, platform, marked, 'manual');
    res.json({ ok: true, offerId, marks });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/results/:offerId', async (req, res) => {
  const offerId = String(req.params.offerId);
  if (!isValidOfferId(offerId)) {
    return res.status(400).json({ ok: false, error: '商品 ID 不合法' });
  }

  const record = await getProduct(offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到该商品' });

  // 先删库再删文件：文件删失败也只是留垃圾，不会出现「库没了文件还在被引用」
  await deleteProduct(offerId);
  const files = removeOfferArtifacts(offerId);
  res.json({ ok: true, offerId, files });
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

/** 手改草稿：只动你传上来的字段，其余原样保留 */
app.post('/api/results/:offerId/draft', async (req, res) => {
  const offerId = String(req.params.offerId);
  const record = await getProduct(offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到该商品' });

  const config = loadConfig();
  const maxTitle = config.mercadolibre?.titleMaxLength ?? 60;
  const body = req.body ?? {};
  const product = { ...(record.product ?? {}) };
  const draft = { ...(record.draft ?? {}) };
  const has = (key) => body[key] !== undefined && body[key] !== null;

  if (has('product_title')) {
    const productTitle = String(body.product_title).trim();
    if (!productTitle) return res.status(400).json({ ok: false, error: '中文原标题不能为空' });
    product.title = productTitle;
    if (draft.source && typeof draft.source === 'object') {
      draft.source = { ...draft.source, originalTitle: productTitle };
    }
  }

  if (has('title')) {
    const title = String(body.title).trim();
    if (!title) return res.status(400).json({ ok: false, error: '标题不能为空' });
    if (title.length > maxTitle) {
      return res.status(400).json({ ok: false, error: `标题超出上限 ${maxTitle} 字符（当前 ${title.length}）` });
    }
    draft.title = title;
  }

  if (has('price')) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ ok: false, error: '价格必须是不小于 0 的数字' });
    }
    draft.price = Math.round(price * 100) / 100;
  }

  if (has('available_quantity')) {
    const qty = Number(body.available_quantity);
    if (!Number.isInteger(qty) || qty < 0) {
      return res.status(400).json({ ok: false, error: '库存必须是不小于 0 的整数' });
    }
    draft.available_quantity = qty;
  }

  if (has('category_id')) {
    draft.category_id = String(body.category_id).trim();
  }

  if (has('weight_g')) {
    const weight = Number(body.weight_g);
    if (!Number.isFinite(weight) || weight < 0) {
      return res.status(400).json({ ok: false, error: '重量必须是不小于 0 的数字' });
    }
    draft.package = { ...(draft.package ?? {}), weight_g: Math.round(weight) };
  }

  // savedAt 保持采集时间，列表排序才不会因为改个标题就跳到最前
  await saveProduct({ ...record, product, draft, savedAt: record.savedAt });
  res.json({
    ok: true,
    record: await getProduct(offerId),
    assets: attachImageDimensions(await getAssets(offerId))
  });
});

/* ---------- 媒体补下载、排序、上传与删除 ---------- */

/** 统一执行媒体真删除：删库记录 -> 删磁盘文件 -> 同步商品/草稿 JSON */
async function deleteAssetsAndFiles(offerId, kind, assetsToDelete) {
  if (!assetsToDelete.length) {
    return {
      deletedIds: [],
      filesRemoved: 0,
      record: await getProduct(offerId),
      assets: attachImageDimensions(await getAssets(offerId))
    };
  }
  const ids = assetsToDelete.map((a) => a.id);
  const urls = assetsToDelete.map((a) => a.remoteUrl);
  await deleteAssetsByIds(ids);

  let filesRemoved = 0;
  for (const asset of assetsToDelete) {
    if (removeAssetFile(asset.localPath)) filesRemoved += 1;
  }

  const record = await removeImagesFromProduct(offerId, kind, urls);
  const assets = attachImageDimensions(await getAssets(offerId));
  return { deletedIds: ids, filesRemoved, record, assets };
}

app.delete('/api/assets/:id', async (req, res) => {
  const asset = await getAssetById(req.params.id);
  if (!asset) return res.status(404).json({ ok: false, error: '未找到该媒体' });
  if (!['main', 'detail', 'sku'].includes(asset.kind)) {
    return res.status(400).json({ ok: false, error: '当前仅支持删除展示图、规格图与详情图' });
  }

  const result = await deleteAssetsAndFiles(asset.offerId, asset.kind, [asset]);
  res.json({
    ok: true,
    deletedId: asset.id,
    fileRemoved: result.filesRemoved > 0,
    record: result.record,
    assets: result.assets
  });
});

app.delete('/api/results/:offerId/skus/:skuId', async (req, res) => {
  const offerId = String(req.params.offerId);
  const skuId = String(req.params.skuId);
  const outcome = await deleteSkuFromProduct(offerId, skuId);
  if (!outcome) return res.status(404).json({ ok: false, error: '未找到该商品' });
  if (outcome.notFound) return res.status(404).json({ ok: false, error: '未找到该 SKU 规格' });

  const result = await deleteAssetsAndFiles(offerId, 'sku', outcome.assetsToDelete);
  res.json({
    ok: true,
    deletedSkuId: skuId,
    removedAssets: result.deletedIds.length,
    filesRemoved: result.filesRemoved,
    record: result.record,
    assets: result.assets
  });
});

app.patch('/api/results/:offerId/assets/order', async (req, res) => {
  const offerId = String(req.params.offerId);
  const record = await getProduct(offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到该商品' });

  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (!orderedIds.length) return res.status(400).json({ ok: false, error: '缺少有序图片 ID 列表' });

  const assets = attachImageDimensions(await reorderMainAssets(offerId, orderedIds));
  res.json({ ok: true, record: await getProduct(offerId), assets });
});

app.post('/api/results/:offerId/assets/upload', async (req, res) => {
  const offerId = String(req.params.offerId);
  const record = await getProduct(offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到该商品' });

  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ ok: false, error: '请选择要上传的图片' });
  if (files.length > 20) return res.status(400).json({ ok: false, error: '单次最多上传 20 张图片' });

  const saved = [];
  try {
    for (const file of files) {
      saved.push(saveUploadedMainImage(offerId, file));
    }
    const assets = attachImageDimensions(await insertUploadedMainAssets(offerId, saved));
    res.json({ ok: true, uploaded: saved.length, record: await getProduct(offerId), assets });
  } catch (err) {
    for (const item of saved) removeAssetFile(item.localPath);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/results/:offerId/assets/clean-small', async (req, res) => {
  const offerId = String(req.params.offerId);
  const record = await getProduct(offerId);
  if (!record) return res.status(404).json({ ok: false, error: '未找到该商品' });

  const minSide = Math.max(100, Number(req.body?.minSide ?? 480) || 480);
  const assets = attachImageDimensions(await getAssets(offerId));
  const smalls = assets.filter(
    (a) => a.kind === 'main' && a.status === 'ok' && a.width && a.height && (a.width < minSide || a.height < minSide)
  );

  const result = await deleteAssetsAndFiles(offerId, 'main', smalls);
  res.json({
    ok: true,
    removedCount: result.deletedIds.length,
    filesRemoved: result.filesRemoved,
    record: result.record,
    assets: result.assets
  });
});

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
  const [refreshed] = attachImageDimensions([await getAssetById(asset.id)]);
  res.json({ ok: result.status === 'ok', asset: refreshed, error: result.error });
});

app.post('/api/results/:offerId/retry', async (req, res) => {
  const pending = await listPendingAssets(req.params.offerId);
  if (!pending.length) {
    return res.json({ ok: true, retried: 0, assets: attachImageDimensions(await getAssets(req.params.offerId)) });
  }

  const apply = async (asset, result) => {
    await updateAsset(asset.id, {
      local_path: result.localPath,
      bytes: result.bytes,
      status: result.status,
      error: result.error
    });
  };

  await downloadMany(pending, { concurrency: 4, onDone: apply });
  const assets = attachImageDimensions(await getAssets(req.params.offerId));
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
