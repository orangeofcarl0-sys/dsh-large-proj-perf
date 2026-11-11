// 跨模块共享的具名常量。
//
// 这些数字原先散落在各处（`index.js` 的 15000、`api.js` 的 16384、
// `warmup.js`/`backfill.js` 的 100000、`memory-budget.js` 的 400），
// 改一处容易漏另一处。集中在这里，且每个都注明依据。

/** 启动后延迟多久触发冷会话补行扫描（`backfillOnBoot` 打开时）。
 *  用延迟而不是立刻跑，是为了不与启动期的服务装配抢事件循环。 */
export const BACKFILL_DELAY_MS = 15000

/** 插件自有 API 的请求体上限（字节）。`config.set` 只需要几十字节；
 *  16 KiB 足够容纳一次改十几个键，同时挡住误发的巨大 body。 */
export const API_BODY_LIMIT_BYTES = 16384

/** 折叠循环的失控保护上限（迭代次数）。
 *  `chunkSize` 的钳制已经保证每轮前进，这个 guard 是纯保险：
 *  一旦上游的 events 数组异常（例如长度谎报），避免死循环。 */
export const FOLD_GUARD_ITERATIONS = 100000

/** 单事件在 V8 堆里的平均占用估算（字节）。
 *  实测依据：24 万事件的会话在堆里占 87.7 MB，即 365 B/事件
 *  （见 docs/MEMORY-ANALYSIS.md）。取 400 留余量，宁可早淘汰不要超预算。 */
export const BYTES_PER_EVENT = 400

/** 事件缓存按字节限容的默认预算（512 MiB）。
 *  约等于 6 份 24 万事件的会话。0 表示关闭限容。 */
export const DEFAULT_MEMORY_BUDGET_BYTES = 536870912
