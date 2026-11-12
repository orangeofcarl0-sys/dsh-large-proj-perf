// dsh-large-proj-perf — client half（浏览器端）
//
// 这不是 ESM。dsh 的客户端模块表按「经典脚本 + 惰性工厂」加载：
// 脚本执行时只做一次注册，工厂在模块被物化时才运行。id 必须等于包名，
// 由 package.json 的 dsh.client / exports["./client"] 指到这里。
// 形态与官方模板 dsh-agent-preset/skills/dsh-doc/templates/decoration/client.js 一致。
//
// 它做两件事，都由宿主侧配置控制（启动时取一次 config.get）：
//
//   1. clientContainment —— 长转录的离屏行加 content-visibility:auto，
//      削减布局与绘制。只在行数超过阈值时启用，且跳过前 30 行（可见区）。
//   2. renderTiming —— 采集长任务与「首行 / 稳定」时间，批量回传到
//      POST /dsh-large-proj-perf/api/perf.report。
//
// 两条都默认关闭：渲染行为属于用户可见面，未实测前不擅自改变。
//
// 为什么测量要放在浏览器里：`session/follow` 的快照只是一个 WS 帧，之后
// 「解析 → 组装 → 挂载 → 布局」全在浏览器。服务端测不到这一段，
// 详见 docs/RENDER-ANALYSIS.md。

