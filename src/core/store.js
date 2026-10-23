/**
 * store.js
 * ------------------------------------------------------------
 * 极简响应式状态容器（发布订阅）。不引入任何第三方库。
 * 约定：所有状态变更走 actions，变更后自动重算分析结果并通知 UI。
 */
import { analyzeBuffer } from './analysis.js?v=20261023f';
import { DEFAULT_OPTIONS, ALERT_STATUS } from './constants.js?v=20261023f';
import { CONFIG } from '../config.js?v=20261023f';

function createStore() {
  const listeners = new Set();

  const state = {
    connection: {
      source: 'mock',
      status: 'idle', // idle | live | paused | error
      roomId: CONFIG.roomId,
      startedAt: null,
      lastMessageAt: null,
    },
    running: false,
    raw: [],            // DanmakuMessage[]（原始缓冲，最多 maxBuffer 条）
    options: { ...DEFAULT_OPTIONS },
    ui: {
      search: '',
      showNoise: false,
      selectedCategory: null,
      selectedClusterId: null,
      expandedClusters: new Set(),
    },
    alertStatus: {},    // alertKey -> ALERT_STATUS
    result: analyzeBuffer([], DEFAULT_OPTIONS),
  };

  function notify() {
    listeners.forEach((fn) => fn(state));
  }

  function recompute() {
    state.result = analyzeBuffer(state.raw, { ...state.options, now: Date.now() });
  }

  function trimBuffer() {
    const max = CONFIG.maxBuffer || DEFAULT_OPTIONS.maxBuffer;
    if (state.raw.length > max) {
      state.raw = state.raw.slice(state.raw.length - max);
    }
  }

  const actions = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    getState() {
      return state;
    },

    /** 追加一条或多条已归一化的弹幕，并立即重算 */
    pushMessages(messages) {
      const list = Array.isArray(messages) ? messages : [messages];
      if (!list.length) return;
      state.raw.push(...list);
      trimBuffer();
      state.connection.lastMessageAt = list[list.length - 1].timestamp;
      recompute();
      notify();
    },

    setConnection(patch) {
      Object.assign(state.connection, patch);
      notify();
    },

    setRunning(running) {
      state.running = running;
      state.connection.status = running ? 'live' : (state.raw.length ? 'paused' : 'idle');
      notify();
    },

    setOption(key, value) {
      state.options[key] = value;
      recompute();
      notify();
    },

    setUi(key, value) {
      state.ui[key] = value;
      notify();
    },

    toggleExpanded(clusterId) {
      const set = state.ui.expandedClusters;
      if (set.has(clusterId)) set.delete(clusterId);
      else set.add(clusterId);
      notify();
    },

    selectCluster(clusterId) {
      state.ui.selectedClusterId = state.ui.selectedClusterId === clusterId ? null : clusterId;
      notify();
    },

    selectCategory(categoryId) {
      state.ui.selectedCategory = state.ui.selectedCategory === categoryId ? null : categoryId;
      notify();
    },

    setAlertStatus(key, status) {
      if (status === ALERT_STATUS.PENDING) delete state.alertStatus[key];
      else state.alertStatus[key] = status;
      notify();
    },

    reset() {
      state.raw = [];
      state.alertStatus = {};
      state.ui = {
        search: '',
        showNoise: false,
        selectedCategory: null,
        selectedClusterId: null,
        expandedClusters: new Set(),
      };
      recompute();
      notify();
    },
  };

  return actions;
}

export const store = createStore();
