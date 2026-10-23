/**
 * analysis.js
 * ------------------------------------------------------------
 * 分析主管道（纯函数，输入原始弹幕数组，输出全部洞察结果）。
 *
 *   rawMessage[] ──▶ 去噪 ──▶ 意图/分类/严重度 ──▶ 问题聚合 ──▶ 低频高价值告警
 *
 * 目前是「全量重算」实现（每次状态变化都从 buffer 重跑一遍）。
 * 优点：改参数（敏感度、聚合阈值）后结果立刻一致，调试成本低。
 * 后续弹幕量上来，可改为增量式 while 保持同样的输出结构。
 */
import { createDenoiseEngine } from './denoise.js?v=20261023f';
import { richAnalyze } from './classify.js?v=20261023f';
import { aggregateQuestions } from './aggregate.js?v=20261023f';
import { detectImportantLowFrequency } from './alert.js?v=20261023f';
import { buildFocusList } from './focus.js?v=20261023f';
import { CATEGORY_MAP, FILTER_REASONS } from './constants.js?v=20261023f';

const PASSED_FILTER = { passed: true, reasonId: null, ruleId: null, reasonLabel: null, note: null };
const EMPTY_RICH = {
  intent: 'chat',
  intentLabel: '闲聊',
  intentHits: [],
  categoryId: null,
  categoryLabel: '未分类',
  categoryHits: [],
  confidence: 0,
  severity: 0,
  severityHits: [],
  color: null,
};

/**
 * @param {Array} messages 归一化后的 DanmakuMessage[]
 * @param {object} options DEFAULT_OPTIONS 的超集
 * @returns {{items:Array, clusters:Array, alerts:Array, stats:object}}
 */
export function analyzeBuffer(messages, options = {}) {
  const engine = createDenoiseEngine(options);

  const items = messages.map((msg) => {
    const filter = options.enableDenoise ? engine.evaluate(msg) : PASSED_FILTER;
    const rich = filter.passed ? richAnalyze(msg.normalizedText) : EMPTY_RICH;
    return {
      ...msg,
      filter,
      ...rich,
      clusterId: null,
    };
  });

  // 回写 clusterId，让 UI 可以「点击问题簇 → 高亮对应弹幕」
  const clusters = aggregateQuestions(items, options);
  const itemToCluster = new Map();
  clusters.forEach((c) => c.itemIds.forEach((id) => itemToCluster.set(id, c.id)));
  items.forEach((it) => { it.clusterId = itemToCluster.get(it.id) || null; });

  const alerts = detectImportantLowFrequency(clusters, options);
  // 商家关注榜：把频率、语义、紧急度合成为一张榜（高频需求 / 购买顾虑 / 低频高危 / 异常待核查）
  const focus = buildFocusList(clusters, alerts, options);
  const stats = buildStats(items);

  return { items, clusters, alerts, focus, stats };
}

function buildStats(items) {
  const total = items.length;
  const byReason = {};
  FILTER_REASONS.forEach((r) => { byReason[r.id] = 0; });

  let passed = 0;
  let questionCount = 0;
  let demandCount = 0;
  let feedbackCount = 0;
  const categoryCounts = {};
  const users = new Set();

  items.forEach((it) => {
    if (it.filter.passed) {
      passed += 1;
      users.add(it.userId);
      if (it.intent === 'question') questionCount += 1;
      if (it.intent === 'demand') demandCount += 1;
      if (it.intent === 'feedback') feedbackCount += 1;
      if (it.categoryId) {
        categoryCounts[it.categoryId] = (categoryCounts[it.categoryId] || 0) + 1;
      }
    } else if (it.filter.reasonId) {
      byReason[it.filter.reasonId] = (byReason[it.filter.reasonId] || 0) + 1;
    }
  });

  const noise = total - passed;
  const noiseRate = total ? Number((noise / total).toFixed(3)) : 0;

  const categories = Object.entries(categoryCounts)
    .map(([id, count]) => ({
      id,
      label: CATEGORY_MAP[id]?.label || id,
      color: CATEGORY_MAP[id]?.color || '#9aa3b8',
      count,
      ratio: passed ? Number((count / passed).toFixed(3)) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    passed,
    noise,
    noiseRate,
    byReason,
    intents: { question: questionCount, demand: demandCount, feedback: feedbackCount },
    categories,
    uniqueUsers: users.size,
  };
}