(function () {
  'use strict'

  var ID = 'dsh-large-proj-perf'
  var API = '/dsh-large-proj-perf/api/'
  var FLOW_SLOT = 'conversation.chat.flow'
  var FLOW = '[data-slot="' + FLOW_SLOT + '"]'
  var ROW = '[data-chat-flow-key]'
  var DENSE_ATTR = 'data-dsh-perf-dense'

  // 行数超过这个值才认为「长转录」，避免在短对话上做任何事。
  var DENSE_MIN_ROWS = 80
  // 前 N 行始终正常布局：可见区与滚动锚点所在的那部分不能是估算高度。
  var CONTAIN_SKIP_ROWS = 30
  // 行数连续这么久没变化，认为首屏已经稳定。
  var SETTLE_MS = 800
  // 长任务缓存上限，避免长时间运行的页面无限增长。
  var MAX_TASKS = 4000
  // 单次回传的样本上限（与宿主侧 16 KiB body 上限匹配）。
  var MAX_BATCH = 8

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

  function installContainment() {
    injectStyle()
    var scheduled = false
    var tick = function () {
      scheduled = false
      updateDensity()
    }
    new MutationObserver(function () {
      if (scheduled) return
      scheduled = true
      setTimeout(tick, 200)
    }).observe(document.documentElement, { childList: true, subtree: true })
    updateDensity()
  }

  // ---- 2. 渲染计时 ----
  //
  // 采集必须在 apply 时**立即**装好：页面重载后会话会被自动打开，等
  // config.get 返回再装就可能错过真正挂载的那个长任务。配置取回后如果
  // renderTiming 不是 true，再整体拆除（见 apply）。
  //
  // 窗口定义：
  //   - 页面生命周期内的第一个窗口以**导航起点**为起点（startedAt = 0），
  //     这样 firstRowMs 就是「从导航到第一行出现」；
  //   - 之后的窗口（切会话导致行数归零再长回来）以归零时刻为起点。
  function createTiming() {
    var tasks = []
    var observers = []
    var stopped = false

    var observe = function (type) {
      try {
        var observer = new PerformanceObserver(function (list) {
          if (stopped) return
          var entries = list.getEntries()
          for (var i = 0; i < entries.length; i++) {
            tasks.push({ start: entries[i].startTime, dur: entries[i].duration })
          }
          if (tasks.length > MAX_TASKS) tasks.splice(0, tasks.length - MAX_TASKS)
        })
        observer.observe({ type: type, buffered: true })
        observers.push(observer)
        return true
      } catch (error) {
        return false
      }
    }
    // long-animation-frame 覆盖样式/布局/绘制的真实耗时（Chrome 116+）；
    // longtask 只覆盖主线程任务。两个都收，用 type 区分。
    if (!observe('long-animation-frame')) observe('longtask')

    var pending = []
    var sending = false

    var flush = function () {
      if (sending || pending.length === 0) return
      sending = true
      var batch = pending.splice(0, MAX_BATCH)
      post('perf.report', { samples: batch }).then(function (result) {
        sending = false
        if (result === undefined || result.ok !== true) pending.length = 0
        else flush()
      })
    }

    var emit = function (sample) {
      pending.push(sample)
      if (pending.length > MAX_BATCH * 4) pending.splice(0, pending.length - MAX_BATCH * 4)
      flush()
    }

    var windowState = null
    var settleTimer = null
    var previous = 0
    var firstWindow = true

    var summarize = function (from, to) {
      var count = 0
      var blocking = 0
      var max = 0
      var top = []
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i]
        if (task.start + task.dur < from || task.start > to) continue
        count++
        if (task.dur > 50) blocking += task.dur - 50
        if (task.dur > max) max = task.dur
        if (task.dur >= 50 && top.length < 5) top.push({ start: Math.round(task.start), dur: Math.round(task.dur) })
      }
      return {
        longTasks: count,
        blockingMs: Math.round(blocking),
        maxTaskMs: Math.round(max),
        topTasks: top,
      }
    }

    var closeWindow = function (reason) {
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
      if (windowState === null) return
      var state = windowState
      windowState = null
      var now = performance.now()
      var stats = summarize(state.startedAt, now)
      var memory = (typeof performance !== 'undefined' && performance.memory) || undefined
      var nav = performance.getEntriesByType('navigation')[0]
      emit({
        kind: reason,
        rows: state.rows,
        firstRowMs: state.firstRowAt === null ? null : Math.round(state.firstRowAt - state.startedAt),
        settleMs: Math.round(now - state.startedAt),
        longTasks: stats.longTasks,
        blockingMs: stats.blockingMs,
        maxTaskMs: stats.maxTaskMs,
        topTasks: stats.topTasks,
        heapMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
        navMs: nav ? Math.round(nav.duration) : null,
        pageNow: Math.round(now),
        at: Date.now(),
      })
    }

    var scheduleSettle = function () {
      if (settleTimer !== null) clearTimeout(settleTimer)
      settleTimer = setTimeout(function () { closeWindow('settle') }, SETTLE_MS)
    }

    var scan = function () {
      if (stopped) return
      var flows = flowElements()
      if (flows.length === 0) return
      var flow = flows[0]
      var count = rowCount(flow)
      var now = performance.now()

      if (count === 0) {
        if (windowState !== null) closeWindow('replaced')
        previous = 0
        return
      }
      if (windowState === null || count < previous / 2) {
        if (windowState !== null) closeWindow('replaced')
        // 首个窗口从导航算起；之后的窗口从「行数归零」那一刻算起。
        windowState = { startedAt: firstWindow ? 0 : now, firstRowAt: null, rows: count }
        firstWindow = false
        scheduleSettle()
      }
      if (windowState.firstRowAt === null) windowState.firstRowAt = now
      windowState.rows = count
      if (count !== previous) {
        previous = count
        scheduleSettle()
      }
    }

    var scheduled = false
    var mutationObserver = new MutationObserver(function () {
      if (stopped || scheduled) return
      scheduled = true
      setTimeout(function () { scheduled = false; scan() }, 120)
    })
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true })
    scan()

    return {
      stop: function () {
        stopped = true
        mutationObserver.disconnect()
        for (var i = 0; i < observers.length; i++) {
          try { observers[i].disconnect() } catch (error) { /* 已断开 */ }
        }
        if (settleTimer !== null) clearTimeout(settleTimer)
        tasks.length = 0
        pending.length = 0
      },
    }
  }

  // ---- 装配 ----

  window.__ModuleLoader__.load({
    id: ID,
    factory: function () {
      return {
        apply: function () {
          // 幂等：模块可能被物化多次（页面内多个装载代际），重复安装会让同一段
          // 渲染被采集成两份。
          if (window.__dshPerfClient === true) return
          window.__dshPerfClient = true
          // 先装采集器再取配置：页面重载后会话会自动打开，等配置回来再装会漏掉
          // 真正挂载的那段。取回配置若明确关闭，再整体拆除。
          var timing = createTiming()
          post('config.get', {}).then(function (result) {
            var config = result !== undefined && result.ok === true ? result.value : undefined
            if (config === undefined || config.renderTiming !== true) timing.stop()
            if (config !== undefined && config.clientContainment === true) installContainment()
          })
        },
      }
    },
  })
})()
