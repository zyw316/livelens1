/**
 * server/env.mjs —— 零依赖 .env 加载
 * ------------------------------------------------------------
 * 为什么不用 dotenv 包：项目坚持「零依赖」，一个 .env 解析器二十行就够了。
 * 规则从简：
 *   - 每行 KEY=VALUE，# 开头为注释，空行忽略；
 *   - VALUE 两侧空白去掉，成对的单/双引号剥掉；
 *   - 不展开变量、不处理多行值（本项目用不到）；
 *   - **不覆盖** process.env 里已有的值（显式环境变量优先，便于临时切换）。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // server/ 的上一级 = 项目根

/** 解析 .env 文本为键值对 */
export function parseEnv(text = '') {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 把项目根目录下的 .env 合入 process.env（已存在的不覆盖）。
 * 文件不存在时静默返回——没配 .env 是完全正常的（走模拟模式）。
 * @returns {Promise<{loaded:boolean, path:string, keys:number}>}
 */
export async function loadDotEnv() {
  const path = join(ROOT, '.env');
  try {
    const text = await readFile(path, 'utf8');
    const parsed = parseEnv(text);
    let applied = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        applied += 1;
      }
    }
    return { loaded: true, path, keys: applied };
  } catch {
    return { loaded: false, path, keys: 0 };
  }
}

/** 当前密钥配置是否指向 OpenAI 兼容服务（DeepSeek / 通义 / 智谱 / OpenAI …） */
export function readAiEnv(env = process.env) {
  return {
    apiKey: (env.AI_API_KEY || env.OPENAI_API_KEY || '').trim(),
    baseUrl: (env.AI_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/+$/, ''),
    model: (env.AI_MODEL || 'deepseek-chat').trim(),
    timeoutMs: Number(env.AI_TIMEOUT_MS) || 12000,
    temperature: Number.isFinite(Number(env.AI_TEMPERATURE)) ? Number(env.AI_TEMPERATURE) : 0.3,
  };
}

/**
 * 跨域白名单配置（CORS_ALLOWED_ORIGINS）。
 * 用途：页面托管在 A 域名（如 GitHub Pages）、AI 后端单独部署在 B 域名时，
 * 浏览器会按 Origin 校验拦截跨域请求，服务端需要显式放行。
 * 未配置 = 放开所有 Origin（演示项目默认行为；密钥由部署者自己保管）。
 * @returns {{allowAll:boolean, origins:string[]}}
 */
export function readCorsEnv(env = process.env) {
  const raw = (env.CORS_ALLOWED_ORIGINS || '').trim();
  const origins = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { allowAll: origins.length === 0, origins };
}

/** 某个 Origin 是否放行（无 Origin 的请求（如 curl / 同源）不需要 CORS 头） */
export function isOriginAllowed(origin, cors = readCorsEnv()) {
  if (!origin) return false;
  return cors.allowAll || cors.origins.includes(origin);
}
