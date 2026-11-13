/**
 * 只读探测 1688 购物车页面结构，用于实现「采集购物车」。
 * 不点击、不提交、不改任何数据。
 *
 *   node scripts/probe-cart.mjs
 *
 * 输出：识别到的 offerId 数量、链接样例、页面文本片段、是否有失效区/分页。
 */

import { chromium } from 'playwright-core';
import { loadConfig } from '../server/config.mjs';

const CARTS = ['https://cart.1688.com/cart.htm', 'https://trade.1688.com/cart/cart.htm'];
const port = loadConfig().chrome.debugPort ?? 9333;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
const page = await context.newPage();

let picked = null;
for (const url of CARTS) {
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(6000);
    const finalUrl = page.url();
    const title = await page.title();
    console.log(`[try] ${url}\n  → ${finalUrl}\n  → ${title} (${res?.status()})`);
    if (!/login|passport/i.test(finalUrl)) {
      picked = finalUrl;
      break;
    }
  } catch (err) {
    console.log(`[try] ${url} 失败: ${err.message}`);
  }
}

if (!picked) {
  console.log('两个入口都跳到了登录页，可能登录态失效');
  await page.close();
  process.exit(1);
}

const info = await page.evaluate(() => {
  const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

  const anchors = [...document.querySelectorAll('a[href]')];
  const offerAnchors = anchors
    .map((a) => a.getAttribute('href') || '')
    .filter((h) => /offer\/\d{6,}|offerId=\d{6,}/i.test(h));

  const html = document.documentElement.innerHTML;
  const fromHtml = new Set();
  for (const m of html.matchAll(/offer\/(\d{6,})/g)) fromHtml.add(m[1]);
  for (const m of html.matchAll(/[?&]offerId=(\d{6,})/gi)) fromHtml.add(m[1]);

  // 页面里看起来像「购物车分组」的标题
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="header"]')]
    .map((el) => clean(el.innerText))
    .filter((t) => t && t.length <= 20)
    .slice(0, 40);

  const globals = Object.keys(window).filter((k) => /cart|data|init|store|state/i.test(k)).slice(0, 60);

  return {
    title: document.title,
    bodyLen: document.body.innerText.length,
    bodyHead: clean(document.body.innerText).slice(0, 1200),
    offerAnchorCount: offerAnchors.length,
    offerAnchorSamples: [...new Set(offerAnchors)].slice(0, 8),
    offerIdsFromHtml: [...fromHtml],
    headings: [...new Set(headings)],
    hasInvalidSection: /失效|下架|无货|已售完/.test(document.body.innerText),
    hasPaging: Boolean(document.querySelector('[class*="pagination"],[class*="pager"],[class*="page-"]')),
    hasCheckbox: document.querySelectorAll('input[type="checkbox"]').length,
    globals
  };
});

console.log('\n=== 探测结果 ===');
console.log('标题:', info.title);
console.log('可见文本长度:', info.bodyLen);
console.log('offer 锚点数:', info.offerAnchorCount);
console.log('HTML 里的 offerId 数:', info.offerIdsFromHtml.length);
console.log('offerId 列表:', info.offerIdsFromHtml.slice(0, 30).join(', '));
console.log('锚点样例:', info.offerAnchorSamples);
console.log('含失效/下架字样:', info.hasInvalidSection);
console.log('有分页控件:', info.hasPaging);
console.log('复选框数量:', info.hasCheckbox);
console.log('疑似标题:', info.headings);
console.log('疑似全局变量:', info.globals);
console.log('\n--- 正文开头 ---\n' + info.bodyHead);

await page.close();
process.exit(0);
