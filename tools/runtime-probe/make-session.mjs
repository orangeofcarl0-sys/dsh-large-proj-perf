// 用**真实实现类**生成一个 v4 长会话，写进隔离 home 的 sessions 根。
//
// 三种内容档位，对应两类测量轴：
//
//   plain     —— 每 turn 8 事件、单行随机文本。turn 数决定投影大小
//                （30 000 turn 的 turnOutline ≈ 6.7 MB），消息体很小。
//   markdown  —— 同样 8 事件/turn，但文本是真实 markdown：标题、列表、表格、
//                围栏代码、行内/块级公式、CJK、长不可断行。用来测解析与高亮，
//                不新增事件类型，校验风险为零。
//   tools     —— 每 turn 追加 1–3 个工具调用（assistant/message 的 tool-call
//                内容块 → tool/call → tool/result），输出是 bash 日志/文件读/
//                unified diff。工具输出占真实编码 agent 日志的 60–80%，
//                这是「消息体很小」这条缺口的正解。
//
// 做法与 tests/e2e_real_components.mjs 同源：真实 SessionStore + 真实
// JsonlSessionPersistence（经 cordis Context.plugin 装载），因此产出的
// header/事件信封/多帧 zstd 都与 dsh 自己写下的一致。
//
// **读回自检**：`verify` 打开时用真实后端重新读出，断言事件数、turn 数、
// 工具调用配对。校验规则比构造器更严（见 buildTurnEvents 注释），自检失败
// 就不返回路径，CLI 非零退出——避免拿一个不合法的会话去测出假数字。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 随机源：可播种，保证同一 seed 产出同一会话 ----

function makeRng(seed) {
  let state = (seed >>> 0) || 0x9e3779b9
  return function next() {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 0x100000000
  }
}

// 伪随机文本：真实会话的压缩比约 2.6MB zstd / 9.2MB 解压（≈3.5×），
// 而重复度高的填充串会被压到 0.5% 以下，测不出分片收益。这里按码点均匀
// 取样，压缩比接近真实内容。
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;-_/\\()[]{}'

let nextRand = makeRng(0x9e3779b9)
function text(len) {
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[(nextRand() * ALPHABET.length) | 0]
  return s
}

// ---- markdown 内容 ----

const CODE_TS = [
  '```ts',
  'export function fold(state: OutlineState, event: SessionEvent): OutlineState {',
  '  switch (event.type) {',
  '    case "turn/start": {',
  '      const next = { turn: event.data.turn, prompt: "", response: "" }',
  '      return { ...state, turns: [...state.turns, next] }',
  '    }',
  '    case "user/message":',
  '      return state',
  '    default:',
  '      return state',
  '  }',
  '}',
  '```',
  '',
].join('\n')

const CODE_PY = [
  '```python',
  'def fold(state, event):',
  '    if event["type"] == "turn/start":',
  '        return {**state, "turns": [*state["turns"], {"turn": event["data"]["turn"]}]}',
  '    return state',
  '```',
  '',
].join('\n')

const TABLE = [
  '| 指标 | 优化前 | 优化后 |',
  '|---|---:|---:|',
  '| 冷读 | 21.2 s | 3.0 s |',
  '| 稳态 RSS | 1324 MB | 690 MB |',
  '',
].join('\n')

const MATH = [
  '行内公式 $E = mc^2$ 与 $\\alpha + \\beta$ 都要渲染。',
  '',
  '$$',
  '\\sum_{i=1}^{n} \\frac{x_i}{1 + x_i^2} + \\int_0^1 f(t)\\,dt',
  '$$',
  '',
].join('\n')

const PROSE = [
  '### 结论',
  '',
  '1. 先确认 `Session.append` 的冻结时机；',
  '2. 再看投影折叠的顺序；',
  '3. 最后才谈缓存。',
  '',
  '中文段落用于测试 CJK 断行、字形回退与标点挤压。标点：，。；：「」（）——……',
  '',
].join('\n')

