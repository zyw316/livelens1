/**
 * main.js
 * ------------------------------------------------------------
 * 应用装配层：把「弹幕源 provider → 状态容器 store → UI 面板」串起来。
 *
 * 这里是唯一知道三者如何连接的地方；分析算法、UI 组件各自独立，互不依赖。
 * 切换真实弹幕时，只需要改 createProvider() 的实现。
 *
 * 注意：保利威 provider 的 connect() 是**异步**的（要加载 SDK、初始化、连聊天室），
 * 所以本文件里所有调用点都必须 await + try/catch，否则连接失败会变成静默失败。
 */
import { store } from './core/store.js?v=20261023f';
import { normalizeMessage } from './core/normalize.js?v=20261023f';
import { SOURCE } from './core/constants.js?v=20261023f';
import { CONFIG } from './config.js?v=20261023f';
import { MockProvider } from './providers/mockProvider.js?v=20261023f';
import { PolyvProvider } from './providers/polyv/polyvProvider.js?v=20261023f';
import { toast } from './ui/dom.js?v=20261023f';
import { mountTopbar } from './ui/topbar.js?v=20261023f';
import { mountControlPanel } from './ui/controlPanel.js?v=20261023f';
import { mountNoisePanel } from './ui/noisePanel.js?v=20261023f';
import { mountCategoryPanel } from './ui/categoryPanel.js?v=20261023f';
import { mountDanmakuPanel } from './ui/danmakuPanel.js?v=20261023f';
import { mountClusterPanel } from './ui/clusterPanel.js?v=20261023f';
import { mountAlertPanel } from './ui/alertPanel.js?v=20261023f';
import { mountFocusPanel } from './ui/focusPanel.js?v=20261023f';
// AI 是旁挂模块：只读 store 的结果，不参与 core 的任何计算
import { aiStore } from './ai/aiStore.js?v=20261023f';
import { createAiBatcher } from './ai/batcher.js?v=20261023f';
import { mountAiPanel } from './ui/aiPanel.js?v=20261023f';

let currentSource = SOURCE.MOCK;
let provider = null;
/** 连接中的 Promise，用于避免用户狂点按钮造成并发连接 */
let connectingPromise = null;
/**
 * 商家在「连接直播间」弹窗里输入的保利威频道号。
 * 为空时回退到 CONFIG.polyv.channelId（默认测试频道）。
 */
let polyvChannelId = '';

const providerOptions = {
  roomId: CONFIG.roomId,
  onStatus: (patch) => store.setConnection(patch),
  onMessage: (raw) => {
    const source = raw.meta && raw.meta.manual ? SOURCE.MOCK : currentSource;
    store.pushMessages(normalizeMessage(raw, source));
  },
};

/** 当前生效的保利威频道号：弹窗输入优先，否则用配置里的默认频道 */
function polyvRoomId() {
  return polyvChannelId || CONFIG.polyv.channelId;
}

/** 数据源工厂：模拟源与保利威实现同一个 provider 接口 */
function createProvider(source) {
  const opts = {
    ...providerOptions,
    roomId: source === SOURCE.POLYV ? polyvRoomId() : CONFIG.roomId,
  };
  if (source === SOURCE.POLYV) return new PolyvProvider(opts);
  return new MockProvider(opts);
}

function roomIdOf(source) {
  return source === SOURCE.POLYV ? polyvRoomId() : CONFIG.roomId;
}

