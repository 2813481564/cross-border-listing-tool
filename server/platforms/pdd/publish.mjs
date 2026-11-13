/**
 * 拼多多「半自动填表」发布流程。
 *
 * 设计原则：
 *  - 在真实浏览器里操作（CDP 连接用户已登录的 Chrome），不伪造请求
 *  - 字段按可见文字/placeholder 定位，不写死 DOM 路径，降低改版影响
 *  - 只填不提交：提交按钮永不自动点击
 */

import path from 'node:path';
import { openWorkPage } from '../../chrome.mjs';
import { ROOT } from '../../config.mjs';
import { readImageInfo } from '../../image-info.mjs';

export const PUBLISH_URL = 'https://mms.pinduoduo.com/goods/category';

/** 从 assets 里取本地主图绝对路径，按 seq 排序。 */
export function localMainImagePaths(assets) {
  return (assets ?? [])
    .filter((a) => a.kind === 'main' && a.status === 'ok' && a.localPath)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((a) => path.join(ROOT, 'data', a.localPath));
}

/**
 * 按拼多多轮播图规则筛选本地图片。
 *
 * 平台要求：宽高比 1:1 或 3:4、宽高均 > 480px、单张 ≤ 3MB。
 * 1688 页面上会混进小图（如 336x338 的图标/缩略图），必须在上传前剔除，
 * 否则拼多多会报“商品主图尺寸不对”。
 */
export function selectCarouselImages(paths, rules = {}) {
  const minSide = Number(rules.imageMinSide ?? 480);
  const maxBytes = Number(rules.imageMaxBytes ?? 3 * 1024 * 1024);
  const max = Number(rules.imageMax ?? 10);
  const tolerance = Number(rules.imageRatioTolerance ?? 0.03);

  const allowed = [];
  const skipped = [];

  for (const filePath of paths ?? []) {
    if (allowed.length >= max) break;
    const info = readImageInfo(filePath);
    const name = path.basename(filePath);

    if (!info) {
      skipped.push({ file: name, reason: '读不出尺寸' });
      continue;
    }
    if (info.width < minSide || info.height < minSide) {
      skipped.push({ file: name, reason: `${info.width}x${info.height} 小于 ${minSide}px` });
      continue;
    }
    const ratio = info.width / info.height;
    const ratioOk = Math.abs(ratio - 1) <= tolerance || Math.abs(ratio - 0.75) <= tolerance;
    if (!ratioOk) {
      skipped.push({ file: name, reason: `比例 ${ratio.toFixed(2)}，不是 1:1 或 3:4` });
      continue;
    }
    if (info.bytes > maxBytes) {
      skipped.push({ file: name, reason: `${(info.bytes / 1024 / 1024).toFixed(1)}MB 超过 3MB` });
      continue;
    }
    allowed.push(filePath);
  }

  return { allowed, skipped };
}

/** 从 assets 里取本地详情长图绝对路径，按 seq 排序。 */
export function localDetailImagePaths(assets) {
  return (assets ?? [])
    .filter((a) => a.kind === 'detail' && a.status === 'ok' && a.localPath)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((a) => path.join(ROOT, 'data', a.localPath));
}

/** 打开（或复用）发布页标签。 */
export async function openPublishPage({ fresh = false } = {}) {
  const { context, page: newPage } = await openWorkPage();

  if (!fresh) {
    const existing = context.pages().find((p) => p.url().includes('/goods/category'));
    if (existing) {
      if (existing !== newPage) await newPage.close().catch(() => {});
      await existing.bringToFront().catch(() => {});
      return { page: existing, created: false };
    }
  }

  await newPage.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await newPage.bringToFront().catch(() => {});
  return { page: newPage, created: true };
}

/** 等页面稳定：网络空闲 + 固定缓冲，任何一步失败都不抛错。 */
export async function settle(page, ms = 800) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

/**
 * 填文本输入框。
 * React/Vue 受控组件必须走原生 setter + input 事件，locator.fill 已包含该逻辑；
 * 这里再补 blur，让表单触发校验与联动。
 */
export async function fillText(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.click({ timeout: 10000 }).catch(() => {});
  await locator.fill('');
  await locator.fill(String(value));
  await locator.evaluate((el) => el.blur());
}

