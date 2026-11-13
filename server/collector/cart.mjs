/**
 * 读取 1688 采购车里的商品，供「采集购物车」按钮使用。
 *
 * 页面是 SPA（lit 组件），类名带构建哈希（如 `item-group--title--F09mZrH`），
 * 哈希每次发版都会变，所以这里只用**语义前缀**做定位，不写死完整类名：
 *   - 购物车主体：`[class*="cart--content"]`
 *   - 每个商品行：`tr[class*="item-group--container"]`
 *
 * 页面底部还有「精选货源」推荐位，实测其卡片不含 offer 链接，
 * 但为了保险仍然只在购物车主体范围内抓，避免以后改版把推荐位也算进来。
 */

import { openWorkPage, closeWorkPage } from '../chrome.mjs';

const CART_URL = 'https://cart.1688.com/cart.htm';

function detectBlock({ url, bodyText }) {
  if (/login\.(1688|taobao)\.com|passport\.1688\.com/i.test(url)) {
    return '购物车需要登录：请在工具启动的 Chrome 窗口里登录 1688 后重试';
  }
  if (/_____tmd_____|punish|captcha|nocaptcha/i.test(url)) {
    return '触发 1688 风控验证：请在 Chrome 窗口里手动完成滑块验证后重试';
  }
  if (/滑动验证|拖动滑块|请完成验证|安全验证|访问受限/.test(bodyText || '')) {
    return '触发 1688 风控验证：请在 Chrome 窗口里手动完成验证后重试';
  }
  return null;
}

/**
 * @returns {Promise<{items: Array<{offerId, url, title}>, cartUrl, hasInvalid, total}>}
 */
export async function scanCart({ timeoutMs = 30000 } = {}) {
  const { page } = await openWorkPage();

  try {
    const res = await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!res || res.status() >= 400) {
      throw new Error(`购物车页打开失败 HTTP ${res?.status() ?? '?'}`);
    }

    await page.waitForTimeout(2500);

    const blocked = detectBlock({ url: page.url(), bodyText: '' });
    if (blocked) throw new Error(blocked);

    // 等购物车主体渲染出来；等不到也别立刻失败，下面还有兜底判断
    await page.waitForSelector('[class*="cart--content"]', { timeout: timeoutMs }).catch(() => {});

    // 滚一遍，把懒加载的行拉出来，再回到顶部
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(320);
    }
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo({ top: 0 }));

    const info = await page.evaluate(() => {
      const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

      const scope = document.querySelector('[class*="cart--content"]') ?? document.body;
      const items = new Map();

      for (const anchor of scope.querySelectorAll('a[href*="offer/"]')) {
        const href = anchor.getAttribute('href') || '';
        const matched = /offer\/(\d{6,})/.exec(href);
        if (!matched) continue;

        const offerId = matched[1];
        const row = anchor.closest('tr[class*="item-group--container"]');
        const titleNode = row?.querySelector('[class*="item-group--title"]');
        const title = clean(titleNode?.textContent || anchor.textContent).slice(0, 120);

        const existing = items.get(offerId);
        // 同一商品有两个链接（图 + 标题），保留能拿到标题的那条
        if (existing) {
          if (!existing.title && title) existing.title = title;
          continue;
        }
        items.set(offerId, { offerId, title });
      }

      const bodyText = document.body.innerText;
      const empty =
        items.size === 0 &&
        /购物车还是空的|购物车是空的|还没有添加商品|空空如也/.test(bodyText);

      return {
        items: [...items.values()].map((it) => ({
          ...it,
          url: `https://detail.1688.com/offer/${it.offerId}.html`
        })),
        hasInvalid: /失效|已下架|无货|已售完/.test(bodyText),
        empty
      };
    });

    if (info.empty) throw new Error('购物车里没有商品');

    return { ...info, cartUrl: page.url(), total: info.items.length };
  } finally {
    await closeWorkPage(page);
  }
}
