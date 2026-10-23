/**
 * ui/aiInsightView.js —— 把洞察数据渲染成 HTML（纯函数，便于单测）
 * ------------------------------------------------------------
 * 只做展示，不含任何状态与请求逻辑；所有文本都经过 escapeHtml。
 */
import { escapeHtml } from './dom.js?v=20261023f';

const PRIORITY_CLASS = { P0: 'ai-p0', P1: 'ai-p1', P2: 'ai-p2' };

const TREND_ICON = { up: '↗', flat: '→', down: '↘' };

/** 一句话结论 + 趋势 */
function renderHeadline(insight) {
  const trend = insight.trend || {};
  const dir = ['up', 'flat', 'down'].includes(trend.direction) ? trend.direction : 'flat';
  return `
    <div class="ai-headline">
      <p class="ai-summary">${escapeHtml(insight.summary)}</p>
      <div class="ai-trend ai-trend-${dir}">
        <span class="ai-trend-icon">${TREND_ICON[dir]}</span>
        <strong>${escapeHtml(trend.label || '无明显变化')}</strong>
        ${trend.note ? `<small>${escapeHtml(trend.note)}</small>` : ''}
      </div>
    </div>`;
}

/** 隐性需求 */
function renderNeeds(needs) {
  if (!needs.length) return '';
  return `
    <div class="ai-block">
      <h3 class="ai-block-title">隐性需求<span class="ai-block-sub">观众没说出口的顾虑</span></h3>
      <ul class="ai-need-list">
        ${needs.map((n) => `
          <li class="ai-need">
            <div class="ai-need-top">
              <span class="ai-need-text">${escapeHtml(n.need)}</span>
              <span class="ai-conf" title="置信度">${Math.round((n.confidence || 0) * 100)}%</span>
            </div>
            <small class="ai-evidence">${escapeHtml(n.evidence)}</small>
          </li>`).join('')}
      </ul>
    </div>`;
}

/** 分类解读 */
function renderCategories(categories) {
  if (!categories.length) return '';
  return `
    <div class="ai-block">
      <h3 class="ai-block-title">分类解读<span class="ai-block-sub">数字来自本地统计，解读由 AI 生成</span></h3>
      <ul class="ai-cat-list">
        ${categories.map((c) => `
          <li class="ai-cat">
            <div class="ai-cat-top">
              <span class="ai-cat-label">${escapeHtml(c.label)}</span>
              <span class="ai-cat-count">${c.count} 条 · ${Math.round((c.share || 0) * 100)}%</span>
            </div>
            <p class="ai-cat-reading">${escapeHtml(c.reading)}</p>
          </li>`).join('')}
      </ul>
    </div>`;
}

/** 低频高危提醒 */
function renderLowFrequency(items) {
  if (!items.length) return '';
  return `
    <div class="ai-block">
      <h3 class="ai-block-title">低频高危<span class="ai-block-sub">条数少但影响大</span></h3>
      <ul class="ai-alert-list">
        ${items.map((a) => `
          <li class="ai-alert">
            <strong>${escapeHtml(a.title)}</strong>
            <small>${escapeHtml(a.why)}</small>
            ${a.action ? `<span class="ai-alert-action">建议：${escapeHtml(a.action)}</span>` : ''}
          </li>`).join('')}
      </ul>
    </div>`;
}

/** 回复话术 */
function renderReplies(replies) {
  if (!replies.length) return '';
  return `
    <div class="ai-block">
      <h3 class="ai-block-title">建议话术<span class="ai-block-sub">可直接照读</span></h3>
      <ul class="ai-reply-list">
        ${replies.map((r) => `
          <li class="ai-reply">
            <div class="ai-reply-q">问：${escapeHtml(r.question)}</div>
            <div class="ai-reply-a">答：${escapeHtml(r.reply)}</div>
          </li>`).join('')}
      </ul>
    </div>`;
}

/** 商家待办 */
function renderActions(actions) {
  if (!actions.length) return '';
  return `
    <div class="ai-block">
      <h3 class="ai-block-title">接下来做什么<span class="ai-block-sub">按优先级排序</span></h3>
      <ul class="ai-action-list">
        ${actions.map((a) => `
          <li class="ai-action">
            <span class="ai-pri ${PRIORITY_CLASS[a.priority] || 'ai-p2'}">${escapeHtml(a.priority)}</span>
            <div class="ai-action-body">
              <strong>${escapeHtml(a.action)}</strong>
              ${a.reason ? `<small>${escapeHtml(a.reason)}</small>` : ''}
            </div>
          </li>`).join('')}
      </ul>
    </div>`;
}

/**
 * 渲染整份洞察。
 * @param {object} insight 已通过 validateInsight 规范化的数据
 * @returns {string} HTML
 */
export function renderInsightHtml(insight) {
  if (!insight || !insight.summary) return '';
  return [
    renderHeadline(insight),
    renderNeeds(insight.implicitNeeds || []),
    renderCategories(insight.categories || []),
    renderLowFrequency(insight.lowFrequency || []),
    renderReplies(insight.replySuggestions || []),
    renderActions(insight.merchantActions || []),
    `<p class="ai-disclaimer">${escapeHtml(insight.disclaimer || '')}</p>`,
  ].join('');
}
