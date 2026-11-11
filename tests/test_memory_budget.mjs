// v1.9 测试：事件缓存按字节限容（memory-budget.js）
//
// 契约要点：
//   1. 只在总估算字节超预算时淘汰，未超不动；
//   2. 只删 `refs === 0`（未被 lease 钉住）的条目；
//   3. 从最旧（Map 插入序）开始删；
//   4. 全部被 pin 时允许暂时超预算并计数，不抛错；
//   5. 预算为 0 / 服务缺失时静默 inactive，不抛；
//   6. 估算用 `events.length × BYTES_PER_EVENT`，不依赖真实堆。

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const { installMemoryBudget } = await import('../lib/memory-budget.js')
// BYTES_PER_EVENT 在 v1.10.0 移到了 constants.js（原先从 memory-budget 导出）
const { BYTES_PER_EVENT } = await import('../lib/constants.js')

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

function makeHarness({ eventsPerSession = 100000, cacheSessions = 5, budget = 200 * 1048576, pins = [] } = {}) {
  const stats = {
    memoryBudgetTrimmed: 0, memoryBudgetFreedBytes: 0, memoryBudgetOverBudget: 0,
  }
  const cache = new Map()
  for (let i = 0; i < cacheSessions; i++) {
    const id = `session-${i}`
    cache.set(id, {
      session: { header: { id }, inheritedEventCount: 0 },
      events: new Array(eventsPerSession).fill(null),
      revision: `rev-${i}`,
      refs: pins.includes(i) ? 1 : 0,
    })
  }
  // 复刻上游的 store：delete+set 提升 MRU，然后按条数淘汰
  const reader = {
    cache,
    cacheCapacity: 5,
    store(sessionId, entry) {
      cache.delete(sessionId)
      cache.set(sessionId, entry)
      this.evictPastCapacity(entry)
    },
    evictPastCapacity(keep) {
      if (cache.size <= this.cacheCapacity) return
      for (const [id, c] of cache) {
        if (c === keep || c.refs > 0) continue
        cache.delete(id)
        if (cache.size <= this.cacheCapacity) return
      }
    },
  }

  const logs = []
  const ctx = {
    get: (n) => {
      if (n === 'sessionQuery') return { _observations: reader }
      if (n === 'sessionPersistence') return { coldLogMemo: new Map() }
      return void 0
    },
    on: () => () => {},
    sessions: { get: () => void 0, list: () => [] },
    logger: { warn() {}, info() {}, error() {} },
  }
  const pc = {
    ctx, config: { memoryBudgetBytes: budget }, stats, disposers: [],
    safeGet: (c, n) => c.get?.(n),
    log: (...a) => logs.push(a.join(' ')),
    logErr: (...a) => logs.push('ERR ' + a.join(' ')),
    setPatchStatus: (n, s) => { pc.__status = s },
  }
  return { pc, reader, cache, stats, logs, eventsPerSession }
}

// ---- 常量 ----
check('bytes-per-event is a sane estimate (300-500)', BYTES_PER_EVENT >= 300 && BYTES_PER_EVENT <= 500, String(BYTES_PER_EVENT))

// ---- 未超预算不动 ----
{
  const h = makeHarness({ eventsPerSession: 10000, cacheSessions: 5, budget: 1024 * 1048576 })
  installMemoryBudget(h.pc, h.pc.ctx)
  check('install: active', h.pc.__status === 'active')
  const before = h.cache.size
  // 触发一次 store 让它检查
  h.reader.store('session-0', h.cache.get('session-0'))
  check('under budget: nothing evicted', h.cache.size === before, `size=${h.cache.size}`)
  check('under budget: no trim counter', h.stats.memoryBudgetTrimmed === 0)
}

