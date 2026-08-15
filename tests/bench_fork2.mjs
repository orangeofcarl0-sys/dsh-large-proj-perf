// benchmark v2：不依赖磁盘 seq 布局——构造与真实负载同规模/同形态的合成事件流
// 形态采样自真实会话：user/message、assistant/message(含长 reasoning/text/tool-call)、tool/result(含长输出)
import { Session } from '@deepseek-ai/dsh-session'
import { performance } from 'node:perf_hooks'

// 真实会话形态采样（来自 $TEMP/dsh_428.jsonl 与 dsh_session.jsonl 统计）：
// 41810 行 / 27.9MB → 平均每事件 ~660 bytes；tool/result 与 assistant/message 含数 KB 长 text
const N = Number(process.argv[2] ?? 20000)
const AVG = Number(process.argv[3] ?? 700)

function text(len) { let s = ''; while (s.length < len) s += 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '; return s.slice(0, len) }

const events = []
let turn = 0
for (let seq = 0; seq < N; seq++) {
  const kind = seq % 10
  const time = Date.now() + seq
  if (kind === 0) {
    events.push({ type: 'turn/start', seq, time, data: { turn: ++turn } })
  } else if (kind === 1) {
    events.push({ type: 'user/message', seq, time, data: { content: [{ type: 'text', text: text(AVG) }], source: { kind: 'user' }, role: 'user', id: `m${seq}` }, surfaceOp: 'append' })
  } else if (kind === 2 || kind === 5) {
    events.push({ type: 'assistant/message', seq, time, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: text(AVG * 2) }, { type: 'text', text: text(AVG) }], source: { kind: 'model', provider: 'bench', model: 'bench-model' }, id: `a${seq}` } }, surfaceOp: 'append' })
  } else if (kind === 3) {
    events.push({ type: 'tool/call', seq, time, data: { turn, step: 1, name: 'bash', callId: `c${seq}`, arguments: { command: text(120) } } })
  } else if (kind === 4) {
    events.push({ type: 'tool/result', seq, time, data: { turn, step: 1, message: { source: { kind: 'tool', callId: `c${seq - 1}` }, content: [{ type: 'tool-result', toolCallId: `c${seq - 1}`, content: [{ type: 'text', text: text(AVG * 4) }], isError: false }], role: 'user', id: `r${seq}` } }, sourceEventSeqs: [seq - 1], surfaceOp: 'append' })
  } else if (kind === 6) {
    events.push({ type: 'step/start', seq, time, data: { turn, step: 1 } })
  } else if (kind === 7) {
    events.push({ type: 'step/end', seq, time, data: { turn, step: 1 } })
  } else if (kind === 8) {
    events.push({ type: 'turn/end', seq, time, data: { turn, reason: { kind: 'completed' } } })
  } else {
    events.push({ type: 'usage', seq, time, data: { turn, step: 1, usage: { inputTokens: 100, outputTokens: 500, cacheReadTokens: 400000 } } })
  }
}
const totalBytes = JSON.stringify(events).length
console.log(`synthetic events: ${events.length}, bytes: ${(totalBytes / 1048576).toFixed(1)}MB (≈真实主会话负载)`)

const header = { version: 0, id: 'session-bench', createdAt: Date.now(), cwd: 'F:\\bench', delegationDepth: 0, agentPreset: 'code' }

function bench(label, fn, n = 5) {
  fn() // warmup
  const times = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  console.log(`${label}: median=${times[Math.floor(n / 2)].toFixed(1)}ms  min=${times[0].toFixed(1)}ms  max=${times.at(-1).toFixed(1)}ms`)
}

bench('A. native fork body   slice+create(snapshotJsonValue)', () => {
  Session.create('session-bench', events.slice(), header)
})
bench('D. zero-copy fork     slice+fromRestore(freeze)', () => {
  Session.fromRestore('session-bench', events.slice(), header)
})
// persistence 侧第二次拷贝：initFor structuredClone(seed)
bench('E. persistence initFor structuredClone(seed)', () => {
  structuredClone(events)
})
// enqueue 逐事件第三次拷贝
bench('F. enqueue per-event structuredClone', () => {
  for (const e of events) structuredClone(e)
})
