// 渲染链路两个模块的单元测试：
//   lib/render-timing.js    —— 服务端计时点（投影快照 / follow 首帧 / 历史分页）
//   lib/history-budget.js   —— 首屏条数上限与单页字节上限
//
// 用 mock 的 `sessionController`，不改任何真实 dsh 结构；真实链路的证据在
// tools/runtime-probe 的 scenario H 与 docs/RENDER-ANALYSIS.md。

import { DEFAULT_CONFIG } from '../lib/config.js'
import { createStats } from '../lib/stats.js'
import { installRenderTiming } from '../lib/render-timing.js'
import { installHistoryBudget } from '../lib/history-budget.js'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const pad = 'x'.repeat(10)

/** 造一个只保留被测形状的 controller：follow 是 async generator，events 是 async 方法。
 *  同时记录最后一次收到的请求，用于断言「参数被改写成了什么」。 */
function makeController() {
  const webController = {
    lastRequest: undefined,
    async *follow(request) {
      this.lastRequest = request
      const count = request?.maxMessages ?? 3
      yield {
        type: 'snapshot',
        header: { id: 's1' },
        projections: { turnOutline: { turns: [] } },
        records: Array.from({ length: count }, (_, i) => ({ type: 'event', event: { seq: i, pad } })),
      }
    },
  }
  const historyController = {
    lastRequest: undefined,
    async events(request) {
      this.lastRequest = request
      const count = request?.maxMessages ?? 3
      return {
        records: Array.from({ length: count }, (_, i) => ({ type: 'event', event: { seq: i, pad } })),
        hasMore: true,
      }
    },
  }
  return { webController, historyController }
}

function makeDeps(controller, overrides = {}, projections) {
  const stats = createStats()
  const disposers = []
  const status = {}
  const ctx = {
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'sessionProjections') return projections
      return void 0
    },
  }
  return {
    stats,
    status,
    disposers,
    deps: {
      ctx,
      config: { ...DEFAULT_CONFIG, ...overrides },
      stats,
      log: () => {},
      logErr: () => {},
      disposers,
      safeGet: (target, name) => { try { return target.get(name) } catch { return void 0 } },
      sessionEventsOf: () => [],
      sessionLogOffset: (v) => v,
      cacheIdentityOf: () => ({}),
      yieldLoop: () => Promise.resolve(),
      setConfigValue: () => {},
      setPatchStatus: (key, value) => { status[key] = value },
      recordFork: () => {},
    },
  }
}

const drain = async (iterator) => {
  const frames = []
  for await (const frame of iterator) frames.push(frame)
  return frames
}

// ---- 1. renderTiming 关闭时不安装 ----
{
  const controller = makeController()
  const webBefore = controller.webController.follow
  const historyBefore = controller.historyController.events
  const { deps, status } = makeDeps(controller)
  installRenderTiming(deps)
  check('render timing: off by default', status.renderTiming === 'off', String(status.renderTiming))
  check('render timing: no method replaced when off',
    controller.webController.follow === webBefore && controller.historyController.events === historyBefore)
}

// ---- 2. renderTiming 打开的计时点 ----
{
  const controller = makeController()
  const projections = {
    snapshot(session, keys) {
      return { asOfSeq: 7, values: { turnOutline: { turns: [] }, sessionStats: { turns: 1 } } }
    },
  }
  const { deps, stats, status, disposers } = makeDeps(controller, { renderTiming: true }, projections)
  const followOriginal = controller.webController.follow
  const eventsOriginal = controller.historyController.events
  installRenderTiming(deps)
  check('render timing: active', status.renderTiming === 'active', String(status.renderTiming))

  // 投影快照：记录次数、累计耗时、units
  projections.snapshot({ id: 's1' })
  check('render timing: snapshot counted', stats.render.snapshotCount === 1, String(stats.render.snapshotCount))
  check('render timing: snapshot units recorded', stats.render.lastUnits === 2, String(stats.render.lastUnits))
  check('render timing: snapshot ms is a finite number', Number.isFinite(stats.render.snapshotMs))

  // follow 首帧
  await drain(controller.webController.follow({ maxMessages: 4 }))
  const followPage = stats.render.pages.at(-1)
  check('render timing: follow first frame recorded', followPage?.kind === 'follow', String(followPage?.kind))
  check('render timing: follow records counted', followPage?.records === 4, String(followPage?.records))
  check('render timing: follow bytes estimated', typeof followPage?.bytes === 'number' && followPage.bytes > 0, String(followPage?.bytes))
  check('render timing: follow projections bytes estimated',
    typeof followPage?.projections === 'number' && followPage.projections > 0, String(followPage?.projections))

  // 历史分页：initial / older 两种
  await controller.historyController.events({ maxMessages: 3 })
  await controller.historyController.events({ maxMessages: 3, beforeSeq: 10 })
  check('render timing: initial page kind', stats.render.pages.at(-2)?.kind === 'initial', String(stats.render.pages.at(-2)?.kind))
  check('render timing: older page kind', stats.render.pages.at(-1)?.kind === 'older', String(stats.render.pages.at(-1)?.kind))
  check('render timing: hasMore recorded', stats.render.pages.at(-1)?.hasMore === true)

  // dispose 还原
  for (const dispose of disposers.splice(0).reverse()) dispose()
  check('render timing: dispose restores follow', controller.webController.follow === followOriginal)
  check('render timing: dispose restores events', controller.historyController.events === eventsOriginal)
}

