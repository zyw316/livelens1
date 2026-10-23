/** ui/noisePanel.js —— 噪声过滤统计 */
import { byId, setText, escapeHtml } from './dom.js?v=20261023f';
import { FILTER_REASONS } from '../core/constants.js?v=20261023f';

export function mountNoisePanel(app) {
  const elTotal = byId('stat-total');
  const elPassed = byId('stat-passed');
  const elNoise = byId('stat-noise');
  const elRate = byId('stat-rate');
  const elBreakdown = byId('noise-breakdown');

  return function render(state) {
    const { stats } = state.result;
    setText(elTotal, stats.total);
    setText(elPassed, stats.passed);
    setText(elNoise, stats.noise);
    setText(elRate, `噪声占比 ${(stats.noiseRate * 100).toFixed(1)}%`);

    const rows = FILTER_REASONS.map((r) => ({ ...r, count: stats.byReason[r.id] || 0 }));
    const max = Math.max(1, ...rows.map((r) => r.count));

    elBreakdown.innerHTML = rows
      .map((r) => `
        <div class="bd-row" title="${escapeHtml(r.label)}">
          <span class="bd-label">${escapeHtml(r.label)}</span>
          <span class="bd-track"><span class="bd-fill" style="width:${(r.count / max) * 100}%"></span></span>
          <span class="bd-val">${r.count}</span>
        </div>`)
      .join('');
  };
}
