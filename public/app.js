const $ = (sel) => document.querySelector(sel);

const state = {
  current: null,
  assets: [],
  busy: false,
  config: null
};

/* ---------- 通用 ---------- */

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) throw new Error(`HTTP ${res.status}`);
  return data;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败，请手动选择');
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/* ---------- 状态 ---------- */

async function refreshHealth() {
  const dot = $('#statusDot');
  const text = $('#statusText');
  try {
    const data = await api('/api/health');
    state.config = data.config;
    if (!data.chromeReady) {
      dot.className = 'dot off';
      text.textContent = 'Chrome 未连接';
    } else if (!data.loggedIn) {
      dot.className = 'dot warn';
      text.textContent = 'Chrome 已连接，1688 未登录';
    } else {
      dot.className = 'dot ok';
      text.textContent = 'Chrome 已就绪';
    }
  } catch {
    dot.className = 'dot off';
    text.textContent = '服务未响应';
  }
}

/* ---------- 媒体 ---------- */

const KIND_LABEL = { main: '展示图', sku: '规格图', detail: '详情图', video: '视频' };

function renderAsset(asset) {
  const box = el('div', 'asset');
  const isVideo = asset.kind === 'video';
  const previewSrc = asset.localUrl || asset.remoteUrl;

  if (isVideo) {
    const link = document.createElement('a');
    link.href = previewSrc;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'asset-video';
    link.textContent = '▶';
    box.appendChild(link);
  } else {
    const img = document.createElement('img');
    img.src = previewSrc;
    img.loading = 'lazy';
    img.alt = asset.label || '';
    img.onerror = () => {
      img.classList.add('broken');
    };
    box.appendChild(img);
  }

  const meta = el('div', 'asset-meta');
  const badge = el(
    'span',
    `badge ${asset.status === 'ok' ? 'ok' : asset.status === 'failed' ? 'bad' : ''}`,
    asset.status === 'ok' ? '本地' : asset.status === 'failed' ? '失败' : '待下载'
  );
  meta.appendChild(badge);

  if (asset.localUrl) {
    const a = document.createElement('a');
    a.href = asset.localUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '本地';
    meta.appendChild(a);
  }
  const remote = document.createElement('a');
  remote.href = asset.remoteUrl;
  remote.target = '_blank';
  remote.rel = 'noopener';
  remote.textContent = '远程';
  meta.appendChild(remote);

  if (asset.status !== 'ok') {
    const btn = el('button', 'mini', '下载');
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const data = await api(`/api/assets/${asset.id}/retry`, { method: 'POST', body: '{}' });
        if (data.ok) {
          toast('下载成功');
          await reloadCurrent();
        } else {
          toast(`失败: ${data.error || '未知'}`);
          btn.disabled = false;
          btn.textContent = '下载';
        }
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = '下载';
      }
    };
    meta.appendChild(btn);
  }

  if (asset.bytes) meta.appendChild(el('span', 'sz', fmtBytes(asset.bytes)));
  if (asset.label) meta.title = asset.label;

  box.appendChild(meta);
  return box;
}

function renderMediaSection(assets) {
  const wrap = el('div', 'media-section');
  const kinds = ['main', 'sku', 'detail', 'video'];

  for (const kind of kinds) {
    const list = assets.filter((a) => a.kind === kind);
    if (!list.length) continue;

    const okCount = list.filter((a) => a.status === 'ok').length;
    const group = el('div', 'media-group');
    const head = el('div', 'media-head');
    head.appendChild(el('span', 'group-label', `${KIND_LABEL[kind]} ${okCount}/${list.length} 已本地`));

    if (okCount < list.length) {
      const retry = el('button', 'mini', '全部补下载');
      retry.onclick = async () => {
        retry.disabled = true;
        retry.textContent = '下载中…';
        try {
          await api(`/api/results/${state.current.offerId}/retry`, { method: 'POST', body: '{}' });
          await reloadCurrent();
        } catch (err) {
          toast(err.message);
          retry.disabled = false;
          retry.textContent = '全部补下载';
        }
      };
      head.appendChild(retry);
    }
    group.appendChild(head);

    const grid = el('div', 'asset-grid');
    list.forEach((a) => grid.appendChild(renderAsset(a)));
    group.appendChild(grid);
    wrap.appendChild(group);
  }

  if (!assets.length) wrap.appendChild(el('p', 'empty', '该商品没有媒体'));
  return wrap;
}

