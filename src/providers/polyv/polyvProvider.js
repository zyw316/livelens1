/**
 * polyvProvider.js
 * ------------------------------------------------------------
 * 保利威（Polyv）直播弹幕适配器 —— 官方 Web 观看页 SDK 聊天室模块。
 *
 * 职责边界（严格遵守）：
 *   只做「连接 SDK + 监听官方消息事件 + 映射成统一弹幕格式」三件事。
 *   - 不做去噪、分类、聚合、告警：这些全部交给 src/core 的现有算法，本文件不参与。
 *   - 不做视频播放器接入、不要求开播、不做历史消息回放。
 *   - 不自建 WebSocket：实时通道完全由官方 SDK 内部管理。
 *
 * 真实链路：
 *   保利威聊天室 →(官方 SDK socket)→ ChatEvents.ChatMessage
 *     → mapChatMsg() → normalizeMessage()(在 main.js) → store → 现有分析流程
 *
 * 安全约定：AppSecret / 签名密钥绝不出现在前端。若频道开启「自定义授权」，
 *   签名必须由自有后端完成（见同目录 README.md 第 4 节与本文件 requestAuthParams）。
 */
import { DanmakuProvider } from '../provider.js?v=20261023f';
import { SOURCE } from '../../core/constants.js?v=20261023f';
import { CONFIG } from '../../config.js?v=20261023f';
import { loadPolyvSdk } from './sdkLoader.js?v=20261023f';

/** 连接状态机：用于阻止重复初始化、重复连接 */
const CONN = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LIVE: 'live',
  CLOSING: 'closing',
  ERROR: 'error',
};

/** 连接超时（毫秒）。超时按失败处理，确保页面能看到明确错误而不是一直转圈。 */
const CONNECT_TIMEOUT_MS = 20000;

/** 网络类失败的最大尝试次数（含首次）。保利威服务偶发抖动时，自动重试一次可自愈。 */
const MAX_CONNECT_ATTEMPTS = 2;

/** 两次尝试之间的间隔（毫秒） */
const RETRY_DELAY_MS = 1500;

/** 幂等去重表上限，防止长时间直播下 Set 无限增长 */
const SEEN_ID_LIMIT = 2000;

/**
 * 把保利威的 time 字段统一成毫秒时间戳。
 * 保利威不同接口可能返回秒级或毫秒级时间戳，这里做稳健判断：
 * 小于 1e12 视为秒（1e12 ms ≈ 2001 年，而直播消息不可能早于此）。
 */
function toMillis(value, fallback = Date.now()) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** 带超时的 Promise 封装 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 简单 sleep，用于重试间隔 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把官方 ChannelSetupFail 事件的 failReason 翻译成可行动的提示。
 * failReason 枚举来自官方 SDK 内部定义（见 polyv/README.md）。
 */
function explainSetupFailReason(reason) {
  const map = {
    NetworkError: '网络错误：浏览器请求保利威服务接口失败，请检查网络 / VPN / 代理 / 广告拦截插件是否拦截了 watch-api.polyv.cn',
    NetworkRequestTimeout: '请求保利威服务接口超时，稍后重试通常即可恢复',
    NotAllowDomain: '保利威后台未放行当前访问域名（130129），请在保利威后台「域名设置」中加入当前站点域名',
    NotAllowAccess: '频道当前不允许访问（403），可能是频道未开播或已被关闭',
    NotAvailableSession: '当前无可用直播场次（30004）',
  };
  return map[reason] || `未知原因（${reason || 'Unknown'}）`;
}

export class PolyvProvider extends DanmakuProvider {
  constructor(options) {
    super(options);
    this.sdk = null;
    this.watchCore = null;
    this.state = CONN.IDLE;
    /** 已处理过的消息 id，用于重连 / 消息重放时避免同一条重复进入分析 */
    this.seenIds = new Set();
    /** 事件解绑函数集合：断开时统一解绑，杜绝残留监听 */
    this.unbinders = [];
    /** 被忽略（非发言类）消息的计数，便于在页面上说明"收到了但不是观众发言" */
    this.ignoredCount = 0;
    /** setup 阶段失败的真实原因（来自官方 ChannelSetupFail 事件），让笼统报错变得可定位 */
    this.setupFailDetail = null;
  }

  /** 子类字段：当前是否已真正连上聊天室 */
  get isLive() {
    return this.state === CONN.LIVE;
  }

