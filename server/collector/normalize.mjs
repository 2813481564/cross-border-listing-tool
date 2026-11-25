/**
 * 1688 页面内嵌 JSON 的启发式解析。
 *
 * 1688 的全局变量名与结构会变（modDetailData / __INIT_DATA__ / data-initial-data ...），
 * 因此这里不绑定固定路径，而是：
 *   1. 先把所有候选 JSON 源合并成一棵"证据树"
 *   2. 再用 key 名 + 值形态的启发式规则各自抽字段
 *   3. 每个字段记录来源路径，便于排查
 */

const IMG_EXT = /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i;

export function normalizeImageUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length < 12) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  if (!/^https?:\/\//i.test(s)) return null;
  if (!/alicdn|alibaba|1688|taobao|tbcdn/i.test(s)) return null;

  s = s.replace(/_\.webp$/i, '');
  s = s.replace(/_sum\.(jpg|jpeg|png|webp)$/i, '');
  s = s.replace(/_(\d+)x(\d+)(xz|q\d+)?\.(jpg|jpeg|png|webp)$/i, '');
  s = s.replace(/_q\d+\.(jpg|jpeg|png|webp)$/i, '');
  s = s.replace(/\.webp$/i, '');
  s = s.split('?')[0];

  if (!IMG_EXT.test(s)) return null;
  return s;
}

export function parsePriceValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const m = value.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  if (typeof value === 'object') {
    for (const key of ['price', 'value', 'amount', 'minPrice']) {
      if (key in value) {
        const parsed = parsePriceValue(value[key]);
        if (parsed !== null) return parsed;
      }
    }
  }
  return null;
}

const TITLE_KEYS = /^(subject|offerTitle|detailTitle|title|productTitle|name)$/i;
const PRICE_KEYS = /^(price|currentPrice|salePrice|consignPrice|promotionPrice|priceRange|priceInfo)$/i;
const ATTR_NAME_KEYS = /^(attributeName|attrName|name|propName|key)$/i;
const ATTR_VALUE_KEYS = /^(attributeValue|attrValue|value|propValue|text)$/i;

function* walk(node, path = '$', depth = 0, budget = { n: 0 }) {
  if (node === null || node === undefined) return;
  if (depth > 14) return;
  if (budget.n++ > 400000) return;
  if (typeof node !== 'object') return;

  yield { node, path };

  const children = Array.isArray(node) ? node.entries() : Object.entries(node);
  for (const [key, value] of children) {
    if (value && typeof value === 'object') {
      yield* walk(value, `${path}.${key}`, depth + 1, budget);
    }
  }
}

function pickString(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function looksLikeChineseTitle(s) {
  return typeof s === 'string' && s.length >= 6 && s.length <= 300 && /[\u4e00-\u9fa5]/.test(s);
}

// 页面图标、店铺 logo、评价图、占位图等噪音图
const IMAGE_NOISE = /\/(tfs|icon|icons|logo|logos|favicon|qrcode|avatar|sns|live)\/|-tps-\d+-\d+|-\d+-rate\.|summ\.|-gg_/i;
// 商品主图通常来自 ibank / i1..i4 目录
const MAIN_IMAGE = /\/img\/ibank\/|\/i[1-4]\//i;

/** 从证据树里收集商品图片 URL（去重，主图优先） */
export function extractImages(tree) {
  const main = [];
  const rest = [];
  const seen = new Set();
  for (const { node } of walk(tree)) {
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const value of values) {
      if (typeof value !== 'string' || value.length < 20) continue;
      const url = normalizeImageUrl(value);
      if (!url || seen.has(url)) continue;
      if (IMAGE_NOISE.test(url)) continue;
      seen.add(url);
      if (MAIN_IMAGE.test(url)) main.push(url);
      else rest.push(url);
    }
  }
  // 主图不足时再用其它图片补齐，避免个别商品拿不到图
  return main.length >= 3 ? main : [...main, ...rest];
}

/** 推荐位/相似商品的容器，里面的标题不是本商品 */
const RECOMMEND_PATH = /majorRecommendOfferInfos|recommend|similar|offerList|hotOffer|rankList|alsoView|guessYouLike/i;

