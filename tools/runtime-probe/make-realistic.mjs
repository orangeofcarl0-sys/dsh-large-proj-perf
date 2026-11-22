// 按真实语料的中值行为生成“类真”长会话。
//
//   node --max-old-space-size=8192 tools/runtime-probe/make-realistic.mjs \
//     --home F:/dsh-rt/<stamp>/home --id session-realmed-1 --turns 230 --seed 42
//
// 参数来自 real-profile.json（默认同目录）：真实 16 个会话（events>=100）的
// 中值 events/turn、tool 调用/大小分布、JSON/事件、字符串数、CJK 比例。
// 生成的事件仍是合成文本，但结构/大小分布/tool 配对贴近真实对话；不是复制
// 某一个真实会话。
//
// 目标（默认 230 turn）：约 25k 事件、tool/result 与 tool/call 各约 5k、
// assistant/message 约 5k、JSON 2.1KB/事件量级。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeSessionEvents } from './make-session.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const home = resolve(arg('home', ''))
if (home === '') { console.error('--home is required'); process.exit(2) }
const id = arg('id', `session-realmed-${Date.now().toString(36)}`)
const turns = Number(arg('turns', '230'))
const seed = Number(arg('seed', '42'))
const cwd = arg('cwd', 'F:\\dsh-rt\\probe-workspace')
const profilePath = resolve(arg('profile', join(here, 'real-profile.json')))
const profile = JSON.parse(readFileSync(profilePath, 'utf8'))

const makeRng = (initial) => {
  let state = (initial >>> 0) || 0x9e3779b9
  return () => {
    state += 0x6D2B79F5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = makeRng(seed)
let spare = null
const gaussian = () => {
  if (spare !== null) { const value = spare; spare = null; return value }
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  const mag = Math.sqrt(-2 * Math.log(u))
  spare = mag * Math.sin(2 * Math.PI * v)
  return mag * Math.cos(2 * Math.PI * v)
}
const lognormal = ({ median, sigma }, min = 1) => Math.max(min, Math.round(median * Math.exp((sigma ?? 0) * gaussian())))
const pick = (rate) => rng() < rate

const cjkRate = profile.rates.cjk ?? 0
const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789  \n.,:;-_/()[]{}'
const CJK = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞'
const makeText = (bytes) => {
  if (bytes <= 0) return ''
  const chars = Math.max(1, Math.round(bytes / (1 + 2 * cjkRate)))
  let out = ''
  for (let i = 0; i < chars; i++) out += (pick(cjkRate) ? CJK[(rng() * CJK.length) | 0] : ASCII[(rng() * ASCII.length) | 0])
  return out
}

const timeBase = Date.now()
let seq = 0
let turnNo = 0
const events = []
const push = (type, data, extra) => {
  events.push({ type, seq: seq++, time: timeBase + seq, data, ...(extra ?? {}) })
  return seq - 1
}
const jsonSize = (event) => Buffer.byteLength(JSON.stringify(event), 'utf8')

const fit = (build, target) => {
  let length = Math.max(0, Math.round(target * 0.55))
  let event = build(length)
  const delta = target - jsonSize(event)
  if (Math.abs(delta) > 16) {
    length = Math.max(0, length + delta)
    event = build(length)
  }
  return event
}

const route = { provider: 'probe-provider', model: 'probe-model' }
const makeCalls = () => {
  if (pick(profile.toolCallsPerStep.zeroRate ?? 0)) return 0
  if (pick(profile.toolCallsPerStep.twoRate ?? 0)) return 2
  if (pick(profile.toolCallsPerStep.threeRate ?? 0)) return 3
  return 1
}

const makeRequestHeader = () => {
  const tools = Array.from({ length: 24 }, (_, i) => ({
    type: 'function',
    function: {
      name: `probe_tool_${i}`,
      description: makeText(200),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 4 }, (_, j) => [`arg_${i}_${j}`, { type: 'string', description: makeText(70) }])),
        required: ['arg_0'],
      },
    },
  }))
  return {
    type: 'request/header',
    data: {
      header: { config: { ...route, maxTokens: 128000 }, tools },
      reason: 'initial',
    },
  }
}

