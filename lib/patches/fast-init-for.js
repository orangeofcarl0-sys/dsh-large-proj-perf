// 补丁 2：fast initFor（问题 A 的 persistence 侧）
//
// rc.6/rc.7 的 PersistenceCoordinator.initFor 对 seed 做
// `session.events.map((e) => structuredClone(e))`（≈135ms），补丁换冻结引用
// 复用。rc.8 起上游原生零拷贝（events 引用）、alpha.5 起改 snapshotEvents()——
// 两种新形态下特征校验不匹配，补丁自动退役（stats.patches = retired）。

export function install(pc, ictx) {
  const { ctx, config, log, logErr, disposers, setPatchStatus } = pc
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
    // rc.8+：上游已原生把 initFor 的 seed 深拷贝换成引用复用/快照，插件补丁
    // 预期退役——这是上游改进，不是漂移。
    if (src.includes('const seed = session.events') || src.includes('session.snapshotEvents()')) {
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
  pc.stats.fastInitForInstalled = true
  setPatchStatus('fastInitFor', 'active')
  disposers.push(() => { delete coordinator.initFor })
  log('fast initFor installed (persistence seed structuredClone eliminated)')
}
