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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
