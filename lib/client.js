// dsh-large-proj-perf — client half（浏览器端）
//
// 这不是 ESM。dsh 的客户端模块表按「经典脚本 + 惰性工厂」加载：
// 脚本执行时只做一次注册，工厂在模块被物化时才运行。id 必须等于包名，
// 由 package.json 的 dsh.client / exports["./client"] 指到这里。
// 形态与官方模板 dsh-agent-preset/skills/dsh-doc/templates/decoration/client.js 一致。
//
// 它做三件事：
//
//   1. clientContainment —— 长转录的离屏行加 content-visibility:auto，
//      削减布局与绘制（行数 >80 时启用，跳过前 30 行）。
//   2. renderTiming 的采集 —— 分段计时（WS 流 → 首行 → 首帧 → 稳定）、
//      LoAF 脚本归属、心跳、回合跳转窗口、滚动跳变。
//   3. window.__dshPerf 诊断入口 —— 供真实浏览器测量脚本驱动固定动作。
//
// 前两项默认关闭/开启由宿主配置决定；第三项只在 renderTiming 打开时存在。
// 为什么要在浏览器里测：服务端只把窗口发出去，解析/组装/挂载全在这里，
// 详见 docs/RENDER-ANALYSIS.md。

(function () {
  'use strict'

  var ID = 'dsh-large-proj-perf'
  var API = '/dsh-large-proj-perf/api/'
  var FLOW_SLOT = 'conversation.chat.flow'
  var FLOW = '[data-slot="' + FLOW_SLOT + '"]'
  var ROW = '[data-chat-flow-key]'
  var DENSE_ATTR = 'data-dsh-perf-dense'
  var SCROLLER = '[data-conversation-scroll]'
  var HISTORY = '[data-chat-history]'

  // 行数超过这个值才认为「长转录」，避免在短对话上做任何事。
  var DENSE_MIN_ROWS = 80
  // 前 N 行始终正常布局：可见区与滚动锚点所在的那部分不能是估算高度。
  var CONTAIN_SKIP_ROWS = 30
  // 行数连续这么久没变化，认为首屏已经稳定。
  var SETTLE_MS = 800
  // 长任务缓存上限，避免长时间运行的页面无限增长。
  var MAX_TASKS = 4000
  // 单次回传的样本上限（配合宿主侧 64 KiB body 上限）。
  var MAX_BATCH = 8
  // 样本里带多少条时间线标记。
  var MAX_TIMELINE = 16
  // 心跳采样上限（100 ms 一次 → 约 60 秒历史）。
  var MAX_HEARTBEAT = 600
  // 滚动采样上限；超出丢最旧。
  var MAX_SCROLL = 400
  // 滚动停止多久算一次手势结束。
  var SCROLL_IDLE_MS = 250
  // 两条滚动样本之间的最小间隔（避免刷屏）。
  var SCROLL_MIN_INTERVAL_MS = 2000
  // 最近多久内有输入，就认为滚动是用户主动的。
  var INPUT_WINDOW_MS = 300

  function post(method, body) {
    return fetch(API + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }).then(function (response) {
      return response.ok ? response.json() : undefined
    }).catch(function () { return undefined })
  }

  function raf() {
    return new Promise(function (resolve) { requestAnimationFrame(function () { resolve() }) })
  }

  function raf2() {
    return raf().then(raf)
  }

  // ---- 1. 离屏行 containment ----

  function containmentCss() {
    return '[data-slot="' + FLOW_SLOT + '"]' + '[' + DENSE_ATTR + ']'
      + ' > ' + ROW + ':nth-child(n+' + (CONTAIN_SKIP_ROWS + 1) + ') {'
      + ' content-visibility: auto;'
      + ' contain-intrinsic-size: auto 120px;'
      + ' }'
  }

  function injectStyle() {
    if (document.querySelector('style[data-dsh-perf-style]') !== null) return
    var style = document.createElement('style')
    style.setAttribute('data-dsh-perf-style', '')
    style.textContent = containmentCss()
    ;(document.head || document.documentElement).appendChild(style)
  }

  function flowElements() {
    return document.querySelectorAll(FLOW)
  }

  function rowCount(flow) {
    var n = 0
    for (var i = 0; i < flow.children.length; i++) {
      if (flow.children[i].hasAttribute('data-chat-flow-key')) n++
    }
    return n
  }

  function updateDensity() {
    var flows = flowElements()
    for (var i = 0; i < flows.length; i++) {
      var flow = flows[i]
      if (rowCount(flow) > DENSE_MIN_ROWS) flow.setAttribute(DENSE_ATTR, '')
      else flow.removeAttribute(DENSE_ATTR)
    }
  }

  var containment = { on: false, style: null, observer: null, timer: null }

  function installContainment() {
    if (containment.on) return
    containment.on = true
    injectStyle()
    containment.observer = new MutationObserver(function () {
      if (containment.timer !== null) return
      containment.timer = setTimeout(function () {
        containment.timer = null
        updateDensity()
      }, 200)
    })
    containment.observer.observe(document.documentElement, { childList: true, subtree: true })
    updateDensity()
  }

  function removeContainment() {
    containment.on = false
    if (containment.observer !== null) { containment.observer.disconnect(); containment.observer = null }
    if (containment.timer !== null) { clearTimeout(containment.timer); containment.timer = null }
    var style = document.querySelector('style[data-dsh-perf-style]')
    if (style !== null && style.parentNode !== null) style.parentNode.removeChild(style)
    var flows = flowElements()
    for (var i = 0; i < flows.length; i++) flows[i].removeAttribute(DENSE_ATTR)
  }

  // ---- 2. 采集器：LoAF + 心跳 ----

  function createCollector() {
    var tasks = []
    var heartbeat = []
    var observers = []
    var stopped = false

    var observe = function (type, toTask) {
      try {
        var observer = new PerformanceObserver(function (list) {
          if (stopped) return
          var entries = list.getEntries()
          for (var i = 0; i < entries.length; i++) tasks.push(toTask(entries[i]))
          if (tasks.length > MAX_TASKS) tasks.splice(0, tasks.length - MAX_TASKS)
        })
        observer.observe({ type: type, buffered: true })
        observers.push(observer)
        return true
      } catch (error) {
        return false
      }
    }

    // LoAF 的 blockingDuration 才是规范值（单任务 -50 的累加 + 渲染段），
    // 早期版本用 duration-50 会系统性高估。scripts[] 能把长帧归到具体脚本。
    var loafOk = observe('long-animation-frame', function (entry) {
      var scripts = []
      var list = entry.scripts || []
      for (var i = 0; i < list.length; i++) {
        var s = list[i]
        scripts.push({
          url: String(s.sourceURL || ''),
          fn: String(s.sourceFunctionName || ''),
          dur: Math.round(s.duration),
          forced: Math.round(s.forcedStyleAndLayoutDuration || 0),
          invoker: String(s.invoker || ''),
        })
      }
      scripts.sort(function (a, b) { return b.dur - a.dur })
      return {
        start: entry.startTime,
        dur: entry.duration,
        blocking: typeof entry.blockingDuration === 'number' ? entry.blockingDuration : Math.max(0, entry.duration - 50),
        renderStart: entry.renderStart || 0,
        layoutStart: entry.styleAndLayoutStart || 0,
        scripts: scripts.slice(0, 5),
      }
    })
    if (!loafOk) {
      observe('longtask', function (entry) {
        return {
          start: entry.startTime,
          dur: entry.duration,
          blocking: Math.max(0, entry.duration - 50),
          renderStart: 0,
          layoutStart: 0,
          scripts: [],
        }
      })
    }

    // 心跳：区分「主线程真的空闲」（等异步）与「大量短任务」（无长任务但忙）。
    var last = performance.now()
    var beat = function () {
      if (stopped) return
      var current = performance.now()
      var lag = current - last - 100
      last = current
      heartbeat.push({ t: Math.round(current), lag: Math.round(lag) })
      if (heartbeat.length > MAX_HEARTBEAT) heartbeat.splice(0, heartbeat.length - MAX_HEARTBEAT)
      if (typeof scheduler !== 'undefined' && scheduler !== null && typeof scheduler.postTask === 'function') {
        try { scheduler.postTask(beat, { priority: 'background', delay: 100 }); return } catch (error) { /* 退回 setTimeout */ }
      }
      setTimeout(beat, 100)
    }
    setTimeout(beat, 100)

    var summarize = function (from, to) {
      var count = 0
      var blocking = 0
      var max = 0
      var top = []
      var scripts = []
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i]
        if (task.start + task.dur < from || task.start > to) continue
        count++
        blocking += task.blocking
        if (task.dur > max) max = task.dur
        if (task.dur >= 50 && top.length < 5) top.push({ start: Math.round(task.start), dur: Math.round(task.dur) })
        if (task.scripts.length > 0 && scripts.length < 5) {
          for (var j = 0; j < task.scripts.length && scripts.length < 5; j++) {
            scripts.push({ dur: task.scripts[j].dur, fn: task.scripts[j].fn, url: task.scripts[j].url, forced: task.scripts[j].forced })
          }
        }
      }
      var maxLag = 0
      for (var k = 0; k < heartbeat.length; k++) {
        if (heartbeat[k].t < from || heartbeat[k].t > to) continue
        if (heartbeat[k].lag > maxLag) maxLag = heartbeat[k].lag
      }
      return {
        longTasks: count,
        blockingMs: Math.round(blocking),
        maxTaskMs: Math.round(max),
        topTasks: top,
        scripts: scripts,
        heartbeatMaxLagMs: maxLag,
      }
    }

    return {
      tasks: tasks,
      summarize: summarize,
      stop: function () {
        stopped = true
        for (var i = 0; i < observers.length; i++) {
          try { observers[i].disconnect() } catch (error) { /* 已断开 */ }
        }
        tasks.length = 0
        heartbeat.length = 0
      },
    }
  }

  // ---- 3. 时间线 ----

  function createTimeline() {
    var marks = []
    return {
      mark: function (name) {
        marks.push({ name: name, t: Math.round(performance.now()), at: Date.now() })
        if (marks.length > 64) marks.shift()
      },
      snapshot: function () { return marks.slice(-MAX_TIMELINE) },
      clear: function () { marks.length = 0 },
    }
  }

  // ---- 4. WS 流标签（区分 control 基线与 per-session follow）----

  function createStreams(ctx) {
    var remote
    try { remote = typeof ctx.get === 'function' ? ctx.get('remote') : undefined } catch (error) { remote = undefined }
    if (remote === undefined) {
      try { remote = ctx.remote } catch (error) { remote = undefined }
    }
    if (remote === null || remote === undefined) {
      return { entries: [], available: false, reason: 'remote service unavailable', stop: function () {} }
    }
    // $stream 可能来自原型（cordis 的 Proxy 会把方法 bind 过）。实例上没有自有
    // 属性时改原型，这与服务端 patch-target 的 sourceOf 处理是同一个道理。
    var owner = remote
    if (typeof remote.$stream !== 'function') {
      return { entries: [], available: false, reason: '$stream missing', stop: function () {} }
    }
    if (!Object.prototype.hasOwnProperty.call(remote, '$stream')) {
      var proto = Object.getPrototypeOf(remote)
      if (proto !== null && typeof proto.$stream === 'function') owner = proto
    }
    var original = owner.$stream
    var entries = []
    // 逻辑流的名字来自 options.name（'session event stream' / 'session control stream'）。
    // 这是唯一能在不解码帧的情况下区分「首帧是谁」的入口。
    owner.$stream = function (options) {
      if (options === null || typeof options !== 'object' || typeof options.open !== 'function') {
        return original.call(this, options)
      }
      var name = String(options.name || 'stream')
      var entry = { name: name, openedAt: Date.now(), firstItemAt: null, items: 0, generations: 0 }
      entries.push(entry)
      if (entries.length > 40) entries.shift()
      self.mark('stream:' + name)

      var wrapped = {}
      for (var key in options) if (Object.prototype.hasOwnProperty.call(options, key)) wrapped[key] = options[key]
      wrapped.open = function (signal) {
        entry.generations += 1
        self.mark('stream-open:' + name)
        var iterator = options.open(signal)
        return {
          next: function () {
            return iterator.next().then(function (result) {
              if (!result.done) {
                entry.items += 1
                if (entry.firstItemAt === null) {
                  entry.firstItemAt = Date.now()
                  self.mark('stream-first:' + name)
                }
              }
              return result
            })
          },
          return: function (value) {
            return typeof iterator.return === 'function'
              ? iterator.return(value)
              : Promise.resolve({ done: true, value: value })
          },
          throw: function (error) {
            return typeof iterator.throw === 'function' ? iterator.throw(error) : Promise.reject(error)
          },
          [Symbol.asyncIterator]: function () { return this },
        }
      }
      return original.call(this, wrapped)
    }
    self.mark('streams:hooked')

    return {
      available: true,
      reason: null,
      entries: entries,
      stop: function () {
        if (owner.$stream !== original) owner.$stream = original
        entries.length = 0
      },
    }
  }

  // ---- 5. 窗口：打开 / 跳转 / 滚动 ----

  function createWindows(env) {
    var collector = env.collector
    var timeline = env.timeline
    var emit = env.emit
    var samples = []

    // --- 打开窗口 ---
    var openState = null
    var settleTimer = null
    var previous = 0
    var firstWindow = true

    // --- 跳转窗口 ---
    var jumpState = null
    var jumpSettleTimer = null
    var historyStatus = null

    // --- 滚动 ---
    var scroller = null
    var scrollState = null
    var scrollFlushTimer = null
    var lastScrollSampleAt = 0
    var lastInputAt = 0
    var scrollRafOn = false

    var record = function (sample) {
      samples.push(sample)
      if (samples.length > 20) samples.shift()
      emit(sample)
    }

    var flowOf = function () {
      var flows = flowElements()
      return flows.length === 0 ? null : flows[0]
    }

    var turnsOf = function (flow) {
      var min = null
      var max = null
      if (flow === null) return { min: min, max: max }
      for (var i = 0; i < flow.children.length; i++) {
        var value = flow.children[i].getAttribute('data-chat-turn')
        if (value === null) continue
        var turn = Number(value)
        if (!isFinite(turn)) continue
        if (min === null || turn < min) min = turn
        if (max === null || turn > max) max = turn
      }
      return { min: min, max: max }
    }

    var closeOpen = function (reason) {
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
      if (openState === null) return
      var state = openState
      openState = null
      var now = performance.now()
      var summary = collector.summarize(state.startedAt, now)
      var memory = (typeof performance !== 'undefined' && performance.memory) || undefined
      var nav = performance.getEntriesByType('navigation')[0]
      record({
        kind: reason,
        rows: state.rows,
        firstRowMs: state.firstRowAt === null ? null : Math.round(state.firstRowAt - state.startedAt),
        firstFrameMs: state.firstFrameAt === null ? null : Math.round(state.firstFrameAt - state.startedAt),
        settleMs: Math.round(now - state.startedAt),
        longTasks: summary.longTasks,
        blockingMs: summary.blockingMs,
        maxTaskMs: summary.maxTaskMs,
        topTasks: summary.topTasks,
        scripts: summary.scripts,
        heartbeatMaxLagMs: summary.heartbeatMaxLagMs,
        heapMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
        navMs: nav ? Math.round(nav.duration) : null,
        rowsPerTurn: state.rowsPerTurn === undefined ? null : state.rowsPerTurn,
        timeline: timeline.snapshot(),
        streams: env.streams.current.available ? env.streams.current.entries.slice(-4) : null,
        pageNow: Math.round(now),
        at: Date.now(),
      })
      timeline.clear()
    }

    var scheduleSettle = function () {
      if (settleTimer !== null) clearTimeout(settleTimer)
      settleTimer = setTimeout(function () { closeOpen('settle') }, SETTLE_MS)
    }

    // 跳转窗口有自己的收尾定时器：它可能在 `data-chat-history` 还没回到 idle 时
    // 就已经把行挂完了（快速本地会话），不能只依赖状态转换。
    var scheduleJumpClose = function () {
      if (jumpSettleTimer !== null) clearTimeout(jumpSettleTimer)
      jumpSettleTimer = setTimeout(function () { jumpSettleTimer = null; closeJump() }, SETTLE_MS)
    }

    var closeJump = function () {
      if (jumpSettleTimer !== null) { clearTimeout(jumpSettleTimer); jumpSettleTimer = null }
      if (jumpState === null) return
      var state = jumpState
      jumpState = null
      var now = performance.now()
      var flow = flowOf()
      var rows = flow === null ? 0 : rowCount(flow)
      var turns = turnsOf(flow)
      var summary = collector.summarize(state.startedAt, now)
      record({
        kind: 'jump',
        rowsBefore: state.rows,
        rowsAfter: rows,
        rowsAdded: rows - state.rows,
        turnsBefore: state.turns,
        turnsAfter: turns,
        loadMs: state.loadedAt === null ? null : Math.round(state.loadedAt - state.startedAt),
        settleMs: Math.round(now - state.startedAt),
        longTasks: summary.longTasks,
        blockingMs: summary.blockingMs,
        maxTaskMs: summary.maxTaskMs,
        topTasks: summary.topTasks,
        scripts: summary.scripts,
        heartbeatMaxLagMs: summary.heartbeatMaxLagMs,
        scrollJumps: state.scrollJumps,
        timeline: timeline.snapshot(),
        at: Date.now(),
      })
      scheduleSettle()
    }

    var scan = function () {
      var flow = flowOf()
      if (flow === null) return
      var count = rowCount(flow)
      var current = performance.now()

      // 首行：在 MutationObserver 回调（微任务）里同步记录，不做防抖——
      // 防抖会把「首行出现」整体推迟一个定时器周期，污染首屏指标。
      if (openState !== null && openState.firstRowAt === null && count > 0) {
        openState.firstRowAt = current
        timeline.mark('firstRow')
        raf2().then(function () {
          if (openState !== null && openState.firstFrameAt === null) {
            openState.firstFrameAt = performance.now()
            timeline.mark('firstFrame')
          }
        })
      }

      if (count === 0) {
        if (openState !== null) closeOpen('replaced')
        previous = 0
        return
      }
      if (openState === null || count < previous / 2) {
        if (openState !== null) closeOpen('replaced')
        openState = { startedAt: firstWindow ? 0 : current, firstRowAt: null, firstFrameAt: null, rows: count }
        firstWindow = false
        timeline.mark('window:open')
        scheduleSettle()
      }
      openState.rows = count
      if (count !== previous) {
        previous = count
        scheduleSettle()
      }

      // 跳转窗口：data-chat-history 从 loading 变回 idle 即为「装载结束」，
      // 之后靠 settle 收尾。它同样覆盖 loadOlder，服务端的 burst 聚合才是
      // 「这是不是一次 loadThrough」的权威判据。
      var marker = document.querySelector(HISTORY)
      var status = marker === null ? null : marker.getAttribute('data-chat-history')
      if (status !== historyStatus) {
        if (status === 'loading') {
          var turns = turnsOf(flow)
          jumpState = { startedAt: current, rows: count, turns: turns, loadedAt: null, scrollJumps: 0 }
          timeline.mark('jump:start')
          scheduleJumpClose()
        } else if (status !== null && jumpState !== null && jumpState.loadedAt === null) {
          jumpState.loadedAt = current
          timeline.mark('jump:loaded')
          scheduleSettle()
          scheduleJumpClose()
        }
        historyStatus = status
      }
      if (jumpState !== null) scheduleJumpClose()
    }

    var mutation = new MutationObserver(function () {
      // 回调本身就是变更后的微任务：直接扫一次，保证首行时间不被延迟。
      scan()
    })
    mutation.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [ 'data-chat-history' ] })
    scan()

    // --- 滚动跳变 ---
    var findScroller = function () {
      if (scroller !== null && scroller.isConnected) return scroller
      scroller = document.querySelector(SCROLLER)
      return scroller
    }

    var markInput = function () { lastInputAt = performance.now() }
    var inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    for (var i = 0; i < inputEvents.length; i++) {
      window.addEventListener(inputEvents[i], markInput, { passive: true, capture: true })
    }

    var topRowOf = function (el) {
      var rows = el.querySelectorAll(ROW)
      var top = el.getBoundingClientRect().top
      for (var i = 0; i < rows.length; i++) {
        var rect = rows[i].getBoundingClientRect()
        if (rect.bottom > top + 1) {
          return { key: rows[i].getAttribute('data-chat-flow-key'), offset: Math.round(rect.top - top) }
        }
      }
      return null
    }

    var flushScroll = function () {
      if (scrollFlushTimer !== null) { clearTimeout(scrollFlushTimer); scrollFlushTimer = null }
      if (scrollState === null) return
      var state = scrollState
      scrollState = null
      var now = performance.now()
      var el = findScroller()
      var anchor = el === null ? null : topRowOf(el)
      var drift = null
      if (anchor !== null && state.anchor !== null && anchor.key === state.anchor.key) {
        drift = Math.abs(anchor.offset - state.anchor.offset)
      }
      // 判定：单帧位移超过半个视口高度即视为「瞬跳」。用总时长做附加条件
      // 会把「一次大跳之后又跟了几帧小调整」误判成平滑滚动。
      var jump = state.maxFrame >= (el === null ? 400 : el.clientHeight * 0.5)
      var intentional = state.lastInputAt !== null && state.lastInputAt >= state.startedAt - INPUT_WINDOW_MS
      if (jump && jumpState !== null) jumpState.scrollJumps += 1
      if (!jump && now - lastScrollSampleAt < SCROLL_MIN_INTERVAL_MS) return
      lastScrollSampleAt = now
      record({
        kind: 'scroll',
        jump: jump,
        intentional: intentional,
        maxFramePx: Math.round(state.maxFrame),
        totalPx: Math.round(state.total),
        reversals: state.reversals,
        anchorDriftPx: drift,
        heightDelta: el === null ? null : el.scrollHeight - state.height,
        durationMs: Math.round(now - state.startedAt),
        frames: state.frames,
        containment: containment.on,
        rows: rowCount(flowOf() || document.createElement('div')),
        at: Date.now(),
      })
    }

    var scrollSample = function () {
      var el = findScroller()
      if (el === null) return
      var y = el.scrollTop
      var now = performance.now()
      if (scrollState === null) {
        var anchor = topRowOf(el)
        scrollState = {
          startedAt: now, lastY: y, lastAt: now, total: 0, maxFrame: 0,
          reversals: 0, direction: 0, frames: 0,
          height: el.scrollHeight, anchor: anchor,
          lastInputAt: lastInputAt === 0 ? null : lastInputAt,
        }
        return
      }
      var dy = y - scrollState.lastY
      if (dy === 0) return
      scrollState.frames += 1
      scrollState.total += Math.abs(dy)
      if (Math.abs(dy) > scrollState.maxFrame) scrollState.maxFrame = Math.abs(dy)
      var direction = dy > 0 ? 1 : -1
      if (scrollState.direction !== 0 && direction !== scrollState.direction) scrollState.reversals += 1
      scrollState.direction = direction
      scrollState.lastY = y
      scrollState.lastAt = now
      scrollState.lastInputAt = lastInputAt === 0 ? null : lastInputAt
      if (scrollFlushTimer !== null) clearTimeout(scrollFlushTimer)
      scrollFlushTimer = setTimeout(flushScroll, SCROLL_IDLE_MS)
    }

    var scrollLoop = function () {
      if (!scrollRafOn) return
      scrollSample()
      requestAnimationFrame(scrollLoop)
    }
    scrollRafOn = true
    requestAnimationFrame(scrollLoop)
    var scrollListener = function () { scrollSample() }
    var attachScroller = function () {
      var el = findScroller()
      if (el !== null) el.addEventListener('scroll', scrollListener, { passive: true })
    }
    attachScroller()

    return {
      samples: samples,
      scan: scan,
      flush: function () { closeOpen('flush'); flushScroll(); if (jumpState !== null) { jumpState.loadedAt = performance.now(); closeJump() } },
      stop: function () {
        mutation.disconnect()
        scrollRafOn = false
        if (settleTimer !== null) clearTimeout(settleTimer)
        if (jumpSettleTimer !== null) clearTimeout(jumpSettleTimer)
        if (scrollFlushTimer !== null) clearTimeout(scrollFlushTimer)
        for (var j = 0; j < inputEvents.length; j++) window.removeEventListener(inputEvents[j], markInput, true)
        if (scroller !== null) scroller.removeEventListener('scroll', scrollListener)
        openState = null
        jumpState = null
        scrollState = null
      },
    }
  }

  // ---- 6. 诊断入口 ----

  function createApi(ctx) {
    var timeline = ctx.timeline

    var railOf = function () {
      var navs = document.querySelectorAll('nav')
      for (var i = 0; i < navs.length; i++) {
        if (navs[i].querySelector('button[data-index]') !== null) return navs[i]
      }
      return null
    }

    return {
      mark: function (name) { if (typeof name === 'string') timeline.mark(name) },
      state: function () {
        var streams = ctx.streams.current
        return {
          containment: containment.on,
          timing: true,
          streamsAvailable: streams.available,
          streamsReason: streams.reason ?? null,
          streams: streams.available ? streams.entries.slice(-8) : null,
          samples: ctx.windows.samples.slice(-8),
        }
      },
      // 跳到最早的一个 turn。只有当 turn 0 尚未加载时才会触发 loadThrough；
      // 否则只是一次普通滚动，样本会标成 settle 而不是 jump。
      jumpToFirst: function () {
        var nav = railOf()
        if (nav === null) return { ok: false, error: 'turn rail not found' }
        if (document.querySelector('[data-chat-turn="0"]') !== null) return { ok: false, error: 'turn 0 already loaded' }
        var scroller = nav.querySelector('button[data-index]')
        var box = scroller === null ? null : scroller.parentElement === null ? null : scroller.parentElement.parentElement
        if (box !== null) box.scrollTop = 0
        return raf2().then(function () {
          var first = nav.querySelector('button[data-index="0"]')
          if (first === null) return { ok: false, error: 'rail mark 0 not materialized' }
          first.click()
          timeline.mark('api:jumpToFirst')
          return { ok: true }
        })
      },
      scrollTest: function (options) {
        var rounds = options !== null && typeof options === 'object' && typeof options.rounds === 'number'
          ? Math.max(1, Math.min(5, Math.round(options.rounds)))
          : 1
        var el = document.querySelector(SCROLLER)
        if (el === null) return Promise.resolve({ ok: false, error: 'no scroll container' })
        var run = function (index) {
          if (index >= rounds) return Promise.resolve({ ok: true, rounds: rounds, rows: rowCount(document.querySelector(FLOW) || document.createElement('div')) })
          el.scrollTop = 0
          return raf2().then(function () {
            el.scrollTop = el.scrollHeight
            return raf2()
          }).then(function () {
            el.scrollTop = 0
            return raf2()
          }).then(function () { return run(index + 1) })
        }
        timeline.mark('api:scrollTest')
        return run(0)
      },
      flush: function () { ctx.windows.flush() },
    }
  }

  // ---- 装配 ----

  var self = {
    mark: function () {},
    timeline: null,
    streams: null,
    windows: null,
  }

  window.__ModuleLoader__.load({
    id: ID,
    factory: function () {
      return {
        // 客户端 cordis 的服务访问要显式声明：`ctx.get('remote')` 只有在
        // inject 里列出后才拿得到（与官方 decoration 模板的 ['slots'] 同理）。
        // remote 缺失时本插件不运行——它在 0.2.2 起是必备服务。
        inject: ['remote'],
        apply: function (ctx) {
          // 幂等：模块可能被物化多次（页面内多个装载代际），重复安装会让同一段
          // 渲染被采集成两份。
          if (window.__dshPerfClient === true) return
          window.__dshPerfClient = true

          var timeline = createTimeline()
          self.timeline = timeline
          self.mark = timeline.mark
          var collector = createCollector()
          // 流钩子只在诊断模式安装：它会改写 $stream（应用的所有逻辑流都经过它），
          // 默认配置下不碰它。用 holder 是因为装配顺序是「先建窗口、后取配置」。
          var streams = { current: { available: false, reason: 'timing off', entries: [], stop: function () {} } }
          self.streams = streams
          var windows = createWindows({ collector: collector, timeline: timeline, streams: streams, emit: function (sample) { window.__dshPerfEmit(sample) } })
          self.windows = windows

          // 样本队列：与非 200 响应时的处理放在一起，避免一条失败清空整批。
          var pending = []
          var sending = false
          var flush = function () {
            if (sending || pending.length === 0) return
            sending = true
            var batch = pending.splice(0, MAX_BATCH)
            post('perf.report', { samples: batch }).then(function (result) {
              sending = false
              if (result === undefined || result.ok !== true) {
                // 只丢最旧的一半，保留最新样本（以前的实现会整批清空）。
                pending.splice(0, Math.ceil(pending.length / 2))
              }
              flush()
            })
          }
          window.__dshPerfEmit = function (sample) {
            pending.push(sample)
            if (pending.length > MAX_BATCH * 4) pending.splice(0, pending.length - MAX_BATCH * 4)
            flush()
          }
          var api = createApi({ streams: streams, windows: windows, collector: collector, timeline: timeline })
          window.__dshPerf = api

          post('config.get', {}).then(function (result) {
            var config = result !== undefined && result.ok === true ? result.value : undefined
            if (config !== undefined && config.clientContainment === true) installContainment()
            if (config === undefined || config.renderTiming !== true) {
              // 关闭时拆除采集设施；界面改动（containment）按它自己的开关决定去留。
              windows.stop()
              collector.stop()
              streams.current.stop()
              if (config === undefined || config.clientContainment !== true) removeContainment()
              delete window.__dshPerf
              window.__dshPerfClient = false
            } else {
              // 只有诊断模式才碰 $stream：它是应用所有逻辑流的公共入口。
              try {
                streams.current = createStreams(ctx)
              } catch (error) {
                streams.current = { available: false, reason: 'hook failed: ' + String(error && error.message ? error.message : error), entries: [], stop: function () {} }
              }
              timeline.mark('timing:on')
            }
          })
        },
      }
    },
  })
})()
