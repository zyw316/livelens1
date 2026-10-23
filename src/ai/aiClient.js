/**
 * ai/aiClient.js —— 与自有后端通信（P1 只打 /api/ai/insight，绝不直接调模型厂商）
 * ------------------------------------------------------------
 * 安全约定：
 *   - 前端永远不持有任何模型 API Key；密钥将来只存在于服务端环境变量里。
 *   - 纯静态托管（python -m http.server / GitHub Pages 等）时该接口返回 404 或 405，
 *     客户端识别为「后端未启动」，页面只提示、不报错，core 流程完全不受影响。
 */

/**
 * 后端不可用（未启动 / 404 / 网络断开）——与「后端返回了错误」区分开，
 * 前者只提示一次，不必反复重试刷屏。
 */
export class BackendUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackendUnavailableError';
    this.unavailable = true;
  }
}

/**
 * 请求一次洞察。
 * @param {object} payload 结构化摘要（见 ai/batcher.js buildPayload）
 * @param {{endpoint:string, timeoutMs:number}} options
 * @returns {Promise<{raw:any, latencyMs:number}>}
 */
export async function requestInsight(payload, options = {}) {
  const endpoint = options.endpoint || '/api/ai/insight';
  const timeoutMs = Number(options.timeoutMs) || 8000;
  const startedAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // 中止 = 超时；其余多为网络层失败（后端没起、被代理拦）
    if (err?.name === 'AbortError') throw new Error(`AI 服务响应超时（${timeoutMs}ms）`);
    throw new BackendUnavailableError(`无法连接 AI 服务（${err?.message || '网络错误'}）`);
  } finally {
    clearTimeout(timer);
  }

  // 404：本地没起服务；405：纯静态托管（GitHub Pages / Vercel 静态等）根本不接受 POST。
  // 两者都算「后端不可用」——只提示、不报错堆栈，交给上层走本地模拟兜底。
  if (res.status === 404 || res.status === 405) {
    const why = res.status === 405
      ? '当前站点是纯静态托管（如 GitHub Pages），没有可用的 AI 后端服务（POST 返回 405）'
      : '未检测到本地 AI 服务（/api/ai/insight 返回 404）';
    throw new BackendUnavailableError(why);
  }
  if (!res.ok) {
    throw new Error(`AI 服务返回 HTTP ${res.status}`);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('AI 服务返回的内容不是合法 JSON');
  }

  if (!json || json.ok !== true || !json.data) {
    throw new Error(json?.error || 'AI 服务返回的数据格式不符合约定');
  }

  return { raw: json.data, latencyMs: Date.now() - startedAt, meta: json.meta || {} };
}
