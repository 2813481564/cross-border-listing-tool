const $ = (sel) => document.querySelector(sel);

const state = {
  current: null,
  assets: [],
  config: null,
  products: [],
  jobs: [],
  stats: { active: 0, queued: 0, running: 0 },
  finishedSeen: new Set(),
  primed: false,
  pollTimer: null,
  query: '',
  filter: 'all',
  sort: 'new',
  selected: new Set()
};

const KIND_LABEL = { main: '展示图', sku: '规格图', detail: '详情图', video: '视频' };
const STATUS_TEXT = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败' };

/* ---------- 通用 ---------- */

function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.classList.remove('show'), 1800);
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

function fmtPrice(price, currency) {
  if (price === null || price === undefined || price === '') return '—';
  const n = Number(price);
  if (!Number.isFinite(n)) return '—';
  return `${currency ? `${currency} ` : ''}${n.toFixed(2)}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function elapsedOf(job) {
  if (!job.startedAt) return 0;
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  return end - new Date(job.startedAt).getTime();
}

/* ---------- 二次确认弹窗 ---------- */

let confirmResolve = null;

function settleConfirm(result) {
  const dialog = $('#confirmDialog');
  const resolve = confirmResolve;
  confirmResolve = null;
  if (dialog.open) dialog.close();
  if (resolve) resolve(result);
}

function confirmDialog({ title, message, confirmText = '确认' }) {
  const dialog = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#btnConfirmOk').textContent = confirmText;

  // 上一次的 Promise 还没结掉就先当作取消，避免一直挂着
  if (confirmResolve) settleConfirm(false);

  dialog.showModal();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
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

/* ---------- 路由：列表 / 详情 ---------- */

function route() {
  const hash = location.hash || '#/products';
  const matched = /^#\/products\/([^/?#]+)/.exec(hash);
  if (matched) openDetail(decodeURIComponent(matched[1]));
  else openList();
}

function openList() {
  $('#viewList').hidden = false;
  $('#viewDetail').hidden = true;
  $('#resultActions').hidden = true;
  state.current = null;
  document.title = 'listing-desk · 商品库';
  window.scrollTo({ top: 0 });
}

async function openDetail(offerId) {
  $('#viewList').hidden = true;
  $('#viewDetail').hidden = false;
  $('#resultActions').hidden = true;
  window.scrollTo({ top: 0 });
  $('#detailTitle').textContent = `商品 ${offerId}`;
  $('#resultBody').replaceChildren(el('p', 'empty', '加载中…'));
  document.title = `listing-desk · ${offerId}`;

  try {
    const data = await api(`/api/results/${encodeURIComponent(offerId)}`);
    if (!data.record) throw new Error('未找到该商品');
    renderDetail(data.record, data.assets ?? []);
  } catch (err) {
    $('#resultBody').replaceChildren(el('p', 'empty', `加载失败：${err.message}`));
  }
}

/* ---------- 商品库 ---------- */

async function refreshProducts() {
  try {
    const items = await api('/api/results');
    state.products = Array.isArray(items) ? items : [];

    // 商品可能已被删除，清掉失效的勾选
    const alive = new Set(state.products.map((p) => p.offerId));
    for (const id of [...state.selected]) {
      if (!alive.has(id)) state.selected.delete(id);
    }

    renderProducts();
  } catch (err) {
    toast(`读取商品库失败：${err.message}`);
  }
}

/* ---------- 批量选择 ---------- */

function syncSelectAll(list) {
  const box = $('#selectAll');
  const visible = list ?? visibleProducts();
  const picked = visible.filter((item) => state.selected.has(item.offerId)).length;
  box.checked = visible.length > 0 && picked === visible.length;
  box.indeterminate = picked > 0 && picked < visible.length;
}

function renderBatchBar() {
  const count = state.selected.size;
  $('#batchBar').hidden = count === 0;
  $('#batchCount').textContent = `已选 ${count} 件`;
  syncSelectAll();
}

const SORTERS = {
  new: (a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')),
  'price-desc': (a, b) => (b.price ?? -1) - (a.price ?? -1),
  'price-asc': (a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER),
  title: (a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN')
};

function visibleProducts() {
  const query = state.query.trim().toLowerCase();

  const filtered = state.products.filter((item) => {
    if (query) {
      const haystack = `${item.title} ${item.originalTitle ?? ''} ${item.offerId}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (state.filter === 'pending') return (item.mediaOk ?? 0) < (item.mediaTotal ?? 0);
    if (state.filter === 'failed') return (item.mediaFailed ?? 0) > 0;
    if (state.filter === 'warned') return (item.warningsCount ?? 0) > 0;
    return true;
  });

  return filtered.sort(SORTERS[state.sort] ?? SORTERS.new);
}