export function extractTitle(tree) {
  const candidates = [];
  for (const { node, path } of walk(tree)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (RECOMMEND_PATH.test(path)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (!TITLE_KEYS.test(key)) continue;
      const s = pickString(value);
      if (!looksLikeChineseTitle(s)) continue;
      candidates.push({ title: s, path: `${path}.${key}`, len: s.length });
    }
  }
  if (!candidates.length) return { title: null, path: null };
  // 标题通常较长且包含空格/规格词，取最长的合理候选
  candidates.sort((a, b) => b.len - a.len);
  return { title: candidates[0].title, path: candidates[0].path };
}

/**
 * 本商品标题：优先 offerId 命中且 isCurrentOffer 的那条。
 *
 * 只靠「最长的中文串」会踩坑——推荐位里同款商品的标题经常比本商品更长，
 * 实测抓到的是一条完全不相干的项链标题。
 */
export function extractOfferTitle(tree, offerId) {
  const targetId = String(offerId ?? '');
  let matched = null;
  let current = null;

  for (const { node, path } of walk(tree)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const text = typeof node.title === 'string' ? node.title.trim() : '';
    if (!text || !looksLikeChineseTitle(text)) continue;

    const id = String(node.offerId ?? node.offerID ?? '');
    const isCurrent = node.isCurrentOffer === true;

    if (targetId && id === targetId) {
      if (isCurrent) return { title: text, path: `${path}.title` };
      matched = matched ?? { title: text, path: `${path}.title` };
    } else if (isCurrent && !current) {
      // 兜底：本页标了 isCurrentOffer 的那条（不受 offerId 字符串类型影响）
      current = { title: text, path: `${path}.title` };
    }
  }

  return matched ?? current ?? { title: null, path: null };
}

export function extractPrice(tree) {
  const hits = [];
  for (const { node, path } of walk(tree)) {
    if (!node || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if (!PRICE_KEYS.test(key)) continue;
      const p = parsePriceValue(value);
      if (p === null || p <= 0 || p > 1_000_000) continue;
      hits.push({ price: p, path: `${path}.${key}` });
    }
  }
  if (!hits.length) return { min: null, max: null, path: null };

  // 跳过明显是"划线价/市场价"的极大值，取众数区间
  const values = hits.map((h) => h.price).sort((a, b) => a - b);
  const min = values[0];
  const max = values[values.length - 1];
  return { min, max, path: hits[0].path, samples: hits.slice(0, 8) };
}

export function extractPriceRanges(tree) {
  const ranges = [];
  for (const { node } of walk(tree)) {
    if (!Array.isArray(node) || node.length === 0 || node.length > 30) continue;
    const items = node.filter((it) => it && typeof it === 'object' && (('beginAmount' in it) || ('startQuantity' in it) || ('minOrder' in it)));
    if (!items.length) continue;
    for (const it of items) {
      const qty = parsePriceValue(it.beginAmount ?? it.startQuantity ?? it.minOrder);
      const price = parsePriceValue(it.price ?? it.consignPrice ?? it.value);
      if (qty !== null && price !== null) ranges.push({ minQty: qty, price });
    }
    if (ranges.length) break;
  }
  return ranges;
}

function isSkuItem(it) {
  return (
    it &&
    typeof it === 'object' &&
    !Array.isArray(it) &&
    it.skuId !== undefined &&
    ('specAttrs' in it || 'skuAttrs' in it || 'price' in it || 'discountPrice' in it || 'specId' in it)
  );
}

/**
 * 1688 规格区里混着的说明文字不是规格值。
 *
 * 例：尺寸里多出「提示：钢丝包单卖8元/只」——它会占掉一个规格值名额、
 * 生成一批库存 0 的无效 SKU，还会把真实尺寸挤掉。这类文本必须在上游剔掉。
 */
const SPEC_HINT_PATTERN =
  /^(提示|注意|说明|备注|温馨提示)\s*[:：]|元\s*\/\s*(只|个|件|套|对|条|张)|单卖|不参与|请咨询|拍前咨询|下单前|另拍/;

export function isHintSpecValue(value) {
  return SPEC_HINT_PATTERN.test(String(value ?? ''));
}

