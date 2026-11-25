/**
 * 登录态快照：把已登录 Chrome 里的 1688 会话导出成一份 JSON，可以在别的机器/便携包里套回去。
 *
 * 为什么需要它：
 *   浏览器 profile 目录（data/chrome-profile）虽然能持久化登录，但它是几十个二进制文件的集合，
 *   非正常退出、并发启动、换电脑、重新解压便携包都会让它失效或干脆不存在。
 *   快照把「会话」抽成一个可复制、可备份、可随包分发的小文件。
 *
 * 为什么不能指望它万能：
 *   快照 = cookie + localStorage。它不含设备指纹、不含 IP。
 *   所以「原机恢复」几乎必成；「换机器/换网络」要看 1688 侧的风控心情，可能仍要重新登录。
 *   这不是本模块的缺陷，是 cookie 方案的边界。
 *
 * 安全：快照等同于账号密码，别传群、别入库、别提交到 git。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AUTH_DIR } from './config.mjs';
import { connectBrowser } from './chrome.mjs';

export const SNAPSHOT_FILE = path.join(AUTH_DIR, '1688.state.json');

const FORMAT = 'listing-desk-auth';
const VERSION = 1;

/** 算「1688 登录态」的域，含 taobao/tmall（1688 登录走阿里统一账号） */
const SESSION_DOMAINS = ['1688.com', 'taobao.com', 'tmall.com'];

/**
 * 过滤 cookie 时保留的域：本工具要跑的四件事都得有登录态，默认一起带上
 *   1688/淘宝（采集）· 拼多多（填表）· 抖店（填表）
 */
const KEEP_DOMAINS = [
  ...SESSION_DOMAINS,
  'alicdn.com',
  'alibaba.com',
  'pinduoduo.com',
  'yangkeduo.com',
  'jinritemai.com',
  'douyin.com',
  'bytedance.com'
];

/** 出现任意一个就认为有登录态 */
const LOGIN_COOKIES = /^(__cn_logon_id__|cookie2|_m_h5_tk|__cn_logon__|_tb_token_)$/;

function hostMatches(host, domains) {
  const h = String(host ?? '').replace(/^\./, '').toLowerCase();
  if (!h) return false;
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** 一组 cookie 里是否含登录凭据 */
export function hasLoginCookie(cookies = []) {
  return (cookies ?? []).some(
    (c) => c?.value && hostMatches(c.domain, SESSION_DOMAINS) && LOGIN_COOKIES.test(String(c.name))
  );
}

/** 只保留可移植字段，丢掉 partitionKey 这类浏览器内部结构 */
function slimCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: typeof c.expires === 'number' ? c.expires : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: c.sameSite || 'Lax'
  };
}

function isAlive(c) {
  if (c.expires === -1 || c.expires === undefined || c.expires === null) return true;
  return Number(c.expires) * 1000 > Date.now();
}

async function contextOf() {
  const browser = await connectBrowser();
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chrome 里没有可用的标签页上下文，请先点「打开 Chrome 登录 1688」');
  return context;
}

/** 读当前浏览器里的 cookie（连不上就返回空数组，供状态检查降级用） */
export async function currentCookies(domain) {
  try {
    const context = await contextOf();
    return await context.cookies(domain ? `https://${domain}` : undefined);
  } catch {
    return [];
  }
}

/* ---------- 加密（发送给同事时不至于明文裸奔） ---------- */

function seal(payload, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: FORMAT,
    version: VERSION,
    encrypted: true,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

function unseal(raw, pass) {
  const key = crypto.scryptSync(pass, Buffer.from(raw.salt, 'base64'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
  try {
    const text = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(text);
  } catch {
    throw new Error('解密失败：密码不对，或文件被改过');
  }
}

/* ---------- 导出 / 导入 ---------- */

/**
 * 把当前浏览器的 1688 会话写成快照文件。
 * @param {{file?:string, pass?:string, allDomains?:boolean}} opts
 */
export async function exportSnapshot({ file = SNAPSHOT_FILE, pass = '', allDomains = false } = {}) {
  const context = await contextOf();
  const cookies = await context.cookies();
  const keep = allDomains ? cookies : cookies.filter((c) => hostMatches(c.domain, KEEP_DOMAINS));
  const alive = keep.filter(isAlive);

  if (!hasLoginCookie(alive)) {
    throw new Error('当前 Chrome 里没有 1688 登录态，请先在弹出的窗口里登录后再备份');
  }

  // localStorage 只在有页面时才读得到，拿不到也不影响 cookie 恢复
  let origins = [];
  try {
    const st = await context.storageState();
    origins = (st.origins ?? [])
      .filter((o) => {
        try {
          return allDomains || hostMatches(new URL(o.origin).hostname, KEEP_DOMAINS);
        } catch {
          return false;
        }
      })
      .slice(0, 20);
  } catch {
    /* CDP 上下文偶发不支持，忽略 */
  }

  const payload = {
    format: FORMAT,
    version: VERSION,
    platform: '1688',
    exportedAt: new Date().toISOString(),
    cookieCount: alive.length,
    cookies: alive.map(slimCookie),
    origins
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(pass ? seal(payload, pass) : payload, null, 2)}\n`, 'utf8');

  return {
    file,
    cookieCount: payload.cookieCount,
    originCount: origins.length,
    encrypted: Boolean(pass),
    bytes: fs.statSync(file).size,
    exportedAt: payload.exportedAt
  };
}

/** 读快照（需要时解密），返回原始 payload */
export function readSnapshot({ file = SNAPSHOT_FILE, pass = '' } = {}) {
  if (!fs.existsSync(file)) throw new Error(`快照文件不存在：${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`快照文件解析失败：${err.message}`);
  }
  if (raw?.format !== FORMAT) throw new Error('这不是本工具的登录态快照文件');
  if (raw.encrypted) {
    if (!pass) throw new Error('该快照已加密，需要输入导出时设置的密码');
    return unseal(raw, pass);
  }
  return raw;
}

/** 把快照套回当前浏览器 */
export async function importSnapshot({ file = SNAPSHOT_FILE, pass = '', applyLocalStorage = true } = {}) {
  const payload = readSnapshot({ file, pass });
  const cookies = (payload.cookies ?? []).filter(isAlive);
  if (!cookies.length) throw new Error('快照里没有可用的 cookie（可能已全部过期），请重新登录后再备份');

  const context = await contextOf();
  let added = 0;
  try {
    await context.addCookies(cookies);
    added = cookies.length;
  } catch {
    // 某些字段 CDP 侧不认，退回最小集合再试一次
    const simple = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      expires: typeof c.expires === 'number' ? c.expires : -1
    }));
    await context.addCookies(simple);
    added = simple.length;
  }

  let restoredOrigins = 0;
  if (applyLocalStorage) {
    for (const origin of payload.origins ?? []) {
      const items = origin?.localStorage ?? [];
      if (!items.length) continue;
      const page = await context.newPage();
      try {
        await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.evaluate((list) => {
          for (const kv of list) {
            try {
              localStorage.setItem(kv.name, kv.value);
            } catch {
              /* 忽略单条写入失败 */
            }
          }
        }, items);
        restoredOrigins += 1;
      } catch {
        /* 单个域失败不影响整体 */
      } finally {
        await page.close().catch(() => {});
      }
    }
  }

  return {
    file,
    cookieCount: added,
    originCount: restoredOrigins,
    exportedAt: payload.exportedAt ?? null
  };
}

