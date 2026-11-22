// v1.17 测试：内容感知的事件字节估算（lib/event-bytes.js）
//
// 契约：
//   1. 空数组 / null 条目 → 0；
//   2. 小消息事件走 BYTES_PER_EVENT 下限（不低估短会话）；
//   3. 4 KB 消息事件显著高于下限；
//   4. 采样按 8 个连续事件整块取，事件总数偏移 1–3 个不改变估算；
//   5. 不可序列化事件不抛，按 0 处理；
//   6. 同一个 events 数组重复调用结果稳定（WeakMap 缓存）。

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const { bytesPerEvent, estimateEntryBytes } = await import('../lib/event-bytes.js')
const { BYTES_PER_EVENT, EVENT_SAMPLE_COUNT, HEAP_OVERHEAD_RATIO } = await import('../lib/constants.js')

// ---- 常量 ----
check('sample count is positive and bounded', EVENT_SAMPLE_COUNT >= 8 && EVENT_SAMPLE_COUNT <= 256, String(EVENT_SAMPLE_COUNT))
check('overhead ratio is sane', HEAP_OVERHEAD_RATIO >= 1 && HEAP_OVERHEAD_RATIO <= 1.5, String(HEAP_OVERHEAD_RATIO))
check('flat floor is still 400', BYTES_PER_EVENT === 400, String(BYTES_PER_EVENT))

// ---- 空输入 ----
check('empty events → 0', bytesPerEvent([]) === 0 && estimateEntryBytes({ events: [] }) === 0)
check('missing entry → 0', estimateEntryBytes(null) === 0 && estimateEntryBytes({}) === 0)
check('non-array events → 0', bytesPerEvent(null) === 0 && bytesPerEvent({ length: 3 }) === 0)

// ---- 小消息：走 400 下限 ----
{
  const small = Array.from({ length: 1000 }, () => ({ type: 'turn/start', data: { turn: 1 } }))
  check('small events: floor applies', bytesPerEvent(small) === BYTES_PER_EVENT, String(bytesPerEvent(small)))
  check('small events: entry = count × floor', estimateEntryBytes({ events: small }) === 1000 * BYTES_PER_EVENT)
}

// ---- null 事件也走下限（旧测试夹具的形状）----
{
  const nulls = new Array(10000).fill(null)
  check('null events: floor applies', bytesPerEvent(nulls) === BYTES_PER_EVENT, String(bytesPerEvent(nulls)))
}

// ---- 4 KB 消息：显著高于下限 ----
{
  const heavy = Array.from({ length: 1000 }, () => ({ type: 'assistant/message', data: { content: 'x'.repeat(4000) } }))
  const perEvent = bytesPerEvent(heavy)
  const expected = Math.round(4000 * HEAP_OVERHEAD_RATIO)
  check('4 KB events: above floor', perEvent > BYTES_PER_EVENT, String(perEvent))
  check('4 KB events: near JSON × ratio', Math.abs(perEvent - expected) < expected * 0.1, `${perEvent} vs ${expected}`)
  const entry = estimateEntryBytes({ events: heavy })
  check('4 KB events: entry scales with count', entry === 1000 * perEvent, String(entry))
}

// ---- 周期性大消息：采样不能系统性漏掉 ----
{
  const mixed = Array.from({ length: 4000 }, (_, i) => i % 4 === 0
    ? { type: 'assistant/message', data: { content: 'y'.repeat(4000) } }
    : { type: 'step/start', data: { step: i } })
  const perEvent = bytesPerEvent(mixed)
  check('mixed events: above floor', perEvent > 500, String(perEvent))
  check('mixed events: below pure 4 KB', perEvent < 3000, String(perEvent))
}

// ---- 字符串 header 开销：同样 JSON 大小，字符串更多的事件应估得更高 ----
{
  const many = Array.from({ length: 100 }, () => ({
    type: 'x',
    data: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, '1234567890'])),
  }))
  const one = Array.from({ length: 100 }, () => ({ type: 'x', data: { a: '1'.repeat(300) } }))
  check('string overhead: many strings > one big string',
    bytesPerEvent(many) > bytesPerEvent(one), `${bytesPerEvent(many)} vs ${bytesPerEvent(one)}`)
}

// ---- 类型分层采样：事件总数偏移 1–3 个不应改变估算（防相位 alias） ----
{
  const big = { type: 'assistant/message', data: { content: 'q'.repeat(4000) } }
  const small = { type: 'step/start', data: { step: 0 } }
  const turnLike = Array.from({ length: 4000 }, (_, i) => (i % 8 === 2 || i % 8 === 5) ? big : small)
  const base = bytesPerEvent(turnLike)
  const shiftedValues = [1, 2, 3].map((shift) => bytesPerEvent([...new Array(shift).fill(small), ...turnLike]))
  const maxDrift = Math.max(...shiftedValues.map((value) => Math.abs(value - base) / base))
  check('type sampling: shift-invariant', maxDrift <= 0.05, `base=${base} shifted=${shiftedValues.join(',')}`)
}

// ---- 不可序列化：不抛，按 0 ----
{
  const circular = { type: 'x', data: {} }
  circular.data.self = circular
  let threw = false
  try {
    const value = bytesPerEvent([circular, circular, circular])
    check('circular event: falls back to floor', value === BYTES_PER_EVENT, String(value))
  } catch { threw = true }
  check('circular event: does not throw', threw === false)
}

// ---- 稳定性 / WeakMap 缓存 ----
{
  const events = Array.from({ length: 500 }, (_, i) => ({ type: 'x', data: { text: 'z'.repeat(i % 2 === 0 ? 800 : 20) } }))
  const first = bytesPerEvent(events)
  const second = bytesPerEvent(events)
  check('repeat calls: identical', first === second)
  const copy = events.map((event) => ({ ...event }))
  const copyValue = bytesPerEvent(copy)
  check('same content, new array: same estimate', copyValue === first, `${copyValue} vs ${first}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
