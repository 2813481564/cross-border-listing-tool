/**
 * 在已启动的调试浏览器里打开（或聚焦）一个页面。
 *
 * 用法：node scripts/open-page.mjs <url>
 *
 * 只在目标地址没有已打开的标签时新建，避免重复开页。
 */

import { chromium } from 'playwright-core';
import { loadConfig } from '../server/config.mjs';

const url = process.argv[2];
if (!url) {
  console.error('用法：node scripts/open-page.mjs <url>');
  process.exit(1);
}

const { chrome } = loadConfig();
const port = chrome.debugPort ?? 9333;

async function main() {
  let info;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error();
    info = await res.json();
  } catch {
    console.error('Chrome 调试端口未就绪，请先运行：npm run chrome');
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('没有可用的浏览器上下文');

  const host = new URL(url).host;
  const existing = context.pages().find((p) => {
    try {
      return new URL(p.url()).host === host;
    } catch {
      return false;
    }
  });

  const page = existing ?? (await context.newPage());
  if (existing) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(1500);

  console.log(`URL:   ${page.url()}`);
  console.log(`TITLE: ${await page.title().catch(() => '')}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('打开失败：', err.message);
  process.exit(1);
});
