/** ui/categoryPanel.js —— 服装行业需求分类分布（可点击筛选弹幕流） */
import { byId, delegate, escapeHtml, toggleClass } from './dom.js?v=20261023f';
import { DEMAND_CATEGORIES } from '../core/constants.js?v=20261023f';

export function mountCategoryPanel(app) {
  const list = byId('category-list');
  const btnClear = byId('btn-clear-category');

  delegate(list, '.cat-item', 'click', (event, el) => {
    app.getActions().selectCategory(el.dataset.categoryId);
  });

  btnClear.addEventListener('click', () => app.getActions().selectCategory(app.getState().ui.selectedCategory));

  return function render(state) {
    const { categories } = state.result.stats;
    const countMap = new Map(categories.map((c) => [c.id, c.count]));
    const total = categories.reduce((sum, c) => sum + c.count, 0) || 1;
    const selected = state.ui.selectedCategory;

    toggleClass(btnClear, 'hidden', !selected);

    // 实时排名：按条数降序，同数时保持词典原顺序
    const ranked = DEMAND_CATEGORIES
      .map((cat, idx) => ({ cat, idx, count: countMap.get(cat.id) || 0 }))
      .sort((a, b) => b.count - a.count || a.idx - b.idx);

    list.innerHTML = ranked.map(({ cat, count }, rank) => {
      const ratio = count / total;
      const rankBadge = count > 0 ? `<span class="cat-rank ${rank < 3 ? 'cat-rank-top' : ''}">${rank + 1}</span>` : '';
      return `
        <div class="cat-item ${selected === cat.id ? 'active' : ''} ${count > 0 ? 'has-count' : ''}" data-category-id="${cat.id}">
          <div class="cat-left">
            <div class="cat-name">
              ${rankBadge}
              <span class="cat-dot" style="background:${cat.color}"></span>${escapeHtml(cat.label)}
            </div>
            <div class="cat-bar"><span style="width:${ratio * 100}%;background:${cat.color}"></span></div>
          </div>
          <div class="cat-right">${count} 条<br />${(ratio * 100).toFixed(1)}%</div>
        </div>`;
    }).join('');
  };
}
