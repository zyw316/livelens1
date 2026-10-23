/**
 * ai/schema.js —— AI 洞察的数据契约（P1：模拟数据也走同一套结构）
 * ------------------------------------------------------------
 * 为什么先定契约：
 *   前端面板只认这一套结构。P1 由本地规则生成（mockInsight.js），P2 换成真实模型时，
 *   只要后端把模型输出映射成同样的字段，前端一行都不用改。
 *
 * 安全约定：
 *   - 这里只做结构校验与兜底，不做任何业务判断；分类/告警仍以 core 的规则结果为准。
 *   - AI 结果永远只是「解释与建议」，不参与、不回写 core 的任何统计。
 */

/** 允许的优先级 */
export const PRIORITIES = ['P0', 'P1', 'P2'];
/** 允许的趋势方向 */
export const TREND_DIRECTIONS = ['up', 'flat', 'down'];

const str = (v, fallback = '', max = 240) => {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

const clamp01 = (v) => Math.min(1, Math.max(0, num(v, 0)));

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * 校验并规范化一份洞察。
 * 设计原则：**永远返回可用结构**，非法字段降级为默认值，绝不因为模型抽风让面板崩掉。
 *
 * @param {any} input 后端返回的 data
 * @returns {{ok:boolean, errors:string[], data:object}}
 */
export function validateInsight(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : null;
  if (!src) {
    return { ok: false, errors: ['洞察内容不是对象'], data: emptyInsight(errors) };
  }

  const data = {
    model: str(src.model, 'unknown', 64),
    mode: src.mode === 'real' ? 'real' : 'mock',
    generatedAt: str(src.generatedAt, new Date().toISOString(), 40),
    summary: str(src.summary, '', 300),
    trend: {
      direction: TREND_DIRECTIONS.includes(src.trend?.direction) ? src.trend.direction : 'flat',
      label: str(src.trend?.label, '无明显变化', 30),
      note: str(src.trend?.note, '', 160),
    },
    implicitNeeds: arr(src.implicitNeeds).slice(0, 5).map((n) => ({
      need: str(n?.need, '', 120),
      evidence: str(n?.evidence, '', 200),
      confidence: Number(clamp01(n?.confidence).toFixed(2)),
    })).filter((n) => n.need),
    categories: arr(src.categories).slice(0, 6).map((c) => ({
      id: str(c?.id, '', 32),
      label: str(c?.label, '未分类', 24),
      count: Math.max(0, Math.round(num(c?.count))),
      share: Number(clamp01(c?.share).toFixed(3)),
      reading: str(c?.reading, '', 200),
    })),
    lowFrequency: arr(src.lowFrequency).slice(0, 5).map((a) => ({
      title: str(a?.title, '', 120),
      why: str(a?.why, '', 200),
      action: str(a?.action, '', 160),
    })).filter((a) => a.title),
    replySuggestions: arr(src.replySuggestions).slice(0, 4).map((r) => ({
      question: str(r?.question, '', 120),
      reply: str(r?.reply, '', 260),
    })).filter((r) => r.reply),
    merchantActions: arr(src.merchantActions).slice(0, 5).map((a) => ({
      action: str(a?.action, '', 120),
      priority: PRIORITIES.includes(a?.priority) ? a.priority : 'P2',
      reason: str(a?.reason, '', 160),
    })).filter((a) => a.action),
    disclaimer: str(src.disclaimer, '本结果为本地规则模拟，未接入真实模型', 160),
  };

  if (!data.summary) errors.push('缺少 summary');
  if (!data.implicitNeeds.length) errors.push('缺少 implicitNeeds');
  if (!data.categories.length) errors.push('缺少 categories');

  return { ok: errors.length === 0, errors, data };
}

/** 完全空白的兜底结构（用于首次渲染占位） */
export function emptyInsight(errors = []) {
  return {
    model: 'none',
    mode: 'mock',
    generatedAt: '',
    summary: '',
    trend: { direction: 'flat', label: '等待数据', note: '' },
    implicitNeeds: [],
    categories: [],
    lowFrequency: [],
    replySuggestions: [],
    merchantActions: [],
    disclaimer: errors.length ? `洞察数据不可用：${errors.join('；')}` : '尚未生成洞察',
  };
}

/** 面板用的阶段文案 */
export const AI_STATUS = {
  IDLE: 'idle',
  WAITING: 'waiting',
  LOADING: 'loading',
  OK: 'ok',
  ERROR: 'error',
  DISABLED: 'disabled',
  UNAVAILABLE: 'unavailable',
};

export const AI_STATUS_LABELS = {
  idle: '待启动',
  waiting: '等待弹幕数据',
  loading: '分析中…',
  ok: '已更新',
  error: '生成失败',
  disabled: '已关闭',
  unavailable: '后端未启动',
};
