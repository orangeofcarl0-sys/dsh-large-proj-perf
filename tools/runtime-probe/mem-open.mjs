// 复刻「Web 点击打开超长会话」的内存实测，支持**一轮开多个会话**：
//   - Web Host：dsh 主进程的 Working Set + JS heap（Node inspector）
//   - Chromium：页面渲染进程的 Working Set（SystemInfo 取 PID）
//   - 浏览器 JS 堆：performance.memory（--enable-precise-memory-info）
//   - 时间线：点击 → 加载历史 → 首批消息 → 渲染峰值 → 稳定
//   - 宿主缓存：每次点击前/稳定后/关页后各取一次 stats.get
//
// 为什么每个会话重启 Chrome：fresh profile 保证进入时没有已打开会话
// （否则 `rows === 0` 的断言不成立），renderer PID 也可按“本轮新出现的”识别，
// 且 renderer 基线不受上一个会话影响。dsh 主进程与 inspector 整轮复用。
//
// 运行前提：隔离 home 里已有目标会话；脚本会先 rename（独立进程）并清空投影缓存，
// 保证测量进程里是冷打开。投影缓存每轮只清一次，arm 之间互不影响。
//
//   node tools/runtime-probe/mem-open.mjs \
//     --home F:/dsh-rt/<stamp>/home --agents F:/dsh-rt/<stamp>/agents \
//     --sessions session-mem-probe-91k-1,session-mem-probe-91k-2,... \
//     --budget-bytes 536870912 --label fixed-512 --reopen first \
//     --out F:/dsh-rt/<stamp>/mem-multi/fixed-512
//
// 单会话旧用法（--session / --title）保持可用。

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, createWriteStream, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { startDsh, waitPortFree } from './server.mjs'
import { makeClient } from './client.mjs'
import { clearProjectionCache } from './scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DSH_PKG = process.env.DSH_PKG
  ?? 'C:/Users/66494/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'
const CHROME = process.env.CHROME_BIN
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const WS_LIB = (() => {
  const mod = createRequire(DSH_PKG)('ws')
  return mod.WebSocket ?? mod
})()

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
const round = (value, digits = 1) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits
const toMiB = (bytes) => bytes === null || bytes === undefined || !Number.isFinite(bytes) ? null : bytes / 1048576

const home = arg('home', '')
if (home === '') { console.error('--home is required'); process.exit(2) }
const agentsHome = arg('agents', join(home, '..', 'agents'))
const sessionsArg = arg('sessions', undefined)
const sessionList = sessionsArg === undefined
  ? [arg('session', 'session-mem-probe-91k')]
  : sessionsArg.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
if (sessionList.length === 0) { console.error('--sessions must contain at least one id'); process.exit(2) }
if (sessionList.some((id) => id.includes(','))) { console.error('session ids must not contain commas'); process.exit(2) }

const titlesArg = arg('titles', undefined)
const singleTitle = arg('title', 'mem-probe-91k')
const titleFor = (id, index) => {
  if (titlesArg !== undefined) return titlesArg.split(',')[index]?.trim() || id
  return sessionList.length === 1 ? singleTitle : id
}

const outDir = arg('out', join(home, '..', 'mem-open'))
const label = arg('label', basename(outDir))
const profile = arg('profile', 'rt')
const port = Number(arg('port', '3320'))
const prepPort = Number(arg('prep-port', String(port + 11)))
const debugPort = Number(arg('debug-port', '9230'))
const chromePort = Number(arg('chrome-port', '9223'))
const sampleMs = Number(arg('sample-ms', '200'))
const durationMs = Number(arg('duration-ms', '25000'))
const eventsArg = arg('events', undefined)
const fixtureEvents = eventsArg === undefined ? null : Number(eventsArg)
const budgetArg = arg('budget-bytes', undefined)
const budgetBytes = budgetArg === undefined ? undefined : Number(budgetArg)
if (budgetBytes !== undefined && (!Number.isFinite(budgetBytes) || budgetBytes < 0)) {
  console.error('--budget-bytes must be a non-negative number')
  process.exit(2)
}
const reopenArg = arg('reopen', undefined)
const reopenId = reopenArg === undefined || reopenArg === 'none'
  ? null
  : reopenArg === 'first' ? sessionList[0] : reopenArg
if (reopenId !== null && !sessionList.includes(reopenId)) {
  console.error(`--reopen ${reopenId} is not in --sessions`)
  process.exit(2)
}
const gcMode = process.argv.includes('--gc')
const snapshotPath = arg('snapshot', undefined)
const maxInitial = arg('max-initial', undefined)
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
    this.events = []
    this.onEvent = null
    socket.on('message', (data) => {
      let message
      try { message = JSON.parse(data.toString()) } catch { return }
      if (message.id === undefined) {
        if (message.method === 'HeapProfiler.addHeapSnapshotChunk' && this.onEvent !== null) {
          this.onEvent(message)
          return
        }
        this.events.push(message)
        return
      }
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
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`${this.label}: ${result.exceptionDetails.text ?? 'evaluate failed'}`)
    }
    return result.result?.value
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

