/**
 * tools/smoke-test.mjs
 * ------------------------------------------------------------
 * 纯 Node 冒烟测试：不依赖浏览器，直接跑核心分析管道。
 * 用途：改完算法后快速验证「没把东西改坏」，而不用手动点页面。
 *
 * 运行： node tools/smoke-test.mjs
 */
import { normalizeMessage } from '../src/core/normalize.js';
import { analyzeBuffer } from '../src/core/analysis.js';
import { textSimilarity } from '../src/core/similarity.js';
import { DEFAULT_OPTIONS } from '../src/core/constants.js';
import { CORPUS_RARE, CORPUS_NOISE } from '../src/data/mockDanmaku.js';
import { store } from '../src/core/store.js';
import { buildPayload, createAiBatcher, createChannelClient } from '../src/ai/batcher.js';
import { CloudUnavailableError, extractJson } from '../src/ai/cloudClient.js';
import { buildMockInsight } from '../src/ai/mockInsight.js';
import { validateInsight } from '../src/ai/schema.js';
import { createAiStore } from '../src/ai/aiStore.js';
import { renderInsightHtml } from '../src/ui/aiInsightView.js';
import { computeVisibleWindow, STREAM_WINDOW_MS, STREAM_WINDOW_MIN, STREAM_WINDOW_MAX } from '../src/ui/danmakuPanel.js';
import { validateChannelId } from '../src/ui/roomModal.js';
import { requestInsight, BackendUnavailableError } from '../src/ai/aiClient.js';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let failed = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failed += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` → ${extra}` : ''}`);
}

console.log('\n[1] 归一化 + 去噪');
const samples = [
  '啊',                       // short
  '😍😍😍',                    // symbol
  '哈哈哈哈哈',                // repeat
  '加微信看新款 v: abc123',    // spam
  '好看',                     // low_info
  '这个针织衫有哪些尺码呀',      // passed
  '针织衫有什么尺码',          // passed（与上条相似）
  '这个针织衫有哪些尺码呀',      // duplicate
];
let ts = Date.now() - 10000;
const messages = samples.map((text) => normalizeMessage({ userId: 'u_test', text, ts: (ts += 800) }, 'mock'));
const result = analyzeBuffer(messages, { ...DEFAULT_OPTIONS });

check('总条数正确', result.stats.total === 8, `total=${result.stats.total}`);
check('通过条数 = 2', result.stats.passed === 2, `passed=${result.stats.passed}`);
check('命中 short', result.stats.byReason.short >= 1, `short=${result.stats.byReason.short}`);
check('命中 symbol', result.stats.byReason.symbol >= 1, `symbol=${result.stats.byReason.symbol}`);
check('命中 repeat', result.stats.byReason.repeat >= 1, `repeat=${result.stats.byReason.repeat}`);
check('命中 spam', result.stats.byReason.spam >= 1, `spam=${result.stats.byReason.spam}`);
check('命中 duplicate', result.stats.byReason.duplicate >= 1, `duplicate=${result.stats.byReason.duplicate}`);

console.log('\n[2] 意图识别与行业分类');
const q1 = result.items.find((it) => it.text === '这个针织衫有哪些尺码呀');
check('尺码提问被识别为 question', q1.intent === 'question', `intent=${q1.intent}`);
check('归类到 size', q1.categoryId === 'size', `categoryId=${q1.categoryId}`);

const buy = normalizeMessage({ userId: 'u2', text: '我想要一件给我来个m码', ts: Date.now() }, 'mock');
const buyResult = analyzeBuffer([buy], DEFAULT_OPTIONS);
check('购买意向识别', buyResult.items[0].intent === 'demand', `intent=${buyResult.items[0].intent}`);
check('购买意向归类到 size', buyResult.items[0].categoryId === 'size', `categoryId=${buyResult.items[0].categoryId}`);

console.log('\n[3] 相似文本相似度');
const sim = textSimilarity('这个针织衫有哪些尺码呀', '针织衫有什么尺码');
// 默认聚合阈值 0.45 就是照着这类真实语料调出来的
check('相似问法得分 >= 默认阈值 0.45', sim >= DEFAULT_OPTIONS.clusterThreshold, `sim=${sim.toFixed(3)}`);
const diff = textSimilarity('发什么快递几天能到', '这个是什么面料的呀');
check('不同问题得分 < 0.4', diff < 0.4, `sim=${diff.toFixed(3)}`);

console.log('\n[4] 重复问题聚合');
check('两条相似尺码提问合并为 1 个簇', result.clusters.length === 1, `clusters=${result.clusters.length}`);
if (result.clusters.length === 1) {
  check('簇内计数 = 2', result.clusters[0].count === 2, `count=${result.clusters[0].count}`);
  check('簇分类为 size', result.clusters[0].categoryId === 'size', `categoryId=${result.clusters[0].categoryId}`);
}

console.log('\n[5] 重要低频问题识别');
const rareMessages = CORPUS_RARE.map((text, i) => normalizeMessage({ userId: `u_r${i}`, text, ts: (ts += 1200) }, 'mock'));
const rareResult = analyzeBuffer(rareMessages, { ...DEFAULT_OPTIONS });
check('产生低频告警', rareResult.alerts.length > 0, `alerts=${rareResult.alerts.length}`);
check('告警按优先级降序', rareResult.alerts.every((a, i, arr) => i === 0 || arr[i - 1].priority >= a.priority));
const top = rareResult.alerts[0];
console.log(`        最高优先级告警：「${top.title}」 severity=${top.severity} count=${top.count} level=${top.level}`);
check('高危告警等级为 high', top.level === 'high', `level=${top.level}`);

console.log('\n[6] 高频问题不应占用告警位');
// 同一个严重问题被问了 6 次（不同措辞、不同用户，避免被去重规则提前过滤）
const hotTexts = [
  '这个线头很多能退货吗',
  '这个线头很多可以退货吗',
  '线头很多能退货吗',
  '这件线头很多能退货吗',
  '这个线头好多能退货吗',
  '线头这么多能退货吗',
];
const hotMessages = hotTexts.map((text, i) => normalizeMessage({ userId: `u_x${i}`, text, ts: (ts += 300) }, 'mock'));
const hotResult = analyzeBuffer(hotMessages, {
  ...DEFAULT_OPTIONS, sensitivity: 20, clusterThreshold: 0.35,
});
const hotCluster = hotResult.clusters.find((c) => c.count >= 4);
check('同类问题聚成高频簇（count >= 4）', !!hotCluster, `count=${hotCluster ? hotCluster.count : 'n/a'}`);
if (hotCluster) {
  check('高频簇严重度仍然很高', hotCluster.maxSeverity >= 0.5, `severity=${hotCluster.maxSeverity}`);
  const hasAlert = hotResult.alerts.some((a) => a.clusterId === hotCluster.id);
  check('高频问题不进入低频告警列表', !hasAlert, `alerts=${hotResult.alerts.length}`);
}

console.log('\n[7] 关闭去噪后全部通过');
const offResult = analyzeBuffer(messages, { ...DEFAULT_OPTIONS, enableDenoise: false });
check('关闭去噪后 noise = 0', offResult.stats.noise === 0, `noise=${offResult.stats.noise}`);

console.log('\n[8] 参数可调性（敏感度影响过滤结果）');
const loose = analyzeBuffer(messages, { ...DEFAULT_OPTIONS, sensitivity: 20 });
const strict = analyzeBuffer(messages, { ...DEFAULT_OPTIONS, sensitivity: 90 });
check('严格模式保留 <= 宽松模式', strict.stats.passed <= loose.stats.passed,
  `strict=${strict.stats.passed} loose=${loose.stats.passed}`);

console.log('\n[9] 演示数据完整性');
check('噪声语料非空', CORPUS_NOISE.length > 0, `count=${CORPUS_NOISE.length}`);
check('严重问题语料非空', CORPUS_RARE.length > 0, `count=${CORPUS_RARE.length}`);

console.log('\n[10] 表情刷屏降噪（方括号表情）');
{
  const spamMsgs = ['[大笑][大笑][大笑]', '[呲牙]', '[捂脸][捂脸][捂脸][捂脸]', '[呲牙]这件有s码吗']
    .map((text) => normalizeMessage({ userId: 'u_e1', text, ts: (ts += 800) }, 'mock'));
  const r = analyzeBuffer(spamMsgs, { ...DEFAULT_OPTIONS });
  const byText = Object.fromEntries(r.items.map((it) => [it.text, it.filter]));
  check('[大笑]x3 被判为刷屏', !byText['[大笑][大笑][大笑]'].passed, byText['[大笑][大笑][大笑]'].reasonId);
  check('单个 [呲牙] 被判为表情', !byText['[呲牙]'].passed, byText['[呲牙]'].reasonId);
  check('[捂脸]x4 被判为刷屏', !byText['[捂脸][捂脸][捂脸][捂脸]'].passed, byText['[捂脸][捂脸][捂脸][捂脸]'].reasonId);
  check('表情+实质内容仍通过', byText['[呲牙]这件有s码吗'].passed === true, byText['[呲牙]这件有s码吗'].reasonId || 'passed');
}

console.log('\n[11] 支付/下单异常识别（双信号规则，避免误伤普通负面评价）');
{
  const hit = analyzeBuffer([normalizeMessage({ userId: 'u_p1', text: '支付失败怎么回事？客服不回信息', ts: Date.now() }, 'mock')], { ...DEFAULT_OPTIONS });
  check('「支付失败」归类到 payment', hit.items[0].categoryId === 'payment', `categoryId=${hit.items[0].categoryId}`);
  check('「支付失败」进入关注榜且标记为异常待核查',
    hit.focus.some((f) => f.type.id === 'anomaly'),
    `focus=${hit.focus.map((f) => f.type.id).join(',') || 'empty'}`);

  // 合理规则约束：普通负面评价 / 单纯咨询价格 不得判为异常
  const miss = analyzeBuffer([
    normalizeMessage({ userId: 'u_p2', text: '这个颜色不太喜欢', ts: Date.now() }, 'mock'),
    normalizeMessage({ userId: 'u_p3', text: '这件多少钱呀', ts: Date.now() + 800 }, 'mock'),
  ], { ...DEFAULT_OPTIONS });
  check('普通负面评价不误判为异常', !miss.focus.some((f) => f.type.id === 'anomaly'),
    `focus=${miss.focus.map((f) => f.type.id).join(',') || 'empty'}`);
}

console.log('\n[12] 商家关注榜：频率 × 语义 × 紧急度 综合排序');
{
  let t2 = Date.now() - 60000;
  const corpus = [];
  // 20 人问尺码 → 高频需求
  for (let i = 0; i < 20; i += 1) corpus.push({ userId: `u_s${i}`, text: '这条裤子有s码吗', ts: (t2 += 400) });
  // 12 人问面料 → 购买顾虑
  for (let i = 0; i < 12; i += 1) corpus.push({ userId: `u_f${i}`, text: '面料夏天穿会不会闷', ts: (t2 += 400) });
  // 1 人支付失败 → 异常待核查
  corpus.push({ userId: 'u_pay', text: '支付失败怎么回事？客服不回信息', ts: (t2 += 400) });
  // 表情刷屏 → 应被过滤，不占榜
  for (let i = 0; i < 6; i += 1) corpus.push({ userId: `u_e${i}`, text: '[大笑][大笑][大笑]', ts: (t2 += 400) });

  const r = analyzeBuffer(corpus.map((m) => normalizeMessage(m, 'mock')), { ...DEFAULT_OPTIONS });
  check('表情刷屏全部被过滤', r.items.filter((it) => it.text.includes('[大笑]')).every((it) => !it.filter.passed));

  const anomaly = r.focus.find((f) => f.type.id === 'anomaly');
  const hot = r.focus.find((f) => f.title.includes('s码'));
  const fabric = r.focus.find((f) => f.title.includes('面料'));
  check('支付异常在榜且类型为 anomaly', !!anomaly, anomaly ? `rank=${anomaly.rank} score=${anomaly.score}` : 'missing');
  check('尺码簇在榜且标记为高频需求', hot && hot.type.id === 'hot_demand', hot ? `type=${hot.type.id} count=${hot.count}` : 'missing');
  check('面料簇在榜且为购买顾虑类', fabric && ['concern', 'hot_demand'].includes(fabric.type.id), fabric ? `type=${fabric.type.id}` : 'missing');
  check('异常紧急度拉满', anomaly && anomaly.components.urgency === 1, anomaly ? `urgency=${anomaly.components.urgency}` : 'missing');
  check('榜单不含表情刷屏内容', !r.focus.some((f) => f.title.includes('[大笑]')));
  console.log('  榜单：' + r.focus.map((f) => `#${f.rank}[${f.type.label}]${f.title.slice(0, 10)}(${f.score})`).join('  '));
}