const makeAssistant = (turn, step, calls, streamChunks) => {
  const targetJson = lognormal(profile.sizes.assistantJson)
  const build = (textBytes) => {
    const content = [{ type: 'text', text: makeText(textBytes) }]
    if (pick(profile.rates.reasoningBlock ?? 0)) content.push({ type: 'reasoning', text: makeText(Math.max(40, textBytes * 0.2)) })
    for (const call of calls) {
      content.push({ type: 'tool-call', id: call.callId, name: call.name, arguments: call.arguments })
    }
    const streamCount = Math.max(2, Math.min(48, Math.round(targetJson / 450), streamChunks))
    const partsPerChunk = Math.max(0, Math.min(20, Math.round(targetJson / 300)))
    return {
      type: 'assistant/message',
      data: {
        turn,
        step,
        message: {
          role: 'assistant',
          id: `probe-assistant-${turn}-${step}`,
          source: { kind: 'model', ...route },
          content,
        },
        // 真实 assistant stream 里有大量小文本片段；用 parts 数组表示同一 chunk
        // 的多个 fragment，保持“字符串多、对象节点少”的真实结构。
        stream: Array.from({ length: streamCount }, (_, i) => ({
          type: 'text',
          time: timeBase + seq + i,
          chunk: {
            type: 'text',
            text: makeText(18 + ((rng() * 18) | 0)),
            parts: Array.from({ length: partsPerChunk }, () => makeText(6 + ((rng() * 10) | 0))),
          },
        })),
      },
      surfaceOp: 'append',
    }
  }
  return fit(build, targetJson)
}

const makeToolResult = (turn, step, call) => {
  const targetJson = lognormal(profile.sizes.toolResultJson)
  const build = (textBytes) => ({
    type: 'tool/result',
    data: {
      turn,
      step,
      message: {
        role: 'tool',
        id: `probe-tool-${call.callId}`,
        source: { kind: 'tool', callId: call.callId },
        toolCallId: call.callId,
        content: [{ type: 'text', text: makeText(textBytes) }],
      },
    },
    sourceEventSeqs: [call.callSeq],
    surfaceOp: 'append',
  })
  return fit(build, targetJson)
}

const startedAt = Date.now()
for (let turn = 1; turn <= turns; turn++) {
  push('turn/start', { turn })
  const steps = lognormal(profile.stepsPerTurn, 1)
  const boundedSteps = Math.min(profile.stepsPerTurn.max ?? 80, steps)
  for (let step = 1; step <= boundedSteps; step++) {
    push('step/start', { turn, step })
    if (step === 1) {
      const user = fit((textBytes) => ({
        type: 'user/message',
        data: { content: [{ type: 'text', text: makeText(textBytes) }], source: { kind: 'user' }, role: 'user', id: `probe-user-${turn}` },
        surfaceOp: 'append',
      }), lognormal(profile.sizes.userJson))
      push(user.type, user.data, { surfaceOp: user.surfaceOp })
      if (pick(profile.rates.requestHeaderPerTurn ?? 0)) {
        const header = makeRequestHeader()
        push(header.type, header.data)
      }
      if (pick(profile.rates.requestContextPerTurn ?? 0)) {
        push('request/context', { ...route, contextWindow: 1000000 })
      }
    }
    const callCount = makeCalls()
    const calls = Array.from({ length: callCount }, (_, i) => {
      const callId = `probe-call-${turn}-${step}-${i}`
      const targetJson = lognormal(profile.sizes.toolCallJson)
      const event = fit((textBytes) => ({
        type: 'tool/call',
        data: {
          turn,
          step,
          callId,
          name: i === 0 ? 'bash' : (pick(0.5) ? 'read' : 'apply_patch'),
          arguments: JSON.stringify({ command: makeText(textBytes), description: 'probe tool call' }),
        },
      }), targetJson)
      return { callId, name: event.data.name, arguments: event.data.arguments, callSeq: -1 }
    })
    const streamChunks = lognormal(profile.sizes.assistantStreamChunks, 0)
    const assistant = makeAssistant(turn, step, calls, streamChunks)
    push(assistant.type, assistant.data, { surfaceOp: assistant.surfaceOp })
    for (const call of calls) {
      call.callSeq = push('tool/call', { turn, step, callId: call.callId, name: call.name, arguments: call.arguments })
      const result = makeToolResult(turn, step, call)
      push(result.type, result.data, { sourceEventSeqs: result.sourceEventSeqs, surfaceOp: result.surfaceOp })
    }
    push('step/end', { turn, step })
  }
  push('turn/end', { turn, reason: { kind: 'completed' } })
}

const result = await writeSessionEvents({ sessionsRoot: join(home, 'sessions'), id, events, cwd, verify: true })
console.log(JSON.stringify({
  id: result.id,
  turns,
  events: result.events,
  toolCalls: events.filter((event) => event.type === 'tool/call').length,
  assistantMessages: events.filter((event) => event.type === 'assistant/message').length,
  profile: profilePath,
  seed,
  verify: result.verified,
  path: result.path,
  generationMs: Date.now() - startedAt,
}, null, 2))
