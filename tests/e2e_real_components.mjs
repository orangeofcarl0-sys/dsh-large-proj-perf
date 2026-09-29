// 真实组件端到端验证：直接驱动 dsh 安装包里的**真实实现类**（非 mock 复刻），
// 覆盖插件的全部作用点位——每个点位都要求「真实源码特征 + 补丁安装 + 行为正确」
// 三者同时成立：
//
//   1. 分片 materialize —— 真实 JsonlSessionPersistence.prototype.encodeMaterialization
//   2. 投影分片预热   —— 真实 SessionProjectionRegistry（cellFor/snapshot/buildCell）
//   3. 零拷贝 fork    —— 真实 SessionStore/Session 的 fork 通道
//   4. 失效点位语义   —— fastInitFor / preparedCacheTrim 在上游无对应物时必须
//                       走 skipped（inactive）而不是误装
//
// 与 mock 套件的区别：这里的分支判定、特征探测、编码字节全部由真实源码决定，
// 上游一旦改动就会在这里暴露（mock 会继续「自洽地通过」）。

import { Session, SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { decodeAllFrames, countFrames } from './zstd_frames.mjs'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 通用最小 cordis ctx（记录 handlers 以便手动触发事件） ----
function makeCtx(services = {}) {
  const handlers = new Map()
  const logs = []
  const map = new Map(Object.entries(services))
  const ctx = {
    sessions: services.sessions,
    get: (name) => map.get(name),
    on: (event, cb) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(cb)
      return () => {}
    },
    inject: (deps, cb) => { if (deps.every((d) => map.has(d))) cb(ctx) },
    effect: (gen) => {
      const it = gen()
      const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }
      step()
    },
    logger: {
      info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    },
  }
  return { ctx, handlers, logs }
}

// 触发挂载在 session/created 上的预热
async function emitCreated(handlers, session, ms = 700) {
  for (const cb of handlers.get('session/created') ?? []) cb(session)
  await tick(ms)
}

function text(len) { let s = ''; while (s.length < len) s += 'e2e payload '; return s.slice(0, len) }
// 合法事件流（真实 Session 会做信封/结构校验）：turn/step 配对 + usage，
// 用于真实 store/registry 路径；materialize 路径不校验内容、同一构造复用。
function buildEvents(n) {
  const ev = []
  let turn = 0
  for (let seq = 0; seq < n; seq++) {
    const kind = seq % 5
    const time = 1000 + seq
    const pad = text(160) // 保持与真实负载同量级的体积
    if (kind === 0) ev.push({ type: 'turn/start', seq, time, data: { turn: ++turn, pad } })
    else if (kind === 1) ev.push({ type: 'step/start', seq, time, data: { turn, step: 1, pad } })
    else if (kind === 2) ev.push({ type: 'step/end', seq, time, data: { turn, step: 1, pad } })
    else if (kind === 3) ev.push({ type: 'turn/end', seq, time, data: { turn, reason: { kind: 'completed' }, pad } })
    else ev.push({ type: 'usage', seq, time, data: { turn, step: 1, usage: { inputTokens: 10, outputTokens: 20 }, pad } })
  }
  return ev
}
function splitFrames(buf) {
  const MAGIC = [0x28, 0xB5, 0x2F, 0xFD]
  const frames = []
  let start = -1
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      if (start !== -1) frames.push(buf.subarray(start, i))
      start = i
    }
  }
  if (start !== -1) frames.push(buf.subarray(start))
  return frames
}

// 合法 header 的真实 Session（header 必须完整：version 取运行时格式线）
const makeSession = (id, events) => Session.create(id, events, {
  version: SESSION_FORMAT_VERSION,
  id,
  createdAt: Date.now(),
  isSeeded: false,
  cwd: 'F:\\e2e',
})

const plugin = await import('../lib/index.js')

