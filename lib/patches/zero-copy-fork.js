// 补丁 1：零拷贝 fork（问题 A 的主项）
//
// 原生 fork 逐事件 snapshotJsonValue 深拷贝 + deepFreeze（18MB ≈ 346ms）。
// fork 的 seed 来自 live 会话的快照（元素在 append 时已 deepFreeze），可改走
// SessionStore 的 fromRestore 通道原地冻结复用引用。三套宿主协议：
//
//   - 0.1.7+（fork-seed）：原生 fork 重构为 _resolveForkSource + _forkBoundary
//     + 模块级 buildForkSeed（slice + 注入 inherited end-seed marker +
//     openTurnClosers 补 turn 闭合）。补丁直接复用这三个 helper，只把 create
//     的通道换成 eventState:'shared-frozen'；buildForkSeed 新建的事件未冻结，
//     送入前原地深冻结（满足「已冻结或独立拥有」前提）。
//   - 0.1.3–0.1.5（event-state）：_forkSeed 返回 seed；补丁确保 seed 尾部有
//     inherited marker（cut == marker.seq），再走 create(eventState)。
//   - alpha.5 / rc.1（seed-source）：prepare(seedSource:'persistence') 旧形态。
//
// 协议探测按能力与方法源码字面量，全部不支持时自动跳过（绝不安装破坏 fork
// 的补丁）。

import { performance } from 'node:perf_hooks'

// 0.1.7+ 的 fork seed 构建器（模块级导出）。旧版本无此导出 → null。
// 顶层 await 让 install 保持同步；解析失败时对应协议自动不可用。
let buildForkSeed = null
try {
  const sessionMod = await import('@deepseek-ai/dsh-session')
  if (typeof sessionMod.buildForkSeed === 'function') buildForkSeed = sessionMod.buildForkSeed
} catch { /* 旧版本 / 测试 mock 环境 */ }

// 迭代式深冻结（复刻 dsh 的 freezeStoredEvent 语义，避免深递归爆栈）
function deepFreeze(value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) continue
    Object.freeze(current)
    for (const key in current) {
      const child = current[key]
      if (child !== null && typeof child === 'object') pending.push(child)
    }
  }
  return value
}

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

  // 协议探测（优先序：0.1.7 fork-seed > 0.1.3–0.1.5 event-state > alpha.5/rc.1 seed-source）
  const prepareSrc = typeof proto.prepare === 'function' ? String(proto.prepare) : ''
  const forkSeedProtocol = buildForkSeed !== null
    && typeof proto._forkBoundary === 'function'
    && typeof proto._resolveForkSource === 'function'
    && typeof proto.create === 'function'
  const newProtocol = !forkSeedProtocol
    && typeof proto.create === 'function'
    && prepareSrc.includes('eventState')
    && typeof proto._forkSeed === 'function'
  const oldProtocol = !forkSeedProtocol && !newProtocol
    && prepareSrc.includes('seedSource') && prepareSrc.includes('persistence')

  const protocolLabel = forkSeedProtocol ? '0.1.7 forkSeed' : newProtocol ? '0.1.3 eventState' : oldProtocol ? 'alpha.5 seedSource' : 'unknown'

  const patchedFork = function (source, boundary, childSessionId) {
    const capable = typeof this._resolveForkSource === 'function'
      && typeof this.prepare === 'function'
      && (forkSeedProtocol
        || (newProtocol && typeof this._forkSeed === 'function')
        || (oldProtocol && typeof this._forkSeed === 'function' && typeof this.enter === 'function'
          && typeof this.announce === 'function' && typeof this.ctx?.effect === 'function'))
    if (!config.zeroCopyFork || !capable) {
      const t0 = performance.now()
      const result = originalFork.apply(this, arguments)
      recordFork({ t: Date.now(), source: String(source?.id ?? source), child: result.id, events: sessionEventsOf(result)?.length ?? 0, ms: performance.now() - t0, path: capable ? 'native (disabled)' : 'native-fallback' })
      return result
    }

    const t0 = performance.now()
    try {
      // 与原生同款预检（duplicate child）
      if (childSessionId !== void 0 && this.get(childSessionId) !== void 0) {
        throw new Error(`session "${childSessionId}" already exists`)
      }
      const liveSource = this._resolveForkSource(source)
      let seed
      let cut
      let protocol = protocolLabel
      if (forkSeedProtocol) {
        // 0.1.7：复用原生 boundary 校验与 seed 构建（含 marker 与 turn 闭合），
        // 只替换 create 的写入通道。
        //
        // 已知差异（仅 open-turn 边界 fork 时）：seed 尾部是 turn 闭合事件而非
        // end-seed，fromRestore 模式下构造器会补一条**非 inherited** 的 live
        // end-seed 标记（原生快照通道因 markedSeed 判断不补）。该标记不参与
        // seed cut（不继承、不影响 v4 校验），代价是子会话事件流比原生多一条
        // 标记；换来大前缀的零拷贝复用。
        const events = liveSource.snapshotEvents()
        const resolved = this._forkBoundary(liveSource.id, events, boundary)
        seed = resolved === void 0 ? [] : buildForkSeed(events, resolved)
        cut = resolved === void 0 ? 0 : resolved + 1
        // buildForkSeed 的 prefix 元素来自 live log（已冻结），但新建的
        // marker / turn 闭合事件未冻结——shared-frozen 通道要求 seed 已冻结
        // 或独立拥有，原地补齐冻结。
        for (const event of seed) if (!Object.isFrozen(event)) deepFreeze(event)
      } else if (newProtocol) {
        seed = this._forkSeed(liveSource, boundary)
        cut = seed.length
        // fromRestore 通道不自动追加 seed 尾部 marker；磁盘校验要求 seeded
        // 会话尾部有 inherited end-seed（cut == marker.seq）。
        const seedTail = seed.at(-1)
        if (seedTail?.type !== 'session/end-seed' || seedTail?.data?.inherited !== true) {
          seed = [...seed, { type: 'session/end-seed', seq: cut, time: Date.now(), data: { inherited: true } }]
        }
      } else {
        seed = this._forkSeed(liveSource, boundary)
        cut = seed.length
      }

      let session
      if (protocol === 'alpha.5 seedSource') {
        let childId = childSessionId
        if (childId === void 0) {
          do { childId = `session-${++this.counter}` } while (this.store.has(childId))
        }
        session = this.prepare(childId, {
          seed,
          inheritedEventCount: sessionLogOffset(cut),
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
      } else {
        // fromRestore 通道把 meta 直接当 header 校验：必须带 version/id/createdAt
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
  log(`zero-copy fork installed (SessionStore.prototype.fork patched, protocol: ${protocolLabel})`)
}