/* ---------- 结果 ---------- */

function renderRecord(record, assets) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  const titleWrap = el('div');
  titleWrap.appendChild(el('h3', 'card-title', record.draft.title || '(无标题)'));
  titleWrap.appendChild(el('p', 'card-origin', record.product.title || ''));

  // 快捷跳转：1688 商品页 / 商家店铺
  const links = el('div', 'card-links');
  const addLink = (text, href, hint) => {
    if (!href) return;
    const a = el('a', 'link-chip', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noreferrer';
    if (hint) a.title = hint;
    links.appendChild(a);
  };
  addLink('1688 商品页', record.product.url, record.offerId);
  const shop = record.product.shop;
  if (shop?.url) addLink(shop.guessed ? '店铺（推测）' : '店铺首页', shop.url, shop.name || shop.loginId || '');
  const copyBtn = el('button', 'link-chip', '复制链接');
  copyBtn.type = 'button';
  copyBtn.onclick = () => copyText(record.product.url || '');
  links.appendChild(copyBtn);
  titleWrap.appendChild(links);

  head.appendChild(titleWrap);
  card.appendChild(head);

  card.appendChild(renderMediaSection(assets));

  const kv = el('div', 'kv');
  const stockSum = (record.product.skus ?? []).reduce((s, x) => s + (x.stock ?? 0), 0);
  const items = [
    ['成本价 CNY', record.product.price?.min ?? '—'],
    ['草稿价', record.draft.price ? `${record.draft.price} ${record.draft.currency_id}` : '—'],
    ['重量', record.draft.package?.weight_g ? `${record.draft.package.weight_g} g` : '—'],
    ['SKU', `${(record.product.skus ?? []).length} 个`],
    ['库存', stockSum || record.draft.available_quantity || '—'],
    ['属性', `${(record.product.attributes ?? []).length} 项`]
  ];
  items.forEach(([k, v]) => {
    const box = el('div');
    box.appendChild(el('span', '', k));
    box.appendChild(el('strong', '', String(v)));
    kv.appendChild(box);
  });
  card.appendChild(kv);

  if (record.product?.attributes?.length) {
    const box = document.createElement('details');
    box.appendChild(el('summary', '', `商品属性与规格 (${record.product.attributes.length} 项)`));
    const grid = el('div', 'kv');
    record.product.attributes.forEach((a) => {
      const item = el('div');
      item.appendChild(el('span', '', a.name));
      item.appendChild(el('strong', '', a.value));
      grid.appendChild(item);
    });
    (record.product.skus ?? []).forEach((sku, i) => {
      const specs = Object.entries(sku.specs || {}).map(([k, v]) => `${k}:${v}`).join(' / ');
      const item = el('div');
      item.appendChild(el('span', '', `SKU ${i + 1}`));
      item.appendChild(el('strong', '', `${specs || '默认'} · ¥${sku.price ?? '-'} · 库存${sku.stock ?? '-'}`));
      grid.appendChild(item);
    });
    box.appendChild(grid);
    box.open = true;
    card.appendChild(box);
  }

  if (record.warnings?.length) {
    const list = el('ul', 'warn-list');
    record.warnings.forEach((w) => list.appendChild(el('li', w.level, w.message)));
    card.appendChild(list);
  }

  const details = document.createElement('details');
  details.appendChild(el('summary', '', '查看草稿 JSON'));
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(record.draft, null, 2);
  details.appendChild(pre);
  card.appendChild(details);

  return card;
}

function showRecord(record, assets) {
  state.current = record;
  state.assets = assets;
  const body = $('#resultBody');
  body.replaceChildren(renderRecord(record, assets));
  $('#resultTitle').textContent = `采集结果 · ${record.offerId}`;
  $('#resultActions').hidden = false;
}

async function reloadCurrent() {
  if (!state.current) return;
  const data = await api(`/api/results/${state.current.offerId}`);
  if (data.record) showRecord(data.record, data.assets ?? []);
}

