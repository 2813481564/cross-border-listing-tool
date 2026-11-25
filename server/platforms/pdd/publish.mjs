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
import { isHintSpecValue } from '../../collector/normalize.mjs';

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

/** 两位小数，不做尾数包装 */
function round2(num) {
  return Number(Number(num).toFixed(2));
}

/**
 * 拼多多价格方案。
 *
 * 两种加价方式：
 *  - markup：拼单价 = 成本 × markup（倍数），按 priceEnding 凑尾
 *  - add：   拼单价 = 成本 + groupAdd、单买价 = 成本 + singleAdd（元）。
 *            「加多少钱」要的是准数，所以这一档不凑尾数。
 *
 * 拼单价 ≤ 单买价 < 参考价，参考价需大于最大单买价。
 */
export function planPrices(costCny, rules) {
  const mode = rules.priceMode === 'add' ? 'add' : 'markup';
  const markup = Number(rules.markup ?? 1.35);
  const groupAdd = Number(rules.groupAdd ?? rules.addAmount ?? 0);
  const singleAdd = Number(rules.singleAdd ?? 0);
  const singleRatio = Number(rules.singleRatio ?? 1.2);
  const refRatio = Number(rules.refRatio ?? 1.6);
  const ending = rules.priceEnding ?? '.9';

  const cost = Number(costCny) > 0 ? Number(costCny) : null;
  if (!cost) return null;

  if (mode === 'add') {
    const group = round2(cost + groupAdd);
    // 单买价各自加在成本上，但至少比拼单价高 1 元，否则平台校验不过
    const single = round2(Math.max(group + 1, cost + singleAdd));
    const reference = round2(Math.max(single + 2, single * refRatio));
    return {
      cost,
      group,
      single,
      reference,
      mode,
      groupAdd,
      singleAdd,
      addAmount: groupAdd,
      markup,
      ending: null
    };
  }

  const groupRaw = cost * markup;
  const group = fitEnding(groupRaw, ending);
  if (!group) return null;

  const singleRaw = Math.max(group + 1, groupRaw * singleRatio);
  const single = fitEnding(singleRaw, ending);
  const reference = fitEnding(Math.max(single + 2, single * refRatio), ending);
  return { cost, group, single, reference, mode, groupAdd: 0, singleAdd: 0, addAmount: 0, markup, ending };
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
 * 拼多多规格值的非法字符。
 *
 * 实测（在真实发布页逐个试）：
 *   `&` 被拒、`,` 被拒、全角 `，` 被拒（提示「请避免输入特殊字符」，值被清空）；
 *   `*` `+` `-` `/` `(` `)` `.` `#`、`【】` 和空格都能通过。
 * 统一换成空格，既能过校验，又不会让两个不同值清洗后撞成一个。
 */
const PDD_BAD_SPEC_CHARS = /[&,，、；;：:]/g;

/** 把 1688 的规格值转成拼多多能接受的文本（不含长度截断） */
export function toPddSpecValue(raw) {
  return String(raw ?? '')
    .replace(/&amp;/gi, '&')
    .replace(PDD_BAD_SPEC_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 规格值清洗：转换非法字符 + 压平空白 + 截断到 40 字。
 *
 * 注意：图片 label 存的是 1688 原始值（`属性=值`），所以比对规格图时
 * 必须用同一个函数处理两侧（见 specKey），否则对不上。
 */
function cleanSpecValue(raw) {
  const text = toPddSpecValue(raw);
  return text.length > SPEC_VALUE_MAX ? text.slice(0, SPEC_VALUE_MAX) : text;
}

/**
 * 兜底清洗：只用于「写入后被页面清空」的值，再激进一点，
 * 去掉所有非中英文/数字/安全符号的字符。正常路径由 toPddSpecValue 处理。
 */
export function sanitizeSpecFallback(raw) {
  return String(raw ?? '')
    .replace(PDD_BAD_SPEC_CHARS, ' ')
    .replace(/[^\w\u4e00-\u9fa5\s\-./(#)*+【】]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SPEC_VALUE_MAX);
}

/** 从 SKU 里收集规格维度（保持出现顺序）。 */
function collectSpecDims(product) {
  const dims = [];
  const index = new Map();
  for (const sku of product?.skus ?? []) {
    for (const [key, rawValue] of Object.entries(sku?.specs ?? {})) {
      const val = cleanSpecValue(rawValue);
      if (!key || !val) continue;
      // 老数据（库里已采集的）没有经过上游过滤，这里再挡一道
      if (isHintSpecValue(val)) continue;
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
export function countLowMarginRows(rows, minRatio = 1.1) {
  let low = 0;
  for (const row of rows ?? []) {
    const cost = Number(row?.sku?.price ?? 0);
    if (cost > 0 && Number(row.group) < cost * minRatio) low += 1;
  }
  return low;
}

/**
 * 规格值比对键。
 *
 * 1688 的原始值里带连续空格（`棕色耐磨款  93厘米一根`，两个空格），
 * 而规格维度里存的是压平空白后的值（一个空格）。两边不统一就永远匹配不上，
 * 表现为「规格图明明下载好了，填表时却一张都没上传」。
 */
function specKey(value) {
  // 必须和「能写进页面的规格值」用同一套清洗，否则规格图索引对不上
  return cleanSpecValue(value);
}

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
      const prop = specKey(entry.slice(0, idx));
      const name = specKey(entry.slice(idx + 1));
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

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 在指定属性项的下拉里选中一个值。
 *
 * 属性项是 beast-core-form-item：label 是属性名（「重要材质」这种带前缀的也算命中），
 * 控件是带搜索框的 select，head input 可以边输入边过滤选项。
 *
 * 只在控件为空时写，已有值就原样保留并说明差异 —— 自动填不覆盖人工改过的值。
 */
export async function fillPropertySelect(page, labelKeywords, value) {
  const keywords = (Array.isArray(labelKeywords) ? labelKeywords : [labelKeywords]).filter(Boolean);
  if (!keywords.length) return { ok: false, reason: '没有配置属性名关键词' };

  // 直接按 label 文本定位所属表单项，不用「先取数组下标、再 nth」——
  // 属性区是异步渲染的，两次调用之间节点会插进来，下标会漂到别的项上。
  const labelPattern = new RegExp(keywords.map(escapeRegExp).join('|'));
  const labelLocator = page.locator('label').filter({ hasText: labelPattern }).first();
  if (!(await labelLocator.count().catch(() => 0))) {
    return { ok: false, reason: `页面上没有「${keywords[0]}」这一项` };
  }

  const fieldLabel =
    (await labelLocator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() || keywords[0];
  const item = labelLocator.locator('xpath=ancestor::*[@data-testid="beast-core-form-item"][1]');
  const header = item.locator('[data-testid="beast-core-select-header"]').first();
  // 属性控件是异步渲染的：刚进第二步时 label 已经在了、下拉还没挂上，等一下再判定
  const headerReady = await header
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!headerReady) return { ok: false, reason: `「${fieldLabel}」不是下拉选项` };

  const headInput = item.locator('input[data-testid="beast-core-select-htmlInput"]').first();
  const current = await headInput.inputValue().catch(() => '');
  if (current) {
    if (current === value || current.includes(String(value))) {
      return { ok: true, skipped: true, field: fieldLabel, current };
    }
    return {
      ok: false,
      kept: true,
      field: fieldLabel,
      reason: `「${fieldLabel}」已填「${current}」，与 1688 的「${value}」不同，保留原值`
    };
  }

  await header.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  await headInput.fill(String(value)).catch(() => {});

  // 品牌这类下拉的选项是远程拉取的，输入后要等接口回来；固定等死容易扑空
  const options = page.locator('[class*="cIL_item"]');
  const exactPattern = new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`);
  let option = null;
  for (let wait = 0; wait < 12 && !option; wait += 1) {
    const exact = options.filter({ hasText: exactPattern }).first();
    if (await exact.count().catch(() => 0)) {
      option = exact;
      break;
    }
    const loose = options.filter({ hasText: String(value) }).first();
    if (await loose.count().catch(() => 0)) {
      option = loose;
      break;
    }
    await page.waitForTimeout(400);
  }

  if (!option || !(await option.count().catch(() => 0))) {
    // 先读可选值再收起下拉，否则面板已经消失，报错里就看不到能选什么
    const shown = await options
      .evaluateAll((els) => els.map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()))
      .catch(() => []);
    await page.keyboard.press('Escape').catch(() => {});
    // 走到这里原本就是空值：把搜索词也清掉，别让它以「未选中」的样子留在框里
    await headInput.fill('').catch(() => {});
    return {
      ok: false,
      field: fieldLabel,
      reason: `「${fieldLabel}」下拉里没有「${value}」${
        shown.length ? `（可选：${shown.slice(0, 8).join('、')}）` : ''
      }`
    };
  }

  await option.click({ timeout: 5000 });
  await page.waitForTimeout(600);

  // 回读要按 label 重新定位：下拉收起时 DOM 会重排，缓存的 input 可能已经不是这一项了
  const after = await page
    .evaluate((name) => {
      const el = [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].find(
        (x) =>
          String(x.querySelector('label')?.innerText ?? '')
            .replace(/\s+/g, ' ')
            .trim() === name
      );
      const input = el?.querySelector('input[data-testid="beast-core-select-htmlInput"]');
      return input ? String(input.value ?? '') : '';
    }, fieldLabel)
    .catch(() => '');

  if (!after || !after.includes(String(value))) {
    return {
      ok: false,
      field: fieldLabel,
      reason: `「${fieldLabel}」点了「${value}」，回读却是「${after || '(空)'}」`
    };
  }
  return { ok: true, field: fieldLabel, current: after };
}

/** 这些属性项不是类目属性（系统项，或已由别的逻辑处理），自动匹配要跳过 */
const SYSTEM_ATTR_LABEL =
  /轮播图|标题|品牌|商品资质|包装标签图|讲解视频|卡密|商品规格|价格|库存|参考价|满件折扣|发货时间|运费模板|规格类型/;

/** 属性名归一化：去掉必填星号、「重要」前缀、空白和冒号 */
const normalizeAttrName = (text) =>
  String(text ?? '')
    .replace(/^\*+/, '')
    .replace(/^重要/, '')
    .replace(/[\s:：]/g, '')
    .trim();

/**
 * 把 1688 采集到的属性按名字填到页面的类目属性上。
 *
 * 平台属性项里「重要材质」「重要单层厚度」这类带前缀的，去掉前缀后与 1688 属性名比对。
 * 只处理下拉类属性：页面上已有的值一律不动，匹配不到就写进「待人工」，不猜。
 */
export async function fillCategoryAttributes(page, product, rules, report) {
  const items = await page
    .evaluate(() => {
      const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('[data-testid="beast-core-form-item"]')]
        .map((el) => {
          const label = clean(el.querySelector('label')?.innerText);
          const isSelect = Boolean(el.querySelector('[data-testid="beast-core-select-header"]'));
          const input = el.querySelector('input[data-testid="beast-core-select-htmlInput"]');
          return { label, isSelect, value: input ? String(input.value ?? '') : '' };
        })
        .filter((x) => x.label && x.isSelect);
    })
    .catch(() => []);

  const attrs = product?.attributes ?? [];
  const explicit = rules.fillAttributes && rules.fillAttributes !== false ? rules.fillAttributes : {};
  const done = new Set();

  // 1) 配置里显式写的映射优先（1688 叫法和平台不一样时用）
  for (const [sourceName, keywords] of Object.entries(explicit)) {
    const hit =
      attrs.find((a) => String(a.name ?? '').trim() === sourceName) ??
      attrs.find((a) => String(a.name ?? '').includes(sourceName));
    if (!hit?.value) {
      report.pending.push(`1688 没有「${sourceName}」属性，需手动选`);
      continue;
    }
    const result = await fillPropertySelect(page, keywords, hit.value);
    if (result.ok) {
      report.filled.push({
        field: result.field ?? sourceName,
        value: result.skipped ? `${result.current}（原已填）` : result.current
      });
      done.add(result.field ?? '');
    } else {
      report.pending.push(`属性「${sourceName}」未自动选：${result.reason}`);
    }
  }

  if (rules.autoCategoryAttributes === false) return;

  // 2) 其余属性项按名字自动对
  for (const item of items) {
    if (SYSTEM_ATTR_LABEL.test(item.label)) continue;
    const key = normalizeAttrName(item.label);
    if (!key || done.has(item.label)) continue;
    if (item.value) continue; // 已有值（一键复用/人工）不动

    const hit =
      attrs.find((a) => normalizeAttrName(a.name) === key) ??
      attrs.find((a) => {
        const name = normalizeAttrName(a.name);
        return name && (key.includes(name) || name.includes(key));
      });
    if (!hit?.value) {
      report.pending.push(`属性「${key}」1688 没采到对应值，需手动选`);
      continue;
    }

    // 1688 多值（「抽气泵,衣挂抽气式,…」）逐个试，命中哪个算哪个
    const candidates = String(hit.value)
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    let result = null;
    let lastReason = '';
    for (const candidate of candidates) {
      const r = await fillPropertySelect(page, [item.label], candidate);
      if (r.ok) {
        result = r;
        break;
      }
      lastReason = r.reason ?? '';
    }
    if (result) {
      report.filled.push({ field: item.label, value: result.current });
      done.add(item.label);
    } else {
      report.pending.push(
        `属性「${key}」没自动选：${lastReason || `1688 值为「${hit.value}」，页面无可选值`}`
      );
    }
  }
}

async function addSpecValues(page, values) {
  const scope = await specScope(page);
  if (!scope) return { added: [], rejected: [], sanitized: [] };

  // 规格值的输入框 placeholder 随类型变化（颜色=请输入规格名称、尺寸=自定义尺寸…），
  // 所以统一取「区域内可编辑的文本框」的最后一个
  const editable = scope.locator('input[type="text"]:not([readonly])');
  const added = [];
  const rejected = [];
  const sanitized = [];

  /** 往当前窗口的空输入框里写一个值，返回是否真的成了规格值 */
  const attempt = async (text) => {
    const before = await editable.count();

    // 加进去之后页面会追加一个新的空输入框；这里等到它出现再写下一个值。
    // 原来固定等 600ms，页面慢的时候拿到的还是「上一个值」那个框，
    // 于是被误判成「加不进去了」直接 break，后面所有值都不会再尝试。
    let last = editable.last();
    for (let attemptWait = 0; attemptWait < 12; attemptWait += 1) {
      if (!(await last.count())) break;
      if ((await last.inputValue().catch(() => 'x')) === '') break;
      await page.waitForTimeout(250);
      last = editable.last();
    }
    if (!(await last.count())) return false;

    const pending = await last.inputValue().catch(() => '');
    if (pending !== '') {
      // 页面没追加新框：清掉残留文本继续下一个值，绝不整体放弃
      await last.fill('').catch(() => {});
    }

    await last.click({ timeout: 5000 }).catch(() => {});
    await last.fill(String(text)).catch(() => {});
    await last.press('Enter').catch(() => {});
    await page.waitForTimeout(700);

    const grew = (await editable.count()) > before;
    const current = await editable.evaluateAll((els) => els.map((el) => el.value));
    const shown = await scope.evaluate((root, v) => root.innerText.includes(v), String(text)).catch(() => false);
    return grew || current.includes(String(text)) || shown;
  };

  for (const value of values) {
    const text = String(value);
    if (await attempt(text)) {
      added.push(text);
      continue;
    }

    // 页面把值清空 = 判定为特殊字符（提示「请避免输入特殊字符」）。
    // 清洗一版再试一次，避免一个标点就让整组规格、连带整张价格库存表都填不进去。
    const fallback = sanitizeSpecFallback(text);
    if (fallback && fallback !== text && (await attempt(fallback))) {
      added.push(fallback);
      sanitized.push({ from: text, to: fallback });
      continue;
    }
    rejected.push(text);
  }
  return { added, rejected, sanitized };
}

/**
 * 按「价格及库存」表头逐行填值。
 *
 * 三个坑：
 *  1. SKU 多时拼多多把「表头」和「数据行」拆成两个 table，表头那个 tbody 是空的，
 *     所以要挑「行数最多」的 table 当数据表。
 *  2. 数据表是**虚拟滚动**：DOM 里只保留十几行，滚动时才复用节点渲染新行。
 *     因此不能「一次取全部 tr 填完」——96 个 SKU 会只填到 18 个就收工，
 *     页面随即报「请输入第19行规格的库存」。必须边滚边填。
 *  3. 虚拟滚动会复用节点，行序号不再可靠，只能按「规格值文字」认行。
 *
 * 规格列数会因 rowspan 合并而不同，所以按「输入框顺序 = 数值列顺序」映射。
 */
export async function fillSkuRows(page, rows, { previewPath } = {}) {
  const headerTable = page.locator('table').filter({ hasText: '拼单价' }).first();
  await headerTable.waitFor({ state: 'visible', timeout: 20000 });

  const headers = (await headerTable.locator('thead th, thead td').allInnerTexts()).map((h) =>
    h.replace(/\s+/g, '')
  );
  const cols = headers.filter((h) => /库存|拼单价|单买价|规格编码|商品编码/.test(h));
  if (!cols.length) {
    return { cols, results: [{ ok: false, reason: '没识别到价格表头' }], total: 0, filled: 0, verified: 0 };
  }

  const pickedValue = (row, label) =>
    label.includes('库存')
      ? row.stock
      : label.includes('拼单价')
        ? row.group
        : label.includes('单买价')
          ? row.single
          : label.includes('规格编码')
            ? row.specCode
            : row.goodsCode;

  const scrollByStep = (toTop = false) =>
    page.evaluate((top) => {
      let best = null;
      let bestN = 0;
      Array.from(document.querySelectorAll('table')).forEach((t) => {
        const n = t.querySelectorAll('tbody tr').length;
        if (n > bestN) {
          bestN = n;
          best = t;
        }
      });
      if (!best) return { moved: 0, atEnd: true };
      let node = best.parentElement;
      while (node) {
        const s = getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(s.overflowY)) break;
        node = node.parentElement;
      }
      const scroller = node ?? document.scrollingElement;
      const before = scroller.scrollTop;
      const step = Math.round((scroller.clientHeight || 800) * 0.8);
      scroller.scrollTop = top ? 0 : before + step;
      return {
        moved: scroller.scrollTop - before,
        atEnd: scroller.scrollTop + (scroller.clientHeight || 0) >= scroller.scrollHeight - 4
      };
    }, toTop);

  const bodyIdx = await page.evaluate(() => {
    let best = -1;
    let bestN = 0;
    Array.from(document.querySelectorAll('table')).forEach((t, i) => {
      const n = t.querySelectorAll('tbody tr').length;
      if (n > bestN) {
        bestN = n;
        best = i;
      }
    });
    return best;
  });
  if (bodyIdx < 0) {
    return { cols, results: [{ ok: false, reason: '没找到 SKU 数据行' }], total: rows.length, filled: 0, verified: 0 };
  }

  const trs = page.locator('table').nth(bodyIdx).locator('tbody tr');

  const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

  // 规格列 = 表头里第一个数值列之前的所有列。行身份就按这些列的文字认。
  //
  // 规格列不能按 rowspan 猜：拼多多有两种表。
  //   有的商品颜色列 rowspan 合并（组首行有颜色、其余行只有尺寸）；
  //   有的商品每行都把颜色和尺码都写出来（实测 773341746067 就是这种，7 行 rowspan 全是 1）。
  // 只认 rowspan>1 会把「颜色」当成「尺寸」，key 全部错位，一行都写不进去。
  const firstValueCol = headers.findIndex((h) => /库存|拼单价|单买价|预览图|编码|状态/.test(h));
  const specNames = (firstValueCol > 0 ? headers.slice(0, firstValueCol) : []).map((h) =>
    h.replace(/^\*+/, '')
  );
  const dimNames = Object.keys(rows[0]?.specs ?? {});
  const byName =
    specNames.length === dimNames.length && dimNames.every((d) => specNames.includes(d));
  const SPEC_SEP = '\u0001';
  const specKeyOf = (specsObj) =>
    (byName
      ? specNames.map((n) => norm(specsObj?.[n]))
      : dimNames.map((d) => norm(specsObj?.[d]))
    ).join(SPEC_SEP);

  const planByKey = new Map();
  rows.forEach((row, i) => planByKey.set(specKeyOf(row.specs), i));

  /**
   * 页面内一次性写入当前窗口：同一帧里解析行身份 + 写值。
   *
   * 为什么不用 locator 逐行 fill：拼多多每写一个输入框都会触发重渲染，
   * tr 的序号随之变化，第二次 nth(i) 可能落到别的行甚至空行上
   * （实测 91 行里有 12 行报「输入框不足 0/4」、回读只剩 44 行）。
   * 在页面内做完整的一遍就绕开了这个竞态。
   */
  const specCount = specNames.length || dimNames.length;

  /**
   * 页面内还原当前窗口每一行的规格文字。
   *
   * 规格格 = 第一个数值输入框之前的所有格。合并单元格时这一行可能只有后半截的格，
   * 前面的从前一行继承（颜色 rowspan=7 的表就是这样），所以按「末位对齐」补齐。
   */
  const writeWindow = () =>
    page.evaluate(
      ({ plan, fieldCount, count, sep }) => {
        let best = null;
        let bestN = 0;
        Array.from(document.querySelectorAll('table')).forEach((t) => {
          const n = t.querySelectorAll('tbody tr').length;
          if (n > bestN) {
            bestN = n;
            best = t;
          }
        });
        if (!best) return [];
        const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const last = new Array(count).fill('');
        const written = [];

        Array.from(best.querySelectorAll('tbody tr')).forEach((tr, index) => {
          const cells = Array.from(tr.children);
          if (!cells.length) return;
          const valueStart = cells.findIndex((c) => c.querySelector('input:not([type="file"])'));
          const end = valueStart < 0 ? cells.length : valueStart;
          const specCells = cells.slice(0, end).map((c) => clean(c.innerText));
          if (count > 0) {
            const offset = Math.max(0, count - specCells.length);
            specCells.slice(0, count).forEach((v, i) => {
              last[offset + i] = v;
            });
          }
          const key = last.join(sep);
          const values = plan[key];
          if (!values) return;

          const inputs = Array.from(tr.querySelectorAll('input')).filter((el) => el.type !== 'file');
          if (!inputs.length) return;

          for (let c = 0; c < fieldCount && c < inputs.length; c += 1) {
            const v = values[c];
            if (v === undefined || v === null || v === '') continue;
            const el = inputs[c];
            if (String(el.value) === String(v)) continue;
            el.focus();
            setter.call(el, String(v));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.blur();
          }
          written.push({ index, key });
        });
        return written;
      },
      {
        plan: Object.fromEntries(
          rows.map((row) => [
            specKeyOf(row.specs),
            cols.map((label) => {
              const v = pickedValue(row, label);
              return v === undefined || v === null ? '' : String(v);
            })
          ])
        ),
        fieldCount: cols.length,
        count: specCount,
        sep: SPEC_SEP
      }
    );

  /** 读当前渲染窗口：还原每行规格文字，并回读输入框当前值 */
  const readWindow = () =>
    page.evaluate(
      ({ count, sep }) => {
        let best = null;
        let bestN = 0;
        Array.from(document.querySelectorAll('table')).forEach((t) => {
          const n = t.querySelectorAll('tbody tr').length;
          if (n > bestN) {
            bestN = n;
            best = t;
          }
        });
        if (!best) return [];
        const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
        const last = new Array(count).fill('');
        return Array.from(best.querySelectorAll('tbody tr')).map((tr, index) => {
          const cells = Array.from(tr.children);
          const inputs = Array.from(tr.querySelectorAll('input')).filter((el) => el.type !== 'file');
          if (!cells.length) return { index, key: last.join(sep), values: [] };
          const valueStart = cells.findIndex((c) => c.querySelector('input:not([type="file"])'));
          const end = valueStart < 0 ? cells.length : valueStart;
          const specCells = cells.slice(0, end).map((c) => clean(c.innerText));
          if (count > 0) {
            const offset = Math.max(0, count - specCells.length);
            specCells.slice(0, count).forEach((v, i) => {
              last[offset + i] = v;
            });
          }
          return { index, key: last.join(sep), values: inputs.map((el) => String(el.value ?? '')) };
        });
      },
      { count: specCount, sep: SPEC_SEP }
    );



  const results = [];
  const done = new Set();
  // 预览图上传是 Playwright 单独做的，用独立集合记账，避免多轮清扫重复上传/重复报缺图
  const previewDone = new Set();
  const previewSkipped = new Set();

  // 规格列数量对不上时行 key 永远匹配不到，提前说清楚，别让调用方只看到「填了 0 行」
  if (specNames.length && specNames.length !== dimNames.length) {
    return {
      cols,
      results: [
        {
          ok: false,
          index: -1,
          reason: `页面规格列（${specNames.join('/')}）与计划规格（${dimNames.join('/')}）数量不一致，无法逐行对应`
        }
      ],
      total: rows.length,
      filled: 0,
      verified: 0,
      failed: 1,
      previewSkipped: 0
    };
  }

  // 先滚回顶部：上一次操作可能把表格停在底部，从底部开始就永远填不到上半部分
  await scrollByStep(true);
  await page.waitForTimeout(400);



  const deadline = Date.now() + 6 * 60 * 1000;

  for (let sweep = 0; sweep < 3 && done.size < rows.length; sweep += 1) {
    let guard = 0;
    while (guard < 60 && Date.now() < deadline) {
      guard += 1;
      const win = await readWindow();
      if (!win.length) break;

      const written = await writeWindow();
      for (const w of written) {
        const idx = planByKey.get(w.key);
        if (idx === undefined || done.has(idx)) continue;
        results.push({ ok: true, index: idx, row: rows[idx] });
        done.add(idx);
      }

      // 预览图只能靠 Playwright 塞本地文件（页面内写不了），失败不影响价格库存
      if (previewPath) {
        for (const w of written) {
          const idx = planByKey.get(w.key);
          if (idx === undefined || previewDone.has(idx)) continue;
          previewDone.add(idx);

          const filePath = previewPath(rows[idx]);
          if (!filePath) continue;

          const file = trs.nth(w.index).locator('input[type="file"]').first();
          if (await file.count().catch(() => 0)) {
            await file.setInputFiles(filePath).catch(() => {});
            await page.waitForTimeout(250);
          } else {
            // 行里没有上传入口：不能静默，否则「图没上去」完全看不出来
            previewSkipped.add(idx);
          }
        }
      }

      const moved = await scrollByStep();
      // 注意：滚到底不能立刻 break——最后那一屏是新渲染出来的，还没处理。
      // 用「这一滚没动了」作终止条件，保证底部窗口会被读一次。
      if (!moved.moved) break;
      await page.waitForTimeout(250);
    }

    if (done.size >= rows.length) break;
    // 还有漏的：从顶部再扫一遍，虚拟滚动在窗口边界偶尔会跳过几行
    await scrollByStep(true);
    await page.waitForTimeout(400);
  }

  // 回读校验：虚拟滚动下「填了但没落进表单」是真实风险，必须数一遍
  let verified = 0;
  try {
    const seen = new Set();
    for (let sweep = 0; sweep < 3 && seen.size < rows.length; sweep += 1) {
      await scrollByStep(true);
      await page.waitForTimeout(300);
      for (let pass = 0; pass < 60; pass += 1) {
        const win = await readWindow();
        if (!win.length) break;
        for (const r of win) {
          const idx = planByKey.get(r.key);
          if (idx === undefined || seen.has(idx)) continue;
          seen.add(idx);
          const vals = r.values;
          const complete = cols.every((label, c) => {
            const need = pickedValue(rows[idx], label);
            if (need === undefined || need === null || need === '') return true;
            return String(vals[c] ?? '') !== '';
          });
          if (complete) verified += 1;
        }
        const moved = await scrollByStep();
        if (!moved.moved) break;
        await page.waitForTimeout(200);
      }
    }
  } catch {
    /* 校验失败不影响已填内容，只在报告里体现 */
  }

  if (!done.size) {
    results.push({
      ok: false,
      index: -1,
      reason: `「价格及库存」一行都没对上：页面规格列（${specNames.join('/') || '未识别'}）、计划规格（${dimNames.join('/')}）、表头（${cols.join('/')}）`
    });
  }

  const failed = results.filter((r) => !r.ok);
  return {
    cols,
    results,
    total: rows.length,
    filled: done.size,
    verified,
    failed: failed.length,
    previewSkipped: previewSkipped.size
  };
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
      pending.push('未找到「一键复用」，属性改为按名称自动填（对不上的需手动）');
    }
  } else {
    pending.push('商品属性未自动填（按配置跳过）');
  }

  // 品牌：1688 的品牌不在平台品牌库里，而「品牌」是必选项，统一选「无品牌/无注册商标」
  const brandValue = rules.brand === false ? '' : String(rules.brand ?? '无品牌');
  if (brandValue) {
    const brandResult = await fillPropertySelect(page, ['品牌'], brandValue);
    if (brandResult.ok) {
      filled.push({ field: '品牌', value: brandResult.skipped ? `${brandResult.current}（原已填）` : brandResult.current || brandValue });
    } else {
      pending.push(`品牌未自动选：${brandResult.reason}`);
    }
  } else {
    pending.push('品牌未自动填（配置关闭）');
  }

  // 类目属性：平台没给「一键复用」按钮，就按属性名把 1688 采到的值逐项选上
  await fillCategoryAttributes(page, product, rules, { filled, pending });

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
      const { added, rejected, sanitized } = await addSpecValues(page, dim.values);
      if (sanitized.length) {
        pending.push(
          `规格「${dim.pddType}」有 ${sanitized.length} 个值含平台不接受的字符，已清洗后写入：` +
            sanitized
              .slice(0, 3)
              .map((s) => `${s.from} → ${s.to}`)
              .join('、')
        );
      }
      // 页面上的规格值才是真相：按实际写入的值重建计划，否则「价格及库存」永远对不上行
      const expected = dim.values.length;
      if (added.length === expected) dim.values = added.slice();
      if (added.length !== expected) {
        const bad = rejected.length ? `，被页面拒绝：${rejected.slice(0, 5).join('、')}` : '';
        pending.push(`规格「${dim.pddType}」只写入 ${added.length}/${expected} 个值${bad}`);
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
        const key = specKey(value);
        const exact = skuImages.byProp[`${specKey(dim?.sourceKey ?? '')}|${key}`];
        if (exact) return exact;
        if (skuImages.byName[key]) return skuImages.byName[key];
      }
      missingPreview.push(Object.values(row.specs).join(' / '));
      return rules.previewFallbackMain === true ? picked[0] : null;
    };

    const table = await fillSkuRows(page, skuRows, { previewPath });
    filled.push({
      field: '商品规格',
      value: `${plan.dims.map((d) => `${d.pddType}(${d.values.length})`).join(' × ')} = ${skuRows.length} 个 SKU`
    });
    filled.push({ field: '价格与库存', value: `${table.filled}/${table.total} 行（回读确认 ${table.verified} 行）` });
    if (table.verified < table.filled) {
      pending.push(`有 ${table.filled - table.verified} 行写入后回读为空，请在「价格及库存」里抽查`);
    }
    if (table.previewSkipped) {
      pending.push(`有 ${table.previewSkipped} 行没找到「预览图」上传入口（页面结构可能变了），需手动补图`);
    }
    table.results.filter((r) => !r.ok).forEach((r) => pending.push(r.reason));
    if (rules.useSkuPrice) pending.push('SKU 价格按各自 1688 价换算，请抽查');
    const lowRows = countLowMarginRows(skuRows);
    if (lowRows > 0) {
      pending.push(`有 ${lowRows} 行售价低于该规格成本的 1.1 倍，可能是加价倍数偏小，提交前务必核对`);
    }
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
    const refBase = Math.max(maxSingle + 2, maxSingle * Number(rules.refRatio ?? 1.6));
    // 按金额加价时不凑尾数，跟 SKU 行保持同一套口径
    const bump = (rules.priceMode ?? 'markup') === 'add' ? round2(refBase) : fitEnding(refBase, rules.priceEnding);
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

  pending.push('商品资质、包装标签图需手动');
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
