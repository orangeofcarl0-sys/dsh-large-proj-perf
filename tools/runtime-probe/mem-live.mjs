// Live Session 状态机探针：cache-only → live → after-close → action → reopen。
//
// 与 mem-open 的区别：不追求 5 会话/峰值，而是固定同一个会话，把
// "cache 条目 / live Session / live Agent / 关页后 / 驱逐后" 拆成可对照的状态。
// 需要 dsh 侧打开 debugApi + debugAgentHandles（后者只在隔离 profile 用）。
//
//   node tools/runtime-probe/mem-live.mjs \
//     --home F:/dsh-rt/<stamp>/home --agents ... \
//     --session session-mem-probe-91k-1 \
//     --action dispose --out F:/dsh-rt/<stamp>/mem-live/dispose \
//     --snapshot-dir F:/dsh-rt/<stamp>/mem-live/dispose

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, createWriteStream, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
const sessionId = arg('session', 'session-mem-probe-91k-1')
const outDir = arg('out', join(home, '..', 'mem-live'))
const snapshotDir = arg('snapshot-dir', undefined)
const snapshotStatesArg = arg('snapshot-states', undefined)
const snapshotStates = snapshotStatesArg === undefined ? null : new Set(snapshotStatesArg.split(',').map((value) => value.trim()))
const action = arg('action', 'control')
if (!['control', 'dispose', 'detach', 'trim'].includes(action)) {
  console.error('--action must be control|dispose|detach|trim')
  process.exit(2)
}
const keepEvents = Number(arg('keep-events', '8000'))
const clearCache = process.argv.includes('--clear-cache')
const profile = arg('profile', 'rt')
const port = Number(arg('port', '3320'))
const prepPort = Number(arg('prep-port', String(port + 11)))
const debugPort = Number(arg('debug-port', '9230'))
const chromePort = Number(arg('chrome-port', '9223'))
const durationMs = Number(arg('duration-ms', '22000'))
const dshVersion = (() => {
  try { return JSON.parse(readFileSync(DSH_PKG, 'utf8')).version } catch { return null }
})()
mkdirSync(outDir, { recursive: true })
if (snapshotDir !== undefined) mkdirSync(snapshotDir, { recursive: true })

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
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined) throw new Error(`${this.label}: ${result.exceptionDetails.text ?? 'evaluate failed'}`)
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

const pluginApi = async (server, method) => {
  const response = await fetch(`${server.origin}/dsh-large-proj-perf/api/${method}`, { method: 'POST' })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.ok !== true) throw new Error(`${method} HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`)
  return body.value
}

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
  try {
    const version = await waitFor(() => httpJson(`http://127.0.0.1:${chromePort}/json/version`), 20000, 'chrome debug endpoint')
    const pageInfo = await waitFor(
      () => httpJson(`http://127.0.0.1:${chromePort}/json/list`).then((list) => list.find((target) => target.type === 'page')),
      15000,
      'chrome page target',
    )
    const page = await Cdp.connect(pageInfo.webSocketDebuggerUrl, 'page')
    const browser = await Cdp.connect(version.webSocketDebuggerUrl, 'browser')
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Page.bringToFront')
    return { child, version, page, browser }
  } catch (error) {
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
  await waitPortFree(chromePort, 15000)
}

