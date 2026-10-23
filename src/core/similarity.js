/**
 * similarity.js
 * ------------------------------------------------------------
 * 中文短文本相似度：基于字符二元组（bigram）的 Jaccard + 包含度加权。
 * 之所以不用词向量：Demo 阶段要保证零依赖、结果可解释、便于调试。
 * 后续要升级，只需保持 textSimilarity(a, b) 的签名不变。
 */

/**
 * 口语填充词：相似度比较前先剔除。
 * 「这个针织衫有哪些尺码呀」和「针织衫有什么尺码」本质是同一个问题，
 * 但字面差异会被 bigram 放大，剥离填充词后匹配率明显提升。
 */
const FILLERS = [
  '这个', '这件', '这条', '这款', '这些', '那些', '那个', '什么样', '请问', '主播', '一下',
  '大家', '可以', '能不能', '有没有', '你好',
  '的', '了', '吗', '呢', '啊', '呀', '哦', '吧', '哇', '哈', '嘛', '地', '得', '着', '我', '你', '他', '是',
];

function stripFillers(text = '') {
  let s = String(text);
  FILLERS.forEach((f) => {
    if (s.length > f.length) s = s.split(f).join('');
  });
  return s || String(text);
}

export function bigrams(text = '') {
  const s = stripFillers(text);
  if (s.length < 2) return s ? new Set([s]) : new Set();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  small.forEach((item) => { if (large.has(item)) inter += 1; });
  return inter / (a.size + b.size - inter);
}

/** 包含度：短句被长句覆盖的比例，用于「黑色有没有m码」≈「有m码吗」这类长短语差异 */
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  small.forEach((item) => { if (large.has(item)) inter += 1; });
  return inter / small.size;
}

/**
 * 文本相似度 0~1
 * @param {string} a 归一化文本
 * @param {string} b 归一化文本
 */
export function textSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  const j = jaccard(A, B);
  const c = containment(A, B);
  // 包含度高说明语义被覆盖，但惩罚长度差异带来的噪声
  return Math.min(0.99, Math.max(j, c * 0.85));
}

/** 取出文本中的尺码/数字类特征，用于在相似度接近时做二次确认 */
export function numericFeatures(text = '') {
  const set = new Set();
  const matched = String(text).match(/\d+|m码|l码|xl|xxl|均码/g);
  if (matched) matched.forEach((m) => set.add(m));
  return set;
}
