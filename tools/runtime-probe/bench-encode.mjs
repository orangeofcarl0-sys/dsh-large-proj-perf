// 量「服务端把快照帧编码一次」的成本：JSON.stringify + zlib deflate(level 1)。
//
// 为什么单独量：`session/follow` 的首帧在服务端生成后，还要经过
// stream-server 的 `JSON.stringify(message)` 与异步 deflate 才会写到 socket。
// 客户端只能看到「帧到达」，中间这段需要从两头夹：
//
//   服务端产出(t)  ──encode+deflate──▶ 写 socket ──网络──▶ [inflate] ──▶ 帧到达
//
// 本脚本给出 encode+deflate 的字节与耗时；它与浏览器侧 `frameAt - server.t`
// 的差值，就是「网络 + inflate」。
//
// 用法：
//   node tools/runtime-probe/bench-encode.mjs \
//     --home <home> --agents <agents> --port 3300 --session session-probe-long

import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { deflateSync, inflateSync } from 'node:zlib'

import { makeClient } from './client.mjs'
import { startDsh } from './server.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const home = resolve(arg('home', ''))
const agentsHome = resolve(arg('agents', ''))
const profile = arg('profile', 'rt')
const port = Number(arg('port', '3300'))
const sessionId = arg('session', 'session-probe-long')
const outDir = arg('out', join(home, '..', 'out'))
mkdirSync(outDir, { recursive: true })

const PAGE = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }
const time = (fn, times) => {
  const started = performance.now()
  for (let i = 0; i < times; i++) fn()
  return (performance.now() - started) / times
}
const round = (value) => Math.round(value * 100) / 100

let server
try {
  server = await startDsh({ home, agentsHome, profile, port, outDir })
  const client = makeClient({ origin: server.origin, token: server.token })
  await client.connect()

  const page = await client.rpc('session', 'events', {
    address: { kind: 'session', sessionId }, ...PAGE,
  })
  const projections = await client.rpc('session', 'projections', { sessionId })
  const records = page.value?.records ?? []

  // 与 stream-server 实际发送的形状一致：{ type:'item', streamId, value }。
  // streamId 是字符串（stream-protocol.ts），header 是完整的 SessionWireHeader
  // （version/id/createdAt/isSeeded 都是必填），否则字节数会偏小。
  const message = {
    type: 'item',
    streamId: 'bench-1',
    value: {
      type: 'snapshot',
      header: { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false },
      cursor: page.value?.cursor ?? 0,
      records,
      hasMore: page.value?.hasMore === true,
      projections: projections.value,
    },
  }

  const text = JSON.stringify(message)
  const frameBytes = Buffer.byteLength(text, 'utf8')
  const stringifyMs = round(time(() => JSON.stringify(message), 5))
  const deflateMs = round(time(() => deflateSync(text, { level: 1 }), 3))
  const compressed = deflateSync(text, { level: 1 })
  const inflateMs = round(time(() => inflateSync(compressed), 3))

  console.log(JSON.stringify({
    sessionId,
    records: records.length,
    recordsBytes: Buffer.byteLength(JSON.stringify(records), 'utf8'),
    projectionBytes: Buffer.byteLength(JSON.stringify(projections.value ?? null), 'utf8'),
    frameBytes,
    compressedBytes: compressed.length,
    ratio: round(frameBytes / Math.max(1, compressed.length)),
    stringifyMs,
    deflateMs,
    inflateMs,
    encodeMs: round(stringifyMs + deflateMs),
    note: 'encodeMs 是服务端在「产出首帧之后」还要付的成本；inflateMs 是 Node 端代理值，浏览器可能更快',
  }, null, 2))
} finally {
  if (server !== undefined) await server.stop()
}
