/**
 * 检查 1688 开放平台凭证是否就位（只读配置，不做网络请求）。
 *
 * 用法：node scripts/ali-check.mjs
 */

import { loadConfig } from '../server/config.mjs';

const { ali1688 } = loadConfig().platforms ?? {};

const mask = (value) => {
  if (!value) return '(未填)';
  const text = String(value);
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
};

const rows = [
  ['AppKey', ali1688?.appKey],
  ['AppSecret', ali1688?.appSecret],
  ['AccessToken', ali1688?.accessToken],
  ['授权用户ID', ali1688?.userId]
];

console.log('1688 开放平台凭证检查（config/settings.json → platforms.ali1688）\n');
for (const [label, value] of rows) {
  console.log(`  ${label.padEnd(12)} ${mask(value)}`);
}

const missing = rows.filter(([, value]) => !value).map(([label]) => label);
if (missing.length) {
  console.log(`\n缺少：${missing.join('、')}`);
  console.log('在开放平台「授权配置」生成 accessToken 后填入配置文件即可。');
} else {
  console.log('\n凭证齐全，可以开始接 API 了。');
}
