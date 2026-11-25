/**
 * 抖店（fxg.jinritemai.com）半自动填表。
 *
 * 页面结构特点：
 *  - 新建页默认是「AI 发品」（上传图片/Excel 让平台生成），需要点「返回旧版」进结构化表单
 *  - 旧版第一步：商品正面图 + 4 张辅助图 + 商品标题，点「下一步」
 *  - 之后是长单页表单，平台会按图片/标题自动识别类目
 *  - 规格区默认是「智能填写助手」（上传 Excel 自动填），可「切换手动填写」
 *  - 底部按钮：保存草稿 / 预览 / 发布商品 / 填写检查
 *
 * 原则：只填不发布，停在页面交给人工核对。
 */

import path from 'node:path';
import { openWorkPage } from '../../chrome.mjs';
import { ROOT } from '../../config.mjs';
import { readImageInfo } from '../../image-info.mjs';
import { buildSkuExcel } from './excel.mjs';
import { planSpecs, buildSkuRows, countLowMarginRows } from '../pdd/publish.mjs';

export const DOUYIN_CREATE_URL = 'https://fxg.jinritemai.com/ffa/g/create?entrance=create';

const settle = (page, ms = 1200) => page.waitForTimeout(ms);

/** 打开新建商品页（新标签） */
export async function openDouyinCreatePage() {
  const { page } = await openWorkPage();
  await page.goto(DOUYIN_CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle(page, 4000);
  return page;
}

/** 主图/详情图路径（复用现有 assets 结构） */
export function localImagePaths(assets, kind) {
  return (assets ?? [])
    .filter((a) => a.kind === kind && a.status === 'ok' && a.localPath)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((a) => path.join(ROOT, 'data', a.localPath));
}

/** 标题：抖店上限 60 字符 = 30 个汉字，超长截断 */
export function buildTitle(product, rules = {}) {
  const max = Number(rules.titleMaxLength ?? 30);
  const raw = String(product?.title ?? '').replace(/\s+/g, ' ').trim();
  const first = raw.split(/[，,。;；|/\\]+/).map((s) => s.trim()).filter(Boolean)[0] ?? raw;
  const title = first.length > max ? first.slice(0, max) : first;
  return { title, original: raw, truncated: title.length !== raw.length };
}

/**
 * 价格方案：抖店只有「售卖价」和「参考价」。
 *
 * 两种加价方式：
 *  - markup：售卖价 = 成本 × markup，按 priceEnding 凑尾
 *  - add：   售卖价 = 成本 + singleAdd（元），「加多少钱」要准数，不凑尾数
 */
export function planPrices(costCny, rules = {}) {
  const mode = rules.priceMode === 'add' ? 'add' : 'markup';
  const ending = rules.priceEnding ?? '.9';
  const markup = Number(rules.markup ?? 1.5);
  const singleAdd = Number(rules.singleAdd ?? 0);
  const cost = Number(costCny) > 0 ? Number(costCny) : null;
  if (!cost) return null;
  const e = Number.parseFloat(ending);
  const fix = (v) => Number((Math.max(1, Math.floor(Number(v))) + (Number.isFinite(e) ? e : 0.9)).toFixed(2));
  const sale = mode === 'add' ? Number((cost + singleAdd).toFixed(2)) : fix(cost * markup);
  const ref = fix(Math.max(sale * Number(rules.refRatio ?? 1.4), sale + 5));
  return {
    cost,
    sale,
    ref,
    markup,
    mode,
    singleAdd: mode === 'add' ? singleAdd : 0,
    ending: mode === 'add' ? null : ending
  };
}

/**
 * 按图片最小边长/比例过滤（抖店主图要求 ≥600×600）
 */
export function selectMainImages(paths, rules = {}) {
  const minSide = Number(rules.imageMinSide ?? 600);
  const maxBytes = Number(rules.imageMaxBytes ?? 5 * 1024 * 1024);
  const max = Number(rules.imageMax ?? 5);
  const ok = [];
  const skipped = [];
  for (const filePath of paths ?? []) {
    if (ok.length >= max) break;
    const info = readImageInfo(filePath);
    if (!info) {
      skipped.push({ file: path.basename(filePath), reason: '读不出尺寸' });
      continue;
    }
    if (info.width < minSide || info.height < minSide) {
      skipped.push({ file: path.basename(filePath), reason: `${info.width}x${info.height} 小于 ${minSide}px` });
      continue;
    }
    if (info.bytes > maxBytes) {
      skipped.push({ file: path.basename(filePath), reason: `${(info.bytes / 1024 / 1024).toFixed(1)}MB 超过 5MB` });
      continue;
    }
    ok.push(filePath);
  }
  return { ok, skipped };
}

/** 若停在「AI 发品」页，切到旧版结构化表单 */
async function ensureLegacyForm(page) {
  const legacy = page.getByText('返回旧版', { exact: false }).first();
  if (await legacy.count()) {
    await legacy.click({ timeout: 8000 }).catch(() => {});
    await settle(page, 3000);
    return true;
  }
  return false;
}

/** 填标题（第一步的输入框 id 固定） */
async function fillTitle(page, title) {
  const input = page.locator('#pg-title-input').first();
  if (!(await input.count())) return false;
  await input.click().catch(() => {});
  await input.fill(title);
  await input.evaluate((el) => el.blur());
  return true;
}

/** 上传主图 + 辅助图（前 5 个图片输入框） */
async function uploadMainImages(page, files) {
  const inputs = page.locator('input[type="file"][accept*="image"]');
  const total = await inputs.count();
  let uploaded = 0;
  for (let i = 0; i < Math.min(total, files.length); i += 1) {
    try {
      await inputs.nth(i).setInputFiles(files[i]);
      uploaded += 1;
      await page.waitForTimeout(1200);
    } catch {
      /* 单个失败不阻断 */
    }
  }
  return { uploaded, total };
}

/** 点「下一步」进入完整表单 */
async function goNext(page) {
  const btn = page.locator('button').filter({ hasText: /下一步/ }).first();
  if (!(await btn.count())) return false;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(8000);
  return true;
}

/** 上传商品详情图：定位「商详图片」所在容器的文件输入 */
async function uploadDetailImages(page, files) {
  if (!files.length) return { uploaded: 0, reason: '没有详情图' };

  const handle = await page.evaluateHandle(() => {
    const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
    const labels = ['商详图片', '商品详情'];
    for (const label of labels) {
      const el = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length <= 3 && clean(e.innerText).includes(label)
      );
      if (!el) continue;
      let box = el;
      for (let i = 0; i < 6 && box; i += 1) {
        const input = box.querySelector?.('input[type="file"][accept*="image"]');
        if (input) return input;
        box = box.parentElement;
      }
    }
    return null;
  });

  const element = handle.asElement();
  if (!element) return { uploaded: 0, reason: '没找到详情图上传控件' };

  await element.setInputFiles(files).catch(() => {});
  await page.waitForTimeout(1500 * Math.min(files.length, 5));
  return { uploaded: files.length };
}

