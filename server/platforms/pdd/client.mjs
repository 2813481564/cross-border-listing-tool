import crypto from 'node:crypto';

/**
 * 拼多多开放平台通用客户端。
 *
 * 签名规则（官方）：
 *   1. 除 sign 外的所有请求参数按参数名 ASCII 升序排序
 *   2. 拼成 key1value1key2value2... 的形式
 *   3. 首尾各拼接一次 client_secret
 *   4. MD5 后转大写
 */
export function pddSign(params, clientSecret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();

  const joined = keys.map((k) => `${k}${params[k]}`).join('');
  return crypto
    .createHash('md5')
    .update(`${clientSecret}${joined}${clientSecret}`, 'utf8')
    .digest('hex')
    .toUpperCase();
}

export class PddError extends Error {
  constructor(payload) {
    const err = payload?.error_response ?? payload;
    super(err?.error_msg || '拼多多接口调用失败');
    this.name = 'PddError';
    this.code = err?.error_code ?? null;
    this.subCode = err?.sub_code ?? null;
    this.subMsg = err?.sub_msg ?? null;
    this.raw = payload;
  }
}

export function createPddClient(config, { timeoutMs = 30000 } = {}) {
  const { gateway, clientId, clientSecret, accessToken } = config ?? {};

  if (!clientId || !clientSecret) {
    throw new Error('拼多多 clientId / clientSecret 未配置');
  }

  /**
   * @param {string} type 接口名，如 pdd.goods.cats.get
   * @param {object} bizParams 业务参数
   * @param {object} options { needToken, version, method }
   */
  async function call(type, bizParams = {}, options = {}) {
    const { needToken = true, version = 'V1' } = options;

    const params = {
      type,
      client_id: clientId,
      timestamp: String(Math.floor(Date.now() / 1000)),
      data_type: 'JSON',
      version
    };
    if (needToken) {
      if (!accessToken) throw new Error('拼多多 access_token 未配置，需要先完成店铺授权');
      params.access_token = accessToken;
    }
    for (const [k, v] of Object.entries(bizParams)) {
      if (v === undefined || v === null) continue;
      params[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    params.sign = pddSign(params, clientSecret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(gateway, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: new URLSearchParams(params).toString(),
        signal: controller.signal
      });

      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`拼多多返回非 JSON：${text.slice(0, 200)}`);
      }

      if (payload.error_response) throw new PddError(payload);

      // 响应体形如 { "pdd_goods_cats_get_response": { ... } }
      const key = Object.keys(payload).find((k) => k.endsWith('_response'));
      return key ? payload[key] : payload;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`拼多多接口超时：${type}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return { call };
}

/* ---------------- 具体接口封装 ---------------- */

export function pddCategories(client) {
  return client.call('pdd.goods.cats.get', { parent_cat_id: 0 }, { needToken: false });
}

export function pddCategoryTemplate(client, catId) {
  return client.call('pdd.goods.cat.template.get', { cat_id: catId });
}

export function pddSpecs(client, catId) {
  return client.call('pdd.goods.spec.get', { cat_id: catId });
}

// 图片上传（pdd.goods.image.upload）是 multipart 提交，签名与普通接口不同，
// 待拿到真实凭证联调后再按实际文档实现，这里不预设实现。

export function pddAddGoods(client, goodsPayload) {
  return client.call('pdd.goods.add', { goods_commit_request: goodsPayload });
}

export function pddGoodsDetail(client, goodsId) {
  return client.call('pdd.goods.detail.get', { goods_id: goodsId });
}
