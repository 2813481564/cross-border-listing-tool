import fs from 'node:fs';
import path from 'node:path';
import { RAW_DIR } from '../config.mjs';
import { openWorkPage, closeWorkPage } from '../chrome.mjs';
import { normalizeProduct } from './normalize.mjs';

export function extractOfferId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^\d{6,}$/.test(s)) return s;
  const patterns = [/offer\/(\d{6,})/, /[?&]offerId=(\d{6,})/i, /(\d{6,})\.html/, /\/offer\/(\d{6,})/];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

function detectBlock({ url, bodyText }) {
  if (/login\.(1688|taobao)\.com/i.test(url)) {
    return '需要登录 1688：请在工具启动的 Chrome 窗口中登录后重试';
  }
  if (/_____tmd_____|punish|captcha|nocaptcha/i.test(url)) {
    return '触发 1688 风控验证：请在 Chrome 窗口中手动完成滑块验证后重试';
  }
  if (/滑动验证|拖动滑块|请完成验证|安全验证|访问受限/.test(bodyText || '')) {
    return '触发 1688 风控验证：请在 Chrome 窗口中手动完成验证后重试';
  }
  return null;
}

/**
 * 新版详情页把数据放在接口响应里，且 window 上多为带循环引用的框架对象，
 * 直接 JSON.stringify 会抛错。这里做一次安全深拷贝。
 */
const SAFE_CLONE_SRC = `
  (obj, maxDepth) => {
    const seen = new WeakSet();
    const walk = (v, d) => {
      if (v === null || v === undefined) return undefined;
      const t = typeof v;
      if (t === 'function' || t === 'symbol') return undefined;
      if (t !== 'object') return v;
      if (seen.has(v) || d > maxDepth) return undefined;
      seen.add(v);
      if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < v.length && i < 500; i++) {
          const r = walk(v[i], d + 1);
          if (r !== undefined) out.push(r);
        }
        return out;
      }
      const out = {};
      for (const k of Object.keys(v)) {
        const r = walk(v[k], d + 1);
        if (r !== undefined) out[k] = r;
      }
      return out;
    };
    try { return walk(obj, 0); } catch { return undefined; }
  }
`;

