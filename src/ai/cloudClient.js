/**
 * ai/cloudClient.js —— 前端直调 WorkBuddy 云 LLM（免费、免密钥）
 * ------------------------------------------------------------
 * 背景：浏览器不能直接「调用模型厂商」的付费接口，但 WorkBuddy 云服务提供
 * keyless LLM API——用 publishableKey（可公开，不带权限）即可调用，无需用户
 * 注册任何模型厂商账号。这是官方唯一允许的形态（明确禁止服务端代理）。
 *
 * 策略：
 *   - CDN 动态加载官方 SDK（与保利威 SDK 同一模式，零构建、按需加载）；
 *   - 每次会话只加载一次；任何一步失败都抛 BackendUnavailableError，
 *     由上层（batcher）自动回退到自有后端通道（DeepSeek Key 或本地模拟）；
 *   - 本机 Origin 若不被云服务放行，会在这里失败并回退——用户无感知。
 */
import { SYSTEM_PROMPT, buildUserPrompt, RETRY_REMINDER } from './prompt.js?v=20261023f';
import { validateInsight } from './schema.js?v=20261023f';

/** 后端不可用（SDK 加载失败 / 云服务拒绝 / 网络不通）——上层据此回退 */
export class CloudUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CloudUnavailableError';
    this.unavailable = true;
  }
}

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

/** 懒加载的云客户端 Promise（整个页面会话只初始化一次） */
let cloudPromise = null;
/** 已选定的模型 id（models.list 只查一次） */
let modelPromise = null;

/** 动态加载官方 SDK，返回全局 WorkBuddyCloud */
function loadSdk() {
  return new Promise((resolve, reject) => {
    if (window.WorkBuddyCloud?.createWorkBuddyCloud) {
      resolve(window.WorkBuddyCloud);
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.onload = () => {
      if (window.WorkBuddyCloud?.createWorkBuddyCloud) resolve(window.WorkBuddyCloud);
      else reject(new CloudUnavailableError('云 AI 组件加载后未就绪'));
    };
    script.onerror = () => reject(new CloudUnavailableError('云 AI 组件加载失败（CDN 不可达）'));
    document.head.appendChild(script);
  });
}

/**
 * 初始化云客户端（幂等）。
 * @param {{endpoint:string, publishableKey:string}} config
 */
function getCloud(config) {
  if (!cloudPromise) {
    cloudPromise = loadSdk()
      .then((sdk) => sdk.createWorkBuddyCloud({
        endpoint: config.endpoint,
        publishableKey: config.publishableKey,
      }))
      .catch((err) => {
        cloudPromise = null; // 允许下次重试（例如网络恢复后）
        throw err;
      });
  }
  return cloudPromise;
}

/** 选定一个可用模型：优先偏好列表，否则取第一个未禁用模型 */
async function pickModel(cloud, preferred = []) {
  if (!modelPromise) {
    modelPromise = (async () => {
      const models = await cloud.llm.models.list();
      if (!Array.isArray(models) || models.length === 0) {
        throw new CloudUnavailableError('云端没有可用模型');
      }
      for (const id of preferred) {
        const hit = models.find((m) => m.id === id && m.disabled !== true);
        if (hit) return hit.id;
      }
      const first = models.find((m) => m.disabled !== true);
      if (!first) throw new CloudUnavailableError('云端模型均被禁用');
      return first.id;
    })().catch((err) => {
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

/** 从模型回复里提取 JSON 对象（容忍 ```json 代码块与前后废话） */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 请求一次云端洞察。
 * @param {object} payload 结构化摘要（ai/batcher.js 构建）
 * @param {object} options
 * @param {object} options.config  CONFIG.ai.cloud（endpoint / publishableKey / preferredModels）
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{raw:object, latencyMs:number}>}
 */
export async function requestCloudInsight(payload, options = {}) {
  const config = options.config || {};
  const timeoutMs = Number(options.timeoutMs) || 30000;

  if (!config.endpoint || !config.publishableKey) {
    throw new CloudUnavailableError('云 AI 未配置（缺少 endpoint 或 publishableKey）');
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let cloud;
  let model;
  try {
    cloud = await getCloud(config);
    model = await pickModel(cloud, config.preferredModels || []);
  } catch (err) {
    clearTimeout(timer);
    throw err instanceof CloudUnavailableError
      ? err
      : new CloudUnavailableError(`云 AI 初始化失败（${err?.message || '未知错误'}）`);
  }

  /** 跑一轮对话并收集全文 */
  async function runOnce(messages) {
    let content = '';
    for await (const chunk of cloud.llm.chat.completions.create({
      model,
      messages,
      stream: true,
      temperature: 0.3,
      signal: controller.signal,
    })) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
    }
    return content;
  }

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(payload) },
    ];
    let content = await runOnce(messages);
    let parsed = extractJson(content);

    // 模型偶尔不守规矩：带提醒重试一次，仍失败则交由上层回退
    if (!parsed) {
      content = await runOnce([
        ...messages,
        { role: 'assistant', content },
        { role: 'user', content: RETRY_REMINDER },
      ]);
      parsed = extractJson(content);
    }
    if (!parsed) {
      throw new CloudUnavailableError('云端模型未返回合法 JSON');
    }

    const { ok, errors, data } = validateInsight({
      ...parsed,
      mode: 'real',
      model,
      disclaimer: `由 WorkBuddy 云端大模型（${model}）生成，数字均来自本地弹幕统计`,
    });
    if (!ok) {
      throw new CloudUnavailableError(`云端模型输出结构不完整：${errors.join('；')}`);
    }
    return { raw: data, latencyMs: Date.now() - startedAt };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new CloudUnavailableError(`云端模型响应超时（${timeoutMs / 1000}s）`);
    }
    if (err instanceof CloudUnavailableError) throw err;
    throw new CloudUnavailableError(`云端模型调用失败（${err?.error?.message || err?.message || '未知错误'}）`);
  } finally {
    clearTimeout(timer);
  }
}