/** 暴露给 UI 面板的应用级动作 */
const app = {
  getState: () => store.getState(),
  getActions: () => store,

  toggleRun() {
    const state = store.getState();
    if (state.running) {
      provider?.pause();
      store.setRunning(false);
      toast('已暂停弹幕采集');
      return;
    }
    // start() 内部已处理所有异常，这里不需要再包 try/catch
    start();
  },

  async reset() {
    await disposeProvider();
    store.reset();
    aiStore.reset();
    store.setConnection({ startedAt: null, lastMessageAt: null, status: 'idle', message: '' });
    toast('演示数据已清空，连接已断开');
  },

  /**
   * 切换弹幕源。
   * @param {string} source SOURCE.MOCK / SOURCE.POLYV
   * @param {string} [channelId] 保利威频道号——由「连接直播间」弹窗确认后传入；
   *   带频道号进来视为「商家明确要求连接」，无论当前是否在采集都立即执行 SDK 连接，
   *   并把结果（{ ok, error }）回传给弹窗展示。
   */
  async switchSource(source, channelId) {
    const connectNow = source === SOURCE.POLYV && !!channelId;
    if (connectNow) polyvChannelId = String(channelId).trim();
    const wasRunning = store.getState().running;
    await disposeProvider();
    currentSource = source;
    store.setConnection({ source, roomId: roomIdOf(source), message: '' });
    if (wasRunning || connectNow) return await start();
    return { ok: true };
  },

  injectDanmaku(text) {
    // 手动注入是本地测试能力，明确标记为 mock 来源，绝不会冒充 SDK 收到的消息
    store.pushMessages(normalizeMessage({
      userId: 'u_manual',
      nick: '手动注入',
      text,
      ts: Date.now(),
      roomId: roomIdOf(currentSource),
      meta: { manual: true },
    }, SOURCE.MOCK));
  },

  setOption: (key, value) => store.setOption(key, value),
  setUi: (key, value) => store.setUi(key, value),

  dispose() {
    disposeProvider();
  },
};

/** 断开并丢弃当前 provider；幂等，可安全重复调用 */
async function disposeProvider() {
  if (!provider) return;
  const p = provider;
  provider = null;
  connectingPromise = null;
  try {
    await p.disconnect();
  } catch (err) {
    // 断开失败不应影响后续重置流程，但要让用户看见
    toast(`断开连接时出错：${err.message}`);
  }
}

async function connectCurrent() {
  if (currentSource === SOURCE.POLYV && !CONFIG.polyv.enabled) {
    const msg = '保利威数据源未启用（CONFIG.polyv.enabled = false），请改用「本地模拟源」';
    store.setConnection({ status: 'error', message: msg });
    throw new Error(msg);
  }
  // 并发保护：连接进行中时复用同一个 Promise，避免重复初始化 SDK
  if (!connectingPromise) {
    connectingPromise = provider.connect().finally(() => {
      connectingPromise = null;
    });
  }
  await connectingPromise;
}

async function start() {
  if (!provider) provider = createProvider(currentSource);
  if (!store.getState().connection.startedAt) {
    store.setConnection({ startedAt: Date.now() });
  }
  store.setConnection({ message: '' });

  try {
    await connectCurrent();
    store.setRunning(true);
    toast(
      currentSource === SOURCE.POLYV
        ? `已连接保利威聊天室 ${polyvRoomId()}，等待观众消息`
        : '已连接模拟弹幕源，正在采集演示数据',
    );
    return { ok: true };
  } catch (err) {
    // 失败必须可见：状态 + toast 都要有，不能静默
    store.setRunning(false);
    const message = err?.message || '连接失败';
    store.setConnection({ status: 'error', message });
    toast(`连接失败：${message}`);
    // 结果回传给调用方（如连接弹窗），失败时弹窗保持打开、就地展示错误
    return { ok: false, error: message };
  }
}

// —— 装配 UI ——
const panels = [
  mountTopbar(app),
  mountControlPanel(app),
  mountNoisePanel(app),
  mountCategoryPanel(app),
  mountDanmakuPanel(app),
  mountFocusPanel(app),
  mountClusterPanel(app),
  mountAlertPanel(app),
];

// —— AI 洞察（旁挂）——
// 单独一套状态与渲染；即使这里全部失败，也只是 AI 面板不可用，页面其余部分照常。
const aiBatcher = createAiBatcher({ store, aiStore, config: CONFIG.ai });
const renderAiPanel = mountAiPanel({ app, aiStore, aiBatcher });
aiStore.subscribe(() => renderAiPanel());
renderAiPanel();

if (aiStore.getState().enabled) {
  aiBatcher.start();
}

store.subscribe((state) => {
  panels.forEach((render) => render(state));
});

store.setConnection({ source: currentSource, roomId: roomIdOf(currentSource) });
panels.forEach((render) => render(store.getState()));

// 控制台入口，便于调试：window.__livelens.store.getState()
window.__livelens = { app, store, aiStore, aiBatcher, get provider() { return provider; } };
