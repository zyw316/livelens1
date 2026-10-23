/** ui/dom.js —— 渲染小工具，无业务逻辑 */

export function byId(id) {
  return document.getElementById(id);
}

export function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function formatTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function setText(el, value) {
  if (el) el.textContent = value;
}

export function toggleClass(el, cls, on) {
  if (!el) return;
  el.classList.toggle(cls, !!on);
}

let toastTimer = null;
export function toast(message) {
  const el = byId('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

/** 事件委托：container.addEventListener(type, handler) 的简写 */
export function delegate(container, selector, type, handler) {
  container.addEventListener(type, (event) => {
    const target = event.target.closest(selector);
    if (target && container.contains(target)) handler(event, target);
  });
}
