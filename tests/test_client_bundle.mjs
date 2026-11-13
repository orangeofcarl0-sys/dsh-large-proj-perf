// v1.16 测试：客户端 bundle 的装载契约与生命周期对称性。
//
// 为什么需要它：`lib/client.js` 是经典脚本（不是 ESM），没有构建步骤，也没法在
// Node 里直接 import。浏览器冒烟只能证明「能用」，证明不了「关掉之后有没有残留」。
// 这里用 node:vm + 假 DOM 把 bundle 跑起来，逐项检查：
//
//   1. bundle 能被解析、注册 id、factory 不抛；
//   2. config 关闭时，采集设施（窗口/observer/监听器/__dshPerf*）全部拆干净，
//      且不碰应用的 `$stream`；
//   3. config 开启时，`$stream` 与 socket.send 被包裹；`stop()` 后**逐函数还原**，
//      highlighter 的 React root 被卸载，监听器全撤；
//   4. stop 之后再次 apply 能重装（幂等标志复位）。
//
// 只依赖 Node 内置模块：评审者 clone + npm install 就能跑，不需要 dsh 安装。

import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---- 假 DOM ----

function makeElement(tag) {
  const listeners = new Map()
  const el = {
    tagName: tag,
    children: [],
    parentNode: null,
    style: {},
    attributes: {},
    isConnected: true,
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 720,
    setAttribute(key, value) { el.attributes[key] = String(value) },
    getAttribute(key) { return Object.prototype.hasOwnProperty.call(el.attributes, key) ? el.attributes[key] : null },
    removeAttribute(key) { delete el.attributes[key] },
    hasAttribute(key) { return Object.prototype.hasOwnProperty.call(el.attributes, key) },
    appendChild(child) { el.children.push(child); child.parentNode = el; return child },
    removeChild(child) {
      const index = el.children.indexOf(child)
      if (index >= 0) el.children.splice(index, 1)
      if (child.parentNode === el) child.parentNode = null
      return child
    },
    querySelector() { return null },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { top: 0, bottom: 0 } },
    click() {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type)
      if (set !== undefined) set.delete(fn)
    },
    listenerCount(type) { return type === undefined ? [...listeners.values()].reduce((n, set) => n + set.size, 0) : (listeners.get(type)?.size ?? 0) },
  }
  return el
}

