import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const RESULT_DIR = path.join(DATA_DIR, 'results');
export const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');
// 图片与视频的本地副本
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const DB_FILE = path.join(DATA_DIR, 'listing.db');
export const CONFIG_FILE = path.join(ROOT, 'config', 'settings.json');

for (const dir of [DATA_DIR, IMAGE_DIR, RAW_DIR, RESULT_DIR, MEDIA_DIR, PROFILE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const DEFAULTS = {
  server: { port: 5173 },
  chrome: { debugPort: 9333, exePath: '' },
  collect: {
    // 采集通道：api=只用开放平台接口；browser=只用浏览器；auto=能走接口就走，否则回落浏览器
    mode: 'auto',
    // 采集后等待页面内嵌数据就绪的毫秒上限
    waitTimeoutMs: 25000,
    // 两个链接之间的最小间隔，避免触发风控
    intervalMs: 2500,
    // 是否把原始页面 JSON 存档，便于解析器调试
    dumpRaw: true
  },
  images: { download: true, maxCount: 12 },
  mercadolibre: {
    site: 'MLM',
    currency: 'MXN',
    // 人民币 -> 目标币种
    rate: 2.55,
    // 在成本价上的加价倍数
    markup: 1.6,
    // 心理尾数，例如 9.9 表示以 X9.90 结尾
    priceEnding: '.90',
    titleMaxLength: 60,
    minImages: 3,
    // 库存上限（美客多单条上限 9999），采集到的真实库存超过时按此收敛
    maxQuantity: 9999,
    // 变体是否按各自 SKU 原价换算；false 时与主商品同价
    variationsUseSkuPrice: false,
    // 中文属性名 -> 美客多属性名（可在 config/settings.json 覆盖）
    attributeMap: {
      品牌: 'BRAND',
      型号: 'MODEL',
      材质: 'MATERIAL',
      面料材质: 'MATERIAL',
      成分与含量: 'MATERIAL',
      颜色: 'COLOR',
      尺码: 'SIZE',
      尺寸规格: 'SIZE',
      风格: 'STYLE',
      图案: 'PATTERN',
      适用人群: 'RECOMMENDED_AGE',
      产地: 'ORIGIN',
      重量: 'WEIGHT',
      克重: 'WEIGHT',
      容量: 'VOLUME_CAPACITY'
    }
  },
  // 本地采集端 -> 线上服务器的数据推送
  remote: {
    enabled: false,
    // 例如 https://lcwllt.com/listing-desk
    baseUrl: '',
    // 接收端校验令牌，两端配置成同一个值
    token: ''
  },
  platforms: {
    // 1688 开放平台（企业自用应用）
    ali1688: {
      appKey: '',
      appSecret: '',
      // 授权配置里生成的 accessToken（企业自用场景长期有效）
      accessToken: '',
      // 授权用户对应的 1688 会员 ID（可选，用于日志核对）
      userId: '',
      // API 不返回包装重量：按 1688 类目 ID 配默认重量（克）
      weightByCategory: {},
      // 类目没配时的兜底重量（克）
      defaultWeightG: 500
    },
    pdd: {
      enabled: false,
      gateway: 'https://gw-api.pinduoduo.com/api/router',
      clientId: '',
      clientSecret: '',
      accessToken: '',
      refreshToken: '',
      // 默认发货地址 ID / 运费模板，发布时必填
      shipAddressId: '',
      costTemplateId: '',
      // 半自动填表规则（浏览器里填，不走接口）
      publish: {
        // 拼多多标题上限：30 个汉字（60 字符）
        titleMaxLength: 30,
        // 加价方式：markup=成本×倍数，add=成本+固定金额（元）
        priceMode: 'markup',
        // 拼单价 = 成本价 × markup（priceMode=markup 时生效）
        markup: 1.35,
        // 拼单价 = 成本价 + addAmount（priceMode=add 时生效）
        addAmount: 0,
        // 单买价 = 拼单价 × singleRatio（不得低于拼单价）
        singleRatio: 1.2,
        // 商品参考价 = 单买价 × refRatio（须大于最大单买价）
        refRatio: 1.6,
        // 心理尾数
        priceEnding: '.9',
        // 默认库存
        stock: 999,
        // 最多上传多少张轮播图（平台上限 10）
        imageMax: 10,
        // 轮播图最小边长（拼多多要求 >480px）
        imageMinSide: 480,
        // 轮播图单张体积上限，默认 3MB
        imageMaxBytes: 3145728,
        // 宽高比容差（1:1 或 3:4 允许的浮动）
        imageRatioTolerance: 0.03,
        // 是否点「一键复用」把平台匹配的属性填上
        autoAttributes: true,
        // 多规格：把 1688 的规格维度映射成拼多多规格类型
        multiSpec: true,
        // 最多几个规格类型（拼多多上限 2）
        maxSpecTypes: 2,
        // SKU 组合数上限，超过就退回单规格并提示
        maxSkus: 100,
        // 每个 SKU 是否用各自的 1688 价换算，false 时统一用主商品价
        useSkuPrice: false,
        // 某规格在 1688 没有规格图时：true=用主图 01 兜底，false=留空等人工补
        previewFallbackMain: false,
        // 是否把采集到的详情长图传进「商品详情（快捷编辑）」
        uploadDetail: true,
        // 详情长图最多传几张（平台上限 50）
        detailImageMax: 20,
        // 商品编码前缀，留空则不填
        codePrefix: '1688-',
        // 规格编码前缀，留空则不填
        specCodePrefix: ''
      }
    }
  }
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件解析失败 ${CONFIG_FILE}: ${err.message}`);
    }
  }
  return deepMerge(DEFAULTS, user);
}

export function writeDefaultConfig() {
  if (fs.existsSync(CONFIG_FILE)) return false;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  return true;
}

export { DEFAULTS };
