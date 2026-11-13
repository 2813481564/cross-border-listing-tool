/**
 * 离线冒烟测试：不访问网络，验证解析器与草稿生成的关键路径。
 * 运行: node scripts/smoke.mjs
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { normalizeProduct, normalizeImageUrl, extractOfferId } from '../server/collector/index.mjs';
import { buildDraft, calcPrice, truncateTitle, translateTitle, toCsv } from '../server/draft/mercadolibre.mjs';
import { pddSign } from '../server/platforms/pdd/client.mjs';

const ML = {
  site: 'MLM',
  currency: 'MXN',
  rate: 2.55,
  markup: 1.6,
  priceEnding: '.90',
  titleMaxLength: 60,
  minImages: 3,
  attributeMap: { 材质: 'MATERIAL', 颜色: 'COLOR', 重量: 'WEIGHT' }
};

// 模拟 1688 页面里常见的嵌套结构
const fakePayload = {
  known: {
    modDetailData: {
      globalData: {
        tempModel: {
          offerTitle: '厂家直销 不锈钢保温杯 500ml 大容量 户外便携 黑色',
          offerImgList: [
            '//cbu01.alicdn.com/img/ibank/O1CN01abc_!!0-item_pic.jpg_.webp',
            'https://cbu01.alicdn.com/img/ibank/O1CN01def.jpg_300x300.jpg',
            'https://cbu01.alicdn.com/img/ibank/O1CN01ghi.jpg'
          ]
        }
      },
      orderParam: {
        skuInfo: {
          skuList: [
            { skuId: 's1', price: '12.50', amountOnSale: 88, specAttrs: [{ attributeName: '颜色', attributeValue: '黑色' }] },
            { skuId: 's2', price: '12.50', amountOnSale: 120, specAttrs: [{ attributeName: '颜色', attributeValue: '白色' }] }
          ],
          priceRanges: [{ beginAmount: 1, price: 12.5 }, { beginAmount: 100, price: 10.8 }]
        }
      },
      productFeature: {
        attributes: [
          { attributeName: '材质', attributeValue: '不锈钢' },
          { attributeName: '颜色', attributeValue: '黑色' },
          { attributeName: '净重', attributeValue: '320g' }
        ]
      },
      description: { detailDesc: '<p>500ml 不锈钢保温杯，真空双层。</p>' }
    }
  },
  holders: [],
  ld: []
};

const product = normalizeProduct({
  offerId: '123456789',
  url: 'https://detail.1688.com/offer/123456789.html',
  payload: fakePayload
});

assert.equal(product.offerId, '123456789');
assert.ok(product.title.includes('保温杯'), '应解析出标题');
assert.equal(product.images.length, 3, '应解析出 3 张去重后的图片');
assert.equal(new Set(product.images).size, 3);
assert.equal(product.images[0], 'https://cbu01.alicdn.com/img/ibank/O1CN01abc_!!0-item_pic.jpg');
assert.equal(product.price.min, 10.8);
assert.equal(product.price.max, 12.5);
assert.equal(product.skus.length, 2);
assert.equal(product.skus[0].specs['颜色'], '黑色');
assert.equal(product.skus[0].stock, 88);
assert.ok(product.attributes.find((a) => a.name === '材质')?.value === '不锈钢');
assert.ok(product.description.includes('真空双层'), '描述应去掉 HTML 标签');
assert.equal(product.price.ranges.length, 2);

// 价格换算
assert.deepEqual(calcPrice(12.5, ML), { amount: 59.9, raw: 51 });
assert.equal(calcPrice(0, ML), null);

// 标题翻译与截断
const translated = translateTitle(product.title);
assert.ok(/acero inoxidable/.test(translated.title), '应翻译不锈钢');
assert.ok(!/厂家直销/.test(translated.title), '应剔除噪音词');
assert.equal(truncateTitle('a'.repeat(80), 60).truncated, true);
assert.ok(truncateTitle('a'.repeat(80), 60).title.length <= 60);

// 草稿
const built = buildDraft(product, ML);
assert.equal(built.draft.currency_id, 'MXN');
// 草稿价基于最低阶梯价 10.8 * 2.55 * 1.6 = 44.06 -> 49.90
assert.equal(built.draft.price, 49.9);
assert.equal(built.draft.available_quantity, 208, '库存取 SKU 库存合计');
assert.equal(built.draft.title.length <= 60, true);
assert.ok(built.draft.attributes.find((a) => a.id === 'MATERIAL'));
assert.ok(built.draft.source_attributes.length >= 3, '原始参数应完整保留');
assert.equal(built.draft.variations.length, 2, '应生成 2 个规格变体');
assert.deepEqual(built.draft.variations[0].attribute_combinations, [{ name: '颜色', value_name: '黑色' }]);
assert.equal(built.draft.variations[0].available_quantity, 88);
assert.equal(built.draft.pricing.cost_cny, 10.8);

// 无重量时应有提示
assert.ok(built.warnings.some((w) => w.field === 'weight'));

const csv = toCsv([built]);
assert.ok(csv.split('\r\n').length === 2);

// URL/ID 归一
assert.equal(extractOfferId('https://detail.1688.com/offer/668899.html?spm=a1'), '668899');
assert.equal(extractOfferId('668899'), '668899');
assert.equal(normalizeImageUrl('//cbu01.alicdn.com/img/ibank/x.jpg_.webp'), 'https://cbu01.alicdn.com/img/ibank/x.jpg');
assert.equal(normalizeImageUrl('https://example.com/a.jpg'), null);

// 拼多多签名：参数名 ASCII 升序 -> key+value 拼接 -> 首尾加 secret -> MD5 大写
const signParams = { type: 'pdd.goods.cats.get', client_id: '123', timestamp: '1700000000', data_type: 'JSON' };
const expectedSign = crypto
  .createHash('md5')
  .update(
    'secret' + 'client_id123' + 'data_typeJSON' + 'timestamp1700000000' + 'typepdd.goods.cats.get' + 'secret',
    'utf8'
  )
  .digest('hex')
  .toUpperCase();
assert.equal(pddSign(signParams, 'secret'), expectedSign);
assert.equal(pddSign(signParams, 'secret').length, 32);
// 空值参数不参与签名
assert.equal(pddSign({ ...signParams, access_token: '' }, 'secret'), expectedSign);

console.log('冒烟测试通过');
