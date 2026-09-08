// 冷会话缓存补行（默认关）
//
// 磁盘缺投影缓存行的大会话流式补写（fold 官方 jsonl 日志 → cache rows）。
// 解码同步、插件层不可分片——大文件仍会短暂冻结事件循环，故默认关；
// 开启后按 chunkSize 分片让出 + 会话间让出。
//
// 读取通道：rc.1 及之前走 persistence.readRaw（内部 zstd 解码）；0.1.3 起
// persistence API 重写（handle 模型），readRaw 不存在——直读磁盘文件
// （scanCandidates 已持有路径），多帧 zstd（scanZstdFrames 语义）解码。
// 文件名：v0 = session.jsonl；vN = session.vN.jsonl；压缩后缀 .zstd。

import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// 逐帧解压：扫描 zstd frame 边界（magic 28 B5 2F FD），每帧独立解压后拼接
// （与 dsh 的 scanZstdFrames/readZstdPrefix 语义一致）
function decodeAllFrames(buf) {
  const MAGIC = [0x28, 0xB5, 0x2F, 0xFD]
  const chunks = []
  let start = -1
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      if (start !== -1) chunks.push(buf.subarray(start, i))
      start = i
    }
  }
  if (start !== -1) chunks.push(buf.subarray(start))
  return Buffer.concat(chunks.map((c) => zstdDecompressSync(c)))
}

const LOG_NAME_RE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/

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

  // alpha.5+ identity：isSeeded/inheritedEventCount 参与匹配。
  // 0.1.3 起物理 header 无 seedLength 字段，cut 由事件流尾 end-seed
  // marker 推导（inheritedEventCount 参数优先于老 meta.seedLength）。
  const coldIdentityOf = (meta, inheritedEventCount) => ({
    createdAt: meta.createdAt,
    ...(meta.cwd !== void 0 ? { cwd: meta.cwd } : {}),
    isSeeded: meta.isSeeded ?? false,
    inheritedEventCount: sessionLogOffset(inheritedEventCount ?? meta.seedLength ?? 0),
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
        let files = []
        try { files = await readdir(join(sessionsRoot, proj.name, sd.name), { withFileTypes: true }) } catch { continue }
        for (const f of files) {
          if (!f.isFile() || !LOG_NAME_RE.test(f.name)) continue
          const p = join(sessionsRoot, proj.name, sd.name, f.name)
          try {
            const st = await stat(p)
            if (st.size >= config.backfillMinBytes && st.size <= config.backfillMaxBytes) {
              candidates.push({ id: sd.name, path: p, size: st.size })
            }
          } catch { /* 文件消失等竞争：跳过 */ }
        }
      }
    }
    return candidates.sort((a, b) => b.size - a.size)
  }

  // 读冷日志。优先 persistence.readRaw（rc.1 及之前）；0.1.3 直读文件。
  const readColdLog = async (cand, persistence) => {
    if (typeof persistence?.readRaw === 'function') {
      const raw = await persistence.readRaw(cand.id, undefined)
      if (raw === void 0) return void 0
      const meta = raw.meta ?? {}
      return {
        content: raw.content,
        meta,
        inheritedEventCount: meta.seedLength !== void 0 ? sessionLogOffset(meta.seedLength) : void 0,
      }
    }
    if (typeof cand.path !== 'string' || cand.path === '') return void 0
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(cand.path)
    const text = cand.path.endsWith('.zstd') ? decodeAllFrames(buf).toString('utf8') : buf.toString('utf8')
    const firstNl = text.indexOf('\n')
    if (firstNl === -1) return void 0
    let meta
    try { meta = JSON.parse(text.slice(0, firstNl)) } catch { return void 0 }
    if (typeof meta?.id !== 'string' || typeof meta?.createdAt !== 'number' || typeof meta?.isSeeded !== 'boolean') return void 0
    return { content: text, meta, inheritedEventCount: void 0 }
  }

  // 逐行折叠冷日志到各 unit 的 init 状态。返回 {folded, lastSeq, states,
  // endSeedCount}；跳过首行 header、空行与损坏行。每 chunkSize 行让出一次。
  // endSeedCount = 最后一个 inherited end-seed marker 的 seq（0.1.3 的 seed cut
  // 表达：v2 校验 lastInheritedMarker !== cut → cut == marker.seq）。
  const foldLogLines = async (content, registrations) => {
    const states = new Map(registrations.map(([key, reg]) => [key, reg.def.init()]))
    let folded = 0
    let lastSeq = -1
    let endSeedCount = 0
    let pos = content.indexOf('\n')
    if (pos === -1) return { folded: 0, lastSeq: -1, states, endSeedCount: 0 } // 无 header 行
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
          if (ev.type === 'session/end-seed' && ev.data?.inherited === true) endSeedCount = ev.seq
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
    return { folded, lastSeq, states, endSeedCount }
  }

  // 处理单个冷会话候选。返回是否完成补行。
  const backfillOne = async (cand, deps) => {
    const { cache, persistence, registry, putCacheRow } = deps
    if (ctx.sessions?.get?.(cand.id) !== void 0) { stats.backfillSkipped += 1; return false }
    const cold = await readColdLog(cand, persistence)
    if (cold === void 0) return false
    const { meta, inheritedEventCount: metaCut, content } = cold
    if (cache.recordFor?.(cand.id, coldIdentityOf(meta, metaCut)) !== void 0) { stats.backfillSkipped += 1; return false }
    const registrations = [...registry.registrations.entries()]
    if (registrations.length === 0) return false

    const t0 = performance.now()
    const { folded, lastSeq, states, endSeedCount } = await foldLogLines(content, registrations)
    if (folded === 0) return false
    const rows = {}
    for (const [key, reg] of registrations) rows[key] = { ver: reg.def.stateVersion, seq: lastSeq, val: states.get(key) }
    const cut = metaCut ?? (endSeedCount > 0 ? sessionLogOffset(endSeedCount) : void 0)
    await putCacheRow.call(cache, cand.id, coldIdentityOf(meta, cut), rows)
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
    if (typeof persistence.readRaw !== 'function' && typeof persistence.encodeMaterialization !== 'function') {
      log('backfill: persistence backend unavailable (no readRaw/encodeMaterialization); skipped'); return
    }
    if (typeof putCacheRow !== 'function') {
      log('backfill: cache.put unavailable; skipped'); return
    }
    const sessionsRoot = resolveSessionsRoot()
    if (sessionsRoot === '') { log('backfill: sessions root not resolvable; skipped'); return }
    const { readdir, stat } = await import('node:fs/promises')
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
