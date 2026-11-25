/**
 * 生成抖店「智能填写助手」用的规格 Excel。
 *
 * 抖店没有强制模板格式，是 AI 自动识别表头，所以列名写得直白即可：
 *   颜色 | 尺码(若有) | 价格 | 库存 | 商家编码
 */

import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { ROOT } from '../../config.mjs';

/**
 * @param {object} options
 * @param {object} options.product 采集到的商品
 * @param {object} options.plan    planSpecs 的结果（含 dims）
 * @param {object[]} options.rows  buildSkuRows 的结果
 * @param {string} [options.dir]   输出目录
 * @returns {Promise<{file:string, rows:number, dims:string[]}>}
 */
/**
 * 抖店规格值清洗：去掉【】里的营销后缀，并截到 20 字（平台上限附近），
 * 超长值会被 AI 丢弃，导致它自己乱猜规格（实测踩过）。
 */
function cleanDyValue(raw) {
  const text = String(raw ?? '').trim();
  const stripped = text.replace(/[【\[（(][^】\]）)]*[】\]）)]/g, '').replace(/\s+/g, ' ').trim();
  return (stripped || text).slice(0, 20);
}

export async function buildSkuExcel({ product, plan, rows, dir }) {
  const dims = (plan?.dims ?? []).map((d) => d.pddType);
  if (!dims.length || !rows?.length) throw new Error('没有可写入 Excel 的规格数据');

  // 清洗后可能出现重名，按维度去重并加序号
  const valueMap = new Map(); // `${dim}|${raw}` -> 可用值
  const used = new Map(); // `${dim}` -> Set(已用值)
  for (const dim of plan.dims) {
    used.set(dim.pddType, new Set());
    for (const raw of dim.values) {
      let value = cleanDyValue(raw);
      const set = used.get(dim.pddType);
      let n = 2;
      while (set.has(value)) {
        value = `${cleanDyValue(raw).slice(0, 17)}-${n}`;
        n += 1;
      }
      set.add(value);
      valueMap.set(`${dim.pddType}|${raw}`, value);
    }
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('商品规格');

  // 抖店是 AI 自动识别表头，列越全、它补的属性越多（用户样例里带长宽高/体积/重量）
  const weightG = Number(product?.package?.weightG) || null;
  const header = [...dims, '价格', '库存', '商家编码'];
  if (weightG) header.push('重量(g)');

  ws.addRow(header);
  ws.getRow(1).font = { bold: true };

  for (const row of rows) {
    const specCells = dims.map(
      (type) => valueMap.get(`${type}|${row.specs?.[type] ?? ''}`) ?? cleanDyValue(row.specs?.[type] ?? '')
    );
    const values = [...specCells, Number(row.group) || 0, Number(row.stock) || 0, row.specCode || ''];
    if (weightG) values.push(weightG);
    ws.addRow(values);
  }

  ws.columns.forEach((column, index) => {
    column.width = index < dims.length ? 26 : 12;
  });

  const outDir = dir ?? path.join(ROOT, 'data', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `dy-sku-${product?.offerId ?? 'x'}.xlsx`);
  await wb.xlsx.writeFile(file);

  return { file, rows: rows.length, dims };
}
