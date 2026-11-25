import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.mjs';

const DICT_FILE = path.join(ROOT, 'config', 'translate.zh-es.json');

let dictCache = null;

export function loadDictionary() {
  if (dictCache) return dictCache;
  if (!fs.existsSync(DICT_FILE)) {
    dictCache = [];
    return dictCache;
  }
  const raw = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
  const entries = Object.entries(raw)
    .filter(([k, v]) => !k.startsWith('_') && typeof v === 'string')
    .sort((a, b) => b[0].length - a[0].length);
  dictCache = entries;
  return dictCache;
}

export function reloadDictionary() {
  dictCache = null;
  return loadDictionary();
}

// 电商标题里对美客多无意义的堆词（1688 卖家用来抢搜索，跨境刊登时是噪音）
const NOISE_WORDS =
  /包邮|爆款|厂家直销|一件代发|现货速发|外贸原单|限时特价|跨境|跨境外贸|A类|B类|网红|同款|特价|批发|代发|铺货|专供|直供|新款上市/g;

export function translateTitle(zhTitle, dict = loadDictionary()) {
  if (!zhTitle) return { title: '', replaced: 0, leftoverChinese: 0 };
  let out = zhTitle.replace(NOISE_WORDS, ' ');
  let replaced = 0;
  for (const [zh, es] of dict) {
    if (!zh || !out.includes(zh)) continue;
    out = out.split(zh).join(es === '' ? ' ' : ` ${es} `);
    replaced += 1;
  }
  out = out
    .replace(/[【】\[\]（）()「」《》]/g, ' ')
    .replace(/[,，、;；]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const leftoverChinese = (out.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  return { title: out, replaced, leftoverChinese };
}

export function truncateTitle(title, maxLength) {
  if (!title || title.length <= maxLength) return { title, truncated: false };
  const slice = title.slice(0, maxLength);
  const cut = slice.lastIndexOf(' ');
  const result = (cut > maxLength * 0.6 ? slice.slice(0, cut) : slice).trim();
  return { title: result, truncated: true };
}

export function calcPrice(cnyPrice, mlConfig) {
  if (!Number.isFinite(cnyPrice) || cnyPrice <= 0) return null;
  const raw = cnyPrice * mlConfig.rate * mlConfig.markup;
  if (!mlConfig.priceEnding) return { amount: Math.round(raw * 100) / 100, raw };

  const ending = Number.parseFloat(mlConfig.priceEnding);
  const safeEnding = Number.isFinite(ending) ? ending : 0.9;
  const base = Math.floor(raw);
  const rounded = Math.max(1, base - (base % 10) + 9);
  return { amount: Number((rounded + safeEnding).toFixed(2)), raw };
}

export function buildAttributes(product, mlConfig) {
  // mapped: 能对上美客多属性 ID 的；unmapped: 对不上的；all: 全量（对不上的 id 为 null）
  const mapped = [];
  const unmapped = [];
  const all = [];
  const seen = new Set();

  const map = mlConfig.attributeMap ?? {};
  // 1688 的属性名各品类差异大（"材质" vs "面料材质" vs "主面料成分"），
  // 精确匹配不到时用互相包含兜底
  const resolveId = (name) => {
    if (map[name]) return map[name];
    const hit = Object.keys(map).find((key) => key && (name.includes(key) || key.includes(name)));
    return hit ? map[hit] : null;
  };

  for (const attr of product.attributes ?? []) {
    const id = resolveId(attr.name);
    const value = String(attr.value ?? '').trim();
    if (!value) continue;
    if (id) {
      // 同一个美客多属性只能有一个值，冲突时保留信息但不带 id
      if (seen.has(id)) {
        unmapped.push({ name: attr.name, value: value });
        all.push({ id: null, name: attr.name, value_name: value, conflict_with: id });
        continue;
      }
      seen.add(id);
      mapped.push({ id, name: attr.name, value_name: value });
      all.push({ id, name: attr.name, value_name: value });
    } else {
      unmapped.push({ name: attr.name, value: value });
      all.push({ id: null, name: attr.name, value_name: value });
    }
  }
  return { mapped, unmapped, all };
}

export function buildDraft(product, mlConfig) {
  const warnings = [];
  const dict = loadDictionary();

  // 标题
  const translated = translateTitle(product.title, dict);
  const truncated = truncateTitle(translated.title, mlConfig.titleMaxLength);
  if (!product.title) {
    warnings.push({ level: 'error', field: 'title', message: '未采集到商品标题，需人工填写' });
  } else if (translated.title === product.title) {
    warnings.push({ level: 'warn', field: 'title', message: '标题未命中任何词表条目，仍是中文，需人工翻译' });
  } else if (translated.leftoverChinese > 0) {
    warnings.push({
      level: 'warn',
      field: 'title',
      message: `标题仍有 ${translated.leftoverChinese} 个中文字符未翻译，建议补充 config/translate.zh-es.json`
    });
  }
  if (truncated.truncated) {
    warnings.push({
      level: 'info',
      field: 'title',
      message: `标题超过 ${mlConfig.titleMaxLength} 字符，已截断；原文：${product.title}`
    });
  }

  // 价格
  const cny = product.price?.min ?? null;
  const price = calcPrice(cny, mlConfig);
  if (!price) {
    warnings.push({ level: 'error', field: 'price', message: '未采集到价格，无法换算' });
  }

  // 图片
  const pictures = product.images ?? [];
  if (pictures.length < mlConfig.minImages) {
    warnings.push({
      level: 'warn',
      field: 'pictures',
      message: `仅采集到 ${pictures.length} 张图片，美客多建议至少 ${mlConfig.minImages} 张`
    });
  }

  // 库存：用真实可售量，只按配置上限收敛（美客多单条上限 9999）
  const maxQty = Number.isFinite(mlConfig.maxQuantity) ? mlConfig.maxQuantity : 9999;
  const stocks = (product.skus ?? []).map((s) => s.stock).filter((n) => Number.isFinite(n) && n > 0);
  const totalStock = stocks.reduce((sum, n) => sum + n, 0);
  const quantity = stocks.length ? Math.min(totalStock, maxQty) : 10;

  // 规格图：规格值 -> 图，用于变体配图
  const skuImageByValue = new Map(
    (product.imageGroups?.sku ?? []).map((s) => [`${s.prop}=${s.name}`, s.image])
  );

  // 规格：把 SKU 转成美客多的 variations，规格名与值原样带过来
  const variations = (product.skus ?? [])
    .filter((s) => s.specs && Object.keys(s.specs).length > 0)
    .map((s) => {
      const combos = Object.entries(s.specs);
      const matched = combos.map(([k, v]) => skuImageByValue.get(`${k}=${v}`)).find(Boolean) ?? null;
      return {
        sku: `${product.offerId}-${s.skuId}`,
        attribute_combinations: combos.map(([name, value_name]) => ({ name, value_name })),
        // 默认与主商品同价，避免顶层价与变体价打架；
        // 需要在美客多按规格差异定价时，把 variationsUseSkuPrice 打开
        price: mlConfig.variationsUseSkuPrice
          ? (calcPrice(s.price, mlConfig)?.amount ?? price?.amount ?? null)
          : (price?.amount ?? null),
        source_price_cny: s.price ?? null,
        available_quantity: Math.min(s.stock ?? 0, maxQty),
        picture_url: matched,
        picture_ids: []
      };
    });

  if (variations.length === 1) {
    warnings.push({
      level: 'info',
      field: 'variations',
      message: '该商品只有 1 个规格，美客多创建变体通常要求至少 2 个；可只保留主商品，或自行补充规格'
    });
  }

  // 0 个规格通常是「页面内嵌数据没解析到」而不是商品真没规格，提示重采
  if ((product.skus ?? []).length === 0) {
    warnings.push({
      level: 'warn',
      field: 'skus',
      message: '没解析到任何规格/SKU：可能是页面未加载完或触发风控降级，建议重新采集一次再上架'
    });
  }

  // 重量：优先用包装信息表的真实称重
  const weightG = product.package?.weightG ?? null;
  const weightAttr = (product.attributes ?? []).find((a) => /重量|毛重/.test(a.name));
  if (!weightG && !weightAttr) {
    warnings.push({ level: 'warn', field: 'weight', message: '未采集到重量，美客多物流需填重量(克)' });
  }

  const { unmapped, all: allAttributes } = buildAttributes(product, mlConfig);
  if (unmapped.length) {
    warnings.push({
      level: 'info',
      field: 'attributes',
      message: `${unmapped.length} 个属性没匹配到美客多属性 ID，已保留在 attributes 里（id 为 null），提交前需在 attributeMap 补映射`
    });
  }

  const draft = {
    source: {
      platform: '1688',
      offerId: product.offerId,
      url: product.url,
      collectedAt: product.collectedAt,
      originalTitle: product.title,
      originalPriceCny: cny
    },
    site_id: mlConfig.site,
    category_id: '',
    title: truncated.title,
    condition: 'new',
    buying_mode: 'buy_it_now',
    listing_type_id: 'gold_special',
    currency_id: mlConfig.currency,
    price: price?.amount ?? null,
    available_quantity: quantity,
    pictures: pictures.map((url) => ({ source: url })),
    // 1688 的讲解视频，美客多刊登时需另行上传（API 走 video 接口）
    videos: (product.videos ?? []).map((v) => ({ url: v.url, type: v.type, video_id: v.videoId })),
    image_summary: {
      main: pictures.length,
      sku: (product.imageGroups?.sku ?? []).length,
      detail: (product.imageGroups?.detail ?? []).length
    },
    detail_images: (product.imageGroups?.detail ?? []).map((url) => ({ source: url })),
    // 全量属性：能对上美客多 ID 的带 id，对不上的 id 为 null（提交前需处理）
    attributes: allAttributes,
    mapped_attribute_count: allAttributes.filter((a) => a.id).length,
    extra_attributes: unmapped,
    // 1688 原始参数完整保留，方便对照与人工补映射
    source_attributes: product.attributes ?? [],
    variations,
    pricing: {
      cost_cny: cny,
      sku_price_cny: product.skus?.[0]?.price ?? null,
      rate: mlConfig.rate,
      markup: mlConfig.markup,
      formula: 'cost_cny × rate × markup，再按 priceEnding 取尾数',
      converted_cny: price?.raw != null ? Math.round(price.raw * 100) / 100 : null
    },
    package: {
      weight_g: weightG,
      table: product.package?.table ?? null
    },
    shipping: { mode: 'me2', free_shipping: false },
    description: { plain_text: product.description || '' },
    sku: product.offerId
  };

  return {
    ok: !warnings.some((w) => w.level === 'error'),
    draft,
    warnings,
    meta: {
      rate: mlConfig.rate,
      markup: mlConfig.markup,
      rawPriceTarget: price?.raw ?? null,
      translatedWords: translated.replaced
    }
  };
}

const CSV_COLUMNS = [
  ['offerId', (r) => r.draft.source.offerId],
  ['title', (r) => r.draft.title],
  ['originalTitle', (r) => r.draft.source.originalTitle],
  ['priceCny', (r) => r.draft.source.originalPriceCny],
  ['price', (r) => r.draft.price],
  ['currency', (r) => r.draft.currency_id],
  ['quantity', (r) => r.draft.available_quantity],
  ['pictures', (r) => r.draft.pictures.map((p) => p.source).join(' | ')],
  ['attributes', (r) => r.draft.attributes.map((a) => `${a.name}=${a.value_name}`).join(' | ')],
  ['url', (r) => r.draft.source.url]
];

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(results) {
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const rows = results.map((r) => CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(','));
  return [header, ...rows].join('\r\n');
}
