/** ui/alertPanel.js —— 重要低频问题提醒（支持已处理 / 已忽略状态切换） */
import { byId, delegate, escapeHtml, formatTime, setText, toggleClass } from './dom.js?v=20261023f';
import { mergeAlertStatus } from '../core/alert.js?v=20261023f';
import { ALERT_STATUS, ALERT_STATUS_LABELS, CATEGORY_MAP } from '../core/constants.js?v=20261023f';

export function mountAlertPanel(app) {
  const listEl = byId('alert-list');
  const emptyEl = byId('alert-empty');
  const countEl = byId('alert-count');

  delegate(listEl, '[data-action]', 'click', (event, el) => {
    event.stopPropagation();
    const { action, key } = el.dataset;
    const status = action === 'handle'
      ? ALERT_STATUS.HANDLED
      : action === 'ignore' ? ALERT_STATUS.IGNORED : ALERT_STATUS.PENDING;
    app.getActions().setAlertStatus(key, status);
  });

  // 已处理归档区（折叠态，默认隐藏，只在有已处理条目时出现）
  const doneWrap = document.createElement('div');
  doneWrap.className = 'alert-done hidden';
  listEl.after(doneWrap);
  let doneOpen = false;
  delegate(doneWrap, '[data-action="toggle-done"]', 'click', (event, el) => {
    event.stopPropagation();
    doneOpen = !doneOpen;
    renderLast();
  });
  delegate(doneWrap, '[data-action="reset"]', 'click', (event, el) => {
    event.stopPropagation();
    app.getActions().setAlertStatus(el.dataset.key, ALERT_STATUS.PENDING);
  });

  let renderLast = () => {};

  function render(state) {
    const alerts = mergeAlertStatus(state.result.alerts, state.alertStatus);
    const pending = alerts.filter((a) => a.status === ALERT_STATUS.PENDING);
    const done = alerts.filter((a) => a.status !== ALERT_STATUS.PENDING);

    setText(countEl, `${pending.length} 条待处理`);
    countEl.className = pending.length ? 'tag tag-warn' : 'tag tag-muted';
    toggleClass(emptyEl, 'hidden', pending.length > 0);

    // 主列表只显示待处理；已处理/已忽略立即从视野中清除
    listEl.innerHTML = pending.map(renderAlert).join('');

    // 归档：折叠为一行，不占用列表空间；展开可逐条恢复
    toggleClass(doneWrap, 'hidden', done.length === 0);
    if (done.length) {
      doneWrap.innerHTML = `
        <button class="alert-done-toggle" data-action="toggle-done">
          已处理 ${done.length} 条 ${doneOpen ? '▲ 收起' : '▼ 查看'}
        </button>
        ${doneOpen ? `<ul class="alert-list alert-list-done">${done.map(renderAlert).join('')}</ul>` : ''}`;
    } else {
      doneOpen = false;
    }
  }
  renderLast = () => render(app.getState());
  return render;
}

function renderAlert(a) {
  const cat = a.categoryId ? CATEGORY_MAP[a.categoryId] : null;
  const cls = a.status === ALERT_STATUS.HANDLED ? 'handled' : a.status === ALERT_STATUS.IGNORED ? 'ignored' : '';
  const sevCls = a.level === 'high' ? 'sev-high' : a.level === 'medium' ? 'sev-mid' : 'sev-low';
  return `
    <li class="alert-item ${cls}">
      <div class="alert-top">
        <span class="alert-title">${escapeHtml(a.title)}</span>
        <span class="sev ${sevCls}">${a.severity.toFixed(2)}</span>
      </div>
      <div class="alert-reason">
        ${escapeHtml(a.reason)}
        ${cat ? ` · 分类：<b style="color:${cat.color}">${escapeHtml(cat.label)}</b>` : ''}
        · 最近 ${escapeHtml(formatTime(a.lastAt))}
      </div>
      ${a.samples.length ? `<div class="alert-sample">原文：${escapeHtml(a.samples[0])}</div>` : ''}
      <div class="alert-actions">
        ${a.status === ALERT_STATUS.PENDING ? `
          <button class="btn btn-tiny" data-action="handle" data-key="${a.key}">标记已处理</button>
          <button class="btn btn-tiny" data-action="ignore" data-key="${a.key}">忽略</button>
        ` : `
          <button class="btn btn-tiny" data-action="reset" data-key="${a.key}">恢复待处理</button>
        `}
      </div>
      <div class="alert-state">状态：${ALERT_STATUS_LABELS[a.status]}</div>
    </li>`;
}
