/**
 * ui/roomModal.js —— 「连接直播间」频道号弹窗
 * ------------------------------------------------------------
 * 真实连接流程：商家在「弹幕源」下拉里选择「保利威直播聊天室」后，先弹出本弹窗，
 * 输入目标频道号并点击【连接直播间】，才会真正创建 PolyvProvider 走官方 SDK 连接；
 * 连接失败时弹窗不关闭，直接展示错误原因，可改号重试。点击【取消】/ Esc / 遮罩
 * 均视为放弃本次连接，页面恢复到打开弹窗之前的状态。
 *
 * 职责边界（严格遵守）：
 *   - 只负责「收集频道号 + 连接过程的可视状态」，不碰任何分析逻辑；
 *   - 真正的连接动作由调用方通过 onConfirm 回调注入（main.js 的 switchSource），
 *     本模块不 import provider / store，保持可测试、可替换。
 *   - 模块级不触碰 document，可在 Node 冒烟测试中直接 import（见 tools/smoke-test.mjs）。
 */
import { byId } from './dom.js?v=20261023f';

/** 频道号规则：纯数字，3–12 位（保利威频道号均为数字） */
const CHANNEL_PATTERN = /^\d{3,12}$/;

/**
 * 校验频道号输入（纯函数，供弹窗与冒烟测试共用）。
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateChannelId(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, error: '请输入频道号' };
  if (!/^\d+$/.test(value)) return { ok: false, error: '频道号只能包含数字，请检查后重试' };
  if (!CHANNEL_PATTERN.test(value)) {
    return { ok: false, error: `频道号应为 3–12 位数字，当前为 ${value.length} 位` };
  }
  return { ok: true, value };
}

/**
 * 创建频道号弹窗。
 * @param {{ onConfirm?: (channelId: string) => Promise<{ ok: boolean, error?: string } | void>,
 *           onCancel?: () => void }} [handlers] 打开时可通过 open() 覆盖
 */
export function createRoomModal(handlers = {}) {
  const overlay = byId('room-modal');
  // 没有弹窗 DOM 时安全降级：确认/取消都为空操作，不影响页面其余功能
  if (!overlay) {
    return { open: () => {}, close: () => {}, isOpen: () => false };
  }

  const input = byId('room-channel-input');
  const errorEl = byId('room-modal-error');
  const statusEl = byId('room-modal-status');
  const btnConfirm = byId('room-modal-confirm');
  const btnCancel = byId('room-modal-cancel');
  const btnClose = byId('room-modal-close');

  /** 本次会话上次成功连接的频道号，下次打开弹窗时预填 */
  let lastChannel = '';
  /** 连接进行中：屏蔽一切交互，避免并发连接与状态错乱 */
  let connecting = false;
  /** 打开弹窗前聚焦的元素，关闭后归还焦点（键盘用户不迷路） */
  let opener = null;
  let confirmHandler = handlers.onConfirm || null;
  let cancelHandler = handlers.onCancel || null;

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
    input?.classList.add('is-error');
  }

  function clearError() {
    errorEl?.classList.add('hidden');
    input?.classList.remove('is-error');
  }

  function showStatus(message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.remove('hidden');
  }

  function hideStatus() {
    statusEl?.classList.add('hidden');
  }

  /** 切换「连接中」状态：三个按钮全部禁用，确认按钮变文案 */
  function setConnecting(on, channel = '') {
    connecting = on;
    if (btnConfirm) {
      btnConfirm.disabled = on;
      btnConfirm.textContent = on ? '连接中…' : '连接直播间';
    }
    if (btnCancel) btnCancel.disabled = on;
    if (btnClose) btnClose.disabled = on;
    if (on) {
      clearError();
      showStatus(`正在连接保利威频道 ${channel}…`);
    } else {
      hideStatus();
    }
  }

  function closeModal() {
    overlay.classList.add('hidden');
    setConnecting(false);
    // 恢复页面滚动（打开时临时锁死，避免背后页面跟着滚）
    document.body.style.removeProperty('overflow');
    confirmHandler = handlers.onConfirm || null;
    cancelHandler = handlers.onCancel || null;
    if (opener && typeof opener.focus === 'function') opener.focus();
    opener = null;
  }

  async function requestConnect() {
    if (connecting) return;
    const result = validateChannelId(input?.value);
    if (!result.ok) {
      showError(result.error);
      input?.focus();
      return;
    }
    const channel = result.value;
    setConnecting(true, channel);
    try {
      // onConfirm 返回 { ok, error }；连接失败时弹窗保持打开，错误就地展示
      const outcome = (await confirmHandler?.(channel)) || { ok: true };
      if (outcome && outcome.ok === false) {
        showError(outcome.error || '连接失败，请稍后重试');
        setConnecting(false);
        return;
      }
      lastChannel = channel;
      closeModal();
    } catch (err) {
      // 防御：调用方抛异常时也不能把弹窗卡在「连接中」
      showError(err?.message || '连接失败，请稍后重试');
      setConnecting(false);
    }
  }

  function requestCancel() {
    if (connecting) return; // 连接中是脏状态窗口，不允许中途取消
    closeModal();
    cancelHandler?.();
  }

  // —— 事件绑定（弹窗存活期间只绑一次）——

  btnConfirm?.addEventListener('click', requestConnect);
  btnCancel?.addEventListener('click', requestCancel);
  btnClose?.addEventListener('click', requestCancel);

  // 输入框内回车 = 点【连接直播间】
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      requestConnect();
    }
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      requestCancel();
      return;
    }
    // 焦点陷阱：Tab 在弹窗内循环，不会跑到背后的页面上
    if (e.key === 'Tab') {
      const focusables = [input, btnCancel, btnConfirm, btnClose].filter(
        (el) => el && !el.disabled,
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // 点遮罩空白处 = 取消（点弹窗本体不触发）
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) requestCancel();
  });

  /**
   * 打开弹窗。
   * @param {{ defaultChannel?: string,
   *           onConfirm?: Function, onCancel?: Function }} [options]
   */
  function open(options = {}) {
    if (options.onConfirm) confirmHandler = options.onConfirm;
    if (options.onCancel) cancelHandler = options.onCancel;
    opener = document.activeElement;
    if (input) {
      input.value = lastChannel || String(options.defaultChannel || '');
    }
    clearError();
    hideStatus();
    setConnecting(false);
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // 自动聚焦并全选：方便商家直接覆盖旧频道号
    input?.focus();
    input?.select();
  }

  return {
    open,
    close: closeModal,
    isOpen: () => !overlay.classList.contains('hidden'),
  };
}
