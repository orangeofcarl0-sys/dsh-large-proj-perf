// 事件缓存按**字节**限容（问题 D 的主项）
//
// ## 实测问题（见 docs/MEASUREMENTS.md §2）
//
// dsh 有三处按「会话条数」限容的事件缓存，没有一处按字节：
//   - `SessionObservationReader.cache`：5 条（preparedSessionCacheSize）
//   - `JsonlSessionPersistence.coldLogMemo`：2 条（COLD_LOG_MEMO_MAX_ENTRIES）
//   - `Session.log` + `eventsSnapshot`：每个 live 会话一份，无上限
//
// 一份 91k 事件 / 4 KB 消息的会话在堆里约 115 MB；5 份就是约 575 MB。
// 上游只看条数，5 个大会话与 5 个小会话一视同仁。
//
// ## 本模块做什么
//
// 给前两处缓存加一个**字节预算**：超过预算时从最旧的、未被 pin 的条目开始淘汰，
// 直到回到预算内。条数上限保持原样（两者取先触发者）。
//
// 字节估算由 `lib/event-bytes.js` 做内容采样：小消息会话仍按 400 B/事件的下限，
// 4 KB 消息会话按 JSON 采样放大。只按 `events.length × 400` 会把后者低估 3.4 倍，
// 512 MiB 预算对 5 个大会话永远不会触发。
//
// ## 为什么这样安全
//
// - 只删**未被 pin**（`refs === 0`）的条目，与上游 `evictPastCapacity` 同一判据；
// - **保护刚插入的条目**：单条就超预算时保留它并计 overBudget，避免 store 后
//   立刻淘汰、每次打开都重新解码的抖动；
// - 缓存 miss 的后果只是下次重新解码 + 折叠（冷读路径），不丢数据、不改语义；
// - 在 store 和 lease 释放两处检查（包装上游 `evictPastCapacity`），被 lease
//   拖住的超预算状态不会拖到下一次 store。

import { BYTES_PER_EVENT } from './constants.js'
import { estimateEntryBytes } from './event-bytes.js'
import { wrapMethod } from './patch-target.js'

