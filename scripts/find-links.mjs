/**
 * 在当前页面里按文字查找可点击元素，打印其 href / 标签，用于确定真实入口地址。
 *
 * 只读，不点击。
 *
 * 用法：
 *   node scripts/find-links.mjs 发布
 *   node scripts/find-links.mjs 发布 --match goods
 */

import { chromium } from 'playwright-core';
import { loadConfig } from '../server/config.mjs';

const argv = process.argv.slice(2);
const text = argv[0];
const mi = argv.indexOf('--match');
const match = mi >= 0 ? argv[mi + 1] : null;

if (!text) {
  console.error('用法：node scripts/find-links.mjs <文字> [--match url片段]');
  process.exit(1);
}

const { chrome } = loadConfig();
const port = chrome.debugPort ?? 9333;

async function main() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error();
  } catch {
    console.error('Chrome 调试端口未就绪，请先运行：npm run chrome');
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const pages = context.pages().filter((p) => /^https?:/.test(p.url()));
  const page = (match && pages.findLast((p) => p.url().includes(match))) ?? pages[pages.length - 1];

  console.log(`PAGE: ${page.url()}`);

  const found = await page.evaluate((needle) => {
    const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
    const out = [];
    document.querySelectorAll('a, button, [role="button"], [class*="btn"]').forEach((el) => {
      const label = clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title'));
      if (!label || !label.includes(needle)) return;
      out.push({
        tag: el.tagName.toLowerCase(),
        text: label.slice(0, 30),
        href: el.getAttribute('href') || '',
        cls: String(el.className || '').slice(0, 60),
        html: el.outerHTML.slice(0, 200)
      });
    });
    return out;
  }, text);

  if (!found.length) {
    console.log(`未找到文字包含「${text}」的元素`);
  } else {
    found.forEach((f, i) => {
      console.log(`\n[${i + 1}] <${f.tag}> ${f.text}`);
      if (f.href) console.log(`    href: ${f.href}`);
      console.log(`    class: ${f.cls}`);
      console.log(`    html: ${f.html.replace(/\s+/g, ' ')}`);
    });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
