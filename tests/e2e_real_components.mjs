// 真实组件端到端验证：直接驱动 dsh 安装包里的**真实实现类**（非 mock 复刻），
// 覆盖插件的全部作用点位——每个点位都要求「真实源码特征 + 补丁安装 + 行为正确」
// 三者同时成立：
//
//   1. 分片 materialize —— 真实 JsonlSessionPersistence.prototype.encodeMaterialization
//   2. 投影分片预热   —— 真实 SessionProjectionRegistry（cellFor/snapshot/buildCell）
//   3. 零拷贝 fork    —— 真实 SessionStore/Session 的 fork 通道
//   4. 失效点位语义   —— fastInitFor / preparedCacheTrim 在上游无对应物时必须
//                       走 skipped（inactive）而不是误装
//
// 与 mock 套件的区别：这里的分支判定、特征探测、编码字节全部由真实源码决定，
// 上游一旦改动就会在这里暴露（mock 会继续「自洽地通过」）。

import { Session, SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
// 0.2.1 起 jsonl 后端改为 cordis 插件形态（导出 name/apply/Config），不再导出
// default 类。真实实例经 Context.plugin 装载后从 ctx.sessionPersistence 取得，
// 原型链仍是真实的 JsonlSessionPersistence.prototype。
import { Context } from '@deepseek-ai/cordis'
import * as jsonlPlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeAllFrames, countFrames } from './zstd_frames.mjs'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 通用最小 cordis ctx（记录 handlers 以便手动触发事件） ----
function makeCtx(services = {}) {
  const handlers = new Map()
  const logs = []
  const map = new Map(Object.entries(services))
  const ctx = {
    sessions: services.sessions,
    get: (name) => map.get(name),
    on: (event, cb) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(cb)
      return () => {}
    },
    inject: (deps, cb) => { if (deps.every((d) => map.has(d))) cb(ctx) },
    effect: (gen) => {
      const it = gen()
      const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }
      step()
    },
    logger: {
      info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    },
  }
  return { ctx, handlers, logs }
}

// 触发挂载在 session/created 上的预热
async function emitCreated(handlers, session, ms = 700) {
  for (const cb of handlers.get('session/created') ?? []) cb(session)
  await tick(ms)
}

function text(len) { let s = ''; while (s.length < len) s += 'e2e payload '; return s.slice(0, len) }
// 合法事件流（真实 Session 会做信封/结构校验）：turn/step 配对 + usage，
// 用于真实 store/registry 路径；materialize 路径不校验内容、同一构造复用。
function buildEvents(n) {
  const ev = []
  let turn = 0
  for (let seq = 0; seq < n; seq++) {
    const kind = seq % 5
    const time = 1000 + seq
    const pad = text(160) // 保持与真实负载同量级的体积
    if (kind === 0) ev.push({ type: 'turn/start', seq, time, data: { turn: ++turn, pad } })
    else if (kind === 1) ev.push({ type: 'step/start', seq, time, data: { turn, step: 1, pad } })
    else if (kind === 2) ev.push({ type: 'step/end', seq, time, data: { turn, step: 1, pad } })
    else if (kind === 3) ev.push({ type: 'turn/end', seq, time, data: { turn, reason: { kind: 'completed' }, pad } })
    else ev.push({ type: 'usage', seq, time, data: { turn, step: 1, usage: { inputTokens: 10, outputTokens: 20 }, pad } })
  }
  return ev
}
function splitFrames(buf) {
  const MAGIC = [0x28, 0xB5, 0x2F, 0xFD]
  const frames = []
  let start = -1
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      if (start !== -1) frames.push(buf.subarray(start, i))
      start = i
    }
  }
  if (start !== -1) frames.push(buf.subarray(start))
  return frames
}

// 合法 header 的真实 Session（header 必须完整：version 取运行时格式线）
const makeSession = (id, events) => Session.create(id, events, {
  version: SESSION_FORMAT_VERSION,
  id,
  createdAt: Date.now(),
  isSeeded: false,
  cwd: 'F:\\e2e',
})

const plugin = await import('../lib/index.js')

// 装载真实 jsonl 后端，返回其 sessionPersistence 实例（真实构造路径）。
// 0.2.0 及之前该包导出 default 类，可直接 new/原型直取；0.2.1 起只导出
// cordis 插件（name/apply），必须经 Context.plugin 装载才能拿到实例。
let backendLoader
async function loadRealBackend() {
  if (backendLoader !== undefined) return backendLoader
  backendLoader = (async () => {
    if (typeof jsonlPlugin.default === 'function') {
      const p = Object.create(jsonlPlugin.default.prototype)
      p.compression = 'zstd'
      return { instance: p, dispose: () => {} }
    }
    const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
    const ctx = new Context()
    ctx.plugin({ name: 'e2e-jsonl', apply: (c, cfg) => jsonlPlugin.apply(c, cfg) }, { root, compression: 'zstd' })
    for (let i = 0; i < 100; i++) {
      const svc = ctx.get('sessionPersistence')
      if (svc !== undefined) return { instance: svc, dispose: () => { void ctx.stop?.() } }
      await tick(20)
    }
    throw new Error('real jsonl backend did not register sessionPersistence')
  })()
  return backendLoader
}

