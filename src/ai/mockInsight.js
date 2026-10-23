/**
 * ai/mockInsight.js —— P1 的「模拟 AI」：用本地规则把已有统计结果翻译成人话
 * ------------------------------------------------------------
 * 定位：**验证链路用**，不是真实模型。
 *   - 不联网、不需要任何 API Key、不消耗额度；
 *   - 输入是前端已经算好的结构化摘要（不含全量原始弹幕），输出符合 ai/schema.js 的洞察；
 *   - 刻意加了一点「解释性文字」和「话术建议」，让面板看起来像真的 AI 产出，
 *     但每条结论都能在输入数据里找到依据，不会凭空编造数字。
 *
 * 服务端（server/index.mjs）与测试（tools/smoke-test.mjs）共用这个纯函数。
 */

/** 各分类的「隐性需求 / 解读 / 回复话术 / 商家动作」模板 */
const CATEGORY_COPY = {
  size: {
    need: '顾客在确认尺码是否合身，核心顾虑是「买错尺码要退换」',
    reading: '尺码咨询集中在少数几个码段，说明详情页尺码表与主播口径需要统一，减少重复提问',
    reply: '我 160cm/50kg 穿 M 正好，腰围 66cm；胯宽的姐妹建议大一码，我在公屏置顶一下尺码表～',
    action: '把尺码表与主播试穿数据置顶到公屏 / 详情页首屏',
  },
  fabric: {
    need: '对面料成分与手感存在疑问，属于「下单前的信任缺口」',
    reading: '面料质疑常与季节、体感绑定（闷不闷、起不起球），需要给可验证的细节而不是形容词',
    reply: '这件是 95% 棉 5% 氨纶，克重 220g，夏天穿不闷；我这件洗了三次没起球，可以拉近给大家看细节～',
    action: '在讲解中固定插入「成分 + 克重 + 洗涤实测」三件套话术',
  },
  color: {
    need: '颜色选择依赖主播上身效果，顾客担心「实物与镜头色差」',
    reading: '颜色问题多为对比型提问（显不显黑、实物色差），灯光与镜头是主要干扰源',
    reply: '这个奶杏色偏暖，黄皮也显白；我把三色并排举到自然光下给大家看，实物和镜头基本一致～',
    action: '增加自然光下的三色并排展示，并在商品卡标注色差说明',
  },
  style: {
    need: '顾客在判断版型是否适合自己的身材，关注显瘦 / 宽松度',
    reading: '版型提问集中在肩宽、胯宽、身高体重段，说明需要按身材给穿搭建议而非统一尺码',
    reply: '肩宽的姐妹选落肩这款更顺；胯宽建议 A 字版型，我把两种版型同时穿上给大家对比～',
    action: '按「身材类型」整理三条选款路径，作为固定讲解段落',
  },
  price: {
    need: '价格敏感型顾客在等优惠或比价，属于高转化临门一脚',
    reading: '价格问题出现频率高但转化意愿强，适合用限时机制承接',
    reply: '今天直播间到手价 129，比店铺价低 30，前 50 单再送运费险，拍下就是最低价～',
    action: '为价格提问准备「到手价 + 限时机制 + 售后保障」三段式应答',
  },
  stock: {
    need: '顾客担心断码 / 补货，库存透明度直接影响下单决心',
    reading: '库存咨询集中在热销码段，说明库存播报节奏偏慢',
    reply: 'M 码还有 8 件，L 码 3 件，卖完这批要等下周；想要的姐妹先拍，我这边实时报库存～',
    action: '每 10 分钟播报一次热销码段库存，减少重复询问',
  },
  shipping: {
    need: '对发货时效有明确期待，属于「下单前的确定性需求」',
    reading: '物流问题多与「什么时候发 / 几天到」相关，承诺不清晰会直接流失',
    reply: '今天 16 点前拍下当天发出，江浙沪次日达，其他地方 2-3 天，超时我们承担运费～',
    action: '在讲解口播中固定承诺发货时效，并写明在商品卡',
  },
  aftersale: {
    need: '关注退换与售后保障，是「降低决策风险」的关键一环',
    reading: '售后提问往往伴随不满情绪，需要先共情再给具体流程',
    reply: '支持 7 天无理由，尺码不合适直接换，运费我们出；有问题私信我，我这边跟进到底～',
    action: '把退换流程做成一张图，在答疑时直接发公屏',
  },
  payment: {
    need: '下单/支付环节存在卡点，属于**直接影响成交的技术问题**',
    reading: '支付类反馈频次低但影响大，应优先核查而不是当成普通咨询',
    reply: '支付失败通常是银行卡限额或网络问题，可以换微信/支付宝再试，我让客服一对一跟进～',
    action: '立即排查支付失败原因，并对受影响观众做一对一兜底',
  },
  match: {
    need: '需要搭配建议来完成整套购买决策，客单价提升机会',
    reading: '搭配咨询说明顾客已在考虑「怎么穿」，适合顺势做关联推荐',
    reply: '这件上衣配我们的直筒牛仔最好看，一套下来更划算，我把链接挂在 3 号位～',
    action: '准备 3 套固定搭配方案，讲解时成套展示',
  },
  care: {
    need: '关心洗护方式，担心变形缩水，属于长期使用顾虑',
    reading: '洗护问题不多但很具体，回答清楚能显著降低退货率',
    reply: '30 度以下冷水机洗，别拧干别暴晒，平铺晾干就不会变形；我洗过三次给大家看效果～',
    action: '在商品详情补充洗护说明，减少售后纠纷',
  },
  stream: {
    need: '对直播间玩法 / 优惠机制不熟悉，需要更清晰的引导',
    reading: '直播间体验类提问说明规则传达不到位，新观众进入后容易迷路',
    reply: '关注领 10 元券，整点抽免单，想看的款打在公屏我挨个过一遍～',
    action: '把当天玩法做成一句话开场白，循环口播',
  },
};

