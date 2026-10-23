/**
 * mockProvider.js
 * ------------------------------------------------------------
 * 本地模拟弹幕源：按随机间隔生成演示弹幕。
 * 用途：在没有真实直播 SDK 的情况下跑通整套 UI 与分析链路。
 */
import { DanmakuProvider } from './provider.js?v=20261023f';
import { SOURCE } from '../core/constants.js?v=20261023f';
import { CONFIG } from '../config.js?v=20261023f';
import { CORPUS_NORMAL, CORPUS_NOISE, CORPUS_RARE, MOCK_USERS } from '../data/mockDanmaku.js?v=20261023f';

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInterval() {
  const { minIntervalMs, maxIntervalMs } = CONFIG.mock;
  return minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs);
}

export class MockProvider extends DanmakuProvider {
  constructor(options) {
    super(options);
    this.timer = null;
    this.lastText = null;
    this.seq = 0;
  }

  connect() {
    // 暂停后仍处于 connected 状态，此时再次 connect 应等价于 resume，
    // 否则会因为提前 return 而不再重新排程定时器（表现为「点了继续却没数据」）。
    if (this.connected) {
      if (this.paused) this.resume();
      return;
    }
    this.connected = true;
    this.onStatus({ status: 'live', source: SOURCE.MOCK });
    this.schedule();
  }

  disconnect() {
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onStatus({ status: 'idle' });
  }

  pause() {
    super.pause();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onStatus({ status: 'paused' });
  }

  resume() {
    super.resume();
    if (this.connected && !this.timer) {
      this.onStatus({ status: 'live' });
      this.schedule();
    }
  }

  schedule() {
    if (!this.connected || this.paused) return;
    this.timer = setTimeout(() => {
      this.tick();
      this.schedule();
    }, randomInterval());
  }

  tick() {
    const { repeatChance, noiseChance, rareChance } = CONFIG.mock;
    const roll = Math.random();

    let text;
    if (this.lastText && roll < repeatChance) {
      text = this.lastText;                       // 复述 → 触发「短时间重复」过滤
    } else if (roll < repeatChance + noiseChance) {
      text = pick(CORPUS_NOISE);                  // 噪声
    } else if (roll < repeatChance + noiseChance + rareChance) {
      text = pick(CORPUS_RARE);                   // 低频严重问题
    } else {
      text = pick(CORPUS_NORMAL);                 // 常规提问
    }

    this.seq += 1;
    const raw = {
      id: `mock_${Date.now()}_${this.seq}`,
      userId: pick(MOCK_USERS),
      nick: '',
      text,
      ts: Date.now(),
      roomId: this.roomId,
      meta: { product: '', simulated: true },
    };
    this.lastText = text;
    this.emit(raw);
  }

  /** 手动注入一条弹幕（调试用，不受 pause 影响） */
  inject(text) {
    if (!text) return;
    this.seq += 1;
    this.onMessage({
      id: `inject_${Date.now()}_${this.seq}`,
      userId: 'u_manual',
      nick: '手动注入',
      text,
      ts: Date.now(),
      roomId: this.roomId,
      meta: { manual: true },
    });
  }
}
