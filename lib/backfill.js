// 冷会话缓存补行（默认关）
//
// 磁盘缺投影缓存行的大会话流式补写（fold 官方 jsonl 日志 → cache rows）。
// readRaw 内部 zstd 全量解码同步、插件层不可分片——大文件仍会短暂冻结事件
// 循环，故默认关；开启后按 chunkSize 分片让出 + 会话间让出。

import { performance } from 'node:perf_hooks'
import { join } from 'node:path'

export function createBackfill(pc) {
  const { ctx, config, stats, log, logErr, sessionLogOffset, safeGet, yieldLoop } = pc

  let running = false
  let fired = false

  const markFired = () => { fired = true }
  const isFired = () => fired

  const resolveSessionsRoot = () => {
    try {
      const paths = safeGet(ctx, 'dshHomePaths')
      const direct = paths?.sessions?.()
      if (typeof direct === 'string' && direct !== '') return direct
      const home = paths?.dshHome?.()
      if (typeof home === 'string' && home !== '') return home + '/sessions'
    } catch { /* 落到环境变量回退 */ }
    const envHome = process.env.DSH_HOME
      ?? (typeof process.env.USERPROFILE === 'string' && process.env.USERPROFILE !== '' ? process.env.USERPROFILE : void 0)
    return envHome !== void 0 ? `${envHome}/.dsh/sessions` : ''
  }

  // alpha.5 identity：isSeeded/inheritedEventCount 参与匹配；冷日志 header 行
  // 按 toHeaderLine 语义携带 isSeeded/seedLength
  const coldIdentityOf = (meta) => ({
    createdAt: meta.createdAt,
    ...(meta.cwd !== void 0 ? { cwd: meta.cwd } : {}),
    isSeeded: meta.isSeeded ?? false,
    inheritedEventCount: sessionLogOffset(meta.seedLength ?? 0),
  })

  const scanCandidates = async (sessionsRoot, readdir, stat) => {
    const candidates = []
    let projectDirs = []
    try { projectDirs = await readdir(sessionsRoot, { withFileTypes: true }) } catch { return candidates }
    for (const proj of projectDirs) {
      if (!proj.isDirectory()) continue
      let sessionDirs = []
      try { sessionDirs = await readdir(join(sessionsRoot, proj.name), { withFileTypes: true }) } catch { continue }
      for (const sd of sessionDirs) {
        if (!sd.isDirectory() || !sd.name.startsWith('session-')) continue
        for (const fname of ['session.jsonl.zstd', 'session.jsonl']) {
          const p = join(sessionsRoot, proj.name, sd.name, fname)
          try {
            const st = await stat(p)
            if (st.size >= config.backfillMinBytes && st.size <= config.backfillMaxBytes) {
              candidates.push({ id: sd.name, path: p, size: st.size })
            }
          } catch { /* 文件不存在 */ }
        }
      }
    }
    return candidates.sort((a, b) => b.size - a.size)
  }

  // 逐行折叠冷日志到各 unit 的 init 状态。返回 {folded, lastSeq, states}；
  // 跳过首行 header、空行与损坏行。每 chunkSize 行让出一次事件循环。
  const foldLogLines = async (content, registrations) => {
    const states = new Map(registrations.map(([key, reg]) => [key, reg.def.init()]))
    let folded = 0
    let lastSeq = -1
    let pos = content.indexOf('\n')
    if (pos === -1) return { folded: 0, lastSeq: -1, states } // 无 header 行
    let chunkLeft = config.chunkSize
    const advance = async () => {
      if (--chunkLeft > 0) return
      chunkLeft = config.chunkSize
      await yieldLoop()
    }
    for (;;) {
      const nl = content.indexOf('\n', pos)
      const line = nl === -1 ? content.slice(pos) : content.slice(pos, nl)
      if (line !== '') {
        let ev
        try { ev = JSON.parse(line) } catch { /* 非事件行/损坏行：跳过 */ }
        if (ev !== void 0 && Number.isInteger(ev?.seq)) {
          lastSeq = ev.seq
          for (const [, reg] of registrations) {
            const def = reg.def
            states.set(def.key, def.apply(states.get(def.key), ev))
          }
          folded += 1
          await advance()
        }
      }
      if (nl === -1) break
      pos = nl + 1
    }
    return { folded, lastSeq, states }
  }

  // 处理单个冷会话候选。返回是否完成补行。
  const backfillOne = async (cand, deps) => {
    const { cache, persistence, registry, putCacheRow } = deps
    const raw = await persistence.readRaw(cand.id, undefined)
    if (raw === void 0) return false
    const meta = raw.meta
    if (ctx.sessions?.get?.(cand.id) !== void 0) { stats.backfillSkipped += 1; return false }
    if (cache.recordFor?.(cand.id, coldIdentityOf(meta)) !== void 0) { stats.backfillSkipped += 1; return false }
    const registrations = [...registry.registrations.entries()]
    if (registrations.length === 0) return false

    const t0 = performance.now()
    const { folded, lastSeq, states } = await foldLogLines(raw.content, registrations)
    if (folded === 0) return false
    const rows = {}
    for (const [key, reg] of registrations) rows[key] = { ver: reg.def.stateVersion, seq: lastSeq, val: states.get(key) }
    await putCacheRow.call(cache, cand.id, coldIdentityOf(meta), rows)
    stats.backfilled += 1
    const entry = { t: Date.now(), id: cand.id, events: folded, ms: Math.round(performance.now() - t0), size: cand.size }
    stats.backfill.push(entry)
    if (stats.backfill.length > config.keepRecent) stats.backfill.splice(0, stats.backfill.length - config.keepRecent)
    log(`backfilled ${cand.id}: ${folded} events in ${entry.ms}ms (${(cand.size / 1048576).toFixed(1)}MB log)`)
    return true
  }

  async function backfillColdSessions() {
    if (!config.backfillOnBoot) return
    if (running) return
    running = true
    try {
      await backfillColdSessionsInner()
    } finally {
      running = false
    }
  }

  async function backfillColdSessionsInner() {
    const cache = safeGet(ctx, 'sessionProjectionCache')
    const persistence = safeGet(ctx, 'sessionPersistence')
    const registry = safeGet(ctx, 'sessionProjections')
    if (!cache || !persistence || !registry) { log('backfill: services unavailable; skipped'); return }
    // alpha.5：putSoft(id, identity, rows, what) 被 put(id, identity, rows) 取代；兼容两者
    const putCacheRow = typeof cache.put === 'function' ? cache.put : typeof cache.putSoft === 'function' ? cache.putSoft : void 0
    if (typeof persistence.readRaw !== 'function' || typeof putCacheRow !== 'function') {
      log('backfill: persistence.readRaw/cache.put unavailable; skipped'); return
    }
    const sessionsRoot = resolveSessionsRoot()
    if (sessionsRoot === '') { log('backfill: sessions root not resolvable; skipped'); return }
    const { readdir, stat } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const candidates = await scanCandidates(sessionsRoot, readdir, stat)
    const deps = { cache, persistence, registry, putCacheRow }
    for (const cand of candidates.slice(0, config.backfillMaxSessions)) {
      try {
        await backfillOne(cand, deps)
      } catch (error) {
        logErr(`backfill failed for ${cand.id}: ${String(error?.message ?? error)}`)
      }
      await yieldLoop()
    }
  }

  return { backfillColdSessions, markFired, isFired }
}