  /**
   * 建立连接：加载 SDK → 创建 watchCore → setup → connect → 监听官方消息事件。
   * 全部异步，失败会 reject，由 main.js 捕获并显示在页面状态里。
   */
  async connect(attempt = 1) {
    // —— 重复初始化保护 ——
    if (this.state === CONN.CONNECTING) {
      this.onStatus({ status: 'connecting' });
      return;
    }
    if (this.state === CONN.LIVE) return;
    if (this.state === CONN.CLOSING) {
      throw new Error('上一次连接正在断开，请稍后重试');
    }

    const roomId = this.roomId || CONFIG.polyv.channelId;
    if (!roomId) throw new Error('缺少保利威频道号（CONFIG.polyv.channelId）');

    this.state = CONN.CONNECTING;
    this.onStatus({ status: 'connecting', message: `正在连接保利威频道 ${roomId}` });

    try {
      this.sdk = await loadPolyvSdk();

      // 只有频道开启了「自定义授权 / 签名校验」时才需要这一步；普通测试频道为空。
      const authParams = await this.requestAuthParams(roomId);

      // 官方要求的初始化参数：频道号必填，其余按需
      const appConfig = {
        channelId: String(roomId),
        ...authParams,
      };

      this.watchCore = this.sdk.createWatchCore(appConfig);
      this.bindCoreEvents();
      this.bindChatEvents();

      // 安装观看页核心（内部会拉取频道信息 / 聊天室配置）
      await withTimeout(
        this.watchCore.setup(),
        CONNECT_TIMEOUT_MS,
        `保利威频道 ${roomId} 初始化超时（${CONNECT_TIMEOUT_MS / 1000}s）`,
      );

      // 观众授权：connect() 内部会校验 auth.isAuthorized()，未授权会直接拒绝连接。
      // 本 Demo 只处理「无条件观看」这一种；其它观看条件需要额外的授权信息，
      // 不做任何伪造，直接给出明确错误告诉使用者该准备什么。
      await this.ensureAuthorized(roomId);

      // 连接聊天室（官方 socket 通道由 SDK 内部建立）
      await withTimeout(
        this.watchCore.connect(),
        CONNECT_TIMEOUT_MS,
        `保利威聊天室 ${roomId} 连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`,
      );

      this.connected = true;
      this.state = CONN.LIVE;
      this.onStatus({ status: 'live', source: SOURCE.POLYV, message: '' });
    } catch (err) {
      this.state = CONN.ERROR;
      // setup 失败原因要先取出来：teardown() 会清空它
      const failDetail = this.setupFailDetail;
      // 失败必须彻底清理，否则残留的监听会在下次连接时造成重复回调
      await this.teardown();
      const message = this.enrichErrorMessage(err, failDetail);

      // 网络抖动 / 服务接口偶发失败：自动重试一次，避免用户再手动点一遍。
      // 确定性错误（观看条件、授权失败等）不重试——重试也无意义。
      const transient = /请求服务接口数据失败|超时|加载失败|Network/i.test(message);
      if (transient && attempt < MAX_CONNECT_ATTEMPTS) {
        this.state = CONN.CONNECTING;
        this.onStatus({
          status: 'connecting',
          message: `连接失败，${RETRY_DELAY_MS / 1000}s 后自动重试（第 ${attempt + 1}/${MAX_CONNECT_ATTEMPTS} 次）…`,
        });
        await sleep(RETRY_DELAY_MS);
        return this.connect(attempt + 1);
      }

      this.onStatus({ status: 'error', message });
      throw new Error(message);
    }
  }

  /**
   * 把 SDK 抛出的笼统错误（如「[watch-core][setup] 请求服务接口数据失败」）
   * 与 ChannelSetupFail 事件里携带的真实原因合并，让用户看到可行动的提示。
   */
  enrichErrorMessage(err, detail = this.setupFailDetail) {
    const message = err?.message || String(err);
    if (!detail || !/请求服务接口数据失败/.test(message)) return message;
    const explained = explainSetupFailReason(detail.reason);
    const raw = detail.message ? `（原始信息：${detail.message}）` : '';
    return `${message} —— ${explained}${raw}`;
  }

