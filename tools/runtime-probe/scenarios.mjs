// 十个运行时场景（A–J）。每个场景独立起停实例（除同进程 A/B），结果写 report。
//
// 设计原则：
//   - 所有测量都同时记录「插件计数器」与「外部墙钟/RSS」，因为插件对 materialize
//     与冷折叠完全没有埋点；
//   - 每次切换配置先 stats.reset，避免上一轮数据污染；
//   - install 时读一次的配置（chunkedMaterialize / renderTiming 等）必须靠
//     `DSH_PERF_*` 环境变量在启动时定值。

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { makeClient } from './client.mjs'
import { startDsh, startRssSampler, readRssMB } from './server.mjs'
import { startPinger } from './pinger.mjs'

const LONG = 'session-probe-long'

// 在隔离 home 里找一个会话的落盘文件（用于数 zstd frame）。
export function findSessionFile(home, sessionId) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return null
  for (const bucket of readdirSync(root)) {
    const dir = join(root, bucket, sessionId)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (f.startsWith('session') && (f.endsWith('.jsonl.zstd') || f.endsWith('.jsonl'))) {
        return join(dir, f)
      }
    }
  }
  return null
}

function countFrames(buf) {
  let n = 0
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) n++
  }
  return n
}

// 在单个实例上跑一段，返回统计快照。
// beforeStart 在起进程之前执行（场景 G 用它清空投影缓存，以制造真正的冷读）。
async function withInstance({ home, agentsHome, profile, port, outDir, configPatch, extraEnv, beforeStart }, fn) {
  if (typeof beforeStart === 'function') await beforeStart()
  const server = await startDsh({ home, agentsHome, profile, port, outDir, extraEnv })
  const client = makeClient({ origin: server.origin, token: server.token })
  try {
    await client.connect()
    if (configPatch !== undefined) await client.configSet(configPatch)
    const result = await fn({ server, client })
    return { ...result, logs: server.readLogs() }
  } finally {
    await server.stop()
  }
}

// 投影缓存行所在位置（dsh 的 per-record layout）。
export function projCacheDir(home) {
  return join(home, 'storages', 'session_projcache', 'sessions')
}

// 清空投影缓存：制造「该会话从未被 checkpoint 过」的冷读起点。
export async function clearProjectionCache(home) {
  const dir = projCacheDir(home)
  if (!existsSync(dir)) return { cleared: 0, dir }
  const { rm } = await import('node:fs/promises')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  for (const f of files) await rm(join(dir, f), { force: true })
  return { cleared: files.length, dir }
}

// 某会话的缓存行是否已生成（场景 G 的验收点）。
export function hasCacheRow(home, sessionId) {
  const dir = projCacheDir(home)
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((f) => f === `session-${sessionId}.json` || f === `${sessionId}.json`)
}

// ---------- 场景 A：装机核验 ----------
export async function scenarioA(opts) {
  return withInstance(opts, async ({ server, client }) => {
    const stats = await client.stats()
    const config = await client.configGet()
    const logs = server.readLogs()
    const perfLines = logs.stdout.split('\n').filter((l) => l.includes('dsh-perf'))
    const heapLine = perfLines.find((l) => l.includes('V8 heap limit')) ?? null
    return {
      dshVersion: stats.value.dshVersion,
      patches: stats.value.patches,
      configKeys: Object.keys(config.value).length,
      debugApiDefault: config.value.debugApi,
      perfLogLines: perfLines,
      heapLine,
      // 「installed(...) 行说得比实际多」的直接证据：
      installedLine: perfLines.find((l) => l.includes('installed (')) ?? null,
      hasPerfLogs: perfLines.length > 0,
    }
  })
}

