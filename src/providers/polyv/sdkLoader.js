/**
 * sdkLoader.js
 * ------------------------------------------------------------
 * 加载保利威官方 Web 观看页 SDK（npm 包 @polyv/live-watch-sdk）。
 *
 * 为什么这样加载：
 *   本项目是原生 ES Module、无构建工具，不能 `npm install` 后再 import 裸包名
 *   （浏览器不认识裸模块说明符）。官方产物里同时提供 ESM 与 UMD 两份构建，
 *   且**自包含、没有任何裸依赖**，所以直接用浏览器原生的动态 import() 去加载
 *   CDN 上的官方 ESM 产物即可，零构建步骤、零全局变量污染。
 *
 * 版本策略：
 *   版本写死在 config.js 的 polyv.sdkUrl 中（当前 2.20.0，官方 latest 标签同版本），
 *   不使用 latest / ^x 这类会漂移的占位写法，避免线上行为随 SDK 升级而突变。
 */
import { CONFIG } from '../../config.js?v=20261023f';

/** 同一个 SDK 只需加载一次；用 Promise 兜住并发调用，避免重复注入 */
let pending = null;

/**
 * @returns {Promise<object>} SDK 命名空间对象（含 createWatchCore / destroyWatchCore / ChatEvents 等）
 */
export function loadPolyvSdk() {
  if (pending) return pending;

  const url = CONFIG.polyv.sdkUrl;
  if (!url) {
    return Promise.reject(new Error('未配置 polyv.sdkUrl，无法加载保利威 SDK'));
  }

  pending = import(url)
    .then((mod) => {
      if (!mod || typeof mod.createWatchCore !== 'function') {
        throw new Error('保利威 SDK 已加载，但未导出 createWatchCore，请检查 SDK 版本是否正确');
      }
      return mod;
    })
    .catch((err) => {
      // 加载失败时清空缓存，允许用户重试，而不是永久卡在失败态
      pending = null;
      throw new Error(`保利威 SDK 加载失败（${url}）：${err.message}`);
    });

  return pending;
}

/** 仅供测试 / 调试：清空加载缓存 */
export function resetPolyvSdkCache() {
  pending = null;
}