/** 按 placeholder 包含文字定位输入框。 */
export function inputByPlaceholder(page, text) {
  return page.locator(`input[placeholder*="${text}"], textarea[placeholder*="${text}"]`).first();
}

/** 给文件输入控件塞本地图片（可隐藏）。 */
export async function uploadImages(page, filePaths, { perFileWaitMs = 1500 } = {}) {
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 20000 });
  await input.setInputFiles(filePaths);
  await page.waitForTimeout(perFileWaitMs * Math.max(1, filePaths.length));
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

/** 按按钮文字点击（精确包含匹配）。 */
export async function clickByText(page, text, { timeout = 20000 } = {}) {
  const btn = page
    .locator('button, [role="button"], a')
    .filter({ hasText: new RegExp(text) })
    .first();
  await btn.waitFor({ state: 'visible', timeout });
  await btn.click();
  return btn;
}

/* ---------------- 价格与标题规则 ---------------- */

/** 按尾数取整：19.4 + '.9' -> 19.9 */
export function fitEnding(value, ending = '.9') {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!ending) return Math.round(num * 100) / 100;
  const e = Number.parseFloat(ending);
  const safe = Number.isFinite(e) ? e : 0.9;
  return Number((Math.max(1, Math.floor(num)) + safe).toFixed(2));
}

/**
 * 拼多多价格方案。
 *
 * 两种加价方式：
 *  - markup：拼单价 = 成本 × markup（倍数）
 *  - add：   拼单价 = 成本 + addAmount（固定加价，单位元）
 *
 * 拼单价 ≤ 单买价 < 参考价，参考价需大于最大单买价。
 */
export function planPrices(costCny, rules) {
  const mode = rules.priceMode === 'add' ? 'add' : 'markup';
  const markup = Number(rules.markup ?? 1.35);
  const addAmount = Number(rules.addAmount ?? 0);
  const singleRatio = Number(rules.singleRatio ?? 1.2);
  const refRatio = Number(rules.refRatio ?? 1.6);
  const ending = rules.priceEnding ?? '.9';

  const cost = Number(costCny) > 0 ? Number(costCny) : null;
  if (!cost) return null;

  const groupRaw = mode === 'add' ? cost + addAmount : cost * markup;
  const group = fitEnding(groupRaw, ending);
  if (!group) return null;

  const singleRaw = Math.max(group + 1, groupRaw * singleRatio);
  const single = fitEnding(singleRaw, ending);
  const reference = fitEnding(Math.max(single + 2, single * refRatio), ending);
  return { cost, group, single, reference, markup, addAmount, mode, ending };
}

/** 拼多多标题：去噪声后按字数截断（英文按 1 字算，最多 titleMaxLength）。 */
export function buildTitle(product, rules) {
  const max = Number(rules.titleMaxLength ?? 30);
  const noise = /\s+/g;
  const raw = String(product?.title ?? '').replace(noise, ' ').trim();
  const parts = raw.split(/[，,。;；|/\\]+/).map((s) => s.trim()).filter(Boolean);
  let title = parts.length ? parts[0] : raw;
  if (title.length > max) title = title.slice(0, max);
  return { title, truncated: title.length !== raw.length };
}

/* ---------------- 第二步字段填充 ---------------- */

/** 读当前推荐类目。 */
async function readCategory(page) {
  const text = await page
    .evaluate(() => {
      const body = document.body.innerText || '';
      const m = body.match(/商品分类\s*([^\n]{2,80}?)\s*修改分类/);
      return m ? m[1].trim() : '';
    })
    .catch(() => '');
  return text;
}

/** 1688 规格名 → 拼多多规格类型。顺序即优先级。 */
const SPEC_TYPE_MAP = [
  { pdd: '颜色', pattern: /颜色|色彩|色系|色号/ },
  { pdd: '尺码', pattern: /尺码|码数|大小/ },
  { pdd: '尺寸', pattern: /尺寸|规格|长宽|长度|宽度|高度|厚度/ },
  { pdd: '款式', pattern: /款式|型号|风格|样式/ },
  { pdd: '材质', pattern: /材质|面料|成分/ },
  { pdd: '容量', pattern: /容量|毫升|升数|净含量/ },
  { pdd: '口味', pattern: /口味|味道|香型/ },
  { pdd: '包装方式', pattern: /包装/ },
  { pdd: '组合', pattern: /组合|套餐|套装/ },
  { pdd: '重量', pattern: /重量|克重/ }
];

