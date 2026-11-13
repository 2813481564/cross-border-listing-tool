import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PROFILE_DIR, loadConfig } from './config.mjs';

const WIN_CANDIDATES = [
  '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe',
  '%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

function expand(p) {
  return p.replace(/%([^%]+)%/g, (_, key) => process.env[key] ?? '');
}

export function findChrome() {
  const { chrome } = loadConfig();
  const explicit = [chrome.exePath, process.env.CHROME_PATH].filter(Boolean);
  const platformDefaults =
    process.platform === 'win32'
      ? WIN_CANDIDATES
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

  for (const candidate of [...explicit, ...platformDefaults]) {
    const resolved = expand(candidate);
    if (resolved && fs.existsSync(resolved)) return resolved;
  }
  throw new Error('未找到 Chrome/Edge，请在 config/settings.json 的 chrome.exePath 中指定可执行文件路径');
}

async function endpointAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureChrome({ force = false } = {}) {
  const { chrome } = loadConfig();
  const port = chrome.debugPort;
  if (!force && (await endpointAlive(port))) {
    return { port, started: false };
  }

  const exe = findChrome();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    '--window-size=1440,960'
  ];

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await endpointAlive(port)) return { port, started: true, exe };
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Chrome 调试端口 ${port} 未就绪，请检查是否已有同 profile 的浏览器实例在运行`);
}

let cached = null;

export async function connectBrowser() {
  if (cached) return cached;
  const { port } = await ensureChrome();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser.on('disconnected', () => {
    cached = null;
  });
  cached = browser;
  return browser;
}

/**
 * 在已登录的浏览器里开一个工作标签页。调用方负责关闭 page。
 * 注意：不要调用 browser.close()，那会关掉用户正在使用的浏览器。
 */
export async function openWorkPage() {
  const browser = await connectBrowser();
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  return { browser, context, page };
}

export async function getCookiesFor(domain) {
  const browser = await connectBrowser();
  const context = browser.contexts()[0];
  if (!context) return [];
  return context.cookies(domain ? `https://${domain}` : undefined);
}

export async function closeWorkPage(page) {
  try {
    if (page && !page.isClosed()) await page.close();
  } catch {
    /* 忽略关闭异常 */
  }
}

export function profilePath() {
  return path.resolve(PROFILE_DIR);
}