/**
 * 1688 的 SKU 有几种形态：
 *  - skuProps: [{prop:'颜色', value:[{name}]}]  规格名与可选值
 *  - skuInfoMap: { '颜色值>尺寸值': {skuId, price, canBookCount, specAttrs} }  对象 map
 *  - tradeModel.skuMap: [...]  数组
 * 这里统一收集，并用 skuProps 的顺序还原规格名。
 */
export function extractSkus(tree) {
  let propNames = [];
  for (const { node } of walk(tree)) {
    if (!Array.isArray(node) || node.length === 0 || node.length > 20) continue;
    const isPropList = node.every((it) => it && typeof it === 'object' && typeof it.prop === 'string' && 'value' in it);
    if (isPropList) {
      propNames = node.map((it) => String(it.prop).trim());
      break;
    }
  }

  const collected = [];
  for (const { node } of walk(tree)) {
    if (Array.isArray(node)) {
      for (const it of node) if (isSkuItem(it)) collected.push(it);
    } else if (node && typeof node === 'object') {
      for (const value of Object.values(node)) if (isSkuItem(value)) collected.push(value);
    }
    if (collected.length > 3000) break;
  }

  const skus = [];
  const seen = new Set();
  for (const it of collected) {
    const id = String(it.skuId ?? it.specId ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const specs = {};
    const attrSource = it.specAttrs ?? it.skuAttrs ?? it.attributes ?? it.props;

    if (typeof attrSource === 'string') {
      const parts = attrSource.split(/&gt;|>/).map((s) => s.trim()).filter(Boolean);
      parts.forEach((part, index) => {
        const key = propNames[index] ?? `规格${index + 1}`;
        specs[key] = part;
      });
    } else if (Array.isArray(attrSource)) {
      for (const a of attrSource) {
        if (!a || typeof a !== 'object') continue;
        const k = pickString(a.attributeName ?? a.attrName ?? a.name ?? a.propName);
        const v = pickString(a.attributeValue ?? a.attrValue ?? a.value ?? a.propValue);
        if (k && v) specs[k] = v;
      }
    } else if (attrSource && typeof attrSource === 'object') {
      for (const [k, v] of Object.entries(attrSource)) {
        const val = pickString(v) ?? (typeof v === 'number' ? String(v) : null);
        if (val) specs[k] = val;
      }
    }

    // 带说明文字的 SKU 是配件/附注，不是主商品的可选规格，整条丢弃
    if (Object.values(specs).some((v) => isHintSpecValue(v))) continue;

    skus.push({
      skuId: id,
      specs,
      price: parsePriceValue(it.price ?? it.consignPrice ?? it.discountPrice),
      stock: parsePriceValue(it.canBookCount ?? it.amountOnSale ?? it.stock ?? it.quantity),
      image: normalizeImageUrl(it.imageUrl ?? it.image ?? it.skuImageUrl)
    });
  }
  return skus;
}

export function extractAttributes(tree) {
  const attrs = [];
  const seen = new Set();
  for (const { node } of walk(tree)) {
    if (!Array.isArray(node) || node.length === 0 || node.length > 200) continue;
    for (const it of node) {
      if (!it || typeof it !== 'object') continue;
      const keys = Object.keys(it);
      const nameKey = keys.find((k) => ATTR_NAME_KEYS.test(k));
      const valueKey = keys.find((k) => ATTR_VALUE_KEYS.test(k));
      if (!nameKey || !valueKey || nameKey === valueKey) continue;
      const name = pickString(it[nameKey]);
      const value = pickString(it[valueKey]);
      if (!name || !value || name.length > 30 || value.length > 200) continue;
      if (!/[\u4e00-\u9fa5]/.test(name)) continue;
      const key = `${name}=${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attrs.push({ name, value });
    }
    if (attrs.length >= 60) break;
  }
  return attrs;
}

export function extractDescription(tree) {
  let best = null;
  for (const { node, path } of walk(tree)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (!/^(description|detailDesc|offerDesc|desc|detailUrl)$/i.test(key)) continue;
      const s = pickString(value);
      if (!s || s.length < 15) continue;
      if (!best || s.length > best.text.length) best = { text: s, path: `${path}.${key}` };
    }
  }
  if (!best) return { text: '' };
  const text = best.text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, html: best.text.startsWith('<') ? best.text : '', path: best.path };
}

/**
 * 规格图：skuProps[].value[].imageUrl —— 每个颜色/款式值自带一张图
 */
export function extractSkuImages(tree) {
  for (const { node } of walk(tree)) {
    if (!Array.isArray(node) || node.length === 0 || node.length > 20) continue;
    const isPropList = node.every(
      (it) => it && typeof it === 'object' && typeof it.prop === 'string' && Array.isArray(it.value)
    );
    if (!isPropList) continue;

    const out = [];
    for (const prop of node) {
      for (const item of prop.value) {
        if (!item || typeof item !== 'object') continue;
        const image = normalizeImageUrl(item.imageUrl ?? item.image ?? item.img ?? item.picUrl);
        if (!image) continue;
        out.push({
          prop: String(prop.prop).trim(),
          name: String(item.name ?? '').trim(),
          image
        });
      }
    }
    if (out.length) return out;
  }
  return [];
}

/** 讲解视频接口返回的是 JSONP，去掉包裹再解析 */
export function parseVideo(videoRaw) {
  if (!videoRaw) return null;
  let text = String(videoRaw).trim();
  const wrapped = text.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  if (wrapped) text = wrapped[1];

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const data = json?.data ?? json;
  if (!data || typeof data !== 'object') return null;

  const url = data.videoUrl ?? data.video_url ?? data.playUrl;
  if (!url || !/^https?:\/\//.test(url)) return null;

  return {
    url,
    videoId: data.videoId ?? null,
    type: data.type ?? null,
    live: Boolean(data.living),
    linkUrl: data.linkUrl ?? null
  };
}

/** 价格在页面上被拆成分段渲染（¥ / 5 / . / 01），只能从正文兜底 */
export function extractPriceFromBodyText(text) {
  if (!text) return null;
  const m = text.match(/[¥￥]\s*(\d+)\s*[.．]\s*(\d{1,2})(?!\d)/);
  if (!m) return null;
  const value = Number(`${m[1]}.${m[2]}`);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 汇总成统一的商品结构。
 * @param {object} input { offerId, url, payload: { known, holders, ld, captures, domImages, domDetailHtml }, pageText }
 */
export function normalizeProduct({ offerId, url, payload, pageText = '' }) {
  const trees = [];
  for (const [name, value] of Object.entries(payload.known ?? {})) {
    if (value) trees.push({ source: name, data: value });
  }
  for (const cap of payload.captures ?? []) {
    if (cap?.json) trees.push({ source: `api:${String(cap.url).slice(0, 100)}`, data: cap.json });
  }
  for (let i = 0; i < (payload.holders ?? []).length; i++) {
    const raw = payload.holders[i];
    try {
      trees.push({ source: `data-initial-data[${i}]`, data: JSON.parse(raw) });
    } catch {
      /* 非 JSON，忽略 */
    }
  }
  for (let i = 0; i < (payload.ld ?? []).length; i++) {
    try {
      trees.push({ source: `ld+json[${i}]`, data: JSON.parse(payload.ld[i]) });
    } catch {
      /* 忽略 */
    }
  }

  const merged = { sources: trees.map((t) => t.source), data: trees };
  const combined = { trees: trees.map((t) => t.data) };

  // 优先本商品那条标题，避免被推荐位更长的标题顶掉
  const scopedTitle = extractOfferTitle(combined, offerId);
  const title = scopedTitle.title ? scopedTitle : extractTitle(combined);
  let price = extractPrice(combined);
  const skus = extractSkus(combined);
  // 属性优先用 DOM 直出的结果（接口里没有）
  const attributes = payload.domAttributes?.length ? [...payload.domAttributes] : extractAttributes(combined);

  // 包装信息表里的每件重量，是美客多物流的必填项
  let weightG = null;
  const pack = payload.domPackaging;
  if (pack?.headers?.length) {
    const idx = pack.headers.findIndex((h) => /重量/.test(h));
    if (idx >= 0) {
      const raw = pack.rows.map((row) => row[idx]).find((v) => v && /\d/.test(v));
      const digits = raw ? String(raw).replace(/[^\d.]/g, '') : '';
      if (digits && Number(digits) > 0) weightG = Number(digits);
    }
  }
  if (weightG && !attributes.some((a) => /重量|克重|毛重/.test(a.name))) {
    attributes.push({ name: '重量', value: `${weightG}g` });
  }
  let description = extractDescription(combined);
  const ranges = extractPriceRanges(combined);

  // 图片分三类：展示主图 / 规格图 / 详情长图
  const skuImages = extractSkuImages(combined);
  const skuImageSet = new Set(skuImages.map((s) => s.image));

  const domImages = (payload.domImages ?? []).map(normalizeImageUrl).filter(Boolean);
  const detailImages = (payload.domDetailImages ?? []).map(normalizeImageUrl).filter(Boolean);

  const mainImages = [...new Set([...extractImages(combined), ...domImages])].filter(
    (url) => !skuImageSet.has(url)
  );
  const images = mainImages.length ? mainImages : [...skuImageSet];

  // 讲解视频来自 getLiveInfoByOfferIdWap 接口；主图视频不在接口里，只能用 DOM 里的 <video> 兜底。
  // 接口对没有讲解视频的商品返回 data:{}，此时 videos 全看 DOM。
  const liveVideo = parseVideo(payload.videoRaw);
  const domVideos = (payload.domVideos ?? [])
    .map((item) => {
      const url = typeof item === 'string' ? item : item?.url;
      if (!url) return null;
      const videoId = String(url).match(/\/(\d{6,})\.(?:mp4|m3u8|flv)/i)?.[1] ?? null;
      return {
        url,
        videoId,
        type: 'main',
        live: false,
        poster: (typeof item === 'object' && item?.poster) || null,
        linkUrl: null
      };
    })
    .filter(Boolean);

  const seenVideoUrl = new Set();
  const videos = [liveVideo, ...domVideos].filter((item) => {
    if (!item) return false;
    const key = String(item.url).split('?')[0];
    if (seenVideoUrl.has(key)) return false;
    seenVideoUrl.add(key);
    return true;
  });

  let priceSource = price.path;
  // 接口里同时有本商品价和"同款推荐"价，优先取本商品
  const primarySample = (price.samples ?? []).find((s) => /currentOffer|offerDetail|\.offer\./i.test(s.path));
  if (primarySample) {
    price = { ...price, min: primarySample.price, max: primarySample.price, path: primarySample.path };
    priceSource = `${primarySample.path}(本商品)`;
  }

  // 促销/补贴会把「本商品价」压到低于所有 SKU 价（实测 2.21 vs 4.42），
  // 那个价下单时拿不到，用最低 SKU 价兜住
  const skuPrices = skus.map((s) => Number(s.price)).filter((p) => Number.isFinite(p) && p > 0);
  if (skuPrices.length) {
    const lo = Math.min(...skuPrices);
    const hi = Math.max(...skuPrices);
    if (price.min == null || price.min < lo * 0.95) {
      price = { ...price, min: lo, max: hi };
      priceSource = `${priceSource}(低于最低SKU价，已按SKU价修正)`;
    }
  }
  if (price.min === null) {
    const fromText = extractPriceFromBodyText(pageText);
    if (fromText) {
      price = { min: fromText, max: fromText, path: 'bodyText', samples: [] };
      priceSource = 'bodyText(页面文本兜底)';
    }
  }

  if (!description.text && payload.domDetailHtml) {
    description = { text: stripHtml(payload.domDetailHtml).slice(0, 8000), path: 'domDetailHtml' };
  }

  return {
    offerId,
    url,
    source: '1688',
    title: title.title,
    price: {
      currency: 'CNY',
      min: price.min,
      max: price.max,
      ranges
    },
    images,
    imageGroups: {
      main: images,
      sku: skuImages,
      detail: detailImages
    },
    skus,
    attributes,
    package: { weightG, table: pack ?? null },
    videos,
    description: description.text,
    // 店铺主页（从页面店铺链接取，取不到为 null）
    shop: payload.domShop
      ? { domain: payload.domShop.domain, url: payload.domShop.url, name: payload.domShop.name }
      : null,
    rawSources: merged.sources,
    debug: {
      titlePath: title.path,
      pricePath: priceSource,
      priceSamples: price.samples ?? [],
      descriptionPath: description.path ?? null,
      pageTextLength: (pageText || '').length
    },
    collectedAt: new Date().toISOString()
  };
}
