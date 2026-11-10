// v1.7 测试：冷读回写（cold-writeback.js）+ 共享 identity 构造器
//
// 回写的契约要点：
//   1. 包装 hydratePrepared 后必须**同步返回**原实现的结果（不改变冷读响应）；
//   2. 回写发生在 setImmediate 之后（不在调用方的同步栈里插磁盘 IO）；
//   3. 已有行的 ver/seq 与本次算出的一致时**不重写**（避免每次冷读都 fsync）；
//   4. 低于 minEvents 不写（小会话折叠本来就快）；
//   5. put 失败只记日志与计数，绝不影响读取；
//   6. dispose 必须还原原方法（原型方法 → delete 自有属性）。

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const flushImmediate = () => new Promise((r) => setImmediate(r))

const { makeCacheIdentity } = await import('../lib/cache-identity.js')
const { installColdWriteBack } = await import('../lib/cold-writeback.js')

// ---- 共享 identity 构造器：必须与上游 identityOf 逐字段一致 ----
{
  const identity = makeCacheIdentity((v) => v)
  const header = { version: 4, createdAt: 1234, cwd: 'F:\\proj', isSeeded: true }
  const got = identity(header, 62851)
  check('identity: formatVersion first key', Object.keys(got)[0] === 'formatVersion', Object.keys(got).join(','))
  check('identity: formatVersion from header.version', got.formatVersion === 4)
  check('identity: createdAt / cwd / isSeeded', got.createdAt === 1234 && got.cwd === 'F:\\proj' && got.isSeeded === true)
  check('identity: inheritedEventCount last', Object.keys(got).at(-1) === 'inheritedEventCount', String(got.inheritedEventCount))

  // cwd 缺失时必须**整键省略**（不是 undefined），否则与上游 `identityMatches`
  // 的 `stored.cwd === expected.cwd` 比较语义会漂移。
  const noCwd = identity({ version: 4, createdAt: 1, isSeeded: false }, 0)
  check('identity: cwd omitted when absent', !('cwd' in noCwd))
  check('identity: isSeeded defaults false', noCwd.isSeeded === false)
}