// ---- 3. historyBudget 关闭时不安装 ----
{
  const controller = makeController()
  const followBefore = controller.webController.follow
  const { deps, status } = makeDeps(controller)
  installHistoryBudget(deps)
  check('history budget: off when both caps are 0', status.historyBudget === 'off', String(status.historyBudget))
  check('history budget: no method replaced when off', controller.webController.follow === followBefore)
}

// ---- 4. 首屏条数上限 ----
{
  const controller = makeController()
  const { deps, status, disposers } = makeDeps(controller, { maxInitialMessages: 2 })
  installHistoryBudget(deps)
  check('history budget: active', status.historyBudget === 'active', String(status.historyBudget))

  const frames = await drain(controller.webController.follow({ maxMessages: 5 }))
  check('history budget: follow frame clamped', frames[0]?.records?.length === 2, String(frames[0]?.records?.length))

  const first = await controller.historyController.events({ maxMessages: 5 })
  check('history budget: initial page clamped', first.records.length === 2, String(first.records.length))

  const older = await controller.historyController.events({ maxMessages: 5, beforeSeq: 100 })
  check('history budget: older page not clamped by count', older.records.length === 5, String(older.records.length))

  const below = await controller.historyController.events({ maxMessages: 1 })
  check('history budget: never raises the client budget', below.records.length === 1, String(below.records.length))

  // 关键：客户端请求的是 {maxMessages:500, turnWindow:{minMessages:50}}，
  // paginate 的切页条件由 minMessages 主导。只压 maxMessages 对短 turn 会话无效，
  // 所以两者都要压。
  await controller.historyController.events({
    maxMessages: 500,
    turnWindow: { minMessages: 50, minTurns: 2 },
  })
  check('history budget: clamps turnWindow.minMessages too',
    controller.historyController.lastRequest.turnWindow.minMessages === 2,
    String(controller.historyController.lastRequest.turnWindow.minMessages))
  check('history budget: keeps minTurns untouched',
    controller.historyController.lastRequest.turnWindow.minTurns === 2)
  check('history budget: minMessages never exceeds maxMessages',
    controller.historyController.lastRequest.turnWindow.minMessages
      <= controller.historyController.lastRequest.maxMessages)

  for (const dispose of disposers.splice(0).reverse()) dispose()
}

// ---- 5. 单页字节上限 ----
{
  const controller = makeController()
  const { deps, disposers } = makeDeps(controller, { maxPageBytes: 200 })
  installHistoryBudget(deps)

  const page = await controller.historyController.events({ maxMessages: 5 })
  check('history budget: byte cap shrinks the page', page.records.length < 5, String(page.records.length))
  const bytes = JSON.stringify(page.records).length
  check('history budget: shrunk page is under the cap', bytes <= 200, `${bytes} <= 200`)

  const frames = await drain(controller.webController.follow({ maxMessages: 5 }))
  const frameBytes = JSON.stringify(frames[0]?.records ?? []).length
  check('history budget: byte cap applies to follow opening', (frames[0]?.records?.length ?? 0) < 5,
    `${frames[0]?.records?.length} records`)
  check('history budget: follow opening under the cap', frameBytes <= 200, `${frameBytes} <= 200`)

  for (const dispose of disposers.splice(0).reverse()) dispose()
}

