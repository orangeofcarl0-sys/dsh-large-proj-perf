// 补丁 1：零拷贝 fork（问题 A 的主项）
//
// 原生 fork 逐事件 snapshotJsonValue 深拷贝 + deepFreeze（18MB ≈ 346ms）。
// fork 的 seed 是 live 会话的 snapshotEvents（frozen 元素），可改走
// SessionStore 的 fromRestore 通道原地冻结复用引用：
//
//   - 0.1.3 起：create(childId, {seed, inheritedEventCount, meta, eventState:
//     'shared-frozen'}) —— prepare 按 eventState 分派到 Session.fromRestore
//     （不拷贝、不冻结）；_resolveForkSource/_forkSeed 是公开私有方法，原生
//     完整边界 / OPEN_TURN 校验原样保留。
//   - alpha.5 / rc.1：prepare(childId, {seed, inheritedEventCount, meta,
//     seedSource: 'persistence'}) 走 fromRestore 通道的旧形态。
//
// 协议探测看 prepare 的源码字面量（eventState vs seedSource），不一致就自动
// 跳过（绝不安装破坏 fork 的补丁）。

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

  // 协议探测：newProtocol = 0.1.3 的 create(eventState:'shared-frozen')；
  // oldProtocol = alpha.5/rc.1 的 prepare(seedSource:'persistence')
  const prepareSrc = typeof proto.prepare === 'function' ? String(proto.prepare) : ''
  const newProtocol = typeof proto.create === 'function' && prepareSrc.includes('eventState')
  const oldProtocol = prepareSrc.includes('seedSource') && prepareSrc.includes('persistence')
  const patchedFork = function (source, boundary, childSessionId) {
    const capable = typeof this._resolveForkSource === 'function'
      && typeof this._forkSeed === 'function'
      && typeof this.prepare === 'function'
      && typeof this.enter === 'function'
      && typeof this.announce === 'function'
      && typeof this.ctx?.effect === 'function'
      && (newProtocol || oldProtocol)
    if (!config.zeroCopyFork || !capable) {
      const t0 = performance.now()
      const result = originalFork.apply(this, arguments)
      recordFork({ t: Date.now(), source: String(source?.id ?? source), child: result.id, events: sessionEventsOf(result)?.length ?? 0, ms: performance.now() - t0, path: capable ? 'native (disabled)' : 'native-fallback' })
      return result
    }

    const t0 = performance.now()
    try {
      // 与原生同款预检（duplicate child）；0.1.3 原生抛 SessionForkError
      if (childSessionId !== void 0 && this.get(childSessionId) !== void 0) {
        throw new Error(`session "${childSessionId}" already exists`)
      }
      const liveSource = this._resolveForkSource(source)
      let seed = this._forkSeed(liveSource, boundary)
      let session
      if (newProtocol) {
        // fromRestore 通道不自动追加 seed 尾部 marker；v2 磁盘校验要求
        // seeded 会话事件流尾有 inherited end-seed（cut == marker.seq）。
        // 原生快照通道无条件追加——这里等价注入（已有则复用）。
        const cut = seed.length
        const seedTail = seed.at(-1)
        if (seedTail?.type !== 'session/end-seed' || seedTail?.data?.inherited !== true) {
          seed = [...seed, { type: 'session/end-seed', seq: cut, time: Date.now(), data: { inherited: true } }]
        }
        // fromRestore 把 meta 直接当 header 校验：必须带 version/id/createdAt
        //（id == 会话 id）
        let childId = childSessionId
        if (childId === void 0) {
          do { childId = `session-${++this.counter}` } while (this.store.has(childId))
        }
        session = this.create(childId, {
          seed,
          inheritedEventCount: sessionLogOffset(cut),
          meta: {
            version: liveSource.header.version,
            id: childId,
            createdAt: Date.now(),
            ...(liveSource.header.cwd !== void 0 ? { cwd: liveSource.header.cwd } : {}),
            parentSession: liveSource.id,
            isSeeded: true,
          },
          eventState: 'shared-frozen',
        })
      } else {
        let childId = childSessionId
        if (childId === void 0) {
          do { childId = `session-${++this.counter}` } while (this.store.has(childId))
        }
        session = this.prepare(childId, {
          seed,
          inheritedEventCount: sessionLogOffset(seed.length),
          meta: {
            ...(liveSource.header.cwd !== void 0 ? { cwd: liveSource.header.cwd } : {}),
            parentSession: liveSource.id,
            isSeeded: true,
          },
          seedSource: 'persistence',
        })
        this.ctx.effect(function* () {
          yield this.enter(session)
          this.announce(session)
        }.bind(this), 'sessions.create()')
      }
      recordFork({ t: Date.now(), source: liveSource.id, child: session.id, events: seed.length, ms: performance.now() - t0, path: 'zero-copy' })
      return session
    } catch (error) {
      logErr(`zero-copy fork failed (${String(error?.message ?? error)}); falling back to native`)
      const result = originalFork.apply(this, arguments)
      recordFork({ t: Date.now(), source: String(source?.id ?? source), child: result.id, events: sessionEventsOf(result)?.length ?? 0, ms: performance.now() - t0, path: 'native-fallback' })
      return result
    }
  }

  proto.fork = patchedFork
  disposers.push(() => { if (proto.fork === patchedFork) proto.fork = originalFork })
  setPatchStatus('zeroCopyFork', 'active')
  log(`zero-copy fork installed (SessionStore.prototype.fork patched, protocol: ${newProtocol ? '0.1.3 eventState' : oldProtocol ? 'alpha.5 seedSource' : 'unknown'})`)
}
