// 内容感知的事件字节估算。
//
// 旧实现按 `events.length × 400 B` 估算；400 B 来自 24 万事件 / 87.7 MB 的
// 小消息会话，对 4 KB 消息的会话会低估约 3.4 倍（实测约 1.37 KB/事件），
// 导致 512 MiB 预算永远不触发。这里改成按内容采样：
//   - 先扫一遍事件类型计数（只读 type，不 stringify）；
//   - 按类型分层：小类型（≤1024 个）全量 stringify，精确计费；
//   - 大类型每种最多采样 64 个（首/尾/等距），避免长尾异常值主导；
//   - 单事件大小用 JSON 字节数 × HEAP_OVERHEAD_RATIO，再按类型计数加权；
//   - 结果不低于 BYTES_PER_EVENT（小消息会话仍走老的保守下限）。
//
// 为什么按类型分层而不是固定 8 事件块：真实会话的 events/turn 从几十到上千，
// 大消息/tool result 在事件流里稀疏出现；固定块会把估算锁在局部相位上。
// 实测同一批真实结构会话，固定块估算相对实际堆误差 -80% ~ -14%；分层 +
// 小类型精确计费 + 字符串 header 后收敛到 -18% ~ +14%。
//
// 估算结果按 events 数组引用缓存：observation cache 与 coldLogMemo 可能共享
// 同一个 frozen 数组，WeakMap 让两条链路只算一次。

import { Buffer } from 'node:buffer'

import { BYTES_PER_EVENT, EVENT_SAMPLE_COUNT, HEAP_OVERHEAD_RATIO, STRING_OVERHEAD_BYTES } from './constants.js'

const perEventCache = new WeakMap()
const EXACT_TYPE_LIMIT = 1024

const countStrings = (value, counter, seen = new WeakSet()) => {
  if (typeof value === 'string') { counter.strings += 1; return }
  if (Array.isArray(value)) {
    if (seen.has(value)) return
    seen.add(value)
    for (const item of value) countStrings(item, counter, seen)
    return
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return
    seen.add(value)
    for (const child of Object.values(value)) countStrings(child, counter, seen)
  }
}

const measureEvent = (event) => {
  let jsonBytes = 0
  try { jsonBytes = Buffer.byteLength(JSON.stringify(event), 'utf8') } catch { jsonBytes = 0 }
  const counter = { strings: 0 }
  countStrings(event, counter)
  return { jsonBytes, strings: counter.strings }
}

/** 单个事件数组的平均堆字节估算（含 BYTES_PER_EVENT 下限）。 */
export function bytesPerEvent(events) {
  if (!Array.isArray(events) || events.length === 0) return 0
  const cached = perEventCache.get(events)
  if (cached !== undefined) return cached

  const total = events.length
  const indicesByType = new Map()
  for (let i = 0; i < total; i++) {
    const type = typeof events[i]?.type === 'string' ? events[i].type : ''
    const list = indicesByType.get(type)
    if (list === undefined) indicesByType.set(type, [i])
    else list.push(i)
  }

  let estimatedTotal = 0
  for (const indices of indicesByType.values()) {
    const count = indices.length
    const budget = Math.min(EVENT_SAMPLE_COUNT, count)
    const picked = count <= EXACT_TYPE_LIMIT
      ? indices
      : budget === 1
        ? [indices[Math.floor((count - 1) / 2)]]
        : Array.from({ length: budget }, (_, k) => indices[Math.floor((k * (count - 1)) / (budget - 1))])
    let jsonBytes = 0
    let strings = 0
    for (const index of picked) {
      const measured = measureEvent(events[index])
      jsonBytes += measured.jsonBytes
      strings += measured.strings
    }
    const divisor = Math.max(1, picked.length)
    const averageJson = jsonBytes / divisor
    const averageStrings = strings / divisor
    estimatedTotal += count * (averageJson * HEAP_OVERHEAD_RATIO + averageStrings * STRING_OVERHEAD_BYTES)
  }

  const estimate = Math.max(BYTES_PER_EVENT, Math.round(estimatedTotal / total))
  perEventCache.set(events, estimate)
  return estimate
}

/** 一个缓存条目（`{ events }`）的估算字节数。 */
export function estimateEntryBytes(entry) {
  const events = entry?.events
  const count = events?.length ?? 0
  return count === 0 ? 0 : count * bytesPerEvent(events)
}
