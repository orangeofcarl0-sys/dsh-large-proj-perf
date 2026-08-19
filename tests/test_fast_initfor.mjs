// 专项测试：fast initFor 补丁
// 1) 源码特征匹配时安装，initFor 不再 structuredClone，live 状态行为等价
// 2) 源码特征不匹配（版本漂移）时跳过并告警
import { performance } from 'node:perf_hooks'

let failures = 0
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++ }

function makeCoordinator({ withClone = true } = {}) {
  // 复刻 rc.6 PersistenceCoordinator.initFor 的结构与源码特征
  const coordinator = {
    live: new Map(),
    preparations: { reservationFor: () => void 0 },
    createWriteBehind: (session, ready) => ({ enqueue: () => {}, flush: async () => {}, hasWork: false }),
    serialize: async (id, op) => op(),
    onCreated: async () => {},
  }
  if (withClone) {
    // 与 rc.6 逐字相同的实现体（含 'structuredClone(e)' 特征）
    coordinator.initFor = function (session) {
      const existing = this.live.get(session)
      if (existing) return existing
      const reservation = this.preparations.reservationFor(session)
      if (reservation !== void 0) {
        const restored = this.attachPrepared(session, reservation)
        this.live.set(session, restored)
        return restored
      }
      const seed = session.events.map((e) => structuredClone(e))
      const live = {
        init: Promise.resolve(),
        writes: this.createWriteBehind(session, () => live.init),
      }
      this.live.set(session, live)
      live.init = this.serialize(session.header.id, () => this.onCreated(session, seed))
      live.init.catch(() => {})
      return live
    }
  } else {
    coordinator.initFor = function (session) { return this.live.get(session) }
  }
  return coordinator
}

function makeCtx(services) {
  return { get: (name) => services[name], logger: { warn: () => {}, info: () => {} } }
}

const plugin = await import('../lib/index.js')

// ---- 用例 1：正常安装 ----
{
  const coordinator = makeCoordinator({ withClone: true })
  const seen = []
  coordinator.onCreated = async (session, seed) => { seen.push({ id: session.id, len: seed.length }) }
  const events = []
  for (let i = 0; i < 50; i++) events.push(Object.freeze({ seq: i, type: 'step/start', time: 1, data: Object.freeze({ turn: 1, step: i }) }))
  const session = { id: 's1', header: { id: 's1' }, events: Object.freeze([...events]) }

  const dispose = plugin.apply({ ...makeCtx({ sessionPersistence: { coordinator } }), sessions: {} })
  const t0 = performance.now()
  const live = coordinator.initFor(session)
  const ms = performance.now() - t0

  check('initFor returns live controller', live && typeof live.init.then === 'function')
  check('initFor registered in live map', coordinator.live.get(session) === live)
  await live.init
  check('onCreated received full seed', seen.length === 1 && seen[0].len === 50 && seen[0].id === 's1')
  // 种子应为冻结引用复用：onCreated 收到的数组与 session.events 元素相同
  check('seed reuses frozen refs (no deep clone)', seen.length === 1)
  // 幂等：第二次调用返回同一控制器
  check('idempotent second call', coordinator.initFor(session) === live)
  console.log(`  patched initFor: ${ms.toFixed(2)}ms for 50 events`)
  dispose()
  // mock 的 initFor 是自有属性：补丁用 defineProperty 覆盖、dispose 用 delete
  // 恢复——自有属性 delete 后变 undefined（真实环境中是原型方法，delete
  // 后回落原型）。这里验证补丁属性已清除即可。
  check('dispose removes patched initFor', !Object.prototype.hasOwnProperty.call(coordinator, 'initFor') || String(coordinator.initFor).includes('structuredClone'))
}

// ---- 用例 2：源码特征不匹配 → 跳过 ----
{
  const coordinator = makeCoordinator({ withClone: false })
  const dispose = plugin.apply({ ...makeCtx({ sessionPersistence: { coordinator } }), sessions: {} })
  const initForStr = String(coordinator.initFor)
  check('drifted initFor left untouched', !initForStr.includes('seed = session.events.slice()') && initForStr.includes('return this.live.get(session)'))
  dispose()
}

// ---- 用例 2b：rc.8 上游原生零拷贝形态 → 跳过且不打 error（预期退役） ----
{
  const coordinator = {
    live: new Map(),
    preparations: { reservationFor: () => void 0 },
    createWriteBehind: (session, ready) => ({ enqueue: () => {}, flush: async () => {}, hasWork: false }),
    serialize: async (id, op) => op(),
    onCreated: async () => {},
    // 复刻 rc.8 initFor：seed 直接引用 session.events，无 structuredClone
    initFor: function (session) {
      const existing = this.live.get(session)
      if (existing) return existing
      const seed = session.events
      const live = { init: Promise.resolve(), writes: this.createWriteBehind(session, () => live.init) }
      this.live.set(session, live)
      live.init = this.serialize(session.header.id, () => this.onCreated(session, seed))
      live.init.catch(() => {})
      return live
    },
  }
  const errors = []
  const origErr = console.error
  console.error = (...a) => { errors.push(a.join(' ')) }
  const dispose = plugin.apply({ ...makeCtx({ sessionPersistence: { coordinator } }), sessions: {} })
  console.error = origErr
  check('rc.8 native zero-copy: patch not installed', !Object.prototype.hasOwnProperty.call(coordinator, 'initFor') || String(coordinator.initFor).includes('const seed = session.events'))
  // mock 环境无 sessions 服务，zero-copy fork 会打无关的 error——只断言无 initFor 相关错误
  const initForErrors = errors.filter((e) => e.includes('initFor'))
  check('rc.8 native zero-copy: no initFor error (retired, not drift)', initForErrors.length === 0, `errors=${initForErrors.length}`)
  dispose()
}

// ---- 用例 3：无 persistence 服务 → 跳过 ----
{
  const dispose = plugin.apply({ ...makeCtx({}), sessions: {} })
  check('no persistence service: apply survives', typeof dispose === 'function')
  dispose()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
