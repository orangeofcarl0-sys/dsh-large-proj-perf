// dsh-large-proj-perf — host half
//
// DSH 大会话性能插件：消除 fork / 历史加载 / 落盘对超大会话（数十万事件）的
// 事件循环阻塞与 OOM。问题与方案细节、实测数据见 README。
//
//   A. fork 深拷贝      → 零拷贝 fork（fromRestore 通道）+ fast initFor
//   B. projection 冷折叠 → 分片预热（片间让出事件循环）+ fork 缓存回填
//   C. fork 全量序列化   → 分片 materialize（多帧 zstd）
//   D. 内存治理          → 冷会话 LRU 裁剪 + heap 上限检测
//
// 安全性：所有补丁带源码特征校验（不符自动跳过并告警，绝不盲补）；三层回退
// （能力探测 / try-catch / 配置开关）；dispose 完整还原；上游吸收某能力后对应
// 补丁自动退役（stats.patches 可见）。升级 dsh 后先跑 tests/verify_compat.mjs。

import { performance } from 'node:perf_hooks'
import { constants as zlibConstants, zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'
import { getHeapStatistics } from 'node:v8'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const zstdCompressAsync = promisify(zstdCompress)
const CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

// 插件开发/验证过的 dsh 版本。运行时探针检测到列表外版本时打告警，并提示跑
// tests/verify_compat.mjs 确认补丁特征是否仍匹配（特征校验会自动跳过，但会静默失效）。
const KNOWN_DSH_VERSIONS = ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2', '0.1.2-alpha.5']

// SessionLogOffset（alpha.5 新增）：非负安全整数 + brand。真实环境从 dsh-session
// 取（顶层动态加载，缺失时用恒等 fallback——数值语义等价，仅少 brand 标记）。
let sessionLogOffset = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) return void 0
  return value
}
try {
  const mod = await import('@deepseek-ai/dsh-session')
  if (typeof mod.SessionLogOffset === 'function') sessionLogOffset = mod.SessionLogOffset
} catch { /* 测试 mock 环境：恒等 fallback */ }

// 版本探针：优先直接解析 @deepseek-ai/dsh（宿主进程内通常可解析）；bundle/
// 安装位置拿不到时，从 dsh-session 的安装路径上溯到 dsh 根读 package.json。
function probeDshVersion() {
  try {
    const entry = require.resolve('@deepseek-ai/dsh/package.json')
    return JSON.parse(readFileSync(entry, 'utf8')).version
  } catch { /* 走 dsh-session 反推 */ }
  try {
    const entry = require.resolve('@deepseek-ai/dsh-session/package.json')
    const root = join(dirname(entry), '..', '..', '..')
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  } catch { return void 0 }
}

// schemastery 可选依赖：顶层 await 加载，缺失时降级为纯内存配置
let schemaLib = null
try { schemaLib = (await import('@deepseek-ai/schemastery')).default ?? null } catch { schemaLib = null }

export const name = 'dsh-large-proj-perf'
export const inject = ['sessions']

const NS = 'dsh-large-proj-perf'
const TAG = '[dsh-perf]'

const DEFAULT_CONFIG = {
  // ---- fork（A）----
  zeroCopyFork: true,   // 零拷贝 fork（跳过 seed 深拷贝）
  fastInitFor: true,    // persistence initFor 冻结引用复用
  slowForkWarnMs: 100,  // fork 耗时超过该值打告警日志
  // ---- projection 预热（B）----
  warmupEnabled: true,  // 大会话投影分片预热
  minEvents: 20000,     // 事件数低于此值不做预热（同步冷折叠足够快）
  chunkSize: 5000,      // 每片折叠的事件数（片间让出事件循环）
  chunkYieldMs: 0,      // 让出方式：0=setImmediate；>0 则 setTimeout 该毫秒数
  warmOnCreated: true,  // session/created（含 resume 的大会话）即预热
  keepRecent: 50,       // 内存保留的最近记录数
  // ---- 冷会话缓存补行（B 辅助，默认关）----
  // readRaw 内部的 zstd 全量解码同步、插件层不可分片，大文件仍会冻结事件
  // 循环数秒~数十秒；默认关闭，需要时经 config.set 打开。
  backfillOnBoot: false,
  backfillMaxSessions: 8,
  backfillMinBytes: 1048576,
  backfillMaxBytes: 33554432,
  // ---- 分片 materialize（C）----
  chunkedMaterialize: true,    // fork 子会话落盘分片序列化，消除 500MB 单字符串/OOM
  materializeChunkEvents: 50000, // 每帧的事件数
  // ---- 内存优化（D）----
  preparedCacheTrim: true,     // 冷会话 LRU 裁剪总开关（false 恢复官方 capacity）
  preparedCacheSize: 1,        // persistence 冷会话 LRU 容量（默认 5 → 1，省 ~2.8GB）
  heapWarnBytes: 6442450944,   // heap 上限低于此值（6GB）打警告，提示 --max-old-space-size
}

// 数值配置下限：settings 载入与 config.set 两条入口都过这道闸。
// materializeChunkEvents<=0 会让分片循环永不前进（死循环+frames 无限增长），
// chunkSize<=0 会让预热空转，preparedCacheSize<=0 会清空 dsh 内部 LRU。
const CONFIG_MIN = {
  slowForkWarnMs: 0,
  minEvents: 0,
  chunkSize: 1,
  chunkYieldMs: 0,
  keepRecent: 0,
  backfillMaxSessions: 0,
  backfillMinBytes: 0,
  backfillMaxBytes: 0,
  materializeChunkEvents: 1000,
  preparedCacheSize: 1,
  heapWarnBytes: 0,
}