const fetchStats = async (server) => {
  try {
    const response = await fetch(`${server.origin}/dsh-large-proj-perf/api/stats.get`, { method: 'POST' })
    if (!response.ok) return null
    return (await response.json()).value ?? null
  } catch { return null }
}

const fetchDebugSessions = async (server) => {
  try {
    const response = await fetch(`${server.origin}/dsh-large-proj-perf/api/debug.sessions`, { method: 'POST' })
    if (!response.ok) return null
    return (await response.json()).value ?? null
  } catch { return null }
}

const fetchProjectionCache = async (server) => {
  try {
    const response = await fetch(`${server.origin}/dsh-large-proj-perf/api/debug.projectionCache`, { method: 'POST' })
    return { status: response.status, body: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 0, body: { error: String(error?.message ?? error) } }
  }
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

// 一个会话用一个全新 Chrome profile；返回时 Chrome 已关闭、端口已释放。
const launchChrome = async (profileDir) => {
  rmSync(profileDir, { recursive: true, force: true })
  const child = spawn(CHROME, [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--enable-precise-memory-info',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' })
  let page = null
  let browser = null
  try {
    const version = await waitFor(
      () => httpJson(`http://127.0.0.1:${chromePort}/json/version`),
      20000,
      'chrome debug endpoint',
    )
    const pageInfo = await waitFor(
      () => httpJson(`http://127.0.0.1:${chromePort}/json/list`)
        .then((list) => list.find((target) => target.type === 'page')),
      15000,
      'chrome page target',
    )
    page = await Cdp.connect(pageInfo.webSocketDebuggerUrl, 'page')
    browser = await Cdp.connect(version.webSocketDebuggerUrl, 'browser')
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    try { await page.send('Log.enable') } catch { /* 旧版 Chrome */ }
    await page.send('Page.bringToFront')
    try { await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch { /* 旧版 Chrome */ }
    return { child, version, page, browser }
  } catch (error) {
    try { page?.close() } catch { /* 已关闭 */ }
    try { browser?.close() } catch { /* 已关闭 */ }
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 }) } catch { /* 已退出 */ }
    await waitPortFree(chromePort, 5000)
    throw error
  }
}
const closeChrome = async (handle) => {
  if (handle === null) return
  try { handle.page?.close() } catch { /* 已关闭 */ }
  try { handle.browser?.close() } catch { /* 已关闭 */ }
  try { execFileSync('taskkill', ['/PID', String(handle.child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 }) } catch { /* 已退出 */ }
  const freed = await waitPortFree(chromePort, 15000)
  if (!freed) throw new Error(`chrome port ${chromePort} did not free after taskkill`)
}

const bootPage = async (page, server) => {
  await page.send('Page.navigate', { url: server.readyUrl })
  await waitFor(
    () => page.eval('document.readyState === "complete" && document.querySelectorAll("[role=treeitem]").length > 0'),
    40000,
    'dsh web app',
  )
  await sleep(1500)
  const dialogs = await page.eval(`(() => [...document.querySelectorAll('[role=dialog]')].map((node) => ({
    text: (node.innerText || '').slice(0, 80),
    buttons: [...node.querySelectorAll('button')].map((button) => ({
      text: (button.textContent || '').trim(),
      aria: button.getAttribute('aria-label'),
    })),
  })))()`)
  if (dialogs.length > 0) console.log('dialogs:', JSON.stringify(dialogs))
  await page.eval(`(() => {
    const dialog = [...document.querySelectorAll('[role=dialog]')].find((node) => node.textContent.includes('开始使用'))
    if (dialog === undefined) return false
    const close = dialog.querySelector('button[aria-label="关闭"]')
      ?? [...dialog.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '关闭' || node.textContent.trim() === '关闭')
    if (close === undefined) return false
    close.click()
    return true
  })()`)
  await sleep(400)
  if ((await page.eval('document.querySelectorAll("[role=dialog]").length')) > 0) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(300)
  }
  // 侧栏可能折叠了较早的会话；先展开
  await page.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('展开其余'))
    if (button !== undefined) { button.click(); return true }
    return false
  })()`)
  await sleep(500)
  // 新 profile 没有模型时 composer 会显示“请选择模型”；点开再关掉，避免遮挡。
  const modelButton = await page.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').includes('请选择模型'))
    if (button === undefined) return null
    button.scrollIntoView({ block: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (modelButton !== null) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: modelButton.x, y: modelButton.y, button: 'left', clickCount: 1, buttons: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: modelButton.x, y: modelButton.y, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(800)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(300)
  }
}

const findSessionRow = async (page, sessionId) => {
  const wantedKey = `session:${sessionId}`
  await page.eval(`(() => {
    const group = [...document.querySelectorAll('[role=treeitem]')].find((node) => node.textContent.includes('未分组'))
    if (group === undefined || group.getAttribute('aria-expanded') === 'true') return false
    group.click()
    return true
  })()`)
  await sleep(500)
  let targetInfo = null
  for (let round = 0; round < 8; round++) {
    targetInfo = await page.eval(`(() => {
      const items = [...document.querySelectorAll('[role=treeitem]')]
      const index = items.findIndex((node) => node.getAttribute('data-row-key') === ${JSON.stringify(wantedKey)})
      return {
        found: index >= 0,
        index,
        text: index >= 0 ? items[index].textContent.trim() : null,
        titles: items.map((node) => node.textContent.trim()).slice(0, 40),
        rows: document.querySelectorAll('[data-chat-flow-key]').length,
      }
    })()`)
    if (targetInfo.found) break
    const expanded = await page.eval(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('展开其余'))
      if (button === undefined) return false
      button.click()
      return true
    })()`)
    if (!expanded) break
    await sleep(500)
  }
  if (targetInfo === null || !targetInfo.found) {
    throw new Error(`session ${sessionId} not found in sidebar; titles=${JSON.stringify(targetInfo?.titles)}`)
  }
  if (targetInfo.rows > 0) {
    throw new Error(`a session is already open before the click (rows=${targetInfo.rows}); use a fresh Chrome profile`)
  }
  return { wantedKey, targetInfo }
}