function createHarness({ config }) {
  const state = {
    styleEl: null,
    flows: [],
    observers: [],
    perfObservers: [],
    roots: [],
    unmounted: 0,
    fetchCalls: [],
    sent: [],
  }

  const documentElement = makeElement('html')
  const head = makeElement('head')
  const windowListeners = new Map()
  const windowObject = {
    __ModuleLoader__: { load(entry) { state.entry = entry } },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set())
      windowListeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      const set = windowListeners.get(type)
      if (set !== undefined) set.delete(fn)
    },
  }

  const document = {
    documentElement,
    head,
    createElement(tag) {
      const el = makeElement(tag)
      if (tag === 'style') el.setAttribute('data-dsh-perf-style', '')
      return el
    },
    querySelector(selector) {
      if (selector === 'style[data-dsh-perf-style]') return state.styleEl !== null && state.styleEl.parentNode !== null ? state.styleEl : null
      if (selector === '[data-conversation-scroll]') return null
      if (selector === '[data-chat-history]') return null
      if (selector === 'nav') return null
      if (selector.startsWith('[data-chat-turn=')) return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-slot="conversation.chat.flow"]') return state.flows
      return []
    },
  }

  // installContainment 的 style 节点要能被 querySelector 找到并 removeChild。
  const originalAppend = head.appendChild.bind(head)
  head.appendChild = (child) => {
    if (child.tagName === 'style') state.styleEl = child
    return originalAppend(child)
  }

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.observed = false; this.disconnected = false; this.options = null; state.observers.push(this) }
    observe(target, options) { this.observed = true; this.options = options ?? null }
    disconnect() { this.disconnected = true }
    takeRecords() { return [] }
  }
  class FakePerformanceObserver {
    constructor(callback) { this.callback = callback; this.observed = false; this.disconnected = false; state.perfObservers.push(this) }
    observe() { this.observed = true }
    disconnect() { this.disconnected = true }
  }

  const rafQueue = []
  const sandbox = {
    window: windowObject,
    document,
    MutationObserver: FakeMutationObserver,
    PerformanceObserver: FakePerformanceObserver,
    performance: {
      now: () => Date.now(),
      memory: { usedJSHeapSize: 64 * 1048576 },
      getEntriesByType: () => [{ duration: 1234 }],
    },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length },
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    fetch: async (url, init) => {
      state.fetchCalls.push({ url, body: String(init?.body ?? '') })
      return { ok: true, json: async () => ({ ok: true, value: config }) }
    },
    console,
    URL,
  }
  sandbox.globalThis = sandbox
  const context = createContext(sandbox)
  runInContext(SOURCE, context, { filename: 'client.js' })

  const entry = state.entry
  const rootModule = {
    id: entry.id,
    factory: (require) => entry.factory(require),
  }

  const makeRemote = (options = {}) => {
    const socketListeners = new Map()
    const socket = {
      addEventListener(type, fn) {
        if (options.socketThrows === true) throw new Error('socket closed')
        if (!socketListeners.has(type)) socketListeners.set(type, new Set())
        socketListeners.get(type).add(fn)
      },
      removeEventListener(type, fn) {
        const set = socketListeners.get(type)
        if (set !== undefined) set.delete(fn)
      },
      send(data) { state.sent.push(data) },
      listenerCount() { return [...socketListeners.values()].reduce((n, set) => n + set.size, 0) },
    }
    const remote = {
      streams: { socket },
      $stream(options) { return { original: true, options } },
    }
    return { remote, socket, originalStream: remote.$stream }
  }

  const primitives = {
    MarkdownText: function MarkdownText() { return null },
    FenceMathBlock: function FenceMathBlock() { return null },
    extractMarkdownPlainText: (text) => text,
    useCodeHighlighter: () => function highlight(code) { return [code] },
  }
  const React = { createElement: (type, props) => ({ type, props }), memo: (component) => component }
  const ReactDOM = { flushSync: (fn) => fn() }
  const ReactDOMClient = {
    createRoot() {
      const root = { renders: 0, render() { root.renders++ }, unmount() { state.unmounted++ } }
      state.roots.push(root)
      return root
    },
  }
  const modules = {
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    react: React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
  }
  const requireStub = (name) => {
    if (!Object.prototype.hasOwnProperty.call(modules, name)) throw new Error(`unexpected module ${name}`)
    return modules[name]
  }

  const windowListenerCount = () => [...windowListeners.values()].reduce((n, set) => n + set.size, 0)
  const hasWindowListener = (type) => (windowListeners.get(type)?.size ?? 0) > 0
  const dispatchWindow = (type) => {
    const set = windowListeners.get(type)
    if (set !== undefined) for (const fn of [...set]) fn({ type })
  }

  return {
    state, document, windowObject, rootModule, requireStub,
    makeRemote, windowListenerCount, hasWindowListener, dispatchWindow,
    apply(configModule = rootModule) {
      const host = this
      const ctx = {
        get(name) { return name === 'remote' ? host.remote : undefined },
      }
      return configModule.factory(requireStub).apply(ctx)
    },
    attach(remoteBundle) {
      this.remote = remoteBundle.remote
      this.socket = remoteBundle.socket
      this.originalStream = remoteBundle.originalStream
      this.originalSend = remoteBundle.socket.send
    },
  }
}

