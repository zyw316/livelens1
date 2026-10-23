/**
 * alert.js
 * ------------------------------------------------------------
 * 重要低频问题识别 —— LiveLens 的差异化能力。
 *
 * 思路：直播弹幕里绝大多数问题是「尺码多少 / 什么时候发货」这类高频刚需，
 * 真正伤转化的问题（掉色、过敏、错发、客服不回）往往只出现一两次，
 * 会被频次统计淹没。因此这里不看出现次数，而看「单位出现次数的危害度」。
 *
 * 对外接口：
 *   detectImportantLowFrequency(clusters, options) -> Alert[]
 *
 * Alert = {
 *   key, clusterId, title, count, severity, priority,
 *   level: 'high'|'medium'|'low', reason, categoryId, sample, lastAt
 * }
 *
 * 评分：priority = severity * 0.65 + rarity * 0.25 + recency * 0.10
 *   rarity  : 出现越少越稀有（1 次 = 1.0）
 *   recency : 距离现在越近越紧急
 */
import { ALERT_STATUS } from './constants.js?v=20261023f';

export function detectImportantLowFrequency(clusters, options = {}) {
  const lowFrequencyMax = options.lowFrequencyMax ?? 3;
  const minSeverity = options.minSeverity ?? 0.5;
  const now = options.now ?? Date.now();

  const alerts = [];

  clusters.forEach((cluster) => {
    const { count, maxSeverity } = cluster;
    if (maxSeverity < minSeverity) return;
    if (count > lowFrequencyMax) return; // 高频问题走常规统计，不占用告警位

    const rarity = count <= 1 ? 1 : 1 - (count - 1) / Math.max(lowFrequencyMax, 1) * 0.6;
    const ageMs = Math.max(now - cluster.lastAt, 0);
    const recency = Math.max(0, 1 - ageMs / (5 * 60 * 1000)); // 5 分钟内衰减到 0
    const priority = Number((maxSeverity * 0.65 + rarity * 0.25 + recency * 0.1).toFixed(3));

    alerts.push({
      key: `cluster:${cluster.id}`,
      clusterId: cluster.id,
      title: cluster.title,
      count,
      severity: maxSeverity,
      severityHits: cluster.samples,
      priority,
      level: maxSeverity >= 0.85 ? 'high' : maxSeverity >= 0.65 ? 'medium' : 'low',
      reason: buildReason(cluster, maxSeverity, count),
      categoryId: cluster.categoryId,
      categoryLabel: cluster.categoryLabel,
      sample: cluster.samples[0],
      samples: cluster.samples,
      lastAt: cluster.lastAt,
      firstAt: cluster.firstAt,
      status: ALERT_STATUS.PENDING,
    });
  });

  return alerts.sort((a, b) => b.priority - a.priority || b.severity - a.severity);
}

function buildReason(cluster, severity, count) {
  const parts = [];
  if (severity >= 0.85) parts.push('涉及质量/履约类高风险信号');
  else if (severity >= 0.65) parts.push('可能影响下单决策');
  else parts.push('存在负面情绪倾向');
  parts.push(`当前仅 ${count} 条，容易被频次统计淹没`);
  return parts.join('，');
}

/** 把外部持久化的处理状态合并进告警列表 */
export function mergeAlertStatus(alerts, statusMap = {}) {
  return alerts.map((a) => ({ ...a, status: statusMap[a.key] || ALERT_STATUS.PENDING }));
}