const bootPage = async (page, server) => {
  await page.send('Page.navigate', { url: server.readyUrl })
  await waitFor(
    () => page.eval('document.readyState === "complete" && document.querySelectorAll("[role=treeitem]").length > 0'),
    40000,
    'dsh web app',
  )
  await sleep(1500)
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
  await page.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('展开其余'))
    if (button !== undefined) { button.click(); return true }
    return false
  })()`)
  await sleep(500)
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

const clickSession = async (page, sessionId) => {
  const wantedKey = `session:${sessionId}`
  await page.eval(`(() => {
    const group = [...document.querySelectorAll('[role=treeitem]')].find((node) => node.textContent.includes('未分组'))
    if (group === undefined || group.getAttribute('aria-expanded') === 'true') return false
    group.click()
    return true
  })()`)
  await sleep(500)
  let target = null
  for (let round = 0; round < 10; round++) {
    target = await page.eval(`(() => {
      const items = [...document.querySelectorAll('[role=treeitem]')]
      const index = items.findIndex((node) => node.getAttribute('data-row-key') === ${JSON.stringify(wantedKey)})
      return { found: index >= 0, index, rows: document.querySelectorAll('[data-chat-flow-key]').length }
    })()`)
    if (target.found) break
    const expanded = await page.eval(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('展开其余'))
      if (button === undefined) return false
      button.click()
      return true
    })()`)
    if (!expanded) break
    await sleep(500)
  }
  if (target === null || !target.found) throw new Error(`session ${sessionId} not found in sidebar`)
  if (target.rows > 0) throw new Error(`a session is already open (rows=${target.rows}); fresh profile expected`)
  const clicked = await page.eval(`(() => {
    const target = document.querySelector('[data-row-key=' + JSON.stringify(${JSON.stringify(wantedKey)}) + ']')
    if (target === null) return null
    target.scrollIntoView({ block: 'center' })
    const rect = target.getBoundingClientRect()
    const x = Math.round(rect.left + rect.width / 2)
    const y = Math.round(rect.top + rect.height / 2)
    const hit = document.elementFromPoint(x, y) ?? target
    const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 }
    hit.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    hit.dispatchEvent(new MouseEvent('mousedown', common))
    hit.dispatchEvent(new PointerEvent('pointerup', { ...common, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    hit.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }))
    hit.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0 }))
    return { x, y }
  })()`)
  if (clicked === null) throw new Error('session row disappeared')
  await sleep(120)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clicked.x, y: clicked.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clicked.x, y: clicked.y, button: 'left', clickCount: 1, buttons: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clicked.x, y: clicked.y, button: 'left', clickCount: 1, buttons: 0 })
  const started = Date.now()
  await waitFor(
    () => page.eval('document.querySelectorAll("[data-chat-flow-key]").length > 0'),
    20000,
    'first row',
  ).catch(() => {})
  const rows = await page.eval('document.querySelectorAll("[data-chat-flow-key]").length')
  return { rows, firstRowMs: Date.now() - started }
}

const openWeb = async (server, stateLabel) => {
  const chrome = await launchChrome(join(outDir, `chrome-profile-${stateLabel}`))
  try {
    await bootPage(chrome.page, server)
    const click = await clickSession(chrome.page, sessionId)
    // 让首屏窗口/投影落定；与 mem-open 的稳定窗口保持同一量级。
    await sleep(Math.max(3000, durationMs - click.firstRowMs))
    return { chrome, click }
  } catch (error) {
    await closeChrome(chrome)
    throw error
  }
}