async function grabPagePayload(page) {
  return page.evaluate((safeCloneSrc) => {
    const safeClone = eval(safeCloneSrc);

    const known = {};
    const globalNames = [
      'modDetailData',
      '__INIT_DATA__',
      '__INITIAL_STATE__',
      '__NEXT_DATA__',
      '__NUXT__',
      '__GLOBAL_DATA',
      '__PAGE_DATA__',
      'dataInitial',
      'detailData',
      'offerDetail',
      'iDetailData',
      '__DETAIL_DATA__',
      'pageData',
      '__RENDER_DATA__'
    ];
    for (const name of globalNames) {
      try {
        if (window[name] && typeof window[name] === 'object') known[name] = safeClone(window[name], 12) ?? null;
      } catch {
        /* getter 抛错则跳过 */
      }
    }

    // 新版详情页（OD 框架）把数据模型挂在 window.context 上，上面那张名字表里没有它，
    // 结果标题、规格、SKU 整段丢失。
    //
    // 挂载点随版本变化（实测是 context.result.data.Root.fields.dataJson），
    // 所以按「谁身上有 fields.dataJson」做广度搜索，别猜固定路径。
    try {
      const ctx = window.context;
      if (ctx && typeof ctx === 'object') {
        const queue = [{ node: ctx, depth: 0 }];
        const seen = new WeakSet();
        let dataJson = null;
        let steps = 0;
        while (queue.length && steps < 3000) {
          const cur = queue.shift();
          steps += 1;
          const node = cur.node;
          if (!node || typeof node !== 'object' || seen.has(node)) continue;
          seen.add(node);
          if (node.fields && node.fields.dataJson && typeof node.fields.dataJson === 'object') {
            dataJson = node.fields.dataJson;
            break;
          }
          if (cur.depth >= 8) continue;
          for (const key of Object.keys(node)) {
            const child = node[key];
            if (child && typeof child === 'object' && !Array.isArray(child)) {
              queue.push({ node: child, depth: cur.depth + 1 });
            }
          }
        }
        if (dataJson) known.__contextDataJson = safeClone(dataJson, 10) ?? null;
      }
    } catch {
      /* 取不到就靠接口拦截 */
    }

    const holders = [];
    document.querySelectorAll('[data-initial-data],[data-spm-anchor-id]').forEach((el) => {
      const value = el.getAttribute('data-initial-data');
      if (value && value.length > 100) holders.push(value);
    });

    const ld = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
      if (el.textContent && el.textContent.length > 20) ld.push(el.textContent);
    });

    // DOM 兜底：主图（按渲染尺寸过滤图标）
    const domImages = [];
    document.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src || '';
      if (!src || !/alicdn|alibaba|1688/i.test(src)) return;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 200 || h < 200) return;
      domImages.push(src);
    });

    // 商品属性：1688 是服务端直出 HTML，接口里没有，必须从 DOM 取
    const attrs = [];
    const pushAttr = (name, value) => {
      const n = (name || '').trim();
      const v = (value || '').trim();
      if (!n || !v || n.length > 30 || v.length > 200) return;
      if (attrs.some((a) => a.name === n)) return;
      attrs.push({ name: n, value: v });
    };

    document.querySelectorAll('.cpv-attr-item').forEach((item) => {
      pushAttr(
        item.querySelector('.cpv-attr-label')?.textContent,
        item.querySelector('.cpv-attr-value')?.textContent
      );
    });

    document.querySelectorAll('.ant-descriptions-row').forEach((row) => {
      const cells = [...row.querySelectorAll('th,td')];
      for (let i = 0; i + 1 < cells.length; i += 2) {
        if (cells[i].tagName !== 'TH') continue;
        pushAttr(cells[i].textContent, cells[i + 1].textContent);
      }
    });

    // 包装信息表（含每件重量，美客多物流必填）
    let domPackaging = null;
    for (const table of document.querySelectorAll('table')) {
      const head = table.querySelector('thead');
      if (!head || !/重量/.test(head.innerText || '')) continue;
      const headers = [...head.querySelectorAll('th')].map((th) => th.innerText.trim()).filter(Boolean);
      const rows = [...table.querySelectorAll('tbody tr')]
        .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()))
        .filter((row) => row.some(Boolean));
      if (headers.length && rows.length) {
        domPackaging = { headers, rows };
        break;
      }
    }

    // 店铺主页地址：页面里指向 *.1688.com 的店铺链接（排除 detail/s 等非店铺域名）
    let domShop = null;
    const IGNORE_HOSTS = new Set([
      'detail', 's', 'www', 'login', 'passport', 'air', 'h5api', 'cart', 'trade', 'work',
      'show', 'page', 'dj', 'cn', 'm', 'style', 'sale', 'p4p', 'vip', 'club', 'ai',
      'openapi', 'open', 'gw', 'act', 'sm', 'sycm', 'peixun', 'rule', 'help', 'service',
      'img', 'cbu01', 'g', 'i', 'log', 'w', 'ss', 'widget', 'xin', 'mx', 'amos'
    ]);
    for (const link of document.querySelectorAll('a[href*=".1688.com"]')) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/https?:\/\/([a-z0-9-]{3,40})\.1688\.com/i);
      if (!match) continue;
      const host = match[1].toLowerCase();
      if (IGNORE_HOSTS.has(host)) continue;
      const rawText = (link.innerText || '').replace(/\s+/g, ' ').trim();
      // 卡片文字常混着“关注 客服 商品 入驻9年 主营：…”这类噪声，只取公司名那段
      const cleanName = rawText.split(/关注|客服|商品|入驻|主营|实力|回头率/)[0].trim().slice(0, 30);
      domShop = {
        domain: `${host}.1688.com`,
        url: `https://${host}.1688.com`,
        name: cleanName || null
      };
      // 优先带“店/公司/企业”字样的链接
      if (/店|公司|企业|工厂/.test(rawText)) break;
    }

    // 详情长图：新版页面在 shadow DOM 里懒加载，需穿透并排除小图标与 800 方图主图
    const detailImages = [];
    const seenDetail = new Set();
    const collectDetail = (root, depth) => {
      if (!root || depth > 8) return;
      root.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('data-src') || img.currentSrc || img.src || '';
        if (!/alicdn|alibaba/i.test(src)) return;
        if (/-tps-/.test(src)) return;
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        if (w < 300) return;
        // 长图：明显竖长，或比主图更宽
        if (!(h > w * 1.2 || w > 800)) return;
        const key = src.split('?')[0];
        if (seenDetail.has(key)) return;
        seenDetail.add(key);
        detailImages.push(src);
      });
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) collectDetail(el.shadowRoot, depth + 1);
      });
    };
    collectDetail(document, 0);

    // 主图视频：首图区渲染成 <video>，getLiveInfoByOfferIdWap 只返回「讲解视频」，
    // 主图视频不在任何接口里，只能从 DOM 取。页面里是协议相对地址，补上 https。
    const domVideos = [];
    const seenVideo = new Set();
    const collectVideo = (root, depth) => {
      if (!root || depth > 8) return;
      root.querySelectorAll('video').forEach((node) => {
        const raw =
          node.getAttribute('src') ||
          node.currentSrc ||
          node.querySelector('source')?.getAttribute('src') ||
          '';
        const url = raw.startsWith('//') ? `https:${raw}` : raw;
        // blob:/data: 是 MSE 播放中的流，取不到原片
        if (!/^https?:\/\//i.test(url)) return;
        if (seenVideo.has(url)) return;
        seenVideo.add(url);
        const poster = node.getAttribute('poster') || '';
        domVideos.push({
          url,
          poster: poster ? (poster.startsWith('//') ? `https:${poster}` : poster) : null
        });
      });
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) collectVideo(el.shadowRoot, depth + 1);
      });
    };
    collectVideo(document, 0);

    const detailEl = document.querySelector(
      '#description, .desc-content, od-product-description, [class*="detail-content"]'
    );

    return {
      known,
      holders: holders.slice(0, 5),
      ld: ld.slice(0, 5),
      domImages: domImages.slice(0, 40),
      domAttributes: attrs,
      domPackaging,
      domShop,
      domDetailImages: detailImages.slice(0, 60),
      domDetailHtml: detailEl ? detailEl.innerHTML.slice(0, 200000) : '',
      domVideos: domVideos.slice(0, 5),
      finalUrl: location.href,
      documentTitle: document.title,
      bodyText: (document.body?.innerText ?? '').slice(0, 20000)
    };
  }, SAFE_CLONE_SRC);
}

