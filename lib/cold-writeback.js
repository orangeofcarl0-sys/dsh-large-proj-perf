// 冷读回写：把已折好的投影状态写成缓存行（问题 B 的替代方案）
//
// 背景（运行时实测，见 docs/RUNTIME-ANALYSIS.md）：
//   - 冷读一个 24 万事件会话的投影要 16.6 秒，其中约 14 秒是 31 个单元 × 24 万
//     次 `def.apply` 的折叠；
//   - 同一会话**有缓存行**时只要 0.26 秒；
//   - 但 dsh 0.2.2 的冷读路径（`hydratePrepared` → `registry.hydrate`）**不回写**
//     缓存行。上游 `sessionProjectionCache.coldSnapshot()` 的注释写着「first cold
//     read creates the cache row and later ones seed from it」，但全安装包 **0 个
//     生产调用点**——它是死代码。
//
// 结果：同一个大会话，每个进程都要重付一次 16.6 秒。
//
// 本模块补上这一跳：冷读完成后（cell 已就位、`checkpoint()` 近乎零成本）把结果
// 写成缓存行，使「第二次起」以及「重启进程后」都走 0.26 秒的快路径。
//
// 挂载点选 `hydratePrepared` 的原因：它是冷读的唯一漏斗（`preparedProjections`
// 在 dsh-session-query 里只有这一条路），覆盖 projections / follow / fork /
// rename 全部路径；而 `session/events`（projectionMode:'none'）不做投影折叠，
// 不在本模块范围内。

import { performance } from 'node:perf_hooks'

export function installColdWriteBack(pc, ictx) {
  const { ctx, config, stats, log, logErr, safeGet, cacheIdentityOf, disposers, setPatchStatus } = pc
  const actx = ictx ?? ctx
  if (!config.coldWriteBack) { setPatchStatus('coldWriteBack', 'off'); return }

  const cache = safeGet(actx, 'sessionProjectionCache')
  if (cache === void 0 || typeof cache.hydratePrepared !== 'function') {
    setPatchStatus('coldWriteBack', 'inactive')
    return
  }
  if (typeof cache.put !== 'function') {
    setPatchStatus('coldWriteBack', 'inactive')
    return
  }

  const original = cache.hydratePrepared
  // dispose 时按原形状还原：原型方法 → delete 自有属性（回落原型）；
  // 自有属性（测试 mock 等）→ 原样写回。
  const hadOwn = Object.prototype.hasOwnProperty.call(cache, 'hydratePrepared')

  // 判断已有缓存行是否已经等于这次算出来的 rows。相等就不重写，避免每次冷读
  // 都产生一次磁盘写（缓存行的写是「整记录替换 + fsync」，不便宜）。
  const sameRows = (existing, rows) => {
    if (existing === void 0 || existing?.rows === void 0) return false
    const a = existing.rows
    const b = rows
    const keys = Object.keys(b)
    if (Object.keys(a).length !== keys.length) return false
    for (const key of keys) {
      const x = a[key]
      const y = b[key]
      if (x === void 0 || y === void 0) return false
      if (x.ver !== y.ver || x.seq !== y.seq) return false
    }
    // 只比较键集、ver、seq：state 值由同一批事件与同一份代码折出，
    // 深比较的开销不值得（而且 `put` 自己会做 snapshotJsonValue 校验）。
    return true
  }

  const writeBack = (session, events) => {
    // 只对超过预热门槛的会话回写：小会话折叠本来就是毫秒级，
    // 回写的磁盘成本反而更高。
    if (events.length < config.minEvents) { stats.coldWriteBackSkipped += 1; return }
    const registry = safeGet(ctx, 'sessionProjections')
    if (registry === void 0 || typeof registry.checkpoint !== 'function') {
      stats.coldWriteBackSkipped += 1
      return
    }
    let identity
    try {
      identity = cacheIdentityOf(session.header, session.inheritedEventCount)
    } catch (error) {
      stats.coldWriteBackFailed += 1
      logErr(`cold write-back identity failed for ${session.id}: ${String(error?.message ?? error)}`)
      return
    }
    let rows
    try {
      // hydrate 之后各单元 cell 均已就位，checkpoint 只是逐个读 cell.state
      // 并结构化克隆，不重新折叠。
      rows = registry.checkpoint(session)
    } catch (error) {
      stats.coldWriteBackFailed += 1
      logErr(`cold write-back checkpoint failed for ${session.id}: ${String(error?.message ?? error)}`)
      return
    }
    const existing = typeof cache.recordFor === 'function' ? cache.recordFor(session.id, identity) : void 0
    if (sameRows(existing, rows)) {
      stats.coldWriteBackSkipped += 1
      return
    }
    const t0 = performance.now()
    // put 是异步的（先落盘再改内存）；不 await，冷读响应不应等它。
    Promise.resolve(cache.put(session.id, identity, rows)).then(() => {
      stats.coldWriteBacks += 1
      const entry = {
        t: Date.now(),
        id: session.id,
        events: events.length,
        units: Object.keys(rows).length,
        ms: Math.round(performance.now() - t0),
      }
      stats.coldWriteBackRecent.push(entry)
      if (stats.coldWriteBackRecent.length > config.keepRecent) {
        stats.coldWriteBackRecent.splice(0, stats.coldWriteBackRecent.length - config.keepRecent)
      }
      if (config.debugApi) log(`cold write-back: ${session.id} (${entry.units} units, ${events.length} events, ${entry.ms}ms)`)
    }, (error) => {
      stats.coldWriteBackFailed += 1
      logErr(`cold write-back put failed for ${session.id}: ${String(error?.message ?? error)}`)
    })
  }

  const patched = function (session, events) {
    // 原始实现保持同步返回（契约不变）。
    const snapshot = original.call(this, session, events)
    // 回写推迟到本轮同步栈之后：hydrate 返回时调用方可能还在同一段同步逻辑里
    // （例如随后立即读 snapshot），不能在这里插磁盘 IO 的 Promise 链。
    setImmediate(() => {
      try { writeBack(session, events) } catch (error) {
        stats.coldWriteBackFailed += 1
        logErr(`cold write-back failed for ${session?.id}: ${String(error?.message ?? error)}`)
      }
    })
    return snapshot
  }

  cache.hydratePrepared = patched
  disposers.push(() => {
    if (cache.hydratePrepared === patched) {
      if (hadOwn) cache.hydratePrepared = original
      else delete cache.hydratePrepared
    }
  })
  setPatchStatus('coldWriteBack', 'active')
  log('cold write-back installed (hydratePrepared -> checkpoint -> cache.put)')
}
