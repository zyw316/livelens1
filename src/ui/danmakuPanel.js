/** ui/danmakuPanel.js —— 实时弹幕流（搜索、分类筛选、问题簇筛选、噪声显隐、15 秒滚动窗口、悬停暂停） */
import { byId, delegate, escapeHtml, formatTime, setText, toggleClass } from './dom.js?v=20261023f';
import { CATEGORY_MAP } from '../core/constants.js?v=20261023f';

/** 主动筛选（搜索/分类/问题簇）或悬停暂停时的兜底渲染条数 */
const MAX_RENDER = 150;

/**
 * 实时弹幕流「滚动窗口」参数（P0 问题生命周期管理）。
 *
 * 铁律：只裁剪视图，绝不清 store 里的数据 —— 分类排名、关注榜、告警全靠
 * 累积数据，清数据会让刚成型的实时排名每 15 秒归零。
 *
 * 混合封顶逻辑：
 *   - 窗口期：只展示最近 STREAM_WINDOW_MS 毫秒的弹幕，防止实时流冗杂；
 *   - 保底：窗口内不足 STREAM_WINDOW_MIN 条时保留最近这么多条，避免面板全空；
 *   - 封顶：最多 STREAM_WINDOW_MAX 条，防突发洪流冲爆面板。
 */
export const STREAM_WINDOW_MS = 15000;
export const STREAM_WINDOW_MIN = 5;
export const STREAM_WINDOW_MAX = 60;

/**
 * 纯函数：从筛选链结果计算「本帧应渲染的弹幕」，返回最新在上。
 * 不修改入参 —— store 数据一个字节都不会动。
 *
 * @param {Array}  filtered 筛选链（噪声→分类→问题簇→搜索）后的弹幕，时间正序
 * @param {number} [now]    当前时间戳（ms）
 * @param {object} [opts]
 * @param {boolean} opts.hovering     鼠标悬停中 → 暂停时间裁剪（主播正在读的弹幕不许消失）
 * @param {boolean} opts.filterActive 主动筛选中 → 不按时间裁剪，避免搜索结果被时间窗口藏掉
 * @returns {Array} 按渲染顺序（最新在上）排列的弹幕
 */
export function computeVisibleWindow(filtered, now = Date.now(), opts = {}) {
  const { hovering = false, filterActive = false } = opts;
  if (hovering || filterActive) return filtered.slice(-MAX_RENDER).reverse();
  const cutoff = now - STREAM_WINDOW_MS;
  let visible = filtered.filter((it) => it.timestamp >= cutoff);
  if (visible.length < STREAM_WINDOW_MIN) visible = filtered.slice(-STREAM_WINDOW_MIN);
  if (visible.length > STREAM_WINDOW_MAX) visible = visible.slice(-STREAM_WINDOW_MAX);
  return visible.reverse();
}

