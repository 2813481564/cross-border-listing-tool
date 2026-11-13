/**
 * 1688 开放平台（open.1688.com）调用客户端。
 *
 * 算法逐字对齐官方 Python SDK（aop/api/base.py）：
 *   1. signPath = `param2/{version}/{namespace}/{apiName}/{appKey}`（**不带前导斜杠**）
 *   2. 把每个参数拼成 `key+value` 字符串，**对这些整串排序**（不是按 key 排）
 *   3. 待签串 = signPath + 排序后整串依次相连
 *   4. _aop_signature = HMAC-SHA1(appSecret, 待签串) 转大写
 *   5. 请求方式为 **POST 表单**（application/x-www-form-urlencoded），不是 GET query
 *
 * 踩过的坑：路径带前导斜杠、按 key 排序、用 GET —— 任一不对都会返回 gw.SignatureInvalid。
 */

import crypto from 'node:crypto';

const GATEWAY = 'https://gw.open.1688.com/openapi';

/** 常见 API 前缀 → 命名空间（1688 网关按命名空间路由，缺失会返回 gw.APIUnsupported） */
const NAMESPACE_BY_PREFIX = {
  'alibaba.product.': 'com.alibaba.product',
  // 注意：member 系列挂在 trade 命名空间下（见官方 SDK 的 get_api_uri）
  'alibaba.member.': 'com.alibaba.trade',
  'alibaba.trade.': 'com.alibaba.trade',
  'alibaba.account.': 'com.alibaba.account',
  'alibaba.category.': 'com.alibaba.category',
  'alibaba.logistics.': 'com.alibaba.logistics',
  'alibaba.offer.': 'com.alibaba.product'
};

/**
 * 解析 API 名：支持三种写法
 *   alibaba.product.simple.get               → 按前缀推断命名空间
 *   com.alibaba.product:alibaba.product.simple.get
 *   com.alibaba.product/alibaba.product.simple.get
 */
export function splitApiName(name) {
  const text = String(name ?? '').trim();
  if (!text) throw new Error('缺少 API 名称');

  if (text.includes(':')) {
    const [namespace, rest] = text.split(':');
    return { namespace, apiName: rest.replace(/-\d+$/, '') };
  }
  if (text.includes('/')) {
    const [namespace, rest] = text.split('/');
    return { namespace, apiName: rest.replace(/-\d+$/, '') };
  }
  for (const [prefix, namespace] of Object.entries(NAMESPACE_BY_PREFIX)) {
    if (text.startsWith(prefix)) return { namespace, apiName: text };
  }
  throw new Error(`无法推断 API「${text}」的命名空间，请写成 com.alibaba.product:${text}`);
}

export class AliApiError extends Error {
  constructor(payload, meta = {}) {
    const code = payload?.errorCode ?? payload?.error_code ?? 'UNKNOWN';
    const message = payload?.errorInfo ?? payload?.errorMessage ?? payload?.error_info ?? '1688 接口调用失败';
    super(`[${code}] ${message}`);
    this.name = 'AliApiError';
    this.code = code;
    this.requestId = payload?.requestId ?? payload?.request_id ?? meta.requestId ?? null;
    this.raw = payload;
  }

  /** 无权限（该商家不是已购买商家）——auto 模式据此回落浏览器采集 */
  get isNoPermission() {
    return this.code === 'NO_PERMISSION';
  }
}

/**
 * 计算 _aop_signature（对齐官方 SDK）。
 * @param {string} signPath 形如 param2/1/com.alibaba.product/alibaba.product.simple.get/4884508
 * @param {object} params 参与签名的全部参数（含 access_token）
 */
export function signRequest(signPath, params, appSecret) {
  const paramStrings = Object.entries(params)
    .filter(([key, value]) => key !== '_aop_signature' && value !== undefined && value !== null)
    .map(([key, value]) => `${key}${value}`)
    .sort();

  const message = signPath + paramStrings.join('');
  return crypto.createHmac('sha1', appSecret).update(message, 'utf8').digest('hex').toUpperCase();
}

/**
 * 调用 1688 API。
 * @param {string} apiName 例如 alibaba.product.simple.get
 * @param {object} params  业务参数（不含 access_token）
 * @param {object} credentials { appKey, appSecret, accessToken }
 * @param {object} options { timeoutMs, version }
 */
export async function callAliApi(apiName, params = {}, credentials = {}, { timeoutMs = 20000, version = '1' } = {}) {
  const { appKey, appSecret, accessToken } = credentials;
  if (!appKey || !appSecret) throw new Error('缺少 1688 appKey / appSecret，请在 config/settings.json 的 platforms.ali1688 填写');
  if (!accessToken) throw new Error('缺少 1688 accessToken（开放平台「授权配置」生成后填入）');

  const { namespace, apiName: pureName } = splitApiName(apiName);

  // 注意：signPath 不带前导斜杠，且排序按「key+value」整串
  const signPath = `param2/${version}/${namespace}/${pureName}/${appKey}`;
  const url = `${GATEWAY}/${signPath}`;

  const form = { ...params, access_token: accessToken };
  const signature = signRequest(signPath, form, appSecret);
  const body = new URLSearchParams({ ...form, _aop_signature: signature });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
        Connection: 'Keep-Alive',
        'User-Agent': 'Ocean-SDK-Client',
        Accept: 'application/json'
      },
      body
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === 'AbortError' ? '1688 接口超时' : `1688 请求失败：${err.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`1688 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }

  // 平台会在成功时也带 errorCode（如空字符串），只有非空且明确失败才算错
  if (payload?.errorCode && payload.errorCode !== 'SUCCESS') throw new AliApiError(payload);
  if (payload?.success === false) throw new AliApiError(payload);
  if (!res.ok) throw new AliApiError(payload, { requestId: payload?.requestId });

  return payload;
}