// ---- 1. bundle 注册 ----
{
  const h = createHarness({ config: { renderTiming: false, clientContainment: false } })
  check('bundle: registers the package id', h.rootModule.id === 'dsh-large-proj-perf', h.rootModule.id)
  let mod = null
  let threw = null
  try { mod = h.rootModule.factory(h.requireStub) } catch (error) { threw = error }
  check('bundle: factory does not throw', threw === null, String(threw?.message ?? ''))
  check('bundle: exposes inject/apply', Array.isArray(mod?.inject) && typeof mod?.apply === 'function')
  check('bundle: injects remote', Array.isArray(mod?.inject) && mod.inject.includes('remote'))
}

// ---- 2. config 关闭：一切拆干净，且不碰 $stream ----
{
  const h = createHarness({ config: { renderTiming: false, clientContainment: false } })
  const remoteBundle = h.makeRemote()
  h.attach(remoteBundle)
  h.apply()
  await settle()

  check('off: __dshPerf removed', h.windowObject.__dshPerf === undefined)
  check('off: __dshPerfEmit removed', h.windowObject.__dshPerfEmit === undefined)
  check('off: idempotency flag reset', h.windowObject.__dshPerfClient === false)
  check('off: $stream untouched', h.remote.$stream === h.originalStream)
  check('off: socket.send untouched', h.socket.send === h.originalSend)
  check('off: socket listener removed', h.socket.listenerCount() === 0, String(h.socket.listenerCount()))
  check('off: window listeners removed', h.windowListenerCount() === 0, String(h.windowListenerCount()))
  check('off: mutation observers disconnected', h.state.observers.every((observer) => observer.disconnected))
  check('off: performance observers disconnected', h.state.perfObservers.every((observer) => observer.disconnected))
  check('off: no highlighter root created', h.state.roots.length === 0, String(h.state.roots.length))
}

// ---- 2b. config 关闭 + containment 开：两条开关互不牵连 ----
{
  const h = createHarness({ config: { renderTiming: false, clientContainment: true } })
  const flow = makeElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  for (let i = 0; i < 120; i++) {
    const row = makeElement('div')
    row.setAttribute('data-chat-flow-key', 'k' + i)
    flow.appendChild(row)
  }
  h.state.flows.push(flow)
  h.attach(h.makeRemote())
  h.apply()
  await settle()

  check('off+containment: style stays injected', h.state.styleEl !== null && h.state.styleEl.parentNode !== null)
  check('off+containment: dense attribute applied', flow.getAttribute('data-dsh-perf-dense') !== null)
  // 两个 observer 的 observe 选项不同：containment 只看 childList/subtree，
  // 窗口还要监听 data-chat-history 的属性变化。
  const containmentObserver = h.state.observers.find((observer) => observer.options?.attributes !== true)
  const windowObserver = h.state.observers.find((observer) => observer.options?.attributes === true)
  check('off+containment: containment observer stays connected', containmentObserver?.disconnected === false)
  check('off+containment: window observer disconnected', windowObserver?.disconnected === true)
  check('off+containment: window listeners still removed', h.windowListenerCount() === 0, String(h.windowListenerCount()))
}

