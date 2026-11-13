# listing-desk

> 粘贴 1688 链接 → 采集商品与图片 → 生成美客多草稿 → 半自动填拼多多表单。

本地刊登工作台：粘贴 1688 商品链接 → 采集商品数据 → 生成 MercadoLibre（美客多）刊登草稿。

1688 的商品页数据需要真实登录态和完整浏览器指纹才能拿到，纯 HTTP 请求会被风控拦。本工具因此不模拟登录，而是连接你自己本机的 Chrome（独立 profile），复用你已经登录的会话读取页面内嵌 JSON，再把结构化数据转成刊登草稿。

**采集留在本地，数据留在本地。** 没有云端服务、没有账号体系，除了 1688 / 拼多多自身页面与开放平台外不触达第三方接口。

## 配置从哪来

`config/settings.json` 不入库。首次 `npm start` 会按 `server/config.mjs` 里的默认值自动生成；也可以复制 `config/settings.example.json` 再填自己的密钥：

- `platforms.ali1688`：1688 开放平台凭证（走 API 通道时才需要，纯浏览器采集可留空）
- `remote.token`：采集端推送线上服务器时的共享令牌

## 它怎么工作

1688 商品页的数据需要登录态和完整浏览器指纹才能拿到，纯 HTTP 请求会被风控拦截。因此本工具：

1. 用你本机的 Chrome 启动一个**独立 profile**（`data/chrome-profile`）并开启调试端口
2. 你在这个窗口里登录 1688，登录态会持久保存
3. 采集时通过 CDP 连接该浏览器，打开商品页，直接读取页面内嵌的 JSON（`modDetailData` / `__INIT_DATA__` / `data-initial-data` 等）
4. 用启发式规则从这些 JSON 中抽取标题、价格、图片、SKU、属性、描述
5. 按配置换算价格、翻译并截断标题、映射属性，产出美客多刊登草稿

## 启动

```bash
npm install          # 首次
npm start            # 打开 http://localhost:5173
```

首次使用：

1. 点右上角「打开 Chrome 登录 1688」（或在命令行跑 `npm run chrome`）
2. 在弹出的 Chrome 窗口里登录 1688
3. 回到网页，左上角状态变成「Chrome 已就绪」

## 两种运行形态

**单机模式**（默认）：采集、存储、界面都在一台机器上，适合自己用。

**采集端 + 线上服务器**：采集留本地，数据和发布放服务器，适合多人协作。

```
本地电脑                          线上服务器
├─ Chrome + 1688 登录态            ├─ 数据库（唯一持有者）
├─ 采集 + 图片下载                  ├─ 网页界面（同事访问）
└─ 采集后推送 ──────────────────→  ├─ 一键发布（调平台 API）
                                   └─ 订单模块
```

为什么采集必须留在本地：1688 的采集依赖真实浏览器的登录态和指纹，服务器上跑无头 Chrome 会被风控拦。

**为什么不直连线上数据库**：那需要在公网暴露数据库端口，是把整个系统的家底敞开；网络抖动还会让本地写入卡死。正确做法是服务器独占数据库，本地通过 HTTP 推送数据。

推送在 `config/settings.json` 里配置：

```json
"remote": {
  "enabled": true,
  "baseUrl": "https://lcwllt.com/listing-desk",
  "token": "两端保持一致的随机字符串"
}
```

服务器端同一个 `token` 负责鉴权（`POST /api/ingest` 校验 `Authorization: Bearer <token>`）。

```bash
node --experimental-sqlite server/cli.mjs push [offerId]   # 手动重推，补齐失败的
```

推送只传结构化数据，图片由服务器自己按 URL 下载，不占用推送带宽。

## 存储

数据全部在本地，不依赖任何数据库服务：

| 位置 | 内容 |
| --- | --- |
| `data/listing.db` | SQLite 数据库，两张表：`products`（商品与草稿 JSON）、`assets`（媒体清单） |
| `data/media/{offerId}/{kind}/` | 图片与视频的本地副本，`kind` 为 `main` / `sku` / `detail` / `video` |
| `data/raw/` | 采集时的原始页面与接口存档，解析异常时用于排查 |
| `data/chrome-profile/` | 专用浏览器登录态 |

SQLite 用 Node 内置的 `node:sqlite`（需要 `--experimental-sqlite`，`npm start` 已带上），不用编译原生模块。

### 媒体双地址

每条媒体在 `assets` 表里同时存两个地址：

- `remote_url`：1688 的原始地址，永远保留
- `local_path` / 本地访问 URL（形如 `/media/{offerId}/main/01.jpg`）：下载成功后才有

