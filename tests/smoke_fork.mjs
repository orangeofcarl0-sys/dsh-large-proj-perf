// 冒烟测试：mock cordis ctx + 真实 SessionStore，验证
// 1) apply/dispose 生命周期
// 2) 零拷贝 fork 与官方 fork 的功能等价（header/事件序列/深冻结/store 状态）
// 3) 补丁在能力缺失时回退官方实现
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { performance } from 'node:perf_hooks'

// ---- mock cordis Context（覆盖插件与 SessionStore 用到的面） ----
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Context } from '@deepseek-ai/cordis'

// kScope 是 dsh-scope 的私有 Symbol；构造一个最小可用的 carrier 代替：
// enter() 只用 scopeTarget(session, scopeOf(ctx)) 做监听器过滤，测试里
// 直接给 ctx 一个 carrier 语义（无 scope = 全局匹配）即可。
function makeCtx(store) {
  const listeners = { on: [], effect: [] }
  const services = new Map()
  const events = {
    dispatch: (kind, args) => {
      const name = args?.[0]
      return listeners.on.filter((l) => l.event === name).map((l) => l.cb)
    },
  }
  const ctx = {
    get: (name) => services.get(name),
    provide: () => () => {},
    on: (event, cb) => { listeners.on.push({ event, cb }); return () => {} },
    effect: (gen, label) => {
      const it = gen()
      const step = (r) => {
        const { value, done } = it.next(r)
        if (!done) step(typeof value?.then === 'function' ? void 0 : value)
      }
      step()
    },
    events,
    parallel: () => Promise.resolve([]),
    logger: { warn: () => {}, info: () => {} },
    [Context.filter]: () => true,
  }
  return { ctx, listeners, services }
}

// ---- 构造真实 SessionStore（绕过 cordis Service 基类构造） ----
function makeStore() {
  const proto = SessionStore.prototype
  const store = Object.create(proto)
  store.store = new Map()
  store.counter = 0
  const { ctx } = makeCtx(store)
  // enter() 会把 store.ctx 捕获为 emitCtx；announce 用它做 events.dispatch
  store.ctx = ctx
  return store
}

// ---- 造一个有历史事件的源会话（含 surfaceOp 合法形态） ----
function text(len) { let s = ''; while (s.length < len) s += 'lorem ipsum dolor sit '; return s.slice(0, len) }
const seedEvents = []
{
  let turn = 0
  for (let seq = 0; seq < 2000; seq++) {
    const kind = seq % 8
    const time = Date.now() + seq
    if (kind === 0) seedEvents.push({ type: 'turn/start', seq, time, data: { turn: ++turn } })
    else if (kind === 1) seedEvents.push({ type: 'user/message', seq, time, data: { content: [{ type: 'text', text: text(500) }], source: { kind: 'user' }, role: 'user', id: `m${seq}` }, surfaceOp: 'append' })
    else if (kind === 2) seedEvents.push({ type: 'assistant/message', seq, time, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: text(800) }], source: { kind: 'model', provider: 't', model: 't' }, id: `a${seq}` } }, surfaceOp: 'append' })
    else if (kind === 3) seedEvents.push({ type: 'tool/call', seq, time, data: { turn, step: 1, name: 'bash', callId: `c${seq}`, arguments: { command: 'ls' } } })
    else if (kind === 4) seedEvents.push({ type: 'tool/result', seq, time, data: { turn, step: 1, message: { source: { kind: 'tool', callId: `c${seq - 1}` }, content: [{ type: 'tool-result', toolCallId: `c${seq - 1}`, content: [{ type: 'text', text: text(1500) }], isError: false }], role: 'user', id: `r${seq}` } }, sourceEventSeqs: [seq - 1], surfaceOp: 'append' })
    else if (kind === 5) seedEvents.push({ type: 'step/start', seq, time, data: { turn, step: 1 } })
    else if (kind === 6) seedEvents.push({ type: 'step/end', seq, time, data: { turn, step: 1 } })
    else seedEvents.push({ type: 'turn/end', seq, time, data: { turn, reason: { kind: 'completed' } } })
  }
}

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

// ================= 用例 1：官方 fork 基线（未打补丁） =================
{
  const store = makeStore()
  const { ctx } = makeCtx(store)
  store.ctx = { ...store.ctx, effect: ctx.effect }
  const src = store.create('session-src1', { seed: seedEvents, meta: { cwd: 'F:\\bench', delegationDepth: 0, agentPreset: 'code', origin: 'subagent' } })
  const t0 = performance.now()
  const child = store.fork('session-src1')
  const nativeMs = performance.now() - t0
  // src.events 已含构造期追加的 end-seed；fork seed 复制全部事件，
  // 但 _forkSeed 截到 lastEvent，构造器再补一个新 end-seed → 数量相同
  const srcEvents = src.snapshotEvents()
  const childEvents = child.snapshotEvents()
  check('native fork works', childEvents.length === srcEvents.length)
  check('native fork header', child.header.parentSession === 'session-src1' && child.header.isSeeded === true)
  check('native fork header has no seedLength (alpha.5)', !('seedLength' in child.header))
  // alpha.5 原生 fork 的 meta 只带 cwd/parentSession/isSeeded——不继承 origin
  check('native fork does not inherit origin', !('origin' in child.header))
  console.log(`  native fork: ${nativeMs.toFixed(1)}ms, events=${childEvents.length}`)
}

