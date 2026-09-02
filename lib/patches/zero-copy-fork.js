// 补丁 1：零拷贝 fork（问题 A 的主项）
//
// alpha.5 原生 fork 逐事件 snapshotJsonValue 深拷贝（18MB ≈ 346ms）。fork 的
// seed 是 deepFreeze 不可变 JSON 树，改走 Session.prepare(seedSource:
// 'persistence') 的 fromRestore 通道原地冻结复用引用（346ms → 19ms）。
// alpha.5 起 meta 为 {cwd, parentSession, isSeeded:true}，seed 长度经
// options.inheritedEventCount（SessionLogOffset）传入 restore 通道。

import { performance } from 'node:perf_hooks'

export function install(pc) {
  const { ctx, config, log, logErr, disposers, sessionEventsOf, sessionLogOffset, setPatchStatus, recordFork } = pc
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
      pc.recordFork({ t: Date.now(), source: String(source?.id ?? source), child: result.id, events: sessionEventsOf(result)?.length ?? 0, ms: performance.now() - t0, path: capable ? 'native (disabled)' : 'native-fallback' })
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
      recordFork({ t: Date.now(), source: liveSource.id, child: result.id, events: pc.sessionEventsOf(result)?.length ?? 0, ms: performance.now() - t0, path: 'native-fallback' })
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