// ---------- 场景 B：冷读基线（重启后第一次读出） ----------
export async function scenarioB(opts) {
  return withInstance(opts, async ({ server, client }) => {
    await client.statsReset()
    const rss = startRssSampler(server.pid, 200)
    const pinger = startPinger(client, { intervalMs: 50 })

    const before = readRssMB(server.pid)
    const events = await client.rpc('session', 'events', { address: { kind: 'session', sessionId: LONG }, maxMessages: 5 })
    const eventsMs = events.wallMs

    const projections = await client.rpc('session', 'projections', { sessionId: LONG })
    const projectionsMs = projections.wallMs

    const ping = pinger.stop()
    const mem = rss.stop()
    const stats = await client.stats()
    return {
      eventsMs: +eventsMs.toFixed(1),
      projectionsMs: +projectionsMs.toFixed(1),
      projectionKeyCount: Object.keys(projections.value?.values ?? {}).length,
      asOfSeq: projections.value?.asOfSeq,
      rssBeforeMB: before,
      rss: mem,
      pinger: ping,
      patches: stats.value.patches,
    }
  })
}

// ---------- 场景 C：resume 冷读 + 投影热读 ----------
//
// v1.10.0 删除 warmup 后，C 的旧语义（等 warmed 计数）已无对象。保留这个字母，
// 改测仍然存在的东西：rename 触发 resolveAgent → 全量读日志 → prepare → announce
// 的墙钟（一次 resume 冷读），以及紧随其后的 projections 热读。
export async function scenarioC(opts) {
  return withInstance(opts, async ({ server, client }) => {
    await client.statsReset()
    const pinger = startPinger(client, { intervalMs: 50 })
    const rss = startRssSampler(server.pid, 200)

    const t0 = performance.now()
    let renameOk = true
    let renameErr = null
    try {
      await client.rpc('session', 'rename', { sessionId: LONG, title: `probe-${Date.now()}` })
    } catch (error) {
      renameOk = false
      renameErr = String(error?.message ?? error).slice(0, 300)
    }
    const resumeAndRenameMs = performance.now() - t0

    const ping = pinger.stop()
    const mem = rss.stop()

    // resume 后读投影：应命中刚折好的热 cell，不再冷折叠。
    const after = await client.rpc('session', 'projections', { sessionId: LONG })
    const stats = await client.stats()
    return {
      renameOk,
      renameErr,
      resumeAndRenameMs: +resumeAndRenameMs.toFixed(1),
      projectionsAfterMs: +after.wallMs.toFixed(1),
      projectionKeyCount: Object.keys(after.value?.values ?? {}).length,
      rss: mem,
      pinger: ping,
      patches: stats.value.patches,
    }
  })
}

// ---------- 场景 D：真实 fork RPC（服务端新路径，不经过 SessionStore.fork） ----------
export async function scenarioD(opts) {
  return withInstance(opts, async ({ server, client }) => {
    await client.statsReset()
    // fork 需要源会话有 completed turn（我们的生成器每个 turn 都有 turn/end）
    const t0 = performance.now()
    const fork = await client.rpc('session', 'fork', { sessionId: LONG })
    const forkMs = performance.now() - t0
    const childId = fork.value.sessionId
    await new Promise((r) => setTimeout(r, 1500)) // 等子会话首次落盘
    const stats = await client.stats()
    const childFile = findSessionFile(opts.home, childId)
    const frames = childFile !== null && existsSync(childFile) ? countFrames(readFileSync(childFile)) : null
    const sizeBytes = childFile !== null && existsSync(childFile) ? statSync(childFile).size : null
    return {
      childId,
      forkMs: +forkMs.toFixed(1),
      // 关键判定：补丁挂在 SessionStore.prototype.fork 上，而这条路径不经过它 →
      // forks 应保持 0。若为 0，说明补丁在这条链路上完全没被调用。
      pluginForks: stats.value.forks,
      pluginZeroCopy: stats.value.zeroCopy,
      childFileFrames: frames,
      childFileBytes: sizeBytes,
      patches: stats.value.patches,
    }
  })
}

