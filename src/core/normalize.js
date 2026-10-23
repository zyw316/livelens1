/**
 * normalize.js
 * ------------------------------------------------------------
 * 把任意弹幕源的原始消息归一化为统一的 DanmakuMessage 结构。
 * 新增数据源时，只需要在这里加一个适配器函数，上层算法无需改动。
 */
import { SOURCE } from './constants.js?v=20261023f';

/** 匹配 emoji / 变体选择符 / 常见装饰符号 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
/**
 * 匹配标点、空白、非常规符号（注意：刻意保留 `?`，问号是意图识别的重要特征）
 */
const PUNCT_RE = /[\s\u3000\u2000-\u206F\u3001-\u303F\uFF01-\uFF65\u0021-\u002F\u003A-\u003C\u003E-\u0040\u005B-\u0060\u007B-\u007E]+/gu;

/** 文本归一化：去表情 → 全角问号转半角 → 小写 → 去标点空白（算法一律基于归一化文本） */
export function normalizeText(raw = '') {
  if (!raw) return '';
  let text = String(raw).replace(EMOJI_RE, '');
  text = text.replace(/？|﹖|？/g, '?');
  text = text.toLowerCase();
  text = text.replace(PUNCT_RE, '');
  return text.trim();
}

/** 是否整句都是符号/表情（归一化后为空但原文非空） */
export function isPureSymbol(raw = '') {
  const origin = String(raw).replace(/\s/g, '');
  return origin.length > 0 && normalizeText(origin).length === 0;
}

/** 简单稳定哈希（仅用于生成脱敏标识，非加密用途） */
export function stableHash(input, len = 4) {
  const str = String(input);
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, len).padStart(len, '0');
}

let seq = 0;
function nextId(prefix = 'dm') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

/** 用户脱敏：userId → "观众#a3f1" */
export function maskUser(userId) {
  return `观众#${stableHash(userId, 4)}`;
}

/**
 * 通用归一化入口
 * @param {object} raw  { id?, userId?, nick?, text, ts?, roomId?, meta? }
 * @param {string} source SOURCE.MOCK | SOURCE.POLYV
 * @returns {object} DanmakuMessage
 */
export function normalizeMessage(raw, source = SOURCE.MOCK) {
  const userId = raw.userId || raw.nick || 'anonymous';
  const text = String(raw.text ?? '').slice(0, 200);
  const normalizedText = normalizeText(text);
  return {
    id: raw.id || nextId(source),
    roomId: raw.roomId || '',
    userId: String(userId),
    userKey: maskUser(userId),
    text,
    normalizedText,
    timestamp: Number(raw.ts ?? Date.now()),
    source,
    meta: raw.meta || {},
  };
}

/** 批量归一化 */
export function normalizeAll(list, source) {
  return list.map((r) => normalizeMessage(r, source));
}
