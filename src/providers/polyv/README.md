# 保利威（Polyv）聊天室接入说明

> 状态：**已接入并可端到端验证**。
> 使用官方 Web 观看页 SDK `@polyv/live-watch-sdk@2.20.0` 的聊天室模块，
> 监听官方 `ChatEvents.ChatMessage` 事件，不做自造 WebSocket、不伪造 SDK 调用。

## 1. 真实链路

```
保利威聊天室
  └─(官方 SDK 内部 socket，SDK 自己建立与维护)
      └─> ChatEvents.ChatMessage   { id, time, user:{userId,nick}, content, msgSource }
          └─> polyvProvider.mapChatMsg()        映射成统一弹幕格式
              └─> normalizeMessage()(main.js)   归一化
                  └─> store → 现有分析流程（去噪/分类/聚合/告警）
```

本目录只做三件事：**连接 SDK、监听官方事件、映射字段**。
去噪 / 分类 / 聚合 / 告警全部由 `src/core` 现有算法完成，本目录不参与、也不改写。

## 2. 为什么不需要构建工具

SDK 同时发布 UMD 与 **ESM** 产物，且 ESM 产物自包含（无裸模块导入）。
因此用浏览器原生动态 `import()` 直接加载官方 ESM 文件即可，**不需要 npm / 打包器 / 转译**：

```js
// src/providers/polyv/sdkLoader.js
const sdk = await import(CONFIG.polyv.sdkUrl);
```

版本固定为 `2.20.0`（npm `latest` 同版本），写在 `src/config.js`，不使用占位版本。
若要离线演示，把 `polyv-live-watch-sdk.esm.js` 下载到 `assets/` 并把 `sdkUrl` 改成本地相对路径即可。

## 3. 配置（`src/config.js`）

```js
polyv: {
  enabled: true,              // false 时选该源会直接报错并提示改用模拟源
  channelId: '8620440',       // 测试频道号
  appId: 'gq7s700644',        // 非敏感，可放前端；SDK 初始化本身不需要它
  sdkVersion: '2.20.0',
  sdkUrl: 'https://cdn.jsdelivr.net/npm/@polyv/live-watch-sdk@2.20.0/lib/polyv-live-watch-sdk.esm.js',
  signEndpoint: '',           // 留空 = 该频道无需额外授权
  acceptMsgSources: ['speak'],// 只要观众发言，过滤系统/打赏/特效
}
```

## 4. 授权（重要）

保利威的 `watchCore.connect()` 内部会先校验 `auth.isAuthorized()`，未授权会打印
`需要观众授权后才能连接聊天室` 并**静默返回**——表现为"连上了但永远收不到消息"。

`ensureAuthorized()` 的处理：

1. 读 `auth.getAuthSettings()`，若观看条件不是 `none`（验证码 / 白名单 / 付费 / 自定义授权等），
   **直接报错并说明需要准备什么**，不做任何伪造或绕过。
2. 若是 `none`，调官方 `auth.verifyNoneAuth()`。
3. 授权后**必须重新 `setup()`**，SDK 才会拉取带观众信息（`viewerInfo`）的频道数据；
   否则后续 `connect()` 会报 `requiredUserId fail, userId is undefined`。
4. 再次确认 `isAuthorized()` 为 true 才继续。

当前测试频道 8620440 为**无条件观看**，因此 `signEndpoint` 留空，**前端不涉及任何密钥**。

### 若频道开启「自定义授权」才需要后端

只有那时才把 `signEndpoint` 指向自有后端，由后端从**环境变量**读取 AppSecret 完成签名，前端只拿一次性授权参数：

```
浏览器 → GET /api/polyv/sign?channelId=xxx → 自有后端(env: POLYV_APP_SECRET)
                                            → 保利威换 token → 返回给前端
```

```js
// 示意：字段名以保利威开放平台当前官方文档为准
const sign = md5(`appId=${APP_ID}&timestamp=${ts}${process.env.POLYV_APP_SECRET}`).toUpperCase();
```

`polyvProvider.requestAuthParams()` 已预留该调用位，`signEndpoint` 为空时直接返回 `{}`。

## 5. 字段映射

| 统一字段 | 保利威字段 | 说明 |
| --- | --- | --- |
| `id` | `chatMsg.id` | 同时用于幂等去重（`seenIds`），重连时同一条不会重复进入分析 |
| `userId` | `chatMsg.user.userId` | 缺失时回落 `nick`，再缺失为 `anonymous` |
| `nick` | `chatMsg.user.nick` | |
| `text` | `chatMsg.content` | |
| `ts` | `chatMsg.time` | `toMillis()` 自动判断秒/毫秒 |
| `roomId` | `CONFIG.polyv.channelId` | |