function renderProducts() {
  const grid = $('#productGrid');
  grid.replaceChildren();

  const list = visibleProducts();
  const total = state.products.length;
  $('#productCount').textContent = total
    ? list.length === total
      ? `${total} 件`
      : `${list.length} / ${total} 件`
    : '';

  if (!list.length) {
    const box = el('div', 'empty-box');
    box.appendChild(
      el(
        'p',
        'empty',
        total
          ? '没有符合条件的商品，换个关键词或筛选条件试试。'
          : '商品库还是空的。把 1688 链接粘到上面的输入框，点「加入队列」开始采集。'
      )
    );
    grid.appendChild(box);
    renderBatchBar();
    return;
  }

  list.forEach((item) => grid.appendChild(renderProductCard(item)));
  renderBatchBar();
}

function renderProductCard(item) {
  const card = el('article', 'p-card');
  card.tabIndex = 0;
  if (state.selected.has(item.offerId)) card.classList.add('selected');

  const open = () => {
    location.hash = `#/products/${encodeURIComponent(item.offerId)}`;
  };
  card.onclick = open;
  card.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  const cover = el('div', 'p-cover');

  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'p-pick';
  pick.checked = state.selected.has(item.offerId);
  pick.title = '选中以批量操作';
  pick.onclick = (event) => event.stopPropagation();
  pick.onchange = () => {
    if (pick.checked) state.selected.add(item.offerId);
    else state.selected.delete(item.offerId);
    card.classList.toggle('selected', pick.checked);
    renderBatchBar();
  };
  cover.appendChild(pick);

  // 封面优先用 CDN 缩略图（几 KB），失败再回落本地原图（可能好几 MB）
  const full = item.coverUrl;
  const thumbSrc = item.thumbUrl || full;
  if (thumbSrc) {
    const img = new Image();
    img.loading = 'lazy';
    img.alt = item.title || '';
    let stage = item.thumbUrl ? 'thumb' : 'full';
    img.onerror = () => {
      if (stage === 'thumb' && full) {
        stage = 'full';
        img.src = full;
        return;
      }
      img.replaceWith(el('div', 'p-cover-empty', '图片失效'));
    };
    img.src = thumbSrc;
    cover.appendChild(img);
  } else {
    cover.appendChild(el('div', 'p-cover-empty', '暂无主图'));
  }

  const pending = Math.max(0, (item.mediaTotal ?? 0) - (item.mediaOk ?? 0));
  if (item.mediaFailed > 0) cover.appendChild(el('span', 'p-flag bad', `${item.mediaFailed} 张失败`));
  else if (pending > 0) cover.appendChild(el('span', 'p-flag warn', `${pending} 张待下载`));

  const del = el('button', 'p-del', '删除');
  del.type = 'button';
  del.title = '删除这个商品及其本地文件';
  del.onclick = (event) => {
    event.stopPropagation();
    deleteOffer(item.offerId);
  };
  cover.appendChild(del);

  card.appendChild(cover);

  const body = el('div', 'p-body');
  body.appendChild(el('p', 'p-title', item.title || '(无标题)'));

  const priceRow = el('div', 'p-price');
  const amount = item.price === null || item.price === undefined ? '—' : Number(item.price).toFixed(2);
  priceRow.appendChild(el('strong', '', amount));
  if (item.currency) priceRow.appendChild(el('span', 'cur', item.currency));
  body.appendChild(priceRow);

  const meta = el('div', 'p-sub');
  meta.appendChild(el('span', '', `媒体 ${item.mediaOk ?? 0}/${item.mediaTotal ?? 0}`));
  meta.appendChild(el('span', '', fmtDate(item.savedAt)));
  body.appendChild(meta);

  card.appendChild(body);
  return card;
}

/* ---------- 详情 ---------- */