采集时主图/规格图/详情图同步下载，视频放后台。下载失败的条目状态为 `failed`，
网页上会显示「失败」徽标和一个「下载」按钮，点一下即可重试；
也可以点分组标题旁的「全部补下载」，或命令行 `npm run ... retry-media`。

本地副本的意义：1688 的图片 CDN 会过期或失效，买家端拉不到；美客多要求图片可公网访问，
所以刊登前要先把本地文件传到自己的图床/对象存储。

## 用法

在文本框里每行粘一个 1688 商品链接（支持 `detail.1688.com/offer/xxx.html`、移动端链接，或直接粘贴商品 ID），点「开始采集」。

每条结果给出：

- 采集到的商品信息（标题、成本价、SKU、属性、包装重量、描述）
- **图片按类型分组**：展示主图 / 规格图（每个颜色款式各自的图）/ 详情长图
- **讲解视频**：来自 `getLiveInfoByOfferIdWap` 接口的 mp4 地址
- 生成的美客多草稿（西语标题、目标币种价格、变体、图片、属性映射）
- 检查提示（标题过长被截断、图片不足、缺重量、属性未映射等）

草稿结构里，`pictures` 只放展示主图，`variations[].picture_url` 是该规格自己的图，
`detail_images` 是详情长图，`videos` 是视频地址。

支持复制草稿 JSON / 标题 / 图片链接，历史记录可导出 CSV。

## 采集通道：API 与浏览器

采集有两条通道，输出同一套产品结构，下游（媒体下载 / 草稿 / 拼多多填表）不区分来源。

| 通道 | 特点 | 适用 |
| --- | --- | --- |
| `api` | 1688 开放平台接口，结构化、稳定、不触发风控 | 你在 1688 **已购买过**的商家的商品 |
| `browser` | CDP 连本机 Chrome，读页面内嵌 JSON | 任意商品（含陌生商家） |

配置 `collect.mode`：

```json
"collect": { "mode": "auto" }   // api | browser | auto
```

- `api`：只用接口，失败直接报错
- `browser`：只用浏览器（原半自动通道，行为不变）
- `auto`（默认）：凭证齐全且商品属于已购买商家 → 接口；遇到 `NO_PERMISSION` 或接口异常 → **自动回落浏览器**，并在产品的 `apiFallback` 里记下原因

命令行临时指定：

```bash
npm run collect -- <链接或ID> --api        # 强制接口
npm run collect -- <链接或ID> --browser    # 强制浏览器
```

前置条件（缺一不可）：开放平台应用 → 订购解决方案 → 获取能力并**关联应用** → 授权配置生成 accessToken，然后填进 `platforms.ali1688`。

接口通道的几个已知差异：

- 图片是相对路径，会自动补 `https://cbu01.alicdn.com/`
- **没有包装重量**，按 1688 类目默认值兜底：
  ```json
  "weightByCategory": { "122534002": 800 },
  "defaultWeightG": 500
  ```
- 独有 `category: { id, name }` 与 `meta`（状态/更新时间/起止时间），后续做定时回访与类目映射要用
- 提示：接口不做详情页截图，详情长图直接从 HTML 里取，顺序与页面一致

调试工具：

```bash
node scripts/ali-check.mjs                                   # 检查凭证是否填齐（脱敏显示）
node scripts/ali-call.mjs alibaba.member.getRelationUserInfo --param domain=shopxxx.1688.com
node scripts/ali-call.mjs alibaba.product.simple.get --param productID=807019187300 --param webSite=1688
```

## 拼多多半自动填表上架

把已采集的商品填进拼多多商家后台的发布表单，**只填不提交**。

前提：先用 `npm run chrome` 打开独立 Chrome，并在窗口里登录拼多多商家后台（登录态与 1688 共用同一个 profile）。

用法：

- 网页：选中一条结果，在「加价」框里选 **倍数** 或 **加价(元)** 并填数值，再点「拼多多填表」。数值会记住，下次沿用。
- 命令行：`npm run pdd-fill -- <offerId>`，用 `--markup 1.5` 或 `--add 6` 覆盖加价。

流程：

1. 打开 `/goods/category`，填商品标题、上传本地主图（最多 `imageMax` 张）
2. 点「下一步」进入完善信息页，平台会按标题/图片智能推荐类目
3. 点「一键复用」把平台匹配到的商品属性填上
4. **多规格**：把 1688 的规格维度映射成拼多多规格类型（最多 2 个），逐个写入规格值，SKU 表按组合自动展开
5. 按「价格及库存」表头定位，逐行填库存 / 拼单价 / 单买价 / 规格编码 / 商品编码，并给每行传预览图
6. 填商品参考价（会取所有 SKU 里最高单买价来抬高）
7. **停在待提交页面**，由你核对后自己点「提交并上架」

