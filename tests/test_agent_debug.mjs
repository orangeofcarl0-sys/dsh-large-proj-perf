// v1.17 分析工具测试：AgentHandle 捕获 / dispose / detach / trim（lib/agent-debug.js）。
//
// 只在 debugAgentHandles=true 时安装；默认关闭时不能留下任何全局或原型改动。

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const { installAgentDebug } = await import('../lib/agent-debug.js')

class FakeAgents {
  constructor() {
    this.store = new Map()
    this.disposed = []
  }
  async resume(options) {
    const id = options.id
    const agent = { id, status: 'idle', session: { id } }
    this.store.set(id, agent)
    return {
      agent,
      dispose: async () => {
        this.disposed.push(id)
        this.store.delete(id)
      },
    }
  }
  async create(options) {
    return this.resume(options)
  }
  get(id) { return this.store.get(id) }
  list() { return [...this.store.values()] }
}

function makeHarness({ enabled = true } = {}) {
  const agents = new FakeAgents()
  const sessions = new Map()
  const sessionStore = {
    store: new Map(),
    get(id) { return sessions.get(id) },
    list() { return [...sessions.values()] },
  }
  const ctx = {
    sessions: sessionStore,
    get(name) { return name === 'agents' ? agents : void 0 },
  }
  const deps = {
    ctx,
    config: { debugAgentHandles: enabled },
    log: () => {},
    logErr: (message) => { deps.errors.push(String(message)) },
    safeGet: (context, name) => context.get?.(name),
    disposers: [],
    errors: [],
  }
  return { agents, sessions, sessionStore, ctx, deps }
}

// ---- 默认关闭 ----
delete globalThis.__dshPerfProbe
{
  const h = makeHarness({ enabled: false })
  const beforeResume = h.agents.resume
  installAgentDebug(h.deps)
  check('disabled: no global probe', globalThis.__dshPerfProbe === undefined)
  check('disabled: resume not wrapped', h.agents.resume === beforeResume)
}

// ---- 捕获 + dispose ----
{
  delete globalThis.__dshPerfProbe
  const h = makeHarness()
  const protoBefore = Object.getPrototypeOf(h.agents)
  const resumeBefore = protoBefore.resume
  installAgentDebug(h.deps)
  check('enabled: global probe installed', typeof globalThis.__dshPerfProbe === 'object')
  check('enabled: prototype wrapped', protoBefore.resume !== resumeBefore)
  const handle = await h.agents.resume({ id: 'a' })
  check('capture: handle returned unchanged', handle.agent.id === 'a' && typeof handle.dispose === 'function')
  check('capture: handle listed', JSON.stringify(globalThis.__dshPerfProbe.list()) === '["a"]')
  h.sessions.set('a', { id: 'a', log: [] })
  const result = await globalThis.__dshPerfProbe.dispose('a')
  check('dispose: reports disposed', result.disposed === true, JSON.stringify(result))
  check('dispose: handle invoked', h.agents.disposed.includes('a'))
  check('dispose: agent removed', h.agents.get('a') === undefined)
  check('dispose: handle removed from map', globalThis.__dshPerfProbe.list().length === 0)
  const unknown = await globalThis.__dshPerfProbe.dispose('missing')
  check('dispose: unknown id reports error', unknown.disposed === false && unknown.error === 'handle-not-captured')

  // detach 负对照
  await h.agents.resume({ id: 'b' })
  const bSession = {
    id: 'b',
    log: [],
    detach() { h.sessions.delete('b'); h.sessionStore.store.delete('b') },
  }
  h.sessions.set('b', bSession)
  h.sessionStore.store.set('b', { id: 'b', detach: () => bSession.detach() })
  const detached = globalThis.__dshPerfProbe.detach('b')
  check('detach: removes session entry', detached.detached === true && !h.sessions.has('b'), JSON.stringify(detached))
  check('detach: agent stays live', h.agents.get('b') !== undefined)

  // trim（破坏性）
  const log = Array.from({ length: 10 }, (_, i) => ({ seq: i }))
  const derived = [{ id: 1 }, { id: 2 }]
  const surfaceManager = { log }
  const cSession = { id: 'c', log, eventsSnapshot: Object.freeze([...log]), derived, surfaceManager }
  h.sessions.set('c', cSession)
  const trimmed = globalThis.__dshPerfProbe.trim('c', { keepEvents: 4, clearDerived: true })
  check('trim: keeps tail', trimmed.trimmed === true && cSession.log.length === 4, JSON.stringify(trimmed))
  check('trim: surface log follows', surfaceManager.log.length === 4)
  check('trim: snapshot cleared', cSession.eventsSnapshot === undefined)
  check('trim: derived cleared', cSession.derived.length === 0)
  check('trim: reports removed count', trimmed.removedEvents === 6, String(trimmed.removedEvents))

  for (const dispose of h.deps.disposers.splice(0)) dispose()
  check('dispose: global probe removed', globalThis.__dshPerfProbe === undefined)
  check('dispose: prototype restored', protoBefore.resume === resumeBefore)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