function markdownText(target, rng) {
  const blocks = [CODE_TS, CODE_PY, TABLE, MATH, PROSE]
  const parts = []
  let length = 0
  let index = 0
  while (length < target) {
    const block = blocks[(index + Math.floor(rng() * blocks.length)) % blocks.length]
    parts.push(block)
    length += block.length
    index += 1
  }
  // 长不可断行：真实日志里常见的 minified 内容与 base64。
  if (target > 1200) parts.push('\n' + text(Math.min(800, Math.round(target / 4))) + '\n')
  return parts.join('')
}

// ---- 工具输出 ----

function bashOutput(target, rng) {
  const lines = []
  let length = 0
  let i = 0
  while (length < target) {
    const ms = 3 + ((rng() * 400) | 0)
    const line = `[${String(((rng() * 24) | 0)).padStart(2, '0')}:${String(((rng() * 60) | 0)).padStart(2, '0')}:${String(((rng() * 60) | 0)).padStart(2, '0')}] ${rng() < 0.25 ? 'FAIL' : 'PASS'} src/module-${i}.test.ts (${ms} ms)`
    lines.push(line)
    length += line.length + 1
    i += 1
  }
  return lines.join('\n')
}

function readOutput(target, rng) {
  const lines = []
  let length = 0
  let line = 1
  while (length < target) {
    const body = `export function handler${line}(input: Input): Output { return { ok: true, id: ${line}, label: "${text(24)}" } }`
    const rendered = `${String(line).padStart(5, ' ')} | ${body}`
    lines.push(rendered)
    length += rendered.length + 1
    line += 1
  }
  return lines.join('\n')
}

function patchOutput(target, rng) {
  const lines = ['--- a/src/module.ts', '+++ b/src/module.ts', '@@ -1,6 +1,9 @@']
  let length = lines.join('\n').length
  let i = 0
  while (length < target) {
    const added = `+  const value${i} = compute(${i}, "${text(16)}")`
    const removed = `-  const old${i} = legacy(${i})`
    lines.push(added)
    length += added.length + 1
    if (rng() < 0.6) {
      lines.push(removed)
      length += removed.length + 1
    }
    i += 1
  }
  return lines.join('\n')
}

function toolOutput(name, target, rng) {
  if (name === 'bash') return bashOutput(target, rng)
  if (name === 'read') return readOutput(target, rng)
  return patchOutput(target, rng)
}

// ---- 事件构造 ----

/**
 * 合法事件流：一个「真实 turn 骨架」的循环。
 *
 * 0.2.2 的读回校验比构造器更严（`assertCurrentLlmShape` / `assertMessageEventShape`
 * / jsonl worker 的工具生命周期核对）：
 *   - 未知事件类型被拒；
 *   - request/header 必须带 provider/model 与合法 reason，空 tools /
 *     空 adapterDefaults 必须省略而不能是空容器；
 *   - assistant/message 必须 role=assistant + source.kind=model + provider/model，
 *     且必须有 turn/step/stream 结算字段；
 *   - **工具生命周期由 `assistant/message` 的 `tool-call` 内容块声明**（不是
 *     `request/header.tools`）：`tool/call` 的 callId/name/arguments 必须与之一致，
 *     `tool/result.message.source.callId === toolCallId`，且三者在同一个打开 step 内，
 *     `step/end` 前必须全部 resolve。
 *
 * @param n - plain 档位的事件数上限
 * @param options - 内容档位与随机种子
 */
