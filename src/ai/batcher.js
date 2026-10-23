/**
 * ai/batcher.js —— 批次调度：什么时候请求、送什么数据
 * ------------------------------------------------------------
 * 旁挂式设计的关键：
 *   1. 只读 core store 的**成品结果**（stats / clusters / focus / alerts），不重算、不回写；
 *   2. 送给后端的是结构化摘要（分类计数 + 代表性问题标题），不是全量原始弹幕；
 *   3. 任何异常都在这里被吞掉并转成 AI 状态的错误提示，绝不抛给核心渲染链路。
 */
import { validateInsight, AI_STATUS } from './schema.js?v=20261023f';
import { requestInsight, BackendUnavailableError } from './aiClient.js?v=20261023f';
import { requestCloudInsight, CloudUnavailableError } from './cloudClient.js?v=20261023f';
import { buildMockInsight } from './mockInsight.js?v=20261023f';

/** 代表性问题标题最多保留的长度，避免把长句整段送出去 */
const QUESTION_MAX_CHARS = 40;

/**
 * 本地规则模拟客户端（第三级兜底）。
 * 场景：云端 AI 不放行当前域名（如 GitHub Pages）+ 后端也不在（纯静态托管 404/405）。
 * 用已有统计结果本地生成洞察，保证 AI 面板永远有内容，且明确标注是模拟结果。
 * 返回结构与云端 / 后端完全一致，上层无感知。
 */
export function createMockClient() {
  return async function mockClient(payload) {
    const { ok, errors, data } = validateInsight(buildMockInsight(payload));
    if (!ok) throw new Error(`本地模拟生成失败：${errors.join('；')}`);
    return { raw: data, latencyMs: 0, meta: { mode: 'mock', source: 'client-fallback' } };
  };
}

/**
 * 通道客户端：三级降级 —— 云端大模型优先，失败回退自有后端，后端也不可用时回退本地模拟。
 * 云端失败一次后本次会话不再重试（本机 Origin 不放行是常见原因，反复试只是拖慢批次）。
 *
 * @param {object} deps
 * @param {object} deps.cloudConfig      CONFIG.ai.cloud
 * @param {Function} deps.backendClient  自有后端请求实现（默认 requestInsight）
 * @param {Function} [deps.cloudClient]  云端请求实现（测试可注入）
 * @param {Function|null} [deps.mockClient] 本地模拟兜底（默认 createMockClient()；传 null 关闭）
 */
export function createChannelClient({
  cloudConfig,
  backendClient,
  cloudClient = requestCloudInsight,
  mockClient = createMockClient(),
}) {
  let cloudDisabled = false;
  /** 云端失败原因留着：后端也失败时一起透出，方便定位「为什么没走云端」 */
  let cloudFailReason = '';
  return async function channelClient(payload, opts) {
    if (!cloudDisabled && cloudConfig?.enabled !== false && cloudConfig?.endpoint) {
      try {
        return await cloudClient(payload, {
          config: cloudConfig,
          timeoutMs: cloudConfig.timeoutMs || 30000,
        });
      } catch (err) {
        cloudDisabled = true;
        cloudFailReason = err?.message || String(err);
        console.info('[LiveLens] 云端 AI 不可用，本次回退自有后端：', cloudFailReason);
      }
    }
    try {
      return await backendClient(payload, opts);
    } catch (err) {
      // 后端不可用（404 / 405 / 网络断）——纯静态托管（GitHub Pages 等）的标准姿势。
      // 第三级兜底：本地规则模拟，洞察面板永远有内容，并在 disclaimer 里写明为什么是模拟。
      if (mockClient && err?.unavailable) {
        const out = await mockClient(payload, { cloudFailReason });
        const reasons = [
          cloudFailReason && `云端 AI 不可用（${cloudFailReason}）`,
          `未检测到本地 AI 服务（${err.message}）`,
        ].filter(Boolean).join('；');
        out.raw = { ...out.raw, disclaimer: `本次为本地规则模拟结果：${reasons}` };
        return out;
      }
      // 后端真实报错（500 / 结构不合法等）：不兜底、不掩盖，原样抛出；
      // 若云端此前也失败过，把原因附在消息里——只改 message，不换错误对象，
      // 保住 instanceof 与 unavailable 标记（上层降级判断依赖它们）。
      if (cloudFailReason) {
        err.message = `${err.message}（云端通道亦不可用：${cloudFailReason}）`;
      }
      throw err;
    }
  };
}

/**
 * 构建送给后端的结构化摘要（纯函数，便于单测）。
 * @param {object} state core store 的状态
 * @returns {object}
 */