// ---------- 场景 E：直测补丁点（debug.fork，同进程 A/B） ----------
export async function scenarioE(opts) {
  return withInstance({ ...opts, configPatch: { debugApi: true } }, async ({ server, client }) => {
    // 先让源会话 live（debug.fork 走 SessionStore.fork，需要 live source）
    let liveOk = true
    let liveErr = null
    try {
      await client.rpc('session', 'rename', { sessionId: LONG, title: `probe-live-${Date.now()}` })
    } catch (error) {
      liveOk = false
      liveErr = String(error?.message ?? error).slice(0, 300)
    }
    await new Promise((r) => setTimeout(r, 800))

    const runs = {}
    for (const [label, enabled] of [['native', false], ['zeroCopy', true]]) {
      await client.configSet({ zeroCopyFork: enabled })
      await client.statsReset()
      const samples = []
      for (let i = 0; i < 5; i++) {
        try {
          const r = await client.debugFork(LONG)
          samples.push({ wallMs: +r.wallMs.toFixed(1), record: r.value.record })
        } catch (error) {
          samples.push({ error: String(error?.message ?? error).slice(0, 200) })
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      const st = await client.stats()
      const ms = samples.filter((s) => typeof s.wallMs === 'number').map((s) => s.wallMs).sort((a, b) => a - b)
      runs[label] = {
        samples,
        n: ms.length,
        min: ms[0] ?? null,
        median: ms[Math.floor(ms.length / 2)] ?? null,
        max: ms.at(-1) ?? null,
        pluginForks: st.value.forks,
        pluginZeroCopy: st.value.zeroCopy,
        pluginFallbacks: st.value.fallbacks,
        recordPaths: st.value.forkRecent.map((r) => r.path),
      }
    }
    return { liveOk, liveErr, runs }
  })
}

// ---------- 场景 F：分片落盘（两次独立进程，true / false 对比帧数） ----------
//
// 必须用真实 `session/fork` RPC 而不是 debug.fork：后者只调
// SessionStore.fork（纯内存建 session，不落盘），materialize 由 agent 生命周期的
// persistence.create 触发，只有走 agents.create 的路径才会写文件。
async function materializeRun({ enabled }, opts) {
  return withInstance({ ...opts, extraEnv: { DSH_PERF_CHUNKED_MATERIALIZE: enabled ? 'true' : 'false', DSH_PERF_MIN_EVENTS: '2000000' } }, async ({ server, client }) => {
    const pinger = startPinger(client, { intervalMs: 50 })
    const t0 = performance.now()
    const fork = await client.rpc('session', 'fork', { sessionId: LONG })
    const forkMs = performance.now() - t0
    const childId = fork.value.sessionId

    // fork 返回时 agents.create 已完成（含首次 materialize）
    const file = findSessionFile(opts.home, childId)
    const ping = pinger.stop()
    const frames = file !== null && existsSync(file) ? countFrames(readFileSync(file)) : null
    const sizeBytes = file !== null && existsSync(file) ? statSync(file).size : null
    const st = await client.stats()
    return {
      childId,
      forkAndMaterializeMs: +forkMs.toFixed(1),
      fileFrames: frames,
      fileBytes: sizeBytes,
      pinger: ping,
      // 真实 fork 不经过 SessionStore.fork，所以这两个值应为 0
      pluginForks: st.value.forks,
      pluginZeroCopy: st.value.zeroCopy,
      patches: st.value.patches,
    }
  })
}

export async function scenarioF(opts) {
  return {
    enabled: await materializeRun({ enabled: true }, opts),
    // 两轮必须用**不同端口**且严格串行：dsh 不重试也不换端口，前一进程的
    // 端口未释放会让第二轮 EADDRINUSE 整个启动失败。startDsh 会先探测端口；
    // 这里给第二轮换一个端口，避免"端口刚释放"的竞态。
    disabled: await materializeRun({ enabled: false }, { ...opts, port: opts.port + 1 }),
  }
}

// ---------- 场景 G：冷读回写的跨进程验证（v1.7 的决定性验收） ----------
//
// 要证明的事：同一会话「第一次冷读」之后缓存行被创建，**重启进程**再读就走快路径。
//
// 三个回合：
//   G1 清空投影缓存 → 冷读（预期 ~16s，且插件应创建缓存行）
//   G2 重启进程 → 再读（预期 ~0.3s，走 hydrate 命中）
//   G3 对照组：清缓存 + coldWriteBack=false → 冷读 → 重启 → 再读（预期仍 ~16s）
export async function scenarioG(opts) {
  const LONG_ID = LONG
  const coldRead = async (client) => {
    await client.statsReset()
    const t0 = performance.now()
    const proj = await client.rpc('session', 'projections', { sessionId: LONG_ID })
    const ms = performance.now() - t0
    return { ms: +ms.toFixed(1), keys: Object.keys(proj.value?.values ?? {}).length, asOfSeq: proj.value?.asOfSeq }
  }

  // --- 回合 1：冷读（回写开启）---
  const round1 = await withInstance({
    ...opts,
    extraEnv: { DSH_PERF_COLD_WRITE_BACK: 'true', DSH_PERF_MIN_EVENTS: '20000' },
    beforeStart: async () => { await clearProjectionCache(opts.home) },
  }, async ({ client }) => {
    const first = await coldRead(client)
    // 等回写的 setImmediate + put 完成（put 是异步落盘 + fsync）
    const deadline = Date.now() + 30000
    let stats = await client.stats()
    while (Date.now() < deadline && stats.value.coldWriteBacks === 0 && stats.value.coldWriteBackFailed === 0) {
      await new Promise((r) => setTimeout(r, 200))
      stats = await client.stats()
    }
    return {
      coldReadMs: first.ms,
      projectionKeys: first.keys,
      asOfSeq: first.asOfSeq,
      coldWriteBacks: stats.value.coldWriteBacks,
      coldWriteBackSkipped: stats.value.coldWriteBackSkipped,
      coldWriteBackFailed: stats.value.coldWriteBackFailed,
      coldWriteBackRecent: stats.value.coldWriteBackRecent,
      patches: stats.value.patches,
      cacheRowExists: hasCacheRow(opts.home, LONG_ID),
    }
  })

  // --- 回合 2：重启进程，同一会话再读（回写开启，但此时应命中缓存）---
  const round2 = await withInstance({
    ...opts,
    port: opts.port + 1,
    extraEnv: { DSH_PERF_COLD_WRITE_BACK: 'true', DSH_PERF_MIN_EVENTS: '20000' },
  }, async ({ client }) => {
    const second = await coldRead(client)
    const stats = await client.stats()
    return {
      warmReadMs: second.ms,
      projectionKeys: second.keys,
      asOfSeq: second.asOfSeq,
      coldWriteBacks: stats.value.coldWriteBacks,
      coldWriteBackSkipped: stats.value.coldWriteBackSkipped,
    }
  })

  // --- 回合 3：对照组（回写关闭）---
  const round3 = await withInstance({
    ...opts,
    port: opts.port + 2,
    extraEnv: { DSH_PERF_COLD_WRITE_BACK: 'false', DSH_PERF_MIN_EVENTS: '20000' },
    beforeStart: async () => { await clearProjectionCache(opts.home) },
  }, async ({ client }) => {
    const first = await coldRead(client)
    const stats = await client.stats()
    return {
      coldReadMs: first.ms,
      coldWriteBacks: stats.value.coldWriteBacks,
      cacheRowExists: hasCacheRow(opts.home, LONG_ID),
      patches: stats.value.patches,
    }
  })
  const round4 = await withInstance({
    ...opts,
    port: opts.port + 3,
    extraEnv: { DSH_PERF_COLD_WRITE_BACK: 'false', DSH_PERF_MIN_EVENTS: '20000' },
  }, async ({ client }) => {
    const second = await coldRead(client)
    return { warmReadMs: second.ms }
  })

  return {
    withWriteBack: {
      coldReadMs: round1.coldReadMs,
      restartReadMs: round2.warmReadMs,
      speedup: round1.coldReadMs > 0 ? +(round1.coldReadMs / round2.warmReadMs).toFixed(1) : null,
      cacheRowCreated: round1.cacheRowExists,
      patches: round1.patches,
      coldWriteBacks: round1.coldWriteBacks,
      coldWriteBackRecent: round1.coldWriteBackRecent,
      projectionKeys: round1.projectionKeys,
      asOfSeq: round1.asOfSeq,
    },
    control: {
      coldReadMs: round3.coldReadMs,
      restartReadMs: round4.warmReadMs,
      speedup: round3.coldReadMs > 0 ? +(round3.coldReadMs / round4.warmReadMs).toFixed(1) : null,
      cacheRowCreated: round3.cacheRowExists,
      patches: round3.patches,
    },
  }
}

// ---------- 场景 H：渲染链路的分页载荷（v1.12） ----------
//
// 要证明的事：浏览器首屏与每次向上滚动拉到的窗口到底有多大、服务端要花多久。
// 客户端固定请求 500 条消息（HISTORY_PAGE_OPTIONS），而 `session/follow` 与
// `session/events` 共用同一个 paginate，所以用 unary 的 events 测出的字节数与
// 条数关系就是首屏 WS 帧的量级。
//
// 两轮：
//   upstream —— maxInitialMessages=0，完全上游行为（客户端请求 500 条 + turnWindow 50）
//   capped   —— maxInitialMessages=25，验证截断后的条数与字节
//
// 注意：客户端虽然请求 maxMessages=500，但 paginate 在「≥50 条消息且跨过 ≥2 个
// turn」时就切页，所以短 turn 会话的真实首屏是 ~50 条。只压 maxMessages 对这种
// 会话毫无效果（实测 150 与 500 产出同样 231 个事件）；必须同时压
// turnWindow.minMessages。
const RENDER_PAGE = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }

const countMessages = (records) => records.filter((record) => {
  const type = record?.event?.type
  return type === 'user/message' || type === 'assistant/message'
}).length

async function renderPageRun(options) {
  return withInstance(options, async ({ server, client }) => {
    await client.statsReset()
    const address = { kind: 'session', sessionId: LONG }

    const coldStart = performance.now()
    const first = await client.rpc('session', 'events', { address, ...RENDER_PAGE })
    const coldMs = performance.now() - coldStart
    const firstRecords = first.value?.records ?? []
    const firstBytes = Buffer.byteLength(JSON.stringify(first.value ?? null), 'utf8')
    const recordsBytes = Buffer.byteLength(JSON.stringify(firstRecords), 'utf8')

    const warmStart = performance.now()
    const second = await client.rpc('session', 'events', { address, ...RENDER_PAGE })
    const warmMs = performance.now() - warmStart
    const secondRecords = second.value?.records ?? []

    const projStart = performance.now()
    const projections = await client.rpc('session', 'projections', { sessionId: LONG })
    const projectionMs = performance.now() - projStart
    const projectionBytes = Buffer.byteLength(JSON.stringify(projections.value?.values ?? null), 'utf8')

    const stats = await client.stats()
    return {
      coldMs: +coldMs.toFixed(1),
      warmMs: +warmMs.toFixed(1),
      records: firstRecords.length,
      messages: countMessages(firstRecords),
      warmRecords: secondRecords.length,
      bytes: firstBytes,
      recordsBytes,
      hasMore: first.value?.hasMore === true,
      projectionKeys: Object.keys(projections.value?.values ?? {}).length,
      projectionMs: +projectionMs.toFixed(1),
      projectionBytes,
      renderPages: stats.value.render?.pages ?? [],
      snapshotCount: stats.value.render?.snapshotCount ?? 0,
      patches: stats.value.patches,
    }
  })
}

export async function scenarioH(opts) {
  return {
    upstream: await renderPageRun({ ...opts, extraEnv: { DSH_PERF_RENDER_TIMING: 'true' } }),
    capped: await renderPageRun({
      ...opts,
      port: opts.port + 1,
      extraEnv: { DSH_PERF_RENDER_TIMING: 'true', DSH_PERF_MAX_INITIAL_MESSAGES: '25' },
    }),
  }
}

// ---------- 场景 I：消息体主导的重会话（v1.13）----------
//
// 与 H 互补：H 的会话是 30 000 turn、小消息，测的是投影主导的开销；
// heavy 会话是 300 turn、工具输出主导，测的是「页字节 → 渲染成本」。
// 两个 fixture 用不同轴，避免把「turn 数」和「消息体大小」混为一谈。
//
// 同时近似 `session/control` 的全量基线：把每个会话的投影各取一次并累加字节。
export const HEAVY = 'session-probe-heavy'

export async function scenarioI(opts) {
  return withInstance({ ...opts, extraEnv: { DSH_PERF_RENDER_TIMING: 'true' } }, async ({ client }) => {
    await client.statsReset()
    const address = { kind: 'session', sessionId: HEAVY }
    const startedAt = performance.now()
    const page = await client.rpc('session', 'events', { address, ...RENDER_PAGE })
    const coldMs = performance.now() - startedAt
    const records = page.value?.records ?? []
    const bytes = Buffer.byteLength(JSON.stringify(page.value ?? null), 'utf8')
    const recordsBytes = Buffer.byteLength(JSON.stringify(records), 'utf8')
    const messages = countMessages(records)

    const warmStart = performance.now()
    const warm = await client.rpc('session', 'events', { address, ...RENDER_PAGE })
    const warmMs = performance.now() - warmStart

    const projStart = performance.now()
    const projections = await client.rpc('session', 'projections', { sessionId: HEAVY })
    const projectionMs = performance.now() - projStart
    const projectionBytes = Buffer.byteLength(JSON.stringify(projections.value?.values ?? null), 'utf8')

    // 近似 control 基线：所有会话的投影值之和（control 一帧里装的就是这些）。
    let baselineBytes = 0
    let baselineSessions = 0
    try {
      const listed = await client.rpc('session', 'list', {}, { argName: '_request' })
      const ids = (listed.value?.items ?? []).map((item) => item.sessionId).filter((id) => typeof id === 'string')
      for (const id of ids.slice(0, 12)) {
        const one = await client.rpc('session', 'projections', { sessionId: id })
        baselineBytes += Buffer.byteLength(JSON.stringify(one.value?.values ?? null), 'utf8')
        baselineSessions += 1
      }
    } catch (error) {
      baselineBytes = -1
    }

    const stats = await client.stats()
    return {
      records: records.length,
      messages,
      warmRecords: warm.value?.records?.length ?? 0,
      bytes,
      recordsBytes,
      coldMs: +coldMs.toFixed(1),
      warmMs: +warmMs.toFixed(1),
      projectionKeys: Object.keys(projections.value?.values ?? {}).length,
      projectionMs: +projectionMs.toFixed(1),
      projectionBytes,
      baselineSessions,
      baselineBytes,
      renderPages: stats.value.render?.pages ?? [],
      patches: stats.value.patches,
    }
  })
}

// ---------- 场景 J：回合跳转的 burst 聚合（v1.13）----------
//
// `loadThrough` 在服务端的指纹是「连续多次 beforeSeq 回翻，间隔很短」。
// 这里用同一形态直接打 `session/events`，验证 render-timing 把它们聚合成
// 一条 kind='jump' 记录（而不是 N 条普通 older 页）。
export async function scenarioJ(opts) {
  return withInstance({ ...opts, extraEnv: { DSH_PERF_RENDER_TIMING: 'true' } }, async ({ client }) => {
    await client.statsReset()
    const address = { kind: 'session', sessionId: LONG }
    await client.rpc('session', 'events', { address, maxMessages: 50 })
    let beforeSeq
    const pages = []
    for (let i = 0; i < 5; i++) {
      const request = { address, maxMessages: 50, ...(beforeSeq === undefined ? {} : { beforeSeq }) }
      const page = await client.rpc('session', 'events', request)
      const records = page.value?.records ?? []
      if (records.length === 0) break
      pages.push(records.length)
      const first = records[0]?.event?.seq
      if (typeof first !== 'number' || first <= 0) break
      beforeSeq = first
    }
    // 等 burst 定时器（JUMP_BURST_GAP_MS = 1500）落盘
    await new Promise((resolve) => setTimeout(resolve, 2200))
    const stats = await client.stats()
    const render = stats.value.render ?? {}
    return {
      pages,
      jumps: render.jumps ?? 0,
      jumpRecords: (render.pages ?? []).filter((entry) => entry.kind === 'jump'),
      olderPages: (render.pages ?? []).filter((entry) => entry.kind === 'older').length,
    }
  })
}

export const SCENARIOS = {
  A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD,
  E: scenarioE, F: scenarioF, G: scenarioG, H: scenarioH,
  I: scenarioI, J: scenarioJ,
}