// ================= 点位 1：分片 materialize（真实 jsonl 后端） =================
{
  const makePersistence = () => {
    const p = Object.create(JsonlSessionPersistence.prototype) // 真实原型链
    p.compression = 'zstd'
    return p
  }
  const meta = { version: 4, id: 'session-e2e-mat', createdAt: 1, cwd: 'F:\\e2e', isSeeded: false }
  const events = buildEvents(60000) // > materializeChunkEvents(50000)

  const native = makePersistence()
  const nativeBuf = await native.encodeMaterialization(meta, 0, events)

  const patched = makePersistence()
  const { ctx, logs } = makeCtx({ sessionPersistence: patched })
  const dispose = plugin.apply(ctx)
  await tick(60)

  check('position 1: patch installed as own property on real prototype chain',
    Object.prototype.hasOwnProperty.call(patched, 'encodeMaterialization'))
  const patchedBuf = await patched.encodeMaterialization(meta, 0, events)
  check('position 1: multi-frame output', countFrames(patchedBuf) > countFrames(nativeBuf),
    `native=${countFrames(nativeBuf)} patched=${countFrames(patchedBuf)}`)
  check('position 1: header frame byte-identical (upstream encoder reused)',
    splitFrames(patchedBuf)[0].equals(splitFrames(nativeBuf)[0]))
  check('position 1: decoded payload byte-identical',
    decodeAllFrames(patchedBuf).equals(decodeAllFrames(nativeBuf)))
  // 小负载走原生路径
  const small = makePersistence()
  const smallDispose = plugin.apply(makeCtx({ sessionPersistence: small }).ctx)
  await tick(60)
  const smallBuf = await small.encodeMaterialization(meta, 0, buildEvents(1000))
  check('position 1: below-threshold delegates to native (2 frames)', countFrames(smallBuf) === 2)
  smallDispose(); dispose()
}

// ================= 点位 2：投影分片预热（真实 registry） =================
{
  const registry = Object.create(SessionProjectionRegistry.prototype)
  registry.registrations = new Map()
  registry.ctx = { effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() } }
  // 真实 def 形状（stateSchema + wire）
  registry.register({
    key: 'counter',
    stateVersion: 1,
    stateSchema: { parse: (v) => v },
    init: () => ({ count: 0, lastSeq: -1 }),
    apply: (s, e) => ({ count: s.count + 1, lastSeq: e.seq }),
    wire: { viewSchema: { parse: (v) => v }, view: (s) => s },
  })
  // 计数真实 buildCell 的调用（冷折叠次数）
  let coldFolds = 0
  const origBuildCell = registry.buildCell
  registry.buildCell = function (...args) { coldFolds += 1; return origBuildCell.apply(this, args) }

  const N = 25000
  const session = makeSession('session-e2e-warm', buildEvents(N))
  const store = Object.create(SessionStore.prototype)
  // 真实 store 条目形态是 { session } 包装（get() = this.store.get(id)?.session）
  store.store = new Map([[session.id, { session }]])
  store.counter = 0
  store.ctx = { effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() } }

  const { ctx, handlers } = makeCtx({ sessionProjections: registry, sessions: store })
  const dispose = plugin.apply(ctx)
  await emitCreated(handlers, session)

  const registration = registry.registrations.get('counter')
  check('position 2: cell written into real registry WeakMap',
    registration?.cells?.get(session) !== undefined)
  const snap = registry.snapshot(session) // 真实 snapshot 路径
  const total = session.snapshotEvents().length // 全部 live 事件（含构造期 end-seed 标记）
  check('position 2: snapshot served without any cold fold', coldFolds === 0, `coldFolds=${coldFolds}`)
  check('position 2: projected value correct', snap.values.counter?.count === total && snap.values.counter?.lastSeq === total - 1,
    `count=${snap.values.counter?.count} expected=${total}`)
  dispose()

  // 对照：不预热时 snapshot 必须触发一次冷折叠（证明上面的 0 是预热的功劳）
  let coldFolds2 = 0
  const registry2 = Object.create(SessionProjectionRegistry.prototype)
  registry2.registrations = new Map()
  registry2.ctx = registry.ctx
  registry2.register({
    key: 'counter', stateVersion: 1, stateSchema: { parse: (v) => v },
    init: () => ({ count: 0, lastSeq: -1 }), apply: (s, e) => ({ count: s.count + 1, lastSeq: e.seq }),
    wire: { viewSchema: { parse: (v) => v }, view: (s) => s },
  })
  const origBuildCell2 = registry2.buildCell
  registry2.buildCell = function (...args) { coldFolds2 += 1; return origBuildCell2.apply(this, args) }
  const session2 = makeSession('session-e2e-cold', buildEvents(N))
  registry2.snapshot(session2)
  check('position 2 control: unwarmed snapshot does cold fold', coldFolds2 === 1, `coldFolds=${coldFolds2}`)
}