function renderDetail(record, assets) {
  state.current = record;
  state.assets = assets;

  const body = $('#resultBody');
  const frag = document.createDocumentFragment();

  frag.appendChild(renderDetailMeta(record));

  const main = el('div', 'detail-main');
  main.appendChild(renderGallery(assets));
  main.appendChild(renderInfo(record));
  frag.appendChild(main);

  frag.appendChild(renderDraftEditor(record));

  const rest = assets.filter((a) => a.kind !== 'main');
  if (rest.length) frag.appendChild(renderMediaSection(rest));

  if (record.warnings?.length) {
    const list = el('ul', 'warn-list');
    record.warnings.forEach((w) => list.appendChild(el('li', w.level, w.message)));
    frag.appendChild(list);
  }

  const json = document.createElement('details');
  json.appendChild(el('summary', '', '查看草稿 JSON'));
  json.appendChild(el('pre', '', JSON.stringify(record.draft ?? {}, null, 2)));
  frag.appendChild(json);

  body.replaceChildren(frag);

  $('#detailTitle').textContent = record.draft?.title || record.product?.title || `商品 ${record.offerId}`;
  $('#resultActions').hidden = false;
  document.title = `listing-desk · ${record.offerId}`;
}

/** 原产地标题 + 快捷跳转 */
function renderDetailMeta(record) {
  const block = el('div', 'detail-title-block');
  const origin = record.product?.title;
  if (origin && origin !== record.draft?.title) {
    block.appendChild(el('p', 'detail-origin', origin));
  }

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
  addLink('1688 商品页', record.product?.url, record.offerId);

  const shop = record.product?.shop;
  if (shop?.url) {
    addLink(shop.guessed ? '店铺（推测）' : '店铺首页', shop.url, shop.name || shop.loginId || '');
  }

  const copyBtn = el('button', 'link-chip', '复制链接');
  copyBtn.type = 'button';
  copyBtn.onclick = () => copyText(record.product?.url || '');
  links.appendChild(copyBtn);

  block.appendChild(links);
  return block;
}

const GALLERY_LIMIT = 12;

function renderGallery(assets) {
  const wrap = el('div', 'detail-gallery');
  const mains = assets.filter((a) => a.kind === 'main');
  wrap.appendChild(el('h3', '', `${KIND_LABEL.main} ${mains.length} 张`));

  if (!mains.length) {
    wrap.appendChild(el('p', 'empty', '该商品没有主图'));
    return wrap;
  }

  const grid = el('div', 'gallery-grid');
  mains.slice(0, GALLERY_LIMIT).forEach((a) => grid.appendChild(renderAsset(a, 'gallery')));
  wrap.appendChild(grid);

  // 1688 主图动辄几十张，先铺一屏，剩下的点了再展开
  const rest = mains.slice(GALLERY_LIMIT);
  if (rest.length) {
    const more = el('button', 'btn ghost small gallery-more', `展开其余 ${rest.length} 张`);
    more.onclick = () => {
      rest.forEach((a) => grid.appendChild(renderAsset(a, 'gallery')));
      more.remove();
    };
    wrap.appendChild(more);
  }

  return wrap;
}

function renderInfo(record) {
  const side = el('div', 'detail-side');
  side.appendChild(el('h3', '', '商品信息'));

  const skus = record.product?.skus ?? [];
  const stockSum = skus.reduce((sum, sku) => sum + (sku.stock ?? 0), 0);
  const items = [
    ['成本价 CNY', record.product?.price?.min ?? '—'],
    ['草稿价', record.draft?.price ? `${record.draft.price} ${record.draft.currency_id ?? ''}`.trim() : '—'],
    ['重量', record.draft?.package?.weight_g ? `${record.draft.package.weight_g} g` : '—'],
    ['SKU', `${skus.length} 个`],
    ['库存', stockSum || record.draft?.available_quantity || '—'],
    ['属性', `${(record.product?.attributes ?? []).length} 项`]
  ];

  const kv = el('div', 'kv');
  items.forEach(([key, value]) => {
    const box = el('div');
    box.appendChild(el('span', '', key));
    box.appendChild(el('strong', '', String(value)));
    kv.appendChild(box);
  });
  side.appendChild(kv);

  if (record.product?.attributes?.length) {
    const box = document.createElement('details');
    box.open = true;
    box.appendChild(el('summary', '', `商品属性与规格 (${record.product.attributes.length} 项)`));

    const grid = el('div', 'kv');
    record.product.attributes.forEach((attr) => {
      const item = el('div');
      item.appendChild(el('span', '', attr.name));
      item.appendChild(el('strong', '', attr.value));
      grid.appendChild(item);
    });
    skus.forEach((sku, index) => {
      const specs = Object.entries(sku.specs || {}).map(([k, v]) => `${k}:${v}`).join(' / ');
      const item = el('div');
      item.appendChild(el('span', '', `SKU ${index + 1}`));
      item.appendChild(el('strong', '', `${specs || '默认'} · ¥${sku.price ?? '-'} · 库存${sku.stock ?? '-'}`));
      grid.appendChild(item);
    });
    box.appendChild(grid);
    side.appendChild(box);
  }

  return side;
}