export function installMemoryBudget(deps) {
  const { ctx, config, stats, log, logErr, safeGet, disposers, setPatchStatus } = deps
  if (!config.memoryBudgetBytes || config.memoryBudgetBytes <= 0) {
    setPatchStatus('memoryBudget', 'off')
    return
  }

  // ---- 目标 1：session-query 的 prepared 事件缓存 ----
  // 通过 `sessionQuery._observations` 访问（SessionQueryEngine 的私有字段，
  // 但它是稳定形状：`_observations = new SessionObservationReader(ctx, capacity)`）。
  const query = safeGet(ctx, 'sessionQuery')
  const reader = query?._observations
  if (reader === void 0 || !(reader.cache instanceof Map)) {
    setPatchStatus('memoryBudget', 'inactive')
    return
  }

  const budget = config.memoryBudgetBytes
  let memoMap = null

  // 唯一快照入口：observation cache + coldLogMemo 都汇总到 stats.memoryBudget。
  // 关闭/不适用时 stats.memoryBudget 保持 null（载荷形状见 stats.js）。
  const refreshStats = () => {
    let entries = 0
    let events = 0
    let bytes = 0
    for (const entry of reader.cache.values()) {
      entries += 1
      events += entry?.events?.length ?? 0
      bytes += estimateEntryBytes(entry)
    }
    stats.memoryBudget.cachedEntries = entries
    stats.memoryBudget.cachedEvents = events
    stats.memoryBudget.estimatedBytes = bytes

    if (memoMap instanceof Map) {
      stats.memoryBudget.memoEntries = memoMap.size
      let memoBytes = 0
      for (const value of memoMap.values()) memoBytes += estimateEntryBytes(value)
      stats.memoryBudget.memoBytes = memoBytes
    } else {
      stats.memoryBudget.memoEntries = 0
      stats.memoryBudget.memoBytes = 0
    }
  }

  stats.memoryBudget = {
    budgetBytes: budget,
    cachedEntries: 0, cachedEvents: 0, estimatedBytes: 0,
    memoEntries: 0, memoBytes: 0,
  }

  // 按「最旧且未被 pin」的顺序淘汰，直到总估算字节回到预算内。
  // `keepId` 是刚 store 的条目：上游 evictPastCapacity 从不淘汰 keep，
  // 这里保持同一语义，单条超预算时宁可暂时超预算也不抖动。
  const enforceBudget = (keepId) => {
    if (reader.cache.size === 0) return
    let total = 0
    for (const entry of reader.cache.values()) total += estimateEntryBytes(entry)
    if (total <= budget) return

    for (const [id, candidate] of [...reader.cache]) {
      if (total <= budget) break
      if (id === keepId) continue
      if (candidate?.refs > 0) continue // 被 lease 钉住，跳过
      const freed = estimateEntryBytes(candidate)
      reader.cache.delete(id)
      total -= freed
      stats.memoryBudgetTrimmed += 1
      stats.memoryBudgetFreedBytes += freed
    }
    if (total > budget) {
      // 全部被 pin（或只剩刚插入的条目）时允许暂时超预算，lease 释放后再试。
      stats.memoryBudgetOverBudget += 1
    }
  }

  // 包装 store()：钉住刚插入的条目做预算检查。
  // 上游 store 内部会调用 evictPastCapacity（已被下面的包装接管）；用 evictRan
  // 标记避免同一次 store 重复检查、重复累加 overBudget。
  let evictRan = false
  const originalStore = reader.store
  if (typeof originalStore === 'function') {
    const patchedStore = function (sessionId, entry) {
      evictRan = false
      const result = originalStore.call(this, sessionId, entry)
      if (!evictRan) {
        try { enforceBudget(sessionId) } catch (error) {
          logErr(`memory budget check failed: ${String(error?.message ?? error)}`)
        }
      }
      try { refreshStats() } catch { /* 观测失败不影响主流程 */ }
      return result
    }
    reader.store = patchedStore
    disposers.push(() => { if (reader.store === patchedStore) reader.store = originalStore })
  }

  // 包装 evictPastCapacity()：上游在 store 与 lease 释放两处调用它。
  // 释放路径没有 keep，此时所有 refs===0 的条目都可被字节预算裁掉；
  // 这条路径修掉了旧实现的“被 pin 拖到下一次 store 才复查”。
  const originalEvict = reader.evictPastCapacity
  if (typeof originalEvict === 'function') {
    const hadOwn = Object.hasOwn(reader, 'evictPastCapacity')
    const patchedEvict = function (keep) {
      evictRan = true
      const result = originalEvict.call(this, keep)
      const keepId = keep?.session?.header?.id
        ?? (keep === void 0 ? void 0 : [...this.cache].find(([, value]) => value === keep)?.[0])
      try { enforceBudget(keepId) } catch (error) {
        logErr(`memory budget release check failed: ${String(error?.message ?? error)}`)
      }
      try { refreshStats() } catch { /* 观测失败不影响主流程 */ }
      return result
    }
    reader.evictPastCapacity = patchedEvict
    disposers.push(() => {
      if (reader.evictPastCapacity !== patchedEvict) return
      if (hadOwn) reader.evictPastCapacity = originalEvict
      else delete reader.evictPastCapacity
    })
  }

  // ---- 目标 2：jsonl 持久化的 coldLogMemo ----
  // 它缓存 `freezeStoredEvents(events)` 的完整结果。上游按 2 条淘汰，
  // 两条各 300MB 就是 600MB。这里把它的上限压到「预算内最多几条」。
  // 挂在 `decodeStoredLog`（原型方法）上——`memoizeStoredLog` 由它内部调用，
  // 无法直接包。
  const persistence = safeGet(ctx, 'sessionPersistence')
  const memo = persistence?.coldLogMemo
  if (memo instanceof Map) memoMap = memo
  if (memo instanceof Map) {
    const proto = Object.getPrototypeOf(persistence)
    if (proto !== null && typeof proto.decodeStoredLog === 'function') {
      wrapMethod(proto, 'decodeStoredLog', (originalDecode) => async function (...args) {
        const result = await originalDecode.apply(this, args)
        try {
          const cache = this.coldLogMemo
          if (cache instanceof Map && cache.size > 0) {
            memoMap = cache
            let total = 0
            for (const value of cache.values()) total += estimateEntryBytes(value)
            // 至少保留最新一条（Map 插入序最后一条；上游 memoizeStoredLog 用
            // delete+set 提升 MRU）。删空会让紧接着的 read 立刻重新解码。
            const entries = [...cache]
            for (let i = 0; i < entries.length - 1 && total > budget; i++) {
              const [id, value] = entries[i]
              const freed = estimateEntryBytes(value)
              cache.delete(id)
              total -= freed
              stats.memoryBudgetTrimmed += 1
              stats.memoryBudgetFreedBytes += freed
            }
            if (total > budget) stats.memoryBudgetOverBudget += 1
          }
          refreshStats()
        } catch (error) {
          logErr(`memory budget memo trim failed: ${String(error?.message ?? error)}`)
        }
        return result
      }, disposers)
    }
  }

  setPatchStatus('memoryBudget', 'active')
  log(`memory budget installed (${(budget / 1048576).toFixed(0)} MB, content-aware, floor ${BYTES_PER_EVENT} B/event)`)

  refreshStats()
}