export function buildPayload(state) {
  const result = state?.result || {};
  const stats = result.stats || {};
  const raw = Array.isArray(state?.raw) ? state.raw : [];

  const from = raw.length ? raw[0].timestamp : 0;
  const to = raw.length ? raw[raw.length - 1].timestamp : 0;

  const shorten = (text) => {
    const s = String(text || '').trim();
    return s.length > QUESTION_MAX_CHARS ? `${s.slice(0, QUESTION_MAX_CHARS)}…` : s;
  };

  return {
    window: {
      from,
      to,
      messageCount: Number(stats.total) || raw.length,
      uniqueUsers: Number(stats.uniqueUsers) || 0,
    },
    stats: {
      total: Number(stats.total) || 0,
      passed: Number(stats.passed) || 0,
      noise: Number(stats.noise) || 0,
      noiseRate: Number(stats.noiseRate) || 0,
      intents: { ...(stats.intents || {}) },
      categories: (stats.categories || []).map((c) => ({
        id: c.id,
        label: c.label,
        count: c.count,
        ratio: c.ratio,
      })),
    },
    focus: (result.focus || []).slice(0, 5).map((f) => ({
      rank: f.rank,
      title: shorten(f.title),
      type: { key: f.type?.key || 'unknown', label: f.type?.label || '' },
      count: f.count,
      userCount: f.userCount,
      score: Number(f.score?.toFixed?.(3) ?? f.score),
    })),
    lowFrequency: (result.alerts || []).slice(0, 5).map((a) => ({
      title: shorten(a.title),
      count: a.count,
      severity: a.severity,
      level: a.level,
      categoryId: a.categoryId,
      categoryLabel: a.categoryLabel,
    })),
    questions: (result.clusters || []).slice(0, 6).map((c) => ({
      text: shorten(c.title),
      categoryId: c.categoryId,
      count: c.count,
    })),
  };
}

/**
 * @param {object} deps
 * @param {object} deps.store        core store（只读）
 * @param {object} deps.aiStore      AI 状态容器（只写 AI 自己的状态）
 * @param {object} deps.config       CONFIG.ai（含 cloud 子配置）
 * @param {Function} [deps.client]   自有后端请求实现，默认 requestInsight（测试可注入）
 * @param {Function} [deps.channelClient] 完整通道客户端（测试可注入，默认云端优先+回退后端）
 * @param {Function} [deps.now]      时间源，便于测试
 */
export function createAiBatcher({
  store,
  aiStore,
  config,
  client = requestInsight,
  channelClient,
  now = () => Date.now(),
}) {
  const cfg = {
    endpoint: config?.endpoint || '/api/ai/insight',
    intervalMs: Number(config?.batchIntervalMs) || 15000,
    minNewMessages: Number(config?.minNewMessages) || 3,
    timeoutMs: Number(config?.timeoutMs) || 8000,
  };

  /** 实际请求入口：云端优先 → 失败回退自有后端 → 后端不可用回退本地模拟 */
  const request = channelClient
    || createChannelClient({ cloudConfig: config?.cloud, backendClient: client });

  let timer = null;
  let busy = false;
  /** 上一次成功请求时，core 缓冲区里已有多少条（用差值判断「有没有新料」） */
  let lastRawCount = 0;
  /** 后端不可用后就别一直轰它，等用户点「重试」或等冷却结束 */
  let coolDownUntil = 0;

  function coreState() {
    return store.getState();
  }

  /** 有没有足够的新数据值得再问一次 */
  function hasFreshData() {
    const len = Array.isArray(coreState().raw) ? coreState().raw.length : 0;
    const delta = len >= lastRawCount ? len - lastRawCount : len; // 重置演示时 len 会变小
    return delta >= cfg.minNewMessages;
  }

  async function runOnce({ manual = false } = {}) {
    const ai = aiStore.getState();
    if (!ai.enabled && !manual) return { skipped: 'disabled' };
    if (busy) return { skipped: 'busy' };
    if (!manual) {
      if (now() < coolDownUntil) return { skipped: 'cooldown' };
      if (!hasFreshData()) return { skipped: 'no-new-data' };
    }

    busy = true;
    const stateAtRequest = coreState();
    const payload = buildPayload(stateAtRequest);
    const rawCountAtRequest = Array.isArray(stateAtRequest.raw) ? stateAtRequest.raw.length : 0;

    if (payload.stats.passed === 0) {
      aiStore.setStatus(AI_STATUS.WAITING);
      busy = false;
      return { skipped: 'no-valid-messages' };
    }

    aiStore.setStatus(AI_STATUS.LOADING);

    try {
      const { raw, latencyMs } = await request(payload, {
        endpoint: cfg.endpoint,
        timeoutMs: cfg.timeoutMs,
      });
      const { ok, errors, data } = validateInsight(raw);
      if (!ok) throw new Error(`AI 返回结构不完整：${errors.join('；')}`);

      aiStore.setInsight(data);
      aiStore.setStatus(AI_STATUS.OK, { backendAvailable: true, lastLatencyMs: latencyMs });
      lastRawCount = rawCountAtRequest;
      return { ok: true, data };
    } catch (err) {
      if (err instanceof BackendUnavailableError || err?.unavailable) {
        aiStore.setError(err.message, { unavailable: true });
        // 纯静态模式下没有必要每 15 秒重试一次，冷却 60 秒
        coolDownUntil = now() + 60000;
        return { error: err.message, unavailable: true };
      }
      aiStore.setError(err?.message || String(err));
      return { error: err?.message || String(err) };
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch((err) => {
        // 理论上 runOnce 内部已全部处理，这里只是最后一道保险
        console.error('[LiveLens] AI 批次异常', err);
      });
    }, cfg.intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 用户点「立即分析」：忽略冷却与增量判断，直接跑一次 */
  function runNow() {
    coolDownUntil = 0;
    return runOnce({ manual: true });
  }

  /** 供测试/调试：重置增量基线 */
  function resetBaseline() {
    lastRawCount = 0;
    coolDownUntil = 0;
  }

  return { start, stop, runNow, runOnce, resetBaseline, buildPayload };
}