const clickSession = async (page, wantedKey, targetInfo) => {
  const clickInfo = await page.eval(`(() => {
    const target = document.querySelector('[data-row-key=' + JSON.stringify(${JSON.stringify(wantedKey)}) + ']')
    if (target === null) return null
    target.scrollIntoView({ block: 'center' })
    const rect = target.getBoundingClientRect()
    const x = Math.round(rect.left + rect.width / 2)
    const y = Math.round(rect.top + rect.height / 2)
    const hit = document.elementFromPoint(x, y) ?? target
    const common = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: 1,
    }
    const pointer = (type, extra) => {
      try { hit.dispatchEvent(new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra })) } catch { /* 旧内核 */ }
    }
    pointer('pointerdown', {})
    hit.dispatchEvent(new MouseEvent('mousedown', common))
    pointer('pointerup', { buttons: 0 })
    hit.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }))
    hit.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0 }))
    return { x, y, tag: hit.tagName, text: (hit.textContent || '').trim().slice(0, 40) }
  })()`)
  if (clickInfo === null) throw new Error('target session row disappeared before click')
  await sleep(120)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickInfo.x, y: clickInfo.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickInfo.x, y: clickInfo.y, button: 'left', clickCount: 1, buttons: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickInfo.x, y: clickInfo.y, button: 'left', clickCount: 1, buttons: 0 })
  return clickInfo
}

