/**
 * provider.js
 * ------------------------------------------------------------
 * 弹幕源统一接口（抽象基类）。
 *
 * 所有数据源（本地模拟源 / 保利威 / 未来其它平台）都必须实现这四个方法，
 * 上层 UI 与算法只依赖这个接口，切换真实弹幕时无需改动任何分析代码。
 *
 *   connect()          建立连接
 *   disconnect()       断开连接
 *   pause()/resume()   暂停/恢复推送（不改变连接状态）
 *   send()             可选：向直播间发送弹幕（主播侧发言）
 */
export class DanmakuProvider {
  constructor({ roomId, onMessage, onStatus } = {}) {
    this.roomId = roomId;
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.connected = false;
    this.paused = false;
  }

  /** 子类实现：真正建立连接 */
  connect() {
    throw new Error('[DanmakuProvider] connect() 未实现');
  }

  /** 子类实现：断开连接并清理定时器 / socket */
  disconnect() {
    this.connected = false;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  send() {
    throw new Error('[DanmakuProvider] 该数据源不支持发送消息');
  }

  /** 子类调用：向外推送一条原始消息（不必归一化，store 会处理） */
  emit(raw) {
    if (!this.connected || this.paused) return;
    this.onMessage(raw);
  }
}
