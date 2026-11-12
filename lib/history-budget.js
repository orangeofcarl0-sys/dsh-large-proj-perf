// 历史窗口预算：给「一页多少消息」补上字节与首屏两个维度。
//
// 上游的 paginate 只按**消息条数**切页（dsh-api-session-controller/src/history.ts），
// 页面字节量完全由内容决定：工具输出密集的 500 条消息可以是数十 MB。而浏览器
// 侧的开销同时取决于条数（挂载多少个 React 节点）与字节（解析、markdown、布局），
// 所以两个维度都得能管。
//
// 两个开关，默认 0 = 完全沿用上游行为（安装即 off，零开销）：
//
//   maxInitialMessages —— 首屏窗口的消息上限（follow 快照，以及无 beforeSeq 的
//                         events）。**同时下调 `turnWindow.minMessages`**：
//                         客户端请求的是 `{maxMessages:500, turnWindow:{minMessages:50}}`，
//                         而 paginate 在「已有 ≥50 条消息且跨过 ≥2 个 turn」时就切页，
//                         所以短 turn 会话的真实首屏是 ~50 条、而不是 500 条。
//                         只压 maxMessages 对这种会话完全无效（实测：150 与 500
//                         产出同样 231 个事件）。见 docs/RENDER-ANALYSIS.md §3。
//   maxPageBytes       —— 单页的估算字节上限。超限时按比例下调 maxMessages 重算，
//                         最多重试一次（首屏）或三次（分页）。
//
// 安全性：只改请求里的 maxMessages，不改分页语义。`hasMore` 由上游按实际切页
// 位置计算，客户端据此续拉——窗口变小只影响「一次装多少」，不影响「能看到多少」。
// maxMessages 本来就是 paginate 的消息对齐边界，所以绝不会把一个 turn 切开。

import { wrapMethod } from './patch-target.js'

/** 上游 `resolveHistoryRequest` 在缺省 maxMessages 时用的值（history.ts）。 */
const UPSTREAM_DEFAULT_MAX_MESSAGES = 50

/** 估算一帧/一页的线上字节数（JSON 文本长度，不含 WS deflate）。 */
const estimateBytes = (value) => {
  try { return JSON.stringify(value).length } catch { return 0 }
}

/**
 * 安装历史窗口预算。
 *
 * @param deps - 只读依赖（见 context.js）
 */
export function installHistoryBudget(deps) {
  const { ctx, config, log, logErr, safeGet, setPatchStatus, disposers } = deps
  const initialCap = config.maxInitialMessages > 0 ? config.maxInitialMessages : 0
  const byteCap = config.maxPageBytes > 0 ? config.maxPageBytes : 0
  if (initialCap === 0 && byteCap === 0) { setPatchStatus('historyBudget', 'off'); return }

  const controller = safeGet(ctx, 'sessionController')
  if (controller === void 0) {
    setPatchStatus('historyBudget', 'inactive')
    log('history budget: sessionController unavailable')
    return
  }
  const web = controller.webController
  const history = controller.historyController

  const requested = (request) => (typeof request?.maxMessages === 'number' && Number.isFinite(request.maxMessages) && request.maxMessages > 0)
    ? request.maxMessages
    : UPSTREAM_DEFAULT_MAX_MESSAGES

  // 首屏（含 follow 的每一页——follow 只有尾页一种）按条数截断。
  // 必须连 turnWindow.minMessages 一起压：paginate 的切页条件取「满足 minMessages
  // 与 minTurns」的最小窗口，只压 maxMessages 对短 turn 会话不生效。
  const clampInitial = (request) => {
    if (initialCap === 0) return request
    const current = requested(request)
    const nextMax = Math.min(current, initialCap)
    const turnWindow = request?.turnWindow
    let nextWindow
    if (turnWindow !== undefined && turnWindow !== null && typeof turnWindow === 'object') {
      const minMessages = typeof turnWindow.minMessages === 'number' && Number.isFinite(turnWindow.minMessages)
        ? turnWindow.minMessages
        : 1
      // 上游要求 minMessages 不超过 maxMessages，取两者最小值保证合法。
      const clamped = Math.max(1, Math.min(minMessages, nextMax))
      nextWindow = clamped === minMessages ? turnWindow : { ...turnWindow, minMessages: clamped }
    }
    if (nextMax === current && nextWindow === turnWindow) return request
    return { ...request, maxMessages: nextMax, ...nextWindow === undefined ? {} : { turnWindow: nextWindow } }
  }

  // 分页按字节截断：先按原请求取一次，超限则按比例下调重算。
  const shrinkByBytes = async (self, original, request, page) => {
    if (byteCap === 0) return page
    let budget = requested(request)
    let current = page
    for (let attempt = 0; attempt < 3; attempt++) {
      const bytes = estimateBytes(current)
      if (bytes <= byteCap) return current
      const scaled = Math.floor((budget * byteCap) / bytes * 0.95)
      const next = Math.max(1, scaled)
      if (next >= budget) return current
      budget = next
      current = await original.call(self, { ...request, maxMessages: next })
    }
    return current
  }

  let installed = 0

  if (web !== void 0 && typeof web.follow === 'function') {
    const result = wrapMethod(web, 'follow', (original) => async function* follow(request, signal) {
      const clamped = clampInitial(request)
      if (byteCap === 0) { yield* original.call(this, clamped, signal); return }

      // 需要字节上限时要先看到首帧才能判断大小，所以最多取两次：
      // 第一次按截断后的预算，超限则按比例缩一次再取。
      let iterator = original.call(this, clamped, signal)
      let first = await iterator.next()
      if (first.done === true) return
      const bytes = estimateBytes(first.value)
      if (bytes > byteCap) {
        const budget = requested(clamped)
        const scaled = Math.max(1, Math.floor((budget * byteCap) / bytes * 0.95))
        if (scaled < budget) {
          try { await iterator.return() } catch { /* 已结束 */ }
          iterator = original.call(this, { ...clamped, maxMessages: scaled }, signal)
          first = await iterator.next()
        }
      }
      if (first.done !== true) yield first.value
      yield* iterator
    }, disposers)
    if (result.installed) installed += 1
  }

  if (history !== void 0 && typeof history.events === 'function') {
    const result = wrapMethod(history, 'events', (original) => async function events(request, signal) {
      const clamped = request?.beforeSeq === undefined ? clampInitial(request) : request
      const page = await original.call(this, clamped, signal)
      return shrinkByBytes(this, original, clamped, page)
    }, disposers)
    if (result.installed) installed += 1
  }

  if (installed === 0) {
    setPatchStatus('historyBudget', 'inactive')
    logErr('history budget: no page entry points installed')
    return
  }
  setPatchStatus('historyBudget', 'active')
  log(`history budget installed (initial=${initialCap || 'off'} messages, pageBytes=${byteCap || 'off'}, ${installed} point${installed === 1 ? '' : 's'})`)
}
