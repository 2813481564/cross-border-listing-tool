#!/usr/bin/env node
import { loadConfig, writeDefaultConfig } from './config.mjs';
import { ensureChrome, openWorkPage } from './chrome.mjs';
import { collectOffer } from './collector/index.mjs';
import { buildDraft, toCsv } from './draft/mercadolibre.mjs';
import { openDb, saveProduct, getProduct, listProducts, importLegacyResults, dbPath } from './db.mjs';
import { persistMedia, downloadMany } from './media.mjs';
import { getAssets, listPendingAssets, updateAsset } from './db.mjs';
import { pushRecord, rememberFailedPush, retryFailedPushes } from './remote.mjs';
import {
  fillPddProduct,
  localMainImagePaths,
  localDetailImagePaths,
  planSpecs,
  buildSkuRows,
  buildTitle,
  selectCarouselImages
} from './platforms/pdd/publish.mjs';

const [command, ...args] = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const flagValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

function usage() {
  console.log(`
用法:
  node --experimental-sqlite server/cli.mjs chrome                启动带调试端口的 Chrome(首次请登录 1688)
  node --experimental-sqlite server/cli.mjs collect <url|offerId>  采集 + 下载媒体 + 生成草稿
  node --experimental-sqlite server/cli.mjs retry-media [offerId] 补下载失败的媒体
  node --experimental-sqlite server/cli.mjs media <offerId>       按已采集数据重建媒体并下载
  node --experimental-sqlite server/cli.mjs push [offerId]        推送本地记录到线上服务器
  node --experimental-sqlite server/cli.mjs export-csv            导出全部为 CSV
  node --experimental-sqlite server/cli.mjs list                  列出已存商品
  node --experimental-sqlite server/cli.mjs pdd-fill <offerId>    在浏览器里填拼多多发布表单（不提交）

选项:
  --json           输出 JSON
  --no-media       不下载媒体
  --api            强制走 1688 开放平台接口采集
  --browser        强制走浏览器采集
  --dry-run        只打印规格与价格映射，不动浏览器
  --max-skus <n>   临时改 SKU 组合上限（默认 100）
  --use-sku-price  每个 SKU 按各自 1688 价换算
  --no-spec        不自动加规格，退回单规格
  --markup <n>     临时改加价倍数（成本 × n）
  --add <n>        临时改固定加价（成本 + n 元）
  --mode <m>       加价方式：markup | add
`);
}