/** 过滤出可能含商品数据的接口 JSON */
function isUsefulResponse(body) {
  if (!body || body.length < 400) return false;
  if (!/[\u4e00-\u9fa5]/.test(body)) return false;
  const hasImage = /alicdn\.com/i.test(body);
  const hasPrice = /"(price|priceRange|consignPrice|beginAmount)"/i.test(body);
  const hasTitle = /"(subject|title|offerTitle)"/i.test(body);
  return (hasImage && hasPrice) || (hasPrice && hasTitle) || hasImage;
}

export async function collectOffer(input, options = {}) {
  const { waitTimeoutMs = 25000, dumpRaw = true, imagesMax = 12, scrollForDetail = true } = options;

  let offerId = extractOfferId(input);
  const targetUrl = offerId ? `https://detail.1688.com/offer/${offerId}.html` : String(input).trim();
  if (!/^https?:\/\//i.test(targetUrl)) throw new Error('请输入 1688 商品链接或商品 ID');

  const { page } = await openWorkPage();
  const captures = [];
  let videoRaw = null;

  const onResponse = (response) => {
    try {
      const url = response.url();
      if (!/1688\.com|alicdn\.com|taobao\.com/i.test(url)) return;
      if (response.status() !== 200) return;

      // 讲解视频不走商品详情接口，单独一个 mtop 方法
      if (/getliveinfobyofferidwap/i.test(url)) {
        response
          .body()
          .then((buffer) => {
            videoRaw = buffer.toString('utf8');
          })
          .catch(() => {});
        return;
      }

      const type = (response.headers()['content-type'] ?? '').toLowerCase();
      if (!/json|javascript|text\/plain|text\/html/.test(type)) return;

      // 不要用 response.text()：1688 部分接口的 charset 声明是 GBK，
      // 实际载荷却是 UTF-8，按声明解码会把中文变成乱码。这里强制按 UTF-8 解。
      response
        .body()
        .then((buffer) => {
          if (captures.length >= 40) return;
          const body = buffer.toString('utf8');
          if (!isUsefulResponse(body)) return;
          captures.push({ url, body: body.slice(0, 8_000_000) });
        })
        .catch(() => {});
    } catch {
      /* 响应可能已释放 */
    }
  };

  page.on('response', onResponse);

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    if (!offerId) {
      const fromUrl = extractOfferId(page.url());
      if (fromUrl) offerId = fromUrl;
    }

    await page
      .waitForFunction(
        () => {
          if (window.modDetailData || window.__INIT_DATA__ || window.dataInitial || window.__INITIAL_STATE__) return true;
          return Boolean(document.querySelector('[data-initial-data]'));
        },
        { timeout: Math.min(waitTimeoutMs, 8000) }
      )
      .catch(() => {
        /* 新版页面可能永远不出现这些全局变量，靠接口拦截 */
      });

    // 等接口响应与懒加载图片落地
    await page.waitForTimeout(3500);
    await page.evaluate(() => window.scrollTo(0, 400)).catch(() => {});
    await page.waitForTimeout(1200);

    // 详情长图在页面底部懒加载，滚到底才会渲染
    if (scrollForDetail) {
      for (let i = 0; i < 8; i += 1) {
        await page.mouse.wheel(0, 2400).catch(() => {});
        await page.waitForTimeout(420);
      }
      await page.waitForTimeout(1600);
    }

    const payload = await grabPagePayload(page);
    payload.captures = captures.map((c) => ({ url: c.url, json: safeParse(c.body) })).filter((c) => c.json);
    payload.videoRaw = videoRaw;

    const finalUrl = payload.finalUrl || page.url();
    if (!offerId) {
      const fromFinal = extractOfferId(finalUrl);
      if (fromFinal) offerId = fromFinal;
      else {
        const fromDom = await page.evaluate(() => {
          const m = document.documentElement.innerHTML.match(/offer\/(\d{6,})/);
          return m ? m[1] : null;
        });
        offerId = fromDom;
      }
    }
    if (!offerId) throw new Error('无法从该链接识别 1688 商品 ID');

    const blocked = detectBlock({ url: finalUrl, bodyText: payload.bodyText });
    if (blocked) throw new Error(blocked);

    if (dumpRaw) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(RAW_DIR, `${offerId}-${stamp}.json`);
      const slim = { ...payload, captures: undefined };
      fs.writeFileSync(file, JSON.stringify({ input, finalUrl, ...slim, captures }, null, 2), 'utf8');
    }

    const product = normalizeProduct({
      offerId,
      url: `https://detail.1688.com/offer/${offerId}.html`,
      payload,
      pageText: payload.bodyText
    });

    if (product.images.length > imagesMax) product.images = product.images.slice(0, imagesMax);
    product.debug.captureCount = payload.captures.length;
    product.debug.captureUrls = payload.captures.map((c) => c.url).slice(0, 10);

    if (!product.title && payload.documentTitle) {
      product.title = payload.documentTitle.replace(/[-_]?\s*阿里巴巴.*$/, '').trim() || null;
    }

    return product;
  } finally {
    page.off('response', onResponse);
    await closeWorkPage(page);
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