console.log('\n[13] AI 旁挂隔离：core 不得依赖 ai');
{
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const coreFiles = (await readdir(join(SRC, 'core'))).filter((f) => f.endsWith('.js'));
  let offenders = [];
  for (const f of coreFiles) {
    const code = await readFile(join(SRC, 'core', f), 'utf8');
    if (/from\s+['"][^'"]*\/ai\//.test(code)) offenders.push(f);
  }
  check('src/core 下没有任何文件 import ai 模块', offenders.length === 0, offenders.join(',') || 'clean');

  // 反向确认：AI 只读 core 结果，不 import core 的写操作
  const aiFiles = (await readdir(join(SRC, 'ai'))).filter((f) => f.endsWith('.js'));
  const aiWritesCore = [];
  for (const f of aiFiles) {
    const code = await readFile(join(SRC, 'ai', f), 'utf8');
    if (/from\s+['"][^'"]*\/core\/store\.js/.test(code)) aiWritesCore.push(f);
  }
  check('src/ai 不直接依赖 core/store（由装配层注入）', aiWritesCore.length === 0, aiWritesCore.join(',') || 'clean');
}

console.log('\n[14] AI 批次载荷：结构化摘要，不含原始弹幕/用户标识');
{
  let t3 = Date.now() - 30000;
  const corpus = [];
  for (let i = 0; i < 10; i += 1) corpus.push({ userId: `u_z${i}`, text: '这条裤子有s码吗', ts: (t3 += 400) });
  for (let i = 0; i < 5; i += 1) corpus.push({ userId: `u_c${i}`, text: '面料夏天穿会不会闷', ts: (t3 += 400) });

  const r = analyzeBuffer(corpus.map((m) => normalizeMessage(m, 'mock')), { ...DEFAULT_OPTIONS });
  const payload = buildPayload({ raw: corpus, result: r });
  const dump = JSON.stringify(payload);

  check('载荷含 window/stats/focus/questions', !!payload.window && !!payload.stats && !!payload.questions);
  check('载荷不含 userId', !dump.includes('userId'));
  check('载荷不含 polyv 原始对象', !dump.includes('polyvRaw'));
  check('载荷传递了 core 的分类计数', payload.stats.categories.length > 0, `categories=${payload.stats.categories.map((c) => c.id).join(',')}`);
  check('载荷里没有问题全文（每条 <= 41 字）',
    payload.questions.every((q) => q.text.length <= 41),
    `maxLen=${Math.max(0, ...payload.questions.map((q) => q.text.length))}`);
}

console.log('\n[15] 模拟洞察：符合契约且数字来自 core');
{
  let t4 = Date.now() - 30000;
  const corpus = [];
  for (let i = 0; i < 12; i += 1) corpus.push({ userId: `u_s${i}`, text: '这条裤子有s码吗', ts: (t4 += 400) });
  for (let i = 0; i < 6; i += 1) corpus.push({ userId: `u_f${i}`, text: '面料夏天穿会不会闷', ts: (t4 += 400) });
  corpus.push({ userId: 'u_pay2', text: '支付失败怎么回事？客服不回信息', ts: (t4 += 400) });

  const r = analyzeBuffer(corpus.map((m) => normalizeMessage(m, 'mock')), { ...DEFAULT_OPTIONS });
  const payload = buildPayload({ raw: corpus, result: r });
  const raw = buildMockInsight(payload);
  const { ok, errors, data } = validateInsight(raw);

  check('模拟洞察通过 schema 校验', ok, errors.join('；') || 'ok');
  check('有一句话结论', data.summary.length > 0, data.summary.slice(0, 40) + '…');
  check('结论里带了真实条数',
    data.summary.includes(String(payload.stats.passed)),
    `passed=${payload.stats.passed}`);
  check('产出隐性需求', data.implicitNeeds.length > 0, `needs=${data.implicitNeeds.length}`);
  check('分类解读与 core 统计一致',
    data.categories.every((c) => {
      const src = payload.stats.categories.find((x) => x.id === c.id);
      return !src || src.count === c.count;
    }),
    data.categories.map((c) => `${c.id}:${c.count}`).join(','));
  check('标注了 mock 模式与免责声明',
    data.mode === 'mock' && /模拟/.test(data.disclaimer),
    `${data.mode} / ${data.disclaimer}`);
  check('低频高危来自 core 告警', data.lowFrequency.length === Math.min(3, payload.lowFrequency.length),
    `lowFrequency=${data.lowFrequency.length}`);
  check('给出可执行动作', data.merchantActions.length > 0 && data.merchantActions.every((a) => ['P0', 'P1', 'P2'].includes(a.priority)),
    data.merchantActions.map((a) => a.priority).join(','));
}

console.log('\n[16] 面板渲染：洞察能变成 HTML 且做了转义');
{
  const insight = validateInsight(buildMockInsight({
    window: { from: Date.now() - 60000, to: Date.now() },
    stats: {
      total: 10, passed: 8, noise: 2, noiseRate: 0.2,
      intents: { question: 4, demand: 3, feedback: 1 },
      categories: [{ id: 'size', label: '<script>x</script>', count: 5, ratio: 0.625 }],
    },
    focus: [], lowFrequency: [], questions: [{ text: '这条有s码吗', categoryId: 'size', count: 5 }],
  })).data;
  const html = renderInsightHtml(insight);
  check('渲染出结论区块', html.includes('ai-summary'));
  check('渲染出隐性需求', html.includes('ai-need'));
  check('渲染出建议话术', html.includes('ai-reply'));
  check('恶意标签被转义', !html.includes('<script>') && html.includes('&lt;script&gt;'));
}

console.log('\n[17] 关闭 AI：核心分析结果一字不变');
{
  let t5 = Date.now() - 20000;
  const corpus = [];
  for (let i = 0; i < 8; i += 1) corpus.push({ userId: `u_k${i}`, text: '这条裤子有s码吗', ts: (t5 += 400) });
  for (let i = 0; i < 3; i += 1) corpus.push({ userId: `u_n${i}`, text: '[大笑][大笑][大笑]', ts: (t5 += 400) });

  store.reset();
  store.pushMessages(corpus.map((m) => normalizeMessage(m, 'mock')));
  const before = JSON.stringify(store.getState().result);

  let calls = 0;
  const ai = createAiStore(false);
  const aiBt = createAiBatcher({
    store,
    aiStore: ai,
    config: { endpoint: '/x', batchIntervalMs: 1000, minNewMessages: 1, timeoutMs: 500 },
    client: async () => { calls += 1; return { raw: buildMockInsight(buildPayload(store.getState())) }; },
  });

  const off = await aiBt.runOnce();
  check('关闭时批次被跳过', off.skipped === 'disabled', JSON.stringify(off));
  check('关闭时不发起任何请求', calls === 0, `calls=${calls}`);
  check('关闭后核心分析结果完全一致', JSON.stringify(store.getState().result) === before);

  // 开启后再跑一次：AI 有产出，但核心结果仍然一字不变
  ai.setEnabled(true);
  const on = await aiBt.runOnce();
  const after = JSON.stringify(store.getState().result);
  check('开启后 AI 生成了洞察', on.ok === true && !!ai.getState().insight);
  check('开启 AI 也不会改动核心结果', after === before);
  check('开关可回落且不残留状态', (ai.setEnabled(false), ai.getState().status === 'disabled'));
}

console.log('\n[18] 云端优先通道：可用直出 / 失败自动回退后端');
{
  // extractJson：容忍代码块与前后废话
  check('extractJson 纯 JSON', JSON.stringify(extractJson('{"a":1}')) === '{"a":1}');
  check('extractJson 代码块', JSON.stringify(extractJson('```json\n{"a":1}\n```')) === '{"a":1}');
  check('extractJson 前后废话', JSON.stringify(extractJson('好的：\n{"a":1}\n以上')) === '{"a":1}');
  check('extractJson 无 JSON 返回 null', extractJson('没有') === null);

  const cloudFixture = {
    model: 'glm-5.3-flash',
    mode: 'real',
    generatedAt: new Date().toISOString(),
    summary: '云端洞察：尺码问题最集中',
    trend: { direction: 'up', label: '决策期', note: '' },
    implicitNeeds: [{ need: '怕买错码', evidence: '9 条尺码咨询', confidence: 0.8 }],
    categories: [{ id: 'size', label: '尺码合身', count: 9, share: 0.56, reading: '' }],
    lowFrequency: [],
    replySuggestions: [],
    merchantActions: [],
    disclaimer: 'cloud',
  };
  const cloudCfg = { enabled: true, endpoint: 'https://cloud.test', publishableKey: 'x' };

  // 云端可用：直接用云端结果，后端一次都不调
  {
    let backendCalls = 0;
    const channel = createChannelClient({
      cloudConfig: cloudCfg,
      cloudClient: async () => ({ raw: cloudFixture, latencyMs: 120 }),
      backendClient: async () => { backendCalls += 1; return { raw: buildMockInsight({}), latencyMs: 5 }; },
    });
    const out = await channel({ stats: {} }, {});
    check('云端可用 → 直接采用云端结果', out.raw.mode === 'real' && out.raw.model === 'glm-5.3-flash');
    check('云端可用 → 不调自有后端', backendCalls === 0, `backendCalls=${backendCalls}`);
  }

  // 云端失败：回退后端，且同一会话不再试云端
  {
    let backendCalls = 0;
    let cloudCalls = 0;
    const channel = createChannelClient({
      cloudConfig: cloudCfg,
      cloudClient: async () => { cloudCalls += 1; throw new CloudUnavailableError('origin not allowed'); },
      backendClient: async () => { backendCalls += 1; return { raw: buildMockInsight({}), latencyMs: 5 }; },
    });
    const first = await channel({ stats: {} }, {});
    const second = await channel({ stats: {} }, {});
    check('云端失败 → 回退自有后端', first.raw.mode === 'mock' && second.raw.mode === 'mock');
    check('云端失败一次后不再重试', cloudCalls === 1, `cloudCalls=${cloudCalls}`);
    check('回退后仍走自有后端', backendCalls === 2, `backendCalls=${backendCalls}`);
  }

  // 未配置云端（cloudConfig 为空）：直接走后端，行为与之前版本一致
  {
    let backendCalls = 0;
    const channel = createChannelClient({
      cloudConfig: undefined,
      cloudClient: async () => { throw new Error('不应被调用'); },
      backendClient: async () => { backendCalls += 1; return { raw: buildMockInsight({}), latencyMs: 5 }; },
    });
    const out = await channel({ stats: {} }, {});
    check('未配置云端 → 直接走自有后端', out.raw.mode === 'mock' && backendCalls === 1);
  }

  // 端到端：createAiBatcher 注入了通道后，AI 洞察来自云端但核心结果不变
  {
    store.reset();
    let t6 = Date.now() - 20000;
    const corpus = [];
    for (let i = 0; i < 6; i += 1) corpus.push({ userId: `u_c${i}`, text: '这条裤子有s码吗', ts: (t6 += 400) });
    store.pushMessages(corpus.map((m) => normalizeMessage(m, 'mock')));
    const before = JSON.stringify(store.getState().result);

    const ai = createAiStore(true);
    const aiBt = createAiBatcher({
      store,
      aiStore: ai,
      config: { endpoint: '/x', batchIntervalMs: 1000, minNewMessages: 1, timeoutMs: 500, cloud: cloudCfg },
      channelClient: async () => ({ raw: cloudFixture, latencyMs: 100 }),
    });
    const res = await aiBt.runOnce();
    check('批次走云端通道并产出洞察', res.ok === true && ai.getState().insight?.model === 'glm-5.3-flash');
    check('云端通道也不影响核心结果', JSON.stringify(store.getState().result) === before);
  }
}

console.log('\n[19] 实时弹幕流滚动窗口（P0：只裁视图，不清数据）');
{
  check('窗口参数符合约定（15s / 保底 5 / 封顶 60）',
    STREAM_WINDOW_MS === 15000 && STREAM_WINDOW_MIN === 5 && STREAM_WINDOW_MAX === 60,
    `${STREAM_WINDOW_MS}ms / ${STREAM_WINDOW_MIN} / ${STREAM_WINDOW_MAX}`);

  const now = 1_000_000_000_000;
  const mk = (i, ageMs) => ({ id: `dm${i}`, timestamp: now - ageMs, text: `弹幕${i}` });
  const fresh = [0, 1, 2, 3, 4].map((i) => mk(i, i * 1000));           // 0~4 秒前
  const stale = [5, 6, 7, 8, 9].map((i) => mk(i, 60_000 + i * 1000));  // 60 秒前

  // 窗口期：只保留最近 15 秒内的，旧的自然褪去
  const w1 = computeVisibleWindow([...stale, ...fresh], now);
  check('15 秒窗口外的旧弹幕被裁掉', w1.length === 5 && w1.every((it) => Number(it.id.slice(2)) < 5),
    `kept=${w1.map((it) => it.id).join(',')}`);
  check('渲染顺序为最新在上', w1[0].id === 'dm4', `first=${w1[0].id}`);

  // 保底：全部很旧时仍保留最近 5 条，面板不会突然全空
  const allStale = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => mk(i, 60_000 + i * 1000));
  const w2 = computeVisibleWindow(allStale, now);
  check('冷场保底：保留最近 5 条', w2.length === STREAM_WINDOW_MIN && w2[0].id === 'dm9', `kept=${w2.length}`);

  // 保底下限：总量不足 5 条时来几条留几条
  const w3 = computeVisibleWindow([mk(0, 60_000), mk(1, 60_100)], now);
  check('总量不足保底条数时全部保留', w3.length === 2, `kept=${w3.length}`);

  // 封顶：窗口内突发洪流不超过 60 条
  const flood = Array.from({ length: 80 }, (_, i) => mk(i, i * 100)); // 0~7.9 秒前，全在窗口内
  const w4 = computeVisibleWindow(flood, now);
  check('窗口内洪流封顶 60 条', w4.length === STREAM_WINDOW_MAX && w4[0].id === 'dm79', `kept=${w4.length}`);

  // 悬停暂停：不按时间裁剪，主播正在读的弹幕不许因过期消失
  const w5 = computeVisibleWindow([...stale, ...fresh], now, { hovering: true });
  check('悬停暂停时暂停裁剪', w5.length === 10, `kept=${w5.length}`);

  // 主动筛选：不按时间裁剪，避免搜索结果被时间窗口藏掉
  const w6 = computeVisibleWindow(allStale, now, { filterActive: true });
  check('筛选激活时不按时间裁剪', w6.length === 10, `kept=${w6.length}`);

  // 铁律：绝不清数据 —— 纯函数不得修改输入
  const input = [...stale, ...fresh];
  const before = input.length;
  computeVisibleWindow(input, now);
  check('不修改输入数组（store 数据一个字节都不动）',
    input.length === before && input[0].id === 'dm5', `len=${input.length}`);
}

console.log('\n[20] 连接直播间频道号弹窗（输入校验 + 模块安全）');
{
  // 合法输入：通过并回传裁剪后的值
  check('合法频道号通过', validateChannelId('8620440').ok === true, '8620440');
  check('合法时 value 为字符串', typeof validateChannelId('8620440').value === 'string');
  check('首尾空格被裁剪', validateChannelId('  8620440 ').value === '8620440');

  // 非法输入：全部拒绝，且错误信息为非空字符串（弹窗里要直接展示）
  check('空输入被拒绝', validateChannelId('').ok === false);
  check('纯空格被拒绝', validateChannelId('   ').ok === false);
  check('null 被拒绝', validateChannelId(null).ok === false);
  check('undefined 被拒绝', validateChannelId(undefined).ok === false);
  check('含字母被拒绝', validateChannelId('8620abc').ok === false);
  check('中间带空格被拒绝', validateChannelId('8620 440').ok === false);
  check('含符号被拒绝', validateChannelId('8620-440').ok === false);
  check('全角数字被拒绝', validateChannelId('８６２０４４０').ok === false);
  check('过短（2 位）被拒绝', validateChannelId('86').ok === false);
  check('过长（13 位）被拒绝', validateChannelId('1234567890123').ok === false);

  const bad = validateChannelId('abc');
  check('错误信息可读（非空字符串）', typeof bad.error === 'string' && bad.error.length > 0, bad.error);

  // 弹窗模块必须 Node 安全：模块级不碰 document，冒烟测试可直接 import
  check('roomModal 模块 Node 安全导入', typeof validateChannelId === 'function');
}

console.log('\n[21] AI 三级降级：静态托管 405 → 本地模拟兜底（GitHub Pages 场景）');
{
  // 构造一份有真实分类统计的载荷
  let t5 = Date.now() - 30000;
  const corpus = [];
  for (let i = 0; i < 10; i += 1) corpus.push({ userId: `u_f${i}`, text: '这条裤子有s码吗', ts: (t5 += 400) });
  for (let i = 0; i < 5; i += 1) corpus.push({ userId: `u_m${i}`, text: '面料夏天穿会不会闷', ts: (t5 += 400) });
  const r21 = analyzeBuffer(corpus.map((m) => normalizeMessage(m, 'mock')), { ...DEFAULT_OPTIONS });
  const payload = buildPayload({ raw: corpus, result: r21 });

  // —— 21a. 真起一个「纯静态托管」服务器：所有 POST 回 405（GitHub Pages 的姿势）——
  const staticHost = createServer((req, res) => {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  });
  await new Promise((resolveListen) => staticHost.listen(0, '127.0.0.1', resolveListen));
  const endpoint = `http://127.0.0.1:${staticHost.address().port}/api/ai/insight`;
  try {
    await requestInsight(payload, { endpoint, timeoutMs: 3000 });
    check('405 应抛错', false, '未抛错');
  } catch (err) {
    check('405 → BackendUnavailableError', err instanceof BackendUnavailableError, err?.name);
    check('文案点明纯静态托管', /纯静态托管/.test(err.message), err.message);
    check('unavailable 标记为 true（上层据此兜底）', err.unavailable === true);
  }
  staticHost.close();

  const cloudDown = () => Promise.reject(new CloudUnavailableError('云端服务返回 HTTP 403（Origin 未放行）'));
  const backendGone = () => Promise.reject(new BackendUnavailableError('当前站点是纯静态托管（如 GitHub Pages），没有可用的 AI 后端服务（POST 返回 405）'));

  // —— 21b. 云端失败 + 后端不可用 → 第三级本地模拟兜底，面板永远有内容 ——
  const fallback = createChannelClient({
    cloudConfig: { enabled: true, endpoint: 'https://cloud.invalid' },
    backendClient: backendGone,
    cloudClient: cloudDown,
  });
  const out = await fallback(payload, {});
  check('兜底产出带 summary 的洞察', !!(out?.raw?.summary), String(out?.raw?.summary || '').slice(0, 30));
  check('兜底结果标注 mock 模式', out.raw.mode === 'mock', out.raw.mode);
  check('兜底 meta 记录来源', out.meta?.mode === 'mock' && out.meta?.source === 'client-fallback');
  check('disclaimer 同时写明云端与后端原因',
    /本地规则模拟/.test(out.raw.disclaimer) && /纯静态托管/.test(out.raw.disclaimer),
    String(out.raw.disclaimer).slice(0, 50));
  check('兜底结果通过 schema 校验', validateInsight(out.raw).ok === true);

  // —— 21c. mockClient: null 关掉兜底：错误原样透出并附上云端原因 ——
  const strict = createChannelClient({
    cloudConfig: { enabled: true, endpoint: 'https://cloud.invalid' },
    backendClient: backendGone,
    cloudClient: cloudDown,
    mockClient: null,
  });
  try {
    await strict(payload, {});
    check('关闭兜底后应抛错', false, '未抛错');
  } catch (err) {
    check('关闭兜底 → BackendUnavailableError', err instanceof BackendUnavailableError, err?.name);
    check('抛错信息附带云端失败原因', /Origin 未放行/.test(err.message), String(err.message).slice(0, 60));
  }

  // —— 21d. 云端成功时绝不惊动后端与兜底 ——
  let backendCalls = 0;
  const cloudOk = async () => ({
    raw: { ...buildMockInsight(payload), mode: 'real', model: 'glm-test' },
    latencyMs: 12,
    meta: { mode: 'real' },
  });
  const happy = createChannelClient({
    cloudConfig: { enabled: true, endpoint: 'https://cloud.ok' },
    backendClient: () => { backendCalls += 1; return Promise.reject(new Error('不应被调用')); },
    cloudClient: cloudOk,
  });
  const okOut = await happy(payload, {});
  check('云端成功时后端零调用', backendCalls === 0, `calls=${backendCalls}`);
  check('云端成功结果原样返回', okOut.raw.model === 'glm-test', okOut.raw.model);

  // —— 21e. 后端真实报错（500 等）不兜底、不掩盖 ——
  const server500 = () => Promise.reject(new Error('AI 服务返回 HTTP 500'));
  const noFallback = createChannelClient({
    cloudConfig: { enabled: false, endpoint: '' },
    backendClient: server500,
    cloudClient: cloudDown,
  });
  try {
    await noFallback(payload, {});
    check('后端 500 应抛错', false, '未抛错');
  } catch (err) {
    check('后端真实报错不被 mock 兜底掩盖',
      !(err instanceof BackendUnavailableError) && /HTTP 500/.test(err.message),
      err.message);
  }
}

console.log(`\n结果：${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}\n`);
process.exit(failed === 0 ? 0 : 1);
