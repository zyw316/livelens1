/**
 * focus.js
 * ------------------------------------------------------------
 * 商家关注榜 —— 项目的核心差异化能力。
 *
 * 不是简单地按频率排名，而是把「频率 × 语义 × 紧急程度」结合起来，
 * 回答一个问题：**此刻最值得商家关注的问题是什么？**
 *
 * 对应四类典型情形：
 *   - 20 个人问尺码      → 高频需求（频率高，常规但量大）
 *   - 12 个人问面料      → 购买顾虑（语义上是下单前的犹豫点）
 *   - 1 个人反馈支付失败  → 异常待核查（频率极低但紧急度最高）
 *   - 30 条表情和刷屏     → 已在去噪层被过滤，不占用注意力
 *
 * 对外接口：
 *   detectAnomaly(normalizedText) -> 命中的异常规则或 null
 *   buildFocusList(clusters, alerts, options) -> FocusItem[]
 *
 * FocusItem = {
 *   rank, clusterId, title, count, userCount, severity,
 *   categoryId, categoryLabel, intentLabel,
 *   type: { id, label, color },   // 关注类型标签
 *   score,                        // 综合关注分（0~1）
 *   components: { freq, sem, urgency }, // 分数构成，便于向评委解释
 *   reason, lastAt, sample
 *   anomalyLabel / anomalyReason  // 仅异常类有
 * }
 */
import { ANOMALY_RULES, CATEGORY_MAP, INTENT_LABELS } from './constants.js?v=20261023f';
import { normalizeText } from './normalize.js?v=20261023f';

/** 关注类型：排序与配色都在这里集中定义 */
export const FOCUS_TYPES = {
  ANOMALY: { id: 'anomaly', label: '异常待核查', color: '#f87171' },
  RARE_SEVERE: { id: 'rare_severe', label: '低频高危', color: '#fb923c' },
  COMPLAINT: { id: 'complaint', label: '集中投诉', color: '#fbbf24' },
  HOT_DEMAND: { id: 'hot_demand', label: '高频需求', color: '#8b5cf6' },
  CONCERN: { id: 'concern', label: '购买顾虑', color: '#2dd4bf' },
  NORMAL: { id: 'normal', label: '一般关注', color: '#9ca3af' },
};

/**
 * 语义上区分两类下单关键点：
 *   事实性需求（尺码/库存/物流/价格）→ 量大时是「高频需求」，商家可以直接行动（报尺码、上库存）
 *   主观性顾虑（面料/洗护/颜色/售后/支付）→ 是「购买顾虑」，需要主播解释/安抚来打消
 */
const CONCERN_CATEGORIES = new Set(['fabric', 'care', 'color', 'aftersale', 'payment']);
const KEY_DECISION_CATEGORIES = new Set(['size', 'stock', 'shipping', 'price', ...CONCERN_CATEGORIES]);

/**
 * 异常识别：必须同时命中「业务行为词」+「失败/异常词」双组信号。
 * 这是刻意的保守设计 —— 单句负面评价（如「太贵了」）不会被误判为系统异常。
 */
export function detectAnomaly(normalizedText = '') {
  if (!normalizedText) return null;
  for (const rule of ANOMALY_RULES) {
    const hitBehavior = rule.anyOf.some((w) => normalizedText.includes(w));
    const hitFailure = rule.andAnyOf.some((w) => normalizedText.includes(w));
    if (hitBehavior && hitFailure) return rule;
  }
  return null;
}

/**
 * 由问题簇 + 低频告警构建关注榜。
 * @param {Array} clusters aggregateQuestions 的输出
 * @param {Array} alerts  detectImportantLowFrequency 的输出（用于标记低频高危）
 * @param {object} options { hotCount, hotMin, now, maxItems }
 */
