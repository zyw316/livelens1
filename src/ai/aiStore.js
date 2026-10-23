/**
 * ai/aiStore.js —— AI 洞察的独立状态容器
 * ------------------------------------------------------------
 * 刻意与 core/store.js **完全分离**：
 *   - core 的分析状态（result / options / alertStatus）不因 AI 改变；
 *   - AI 的状态（开关、加载中、最近一次洞察、错误）也不进入 core，
 *     所以「关闭 AI」只是停掉这个容器，对弹幕筛查与分类零影响。
 */
import { AI_STATUS } from './schema.js?v=20261023f';

const STORAGE_KEY = 'livelens.ai.enabled';

/** localStorage 可能被禁用（隐私模式），读写都要兜底 */
function readEnabled(fallback) {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeEnabled(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* 存不了就算了，不影响本次会话 */
  }
}

function createAiStore(defaultEnabled = true) {
  const listeners = new Set();

  const state = {
    enabled: readEnabled(defaultEnabled),
    status: AI_STATUS.IDLE,
    /** 最近一次成功洞察（schema 规范化后的数据） */
    insight: null,
    lastRunAt: 0,
    lastError: '',
    /** 已成功生成的批次数 */
    successCount: 0,
    /** 后端是否可用：null=未知 true=可用 false=不可用（纯静态托管时会变成 false） */
    backendAvailable: null,
  };

  function notify() {
    listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (err) {
        // 单个订阅者出错不能影响其他面板
        console.error('[LiveLens] AI 面板渲染异常', err);
      }
    });
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getState() {
      return state;
    },
    setEnabled(enabled) {
      state.enabled = !!enabled;
      writeEnabled(state.enabled);
      if (!state.enabled) {
        state.status = AI_STATUS.DISABLED;
      } else if (state.status === AI_STATUS.DISABLED) {
        state.status = AI_STATUS.WAITING;
      }
      notify();
    },
    setStatus(status, patch = {}) {
      state.status = status;
      Object.assign(state, patch);
      notify();
    },
    setInsight(insight) {
      state.insight = insight;
      state.lastRunAt = Date.now();
      state.successCount += 1;
      state.status = AI_STATUS.OK;
      state.lastError = '';
      notify();
    },
    setError(message, { unavailable = false } = {}) {
      state.lastError = message;
      state.status = unavailable ? AI_STATUS.UNAVAILABLE : AI_STATUS.ERROR;
      if (unavailable) state.backendAvailable = false;
      notify();
    },
    reset() {
      state.insight = null;
      state.lastRunAt = 0;
      state.lastError = '';
      state.successCount = 0;
      state.status = state.enabled ? AI_STATUS.WAITING : AI_STATUS.DISABLED;
      notify();
    },
  };
}

export const aiStore = createAiStore(true);
export { createAiStore };
