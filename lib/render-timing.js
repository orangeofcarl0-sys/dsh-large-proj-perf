// 渲染耗时诊断：给「打开一个会话」链路上插件够得到的点加计时。
//
// 为什么需要它：本插件此前所有测量都在服务端（冷读、RSS、事件循环阻塞），
// 浏览器侧的渲染从未被观测。静态分析（docs/RENDER-ANALYSIS.md）指出代价集中在
// 「一次性挂载整个窗口」，但每一段的实际占比只能真机测。
//
// 计时点只有两个，且都要求 `config.renderTiming = true`（默认关，关闭时本模块
// 完全不安装，零开销）：
//
//   1. `sessionProjections.snapshot` —— 快照里投影部分的产出耗时（同步、热路径）；
//   2. `webController.follow` / `historyController.events` —— 首屏窗口与历史分页的
//      产出耗时、事件数、序列化字节估计。
//
// 浏览器侧的样本（首行时间、稳定时间、长任务）由 lib/client.js 采集后 POST 到
// `perf.report`，落在同一个 `stats.render` 下。
//
// 本模块**不改**任何响应内容；窗口截断在 history-budget.js。

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { JUMP_BURST_GAP_MS } from './constants.js'
import { wrapMethod } from './patch-target.js'

const require = createRequire(import.meta.url)

/** 估算一段记录的线上字节数（JSON 文本长度，不含 WS deflate）。
 *  只在诊断模式下调用；代价高但测得准，且不计入被测量的耗时区间。 */
const estimateBytes = (value) => {
  try { return JSON.stringify(value).length } catch { return 0 }
}

const trim = (arr, keep) => { if (arr.length > keep) arr.splice(0, arr.length - keep) }

/** 从请求里取会话 id（address 可能是 {kind, sessionId} 或裸 id）。 */
const sessionIdOf = (request) => {
  const address = request?.address
  if (address !== null && typeof address === 'object' && typeof address.sessionId === 'string') return address.sessionId
  if (typeof request?.sessionId === 'string') return request.sessionId
  return null
}

/** 只记录足够大的帧，避免把心跳/控制帧灌进环。 */
const SEND_MIN_BYTES = 65536

/**
 * 包装 `ws` 的 `WebSocket.prototype.send`，把「服务端产出之后」再拆成三段：
 *
 *   stream-server 调用 send 的时刻（queuedAt）  ← 之前是写队列等待
 *   send 回调（sentAt）                          ← 之间是 JSON 序列化之后的 deflate + 写入
 *   客户端 message 的 event.timeStamp             ← 之间是网络 + 浏览器 inflate
 *
 * 这是冷读响应腿（实测可到 2.3 s）唯一能拆开的办法：`stream-server` 的
 * `this.writes` 是跨逻辑流的串行队列，control 基线会挡住 follow，光看客户端
 * 只能看到「帧很晚到」，看不出是在等队列还是在 deflate。
 *
 * 只在诊断模式安装；无法解析 `ws` 时静默跳过（不影响其它计时点）。
 *
 * @param deps - 只读依赖
 * @returns 是否安装成功
 */
