// 模块装配上下文：`deps`（构造时就绪、只读）与 `runtime`（晚绑定槽）。
//
// ## 为什么要把两者分开
//
// 原先所有模块共用一个 `pc` 对象，字段由 `index.js` 一次性塞进去。问题：
// 有些字段（`retrimPreparedCache`、`backfill`）是**别的模块在装配之后才写进
// `pc` 的**，而 `installApi` 走 `ctx.inject(['webServer'])` 懒装配、可能更早
// 执行 —— 解构时拿到的是 `undefined`，且之后再也不会更新。
//
// 后果（真实 bug，v1.10.0 修复）：
//   - `config.set` 改 `preparedCacheSize` 不触发重裁；
//   - 打开 `backfillOnBoot` 不补跑扫描。
//
// ## 契约
//
// - `deps`：**只读**。每个模块在装配时就能拿到全部字段，不存在"晚到"的情况。
// - `runtime`：**可变**。持有者注册能力，调用方在**使用时**取值（`getXxx()`），
//   而不是在装配时解构。只有确实需要晚绑定的调用方（目前只有 api.js）才拿它。

/**
 * 构造只读依赖包。所有字段在构造时就绪。
 *
 * @param options - 见下方 JSDoc 的字段说明
 * @returns 冻结的 deps 对象
 */
export function createDeps({
  ctx,
  config,
  stats,
  log,
  logErr,
  disposers,
  safeGet,
  sessionEventsOf,
  sessionLogOffset,
  cacheIdentityOf,
  yieldLoop,
  setConfigValue,
  setPatchStatus,
  recordFork,
}) {
  return Object.freeze({
    /** cordis 上下文（apply 的入参，或 ctx.inject 给的子上下文） */
    ctx,
    /** 运行期配置；数字项已做过下限钳制 */
    config,
    /** stats.get 暴露的计数与状态树 */
    stats,
    /** info 级日志（走 ctx.logger，可能被宿主日志级别过滤） */
    log,
    /** error 级日志 */
    logErr,
    /** 注册 dispose 回调（倒序执行） */
    disposers,
    /** 安全取服务：cordis 下 ctx.get 对缺失服务可能抛错 */
    safeGet,
    /** 取会话的事件数组（兼容 snapshotEvents() 与 events getter） */
    sessionEventsOf,
    /** SessionLogOffset 的运行时实现（含 brand） */
    sessionLogOffset,
    /** 缓存行 identity 的唯一构造器，见 cache-identity.js */
    cacheIdentityOf,
    /** 分片遍历的让出函数，见 yield.js */
    yieldLoop,
    /** 写一个配置键（含类型校验与下限钳制） */
    setConfigValue,
    /** 记一个补丁的生命周期状态 */
    setPatchStatus,
    /** 记一次 fork（计数 + 慢 fork 日志） */
    recordFork,
  })
}

/**
 * 构造晚绑定槽。
 *
 * 每个槽有 `set`（由提供方在装配后调用）与 `get`（由消费方在使用时调用）。
 * `get` 在 `set` 之前返回 `undefined` —— 消费方必须容忍这一点。
 *
 * @returns `{ backfill: { set, get } }`
 */
export function createRuntime() {
  let backfill = void 0

  return {
    /**
     * 冷会话补行任务的句柄。
     *
     * 消费方（api.js 的 `config.set`）必须在**每次调用时** `get()`，
     * 不能在装配时解构 —— 否则会重现 v1.9.0 及之前的晚绑定 bug。
     *
     * 句柄形状：`{ backfillColdSessions(): Promise, isFired(): boolean }`
     */
    backfill: {
      set(handlers) { backfill = handlers },
      get() { return backfill },
      clear() { backfill = void 0 },
    },
  }
}