自动填的：标题、轮播图、商品属性（复用平台匹配值）、规格类型与规格值、每个 SKU 的库存/拼单价/单买价/预览图/规格编码、商品编码、商品参考价、商品详情长图（采集到时）。
需人工的：类目确认、品牌、商品资质、包装标签图、运费模板与发货时效、**提交**。

> 商品详情走「快捷编辑」区，把采集到的详情长图一次性塞进去；商品本身没有长图时会在结果里提示需手动。

### 多规格怎么映射

| 1688 规格名 | 拼多多规格类型 |
| --- | --- |
| 颜色 / 色彩 / 色系 / 色号 | 颜色 |
| 尺码 / 码数 | 尺码 |
| 尺寸 / 规格 / 长度 / 宽度 / 高度 / 厚度 | 尺寸（值看起来不像尺寸时改判为「款式」） |
| 款式 / 型号 / 风格 | 款式 |
| 材质 / 面料 / 成分 | 材质 |
| 容量 / 毫升 / 净含量 | 容量 |

规则细节：

- 最多取 2 个维度，第三个及以后的维度会提示「未使用」
- 规格值会去掉 `【适用大三人位】` 这类括号话术，并截到 20 字
- 组合数超过 `maxSkus`（默认 100）时，从最后一个维度往前截断，而不是整体放弃
- SKU 预览图按「属性名 + 规格值」精确匹配 1688 规格图；**1688 没有配图就留空**（不拿主图充数），结果里会点名是哪几个 SKU
- 规格值原样搬运，不删 `【】`/`()` 后缀，上限 40 字；被 SKU 上限截断时会列出丢弃的值名
- 库存直接沿用 1688 各 SKU 的真实库存
- 想先看映射对不对，用 `npm run pdd-fill -- <offerId> --dry-run`，只打印不碰浏览器

价格规则（`config/settings.json` 的 `platforms.pdd.publish`）：

| 字段 | 说明 |
| --- | --- |
| `priceMode` | 加价方式：`markup`（成本×倍数，默认）或 `add`（成本+固定金额） |
| `markup` | 拼单价 = 成本价 × markup，默认 1.35 |
| `addAmount` | `priceMode=add` 时的加价金额（元），默认 0 |
| `singleRatio` | 单买价 = 成本价 × markup × singleRatio，且不低于拼单价+1 |
| `refRatio` | 商品参考价 = 单买价 × refRatio，且须大于最大单买价 |
| `priceEnding` | 价格尾数，默认 `.9` |
| `stock` | 默认库存，默认 999 |
| `imageMax` | 上传轮播图上限，默认 10（平台上限 10） |
| `imageMinSide` | 轮播图最小边长，默认 480（平台要求 >480px，不达标自动跳过） |
| `imageMaxBytes` | 轮播图单张体积上限，默认 3MB |
| `titleMaxLength` | 标题上限，默认 30 个汉字 |
| `autoAttributes` | 是否点「一键复用」，默认 `true` |
| `codePrefix` | 商品编码前缀，留空则不填 |
| `multiSpec` | 是否自动加规格，默认 `true`；`false` 退回单规格 |
| `maxSpecTypes` | 最多几个规格类型，默认 2（平台上限 2） |
| `maxSkus` | SKU 组合上限，默认 100，超出按维度截断 |
| `useSkuPrice` | 每个 SKU 用各自 1688 价换算，默认 `false`（统一用主商品价） |
| `previewFallbackMain` | 1688 没有规格图时是否用主图兜底，默认 **`false`**（留空，由你手动补） |
| `uploadDetail` | 是否把详情长图传进「商品详情」，默认 `true` |
| `detailImageMax` | 详情长图最多传几张，默认 20（平台上限 50） |

命令行临时覆盖（不改配置）：

```bash
npm run pdd-fill -- <offerId> --dry-run        # 只看规格与价格映射
npm run pdd-fill -- <offerId> --max-skus 20    # 临时限制 SKU 数
npm run pdd-fill -- <offerId> --use-sku-price  # 按各 SKU 价定价
npm run pdd-fill -- <offerId> --no-spec        # 退回单规格
npm run pdd-fill -- <offerId> --markup 1.5     # 成本 × 1.5
npm run pdd-fill -- <offerId> --add 6          # 成本 + 6 元
npm run pdd-fill -- <offerId> --mode markup    # 指定加价方式
```

排查工具（平台改版后用来重新定位字段，全部只读）：

```bash
npm run inspect                                # 抓当前标签页的表单结构，输出 data/probe/*-report.md
node scripts/inspect-page.mjs --match goods_add --list
node scripts/find-links.mjs 发布                # 按文字找入口，打印 href
node scripts/image-audit.mjs <offerId> main    # 检查本地主图像素/比例是否满足平台要求
node scripts/open-page.mjs <url>               # 在调试浏览器里打开/聚焦页面
```

