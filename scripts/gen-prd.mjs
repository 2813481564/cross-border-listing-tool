/**
 * 生成「产品需求说明书（PRD）」docx。
 * 用法: node scripts/gen-prd.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  WidthType,
  ShadingType,
  VerticalAlign,
  LevelFormat,
  PageBreak
} from 'docx';

const OUT = process.argv[2] || 'E:/project/莱创生活/莱创生活商城管理系统-产品需求说明书.docx';

const FONT = '微软雅黑';
const border = { style: BorderStyle.SINGLE, size: 1, color: 'BFBFBF' };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(text, { width, bold = false, fill = null, align = AlignmentType.LEFT } = {}) {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: fill ? { fill, type: ShadingType.CLEAR } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text: String(text ?? ''), bold, font: FONT, size: 21 })]
      })
    ]
  });
}

function makeTable(columnWidths, headerCells, rows) {
  const total = columnWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headerCells.map((t, i) =>
          cell(t, { width: columnWidths[i], bold: true, fill: 'E8EEF7', align: AlignmentType.CENTER })
        )
      }),
      ...rows.map(
        (r) =>
          new TableRow({
            children: r.map((t, i) => cell(t, { width: columnWidths[i] }))
          })
      )
    ]
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, font: FONT, size: 30, bold: true })]
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 220, after: 120 },
    children: [new TextRun({ text, font: FONT, size: 26, bold: true })]
  });
}

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 100, line: 320 },
    indent: opts.indent ? { left: 420 } : undefined,
    children: [new TextRun({ text, font: FONT, size: 21, bold: Boolean(opts.bold) })]
  });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } }
  },
  numbering: {
    config: [
      {
        reference: 'num',
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 480, hanging: 300 } } }
          }
        ]
      }
    ]
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, right: 1247, bottom: 1440, left: 1247 }
        }
      },
      children: [
        /* ---------- 封面 ---------- */
        new Paragraph({ spacing: { before: 2200 } }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 240 },
          children: [new TextRun({ text: '莱创生活商城管理系统', font: FONT, size: 52, bold: true })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 600 },
          children: [new TextRun({ text: 'V1.0', font: FONT, size: 32 })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 240 },
          children: [new TextRun({ text: '产品需求说明书', font: FONT, size: 44, bold: true })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 800 },
          children: [new TextRun({ text: '2026 年 11 月', font: FONT, size: 24 })]
        }),
        new Paragraph({ children: [new PageBreak()] }),

        /* ---------- 修订记录 ---------- */
        h1('修订记录'),
        makeTable(
          [2200, 1400, 1800, 3560],
          ['时间', '版本号', '维护人', '维护内容'],
          [
            ['2026-11', 'V1.0', '技术部', '初版创建，含商品管理、订单管理、拼多多渠道同步'],
            ['', '', '', ''],
            ['', '', '', '']
          ]
        ),
        new Paragraph({ children: [new PageBreak()] }),

        /* ---------- 1 产品说明 ---------- */
        h1('1  产品说明'),
        p('产品名称：莱创生活商城管理系统', { bold: true }),
        p(''),

        h2('1.1  使用场景'),
        p(
          '莱创生活商城管理系统是公司自建、自用的电商经营管理平台，面向公司内部运营与仓储人员。' +
            '系统覆盖商品资料维护、商品上架、订单处理、物流发货等日常经营环节。'
        ),
        p(
          '公司在淘宝、拼多多等多个平台开设店铺，同一批商品需要在多个渠道同时销售。' +
            '过去商品资料分散在各平台后台，同一件商品要在不同平台重复录入标题、图片、规格与价格，' +
            '工作量大且容易出错；各渠道订单也需要分别登录平台后台处理，发货信息需要人工回填。'
        ),
        p(
          '本系统把商品资料集中在公司自己的数据库中统一维护，通过拼多多开放平台接口将商品同步发布到公司拼多多店铺，' +
            '并把拼多多店铺产生的订单回流到本系统统一处理，实现「一处维护、多渠道销售」的经营方式。'
        ),

        h2('1.2  解决的核心需求'),
        p('（1）商品资料集中管理', { indent: true }),
        p(
          '商品标题、主图、详情图、规格、价格、库存统一维护在系统内，避免多平台重复录入，' +
            '商品信息修改后可在各渠道同步更新。'
        ),
        p('（2）商品同步发布到拼多多店铺', { indent: true }),
        p(
          '通过拼多多开放平台接口，将系统内的商品按平台类目要求补全属性、上传图片后直接发布，' +
            '替代过去在平台后台逐个手工录入的方式，显著降低上架耗时。'
        ),
        p('（3）订单集中处理', { indent: true }),
        p(
          '定时拉取拼多多店铺订单并汇入系统订单列表，运营人员在同一个界面处理来自不同渠道的订单，' +
            '不必反复切换平台后台。'
        ),
        p('（4）发货与物流回传', { indent: true }),
        p(
          '在系统内录入物流公司与运单号后，通过接口回传平台，完成发货状态同步，' +
            '减少人工在平台后台逐单填写运单号的操作及错填风险。'
        ),

        new Paragraph({ children: [new PageBreak()] }),

        /* ---------- 2 详细需求 ---------- */
        h1('2  详细需求'),

        h2('2.1  调用接口（API）一览表'),
        p('本系统调用拼多多开放平台接口，用于商品同步发布与订单回流，具体如下：'),
        makeTable(
          [2900, 6060],
          ['接口', '调用原因'],
          [
            [
              'pdd.goods.cats.get',
              '拉取拼多多商品类目树。系统内商品分类与平台类目不是一一对应关系，发布前需先取得平台类目列表，由运营人员完成类目映射并保存，后续同类商品可直接复用映射关系。'
            ],
            [
              'pdd.goods.cat.template.get',
              '获取所选类目的属性模板。不同类目的必填属性差异较大（如材质、适用人群、规格参数），发布前需按模板校验并补全商品属性，否则平台会拒绝发布。'
            ],
            [
              'pdd.goods.spec.get',
              '获取类目允许的规格定义。系统内的颜色、尺码等规格需转换为平台认可的标准规格值，才能正确生成商品的多规格 SKU 与价格库存。'
            ],
            [
              'pdd.goods.image.upload',
              '上传商品主图与详情图至平台图片空间并换取图片地址。平台不接受外部图片链接，必须先上传再引用，否则商品图片无法展示。'
            ],
            [
              'pdd.goods.add',
              '将校验通过的商品资料正式提交发布到公司拼多多店铺，是商品上架的核心动作，替代人工在平台后台逐条录入。'
            ],
            [
              'pdd.goods.detail.get',
              '发布后回查商品状态与平台商品 ID。平台审核为异步过程，需定时查询以同步「审核中/已上架/被驳回」等状态，并记录驳回原因供运营修改。'
            ],
            [
              'pdd.order.list.get',
              '按时间范围拉取拼多多店铺订单，回流至系统订单模块统一处理，使运营无需在两个后台之间切换即可完成订单履约。'
            ],
            [
              'pdd.logistics.online.send',
              '发货后将物流公司编码与运单号回传平台，完成平台侧发货状态更新，避免人工逐单填写运单号。'
            ]
          ]
        ),

        h2('2.2  业务流程图'),
        p('商品发布到拼多多店铺的完整流程如下：'),
        p('① 运营在系统中新建或编辑商品，维护标题、主图、详情图、规格、价格、库存；', { indent: true }),
        p('② 选择要发布的目标渠道（拼多多），系统调用 pdd.goods.cats.get 获取类目树；', { indent: true }),
        p('③ 运营完成商品分类与平台类目的映射，映射关系保存供后续复用；', { indent: true }),
        p('④ 系统调用 pdd.goods.cat.template.get 取得该类目属性模板，按模板检查必填属性，缺失项提示运营补全；', {
          indent: true
        }),
        p('⑤ 系统调用 pdd.goods.spec.get 取得规格定义，将系统规格值转换为平台标准规格；', { indent: true }),
        p('⑥ 系统调用 pdd.goods.image.upload 逐张上传商品图片，换取平台图片地址；', { indent: true }),
        p('⑦ 资料齐全后调用 pdd.goods.add 提交发布，记录本次发布的批次与状态；', { indent: true }),
        p('⑧ 系统定时调用 pdd.goods.detail.get 回查发布结果：', { indent: true }),
        p('　　· 已上架：记录平台商品 ID，商品状态更新为「在售」；', { indent: true }),
        p('　　· 被驳回：记录驳回原因，商品状态更新为「待修改」，运营修改后可再次发布；', { indent: true }),
        p('⑨ 商品在拼多多产生订单后，系统定时调用 pdd.order.list.get 拉取订单，写入系统订单列表；', { indent: true }),
        p('⑩ 运营在系统中拣货打包，录入物流公司与运单号，系统调用 pdd.logistics.online.send 回传平台，订单状态更新为「已发货」；', {
          indent: true
        }),
        p('⑪ 订单完成后，系统记录该笔订单的渠道来源、商品与金额，供后续经营分析使用。', { indent: true }),

        p(''),
        p('流程简图：'),
        p('商品维护 → 类目映射 → 属性校验 → 规格转换 → 图片上传 → 提交发布 → 状态回查 → 订单拉取 → 发货回传 → 订单完成'),

        h2('2.3  功能列表'),
        makeTable(
          [1900, 5000, 2060],
          ['名称', '功能摘要', '备注'],
          [
            ['商品管理', '商品的新增、编辑、删除、复制、上下架；维护标题、副标题、主图、详情图、规格、价格、库存、单位等基础资料。', '核心模块'],
            ['商品分类管理', '维护多级商品分类，支持分类排序、启停用，商品关联分类。', ''],
            ['规格与属性管理', '维护商品规格模板（颜色、尺码、容量等）与规格值，支持商品多规格组合及各自价格、库存。', ''],
            ['图片素材管理', '商品图片上传、分组存放、复用到多个商品，支持主图与详情长图分别管理。', ''],
            ['拼多多类目映射', '维护系统分类与拼多多类目的对应关系，一次配置可复用于同类商品。', ''],
            ['拼多多属性映射', '按平台类目属性模板补全商品属性，维护常用属性值的中文与平台值对应表。', ''],
            ['渠道商品发布', '选择商品一键发布至拼多多店铺，记录发布批次、平台商品 ID、审核状态与驳回原因。', '核心功能'],
            ['发布结果回查', '定时查询已提交商品的审核状态，同步上下架结果并提示需修改的商品。', ''],
            ['订单管理', '订单列表与详情，按渠道、状态、时间筛选；展示商品明细、金额、收货信息。', '核心模块'],
            ['订单同步', '按设定频率拉取拼多多店铺订单并合并入系统，自动去重。', ''],
            ['发货与物流', '录入物流公司与运单号，回传平台完成发货；支持批量发货。', ''],
            ['店铺授权管理', '维护拼多多店铺的授权信息，授权到期前提醒重新授权。', ''],
            ['系统管理', '用户、角色、菜单权限、操作日志管理，控制不同岗位可见的功能范围。', '']
          ]
        )
      ]
    }
  ]
});

await Packer.toBuffer(doc).then((buffer) => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buffer);
  console.log(`已生成: ${OUT}  (${(buffer.length / 1024).toFixed(0)} KB)`);
});
