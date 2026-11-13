/**
 * 临时诊断：对某个已采集商品，比对外观规格值 与 规格图 label 的匹配情况。
 */

import { DatabaseSync } from 'node:sqlite';
import { buildAssets } from '../server/media.mjs';

const offerId = process.argv[2];
if (!offerId) {
  console.error('用法：node scripts/tmp-preview-audit.mjs <offerId>');
  process.exit(1);
}

const db = new DatabaseSync('data/listing.db');
const row = db.prepare('SELECT product_json FROM products WHERE offer_id = ?').get(offerId);
if (!row) {
  console.log(`数据库里没有 ${offerId}`);
  process.exit(0);
}
const product = JSON.parse(row.product_json);

const dims = new Map();
for (const sku of product.skus ?? []) {
  for (const [key, value] of Object.entries(sku.specs ?? {})) {
    if (!dims.has(key)) dims.set(key, []);
    const list = dims.get(key);
    if (!list.includes(value)) list.push(value);
  }
}

console.log(`商品：${product.title}`);
console.log(`SKU 数：${(product.skus ?? []).length}`);
console.log('\n=== 1688 原始规格值 ===');
for (const [key, values] of dims) {
  console.log(`[${key}] ${values.length} 个值`);
  values.forEach((v) => console.log(`   · ${JSON.stringify(v)} len=${v.length}`));
}

const assets = buildAssets(product);
const skuAssets = assets.filter((a) => a.kind === 'sku');
console.log(`\n=== 规格图 label（共 ${skuAssets.length} 张） ===`);
skuAssets.slice(0, 40).forEach((a) => console.log(`   ${a.label}`));

// 一张图可能被多个规格值共用，label 里用 ; 分隔多个 `属性=值`
const labelNames = [];
for (const asset of skuAssets) {
  for (const entry of String(asset.label ?? '').split(';')) {
    const i = entry.indexOf('=');
    if (i >= 0) labelNames.push(entry.slice(i + 1).trim());
  }
}
const labelSet = new Set(labelNames);

console.log('\n=== 命中情况（原始值 vs 图片 label） ===');
let hit = 0;
let miss = 0;
for (const [key, values] of dims) {
  for (const value of values) {
    const ok = labelSet.has(value);
    if (ok) hit += 1;
    else {
      miss += 1;
      console.log(`   MISS [${key}] ${JSON.stringify(value)}`);
    }
  }
}
console.log(`命中 ${hit} / 未命中 ${miss}`);

// 模拟旧清洗逻辑（剥括号 + 截 20）
const legacy = (raw) =>
  String(raw)
    .replace(/[【\[（(][^】\]）)]*[】\]）)]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);

console.log('\n=== 旧清洗逻辑会变成什么 ===');
for (const [key, values] of dims) {
  for (const value of values) {
    const cleaned = legacy(value);
    if (cleaned !== value) {
      console.log(`   ${JSON.stringify(value)} -> ${JSON.stringify(cleaned)}  图片有吗: ${labelSet.has(cleaned) ? '有' : '无'}`);
    }
  }
}