/** 规格值上限（拼多多规格值可填 40 字）。 */
export const SPEC_VALUE_MAX = 40;

/**
 * 规格值清洗：只压平空白、去首尾空格，**保留【】等后缀原文**。
 *
 * 关键：图片 label 存的是 1688 原始值（`属性=值`），一旦改写值就匹配不上，
 * 所以除长度上限外不做任何变形。
 */
function cleanSpecValue(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return text.length > SPEC_VALUE_MAX ? text.slice(0, SPEC_VALUE_MAX) : text;
}

/** 从 SKU 里收集规格维度（保持出现顺序）。 */
function collectSpecDims(product) {
  const dims = [];
  const index = new Map();
  for (const sku of product?.skus ?? []) {
    for (const [key, rawValue] of Object.entries(sku?.specs ?? {})) {
      const val = cleanSpecValue(rawValue);
      if (!key || !val) continue;
      if (!index.has(key)) {
        const dim = { sourceKey: key, values: [] };
        index.set(key, dim);
        dims.push(dim);
      }
      const dim = index.get(key);
      if (!dim.values.includes(val)) dim.values.push(val);
    }
  }
  return dims;
}

/**
 * 规格值形态校正：名字叫「规格」但值是「香炉款式」时，应该用款式而不是尺寸。
 */
function refineSpecType(pddType, values) {
  if (pddType !== '尺寸' && pddType !== '尺码') return pddType;
  const sizeLike = values.filter((v) => /\d/.test(v) && /(cm|mm|CM|MM|×|x|X|\*|\*)/.test(v)).length;
  if (pddType === '尺寸' && sizeLike * 2 < values.length) return '款式';
  return pddType;
}

/**
 * 规划规格：1688 维度 → 拼多多规格类型（最多 2 个）。
 * @returns {{dims:Array<{pddType:string,sourceKey:string,values:string[]}>,skipped:string[],combos:number,reason?:string}}
 */
export function planSpecs(product, rules = {}) {
  const dims = collectSpecDims(product);
  if (!dims.length) return { dims: [], skipped: [], combos: 0, reason: '没有带规格的 SKU' };

  const maxTypes = Math.min(2, Number(rules.maxSpecTypes ?? 2));
  const picked = [];
  const skipped = [];

  for (const dim of dims) {
    if (picked.length >= maxTypes) {
      skipped.push(dim.sourceKey);
      continue;
    }
    const hit = SPEC_TYPE_MAP.find((r) => r.pattern.test(dim.sourceKey));
    if (!hit) {
      skipped.push(dim.sourceKey);
      continue;
    }
    const pddType = refineSpecType(hit.pdd, dim.values);
    if (picked.some((p) => p.pddType === pddType)) {
      skipped.push(dim.sourceKey);
      continue;
    }
    picked.push({ pddType, sourceKey: dim.sourceKey, values: dim.values.slice(0, 50) });
  }

  if (!picked.length) {
    return { dims: [], skipped, combos: 0, reason: '规格名无法映射到拼多多规格类型' };
  }

  let combos = picked.reduce((n, d) => n * d.values.length, 1);
  const maxSkus = Number(rules.maxSkus ?? 100);
  const truncated = [];

  // 组合超上限时，从最后一个维度往前截断，尽量保住规格结构
  if (combos > maxSkus) {
    for (let i = picked.length - 1; i >= 0 && combos > maxSkus; i -= 1) {
      const dim = picked[i];
      const others = picked.reduce((n, d, idx) => (idx === i ? n : n * d.values.length), 1) || 1;
      const keep = Math.max(1, Math.floor(maxSkus / others));
      if (keep < dim.values.length) {
        truncated.push({
          pddType: dim.pddType,
          kept: keep,
          dropped: dim.values.length - keep,
          droppedSample: dim.values.slice(keep, keep + 3)
        });
        dim.values = dim.values.slice(0, keep);
        combos = others * dim.values.length;
      }
    }
    if (combos > maxSkus) {
      return { dims: [], skipped, combos, truncated, reason: `规格组合 ${combos} 个超过上限 ${maxSkus}` };
    }
  }

  return { dims: picked, skipped, combos, truncated };
}

