/**
 * server/index.mjs —— 零依赖本地服务（静态站点 + AI 洞察接口）
 * ------------------------------------------------------------
 * 为什么需要它：
 *   浏览器不能直接「调用模型」，密钥也绝不能进前端。因此 AI 相关请求统一走后端；
 *   后端按优先级选择 Provider（server/ai/providers.mjs）：
 *     1. 配了 AI_API_KEY  → 真实大模型（OpenAI 兼容协议，DeepSeek/智谱/Moonshot/OpenAI…）；
 *     2. 没配 / 调用失败   → 自动回退本地规则模拟（src/ai/mockInsight.js），页面永远可用。
 *
 * 启动：
 *   node server/index.mjs          → http://127.0.0.1:4173（未配 Key = 模拟模式）
 *   AI_API_KEY=sk-xxx node server/index.mjs   → 真实模型模式
 *   或在项目根目录建 .env（见 .env.example）
 *
 * 接口：
 *   POST /api/ai/insight   入参为结构化摘要，返回 { ok, meta, data }
 *   GET  /api/ai/health    健康检查（返回当前 AI 模式与配置来源）
 *
 * 安全约定：
 *   - 模型密钥只从服务端环境变量 / .env 读取，**绝不出现在前端与响应里**；
 *   - 静态文件只允许访问项目根目录内的文件，防止路径穿越；
 *   - /api/* 默认放开跨域（CORS_ALLOWED_ORIGINS 可收紧为白名单），
 *     方便「页面挂 GitHub Pages、后端单独部署」的拆分用法。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, readAiEnv, readCorsEnv, isOriginAllowed } from './env.mjs';
import { generateInsight } from './ai/providers.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';

/** 请求体上限，避免异常请求把内存打满 */
const MAX_BODY = 256 * 1024;

/** 当前 AI 配置（.env 加载后读取，决定启动日志与 health 的展示） */
let AI_ENV = readAiEnv();
/** AI 模式：real = 已配置真实模型；mock = 本地规则模拟。
 *  注意：.env 是在 listen 之前加载的，因此这里用函数动态判断，
 *  不能写成顶层常量（那会早于 .env 加载，导致 .env 里的 Key 不被识别）。 */
const aiMode = () => (readAiEnv().apiKey ? 'real' : 'mock');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 跨域响应头（CORS）。
 * 用途：前端页面托管在 A 域名（如 GitHub Pages）、本服务单独部署在 B 域名时，
 * 浏览器会按 Origin 拦截跨域 fetch，服务端需要显式放行。
 * 规则（server/env.mjs 的 readCorsEnv）：
 *   - 未配置 CORS_ALLOWED_ORIGINS = 放开所有 Origin（演示项目默认行为）；
 *   - 配了则只放行白名单内的 Origin（精确匹配，如 https://user.github.io）。
 * 无 Origin 的请求（同源页面、curl、服务端）不需要 CORS 头，直接跳过。
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isOriginAllowed(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** 读取并解析 JSON 请求体（带上限） */
function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** POST /api/ai/insight */
async function handleInsight(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }

  // 入参做最小校验：至少要有一份 stats，避免空请求也生成"洞察"
  if (!payload || typeof payload !== 'object' || !payload.stats) {
    sendJson(res, 400, { ok: false, error: '缺少结构化摘要（stats）' });
    return;
  }

  const startedAt = Date.now();

  try {
    const outcome = await generateInsight(payload);
    sendJson(res, 200, {
      ok: true,
      meta: {
        mode: outcome.mode,
        model: outcome.model,
        latencyMs: outcome.latencyMs,
        usedFallback: outcome.usedFallback,
        fallbackReason: outcome.fallbackReason || undefined,
        received: {
          passed: payload.stats.passed ?? 0,
          categories: (payload.stats.categories || []).length,
          questions: (payload.questions || []).length,
        },
      },
      data: outcome.data,
    });
  } catch (err) {
    console.error('[ai] 生成洞察失败:', err);
    sendJson(res, 500, { ok: false, error: err.message || '生成洞察失败' });
  }
}

/** 静态文件 */
async function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const target = resolve(join(ROOT, rel));

  // 防路径穿越：解析后必须仍在项目根目录内
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    sendJson(res, 403, { ok: false, error: '禁止访问' });
    return;
  }

  try {
    const info = await stat(target);
    const filePath = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  applyCors(req, res);

  // 预检请求：跨域 POST（Content-Type: application/json 会触发）之前，
  // 浏览器先发一次 OPTIONS，这里直接放行并带上 CORS 头。
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, { 'Content-Length': '0' });
    res.end();
    return;
  }

  if (url.pathname === '/api/ai/health') {
    const mode = aiMode();
    const env = readAiEnv();
    sendJson(res, 200, {
      ok: true,
      mode,
      service: 'livelens-ai',
      model: mode === 'real' ? env.model : 'mock-rules-v1',
      provider: mode === 'real' ? env.baseUrl : 'local-rules',
      hint:
        mode === 'real'
          ? `已接入真实模型 ${env.model}（调用失败会自动回退本地模拟）`
          : '未配置 AI_API_KEY，当前为本地规则模拟；在项目根目录创建 .env 配置后重启即可接入真实模型',
    });
    return;
  }
  if (url.pathname === '/api/ai/insight') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '请使用 POST' });
      return;
    }
    handleInsight(req, res);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { ok: false, error: `未知接口 ${url.pathname}` });
    return;
  }

  serveStatic(req, res, url.pathname);
});

// —— 启动：先加载 .env，再确定 AI 模式 ——
const dotEnv = await loadDotEnv();

server.listen(PORT, HOST, () => {
  AI_ENV = readAiEnv();
  const mode = aiMode();
  console.log(`LiveLens 已启动 → http://127.0.0.1:${PORT}`);
  if (dotEnv.loaded) {
    console.log(`  已加载 .env（${dotEnv.path}，应用 ${dotEnv.keys} 项）`);
  }
  if (mode === 'real') {
    console.log(`  AI 模式: 真实模型 ${AI_ENV.model} @ ${AI_ENV.baseUrl}`);
    console.log('    密钥仅存在于服务端环境变量；调用失败会自动回退本地模拟');
  } else {
    console.log('  AI 模式: 本地规则模拟（未配置 AI_API_KEY，不需要任何密钥）');
    console.log('    接入真实模型：在项目根目录创建 .env（参考 .env.example），重启本服务');
  }
  console.log('  接口: POST /api/ai/insight · GET /api/ai/health');
  const cors = readCorsEnv();
  console.log(
    cors.allowAll
      ? '  CORS: 放开所有 Origin（异域前端可直接调用；配 CORS_ALLOWED_ORIGINS 可收紧）'
      : `  CORS 白名单: ${cors.origins.join(', ')}`,
  );
});