const DEFAULT_COPY = {
  need: '顾客提出了需要进一步澄清的问题',
  reading: '该类问题需要结合具体商品信息回答',
  reply: '这个问题我详细说一下，有同样疑问的姐妹可以打在公屏～',
  action: '整理该类问题的高频问法，准备标准答复',
};

/** 取分类模板，未知分类走兜底 */
function copyOf(categoryId) {
  return CATEGORY_COPY[categoryId] || DEFAULT_COPY;
}

/** 百分比（整数） */
const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

/** 把时间窗换算成「近 N 分钟」 */
function windowLabel(payload) {
  const from = Number(payload?.window?.from);
  const to = Number(payload?.window?.to);
  if (!from || !to || to <= from) return '本批次';
  const mins = Math.max(1, Math.round((to - from) / 60000));
  return `近 ${mins} 分钟`;
}

/**
 * 生成一份模拟洞察。
 * @param {object} payload 由 ai/batcher.js 构建的结构化摘要
 * @returns {object} 符合 ai/schema.js 的洞察数据
 */
export function buildMockInsight(payload = {}) {
  const stats = payload.stats || {};
  const passed = Math.max(0, Number(stats.passed) || 0);
  const categories = Array.isArray(stats.categories) ? stats.categories : [];
  const top = categories.slice(0, 3);
  const lead = top[0];
  const focus = Array.isArray(payload.focus) ? payload.focus : [];
  const lowFreq = Array.isArray(payload.lowFrequency) ? payload.lowFrequency : [];
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const intents = stats.intents || {};

  const when = windowLabel(payload);

  // —— 一句话结论：永远先给最该被看到的那件事 ——
  let summary;
  if (!passed) {
    summary = `${when}没有收到有效弹幕，暂无法形成洞察。可以换「本地模拟源」先跑通链路。`;
  } else if (lead) {
    summary = `${when}共 ${passed} 条有效弹幕，${
      lead.label
    }是最集中的需求（${lead.count} 条，占 ${pct(lead.ratio)}）；${
      top[1] ? `其次是${top[1].label}（${top[1].count} 条）。` : '暂未出现第二类集中需求。'
    }${
      lowFreq.length ? `另有 ${lowFreq.length} 条低频高危反馈需要单独跟进。` : ''
    }`;
  } else {
    summary = `${when}共 ${passed} 条有效弹幕，但尚未形成明确的需求分类，建议先引导观众描述具体问题。`;
  }

  // —— 趋势：用「意向/反馈」占比粗判热度走向（口径明确写在 note 里）——
  const intentTotal = (intents.demand || 0) + (intents.question || 0) + (intents.feedback || 0);
  const hotShare = intentTotal ? ((intents.demand || 0) + (intents.feedback || 0)) / intentTotal : 0;
  const trend = hotShare >= 0.5
    ? {
      direction: 'up',
      label: '购买意向升温',
      note: `意向与反馈合计占 ${pct(hotShare)}，观众已进入比较与决策阶段，适合强化逼单话术`,
    }
    : hotShare >= 0.3
      ? {
        direction: 'flat',
        label: '以咨询为主',
        note: `意向与反馈占比 ${pct(hotShare)}，多数人还在了解阶段，需要先把信息讲透`,
      }
      : {
        direction: 'down',
        label: '互动偏冷',
        note: '提问以信息类为主，建议主动抛出话题或福利机制拉动互动',
      };

  // —— 隐性需求：从 Top 分类反推「没说出口的顾虑」——
  const implicitNeeds = top.map((c) => ({
    need: copyOf(c.id).need,
    evidence: `该分类 ${c.count} 条、占有效弹幕 ${pct(c.ratio)}，${
      questions.filter((q) => q.categoryId === c.id).slice(0, 1).map((q) => `代表问法「${q.text}」`).join('') || '问法集中于同类关键词'
    }`,
    confidence: Math.min(0.95, 0.45 + (Number(c.ratio) || 0) * 1.2),
  }));

  // —— 分类解读：数字直接来自 core 的统计，不重算 ——
  const categoryReadings = top.map((c) => ({
    id: c.id,
    label: c.label,
    count: c.count,
    share: Number(c.ratio) || 0,
    reading: copyOf(c.id).reading,
  }));

  // —— 低频高危：优先用 core 的告警，避免 AI 自己"发现"问题 ——
  const lowFrequency = lowFreq.slice(0, 3).map((a) => ({
    title: a.title,
    why: `仅 ${a.count} 条但严重度高（${Number(a.severity || 0).toFixed(2)}），容易被刷屏淹没`,
    action: copyOf(a.categoryId).action,
  }));

  // —— 回复话术：从代表性问题里挑，按分类给模板 ——
  const replySuggestions = questions
    .slice(0, 3)
    .map((q) => ({ question: q.text, reply: copyOf(q.categoryId).reply }))
    .filter((r, i, list) => list.findIndex((x) => x.reply === r.reply) === i);

  // —— 商家动作：按优先级排，P0 只给最紧急的一类 ——
  const merchantActions = [];
  if (lead && Number(lead.ratio) >= 0.3) {
    merchantActions.push({
      action: copyOf(lead.id).action,
      priority: 'P0',
      reason: `${lead.label}占有效弹幕 ${pct(lead.ratio)}，是当前转化最大的阻塞点`,
    });
  }
  if (lowFreq.length) {
    merchantActions.push({
      action: '优先处理低频高危反馈，安排客服一对一跟进',
      priority: 'P1',
      reason: `${lowFreq.length} 条低频高危问题若被忽略会造成差评或投诉`,
    });
  }
  if (top[1]) {
    merchantActions.push({
      action: copyOf(top[1].id).action,
      priority: 'P1',
      reason: `${top[1].label}是第二集中需求（${top[1].count} 条），补上可直接减少重复提问`,
    });
  }
  const noiseRate = Number(stats.noiseRate) || 0;
  if (noiseRate >= 0.3) {
    merchantActions.push({
      action: '减少纯口播时段，增加「提问—回答」互动节奏',
      priority: 'P2',
      reason: `噪声占比 ${pct(noiseRate)}，说明当前发言中含大量无信息内容`,
    });
  }

  return {
    model: 'mock-rules-v1',
    mode: 'mock',
    generatedAt: new Date().toISOString(),
    summary,
    trend,
    implicitNeeds,
    categories: categoryReadings,
    lowFrequency,
    replySuggestions,
    merchantActions,
    disclaimer: '本结果由本地规则模拟生成，用于验证链路，未调用真实大模型',
  };
}
