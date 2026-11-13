/**
 * 采集路由：决定走 API 还是浏览器。
 *
 * mode:
 *   api      只用 API，失败直接报错
 *   browser  只用浏览器（原有半自动通道）
 *   auto     凭证齐全且商品属于已购买商家 → API；否则回落浏览器
 *
 * 两条通道输出同一套产品结构，调用方无需关心来源。
 */

import { loadConfig } from '../config.mjs';
import { collectOffer as collectByBrowser, extractOfferId } from './ali1688.mjs';
import { collectViaApi, apiReady } from '../platforms/ali1688/collect.mjs';

export { extractOfferId };

/**
 * @param {string} input 商品链接或 ID
 * @param {object} options { mode, ...采集参数 }
 */
export async function collectOffer(input, options = {}) {
  const config = loadConfig();
  const mode = options.mode ?? config.collect?.mode ?? 'auto';
  const aliConfig = config.platforms?.ali1688 ?? {};
  const offerId = options.offerId ?? extractOfferId(input) ?? null;

  if (mode === 'browser') {
    return collectByBrowser(input, options);
  }

  const canTryApi = offerId && apiReady(aliConfig);

  if (mode === 'api') {
    if (!canTryApi) {
      throw new Error('API 采集不可用：请先在 config/settings.json 的 platforms.ali1688 填写 appKey / appSecret / accessToken');
    }
    return collectViaApi(offerId, options);
  }

  // auto：凭证缺失时也回落，但要说清楚，避免以为走了接口
  if (mode === 'auto' && !canTryApi) {
    const product = await collectByBrowser(input, options);
    product.apiFallback = {
      reason: 'NO_CREDENTIALS',
      message: 'API 凭证未配置，已使用浏览器采集（填好 platforms.ali1688 后自动切接口）'
    };
    return product;
  }

  if (canTryApi) {
    try {
      return await collectViaApi(offerId, options);
    } catch (err) {
      // 该商家不是「已购买商家」→ 正常回落浏览器
      if (err?.isNoPermission) {
        const product = await collectByBrowser(input, options);
        product.apiFallback = { reason: 'NO_PERMISSION', message: err.message };
        return product;
      }
      // 其他错误（签名/凭证/网络）在 auto 下也回落，但把原因记下来，避免静默失败
      const product = await collectByBrowser(input, options);
      product.apiFallback = { reason: err.code ?? 'ERROR', message: err.message };
      return product;
    }
  }

  return collectByBrowser(input, options);
}