// ================= 点位 1：分片 materialize（真实 jsonl 后端） =================
{
  const { instance: realBackend } = await loadRealBackend()
  const RealProto = Object.getPrototypeOf(realBackend)
  const makePersistence = () => Object.create(RealProto) // 真实原型链
  const meta = { version: 4, id: 'session-e2e-mat', createdAt: 1, cwd: 'F:\\e2e', isSeeded: false }
  const events = buildEvents(60000) // > materializeChunkEvents(50000)

  const native = makePersistence()
  const nativeBuf = await native.encodeMaterialization(meta, 0, events)

  const patched = makePersistence()
  const { ctx, logs } = makeCtx({ sessionPersistence: patched })
  const dispose = plugin.apply(ctx)
  await tick(60)

  check('position 1: patch installed as own property on real prototype chain',
    Object.prototype.hasOwnProperty.call(patched, 'encodeMaterialization'))
  const patchedBuf = await patched.encodeMaterialization(meta, 0, events)
  check('position 1: multi-frame output', countFrames(patchedBuf) > countFrames(nativeBuf),
    `native=${countFrames(nativeBuf)} patched=${countFrames(patchedBuf)}`)
  check('position 1: header frame byte-identical (upstream encoder reused)',
    splitFrames(patchedBuf)[0].equals(splitFrames(nativeBuf)[0]))
  check('position 1: decoded payload byte-identical',
    decodeAllFrames(patchedBuf).equals(decodeAllFrames(nativeBuf)))
  // 小负载走原生路径
  const small = makePersistence()
  const smallDispose = plugin.apply(makeCtx({ sessionPersistence: small }).ctx)
  await tick(60)
  const smallBuf = await small.encodeMaterialization(meta, 0, buildEvents(1000))
  check('position 1: below-threshold delegates to native (2 frames)', countFrames(smallBuf) === 2)
  smallDispose(); dispose()
}

// 点位 2（投影分片预热）已随 v1.10.0 删除该能力一并移除。
// 当时的三条实测结论保留在 docs/RUNTIME-ANALYSIS.md 的场景 C：
//   1. 预热用 def.init() 无参调用会抛 TypeError（1.3.1 修复，已随能力删除）；
//   2. 预热写入的 cell 必须与 buildCell 同形（含 views 对）；
//   3. 在 0.2.2 上该能力恒 alreadyHot —— 上游在 session/created 的同步广播里
//      已把全部 cell 建满，预热没有可折的单元。

// ================= 点位 3：零拷贝 fork（真实 SessionStore/Session） =================
{
  const store = Object.create(SessionStore.prototype)
  store.store = new Map()
  store.counter = 0
  const listeners = []
  store.ctx = {
    effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
    on: (e, cb) => { listeners.push(cb); return () => {} },
    parallel: () => Promise.resolve([]),
    // announce() 经 ctx.events.dispatch 收集 session/created 监听者
    events: { dispatch: () => [] },
  }
  const src = store.create('session-e2e-src', { seed: buildEvents(3000), meta: { cwd: 'F:\\e2e' } })

  const nativeChild = store.fork('session-e2e-src')
  const nativeEvents = nativeChild.snapshotEvents()

  const { ctx } = makeCtx({ sessions: store })
  const dispose = plugin.apply(ctx)
  const patchedChild = store.fork('session-e2e-src')
  const patchedEvents = patchedChild.snapshotEvents()

  check('position 3: patched fork produces same event count as native',
    patchedEvents.length === nativeEvents.length, `patched=${patchedEvents.length} native=${nativeEvents.length}`)
  check('position 3: inherited cut matches native',
    patchedChild.inheritedEventCount === nativeChild.inheritedEventCount,
    `cut=${patchedChild.inheritedEventCount}`)
  check('position 3: inherited prefix + marker byte-identical',
    JSON.stringify(patchedEvents.slice(0, patchedChild.inheritedEventCount + 1))
    === JSON.stringify(nativeEvents.slice(0, nativeChild.inheritedEventCount + 1)))
  let frozen = false
  try { patchedEvents[1].data.text = 'MUTATE' } catch { frozen = true }
  check('position 3: shared seed refs stay frozen (true zero-copy)', frozen)
  // header 必须与同版本原生 fork 一致：0.1.7–0.2.1 原生写 parentSession，
  // 0.2.2 起不写。断言比对的是「与原生相同」而不是固定值。
  check('position 3: child header parity',
    patchedChild.header.isSeeded === true
      && patchedChild.header.parentSession === nativeChild.header.parentSession,
    `parentSession=${String(patchedChild.header.parentSession)} native=${String(nativeChild.header.parentSession)}`)
  dispose()
}

// 点位 4（失效点位必须是 skipped）已随 v1.10.0 删除 fastInitFor 与
// preparedCacheTrim 一并移除 —— 它们依赖的 persistence.coordinator 在 dsh 0.2.2
// 里已不存在（grep -c coordinator = 0），实测恒 inactive，不再作为「补丁」维护。

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
