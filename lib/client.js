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
  // 滚动停止多久算一次手势结束。
  var SCROLL_IDLE_MS = 250
  // 两条滚动样本之间的最小间隔（避免刷屏）。
  var SCROLL_MIN_INTERVAL_MS = 2000
  // 最近多久内有输入，就认为滚动是用户主动的。
  var INPUT_WINDOW_MS = 300
  // 只记录「大帧」：控制帧与心跳帧没有归因价值，还会把环填满。
  var FRAME_MIN_BYTES = 4096

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

  var containment = { on: false, observer: null, timer: null }

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
    var beatTimer = null
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
      beatTimer = setTimeout(beat, 100)
    }
    beatTimer = setTimeout(beat, 100)

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
        if (beatTimer !== null) { clearTimeout(beatTimer); beatTimer = null }
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

  function createStreams(ctx, timeline) {
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
    var patched = function (options) {
      if (options === null || typeof options !== 'object' || typeof options.open !== 'function') {
        return original.call(this, options)
      }
      var name = String(options.name || 'stream')
      var entry = { name: name, openedAt: Date.now(), firstItemAt: null, items: 0, generations: 0 }
      entries.push(entry)
      if (entries.length > 40) entries.shift()
      timeline.mark('stream:' + name)

      var wrapped = {}
      for (var key in options) if (Object.prototype.hasOwnProperty.call(options, key)) wrapped[key] = options[key]
      wrapped.open = function (signal) {
        entry.generations += 1
        timeline.mark('stream-open:' + name)
        var iterator = options.open(signal)
        return {
          next: function () {
            return iterator.next().then(function (result) {
              if (!result.done) {
                entry.items += 1
                if (entry.firstItemAt === null) {
                  entry.firstItemAt = Date.now()
                  timeline.mark('stream-first:' + name)
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
    owner.$stream = patched
    timeline.mark('streams:hooked')

    // WS 帧时间戳。物理 socket 挂在 `remote.streams.socket` 上——TS 里是 private，
    // 运行时是普通属性。帧到达 → 逻辑流 item 之间只有微任务（receive 从 message
    // 监听器同步调用），所以这两个时间的差可以直接读成「本地派发」；再配合服务端
    // 的 startedAt/t（同机 Date.now），请求腿 / 服务端 / 响应腿三段就能分开。
    //
    // 光有大小不够：同一个 socket 上同时跑着 control 基线与 per-session follow，
    // 大帧可能是别人。这里顺手解析出站 open 帧的 {streamId, endpoint}，入站帧按
    // streamId 归到具体端点，才能回答「首帧到底是谁」。
    var frames = []
    var endpoints = {}
    var originalSend = null
    var patchedSend = null
    var detachFrames = null
    var onFrame = function (event) {
      var data = event.data
      var size = typeof data === 'string'
        ? data.length
        : (data !== null && data !== undefined && (data.byteLength || data.size)) || 0
      if (size < FRAME_MIN_BYTES) return
      var streamId = null
      if (typeof data === 'string') {
        var match = /"streamId":("?[^",}]+"?)/.exec(data.slice(0, 240))
        if (match !== null) streamId = match[1].replace(/"/g, '')
      }
      frames.push({
        // event.timeStamp 是事件创建时刻（帧到达后被排入任务队列的时间），
        // 早于本监听器执行——应用自己的 message 监听器可能先同步解析完大帧，
        // 期间还会跑微任务检查点。归因必须用 stamp，不能用这里的 t。
        at: Date.now(),
        t: Math.round(performance.now()),
        stamp: Math.round(event.timeStamp),
        size: size,
        streamId: streamId,
        endpoint: streamId === null ? null : endpoints[streamId] ?? null,
      })
      if (frames.length > 50) frames.shift()
      timeline.mark('ws-frame:' + size)
    }

    // 半装状态自己回滚：任何一步抛错都不把 $stream / send 的补丁留在应用上。
    try {
      var socket = null
      try {
        socket = remote.streams !== null && remote.streams !== undefined ? remote.streams.socket : null
      } catch (error) { socket = null }
      if (socket !== null && typeof socket.addEventListener === 'function') {
        socket.addEventListener('message', onFrame)
        // 出站 open 帧很小，解析它不会碰到大帧的 JSON.parse 成本。
        if (typeof socket.send === 'function') {
          var boundSend = socket.send.bind(socket)
          originalSend = socket.send
          patchedSend = function (data) {
            try {
              if (typeof data === 'string' && data.length < 4096 && data.indexOf('"open"') >= 0) {
                var id = /"streamId":("?[^",}]+"?)/.exec(data)
                var endpoint = /"endpoint":"([^"]+)"/.exec(data)
                if (id !== null) endpoints[id[1].replace(/"/g, '')] = endpoint === null ? 'unknown' : endpoint[1]
              }
            } catch (error) { /* 解析失败不影响发送 */ }
            return boundSend(data)
          }
          socket.send = patchedSend
        }
        detachFrames = function () {
          try { socket.removeEventListener('message', onFrame) } catch (error) { /* 已关闭 */ }
          // 只有仍是我们包的那一层才还原：别人后来包过的话，不能把他们的 wrapper 抹掉。
          if (patchedSend !== null && socket.send === patchedSend) {
            try { socket.send = originalSend } catch (error) { /* 已关闭 */ }
          }
        }
      }
    } catch (error) {
      try { if (detachFrames !== null) detachFrames() } catch { /* 已还原 */ }
      try { if (owner.$stream === patched) owner.$stream = original } catch { /* 已还原 */ }
      throw error
    }

    return {
      available: true,
      reason: null,
      frames: detachFrames === null ? null : frames,
      framesReason: detachFrames === null ? 'socket unavailable' : null,
      entries: entries,
      stop: function () {
        if (owner.$stream === patched) owner.$stream = original
        if (detachFrames !== null) detachFrames()
        entries.length = 0
        frames.length = 0
      },
    }
  }

  // ---- 5. 滚动跳变追踪 ----
  // 独立于行扫描与打开/跳转窗口：它只关心「单帧位移、方向反转、锚点漂移、
  // 输入意图」，通过 env 回传样本与两条计数。
  function createScrollTracker(env) {
    var scroller = null
    var attachedScroller = null
    var scrollState = null
    var scrollFlushTimer = null
    var lastScrollSampleAt = 0
    var lastInputAt = 0
    var scrollRafOn = false

    var scrollListener = function () { scrollSample() }
    // 容器可能在会话切换时被 React 换掉：记住真正挂过监听的那个节点，
    // 换节点先摘旧监听，stop 也从它上面摘——否则旧节点会泄漏一个常驻监听器。
    var ensureScroller = function () {
      if (scroller !== null && scroller.isConnected) return scroller
      var next = document.querySelector(SCROLLER)
      if (next !== scroller) {
        if (attachedScroller !== null) {
          try { attachedScroller.removeEventListener('scroll', scrollListener) } catch (error) { /* 已移除 */ }
          attachedScroller = null
        }
        if (next !== null) {
          attachedScroller = next
          next.addEventListener('scroll', scrollListener, { passive: true })
        }
      }
      scroller = next
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
      var el = ensureScroller()
      var anchor = el === null ? null : topRowOf(el)
      var drift = null
      if (anchor !== null && state.anchor !== null && anchor.key === state.anchor.key) {
        drift = Math.abs(anchor.offset - state.anchor.offset)
      }
      // 判定：单帧位移超过半个视口高度、**且没有近期输入意图**，才算「意外跳变」。
      // 用户滚轮本身就会产生大 delta（实测一次 -1500 的滚动会出现 3146 px 的单帧），
      // 把它记成 jump 是误报；有意的滚动只看 maxFramePx 与 anchorDriftPx。
      var intentional = state.lastInputAt !== null && state.lastInputAt >= state.startedAt - INPUT_WINDOW_MS
      var jump = state.maxFrame >= (el === null ? 400 : el.clientHeight * 0.5) && !intentional
      if (jump) env.onJump()
      if (!jump && now - lastScrollSampleAt < SCROLL_MIN_INTERVAL_MS) return
      lastScrollSampleAt = now
      env.record({
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
        containment: env.containmentOn(),
        rows: env.rowCount(env.flowOf() || document.createElement('div')),
        at: Date.now(),
      })
    }

    var scrollSample = function () {
      var el = ensureScroller()
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
    ensureScroller()

    return {
      flush: function () { flushScroll() },
      stop: function () {
        scrollRafOn = false
        if (scrollFlushTimer !== null) { clearTimeout(scrollFlushTimer); scrollFlushTimer = null }
        for (var j = 0; j < inputEvents.length; j++) window.removeEventListener(inputEvents[j], markInput, true)
        if (attachedScroller !== null) {
          try { attachedScroller.removeEventListener('scroll', scrollListener) } catch (error) { /* 已移除 */ }
          attachedScroller = null
        }
        scroller = null
        scrollState = null
      },
    }
  }

  // ---- 6. 窗口：打开 / 跳转 ----

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
    // 状态与监听都在 createScrollTracker 里；这里只保留一个句柄。

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

    var scroll = createScrollTracker({
      record: record,
      flowOf: flowOf,
      rowCount: rowCount,
      containmentOn: function () { return containment.on },
      onJump: function () { if (jumpState !== null) jumpState.scrollJumps += 1 },
    })

    var closeOpen = function (reason) {
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
      if (openState === null) return
      var state = openState
      openState = null
      var now = performance.now()
      var summary = collector.summarize(state.startedAt, now)
      var memory = (typeof performance !== 'undefined' && performance.memory) || undefined
      var nav = performance.getEntriesByType('navigation')[0]
      // 窗口内的第一个大帧：它通常就是这次打开/翻页的快照。
      var allFrames = env.streams.current.frames
      var frame = null
      if (allFrames !== null) {
        for (var i = 0; i < allFrames.length; i++) {
          if (allFrames[i].stamp >= state.startedAt) { frame = allFrames[i]; break }
        }
      }
      record({
        kind: reason,
        rows: state.rows,
        firstRowMs: state.firstRowAt === null ? null : Math.round(state.firstRowAt - state.startedAt),
        firstFrameMs: state.firstFrameAt === null ? null : Math.round(state.firstFrameAt - state.startedAt),
        settleMs: Math.round(now - state.startedAt),
        frameArrivalMs: frame === null ? null : Math.round(frame.stamp - state.startedAt),
        frameHandlerMs: frame === null ? null : Math.round(frame.t - state.startedAt),
        frameBytes: frame === null ? null : frame.size,
        frameEndpoint: frame === null ? null : frame.endpoint,
        wsFrames: allFrames === null ? null : allFrames.slice(-4),
        longTasks: summary.longTasks,
        blockingMs: summary.blockingMs,
        maxTaskMs: summary.maxTaskMs,
        topTasks: summary.topTasks,
        scripts: summary.scripts,
        heartbeatMaxLagMs: summary.heartbeatMaxLagMs,
        heapMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
        navMs: nav ? Math.round(nav.duration) : null,
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

    return {
      samples: samples,
      scan: scan,
      flush: function () {
        closeOpen('flush')
        scroll.flush()
        if (jumpState !== null) { jumpState.loadedAt = performance.now(); closeJump() }
      },
      stop: function () {
        mutation.disconnect()
        if (settleTimer !== null) clearTimeout(settleTimer)
        if (jumpSettleTimer !== null) clearTimeout(jumpSettleTimer)
        scroll.stop()
        openState = null
        jumpState = null
      },
    }
  }

  // ---- 7. 诊断入口 ----

  // 取 shiki 的 tokenize 回调：`useCodeHighlighter` 是 hook，必须在一个组件里
  // 渲染一次才能拿到。挂到分离的 div 上、保持挂载，回调才稳定。
  // 直接挂 CodeBlock 不行——它被 IntersectionObserver 门控，离屏永远不高亮。
  function createHighlighterSeat(require, primitives) {
    if (primitives === null || primitives === undefined || typeof primitives.useCodeHighlighter !== 'function') {
      return { highlighter: null, reason: 'useCodeHighlighter unavailable', root: null }
    }
    try {
      var React = require('react')
      var Client = require('react-dom/client')
      var ReactDOM = require('react-dom')
      if (React === undefined || Client === null || Client === undefined || typeof Client.createRoot !== 'function') {
        return { highlighter: null, reason: 'react-dom/client unavailable', root: null }
      }
      var captured = null
      var Seat = function () {
        captured = primitives.useCodeHighlighter('typescript')
        return null
      }
      var root = Client.createRoot(document.createElement('div'))
      var render = function () { root.render(React.createElement(Seat)) }
      if (ReactDOM !== null && ReactDOM !== undefined && typeof ReactDOM.flushSync === 'function') ReactDOM.flushSync(render)
      else render()
      if (typeof captured !== 'function') return { highlighter: null, reason: 'hook returned non-function', root: root }
      return { highlighter: captured, reason: null, root: root }
    } catch (error) {
      return { highlighter: null, reason: 'seat failed: ' + String(error && error.message ? error.message : error), root: null }
    }
  }

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
          framesReason: streams.framesReason ?? null,
          wsFrames: streams.frames === null || streams.frames === undefined ? null : streams.frames.slice(-8),
          highlighterReason: ctx.highlighterReason ?? null,
          samples: ctx.windows.samples.slice(-8),
        }
      },
      // 跳到指定 turn。只有该 turn 尚未加载时才会触发 loadThrough。
      // 回合导航是虚拟列表（每项估高 10px），所以先滚到目标索引再点。
      jumpToTurn: function (turn) {
        if (typeof turn !== 'number' || !isFinite(turn) || turn < 1) return { ok: false, error: 'turn must be >= 1' }
        var target = Math.round(turn)
        var nav = railOf()
        if (nav === null) return { ok: false, error: 'turn rail not found' }
        if (document.querySelector('[data-chat-turn="' + target + '"]') !== null) return { ok: false, error: 'turn already loaded', turn: target }
        var index = target - 1
        var mark = nav.querySelector('button[data-index]')
        var box = mark === null || mark.parentElement === null ? null : mark.parentElement.parentElement
        if (box !== null) box.scrollTop = index * 10
        return raf2().then(function () {
          var button = nav.querySelector('button[data-index="' + index + '"]')
          if (button === null) return { ok: false, error: 'rail mark not materialized', index: index }
          button.click()
          timeline.mark('api:jumpToTurn:' + target)
          return { ok: true, index: index, turn: target }
        })
      },
      // 跳到最早的一个 turn（jumpToTurn(1) 的快捷方式）。
      jumpToFirst: function () { return this.jumpToTurn(1) },
      // markdown / KaTeX / shiki 的 op 级微基准。
      // 只建 React 元素、不 commit；代码高亮走 useCodeHighlighter 回调，
      // 绕开 CodeBlock 的 IntersectionObserver 门控（离屏永远不会高亮）。
      benchMarkdown: function (options) {
        var P = ctx.primitives
        if (P === null || P === undefined) return { ok: false, reason: 'primitives unavailable' }
        var text = options !== null && typeof options === 'object' && typeof options.text === 'string' ? options.text : ''
        if (text === '') return { ok: false, reason: 'text required' }
        var iterations = options !== null && typeof options === 'object' && typeof options.iterations === 'number'
          ? Math.max(1, Math.min(20, Math.round(options.iterations)))
          : 5
        var labels = function (i) {
          return { code: { copyLabel: 'C' + i, copiedLabel: 'D' + i }, footnotes: 'F' + i }
        }
        var time = function (fn) {
          var start = performance.now()
          for (var i = 0; i < iterations; i++) fn(i)
          return Math.round(((performance.now() - start) / iterations) * 100) / 100
        }
        var result = { ok: true, chars: text.length, iterations: iterations }
        var fences = (text.match(/```/g) || []).length
        var maths = text.match(/\$\$[\s\S]*?\$\$/g) || []
        result.fences = Math.floor(fences / 2)
        result.mathBlocks = maths.length

        if (typeof P.extractMarkdownPlainText === 'function') {
          try {
            P.extractMarkdownPlainText(text)
            result.parseMs = time(function () { P.extractMarkdownPlainText(text) })
          } catch (error) { result.parseError = String(error && error.message ? error.message : error) }
        }

        var inner = P.MarkdownText
        // memo() 返回的是带 $$typeof 的对象而不是函数，别用 typeof 判。
        if (inner !== null && inner !== undefined && (typeof inner === 'function' || typeof inner === 'object')
          && ctx.react !== null && ctx.createRoot !== null) {
          // MarkdownText 是 memo 组件且内部用 hooks，不能直接当函数调用
          // （React #321 invalid hook call）。挂到一个**分离**的容器里量：
          // 含 element 创建 + commit，不含布局与视口高亮（离屏代码块本来就
          // 被 IntersectionObserver 门控，高亮单独用 highlightMs 量）。
          var renderOnce = function (i) {
            var host = document.createElement('div')
            var root = ctx.createRoot(host)
            var element = ctx.react.createElement(inner, { text: text, labels: labels(i), streaming: false })
            var started = performance.now()
            if (typeof ctx.flushSync === 'function') ctx.flushSync(function () { root.render(element) })
            else root.render(element)
            var ms = performance.now() - started
            try { root.unmount() } catch (error) { /* 已卸载 */ }
            return ms
          }
          try {
            renderOnce(0)
            var total = 0
            for (var r = 0; r < iterations; r++) total += renderOnce(r + 1)
            result.renderMs = Math.round((total / iterations) * 100) / 100
            result.renderVia = 'MarkdownText detached mount'
            result.renderIncludesHighlight = false
          } catch (error) { result.renderError = String(error && error.message ? error.message : error) }
        }

        if (maths.length > 0 && typeof P.FenceMathBlock === 'function') {
          var tex = maths[0].slice(2, -2)
          try {
            P.FenceMathBlock({ code: tex })
            result.katexMs = time(function () { P.FenceMathBlock({ code: tex }) })
          } catch (error) { result.katexError = String(error && error.message ? error.message : error) }
        }

        var highlighter = ctx.seat.highlighter
        if (highlighter !== null && highlighter !== undefined) {
          var code = (text.match(/```[a-zA-Z]*\n([\s\S]*?)```/) || [null, text.slice(0, 400)])[1]
          try {
            highlighter(code)
            result.highlightMs = time(function () { highlighter(code) })
            result.highlightVia = 'useCodeHighlighter'
            result.highlightChars = code.length
          } catch (error) { result.highlightError = String(error && error.message ? error.message : error) }
        } else {
          result.highlightReason = ctx.seat.reason ?? 'highlighter unavailable'
        }
        return result
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
      // 生命周期终点：停采集、还原所有 patch、卸载 highlighter。
      // pagehide 与测量脚本都可以调；重复调用安全。
      stop: function () { ctx.stop() },
    }
  }

  // ---- 装配 ----

  window.__ModuleLoader__.load({
    id: ID,
    factory: function (require) {
      // seed 模块表里就有 primitives / react，factory 的 require 直接拿得到。
      // 拿不到就整体降级（不猜替代实现）。
      var primitives = null
      try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch (error) { primitives = null }
      var react = null
      var reactDom = null
      var reactClient = null
      try { react = require('react') } catch (error) { react = null }
      try { reactDom = require('react-dom') } catch (error) { reactDom = null }
      try { reactClient = require('react-dom/client') } catch (error) { reactClient = null }
      var createRoot = reactClient !== null && reactClient !== undefined && typeof reactClient.createRoot === 'function'
        ? reactClient.createRoot.bind(reactClient)
        : null
      var flushSync = reactDom !== null && reactDom !== undefined && typeof reactDom.flushSync === 'function'
        ? reactDom.flushSync.bind(reactDom)
        : null
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
          var collector = createCollector()
          // 流钩子只在诊断模式安装：它会改写 $stream（应用的所有逻辑流都经过它），
          // 默认配置下不碰它。用 holder 是因为装配顺序是「先建窗口、后取配置」。
          var streams = { current: { available: false, reason: 'timing off', entries: [], stop: function () {} } }

          // 样本队列必须在 createWindows 之前就位：窗口的 emit 回调引用它，
          // 任何同步样本都不能落在一个还没赋值的全局函数上。
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
          var emit = function (sample) {
            pending.push(sample)
            if (pending.length > MAX_BATCH * 4) pending.splice(0, pending.length - MAX_BATCH * 4)
            flush()
          }
          var windows = createWindows({ collector: collector, timeline: timeline, streams: streams, emit: emit })

          // highlighter 座位是晚绑定槽：createApi 读 holder，不事后改 apiEnv。
          var seat = { highlighter: null, reason: 'timing off', root: null }

          // 生命周期终点。只拆诊断设施；clientContainment 是独立的界面开关，
          // 由它自己的配置决定去留。
          var stopped = false
          var stop = function () {
            if (stopped) return
            stopped = true
            try { windows.stop() } catch (error) { /* 已停 */ }
            try { collector.stop() } catch (error) { /* 已停 */ }
            try { streams.current.stop() } catch (error) { /* 已停 */ }
            if (seat.root !== null) {
              try { seat.root.unmount() } catch (error) { /* 已卸载 */ }
              seat.root = null
            }
            try { window.removeEventListener('pagehide', onPageHide) } catch (error) { /* 已移除 */ }
            delete window.__dshPerfEmit
            delete window.__dshPerf
            window.__dshPerfClient = false
          }
          var onPageHide = function () { stop() }

          var api = createApi({
            streams: streams, windows: windows, collector: collector, timeline: timeline,
            primitives: primitives, seat: seat,
            react: react, createRoot: createRoot, flushSync: flushSync,
            stop: stop,
          })
          window.__dshPerf = api
          window.__dshPerfEmit = emit
          try { window.addEventListener('pagehide', onPageHide) } catch (error) { /* 忽略 */ }

          post('config.get', {}).then(function (result) {
            var config = result !== undefined && result.ok === true ? result.value : undefined
            if (config !== undefined && config.clientContainment === true) installContainment()
            if (config === undefined || config.renderTiming !== true) {
              // 关闭时拆除采集设施；界面改动（containment）按它自己的开关决定去留。
              stop()
              if (config === undefined || config.clientContainment !== true) removeContainment()
              return
            }
            // 只有诊断模式才碰 $stream：它是应用所有逻辑流的公共入口。
            try {
              streams.current = createStreams(ctx, timeline)
            } catch (error) {
              streams.current = { available: false, reason: 'hook failed: ' + String(error && error.message ? error.message : error), entries: [], stop: function () {} }
            }
            var created = createHighlighterSeat(require, primitives)
            seat.highlighter = created.highlighter
            seat.reason = created.reason
            seat.root = created.root
            timeline.mark('timing:on')
          })
        },
      }
    },
  })
})()
