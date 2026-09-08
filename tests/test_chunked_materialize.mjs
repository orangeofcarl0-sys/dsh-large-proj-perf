// v0.3 测试：分片 materialize 与原生 encodeMaterialization 语义/字节等价
import { zstdDecompressSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { decodeAllFrames, countFrames } from './zstd_frames.mjs'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

// 复刻插件逻辑（独立于插件文件，直接测逻辑正确性）
const plugin = await import('../lib/index.js')

function text(len) { let s = ''; while (s.length < len) s += 'x'; return s.slice(0, len) }
function buildEvents(n) {
  const ev = []
  for (let seq = 0; seq < n; seq++) {
    ev.push({ type: seq % 3 === 0 ? 'assistant/message' : 'step/start', seq, time: seq, data: { turn: 1, step: 1, text: text(200) } })
  }
  return ev
}

// mock persistence backend：复刻 rc.6 encodeMaterialization 结构（含特征字面量）
function makePersistence({ packChunks = false } = {}) {
  const zstdCompressAsync = (async () => { const { zstdCompress } = await import('node:zlib'); const { promisify } = await import('node:util'); return promisify(zstdCompress) })()
  return {
    packChunks,
    compression: 'zstd',
    // 与 rc.6 逐字相同的实现体（含 'eventLines(events, this.packChunks)' + 'compressZstdFrame' 特征）
    encodeMaterialization: async function (meta, events) {
      const header = JSON.stringify({
        type: 'session', version: meta.version, id: meta.id, createdAt: meta.createdAt,
        ...(meta.cwd !== void 0 ? { cwd: meta.cwd } : {}),
        ...(meta.parentSession !== void 0 ? { parentSession: meta.parentSession } : {}),
        delegationDepth: meta.delegationDepth ?? 0,
      }) + '\n'
      const body = eventLines(events, this.packChunks) + '\n'
      const headerFrame = await compressZstdFrame(header)
      const bodyFrame = await compressZstdFrame(body)
      return Buffer.concat([headerFrame, bodyFrame])
    },
  }
  function eventLines(events, packChunks) {
    return events.map((r) => JSON.stringify(r)).join('\n') + '\n'
  }
  async function compressZstdFrame(input) {
    const z = await zstdCompressAsync
    return z(Buffer.from(input), { params: { [201]: 1 } })
  }
}

const N = 200000 // 超过 materializeChunkEvents 阈值（50000）触发分片
const events = buildEvents(N)
const meta = { version: 0, id: 'session-m1', createdAt: 123, cwd: 'C:\\t', delegationDepth: 0 }

// 原生基线
const nativeP = makePersistence()
const nativeBuf = await nativeP.encodeMaterialization(meta, events)
const nativeText = decodeAllFrames(nativeBuf).toString('utf8')
const nativeLines = nativeText.split('\n').filter(Boolean)

// 应用插件分片补丁
const ctx = {
  get: (name) => name === 'sessionPersistence' ? makePersistence() : name === 'settings' ? void 0 : void 0,
  on: () => () => {},
  inject: (deps, cb) => { if (deps[0] === 'sessionPersistence') cb({ get: () => makePersistence() }) },
  effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
  sessions: { get: () => void 0, list: () => [] },
  logger: { warn: () => {} },
}
const dispose = plugin.apply(ctx)
await new Promise((r) => setTimeout(r, 50))

// 但插件 patch 的是 ctx.get('sessionPersistence') 那个实例——mock 里 get 每次都新建。
// 改用固定实例重测
const persistence = makePersistence()
const ctx2 = {
  get: (name) => name === 'sessionPersistence' ? persistence : void 0,
  on: () => () => {},
  inject: (deps, cb) => { if (deps[0] === 'sessionPersistence') cb({ get: () => persistence }) },
  effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
  sessions: { get: () => void 0, list: () => [] },
  logger: { warn: () => {} },
}
dispose()
const dispose2 = plugin.apply(ctx2)
await new Promise((r) => setTimeout(r, 50))

const patchedBuf = await persistence.encodeMaterialization(meta, events)
const patchedText = decodeAllFrames(patchedBuf).toString('utf8')
const patchedLines = patchedText.split('\n').filter(Boolean)

check('chunked output decodes to same line count', patchedLines.length === nativeLines.length, `native=${nativeLines.length} patched=${patchedLines.length}`)
check('chunked output uses multiple frames', countFrames(patchedBuf) > countFrames(nativeBuf), `native frames=${countFrames(nativeBuf)} patched frames=${countFrames(patchedBuf)}`)
check('header line intact', patchedLines[0] === nativeLines[0])
// 逐事件 JSON 等价
let eq = true
for (let i = 1; i < nativeLines.length; i++) {
  if (nativeLines[i] !== patchedLines[i]) { eq = false; break }
}
check('all event lines byte-identical', eq)

dispose2()

// 阈值以下不触发分片（走原生路径）
const smallEvents = buildEvents(1000)
const smallP = makePersistence()
const ctx3 = {
  get: (name) => name === 'sessionPersistence' ? smallP : void 0,
  on: () => () => {},
  inject: (deps, cb) => { if (deps[0] === 'sessionPersistence') cb({ get: () => smallP }) },
  effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
  sessions: { get: () => void 0, list: () => [] },
  logger: { warn: () => {} },
}
const dispose3 = plugin.apply(ctx3)
await new Promise((r) => setTimeout(r, 50))
const smallBuf = await smallP.encodeMaterialization(meta, smallEvents)
// 低于阈值走原生路径：解压文本应等于 mock 原生 eventLines 的输出
const smallText = decodeAllFrames(smallBuf).toString('utf8')
check('below-threshold unchanged (single frame)', smallText.startsWith('{"type":"session"') && smallText.split('\n').filter(Boolean).length === smallEvents.length + 1, `lines=${smallText.split('\n').filter(Boolean).length}`)
dispose3()

// ================= 0.1.3 形态：三参签名 + 头帧复用原方法 =================
// 复刻 0.1.3 jsonl 实现：encodeMaterialization(meta, inheritedEventCount, events)；
// events 为空时只编码 header 帧（补丁头帧复用的入口）；body 单帧、无 packChunks
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
// 类语法复刻（方法 toString 需含 'encodeMaterialization(meta, inheritedEventCount, events)' 特征行，
// 与真实 0.1.3 jsonl 后端一致）
function makePersistence013() {
  const zstdCompressAsync = (async () => { const { zstdCompress } = await import('node:zlib'); const { promisify } = await import('node:util'); return promisify(zstdCompress) })()
  function eventLines(events) { return events.map((r) => JSON.stringify(r)).join('\n') + '\n' }
  async function compressZstdFrame(input) {
    const z = await zstdCompressAsync
    return z(Buffer.from(input), { params: { [201]: 1 } })
  }
  return new (class JsonlMock013 {
    constructor() { this.compression = 'zstd' }
    async encodeMaterialization(meta, inheritedEventCount, events) {
      const header = JSON.stringify({
        type: 'session', version: meta.version, id: meta.id, createdAt: meta.createdAt,
        ...(meta.cwd !== void 0 ? { cwd: meta.cwd } : {}),
        ...(meta.parentSession !== void 0 ? { parentSession: meta.parentSession } : {}),
        isSeeded: meta.isSeeded ?? false,
        delegationDepth: meta.delegationDepth ?? 0,
      }) + '\n'
      if (events.length === 0) return this.compression === 'none' ? header : compressZstdFrame(header)
      const body = eventLines(events) + '\n'
      if (this.compression === 'none') return header + body
      const headerFrame = await compressZstdFrame(header)
      const eventFrame = await compressZstdFrame(body)
      return Buffer.concat([headerFrame, eventFrame])
    }
  })()
}

{
  const meta013 = { version: 2, id: 'session-m013', createdAt: 123, cwd: 'C:\\t', isSeeded: true, delegationDepth: 0 }
  const native013 = makePersistence013()
  const nativeBuf = await native013.encodeMaterialization(meta013, 700, events)
  const nativeText = decodeAllFrames(nativeBuf).toString('utf8')
  const nativeLines = nativeText.split('\n').filter(Boolean)

  const p013 = makePersistence013()
  const ctx013 = {
    get: (name) => name === 'sessionPersistence' ? p013 : void 0,
    on: () => () => {},
    inject: (deps, cb) => { if (deps[0] === 'sessionPersistence') cb({ get: () => p013 }) },
    effect: (gen) => { const it = gen(); const step = (r) => { const { value, done } = it.next(r); if (!done) step(value) }; step() },
    sessions: { get: () => void 0, list: () => [] },
    logger: { warn: () => {} },
  }
  const dispose013 = plugin.apply(ctx013)
  await new Promise((r) => setTimeout(r, 50))

  const patched013 = await p013.encodeMaterialization(meta013, 700, events)
  const patchedText = decodeAllFrames(patched013).toString('utf8')
  const patchedLines = patchedText.split('\n').filter(Boolean)

  check('0.1.3 output decodes to same line count', patchedLines.length === nativeLines.length, `native=${nativeLines.length} patched=${patchedLines.length}`)
  check('0.1.3 output uses multiple frames', countFrames(patched013) > countFrames(nativeBuf), `native frames=${countFrames(nativeBuf)} patched frames=${countFrames(patched013)}`)
  // 头帧复用原方法：同一输入下字节级一致
  const patchedFrames = splitFrames(patched013)
  const nativeFrames = splitFrames(nativeBuf)
  check('0.1.3 header frame byte-identical (reused encoder)', patchedFrames[0].equals(nativeFrames[0]))
  // 逐事件 JSON 等价
  let eq013 = true
  for (let i = 1; i < nativeLines.length; i++) {
    if (nativeLines[i] !== patchedLines[i]) { eq013 = false; break }
  }
  check('0.1.3 all event lines byte-identical', eq013)

  // 阈值以下走原方法（保持两帧：header + body）
  const small013 = makePersistence013()
  const ctx013b = { ...ctx013, get: (name) => name === 'sessionPersistence' ? small013 : void 0 }
  const dispose013b = plugin.apply(ctx013b)
  await new Promise((r) => setTimeout(r, 50))
  const small013Buf = await small013.encodeMaterialization(meta013, 0, smallEvents)
  check('0.1.3 below-threshold unchanged (two frames)', countFrames(small013Buf) === 2, `frames=${countFrames(small013Buf)}`)
  dispose013b()
  dispose013()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