// ---- 超预算时按字节淘汰 ----
{
  // 10 万事件 × 400B = 40 MB/会话；5 个 = 200 MB；预算 100 MB → 应淘汰到只剩 2 个
  const h = makeHarness({ eventsPerSession: 100000, cacheSessions: 5, budget: 100 * 1048576 })
  installMemoryBudget(h.pc, h.pc.ctx)
  // 触发 check：store 一个已有条目（会 delete+set 提升为 MRU）
  const mruEntry = h.cache.get('session-0')
  h.reader.store('session-0', mruEntry)
  const remaining = [...h.cache.keys()]
  check('over budget: evicted down to 2 entries', h.cache.size === 2, `kept=${remaining.join(',')}`)
  check('over budget: MRU entry kept', h.cache.has('session-0'), remaining.join(','))
  check('over budget: evicted oldest first', !h.cache.has('session-1') && !h.cache.has('session-2'), remaining.join(','))
  check('over budget: counter reflects evictions', h.stats.memoryBudgetTrimmed === 3, String(h.stats.memoryBudgetTrimmed))
  check('over budget: freed bytes counted',
    h.stats.memoryBudgetFreedBytes === 3 * 100000 * BYTES_PER_EVENT, String(h.stats.memoryBudgetFreedBytes))
}

// ---- 被 pin 的条目不删 ----
{
  // 5 个会话，预算只够 1 个；但前 4 个被 pin
  const h = makeHarness({ eventsPerSession: 100000, cacheSessions: 5, budget: 50 * 1048576, pins: [0, 1, 2, 3] })
  installMemoryBudget(h.pc, h.pc.ctx)
  h.reader.store('session-4', h.cache.get('session-4'))
  // 只有 session-4 可删，但它就是 keep → 上游不删；我们的字节淘汰也不该删 pin 的
  const pinnedAll = [0, 1, 2, 3].every((i) => h.cache.has(`session-${i}`))
  check('pinned entries survive', pinnedAll, [...h.cache.keys()].join(','))
  check('over-budget event counted when all pinned',
    h.stats.memoryBudgetOverBudget >= 1, String(h.stats.memoryBudgetOverBudget))
}

// ---- 预算为 0 = 关闭 ----
{
  const h = makeHarness({ budget: 0 })
  installMemoryBudget(h.pc, h.pc.ctx)
  check('budget=0: status off', h.pc.__status === 'off')
}

// ---- 服务缺失不抛 ----
{
  const pc = {
    ctx: { get: () => void 0, on: () => () => {}, sessions: { get() {}, list: () => [] } },
    config: { memoryBudgetBytes: 1048576 },
    stats: { memoryBudgetTrimmed: 0, memoryBudgetFreedBytes: 0, memoryBudgetOverBudget: 0 },
    disposers: [], safeGet: (c, n) => c.get?.(n),
    log: () => {}, logErr: () => {}, setPatchStatus: (n, s) => { pc.__status = s },
  }
  let threw = false
  try { installMemoryBudget(pc, pc.ctx) } catch { threw = true }
  check('missing sessionQuery: does not throw', threw === false)
  check('missing sessionQuery: inactive', pc.__status === 'inactive')
}

// ---- dispose 还原 ----
{
  const h = makeHarness({ eventsPerSession: 10000, budget: 1024 * 1048576 })
  const before = h.reader.store
  installMemoryBudget(h.pc, h.pc.ctx)
  check('install: store wrapped', h.reader.store !== before)
  for (const d of h.pc.disposers.splice(0)) d()
  check('dispose: store restored', h.reader.store === before)
}

// ---- 统计接口 ----
// v1.10.0 起快照挂在 `stats.memoryBudget`（statt.get 可读），不再挂 pc 下的函数。
{
  const h = makeHarness({ eventsPerSession: 50000, cacheSessions: 3, budget: 1024 * 1048576 })
  installMemoryBudget(h.pc, h.pc.ctx)
  const s = h.stats.memoryBudget
  check('stats: snapshot exposed on stats', s !== undefined)
  check('stats: reports budget', s?.budgetBytes === 1024 * 1048576)
  check('stats: reports estimated bytes', s?.estimatedBytes === 3 * 50000 * BYTES_PER_EVENT, String(s?.estimatedBytes))
  check('stats: reports cached entries', s?.cachedEntries === 3)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