function renderHistory(items) {
  const list = $('#history');
  list.replaceChildren();
  if (!items.length) {
    list.appendChild(el('li', 'empty', '暂无记录'));
    return;
  }
  items.forEach((item) => {
    const li = el('li');
    li.appendChild(el('span', 'h-title', item.title || '(无标题)'));
    const meta = el('span', 'h-meta');
    meta.appendChild(el('span', '', item.price ? `${item.price} ${item.currency}` : '无价格'));
    const mediaText =
      item.mediaTotal > 0
        ? `媒体 ${item.mediaOk}/${item.mediaTotal}`
        : '无媒体';
    meta.appendChild(el('span', item.mediaFailed ? 'h-warn' : '', mediaText));
    li.appendChild(meta);
    li.onclick = async () => {
      const data = await api(`/api/results/${item.offerId}`);
      if (data.record) showRecord(data.record, data.assets ?? []);
    };
    list.appendChild(li);
  });
}

async function refreshHistory() {
  const items = await api('/api/results');
  renderHistory(Array.isArray(items) ? items : []);
}

/* ---------- 采集 ---------- */

async function collectAll() {
  if (state.busy) return;
  const raw = $('#urls').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!raw.length) return toast('请先粘贴链接');

  state.busy = true;
  $('#btnCollect').disabled = true;
  const body = $('#resultBody');
  body.replaceChildren();
  $('#resultTitle').textContent = '采集结果';
  $('#resultActions').hidden = true;

  let index = 0;
  for (const url of raw) {
    index += 1;
    $('#progress').textContent = `${index}/${raw.length} 采集与下载中…`;
    $('#btnCollect').textContent = '采集中…';
    try {
      const data = await api('/api/collect', { method: 'POST', body: JSON.stringify({ url }) });
      if (data.ok) {
        body.prepend(renderRecord(data.record, data.assets ?? []));
        state.current = data.record;
        state.assets = data.assets ?? [];
        $('#resultActions').hidden = false;
      } else {
        const card = el('div', 'card error');
        card.appendChild(el('h3', 'card-title', '采集失败'));
        card.appendChild(el('p', 'card-origin', `${url}\n${data.error || '未知错误'}`));
        body.prepend(card);
      }
    } catch (err) {
      const card = el('div', 'card error');
      card.appendChild(el('h3', 'card-title', '请求失败'));
      card.appendChild(el('p', 'card-origin', `${url}\n${err.message}`));
      body.prepend(card);
    }
  }

  $('#progress').textContent = `完成 ${raw.length} 条`;
  $('#btnCollect').textContent = '开始采集';
  $('#btnCollect').disabled = false;
  state.busy = false;
  refreshHistory();
}

/* ---------- 设置 ---------- */

function fillSettings(cfg) {
  const ml = cfg.mercadolibre;
  $('#cfgSite').value = ml.site;
  $('#cfgCurrency').value = ml.currency;
  $('#cfgRate').value = ml.rate;
  $('#cfgMarkup').value = ml.markup;
  $('#cfgEnding').value = ml.priceEnding;
  $('#cfgTitleMax').value = ml.titleMaxLength;
  $('#cfgMinImages').value = ml.minImages;
}