export function buildFocusList(clusters, alerts = [], options = {}) {
  const hotCount = options.hotCount ?? 8;   // 达到该数量视为频率满分
  const hotMin = options.hotMin ?? 4;       // 达到该数量才可被标记为高频/集中投诉
  const maxItems = options.maxFocusItems ?? 10;
  const alertClusterIds = new Set(alerts.map((a) => a.clusterId));

  const items = clusters.map((c) => {
    // 异常检测：代表文本 + 样本都要查（聚合后代表文本可能不是含异常信号的那条）
    const anomaly = detectAnomaly(c.representative)
      || c.samples.map((s) => detectAnomaly(normalizeText(s))).find(Boolean)
      || null;

    // 三个分数构成（都归一化到 0~1，方便向评委解释）
    const freq = Math.min(1, c.count / hotCount);              // 频率：人多不多
    const sem = semanticWeight(c);                             // 语义：是不是下单关键点
    const urgency = anomaly ? 1 : Math.min(1, c.maxSeverity);  // 紧急度：异常最高，否则看严重度

    // 综合关注分：频率 0.35 + 语义 0.25 + 紧急度 0.40（紧急度权重最高，异常一定靠前）
    const score = Number((0.35 * freq + 0.25 * sem + 0.4 * urgency).toFixed(3));

    const type = classifyFocusType(c, { anomaly, alertClusterIds, hotMin });

    return {
      clusterId: c.id,
      title: c.title,
      count: c.count,
      userCount: c.userCount,
      severity: c.maxSeverity,
      categoryId: c.categoryId,
      categoryLabel: c.categoryId ? (CATEGORY_MAP[c.categoryId]?.label || c.categoryLabel) : null,
      intentLabel: INTENT_LABELS[c.intent] || '闲聊',
      type,
      score,
      components: { freq: Number(freq.toFixed(3)), sem, urgency },
      reason: buildReason(c, type, anomaly),
      anomalyLabel: anomaly?.label || null,
      anomalyReason: anomaly?.reason || null,
      sample: c.samples[0] || c.title,
      lastAt: c.lastAt,
    };
  });

  return items
    .filter((it) => it.type.id !== 'normal' || it.score >= 0.12)
    .sort((a, b) => b.score - a.score || b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, maxItems)
    .map((it, idx) => ({ rank: idx + 1, ...it }));
}

/** 语义权重：下单决策关键点给高分，直播间体验类次之，未分类最低 */
function semanticWeight(cluster) {
  if (!cluster.categoryId) return 0.15;
  if (KEY_DECISION_CATEGORIES.has(cluster.categoryId)) return 1;
  if (cluster.categoryId === 'stream') return 0.3;
  return 0.6;
}

function classifyFocusType(cluster, { anomaly, alertClusterIds, hotMin }) {
  if (anomaly) return FOCUS_TYPES.ANOMALY;
  if (alertClusterIds.has(cluster.id)) return FOCUS_TYPES.RARE_SEVERE;
  if (cluster.intent === 'feedback' && cluster.count >= hotMin) return FOCUS_TYPES.COMPLAINT;
  if (cluster.intent === 'feedback') return FOCUS_TYPES.CONCERN;
  if (CONCERN_CATEGORIES.has(cluster.categoryId)) return FOCUS_TYPES.CONCERN;
  if (cluster.count >= hotMin) return FOCUS_TYPES.HOT_DEMAND;
  return FOCUS_TYPES.NORMAL;
}

/** 用「频率 · 语义 · 紧急度」三个维度生成一句可解释的理由 */
function buildReason(cluster, type, anomaly) {
  const parts = [];
  if (cluster.count >= 4) parts.push(`${cluster.userCount} 人 / ${cluster.count} 条，热度高`);
  else parts.push(`${cluster.count} 条`);
  if (anomaly) parts.push(anomaly.label);
  else if (cluster.maxSeverity >= 0.5) parts.push(`严重度 ${cluster.maxSeverity.toFixed(2)}`);
  if (cluster.categoryId && KEY_DECISION_CATEGORIES.has(cluster.categoryId)) {
    parts.push(CONCERN_CATEGORIES.has(cluster.categoryId) ? '属主观购买顾虑，需主播解释打消' : '属事实性需求，可直接行动');
  }
  if (type.id === 'normal' && parts.length <= 1) parts.push('常规关注');
  return parts.join('，');
}