  /**
   * 确保观众已完成「观看条件授权」。
   *
   * 保利威的 watchCore.connect() 会先检查 auth.isAuthorized()，未授权会打印
   * "[watch-core][connect] 需要观众授权后才能连接聊天室" 并静默返回，
   * 所以这一步必须显式处理，否则会表现为"连上了但永远收不到消息"。
   *
   * 支持的类型：
   *   - none（无条件观看/公开观看）：调 verifyNoneAuth() 后重新 setup() 拉取观众信息。
   *   - 其它类型（验证码 / 白名单 / 付费 / 自定义授权 / 登记 等）：
   *     需要额外凭据，本 Demo 不做伪造，直接报错并说明需要准备什么。
   */
  async ensureAuthorized(roomId) {
    const core = this.watchCore;
    if (core.auth.isAuthorized()) return;

    const settings = core.auth.getAuthSettings?.() || [];
    const authType = settings[0]?.authType || 'unknown';

    if (authType !== 'none') {
      throw new Error(
        `频道 ${roomId} 开启了观看条件「${authType}」，本 Demo 只接入了「无条件观看」。`
        + '请在保利威后台临时关闭观看条件，或按 src/providers/polyv/README.md 第 4 节接入对应授权流程。',
      );
    }

    const result = await core.auth.verifyNoneAuth();
    if (!result || result.success !== true) {
      const reason = result?.message || result?.failMessage || '未知原因';
      throw new Error(`无条件观看授权失败：${reason}`);
    }

    // 授权成功后必须重新 setup()，SDK 才会重新拉取带观众信息（viewerInfo）的频道数据。
    // 这一步缺失会导致后续 connect() 报 "requiredUserId fail, userId is undefined"。
    await core.setup();

    if (!core.auth.isAuthorized()) {
      throw new Error('授权流程已完成，但 SDK 仍未拿到观众信息，无法连接聊天室');
    }
  }

  /**
   * 频道授权参数。
   * 默认返回空对象 —— 普通 / 测试频道不需要任何凭据即可进入聊天室。
   * 若你的频道开启了「自定义授权」，把 CONFIG.polyv.signEndpoint 指向自有后端，
   * 由后端读取环境变量里的 AppSecret 完成签名，前端只拿到一次性授权参数。
   * 注意：这里返回的任何字段都不会包含 AppSecret。
   */
  async requestAuthParams(roomId) {
    const endpoint = CONFIG.polyv.signEndpoint;
    if (!endpoint) return {};

    const query = new URLSearchParams({ channelId: String(roomId) });
    if (CONFIG.polyv.appId) query.set('appId', CONFIG.polyv.appId);
    const res = await fetch(`${endpoint}?${query.toString()}`);
    if (!res.ok) throw new Error(`授权服务返回 ${res.status}`);
    const json = await res.json();
    if (!json || typeof json !== 'object') throw new Error('授权服务返回内容不是对象');
    // 由后端决定返回什么字段（例如自定义授权的 token / 验证码），此处原样透传
    return json.params || {};
  }

  /** 监听 watchCore 级别的连接状态事件 */
  bindCoreEvents() {
    const events = this.sdk.PolyvWatchCoreEvents || {};
    const emitter = this.watchCore.eventEmitter;
    if (!emitter) return;

    const on = (name, handler) => {
      if (!name) return;
      emitter.on(name, handler);
      this.unbinders.push(() => emitter.off?.(name, handler));
    };

    on(events.WatchCoreConnected || 'WatchCoreConnected', () => {
      this.onStatus({ status: 'live', source: SOURCE.POLYV });
    });

    // setup() 内部请求频道信息失败时，SDK 会先发这个事件，再抛出笼统的
    // 「[watch-core][setup] 请求服务接口数据失败」。这里先收下真实原因，
    // connect() 的 catch 里再合并成可行动的错误文案（见 enrichErrorMessage）。
    on(events.ChannelSetupFail || 'ChannelSetupFail', (data) => {
      this.setupFailDetail = {
        reason: data?.failReason || '',
        message: data?.failMessage || '',
      };
      console.warn('[LiveLens] 保利威 setup 失败原因', this.setupFailDetail);
    });

    on(events.WatchCoreDisconnected || 'WatchCoreDisconnected', () => {
      // 被动断线：标记为未连接，让页面状态立刻可见
      if (this.state === CONN.LIVE || this.state === CONN.CONNECTING) {
        this.state = CONN.IDLE;
        this.connected = false;
        this.onStatus({ status: 'error', message: '保利威聊天室连接已断开' });
      }
    });
  }

  /** 监听聊天室消息事件 —— 这是弹幕的唯一真实来源 */
  bindChatEvents() {
    const chat = this.watchCore.chat;
    const chatEvents = this.sdk.ChatEvents || {};
    if (!chat || !chat.eventEmitter) {
      throw new Error('保利威 SDK 聊天室模块不可用（watchCore.chat 缺失）');
    }
    const emitter = chat.eventEmitter;

    const on = (name, handler) => {
      if (!name) return;
      emitter.on(name, handler);
      this.unbinders.push(() => emitter.off?.(name, handler));
    };

    // 官方聊天消息事件：观众发言、打赏等都会回调这里
    on(chatEvents.ChatMessage || 'ChatMessage', (data) => {
      if (!data || !data.chatMsg) return;
      // 聊天重放消息属于历史回放，本 Demo 明确不做，直接丢弃
      if (data.isChatReplayMsg) return;
      this.handleChatMsg(data.chatMsg);
    });

    // 连接失败：把官方给出的原因直接透传到页面
    on(chatEvents.ChatConnectFail || 'ChatConnectFail', (data) => {
      const reason = data?.reason || 'unknown';
      const reasonMap = {
        TokenExpired: '聊天室令牌过期',
        SocketConnectError: '聊天室 socket 连接失败',
        SocketConnectTimeout: '聊天室 socket 连接超时',
        SocketReconnectAttempt: '聊天室正在重连',
      };
      if (reason === 'SocketReconnectAttempt') {
        this.onStatus({ status: 'connecting', message: `${reasonMap[reason]}…` });
        return;
      }
      this.state = CONN.ERROR;
      this.onStatus({
        status: 'error',
        message: `${reasonMap[reason] || reason}（${reason}）`,
      });
    });
  }

