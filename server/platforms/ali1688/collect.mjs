/**
 * 用 1688 开放平台采集单个商品（API 通道）。
 *
 * 与浏览器通道输出同一套产品结构，下游无需区分来源。
 */

import { loadConfig } from '../../config.mjs';
import { callAliApi } from './client.mjs';
import { normalizeApiProduct } from './product.mjs';

/** 按 1688 类目取默认重量，没配置则用全局默认 */
export function resolveWeightG(categoryId, aliConfig = {}) {
  const table = aliConfig.weightByCategory ?? {};
  const hit = table[String(categoryId ?? '')];
  if (Number.isFinite(Number(hit)) && Number(hit) > 0) return Number(hit);
  const fallback = Number(aliConfig.defaultWeightG ?? 500);
  return fallback > 0 ? fallback : 500;
}

/** 凭证是否齐全（齐全才值得尝试 API） */
export function apiReady(aliConfig = {}) {
  return Boolean(aliConfig.appKey && aliConfig.appSecret && aliConfig.accessToken);
}

/**
 * @param {string} productId 1688 商品 ID（offerId）
 * @returns {Promise<object>} 统一产品结构
 */
export async function collectViaApi(productId, options = {}) {
  const config = loadConfig();
  const aliConfig = config.platforms?.ali1688 ?? {};

  const payload = await callAliApi(
    'alibaba.product.simple.get',
    { productID: String(productId), webSite: options.webSite ?? '1688' },
    aliConfig,
    { timeoutMs: options.timeoutMs ?? 20000 }
  );

  const product = normalizeApiProduct(payload, { offerId: String(productId) });
  product.package.weightG = resolveWeightG(product.category?.id, aliConfig);
  return product;
}
