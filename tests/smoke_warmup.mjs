// 冒烟测试：dsh-projection-warmup
// 用真实 SessionProjectionRegistry 语义的 mock + 大事件量会话验证：
// 1) 分片预热产出与同步折叠完全一致
// 2) checkpoint 基线跳过前缀
// 3) 预热期间并发 drive（热 cell）不冲突
// 4) 会话消失中止
// 5) dispose 生命周期
import { Session } from '@deepseek-ai/dsh-session'
import { performance } from 'node:perf_hooks'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

// ---- mock registry（复刻 rc.6 SessionProjectionRegistry 的关键行为） ----
function makeRegistry() {
  const registry = {
    registrations: new Map(),
    listeners: new Set(),
    register(def) {
      const entry = { def, cells: new WeakMap(), refs: 1 }
      this.registrations.set(def.key, entry)
      return () => { this.registrations.delete(def.key) }
    },
    // 与框架一致：同步冷折叠
    cellFor(registration, session) {
      let cell = registration.cells.get(session)
      if (cell === void 0) {
        cell = this.buildCell(registration.def, session.events)
        registration.cells.set(session, cell)
      }
      return cell
    },
    buildCell(def, events) {
      let state = def.init()
      for (const e of events) state = def.apply(state, e)
      return { state, observedSeq: events.at(-1)?.seq ?? -1 }
    },
    snapshot(session) {
      const values = {}
      for (const reg of this.registrations.values()) {
        const cell = this.cellFor(reg, session)
        values[reg.def.key] = reg.def.schema.parse(reg.def.view(cell.state))
      }
      return { asOfSeq: session.seq - 1, values }
    },
    drive(session, event) {
      for (const reg of this.registrations.values()) {
        let cell = reg.cells.get(session)
        if (cell === void 0) { cell = this.buildCell(reg.def, session.events.slice(0, event.seq)); reg.cells.set(session, cell) }
        cell.state = reg.def.apply(cell.state, event)
        cell.observedSeq = event.seq
      }
    },
  }
  return registry
}

// 两个测试 unit：计数器 + 奇偶翻转（状态引用变化可观察）
const defCounter = {
  key: 'counter',
  stateVersion: 1,
  schema: { parse: (v) => v },
  init: () => ({ count: 0, lastSeq: -1 }),
  apply: (s, e) => ({ count: s.count + 1, lastSeq: e.seq }),
  view: (s) => s,
}
const defFlip = {
  key: 'flip',
  stateVersion: 1,
  schema: { parse: (v) => v },
  init: () => ({ on: false }),
  apply: (s, e) => (e.seq % 2 === 0 ? { on: !s.on } : s),
  view: (s) => s,
}

function text(len) { let s = ''; while (s.length < len) s += 'x'; return s.slice(0, len) }
function buildEvents(n) {
  const events = []
  for (let seq = 0; seq < n; seq++) {
    events.push({ type: seq % 5 === 0 ? 'turn/start' : 'step/start', seq, time: Date.now() + seq, data: { turn: 1 + Math.floor(seq / 5), step: 1, text: text(120) } })
  }
  return events
}

const plugin = await import('../lib/index.js')

function makeCtx({ registry, sessions }) {
  return {
    get: (name) => (name === 'sessionProjections' ? registry : name === 'settings' ? void 0 : void 0),
    on: () => () => {},
    inject: () => {},
    effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
    sessions: { get: (id) => sessions.get(id), list: () => [...sessions.values()] },
    logger: { warn: () => {} },
  }
}

// ================= 用例 1：分片预热结果与同步折叠一致 =================
{
  const registry = makeRegistry()
  registry.register(defCounter)
  registry.register(defFlip)
  const N = 30000
  const events = buildEvents(N)
  // 不可变会话对象（模拟真实 Session：events 冻结快照）
  const session = { id: 's1', header: { id: 's1', version: 0, createdAt: Date.now(), cwd: 'C:\\b' }, events: Object.freeze([...events]) }
  const sessions = new Map([['s1', session]])

  // 基线：纯同步折叠
  const tSync0 = performance.now()
  const cellSyncCounter = registry.buildCell(defCounter, events)
  const cellSyncFlip = registry.buildCell(defFlip, events)
  const tSync = performance.now() - tSync0

  // 干净 registry 再来一次：走插件预热
  const registry2 = makeRegistry()
  registry2.register({ ...defCounter })
  registry2.register({ ...defFlip })
  const ctx2 = makeCtx({ registry: registry2, sessions })
  const dispose = plugin.apply(ctx2)
  // 手动触发预热（测试里 session/created mock 为 no-op）
  await new Promise((resolve) => {
    // 通过导出的内部？不可；直接调用插件的 warmSession 需要事件——
    // 改为直接调用 registry2.cellFor 前先手动跑一次分片逻辑：
    resolve()
  })
  // 调用插件的公开路径：apply 已对 sessions.list() 里的会话预热
  await new Promise((r) => setTimeout(r, 600)) // 等分片完成（30000/5000=6 片）

  const cellWarmCounter = registry2.registrations.get('counter')?.cells.get(session)
  const cellWarmFlip = registry2.registrations.get('flip')?.cells.get(session)
  check('cells warmed (both units)', cellWarmCounter !== void 0 && cellWarmFlip !== void 0)
  if (cellWarmCounter && cellWarmFlip) {
    check('counter state identical to sync fold', JSON.stringify(cellWarmCounter.state) === JSON.stringify(cellSyncCounter.state),
      `warm=${JSON.stringify(cellWarmCounter.state)} sync=${JSON.stringify(cellSyncCounter.state)}`)
    check('flip state identical to sync fold', JSON.stringify(cellWarmFlip.state) === JSON.stringify(cellSyncFlip.state))
    check('observedSeq identical', cellWarmCounter.observedSeq === cellSyncCounter.observedSeq && cellWarmFlip.observedSeq === cellSyncFlip.observedSeq)
  }
  // 预热后 snapshot 直接命中（不再触发同步 buildCell）——验证方式：
  // 替换 buildCell 为抛错函数，snapshot 仍成功
  const origBuild = registry2.buildCell
  registry2.buildCell = () => { throw new Error('buildCell must not be called on warm cells') }
  let snapOk = true
  try { registry2.snapshot(session) } catch { snapOk = false }
  check('snapshot hits warm cells (no cold fold)', snapOk)
  registry2.buildCell = origBuild
  console.log(`  sync fold: ${tSync.toFixed(0)}ms for ${N} events (reference)`)
  dispose()
}

