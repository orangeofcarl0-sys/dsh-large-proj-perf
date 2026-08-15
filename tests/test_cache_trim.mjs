// v1.1 测试：冷会话 LRU 裁剪 + heap 检测
let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

// mock SessionPreparations（复刻 rc.6 结构）
function makePreparations(capacity, readyCount) {
  const entries = new Map()
  for (let i = 0; i < readyCount; i++) {
    entries.set(`session-${i}`, { id: `session-${i}`, phase: 'ready', source: { events: ['big'.repeat(1000)] } })
  }
  return { capacity, entries }
}

function makeCoordinator(prep) {
  return { preparations: prep, initFor: function (session) { const existing = this.live?.get(session); if (existing) return existing; const seed = session.events.map((e) => structuredClone(e)); return { init: Promise.resolve() } } }
}

const plugin = await import('../lib/index.js')

function makeCtx(coordinator) {
  return {
    get: (name) => (name === 'sessionPersistence' ? { coordinator } : name === 'settings' ? void 0 : void 0),
    on: () => () => {},
    inject: (deps, cb) => { if (deps[0] === 'sessionPersistence') cb({ get: () => ({ coordinator }) }) },
    effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
    sessions: { get: () => void 0, list: () => [] },
    logger: { warn: () => {} },
  }
}

// 用例 1：capacity 5 → 1，淘汰 4 个 ready entry
{
  const prep = makePreparations(5, 5)
  const coordinator = makeCoordinator(prep)
  const dispose = plugin.apply(makeCtx(coordinator))
  await new Promise((r) => setTimeout(r, 50))
  check('capacity lowered to 1', prep.capacity === 1, `capacity=${prep.capacity}`)
  const ready = [...prep.entries.values()].filter((e) => e.phase === 'ready')
  check('ready entries trimmed to 1', ready.length === 1, `ready=${ready.length}`)
  dispose()
}

// 用例 2：capacity 已是 1（从 cordis.patch.yml 传入），无多余 ready，不误删
{
  const prep = makePreparations(1, 1)
  const coordinator = makeCoordinator(prep)
  const dispose = plugin.apply(makeCtx(coordinator))
  await new Promise((r) => setTimeout(r, 50))
  check('already-1 capacity: no over-trim', [...prep.entries.values()].filter((e) => e.phase === 'ready').length === 1)
  dispose()
}

// 用例 3：无 persistence 服务 → 跳过不崩
{
  const ctx = {
    get: () => void 0, on: () => () => {}, inject: () => {},
    effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
    sessions: { get: () => void 0, list: () => [] }, logger: { warn: () => {} },
  }
  const dispose = plugin.apply(ctx)
  await new Promise((r) => setTimeout(r, 20))
  check('no persistence: apply survives', typeof dispose === 'function')
  dispose()
}

// 用例 4：entries 里有 loading 态（非 ready），只淘汰 ready
{
  const prep = makePreparations(5, 2)
  prep.entries.set('session-loading', { id: 'session-loading', phase: 'loading' })
  const coordinator = makeCoordinator(prep)
  const dispose = plugin.apply(makeCtx(coordinator))
  await new Promise((r) => setTimeout(r, 50))
  const ready = [...prep.entries.values()].filter((e) => e.phase === 'ready')
  const loading = [...prep.entries.values()].filter((e) => e.phase === 'loading')
  check('only ready trimmed, loading preserved', ready.length === 1 && loading.length === 1, `ready=${ready.length} loading=${loading.length}`)
  dispose()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
