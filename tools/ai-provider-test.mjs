/**
 * tools/ai-provider-test.mjs —— 真实模型 Provider 链路测试（零依赖）
 * ------------------------------------------------------------
 * 不起真实网络、不需要真密钥：用一个本地假「OpenAI 兼容服务器」扮演模型服务，
 * 把 P2 的关键路径全部跑一遍：
 *   1. 未配置 Key            → 直接本地模拟；
 *   2. 假 Key + 正常响应      → 走真实模式，JSON 字段正确映射；
 *   3. 假 Key + 401          → 回退本地模拟，且注明原因（页面不会白屏）；
 *   4. 假 Key + 第一次坏 JSON → 自动重试后成功；
 *   5. 假 Key + 两次都坏      → 回退本地模拟；
 *   6. Prompt 构建           → 摘要数据确实进了 prompt。
 *
 * 运行：node tools/ai-provider-test.mjs
 */
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { generateInsight, extractJson } from '../server/ai/providers.mjs';
import { SYSTEM_PROMPT, buildUserPrompt } from '../server/ai/prompt.mjs';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/** 造一份和真实批次 payload 同构的摘要 */
function makePayload() {
  return {
    window: { from: 1, to: 60000, messageCount: 20, uniqueUsers: 12 },
    stats: {
      total: 20,
      passed: 16,
      noise: 4,
      noiseRate: 0.2,
      intents: { question: 9, demand: 5, feedback: 2 },
      categories: [
        { id: 'size', label: '尺码合身', count: 9, ratio: 0.562 },
        { id: 'fabric', label: '面料质感', count: 4, ratio: 0.25 },
      ],
    },
    focus: [
      { rank: 1, title: '这条裤子有s码吗', type: { key: 'hot_demand', label: '高频需求' }, count: 9, userCount: 8, score: 0.72 },
    ],
    lowFrequency: [
      { title: '支付失败怎么回事', count: 1, severity: 1, level: 'high', categoryId: 'payment', categoryLabel: '支付下单' },
    ],
    questions: [
      { text: '这条裤子有s码吗', categoryId: 'size', count: 9 },
      { text: '面料起球吗', categoryId: 'fabric', count: 4 },
    ],
  };
}

/** 模型「正常」时返回的洞察内容 */
const GOOD_MODEL_JSON = JSON.stringify({
  summary: '近 1 分钟 16 条有效弹幕，尺码合身最集中（9 条，56%），另有 1 条支付失败需立即跟进。',
  trend: { direction: 'up', label: '决策期', note: '需求与反馈占比高，观众在比价与确认' },
  implicitNeeds: [
    { need: '怕买错尺码要退换', evidence: '尺码类 9 条占 56%，集中在 s 码有无', confidence: 0.88 },
  ],
  categories: [
    { id: 'size', label: '尺码合身', count: 9, share: 0.562, reading: '尺码表与主播口径需统一' },
    { id: 'fabric', label: '面料质感', count: 4, share: 0.25, reading: '需要成分与克重等可验证细节' },
  ],
  lowFrequency: [
    { title: '支付失败怎么回事', why: '直接影响成交', action: '一对一跟进并排查支付通道' },
  ],
  replySuggestions: [
    { question: '这条裤子有s码吗', reply: 'S 码还有货，我 160cm/48kg 穿 S 正好，胯宽建议大一码～' },
  ],
  merchantActions: [
    { action: '置顶尺码表', priority: 'P0', reason: '尺码问题占 56%，是最大阻塞点' },
  ],
});

/**
 * 起一个假模型服务器。
 * @param {(reqBody:object, callIndex:number)=>object} responder 返回 OpenAI 风格响应体
 */
function startFakeModel(responder) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* 保持 {} */ }
      calls.push({ headers: req.headers, body: parsed });
      const out = responder(parsed, calls.length);
      const status = out.status || 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? out));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** OpenAI chat/completions 成功响应 */
function okResponse(content, model = 'fake-model-v1') {
  return { status: 200, body: { model, choices: [{ message: { role: 'assistant', content } }] } };
}