// ---- 3. config 开启：包裹 → stop 还原 ----
{
  const h = createHarness({ config: { renderTiming: true, clientContainment: false } })
  const remoteBundle = h.makeRemote()
  h.attach(remoteBundle)
  h.apply()
  await settle()

  check('on: __dshPerf exposed', h.windowObject.__dshPerf !== undefined)
  check('on: $stream wrapped', h.remote.$stream !== h.originalStream)
  check('on: socket.send wrapped', h.socket.send !== h.originalSend)
  check('on: socket listener attached', h.socket.listenerCount() === 1, String(h.socket.listenerCount()))
  check('on: highlighter root mounted', h.state.roots.length === 1, String(h.state.roots.length))
  const state = h.windowObject.__dshPerf.state()
  check('on: state() reports streams', state.streamsAvailable === true && state.streamsReason === null)
  check('on: state() reports timing on', state.timing === true)

  h.windowObject.__dshPerf.stop()

  check('stop: $stream restored to the exact original', h.remote.$stream === h.originalStream)
  check('stop: socket.send restored to the exact original', h.socket.send === h.originalSend)
  check('stop: socket listener removed', h.socket.listenerCount() === 0, String(h.socket.listenerCount()))
  check('stop: window listeners removed', h.windowListenerCount() === 0, String(h.windowListenerCount()))
  check('stop: highlighter root unmounted', h.state.unmounted === 1, String(h.state.unmounted))
  check('stop: mutation observer disconnected', h.state.observers.every((observer) => observer.disconnected))
  check('stop: performance observers disconnected', h.state.perfObservers.every((observer) => observer.disconnected))
  check('stop: __dshPerf removed', h.windowObject.__dshPerf === undefined)
  check('stop: __dshPerfEmit removed', h.windowObject.__dshPerfEmit === undefined)
  check('stop: idempotency flag reset', h.windowObject.__dshPerfClient === false)

  // stop 之后可以重装（页面内模块被重新物化时）。
  h.apply()
  await settle()
  check('re-apply: __dshPerf exposed again', h.windowObject.__dshPerf !== undefined)
  check('re-apply: $stream wrapped again', h.remote.$stream !== h.originalStream)
  h.windowObject.__dshPerf.stop()
}

// ---- 4. 重复 apply 幂等 ----
{
  const h = createHarness({ config: { renderTiming: true, clientContainment: false } })
  h.attach(h.makeRemote())
  h.apply()
  await settle()
  const firstApi = h.windowObject.__dshPerf
  h.apply()
  await settle()
  check('idempotent: second apply keeps the first API object', h.windowObject.__dshPerf === firstApi)
  check('idempotent: only one highlighter root', h.state.roots.length === 1, String(h.state.roots.length))
  h.windowObject.__dshPerf.stop()
}

// ---- 5. 所有权：别人后来包的层不能被我们抹掉 ----
{
  const h = createHarness({ config: { renderTiming: true, clientContainment: false } })
  h.attach(h.makeRemote())
  h.apply()
  await settle()

  const ours = h.remote.$stream
  const thirdStream = function (options) { return ours.call(this, options) }
  h.remote.$stream = thirdStream
  const thirdSend = function (data) { return h.originalSend.call(h.socket, data) }
  h.socket.send = thirdSend

  h.windowObject.__dshPerf.stop()
  check('ownership: later $stream wrapper survives stop', h.remote.$stream === thirdStream)
  check('ownership: later socket.send wrapper survives stop', h.socket.send === thirdSend)

  // 手工收尾，避免影响后续用例。
  h.remote.$stream = h.originalStream
  h.socket.send = h.originalSend
}

// ---- 6. createStreams 中途失败要回滚 ----
{
  const h = createHarness({ config: { renderTiming: true, clientContainment: false } })
  h.attach(h.makeRemote({ socketThrows: true }))
  h.apply()
  await settle()

  check('rollback: $stream restored after a mid-install throw', h.remote.$stream === h.originalStream)
  check('rollback: socket.send untouched after a mid-install throw', h.socket.send === h.originalSend)
  check('rollback: state reports the hook failure', h.windowObject.__dshPerf.state().streamsAvailable === false)
  h.windowObject.__dshPerf.stop()
}

// ---- 7. pagehide 就是生命周期终点 ----
{
  const h = createHarness({ config: { renderTiming: true, clientContainment: false } })
  h.attach(h.makeRemote())
  h.apply()
  await settle()
  check('pagehide: listener registered', h.hasWindowListener('pagehide'))

  h.dispatchWindow('pagehide')
  check('pagehide: $stream restored', h.remote.$stream === h.originalStream)
  check('pagehide: socket.send restored', h.socket.send === h.originalSend)
  check('pagehide: __dshPerf removed', h.windowObject.__dshPerf === undefined)
  check('pagehide: listeners all removed', h.windowListenerCount() === 0, String(h.windowListenerCount()))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