/* ---------- 草稿手改 ---------- */

function field(label, control, wide = false) {
  const wrap = el('label', wide ? 'wide' : '');
  wrap.appendChild(el('span', '', label));
  wrap.appendChild(control);
  return wrap;
}

function numberInput(id, value, { step = '1', min = '0' } = {}) {
  const input = document.createElement('input');
  input.id = id;
  input.type = 'number';
  input.step = step;
  input.min = min;
  input.value = value === null || value === undefined ? '' : value;
  return input;
}

function textInput(id, value, placeholder = '') {
  const input = document.createElement('input');
  input.id = id;
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = value ?? '';
  return input;
}

function renderDraftEditor(record) {
  const draft = record.draft ?? {};
  const panel = el('div', 'detail-edit');
  panel.appendChild(el('h3', '', '编辑草稿'));
  panel.appendChild(el('p', 'hint', '改完点保存直接写回本地库；重新采集会被 1688 的数据覆盖。'));

  const grid = el('div', 'edit-grid');
  const title = textInput('editTitle', draft.title ?? '');
  const price = numberInput('editPrice', draft.price, { step: '0.01' });
  const stock = numberInput('editStock', draft.available_quantity);
  const category = textInput('editCategory', draft.category_id ?? '', '例如 MLM158455');
  const weight = numberInput('editWeight', draft.package?.weight_g);

  grid.appendChild(field(`西语标题（上限 ${state.config?.mercadolibre?.titleMaxLength ?? 60}）`, title, true));
  grid.appendChild(field(`价格 ${draft.currency_id ?? ''}`.trim(), price));
  grid.appendChild(field('库存', stock));
  grid.appendChild(field('类目 ID', category));
  grid.appendChild(field('重量 (g)', weight));
  panel.appendChild(grid);

  const row = el('div', 'row');

  const save = el('button', 'btn primary small', '保存草稿');
  save.type = 'button';
  save.onclick = async () => {
    save.disabled = true;
    save.textContent = '保存中…';
    try {
      const data = await api(`/api/results/${encodeURIComponent(record.offerId)}/draft`, {
        method: 'POST',
        body: JSON.stringify({
          title: title.value,
          price: price.value === '' ? null : Number(price.value),
          available_quantity: stock.value === '' ? null : Number(stock.value),
          category_id: category.value,
          weight_g: weight.value === '' ? null : Number(weight.value)
        })
      });
      if (!data.ok) throw new Error(data.error || '保存失败');

      const keepY = window.scrollY;
      toast('草稿已保存');
      renderDetail(data.record, state.assets);
      window.scrollTo({ top: keepY });
    } catch (err) {
      toast(`保存失败：${err.message}`);
      save.disabled = false;
      save.textContent = '保存草稿';
    }
  };
  row.appendChild(save);

  const reset = el('button', 'btn ghost small', '撤销修改');
  reset.type = 'button';
  reset.onclick = () => {
    const keepY = window.scrollY;
    renderDetail(record, state.assets);
    window.scrollTo({ top: keepY });
  };
  row.appendChild(reset);

  panel.appendChild(row);
  return panel;
}

/* ---------- 媒体 ---------- */

function renderAsset(asset, variant = '') {
  const box = el('div', `asset ${variant}`.trim());
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
    img.onerror = () => img.classList.add('broken');
    box.appendChild(img);
  }

  const meta = el('div', 'asset-meta');
  meta.appendChild(
    el(
      'span',
      `badge ${asset.status === 'ok' ? 'ok' : asset.status === 'failed' ? 'bad' : ''}`,
      asset.status === 'ok' ? '本地' : asset.status === 'failed' ? '失败' : '待下载'
    )
  );

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
  const kinds = ['sku', 'detail', 'video'];

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

  return wrap;
}

