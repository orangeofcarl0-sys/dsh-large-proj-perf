// 渲染耗时诊断：给「打开一个会话」链路上插件够得到的点加计时。
//
// 为什么需要它：本插件此前所有测量都在服务端（冷读、RSS、事件循环阻塞），
// 浏览器侧的渲染从未被观测。静态分析（docs/RENDER-ANALYSIS.md）指出代价集中在
// 「一次性挂载整个窗口」，但每一段的实际占比只能真机测。
//
// 计时点：
//
//   1. `sessionProjections.snapshot` —— 快照里投影部分的产出耗时（同步、热路径）；
//   2. `webController.follow` / `historyController.events` —— 首屏窗口与历史分页的
//      产出耗时、事件数、序列化字节估计。
//
// ws 发送链路（写队列 / deflate / 网络）在 ws-timing.js；它不依赖 controller，
// 所以在能力门禁之前安装。
//
// 浏览器侧的样本（首行时间、稳定时间、长任务）由 lib/client.js 采集后 POST 到
// `perf.report`，落在同一个 `stats.render` 下。
//
// 本模块**不改**任何响应内容；窗口截断在 history-budget.js。

import { performance } from 'node:perf_hooks'

import { JUMP_BURST_GAP_MS } from './constants.js'
import { wrapMethod } from './patch-target.js'
import { installSendTiming } from './ws-timing.js'

/** 估算一段记录的线上字节数（JSON 文本长度，不含 WS deflate）。
 *  只在诊断模式下调用；代价高但测得准，且不计入被测量的耗时区间。 */
const estimateBytes = (value) => {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return 0 }
}

const trim = (arr, keep) => { if (arr.length > keep) arr.splice(0, arr.length - keep) }

/** 从请求里取会话 id（address 可能是 {kind, sessionId} 或裸 id）。 */
const sessionIdOf = (request) => {
  const address = request?.address
  if (address !== null && typeof address === 'object' && typeof address.sessionId === 'string') return address.sessionId
  if (typeof request?.sessionId === 'string') return request.sessionId
  return null
}

/**
 * 安装渲染耗时诊断。
 *
 * @param deps - 只读依赖（见 context.js）
 */
export function installRenderTiming(deps) {
  const { ctx, config, stats, log, logErr, safeGet, setPatchStatus, disposers } = deps
  if (!config.renderTiming) {
    setPatchStatus('renderTiming', 'off')
    setPatchStatus('renderTimingSend', 'off')
    return
  }

  // ws.send 计时只依赖 stats/config/log/disposers，不依赖 sessionController。
  // 先装它：页面计时点全都不在（controller 内部结构漂移）时，发送链路仍可测。
  const sendTiming = installSendTiming(deps)
  setPatchStatus('renderTimingSend', sendTiming ? 'active' : 'inactive')

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
      // jump 的 ms/字节/事件都是**跨页合计**，与单页同名字段语义不同，
      // 所以合计项用 *Total 后缀，避免消费端把两个量混在一起算斜率。
      ms: Math.round(current.ms * 10) / 10,
      pages: current.pages,
      recordsTotal: current.records,
      bytesTotal: current.bytes,
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
  setPatchStatus('renderTiming', 'active')
  log(`render timing installed (${installed} point${installed === 1 ? '' : 's'}, ws.send=${sendTiming ? 'on' : 'off'})`)
}