async function saveSettings() {
  const current = state.config ?? (await api('/api/settings'));
  const patch = {
    ...current,
    mercadolibre: {
      ...current.mercadolibre,
      site: $('#cfgSite').value,
      currency: $('#cfgCurrency').value.trim().toUpperCase(),
      rate: Number($('#cfgRate').value),
      markup: Number($('#cfgMarkup').value),
      priceEnding: $('#cfgEnding').value.trim(),
      titleMaxLength: Number($('#cfgTitleMax').value),
      minImages: Number($('#cfgMinImages').value)
    }
  };
  const data = await api('/api/settings', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  toast('设置已保存，重新采集后生效');
}

/* ---------- 绑定 ---------- */

$('#btnCollect').onclick = collectAll;
$('#btnClear').onclick = () => {
  $('#urls').value = '';
  $('#progress').textContent = '';
};
$('#btnRefresh').onclick = refreshHistory;
$('#btnOpenChrome').onclick = async () => {
  toast('正在打开 Chrome…');
  try {
    await api('/api/chrome/open', { method: 'POST', body: JSON.stringify({ url: 'https://www.1688.com' }) });
    toast('已打开 1688，请在该窗口登录');
    setTimeout(refreshHealth, 1500);
  } catch (err) {
    toast(`打开失败: ${err.message}`);
  }
};
$('#btnSettings').onclick = async () => {
  const cfg = state.config ?? (await api('/api/settings'));
  state.config = cfg;
  fillSettings(cfg);
  $('#settingsDialog').showModal();
};
$('#btnSaveSettings').onclick = async (event) => {
  event.preventDefault();
  await saveSettings();
  $('#settingsDialog').close();
};
$('#btnCopyJson').onclick = () => {
  if (!state.current) return;
  copyText(JSON.stringify(state.current.draft, null, 2));
};
$('#btnCopyTitle').onclick = () => {
  if (!state.current) return;
  copyText(state.current.draft.title || '');
};
$('#btnCopyImages').onclick = () => {
  if (!state.current) return;
  const lines = state.assets
    .filter((a) => a.kind !== 'video')
    .map((a) => a.localUrl || a.remoteUrl);
  copyText(lines.join('\n'));
};

/* ---------- 拼多多填表 ---------- */

function showPddReport(report) {
  $('#pddSummary').textContent = [
    `类目：${report.category || '未识别'}`,
    `标题：${report.title}`,
    report.prices
      ? `拼单价 ${report.prices.group} / 单买价 ${report.prices.single} / 参考价 ${report.prices.reference}（${
          report.prices.mode === 'add' ? `成本+${report.prices.addAmount}元` : `成本×${report.prices.markup}`
        }）`
      : '价格未填'
  ].join('　|　');

  const box = $('#pddReport');
  box.replaceChildren();

  const filledTitle = el('h3', '', `已自动填 ${report.filled.length} 项`);
  box.appendChild(filledTitle);
  const filledList = el('ul', 'pdd-list');
  report.filled.forEach((f) => filledList.appendChild(el('li', 'ok', `${f.field}：${f.value}`)));
  box.appendChild(filledList);

  const pendingTitle = el('h3', '', `需人工处理 ${report.pending.length} 项`);
  box.appendChild(pendingTitle);
  const pendingList = el('ul', 'pdd-list');
  report.pending.forEach((p) => pendingList.appendChild(el('li', 'todo', p)));
  box.appendChild(pendingList);

  box.appendChild(el('p', 'hint', '浏览器已停在待提交页面，核对无误后请自己点「提交并上架」。'));
  $('#pddDialog').showModal();
}

/* 加价设置：记住上次填的值 */
const PDD_PRICE_KEY = 'listing-desk.pddPrice';

function restorePddPrice() {
  const modeEl = $('#pddPriceMode');
  const valueEl = $('#pddPriceValue');
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PDD_PRICE_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  if (saved?.mode) modeEl.value = saved.mode;
  if (saved?.value) valueEl.value = saved.value;
  if (!valueEl.value) valueEl.value = modeEl.value === 'add' ? '5' : '1.35';
}

$('#pddPriceMode').onchange = () => {
  const valueEl = $('#pddPriceValue');
  valueEl.value = $('#pddPriceMode').value === 'add' ? '5' : '1.35';
};

$('#btnPddFill').onclick = async () => {
  if (!state.current) return;

  const mode = $('#pddPriceMode').value;
  const value = Number($('#pddPriceValue').value);
  if (!Number.isFinite(value) || value <= 0) return toast('请先填写大于 0 的加价');
  localStorage.setItem(PDD_PRICE_KEY, JSON.stringify({ mode, value }));
  const rules = mode === 'add' ? { priceMode: 'add', addAmount: value } : { priceMode: 'markup', markup: value };

  const btn = $('#btnPddFill');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '填表中…';
  try {
    const data = await api('/api/pdd/fill', {
      method: 'POST',
      body: JSON.stringify({ offerId: state.current.offerId, rules })
    });
    if (!data.ok) throw new Error(data.error || '填表失败');
    showPddReport(data);
  } catch (err) {
    toast(`填表失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

$('#btnPddClose').onclick = () => $('#pddDialog').close();

$('#btnExportCsv').onclick = async () => {
  const res = await fetch('/api/export/csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'listing-desk.csv';
  a.click();
  URL.revokeObjectURL(a.href);
};

restorePddPrice();
refreshHealth();
refreshHistory();
setInterval(refreshHealth, 30000);
