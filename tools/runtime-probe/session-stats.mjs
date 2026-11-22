// 真实会话结构统计 + 同结构合成（内容替换为等长伪文本）。
//
//   node --max-old-space-size=8192 tools/runtime-probe/session-stats.mjs \
//     --home F:/dsh-rt/real-in/home --session session-<id> [--json]
//
//   # 生成同结构合成会话（不保留原始对话内容）
//   node --max-old-space-size=8192 tools/runtime-probe/session-stats.mjs \
//     --home F:/dsh-rt/real-in/home --session session-<id> \
//     --synth-out F:/dsh-rt/real-synth/home --synth-id session-real-1 --seed 42
//
// 统计只输出聚合数字，不打印事件文本；合成只保留事件类型/seq/turn/step/
// 工具配对/内容块结构，把所有正文替换成等长伪文本。

import { Buffer } from 'node:buffer'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { loadJsonlBackend } from './make-session.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const home = resolve(arg('home', ''))
const sessionId = arg('session', '')
if (home === '' || sessionId === '') {
  console.error('usage: session-stats.mjs --home <home> --session <id> [--synth-out <home> --synth-id <id>]')
  process.exit(2)
}
const synthOut = arg('synth-out', undefined)
const synthId = arg('synth-id', `session-real-${Date.now().toString(36)}`)
const seed = Number(arg('seed', '42'))
const jsonOutput = process.argv.includes('--json')

const percentile = (sorted, p) => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
const summaryOf = (values) => {
  if (values.length === 0) return { count: 0, p50: null, p90: null, p99: null, max: null, mean: null }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1),
    mean: +(sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(1),
  }
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
const PRESERVE_KEYS = new Set([
  'type', 'role', 'kind', 'provider', 'model', 'name', 'id', 'callId', 'toolCallId',
  'turn', 'step', 'seq', 'status', 'reason', 'version', 'arguments', 'cwd', 'path', 'surfaceOp', 'op',
  'policyKey', 'mode', 'catalog',
])
const CONTENT_KEYS = new Set([
  'text', 'content', 'message', 'title', 'summary', 'description', 'command', 'output',
  'stdout', 'stderr', 'error', 'prompt', 'instructions', 'reasoning', 'thought', 'diff', 'patch',
])

const makeRng = (initial) => {
  let state = initial >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 0x100000000
  }
}
const rng = makeRng(seed)
const ASCII_POOL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const CJK_POOL = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞'

const synthesizeString = (value) => {
  let result = ''
  for (const char of value) {
    if (CJK.test(char)) result += CJK_POOL[(rng() * CJK_POOL.length) | 0]
    else if (/[A-Za-z0-9]/.test(char)) result += ASCII_POOL[(rng() * ASCII_POOL.length) | 0]
    else result += char
  }
  return result
}

const argumentsMemo = new Map()
const sanitizeValue = (value, key) => {
  if (typeof value === 'string') {
    if (PRESERVE_KEYS.has(key) || /(?:Id|Ids|ID)$/.test(key)) return value
    // 只替换正文/长文本；短枚举、版本、policyKey、mode 等结构字符串保留，
    // 否则格式化校验（retry/policy、subagent catalog）会失败。
    if (CONTENT_KEYS.has(key) || value.length > 256) return synthesizeString(value)
    return value
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key))
  if (value !== null && typeof value === 'object') {
    // PTC dispatch-start 与 dispatch 的 arguments 必须一致；对相同 arguments
    // 用同一份合成结果，避免各自随机化后配对校验失败。
    let cacheKey
    if (key === 'arguments') {
      try { cacheKey = JSON.stringify(value) } catch { /* 循环引用等，跳过缓存 */ }
      if (cacheKey !== undefined && argumentsMemo.has(cacheKey)) return argumentsMemo.get(cacheKey)
    }
    const result = {}
    for (const [childKey, child] of Object.entries(value)) {
      result[childKey] = sanitizeValue(child, childKey)
    }
    if (cacheKey !== undefined) argumentsMemo.set(cacheKey, result)
    return result
  }
  return value
}