/**
 * 切到「手动填写」。
 * 默认是「智能填写助手」，此时售卖价/库存输入框是 disabled 的，必须先切换。
 */
export async function switchToManualSpec(page) {
  // 不同版本文案不一样，挨个试
  const texts = ['切换手动填写', '手动填写', '使用手动填写', '切换为手动'];
  for (const text of texts) {
    const btn = page.getByText(text, { exact: false }).first();
    if (!(await btn.count())) continue;
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return true;
  }
  return false;
}

/**
 * 取「标签旁边的可编辑输入框」。
 *
 * 抖店的价格行里通常有两个 input：一个是 `.ecom-g-input-disabled` 的展示框，
 * 真正能填的是 `.ecom-g-input-number-input`，所以要优先挑后者且跳过 disabled。
 */
async function inputNearLabel(page, label, occurrence = 0) {
  const handle = await page.evaluateHandle(({ kw, nth }) => {
    const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length <= 1 && clean(e.innerText).includes(kw) && clean(e.innerText).length < 10
    );
    if (!el) return null;

    let box = el;
    for (let i = 0; i < 7 && box; i += 1) {
      const rowText = clean(box.innerText);
      // 只在「窄」的行容器里找，避免向上跨到别的字段把售卖价/参考价认成同一个输入框
      if (rowText.length <= 40) {
        const editable = Array.from(box.querySelectorAll?.('input') ?? []).filter(
          (input) => !input.disabled && !input.readOnly && input.type !== 'radio'
        );
        const numbers = editable.filter((input) => /number/i.test(input.className));
        const pool = numbers.length ? numbers : editable;
        if (pool.length) return pool[Math.min(nth, pool.length - 1)];
      }
      box = box.parentElement;
    }
    return null;
  }, { kw: label, nth: occurrence });

  return handle.asElement() ?? null;
}

