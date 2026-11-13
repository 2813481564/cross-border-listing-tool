/**
 * 只读页面结构探针。
 *
 * 用途：连接已启动的 Chrome（调试端口），把当前标签页的表单结构 dump 出来，
 * 供开发「半自动填表」时确定字段定位方式。
 *
 * 安全边界：只读取 DOM，绝不点击、不输入、不提交、不关闭浏览器。
 *
 * 用法：
 *   node scripts/inspect-page.mjs
 *   node scripts/inspect-page.mjs --match pinduoduo
 *   node scripts/inspect-page.mjs --list
 */

import path from 'node:path';
import { chromium } from 'playwright-core';
import { loadConfig, ROOT } from '../server/config.mjs';
import { saveSnapshot } from '../server/platforms/pdd/dom.mjs';

const argv = process.argv.slice(2);
const mi = argv.indexOf('--match');
const match = mi >= 0 ? argv[mi + 1] : null;
const listOnly = argv.includes('--list');

async function connect() {
  const { chrome } = loadConfig();
  const port = chrome.debugPort ?? 9333;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

async function main() {
  const browser = await connect();
  if (!browser) {
    console.error('Chrome 调试端口未就绪。请先运行：npm run chrome');
    console.error('然后在弹出的窗口里登录拼多多商家后台，并打开要分析的页面。');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error('没有可用的浏览器上下文。');
    process.exit(1);
  }

  const pages = context.pages().filter((p) => /^https?:/.test(p.url()));
  if (!pages.length) {
    console.error('没有打开的网页标签。请在浏览器里打开目标页面后重试。');
    process.exit(1);
  }

  if (listOnly) {
    pages.forEach((p, i) => console.log(`${i + 1}. ${p.url()}`));
    process.exit(0);
  }

  const pick =
    (match && pages.findLast((p) => p.url().includes(match))) ??
    pages.findLast((p) => /pinduoduo|yangkeduo/.test(p.url())) ??
    pages[pages.length - 1];

  console.log(`TARGET: ${pick.url()}`);

  const { snapshot, reportPath, htmlPath, jsonPath } = await saveSnapshot(pick, 'page');

  console.log(`FIELDS: ${snapshot.fields.length} (visible ${snapshot.fields.filter((f) => f.visible).length})`);
  console.log(`FILE_INPUTS: ${snapshot.fileInputs.length}`);
  console.log(`TABLES: ${snapshot.tables.length}`);
  console.log(`REPORT: ${path.relative(ROOT, reportPath)}`);
  console.log(`HTML:   ${path.relative(ROOT, htmlPath)}`);
  console.log(`JSON:   ${path.relative(ROOT, jsonPath)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('探针失败：', err.message);
  process.exit(1);
});
