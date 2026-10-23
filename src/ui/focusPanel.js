/** ui/focusPanel.js —— 商家关注榜（频率 × 语义 × 紧急度 综合排序） */
import { byId, delegate, escapeHtml, formatTime, setText, toggleClass } from './dom.js?v=20261023f';
import { CATEGORY_MAP } from '../core/constants.js?v=20261023f';

export function mountFocusPanel(app) {
  const listEl = byId('focus-list');
  const emptyEl = byId('focus-empty');
  const countEl = byId('focus-count');

  // 点击榜单项 → 联动「重复问题聚合」选中 + 弹幕流高亮
  delegate(listEl, '[data-cluster]', 'click', (event, el) => {
    event.stopPropagation();
    app.getActions().selectCluster(el.dataset.cluster);
  });

  return function render(state) {
    const focus = state.result.focus || [];
    setText(countEl, `${focus.length} 项`);
    countEl.className = focus.length ? 'tag tag-primary' : 'tag tag-muted';
    toggleClass(emptyEl, 'hidden', focus.length > 0);

    const selectedId = state.ui.selectedClusterId;

    listEl.innerHTML = focus.map((f) => {
      const cat = f.categoryId ? CATEGORY_MAP[f.categoryId] : null;
      const pct = Math.round(f.score * 100);
      return `
        <li class="focus-item ${f.clusterId === selectedId ? 'is-selected' : ''}" data-cluster="${f.clusterId}">
          <div class="focus-top">
            <span class="focus-rank">${f.rank}</span>
            <span class="focus-title">${escapeHtml(f.title)}</span>
            <span class="chip" style="background:${f.type.color}1a;color:${f.type.color};border-color:${f.type.color}55">${f.type.label}</span>
          </div>
          <div class="focus-meta">
            ${cat ? `<span class="chip chip-cat" style="color:${cat.color};border-color:${cat.color}55;background:${cat.color}0d">${escapeHtml(cat.label)}</span>` : ''}
            <span>${f.userCount} 人 / ${f.count} 条</span>
            <span>意图：${escapeHtml(f.intentLabel)}</span>
            <span>${escapeHtml(formatTime(f.lastAt))}</span>
          </div>
          <div class="focus-reason">${escapeHtml(f.reason)}${f.anomalyReason ? `<br><span class="focus-anomaly">⚠ ${escapeHtml(f.anomalyReason)}</span>` : ''}</div>
          <div class="focus-score" title="综合关注分 = 频率 ${Math.round(f.components.freq * 100)}% × 0.35 + 语义 ${Math.round(f.components.sem * 100)}% × 0.25 + 紧急度 ${Math.round(f.components.urgency * 100)}% × 0.40">
            <div class="focus-score-track"><div class="focus-score-bar" style="width:${pct}%;background:${f.type.color}"></div></div>
            <span class="focus-score-num">${pct}</span>
          </div>
        </li>`;
    }).join('');
  };
}