// ================= 点位 3：零拷贝 fork（真实 SessionStore/Session） =================
{
  const store = Object.create(SessionStore.prototype)
  store.store = new Map()
  store.counter = 0
  const listeners = []
  store.ctx = {
    effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
    on: (e, cb) => { listeners.push(cb); return () => {} },
    parallel: () => Promise.resolve([]),
    // announce() 经 ctx.events.dispatch 收集 session/created 监听者
    events: { dispatch: () => [] },
  }
  const src = store.create('session-e2e-src', { seed: buildEvents(3000), meta: { cwd: 'F:\\e2e' } })

  const nativeChild = store.fork('session-e2e-src')
  const nativeEvents = nativeChild.snapshotEvents()

  const { ctx } = makeCtx({ sessions: store })
  const dispose = plugin.apply(ctx)
  const patchedChild = store.fork('session-e2e-src')
  const patchedEvents = patchedChild.snapshotEvents()

  check('position 3: patched fork produces same event count as native',
    patchedEvents.length === nativeEvents.length, `patched=${patchedEvents.length} native=${nativeEvents.length}`)
  check('position 3: inherited cut matches native',
    patchedChild.inheritedEventCount === nativeChild.inheritedEventCount,
    `cut=${patchedChild.inheritedEventCount}`)
  check('position 3: inherited prefix + marker byte-identical',
    JSON.stringify(patchedEvents.slice(0, patchedChild.inheritedEventCount + 1))
    === JSON.stringify(nativeEvents.slice(0, nativeChild.inheritedEventCount + 1)))
  let frozen = false
  try { patchedEvents[1].data.text = 'MUTATE' } catch { frozen = true }
  check('position 3: shared seed refs stay frozen (true zero-copy)', frozen)
  check('position 3: child header parity', patchedChild.header.parentSession === 'session-e2e-src'
    && patchedChild.header.isSeeded === true)
  dispose()
}

// ================= 点位 4：失效点位必须是 skipped（不是误装） =================
{
  // 真实 jsonl 后端实例上没有 coordinator / preparations（0.1.3 起 API 重写），
  // 两个旧补丁必须走 skipped 分支：日志出现 not found 且实例上不留任何自有属性
  const persistence = Object.create(JsonlSessionPersistence.prototype)
  persistence.compression = 'zstd'
  const { ctx, logs } = makeCtx({ sessionPersistence: persistence })
  const dispose = plugin.apply(ctx)
  await tick(60)
  const joined = logs.join('\n')
  check('position 4: fastInitFor skipped on rewritten persistence API',
    /fast initFor|coordinator not found/i.test(joined))
  check('position 4: preparedCacheTrim skipped on rewritten persistence API',
    /prepared cache trim|coordinator\.preparations not found/i.test(joined))
  check('position 4: no stray own properties patched onto real backend',
    !Object.prototype.hasOwnProperty.call(persistence, 'initFor')
    && !Object.prototype.hasOwnProperty.call(persistence, 'preparations'))
  dispose()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