/** 生成 SKU 行（顺序：第一规格外层，第二规格内层，与页面一致）。 */
export function buildSkuRows(product, plan, rules = {}) {
  const dims = plan?.dims ?? [];
  if (!dims.length) return [];

  const matrix = [];
  const walk = (i, acc) => {
    if (i === dims.length) {
      matrix.push({ ...acc });
      return;
    }
    for (const value of dims[i].values) walk(i + 1, { ...acc, [dims[i].pddType]: value });
  };
  walk(0, {});

  const skuIndex = new Map();
  for (const sku of product?.skus ?? []) {
    const key = dims.map((d) => cleanSpecValue(sku?.specs?.[d.sourceKey])).join('|');
    if (key) skuIndex.set(key, sku);
  }

  const basePrice = planPrices(product?.price?.min, rules);
  return matrix.map((specs) => {
    const key = dims.map((d) => specs[d.pddType]).join('|');
    const sku = skuIndex.get(key) ?? null;
    const cost = rules.useSkuPrice && sku?.price ? sku.price : product?.price?.min;
    const prices = planPrices(cost, rules) ?? basePrice;
    return {
      specs,
      sku,
      // 1688 没有这个组合（矩形展开产生的空档）→ 库存 0，避免虚库存超卖
      stock: sku ? Number(sku.stock ?? rules.stock ?? 999) : 0,
      group: prices?.group ?? '',
      single: prices?.single ?? '',
      specCode: rules.specCodePrefix ? `${rules.specCodePrefix}${product?.offerId ?? ''}-${sku?.skuId ?? ''}` : ''
    };
  });
}

/**
 * 规格图索引：`属性|值` 精确命中优先，其次按值名命中。
 *
 * 1688 的 assets.label 形如 `颜色=40*60*32cm【免抽立体式】`，值必须原样比对，
 * 任何改写都会导致匹配失败。
 */
export function skuImageMap(assets) {
  const byName = {};
  const byProp = {};
  for (const asset of assets ?? []) {
    if (asset.kind !== 'sku' || asset.status !== 'ok' || !asset.localPath || !asset.label) continue;
    const localPath = path.join(ROOT, 'data', asset.localPath);

    // 一张图可能对应多个规格值，label 用 ; 分隔
    for (const entry of String(asset.label).split(';')) {
      const idx = entry.indexOf('=');
      if (idx < 0) continue;
      const prop = entry.slice(0, idx).trim();
      const name = entry.slice(idx + 1).trim();
      if (!name) continue;
      if (!byProp[`${prop}|${name}`]) byProp[`${prop}|${name}`] = localPath;
      if (!byName[name]) byName[name] = localPath;
    }
  }
  return { byName, byProp };
}

/**
 * 从第一步进第二步。
 *
 * 坑：拼多多有概率在新标签页打开完善信息页；也会因为图片还在处理而点不动「下一步」。
 * 因此：等按钮可用 → 点 → 同时盯原页与新页 → 最多重试 3 轮，失败时把页面提示带出来。
 */
async function goNextStep(page) {
  const context = page.context();
  const pagesBefore = new Set(context.pages());

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const btn = page.locator('button, [role="button"], a').filter({ hasText: /下一步/ }).first();
    if (!(await btn.count())) throw new Error('找不到「下一步」按钮，页面可能已改版');

    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await btn.click({ timeout: 10000 }).catch(() => {});

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (/goods_add/.test(page.url())) return page;
      const fresh = context.pages().find((p) => !pagesBefore.has(p) && /goods_add/.test(p.url()));
      if (fresh) return fresh;
      await page.waitForTimeout(400);
    }
  }

  // 兜底：草稿页有时比预期更晚出现，再扫 15 秒
  const tailDeadline = Date.now() + 15000;
  while (Date.now() < tailDeadline) {
    if (/goods_add/.test(page.url())) return page;
    const late = context.pages().find((p) => !pagesBefore.has(p) && /goods_add/.test(p.url()));
    if (late) return late;
    await page.waitForTimeout(500);
  }

  const hint = await page
    .evaluate(() => {
      const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
      const m = text.match(/[^。\n]{0,30}(不能为空|请上传|不合规|失败|必填|更清晰)[^。\n]{0,30}/);
      return m ? m[0].trim() : text.slice(0, 160);
    })
    .catch(() => '');

  throw new Error(`点击「下一步」后未进入完善信息页。页面提示：${hint || '(未捕获到提示)'}`);
}