// ================= 用例 2：插件 apply → 零拷贝 fork → dispose =================
{
  const store = makeStore()
  const { ctx } = makeCtx(store)
  store.ctx = { ...store.ctx, effect: ctx.effect }
  const src = store.create('session-src2', { seed: seedEvents, meta: { cwd: 'F:\\bench', delegationDepth: 0, agentPreset: 'code', origin: 'subagent' } })

  const plugin = await import('../lib/index.js')
  const dispose = plugin.apply({ ...ctx, sessions: store })

  const t0 = performance.now()
  const child = store.fork('session-src2')
  const patchedMs = performance.now() - t0

  const zeroChildEvents = child.snapshotEvents()
  check('zero-copy fork works', zeroChildEvents.length === src.snapshotEvents().length)
  check('zero-copy fork header parent', child.header.parentSession === 'session-src2')
  check('zero-copy fork header isSeeded', child.header.isSeeded === true)
  check('zero-copy fork header has no seedLength (alpha.5)', !('seedLength' in child.header))
  check('zero-copy fork cwd inherited', child.header.cwd === 'F:\\bench')
  // 官方 fork 本身不继承 agentPreset/delegationDepth/origin（已验证 rc.6 行为），
  // 插件行为与官方一致：
  check('header parity with native (no agentPreset)', !('agentPreset' in child.header) && !('delegationDepth' in child.header))
  check('header parity with native (no origin)', !('origin' in child.header))
  check('child in store', store.get(child.id) === child)
  // 深冻结：共享引用不可变
  let frozen = true
  try { zeroChildEvents[1].data.content[0].text = 'MUTATE' } catch { frozen = false }
  check('events deep-frozen (shared refs immutable)', !frozen)
  // 与官方产物逐事件 JSON 等价：seed 的最后一个事件是各源自带的 end-seed 标记
  // （建源时间戳不同），比对排除它——其余前缀来自共享 seedEvents，确定性数据
  const baselineEvents = makeStoreForkBaseline()
  check('event stream length matches native', zeroChildEvents.length === baselineEvents.length)
  check('seed prefix byte-identical to native',
    JSON.stringify(zeroChildEvents.slice(0, child.header.inheritedEventCount - 1)) === JSON.stringify(baselineEvents.slice(0, child.header.inheritedEventCount - 1)))
  console.log(`  zero-copy fork: ${patchedMs.toFixed(1)}ms  (native baseline ~${'346ms @20k events / scaled'}`+`)`)

  // boundary fork（中途分叉）
  const midChild = store.fork('session-src2', 999)
  check('boundary fork at seq 999', midChild.snapshotEvents().length === 1000 + 1 && midChild.header.isSeeded === true && midChild.inheritedEventCount === 1000)

  // open turn 保护：找 turn/start 未闭合点
  let openTurnErr = false
  try { store.fork('session-src2', 8) } catch (e) { openTurnErr = /open turn/i.test(e.message) }
  check('open-turn boundary rejected like native', openTurnErr)

  // dispose 恢复官方实现
  dispose()
  const t2 = performance.now()
  const child2 = store.fork('session-src2')
  const nativeMs2 = performance.now() - t2
  check('dispose restores native fork', child2.snapshotEvents().length === src.snapshotEvents().length)
  console.log(`  post-dispose fork: ${nativeMs2.toFixed(1)}ms`)
}

function makeStoreForkBaseline() {
  const store = makeStore()
  const { ctx } = makeCtx(store)
  store.ctx = { ...store.ctx, effect: ctx.effect }
  const src = store.create('session-src-baseline', { seed: seedEvents, meta: { cwd: 'F:\\bench', delegationDepth: 0, agentPreset: 'code' } })
  return store.fork('session-src-baseline').snapshotEvents()
}

// ================= 用例 3：能力缺失自动回退 =================
{
  const store = makeStore()
  const { ctx } = makeCtx(store)
  store.ctx = { ...store.ctx, effect: ctx.effect }
  const src = store.create('session-src3', { seed: seedEvents, meta: { cwd: 'F:\\bench' } })
  const plugin = await import('../lib/index.js')
  const dispose = plugin.apply({ ...ctx, sessions: store })
  // 模拟版本漂移：restore 通道消失（prepare 不再支持 seedSource:'persistence'）
  // —— 补丁额外依赖、官方路径不依赖的能力，探测失败必须回退官方实现。
  const proto = Object.getPrototypeOf(store)
  const savedPrepare = proto.prepare
  proto.prepare = function (id, options) {
    if (options?.seedSource === 'persistence') {
      const e = new Error('seedSource persistence unsupported')
      throw e
    }
    return savedPrepare.call(this, id, options)
  }
  let child
  try { child = store.fork('session-src3') } catch (e) { child = void 0; console.error('  fallback threw:', e.message) }
  // 探测无法预知 prepare 会拒绝 restore；该场景由 try/catch 兜底转官方：
  check('fallback to native on restore-channel drift', child !== void 0 && child.snapshotEvents().length === src.snapshotEvents().length)
  proto.prepare = savedPrepare
  dispose()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
