/**
 * server/ai/openaiCompat.mjs —— OpenAI 兼容协议的最小客户端
 * ------------------------------------------------------------
 * 覆盖 DeepSeek / 智谱 / Moonshot / OpenAI / 通义等所有提供
 * `POST {baseUrl}/chat/completions` 的服务，零依赖（用 Node 18+ 内置 fetch）。
 *
 * 错误规范化：把各种失败归成几类，让上层知道该不该重试、该给用户看什么：
 *   - auth      ：密钥无效/过期（401/403）——重试无意义，直接提示检查 Key
 *   - rateLimit：限流（429）——可稍后重试
 *   - server    ：模型服务端错误（5xx）
 *   - network   ：网络不通/DNS/被墙
 *   - timeout   ：超时
 */

/** 可识别的错误类型 */
export const AI_ERROR_KINDS = {
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  SERVER: 'server',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  BAD_RESPONSE: 'bad_response',
};

export class AiCallError extends Error {
  constructor(kind, message, { status } = {}) {
    super(message);
    this.name = 'AiCallError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * 创建一个客户端。
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.baseUrl   例如 https://api.deepseek.com
 * @param {string} options.model     例如 deepseek-chat
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl] 测试可注入
 */
export function createOpenAICompatClient({
  apiKey,
  baseUrl,
  model,
  timeoutMs = 12000,
  fetchImpl,
}) {
  if (!apiKey) throw new AiCallError(AI_ERROR_KINDS.AUTH, '未配置 AI_API_KEY');
  if (!baseUrl) throw new AiCallError(AI_ERROR_KINDS.NETWORK, '未配置 AI_BASE_URL');
  const doFetch = fetchImpl || fetch;

  /**
   * 发起一次对话。
   * @param {Array<{role:string, content:string}>} messages
   * @returns {Promise<{content:string, model:string, usage:object|null}>}
   */
  async function chat(messages, { temperature = 0.3, maxTokens = 1400 } = {}) {
    const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new AiCallError(AI_ERROR_KINDS.TIMEOUT, `模型请求超时（${timeoutMs}ms）`);
      }
      throw new AiCallError(
        AI_ERROR_KINDS.NETWORK,
        `无法连接模型服务 ${baseUrl}（${err?.message || '网络错误'}）`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      const detail = extractErrorDetail(text);
      if (res.status === 401 || res.status === 403) {
        throw new AiCallError(
          AI_ERROR_KINDS.AUTH,
          `模型服务拒绝访问（HTTP ${res.status}）：密钥无效或未开通。${detail}`,
          { status: res.status },
        );
      }
      if (res.status === 429) {
        throw new AiCallError(
          AI_ERROR_KINDS.RATE_LIMIT,
          `模型服务限流（HTTP 429），请稍后重试。${detail}`,
          { status: res.status },
        );
      }
      throw new AiCallError(
        AI_ERROR_KINDS.SERVER,
        `模型服务异常（HTTP ${res.status}）。${detail}`,
        { status: res.status },
      );
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiCallError(AI_ERROR_KINDS.BAD_RESPONSE, '模型返回的不是合法 JSON');
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiCallError(AI_ERROR_KINDS.BAD_RESPONSE, '模型返回内容为空');
    }
    return {
      content,
      model: json.model || model,
      usage: json.usage || null,
    };
  }

  return { chat };
}

/** 从错误响应体里提取一句可读原因（各家格式不一，尽力而为） */
function extractErrorDetail(text) {
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message || json?.message || json?.error?.code;
    return msg ? `服务端信息：${String(msg).slice(0, 200)}` : '';
  } catch {
    return text ? `服务端信息：${String(text).slice(0, 120)}` : '';
  }
}
