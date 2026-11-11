// v1.10 测试：装配上下文契约（context.js）
//
// 本套件存在的核心目的：**证明晚绑定 bug 已修**。
//
// v1.9.0 及之前，`api.js` 在 installApi 时解构 `backfill` 与 `retrimPreparedCache`，
// 但这两个值是别的模块在装配**之后**才写进共享 `pc` 的。因为 installApi 走
// `ctx.inject(['webServer'])` 懒装配（webServer 通常早于 sessionPersistence 就绪），
// 解构到的是 `undefined` 且永不更新：
//   - `config.set` 改 `preparedCacheSize` 不重裁；
//   - 打开 `backfillOnBoot` 不补跑扫描。
//
// 现在 api.js 通过 `runtime.backfill.get()` **在调用时**取值，所以两个功能都能用。

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const { createDeps, createRuntime } = await import('../lib/context.js')
const { installApi } = await import('../lib/api.js')

// ---- deps 是冻结的只读包 ----
{
  const stub = { a: 1 }
  const deps = createDeps({
    ctx: stub, config: {}, stats: {}, log: () => {}, logErr: () => {},
    disposers: [], safeGet: () => void 0, sessionEventsOf: () => void 0,
    sessionLogOffset: (v) => v, cacheIdentityOf: () => ({}),
    yieldLoop: () => Promise.resolve(), setConfigValue: () => {},
    setPatchStatus: () => {}, recordFork: () => {},
  })
  check('deps: frozen', Object.isFrozen(deps))
  check('deps: exposes documented fields',
    deps.ctx === stub && typeof deps.yieldLoop === 'function' && typeof deps.safeGet === 'function')
  let threw = false
  try { 'use strict'; deps.ctx = null } catch { threw = true }
  check('deps: assignment throws in strict mode', threw || deps.ctx === stub)
}

// ---- runtime 晚绑定槽：set 之前 get 得 undefined ----
{
  const runtime = createRuntime()
  check('runtime: get before set is undefined', runtime.backfill.get() === void 0)
  const handle = { backfillColdSessions: () => Promise.resolve(), isFired: () => true }
  runtime.backfill.set(handle)
  check('runtime: get after set returns handle', runtime.backfill.get() === handle)
  runtime.backfill.clear()
  check('runtime: clear resets to undefined', runtime.backfill.get() === void 0)
}

// ---- 决定性验证：api.js 在**调用时**取 backfill 句柄 ----
// 复刻 v1.9.0 的失败现场：installApi 时 runtime 里还没有 backfill，
// 之后才 set。正确实现下 config.set 仍能触发补跑。
{
  const config = { backfillOnBoot: false, debugApi: false }
  const stats = { forks: 0, zeroCopy: 0, fallbacks: 0, forkRecent: [], backfilled: 0, backfillSkipped: 0, backfill: [], coldWriteBacks: 0, coldWriteBackSkipped: 0, coldWriteBackFailed: 0, coldWriteBackRecent: [], memoryBudgetTrimmed: 0, memoryBudgetFreedBytes: 0, memoryBudgetOverBudget: 0 }
  const disposers = []
  const logs = []

  let handler = null
  const webServer = {
    register({ handler: h }) { handler = h; return () => {} },
  }
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : void 0),
    sessions: { fork: () => ({ id: 'child' }) },
    on: () => () => {},
    logger: { info() {}, error() {}, warn() {} },
  }
  const deps = createDeps({
    ctx, config, stats,
    log: (m) => logs.push(m), logErr: (m) => logs.push('ERR ' + m),
    disposers, safeGet: (c, n) => c.get?.(n),
    sessionEventsOf: () => [], sessionLogOffset: (v) => v,
    cacheIdentityOf: () => ({}),
    yieldLoop: () => Promise.resolve(),
    // 复刻真实实现：只认 DEFAULT_CONFIG 里存在的键
    setConfigValue: (k, v) => { if (k in config) config[k] = v },
    setPatchStatus: () => {}, recordFork: () => {},
  })
  const runtime = createRuntime()

  // 关键：installApi 时 runtime 还是空的（这正是 v1.9.0 的失败时机）
  installApi(deps, runtime)
  check('late binding: api handler registered', typeof handler === 'function')

  // 装配之后才登记 backfill —— 与 index.js 的真实时序一致
  let scanCalls = 0
  let fired = true
  runtime.backfill.set({
    backfillColdSessions: () => { scanCalls += 1; return Promise.resolve() },
    isFired: () => fired,
  })

  // 走一次 config.set({ backfillOnBoot: true })
  const req = {
    headers: { host: '127.0.0.1:3080' },
    method: 'POST',
    url: '/dsh-large-proj-perf/api/config.set',
    setEncoding() {},
    on(event, cb) {
      if (event === 'data') cb(JSON.stringify({ backfillOnBoot: true }))
      if (event === 'end') setTimeout(cb, 0)
    },
  }
  let status = 0
  let body = ''
  const res = {
    writeHead(s) { status = s },
    end(b) { body = b },
  }
  await handler(req, res)
  await new Promise((r) => setTimeout(r, 20))

  check('late binding: config.set returned 200', status === 200, `status=${status}`)
  check('late binding: backfillOnBoot applied', config.backfillOnBoot === true)
  check('late binding: backfill scan was triggered', scanCalls === 1, `scanCalls=${scanCalls}`)
  check('late binding: no error logged', !logs.some((l) => l.startsWith('ERR')), logs.join(' | '))

  // 反向验证：如果 isFired() 为 false（还没到 15 秒），不应触发
  scanCalls = 0
  fired = false
  config.backfillOnBoot = false
  const req2 = { ...req, on(event, cb) {
    if (event === 'data') cb(JSON.stringify({ backfillOnBoot: true }))
    if (event === 'end') setTimeout(cb, 0)
  } }
  await handler(req2, res)
  await new Promise((r) => setTimeout(r, 20))
  check('late binding: no scan before timer fired', scanCalls === 0, `scanCalls=${scanCalls}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
