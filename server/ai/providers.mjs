/**
 * server/ai/providers.mjs —— Provider 编排：真实模型优先，失败自动回退模拟
 * ------------------------------------------------------------
 * 这是 P2 的核心决策点：
 *   - 配了 AI_API_KEY → 走真实大模型（OpenAI 兼容协议）；
 *   - 没配 Key / 调用失败 / 模型输出不可用 → **自动回退**到本地规则模拟，
 *     页面永远有洞察可看，绝不会因为模型挂了而白屏；
 *   - 回退不是静默：data.disclaimer 与响应 meta 里会写明原因，用户知道这次为什么是模拟。
 */
import { buildMockInsight } from '../../src/ai/mockInsight.js';
import { validateInsight } from '../../src/ai/schema.js';
import { readAiEnv } from '../env.mjs';
import { SYSTEM_PROMPT, buildUserPrompt, RETRY_REMINDER } from './prompt.mjs';
import { createOpenAICompatClient, AiCallError, AI_ERROR_KINDS } from './openaiCompat.mjs';

/**
 * 从模型输出里提取 JSON 对象。
 * 模型很爱裹 ```json 代码块，或者前后客套话，这里做三层剥离：
 *   1. 去掉 markdown 代码块围栏；
 *   2. 截取第一个 { 到最后一个 }；
 *   3. JSON.parse。
 * @returns {object|null} 解析失败返回 null
 */
export function extractJson(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 调用真实模型，返回**符合 schema 的原始洞察**（未过 validateInsight） */
async function callRealModel(payload, env, { fetchImpl } = {}) {
  const client = createOpenAICompatClient({
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    model: env.model,
    timeoutMs: env.timeoutMs,
    fetchImpl,
  });

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  messages.push({ role: 'user', content: buildUserPrompt(payload) });

  // 第一次调用
  let content;
  try {
    const res = await client.chat(messages, { temperature: env.temperature });
    content = res.content;
  } catch (err) {
    // 限流/服务端抖动值得原样再试一次；密钥错误重试没意义
    if (err instanceof AiCallError && (err.kind === AI_ERROR_KINDS.RATE_LIMIT || err.kind === AI_ERROR_KINDS.SERVER)) {
      const res = await client.chat(messages, { temperature: env.temperature });
      content = res.content;
    } else {
      throw err;
    }
  }

  let parsed = extractJson(content);

  // 输出不是合法 JSON：带提醒重试一次（temperature 压低）
  if (!parsed) {
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: RETRY_REMINDER });
    const res = await client.chat(messages, { temperature: 0.1 });
    parsed = extractJson(res.content);
  }

  if (!parsed) {
    throw new AiCallError(AI_ERROR_KINDS.BAD_RESPONSE, '模型两次输出都不是合法 JSON');
  }

  // 打上真实模型标记，交给 validateInsight 做结构兜底
  return {
    ...parsed,
    model: env.model,
    mode: 'real',
    generatedAt: new Date().toISOString(),
    disclaimer: parsed.disclaimer || `由 ${env.model} 生成，基于本地统计的结构化摘要`,
  };
}

/**
 * 生成洞察：真实优先，任何失败都回退 mock。
 *
 * @param {object} payload 前端送来的结构化摘要
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl] 测试注入
 * @param {object}   [deps.env]       测试注入（默认读环境变量）
 * @returns {Promise<{data:object, mode:'real'|'mock', usedFallback:boolean, fallbackReason:string, model:string, latencyMs:number}>}
 */
export async function generateInsight(payload, deps = {}) {
  const env = deps.env || readAiEnv();
  const startedAt = Date.now();

  if (env.apiKey) {
    try {
      const raw = await callRealModel(payload, env, { fetchImpl: deps.fetchImpl });
      const { ok, errors, data } = validateInsight(raw);
      if (!ok) {
        throw new AiCallError(
          AI_ERROR_KINDS.BAD_RESPONSE,
          `模型输出缺少必要字段：${errors.join('；')}`,
        );
      }
      return {
        data,
        mode: 'real',
        model: data.model,
        usedFallback: false,
        fallbackReason: '',
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      // —— 真实模型失败：回退 mock，并把原因写进 disclaimer，绝不静默 ——
      const reason = err?.message || String(err);
      const mockRaw = buildMockInsight(payload);
      mockRaw.mode = 'mock';
      mockRaw.model = 'mock-rules-v1';
      mockRaw.disclaimer = `真实模型暂不可用（${reason}），本次为本地规则模拟结果`;
      const { data } = validateInsight(mockRaw);
      return {
        data,
        mode: 'mock',
        model: data.model,
        usedFallback: true,
        fallbackReason: reason,
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  // —— 没配 Key：直接 mock ——
  const mockRaw = buildMockInsight(payload);
  const { data } = validateInsight(mockRaw);
  return {
    data,
    mode: 'mock',
    model: data.model,
    usedFallback: false,
    fallbackReason: '未配置 AI_API_KEY，使用本地规则模拟',
    latencyMs: Date.now() - startedAt,
  };
}
