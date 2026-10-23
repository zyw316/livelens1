/**
 * classify.js
 * ------------------------------------------------------------
 * 意图识别 + 服装行业需求分类 + 严重度打分（均为基础规则实现，非占位）
 * 对外接口：
 *   detectIntent(normalizedText) -> { intent, label, hits }
 *   classifyCategory(normalizedText) -> { categoryId, label, confidence, hits, scores }
 *   scoreSeverity(normalizedText) -> { severity, hits }
 *   richAnalyze(normalizedText) -> 上述三项的合并结果
 */
import {
  INTENT, INTENT_LABELS, INTENT_RULES, DEMAND_CATEGORIES, CATEGORY_MAP, SEVERITY_DICT,
} from './constants.js?v=20261023f';

/** 意图识别：命中多重信号时按 提问 > 反馈 > 购买意向 > 闲聊 的优先级裁决 */
export function detectIntent(normalizedText = '') {
  const t = normalizedText;
  const hits = {
    question: [],
    demand: [],
    feedback: [],
  };

  INTENT_RULES.questionWords.forEach((w) => { if (t.includes(w)) hits.question.push(w); });
  INTENT_RULES.questionMarks.forEach((w) => { if (t.includes(w)) hits.question.push(w); });
  INTENT_RULES.feedbackWords.forEach((w) => { if (t.includes(w)) hits.feedback.push(w); });
  INTENT_RULES.demandWords.forEach((w) => { if (t.includes(w)) hits.demand.push(w); });

  let intent = INTENT.CHAT;
  if (hits.feedback.length > 0) intent = INTENT.FEEDBACK;
  if (hits.demand.length > 0) intent = INTENT.DEMAND;
  // 提问信号最强：包含疑问词或问号，且不是明确的购买指令
  const strongQuestion = hits.question.some((w) => [
    '吗', '？', '?', '怎么', '怎样', '如何', '多少', '多久', '什么样', '哪里', '哪儿',
    '是不是', '能不能', '有没有', '哪些', '什么', '几号', '是否', '几个', '哪位',
    '哪个', '还是', '会不会', '合适吗', '适合吗',
    '怎么办', '咋办', '咋整', '如何处理',
  ].includes(w));
  if (strongQuestion && intent !== INTENT.DEMAND) intent = INTENT.QUESTION;
  if (intent === INTENT.FEEDBACK && strongQuestion) intent = INTENT.FEEDBACK;

  return { intent, label: INTENT_LABELS[intent], hits };
}

/**
 * 需求分类：关键词加权投票，取最高分；多类接近时给出次优候选便于调试
 * @returns {{categoryId:string|null, label:string, confidence:number, hits:string[], scores:Array}}
 */
export function classifyCategory(normalizedText = '') {
  const t = normalizedText;
  const scores = [];

  DEMAND_CATEGORIES.forEach((cat) => {
    let score = 0;
    const hits = [];
    cat.keywords.forEach(([word, weight]) => {
      if (!word || weight <= 0) return;
      if (t.includes(word)) {
        score += weight;
        hits.push(word);
      }
    });
    if (score > 0) scores.push({ id: cat.id, label: cat.label, score, hits });
  });

  if (!scores.length) {
    return { categoryId: null, label: '未分类', confidence: 0, hits: [], scores: [] };
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const total = scores.reduce((sum, s) => sum + s.score, 0);
  // 置信度 = 最高分占比（体现类别区分度），再对绝对分数做一个轻微加成
  const dominance = best.score / total;
  const confidence = Math.min(1, dominance * 0.7 + Math.min(best.score, 8) / 8 * 0.3);

  return {
    categoryId: best.id,
    label: best.label,
    confidence: Number(confidence.toFixed(3)),
    hits: best.hits,
    scores,
  };
}

/** 严重度打分：命中多条时取「最大值 + 其余打折累加」，避免堆叠刷分 */
export function scoreSeverity(normalizedText = '') {
  const t = normalizedText;
  const hits = [];
  SEVERITY_DICT.forEach(([word, weight]) => {
    if (t.includes(word)) hits.push({ word, weight });
  });
  if (!hits.length) return { severity: 0, hits: [] };

  hits.sort((a, b) => b.weight - a.weight);
  let severity = hits[0].weight;
  for (let i = 1; i < hits.length; i += 1) {
    severity += hits[i].weight * (0.25 / i);
  }
  return { severity: Number(Math.min(1, severity).toFixed(3)), hits: hits.map((h) => h.word) };
}

/** 文本全量解析（意图 + 分类 + 严重度） */
export function richAnalyze(normalizedText = '') {
  const intent = detectIntent(normalizedText);
  const category = classifyCategory(normalizedText);
  const severity = scoreSeverity(normalizedText);
  return {
    intent: intent.intent,
    intentLabel: intent.label,
    intentHits: intent.hits,
    categoryId: category.categoryId,
    categoryLabel: category.label,
    confidence: category.confidence,
    categoryHits: category.hits,
    severity: severity.severity,
    severityHits: severity.hits,
    color: category.categoryId ? CATEGORY_MAP[category.categoryId].color : null,
  };
}
