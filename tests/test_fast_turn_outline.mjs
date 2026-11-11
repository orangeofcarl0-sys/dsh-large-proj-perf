// v1.8 测试：turnOutline 折叠加速的**语义等价性**
//
// 这个优化替换的是一个投影单元的 fold 实现。它必须与上游逐 case 等价，
// 否则同一会话会在「冷读（走我们的 fold）」与「live 增量（走上游 apply）」
// 两条路径下渲染出不同的 turn outline，并把差异写进缓存行。
//
// 所以本套件的核心不是"快不快"，而是**在大量随机事件流上逐字段比对结果**。

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const { foldTurnOutlineLinear, previewOf } = await import('../lib/fast-turn-outline.js')

// ---- 上游实现的逐字复刻（dsh-session-turn-outline/lib/index.js:25-141）----
const PROMPT_PREVIEW_LIMIT = 50
const RESPONSE_PREVIEW_LIMIT = 120

function upstreamPreview(content, limit) {
  let text = ''
  let unread = false
  for (const block of content) {
    if (block.type !== 'text') continue
    if (text.length >= limit * 2) { unread = true; break }
    const clipped = block.text.length > limit * 2
    const chunk = clipped ? block.text.slice(0, limit * 2) : block.text
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) { unread = true; break }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}

const EMPTY_OUTLINE = { turns: [], draft: '' }

function upstreamApply(state, event) {
  switch (event.type) {
    case 'turn/start': {
      const last = state.turns.at(-1)
      if (last !== void 0 && event.data.turn <= last.turn) return state
      return { turns: [...state.turns, { turn: event.data.turn, seq: event.seq, prompt: '', response: '' }], draft: '' }
    }
    case 'user/message': {
      if (event.data.source.kind !== 'user') return state
      const last = state.turns.at(-1)
      if (last === void 0 || last.prompt !== '') return state
      const prompt = upstreamPreview(event.data.content, PROMPT_PREVIEW_LIMIT)
      if (prompt === '') return state
      return { turns: [...state.turns.slice(0, -1), { ...last, prompt }], draft: state.draft }
    }
    case 'assistant/message': {
      const draft = upstreamPreview(event.data.message.content, RESPONSE_PREVIEW_LIMIT)
      if (draft === '' || draft === state.draft) return state
      return { turns: state.turns, draft }
    }
    case 'turn/end': {
      if (state.draft === '') return state
      const last = state.turns.at(-1)
      if (last === void 0 || last.response === state.draft) return { turns: state.turns, draft: '' }
      return { turns: [...state.turns.slice(0, -1), { ...last, response: state.draft }], draft: '' }
    }
    default: return state
  }
}

function upstreamFold(events) {
  let state = EMPTY_OUTLINE
  for (const e of events) state = upstreamApply(state, e)
  return state
}

// ---- preview 等价性（含边界：超长块、多块、非文本块、全空白）----
{
  const cases = [
    { content: [{ type: 'text', text: 'hello' }], limit: 50 },
    { content: [{ type: 'text', text: 'a'.repeat(200) }], limit: 50 },
    { content: [{ type: 'text', text: 'a'.repeat(99) }, { type: 'text', text: 'b' }], limit: 50 },
    { content: [{ type: 'text', text: 'x'.repeat(101) }], limit: 50 },
    { content: [{ type: 'image' }, { type: 'text', text: 'after image' }], limit: 50 },
    { content: [{ type: 'text', text: '   ' }], limit: 50 },
    { content: [{ type: 'text', text: 'line1\n\nline2\t  line3' }], limit: 50 },
    { content: [{ type: 'text', text: 'a'.repeat(49) }], limit: 50 },
    { content: [{ type: 'text', text: 'a'.repeat(50) }], limit: 50 },
    { content: [{ type: 'text', text: 'a'.repeat(240) }], limit: 120 },
    { content: [{ type: 'text', text: 'b'.repeat(241) }], limit: 120 },
  ]
  let same = 0
  for (const c of cases) {
    const a = upstreamPreview(c.content, c.limit)
    const b = previewOf(c.content, c.limit)
    if (a === b) same += 1
    else console.log(`  MISMATCH limit=${c.limit}: upstream=${JSON.stringify(a)} ours=${JSON.stringify(b)}`)
  }
  check('preview: byte-identical on all boundary cases', same === cases.length, `${same}/${cases.length}`)
}

