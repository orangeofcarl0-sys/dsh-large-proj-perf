// 对照一个已有会话的「JSON 字节 / 事件」与内容感知估算。
//
//   node --max-old-space-size=8192 tools/runtime-probe/event-bytes.mjs \
//     --home F:/dsh-rt/<stamp>/home --session session-mem-probe-91k-1
//
// 输出用于校准 lib/constants.js 的 HEAP_OVERHEAD_RATIO：
//   JSON 均值 × ratio 应接近 mem-open 实测的“稳态堆增量 ÷ 新增事件数”。

import { Buffer } from 'node:buffer'
import { resolve, join } from 'node:path'

import { loadJsonlBackend } from './make-session.mjs'
import { BYTES_PER_EVENT, EVENT_SAMPLE_COUNT, HEAP_OVERHEAD_RATIO } from '../../lib/constants.js'
import { bytesPerEvent, estimateEntryBytes } from '../../lib/event-bytes.js'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const home = resolve(arg('home', ''))
const sessionId = arg('session', '')
if (home === '' || sessionId === '') {
  console.error('usage: event-bytes.mjs --home <isolated home> --session <id>')
  process.exit(2)
}

const { ctx, service } = await loadJsonlBackend(join(home, 'sessions'))
try {
  const handle = await service.open(sessionId, 'read')
  try {
    const result = await handle.read(0, undefined)
    const all = Array.isArray(result?.events) ? result.events : []
    const hasMarker = all.length > 0 && all[all.length - 1].type === 'session/end-seed'
    const events = hasMarker ? all.slice(0, -1) : all

    let jsonBytes = 0
    for (const event of events) {
      try { jsonBytes += Buffer.byteLength(JSON.stringify(event), 'utf8') } catch { /* 单个事件不可序列化，跳过 */ }
    }
    const perEvent = bytesPerEvent(events)
    const entryBytes = estimateEntryBytes({ events })
    const output = {
      sessionId,
      events: events.length,
      trailingEndSeed: hasMarker,
      jsonBytes,
      jsonBytesPerEvent: events.length === 0 ? null : +(jsonBytes / events.length).toFixed(1),
      estimate: {
        sampleCount: EVENT_SAMPLE_COUNT,
        bytesPerEvent: BYTES_PER_EVENT,
        ratio: HEAP_OVERHEAD_RATIO,
        bytesPerEventEstimate: perEvent,
        entryBytes,
        ratioToJson: jsonBytes === 0 ? null : +(entryBytes / jsonBytes).toFixed(3),
      },
      note: '对比 mem-open 的 cache.actualBytesPerEvent：两者应接近（±25%）',
    }
    console.log(JSON.stringify(output, null, 2))
  } finally {
    try { await handle.close?.() } catch { /* best effort */ }
  }
} finally {
  await ctx.stop?.()
}