export function buildEvents(n, { pad = 160, profile = 'plain', seed } = {}) {
  if (seed !== undefined) nextRand = makeRng(seed)
  const ev = []
  let seq = 0
  let turn = 0
  const push = (type, data, extra) => {
    ev.push({ type, seq: seq++, time: 1_700_000_000_000 + seq, data, ...(extra ?? {}) })
  }
  while (ev.length < n) {
    turn += 1
    const p = text(pad)
    const route = { provider: 'probe-provider', model: 'probe-model' }

    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('user/message', {
      content: [{ type: 'text', text: p }],
      source: { kind: 'user' },
      role: 'user',
      id: `probe-user-${turn}`,
    }, { surfaceOp: 'append' })
    push('request/header', {
      header: { config: { ...route, maxTokens: 128000 } },
      reason: 'initial',
    })
    push('request/context', { ...route, contextWindow: 1000000 })
    push('assistant/message', {
      turn,
      step: 1,
      stream: [],
      message: {
        role: 'assistant',
        id: `probe-assistant-${turn}`,
        source: { kind: 'model', ...route },
        content: [{ type: 'text', text: p }],
      },
    }, { surfaceOp: 'append' })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return ev.slice(0, n)
}

/**
 * 按 **turn 数** 构造，供 markdown / tools 档位使用。
 *
 * @param turnCount - turn 数（直接决定 turnOutline 投影大小）
 * @param options - profile: 'plain' | 'markdown' | 'tools'
 * @returns { events, turns, toolCalls }
 */
export function buildTurnEvents(turnCount, { profile = 'markdown', pad = 160, toolBytes = 12000, seed = 0x9e3779b9 } = {}) {
  const rng = makeRng(seed)
  const ev = []
  let seq = 0
  let toolCalls = 0
  const push = (type, data, extra) => {
    ev.push({ type, seq: seq++, time: 1_700_000_000_000 + seq, data, ...(extra ?? {}) })
  }
  const route = { provider: 'probe-provider', model: 'probe-model' }
  const contentOf = (target) => (profile === 'plain' ? text(target) : markdownText(target, rng))

  for (let turn = 1; turn <= turnCount; turn++) {
    const prompt = contentOf(Math.max(120, Math.round(pad / 2)))
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('user/message', {
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
      role: 'user',
      id: `probe-user-${turn}`,
    }, { surfaceOp: 'append' })
    push('request/header', {
      header: { config: { ...route, maxTokens: 128000 } },
      reason: 'initial',
    })
    push('request/context', { ...route, contextWindow: 1000000 })

    const content = [{ type: 'text', text: contentOf(pad) }]
    const planned = []
    if (profile === 'tools') {
      const count = 1 + ((rng() * 3) | 0)
      for (let i = 0; i < count; i++) {
        const name = i === 0 ? 'bash' : (rng() < 0.5 ? 'read' : 'apply_patch')
        const args = JSON.stringify(
          name === 'bash'
            ? { command: `npm test -- --grep "case-${turn}-${i}"` }
            : { path: `src/module-${turn}.ts` },
        )
        const callId = `probe-call-${turn}-${i}`
        content.push({ type: 'tool-call', id: callId, name, arguments: args })
        const size = Math.max(1000, Math.min(60000, Math.round(toolBytes * (0.5 + rng()))))
        planned.push({ callId, name, args, size })
      }
    }
    push('assistant/message', {
      turn,
      step: 1,
      stream: [],
      message: {
        role: 'assistant',
        id: `probe-assistant-${turn}`,
        source: { kind: 'model', ...route },
        content,
      },
    }, { surfaceOp: 'append' })

    for (const call of planned) {
      push('tool/call', { turn, step: 1, callId: call.callId, name: call.name, arguments: call.args })
      push('tool/result', {
        turn,
        step: 1,
        message: {
          role: 'tool',
          id: `probe-tool-${turn}-${call.callId}`,
          source: { kind: 'tool', callId: call.callId },
          toolCallId: call.callId,
          content: [{ type: 'text', text: toolOutput(call.name, call.size, rng) }],
        },
      }, { surfaceOp: 'append' })
      toolCalls += 1
    }

    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { events: ev, turns: turnCount, toolCalls }
}

// 旧构造器（0.2.2 已不认 `usage`）已删除；只保留真实会话形状的 buildTurnEvents。

// 装载真实 jsonl 后端（0.2.1+ 只导出 cordis 插件，必须经 Context.plugin）。
async function loadJsonlBackend(root) {
  const { Context } = await import('@deepseek-ai/cordis')
  const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const ctx = new Context()
  ctx.plugin({ name: 'probe-jsonl', apply: (c, cfg) => jsonl.apply(c, cfg) }, { root, compression: 'zstd' })
  for (let i = 0; i < 150; i++) {
    const svc = ctx.get('sessionPersistence')
    if (svc !== undefined) return { ctx, service: svc }
    await sleep(20)
  }
  throw new Error('real jsonl backend did not register sessionPersistence')
}

/** 读回自检：用真实后端重新打开并核对结构。失败抛错，由调用方决定是否落盘。 */
async function verifySession(service, id, expected) {
  const handle = await service.open(id, 'read')
  try {
    const result = await handle.read(0, undefined)
    const all = Array.isArray(result?.events) ? result.events : []
    // 后端在 close 时会给会话补一个 `session/end-seed` 收尾标记（非 seed 会话也有），
    // 所以允许恰好一个尾部标记；其余数量必须逐一对上。
    const hasMarker = all.length === expected.events + 1 && all[all.length - 1].type === 'session/end-seed'
    const events = hasMarker ? all.slice(0, expected.events) : all
    if (events.length !== expected.events) {
      const tail = all.slice(-4).map((event) => event.type).join(',')
      throw new Error(`read-back event count ${all.length} != ${expected.events} (+end-seed) (tail: ${tail})`)
    }
    let turns = 0
    let calls = 0
    let results = 0
    for (const event of events) {
      if (event.type === 'turn/start') turns += 1
      else if (event.type === 'tool/call') calls += 1
      else if (event.type === 'tool/result') results += 1
    }
    if (expected.turns !== undefined && turns !== expected.turns) {
      throw new Error(`read-back turn count ${turns} != ${expected.turns}`)
    }
    if (expected.toolCalls !== undefined && (calls !== expected.toolCalls || results !== expected.toolCalls)) {
      throw new Error(`read-back tool calls ${calls}/${results} != ${expected.toolCalls}`)
    }
    return { events: events.length, turns, toolCalls: calls }
  } finally {
    try { await handle.close?.() } catch { /* best effort */ }
  }
}

// 生成会话并落盘。返回 { id, events, bytes, path }。
export async function generateSession({
  sessionsRoot, id, eventCount, turns, cwd,
  pad = 160, profile = 'plain', toolBytes = 12000, seed, verify = true,
}) {
  const sessionMod = await import('@deepseek-ai/dsh-session')
  const { Session, SESSION_FORMAT_VERSION } = sessionMod

  mkdirSync(sessionsRoot, { recursive: true })
  // 后端 root 就设成隔离 home 的 sessions 根：路径布局与 dsh 自己产出的完全一致
  // （<root>/<projectKey(cwd)>/<session-id>/session.v4.jsonl.zstd）。
  const { ctx, service } = await loadJsonlBackend(sessionsRoot)

  const header = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }

  let events
  let expected
  if (turns !== undefined) {
    const built = buildTurnEvents(turns, { profile, pad, toolBytes, seed })
    events = built.events
    expected = { events: events.length, turns: built.turns, toolCalls: profile === 'tools' ? built.toolCalls : undefined }
  } else {
    events = buildEvents(eventCount, { pad, profile: 'plain', seed })
    expected = { events: events.length }
  }

  const session = Session.create(id, events, header)

  const handle = await service.create(session.header, { inheritedEventCount: 0 })
  await handle.append(session.snapshotEvents())
  await handle.close()

  let verified = null
  if (verify) {
    verified = await verifySession(service, id, expected)
  }

  // stat 必须在 ctx.stop 之前取：service 属于这个 Context，停掉之后句柄不可靠。
  const stored = await service.stat?.(id)
  const path = stored?.location?.path ?? null

  // 关掉装载后端的 Context（释放文件句柄/表锁），否则 dsh 起不来同一个根。
  try { await ctx.stop?.() } catch { /* best effort */ }
  await sleep(200)

  return {
    id,
    events: events.length,
    turns: turns ?? null,
    toolCalls: expected.toolCalls ?? null,
    verified,
    path,
  }
}