function installSendTiming(deps) {
  const { stats, config, log, disposers } = deps
  let WebSocket = null
  // 插件安装目录里没有 ws；要从 dsh 自己的安装根解析。三条候选按可靠性排序：
  //   1. 已加载插件的 ESM 解析（部分安装形态可用）；
  //   2. `process.argv[1]`（dsh 的 bin.js）→ 上跳一级到 dsh 根；
  //   3. dsh-session 的安装路径 → 上跳三级（probeDshVersion 同款 fallback）。
  const candidates = []
  try { candidates.push(require.resolve('@deepseek-ai/dsh/package.json')) } catch { /* 继续 */ }
  try {
    const entry = process.argv[1]
    if (typeof entry === 'string' && entry !== '') candidates.push(join(dirname(entry), '..', 'package.json'))
  } catch { /* 继续 */ }
  try {
    const sessionPkg = require.resolve('@deepseek-ai/dsh-session/package.json')
    candidates.push(join(dirname(sessionPkg), '..', '..', '..', 'package.json'))
  } catch { /* 继续 */ }
  for (const candidate of candidates) {
    try {
      const mod = createRequire(candidate)('ws')
      WebSocket = mod?.WebSocket ?? mod
      if (typeof WebSocket?.prototype?.send === 'function') break
      WebSocket = null
    } catch { WebSocket = null }
  }
  if (WebSocket === null || typeof WebSocket?.prototype?.send !== 'function') {
    log('render timing: ws.send timing unavailable')
    return false
  }
  const proto = WebSocket.prototype
  const original = proto.send
  const record = (entry) => {
    stats.render.sends.push(entry)
    trim(stats.render.sends, config.keepRecent)
  }
  proto.send = function send(data, options, callback) {
    const size = typeof data === 'string' ? data.length : (data?.length ?? 0)
    if (size < SEND_MIN_BYTES) return original.call(this, data, options, callback)
    const queuedAt = Date.now()
    const done = (error) => {
      record({ t: queuedAt, sentAt: Date.now(), bytes: size })
      if (typeof callback === 'function') callback(error)
    }
    // ws 的签名有 (data, cb) 与 (data, options, cb) 两种。
    if (typeof options === 'function') return original.call(this, data, done)
    return original.call(this, data, options, done)
  }
  disposers.push(() => { if (proto.send !== original) proto.send = original })
  return true
}

/**
 * 安装渲染耗时诊断。
 *
 * @param deps - 只读依赖（见 context.js）
 */
