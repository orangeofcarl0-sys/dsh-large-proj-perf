// 六个运行时场景。每个场景独立起停实例（除同进程 A/B），结果写 report。
//
// 设计原则：
//   - 所有测量都同时记录「插件计数器」与「外部墙钟/RSS」，因为插件对 materialize
//     与冷折叠完全没有埋点；
//   - 每次切换配置先 stats.reset，避免上一轮数据污染；
//   - warmup 关闭必须重启进程（已预热 cell 存在 WeakMap 里，撤不掉）。

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
async function withInstance({ home, agentsHome, profile, port, outDir, configPatch, extraEnv }, fn) {
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

// ---------- 场景 B：冷读基线（warmup 关闭，重启后第一次读出） ----------
export async function scenarioB(opts) {
  return withInstance({ ...opts, configPatch: { warmupEnabled: false, minEvents: 2000000 } }, async ({ server, client }) => {
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
      warmed: stats.value.warmed,
      skipped: stats.value.skipped,
      warmRecent: stats.value.warmRecent,
      patches: stats.value.patches,
    }
  })
}

// ---------- 场景 C：预热收益（warmup 开，resume 触发 session/created） ----------
export async function scenarioC(opts) {
  return withInstance({ ...opts, configPatch: { warmupEnabled: true, minEvents: 20000, warmOnCreated: true } }, async ({ server, client }) => {
    await client.statsReset()
    const pinger = startPinger(client, { intervalMs: 50 })
    const rss = startRssSampler(server.pid, 200)

    // resume：rename 会在服务端 resolveAgent → 读全量日志 → prepare → announce，
    // announce 之后才发出 session/created，插件的预热监听在这里被唤醒。
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

    // 预热是异步的：等它跑完（max 120s），轮询 warmed 计数。
    const deadline = performance.now() + 120000
    let stats = await client.stats()
    while (performance.now() < deadline && stats.value.warmed === 0 && stats.value.aborted === 0) {
      await new Promise((r) => setTimeout(r, 300))
      stats = await client.stats()
    }

    const ping = pinger.stop()
    const mem = rss.stop()

    // 预热后读投影：应命中热 cell，不再冷折叠。
    const after = await client.rpc('session', 'projections', { sessionId: LONG })
    return {
      renameOk,
      renameErr,
      resumeAndRenameMs: +resumeAndRenameMs.toFixed(1),
      warmed: stats.value.warmed,
      skipped: stats.value.skipped,
      aborted: stats.value.aborted,
      alreadyHot: stats.value.alreadyHot,
      warmRecent: stats.value.warmRecent,
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
  return withInstance({ ...opts, configPatch: { debugApi: true, warmupEnabled: false, minEvents: 2000000 } }, async ({ server, client }) => {
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
  return withInstance({ ...opts, extraEnv: { DSH_PERF_CHUNKED_MATERIALIZE: enabled ? 'true' : 'false', DSH_PERF_WARMUP_ENABLED: 'false', DSH_PERF_MIN_EVENTS: '2000000' } }, async ({ server, client }) => {
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
    disabled: await materializeRun({ enabled: false }, opts),
  }
}

export const SCENARIOS = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE, F: scenarioF }