/**
 * 填价格与库存（无规格或单规格）。
 * 会先切到手动填写，否则输入框是只读的。
 */
export async function fillPriceStock(page, prices, stock) {
  const result = { sale: false, ref: false, stock: false, manual: false };

  result.manual = await switchToManualSpec(page);

  // 抖店的数值框：placeholder 为「请输入」的是售卖价/参考价，「请输入库存」的是库存
  const numberInputs = page.locator('input.ecom-g-input-number-input:not([disabled])');
  const counts = await numberInputs.count();

  const fillAt = async (index, value) => {
    const input = numberInputs.nth(index);
    if (!(await input.count())) return false;
    await input.click().catch(() => {});
    await input.fill(String(value));
    await input.evaluate((el) => el.blur());
    return true;
  };

  result.sale = await fillAt(0, prices.sale);
  if (counts >= 3) result.ref = await fillAt(1, prices.ref); // 有参考价输入框时才填

  const stockInput = page.locator('input[placeholder="请输入库存"]').first();
  if (await stockInput.count()) {
    await stockInput.click().catch(() => {});
    await stockInput.fill(String(stock));
    await stockInput.evaluate((el) => el.blur());
    result.stock = true;
  }

  return result;
}

/** 点击某个标签所在行的下拉框，展开选项 */
async function openSelectNear(page, label) {
  const box = await page.evaluateHandle((kw) => {
    const c = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length <= 1 && c(e.innerText).includes(kw) && c(e.innerText).length < 12
    );
    if (!el) return null;
    let node = el;
    for (let i = 0; i < 6 && node; i += 1) {
      const sel = node.querySelector?.('[class*="select"]');
      if (sel) return sel;
      node = node.parentElement;
    }
    return null;
  }, label);

  const element = box.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return true;
}

/** 在下拉里点选文字完全一致的选项 */
async function pickOptionExact(page, text) {
  const option = page.locator('[class*="option"], [role="option"], li').filter({ hasText: new RegExp(`^${text}$`) }).first();
  if (!(await option.count())) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await option.click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(900);
  return true;
}

/**
 * 固定履约设置：发货时间 / 售后政策 / 运费模板。
 * 默认 48小时 + 7天无理由退货 + 包邮，可在配置里改。
 */
export async function applyFulfillment(page, rules = {}) {
  const delivery = rules.deliveryTime ?? '48小时';
  const afterSale = rules.afterSale ?? '7天无理由退货';
  const freight = rules.freightTemplate ?? '包邮';
  const result = { delivery: false, afterSale: false, freight: false };

  // 发货时间：单选按钮标签
  const deliveryLabel = page.getByText(delivery, { exact: true }).first();
  if (await deliveryLabel.count()) {
    await deliveryLabel.scrollIntoViewIfNeeded().catch(() => {});
    await deliveryLabel.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(600);
    result.delivery = true;
  }

  // 售后政策
  if (await openSelectNear(page, '售后服务')) {
    result.afterSale = await pickOptionExact(page, afterSale);
  }

  // 运费模板
  if (await openSelectNear(page, '运费模板')) {
    result.freight = await pickOptionExact(page, freight);
  }

  return result;
}

/**
 * 类目属性的必填项：货号（1688 货号或 offerId）。
 * 品牌、材质等由 fillCategoryAttributes 统一处理。
 */
export async function fillRequiredAttributes(page, product) {
  const result = { goodsNo: false, progress: null };

  const attrGoodsNo = (product?.attributes ?? []).find((a) => /货号|型号|商品编号/.test(a?.name ?? ''));
  const goodsNo = String(attrGoodsNo?.value ?? '').trim() || `1688-${product?.offerId ?? ''}`;

  const input = await inputNearLabel(page, '货号', 0);
  if (input) {
    await input.click().catch(() => {});
    await input.fill(goodsNo);
    await input.evaluate((el) => el.blur());
    result.goodsNo = goodsNo;
  }

  result.progress = await readRequiredProgress(page);
  return result;
}

async function readRequiredProgress(page) {
  return page
    .evaluate(() => {
      const text = String(document.body.innerText ?? '').replace(/\s+/g, ' ');
      const m = text.match(/必填项进度\s*(\d+)%/);
      return m ? Number(m[1]) : null;
    })
    .catch(() => null);
}

/* ---------------- 类目属性 ---------------- */