async function reloadCurrent() {
  if (!state.current) return;
  const data = await api(`/api/results/${encodeURIComponent(state.current.offerId)}`);
  if (data.record) renderDetail(data.record, data.assets ?? []);
}

/* ---------- 删除 ---------- */

async function deleteOffer(offerId, { fromDetail = false } = {}) {
  const confirmed = await confirmDialog({
    title: '删除商品',
    message: `将永久删除商品 ${offerId} 的全部数据：数据库记录、本地图片与视频副本、采集原始存档。此操作不可恢复。`,
    confirmText: '确认删除'
  });
  if (!confirmed) return false;

  try {
    const data = await api(`/api/results/${encodeURIComponent(offerId)}`, { method: 'DELETE' });
    if (!data.ok) throw new Error(data.error || '删除失败');

    const files = [];
    if (data.files?.media) files.push('媒体文件');
    if (data.files?.raw) files.push(`${data.files.raw} 个原始存档`);
    if (data.files?.legacy) files.push('旧版结果');
    toast(files.length ? `已删除（含${files.join('、')}）` : '已删除');

    await refreshProducts();

    if (fromDetail) {
      state.current = null;
      state.assets = [];
      location.hash = '#/products';
    }
    return true;
  } catch (err) {
    toast(`删除失败：${err.message}`);
    return false;
  }
}

/* ---------- 任务队列 ---------- */

async function submitJobs() {
  const urls = $('#urls')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!urls.length) return toast('请先粘贴链接');

  const btn = $('#btnCollect');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ urls }) });
    if (!data.ok) throw new Error(data.error || '加入队列失败');
    toast(`已加入 ${urls.length} 个采集任务`);
    $('#urls').value = '';
    $('#progress').textContent = `已排队 ${data.active ?? urls.length} 个任务`;
    applyJobs(data.jobs ?? [], data);
    $('#queuePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '加入队列';
  }
}

/* ---------- 采集购物车 ---------- */