// ---- 6. 配置读取是安装时快照（与其它补丁一致）----
{
  const controller = makeController()
  const { deps, disposers } = makeDeps(controller, { maxInitialMessages: 3 })
  installHistoryBudget(deps)
  deps.config.maxInitialMessages = 1
  const page = await controller.historyController.events({ maxMessages: 9 })
  check('history budget: caps are read at install time', page.records.length === 3, String(page.records.length))
  for (const dispose of disposers.splice(0).reverse()) dispose()
}

// ---- 7. 分页记录带 startedAt / sessionId / beforeSeq ----
{
  const controller = makeController()
  const { deps, stats, disposers } = makeDeps(controller, { renderTiming: true })
  installRenderTiming(deps)
  const before = Date.now()
  await controller.historyController.events({ maxMessages: 2, address: { kind: 'session', sessionId: 's-1' } })
  const page = stats.render.pages.at(-1)
  check('render timing: page records startedAt', typeof page.startedAt === 'number' && page.startedAt >= before - 1000,
    String(page.startedAt))
  check('render timing: page records sessionId', page.sessionId === 's-1', String(page.sessionId))
  check('render timing: page records beforeSeq (null on initial)', page.beforeSeq === null)
  await controller.historyController.events({ maxMessages: 2, beforeSeq: 9, address: { kind: 'session', sessionId: 's-1' } })
  check('render timing: older page records beforeSeq',
    stats.render.pages.at(-1).beforeSeq === 9, String(stats.render.pages.at(-1).beforeSeq))
  for (const dispose of disposers.splice(0).reverse()) dispose()
}

// ---- 8. 回合跳转的 burst 聚合 ----
// `loadThrough` = 连续多次回翻、间隔很短。单页是普通翻页，不记成跳转。
{
  const controller = makeController()
  const { deps, stats, disposers } = makeDeps(controller, { renderTiming: true })
  installRenderTiming(deps)
  await controller.historyController.events({ maxMessages: 2, beforeSeq: 40, address: { kind: 'session', sessionId: 's-2' } })
  await controller.historyController.events({ maxMessages: 2, beforeSeq: 30, address: { kind: 'session', sessionId: 's-2' } })
  await controller.historyController.events({ maxMessages: 2, beforeSeq: 20, address: { kind: 'session', sessionId: 's-2' } })
  await new Promise((resolve) => setTimeout(resolve, 1800))
  const jumps = stats.render.pages.filter((entry) => entry.kind === 'jump')
  check('jump burst: consecutive older pages collapse into one jump', jumps.length === 1, String(jumps.length))
  check('jump burst: aggregates page count', jumps[0]?.pages === 3, String(jumps[0]?.pages))
  check('jump burst: aggregates records', jumps[0]?.recordsTotal === 6, String(jumps[0]?.recordsTotal))
  check('jump burst: aggregates bytes', typeof jumps[0]?.bytesTotal === 'number' && jumps[0].bytesTotal > 0, String(jumps[0]?.bytesTotal))
  // jump 是跨页合计，不能复用单页的 records/bytes 名字，否则消费端会把两个量混算。
  check('jump burst: does not reuse single-page field names',
    jumps[0]?.records === undefined && jumps[0]?.bytes === undefined, Object.keys(jumps[0] ?? {}).join(','))
  check('jump burst: increments the counter', stats.render.jumps === 1, String(stats.render.jumps))
  check('jump burst: keeps the session id', jumps[0]?.sessionId === 's-2', String(jumps[0]?.sessionId))
  for (const dispose of disposers.splice(0).reverse()) dispose()
}

// ---- 9. 单页不记成跳转 ----
{
  const controller = makeController()
  const { deps, stats, disposers } = makeDeps(controller, { renderTiming: true })
  installRenderTiming(deps)
  await controller.historyController.events({ maxMessages: 2, beforeSeq: 50 })
  await new Promise((resolve) => setTimeout(resolve, 1800))
  check('jump burst: a single older page is not a jump', stats.render.jumps === 0, String(stats.render.jumps))
  for (const dispose of disposers.splice(0).reverse()) dispose()
}

if (failures > 0) {
  console.error(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nALL PASS')
