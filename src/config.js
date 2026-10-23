/**
 * config.js
 * ------------------------------------------------------------
 * 前端运行配置。
 *
 * 安全约定（重要）：
 *   - 保利威的 AppId / AppSecret / 签名 **永远不能出现在前端代码里**。
 *   - AppSecret 只应存在于服务端；前端通过 signEndpoint 向自有后端请求临时签名，
 *     再由后端用 AppSecret 换取保利威 accessToken 返回给前端。详见
 *     src/providers/polyv/README.md
 *   - 本 Demo 全部使用模拟数据（CONFIG.demoMode = true）。
 */
export const CONFIG = {
  demoMode: true,
  roomId: 'DEMO-ROOM-8810',

  /** 原始弹幕缓冲上限，超出后丢弃最旧数据 */
  maxBuffer: 500,

  /** 模拟弹幕源参数 */
  mock: {
    minIntervalMs: 700,
    maxIntervalMs: 1800,
    repeatChance: 0.12,   // 复述上一条的概率（用于验证重复过滤）
    noiseChance: 0.16,    // 发送噪声弹幕的概率
    rareChance: 0.12,     // 发送「低频但严重」弹幕的概率
  },

  /**
   * 保利威接入配置
   * ------------------------------------------------------------
   * 已接入官方 Web 观看页 SDK 的聊天室模块（@polyv/live-watch-sdk 2.20.0）。
   */
  polyv: {
    /** 是否启用保利威数据源。false 时切到该源会直接报错并提示改用模拟源。 */
    enabled: true,

    /** 测试频道号（保利威云直播频道 / 聊天室） */
    channelId: '8620440',

    /**
     * 保利威应用 id —— 非敏感信息，可安全放在前端。
     * 观看页 SDK 的初始化本身不需要 appId；它只在你为频道开启「自定义授权」
     * （需要后端用 AppSecret 签名）时才参与。这里保留是为了让授权请求能带上它。
     */
    appId: 'gq7s700644',

    /**
     * SDK 地址：固定到官方已发布版本 2.20.0（npm latest 同版本）。
     * 用官方 ESM 产物 + 浏览器原生动态 import()，因此无需任何构建工具。
     * 若要离线运行，把该文件下载到 assets/ 下并把这里改成本地相对路径即可。
     */
    sdkVersion: '2.20.0',
    sdkUrl: 'https://cdn.jsdelivr.net/npm/@polyv/live-watch-sdk@2.20.0/lib/polyv-live-watch-sdk.esm.js',

    /**
     * 后端授权 / 签名服务地址。**留空表示频道无需额外授权**（普通测试频道即如此）。
     * 只有当频道开启了「自定义授权」等需要签名的观看条件时，才把它指向自有后端；
     * 后端从环境变量读取 AppSecret 完成签名，前端永远不接触密钥。
     */
    signEndpoint: '',

    /** 允许进入分析流程的消息来源。默认只要观众发言，过滤系统/打赏/特效等。 */
    acceptMsgSources: ['speak'],
  },

  /**
   * AI 洞察配置（P2：支持真实大模型，未配置时自动回退本地模拟）
   * ------------------------------------------------------------
   * 旁挂式：AI 只读 core 的分析结果，不参与、不回写任何统计，
   * 关闭后 core 的过滤/分类/聚合/告警完全不受影响。
   *
   * 安全约定：前端不含任何模型 API Key。请求只发到自有后端 /api/ai/insight，
   * 由服务端读取环境变量/.env 里的密钥（见 .env.example）。
   * 后端未配置 Key 或真实模型调用失败时，会自动回退本地规则模拟，
   * 面板会显示「模拟输出」并在洞察末尾注明原因。
   */
  ai: {
    /** 是否默认开启（用户可在面板上关闭，选择会记忆在 localStorage） */
    enabled: true,

    /** 自有后端的洞察接口 */
    endpoint: '/api/ai/insight',

    /**
     * 云端免费大模型（WorkBuddy 云服务 keyless LLM）
     * ------------------------------------------------------------
     * 优先通道：前端直调云端模型，**不需要用户注册任何模型厂商、不需要任何密钥**。
     * 任一步失败（CDN 不可达 / 本机 Origin 不放行 / 模型超时）都会自动回退到
     * 自有后端，后端也不在（纯静态托管）时回退本地规则模拟，面板与核心功能不受影响。
     *
     * endpoint 与 publishableKey 来自云服务激活后的 publicConfig：
     *   - publishableKey 只是「哪个应用」的标识，本身不带权限，可安全出现在前端源码；
     *   - 服务端按发布域名做**精确 Origin 校验**：只有应用自己的发布域名与本机
     *     127.0.0.1 调试源会被放行。把页面挂到第三方静态托管（如 GitHub Pages）时
     *     云端会返回 403，此时自动走第三级本地模拟兜底（见 ai/batcher.js）。
     *     换域名发布后需同步更新这两个值。
     */
    cloud: {
      enabled: true,
      endpoint: 'https://livelens-danmaku.app.workbuddy.host',
      publishableKey: 'wbpk_KhWagfaEMwSjGVz7Tj6NDS_q7lT6RmTYJjohXAZGjnMS9FKotEy41J8',
      /** 偏好模型（快的放前面）；都不在列表时自动选第一个可用模型 */
      preferredModels: ['glm-5.3-flash', 'glm-5.3', 'hy3', 'auto'],
      /** 云端含流式输出，超时放宽到 30s */
      timeoutMs: 30000,
    },

    /** 批次间隔：每 15 秒看一次有没有新数据 */
    batchIntervalMs: 15000,

    /** 至少积累多少条**新**弹幕才值得再问一次，避免空跑 */
    minNewMessages: 3,

    /** 单次请求超时 */
    timeoutMs: 8000,
  },
};

export default CONFIG;