  /** 单条消息处理：过滤来源 → 幂等去重 → 映射 → 交给统一数据流 */
  handleChatMsg(chatMsg) {
    const msgSource = chatMsg.msgSource || 'speak';
    const accept = CONFIG.polyv.acceptMsgSources || ['speak'];
    if (!accept.includes(msgSource)) {
      // 系统消息 / 打赏 / 特效等不是观众发言，不计入弹幕
      this.ignoredCount += 1;
      // 只在浏览器控制台留痕，方便排查「发了但页面没出现」的情况
      console.debug('[LiveLens] 忽略非发言类消息', { msgSource, text: chatMsg.content });
      return;
    }
    // 本地回显消息（自己刚发出、服务端尚未确认）跳过，只认服务端广播的那一条
    if (chatMsg.isLocal === true) {
      console.debug('[LiveLens] 跳过本地回显消息', { text: chatMsg.content });
      return;
    }

    const mapped = this.mapChatMsg(chatMsg);

    // 幂等：重连或消息重放时，同一条消息只进入分析流程一次
    if (mapped.id) {
      if (this.seenIds.has(mapped.id)) return;
      this.seenIds.add(mapped.id);
      if (this.seenIds.size > SEEN_ID_LIMIT) {
        // 简单策略：超过上限后清空，代价是极老的消息理论上可能重复（可接受）
        this.seenIds.clear();
      }
    }

    this.emit(mapped);
  }

  /**
   * 官方消息字段 → 项目统一弹幕格式（归一化仍由 normalizeMessage() 完成）。
   * 字段对应关系见 README.md 第 5 节。
   */
  mapChatMsg(chatMsg) {
    const user = chatMsg.user || {};
    return {
      id: chatMsg.id || '',
      userId: user.userId || user.nick || 'anonymous',
      nick: user.nick || '',
      text: chatMsg.content ?? '',
      ts: toMillis(chatMsg.time),
      roomId: String(this.roomId || CONFIG.polyv.channelId),
      meta: {
        polyvMsgSource: chatMsg.msgSource,
        polyvUserType: user.userType,
        // 原始对象保留在 meta 中供调试，不参与任何算法
        polyvRaw: chatMsg,
      },
    };
  }

  /**
   * 断开连接：先走官方 disconnect，再销毁 watchCore，最后解绑所有监听。
   * 幂等：重复调用不会产生副作用。
   */
  async disconnect() {
    if (this.state === CONN.IDLE && !this.watchCore) {
      this.connected = false;
      return;
    }
    this.state = CONN.CLOSING;
    this.connected = false;
    await this.teardown();
    this.state = CONN.IDLE;
    this.onStatus({ status: 'idle', message: '' });
  }

  /** 彻底清理：断开 socket + 销毁 core + 解绑监听 + 清空去重表 */
  async teardown() {
    const core = this.watchCore;
    this.watchCore = null;

    // 统一解绑，杜绝"断开后重连导致同一条回调触发两次"
    while (this.unbinders.length) {
      const off = this.unbinders.pop();
      try { off(); } catch { /* 忽略单个解绑失败 */ }
    }

    if (core) {
      try { await core.disconnect?.(); } catch { /* 断开失败也要继续销毁 */ }
      try { this.sdk?.destroyWatchCore?.(core); } catch { /* ignore */ }
    }

    this.seenIds.clear();
    this.setupFailDetail = null;
  }

  /** 暂停：保持 socket 连接，只是不再把消息交给上层（与模拟源行为一致） */
  pause() {
    super.pause();
    if (this.state === CONN.LIVE) this.onStatus({ status: 'paused' });
  }

  /** 继续：不重新连接，因此不会产生重复监听 */
  resume() {
    super.resume();
    if (this.state === CONN.LIVE) this.onStatus({ status: 'live', source: SOURCE.POLYV });
  }
}

export { CONN };
