// 分片投影预热（问题 B）
//
// 会话进入且事件数超阈值时，抢在首次同步冷折叠前分片重放 cells——每片间
// 让出事件循环，折叠完成后直写 registration.cells（WeakMap），此后
// snapshot()/drive() 全部命中热 cell。可用时从投影缓存行取基线跳过已折叠
// 前缀。fork 子会话预热后回填投影缓存行（否则重开走 readFrom(0) 全量读）。

import { performance } from 'node:perf_hooks'

export function createWarmup(pc) {
  const { ctx, config, stats, log, logErr, sessionEventsOf, sessionLogOffset, safeGet, yieldLoop, recordWarm } = pc

  // 按 cache 的 identityOf 语义构造匹配键：
  //   - alpha.5 起含 isSeeded/inheritedEventCount；
  //   - 0.1.3 起 identityMatches 额外要求 formatVersion === header.version
  //     （缺该字段的行只能当 title 前驱提示，不能作折叠短路/基线）。
  // 0.1.2 及更早逐字段比较，多带 formatVersion 无副作用。
  const cacheIdentityOf = (header, inheritedEventCount) => ({
    formatVersion: header?.version,
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
    // cell 已存在时不再一律视为「别人先折完了」：0.2.2 里上游会在
    // session/created 的同步广播中调 snapshot() → cellFor() → buildCell()
    // 一次性全量折叠，这种 cell 的 observedSeq 已经到会话末尾。只有「存在但
    // 未追上末尾」的 cell 才值得接管继续折。
    if (registration.cells.get(session) !== void 0) return { status: 'hot', baseSeq: -1 }
    const def = registration.def
    const row = checkpointRows[key]
    const usable = row !== void 0 && row.ver === def.stateVersion
    const unitBaseSeq = usable ? row.seq : -1
    // init 的上游签名是 init(header, inheritedEventCount)：多个真实投影
    // （agentPreset / workingDirectory / agentTeam）从 header 取值，无参调用
    // 会直接抛 TypeError。缓存行可用时按上游 restore() 语义直接用 row.val。
    let state = usable ? row.val : def.init(session.header, session.inheritedEventCount)

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
    // cell 必须与上游 buildCell 同形：drive()/advanceCell() 会读写 views[0]/[1]，
    // 缺该字段会在下一条事件到达时抛 TypeError（Cannot read properties of
    // undefined (reading '1')）。
    liveReg.cells.set(session, { state, observedSeq, views: [void 0, void 0] })
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
    let alreadyHot = 0
    let baseSeq = -1

    for (const [key, registration] of [...registrations.entries()]) {
      // 0.2.2 起 registrations 会保留已释放（refs === 0）的 key：它们不再被
      // drive / snapshot / restore 读取，预热它们纯属浪费。老版本没有 refs
      // 字段（undefined），按「活跃」处理。
      if (registration.refs === 0) continue
      const outcome = await foldUnit(registry, session, key, registration, events, checkpointRows)
      if (outcome.status === 'abort') return
      if (outcome.status === 'hot') { alreadyHot += 1; continue }
      baseSeq = Math.max(baseSeq, outcome.baseSeq)
      if (outcome.status === 'folded') foldedUnits += 1
    }

    // 「上游已在本进程内建满 cell」是 0.2.2 的常态：session/created 是同步广播，
    // dsh-api-session-controller 的监听器注册更早，会在里面调 snapshot() →
    // cellFor() → buildCell()，一次性把全部投影折完。此时预热没有可做的事，
    // 但也说明该会话的投影已经是热的——这个事实必须计数，否则 stats 会显示
    // 「warmed=0 且 skipped=0」，让人误以为预热从未被调用。
    if (foldedUnits === 0 && alreadyHot > 0) {
      stats.alreadyHot += 1
      recordWarm({ t: Date.now(), id: sessionId, events: events.length, units: 0, hotUnits: alreadyHot, baseSeq, ms: performance.now() - t0 })
      return
    }

    if (foldedUnits > 0) {
      stats.warmed += 1
      recordWarm({ t: Date.now(), id: sessionId, events: events.length, units: foldedUnits, baseSeq, ms: performance.now() - t0 })
      // fork 子会话预热后回填缓存行，否则被放弃时永远没有缓存行。
      //
      // 识别方式：0.1.7–0.2.1 的原生 fork 在 header 写 parentSession；0.2.2 起
      // 原生 fork 不再写该字段，只剩 `isSeeded`。两者都覆盖：isSeeded 表示
      // 会话带继承前缀（fork / resume），这类会话正是"被放弃后重开要走
      // readFrom(0) 全量读"的高危对象。
      if (session.header?.parentSession !== void 0 || session.inheritedEventCount > 0) {
        await backfillForkCacheRow(sessionId, events.length)
      }
    }
  }

  return { warmSession }
}
