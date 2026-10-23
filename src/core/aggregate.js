/**
 * aggregate.js
 * ------------------------------------------------------------
 * 重复问题聚合：把语义相近的弹幕合并成「问题簇」，用于统计真实需求热度。
 *
 * 对外接口：
 *   aggregateQuestions(items, options) -> Cluster[]
 *
 * Cluster = {
 *   id, title, count, userCount, firstAt, lastAt,
 *   categoryId, categoryLabel, intent, maxSeverity,
 *   samples: string[], itemIds: string[]
 * }
 *
 * 算法（基础版，可解释、可调）：
 *   1. 仅对通过去噪、且属于「提问/购买意向/反馈」的弹幕聚簇（闲聊不参与）
 *   2. 依次与已有簇的「代表文本」计算相似度，超过阈值则并入
 *   3. 并入时用「出现次数最多的最长文本」更新代表标题，保证标题稳定可读
 */
import { textSimilarity } from './similarity.js?v=20261023f';
import { stableHash } from './normalize.js?v=20261023f';
import { INTENT } from './constants.js?v=20261023f';

const CLUSTERABLE_INTENTS = new Set([INTENT.QUESTION, INTENT.DEMAND, INTENT.FEEDBACK]);

export function aggregateQuestions(items, options = {}) {
  const threshold = options.clusterThreshold ?? 0.55;
  const clusters = [];

  items.forEach((item) => {
    if (!item.filter.passed) return;
    if (!CLUSTERABLE_INTENTS.has(item.intent)) return;

    const text = item.normalizedText;
    if (!text) return;

    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = textSimilarity(cluster.representative, text);
      if (score > bestScore) {
        bestScore = score;
        best = cluster;
      }
    }

    if (best && bestScore >= threshold) {
      mergeIntoCluster(best, item, bestScore);
    } else {
      clusters.push(createCluster(item));
    }
  });

  return clusters
    .map(finalizeCluster)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

function createCluster(item) {
  return {
    id: `c_${stableHash(item.normalizedText, 8)}`,
    representative: item.normalizedText,
    title: item.text,
    count: 1,
    users: new Set([item.userId]),
    itemIds: [item.id],
    samples: [item.text],
    firstAt: item.timestamp,
    lastAt: item.timestamp,
    categoryVotes: new Map([[item.categoryId, 1]]),
    categoryLabel: item.categoryLabel,
    intents: new Map([[item.intent, 1]]),
    maxSeverity: item.severity,
    peakSimilarity: 1,
  };
}

function mergeIntoCluster(cluster, item, score) {
  cluster.count += 1;
  cluster.users.add(item.userId);
  cluster.itemIds.push(item.id);
  if (cluster.samples.length < 3) cluster.samples.push(item.text);
  cluster.firstAt = Math.min(cluster.firstAt, item.timestamp);
  cluster.lastAt = Math.max(cluster.lastAt, item.timestamp);
  cluster.categoryVotes.set(item.categoryId, (cluster.categoryVotes.get(item.categoryId) || 0) + 1);
  cluster.intents.set(item.intent, (cluster.intents.get(item.intent) || 0) + 1);
  cluster.maxSeverity = Math.max(cluster.maxSeverity, item.severity);
  cluster.peakSimilarity = Math.max(cluster.peakSimilarity, score);

  // 标题策略：优先保留出现过的、信息量更完整的表述（长度更长但不过长）
  if (item.text.length > cluster.title.length && item.text.length <= 24) {
    cluster.title = item.text;
  }
}

function finalizeCluster(c) {
  let categoryId = null;
  let bestVotes = 0;
  c.categoryVotes.forEach((v, k) => {
    if (k && v > bestVotes) { bestVotes = v; categoryId = k; }
  });
  if (!categoryId) {
    // 未命中多数投票时取首条所属分类
    categoryId = [...c.categoryVotes.keys()][0] || null;
  }

  let intent = null;
  let intentVotes = 0;
  c.intents.forEach((v, k) => {
    if (v > intentVotes) { intentVotes = v; intent = k; }
  });

  return {
    id: c.id,
    title: c.title,
    count: c.count,
    userCount: c.users.size,
    itemIds: c.itemIds,
    samples: c.samples,
    firstAt: c.firstAt,
    lastAt: c.lastAt,
    categoryId,
    categoryLabel: c.categoryLabel,
    intent,
    maxSeverity: c.maxSeverity,
    peakSimilarity: Number(c.peakSimilarity.toFixed(2)),
    /** 热度分：出现次数 * 独立用户加成 */
    heat: Number((c.count * (1 + Math.min(c.users.size, 10) * 0.08)).toFixed(2)),
  };
}