/** 这些不是类目属性（系统字段，或由别的逻辑处理），自动映射要跳过 */
const DY_ATTR_SKIP =
  /商品类目|商品标题|使用品牌名|导购短标题|类目属性|货号|产品名称|商品资质|主图|详情图|视频|价格|库存|规格/;

const normalizeAttrKey = (text) => String(text ?? '').replace(/[\s*＊:：]/g, '').trim();

/** 属性值 → 下拉搜索词序列：完整值 → 去掉「材质/类型」类后缀 → 按分隔符拆段 */
function attrSearchTerms(value) {
  const base = String(value ?? '').trim();
  if (!base) return [];
  const terms = [base];
  const stripped = base.replace(/(材质|面料|类型|类别|款)$/u, '').trim();
  if (stripped && stripped !== base) terms.push(stripped);
  for (const part of base.split(/[、,，/]/)) {
    const t = part.trim();
    if (t && !terms.includes(t)) terms.push(t);
  }
  return terms;
}

/** 按 attr-field-id 定位属性项（id 里可能带引号，先转义） */
const dyField = (page, id) =>
  page.locator(`[attr-field-id="${String(id).replace(/["\\]/g, '\\$&')}"]`).first();

/**
 * 打开属性项下拉，搜一个词并在可见弹层里点中匹配的选项。
 * 抖店的下拉弹层会 portal 到 body，页面上同时存在多个（其它字段的残留），
 * 所以只在「可见的」弹层里找，命中后打标记再点，避免点到隐藏节点。
 */
async function pickDyOption(page, field, term) {
  const selector = field.locator('.ecom-g-select-selector').first();
  await selector.scrollIntoViewIfNeeded().catch(() => {});
  await selector.click({ timeout: 6000 }).catch(() => {});
  await settle(page, 800);

  const search = field.locator('input[role="combobox"]').first();
  await search.fill(String(term)).catch(() => {});
  await settle(page, 1000);

  const hit = await page
    .evaluate((kw) => {
      const clean = (t) => String(t ?? '').replace(/\s+/g, '').trim();
      document.querySelectorAll('[data-cb-target]').forEach((el) => el.removeAttribute('data-cb-target'));
      const drops = [...document.querySelectorAll('.ecom-g-select-dropdown')].filter((el) => {
        const r = el.getBoundingClientRect();
        return el.offsetParent && r.height > 0;
      });
      for (const drop of drops) {
        const opts = [
          ...drop.querySelectorAll('[class*="tree-treenode"], [class*="item-option"], [role="option"]')
        ].filter((el) => String(el.innerText ?? '').trim());
        const exact = opts.find((o) => clean(o.innerText) === clean(kw));
        const loose = opts.find((o) => clean(o.innerText).includes(clean(kw)));
        const pick = exact || loose;
        if (pick) {
          pick.setAttribute('data-cb-target', '1');
          return String(pick.innerText ?? '').replace(/\s+/g, ' ').trim();
        }
      }
      return null;
    }, term)
    .catch(() => null);

  if (!hit) return null;
  await page.locator('[data-cb-target="1"]').first().click({ timeout: 5000 }).catch(() => {});
  await settle(page, 700);
  return hit;
}

/**
 * 抖店「类目属性」自动填写。
 *
 * 抖店每个属性项都带 attr-field-id（材质 / 件数 / 尺寸 / 容量 / 压缩形式 …），
 * 用它对 1688 采集到的属性名，命中就按控件类型填：文本直接写，下拉搜索后选。
 * 已有的值一律不动；选不中的写进待人工，不猜。
 */
