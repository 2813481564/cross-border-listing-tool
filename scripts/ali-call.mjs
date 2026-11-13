/**
 * 直接调用 1688 开放平台接口（本地签名，不依赖在线测试工具）。
 *
 * 用法：
 *   node scripts/ali-call.mjs alibaba.member.getRelationUserInfo --param domain=shopxxx.1688.com
 *   node scripts/ali-call.mjs alibaba.product.simple.get --param productID=807019187300 --param webSite=1688
 *   node scripts/ali-call.mjs alibaba.product.simple.get --param productID=xxx --print-url
 *
 * 凭证取自 config/settings.json → platforms.ali1688
 */

import { loadConfig } from '../server/config.mjs';
import { callAliApi } from '../server/platforms/ali1688/client.mjs';

const argv = process.argv.slice(2);
const apiName = argv[0];
if (!apiName) {
  console.error('用法：node scripts/ali-call.mjs <apiName> [--param k=v ...] [--print-url]');
  process.exit(1);
}

const params = {};
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i] === '--param') {
    const pair = argv[i + 1] ?? '';
    const idx = pair.indexOf('=');
    if (idx > 0) params[pair.slice(0, idx)] = pair.slice(idx + 1);
    i += 1;
  }
}

const printUrl = argv.includes('--print-url');
const { ali1688 } = loadConfig().platforms ?? {};

if (!ali1688?.appKey || !ali1688?.appSecret || !ali1688?.accessToken) {
  console.error('凭证不全：请在 config/settings.json 的 platforms.ali1688 填写 appKey / appSecret / accessToken');
  console.error('当前：', {
    appKey: ali1688?.appKey ? '已填' : '缺',
    appSecret: ali1688?.appSecret ? '已填' : '缺',
    accessToken: ali1688?.accessToken ? '已填' : '缺'
  });
  process.exit(1);
}

console.log(`API: ${apiName}`);
console.log(`参数: ${JSON.stringify(params)}`);

try {
  const payload = await callAliApi(apiName, params, ali1688, { timeoutMs: 25000 });
  if (printUrl) console.log('（签名与请求已发出）');
  console.log(JSON.stringify(payload, null, 2));
} catch (err) {
  console.error(`失败：${err.message}`);
  if (err.requestId) console.error(`RequestId: ${err.requestId}`);
  if (err.raw) console.error(`原始返回：${JSON.stringify(err.raw).slice(0, 800)}`);
  process.exitCode = 1;
}