async function scanCart() {
  const btn = $('#btnScanCart');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '读取购物车…';
  try {
    const data = await api('/api/cart/scan', { method: 'POST', body: '{}' });
    if (!data.ok) throw new Error(data.error || '读取失败');
    showCartDialog(data);
  } catch (err) {
    toast(`读取购物车失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function showCartDialog(data) {
  $('#cartSummary').textContent = `购物车共 ${data.total} 个商品，其中 ${data.newCount} 个是新商品（默认勾选）${
    data.hasInvalid ? '；检测到失效商品，采集可能失败' : ''
  }`;

  const list = $('#cartList');
  list.replaceChildren();

  data.items.forEach((item) => {
    const row = el('label', `cart-row${item.exists ? ' exists' : ''}`);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !item.exists; // 已在库的默认不勾，避免覆盖手改过的草稿
    box.dataset.offerId = item.offerId;
    row.appendChild(box);

    const main = el('span', 'c-main');
    main.appendChild(el('span', 'c-title', item.title || item.offerId));
    main.appendChild(el('span', 'c-id', item.offerId));
    row.appendChild(main);

    if (item.exists) row.appendChild(el('span', 'c-tag', '已在商品库'));

    list.appendChild(row);
  });

  $('#cartDialog').showModal();
}

function pickedCartIds() {
  return [...$('#cartList').querySelectorAll('input[type="checkbox"]')]
    .filter((box) => box.checked)
    .map((box) => box.dataset.offerId);
}

function applyJobs(jobs, stats) {
  state.jobs = jobs;
  state.stats = {
    active: stats?.active ?? 0,
    queued: stats?.queued ?? 0,
    running: stats?.running ?? 0
  };
  renderQueue();
  updateQueuePill();

  // 首次拿到队列快照时只做标记，避免一进页面就重复拉一次商品库
  if (!state.primed) {
    state.primed = true;
    jobs.forEach((job) => state.finishedSeen.add(job.id));
    return;
  }

  // 有新任务落库 → 刷新商品库（列表里的封面/价格才算得出来）
  let refreshed = false;
  jobs.forEach((job) => {
    if (job.status === 'succeeded' && !state.finishedSeen.has(job.id)) {
      state.finishedSeen.add(job.id);
      refreshed = true;
    }
    if (job.status === 'failed') state.finishedSeen.add(job.id);
  });
  if (refreshed) refreshProducts();
}

function updateQueuePill() {
  const pill = $('#queuePill');
  const active = state.stats.active ?? 0;
  pill.hidden = active === 0;
  pill.textContent = String(active);
}

function renderQueue() {
  const panel = $('#queuePanel');
  const list = $('#queueList');
  const jobs = state.jobs ?? [];

  if (!jobs.length) {
    panel.hidden = true;
    list.replaceChildren();
    $('#queueSummary').textContent = '';
    return;
  }

  panel.hidden = false;
  $('#queueSummary').textContent =
    state.stats.active > 0 ? `（进行中 ${state.stats.running}，排队 ${state.stats.queued}）` : '';

  list.replaceChildren();
  jobs.slice(0, 30).forEach((job) => list.appendChild(renderJobRow(job)));
}

function renderJobRow(job) {
  const row = el('div', `q-row ${job.status}`);
  row.appendChild(el('span', `q-status ${job.status}`, STATUS_TEXT[job.status] ?? job.status));

  const main = el('div', 'q-main');
  main.appendChild(el('p', 'q-title', job.title || job.url || job.offerId || '—'));

  const parts = [];
  if (job.status === 'failed') {
    parts.push(job.error || '失败');
  } else if (job.status === 'queued') {
    parts.push('等待前面的任务');
  } else if (job.stage) {
    parts.push(job.stage);
  }
  if (job.detail) parts.push(job.detail);
  const elapsed = elapsedOf(job);
  if (elapsed) parts.push(fmtDuration(elapsed));
  main.appendChild(el('p', 'q-sub', parts.join(' · ')));

  if (job.status === 'running' && job.progress?.total) {
    const bar = el('div', 'q-bar');
    const fill = el('i');
    const ratio = Math.min(1, job.progress.done / job.progress.total);
    fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.appendChild(fill);
    main.appendChild(bar);
  }
  row.appendChild(main);

  const actions = el('div', 'q-actions');
  if (job.status === 'succeeded' && job.offerId) {
    const view = el('button', 'mini', '查看');
    view.onclick = () => {
      location.hash = `#/products/${encodeURIComponent(job.offerId)}`;
    };
    actions.appendChild(view);
  }
  if (job.status === 'failed' || job.status === 'succeeded') {
    const again = el('button', 'mini', '重采');
    again.onclick = async () => {
      again.disabled = true;
      try {
        const data = await api(`/api/jobs/${job.id}/retry`, { method: 'POST', body: '{}' });
        if (data.ok) applyJobs(data.jobs ?? [], data);
        else toast(data.error || '重采失败');
      } catch (err) {
        toast(err.message);
      } finally {
        again.disabled = false;
      }
    };
    actions.appendChild(again);
  }
  row.appendChild(actions);

  return row;
}

async function pollJobs() {
  try {
    const data = await api('/api/jobs');
    applyJobs(data.jobs ?? [], data);
  } catch {
    /* 轮询失败不打扰用户，下一轮再试 */
  }
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const active = (state.stats?.active ?? 0) > 0;
  state.pollTimer = setTimeout(pollJobs, active ? 1200 : 5000);
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

$('#btnCollect').onclick = submitJobs;
$('#btnScanCart').onclick = scanCart;

$('#btnCartCancel').onclick = () => $('#cartDialog').close();

$('#btnCartConfirm').onclick = async () => {
  const ids = pickedCartIds();
  if (!ids.length) return toast('请至少勾选一个商品');

  const btn = $('#btnCartConfirm');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ urls: ids }) });
    if (!data.ok) throw new Error(data.error || '加入队列失败');
    toast(`已把 ${ids.length} 个商品加入采集队列`);
    $('#cartDialog').close();
    applyJobs(data.jobs ?? [], data);
    $('#queuePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始采集';
  }
};

$('#btnClear').onclick = () => {
  $('#urls').value = '';
  $('#progress').textContent = '';
};

$('#btnRefresh').onclick = async () => {
  await refreshProducts();
  await pollJobs();
};

