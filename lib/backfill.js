// 冷会话缓存补行（默认关）
//
// 磁盘缺投影缓存行的大会话流式补写（fold 官方 jsonl 日志 → cache rows）。
// 解码按 zstd frame 逐帧异步进行、帧间让出事件循环；折叠按 chunkSize 让出；
// 会话之间也各让出一次。默认关：它仍是「读全量日志 + 折全部单元」的重活，
// 需要时再开。
//
// 读取通道：rc.1 及之前走 persistence.readRaw（内部 zstd 解码）；0.1.3 起
// persistence API 重写（handle 模型），readRaw 不存在——直读磁盘文件
// （scanCandidates 已持有路径），多帧 zstd（scanZstdFrames 语义）解码。
// 文件名：v0 = session.jsonl；vN = session.vN.jsonl；压缩后缀 .zstd。

import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'

const zstdDecompressAsync = promisify(zstdDecompress)

// zstd frame 边界扫描（与上游 scanZstdFrames 的语义一致：按 RFC 8878 走帧头 +
// block 链，遇到不完整的尾帧就把它当 torn 起点）。上游那个是包内私有函数，
// 这里复刻一份只够「逐帧独立解压」用的最小实现。
const ZSTD_MAGIC = 0xFD2FB528

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstandard log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt zstandard log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt zstandard log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

// 逐帧解压器：优先用 Node 的私有快速通道（如果该 Node 版本有），否则退化为
// 每帧一次 `zstdDecompress`。两者语义相同（每帧是独立可解码单元）。
function createFrameDecoder() {
  const zstdDecompressAsync = promisify(zstdDecompress)
  return {
    async *decode(buffer, frames) {
      for (const frame of frames) {
        yield await zstdDecompressAsync(buffer.subarray(frame.start, frame.end))
      }
    },
  }
}

const LOG_NAME_RE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/

export function createBackfill(deps) {
  const { ctx, config, stats, log, logErr, sessionLogOffset, safeGet, yieldLoop, cacheIdentityOf } = deps

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

  // identity 构造器统一在 lib/cache-identity.js：字段顺序与条件展开必须与上游
  // identityOf() 逐字一致，否则缓存行永久失配（见该文件头注释）。

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
    let text
    if (cand.path.endsWith('.zstd')) {
      // 逐帧异步解压 + 帧间让出（旧实现同步解整个文件，会冻结事件循环）。
      const { frames } = scanZstdFrames(buf)
      const chunks = []
      const decoder = createFrameDecoder()
      let n = 0
      if (frames.length > 0) {
        for await (const plaintext of decoder.decode(buf, frames)) {
          chunks.push(plaintext)
          if (++n % 8 === 0) await yieldLoop()
        }
      }
      text = Buffer.concat(chunks).toString('utf8')
    } else {
      text = buf.toString('utf8')
    }
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
  const foldLogLines = async (content, meta, inheritedEventCount, registrations) => {
    // 只折活跃单元（跳过 refs === 0 的已释放项）；init 必须带 (header, cut)，
    // 见 session-walk.js 的说明与 1.3.1 修过的 TypeError。
    const active = registrations.filter(([, reg]) => reg.refs !== 0)
    const states = new Map(active.map(([key, reg]) => [key, reg.def.init(meta, inheritedEventCount)]))
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
          for (const [, reg] of active) {
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
    // 只有在「行缺失」或「行陈旧」时才补写。旧实现只判缺失，于是会话追加了
    // 新事件之后，陈旧行永远不会被刷新，读取时仍要从该行的 seq 继续折。
    const existing = cache.recordFor?.(cand.id, cacheIdentityOf(meta, metaCut))
    const existingSeq = existing === void 0
      ? -1
      : Math.min(...Object.values(existing.rows ?? {}).map((r) => r?.seq ?? -1))
    if (existing !== void 0 && !Number.isFinite(existingSeq)) { stats.backfillSkipped += 1; return false }
    const registrations = [...registry.registrations.entries()]
    if (registrations.length === 0) return false

    const t0 = performance.now()
    const { folded, lastSeq, states, endSeedCount } = await foldLogLines(content, meta, metaCut, registrations)
    if (folded === 0) return false
    // 已有行的水位已经追上日志末尾 → 无需重写。
    if (existingSeq >= lastSeq) { stats.backfillSkipped += 1; return false }
    const rows = {}
    for (const [key, reg] of registrations) {
      if (reg.refs === 0) continue
      rows[key] = { ver: reg.def.stateVersion, seq: lastSeq, val: states.get(key) }
    }
    // cut 的推导顺序（与历史版本兼容）：
    //   1. 调用方显式给出的 inheritedEventCount（0.1.3+ 的 handle 模型）；
    //   2. 事件流尾的 inherited end-seed marker（0.1.3+ 的物理表达）；
    //   3. 老格式 v0 的 header.seedLength（rc 之前的写法）。
    const cut = metaCut ?? (endSeedCount > 0 ? sessionLogOffset(endSeedCount) : void 0)
      ?? (meta.seedLength !== void 0 ? sessionLogOffset(meta.seedLength) : void 0)
    await putCacheRow.call(cache, cand.id, cacheIdentityOf(meta, cut), rows)
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