export async function fillCategoryAttributes(page, product, rules = {}) {
  const filled = [];
  const pending = [];
  const attrs = product?.attributes ?? [];

  // 品牌：平台必选，而 1688 的品牌不在平台品牌库里，固定选「无品牌」
  const brandValue = rules.brand === false ? '' : String(rules.brand ?? '无品牌');
  if (brandValue) {
    const brandField = dyField(page, '品牌');
    if (await brandField.count().catch(() => 0)) {
      const current = String(
        await brandField.locator('.ecom-g-select-selection-item').first().innerText().catch(() => '')
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (current) {
        filled.push({ field: '品牌', value: `${current}（原已填）` });
      } else {
        const picked = await pickDyOption(page, brandField, brandValue);
        await page.keyboard.press('Escape').catch(() => {});
        if (picked) filled.push({ field: '品牌', value: picked });
        else pending.push(`品牌没能选中「${brandValue}」，需手动选`);
      }
    }
  }

  if (rules.autoCategoryAttributes === false) return { filled, pending };

  const fields = await page
    .evaluate(() => {
      const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('[attr-field-id]')].map((el) => {
        const single = Boolean(el.querySelector('.ecom-g-select-single'));
        const multi = Boolean(el.querySelector('.ecom-g-select-multiple'));
        const textInput = el.querySelector('input[type="text"]');
        const selected = [...el.querySelectorAll('.ecom-g-select-selection-item')]
          .map((x) => clean(x.innerText))
          .filter(Boolean);
        return {
          id: el.getAttribute('attr-field-id') ?? '',
          required: Boolean(el.querySelector('[class*="required"]')),
          ctrl: multi ? 'multi' : single ? 'single' : textInput ? 'text' : 'other',
          value: textInput ? String(textInput.value ?? '') : '',
          selected
        };
      });
    })
    .catch(() => []);

  // 规格里可能带尺寸（1688 的「尺寸」常常只以规格维度存在）
  const specSizeValues = [
    ...new Set(
      (product?.skus ?? [])
        .map((sku) => sku?.specs?.尺寸 ?? sku?.specs?.['尺寸规格'] ?? null)
        .filter(Boolean)
        .map((v) => String(v).trim())
    )
  ];
  // 只认长得像尺寸的值：带数字 + 长度单位/乘号
  const sizeLikeValues = specSizeValues.filter(
    (v) => /\d/.test(v) && /(cm|mm|CM|MM|厘米|毫米|米|寸|×|x|X|\*)/.test(v)
  );

  for (const item of fields) {
    const id = String(item.id ?? '').trim();
    if (!id || id === '品牌' || DY_ATTR_SKIP.test(id)) continue;
    if (item.ctrl === 'other') continue;

    // 已有值不动（平台的默认值 / 一键带入 / 人工填的）
    const hasValue = item.ctrl === 'text' ? item.value !== '' : item.selected.length > 0;
    if (hasValue) continue;

    const key = normalizeAttrKey(id);
    const hit =
      attrs.find((a) => normalizeAttrKey(a.name) === key) ??
      attrs.find((a) => {
        const name = normalizeAttrKey(a.name);
        return name && (key.includes(name) || name.includes(key));
      });

    let value = String(hit?.value ?? '').trim();

    // 尺寸没采到属性时，退回规格里的尺寸值。
    // 只认长得像尺寸的值（带数字和长度单位）——1688 有些商品把泵型/款式塞进「尺寸」维度，
    // 那种值填进「尺寸」属性是错的。多个值只能先填第一个并提示核对。
    if (!value && id === '尺寸' && sizeLikeValues.length) {
      value = sizeLikeValues[0];
      if (sizeLikeValues.length > 1) {
        pending.push(
          `属性「尺寸」有 ${sizeLikeValues.length} 个规格尺寸，已填第一个「${value}」，请核对`
        );
      }
    }

    if (!value) {
      if (item.required) pending.push(`属性「${id}」1688 没采到对应值，需手动填`);
      continue;
    }

    if (item.ctrl === 'text') {
      const input = dyField(page, id).locator('input[type="text"]').first();
      await input.fill(value).catch(() => {});
      await input.evaluate((el) => el.blur()).catch(() => {});
      await settle(page, 300);
      const after = String(await input.inputValue().catch(() => '')).trim();
      if (after) filled.push({ field: id, value: after });
      else pending.push(`属性「${id}」填「${value}」没落进输入框，需手动`);
      continue;
    }

    // 下拉（单选/多选）：按搜索词序列逐个试
    const field = dyField(page, id);
    let picked = null;
    for (const term of attrSearchTerms(value)) {
      picked = await pickDyOption(page, field, term);
      if (picked) break;
    }
    await page.keyboard.press('Escape').catch(() => {});

    if (picked) {
      filled.push({ field: id, value: picked });
    } else if (item.required) {
      pending.push(`属性「${id}」1688 为「${value}」，下拉里没有匹配选项，需手动选`);
    }
  }

  return { filled, pending };
}

/**
 * 该类目是否被平台纳入「规格标准化管控」。
 * 命中后自定义规格会被判失效，Excel 自动填也不作数，只能人工从标准值里选。
 */