/** 商品详情（快捷编辑区）：直接往详情区塞长图。 */
async function fillDetailImages(page, paths) {
  const zone = page.locator('.decoration-operate').first();
  if (!(await zone.count())) return { ok: false, reason: '未找到商品详情区' };

  const input = zone.locator('input[type="file"]').first();
  if (!(await input.count())) return { ok: false, reason: '详情区没有上传控件' };

  await input.setInputFiles(paths);
  await page.waitForTimeout(1000 * Math.min(paths.length, 6));
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  return { ok: true, count: paths.length };
}

/* ---------------- 规格与价格表格 ---------------- */

/**
 * 定位「规格类型」下拉。
 * 不同商品/版本的容器 id 不一样（有的是 #spec_new，有的没有），
 * 所以优先按 placeholder 里含「规格类型」的输入框反查所属 select。
 */
async function specTypeSelect(page, index) {
  const byContainer = page.locator('#spec_new [data-testid="beast-core-select-header"]');
  if (await byContainer.count()) return byContainer.nth(index);

  const holder = page.locator('input[placeholder*="规格类型"]').nth(index);
  if (await holder.count()) {
    const select = holder.locator('xpath=ancestor::*[@data-testid="beast-core-select"][1]');
    const header = select.locator('[data-testid="beast-core-select-header"]');
    if (await header.count()) return header.first();
    return holder;
  }
  return null;
}

async function clickAddSpecType(page) {
  const btn = page.locator('button').filter({ hasText: /添加规格类型/ }).first();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();

  // 等规格类型下拉出现；没有就再点一次（偶尔首次点击不生效）
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForTimeout(700);
    if (await specTypeSelect(page, 0)) return true;
    await btn.click({ timeout: 5000 }).catch(() => {});
  }
  return false;
}

async function chooseSpecType(page, typeIndex, pddType) {
  const header = await specTypeSelect(page, typeIndex);
  if (!header) return false;

  await header.click({ timeout: 15000 });
  await page.waitForTimeout(700);

  const option = page.locator('[class*="cIL_item"]').filter({ hasText: new RegExp(`^${pddType}$`) }).first();
  if (!(await option.count())) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await option.click();
  await page.waitForTimeout(900);
  return true;
}

/**
 * 「商品规格」区域容器。
 * 页面有两个版本：一个 id 是 #spec_new，一个是 #newSpec；
 * 再兜底按 label「商品规格」反查表单项。
 */
async function specScope(page) {
  const byId = page.locator('#spec_new, #newSpec');
  if (await byId.count()) return byId.first();

  const label = page.locator('label').filter({ hasText: /^商品规格$/ }).first();
  if (await label.count()) {
    const item = label.locator('xpath=ancestor::*[@data-testid="beast-core-form-item"][1]');
    if (await item.count()) return item.first();
  }
  return null;
}

async function addSpecValues(page, values) {
  const scope = await specScope(page);
  if (!scope) return [];

  // 规格值的输入框 placeholder 随类型变化（颜色=请输入规格名称、尺寸=自定义尺寸…），
  // 所以统一取「区域内可编辑的文本框」的最后一个
  const editable = scope.locator('input[type="text"]:not([readonly])');
  const added = [];

  for (const value of values) {
    const last = editable.last();
    if (!(await last.count())) break;
    if ((await last.inputValue().catch(() => 'x')) !== '') break;
    await last.click();
    await last.fill(String(value));
    await last.press('Enter');
    await page.waitForTimeout(600);
    const current = await editable.evaluateAll((els) => els.map((el) => el.value));
    if (current.includes(String(value))) added.push(String(value));
  }
  return added;
}