const summarizeSamples = ({ server, clickAt, endAt, wsSamples, hostHeap, pageSamples, rendererPids }) => {
  const after = (sample) => sample.t >= clickAt
  const wsAfter = wsSamples.filter(after)
  const pageAfter = pageSamples.filter(after)
  const hostAfter = hostHeap.filter(after)
  const baselineFrom = clickAt - 2500
  const baselineWs = wsSamples.filter((sample) => sample.t >= baselineFrom && sample.t < clickAt)
  const baselineHostHeap = hostHeap.filter((sample) => sample.t >= baselineFrom && sample.t < clickAt)
  const baselinePage = pageSamples.filter((sample) => sample.t >= baselineFrom && sample.t < clickAt)

  const seriesFor = (pid) => wsAfter.filter((sample) => sample.pid === pid)
  const rendererSeries = rendererPids.map((pid) => ({ pid, samples: seriesFor(pid) }))
  const rendererGrowth = rendererSeries.map(({ pid, samples }) => {
    const baseline = median(baselineWs.filter((sample) => sample.pid === pid).map((sample) => sample.bytes))
    const peak = samples.length === 0 ? null : Math.max(...samples.map((sample) => sample.bytes))
    return { pid, baseline, peak, growth: baseline === null || peak === null ? null : peak - baseline }
  })
  const primaryGrowth = [...rendererGrowth].sort((a, b) => (b.growth ?? -1) - (a.growth ?? -1))[0]
  const primaryRenderer = rendererSeries.find((entry) => entry.pid === primaryGrowth?.pid) ?? rendererSeries[0]

  const loadingSample = pageAfter.find((sample) => sample.loading === true)
  const firstRowSample = pageAfter.find((sample) => sample.rows > 0)
  let settleSample = null
  if (firstRowSample !== undefined) {
    for (let i = 0; i < pageAfter.length; i++) {
      const sample = pageAfter[i]
      if (sample.t < firstRowSample.t) continue
      const window = pageAfter.slice(i, i + 5)
      if (window.length === 5 && window.every((entry) => entry.rows === sample.rows)) { settleSample = window[4]; break }
    }
  }

  const hostWsSeriesAll = wsAfter.filter((sample) => sample.pid === server.pid)
  const hostPeakSample = hostWsSeriesAll.reduce((best, sample) => best === null || sample.bytes > best.bytes ? sample : best, null)
  const rendererPeak = primaryRenderer.samples.reduce((best, sample) => best === null || sample.bytes > best.bytes ? sample : best, null)

  const stableWindowStart = firstRowSample === undefined ? endAt - 3000 : firstRowSample.t + 12000
  const stableWindowEnd = firstRowSample === undefined ? endAt : firstRowSample.t + 15000
  const stableHost = wsSamples.filter((sample) => sample.pid === server.pid && sample.t >= stableWindowStart && sample.t <= stableWindowEnd)
  const stableRenderer = wsSamples.filter((sample) => sample.pid === primaryRenderer.pid && sample.t >= stableWindowStart && sample.t <= stableWindowEnd)
  const stableHostHeap = hostHeap.filter((sample) => sample.t >= stableWindowStart && sample.t <= stableWindowEnd)
  const stablePage = pageSamples.filter((sample) => sample.t >= stableWindowStart && sample.t <= stableWindowEnd)
  const maxOf = (values) => values.length === 0 ? null : Math.max(...values)

  return {
    baseline: {
      hostWsMiB: round(toMiB(median(baselineWs.filter((sample) => sample.pid === server.pid).map((sample) => sample.bytes)))),
      rendererWsMiB: round(toMiB(median(baselineWs.filter((sample) => sample.pid === primaryRenderer.pid).map((sample) => sample.bytes)))),
      hostHeapMiB: round(toMiB(median(baselineHostHeap.map((sample) => sample.heapUsed)))),
      pageHeapMiB: round(toMiB(median(baselinePage.map((sample) => sample.heap).filter((value) => value !== null)))),
    },
    peak: {
      hostWsMiB: round(toMiB(hostPeakSample === null ? null : hostPeakSample.bytes)),
      rendererWsMiB: round(toMiB(rendererPeak === null ? null : rendererPeak.bytes)),
      hostHeapMiB: round(toMiB(maxOf(hostAfter.map((sample) => sample.heapUsed)))),
      pageHeapMiB: round(toMiB(maxOf(pageAfter.map((sample) => sample.heap).filter((value) => value !== null)))),
    },
    stable: {
      hostWsMiB: round(toMiB(median(stableHost.map((sample) => sample.bytes)))),
      rendererWsMiB: round(toMiB(median(stableRenderer.map((sample) => sample.bytes)))),
      hostHeapMiB: round(toMiB(median(stableHostHeap.map((sample) => sample.heapUsed)))),
      pageHeapMiB: round(toMiB(median(stablePage.map((sample) => sample.heap).filter((value) => value !== null)))),
    },
    timeline: {
      loadingMs: loadingSample === undefined ? null : loadingSample.t - clickAt,
      firstRowMs: firstRowSample === undefined ? null : firstRowSample.t - clickAt,
      settleMs: settleSample === null ? null : settleSample.t - clickAt,
      hostPeakMs: hostPeakSample === null ? null : hostPeakSample.t - clickAt,
      rendererPeakMs: rendererPeak === null ? null : rendererPeak.t - clickAt,
      hostPeakMiB: round(toMiB(hostPeakSample === null ? null : hostPeakSample.bytes)),
      rendererPeakMiB: round(toMiB(rendererPeak === null ? null : rendererPeak.bytes)),
      rowsAtEnd: pageAfter.length === 0 ? null : pageAfter[pageAfter.length - 1].rows,
      titleAtEnd: pageAfter.length === 0 ? null : pageAfter[pageAfter.length - 1].title,
    },
    rendererGrowth: rendererGrowth.map((entry) => ({ ...entry, baselineMiB: round(toMiB(entry.baseline)), peakMiB: round(toMiB(entry.peak)) })),
    firstRowAt: firstRowSample === undefined ? null : firstRowSample.t,
  }
}

