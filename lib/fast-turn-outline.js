// 投影折叠加速：消除 turnOutline 的 O(n²) 重折（问题 B 的真正修复）
//
// ## 实测归因（见 docs/RUNTIME-ANALYSIS.md）
//
// 24 万事件会话冷读 21 秒，归因：
//   解码 + 行解析 + 深冻 + Session 构造  1.4 s   （6%）
//   投影折叠                            18.2 s   （86%）
//   其中 **turnOutline 单单元**           16.1 s   （76%）
//   其余 28 个单元合计                    0.7 s   （3%）
//
// `dsh-session-turn-outline` 的 `apply` 每次 `turn/start` 都执行
// `[...state.turns, next]`，每次 `user/message` / `turn/end` 执行
// `[...state.turns.slice(0, -1), fixed]` —— 都是**整数组复制**。N 个 turn 累积
// 下来是 O(N²)：实测 5000 turn 87ms、10000 turn 439ms、20000 turn 5238ms
// （翻倍时约 4~12 倍增长），而语义等价的「只改末尾一项」写法是 O(N)（2/12/7ms）。
//
// ## 本模块做什么
//
// 在冷读之前（或预热时）用 O(N) 的等价 fold 把 `turnOutline` 的 cell 预先写好。
// 之后 `hydrate` / `restore` 发现该单元 cell 已存在且水位已到日志末尾，就不会
// 再调用上游的 `apply`。
//
// ## 为什么必须逐字段等价
//
// 投影单元的状态会进缓存行（`checkpoint` 会 `structuredClone(cell.state)`），
// 也会经 `wire.viewSchema.parse` 发给客户端。任何一个字段与上游实现不同都会
// 造成「同一会话在不同路径下看到不同 outline」。因此这里按上游源码逐 case
// 复刻，只把「整数组复制」换成「只替换末尾一项」，语义完全一致。

import { performance } from 'node:perf_hooks'

// 上游的 preview 实现（dsh-session-turn-outline/lib/index.js:25-48），逐字复刻。
// prompt/response 的最终字符串会进缓存行与 wire 视图，任何差异都会让同一会话在
// 不同路径下渲染出不同 outline。
const PROMPT_PREVIEW_LIMIT = 50
const RESPONSE_PREVIEW_LIMIT = 120

function previewOf(content, limit) {
  let text = ''
  let unread = false
  for (const block of content) {
    if (block.type !== 'text') continue
    if (text.length >= limit * 2) {
      unread = true
      break
    }
    const clipped = block.text.length > limit * 2
    const chunk = clipped ? block.text.slice(0, limit * 2) : block.text
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) {
      unread = true
      break
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}

// 线性 fold：与上游 apply 逐 case 等价，但只替换数组末项（`turns` 由本函数独占，
// 调用方拿到的是新建数组，所以原地 push 不会影响任何外部引用）。
function foldTurnOutlineLinear(events) {
  const turns = []
  let draft = ''
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        const last = turns.length === 0 ? void 0 : turns[turns.length - 1]
        if (last !== void 0 && event.data.turn <= last.turn) break
        turns.push({ turn: event.data.turn, seq: event.seq, prompt: '', response: '' })
        draft = ''
        break
      }
      case 'user/message': {
        if (event.data.source?.kind !== 'user') break
        const i = turns.length - 1
        if (i < 0 || turns[i].prompt !== '') break
        const prompt = previewOf(event.data.content, PROMPT_PREVIEW_LIMIT)
        if (prompt === '') break
        turns[i] = { ...turns[i], prompt }
        break
      }
      case 'assistant/message': {
        const next = previewOf(event.data.message?.content, RESPONSE_PREVIEW_LIMIT)
        if (next === '' || next === draft) break
        draft = next
        break
      }
      case 'turn/end': {
        if (draft === '') break
        const i = turns.length - 1
        if (i < 0 || turns[i].response === draft) { draft = ''; break }
        turns[i] = { ...turns[i], response: draft }
        draft = ''
        break
      }
      default: break
    }
  }
  return { turns, draft }
}

// 上游把 turns 数组本身作为 wire 视图（`view: (state) => state.turns`），
// 因此这里返回的状态形状必须是 `{ turns, draft }`，且 turns 元素只含
// turn / seq / prompt / response 四个键（上游 `.strict()` schema 会拒绝多余键）。
// 等价性探针用的事件流：覆盖 fold 的每一个分支。
const PROBE_HEADER = { version: 4, id: 'probe', createdAt: 0, isSeeded: false }

function buildEquivalenceProbe() {
  const text = (s) => [{ type: 'text', text: s }]
  const long = 'x'.repeat(300) // 同时超过 50*2 与 120*2 的单块
  return [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },   // 不递增 → 忽略
    { type: 'user/message', seq: 2, data: { source: { kind: 'model' }, content: text('ignored') } }, // 非 user → 忽略
    { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: text('first prompt') } },
    { type: 'user/message', seq: 4, data: { source: { kind: 'user' }, content: text('second') } },   // prompt 已设 → 忽略
    { type: 'assistant/message', seq: 5, data: { message: { content: text('draft one') } } },
    { type: 'assistant/message', seq: 6, data: { message: { content: text('draft two') } } },        // 覆盖 draft
    { type: 'tool/call', seq: 7, data: {} },                                                          // 无关事件
    { type: 'turn/end', seq: 8, data: {} },                                                           // 提交 response
    { type: 'turn/start', seq: 9, data: { turn: 2 } },
    { type: 'user/message', seq: 10, data: { source: { kind: 'user' }, content: text(long) } },       // 触发截断
    { type: 'assistant/message', seq: 11, data: { message: { content: text(long) } } },
    { type: 'turn/start', seq: 12, data: { turn: 3 } },                                               // 不开 turn/end，draft 保留
    { type: 'user/message', seq: 13, data: { source: { kind: 'user' }, content: text('   ') } },      // 全空白 → 不写
    { type: 'assistant/message', seq: 14, data: { message: { content: [{ type: 'image' }] } } },       // 无 text block
  ]
}