async function hasStandardizedSpecWarning(page) {
  const text = await page
    .evaluate(() => String(document.body.innerText ?? '').replace(/\s+/g, ' '))
    .catch(() => '');
  return text.includes('规格标准化管控') || text.includes('标准化规格');
}

/** 判断当前是否已有多规格表格 */
async function hasSpecTable(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.some((t) => {
      const head = (t.querySelector('thead')?.innerText ?? '').replace(/\s+/g, '');
      return /价格/.test(head) && /库存/.test(head) && t.querySelectorAll('tbody tr').length > 0;
    });
  });
}

/** 数一下 SKU 表当前有几行 */
async function countSkuRows(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const hit = tables.find((t) => {
      const head = (t.querySelector('thead')?.innerText ?? '').replace(/\s+/g, '');
      return /价格/.test(head) && /库存/.test(head);
    });
    return hit ? hit.querySelectorAll('tbody tr').length : 0;
  });
}

/**
 * 上传规格 Excel 到「智能填写助手」并触发智能识别。
 *
 * 关键顺序（踩过的坑）：
 *   1. 先点「立即上传」开弹窗 —— 上传控件只在弹窗里才存在
 *   2. 弹窗内的控件 accept 是 ".xls,.xlsx,.png,.jpg,.jpeg,.csv"
 *   3. 传完文件后「智能识别」按钮才会变可点，必须点它 AI 才解析
 */
async function uploadSkuExcel(page, file, dimName = '颜色') {
  const openBtn = page.getByText('立即上传', { exact: false }).first();
  if (await openBtn.count()) {
    await openBtn.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const inputs = page.locator('input[type="file"]');
  const total = await inputs.count();
  let target = null;
  for (let i = total - 1; i >= 0; i -= 1) {
    const accept = (await inputs.nth(i).getAttribute('accept')) ?? '';
    if (accept.includes('.xlsx')) {
      target = inputs.nth(i);
      break;
    }
  }
  if (!target) return { ok: false, reason: '弹窗里没找到 Excel 上传控件' };

  try {
    await target.setInputFiles(file);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  await page.waitForTimeout(2500);

  // 智能识别按钮就绪后点击
  const aiBtn = page.getByRole('button', { name: /智能识别/ }).first();
  if (!(await aiBtn.count())) return { ok: false, reason: '没找到「智能识别」按钮' };
  for (let i = 0; i < 10; i += 1) {
    const disabled = await aiBtn.isDisabled().catch(() => true);
    if (!disabled) break;
    await page.waitForTimeout(800);
  }
  await aiBtn.click({ timeout: 8000 }).catch(() => {});

  // 等 AI 生成规格：轮询规格区文字
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(1500);
    const text = await page
      .evaluate(() => (document.querySelector('[data-guide="goods-spec-detail"]')?.innerText ?? '').replace(/\s+/g, ' '))
      .catch(() => '');
    if (text.length > 20) {
      await page.waitForTimeout(2500);
      // 每个规格类型都有一个「添加规格图」，据此数出类型数量
      const typeCount = (text.match(/添加规格图/g) || []).length;
      return { ok: true, specText: text.slice(0, 120), typeCount };
    }
  }
  return { ok: true, specText: '', typeCount: 0 };
}

/**
 * 多规格时逐行填价格与库存（每行输入框顺序：价格、库存、商家编码）。
 */
async function fillSkuTable(page, rows) {
  const result = { filled: 0, total: 0, skipped: 0 };
  if (!rows.length) return result;

  const tables = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('table'));
    const hit = list.find((t) => {
      const head = (t.querySelector('thead')?.innerText ?? '').replace(/\s+/g, '');
      return /价格/.test(head) && /库存/.test(head);
    });
    if (!hit) return { rows: 0 };
    return { rows: hit.querySelectorAll('tbody tr').length };
  });

  const total = tables.rows;
  if (!total) return result;
  result.total = total;

  const table = page.locator('table').filter({ hasText: '现货库存' }).last();
  const trs = table.locator('tbody tr');

  for (let i = 0; i < Math.min(total, rows.length); i += 1) {
    const inputs = trs.nth(i).locator('input:not([type="file"]):not([type="radio"]):not([type="checkbox"])');
    const count = await inputs.count();
    if (count < 2) {
      result.skipped += 1;
      continue;
    }

    const row = rows[i];
    try {
      const priceInput = inputs.nth(0);
      await priceInput.click().catch(() => {});
      await priceInput.fill(String(row.group));
      await priceInput.evaluate((el) => el.blur());

      const stockInput = inputs.nth(1);
      await stockInput.click().catch(() => {});
      await stockInput.fill(String(row.stock));
      await stockInput.evaluate((el) => el.blur());

      if (row.specCode && count >= 3) {
        const codeInput = inputs.nth(2);
        await codeInput.click().catch(() => {});
        await codeInput.fill(String(row.specCode));
        await codeInput.evaluate((el) => el.blur());
      }
      result.filled += 1;
    } catch {
      result.skipped += 1;
    }
  }

  await page.waitForTimeout(800);
  return result;
}