另有两点过滤：

- `msgSource` 不在 `acceptMsgSources` 内 → 计入 `ignoredCount`，不进分析（不是观众发言）。
- `isLocal === true` → 跳过。这是**本地回显**，保利威不会把自己发的消息广播回自己，
  只认服务端下发的那一条。

## 6. 状态机与幂等

`polyvProvider` 内部有 `idle → connecting → live → closing → error` 状态机：

- **重复初始化**：`connecting` 中再次 `connect()` 直接返回；`live` 时直接返回。
- **失败**：进 `error`，先彻底 `teardown()` 再上抛，由 `main.js` catch 后写进页面状态 + toast，**不静默失败**。
- **断开**：先官方 `disconnect()`，再 `destroyWatchCore()`，最后统一执行 `unbinders` 解绑所有监听，并清空 `seenIds`。
- **暂停/继续**：保持 socket，只是不再把消息交给上层，不重连、不重复注册监听。

`src/main.js` 的 `connectCurrent()` 对异步 `connect()` 做了 `await + try/catch` 与并发 Promise 复用，
连接失败会在页面状态区显示具体原因。

## 7. 怎么亲自验证（推荐用手机发）

保利威**不会把自己发的消息回播给自己**，所以验证必须「一端发、另一端收」。
用手机发是最省事的方式——手机和网页天然是两个独立观众。

1. 启动本地服务（必须走 HTTP，ES Module 会被 `file://` 的 CORS 拦住）：

   ```bash
   cd livelens-demo
   python -m http.server 4173
   ```

2. 浏览器打开 <http://127.0.0.1:4173>，右上角数据源选 **「保利威聊天室 8620440」**，点 **开始分析**。
   状态应显示 `正在连接保利威频道 8620440` → `已连接`。

3. **手机浏览器打开 <https://live.polyv.cn/watch/8620440>**，进入聊天室，发一条消息，例如：

   ```
   这件针织衫洗完会不会起球啊，客服一直不回我
   ```

4. 回到 LiveLens 页面：这条消息会出现在弹幕流里，并带 **「保利威」来源标记**，
   同时右侧产出洞察（实测：意图=反馈投诉、分类=面料质感、严重度=0.85、触发 1 条低频告警）。

> 想不依赖手机也可以：在电脑上**另开一个浏览器窗口**打开同一个观看页发言，效果相同。
> 左侧「手动注入」是本地测试能力，标记来源为 `mock`，**不会冒充 SDK 收到的消息**。

## 8. 已验证 / 未覆盖

已实测通过（真实 SDK + 真实网络 + 真实服务器广播）：

- `connect()` 成功，状态流转含 `connecting` 中间态
- 另一个独立观众用官方 `chat.sendSpeakMsg()` 发出的消息，被本项目 provider 收到
- 映射后 `source=polyv`、`roomId=8620440`、毫秒时间戳正确
- 消息触发真实洞察（分类 + 严重度 + 低频告警）
- 断开后监听全部解绑、`watchCore` 释放；重连后同一条消息不会被处理两次
- 模拟数据源保持可用，可随时切回

未覆盖（按需求刻意不做）：视频播放器接入、开播、历史消息回放、聊天重放消息（已显式丢弃）。

## 9. 连接失败排查（「[watch-core][setup] 请求服务接口数据失败」）

setup 阶段 SDK 会向 `https://watch-api.polyv.cn/v3/common/channel/detail` 与
`/v3/common/channel/viewer` 拉取频道与观众信息。这两个接口实测：

- 服务本身可用（`code: 200`，频道 8620440 数据正常）；
- CORS 完全开放（`Access-Control-Allow-Origin: *`），任何来源站点都能调。

因此该报错基本只可能是**当时的网络环境**问题（公司代理 / VPN / 广告拦截插件拦截了
`*.polyv.cn`，或保利威侧瞬时抖动）。provider 已做两层处理：

1. **自动重试**：网络类失败会在 1.5s 后自动重连一次（确定性错误如「观看条件未满足」不重试）。
2. **透传真实原因**：SDK 内部会先派发 `ChannelSetupFail` 事件（含 `failReason` /
   `failMessage`），provider 会把它翻译成可行动提示，例如：
   - `NetworkError` → 提示检查网络 / 代理 / 插件；
   - `NotAllowDomain`（130129）→ 提示在保利威后台「域名设置」加入当前站点域名；
   - `NotAllowAccess`（403）→ 提示频道未开播或已关闭。

若重试后仍失败，按页面上显示的 `——` 后半段提示定位即可，同时浏览器控制台会输出
`[LiveLens] 保利威 setup 失败原因 { reason, message }` 供进一步排查。