export function mountDanmakuPanel(app) {
  const listEl = byId('danmaku-list');
  const emptyEl = byId('danmaku-empty');
  const searchInput = byId('search-input');
  const statusEl = byId('stream-status');
  const countEl = byId('stream-count');
  const noteEl = byId('filter-note');
  const pausedEl = byId('stream-paused');
  const streamBodyEl = listEl.parentElement; // .card-body-scroll：悬停暂停的感应区域

  let timer = null;
  /** 鼠标悬停在弹幕流上 → 暂停滚动窗口：主播正在读的弹幕不许因过期消失 */
  let hovering = false;
  /** 上一帧渲染签名；相同则跳过重绘，避免每秒定时器造成无谓重排 */
  let lastSignature = '';

  searchInput.addEventListener('input', (e) => {
    if (timer) clearTimeout(timer);
    const value = e.target.value;
    timer = setTimeout(() => app.setUi('search', value.trim()), 200);
  });

  delegate(noteEl, '[data-clear]', 'click', (event, el) => {
    const clear = el.dataset.clear;
    if (clear === 'category') app.getActions().selectCategory(app.getState().ui.selectedCategory);
    if (clear === 'cluster') app.getActions().selectCluster(app.getState().ui.selectedClusterId);
  });

  // —— 悬停暂停：进入暂停并立即重绘一帧；移开立即恢复并按窗口重新裁剪 ——
  streamBodyEl.addEventListener('mouseenter', () => {
    hovering = true;
    toggleClass(pausedEl, 'hidden', false);
    render(app.getState());
  });
  streamBodyEl.addEventListener('mouseleave', () => {
    hovering = false;
    toggleClass(pausedEl, 'hidden', true);
    render(app.getState());
  });

  // —— 每秒 tick：没有新弹幕流入时，「最近 15 秒」窗口也要随时间自然收缩 ——
  setInterval(() => {
    if (hovering) return;
    render(app.getState());
  }, 1000);

  function render(state) {
    const { items, clusters } = state.result;
    const ui = state.ui;

    // —— 筛选链：噪声 → 分类 → 问题簇 → 搜索
    let filtered = items.slice();
    if (!ui.showNoise) filtered = filtered.filter((it) => it.filter.passed);
    if (ui.selectedCategory) {
      filtered = filtered.filter((it) => it.filter.passed && it.categoryId === ui.selectedCategory);
    }
    if (ui.selectedClusterId) {
      filtered = filtered.filter((it) => it.clusterId === ui.selectedClusterId);
    }
    if (ui.search) {
      const kw = ui.search.toLowerCase();
      filtered = filtered.filter((it) => it.normalizedText.includes(kw) || it.text.toLowerCase().includes(kw));
    }

    const statusMap = { idle: '空闲', connecting: '连接中', live: '采集中', paused: '已暂停', error: '异常' };
    const statusText = statusMap[state.connection.status] || state.connection.status;
    setText(statusEl, statusText);
    setText(countEl, `${filtered.length} / ${items.length} 条`);

    // —— 筛选提示条
    const notes = [];
    if (ui.selectedCategory) {
      notes.push(`已筛选分类：<b>${escapeHtml(CATEGORY_MAP[ui.selectedCategory]?.label || ui.selectedCategory)}</b>`);
    }
    if (ui.selectedClusterId) {
      const c = clusters.find((x) => x.id === ui.selectedClusterId);
      notes.push(`已筛选问题簇：<b>${escapeHtml(c ? c.title : ui.selectedClusterId)}</b>`);
    }
    if (notes.length) {
      const buttons = [];
      if (ui.selectedCategory) buttons.push('<button class="btn btn-tiny" data-clear="category">清除分类</button>');
      if (ui.selectedClusterId) buttons.push('<button class="btn btn-tiny" data-clear="cluster">清除问题簇</button>');
      noteEl.classList.remove('hidden');
      noteEl.innerHTML = `${notes.join(' ｜ ')} ${buttons.join(' ')}`;
    } else {
      noteEl.classList.add('hidden');
    }

    // —— 列表渲染（滚动窗口：只裁视图；签名相同则跳过重绘）
    const filterActive = Boolean(ui.search || ui.selectedCategory || ui.selectedClusterId);
    const visible = computeVisibleWindow(filtered, Date.now(), { hovering, filterActive });
    const signature = [
      statusText,
      `${filtered.length}/${items.length}`,
      ui.selectedCategory || '',
      ui.selectedClusterId || '',
      visible.map((it) => it.id).join(','),
    ].join('|');
    if (signature === lastSignature) return;
    lastSignature = signature;

    toggleClass(emptyEl, 'hidden', visible.length > 0);
    listEl.innerHTML = visible.map((it) => renderItem(it, ui.selectedClusterId)).join('');
    listEl.scrollTop = 0;
  }

  return render;
}

function renderItem(it, selectedClusterId) {
  const isNoise = !it.filter.passed;
  const chips = [`<span class="chip chip-intent">${escapeHtml(it.intentLabel)}</span>`];

  // 来源标记：让"SDK 真实收到"与"本地模拟 / 手动注入"在视觉上无法混淆
  if (it.source === 'polyv') {
    chips.push('<span class="chip chip-src chip-src-polyv">保利威 SDK</span>');
  } else if (it.meta && it.meta.manual) {
    chips.push('<span class="chip chip-src chip-src-mock">手动注入 · 本地</span>');
  } else {
    chips.push('<span class="chip chip-src chip-src-mock">模拟数据</span>');
  }

  if (isNoise) {
    chips.push(`<span class="chip chip-noise">已过滤 · ${escapeHtml(it.filter.reasonLabel || it.filter.reasonId)}</span>`);
  } else if (it.categoryId) {
    const cat = CATEGORY_MAP[it.categoryId];
    chips.push(`<span class="chip chip-cat" style="background:${cat.color}">${escapeHtml(cat.label)} ${(it.confidence * 100).toFixed(0)}%</span>`);
    if (it.severity > 0) chips.push(`<span class="chip">严重度 ${it.severity.toFixed(2)}</span>`);
  }

  const clusterHint = it.clusterId && it.clusterId === selectedClusterId ? 'is-highlight' : '';
  return `
    <li class="dm ${isNoise ? 'is-noise' : ''} ${clusterHint}" data-cluster="${it.clusterId || ''}">
      <div class="dm-top">
        <span class="dm-user">${escapeHtml(it.userKey)}</span>
        <span>${escapeHtml(formatTime(it.timestamp))}</span>
      </div>
      <div class="dm-text">${escapeHtml(it.text)}</div>
      <div class="dm-chips">${chips.join('')}</div>
    </li>`;
}
