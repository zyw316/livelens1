/** ui/clusterPanel.js —— 重复问题聚合（点击可展开样例并联动筛选弹幕流） */
import { byId, delegate, escapeHtml, formatTime, setText, toggleClass } from './dom.js?v=20261023f';
import { CATEGORY_MAP, INTENT_LABELS } from '../core/constants.js?v=20261023f';

export function mountClusterPanel(app) {
  const listEl = byId('cluster-list');
  const emptyEl = byId('cluster-empty');
  const countEl = byId('cluster-count');

  delegate(listEl, '.cluster', 'click', (event, el) => {
    app.getActions().selectCluster(el.dataset.clusterId);
    app.getActions().toggleExpanded(el.dataset.clusterId);
  });

  return function render(state) {
    const clusters = state.result.clusters;
    const selected = state.ui.selectedClusterId;
    const expanded = state.ui.expandedClusters;

    setText(countEl, `${clusters.length} 个问题簇`);
    toggleClass(emptyEl, 'hidden', clusters.length > 0);

    listEl.innerHTML = clusters.map((c) => {
      const cat = c.categoryId ? CATEGORY_MAP[c.categoryId] : null;
      const isExpanded = expanded.has(c.id) || selected === c.id;
      return `
        <li class="cluster ${isExpanded ? 'expanded' : ''}" data-cluster-id="${c.id}">
          <div class="cluster-top">
            <span class="cluster-title">${escapeHtml(c.title)}</span>
            <span class="cluster-count">×${c.count}</span>
          </div>
          <div class="cluster-meta">
            ${cat ? `<span class="chip chip-cat" style="background:${cat.color}">${escapeHtml(cat.label)}</span>` : '<span class="chip">未分类</span>'}
            <span>${escapeHtml(INTENT_LABELS[c.intent] || c.intent || '-')}</span>
            <span>${c.userCount} 人提问</span>
            <span>${escapeHtml(formatTime(c.lastAt))}</span>
          </div>
          ${isExpanded ? `<ul class="cluster-samples">${c.samples.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : ''}
        </li>`;
    }).join('');
  };
}