export function installRenderTiming(deps) {
  const { ctx, config, stats, log, logErr, safeGet, setPatchStatus, disposers } = deps
  if (!config.renderTiming) { setPatchStatus('renderTiming', 'off'); return }

  const controller = safeGet(ctx, 'sessionController')
  if (controller === void 0) {
    setPatchStatus('renderTiming', 'inactive')
    log('render timing: sessionController unavailable')
    return
  }
  const web = controller.webController
  const history = controller.historyController
  if (web === void 0 || typeof web.follow !== 'function'
    || history === void 0 || typeof history.events !== 'function') {
    setPatchStatus('renderTiming', 'inactive')
    log('render timing: sessionController internals missing (webController.follow / historyController.events)')
    return
  }

  let installed = 0

  // ---- 回合跳转的 burst 聚合 ----
  // `loadThrough` 的行为是：连续回翻若干页，**全部攒完才发布一次**。单看一页
  // 与普通滚动翻页没有区别；连续多页落在 1500 ms 内才是跳转的指纹。
  // 聚合只影响记录，不改变任何响应。
  let burst = null
  let burstTimer = null

  const trimPages = () => trim(stats.render.pages, config.keepRecent)

  const flushBurst = () => {
    if (burstTimer !== null) { clearTimeout(burstTimer); burstTimer = null }
    if (burst === null) return
    const current = burst
    burst = null
    // 单页是普通翻页（用户滚到顶），不记成跳转。
    if (current.pages < 2) return
    stats.render.jumps += 1
    stats.render.pages.push({
      t: Date.now(),
      kind: 'jump',
      startedAt: current.startedAt,
      ms: Math.round(current.ms * 10) / 10,
      pages: current.pages,
      records: current.records,
      bytes: current.bytes,
      sessionId: current.sessionId,
    })
    trimPages()
  }

  const recordOlder = (entry) => {
    const now = Date.now()
    if (burst === null || now - burst.lastAt > JUMP_BURST_GAP_MS) {
      flushBurst()
      burst = { startedAt: now, lastAt: now, pages: 0, records: 0, bytes: 0, ms: 0, sessionId: entry.sessionId }
    }
    burst.lastAt = now
    burst.pages += 1
    burst.records += entry.records
    burst.bytes += entry.bytes
    burst.ms += entry.ms
    if (burstTimer !== null) clearTimeout(burstTimer)
    burstTimer = setTimeout(flushBurst, JUMP_BURST_GAP_MS)
    if (typeof burstTimer.unref === 'function') burstTimer.unref()
  }

  disposers.push(() => {
    if (burstTimer !== null) { clearTimeout(burstTimer); burstTimer = null }
    burst = null
  })

  // ---- 投影快照 ----
  // 同步热路径：`session/created` 的同步广播里就会调它。包装体保持无分配常态
  // （只在记录时写已有字段），不重入注册表。
  const projections = safeGet(ctx, 'sessionProjections')
  if (projections !== void 0 && typeof projections.snapshot === 'function') {
    const result = wrapMethod(projections, 'snapshot', (original) => function snapshot(session, keys) {
      const startedAt = performance.now()
      const value = original.call(this, session, keys)
      const ms = performance.now() - startedAt
      const render = stats.render
      render.snapshotCount += 1
      render.snapshotMs += ms
      if (ms > render.snapshotMaxMs) render.snapshotMaxMs = ms
      render.lastUnits = value !== null && typeof value === 'object' && value.values !== null
        && typeof value.values === 'object' ? Object.keys(value.values).length : 0
      return value
    }, disposers)
    if (result.installed) installed += 1
  }

  // ---- 首屏窗口（follow 快照）----
  // async generator：只量「第一帧产出」的耗时，后续每帧原样透传。
  const follow = wrapMethod(web, 'follow', (original) => async function* follow(request, signal) {
    const startedAt = Date.now()
    const startedPerf = performance.now()
    let firstFrame = true
    for await (const frame of original.call(this, request, signal)) {
      if (firstFrame) {
        firstFrame = false
        const ms = performance.now() - startedPerf
        const records = frame !== null && typeof frame === 'object' && Array.isArray(frame.records)
          ? frame.records
          : []
        stats.render.pages.push({
          t: Date.now(),
          startedAt,
          kind: 'follow',
          ms: Math.round(ms * 10) / 10,
          sessionId: sessionIdOf(request),
          maxMessages: typeof request?.maxMessages === 'number' ? request.maxMessages : null,
          records: records.length,
          bytes: estimateBytes(records),
          projections: estimateBytes(frame?.projections ?? null),
        })
        trimPages()
      }
      yield frame
    }
  }, disposers)
  if (follow.installed) installed += 1

  // ---- 历史分页 ----
  const events = wrapMethod(history, 'events', (original) => async function events(request, signal) {
    const startedAt = Date.now()
    const startedPerf = performance.now()
    const page = await original.call(this, request, signal)
    const ms = performance.now() - startedPerf
    const records = Array.isArray(page?.records) ? page.records : []
    const entry = {
      t: Date.now(),
      startedAt,
      kind: request?.beforeSeq === undefined ? 'initial' : 'older',
      ms: Math.round(ms * 10) / 10,
      sessionId: sessionIdOf(request),
      beforeSeq: typeof request?.beforeSeq === 'number' ? request.beforeSeq : null,
      maxMessages: typeof request?.maxMessages === 'number' ? request.maxMessages : null,
      records: records.length,
      bytes: estimateBytes(records),
      hasMore: page?.hasMore === true,
    }
    stats.render.pages.push(entry)
    trimPages()
    if (entry.kind === 'older') recordOlder(entry)
    return page
  }, disposers)
  if (events.installed) installed += 1

  if (installed === 0) {
    setPatchStatus('renderTiming', 'inactive')
    logErr('render timing: no timing points installed')
    return
  }
  const sendTiming = installSendTiming(deps)
  setPatchStatus('renderTiming', 'active')
  log(`render timing installed (${installed} point${installed === 1 ? '' : 's'}, ws.send=${sendTiming ? 'on' : 'off'})`)
}