// 打开一个会话并测量；结束时会关闭 Chrome，返回的 settled 缓存快照在关页后取得。
const runSession = async ({ server, inspector, sessionId, title, index, kind = 'open' }) => {
  const tag = `${kind === 'reopen' ? 'reopen' : `#${index + 1}`} ${sessionId}`
  console.log(`\n=== ${tag} ===`)
  const chromeProfile = join(outDir, `chrome-profile-${kind === 'reopen' ? 'reopen' : index}`)
  let chrome = null
  let sampler = null
  let sessionStopped = false
  let chromeClosed = false
  const shutdownChrome = async () => {
    if (chromeClosed) return
    chromeClosed = true
    sessionStopped = true
    try { sampler?.kill() } catch { /* 已退出 */ }
    await closeChrome(chrome)
  }
  try {
    chrome = await launchChrome(chromeProfile)
    const { page, browser } = chrome
    await bootPage(page, server)
    const { wantedKey, targetInfo } = await findSessionRow(page, sessionId)
    console.log(`target: ${JSON.stringify(targetInfo.text)} (index ${targetInfo.index})`)

    const processInfo = await browser.send('SystemInfo.getProcessInfo')
    const rendererPids = processInfo.processInfo.filter((entry) => entry.type === 'renderer').map((entry) => entry.id)
    if (rendererPids.length === 0) throw new Error('no Chromium renderer process found')
    console.log(`pids: host=${server.pid} renderer=${rendererPids.join(',')}`)

    const wsSamples = []
    const hostHeap = []
    const pageSamples = []
    sampler = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', join(here, 'sample-ws.ps1'),
      '-ProcessIds', [server.pid, ...rendererPids].join(','),
      '-IntervalMs', String(sampleMs),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    sampler.stderr.on('data', (chunk) => console.error(`sampler: ${chunk.toString().trim()}`))
    sampler.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const [t, pid, bytes] = line.trim().split(',')
        if (t === undefined || pid === undefined || bytes === undefined) continue
        const timestamp = Number(t)
        const processId = Number(pid)
        const value = Number(bytes)
        if (Number.isFinite(timestamp) && Number.isFinite(processId) && Number.isFinite(value)) {
          wsSamples.push({ session: sessionId, t: timestamp, pid: processId, bytes: value })
        }
      }
    })

    const collectGarbage = async () => {
      try { await inspector.send('HeapProfiler.collectGarbage') } catch { /* host GC 失败 */ }
      try { await page.send('HeapProfiler.enable'); await page.send('HeapProfiler.collectGarbage') } catch { /* 页面 GC 失败 */ }
    }
    const hostLoop = async () => {
      while (!sessionStopped) {
        try {
          const result = await inspector.send('Runtime.evaluate', {
            expression: 'process.memoryUsage()',
            returnByValue: true,
          })
          const value = result.result?.value
          if (value !== undefined) hostHeap.push({ session: sessionId, t: Date.now(), ...value })
        } catch { /* inspector 暂不可用 */ }
        await sleep(500)
      }
    }
    const pageLoop = async () => {
      while (!sessionStopped) {
        try {
          const value = await page.eval(`(() => {
            const flow = document.querySelector('[data-slot="conversation.chat.flow"]')
            const history = document.querySelector('[data-chat-history]')
            return {
              t: Date.now(),
              rows: flow === null ? 0 : flow.querySelectorAll('[data-chat-flow-key]').length,
              loading: history !== null && history.getAttribute('data-chat-history') === 'loading',
              heap: performance.memory === undefined ? null : performance.memory.usedJSHeapSize,
              title: document.title,
            }
          })()`)
          pageSamples.push({ session: sessionId, ...value })
        } catch { /* 页面切换中 */ }
        await sleep(sampleMs)
      }
    }
    void hostLoop()
    void pageLoop()

    const beforeStats = await fetchStats(server)
    const beforeBudget = budgetSnapshot(beforeStats)

    console.log(`baseline 3s...${gcMode ? ' (forced GC)' : ''}`)
    if (gcMode) { await collectGarbage(); await sleep(500) }
    await sleep(3000)
    const clickAt = Date.now()
    const clickInfo = await clickSession(page, wantedKey, targetInfo)
    console.log(`click hit: <${clickInfo.tag}> ${JSON.stringify(clickInfo.text)} @ ${clickInfo.x},${clickInfo.y}`)

    await waitFor(
      () => page.eval('document.querySelectorAll("[data-chat-flow-key]").length > 0'),
      20000,
      'first row',
    ).catch(() => {})
    const firstRows = await page.eval('document.querySelectorAll("[data-chat-flow-key]").length')
    // pageLoop 每 sampleMs 才落一个样本；等它看到首行再做窗口计算。
    let firstRowSample = null
    for (let i = 0; i < 12 && firstRowSample === null; i++) {
      firstRowSample = pageSamples.find((sample) => sample.t >= clickAt && sample.rows > 0) ?? null
      if (firstRowSample === null) await sleep(sampleMs)
    }
    console.log(`rows after open: ${firstRows}; first row after ${firstRowSample === null ? 'n/a' : `${firstRowSample.t - clickAt}ms`}`)

    let gcTimer = null
    if (gcMode) {
      const gcAt = firstRowSample === null ? clickAt + 11000 : firstRowSample.t + 11000
      gcTimer = setTimeout(() => { void collectGarbage() }, Math.max(0, gcAt - Date.now()))
    }
    const targetEnd = firstRowSample === null
      ? clickAt + durationMs
      : Math.max(clickAt + durationMs, firstRowSample.t + 16000)
    const waitMs = Math.max(0, targetEnd - Date.now())
    console.log(`sampling ${waitMs}ms...`)
    await sleep(waitMs)
    sessionStopped = true
    if (gcTimer !== null) clearTimeout(gcTimer)
    const endAt = Date.now()
    if (gcMode) { await collectGarbage(); await sleep(500) }

    const summary = summarizeSamples({ server, clickAt, endAt, wsSamples, hostHeap, pageSamples, rendererPids })
    const duringStats = await fetchStats(server)
    const duringBudget = budgetSnapshot(duringStats)
    const duringLive = await fetchDebugSessions(server)
    const cacheDelta = deltaBudget(beforeBudget, duringBudget)
    const eventsAdded = cacheDelta === null
      ? null
      : cacheDelta.cachedEvents ?? (fixtureEvents === null || cacheDelta.cachedEntries === null ? null : cacheDelta.cachedEntries * fixtureEvents)
    const retainedBytes = summary.stable.hostHeapMiB === null || summary.baseline.hostHeapMiB === null
      ? null
      : (summary.stable.hostHeapMiB - summary.baseline.hostHeapMiB) * 1048576

    if (snapshotPath !== undefined && index === sessionList.length - 1 && kind === 'open') {
      console.log(`taking heap snapshot -> ${snapshotPath}`)
      const stream = createWriteStream(snapshotPath)
      inspector.onEvent = (message) => { stream.write(message.params.chunk) }
      await inspector.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 300000)
      inspector.onEvent = null
      await new Promise((resolve) => { stream.end(resolve) })
    }

    await shutdownChrome()
    await sleep(2000)
    // 关页后再 GC 一次，区分「缓存条目」与「live Agent 仍持有的会话」：
    // 如果 live Agent 随 websocket 断开而释放，堆会在这一步下降。
    await collectGarbage().catch(() => {})
    await sleep(700)
    const afterCloseSamples = []
    for (let i = 0; i < 3; i++) {
      try {
        const result = await inspector.send('Runtime.evaluate', {
          expression: 'process.memoryUsage()',
          returnByValue: true,
        })
        const value = result.result?.value?.heapUsed
        if (value !== undefined) afterCloseSamples.push(value)
      } catch { /* inspector 暂不可用 */ }
      await sleep(200)
    }
    const afterCloseHeap = median(afterCloseSamples)
    const settledStats = await fetchStats(server)
    const settledBudget = budgetSnapshot(settledStats)
    const afterLive = await fetchDebugSessions(server)
    const liveSnapshot = (state) => state === null ? null : {
      agents: state.agents?.length ?? null,
      sessions: state.sessions?.length ?? null,
      targetAgentLive: state.agents?.some((agent) => agent.id === sessionId) ?? null,
      targetSessionLive: state.sessions?.some((session) => session.id === sessionId) ?? null,
      observationEntries: state.observationCache?.entries?.length ?? null,
    }

    return {
      kind,
      sessionId,
      title,
      index,
      firstSession: kind === 'open' && index === 0,
      clickAt,
      endAt,
      baseline: summary.baseline,
      peak: summary.peak,
      stable: summary.stable,
      timeline: summary.timeline,
      rendererGrowth: summary.rendererGrowth,
      rowsAtEnd: summary.timeline.rowsAtEnd,
      cache: {
        before: beforeBudget,
        during: duringBudget,
        settled: settledBudget,
        delta: cacheDelta,
        eventsAdded,
        retainedMiB: round(summary.stable.hostHeapMiB === null || summary.baseline.hostHeapMiB === null ? null : summary.stable.hostHeapMiB - summary.baseline.hostHeapMiB),
        afterCloseHeapMiB: round(toMiB(afterCloseHeap)),
        releasedOnCloseMiB: round(summary.stable.hostHeapMiB === null || afterCloseHeap === null ? null : summary.stable.hostHeapMiB - toMiB(afterCloseHeap)),
        actualBytesPerEvent: retainedBytes === null || eventsAdded === null || eventsAdded <= 0 ? null : round(retainedBytes / eventsAdded),
        liveDuring: liveSnapshot(duringLive),
        liveAfterClose: liveSnapshot(afterLive),
      },
      rawSamples: { wsSamples, hostHeap, pageSamples },
    }
  } finally {
    await shutdownChrome().catch((error) => console.error(`chrome shutdown: ${String(error?.message ?? error)}`))
  }
}