async function runChrome() {
  const { port } = await ensureChrome();
  const { page } = await openWorkPage();
  await page.goto('https://www.1688.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log(`Chrome 调试端口: ${port}，已打开 1688 首页，请登录后保持窗口不关闭。`);
}

async function runCollect(urls) {
  writeDefaultConfig();
  await openDb();
  await importLegacyResults();

  const config = loadConfig();
  const withMedia = !flags.includes('--no-media');
  const results = [];

  for (const url of urls) {
    process.stderr.write(`采集中: ${url}\n`);
    try {
      const product = await collectOffer(url, {
        mode: flags.includes('--api') ? 'api' : flags.includes('--browser') ? 'browser' : undefined,
        waitTimeoutMs: config.collect.waitTimeoutMs,
        dumpRaw: config.collect.dumpRaw,
        imagesMax: config.images.maxCount
      });
      if (product.apiFallback) {
        process.stderr.write(`  API 未命中（${product.apiFallback.reason}），已回落浏览器采集\n`);
      }
      const built = buildDraft(product, config.mercadolibre);
      const record = {
        offerId: product.offerId,
        product,
        draft: built.draft,
        warnings: built.warnings,
        meta: built.meta,
        savedAt: new Date().toISOString()
      };
      await saveProduct(record);

      let mediaLine = '媒体未下载';
      if (withMedia) {
        const assets = await persistMedia(product.offerId, product);
        const ok = assets.filter((a) => a.status === 'ok').length;
        const failed = assets.filter((a) => a.status === 'failed').length;
        mediaLine = `媒体 ${ok}/${assets.length} 已本地${failed ? `，${failed} 个失败` : ''}`;
      }

      // 推送到线上服务器（如果配置了）
      if (config.remote?.enabled) {
        const push = await pushRecord(record, config);
        if (push.ok) {
          process.stderr.write(`  已推送至 ${config.remote.baseUrl}\n`);
        } else if (push.skipped) {
          process.stderr.write(`  推送跳过: ${push.reason}\n`);
        } else {
          rememberFailedPush(record, push.error);
          process.stderr.write(`  推送失败: ${push.error}（可用 retry-push 重推）\n`);
        }
      }

      results.push({ record, mediaLine });
      process.stderr.write(
        `  OK ${product.offerId} | ${product.title ?? '(无标题)'} | 图 ${product.images.length} | ${mediaLine}\n`
      );
    } catch (err) {
      process.stderr.write(`  FAIL ${url}: ${err.message}\n`);
    }
  }

  if (flags.includes('--json')) {
    console.log(JSON.stringify(results.map((r) => r.record), null, 2));
  } else {
    for (const { record, mediaLine } of results) {
      console.log(`\n=== ${record.offerId} ===`);
      console.log(`标题(原): ${record.product.title}`);
      console.log(`标题(草稿): ${record.draft.title}`);
      console.log(`价格: CNY ${record.product.price.min} -> ${record.draft.price} ${record.draft.currency_id}`);
      console.log(`参数: ${record.draft.attributes.length} 项（有ID ${record.draft.mapped_attribute_count}）`);
      console.log(`规格: ${record.draft.variations.length} 个`);
      console.log(`重量: ${record.draft.package?.weight_g ?? '-'} g`);
      console.log(mediaLine);
      if (record.warnings.length) console.log(`提示:\n${record.warnings.map((w) => `  [${w.level}] ${w.message}`).join('\n')}`);
    }
  }
  console.log(`\n数据已存入 ${dbPath()}`);
}

async function runRetryMedia(offerId) {
  await openDb();
  const targets = offerId ? [offerId] : (await listProducts()).map((r) => r.offerId);
  for (const id of targets) {
    const pending = await listPendingAssets(id);
    if (!pending.length) continue;
    process.stderr.write(`补下载 ${id}: ${pending.length} 个\n`);
    await downloadMany(pending, {
      concurrency: 4,
      onDone: (asset, result) =>
        updateAsset(asset.id, {
          local_path: result.localPath,
          bytes: result.bytes,
          status: result.status,
          error: result.error
        })
    });
    const assets = await getAssets(id);
    const ok = assets.filter((a) => a.status === 'ok').length;
    console.log(`${id}: ${ok}/${assets.length} 已本地`);
  }
}

async function runExportCsv() {
  await openDb();
  await importLegacyResults();
  const list = await listProducts();
  const records = [];
  for (const item of list) {
    const record = await getProduct(item.offerId);
    if (record) records.push(record);
  }
  const csv = toCsv(records);
  const out = new URL('../data/listing-desk.csv', import.meta.url);
  const fs = await import('node:fs');
  fs.writeFileSync(out, `\uFEFF${csv}`, 'utf8');
  console.log(`已导出 ${records.length} 条`);
}

/** 全量/指定重推：比内存队列可靠，服务重启后也能补推 */
async function runRetryPush(offerId) {
  const config = loadConfig();
  if (!config.remote?.enabled) return console.log('未启用远程推送，请先在 config/settings.json 配置 remote');

  const targets = offerId ? [{ offerId }] : await listProducts();
  if (!targets.length) return console.log('本地没有可推送的记录');

  let ok = 0;
  for (const item of targets) {
    const record = await getProduct(item.offerId);
    if (!record) continue;
    const result = await pushRecord(record, config);
    if (result.ok) {
      ok += 1;
      console.log(`${item.offerId}: 已推送`);
    } else {
      console.log(`${item.offerId}: 失败 ${result.error}`);
    }
  }
  console.log(`\n完成 ${ok}/${targets.length}`);
}

async function runPddFill(offerId) {
  if (!offerId) {
    console.error('用法：cli.mjs pdd-fill <offerId>');
    process.exit(1);
  }
  await openDb();
  const record = await getProduct(offerId);
  if (!record) {
    console.error(`未找到商品 ${offerId}，请先采集`);
    process.exit(1);
  }

  const config = loadConfig();
  const rules = { ...(config.platforms?.pdd?.publish ?? {}) };
  if (flagValue('max-skus')) rules.maxSkus = Number(flagValue('max-skus'));
  if (flags.includes('--use-sku-price')) rules.useSkuPrice = true;
  if (flags.includes('--no-spec')) rules.multiSpec = false;
  if (flagValue('markup')) {
    rules.priceMode = 'markup';
    rules.markup = Number(flagValue('markup'));
  }
  if (flagValue('add')) {
    rules.priceMode = 'add';
    rules.addAmount = Number(flagValue('add'));
  }
  if (flagValue('mode')) rules.priceMode = flagValue('mode');

  const assets = await getAssets(offerId);
  const images = localMainImagePaths(assets);

  if (flags.includes('--dry-run')) {
    const plan = planSpecs(record.product, rules);
    const rows = plan.dims.length ? buildSkuRows(record.product, plan, rules) : [];
    console.log(`标题: ${buildTitle(record.product, rules).title}`);
    console.log(`规格维度: ${plan.dims.map((d) => `${d.sourceKey}→${d.pddType}(${d.values.length})`).join(' × ') || '(无)'}`);
    if (plan.skipped.length) console.log(`跳过维度: ${plan.skipped.join('、')}`);
    (plan.truncated ?? []).forEach((t) =>
      console.log(`截断: ${t.pddType} 保留 ${t.kept} 个值，丢弃 ${t.dropped} 个`)
    );
    if (plan.reason) console.log(`规格未启用: ${plan.reason}`);
    rows.forEach((r, i) =>
      console.log(
        `SKU${i + 1}: ${Object.entries(r.specs).map(([k, v]) => `${k}:${v}`).join(' / ')} | 库存${r.stock} | 拼单价${r.group} | 单买价${r.single} | ${r.sku?.skuId ?? '无对应SKU'}`
      )
    );

    const { allowed, skipped } = selectCarouselImages(images, rules);
    console.log(`\n轮播图: 可用 ${allowed.length} 张，跳过 ${skipped.length} 张`);
    skipped.forEach((s) => console.log(`  ✗ ${s.file}：${s.reason}`));
    return;
  }

  const detailImages = localDetailImagePaths(assets);
  process.stderr.write(`拼多多填表：${offerId}，本地主图 ${images.length} 张、详情图 ${detailImages.length} 张\n`);
  const report = await fillPddProduct({
    product: record.product,
    images,
    detailImages,
    assets,
    rules
  });

  if (flags.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n页面: ${report.url}`);
  console.log(`类目: ${report.category || '(未识别)'}`);
  console.log(`标题: ${report.title}`);
  if (report.prices) {
    console.log(
      `价格: 拼单价 ${report.prices.group} / 单买价 ${report.prices.single} / 参考价 ${report.prices.reference}`
    );
  }
  console.log('\n已填:');
  report.filled.forEach((f) => console.log(`  ✓ ${f.field}: ${f.value}`));
  console.log('\n待人工:');
  report.pending.forEach((p) => console.log(`  · ${p}`));
}

/**
 * 按数据库里已采集的商品重建媒体清单并下载（不重新访问 1688）。
 * 用于：改了采集逻辑后补齐缺失的详情图等，而不用整单重采。
 */
async function runMedia(offerId) {
  if (!offerId) {
    console.error('用法：cli.mjs media <offerId> [--no-video]');
    process.exit(1);
  }
  await openDb();
  const record = await getProduct(offerId);
  if (!record) {
    console.error(`未找到商品 ${offerId}`);
    process.exit(1);
  }

  const product = record.product;
  if (flags.includes('--no-video')) {
    product.videos = [];
  }

  const assets = await persistMedia(offerId, product);
  const ok = assets.filter((a) => a.status === 'ok').length;
  const failed = assets.filter((a) => a.status === 'failed').length;
  const byKind = assets.reduce((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`媒体清单：${JSON.stringify(byKind)}`);
  console.log(`下载完成 ${ok}/${assets.length}${failed ? `，失败 ${failed}（可用 retry-media 补）` : ''}`);
}

async function runList() {
  await openDb();
  await importLegacyResults();
  const items = await listProducts();
  if (!items.length) return console.log('暂无记录');
  for (const i of items) {
    console.log(`${i.offerId} | ${i.price ?? '-'} ${i.currency ?? ''} | 媒体 ${i.mediaOk}/${i.mediaTotal} | ${i.title}`);
  }
}

switch (command) {
  case 'chrome':
    await runChrome();
    break;
  case 'collect':
    if (!positional.length) {
      usage();
      process.exit(1);
    }
    await runCollect(positional);
    break;
  case 'retry-media':
    await runRetryMedia(positional[0]);
    break;
  case 'media':
    await runMedia(positional[0]);
    break;
  case 'push':
  case 'retry-push':
    await runRetryPush(positional[0]);
    break;
  case 'pdd-fill':
    await runPddFill(positional[0]);
    break;
  case 'export-csv':
    await runExportCsv();
    break;
  case 'list':
    await runList();
    break;
  default:
    usage();
}
