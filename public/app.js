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
  selected: new Set(),
  // 当前详情商品的上架标记：{ pdd: {...}, douyin: {...} }
  marks: {},
  // 详情页展示图是否已展开全部（删除后重渲染保持状态）
  galleryExpanded: false,
  // SKU 列表排序：default | price-asc | price-desc
  skuSort: 'default'
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
  $('#detailPager').hidden = true;
  state.current = null;
  document.title = 'listing-desk · 商品库';
  window.scrollTo({ top: 0 });
}

async function openDetail(offerId) {
  state.galleryExpanded = false;
  $('#viewList').hidden = true;
  $('#viewDetail').hidden = false;
  $('#resultActions').hidden = true;
  $('#detailPager').hidden = true;
  window.scrollTo({ top: 0 });
  $('#detailTitle').textContent = `商品 ${offerId}`;
  $('#resultBody').replaceChildren(el('p', 'empty', '加载中…'));
  document.title = `listing-desk · ${offerId}`;

  try {
    const data = await api(`/api/results/${encodeURIComponent(offerId)}`);
    if (!data.record) throw new Error('未找到该商品');
    state.marks = data.marks ?? {};
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
    if (state.current) renderDetailPager(state.current.offerId);
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
    const marks = item.marks ?? {};
    if (state.filter === 'pdd-listed') return Boolean(marks.pdd);
    if (state.filter === 'pdd-not') return !marks.pdd;
    if (state.filter === 'dy-listed') return Boolean(marks.douyin);
    if (state.filter === 'dy-not') return !marks.douyin;
    if (state.filter === 'none-listed') return !marks.pdd && !marks.douyin;
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

  // 上架标记：已上架的平台显示小标签
  const marks = item.marks ?? {};
  const badges = PLATFORMS.filter((p) => marks[p.key]);
  if (badges.length) {
    const row = el('div', 'p-marks');
    badges.forEach((p) => row.appendChild(el('span', `p-mark p-mark-${p.key}`, `已上架 ${p.label}`)));
    body.appendChild(row);
  }

  card.appendChild(body);
  return card;
}

/* ---------- 上架标记 ---------- */

const PLATFORMS = [
  { key: 'pdd', label: '拼多多' },
  { key: 'douyin', label: '抖音' }
];

function renderMarksBar(marks, offerId) {
  const bar = $('#marksBar');
  bar.replaceChildren();
  bar.hidden = false;

  bar.appendChild(el('span', 'marks-label', '上架状态：'));

  for (const platform of PLATFORMS) {
    const marked = Boolean(marks?.[platform.key]);
    const chip = el('button', `mark-chip ${marked ? 'on' : 'off'}`, `${platform.label} ${marked ? '已上架' : '未上架'}`);
    chip.type = 'button';
    chip.title = marked ? '点击取消标记' : '点击标记为已上架';
    chip.onclick = async () => {
      chip.disabled = true;
      try {
        const data = await api('/api/marks', {
          method: 'POST',
          body: JSON.stringify({ offerId, platform: platform.key, marked: !marked })
        });
        state.marks = data.marks ?? {};
        renderMarksBar(state.marks, offerId);
        // 同步列表缓存，返回列表时标签立即正确
        const item = state.products.find((p) => p.offerId === offerId);
        if (item) item.marks = state.marks;
        toast(`${platform.label} 已标记为${marked ? '未上架' : '已上架'}`);
      } catch (err) {
        toast(`标记失败：${err.message}`);
        chip.disabled = false;
      }
    };
    bar.appendChild(chip);
  }
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
  main.appendChild(renderInfo(record, assets));
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
  renderMarksBar(state.marks ?? {}, record.offerId);
  renderDetailPager(record.offerId);
  updateFillPricePreview();
  document.title = `listing-desk · ${record.offerId}`;
}

function renderDetailPager(offerId) {
  const pager = $('#detailPager');
  const list = visibleProducts();
  const idx = list.findIndex((item) => item.offerId === offerId);
  if (idx < 0 || list.length <= 1) {
    pager.hidden = true;
    return;
  }

  pager.hidden = false;
  $('#detailPagerPos').textContent = `${idx + 1} / ${list.length}`;
  const prevBtn = $('#btnPrevProduct');
  const nextBtn = $('#btnNextProduct');
  prevBtn.disabled = idx === 0;
  nextBtn.disabled = idx === list.length - 1;
  prevBtn.onclick = () => {
    if (idx > 0) location.hash = `#/products/${encodeURIComponent(list[idx - 1].offerId)}`;
  };
  nextBtn.onclick = () => {
    if (idx < list.length - 1) location.hash = `#/products/${encodeURIComponent(list[idx + 1].offerId)}`;
  };
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
  const offerId = state.current?.offerId;

  const head = el('div', 'gallery-head');
  head.appendChild(el('h3', '', `${KIND_LABEL.main} ${mains.length} 张`));

  const tools = el('div', 'gallery-tools');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.onchange = () => {
    if (fileInput.files?.length && offerId) uploadGalleryFiles(offerId, fileInput.files, uploadBtn);
    fileInput.value = '';
  };

  const uploadBtn = el('button', 'btn ghost small', '上传图片');
  uploadBtn.type = 'button';
  uploadBtn.title = '选择或直接拖拽本地图片到此区域（支持 JPG/PNG/WebP/GIF）';
  uploadBtn.onclick = () => fileInput.click();
  tools.appendChild(fileInput);
  tools.appendChild(uploadBtn);

  const smalls = mains.filter((a) => a.status === 'ok' && a.width && a.height && (a.width < 480 || a.height < 480));
  if (smalls.length && offerId) {
    const cleanBtn = el('button', 'btn ghost small', `清理小图 (${smalls.length})`);
    cleanBtn.type = 'button';
    cleanBtn.title = '永久删除宽高小于 480px 的不合规展示图';
    cleanBtn.onclick = () => cleanSmallGalleryAssets(offerId, smalls.length, cleanBtn);
    tools.appendChild(cleanBtn);
  }

  head.appendChild(tools);
  wrap.appendChild(head);

  // 拖拽文件直接上传到展示图区域（与内部卡片排序拖拽通过 draggingAssetId 区分）
  let draggingAssetId = null;
  wrap.addEventListener('dragover', (event) => {
    if (draggingAssetId || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    wrap.classList.add('drag-over');
  });
  wrap.addEventListener('dragleave', (event) => {
    if (!wrap.contains(event.relatedTarget)) wrap.classList.remove('drag-over');
  });
  wrap.addEventListener('drop', (event) => {
    if (draggingAssetId || !event.dataTransfer?.files?.length || !offerId) return;
    event.preventDefault();
    wrap.classList.remove('drag-over');
    uploadGalleryFiles(offerId, event.dataTransfer.files, uploadBtn);
  });

  if (!mains.length) {
    wrap.appendChild(el('p', 'empty', '该商品没有主图，可直接点击或拖入图片上传'));
    return wrap;
  }

  const orderedIds = mains.map((a) => a.id);
  const grid = el('div', 'gallery-grid');
  const bindCardOrder = (card, asset, idx) => {
    card.draggable = mains.length > 1;
    card.addEventListener('dragstart', (event) => {
      draggingAssetId = asset.id;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(asset.id));
    });
    card.addEventListener('dragend', () => {
      draggingAssetId = null;
      card.classList.remove('dragging');
      grid.querySelectorAll('.drag-target').forEach((n) => n.classList.remove('drag-target'));
    });
    card.addEventListener('dragover', (event) => {
      if (!draggingAssetId || draggingAssetId === asset.id) return;
      event.preventDefault();
      card.classList.add('drag-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-target'));
    card.addEventListener('drop', (event) => {
      if (!draggingAssetId || draggingAssetId === asset.id || !offerId) return;
      event.preventDefault();
      event.stopPropagation();
      card.classList.remove('drag-target');
      const fromIdx = orderedIds.indexOf(draggingAssetId);
      const toIdx = orderedIds.indexOf(asset.id);
      if (fromIdx < 0 || toIdx < 0) return;
      const next = [...orderedIds];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      saveGalleryOrder(offerId, next);
    });
    return card;
  };

  const showAll = state.galleryExpanded || mains.length <= GALLERY_LIMIT;
  const shown = showAll ? mains : mains.slice(0, GALLERY_LIMIT);
  shown.forEach((a, i) => grid.appendChild(bindCardOrder(renderAsset(a, 'gallery', { index: i, total: mains.length, orderedIds }), a, i)));
  wrap.appendChild(grid);

  // 1688 主图动辄几十张，先铺一屏，剩下的点了再展开
  if (!showAll) {
    const rest = mains.slice(GALLERY_LIMIT);
    const more = el('button', 'btn ghost small gallery-more', `展开其余 ${rest.length} 张`);
    more.onclick = () => {
      state.galleryExpanded = true;
      rest.forEach((a, i) => {
        const idx = GALLERY_LIMIT + i;
        grid.appendChild(bindCardOrder(renderAsset(a, 'gallery', { index: idx, total: mains.length, orderedIds }), a, idx));
      });
      more.remove();
    };
    wrap.appendChild(more);
  }

  return wrap;
}

function normSpecPair(prop, name) {
  const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
  return `${clean(prop)}=${clean(name)}`;
}

function findSkuAsset(sku, assets) {
  const skuAssets = (assets ?? []).filter((a) => a.kind === 'sku');
  if (!skuAssets.length) return null;
  if (sku?.image) {
    const byUrl = skuAssets.find((a) => a.remoteUrl === sku.image);
    if (byUrl) return byUrl;
  }
  const pairs = new Set(Object.entries(sku?.specs ?? {}).map(([k, v]) => normSpecPair(k, v)));
  if (!pairs.size) return null;
  return (
    skuAssets.find((a) =>
      String(a.label ?? '')
        .split(';')
        .some((entry) => {
          const idx = entry.indexOf('=');
          return idx > 0 && pairs.has(normSpecPair(entry.slice(0, idx), entry.slice(idx + 1)));
        })
    ) ?? null
  );
}

const SKU_SORT_OPTIONS = [
  { key: 'default', label: '默认顺序' },
  { key: 'price-asc', label: '价格 ↑' },
  { key: 'price-desc', label: '价格 ↓' }
];

function sortSkus(skus, mode) {
  if (mode === 'default') return skus;
  const dir = mode === 'price-asc' ? 1 : -1;
  const priceOf = (s) => {
    const n = Number(s?.price);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return [...skus].sort((a, b) => {
    const pa = priceOf(a);
    const pb = priceOf(b);
    if (pa === null && pb === null) return 0;
    if (pa === null) return 1;
    if (pb === null) return -1;
    return (pa - pb) * dir;
  });
}

function renderSkuRows(container, skus, record, assets) {
  container.replaceChildren();
  sortSkus(skus, state.skuSort).forEach((sku, index) => {
    const row = el('div', 'sku-row');
    const matched = findSkuAsset(sku, assets);
    const thumbSrc = matched?.localUrl || matched?.remoteUrl || sku.image;
    if (thumbSrc) {
      const img = document.createElement('img');
      img.className = 'sku-thumb';
      img.src = thumbSrc;
      img.loading = 'lazy';
      img.alt = '';
      if (matched) {
        img.title = '点击查看规格图';
        img.onclick = () => openLightbox(matched);
      }
      row.appendChild(img);
    }

    const main = el('div', 'sku-main');
    const specs = Object.entries(sku.specs || {}).map(([k, v]) => `${k}:${v}`).join(' / ');
    main.appendChild(el('div', 'sku-specs', specs || `默认 SKU ${index + 1}`));
    main.appendChild(el('div', 'sku-sub', `¥${sku.price ?? '-'} · 库存 ${sku.stock ?? '-'}`));
    row.appendChild(main);

    if (sku.skuId) {
      const del = el('button', 'mini sku-del', '删除');
      del.type = 'button';
      del.title = '删除该 SKU（若对应规格图已无其它 SKU 使用，将同步真删除）';
      del.onclick = () => deleteSkuItem(record.offerId, sku.skuId, del);
      row.appendChild(del);
    }

    container.appendChild(row);
  });
}

function renderInfo(record, assets = []) {
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

  const skuBox = document.createElement('details');
  skuBox.open = true;
  skuBox.appendChild(el('summary', '', `SKU 规格 (${skus.length} 个)`));
  if (!skus.length) {
    skuBox.appendChild(el('p', 'hint', '当前没有 SKU 规格，自动填表将按单品处理。'));
  } else {
    const list = el('div', 'sku-list');
    if (skus.length > 1) {
      const toolbar = el('div', 'sku-toolbar');
      toolbar.appendChild(el('span', 'sku-sort-label', '排序'));
      SKU_SORT_OPTIONS.forEach((opt) => {
        const btn = el('button', `mini sku-sort-btn${state.skuSort === opt.key ? ' active' : ''}`, opt.label);
        btn.type = 'button';
        btn.onclick = () => {
          state.skuSort = opt.key;
          toolbar.querySelectorAll('.sku-sort-btn').forEach((node, idx) => {
            node.classList.toggle('active', SKU_SORT_OPTIONS[idx].key === opt.key);
          });
          renderSkuRows(list, skus, record, assets);
        };
        toolbar.appendChild(btn);
      });
      skuBox.appendChild(toolbar);
    }
    renderSkuRows(list, skus, record, assets);
    skuBox.appendChild(list);
  }
  side.appendChild(skuBox);

  if (record.product?.attributes?.length) {
    const box = document.createElement('details');
    box.open = false;
    box.appendChild(el('summary', '', `商品属性 (${record.product.attributes.length} 项)`));

    const grid = el('div', 'kv');
    record.product.attributes.forEach((attr) => {
      const item = el('div');
      item.appendChild(el('span', '', attr.name));
      item.appendChild(el('strong', '', attr.value));
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
  const productTitle = textInput('editProductTitle', record.product?.title ?? '');
  const productTitleField = field('', productTitle, true);
  const productTitleLabel = productTitleField.querySelector('span');
  const syncZhCount = () => {
    const len = productTitle.value.trim().length;
    productTitleLabel.textContent = `中文原标题（拼多多 / 抖店填表用，当前 ${len} 字，建议 ≤ 30）`;
  };
  syncZhCount();
  productTitle.oninput = syncZhCount;

  const title = textInput('editTitle', draft.title ?? '');
  const price = numberInput('editPrice', draft.price, { step: '0.01' });
  const stock = numberInput('editStock', draft.available_quantity);
  const category = textInput('editCategory', draft.category_id ?? '', '例如 MLM158455');
  const weight = numberInput('editWeight', draft.package?.weight_g);

  grid.appendChild(productTitleField);
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
          product_title: productTitle.value,
          title: title.value,
          price: price.value === '' ? null : Number(price.value),
          available_quantity: stock.value === '' ? null : Number(stock.value),
          category_id: category.value,
          weight_g: weight.value === '' ? null : Number(weight.value)
        })
      });
      if (!data.ok) throw new Error(data.error || '保存失败');

      applyDetailPayload(data);
      toast('草稿已保存');
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

function galleryQualityBadge(asset) {
  if (asset.kind !== 'main' || !asset.width || !asset.height) return null;
  if (asset.width < 480 || asset.height < 480) {
    const tag = el('span', 'badge bad', '过小');
    tag.title = '宽高需大于 480px（抖店 ≥ 600px），自动填表会被跳过';
    return tag;
  }
  if (asset.width < 600 || asset.height < 600) {
    const tag = el('span', 'badge warn', '<600');
    tag.title = '拼多多可用，抖店要求 ≥ 600×600';
    return tag;
  }
  const ratio = asset.width / asset.height;
  if (Math.abs(ratio - 1) > 0.03 && Math.abs(ratio - 0.75) > 0.03) {
    const tag = el('span', 'badge warn', '非1:1/3:4');
    tag.title = '拼多多轮播图仅支持 1:1 或 3:4，自动填表会被跳过';
    return tag;
  }
  return null;
}

function renderAsset(asset, variant = '', galleryMeta = null) {
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
    img.title = '点击查看大图';
    img.onerror = () => img.classList.add('broken');
    img.onclick = () => openLightbox(asset);
    box.appendChild(img);
  }

  if (variant === 'gallery' && galleryMeta?.index === 0) {
    box.appendChild(el('span', 'asset-cover-tag', '首图'));
  }

  if (['main', 'detail', 'sku'].includes(asset.kind)) {
    const del = el('button', 'asset-del', '删除');
    del.type = 'button';
    del.title = `永久删除这张${KIND_LABEL[asset.kind] || '图片'}（含本地文件）`;
    del.onclick = () => deleteAssetItem(asset, del);
    box.appendChild(del);
  }

  const meta = el('div', 'asset-meta');
  meta.appendChild(
    el(
      'span',
      `badge ${asset.status === 'ok' ? 'ok' : asset.status === 'failed' ? 'bad' : ''}`,
      asset.status === 'ok' ? '本地' : asset.status === 'failed' ? '失败' : '待下载'
    )
  );

  const qBadge = galleryQualityBadge(asset);
  if (qBadge) meta.appendChild(qBadge);

  if (asset.localUrl) {
    const a = document.createElement('a');
    a.href = asset.localUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '本地';
    meta.appendChild(a);
  }

  if (asset.remoteUrl && !asset.remoteUrl.startsWith('local://')) {
    const remote = document.createElement('a');
    remote.href = asset.remoteUrl;
    remote.target = '_blank';
    remote.rel = 'noopener';
    remote.textContent = '远程';
    meta.appendChild(remote);
  }

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

  if (asset.width && asset.height) meta.appendChild(el('span', 'sz', `${asset.width}×${asset.height}`));
  if (asset.bytes) meta.appendChild(el('span', 'sz', fmtBytes(asset.bytes)));
  if (asset.label) meta.title = asset.label;

  box.appendChild(meta);

  if (variant === 'gallery' && galleryMeta && galleryMeta.total > 1) {
    const { index, total, orderedIds } = galleryMeta;
    const offerId = state.current?.offerId;
    const orderRow = el('div', 'asset-order');

    const move = (targetIndex) => {
      if (!offerId || targetIndex < 0 || targetIndex >= total) return;
      const next = [...orderedIds];
      const [picked] = next.splice(index, 1);
      next.splice(targetIndex, 0, picked);
      saveGalleryOrder(offerId, next);
    };

    const leftBtn = el('button', 'mini', '←');
    leftBtn.type = 'button';
    leftBtn.title = '前移一张';
    leftBtn.disabled = index === 0;
    leftBtn.onclick = () => move(index - 1);
    orderRow.appendChild(leftBtn);

    if (index > 0) {
      const topBtn = el('button', 'mini', '首图');
      topBtn.type = 'button';
      topBtn.title = '设为第一张展示图与列表封面';
      topBtn.onclick = () => move(0);
      orderRow.appendChild(topBtn);
    }

    const rightBtn = el('button', 'mini', '→');
    rightBtn.type = 'button';
    rightBtn.title = '后移一张';
    rightBtn.disabled = index === total - 1;
    rightBtn.onclick = () => move(index + 1);
    orderRow.appendChild(rightBtn);

    box.appendChild(orderRow);
  }

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
    const variant = kind === 'detail' ? 'detail-item' : '';
    list.forEach((a) => grid.appendChild(renderAsset(a, variant)));
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

function applyDetailPayload(data, fallbackAssets = state.assets) {
  const keepY = window.scrollY;
  renderDetail(data.record ?? state.current, data.assets ?? fallbackAssets);
  window.scrollTo({ top: keepY });
  refreshProducts();
}

async function deleteSkuItem(offerId, skuId, btn = null) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '删除中…';
  }
  try {
    const data = await api(`/api/results/${encodeURIComponent(offerId)}/skus/${encodeURIComponent(skuId)}`, {
      method: 'DELETE'
    });
    if (!data.ok) throw new Error(data.error || '删除失败');
    applyDetailPayload(data);
    toast(data.removedAssets ? `已删除 SKU（同时真删除 ${data.removedAssets} 张配套规格图）` : '已删除 SKU');
    return data;
  } catch (err) {
    toast(`删除 SKU 失败：${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '删除';
    }
    return null;
  }
}

async function deleteAssetItem(asset, btn = null) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '删除中…';
  }
  try {
    const data = await api(`/api/assets/${asset.id}`, { method: 'DELETE' });
    if (!data.ok) throw new Error(data.error || '删除失败');
    applyDetailPayload(data, state.assets.filter((a) => a.id !== asset.id));
    toast(`已删除${KIND_LABEL[asset.kind] || '图片'}`);
    return data;
  } catch (err) {
    toast(`删除失败：${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '删除';
    }
    return null;
  }
}

async function saveGalleryOrder(offerId, orderedIds) {
  try {
    const data = await api(`/api/results/${encodeURIComponent(offerId)}/assets/order`, {
      method: 'PATCH',
      body: JSON.stringify({ orderedIds })
    });
    if (!data.ok) throw new Error(data.error || '排序失败');
    applyDetailPayload(data);
    toast('展示图顺序已更新');
    return data;
  } catch (err) {
    toast(`调整顺序失败：${err.message}`);
    return null;
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

async function uploadGalleryFiles(offerId, fileList, btn = null) {
  const valid = [...fileList].filter((f) => /^image\/(jpeg|png|webp|gif)$/i.test(f.type));
  if (!valid.length) return toast('请上传 JPG/PNG/WebP/GIF 图片');
  if (valid.length > 20) return toast('单次最多上传 20 张图片');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '上传中…';
  }
  try {
    const files = await Promise.all(valid.map(async (f) => ({ name: f.name, dataUrl: await fileToDataUrl(f) })));
    const data = await api(`/api/results/${encodeURIComponent(offerId)}/assets/upload`, {
      method: 'POST',
      body: JSON.stringify({ files })
    });
    if (!data.ok) throw new Error(data.error || '上传失败');
    applyDetailPayload(data);
    toast(`已上传 ${data.uploaded ?? files.length} 张展示图`);
  } catch (err) {
    toast(`上传失败：${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '上传图片';
    }
  }
}

async function cleanSmallGalleryAssets(offerId, count, btn = null) {
  const confirmed = await confirmDialog({
    title: '清理不合规小图',
    message: `检测到 ${count} 张宽或高小于 480px 的展示图，确认永久删除这些图片及其本地文件？`,
    confirmText: `删除 ${count} 张`
  });
  if (!confirmed) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = '清理中…';
  }
  try {
    const data = await api(`/api/results/${encodeURIComponent(offerId)}/assets/clean-small`, {
      method: 'POST',
      body: JSON.stringify({ minSide: 480 })
    });
    if (!data.ok) throw new Error(data.error || '清理失败');
    applyDetailPayload(data);
    toast(`已清理 ${data.removedCount ?? 0} 张小图`);
  } catch (err) {
    toast(`清理失败：${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = `清理小图 (${count})`;
    }
  }
}

/* ---------- 大图灯箱 ---------- */

let lightbox = { list: [], index: 0 };

function openLightbox(asset) {
  const list = state.assets.filter((a) => a.kind === asset.kind && a.kind !== 'video');
  const index = Math.max(0, list.findIndex((a) => a.id === asset.id));
  lightbox = { list, index };
  renderLightbox();
  const dialog = $('#lightboxDialog');
  if (!dialog.open) dialog.showModal();
}

function renderLightbox() {
  const item = lightbox.list[lightbox.index];
  if (!item) {
    const dialog = $('#lightboxDialog');
    if (dialog.open) dialog.close();
    return;
  }

  const label = KIND_LABEL[item.kind] || '图片';
  $('#lightboxTitle').textContent = `${label} ${lightbox.index + 1} / ${lightbox.list.length}`;
  $('#lightboxImg').src = item.localUrl || item.remoteUrl;
  $('#btnLightboxPrev').disabled = lightbox.index <= 0;
  $('#btnLightboxNext').disabled = lightbox.index >= lightbox.list.length - 1;

  const canTop = item.kind === 'main' && lightbox.index > 0;
  const canDel = ['main', 'detail', 'sku'].includes(item.kind);
  $('#btnLightboxTop').hidden = !canTop;
  $('#btnLightboxDelete').hidden = !canDel;

  const meta = $('#lightboxMeta');
  meta.replaceChildren();
  if (item.width && item.height) meta.appendChild(el('span', '', `尺寸 ${item.width}×${item.height}`));
  if (item.bytes) meta.appendChild(el('span', '', `大小 ${fmtBytes(item.bytes)}`));
  if (item.label) meta.appendChild(el('span', '', item.label));
  const qBadge = galleryQualityBadge(item);
  if (qBadge) meta.appendChild(qBadge);
  if (item.remoteUrl && !item.remoteUrl.startsWith('local://')) {
    const a = document.createElement('a');
    a.href = item.remoteUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '查看原链接';
    meta.appendChild(a);
  }
}

$('#btnLightboxClose').onclick = () => $('#lightboxDialog').close();
$('#btnLightboxPrev').onclick = () => {
  if (lightbox.index > 0) {
    lightbox.index -= 1;
    renderLightbox();
  }
};
$('#btnLightboxNext').onclick = () => {
  if (lightbox.index < lightbox.list.length - 1) {
    lightbox.index += 1;
    renderLightbox();
  }
};
$('#btnLightboxTop').onclick = async () => {
  const item = lightbox.list[lightbox.index];
  const offerId = state.current?.offerId;
  if (!item || !offerId) return;
  const ids = lightbox.list.map((a) => a.id).filter((id) => id !== item.id);
  const data = await saveGalleryOrder(offerId, [item.id, ...ids]);
  if (data) {
    lightbox.list = (data.assets ?? state.assets).filter((a) => a.kind === 'main');
    lightbox.index = 0;
    renderLightbox();
  }
};
$('#btnLightboxDelete').onclick = async () => {
  const item = lightbox.list[lightbox.index];
  if (!item) return;
  const btn = $('#btnLightboxDelete');
  const data = await deleteAssetItem(item, btn);
  btn.disabled = false;
  btn.textContent = '删除';
  if (!data) return;
  lightbox.list = (data.assets ?? state.assets).filter((a) => a.kind === item.kind);
  if (lightbox.index >= lightbox.list.length) lightbox.index = Math.max(0, lightbox.list.length - 1);
  renderLightbox();
};
$('#lightboxDialog').addEventListener('click', (event) => {
  if (event.target === $('#lightboxDialog')) $('#lightboxDialog').close();
});
$('#lightboxDialog').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    $('#btnLightboxPrev').click();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    $('#btnLightboxNext').click();
  } else if (event.key === 'Delete' && !$('#btnLightboxDelete').hidden) {
    event.preventDefault();
    $('#btnLightboxDelete').click();
  }
});

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

/* ---------- 登录态快照 ---------- */

async function loadAuthSnapshot() {
  const node = $('#authSnapshotInfo');
  try {
    const data = await api('/api/auth/snapshot');
    if (data.restore && data.restore.restored) {
      node.textContent = `已自动套用随包快照（${data.restore.cookieCount} 条 cookie），无需重新登录。`;
      return;
    }
    if (!data.exists) {
      node.textContent =
        '还没有备份。点「备份登录态」把当前 1688 会话存成文件；这个文件会跟着便携包一起发给同事，对方首次打开自动套用。';
      return;
    }
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : new Date(data.mtime).toLocaleString();
    const size = `${Math.round((data.bytes ?? 0) / 1024)} KB`;
    const body = data.encrypted ? '已加密' : `${data.cookieCount ?? 0} 条 cookie`;
    node.textContent = `快照：${when} · ${size} · ${body}${data.valid === false ? ' · 文件已损坏' : ''}`;
  } catch (err) {
    node.textContent = `读取失败：${err.message}`;
  }
}

$('#btnAuthExport').onclick = async () => {
  toast('正在备份登录态…');
  try {
    const r = await api('/api/auth/export', { method: 'POST', body: '{}' });
    toast(r.ok ? `已备份 ${r.cookieCount} 条 cookie` : `备份失败：${r.error}`);
    loadAuthSnapshot();
  } catch (err) {
    toast(`备份失败：${err.message}`);
  }
};

$('#btnAuthDownload').onclick = () => {
  window.open('/api/auth/snapshot/download', '_blank');
};

$('#btnAuthImport').onclick = async () => {
  toast('正在套用快照…');
  try {
    const r = await api('/api/auth/import', { method: 'POST', body: '{}' });
    toast(r.ok ? `已恢复 ${r.cookieCount} 条 cookie` : `恢复失败：${r.error}`);
    setTimeout(refreshHealth, 800);
    loadAuthSnapshot();
  } catch (err) {
    toast(`恢复失败：${err.message}`);
  }
};

$('#btnAuthProbe').onclick = async () => {
  toast('正在打开购物车页实测…');
  try {
    const r = await api('/api/auth/probe', { method: 'POST', body: '{}' });
    if (r.ok && r.loggedIn) toast('登录有效');
    else toast(`登录已失效${r.reason ? `：${r.reason}` : ''}${r.error ? `：${r.error}` : ''}`);
    refreshHealth();
  } catch (err) {
    toast(`检查失败：${err.message}`);
  }
};

$('#btnSettings').onclick = async () => {
  const cfg = state.config ?? (await api('/api/settings'));
  state.config = cfg;
  fillSettings(cfg);
  loadAuthSnapshot();
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
  $('#fillDialogTitle').textContent = '拼多多填表结果';
  $('#pddSummary').textContent = [
    `类目：${report.category || '未识别'}`,
    `标题：${report.title}`,
    report.prices
      ? `拼单价 ${report.prices.group} / 单买价 ${report.prices.single} / 参考价 ${report.prices.reference}（${
          report.prices.mode === 'add'
            ? `成本+${report.prices.groupAdd} / 单买成本+${report.prices.singleAdd}`
            : `成本×${report.prices.markup}`
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

/* ---------- 自动填表：平台与加价设置 ---------- */

const FILL_PRICE_KEY = 'listing-desk.fillPrice';

const FILL_DEFAULTS = {
  platform: 'pdd',
  groupAdd: '5',
  singleAdd: '8',
  dyMode: 'markup',
  dyMarkup: '1.6',
  dyAdd: '5'
};

/** 抖音两种加价方式各记一个值，切换下拉时互不覆盖 */
let dyValues = { markup: FILL_DEFAULTS.dyMarkup, add: FILL_DEFAULTS.dyAdd };

const dyPriceMode = () => ($('#dyPriceMode').value === 'add' ? 'add' : 'markup');

function loadFillPrice() {
  try {
    return { ...FILL_DEFAULTS, ...(JSON.parse(localStorage.getItem(FILL_PRICE_KEY) ?? 'null') ?? {}) };
  } catch {
    return { ...FILL_DEFAULTS };
  }
}

function saveFillPrice() {
  const mode = dyPriceMode();
  dyValues[mode] = $('#dyPriceValue').value;
  localStorage.setItem(
    FILL_PRICE_KEY,
    JSON.stringify({
      platform: $('#fillPlatform').value,
      groupAdd: $('#pddGroupAdd').value,
      singleAdd: $('#pddSingleAdd').value,
      dyMode: mode,
      dyMarkup: dyValues.markup,
      dyAdd: dyValues.add
    })
  );
}

function round2(n) {
  return Number(Number(n).toFixed(2));
}

function fitPriceEnding(value, ending = '.9') {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const e = Number.parseFloat(ending);
  const safe = Number.isFinite(e) ? e : 0.9;
  return Number((Math.max(1, Math.floor(num)) + safe).toFixed(2));
}

function updateFillPricePreview() {
  const box = $('#fillPricePreview');
  if (!box) return;
  if (!state.current) {
    box.textContent = '';
    return;
  }
  const cost = Number(state.current.product?.price?.min);
  if (!Number.isFinite(cost) || cost <= 0) {
    box.textContent = '未采集到成本价';
    return;
  }

  if ($('#fillPlatform').value === 'pdd') {
    const gAdd = Number($('#pddGroupAdd').value);
    const sAdd = Number($('#pddSingleAdd').value);
    if (!Number.isFinite(gAdd) || gAdd < 0 || !Number.isFinite(sAdd) || sAdd < 0) {
      box.textContent = `成本 ¥${cost}`;
      return;
    }
    const group = round2(cost + gAdd);
    const single = round2(Math.max(group + 1, cost + sAdd));
    box.textContent = `成本 ¥${cost} → 拼单 ¥${group} / 单买 ¥${single}`;
    return;
  }

  const mode = dyPriceMode();
  const val = Number($('#dyPriceValue').value);
  if (!Number.isFinite(val) || (mode === 'add' ? val < 0 : val <= 0)) {
    box.textContent = `成本 ¥${cost}`;
    return;
  }
  const sale = mode === 'add' ? round2(cost + val) : fitPriceEnding(cost * val, '.9');
  const ref = fitPriceEnding(Math.max(sale * 1.4, sale + 5), '.9');
  box.textContent = `成本 ¥${cost} → 售卖 ¥${sale} / 参考 ¥${ref}`;
}

/** 加价区随平台切换：拼多多两档金额（没有倍率），抖音只给售卖价，加价方式下拉里二选一 */
function syncFillPriceFields() {
  const isPdd = $('#fillPlatform').value === 'pdd';
  const mode = dyPriceMode();
  $('#fillPddGroup').hidden = !isPdd;
  $('#fillPddSingle').hidden = !isPdd;
  $('#fillDyPrice').hidden = isPdd;

  const isAdd = mode === 'add';
  $('#dyPriceLabel').textContent = isAdd ? '加价金额' : '加价倍数';
  const input = $('#dyPriceValue');
  input.step = isAdd ? '0.1' : '0.05';
  input.min = isAdd ? '0' : '1';
  input.title = isAdd ? '售卖价 = 成本价 + 该金额（元），按实填不凑尾数' : '售卖价 = 成本价 × 该倍数，价格尾数凑 .9';
  updateFillPricePreview();
}

function restoreFillSettings() {
  const saved = loadFillPrice();
  $('#fillPlatform').value = saved.platform === 'douyin' ? 'douyin' : 'pdd';
  $('#pddGroupAdd').value = saved.groupAdd;
  $('#pddSingleAdd').value = saved.singleAdd;
  dyValues = { markup: String(saved.dyMarkup), add: String(saved.dyAdd) };
  $('#dyPriceMode').value = saved.dyMode === 'add' ? 'add' : 'markup';
  $('#dyPriceValue').value = dyValues[dyPriceMode()];
  syncFillPriceFields();
}

$('#fillPlatform').onchange = () => {
  syncFillPriceFields();
  saveFillPrice();
};

$('#dyPriceMode').onchange = () => {
  $('#dyPriceValue').value = dyValues[dyPriceMode()];
  syncFillPriceFields();
  saveFillPrice();
};

['#pddGroupAdd', '#pddSingleAdd', '#dyPriceValue'].forEach((sel) => {
  $(sel).oninput = () => updateFillPricePreview();
  $(sel).onchange = () => {
    saveFillPrice();
    updateFillPricePreview();
  };
});

$('#btnAutoFill').onclick = async () => {
  if (!state.current) return;

  const platform = $('#fillPlatform').value;
  let rules;
  let endpoint;
  let failLabel;

  if (platform === 'pdd') {
    const groupAdd = Number($('#pddGroupAdd').value);
    const singleAdd = Number($('#pddSingleAdd').value);
    if (!Number.isFinite(groupAdd) || groupAdd < 0) return toast('「拼单价+」请填 0 或正数');
    if (!Number.isFinite(singleAdd) || singleAdd < 0) return toast('「单买价+」请填 0 或正数');
    rules = { priceMode: 'add', groupAdd, singleAdd };
    endpoint = '/api/pdd/fill';
    failLabel = '拼多多填表';
  } else {
    const mode = dyPriceMode();
    const value = Number($('#dyPriceValue').value);
    if (!Number.isFinite(value)) return toast(mode === 'add' ? '「加价金额」请填数字' : '「加价倍数」请填数字');
    if (mode === 'add') {
      if (value < 0) return toast('「加价金额」请填 0 或正数');
      // 单买加价：售卖价 = 成本 + 金额；SKU 行按同一口径，两档金额都传
      rules = { priceMode: 'add', groupAdd: value, singleAdd: value, addAmount: value };
    } else {
      if (value <= 0) return toast('加价倍数请填大于 0 的数');
      rules = { priceMode: 'markup', markup: value };
    }
    endpoint = '/api/dy/fill';
    failLabel = '抖音填表';
  }

  saveFillPrice();

  const btn = $('#btnAutoFill');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '填表中…';
  try {
    const data = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({ offerId: state.current.offerId, rules })
    });
    if (!data.ok) throw new Error(data.error || '填表失败');
    if (data.marks) {
      state.marks = data.marks;
      renderMarksBar(state.marks, state.current.offerId);
      const item = state.products.find((p) => p.offerId === state.current.offerId);
      if (item) item.marks = data.marks;
    }
    if (platform === 'pdd') showPddReport(data);
    else showDyReport(data);
  } catch (err) {
    toast(`${failLabel}失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

$('#btnPddClose').onclick = () => $('#pddDialog').close();

/* ---------- 抖音（抖店）填表 ---------- */

function showDyReport(report) {
  $('#fillDialogTitle').textContent = '抖音填表结果';
  $('#pddSummary').textContent = [
    `标题：${report.title}`,
    report.prices
      ? `售卖价 ${report.prices.sale} / 参考价 ${report.prices.ref}（${
          report.prices.mode === 'add'
            ? `成本+${report.prices.singleAdd}`
            : `成本×${report.prices.markup}`
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

  box.appendChild(el('p', 'hint', '浏览器已停在抖店发布页，核对后自己点「发布商品」或「保存草稿」。'));
  $('#pddDialog').showModal();
}

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

restoreFillSettings();
refreshHealth();
refreshProducts();
pollJobs();
route();
window.addEventListener('hashchange', route);
setInterval(refreshHealth, 30000);