// ---- 回写主路径 ----
function makeHarness({ events = 30000, minEvents = 20000, existingRows = null, putFails = false, config = {} } = {}) {
  const puts = []
  const session = { id: 'session-cold-1', header: { version: 4, createdAt: 999, cwd: 'F:\\p', isSeeded: false }, inheritedEventCount: 0 }
  const rows = { alpha: { ver: 1, seq: events - 1, val: { n: 1 } } }
  const putsByCall = []

  const cache = {
    recordFor: (id, identity) => (existingRows === null ? void 0 : { identity, rows: existingRows }),
    hydratePrepared(sessionArg, eventsArg) {
      return { asOfSeq: eventsArg.length - 1, values: { alpha: { n: 1 } } }
    },
    put(id, identity, r) {
      putsByCall.push({ id, identity, r })
      if (putFails) return Promise.reject(new Error('disk full'))
      return Promise.resolve()
    },
  }

  const registrations = new Map([['alpha', { refs: 1, def: { key: 'alpha', stateVersion: 1 }, cells: new WeakMap() }]])
  registrations.get('alpha').cells.set(session, { state: { n: 1 }, observedSeq: events - 1, views: [void 0, void 0] })

  const registry = {
    checkpoint(s) {
      const out = {}
      for (const [key, reg] of registrations) {
        const cell = reg.cells.get(s)
        if (cell === void 0) continue
        out[key] = { ver: reg.def.stateVersion, seq: cell.observedSeq, val: cell.state }
      }
      return out
    },
  }

  const stats = { coldWriteBacks: 0, coldWriteBackSkipped: 0, coldWriteBackFailed: 0, coldWriteBackRecent: [] }
  const logs = []
  const ctx = {
    get: (name) => (name === 'sessionProjections' ? registry : void 0),
    on: () => () => {},
    inject: (deps, cb) => { if (deps.includes('sessionProjectionCache')) cb(injected) },
    effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
    sessions: { get: () => void 0, list: () => [] },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  // installColdWriteBack 经 safeGet(actx,'sessionProjectionCache') 取服务；
  // 测试里把 cache 直接挂到注入上下文上（与 dsh 的 ctx.inject 语义一致）。
  const injected = { ...ctx, get: (name) => (name === 'sessionProjectionCache' ? cache : ctx.get(name)) }

  const pc = {
    ctx: injected, config: { coldWriteBack: true, minEvents, keepRecent: 50, debugApi: false, ...config },
    stats, disposers: [],
    safeGet: (c, name) => c.get?.(name),
    cacheIdentityOf: makeCacheIdentity((v) => v),
    log: (...a) => logs.push(a.join(' ')),
    logErr: (...a) => logs.push('ERR ' + a.join(' ')),
    setPatchStatus: () => {},
  }
  return { pc, cache, session, events, putsByCall, stats, logs }
}

{
  const h = makeHarness({ events: 30000 })
  const before = h.cache.hydratePrepared
  installColdWriteBack(h.pc, h.ctx)
  const wrapped = h.cache.hydratePrepared
  check('install: replaces hydratePrepared', wrapped !== before)

  // 同步返回原结果
  const eventsArr = Array.from({ length: 30000 }, (_, i) => ({ seq: i }))
  const snap = wrapped(h.session, eventsArr)
  check('sync: returns original snapshot immediately', snap?.asOfSeq === 29999 && snap?.values?.alpha?.n === 1)

  // 回写是异步的：此刻还没写
  check('async: no put before setImmediate', h.putsByCall.length === 0)

  await flushImmediate(); await tick(20)
  check('write-back: put called once', h.putsByCall.length === 1, `calls=${h.putsByCall.length}`)
  check('write-back: identity carries formatVersion', h.putsByCall[0]?.identity?.formatVersion === 4)
  check('write-back: rows carry unit + seq', h.putsByCall[0]?.r?.alpha?.seq === 29999)
  check('write-back: counted', h.stats.coldWriteBacks === 1)
  check('write-back: recent record', h.stats.coldWriteBackRecent.length === 1 && h.stats.coldWriteBackRecent[0].units === 1)
}

// ---- 门槛：低于 minEvents 不写 ----
{
  const h = makeHarness({ events: 100, minEvents: 20000 })
  installColdWriteBack(h.pc, h.ctx)
  h.cache.hydratePrepared(h.session, Array.from({ length: 100 }, (_, i) => ({ seq: i })))
  await flushImmediate(); await tick(20)
  check('threshold: below minEvents writes nothing', h.putsByCall.length === 0)
  check('threshold: counted as skipped', h.stats.coldWriteBackSkipped === 1)
}

// ---- 幂等：已有行 ver/seq 相同则不重写 ----
{
  const h = makeHarness({ events: 30000, existingRows: { alpha: { ver: 1, seq: 29999, val: { n: 1 } } } })
  installColdWriteBack(h.pc, h.ctx)
  h.cache.hydratePrepared(h.session, Array.from({ length: 30000 }, (_, i) => ({ seq: i })))
  await flushImmediate(); await tick(20)
  check('idempotent: unchanged rows are not rewritten', h.putsByCall.length === 0)
  check('idempotent: counted as skipped', h.stats.coldWriteBackSkipped === 1)
}

// ---- 陈旧行会被刷新 ----
{
  const h = makeHarness({ events: 30000, existingRows: { alpha: { ver: 1, seq: 100, val: { n: 0 } } } })
  installColdWriteBack(h.pc, h.ctx)
  h.cache.hydratePrepared(h.session, Array.from({ length: 30000 }, (_, i) => ({ seq: i })))
  await flushImmediate(); await tick(20)
  check('stale: old row is refreshed', h.putsByCall.length === 1 && h.putsByCall[0].r.alpha.seq === 29999)
}

// ---- put 失败被吞掉，只计数 ----
{
  const h = makeHarness({ events: 30000, putFails: true })
  installColdWriteBack(h.pc, h.ctx)
  const out = h.cache.hydratePrepared(h.session, Array.from({ length: 30000 }, (_, i) => ({ seq: i })))
  check('failure: read result unaffected', out?.asOfSeq === 29999)
  await flushImmediate(); await tick(30)
  check('failure: counted, not thrown', h.stats.coldWriteBackFailed === 1 && h.stats.coldWriteBacks === 0)
  check('failure: logged as error', h.logs.some((l) => l.startsWith('ERR')))
}

// ---- dispose 还原 ----
{
  // 情形 A：mock 的自有属性。dispose 要写回原函数本身。
  const h = makeHarness({ events: 30000 })
  const before = h.cache.hydratePrepared
  installColdWriteBack(h.pc, h.ctx)
  for (const d of h.pc.disposers.splice(0)) d()
  check('dispose: restores original method (own property)', h.cache.hydratePrepared === before)
  check('dispose: own property kept when it was originally own',
    Object.prototype.hasOwnProperty.call(h.cache, 'hydratePrepared'))
}

{
  // 情形 B：真实 dsh 后端——hydratePrepared 在**原型**上，patch 落在自有属性。
  // dispose 必须 delete 自有属性让方法回落原型，否则会留下一个副本遮蔽原型。
  class RealCache {
    hydratePrepared() { return { asOfSeq: 0, values: {} } }
    recordFor() { return void 0 }
    put() { return Promise.resolve() }
  }
  const cache = new RealCache()
  const protoMethod = Object.getPrototypeOf(cache).hydratePrepared
  const registry = { checkpoint: () => ({}) }
  const stats = { coldWriteBacks: 0, coldWriteBackSkipped: 0, coldWriteBackFailed: 0, coldWriteBackRecent: [] }
  const base = {
    get: (name) => (name === 'sessionProjections' ? registry : void 0),
    on: () => () => {},
    sessions: { get: () => void 0, list: () => [] },
    logger: { warn() {}, info() {}, error() {} },
  }
  const injected = { ...base, get: (n) => (n === 'sessionProjectionCache' ? cache : base.get(n)) }
  const pc = {
    ctx: injected,
    config: { coldWriteBack: true, minEvents: 1, keepRecent: 10, debugApi: false },
    stats, disposers: [],
    safeGet: (c, n) => c.get?.(n),
    cacheIdentityOf: makeCacheIdentity((v) => v),
    log: () => {}, logErr: () => {}, setPatchStatus: () => {},
  }
  installColdWriteBack(pc, injected)
  check('prototype: patch becomes own property', Object.prototype.hasOwnProperty.call(cache, 'hydratePrepared'))
  check('prototype: original prototype method untouched',
    Object.getPrototypeOf(cache).hydratePrepared === protoMethod)
  for (const d of pc.disposers.splice(0)) d()
  check('prototype: dispose deletes own property', !Object.prototype.hasOwnProperty.call(cache, 'hydratePrepared'))
  check('prototype: method falls back to prototype', typeof cache.hydratePrepared === 'function')
}

// ---- 配置关闭 ----
{
  const h = makeHarness({ events: 30000, config: { coldWriteBack: false } })
  const before = h.cache.hydratePrepared
  installColdWriteBack(h.pc, h.ctx)
  check('off: does not wrap when coldWriteBack=false', h.cache.hydratePrepared === before)
}

// ---- 服务缺失时不抛 ----
{
  const h = makeHarness({ events: 30000 })
  h.cache.hydratePrepared = undefined
  let threw = false
  try { installColdWriteBack(h.pc, h.ctx) } catch { threw = true }
  check('robust: missing hydratePrepared does not throw', threw === false)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
