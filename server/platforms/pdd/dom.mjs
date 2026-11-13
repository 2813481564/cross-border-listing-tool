/**
 * 拼多多商家后台页面结构快照。
 *
 * 只读取 DOM，不做任何点击/输入。用于摸清表单结构、定位字段、排查改版。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../config.mjs';

/** 在页面上下文执行的采集函数（必须自包含，不能引用外部变量）。 */
function collectInPage() {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  };

  const clean = (text, max = 60) =>
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);

  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    let node = el.parentElement;
    for (let i = 0; i < 4 && node; i += 1) {
      const cls = String(node.className || '');
      if (/form-?item|field|label|control|row|cell/i.test(cls)) {
        const t = clean(node.innerText, 40);
        if (t) return t;
      }
      node = node.parentElement;
    }
    return '';
  };

  const selectorOf = (el) => {
    if (el.id) return `#${el.id}`;
    const name = el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    return null;
  };

  const fields = [];
  document
    .querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="switch"]')
    .forEach((el, idx) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' && el.type === 'hidden') return;
      fields.push({
        idx,
        tag,
        type: el.getAttribute('type') || '',
        label: labelOf(el),
        placeholder: clean(el.getAttribute('placeholder'), 40),
        name: el.getAttribute('name') || '',
        id: el.id || '',
        required:
          el.required === true ||
          el.getAttribute('aria-required') === 'true' ||
          Boolean(el.closest('[class*="required"]')),
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        readonly: el.readOnly === true || el.getAttribute('readonly') !== null,
        value: tag === 'select' ? '' : clean(el.value, 40),
        selector: selectorOf(el),
        visible: isVisible(el),
        options: tag === 'select' ? Array.from(el.options).slice(0, 15).map((o) => clean(o.text, 20)) : null,
        optionCount: tag === 'select' ? el.options.length : null
      });
    });

  const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el, idx) => ({
    idx,
    accept: el.getAttribute('accept') || '',
    multiple: el.multiple === true,
    name: el.getAttribute('name') || '',
    visible: isVisible(el)
  }));

  const labels = Array.from(document.querySelectorAll('label, [class*="label"], [class*="title"]'))
    .map((el) => clean(el.innerText, 30))
    .filter((t) => t && t.length <= 30);

  const tables = Array.from(document.querySelectorAll('table')).slice(0, 4).map((el, idx) => ({
    idx,
    headers: Array.from(el.querySelectorAll('thead th, thead td')).map((th) => clean(th.innerText, 20)),
    rows: el.querySelectorAll('tbody tr').length
  }));

  const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[class*="btn"]'))
    .map((el) => clean(el.innerText || el.getAttribute('aria-label'), 20))
    .filter(Boolean);

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: `${innerWidth}x${innerHeight}`,
    fields,
    fileInputs,
    labels: [...new Set(labels)].slice(0, 160),
    tables,
    buttons: [...new Set(buttons)].slice(0, 100),
    textSample: clean(document.body?.innerText, 1200),
    html: document.documentElement.outerHTML
  };
}

/**
 * 抓取当前页面结构。
 * @returns {Promise<object>} 结构快照，含 html 字段（需调用方自行落盘或丢弃）
 */
export async function snapshotPage(page) {
  return page.evaluate(collectInPage);
}

/**
 * 抓取并落盘：data/probe/<stamp>-<tag>.{html,json,md}
 * @returns {{reportPath:string, htmlPath:string, jsonPath:string, snapshot:object}}
 */
export async function saveSnapshot(page, tag = 'page') {
  const snap = await snapshotPage(page);
  const html = snap.html;
  delete snap.html;

  const outDir = path.join(ROOT, 'data', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const base = path.join(outDir, `${stamp}-${tag}`);

  fs.writeFileSync(`${base}.html`, html, 'utf8');
  fs.writeFileSync(`${base}.json`, JSON.stringify(snap, null, 2), 'utf8');
  fs.writeFileSync(`${base}-report.md`, snapshotToMarkdown(snap), 'utf8');

  return {
    snapshot: snap,
    reportPath: `${base}-report.md`,
    htmlPath: `${base}.html`,
    jsonPath: `${base}.json`
  };
}

/** 把快照渲染成 markdown 报告。 */
export function snapshotToMarkdown(snap) {
  const lines = [];
  lines.push('# 页面结构探针报告', '');
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 地址：${snap.url}`);
  lines.push(`- 标题：${snap.title}`);
  lines.push(`- 视口：${snap.viewport} / 文档状态：${snap.readyState}`);
  lines.push(`- 字段数：${snap.fields.length} / 可见字段：${snap.fields.filter((f) => f.visible).length}`);
  lines.push('');

  lines.push('## 可填字段', '');
  lines.push('| # | 标签 | 元素 | placeholder | 必填 | 可见 | 值 | 建议选择器 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  snap.fields.forEach((f, i) => {
    lines.push(
      `| ${i + 1} | ${f.label || '-'} | ${f.tag}${f.type ? `/${f.type}` : ''} | ${f.placeholder || '-'} | ${
        f.required ? '是' : ''
      } | ${f.visible ? '是' : '否'} | ${f.value || '-'} | ${f.selector || '-'} |`
    );
  });
  lines.push('');

  const selects = snap.fields.filter((f) => f.options && f.options.length);
  if (selects.length) {
    lines.push('## 原生下拉', '');
    selects.forEach((f) => {
      lines.push(`- **${f.label || f.name || f.id || '未命名'}**（${f.optionCount} 项）：${f.options.join(' / ')}`);
    });
    lines.push('');
  }

  if (snap.fileInputs.length) {
    lines.push('## 文件上传控件', '');
    snap.fileInputs.forEach((f) => {
      lines.push(`- accept="${f.accept}" multiple=${f.multiple} name="${f.name}" 可见=${f.visible}`);
    });
    lines.push('');
  }

  if (snap.tables.length) {
    lines.push('## 表格', '');
    snap.tables.forEach((t) => {
      lines.push(`- 表 ${t.idx + 1}（${t.rows} 行）：${t.headers.join(' | ') || '无表头'}`);
    });
    lines.push('');
  }

  if (snap.labels.length) {
    lines.push('## 页面标签文字', '');
    lines.push(snap.labels.map((l) => `\`${l}\``).join('、'));
    lines.push('');
  }

  if (snap.buttons.length) {
    lines.push('## 按钮文字', '');
    lines.push(snap.buttons.map((b) => `\`${b}\``).join('、'));
    lines.push('');
  }

  if (snap.textSample) {
    lines.push('## 正文摘录', '');
    lines.push('```');
    lines.push(snap.textSample);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}
