// 分片遍历之间的让出原语。
//
// 原先住在 `runtime.js` 里。挪出来的原因：它只服务「分片遍历」这一件事
// （backfill 的帧解压与折叠、chunked materialize 的分帧），而 `runtime.js`
// 是 dsh 兼容垫片。混在一起会让兼容垫片的职责变得不清楚。
//
// 语义：`chunkYieldMs > 0` 用 setTimeout（更慢但更松弛，适合与前台交互抢
// 事件循环的场景），否则 setImmediate（最快让出）。

/**
 * @param config - 读 `chunkYieldMs`
 * @returns 一个返回 Promise 的让出函数
 */
export const makeYieldLoop = (config) => () => config.chunkYieldMs > 0
  ? new Promise((resolve) => setTimeout(resolve, config.chunkYieldMs))
  : new Promise((resolve) => setImmediate(resolve))