已知限制：

- 属性来自「一键复用」的相似品匹配，需要你核对是否属实；没匹配到时不会猜
- 规格名映射是启发式：拼多多 30 多种规格类型只覆盖了常见的十来种，映射不到会提示手动
- 未处理商品详情长图、白底图/包装标签图
- 平台季度改版可能失效，症状是「填了但没进去」，用上面的探针重新核对字段

## 配置

`config/settings.json`（首次启动自动生成，也可在页面「设置」里改）：

| 字段 | 说明 |
| --- | --- |
| `server.port` | 本地端口，默认 5173 |
| `chrome.debugPort` | Chrome 调试端口，默认 9333 |
| `chrome.exePath` | Chrome 路径，留空自动探测 |
| `collect.intervalMs` | 两次采集之间的间隔，避免风控 |
| `collect.dumpRaw` | 是否把原始页面 JSON 存到 `data/raw/`，解析异常时用来排查 |
| `images.maxCount` | 最多保留多少张图片 |
| `mercadolibre.site` | 站点，默认 `MLM`（墨西哥） |
| `mercadolibre.currency` | 目标币种，默认 `MXN` |
| `mercadolibre.rate` | 人民币 → 目标币种汇率 |
| `mercadolibre.markup` | 加价倍数（含运费与佣金的粗略预留） |
| `mercadolibre.priceEnding` | 价格尾数，如 `.90` 会算成 `X9.90`；留空则四舍五入 |
| `mercadolibre.titleMaxLength` | 标题上限，默认 60 |
| `mercadolibre.maxQuantity` | 库存上限，默认 9999（美客多单条上限） |
| `mercadolibre.variationsUseSkuPrice` | 变体是否按各自 SKU 原价换算，默认 `false`（与主商品同价） |
| `mercadolibre.attributeMap` | 中文属性名 → 美客多属性 ID，支持互相包含的模糊匹配 |

`config/translate.zh-es.json`：中文 → 西语词表，按最长优先替换。草稿标题里没翻译的词会保留中文并给出提示，逐步补词表即可。

## 命令行

```bash
npm run chrome          # 只启动浏览器
npm start               # 启动网页
npm run collect -- <url> [<url>..]   # 采集 + 下载媒体 + 生成草稿
npm run pdd-fill -- <offerId>        # 在浏览器里填拼多多发布表单（不提交）
npm run smoke           # 离线冒烟测试
```

CLI 其余命令（都需要 `node --experimental-sqlite` 前缀）：

```bash
node --experimental-sqlite server/cli.mjs collect <url> [<url>..]
node --experimental-sqlite server/cli.mjs retry-media [offerId]   # 补下载失败的媒体
node --experimental-sqlite server/cli.mjs media <offerId>         # 按已采集数据重建媒体清单并下载（不重采）
node --experimental-sqlite server/cli.mjs export-csv
node --experimental-sqlite server/cli.mjs list
```

## 目录

```
server/
  index.mjs              HTTP 服务与 API
  cli.mjs                命令行入口
  config.mjs             配置与路径
  chrome.mjs             Chrome 启动与 CDP 连接
  db.mjs                 SQLite 数据层（products / assets）
  media.mjs              媒体清单构建、本地下载、补下载
  collector/
    ali1688.mjs          采集流程（含风控识别、接口拦截）
    normalize.mjs        内嵌 JSON 的启发式解析、图片分类、视频解析
  draft/
    mercadolibre.mjs     草稿生成
  platforms/pdd/
    client.mjs           拼多多开放平台客户端（签名/错误，未接入业务）
    publish.mjs          半自动填表流程（两阶段，只填不提交）
    dom.mjs              页面结构快照与落盘
public/                  前端页面
config/                  配置与词表
data/
  listing.db             SQLite 数据库
  media/                 图片与视频的本地副本
  raw/                   原始页面与接口存档
  chrome-profile/        专用浏览器登录态
scripts/smoke.mjs        离线测试
```

## 已知限制

- 只能采集你账号在 1688 上能看到的内容；登录失效会直接提示
- 触发滑块验证时需要你手动在浏览器里完成
- 价格取最低阶梯价，不区分 SKU 差异定价
- 标题翻译依赖词表，词表没覆盖的部分会保留中文，需要人工补
- 草稿的 `category_id` 需要自己填（美客多类目需要按站点查）
- 本地副本只解决"图源失效"问题；美客多要求公网可访问，刊登前仍需把本地文件传到图床
- 视频只下载原片，美客多刊登需走它自己的视频上传接口