/**
 * 按「价格及库存」表头逐行填值。
 * 规格列数会因 rowspan 合并而不同，所以按「输入框顺序 = 数值列顺序」映射。
 */
async function fillSkuRows(page, rows, { previewPath } = {}) {
  const headerTable = page.locator('table').filter({ hasText: '拼单价' }).first();
  await headerTable.waitFor({ state: 'visible', timeout: 20000 });

  const headers = (await headerTable.locator('thead th, thead td').allInnerTexts()).map((h) =>
    h.replace(/\s+/g, '')
  );
  const cols = headers.filter((h) => /库存|拼单价|单买价|规格编码|商品编码/.test(h));

  // 坑：SKU 多时拼多多把「表头」和「数据行」拆成两个 table，
  // 表头那个 tbody 是空的，所以必须挑“行数最多”的 table 来填。
  const tables = page.locator('table');
  const tableCount = await tables.count();
  let trs = null;
  let total = 0;
  for (let i = 0; i < tableCount; i += 1) {
    const candidate = tables.nth(i).locator('tbody tr');
    const n = await candidate.count();
    if (n > total) {
      total = n;
      trs = candidate;
    }
  }
  if (!trs || total === 0) {
    trs = headerTable.locator('tbody tr');
    total = await trs.count();
  }

  const limit = Math.min(total, rows.length);
  const results = [];

  for (let i = 0; i < limit; i += 1) {
    const tr = trs.nth(i);
    const inputs = tr.locator('input:not([type="file"])');
    const count = await inputs.count();
    if (count < cols.length) {
      results.push({ ok: false, reason: `第 ${i + 1} 行输入框不足（${count}/${cols.length}）` });
      continue;
    }

    for (let c = 0; c < cols.length; c += 1) {
      const label = cols[c];
      const row = rows[i];
      const value = label.includes('库存')
        ? row.stock
        : label.includes('拼单价')
          ? row.group
          : label.includes('单买价')
            ? row.single
            : label.includes('规格编码')
              ? row.specCode
              : row.goodsCode;
      if (value === undefined || value === null || value === '') continue;
      const input = inputs.nth(c);
      await input.click().catch(() => {});
      await input.fill(String(value));
      await input.evaluate((el) => el.blur());
    }

    const file = tr.locator('input[type="file"]').first();
    if (previewPath && (await file.count())) {
      const filePath = previewPath(rows[i]);
      if (filePath) {
        await file.setInputFiles(filePath).catch(() => {});
        await page.waitForTimeout(600);
      }
    }

    results.push({ ok: true, row: rows[i] });
  }

  return { cols, results, total, filled: limit };
}

/**
 * 填一个商品，走到「提交并上架」之前停下。
 *
 * @param {object} options
 * @param {object} options.product  采集到的商品（含 title / price.min / skus）
 * @param {string[]} options.images 本地主图绝对路径（已按顺序排好）
 * @param {object[]} options.assets 媒体清单（用于取规格图做 SKU 预览图）
 * @param {object} options.rules    platforms.pdd.publish 配置
 * @returns {Promise<{url:string, filled:object[], pending:string[], title:string, prices:object|null, category:string, skuCount:number}>}
 */