// cordis 环境下对缺失服务调用 ctx.get 可能抛错——统一安全取服务
const safeGet = (ctx, name) => {
  try { return ctx.get(name) } catch { return void 0 }
}

export function apply(ctx) {
  const disposers = []
  const config = { ...DEFAULT_CONFIG }
  // 日志优先走 ctx.logger（可被 dsh 日志级别控制），不可用/无对应方法时回退 console
  const logger = safeGet(ctx, 'logger') ?? ctx.logger
  const log = (...args) => {
    if (typeof logger?.info === 'function') logger.info(TAG, ...args)
    else console.log(TAG, ...args)
  }
  const logErr = (...args) => {
    if (typeof logger?.error === 'function') logger.error(TAG, ...args)
    else console.error(TAG, ...args)
  }
  const stats = {
    // 版本探针
    dshVersion: null,
    // 各补丁状态：active=已安装生效；retired=上游已原生实现（补丁跳过）；
    // inactive=环境缺失/特征漂移；off=配置关闭。上游吸收某能力后对应项
    // 自动转 retired——这就是插件「逐项退役」的可见化。
    patches: {},
    // fork
    forks: 0, zeroCopy: 0, fallbacks: 0, fastInitForInstalled: false, forkRecent: [],
    // warmup
    warmed: 0, skipped: 0, aborted: 0, backfilled: 0, backfillSkipped: 0,
    warmRecent: [], backfill: [],
  }
  const setPatchStatus = (name, status) => { stats.patches[name] = status }

  // alpha.5 起 Session 公共快照为 snapshotEvents()（rc.2 及之前是 events getter）。
  // 兼容两者；mock 测试对象带 events 属性也能走通。
  const sessionEventsOf = (session) => typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session?.events

  // 版本探针：启动即探测 dsh 版本。列表内 → 确认日志；列表外 → 告警提示
  // 跑 verify_compat（补丁特征校验会自动跳过优化，但会静默失效）。
  const dshVersion = probeDshVersion()
  stats.dshVersion = dshVersion ?? null
  if (dshVersion === void 0) {
    log('dsh version: unknown (probe failed; patches rely on source-signature checks)')
  } else if (KNOWN_DSH_VERSIONS.includes(dshVersion)) {
    log(`dsh version: ${dshVersion} (verified)`)
  } else {
    logErr(`dsh version: ${dshVersion} NOT in verified list (${KNOWN_DSH_VERSIONS.join('/')}); run tests/verify_compat.mjs and check startup logs for signature mismatch`)
  }

  const yieldLoop = () => config.chunkYieldMs > 0
    ? new Promise((r) => setTimeout(r, config.chunkYieldMs))
    : new Promise((r) => setImmediate(r))

  // 配置唯一写入口：未知键忽略、类型不符忽略、数值做下限钳制（拒绝 NaN/Infinity）。
  // 保证 config 里的数值永远安全，消费端（分片循环等）无需再防御。
  function setConfigValue(key, value) {
    if (!(key in DEFAULT_CONFIG)) return
    if (typeof value !== typeof DEFAULT_CONFIG[key]) return
    const min = CONFIG_MIN[key]
    if (min !== void 0) {
      if (!Number.isFinite(value)) return
      value = Math.max(value, min)
    }
    config[key] = value
  }

  // ---------- 配置：settings 服务存在则持久化，否则纯内存 ----------
  try {
    const settings = safeGet(ctx, 'settings')
    if (settings && typeof settings.register === 'function' && schemaLib) {
      // schema 由 DEFAULT_CONFIG 键驱动生成（boolean/number 按默认值类型推断），
      // 避免与 DEFAULT_CONFIG 双清单漂移
      const schema = schemaLib.object(Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, def]) => [
        key,
        typeof def === 'boolean' ? schemaLib.boolean().default(def) : schemaLib.number().default(def),
      ])))
      const off = settings.register(NS, schema, { base: { ...DEFAULT_CONFIG } })
      if (typeof off === 'function') disposers.push(off)
      const resolved = settings.get(NS)
      if (resolved && typeof resolved === 'object') {
        for (const [key, value] of Object.entries(resolved)) setConfigValue(key, value)
      }
    }
  } catch (error) {
    logErr('settings register failed:', String(error?.message ?? error))
  }

  function recordFork(entry) {
    stats.forks += 1
    if (entry.path === 'zero-copy') stats.zeroCopy += 1
    if (entry.path === 'native-fallback') stats.fallbacks += 1
    stats.forkRecent.push(entry)
    if (stats.forkRecent.length > config.keepRecent) stats.forkRecent.splice(0, stats.forkRecent.length - config.keepRecent)
    if (entry.ms >= config.slowForkWarnMs) {
      log(`slow fork: ${entry.events} events in ${entry.ms.toFixed(1)}ms (${entry.path})`)
    }
  }

  function recordWarm(entry) {
    stats.warmRecent.push(entry)
    if (stats.warmRecent.length > config.keepRecent) stats.warmRecent.splice(0, stats.warmRecent.length - config.keepRecent)
    if (entry.ms > 1000) log(`warmed ${entry.id}: ${entry.events} events in ${entry.ms.toFixed(0)}ms (${entry.units} units, base seq ${entry.baseSeq})`)
  }

  // ---------- 1. 零拷贝 fork ----------
  function installZeroCopyFork() {
    const store = ctx.sessions
    const proto = Object.getPrototypeOf(store)
    if (!proto || typeof proto.fork !== 'function') {
      logErr('SessionStore.fork not found; zero-copy fork disabled')
      setPatchStatus('zeroCopyFork', 'inactive')
      return
    }
    const originalFork = proto.fork

    const patchedFork = function (source, boundary, childSessionId) {
      const capable = typeof this._resolveForkSource === 'function'
        && typeof this._forkSeed === 'function'
        && typeof this.prepare === 'function'
        && typeof this.enter === 'function'
        && typeof this.announce === 'function'
        && typeof this.ctx?.effect === 'function'
      if (!config.zeroCopyFork || !capable) {
        const t0 = performance.now()
        const result = originalFork.apply(this, arguments)
        recordFork({ t: Date.now(), source: String(source?.id ?? source), child: result.id, events: sessionEventsOf(result)?.length ?? 0, ms: performance.now() - t0, path: capable ? 'native (disabled)' : 'native-fallback' })
        return result
      }

      const t0 = performance.now()
      if (childSessionId !== void 0 && this.get(childSessionId) !== void 0) {
        throw Object.assign(new Error(`session "${childSessionId}" already exists`), { code: 'SESSION_ALREADY_EXISTS' })
      }
      const liveSource = this._resolveForkSource(source)
      const seed = this._forkSeed(liveSource, boundary)
      const sourceHeader = liveSource.header
      let childId = childSessionId
      if (childId === void 0) {
        do { childId = `session-${++this.counter}` } while (this.store.has(childId))
      }
      let session
      try {
        // alpha.5 起：seedLength 字段被 isSeeded:true 取代，seed 长度经
        // options.inheritedEventCount（SessionLogOffset）传给 restore 通道。
        session = this.prepare(childId, {
          seed,
          inheritedEventCount: sessionLogOffset(seed.length),
          meta: {
            version: sourceHeader.version,
            id: childId,
            createdAt: Date.now(),
            ...(sourceHeader.cwd !== void 0 ? { cwd: sourceHeader.cwd } : {}),
            parentSession: liveSource.id,
            isSeeded: true,
          },
          seedSource: 'persistence',
        })
        this.ctx.effect(function* () {
          yield this.enter(session)
          this.announce(session)
        }.bind(this), 'sessions.create()')
      } catch (error) {
        logErr(`zero-copy fork failed (${String(error?.message ?? error)}); falling back to native`)
        const result = originalFork.apply(this, arguments)
        recordFork({ t: Date.now(), source: liveSource.id, child: result.id, events: sessionEventsOf(result)?.length ?? 0, ms: performance.now() - t0, path: 'native-fallback' })
        return result
      }
      recordFork({ t: Date.now(), source: liveSource.id, child: session.id, events: seed.length, ms: performance.now() - t0, path: 'zero-copy' })
      return session
    }

    proto.fork = patchedFork
    disposers.push(() => { if (proto.fork === patchedFork) proto.fork = originalFork })
    setPatchStatus('zeroCopyFork', 'active')
    log(`zero-copy fork installed (SessionStore.prototype.fork patched)`)
  }

  // ---------- 2. fast initFor（persistence 深拷贝消除） ----------
  function installFastInitFor(ictx) {
    const actx = ictx ?? ctx
    if (!config.fastInitFor) { setPatchStatus('fastInitFor', 'off'); return }
    let coordinator
    try {
      const persistence = actx.get('sessionPersistence')
      coordinator = persistence?.coordinator
    } catch { /* headless 等未装配 persistence 的环境：跳过 */ }
    if (!coordinator || typeof coordinator.initFor !== 'function') {
      log('sessionPersistence coordinator not found; fast initFor skipped')
      setPatchStatus('fastInitFor', 'inactive')
      return
    }
    const src = String(coordinator.initFor)
    const MARK = 'structuredClone(e)'
    if (!src.includes(MARK)) {
      // rc.8+：上游已原生把 initFor 的 seed 深拷贝换成引用复用（const seed =
      // session.events），插件补丁预期退役——这是上游改进，不是漂移。
      if (src.includes('const seed = session.events')) {
        log('initFor is already zero-copy upstream (rc.8+); fast initFor retired')
        setPatchStatus('fastInitFor', 'retired')
      } else {
        logErr('initFor source signature mismatch (dsh internals changed?); fast initFor skipped')
        setPatchStatus('fastInitFor', 'inactive')
      }
      return
    }
    const patchedInitFor = function (session) {
      const existing = this.live.get(session)
      if (existing) return existing
      const reservation = this.preparations.reservationFor(session)
      if (reservation !== void 0) {
        const restored = this.attachPrepared(session, reservation)
        this.live.set(session, restored)
        return restored
      }
      const seed = session.events.slice()
      const live = {
        init: Promise.resolve(),
        writes: this.createWriteBehind(session, () => live.init),
      }
      this.live.set(session, live)
      live.init = this.serialize(session.header.id, () => this.onCreated(session, seed))
      live.init.catch(() => {})
      return live
    }
    Object.defineProperty(coordinator, 'initFor', {
      value: patchedInitFor,
      writable: true,
      enumerable: false,
      configurable: true,
    })
    stats.fastInitForInstalled = true
    setPatchStatus('fastInitFor', 'active')
    disposers.push(() => { delete coordinator.initFor })
    log('fast initFor installed (persistence seed structuredClone eliminated)')
  }

  // ---------- 2b. 冷会话 LRU 裁剪（内存优化） ----------
  // preparedSessionCacheSize 默认 5，每个冷会话缓存完整事件树（大会话 ~700MB），
  // 5×700MB 叠加是 OOM 主因之一。调低 capacity 并淘汰最旧 ready entry，主动
  // 释放冷会话事件树。开关 preparedCacheTrim；config.set 改 preparedCacheSize/
  // preparedCacheTrim 即时重跑；dispose 恢复原 capacity（已淘汰条目不复活）。
  let retrimPreparedCache = null
  function installPreparedCacheTrim(ictx) {
    const actx = ictx ?? ctx
    let coordinator
    try {
      const persistence = actx.get('sessionPersistence')
      coordinator = persistence?.coordinator
    } catch { /* 无 persistence：跳过 */ }
    if (!coordinator || !coordinator.preparations || typeof coordinator.preparations.entries !== 'object') {
      log('prepared cache trim: coordinator.preparations not found; skipped')
      setPatchStatus('preparedCacheTrim', 'inactive')
      return
    }
    const prep = coordinator.preparations
    const originalCapacity = prep.capacity
    retrimPreparedCache = () => {
      const target = config.preparedCacheTrim ? Math.max(1, config.preparedCacheSize) : originalCapacity
      prep.capacity = target
      // 淘汰最旧的 ready entry 直到 ready 数量 <= target（entries 为插入序，最旧在前）
      let readyCount = 0
      for (const e of prep.entries.values()) if (e.phase === 'ready') readyCount += 1
      let evicted = 0
      while (readyCount > target) {
        let didEvict = false
        for (const [id, e] of prep.entries) {
          if (e.phase === 'ready') {
            prep.entries.delete(id)
            readyCount -= 1
            evicted += 1
            didEvict = true
            break
          }
        }
        if (!didEvict) break
      }
      log(`prepared cache trimmed to ${target} (evicted ${evicted} cold event trees)`)
    }
    retrimPreparedCache()
    setPatchStatus('preparedCacheTrim', 'active')
    disposers.push(() => {
      retrimPreparedCache = null
      prep.capacity = originalCapacity
    })
  }

  // ---------- 2c. heap 上限检测（内存优化） ----------
  // --max-old-space-size 是 V8 启动期参数，进程内无法改；检测低于阈值时告警，
  // 引导用户用推荐的启动脚本（scripts/start-dsh.ps1）或加参数重启。
  function checkHeapLimit() {
    let limit = 0
    try { limit = getHeapStatistics().heap_size_limit } catch { /* 忽略 */ }
    if (limit > 0 && limit < config.heapWarnBytes) {
      log(`WARNING: V8 heap limit is ${(limit / 1048576).toFixed(0)}MB (< ${(config.heapWarnBytes / 1048576).toFixed(0)}MB). Large sessions may OOM. Restart with: node --max-old-space-size=8192 .../bin.js web`)
    } else if (limit > 0) {
      log(`V8 heap limit: ${(limit / 1048576).toFixed(0)}MB (ok)`)
    }
  }

  // ---------- 3. 分片投影预热 ----------
  // alpha.5 起 identity 含 isSeeded/inheritedEventCount（identityMatches 四字段
  // 全等），直接传 header 不再匹配——按 identityOf 语义构造。
  const cacheIdentityOf = (header, inheritedEventCount) => ({
    createdAt: header?.createdAt,
    ...(header?.cwd !== void 0 ? { cwd: header.cwd } : {}),
    isSeeded: header?.isSeeded ?? false,
    inheritedEventCount: sessionLogOffset(inheritedEventCount ?? 0),
  })

  const loadCheckpointRows = (session) => {
    try {
      const cache = safeGet(ctx, 'sessionProjectionCache')
      if (!cache || typeof cache.recordFor !== 'function') return {}
      const record = cache.recordFor(session.id, cacheIdentityOf(session.header, session.inheritedEventCount))
      return record?.rows ?? {}
    } catch { /* 基线不可用：从 init 全量折叠 */ }
    return {}
  }

  const backfillForkCacheRow = async (sessionId, eventCount) => {
    // fork 子会话预热完成后回填投影缓存行：否则被放弃时永远没有缓存行，
    // 下次打开历史 coldSnapshot 走 readFrom(0) 全量读（分钟级阻塞）。
    try {
      const cache = safeGet(ctx, 'sessionProjectionCache')
      const session = ctx.sessions?.get(sessionId)
      if (cache && typeof cache.write === 'function' && session) await cache.write(session)
      log(`backfilled cache rows for fork child ${sessionId} (${eventCount} events)`)
    } catch (error) {
      logErr(`fork cache backfill failed for ${sessionId}: ${String(error?.message ?? error)}`)
    }
  }

  // 单个投影 unit 的分片折叠。返回 {status, baseSeq}：'folded'=已写热 cell；
  // 'skip'=cell 已热/registration 漂移/被并发 drive 抢建（写 cell 的机会让给
  // 并发方）；'abort'=会话消失或 guard 触发，终止全部预热。usable 基线的
  // seq 无论是否写 cell 都随结果带回（recordWarm 展示用）。
  async function foldUnit(registry, session, key, registration, events, checkpointRows) {
    const sessionId = session.id
    if (registration.cells.get(session) !== void 0) return { status: 'skip', baseSeq: -1 }
    const def = registration.def
    const row = checkpointRows[key]
    const usable = row !== void 0 && row.ver === def.stateVersion
    const unitBaseSeq = usable ? row.seq : -1
    let state = usable ? row.val : def.init()

    let i = 0
    if (usable) {
      while (i < events.length && events[i].seq <= row.seq) i++
    }
    let guard = 0
    while (i < events.length) {
      if (ctx.sessions?.get(sessionId) !== session) { stats.aborted += 1; return { status: 'abort', baseSeq: unitBaseSeq } }
      if (registry.registrations.get(key) !== registration) return { status: 'skip', baseSeq: unitBaseSeq }
      // 并发 drive/snapshot 已建热 cell：立即让位，不再白折剩余分片
      if (registration.cells.get(session) !== void 0) return { status: 'skip', baseSeq: unitBaseSeq }
      const end = Math.min(i + config.chunkSize, events.length)
      for (; i < end; i++) state = def.apply(state, events[i])
      if (i < events.length) await yieldLoop()
      if (++guard > 100000) { logErr(`guard tripped for ${sessionId}/${key}`); return { status: 'abort', baseSeq: unitBaseSeq } }
    }

    if (ctx.sessions?.get(sessionId) !== session) { stats.aborted += 1; return { status: 'abort', baseSeq: unitBaseSeq } }
    const liveReg = registry.registrations.get(key)
    if (liveReg !== registration || liveReg.cells.get(session) !== void 0) return { status: 'skip', baseSeq: unitBaseSeq }
    const observedSeq = events.at(-1)?.seq ?? -1
    liveReg.cells.set(session, { state, observedSeq })
    return { status: 'folded', baseSeq: unitBaseSeq }
  }

  async function warmSession(session) {
    const registry = safeGet(ctx, 'sessionProjections')
    if (!registry || typeof registry.snapshot !== 'function') return
    if (typeof registry.cellFor !== 'function' || typeof registry.buildCell !== 'function') {
      logErr('registry internals not found (dsh internals changed?); warmup skipped')
      return
    }
    const events = sessionEventsOf(session)
    if (events === void 0 || events.length < config.minEvents) { stats.skipped += 1; return }

    const t0 = performance.now()
    const registrations = registry.registrations
    if (!registrations || registrations.size === 0) return

    const checkpointRows = loadCheckpointRows(session)
    const sessionId = session.id
    let foldedUnits = 0
    let baseSeq = -1

    for (const [key, registration] of [...registrations.entries()]) {
      const outcome = await foldUnit(registry, session, key, registration, events, checkpointRows)
      if (outcome.status === 'abort') return
      baseSeq = Math.max(baseSeq, outcome.baseSeq)
      if (outcome.status === 'folded') foldedUnits += 1
    }

    if (foldedUnits > 0) {
      stats.warmed += 1
      recordWarm({ t: Date.now(), id: sessionId, events: events.length, units: foldedUnits, baseSeq, ms: performance.now() - t0 })
      if (session.header?.parentSession !== void 0) await backfillForkCacheRow(sessionId, events.length)
    }
  }

  // ---------- 4. 分片 materialize（fork 超大 seed 的全量序列化） ----------
  async function installChunkedMaterialize(ictx) {
    const actx = ictx ?? ctx
    if (!config.chunkedMaterialize) { setPatchStatus('chunkedMaterialize', 'off'); return }
    const persistence = safeGet(actx, 'sessionPersistence')
    if (!persistence || typeof persistence.encodeMaterialization !== 'function') {
      log('chunked materialize: encodeMaterialization not found; skipped')
      setPatchStatus('chunkedMaterialize', 'inactive'); return
    }
    // 注意：ctx.get('sessionPersistence') 返回 cordis Proxy，访问其方法会得到
    // createShadowMethod（bind 过的函数，String 为 [native code]），签名校验
    // 永远失败。改用原型方法（真实源码）做特征校验；自有属性场景（测试 mock）
    // 回退到实例方法。patch 本身经 Proxy set 陷阱落到真实实例，不受影响。
    const candidate = Object.getPrototypeOf(persistence)?.encodeMaterialization ?? persistence.encodeMaterialization
    const src = String(candidate ?? '')
    if (!src.includes('eventLines(events, this.packChunks)') || !src.includes('compressZstdFrame')) {
      logErr('encodeMaterialization signature mismatch (dsh internals changed?); chunked materialize skipped')
      setPatchStatus('chunkedMaterialize', 'inactive'); return
    }
    const originalRaw = persistence.encodeMaterialization
    const original = originalRaw.bind(persistence)
    // dispose 时按原形状还原：原型方法 → delete 自有补丁属性（回落原型）；
    // 自有属性（测试 mock 等）→ 原样写回，不留 bind 副本遮蔽
    const hadOwn = Object.prototype.hasOwnProperty.call(persistence, 'encodeMaterialization')

    let packChunkRuns = null
    try { packChunkRuns = (await import('@deepseek-ai/dsh-session')).packChunkRuns } catch { /* 退化 */ }
    if (!packChunkRuns) {
      logErr('dsh-session packChunkRuns unavailable; chunked materialize degrades to unpacked lines when packChunks is enabled (format drift vs native)')
    }
    const eventLinesChunk = (events) => ((packChunkRuns && persistence.packChunks) ? packChunkRuns(events) : events)
      .map((r) => JSON.stringify(r)).join('\n') + '\n'
    // alpha.5 复刻：toHeaderLine(header, inheritedEventCount)——seedLength 变为
    // isSeeded 条件字段（值 = SessionLogOffset(inheritedEventCount ?? 0)），且
    // seeded 会话必须有 inheritedEventCount、unseeded 会话必须为 0。
    const toHeaderLine = (header, inheritedEventCount) => {
      const cut = sessionLogOffset(inheritedEventCount ?? 0)
      if (cut === void 0) throw new TypeError(`inheritedEventCount must be a non-negative safe integer, got ${String(inheritedEventCount)}`)
      if (header.isSeeded && inheritedEventCount === void 0) throw new Error('seeded session header requires an inherited event count')
      if (!header.isSeeded && cut !== 0) throw new Error('unseeded session header inherited event count must be 0')
      return {
        type: 'session',
        version: header.version,
        id: header.id,
        createdAt: header.createdAt,
        ...(header.cwd !== void 0 ? { cwd: header.cwd } : {}),
        ...(header.parentSession !== void 0 ? { parentSession: header.parentSession } : {}),
        ...(header.isSeeded ? { seedLength: cut } : {}),
        ...(header.origin !== void 0 ? { origin: header.origin } : {}),
        delegationDepth: header.delegationDepth ?? 0,
        ...(header.agentPreset !== void 0 ? { agentPreset: header.agentPreset } : {}),
      }
    }

    // alpha.5 起签名为 (storage, events)，storage = { meta, inheritedEventCount }。
    // 向后兼容：storage.meta 缺失时按 rc.2 的 (meta, events) 形态处理。
    persistence.encodeMaterialization = async function (storage, events) {
      const meta = storage?.meta ?? storage
      const inheritedEventCount = storage?.meta !== void 0 ? storage.inheritedEventCount : void 0
      if (this.compression === 'none' || events.length <= config.materializeChunkEvents) {
        return original(storage, events)
      }
      const header = JSON.stringify(toHeaderLine(meta, inheritedEventCount)) + '\n'
      const headerFrame = await zstdCompressAsync(Buffer.from(header), CHECKSUM_OPTIONS)
      const frames = [headerFrame]
      for (let i = 0; i < events.length; i += config.materializeChunkEvents) {
        const chunk = events.slice(i, i + config.materializeChunkEvents)
        const body = eventLinesChunk(chunk)
        frames.push(await zstdCompressAsync(Buffer.from(body), CHECKSUM_OPTIONS))
        if (i + config.materializeChunkEvents < events.length) await yieldLoop()
      }
      return Buffer.concat(frames)
    }
    disposers.push(() => {
      if (hadOwn) persistence.encodeMaterialization = originalRaw
      else delete persistence.encodeMaterialization
    })
    setPatchStatus('chunkedMaterialize', 'active')
    log(`chunked materialize installed (chunk=${config.materializeChunkEvents} events/frame)`)
  }

  // ---------- 5. 冷会话缓存补行（默认关） ----------
  let backfillRunning = false
  let backfillFired = false
  // readRaw 内部 zstd 全量解码同步、插件层不可分片——大文件仍会短暂冻结事件
  // 循环，故默认关；开启后按 chunkSize 分片让出 + 会话间让出。
  const resolveSessionsRoot = () => {
    try {
      const paths = safeGet(ctx, 'dshHomePaths')
      const direct = paths?.sessions?.()
      if (typeof direct === 'string' && direct !== '') return direct
      const home = paths?.dshHome?.()
      if (typeof home === 'string' && home !== '') return home + '/sessions'
    } catch { /* 落到环境变量回退 */ }
    const envHome = process.env.DSH_HOME
      ?? (typeof process.env.USERPROFILE === 'string' && process.env.USERPROFILE !== '' ? process.env.USERPROFILE : void 0)
    return envHome !== void 0 ? `${envHome}/.dsh/sessions` : ''
  }

  // alpha.5 identity：isSeeded/inheritedEventCount 参与匹配；冷日志 header 行
  // 按 toHeaderLine 语义携带 isSeeded/seedLength
  const coldIdentityOf = (meta) => ({
    createdAt: meta.createdAt,
    ...(meta.cwd !== void 0 ? { cwd: meta.cwd } : {}),
    isSeeded: meta.isSeeded ?? false,
    inheritedEventCount: sessionLogOffset(meta.seedLength ?? 0),
  })

  const scanCandidates = async (sessionsRoot, readdir, stat) => {
    const candidates = []
    let projectDirs = []
    try { projectDirs = await readdir(sessionsRoot, { withFileTypes: true }) } catch { return candidates }
    for (const proj of projectDirs) {
      if (!proj.isDirectory()) continue
      let sessionDirs = []
      try { sessionDirs = await readdir(join(sessionsRoot, proj.name), { withFileTypes: true }) } catch { continue }
      for (const sd of sessionDirs) {
        if (!sd.isDirectory() || !sd.name.startsWith('session-')) continue
        for (const fname of ['session.jsonl.zstd', 'session.jsonl']) {
          const p = join(sessionsRoot, proj.name, sd.name, fname)
          try {
            const st = await stat(p)
            if (st.size >= config.backfillMinBytes && st.size <= config.backfillMaxBytes) {
              candidates.push({ id: sd.name, path: p, size: st.size })
            }
          } catch { /* 文件不存在 */ }
        }
      }
    }
    return candidates.sort((a, b) => b.size - a.size)
  }

  // 逐行折叠冷日志到各 unit 的 init 状态。返回 {folded, lastSeq, states}；
  // 跳过首行 header、空行与损坏行。每 chunkSize 行让出一次事件循环。
  const foldLogLines = async (content, registrations) => {
    const states = new Map(registrations.map(([key, reg]) => [key, reg.def.init()]))
    let folded = 0
    let lastSeq = -1
    let pos = content.indexOf('\n')
    if (pos === -1) return { folded: 0, lastSeq: -1, states } // 无 header 行
    let chunkLeft = config.chunkSize
    const advance = async () => {
      if (--chunkLeft > 0) return
      chunkLeft = config.chunkSize
      await yieldLoop()
    }
    for (;;) {
      const nl = content.indexOf('\n', pos)
      const line = nl === -1 ? content.slice(pos) : content.slice(pos, nl)
      if (line !== '') {
        let ev
        try { ev = JSON.parse(line) } catch { /* 非事件行/损坏行：跳过 */ }
        if (ev !== void 0 && Number.isInteger(ev?.seq)) {
          lastSeq = ev.seq
          for (const [, reg] of registrations) {
            const def = reg.def
            states.set(def.key, def.apply(states.get(def.key), ev))
          }
          folded += 1
          await advance()
        }
      }
      if (nl === -1) break
      pos = nl + 1
    }
    return { folded, lastSeq, states }
  }

  // 处理单个冷会话候选。返回是否完成补行（用于日志区分）。
  const backfillOne = async (cand, deps) => {
    const { cache, persistence, registry, putCacheRow } = deps
    const raw = await persistence.readRaw(cand.id, undefined)
    if (raw === void 0) return false
    const meta = raw.meta
    if (ctx.sessions?.get?.(cand.id) !== void 0) { stats.backfillSkipped += 1; return false }
    if (cache.recordFor?.(cand.id, coldIdentityOf(meta)) !== void 0) { stats.backfillSkipped += 1; return false }
    const registrations = [...registry.registrations.entries()]
    if (registrations.length === 0) return false

    const t0 = performance.now()
    const { folded, lastSeq, states } = await foldLogLines(raw.content, registrations)
    if (folded === 0) return false
    const rows = {}
    for (const [key, reg] of registrations) rows[key] = { ver: reg.def.stateVersion, seq: lastSeq, val: states.get(key) }
    await putCacheRow.call(cache, cand.id, coldIdentityOf(meta), rows)
    stats.backfilled += 1
    const entry = { t: Date.now(), id: cand.id, events: folded, ms: Math.round(performance.now() - t0), size: cand.size }
    stats.backfill.push(entry)
    if (stats.backfill.length > config.keepRecent) stats.backfill.splice(0, stats.backfill.length - config.keepRecent)
    log(`backfilled ${cand.id}: ${folded} events in ${entry.ms}ms (${(cand.size / 1048576).toFixed(1)}MB log)`)
    return true
  }

  async function backfillColdSessions() {
    if (!config.backfillOnBoot) return
    if (backfillRunning) return
    backfillRunning = true
    try {
      await backfillColdSessionsInner()
    } finally {
      backfillRunning = false
    }
  }

  async function backfillColdSessionsInner() {
    const cache = safeGet(ctx, 'sessionProjectionCache')
    const persistence = safeGet(ctx, 'sessionPersistence')
    const registry = safeGet(ctx, 'sessionProjections')
    if (!cache || !persistence || !registry) { log('backfill: services unavailable; skipped'); return }
    // alpha.5：putSoft(id, identity, rows, what) 被 put(id, identity, rows) 取代；兼容两者
    const putCacheRow = typeof cache.put === 'function' ? cache.put : typeof cache.putSoft === 'function' ? cache.putSoft : void 0
    if (typeof persistence.readRaw !== 'function' || typeof putCacheRow !== 'function') {
      log('backfill: persistence.readRaw/cache.put unavailable; skipped'); return
    }
    const sessionsRoot = resolveSessionsRoot()
    if (sessionsRoot === '') { log('backfill: sessions root not resolvable; skipped'); return }
    const { readdir, stat } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const candidates = await scanCandidates(sessionsRoot, readdir, stat)
    const deps = { cache, persistence, registry, putCacheRow }
    for (const cand of candidates.slice(0, config.backfillMaxSessions)) {
      try {
        await backfillOne(cand, deps)
      } catch (error) {
        logErr(`backfill failed for ${cand.id}: ${String(error?.message ?? error)}`)
      }
      await yieldLoop()
    }
  }

  // ---------- 6. webServer API ----------
  function installApi(ictx) {
    const actx = ictx ?? ctx
    const webServer = safeGet(actx, 'webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    const isTrusted = (request) => {
      try {
        const host = request.headers && request.headers.host
        if (typeof host !== 'string' || host === '') return false
        const hostUrl = new URL('http://' + host)
        const hostname = hostUrl.hostname
        const loopback = hostname === 'localhost' || hostname === '[::1]'
          || (hostname.split('.').length === 4 && hostname.split('.')[0] === '127'
            && hostname.split('.').every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
        if (!loopback) return false
        if (request.headers['sec-fetch-site'] === 'cross-site') return false
        const origin = request.headers.origin
        if (origin === void 0) return true
        return new URL(origin).host === hostUrl.host
      } catch { return false }
    }
    const readBody = (req) => new Promise((resolve, reject) => {
      let data = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { data += chunk; if (data.length > 16384) { reject(new Error('body too large')); req.destroy() } })
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
      req.on('error', reject)
    })
    const writeJson = (res, status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }
    const off = webServer.register({
      kind: 'prefix',
      path: '/dsh-large-proj-perf/api',
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        let method = ''
        try { method = new URL(req.url || '/', 'http://dsh.internal').pathname.slice('/dsh-large-proj-perf/api/'.length) } catch { method = '' }
        if (!method || method.includes('/')) return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        try {
          if (method === 'stats.get') return writeJson(res, 200, { ok: true, value: stats })
          if (method === 'stats.reset') {
            // 只清计数器与历史；fastInitForInstalled 是安装状态标志（非测量值），刻意保留
            stats.forks = 0; stats.zeroCopy = 0; stats.fallbacks = 0; stats.forkRecent = []
            stats.warmed = 0; stats.skipped = 0; stats.aborted = 0; stats.backfilled = 0; stats.backfillSkipped = 0
            stats.warmRecent = []; stats.backfill = []
            return writeJson(res, 200, { ok: true })
          }
          if (method === 'config.get') return writeJson(res, 200, { ok: true, value: config })
          if (method === 'config.set') {
            const payload = await readBody(req)
            const before = { ...config }
            if (payload && typeof payload === 'object') {
              for (const key of Object.keys(DEFAULT_CONFIG)) {
                if (key in payload) setConfigValue(key, payload[key])
              }
            }
            if (config.preparedCacheTrim !== before.preparedCacheTrim
              || config.preparedCacheSize !== before.preparedCacheSize) {
              try { retrimPreparedCache?.() } catch (error) {
                logErr(`prepared cache retrim failed: ${String(error?.message ?? error)}`)
              }
            }
            // 开机定时器只触发一次；过后才打开 backfillOnBoot 的，立即补跑一次扫描
            if (!before.backfillOnBoot && config.backfillOnBoot && backfillFired) {
              Promise.resolve(backfillColdSessions()).catch((e) => logErr(`backfill scan failed: ${String(e?.message ?? e)}`))
            }
            try {
              const settings = ctx.get('settings')
              if (settings && typeof settings.update === 'function') await settings.update(NS, { ...config })
            } catch { /* 内存态已生效 */ }
            return writeJson(res, 200, { ok: true, value: config })
          }
          return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        } catch (error) {
          return writeJson(res, 500, { ok: false, error: { code: 'rejected', message: String(error?.message ?? error) } })
        }
      },
    })
    if (typeof off === 'function') disposers.push(off)
  }

  // ---------- 安装调度 ----------
  installZeroCopyFork()
  checkHeapLimit()
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionPersistence'], (sub) => {
      installFastInitFor(sub)
      installPreparedCacheTrim(sub)
      Promise.resolve(installChunkedMaterialize(sub)).catch((e) => logErr(`chunked materialize install failed: ${String(e?.message ?? e)}`))
    })
    ctx.inject(['webServer'], (sub) => {
      installApi(sub)
    })
  } else {
    installFastInitFor(ctx)
    installPreparedCacheTrim(ctx)
    Promise.resolve(installChunkedMaterialize(ctx)).catch(() => {})
    installApi(ctx)
  }

  // 触发时机：session/created + 存量会话预热 + backfill 定时器
  setPatchStatus('warmup', config.warmupEnabled ? 'active' : 'off')
  if (config.warmOnCreated && typeof ctx.on === 'function') {
    const offCreated = ctx.on('session/created', (session) => {
      if (!config.warmupEnabled) return
      Promise.resolve(warmSession(session)).catch((e) => {
        logErr(`warmup failed for ${session.id}: ${String(e?.message ?? e)}`)
      })
    })
    if (typeof offCreated === 'function') disposers.push(offCreated)
  }
  for (const session of ctx.sessions?.list?.() ?? []) {
    Promise.resolve(warmSession(session)).catch(() => {})
  }
  const backfillTimer = setTimeout(() => {
    backfillFired = true
    Promise.resolve(backfillColdSessions()).catch((e) => logErr(`backfill scan failed: ${String(e?.message ?? e)}`))
  }, 15000)
  if (typeof backfillTimer.unref === 'function') backfillTimer.unref()
  disposers.push(() => clearTimeout(backfillTimer))

  log(`installed (zeroCopy=${config.zeroCopyFork}, fastInitFor=${config.fastInitFor}, warmup=${config.warmupEnabled} minEvents=${config.minEvents}, chunkedMaterialize=${config.chunkedMaterialize})`)

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { logErr('dispose failed:', String(error?.message ?? error)) }
    }
    log('disposed')
  }
}
