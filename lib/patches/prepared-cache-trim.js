// 补丁 3：冷会话 LRU 裁剪（问题 D）
//
// SessionPreparations 默认缓存 5 个完整冷会话事件树（每个大会话 ~700MB），
// 5×700MB 叠加是 OOM 主因之一。调低 capacity 并淘汰最旧 ready entry，主动
// 释放。开关 preparedCacheTrim；config.set 改相关键即时重跑；dispose 恢复
// 原 capacity（已淘汰条目不复活）。

export function install(pc, ictx) {
  const { ctx, config, log, logErr, disposers, setPatchStatus } = pc
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
  const retrim = () => {
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
  retrim()
  pc.retrimPreparedCache = retrim
  setPatchStatus('preparedCacheTrim', 'active')
  disposers.push(() => {
    pc.retrimPreparedCache = null
    prep.capacity = originalCapacity
  })
}
