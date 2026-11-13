/**
 * 解析平台批量导入模板的结构。
 * 用法: node scripts/inspect-template.mjs <模板.xlsx>
 *
 * 会打印每个 sheet 的行数、疑似表头行、前几行内容与列数，
 * 用于把我们的商品数据准确映射到模板列上。
 */
import path from 'node:path';
import ExcelJS from 'exceljs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/inspect-template.mjs <模板.xlsx>');
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.resolve(file));

console.log(`文件: ${path.basename(file)}`);
console.log(`工作表数: ${wb.worksheets.length}\n`);

for (const ws of wb.worksheets) {
  console.log('='.repeat(70));
  console.log(`工作表: 「${ws.name}」  行 ${ws.rowCount} / 列 ${ws.columnCount}`);

  const dumpRows = Math.min(ws.rowCount, 8);
  for (let r = 1; r <= dumpRows; r++) {
    const row = ws.getRow(r);
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      let text = cell.text;
      if (cell.type === ExcelJS.ValueType.Formula) text = `=${cell.formula}`;
      if (text && text.length > 40) text = `${text.slice(0, 40)}…`;
      cells.push(`${col}:${text}`);
    });
    if (!cells.length) {
      console.log(`  [${r}] (空行)`);
      continue;
    }
    console.log(`  [${r}] ${cells.join(' | ')}`);
  }

  // 找出列数最多的那一行，通常就是表头
  let bestRow = 1;
  let bestCount = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
    let count = 0;
    ws.getRow(r).eachCell({ includeEmpty: false }, () => count++);
    if (count > bestCount) {
      bestCount = count;
      bestRow = r;
    }
  }
  console.log(`  → 疑似表头行: 第 ${bestRow} 行（${bestCount} 列）`);
  const headers = [];
  ws.getRow(bestRow).eachCell({ includeEmpty: false }, (cell, col) => {
    headers.push(`${col}=${cell.text}`);
  });
  console.log(`  → 表头: ${headers.join(' | ')}`);
  console.log('');
}