export async function fillPddProduct({ product, images, detailImages = [], assets = [], rules = {} }) {
  const filled = [];
  const pending = [];

  const opened = await openPublishPage({ fresh: true });
  let page = opened.page;
  await settle(page, 1500);

  const { title } = buildTitle(product, rules);
  if (!title) throw new Error('商品标题为空，无法填写');

  await fillText(inputByPlaceholder(page, '商品标题'), title);
  filled.push({ field: '商品标题', value: title });

  if (!(images ?? []).length) throw new Error('没有本地主图，请先完成媒体下载');

  const { allowed: picked, skipped: skippedImages } = selectCarouselImages(images, rules);
  if (!picked.length) {
    throw new Error('没有符合拼多多要求的轮播图（需 1:1 或 3:4、边长 >480px、≤3MB）');
  }
  await uploadImages(page, picked, { perFileWaitMs: 1200 });
  filled.push({ field: '商品轮播图', value: `${picked.length} 张` });

  if (skippedImages.length) {
    const detail = skippedImages
      .slice(0, 3)
      .map((s) => `${s.file}（${s.reason}）`)
      .join('、');
    pending.push(
      `跳过 ${skippedImages.length} 张不合规主图：${detail}${skippedImages.length > 3 ? ' 等' : ''}`
    );
  }
  if (picked.length < 3) pending.push('轮播图少于 3 张，建议补图');

  await settle(page, 2500);
  page = await goNextStep(page);
  await settle(page, 3000);

  const category = await readCategory(page);

  if (rules.autoAttributes !== false) {
    const reuse = page.locator('button, [role="button"]').filter({ hasText: /一键复用/ }).first();
    if (await reuse.count()) {
      await reuse.click({ timeout: 5000 }).catch(() => {});
      await settle(page, 1500);
      filled.push({ field: '商品属性', value: '一键复用平台匹配属性' });
      pending.push('属性值来自平台相似品匹配，请核对工艺/面料/图案等是否属实');
    } else {
      pending.push('未找到「一键复用」，属性需手动选择');
    }
  } else {
    pending.push('商品属性未自动填（按配置跳过）');
  }

  const prices = planPrices(product?.price?.min, rules);

  // 规格：1688 的规格维度 → 拼多多规格类型，最多 2 个
  const plan = rules.multiSpec === false ? { dims: [], skipped: [], combos: 0 } : planSpecs(product, rules);
  let skuRows = [];

  if (plan.dims.length) {
    let specOk = true;
    for (let i = 0; i < plan.dims.length; i += 1) {
      const dim = plan.dims[i];
      const rowReady = await clickAddSpecType(page);
      if (!rowReady) {
        pending.push('点击「添加规格类型」后没有出现规格行，规格需手动添加');
        specOk = false;
        break;
      }
      const pickedType = await chooseSpecType(page, i, dim.pddType);
      if (!pickedType) {
        pending.push(`规格类型「${dim.pddType}」在页面下拉里没找到，规格需手动`);
        specOk = false;
        break;
      }
      const added = await addSpecValues(page, dim.values);
      if (added.length !== dim.values.length) {
        pending.push(`规格「${dim.pddType}」只写入 ${added.length}/${dim.values.length} 个值`);
      }
    }
    await settle(page, 1500);
    if (specOk) skuRows = buildSkuRows(product, plan, rules);
  } else if (plan.reason) {
    pending.push(`未自动添加规格：${plan.reason}`);
  }
  if (plan.skipped?.length) {
    pending.push(`未使用的 1688 规格维度：${plan.skipped.join('、')}`);
  }
  if (plan.truncated?.length) {
    plan.truncated.forEach((t) => {
      const sample = (t.droppedSample ?? []).join('、');
      pending.push(
        `规格「${t.pddType}」只写入前 ${t.kept} 个值（SKU 上限 ${rules.maxSkus ?? 100}），丢弃 ${t.dropped} 个${
          sample ? `，如：${sample}` : ''
        }`
      );
    });
  }

  if (skuRows.length) {
    const skuImages = skuImageMap(assets);
    const missingPreview = [];

    // 1688 有图就用对应的图；1688 没图就留空，不拿主图充数
    const previewPath = (row) => {
      for (const [pddType, value] of Object.entries(row.specs)) {
        const dim = plan.dims.find((d) => d.pddType === pddType);
        const exact = skuImages.byProp[`${dim?.sourceKey ?? ''}|${value}`];
        if (exact) return exact;
        if (skuImages.byName[value]) return skuImages.byName[value];
      }
      missingPreview.push(Object.values(row.specs).join(' / '));
      return rules.previewFallbackMain === true ? picked[0] : null;
    };

    const table = await fillSkuRows(page, skuRows, { previewPath });
    filled.push({
      field: '商品规格',
      value: `${plan.dims.map((d) => `${d.pddType}(${d.values.length})`).join(' × ')} = ${skuRows.length} 个 SKU`
    });
    filled.push({ field: '价格与库存', value: `${table.filled}/${table.total} 行` });
    table.results.filter((r) => !r.ok).forEach((r) => pending.push(r.reason));
    if (rules.useSkuPrice) pending.push('SKU 价格按各自 1688 价换算，请抽查');
    if (missingPreview.length) {
      const sample = missingPreview.slice(0, 5).join('、');
      const more = missingPreview.length > 5 ? ` 等 ${missingPreview.length} 个` : '';
      pending.push(
        rules.previewFallbackMain === true
          ? `${missingPreview.length} 个 SKU 1688 没有规格图，已用主图 01 兜底：${sample}${more}`
          : `${missingPreview.length} 个 SKU 1688 没有规格图，预览图留空（必填项，需手动补）：${sample}${more}`
      );
    }
  } else if (prices) {
    const results = await fillSkuRows(page, [
      {
        stock: Number(rules.stock ?? 999),
        group: prices.group,
        single: prices.single,
        specCode: rules.specCodePrefix ? `${rules.specCodePrefix}${product.offerId ?? ''}` : '',
        goodsCode: rules.codePrefix ? `${rules.codePrefix}${product.offerId ?? ''}` : ''
      }
    ]);
    if (results.filled) {
      filled.push({ field: '库存', value: rules.stock ?? 999 });
      filled.push({ field: '拼单价', value: prices.group });
      filled.push({ field: '单买价', value: prices.single });
      if (results.cols.some((c) => c.includes('商品编码')) && rules.codePrefix) {
        filled.push({ field: '商品编码', value: `${rules.codePrefix}${product.offerId ?? ''}` });
      }
    } else {
      pending.push('价格表格未识别，价格与库存需手动填写');
    }
  } else {
    pending.push('成本价缺失，价格与库存需手动填写');
  }

  if (prices) {
    const singles = skuRows.map((r) => Number(r.single) || 0);
    const maxSingle = singles.length ? Math.max(...singles) : Number(prices.single) || 0;
    const bump = fitEnding(Math.max(maxSingle + 2, maxSingle * Number(rules.refRatio ?? 1.6)), rules.priceEnding);
    const reference = Math.max(Number(prices.reference) || 0, Number(bump) || 0);

    const refInput = page.locator('input[placeholder*="应大于商品最大单买价"]').first();
    if (reference && (await refInput.count())) {
      await refInput.click().catch(() => {});
      await refInput.fill(String(reference));
      await refInput.evaluate((el) => el.blur());
      filled.push({ field: '商品参考价', value: reference });
    }
  }
  if (rules.multiSpec === false && (product?.skus ?? []).some((s) => Object.keys(s?.specs ?? {}).length)) {
    pending.push('多规格填写已在配置里关闭（multiSpec: false），规格需手动');
  }

  // 商品详情长图（快捷编辑区）
  const detailMax = Number(rules.detailImageMax ?? 20);
  const detailMaxBytes = Number(rules.detailImageMaxBytes ?? 3 * 1024 * 1024);
  const detailSkipped = [];
  const detailPaths = [];
  for (const filePath of (detailImages ?? []).slice(0, detailMax)) {
    const info = readImageInfo(filePath);
    if (info && info.bytes > detailMaxBytes) {
      detailSkipped.push(path.basename(filePath));
      continue;
    }
    detailPaths.push(filePath);
  }
  if (detailSkipped.length) {
    pending.push(`跳过 ${detailSkipped.length} 张超大详情图（>3MB）：${detailSkipped.slice(0, 3).join('、')}`);
  }
  let detailUploaded = 0;
  if (detailPaths.length && rules.uploadDetail !== false) {
    const result = await fillDetailImages(page, detailPaths);
    if (result.ok) {
      detailUploaded = result.count;
      filled.push({ field: '商品详情', value: `${result.count} 张长图` });
    } else {
      pending.push(`商品详情未上传：${result.reason}`);
    }
  } else {
    pending.push('商品详情未上传（没有采集到详情长图），需手动或用「装修商详」');
  }

  pending.push('品牌、商品资质、包装标签图需手动');
  pending.push('运费模板/发货时效请核对后再提交');
  pending.push('提交动作未自动化，请检查后自己点「提交并上架」');

  return {
    url: page.url(),
    title,
    prices,
    category,
    filled,
    pending,
    skuCount: skuRows.length,
    detailCount: detailUploaded
  };
}
