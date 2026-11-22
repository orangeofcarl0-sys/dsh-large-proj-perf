// 分析专用：捕获 AgentHandle，供 live Session 驱逐/窗口化实验使用。
//
// **默认关闭**（config.debugAgentHandles=false）。只有隔离分析 profile 会打开；
// 它包装 AgentRegistry.prototype.resume/create，把返回的 { agent, dispose } 存进
// Map，并暴露 globalThis.__dshPerfProbe 给 Node inspector 调用。
//
// 为什么需要：Web controller 在 resume 后只返回 .agent，丢弃了唯一的
// AgentHandle.dispose capability（dsh-api-session-controller/src/agent.ts）。
// 没有这个探针就无法执行“真 teardown vs 仅 detach”的对照实验。
//
// 本模块不是产品功能；分析结束后应删除（或至少保持默认关闭且不发布）。

import { wrapMethod } from './patch-target.js'

const describeError = (error) => String(error?.message ?? error)

export function installAgentDebug(deps) {
  const { ctx, config, log, logErr, safeGet, disposers } = deps
  if (!config.debugAgentHandles) return

  const agents = safeGet(ctx, 'agents')
  if (agents === void 0 || typeof agents.resume !== 'function' || typeof agents.create !== 'function') {
    logErr('agent debug: ctx.agents.resume/create is unavailable')
    return
  }
  const proto = Object.getPrototypeOf(agents)
  if (proto === null) {
    logErr('agent debug: AgentRegistry prototype is unavailable')
    return
  }

  const handles = new Map()
  const capture = (handle) => {
    if (handle?.agent !== undefined && typeof handle.agent.id === 'string' && typeof handle.dispose === 'function') {
      handles.set(handle.agent.id, handle)
    }
    return handle
  }
  let wrapped = 0
  for (const method of ['resume', 'create']) {
    if (typeof proto[method] !== 'function') continue
    wrapMethod(proto, method, (original) => async function (...args) {
      return capture(await original.apply(this, args))
    }, disposers)
    wrapped += 1
  }
  if (wrapped === 0) {
    logErr('agent debug: no resume/create method was wrapped')
    return
  }

  const clearCached = (id) => {
    let cacheCleared = 0
    let memoCleared = 0
    const cache = ctx.get('sessionQuery')?._observations?.cache
    if (cache instanceof Map && cache.delete(id)) cacheCleared = 1
    const memo = ctx.get('sessionPersistence')?.coldLogMemo
    if (memo instanceof Map && memo.delete(id)) memoCleared = 1
    return { cacheCleared, memoCleared }
  }

  const probe = {
    ctx,
    handles,
    list: () => [...handles.keys()],
    /** 真 teardown：仅 idle agent。返回前后注册表状态。 */
    async dispose(id, options = {}) {
      const agent = agents.get(id)
      const handle = handles.get(id)
      if (handle === undefined) return { disposed: false, error: 'handle-not-captured' }
      if (agent !== undefined && agent.status !== 'idle') {
        return { disposed: false, error: 'agent-not-idle', status: agent.status }
      }
      const started = Date.now()
      try {
        await handle.dispose()
      } catch (error) {
        return { disposed: false, error: describeError(error), ms: Date.now() - started }
      }
      handles.delete(id)
      const cleared = options.clearCache === true ? clearCached(id) : { cacheCleared: 0, memoCleared: 0 }
      return {
        disposed: true,
        ms: Date.now() - started,
        agentStillLive: agents.get(id) !== undefined,
        sessionStillInStore: ctx.sessions.get(id) !== undefined,
        ...cleared,
      }
    },
    /** 负对照：只调 SessionStore 内部的 detach，不停止 Agent。 */
    detach(id) {
      const before = {
        agentLive: agents.get(id) !== undefined,
        sessionInStore: ctx.sessions.get(id) !== undefined,
      }
      const entry = ctx.sessions.store?.get?.(id)
      if (entry === undefined || typeof entry.detach !== 'function') {
        return { detached: false, error: 'detach-unavailable', before }
      }
      entry.detach()
      return {
        detached: true,
        before,
        after: {
          agentLive: agents.get(id) !== undefined,
          sessionInStore: ctx.sessions.get(id) !== undefined,
        },
      }
    },
    /**
     * C1 内存上限实验：破坏性裁剪 live Session 的 log/snapshot/derived。
     * 不用于生产；裁剪后 seq/读取/fork 都会失效，进程应尽快丢弃。
     */
    trim(id, options = {}) {
      const session = ctx.sessions.get(id)
      if (session === undefined) return { trimmed: false, error: 'session-not-live' }
      if (!Array.isArray(session.log)) return { trimmed: false, error: 'log-unavailable' }
      const beforeEvents = session.log.length
      const beforeSnapshot = session.eventsSnapshot !== undefined
      const beforeDerived = Array.isArray(session.derived) ? session.derived.length : null
      if (options.clearSnapshot !== false) session.eventsSnapshot = undefined
      if (options.clearDerived === true) session.derived = []
      let cacheCleared = 0
      let memoCleared = 0
      if (options.clearCache === true) {
        ;({ cacheCleared, memoCleared } = clearCached(id))
      }
      let afterEvents = beforeEvents
      const keep = Number(options.keepEvents)
      if (Number.isFinite(keep) && keep > 0 && keep < beforeEvents) {
        const tail = session.log.slice(beforeEvents - keep)
        session.log = tail
        if (session.surfaceManager !== undefined && session.surfaceManager.log !== undefined) {
          session.surfaceManager.log = tail
        }
        afterEvents = tail.length
      }
      return {
        trimmed: true,
        beforeEvents,
        afterEvents,
        removedEvents: beforeEvents - afterEvents,
        clearedSnapshot: beforeSnapshot,
        clearedDerived: options.clearDerived === true ? beforeDerived : null,
        cacheCleared,
        memoCleared,
        warning: 'destructive: seq/eventAt/fork/pagination are invalid after trim',
      }
    },
  }

  globalThis.__dshPerfProbe = probe
  disposers.push(() => {
    if (globalThis.__dshPerfProbe === probe) delete globalThis.__dshPerfProbe
  })
  log(`agent debug: captured AgentHandle on ${wrapped} method(s); __dshPerfProbe exposed`)
}