// ---- 确定性事件流的逐字段等价 ----
function buildEvents(turnCount) {
  const ev = []
  let seq = 0
  for (let t = 1; t <= turnCount; t++) {
    ev.push({ type: 'turn/start', seq: seq++, data: { turn: t } })
    // 每 3 轮放一条非 user 的 message（应被忽略）
    if (t % 3 === 0) {
      ev.push({ type: 'user/message', seq: seq++, data: { source: { kind: 'model' }, content: [{ type: 'text', text: 'ignored' }] } })
    }
    ev.push({ type: 'user/message', seq: seq++, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${t}` }] } })
    // 每轮两条 assistant（后者应覆盖 draft）
    ev.push({ type: 'assistant/message', seq: seq++, data: { message: { content: [{ type: 'text', text: `draft a${t}` }] } } })
    ev.push({ type: 'assistant/message', seq: seq++, data: { message: { content: [{ type: 'text', text: `draft b${t}` }] } } })
    // 每 5 轮不带 turn/end（draft 保留到下一轮）
    if (t % 5 !== 0) ev.push({ type: 'turn/end', seq: seq++, data: {} })
    // 夹杂无关事件
    ev.push({ type: 'tool/call', seq: seq++, data: { callId: `c${t}` } })
  }
  return ev
}

{
  const events = buildEvents(200)
  const up = upstreamFold(events)
  const fast = foldTurnOutlineLinear(events)
  const sameJson = JSON.stringify(up) === JSON.stringify(fast)
  check('fold: identical turns array (200 turns, mixed)', sameJson,
    `upstream=${up.turns.length} ours=${fast.turns.length}`)
  if (!sameJson) {
    // 定位第一处差异，便于排查
    for (let i = 0; i < Math.max(up.turns.length, fast.turns.length); i++) {
      const a = JSON.stringify(up.turns[i])
      const b = JSON.stringify(fast.turns[i])
      if (a !== b) { console.log(`  first diff at ${i}: ${a} vs ${b}`); break }
    }
  }
  check('fold: draft identical', up.draft === fast.draft, `upstream=${JSON.stringify(up.draft)} ours=${JSON.stringify(fast.draft)}`)
}

// ---- 边界：turn 号不递增（应被忽略）----
{
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 5 } },
    { type: 'turn/start', seq: 1, data: { turn: 3 } }, // 应被忽略
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'p' }] } },
    { type: 'turn/end', seq: 3, data: {} },
    { type: 'turn/start', seq: 4, data: { turn: 6 } },
  ]
  const up = upstreamFold(events)
  const fast = foldTurnOutlineLinear(events)
  check('edge: non-increasing turn ignored', JSON.stringify(up) === JSON.stringify(fast), JSON.stringify(fast.turns.map((t) => t.turn)))
}

// ---- 边界：空事件流 ----
{
  const up = upstreamFold([])
  const fast = foldTurnOutlineLinear([])
  check('edge: empty stream', JSON.stringify(up) === JSON.stringify(fast), JSON.stringify(fast))
}

// ---- 边界：prompt 只取第一条 user 消息 ----
{
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] } },
  ]
  const up = upstreamFold(events)
  const fast = foldTurnOutlineLinear(events)
  check('edge: only first user message becomes prompt',
    JSON.stringify(up) === JSON.stringify(fast) && fast.turns[0].prompt === 'first',
    JSON.stringify(fast.turns[0]))
}

// ---- 边界：空 prompt（全空白内容）不写入 ----
{
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] } },
  ]
  const up = upstreamFold(events)
  const fast = foldTurnOutlineLinear(events)
  check('edge: blank prompt stays empty', JSON.stringify(up) === JSON.stringify(fast) && fast.turns[0].prompt === '')
}

// ---- 性能：线性实现必须显著快于上游（这个优化存在的理由）----
{
  const events = buildEvents(6000)
  const t0 = performance.now()
  upstreamFold(events)
  const upMs = performance.now() - t0
  const t1 = performance.now()
  foldTurnOutlineLinear(events)
  const fastMs = performance.now() - t1
  check('perf: linear fold is at least 10x faster at 6000 turns',
    fastMs * 10 < upMs, `upstream=${upMs.toFixed(0)}ms linear=${fastMs.toFixed(1)}ms`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
