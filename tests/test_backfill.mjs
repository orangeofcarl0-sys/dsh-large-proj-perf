// v0.2 冒烟测试：fork 回填 + 冷会话后台补行
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const defCounter = {
  key: 'counter',
  stateVersion: 1,
  schema: { parse: (v) => v },
  init: () => ({ count: 0, lastSeq: -1 }),
  apply: (s, e) => ({ count: s.count + 1, lastSeq: e.seq }),
  view: (s) => s,
}

function makeRegistry() {
  return {
    registrations: new Map(),
    register(def) { this.registrations.set(def.key, { def, cells: new WeakMap(), refs: 1 }); return () => this.registrations.delete(def.key) },
    snapshot: function (session) { const v = {}; for (const [k, r] of this.registrations) { const c = this.cellFor(r, session); v[k] = r.def.view(c.state) } return { asOfSeq: 0, values: v } },
    cellFor(reg, session) { let c = reg.cells.get(session); if (!c) { c = this.buildCell(reg.def, session.events); reg.cells.set(session, c) } return c },
    buildCell(def, events) { let s = def.init(); for (const e of events) s = def.apply(s, e); return { state: s, observedSeq: events.at(-1)?.seq ?? -1 } },
  }
}

// mock 投影缓存（复刻 recordFor/write/putSoft 语义）
function makeCache() {
  const records = new Map()
  return {
    records,
    recordFor: (id, identity) => {
      const r = records.get(id)
      if (r === void 0) return void 0
      return r.identity.createdAt === identity.createdAt && r.identity.cwd === identity.cwd ? r : void 0
    },
    write: async (session) => { records.set(session.id, { identity: { createdAt: session.header.createdAt, cwd: session.header.cwd }, rows: { counter: { ver: 1, seq: session.events.at(-1)?.seq ?? -1, val: { count: session.events.length, lastSeq: session.events.at(-1)?.seq ?? -1 } } } }) },
    putSoft: async (id, identity, rows) => { records.set(id, { identity, rows }) },
  }
}

const plugin = await import('../lib/index.js')

function makeCtx({ registry, cache, sessions, persistence, dshHomePaths, settings }) {
  return {
    get: (name) => ({ sessionProjections: registry, sessionProjectionCache: cache, sessionPersistence: persistence, dshHomePaths, settings }[name]),
    on: () => () => {},
    inject: () => {},
    effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
    sessions: { get: (id) => sessions.get(id), list: () => [...sessions.values()] },
    logger: { warn: () => {} },
  }
}

// ================= 用例 1：fork 子会话预热后回填缓存行 =================
{
  const registry = makeRegistry()
  registry.register(defCounter)
  const cache = makeCache()
  const N = 25000
  const events = []
  for (let seq = 0; seq < N; seq++) events.push({ type: 'step/start', seq, time: 1, data: { turn: 1, step: 1 } })
  const session = {
    id: 'session-child1',
    header: { id: 'session-child1', version: 0, createdAt: 123, cwd: 'C:\\b', parentSession: 'session-parent', seedLength: N },
    events: Object.freeze([...events]),
  }
  const sessions = new Map([['session-child1', session]])
  const ctx2 = makeCtx({ registry, cache, sessions })
  const dispose = plugin.apply(ctx2)
  await new Promise((r) => setTimeout(r, 400))
  const rec = cache.records.get('session-child1')
  check('fork child cache row backfilled', rec !== void 0)
  if (rec) {
    check('row watermark = last seq', rec.rows.counter.seq === N - 1, `seq=${rec.rows.counter.seq}`)
    check('row value matches fold', rec.rows.counter.val.count === N)
  }
  dispose()
}

// ================= 用例 2：非 fork 会话不回填 =================
{
  const registry = makeRegistry()
  registry.register(defCounter)
  const cache = makeCache()
  const events = []
  for (let seq = 0; seq < 25000; seq++) events.push({ type: 'step/start', seq, time: 1, data: {} })
  const session = { id: 'session-plain', header: { id: 'session-plain', version: 0, createdAt: 1, cwd: 'C:\\b' }, events: Object.freeze([...events]) }
  const sessions = new Map([['session-plain', session]])
  const ctx2 = makeCtx({ registry, cache, sessions })
  const dispose = plugin.apply(ctx2)
  await new Promise((r) => setTimeout(r, 300))
  check('non-fork session NOT backfilled', cache.records.get('session-plain') === void 0)
  dispose()
}

// ================= 用例 3：冷会话后台补行（磁盘日志 → 缓存行） =================
{
  const tmp = mkdtempSync(join(tmpdir(), 'warmup-bf-'))
  const projDir = join(tmp, '--C-test--')
  const sessDir = join(projDir, 'session-cold1')
  mkdirSync(sessDir, { recursive: true })
  // 造日志：header + 25000 行事件
  const header = { type: 'session', version: 0, id: 'session-cold1', createdAt: 42, cwd: 'C:\\test', delegationDepth: 0 }
  const lines = [JSON.stringify(header)]
  for (let seq = 0; seq < 25000; seq++) lines.push(JSON.stringify({ type: 'step/start', seq, time: 1, data: { turn: 1, step: 1 } }))
  const logText = lines.join('\n') + '\n'
  writeFileSync(join(sessDir, 'session.jsonl'), logText)
  // 填大文件以满足 backfillMinBytes？明文不够大——直接用 jsonl（无压缩）并放宽阈值 via config
  const registry = makeRegistry()
  registry.register(defCounter)
  const cache = makeCache()
  const persistence = {
    readRaw: async (id) => {
      if (id !== 'session-cold1') return void 0
      return { meta: { id, createdAt: 42, cwd: 'C:\\test' }, filename: 'session.jsonl', content: logText }
    },
  }
  const sessions = new Map() // 无 live 会话
  // mock settings：提供 backfillOnBoot=true + 降低 backfillMinBytes 让明文日志入选
  const settings = {
    register: () => () => {},
    get: () => ({ backfillOnBoot: true, backfillMinBytes: 1, backfillMaxBytes: 33554432 }),
  }
  const ctx2 = makeCtx({ registry, cache, sessions, persistence, dshHomePaths: { sessions: () => tmp }, settings })
  const dispose = plugin.apply(ctx2)
  // 等 15s 定时器触发 backfillColdSessions
  await new Promise((r) => setTimeout(r, 16500))
  const rec = cache.records.get('session-cold1')
  check('cold session backfilled from disk', rec !== void 0)
  if (rec) {
    check('backfill row count matches', rec.rows.counter.val.count === 25000, `count=${rec.rows.counter.val.count}`)
    check('backfill watermark = last seq', rec.rows.counter.seq === 24999)
    check('identity carried from log header', rec.identity.createdAt === 42 && rec.identity.cwd === 'C:\\test')
  }
  dispose()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