$('#btnQueue').onclick = () => {
  if (location.hash !== '#/products') location.hash = '#/products';

  const panel = $('#queuePanel');
  if (panel.hidden) {
    toast('当前没有任务');
    return;
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

$('#btnClearJobs').onclick = async () => {
  try {
    const data = await api('/api/jobs/clear', { method: 'POST', body: '{}' });
    applyJobs(data.jobs ?? [], data);
  } catch (err) {
    toast(err.message);
  }
};

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
  copyText(state.current.draft?.title || '');
};

$('#btnCopyImages').onclick = () => {
  if (!state.current) return;
  const lines = state.assets.filter((a) => a.kind !== 'video').map((a) => a.localUrl || a.remoteUrl);
  copyText(lines.join('\n'));
};

$('#btnDelete').onclick = () => {
  if (!state.current) return;
  deleteOffer(state.current.offerId, { fromDetail: true });
};

$('#btnConfirmOk').onclick = () => settleConfirm(true);
$('#btnConfirmCancel').onclick = () => settleConfirm(false);
$('#confirmDialog').addEventListener('cancel', (event) => {
  // Esc 默认直接关掉 dialog，会留下悬空的 Promise，这里自己收尾
  event.preventDefault();
  settleConfirm(false);
});

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

  box.appendChild(el('h3', '', `已自动填 ${report.filled.length} 项`));
  const filledList = el('ul', 'pdd-list');
  report.filled.forEach((f) => filledList.appendChild(el('li', 'ok', `${f.field}：${f.value}`)));
  box.appendChild(filledList);

  box.appendChild(el('h3', '', `需人工处理 ${report.pending.length} 项`));
  const pendingList = el('ul', 'pdd-list');
  report.pending.forEach((p) => pendingList.appendChild(el('li', 'todo', p)));
  box.appendChild(pendingList);

  box.appendChild(el('p', 'hint', '浏览器已停在待提交页面，核对无误后请自己点「提交并上架」。'));
  $('#pddDialog').showModal();
}

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

/* ---------- 筛选与导出 ---------- */

$('#searchBox').oninput = () => {
  state.query = $('#searchBox').value;
  renderProducts();
};

$('#filterSelect').onchange = () => {
  state.filter = $('#filterSelect').value;
  renderProducts();
};

$('#sortSelect').onchange = () => {
  state.sort = $('#sortSelect').value;
  renderProducts();
};

$('#selectAll').onchange = () => {
  const on = $('#selectAll').checked;
  visibleProducts().forEach((item) => {
    if (on) state.selected.add(item.offerId);
    else state.selected.delete(item.offerId);
  });
  renderProducts();
};

$('#btnBatchClear').onclick = () => {
  state.selected.clear();
  renderProducts();
};

async function exportCsv(offerIds) {
  const res = await fetch('/api/export/csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(offerIds ? { offerIds } : {})
  });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'listing-desk.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

$('#btnExportCsv').onclick = () => exportCsv(null);

$('#btnBatchExport').onclick = () => {
  if (!state.selected.size) return;
  exportCsv([...state.selected]);
};

$('#btnBatchRecollect').onclick = async () => {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    // 采集入口接受商品 ID，和粘贴链接走同一条路径
    const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ urls: ids }) });
    if (!data.ok) throw new Error(data.error || '加入队列失败');
    toast(`已把 ${ids.length} 个商品加入重采队列`);
    applyJobs(data.jobs ?? [], data);
  } catch (err) {
    toast(err.message);
  }
};

$('#btnBatchDelete').onclick = async () => {
  const ids = [...state.selected];
  if (!ids.length) return;

  const confirmed = await confirmDialog({
    title: '批量删除',
    message: `将永久删除选中的 ${ids.length} 个商品及其本地文件（图片/视频副本、采集原始存档）。此操作不可恢复。`,
    confirmText: `删除 ${ids.length} 件`
  });
  if (!confirmed) return;

  const btn = $('#btnBatchDelete');
  btn.disabled = true;
  btn.textContent = '删除中…';

  let done = 0;
  const failed = [];
  for (const id of ids) {
    try {
      const data = await api(`/api/results/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!data.ok) throw new Error(data.error || '删除失败');
      done += 1;
      state.selected.delete(id);
    } catch {
      failed.push(id);
    }
  }

  btn.disabled = false;
  btn.textContent = '批量删除';
  toast(failed.length ? `已删除 ${done} 件，${failed.length} 件失败` : `已删除 ${done} 件`);
  await refreshProducts();
};

/* ---------- 启动 ---------- */

restorePddPrice();
refreshHealth();
refreshProducts();
pollJobs();
route();
window.addEventListener('hashchange', route);
setInterval(refreshHealth, 30000);
