// 事件缓存按**字节**限容（问题 D 的主项）
//
// ## 实测问题（见 docs/MEMORY-ANALYSIS.md）
//
// dsh 有三处按「会话条数」限容的事件缓存，没有一处按字节：
//   - `SessionObservationReader.cache`：5 条（preparedSessionCacheSize）
//   - `JsonlSessionPersistence.coldLogMemo`：2 条（COLD_LOG_MEMO_MAX_ENTRIES）
//   - `Session.log` + `eventsSnapshot`：每个 live 会话一份，无上限
//
// 一份 24 万事件树在堆里是 87.7 MB。实测连开 6 个 18 MB 会话 → RSS 从 388 MB
// 涨到 1209 MB（+821 MB），12 个后稳定在 1324 MB（936 MB 常驻缓存）。
// 真实环境里 52 MB 的会话单份就 250 MB+，而 dsh 允许 7 份并存。
//
// ## 本模块做什么
//
// 给前两处缓存加一个**字节预算**：超过预算时从最旧的、未被 pin 的条目开始淘汰，
// 直到回到预算内。条数上限保持原样（两者取先触发者）。
//
// 字节估算不追求精确：用 `events.length × 单事件平均字节`（实测 87.7 MB /
// 240031 事件 ≈ 365 B/事件）。目的是区分「5 个大会话」与「5 个小会话」，
// 不需要真去量堆。
//
// ## 为什么这样安全
//
// - 只删**未被 pin**（`refs === 0`）的条目，与上游 `evictPastCapacity` 同一判据；
// - 缓存 miss 的后果只是下次重新解码 + 折叠（冷读路径），不丢数据、不改语义；
// - 每次 `read` 之后检查一次（延迟到 lease 释放时才真正淘汰），不引入定时器。

import { performance } from 'node:perf_hooks'

// 单事件在 V8 堆里的平均占用（实测：240031 事件 / 87.7 MB = 365 B）。
// 取 400 留一点余量，宁可早淘汰也不要超预算。
const BYTES_PER_EVENT = 400

export function installMemoryBudget(pc, ictx) {
  const { ctx, config, stats, log, logErr, safeGet, disposers, setPatchStatus } = pc
  const actx = ictx ?? ctx
  if (!config.memoryBudgetBytes || config.memoryBudgetBytes <= 0) {
    setPatchStatus('memoryBudget', 'off')
    return
  }

  // ---- 目标 1：session-query 的 prepared 事件缓存 ----
  // 通过 `sessionQuery._observations` 访问（SessionQueryEngine 的私有字段，
  // 但它是稳定形状：`_observations = new SessionObservationReader(ctx, capacity)`）。
  const query = safeGet(actx, 'sessionQuery')
  const reader = query?._observations
  if (reader === void 0 || !(reader.cache instanceof Map)) {
    setPatchStatus('memoryBudget', 'inactive')
    return
  }

  const budget = config.memoryBudgetBytes
  const estimateEntryBytes = (entry) => (entry?.events?.length ?? 0) * BYTES_PER_EVENT

  let lastCheckMs = 0

  // 按「最旧且未被 pin」的顺序淘汰，直到总估算字节回到预算内。
  // 与上游 evictPastCapacity 的区别：先算总量、再看是否需要淘汰、最后按字节裁。
  const enforceBudget = () => {
    const t0 = performance.now()
    if (reader.cache.size === 0) return
    let total = 0
    for (const entry of reader.cache.values()) total += estimateEntryBytes(entry)
    if (total <= budget) { lastCheckMs = performance.now() - t0; return }

    // Map 的插入序即访问序（上游 store 用 delete+set 提升 MRU），从最旧开始删。
    for (const [id, candidate] of [...reader.cache]) {
      if (total <= budget) break
      if (candidate?.refs > 0) continue // 被 lease 钉住，跳过
      const freed = estimateEntryBytes(candidate)
      reader.cache.delete(id)
      total -= freed
      stats.memoryBudgetTrimmed += 1
      stats.memoryBudgetFreedBytes += freed
    }
    lastCheckMs = performance.now() - t0
    if (total > budget) {
      // 全部被 pin 时允许暂时超预算（与上游同样的策略），下次 lease 释放再试。
      stats.memoryBudgetOverBudget += 1
    }
  }

  // 包装 store()：每次插入后检查（上游 store 自身会按条数淘汰，我们补字节维度）。
  const originalStore = reader.store
  if (typeof originalStore === 'function') {
    const patchedStore = function (sessionId, entry) {
      const result = originalStore.call(this, sessionId, entry)
      try { enforceBudget() } catch (error) {
        logErr(`memory budget check failed: ${String(error?.message ?? error)}`)
      }
      return result
    }
    reader.store = patchedStore
    disposers.push(() => { if (reader.store === patchedStore) reader.store = originalStore })
  }

  // ---- 目标 2：jsonl 持久化的 coldLogMemo ----
  // 它缓存 `freezeStoredEvents(events)` 的完整结果。上游按 2 条淘汰，
  // 两条各 400MB 就是 800MB。这里把它的上限压到「预算内最多几条」。
  const persistence = safeGet(actx, 'sessionPersistence')
  const memo = persistence?.coldLogMemo
  if (memo instanceof Map) {
    // 包装 memoizeStoredLog 的调用结果：它由 decodeStoredLog 内部调用，无法直接包，
    // 所以改为在每次 decode 完成后（store 被调时的同一时机）清理。
    // 由于 decodeStoredLog 是原型方法，这里包装它。
    const proto = Object.getPrototypeOf(persistence)
    const originalDecode = proto?.decodeStoredLog
    if (typeof originalDecode === 'function') {
      const patchedDecode = async function (...args) {
        const result = await originalDecode.apply(this, args)
        try {
          const memoMap = this.coldLogMemo
          if (memoMap instanceof Map && memoMap.size > 0) {
            let total = 0
            for (const v of memoMap.values()) total += (v?.events?.length ?? 0) * BYTES_PER_EVENT
            // coldLogMemo 只给「紧接着的 read」用，保留 1 条即可。
            for (const [id, v] of [...memoMap]) {
              if (total <= budget) break
              const freed = (v?.events?.length ?? 0) * BYTES_PER_EVENT
              memoMap.delete(id)
              total -= freed
              stats.memoryBudgetTrimmed += 1
              stats.memoryBudgetFreedBytes += freed
            }
          }
        } catch (error) {
          logErr(`memory budget memo trim failed: ${String(error?.message ?? error)}`)
        }
        return result
      }
      proto.decodeStoredLog = patchedDecode
      disposers.push(() => { if (proto.decodeStoredLog === patchedDecode) proto.decodeStoredLog = originalDecode })
    }
  }

  setPatchStatus('memoryBudget', 'active')
  log(`memory budget installed (${(budget / 1048576).toFixed(0)} MB, ~${BYTES_PER_EVENT} B/event)`)

  // 供 stats / API 读取
  pc.memoryBudgetStats = () => ({
    budgetBytes: budget,
    evictedEntries: stats.memoryBudgetTrimmed,
    evictedBytes: stats.memoryBudgetFreedBytes,
    lastCheckMs: +lastCheckMs.toFixed(2),
    cachedEntries: reader.cache.size,
    estimatedBytes: [...reader.cache.values()].reduce((a, e) => a + estimateEntryBytes(e), 0),
  })
}

export { BYTES_PER_EVENT }
