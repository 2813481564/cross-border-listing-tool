/**
 * 把 1688 开放平台的商品结构，归一化成和浏览器采集一致的产品结构。
 *
 * 下游（媒体下载 / 美客多草稿 / 拼多多填表）只认这一套字段，
 * 所以这里必须对齐 normalizeProduct 的输出。
 */

const IMAGE_CDN = 'https://cbu01.alicdn.com/';

/** 相对图片地址补全成可下载的绝对地址 */
export function absoluteImageUrl(src) {
  if (!src || typeof src !== 'string') return null;
  const text = src.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('//')) return `https:${text}`;
  return IMAGE_CDN + text.replace(/^\/+/, '');
}

/** 从详情 HTML 里按顺序取出图片地址 */
export function detailImagesFromHtml(html) {
  if (!html) return [];
  const urls = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const url = absoluteImageUrl(match[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** HTML 去标签，保留可读文本 */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} payload 接口原始返回
 * @param {object} options { offerId, weightG }
 * @returns {object} 与采集通道无关的统一产品结构
 */
export function normalizeApiProduct(payload, { offerId, weightG } = {}) {
  const info = payload?.productInfo ?? payload?.result?.productInfo ?? null;
  if (!info || !info.productID) {
    throw new Error('接口返回里没有 productInfo，可能商品不存在或无权访问');
  }

  const productId = String(info.productID ?? offerId ?? '');

  // 主图
  const mainImages = (info.image?.images ?? []).map(absoluteImageUrl).filter(Boolean);

  // 详情长图
  const detailImages = detailImagesFromHtml(info.description);

  // SKU
  const skuInfos = info.skuInfos ?? [];
  const skus = skuInfos.map((sku) => {
    const specs = {};
    for (const attr of sku.attributes ?? []) {
      if (attr?.attributeName) specs[attr.attributeName] = String(attr.attributeValue ?? '');
    }
    return {
      skuId: String(sku.skuId ?? sku.skuCode ?? ''),
      price: Number(sku.price ?? sku.consignPrice ?? 0) || null,
      stock: Number(sku.amountOnSale ?? 0) || 0,
      specs
    };
  });

  // 规格图：每个 SKU 的属性里带 skuImageUrl 的那一项
  const skuImages = [];
  const seenSkuImage = new Set();
  for (const sku of skuInfos) {
    for (const attr of sku.attributes ?? []) {
      if (!attr?.skuImageUrl) continue;
      const key = `${attr.attributeName}=${attr.attributeValue}`;
      if (seenSkuImage.has(key)) continue;
      seenSkuImage.add(key);
      skuImages.push({
        prop: attr.attributeName,
        name: String(attr.attributeValue ?? ''),
        image: absoluteImageUrl(attr.skuImageUrl)
      });
    }
  }

  // 价格：优先各 SKU 价，其次阶梯价
  const skuPrices = skus.map((s) => s.price).filter((n) => Number.isFinite(n) && n > 0);
  const rangePrices = (info.saleInfo?.priceRanges ?? [])
    .map((r) => Number(r.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  const pricePool = skuPrices.length ? skuPrices : rangePrices;
  const minPrice = pricePool.length ? Math.min(...pricePool) : null;
  const maxPrice = pricePool.length ? Math.max(...pricePool) : null;

  // 属性（同名多值会重复出现，保留原样）
  const attributes = (info.attributes ?? [])
    .filter((a) => a?.attributeName && a?.value !== undefined)
    .map((a) => ({ name: String(a.attributeName), value: String(a.value) }));

  const videos = [];
  for (const url of [info.mainVedio, info.detailVedio]) {
    if (url && !videos.some((v) => v.url === url)) videos.push({ url, videoId: null });
  }

  return {
    offerId: productId,
    url: `https://detail.1688.com/offer/${productId}.html`,
    source: 'api',
    title: String(info.subject ?? '').trim(),
    price: {
      min: minPrice,
      max: maxPrice,
      path: 'api.productInfo.skuInfos/priceRanges'
    },
    images: mainImages,
    imageGroups: {
      main: mainImages,
      sku: skuImages,
      detail: detailImages
    },
    skus,
    attributes,
    // API 不返回包装信息，用类目默认重量兜底（可在配置里按类目覆盖）
    package: {
      weightG: Number(weightG) || null,
      table: null
    },
    videos,
    description: htmlToText(info.description).slice(0, 8000),
    // 1688 类目：浏览器采集拿不到，API 独有；用于类目映射
    category: {
      id: info.categoryID ? String(info.categoryID) : null,
      name: info.categoryName ?? null
    },
    // 店铺：API 只给 sellerLoginId。若它是纯英文/数字，才可能等于店铺域名；
    // 中文登录名无法拼域名，url 留空（前端不显示链接，商品页里仍可进店铺）
    shop: (() => {
      const loginId = info.sellerLoginId ? String(info.sellerLoginId) : null;
      if (!loginId) return null;
      const ascii = /^[a-zA-Z0-9-]+$/.test(loginId);
      return {
        loginId,
        name: null,
        url: ascii ? `https://${loginId.toLowerCase()}.1688.com` : null,
        guessed: true
      };
    })(),
    // 平台侧时间与状态，便于做回访对比
    meta: {
      status: info.status ?? null,
      createdAt: info.createTime ?? null,
      updatedAt: info.lastUpdateTime ?? null,
      expireAt: info.expireTime ?? null,
      sellerLoginId: info.sellerLoginId ?? null,
      referencePrice: info.referencePrice ?? null,
      minOrderQuantity: info.saleInfo?.minOrderQuantity ?? null,
      unit: info.saleInfo?.unit ?? null
    },
    rawSources: { api: 'alibaba.product.simple.get' },
    collectedAt: new Date().toISOString()
  };
}
