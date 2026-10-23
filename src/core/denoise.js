/**
 * denoise.js
 * ------------------------------------------------------------
 * 弹幕去噪过滤器。规则按「判定成本」从低到高执行，命中即返回原因。
 *
 * 对外接口：
 *   createDenoiseEngine(options) -> { evaluate(msg) -> {passed, reasonId, ruleId, reasonLabel} }
 *
 * 敏感度 sensitivity(0~100) 影响：
 *   - 最短有效长度门槛
 *   - 重复字符容忍度
 *   - dup 去重窗口长度
 *   - lowInfo 是否启用
 */
import { FILTER_REASON_MAP } from './constants.js?v=20261023f';
import { isPureSymbol } from './normalize.js?v=20261023f';

/** 已知营销/刷屏话术（正则 + 说明） */
const SPAM_PATTERNS = [
  { re: /加微信|微信号|vx|v信|weixin|加群|私聊我|扫码|二维码/, note: '导流/广告' },
  { re: /代拍|代购|内部价|一手货源|厂家直供|批发清仓/, note: '外部广告' },
  { re: /签到|打卡|每日打卡|已签到/, note: '任务打卡' },
  { re: /关注主播|点点关注|点个小爱心|亮个灯牌|冲榜|上票|帮点点/, note: '互动任务' },
  { re: /抢红包|福袋|抽奖口令|红包雨/, note: '抽奖刷屏' },
  { re: /^\d+$/, note: '纯数字' },
  { re: /棒棒棒|买它买它买它|666+/, note: '口号刷屏' },
];

/** 单字重复刷屏，如「哈哈哈啊」「好好好好」「？？？？？」 */
const REPEAT_RE = /^(.)\1{3,}$/u;

/** 方括号表情，如 [呲牙] [大笑] [捂脸]（聊天室表情的文本形态） */
const BRACKET_EMOJI_RE = /\[[^\[\]\s]{1,8}\]/g;

/** 无实质信息的寒暄（默认敏感度下最短长度为 3，因此这里只放 ≥3 字的短语） */
const LOW_INFO_LIST = [
  '好看呀', '好好看', '好看好看', '来了来了', '收到收到', '主播好看',
  '爱了爱了', '好的好的', '嗯嗯呢', '在的在的', '哇好美', '好漂亮啊',
];

export function createDenoiseEngine(options) {
  const opts = { ...options };
  const s = opts.sensitivity ?? 60;

  // 敏感度 → 参数映射
  const minLen = s >= 80 ? 4 : s >= 45 ? 3 : 2;      // 最短有效长度
  const repeatTolerance = s >= 80 ? 3 : s >= 45 ? 4 : 6; // 允许的最大连续重复数
  const dupWindowMs = Math.round((s >= 80 ? 25000 : s >= 45 ? 15000 : 8000));
  const enableLowInfo = s >= 45;

  const recentByUser = new Map(); // userId -> 窗口内消息列表 [{text, ts}]
  const recentGlobal = [];        // 全局最近文本窗口 [{text, ts, userId}]

  function cleanup(now) {
    while (recentGlobal.length && now - recentGlobal[0].ts > dupWindowMs) recentGlobal.shift();
    recentByUser.forEach((arr, k) => {
      const kept = arr.filter((h) => now - h.ts <= dupWindowMs);
      if (kept.length) recentByUser.set(k, kept);
      else recentByUser.delete(k);
    });
  }

  /**
   * @param {object} msg 统一弹幕结构
   * @returns {{passed:boolean, reasonId:string|null, ruleId:string|null, reasonLabel:string|null, note:string|null}}
   */
  function evaluate(msg) {
    const pass = { passed: true, reasonId: null, ruleId: null, reasonLabel: null, note: null };
    const fail = (reasonId, note = null) => {
      const r = FILTER_REASON_MAP[reasonId];
      return {
        passed: false, reasonId, ruleId: r ? r.rule : null, reasonLabel: r ? r.label : reasonId, note,
      };
    };

    const rawText = msg.text || '';
    const text = msg.normalizedText || '';
    const now = msg.timestamp || Date.now();

    cleanup(now);

    // 1. 纯表情符号（必须先于长度判断，否则会被误判为「内容过短」）
    if (isPureSymbol(rawText)) return fail('symbol');

    // 1.5 方括号表情刷屏：[大笑][大笑][大笑] 这类。剥掉表情后没有实质内容 → 干扰信息
    const brackets = rawText.match(BRACKET_EMOJI_RE) || [];
    if (brackets.length) {
      const rest = rawText.replace(BRACKET_EMOJI_RE, '').replace(/[\s\p{P}\p{S}]/gu, '');
      if (!rest) {
        const uniqueKinds = new Set(brackets).size;
        // 同一表情连刷 → 重复刷屏；混合纯表情 → 表情符号
        return fail(brackets.length >= 3 && uniqueKinds === 1 ? 'repeat' : 'symbol', '表情包刷屏');
      }
    }

    // 2. 空 / 过短
    if (!text || text.length < minLen) return fail('short');

    // 3. 重复字符刷屏
    if (REPEAT_RE.test(text)) return fail('repeat');
    const maxRun = maxConsecutive(text);
    if (maxRun >= repeatTolerance && uniqueRatio(text) < 0.4) return fail('repeat');

    // 4. 营销/刷屏话术
    for (const p of SPAM_PATTERNS) {
      if (p.re.test(text)) return fail('spam', p.note);
    }

    // 5. 短时间内重复
    // 5a. 同一观众在窗口内重复发送同一句 → 复读，过滤
    //     （查窗口内全部历史而不是只查最后一条，否则隔一句就能绕过）
    const userHistory = recentByUser.get(msg.userId) || [];
    if (userHistory.some((h) => h.text === text && now - h.ts <= dupWindowMs)) {
      return fail('duplicate', '同一观众短时间重复发送');
    }
    // 5b. 全局雷同要区分「少数人刷屏」与「多人真实同问」：
    //     很多不同观众问同一句话是有效需求信号（问题聚合正要靠它统计热度），不能过滤；
    //     只有同一小撮人快速复读、或总量明显失控时才算刷屏。
    const sameText = recentGlobal.filter((r) => r.text === text);
    if (sameText.length) {
      const distinctUsers = new Set(sameText.map((r) => r.userId));
      const fewPeopleFlooding = sameText.length >= 2 && distinctUsers.size <= 2
        && now - sameText[sameText.length - 1].ts <= 3000;
      const outOfControl = sameText.length >= 8;
      if (fewPeopleFlooding || outOfControl) {
        recentGlobal.push({ text, ts: now, userId: msg.userId });
        return fail('duplicate', '窗口内同一内容反复出现（刷屏）');
      }
    }

    // 6. 无实质信息
    if (enableLowInfo && LOW_INFO_LIST.includes(text)) return fail('low_info');

    // 通过：写入窗口
    userHistory.push({ text, ts: now });
    recentByUser.set(msg.userId, userHistory);
    recentGlobal.push({ text, ts: now, userId: msg.userId });
    return pass;
  }

  function reset() {
    recentByUser.clear();
    recentGlobal.length = 0;
  }

  return { evaluate, reset, config: { minLen, repeatTolerance, dupWindowMs, enableLowInfo } };
}

/** 最大连续相同字符数 */
function maxConsecutive(text) {
  let max = 1;
  let run = 1;
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === text[i - 1]) {
      run += 1;
      max = Math.max(max, run);
    } else {
      run = 1;
    }
  }
  return max;
}

/** 去重字符比例 */
function uniqueRatio(text) {
  const unique = new Set(text.split(''));
  return unique.size / text.length;
}
