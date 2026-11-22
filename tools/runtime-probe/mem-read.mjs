// 多会话「只读」内存实测：不激活 Agent，只走 session/projections + session/events。
//
// 为什么需要它：Web 点击打开会把会话 promote 成 live Agent，live Session 自己
// 持有事件树，观察缓存是否淘汰都看不出稳态差异。这个工具只做 passive read，
// 读完后 lease 释放、没有 live 引用，能直接量出 memoryBudget 的真实效果：
//   - 每读一个会话，宿主堆增加多少；
//   - 预算触发后被淘汰的条目是否真的把堆还回去；
//   - 重开被淘汰会话的冷读成本。
//
//   node tools/runtime-probe/mem-read.mjs \
//     --home F:/dsh-rt/<stamp>/home --agents ... \
//     --sessions session-mem-probe-91k-1,... --events 91008 \
//     --budget-bytes 536870912 --label fixed-512 --reopen first \
//     --out F:/dsh-rt/<stamp>/mem-read/fixed-512

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { startDsh, waitPortFree } from './server.mjs'
import { makeClient } from './client.mjs'
import { clearProjectionCache } from './scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DSH_PKG = process.env.DSH_PKG
  ?? 'C:/Users/66494/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'
const WS_LIB = (() => {
  const mod = createRequire(DSH_PKG)('ws')
  return mod.WebSocket ?? mod
})()

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value, digits = 1) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits
const toMiB = (bytes) => bytes === null || bytes === undefined ? null : bytes / 1048576
const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const home = arg('home', '')
if (home === '') { console.error('--home is required'); process.exit(2) }
const agentsHome = arg('agents', join(home, '..', 'agents'))
const sessionList = (arg('sessions', arg('session', 'session-mem-probe-91k'))).split(',').map((entry) => entry.trim()).filter(Boolean)
const outDir = arg('out', join(home, '..', 'mem-read'))
const label = arg('label', basename(outDir))
const profile = arg('profile', 'rt')
const port = Number(arg('port', '3320'))
const prepPort = Number(arg('prep-port', String(port + 11)))
const debugPort = Number(arg('debug-port', '9230'))
const eventsArg = arg('events', undefined)
const fixtureEvents = eventsArg === undefined ? null : Number(eventsArg)
const budgetArg = arg('budget-bytes', undefined)
const budgetBytes = budgetArg === undefined ? undefined : Number(budgetArg)
const reopenArg = arg('reopen', undefined)
const reopenId = reopenArg === undefined || reopenArg === 'none'
  ? null
  : reopenArg === 'first' ? sessionList[0] : reopenArg
if (reopenId !== null && !sessionList.includes(reopenId)) {
  console.error(`--reopen ${reopenId} is not in --sessions`)
  process.exit(2)
}
const dshVersion = (() => {
  try { return JSON.parse(readFileSync(DSH_PKG, 'utf8')).version } catch { return null }
})()
mkdirSync(outDir, { recursive: true })

class Cdp {
  static async connect(url, label) {
    const socket = new WS_LIB(url)
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
      setTimeout(() => reject(new Error(`${label}: websocket open timeout`)), 10000)
    })
    return new Cdp(socket, label)
  }
  constructor(socket, label) {
    this.socket = socket
    this.label = label
    this.nextId = 1
    this.pending = new Map()
    socket.on('message', (data) => {
      let message
      try { message = JSON.parse(data.toString()) } catch { return }
      if (message.id === undefined) return
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(`${this.label}: ${message.error.message}`))
      else pending.resolve(message.result)
    })
    socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error(`${this.label}: socket closed`))
      this.pending.clear()
    })
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label}: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { try { this.socket.close() } catch { /* 已关闭 */ } }
}

const httpJson = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}
const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) { last = error }
    await sleep(200)
  }
  throw new Error(`${label} timed out${last === undefined ? '' : `: ${last.message}`}`)
}

const budgetSnapshot = (stats) => {
  const budget = stats?.memoryBudget
  if (budget === null || budget === undefined) return null
  return {
    budgetBytes: budget.budgetBytes,
    cachedEntries: budget.cachedEntries,
    cachedEvents: budget.cachedEvents ?? null,
    estimatedBytes: budget.estimatedBytes,
    memoEntries: budget.memoEntries ?? null,
    memoBytes: budget.memoBytes ?? null,
    trimmed: stats.memoryBudgetTrimmed,
    freedBytes: stats.memoryBudgetFreedBytes,
    overBudget: stats.memoryBudgetOverBudget,
  }
}
const deltaBudget = (before, after) => {
  if (before === null || after === null) return null
  const diff = {}
  for (const key of ['cachedEntries', 'cachedEvents', 'estimatedBytes', 'memoEntries', 'memoBytes', 'trimmed', 'freedBytes', 'overBudget']) {
    diff[key] = before[key] === null || after[key] === null ? null : after[key] - before[key]
  }
  return diff
}

const fetchProjectionCache = async (client) => {
  try {
    const result = await client.pluginApi('debug.projectionCache')
    return { status: 200, body: { ok: true, value: result.value } }
  } catch (error) {
    return { status: 0, body: { error: String(error?.message ?? error) } }
  }
}