const walkGraph = (value, counters) => {
  if (typeof value === 'string') {
    counters.strings += 1
    counters.stringBytes += Buffer.byteLength(value, 'utf8')
    counters.stringChars += value.length
    for (const char of value) if (CJK.test(char)) counters.cjkChars += 1
    return
  }
  if (Array.isArray(value)) {
    counters.arrays += 1
    for (const item of value) walkGraph(item, counters)
    return
  }
  if (value !== null && typeof value === 'object') {
    counters.objects += 1
    for (const child of Object.values(value)) walkGraph(child, counters)
  }
}

const readEvents = async (service, id) => {
  const handle = await service.open(id, 'read')
  try {
    const result = await handle.read(0, undefined)
    const all = Array.isArray(result?.events) ? result.events : []
    const hasMarker = all.length > 0 && all[all.length - 1].type === 'session/end-seed'
    return { events: hasMarker ? all.slice(0, -1) : all, trailingEndSeed: hasMarker }
  } finally {
    try { await handle.close?.() } catch { /* best effort */ }
  }
}

const statsFor = (events, trailingEndSeed) => {
  const eventTypes = new Map()
  const typeJson = new Map()
  const typeStrings = new Map()
  const jsonBytes = []
  const textBytes = []
  let textChars = 0
  let cjkChars = 0
  let objects = 0
  let arrays = 0
  let strings = 0
  const nodesPerEvent = []
  let toolCalls = 0
  let toolResults = 0
  const toolResultBytes = []
  const contentBlocks = new Map()
  const surfaceOps = new Map()
  let turns = 0
  const eventsPerTurn = []
  let currentTurn = 0

  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
    jsonBytes.push(size)
    const type = event.type ?? '<none>'
    const typeRecord = eventTypes.get(type) ?? { count: 0, jsonBytes: 0 }
    typeRecord.count += 1
    typeRecord.jsonBytes += size
    eventTypes.set(type, typeRecord)
    const jsonList = typeJson.get(type)
    if (jsonList === undefined) typeJson.set(type, [size])
    else jsonList.push(size)
    if (event.surfaceOp !== undefined) surfaceOps.set(event.surfaceOp, (surfaceOps.get(event.surfaceOp) ?? 0) + 1)
    if (type === 'tool/call') toolCalls += 1
    if (type === 'tool/result') { toolResults += 1; toolResultBytes.push(size) }
    if (type === 'turn/start') {
      if (currentTurn > 0) eventsPerTurn.push(currentTurn)
      currentTurn = 0
      turns += 1
    }
    currentTurn += 1
    const content = event.data?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const blockType = block?.type ?? '<none>'
        contentBlocks.set(blockType, (contentBlocks.get(blockType) ?? 0) + 1)
      }
    }
    let eventTextBytes = 0
    const counters = { strings: 0, stringBytes: 0, stringChars: 0, cjkChars: 0, objects: 0, arrays: 0 }
    walkGraph(event, counters)
    eventTextBytes += counters.stringBytes
    textChars += counters.stringChars
    cjkChars += counters.cjkChars
    objects += counters.objects
    arrays += counters.arrays
    strings += counters.strings
    const stringList = typeStrings.get(type)
    if (stringList === undefined) typeStrings.set(type, [counters.strings])
    else stringList.push(counters.strings)
    nodesPerEvent.push(counters.objects + counters.arrays)
    textBytes.push(eventTextBytes)
  }
  if (currentTurn > 0) eventsPerTurn.push(currentTurn)

  return {
    events: events.length,
    turns,
    eventsPerTurn: summaryOf(eventsPerTurn),
    jsonBytesTotal: jsonBytes.reduce((sum, value) => sum + value, 0),
    jsonBytesPerEvent: summaryOf(jsonBytes),
    textBytesTotal: textBytes.reduce((sum, value) => sum + value, 0),
    textBytesPerEvent: summaryOf(textBytes),
    nodesPerEvent: summaryOf(nodesPerEvent),
    objectCount: objects,
    arrayCount: arrays,
    stringCount: strings,
    objectsPerEvent: +(objects / Math.max(1, events.length)).toFixed(2),
    arraysPerEvent: +(arrays / Math.max(1, events.length)).toFixed(2),
    stringsPerEvent: +(strings / Math.max(1, events.length)).toFixed(2),
    cjkRatio: textChars === 0 ? null : +(cjkChars / textChars).toFixed(4),
    eventTypes: [...eventTypes.entries()].sort((a, b) => b[1].jsonBytes - a[1].jsonBytes),
    typeStats: [...eventTypes.entries()].sort((a, b) => b[1].jsonBytes - a[1].jsonBytes).map(([type, record]) => ({
      type,
      count: record.count,
      jsonBytes: record.jsonBytes,
      share: +(record.count / Math.max(1, events.length)).toFixed(4),
      json: summaryOf(typeJson.get(type) ?? []),
      strings: summaryOf(typeStrings.get(type) ?? []),
    })),
    contentBlocks: [...contentBlocks.entries()].sort((a, b) => b[1] - a[1]),
    surfaceOps: [...surfaceOps.entries()].sort((a, b) => b[1] - a[1]),
    toolCalls,
    toolResults,
    toolResultBytes: summaryOf(toolResultBytes),
    trailingEndSeed,
  }
}

