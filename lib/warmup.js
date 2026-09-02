// 分片投影预热（问题 B）
//
// 会话进入且事件数超阈值时，抢在首次同步冷折叠前分片重放 cells——每片间
// 让出事件循环，折叠完成后直写 registration.cells（WeakMap），此后
// snapshot()/drive() 全部命中热 cell。可用时从投影缓存行取基线跳过已折叠
// 前缀。fork 子会话预热后回填投影缓存行（否则重开走 readFrom(0) 全量读）。

import { performance } from 'node:perf_hooks'

export function createWarmup(pc) {
  const { ctx, config, stats, log, logErr, sessionEventsOf, sessionLogOffset, safeGet, yieldLoop, recordWarm } = pc

  // alpha.5 起 identity 含 isSeeded/inheritedEventCount（identityMatches 四字段
  // 全等），直接传 header 不再匹配——按 identityOf 语义构造。
  const cacheIdentityOf = (header, inheritedEventCount) => ({
    createdAt: header?.createdAt,
    ...(header?.cwd !== void 0 ? { cwd: header.cwd } : {}),
    isSeeded: header?.isSeeded ?? false,
    inheritedEventCount: sessionLogOffset(inheritedEventCount ?? 0),
  })

  const loadCheckpointRows = (session) => {
    try {
      const cache = safeGet(ctx, 'sessionProjectionCache')
      if (!cache || typeof cache.recordFor !== 'function') return {}
      const record = cache.recordFor(session.id, cacheIdentityOf(session.header, session.inheritedEventCount))
      return record?.rows ?? {}
    } catch { /* 基线不可用：从 init 全量折叠 */ }
    return {}
  }

  const backfillForkCacheRow = async (sessionId, eventCount) => {
    // fork 子会话预热完成后回填投影缓存行：否则被放弃时永远没有缓存行，
    // 下次打开历史 coldSnapshot 走 readFrom(0) 全量读（分钟级阻塞）。
    try {
      const cache = safeGet(ctx, 'sessionProjectionCache')
      const session = ctx.sessions?.get(sessionId)
      if (cache && typeof cache.write === 'function' && session) await cache.write(session)
      log(`backfilled cache rows for fork child ${sessionId} (${eventCount} events)`)
    } catch (error) {
      logErr(`fork cache backfill failed for ${sessionId}: ${String(error?.message ?? error)}`)
    }
  }

  // 单个投影 unit 的分片折叠。返回 {status, baseSeq}：'folded'=已写热 cell；
  // 'skip'=cell 已热/registration 漂移/被并发 drive 抢建（写 cell 的机会让给
  // 并发方）；'abort'=会话消失或 guard 触发，终止全部预热。usable 基线的
  // seq 无论是否写 cell 都随结果带回（recordWarm 展示用）。
  async function foldUnit(registry, session, key, registration, events, checkpointRows) {
    const sessionId = session.id
    if (registration.cells.get(session) !== void 0) return { status: 'skip', baseSeq: -1 }
    const def = registration.def
    const row = checkpointRows[key]
    const usable = row !== void 0 && row.ver === def.stateVersion
    const unitBaseSeq = usable ? row.seq : -1
    let state = usable ? row.val : def.init()

    let i = 0
    if (usable) {
      while (i < events.length && events[i].seq <= row.seq) i++
    }
    let guard = 0
    while (i < events.length) {
      if (ctx.sessions?.get(sessionId) !== session) { stats.aborted += 1; return { status: 'abort', baseSeq: unitBaseSeq } }
      if (registry.registrations.get(key) !== registration) return { status: 'skip', baseSeq: unitBaseSeq }
      // 并发 drive/snapshot 已建热 cell：立即让位，不再白折剩余分片
      if (registration.cells.get(session) !== void 0) return { status: 'skip', baseSeq: unitBaseSeq }
      const end = Math.min(i + config.chunkSize, events.length)
      for (; i < end; i++) state = def.apply(state, events[i])
      if (i < events.length) await yieldLoop()
      if (++guard > 100000) { logErr(`guard tripped for ${sessionId}/${key}`); return { status: 'abort', baseSeq: unitBaseSeq } }
    }

    if (ctx.sessions?.get(sessionId) !== session) { stats.aborted += 1; return { status: 'abort', baseSeq: unitBaseSeq } }
    const liveReg = registry.registrations.get(key)
    if (liveReg !== registration || liveReg.cells.get(session) !== void 0) return { status: 'skip', baseSeq: unitBaseSeq }
    const observedSeq = events.at(-1)?.seq ?? -1
    liveReg.cells.set(session, { state, observedSeq })
    return { status: 'folded', baseSeq: unitBaseSeq }
  }

  async function warmSession(session) {
    const registry = safeGet(ctx, 'sessionProjections')
    if (!registry || typeof registry.snapshot !== 'function') return
    if (typeof registry.cellFor !== 'function' || typeof registry.buildCell !== 'function') {
      logErr('registry internals not found (dsh internals changed?); warmup skipped')
      return
    }
    const events = sessionEventsOf(session)
    if (events === void 0 || events.length < config.minEvents) { stats.skipped += 1; return }

    const t0 = performance.now()
    const registrations = registry.registrations
    if (!registrations || registrations.size === 0) return

    const checkpointRows = loadCheckpointRows(session)
    const sessionId = session.id
    let foldedUnits = 0
    let baseSeq = -1

    for (const [key, registration] of [...registrations.entries()]) {
      const outcome = await foldUnit(registry, session, key, registration, events, checkpointRows)
      if (outcome.status === 'abort') return
      baseSeq = Math.max(baseSeq, outcome.baseSeq)
      if (outcome.status === 'folded') foldedUnits += 1
    }

    if (foldedUnits > 0) {
      stats.warmed += 1
      recordWarm({ t: Date.now(), id: sessionId, events: events.length, units: foldedUnits, baseSeq, ms: performance.now() - t0 })
      if (session.header?.parentSession !== void 0) await backfillForkCacheRow(sessionId, events.length)
    }
  }

  return { warmSession }
}