let server = null
let inspector = null
try {
  for (const [name, value] of [['dsh', port], ['prep', prepPort], ['inspector', debugPort]]) {
    if (!(await waitPortFree(value, 1000))) throw new Error(`${name} port ${value} is in use`)
  }

  // 准备：独立进程 rename 后退出，测量进程里不会留下 live session。
  console.log(`preparing ${sessionList.length} session(s)...`)
  const prep = await startDsh({ home, agentsHome, profile, port: prepPort, outDir })
  try {
    const client = makeClient({ origin: prep.origin, token: prep.token })
    await client.connect()
    for (const sessionId of sessionList) {
      try {
        await client.rpc('session', 'rename', { sessionId, title: sessionId })
      } catch (error) {
        console.warn(`rename ${sessionId} skipped: ${String(error?.message ?? error).slice(0, 200)}`)
      }
      await sleep(250)
    }
  } finally {
    await prep.stop()
  }
  const cleared = await clearProjectionCache(home)
  console.log(`projection cache cleared: ${cleared.cleared} file(s)`)

  server = await startDsh({
    home, agentsHome, profile, port, outDir,
    nodeArgs: [`--inspect=127.0.0.1:${debugPort}`],
    extraEnv: {
      DEEPSEEK_API_KEY: 'sk-dummy-memory-probe',
      DSH_PERF_DEBUG_API: 'true',
      ...(budgetBytes === undefined ? {} : { DSH_PERF_MEMORY_BUDGET_BYTES: String(budgetBytes) }),
    },
    readyTimeoutMs: 120000,
  })
  console.log(`dsh ready: ${server.origin}`)
  const client = makeClient({ origin: server.origin, token: server.token })
  await client.connect()

  const inspectorInfo = await waitFor(
    () => httpJson(`http://127.0.0.1:${debugPort}/json/list`)
      .then((list) => list.find((target) => typeof target.webSocketDebuggerUrl === 'string')),
    15000,
    'node inspector',
  )
  inspector = await Cdp.connect(inspectorInfo.webSocketDebuggerUrl, 'inspector')
  await inspector.send('Runtime.enable')
  await inspector.send('HeapProfiler.enable')

  const heapUsed = async () => {
    const result = await inspector.send('Runtime.evaluate', {
      expression: 'process.memoryUsage()',
      returnByValue: true,
    })
    return result.result?.value?.heapUsed ?? null
  }
  const collectGarbage = async () => {
    try { await inspector.send('HeapProfiler.collectGarbage') } catch { /* inspector 暂不可用 */ }
  }
  const stableHeap = async () => {
    await collectGarbage()
    await sleep(700)
    const samples = []
    for (let i = 0; i < 3; i++) {
      const value = await heapUsed()
      if (value !== null) samples.push(value)
      await sleep(200)
    }
    return median(samples)
  }

  const baselineStats = budgetSnapshot((await client.stats()).value)
  const baselineHeap = await stableHeap()
  console.log(`baseline heap: ${round(toMiB(baselineHeap))} MiB; cache ${JSON.stringify(baselineStats)}`)

  const readSession = async ({ sessionId, index, kind = 'open' }) => {
    const startedAt = Date.now()
    const beforeStats = budgetSnapshot((await client.stats()).value)
    const beforeHeap = await stableHeap()

    let peak = beforeHeap
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        try {
          const value = await heapUsed()
          if (value !== null && value > peak) peak = value
        } catch { /* 读期间 inspector 偶发失败 */ }
        await sleep(300)
      }
    })()

    const t0 = Date.now()
    let projections = null
    let projectionsError = null
    try {
      projections = await client.rpc('session', 'projections', { sessionId })
    } catch (error) {
      projectionsError = String(error?.message ?? error).slice(0, 300)
    }
    const projectionsMs = Date.now() - t0
    const t1 = Date.now()
    const events = await client.rpc('session', 'events', {
      address: { kind: 'session', sessionId },
      maxMessages: 50,
    })
    const eventsMs = Date.now() - t1
    sampling = false
    await sampler

    await sleep(1000)
    const afterHeap = await stableHeap()
    const afterStats = budgetSnapshot((await client.stats()).value)
    const delta = deltaBudget(beforeStats, afterStats)
    const eventsAdded = delta === null
      ? null
      : delta.cachedEvents ?? (fixtureEvents === null || delta.cachedEntries === null ? null : delta.cachedEntries * fixtureEvents)
    const retainedBytes = beforeHeap === null || afterHeap === null ? null : afterHeap - beforeHeap

    const result = {
      kind,
      sessionId,
      index,
      clickAt: startedAt,
      endAt: Date.now(),
      baseline: { hostHeapMiB: round(toMiB(beforeHeap)) },
      peak: { hostHeapMiB: round(toMiB(peak)) },
      stable: { hostHeapMiB: round(toMiB(afterHeap)) },
      timeline: {
        firstRowMs: projectionsMs,
        projectionsMs,
        projectionsError,
        eventsMs,
        projectionKeys: Object.keys(projections?.value?.values ?? {}).length,
        eventRows: Array.isArray(events.value?.events) ? events.value.events.length : null,
      },
      cache: {
        before: beforeStats,
        during: afterStats,
        settled: afterStats,
        delta,
        eventsAdded,
        retainedMiB: round(beforeHeap === null || afterHeap === null ? null : toMiB(retainedBytes)),
        actualBytesPerEvent: retainedBytes === null || eventsAdded === null || eventsAdded <= 0 ? null : round(retainedBytes / eventsAdded),
      },
      rendererGrowth: [],
      rowsAtEnd: null,
    }
    console.log(`${kind} ${sessionId}: projections ${projectionsMs}ms${projectionsError === null ? '' : ` (error: ${projectionsError})`}, events ${eventsMs}ms, heap ${result.stable.hostHeapMiB} MiB (${result.cache.retainedMiB >= 0 ? '+' : ''}${result.cache.retainedMiB}), cache ${JSON.stringify(afterStats)}`)
    return result
  }

  const results = []
  for (let i = 0; i < sessionList.length; i++) {
    results.push(await readSession({ sessionId: sessionList[i], index: i }))
  }
  let reopen = null
  if (reopenId !== null) {
    reopen = await readSession({ sessionId: reopenId, index: sessionList.indexOf(reopenId), kind: 'reopen' })
  }

  const projectionCache = await fetchProjectionCache(client)
  const finalStats = budgetSnapshot((await client.stats()).value)
  const stripped = (result) => result
  const summary = {
    meta: {
      startedAt: new Date().toISOString(),
      label,
      home,
      port,
      profile,
      mode: 'passive-read',
      dshVersion: (await client.stats()).value?.dshVersion ?? dshVersion,
      sessions: sessionList,
      reopen: reopenId,
      budgetBytes: budgetBytes ?? null,
      budgetFromStats: finalStats?.budgetBytes ?? null,
      fixtureEvents,
      cacheCleared: cleared.cleared,
      finalCache: finalStats,
      projectionCache,
      patches: (await client.stats()).value?.patches ?? null,
    },
    sessions: results.map(stripped),
    reopen: reopen === null ? null : stripped(reopen),
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ summary }, null, 2))

  const line = (cells) => `| ${cells.join(' | ')} |`
  const markdown = [
    `# 多会话只读内存实测（${label}）`,
    '',
    `- 模式：passive read（session/projections + session/events），不激活 Agent`,
    `- 会话：${sessionList.map((id) => `\`${id}\``).join('、')}`,
    `- 预算：${summary.meta.budgetFromStats ?? summary.meta.budgetBytes ?? '默认'}；投影缓存清空 ${cleared.cleared} 行`,
    `- 单位：MiB（Node heapUsed，读后强制 GC）`,
    '',
    line(['#', '会话', '读前堆', '读后堆', '增量', '缓存条目', '缓存事件', 'estimatedBytes', '淘汰', 'projections ms', 'events ms']),
    line(['---:', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
    ...results.map((session, index) => line([
      String(index + 1),
      `\`${session.sessionId}\``,
      `${session.baseline.hostHeapMiB}`,
      `${session.stable.hostHeapMiB}`,
      `**${session.cache.retainedMiB}**`,
      `${session.cache.during?.cachedEntries ?? '—'}`,
      `${session.cache.during?.cachedEvents ?? '—'}`,
      `${session.cache.during?.estimatedBytes ?? '—'}`,
      `${session.cache.delta?.trimmed ?? '—'}`,
      `${session.timeline.projectionsMs}`,
      `${session.timeline.eventsMs}`,
    ])),
    '',
    '## 重开',
    '',
    reopen === null ? '未重开。' : line(['会话', '缓存条目', '首读 ms', '增量 MiB', '淘汰 Δ']) + '\n' + line(['---', '---:', '---:', '---:', '---:']) + '\n' + line([
      `\`${reopen.sessionId}\``,
      `${reopen.cache.during?.cachedEntries ?? '—'}`,
      `${reopen.timeline.projectionsMs}`,
      `${reopen.cache.retainedMiB}`,
      `${reopen.cache.delta?.trimmed ?? '—'}`,
    ]),
    '',
    '## 投影缓存行',
    '',
    projectionCache.body?.value === undefined
      ? `探针失败：${JSON.stringify(projectionCache.body)}`
      : `rows ${projectionCache.body.value.rows}，bytes ${projectionCache.body.value.bytes}`,
    '',
    '> 读路径不 promote Agent；`session/projections` 与 `session/events` 都通过 observation lease，',
    '> RPC 返回后 lease 释放，内存预算可以在下一次 store 时淘汰旧条目。',
    '> 首个会话的增量含首次装载 sessionQuery / projections 的模块成本。',
    '',
  ].join('\n')
  writeFileSync(join(outDir, 'report.md'), markdown)
  console.log(`\nwrote ${join(outDir, 'report.json')} and report.md`)
  console.log(JSON.stringify(summary.meta, null, 2))
} finally {
  try { inspector?.close() } catch { /* 已关闭 */ }
  if (server !== null) await server.stop()
}