async function main() {
  const payload = makePayload();

  // —— 1. 未配置 Key：直接 mock ——
  {
    const out = await generateInsight(payload, { env: { apiKey: '', baseUrl: 'http://127.0.0.1:1', model: 'x', timeoutMs: 3000 } });
    check('未配置 Key → 本地模拟', () => {
      assert.equal(out.mode, 'mock');
      assert.equal(out.usedFallback, false);
      assert.equal(out.data.mode, 'mock');
      assert.ok(out.data.summary.includes('尺码合身'));
      assert.ok(out.data.disclaimer.includes('本地规则'));
    });
  }

  // —— 2. 假 Key + 正常响应：真实模式，字段映射正确 ——
  {
    const fake = await startFakeModel(() => okResponse(GOOD_MODEL_JSON));
    const out = await generateInsight(payload, {
      env: { apiKey: 'sk-fake', baseUrl: fake.baseUrl, model: 'deepseek-chat', timeoutMs: 5000 },
      fetchImpl: (...args) => fetch(...args),
    });
    check('假 Key + 正常响应 → 真实模式', () => {
      assert.equal(out.mode, 'real');
      assert.equal(out.usedFallback, false);
      assert.equal(out.data.mode, 'real');
      assert.equal(out.data.model, 'deepseek-chat');
      assert.equal(out.data.categories[0].count, 9);
      assert.equal(out.data.merchantActions[0].priority, 'P0');
      assert.ok(out.data.summary.includes('16 条'));
    });
    check('真实模式带了 Bearer 头、模型名与系统 Prompt', () => {
      assert.equal(fake.calls.length, 1);
      const call = fake.calls[0];
      assert.equal(call.headers.authorization, 'Bearer sk-fake');
      assert.equal(call.body.model, 'deepseek-chat');
      assert.equal(call.body.stream, false);
      assert.ok(String(call.body.messages[0].content).includes('运营顾问'));
      assert.ok(String(call.body.messages[1].content).includes('尺码合身'));
    });
    await fake.close();
  }

  // —— 3. 假 Key + 401：回退 mock，注明原因 ——
  {
    const fake = await startFakeModel(() => ({ status: 401, body: { error: { message: 'invalid api key' } } }));
    const out = await generateInsight(payload, {
      env: { apiKey: 'sk-wrong', baseUrl: fake.baseUrl, model: 'm', timeoutMs: 5000 },
      fetchImpl: (...args) => fetch(...args),
    });
    check('假 Key + 401 → 回退本地模拟并注明原因', () => {
      assert.equal(out.mode, 'mock');
      assert.equal(out.usedFallback, true);
      assert.ok(out.fallbackReason.includes('401'));
      assert.ok(out.data.disclaimer.includes('真实模型暂不可用'));
      assert.ok(out.data.summary.length > 0); // 页面依然有洞察可看
    });
    check('401 不重试（密钥错误重试无意义）', () => {
      assert.equal(fake.calls.length, 1);
    });
    await fake.close();
  }

  // —— 4. 第一次坏 JSON（带代码块与废话），第二次正常：重试后成功 ——
  {
    const fake = await startFakeModel((_b, n) =>
      n === 1
        ? okResponse('好的，我来分析一下：\n```json\n{ "summary": "半截', 'm')
        : okResponse(GOOD_MODEL_JSON, 'm'),
    );
    const out = await generateInsight(payload, {
      env: { apiKey: 'sk-fake', baseUrl: fake.baseUrl, model: 'm', timeoutMs: 5000 },
      fetchImpl: (...args) => fetch(...args),
    });
    check('第一次坏 JSON → 自动重试后走真实模式', () => {
      assert.equal(out.mode, 'real');
      assert.equal(out.usedFallback, false);
      assert.equal(fake.calls.length, 2);
      // 第二次请求应带「重试提醒」
      const last = fake.calls[1].body.messages.at(-1);
      assert.ok(String(last.content).includes('合法的 JSON'));
    });
    await fake.close();
  }

  // —— 5. 两次都坏：回退 mock ——
  {
    const fake = await startFakeModel(() => okResponse('我不太确定，但还是随便说点吧', 'm'));
    const out = await generateInsight(payload, {
      env: { apiKey: 'sk-fake', baseUrl: fake.baseUrl, model: 'm', timeoutMs: 5000 },
      fetchImpl: (...args) => fetch(...args),
    });
    check('两次都非 JSON → 回退本地模拟', () => {
      assert.equal(out.mode, 'mock');
      assert.equal(out.usedFallback, true);
      assert.ok(out.fallbackReason.includes('JSON'));
      assert.equal(fake.calls.length, 2);
    });
    await fake.close();
  }

  // —— 6. extractJson 形态覆盖 ——
  check('extractJson：纯 JSON / 代码块 / 带前后废话', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('当然可以：\n{"a":1}\n希望有帮助！'), { a: 1 });
    assert.equal(extractJson('没有 JSON'), null);
    assert.equal(extractJson('{坏了'), null);
  });

  // —— 7. Prompt 确实带上了摘要数据 ——
  check('Prompt 包含分类与低频问题数据', () => {
    const user = buildUserPrompt(payload);
    assert.ok(user.includes('尺码合身'));
    assert.ok(user.includes('支付失败怎么回事'));
    assert.ok(SYSTEM_PROMPT.includes('禁止编造'));
    assert.ok(SYSTEM_PROMPT.includes('只输出一个 JSON 对象'));
  });

  // —— 8. 模型缺必填字段 → 回退（validateInsight 兜底）——
  {
    const fake = await startFakeModel(() => okResponse(JSON.stringify({ summary: '只有一句话', trend: {} }), 'm'));
    const out = await generateInsight(payload, {
      env: { apiKey: 'sk-fake', baseUrl: fake.baseUrl, model: 'm', timeoutMs: 5000 },
      fetchImpl: (...args) => fetch(...args),
    });
    check('模型输出缺字段 → 回退本地模拟', () => {
      assert.equal(out.mode, 'mock');
      assert.equal(out.usedFallback, true);
      assert.ok(out.fallbackReason.includes('缺少'));
    });
    await fake.close();
  }

  console.log(`\n结果：${failed === 0 ? `全部通过 ✅（${passed} 项）` : `${failed} 项失败 ❌`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exit(1);
});