// 逐帧异步解压等无关；这里只做纯函数 fold。
export function installTurnOutlineFastFold(pc) {
  const { ctx, config, stats, log, logErr, safeGet, disposers, setPatchStatus } = pc
  if (!config.fastTurnOutline) { setPatchStatus('fastTurnOutline', 'off'); return }

  const registry = safeGet(ctx, 'sessionProjections')
  if (registry === void 0 || typeof registry.buildCell !== 'function' || registry.registrations === void 0) {
    setPatchStatus('fastTurnOutline', 'inactive')
    return
  }

  // 只在能确证上游语义时启用。
  //
  // 注意：dsh 0.2.2 里 `registration.def.apply` 不是投影定义里的原始函数，而是
  // 一层转发包装：`(state, event) => definition.apply(state, event)`（48 字符）。
  // 所以**拿不到**原始 `apply` 源码做特征串校验。这里改成两条判据：
  //   1. 该 key 存在、stateVersion 是数字（能写进缓存行）；
  //   2. 运行时抽样比对——用一小段合成事件流分别跑「上游 apply」与「我们的
  //      线性 fold」，结果必须逐字段相等。不等就退役，绝不上线。
  const registration = registry.registrations.get('turnOutline')
  if (registration === void 0 || registration.def === void 0 || typeof registration.def.stateVersion !== 'number') {
    setPatchStatus('fastTurnOutline', 'inactive')
    return
  }
  const originalApply = registration.def.apply
  const originalInit = registration.def.init
  if (typeof originalApply !== 'function' || typeof originalInit !== 'function') {
    setPatchStatus('fastTurnOutline', 'inactive')
    return
  }

  // 运行时等价性抽样：合成覆盖全部分支的事件流（turn/start 递增与不递增、
  // user/message 命中与忽略、assistant/message 覆盖 draft、turn/end 提交、
  // 超长 preview 截断），逐字段比对。
  const probeEvents = buildEquivalenceProbe()
  let probeEqual = false
  try {
    let upState = originalInit.call(registration.def, PROBE_HEADER, 0)
    for (const e of probeEvents) upState = originalApply.call(registration.def, upState, e)
    const fastState = foldTurnOutlineLinear(probeEvents)
    probeEqual = JSON.stringify(upState) === JSON.stringify(fastState)
  } catch { probeEqual = false }
  if (!probeEqual) {
    // 上游语义已变（或包装形态变了）。此时**不覆盖**，只在日志里提示。
    setPatchStatus('fastTurnOutline', 'inactive')
    pc.logErr?.('turnOutline equivalence probe failed; fast fold NOT installed (upstream semantics changed?)')
    return
  }

  const stateVersion = registration.def.stateVersion
  let fastApplied = 0

  // 用一个「可变中间态」实现线性累积：上游每次返回新对象，我们返回同一个对象，
  // 因为 registry 只在 fold 期间持有它，折完才写进 cell。
  const linearApply = (state, event) => {
    fastApplied += 1
    switch (event.type) {
      case 'turn/start': {
        const last = state.turns.length === 0 ? void 0 : state.turns[state.turns.length - 1]
        if (last !== void 0 && event.data.turn <= last.turn) return state
        state.turns.push({ turn: event.data.turn, seq: event.seq, prompt: '', response: '' })
        state.draft = ''
        return state
      }
      case 'user/message': {
        if (event.data.source?.kind !== 'user') return state
        const i = state.turns.length - 1
        if (i < 0 || state.turns[i].prompt !== '') return state
        const prompt = previewOf(event.data.content, PROMPT_PREVIEW_LIMIT)
        if (prompt === '') return state
        state.turns[i] = { ...state.turns[i], prompt }
        return state
      }
      case 'assistant/message': {
        const next = previewOf(event.data.message?.content, RESPONSE_PREVIEW_LIMIT)
        if (next === '' || next === state.draft) return state
        state.draft = next
        return state
      }
      case 'turn/end': {
        if (state.draft === '') return state
        const i = state.turns.length - 1
        if (i < 0 || state.turns[i].response === state.draft) { state.draft = ''; return state }
        state.turns[i] = { ...state.turns[i], response: state.draft }
        state.draft = ''
        return state
      }
      default: return state
    }
  }

  // 上游 init 返回的是模块级共享的 EMPTY_OUTLINE 常量。如果直接原地改它，
  // 会污染所有会话的「空 outline」。所以 init 必须返回**新的**可变状态。
  const fastInit = (header, inheritedEventCount) => {
    const base = originalInit.call(registration.def, header, inheritedEventCount)
    // 深拷一层：turns 必须可 push，draft 是字符串（不可变）。
    return { turns: Array.isArray(base?.turns) ? [...base.turns] : [], draft: base?.draft ?? '' }
  }

  registration.def.apply = linearApply
  registration.def.init = fastInit
  disposers.push(() => {
    if (registration.def.apply === linearApply) registration.def.apply = originalApply
    if (registration.def.init === fastInit) registration.def.init = originalInit
  })

  setPatchStatus('fastTurnOutline', 'active')
  log(`turnOutline fast fold installed (stateVersion=${stateVersion}, O(n^2) -> O(n))`)

  // 诊断：本轮折了多少次（用于 stats.get 与文档复现）
  pc.turnOutlineFastFoldCount = () => fastApplied
}

export { foldTurnOutlineLinear, previewOf }