const { ctx, service } = await loadJsonlBackend(join(home, 'sessions'))
try {
  const stored = await service.stat?.(sessionId)
  const { events, trailingEndSeed } = await readEvents(service, sessionId)
  const stats = { sessionId, ...statsFor(events, trailingEndSeed) }
  if (jsonOutput) console.log(JSON.stringify(stats, null, 2))
  else {
    console.log(`session: ${sessionId}`)
    console.log(`events=${stats.events} turns=${stats.turns} events/turn p50=${stats.eventsPerTurn.p50} p99=${stats.eventsPerTurn.p99}`)
    console.log(`JSON B/event p50=${stats.jsonBytesPerEvent.p50} p90=${stats.jsonBytesPerEvent.p90} p99=${stats.jsonBytesPerEvent.p99} max=${stats.jsonBytesPerEvent.max}`)
    console.log(`text B/event p50=${stats.textBytesPerEvent.p50} p90=${stats.textBytesPerEvent.p90} p99=${stats.textBytesPerEvent.p99}`)
    console.log(`cjkRatio=${stats.cjkRatio} toolCalls=${stats.toolCalls} toolResults=${stats.toolResults} toolResultB p50=${stats.toolResultBytes.p50} p99=${stats.toolResultBytes.p99}`)
    console.log('eventTypes:', stats.eventTypes.map(([type, record]) => `${type}=${record.count}`).join(' '))
    console.log('contentBlocks:', stats.contentBlocks.map(([type, count]) => `${type}=${count}`).join(' '))
    console.log('surfaceOps:', stats.surfaceOps.map(([op, count]) => `${op}=${count}`).join(' '))
  }

  if (synthOut !== undefined) {
    if (events.length === 0) throw new Error('session has no events')
    if (events.some((event, index) => event.seq !== index)) throw new Error('session event seq is not contiguous from 0')
    const isSeeded = stored?.header?.isSeeded === true
    let inheritedEventCount = 0
    if (isSeeded) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'session/end-seed' && events[i]?.data?.inherited === true) {
          inheritedEventCount = i
          break
        }
      }
      if (inheritedEventCount === 0) throw new Error('seeded session has no inherited end-seed marker')
    }
    const sanitized = events.map((event) => sanitizeValue(event, ''))
    const sessionMod = await import('@deepseek-ai/dsh-session')
    const { Session, SESSION_FORMAT_VERSION } = sessionMod
    const header = {
      ...(stored?.header ?? {}),
      version: SESSION_FORMAT_VERSION,
      id: synthId,
      createdAt: Date.now(),
      cwd: 'F:\\dsh-rt\\probe-workspace',
      isSeeded,
      delegationDepth: stored?.header?.delegationDepth ?? 0,
    }
    const session = Session.create(synthId, sanitized, header, inheritedEventCount)
    const synthSessionsRoot = join(synthOut, 'sessions')
    mkdirSync(synthSessionsRoot, { recursive: true })
    const synthBackend = await loadJsonlBackend(synthSessionsRoot)
    try {
      const handle = await synthBackend.service.create(session.header, { inheritedEventCount })
      await handle.append(session.snapshotEvents())
      await handle.close()
      const result = await synthBackend.service.stat?.(synthId)
      console.log(JSON.stringify({ synthId, synthEvents: sanitized.length, isSeeded, inheritedEventCount, path: result?.location?.path ?? null }))
    } finally {
      try { await synthBackend.ctx.stop?.() } catch { /* best effort */ }
    }
  }
} finally {
  try { await ctx.stop?.() } catch { /* best effort */ }
}