/**
 * 填一个商品，停在「发布商品」之前。
 */
export async function fillDouyinProduct({ product, images = [], detailImages = [], assets = [], rules = {} }) {
  const filled = [];
  const pending = [];

  const page = await openDouyinCreatePage();
  const legacy = await ensureLegacyForm(page);
  if (legacy) filled.push({ field: '发布入口', value: '已切到旧版结构化表单' });

  const { title, truncated } = buildTitle(product, rules);
  if (!title) throw new Error('商品标题为空');
  if (!(await fillTitle(page, title))) throw new Error('没找到标题输入框，页面结构可能已改版');
  filled.push({ field: '商品标题', value: title });
  if (truncated) pending.push('标题超出 60 字符已被截断，建议人工确认');

  const mainPaths = images.length ? images : localImagePaths(assets, 'main');
  if (!mainPaths.length) throw new Error('没有本地主图，请先完成媒体下载');

  const { ok: picked, skipped } = selectMainImages(mainPaths, rules);
  if (!picked.length) throw new Error('没有符合抖店要求的主图（需 ≥600×600、≤5MB）');
  const up = await uploadMainImages(page, picked);
  filled.push({ field: '主图/辅助图', value: `${up.uploaded}/${picked.length} 张` });
  if (skipped.length) {
    pending.push(
      `跳过 ${skipped.length} 张不合规图片：${skipped.slice(0, 3).map((s) => `${s.file}（${s.reason}）`).join('、')}`
    );
  }

  await settle(page, 2500);
  const moved = await goNext(page);
  if (!moved) throw new Error('没找到「下一步」按钮');
  await settle(page, 3000);

  // 平台可能按图片重写标题，覆盖回我们的
  await fillTitle(page, title).catch(() => {});
  filled.push({ field: '标题复核', value: '已覆盖为草稿标题' });

  const detailPaths = (detailImages.length ? detailImages : localImagePaths(assets, 'detail')).slice(
    0,
    Number(rules.detailImageMax ?? 20)
  );
  if (detailPaths.length) {
    const dt = await uploadDetailImages(page, detailPaths);
    if (dt.uploaded) filled.push({ field: '商品详情图', value: `${dt.uploaded} 张` });
    else pending.push(`详情图未上传：${dt.reason ?? '未知原因'}`);
  } else {
    pending.push('没有采集到详情长图，商品详情需手动');
  }

  const prices = planPrices(product?.price?.min, rules);

  // 规格：抖店没有预置规格类型，走「智能填写助手」上传 Excel（AI 自动识别表头）
  const plan = rules.multiSpec === false ? { dims: [] } : planSpecs(product, rules);
  let skuRows = [];
  let excelDone = false;

  // 标准化管控类目：自定义规格会被判失效，Excel 填了也白填，直接跳过去并提示
  const standardized = await hasStandardizedSpecWarning(page);
  if (standardized) {
    pending.push(
      '该类目被平台「规格标准化管控」：自定义规格（颜色分类/尺寸大小等）会被判失效，必须在该类目的标准规格项里手动选择。' +
        '规格与价格需人工填，其余内容已自动完成'
    );
  }

  if (plan.dims?.length && !standardized) {
    skuRows = buildSkuRows(product, plan, rules);
    if (rules.useSkuPrice) pending.push('每个 SKU 按各自的 1688 价换算，请抽查');
    const lowRows = countLowMarginRows(skuRows);
    if (lowRows > 0) {
      const hint = rules.priceMode === 'add' ? '加价金额可能偏小' : '加价倍数可能偏小';
      pending.push(`有 ${lowRows} 行售价低于该规格成本的 1.1 倍，${hint}`);
    }
    try {
      const excel = await buildSkuExcel({ product, plan, rows: skuRows });
      const uploaded = await uploadSkuExcel(page, excel.file, plan.dims[0].pddType);
      if (uploaded.ok) {
        excelDone = true;
        filled.push({
          field: '商品规格',
          value: `${plan.dims.map((d) => `${d.pddType}(${d.values.length})`).join(' × ')} = ${skuRows.length} 个 SKU`
        });
        filled.push({ field: '价格与库存', value: `${skuRows.length} 行（由 AI 按 Excel 填入）` });
        if (uploaded.typeCount > 1) {
          pending.push(
            `AI 生成了 ${uploaded.typeCount} 个规格类型（只应该有 1 个），多出来的空类型需要在页面手动删除`
          );
        }
        pending.push('规格与价格由抖店 AI 按 Excel 生成，请核对每行价格/库存是否与预期一致');
      } else {
        pending.push(`规格 Excel 上传失败：${uploaded.reason}`);
      }
    } catch (err) {
      pending.push(`规格未自动填：${err.message}`);
    }
  } else if (!(product?.skus ?? []).length) {
    pending.push('该商品没有采集到 SKU/规格，抖店只会生成 1 行价格库存——建议先在工具里重采一次再填表');
  }

  const multi = await hasSpecTable(page);
  if (standardized) {
    // 规格要人工按标准值选，价格行数也会随之变化，这里不写价格，避免留下错价
    pending.push('价格与库存请在补齐标准规格后手动填写（行数取决于标准规格值数量）');
  } else if (excelDone) {
    // 规格与价格都由 AI 按 Excel 生成，这里不再改写（避免覆盖 AI 结果）
  } else if (multi) {
    const tableFill = await fillSkuTable(page, skuRows);
    if (tableFill.filled) {
      filled.push({ field: '价格与库存', value: `${tableFill.filled}/${tableFill.total} 行` });
    }
    if (tableFill.skipped) pending.push(`有 ${tableFill.skipped} 行没填上价格库存，需核对`);
  } else if (prices) {
    const stock = Number(rules.stock ?? 999);
    const r = await fillPriceStock(page, prices, stock);
    if (r.manual) filled.push({ field: '规格模式', value: '已切到手动填写' });
    if (r.sale) filled.push({ field: '售卖价', value: prices.sale });
    if (r.ref) filled.push({ field: '参考价', value: prices.ref });
    if (r.stock) filled.push({ field: '库存', value: stock });
    if (!r.sale) pending.push('「售卖价」输入框仍是只读，价格需手动（先把规格切到手动填写）');
    if (!r.ref) pending.push('「参考价」需先在页面上点选设置方式，再手填或下次补');
  } else {
    pending.push('成本价缺失，价格库存需手动');
  }

  // 固定履约：48小时发货 + 7天无理由 + 包邮
  const ship = await applyFulfillment(page, rules);
  if (ship.delivery) filled.push({ field: '发货时间', value: rules.deliveryTime ?? '48小时' });
  else pending.push('发货时间未设置成功，需手动选');

  if (ship.afterSale) filled.push({ field: '售后服务', value: rules.afterSale ?? '7天无理由退货' });
  else pending.push('售后政策未设置成功，需手动选');

  if (ship.freight) filled.push({ field: '运费模板', value: rules.freightTemplate ?? '包邮' });
  else pending.push('运费模板未设置成功（店铺里可能没有名为「包邮」的模板），需手动选');

  // 类目属性：货号 + 品牌（固定无品牌）+ 其余按属性名自动填
  const attr = await fillRequiredAttributes(page, product);
  if (attr.goodsNo) filled.push({ field: '货号', value: attr.goodsNo });

  const categoryAttrs = await fillCategoryAttributes(page, product, rules);
  categoryAttrs.filled.forEach((f) => filled.push(f));
  categoryAttrs.pending.forEach((p) => pending.push(p));

  // 属性填完再读进度，才能反映真实情况
  const progress = await readRequiredProgress(page);
  if (progress !== null) {
    filled.push({ field: '类目必填项进度', value: `${progress}%` });
    if (progress < 100) pending.push(`类目属性必填项还差 ${100 - progress}%，请手动补`);
  }

  pending.push('类目由平台自动识别，请核对「商品类目」是否正确');
  pending.push('规格（颜色/尺码）：抖店默认走「智能填写助手」，如需自动请另开需求');
  pending.push('提交动作未自动化，请核对后自己点「发布商品」或「保存草稿」');

  return { url: page.url(), title, prices, filled, pending };
}