// ================= 用例 2：checkpoint 基线跳过前缀 =================
{
  const registry = makeRegistry()
  registry.register(defCounter)
  const N = 20000
  const events = buildEvents(N)
  const session = { id: 's2', header: { id: 's2', version: 0, createdAt: Date.now(), cwd: 'C:\\b' }, events: Object.freeze([...events]) }
  const sessions = new Map([['s2', session]])
  // mock 投影缓存：基线到 seq 14999（15000 事件已折叠）
  const cacheRow = { ver: 1, seq: 14999, val: { count: 15000, lastSeq: 14999 } }
  const ctx2 = makeCtx({ registry, sessions })
  ctx2.get = (name) => name === 'sessionProjectionCache'
    ? { recordFor: () => ({ rows: { counter: cacheRow } }) }
    : name === 'sessionProjections' ? registry : void 0
  const dispose = plugin.apply(ctx2)
  await new Promise((r) => setTimeout(r, 500))
  const cell = registry.registrations.get('counter')?.cells.get(session)
  check('baseline warmup completes', cell !== void 0)
  if (cell) check('baseline result identical', JSON.stringify(cell.state) === JSON.stringify({ count: N, lastSeq: N - 1 }),
    `state=${JSON.stringify(cell.state)}`)
  dispose()
}

// ================= 用例 3：并发 drive 建热 cell → 预热让位 =================
{
  const registry = makeRegistry()
  registry.register(defCounter)
  const N = 25000
  const events = buildEvents(N)
  const session = { id: 's3', header: { id: 's3', version: 0, createdAt: Date.now(), cwd: 'C:\\b' }, events: Object.freeze([...events]) }
  const sessions = new Map([['s3', session]])
  const ctx2 = makeCtx({ registry, sessions })
  const dispose = plugin.apply(ctx2)
  // 预热启动后立刻并发触发 drive（建热 cell）
  await new Promise((r) => setImmediate(r))
  registry.drive(session, events.at(-1))
  await new Promise((r) => setTimeout(r, 400))
  const cell = registry.registrations.get('counter')?.cells.get(session)
  check('concurrent drive wins, cell warm via drive', cell !== void 0 && cell.state.count === N,
    `count=${cell?.state.count}`)
  dispose()
}

// ================= 用例 4：会话消失中止预热 =================
{
  const registry = makeRegistry()
  // 慢 unit：每次 apply 微延迟，保证分片跨多个事件循环轮次
  let applyCalls = 0
  const defSlow = {
    key: 'slow',
    stateVersion: 1,
    schema: { parse: (v) => v },
    init: () => ({ n: 0 }),
    apply: (s, e) => { applyCalls++; return { n: s.n + 1 } },
    view: (s) => s,
  }
  registry.register(defSlow)
  const N = 60000
  const events = buildEvents(N)
  const session = { id: 's4', header: { id: 's4', version: 0, createdAt: Date.now(), cwd: 'C:\\b' }, events: Object.freeze([...events]) }
  const sessions = new Map([['s4', session]])
  const ctx2 = makeCtx({ registry, sessions })
  const dispose = plugin.apply(ctx2)
  // 预热首片后 yield（setImmediate），setTimeout(1) 在下一轮 timers 触发，
  // 此时折叠远未完成（60 片），删除会话 → 下一次片头检查中止
  await new Promise((r) => setTimeout(r, 1))
  sessions.delete('s4') // 模拟 dispose（下一次片头检查应中止）
  await new Promise((r) => setTimeout(r, 300))
  const cell = registry.registrations.get('slow')?.cells.get(session)
  check('aborted on session dispose (no cell written)', cell === void 0,
    `cell=${cell ? 'WRITTEN' : 'absent'}`)
  dispose()
}

// ================= 用例 5：小会话跳过 + dispose 无害 =================
{
  const registry = makeRegistry()
  registry.register(defCounter)
  const session = { id: 's5', header: { id: 's5', version: 0, createdAt: Date.now(), cwd: 'C:\\b' }, events: Object.freeze(buildEvents(100)) }
  const sessions = new Map([['s5', session]])
  const ctx2 = makeCtx({ registry, sessions })
  const dispose = plugin.apply(ctx2)
  await new Promise((r) => setTimeout(r, 100))
  const cell = registry.registrations.get('counter')?.cells.get(session)
  check('small session skipped (below minEvents)', cell === void 0)
  dispose()
  check('dispose runs clean', true)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