/* ---------- 状态 ---------- */

/** 快照文件本身的元信息（不解密、不连浏览器） */
export function snapshotInfo({ file = SNAPSHOT_FILE } = {}) {
  if (!fs.existsSync(file)) return { exists: false, file };
  const stat = fs.statSync(file);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      exists: true,
      valid: raw?.format === FORMAT,
      file,
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      encrypted: Boolean(raw?.encrypted),
      exportedAt: raw?.encrypted ? null : (raw?.exportedAt ?? null),
      cookieCount: raw?.encrypted ? null : (raw?.cookies?.length ?? 0),
      platform: raw?.platform ?? null
    };
  } catch (err) {
    return { exists: true, valid: false, file, bytes: stat.size, error: err.message };
  }
}

/**
 * 真实探测登录是否还有效。
 * 只认 cookie 名字会误判（_m_h5_tk 未登录时也可能存在），所以打开购物车页看是否被踢到登录页。
 */
export async function probeLogin({ timeoutMs = 25000 } = {}) {
  const context = await contextOf();
  const page = await context.newPage();
  try {
    const res = await page
      .goto('https://cart.1688.com/cart.htm', { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      .catch(() => null);
    const finalUrl = page.url();
    const text = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 3000)).catch(() => '');

    const redirected = /login\.(1688|taobao)\.com|passport\.1688\.com/i.test(finalUrl);
    const loginWall = /请登录|登录后查看|亲，请登录|账号登录|扫码登录/.test(text);
    return {
      loggedIn: !redirected && !loginWall,
      finalUrl,
      status: res?.status() ?? null,
      reason: redirected ? '被重定向到登录页' : loginWall ? '页面提示需要登录' : null
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/* ---------- 自动行为 ---------- */

/**
 * 新 profile（比如同事刚解压便携包）自动套用随包附带的快照。
 * 只有当前确实没登录、且快照存在时才动手，绝不覆盖正在使用的会话。
 */
export async function maybeRestore({ file = SNAPSHOT_FILE, pass = '' } = {}) {
  const info = snapshotInfo({ file });
  if (!info.exists) return { restored: false, reason: 'NO_SNAPSHOT' };
  if (info.valid === false) return { restored: false, reason: 'BAD_SNAPSHOT', message: info.error };
  if (info.encrypted && !pass) return { restored: false, reason: 'NEEDS_PASSWORD' };

  const cookies = await currentCookies();
  if (hasLoginCookie(cookies)) return { restored: false, reason: 'ALREADY_LOGGED_IN' };

  try {
    return { restored: true, ...(await importSnapshot({ file, pass })) };
  } catch (err) {
    return { restored: false, reason: 'IMPORT_FAILED', message: err.message };
  }
}

let lastBackupAt = 0;

/**
 * 已登录就顺手刷新快照，让「备份」这件事不需要用户记得做。
 * 节流：默认 10 分钟最多写一次盘。
 */
export async function backupIfLoggedIn({ file = SNAPSHOT_FILE, minIntervalMs = 10 * 60 * 1000, pass = '' } = {}) {
  if (Date.now() - lastBackupAt < minIntervalMs) return { skipped: true, reason: 'THROTTLED' };

  // 已有加密快照时不拿明文盖掉它
  const info = snapshotInfo({ file });
  if (info.encrypted && !pass) return { skipped: true, reason: 'ENCRYPTED_EXISTING' };

  try {
    const cookies = await currentCookies();
    if (!hasLoginCookie(cookies)) return { skipped: true, reason: 'NOT_LOGGED_IN' };
    const result = await exportSnapshot({ file, pass });
    lastBackupAt = Date.now();
    return { skipped: false, ...result };
  } catch (err) {
    return { skipped: true, reason: 'ERROR', message: err.message };
  }
}
