// 跨模块共享的具名常量。
//
// 这些数字原先散落在各处（`index.js` 的 15000、`api.js` 的 16384、
// `backfill.js` 的 100000、`memory-budget.js` 的 400），改一处容易漏另一处。
// 集中在这里，且每个都注明依据。

/** 启动后延迟多久触发冷会话补行扫描（`backfillOnBoot` 打开时）。
 *  用延迟而不是立刻跑，是为了不与启动期的服务装配抢事件循环。 */
export const BACKFILL_DELAY_MS = 15000

/** 插件自有 API 的请求体上限（字节）。`config.set` 只需要几十字节；
 *  16 KiB 足够容纳一次改十几个键，同时挡住误发的巨大 body。 */
export const API_BODY_LIMIT_BYTES = 16384

/** `perf.report` 专用的请求体上限（字节）。
 *  浏览器样本带时间线标记与 LoAF 脚本归属，单条可达 1–2 KiB；一批 8 条
 *  会超过通用上限，所以单独放宽到 64 KiB。仍然只接受回环 + 同源请求。 */
export const PERF_BODY_LIMIT_BYTES = 65536

/** 连续历史分页之间不超过这个间隔，就认为是同一次回合跳转。
 *  `loadThrough` 逐页回翻、全部攒完才发布一次，页与页之间通常几十到几百毫秒；
 *  用户在滚动时手动触发的翻页间隔通常在秒级。1500 ms 是两者的分界经验值。 */
export const JUMP_BURST_GAP_MS = 1500

/** 单事件在 V8 堆里的平均占用估算下限（字节）。
 *  旧实现直接用它做全量估算：24 万事件 / 87.7 MB ≈ 365 B/事件。
 *  现在它是内容感知估算的**下限**——小消息会话仍按 400 计，避免低估；
 *  大消息会话由 lib/event-bytes.js 按 JSON 采样放大。 */
export const BYTES_PER_EVENT = 400

/** 内容感知估算的采样上限：每种事件类型最多 128 个（小类型全量精确计费）。 */
export const EVENT_SAMPLE_COUNT = 128

/** 每个字符串值在 V8 堆里的对象头估算（字节，取 40 留余量）。
 *  JSON 字节只算内容与引号，不含每个字符串对象的 header；真实会话事件里
 *  字符串数量多（50–100/事件），这部分是 JSON×1.15 低估的主因。 */
export const STRING_OVERHEAD_BYTES = 40

/** JSON 字节 → V8 堆字节的基础放大系数。
 *  覆盖对象/数组槽位；字符串 header 另由 STRING_OVERHEAD_BYTES 计。 */
export const HEAP_OVERHEAD_RATIO = 1.15

/** 事件缓存按字节限容的默认预算（512 MiB）。
 *  约等于 5 份 24 万事件的小消息会话；4 KB 消息的 91k 会话约 4 份。
 *  0 表示关闭限容。 */
export const DEFAULT_MEMORY_BUDGET_BYTES = 536870912