let server = null
let inspector = null
let chrome = null
try {
  for (const [name, value] of [['dsh', port], ['prep', prepPort], ['inspector', debugPort], ['chrome', chromePort]]) {
    if (!(await waitPortFree(value, 1000))) throw new Error(`${name} port ${value} is in use`)
  }

  // 准备：独立进程 rename + 清投影缓存。
  console.log('preparing session...')
  const prep = await startDsh({ home, agentsHome, profile, port: prepPort, outDir })
  try {
    const client = makeClient({ origin: prep.origin, token: prep.token })
    await client.connect()
    await client.rpc('session', 'rename', { sessionId, title: sessionId })
    await sleep(400)
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
      DSH_PERF_DEBUG_AGENT_HANDLES: 'true',
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
    const result = await inspector.send('Runtime.evaluate', { expression: 'process.memoryUsage()', returnByValue: true })
    return result.result?.value ?? null
  }
  const gcHost = async () => {
    try { await inspector.send('HeapProfiler.collectGarbage') } catch { /* ignore */ }
  }
  const gcAll = async () => {
    await gcHost()
    if (chrome !== null) {
      try { await chrome.page.send('HeapProfiler.enable'); await chrome.page.send('HeapProfiler.collectGarbage') } catch { /* ignore */ }
    }
  }
  const snapshot = async (label) => {
    if (snapshotDir === undefined) return null
    const file = join(snapshotDir, `snapshot-${label}.heapsnapshot`)
    console.log(`snapshot ${label} -> ${file}`)
    const stream = createWriteStream(file)
    inspector.onEvent = (message) => stream.write(message.params.chunk)
    await inspector.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 300000)
    inspector.onEvent = null
    await new Promise((resolve) => stream.end(resolve))
    return file
  }
  const capture = async (label) => {
    await gcAll()
    await sleep(700)
    const samples = []
    for (let i = 0; i < 3; i++) {
      const value = await heapUsed()
      if (value !== null) samples.push(value.heapUsed)
      await sleep(200)
    }
    const heap = median(samples)
    const [sessions, heapStats] = await Promise.all([
      pluginApi(server, 'debug.sessions'),
      pluginApi(server, 'debug.heap'),
    ])
    const file = snapshotDir === undefined || (snapshotStates !== null && !snapshotStates.has(label))
      ? null
      : await snapshot(label)
    const state = {
      label,
      heapMiB: round(toMiB(heap)),
      rssMiB: round(toMiB(heapStats.process?.rss)),
      agents: sessions.agents,
      sessions: sessions.sessions,
      observationCache: sessions.observationCache,
      coldLogMemo: sessions.coldLogMemo,
      snapshot: file,
    }
    console.log(`${label}: heap=${state.heapMiB} MiB agents=${state.agents.length} sessions=${state.sessions.length} cache=${state.observationCache.entries.length}`)
    return state
  }

  // ---- 1. cache-only ----
  const states = []
  await client.rpc('session', 'projections', { sessionId })
  await client.rpc('session', 'events', { address: { kind: 'session', sessionId }, maxMessages: 50 })
  await sleep(1000)
  states.push(await capture('cache-only'))

  // ---- 2. live + cache ----
  const liveOpen = await openWeb(server, 'live')
  chrome = liveOpen.chrome
  states.push(await capture('live'))

  // ---- 3. after close ----
  await closeChrome(chrome)
  chrome = null
  await sleep(2000)
  states.push(await capture('after-close'))

  // ---- 4. action ----
  let actionResult = null
  if (action === 'control') {
    actionResult = { action, skipped: true }
  } else if (action === 'dispose') {
    actionResult = await inspector.eval(`globalThis.__dshPerfProbe.dispose(${JSON.stringify(sessionId)}, ${JSON.stringify({ clearCache })})`)
  } else if (action === 'detach') {
    actionResult = await inspector.eval(`globalThis.__dshPerfProbe.detach(${JSON.stringify(sessionId)})`)
  } else if (action === 'trim') {
    actionResult = await inspector.eval(`globalThis.__dshPerfProbe.trim(${JSON.stringify(sessionId)}, ${JSON.stringify({ keepEvents, clearDerived: true, clearCache })})`)
  }
  await sleep(1500)
  states.push(await capture('after-action'))

  // ---- 5. reopen ----
  let reopen = null
  try {
    const opened = await openWeb(server, 'reopen')
    chrome = opened.chrome
    reopen = { firstRowMs: opened.click.firstRowMs, rows: opened.click.rows }
    states.push(await capture('reopened'))
  } catch (error) {
    reopen = { error: String(error?.message ?? error) }
  }

  const summary = {
    meta: {
      startedAt: new Date().toISOString(),
      sessionId,
      action,
      keepEvents: action === 'trim' ? keepEvents : null,
      clearCache: action === 'trim' || action === 'dispose' ? clearCache : null,
      dshVersion: dshVersion,
      home,
      port,
      cacheCleared: cleared.cleared,
    },
    states,
    actionResult,
    reopen,
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(summary, null, 2))

  const line = (cells) => `| ${cells.join(' | ')} |`
  const markdown = [
    `# Live Session 状态探针（${action}）`,
    '',
    `- 会话：\`${sessionId}\`　dsh：${dshVersion}`,
    `- 动作：\`${action}\`${action === 'trim' ? `（keepEvents=${keepEvents}）` : ''}`,
    '',
    line(['状态', 'Host heap MiB', 'RSS MiB', 'agents', 'sessions', 'cache entries', 'cache refs', 'memo entries']),
    line(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
    ...states.map((state) => line([
      state.label,
      state.heapMiB,
      state.rssMiB,
      state.agents.length,
      state.sessions.length,
      state.observationCache.entries.length,
      state.observationCache.entries.reduce((sum, entry) => sum + (entry.refs ?? 0), 0),
      state.coldLogMemo.entries.length,
    ])),
    '',
    '## 每会话字段',
    '',
    ...states.flatMap((state) => [
      `### ${state.label}`,
      '',
      state.sessions.length === 0 ? '无 live Session。' : line(['id', 'seq', 'logEvents', 'snapshot', 'derived']) + '\n' + line(['---', '---:', '---:', '---:', '---:']) + '\n' + state.sessions.map((session) => line([
        `\`${session.id}\``,
        session.seq,
        session.logEvents,
        session.hasEventsSnapshot,
        session.derivedMessages,
      ])).join('\n'),
      '',
    ]),
    '## 动作结果',
    '',
    `\`\`\`json\n${JSON.stringify(actionResult, null, 2)}\n\`\`\``,
    '',
    '## 重开',
    '',
    `\`\`\`json\n${JSON.stringify(reopen, null, 2)}\n\`\`\``,
  ].join('\n')
  writeFileSync(join(outDir, 'report.md'), markdown)
  console.log(`\nwrote ${join(outDir, 'report.json')} and report.md`)
  console.log(JSON.stringify({ states: states.map((s) => ({ label: s.label, heap: s.heapMiB, agents: s.agents.length, sessions: s.sessions.length, cache: s.observationCache.entries.length })), actionResult, reopen }, null, 2))
} finally {
  try { inspector?.close() } catch { /* 已关闭 */ }
  await closeChrome(chrome).catch(() => {})
  if (server !== null) await server.stop()
}
