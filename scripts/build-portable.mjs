/**
 * 生成「双击即用」的绿色便携包，给非程序员同事使用。
 *
 * 产物：dist/listing-desk/
 *   启动.bat        双击运行（会自动打开浏览器）
 *   使用说明.txt    给同事看的说明
 *   node.exe        便携 Node 运行时（从本机复制，不需要对方安装）
 *   server/ public/ config/
 *   node_modules/   仅运行期依赖（express / playwright-core）
 *   data/           首次运行自动生成
 *
 * 用法：node scripts/build-portable.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'listing-desk');

function log(msg) {
  console.log(`  ${msg}`);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (!filter(entry.name)) continue;
    if (entry.isDirectory()) copyDir(src, dest, filter);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

const BAT = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
title listing-desk
set LISTING_DESK_OPEN=1
echo.
echo   ==========================================
echo      listing-desk 正在启动，请稍候...
echo      启动后会自动打开浏览器
echo      关闭本窗口即停止工具
echo   ==========================================
echo.
"%~dp0node.exe" --experimental-sqlite server\\index.mjs
if errorlevel 1 (
  echo.
  echo   启动失败，请把上面的报错截图发给技术同事。
  pause
)
`;

const README_TXT = `listing-desk 使用说明
================================================================

一、首次使用（只做一次）
1. 双击「启动.bat」，稍等几秒，浏览器会自动打开一个页面。
2. 页面右上角点「打开 Chrome 登录 1688」，会弹出一个新的 Chrome 窗口。
3. 在这个窗口里登录 1688；再开一个标签页，登录拼多多商家后台（mms.pinduoduo.com）。
4. 登录一次就会记住，以后不用再登。这个 Chrome 窗口不要关。

二、日常使用
1. 双击「启动.bat」，浏览器自动打开页面。
2. 在文本框里粘贴 1688 商品链接（一行一个），点「开始采集」。
3. 采集完成后，在右侧结果里选一条，设置「加价」，点「拼多多填表」。
4. 工具会把标题、图片、规格、价格、详情填进拼多多，停在提交前。
5. 你自己核对，补品牌等必填项，然后点「提交并上架」。

   工具永远不会替你点提交。

三、关闭
直接关掉那个黑色的命令行窗口即可。

四、数据在哪
程序目录下的 data 文件夹：
  data/media/    商品图片
  data/listing.db  采集记录
删掉 data 就相当于清空所有记录（图片也会没）。

五、常见问题
- 提示「Chrome 未就绪」：先点页面上的「打开 Chrome 登录 1688」，或检查是不是把之前的 Chrome 窗口关了。
- 采集报「登录失效」：在那个 Chrome 窗口里重新登录 1688。
- 出现滑块验证：在 Chrome 窗口里手动拖一下，然后重试。
- 端口被占用：程序会自动换端口，看命令行窗口里提示的地址即可。
- 提示「主图尺寸不对」：说明 1688 那张图太小，工具已自动跳过；若仍报错，把截图发给技术同事。

六、注意
本工具需要电脑上装有 Chrome（或 Edge）。没有的话先装一个。
`;

function writeFile(file, content) {
  fs.writeFileSync(file, content, 'utf8');
}

async function main() {
  log(`输出目录：${OUT}`);
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // 1. 业务代码
  for (const dir of ['server', 'public']) {
    copyDir(path.join(ROOT, dir), path.join(OUT, dir));
    log(`复制 ${dir}/`);
  }

  // 2. 配置：词表照发；settings.json 用默认值，避免把本机加价/汇率带出去
  fs.mkdirSync(path.join(OUT, 'config'), { recursive: true });
  const dict = path.join(ROOT, 'config', 'translate.zh-es.json');
  if (fs.existsSync(dict)) fs.copyFileSync(dict, path.join(OUT, 'config', 'translate.zh-es.json'));

  const { DEFAULTS } = await import('../server/config.mjs');
  writeFile(path.join(OUT, 'config', 'settings.json'), JSON.stringify(DEFAULTS, null, 2));
  log('写入默认配置（不含本机加价设置）');

  // 3. Node 运行时
  const nodeExe = process.execPath;
  fs.copyFileSync(nodeExe, path.join(OUT, 'node.exe'));
  log(`复制 node.exe（${(fs.statSync(nodeExe).size / 1024 / 1024).toFixed(0)}MB）`);

  // 4. 运行期依赖：只装 express + playwright-core
  writeFile(
    path.join(OUT, 'package.json'),
    JSON.stringify(
      {
        name: 'listing-desk',
        version: '0.1.0',
        private: true,
        type: 'module',
        engines: { node: '>=20' },
        dependencies: { express: '^4.21.2', 'playwright-core': '^1.49.1' }
      },
      null,
      2
    )
  );

  try {
    log('安装运行期依赖（express / playwright-core）…');
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: OUT,
      stdio: 'inherit',
      shell: true
    });
  } catch (err) {
    console.warn('  npm 安装失败，回退为复制本机 node_modules');
    copyDir(
      path.join(ROOT, 'node_modules'),
      path.join(OUT, 'node_modules'),
      (name) => !['better-sqlite3', 'docx', 'exceljs', '.bin', '.cache'].includes(name)
    );
  }

  // 5. 启动脚本与说明
  writeFile(path.join(OUT, '启动.bat'), BAT);
  writeFile(path.join(OUT, '使用说明.txt'), README_TXT);
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

  const total = (function size(dir) {
    let sum = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      sum += entry.isDirectory() ? size(p) : fs.statSync(p).size;
    }
    return sum;
  })(OUT);

  log('');
  log(`完成：${OUT}`);
  log(`体积：${(total / 1024 / 1024).toFixed(0)} MB`);
  log('把整个 listing-desk 文件夹压缩成 zip 发给同事即可。');
}

main().catch((err) => {
  console.error('打包失败：', err);
  process.exit(1);
});