let server = null
let inspector = null
try {
  for (const [name, value] of [['dsh', port], ['prep', prepPort], ['inspector', debugPort], ['chrome', chromePort]]) {
    if (!(await waitPortFree(value, 1000))) throw new Error(`${name} port ${value} is in use`)
  }

  // ---- 0. 准备会话：独立进程 rename，再清空投影缓存 ----
  console.log(`preparing ${sessionList.length} session(s)...`)
  const prep = await startDsh({ home, agentsHome, profile, port: prepPort, outDir })
  try {
    const client = makeClient({ origin: prep.origin, token: prep.token })
    await client.connect()
    for (let i = 0; i < sessionList.length; i++) {
      await client.rpc('session', 'rename', { sessionId: sessionList[i], title: titleFor(sessionList[i], i) })
      await sleep(300)
    }
  } finally {
    await prep.stop()
  }
  const cleared = await clearProjectionCache(home)
  console.log(`projection cache cleared: ${cleared.cleared} file(s)`)

  // ---- 1. 起测量用 dsh（Node inspector 暴露 host heap） ----
  server = await startDsh({
    home, agentsHome, profile, port, outDir,
    nodeArgs: [`--inspect=127.0.0.1:${debugPort}`],
    extraEnv: {
      DEEPSEEK_API_KEY: 'sk-dummy-memory-probe',
      DSH_PERF_DEBUG_API: 'true',
      ...(maxInitial === undefined ? {} : { DSH_PERF_MAX_INITIAL_MESSAGES: maxInitial }),
      ...(budgetBytes === undefined ? {} : { DSH_PERF_MEMORY_BUDGET_BYTES: String(budgetBytes) }),
    },
    readyTimeoutMs: 120000,
  })
  console.log(`dsh ready: ${server.origin}`)

  const inspectorInfo = await waitFor(
    () => httpJson(`http://127.0.0.1:${debugPort}/json/list`)
      .then((list) => list.find((target) => typeof target.webSocketDebuggerUrl === 'string')),
    15000,
    'node inspector',
  )
  inspector = await Cdp.connect(inspectorInfo.webSocketDebuggerUrl, 'inspector')
  await inspector.send('Runtime.enable')
  await inspector.send('HeapProfiler.enable')
  const heapProbe = await inspector.send('Runtime.evaluate', {
    expression: 'process.memoryUsage()',
    returnByValue: true,
  })
  if (heapProbe.result?.value === undefined) throw new Error('node inspector cannot evaluate process.memoryUsage()')

  // ---- 2. 依次打开每个会话 ----
  const results = []
  for (let i = 0; i < sessionList.length; i++) {
    const result = await runSession({
      server, inspector, sessionId: sessionList[i], title: titleFor(sessionList[i], i), index: i,
    })
    results.push(result)
    console.log(`done ${sessionList[i]}: stable host heap ${result.stable.hostHeapMiB} MiB, cache ${JSON.stringify(result.cache.during)}`)
  }

  let reopen = null
  if (reopenId !== null) {
    const index = sessionList.indexOf(reopenId)
    reopen = await runSession({
      server, inspector, sessionId: reopenId, title: titleFor(reopenId, index), index, kind: 'reopen',
    })
    console.log(`reopen ${reopenId}: firstRow ${reopen.timeline.firstRowMs}ms, cache ${JSON.stringify(reopen.cache.during)}`)
  }

  const projectionCache = await fetchProjectionCache(server)
  console.log('projection cache probe:', JSON.stringify(projectionCache).slice(0, 800))

  // ---- 3. 汇总 ----
  const finalStats = await fetchStats(server)
  const allSamples = { wsSamples: [], hostHeap: [], pageSamples: [] }
  for (const result of [...results, ...(reopen === null ? [] : [reopen])]) {
    allSamples.wsSamples.push(...result.rawSamples.wsSamples)
    allSamples.hostHeap.push(...result.rawSamples.hostHeap)
    allSamples.pageSamples.push(...result.rawSamples.pageSamples)
  }
  const stripped = (result) => {
    const { rawSamples, ...rest } = result
    return rest
  }
  const summary = {
    meta: {
      startedAt: new Date().toISOString(),
      label,
      home,
      port,
      profile,
      dshVersion: finalStats?.dshVersion ?? dshVersion,
      sessions: sessionList,
      titles: sessionList.map((id, i) => titleFor(id, i)),
      reopen: reopenId,
      budgetBytes: budgetBytes ?? null,
      budgetFromStats: finalStats?.memoryBudget?.budgetBytes ?? null,
      fixtureEvents,
      sampleMs,
      durationMs,
      gc: gcMode,
      maxInitial: maxInitial ?? null,
      baselineWindowMs: 2500,
      stableWindow: 'firstRow + 12–15s',
      cacheCleared: cleared.cleared,
      finalCache: budgetSnapshot(finalStats),
      patches: finalStats?.patches ?? null,
      projectionCache,
    },
    sessions: results.map(stripped),
    reopen: reopen === null ? null : stripped(reopen),
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ summary, ...allSamples }, null, 2))

  const line = (cells) => `| ${cells.join(' | ')} |`
  const rows = summary.sessions.map((session, index) => line([
    String(index + 1),
    `\`${session.sessionId}\``,
    `${session.baseline.hostHeapMiB}`,
    `${session.stable.hostHeapMiB}`,
    `**${session.cache.retainedMiB}**`,
    `${session.cache.during?.cachedEntries ?? '—'}`,
    `${session.cache.during?.cachedEvents ?? '—'}`,
    `${session.cache.during?.estimatedBytes ?? '—'}`,
    `${session.cache.delta?.trimmed ?? '—'}`,
    `${session.timeline.firstRowMs}`,
  ]))
  const reopenRows = summary.reopen === null ? [] : [
    '',
    '## C. 重开（关闭全部页面之后）',
    '',
    line(['会话', '点击前缓存条目', '稳定后缓存条目', '首行 ms', '重建条目']),
    line(['---', '---:', '---:', '---:', '---:']),
    line([
      `\`${summary.reopen.sessionId}\``,
      `${summary.reopen.cache.before?.cachedEntries ?? '—'}`,
      `${summary.reopen.cache.during?.cachedEntries ?? '—'}`,
      `${summary.reopen.timeline.firstRowMs}`,
      `${summary.reopen.cache.delta?.cachedEntries ?? '—'}`,
    ]),
  ]
  const projectionLines = summary.meta.projectionCache?.status === 200 && summary.meta.projectionCache.body?.ok
    ? [
        '',
        '## D. 投影缓存行（只读探针）',
        '',
        `- rows：**${summary.meta.projectionCache.body.value.rows}**，JSON 字节：**${summary.meta.projectionCache.body.value.bytes}**`,
        ...summary.meta.projectionCache.body.value.top.slice(0, 8).map((entry) => `  - \`${entry.id}\`：${entry.bytes} B`),
      ]
    : []
  const markdown = [
    `# Web 打开多个超长会话：内存与缓存（${label}）`,
    '',
    `- 会话：${sessionList.map((id) => `\`${id}\``).join('、')}`,
    `- dsh：${summary.meta.dshVersion}　预算：${summary.meta.budgetFromStats ?? summary.meta.budgetBytes ?? '默认'}`,
    `- 采样：${sampleMs} ms / 点；强制 GC：${gcMode ? '是' : '否'}；每会话 fresh Chrome profile`,
    `- 单位：MiB（Windows Working Set / JS heap）；“增量”= 稳定 − 点击前`,
    '',
    '## A. 逐会话',
    '',
    line(['#', '会话', '点击前 Host 堆', '稳定 Host 堆', '增量', '缓存条目', '缓存事件', 'estimatedBytes', '淘汰', '首行 ms']),
    line(['---:', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
    ...rows,
    '',
    '## B. 关页后的缓存快照',
    '',
    line(['会话', 'entries', 'events', 'estimatedBytes', 'memoEntries', 'memoBytes', 'trimmed', 'freedBytes']),
    line(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
    ...summary.sessions.map((session) => line([
      `\`${session.sessionId}\``,
      `${session.cache.settled?.cachedEntries ?? '—'}`,
      `${session.cache.settled?.cachedEvents ?? '—'}`,
      `${session.cache.settled?.estimatedBytes ?? '—'}`,
      `${session.cache.settled?.memoEntries ?? '—'}`,
      `${session.cache.settled?.memoBytes ?? '—'}`,
      `${session.cache.settled?.trimmed ?? '—'}`,
      `${session.cache.settled?.freedBytes ?? '—'}`,
    ])),
    ...reopenRows,
    ...projectionLines,
    '',
    '> 说明：每会话关闭 Chrome 后再取 settled 快照，因此 `cachedEntries` 反映 lease 释放后的结果。',
    '> 首个会话的“增量”含 dsh 首次装载 sessionQuery / projections 的一次性模块成本；从第 2 个起才是纯保留量。',
    '> `actualBytesPerEvent` = 增量字节 ÷ 新增缓存事件数，可在 report.json 的 `cache` 字段查看。',
    '',
  ].join('\n')
  writeFileSync(join(outDir, 'report.md'), markdown)
  console.log(`\nwrote ${join(outDir, 'report.json')} and report.md`)
  console.log(JSON.stringify(summary.meta, null, 2))
} finally {
  try { inspector?.close() } catch { /* 已关闭 */ }
  if (server !== null) await server.stop()
}
