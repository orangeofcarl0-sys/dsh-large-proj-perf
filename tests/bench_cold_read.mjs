// 冷读归因基准：把一次完整冷读切成可分别计时的段。
//
// 背景：24 万事件会话的 `session/projections` 冷读要 ~16.6-19 秒，且事件循环出现
// 1.5-2.3 秒停顿。v1.6/v1.7 两轮都因为「没有精确归因就先动手」而做出了无效方案
// （回写缓存行实测零加速）。本基准存在的唯一目的是：在决定投入 worker thread
// 之前，先拿到每一段的真实占比。
//
// 能打点的地方有限：
//   - `SessionLogScanner` 是模块内 `var ... = class`，**未导出**（该包只导出
//     Config / JsonlCompressionSchema / apply / name），所以行解析段无法直接从外部包；
//   - `scanZstdFrames` / `createZstdFrameDecoder` 同样是包内私有。
//
// 因此采用「可达段实测 + 不可达段独立复算」的混合办法：
//   A. 可达段（直接包真实原型/实例方法）：
//      - persistence.readStoredLog（含文件读 + 帧扫描 + 解压 + 行解析 + 冻结的全链）
//      - sessionLogScanner 不可达 → 用 B 组的独立复算代替
//      - sessions.prepare（Session 构造：信封校验 + surface 折叠）
//      - registry.hydrate（投影）
//   B. 独立复算（用同一份字节，逐段计时，给出各段的绝对成本）：
//      - 帧扫描（复刻 scanZstdFrames 的算法）
//      - 逐帧解压
//      - 逐行 JSON.parse
//      - 逐行 assertV4RowAdmission（import 真实实现不可得 → 用 JSON.parse 成本作下界）
//      - 全图深冻（复刻 freezeStoredEvent）
//      - Session 构造（用真实 Session.create 在已解析事件上跑）
//
// 用法：
//   node tests/bench_cold_read.mjs --home <隔离 home> --session <sessionId>
//
// 注意：本文件**不是** npm test 的套件（它要跑一次完整冷读，约 20 秒，且需要
// 一个真实的 24 万事件会话）。run.mjs 只对 `tests/` 下不以 bench_ 开头的文件做
// 未知文件检查，`bench_*` 已被豁免。

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'

const zstdDecompressAsync = promisify(zstdDecompress)

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const home = arg('home', '')
const sessionId = arg('session', 'session-probe-long')
if (home === '') {
  console.error('usage: node tests/bench_cold_read.mjs --home <isolated home> [--session <id>]')
  process.exit(1)
}

// ---- 定位会话日志文件（dsh 的 bucket 布局：sessions/<projectKey>/<sessionId>/session*.jsonl.zstd）----
function findLog(root, id) {
  const sessionsRoot = join(root, 'sessions')
  if (!existsSync(sessionsRoot)) return null
  for (const bucket of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, bucket, id)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f)) return join(dir, f)
    }
  }
  return null
}

const logPath = findLog(home, sessionId)
if (logPath === null) {
  console.error(`session log not found under ${join(home, 'sessions')} for id ${sessionId}`)
  process.exit(1)
}
const raw = readFileSync(logPath)
const sizeMB = raw.length / 1048576
console.log(`# bench_cold_read`)
console.log(`session: ${sessionId}`)
console.log(`log: ${logPath}`)
console.log(`size: ${sizeMB.toFixed(2)} MB\n`)

const rows = []
const record = (label, ms, note = '') => {
  rows.push({ label, ms, note })
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(9)} ms  ${note}`)
}

// ============ B 组：独立复算（给出各段的绝对成本） ============

// B1 帧扫描（复刻 dsh 的 scanZstdFrames 算法）
function scanFrames(buffer) {
  const ZSTD_MAGIC = 0xFD2FB528
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    const start = offset
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, torn: true }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return { frames, torn: false }
}

let t = performance.now()
const { frames } = scanFrames(raw)
record('B1 frame scan', performance.now() - t, `${frames.length} frames`)

// B2 逐帧解压
t = performance.now()
const plains = []
for (const f of frames) plains.push(await zstdDecompressAsync(raw.subarray(f.start, f.end)))
const decompressMs = performance.now() - t
record('B2 decompress', decompressMs, `${(plains.reduce((a, b) => a + b.length, 0) / 1048576).toFixed(1)} MB inflated`)

// B3 逐行 split + JSON.parse
t = performance.now()
const text = Buffer.concat(plains).toString('utf8')
const lines = text.split('\n').filter((l) => l !== '')
record('B3 utf8 + split', performance.now() - t, `${lines.length} lines`)

t = performance.now()
const events = []
for (let i = 1; i < lines.length; i++) {
  try { events.push(JSON.parse(lines[i])) } catch { /* header 或损坏行 */ }
}
const parseMs = performance.now() - t
record('B4 JSON.parse', parseMs, `${events.length} events`)

// B5 全图深冻（复刻 freezeStoredEvent 的迭代式实现）
function freezeDeep(root) {
  const pending = [root]
  while (pending.length > 0) {
    const cur = pending.pop()
    Object.freeze(cur)
    if (Array.isArray(cur)) for (let i = 0; i < cur.length; i++) {
      const c = cur[i]
      if (c !== null && typeof c === 'object') pending.push(c)
    } else for (const k in cur) {
      const c = cur[k]
      if (c !== null && typeof c === 'object') pending.push(c)
    }
  }
}
// 用一份未冻结的副本量，避免重复运行时已是 frozen 导致 Object.freeze 空转
const forFreeze = lines.slice(1).map((l) => { try { return JSON.parse(l) } catch { return undefined } }).filter((e) => e !== undefined)
t = performance.now()
for (const e of forFreeze) freezeDeep(e)
Object.freeze(forFreeze)
const freezeMs = performance.now() - t
record('B5 deep freeze', freezeMs, `${forFreeze.length} events`)

// ============ A 组：真实链路（Session 构造 + 投影） ============

const { Session, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
const headerLine = JSON.parse(lines[0])
const header = {
  version: SESSION_FORMAT_VERSION,
  id: headerLine.id ?? sessionId,
  createdAt: headerLine.createdAt ?? Date.now(),
  ...(headerLine.cwd !== void 0 ? { cwd: headerLine.cwd } : {}),
  isSeeded: headerLine.isSeeded ?? false,
}
// 已冻结的 seed（模拟 readStoredLog 返回的 shared-frozen 状态）
const frozenSeed = forFreeze

t = performance.now()
const session = Session.fromRestore(header.id, frozenSeed, header, 0, 'shared-frozen')
const constructMs = performance.now() - t
record('A1 Session.fromRestore', constructMs, `header 校验 + surface 折叠（${frozenSeed.length} 事件）`)

// A2 投影 hydrate（若无 registry 则跳过）
let hydrateMs = null
try {
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  const projPlugin = await import('@deepseek-ai/dsh-session-projection')
  ctx.plugin({ name: 'bench-proj', apply: (c, cfg) => projPlugin.apply(c, cfg) }, {})
  let registry
  for (let i = 0; i < 100; i++) {
    registry = ctx.get('sessionProjections')
    if (registry !== void 0) break
    await new Promise((r) => setTimeout(r, 20))
  }
  if (registry !== void 0 && typeof registry.hydrate === 'function') {
    t = performance.now()
    registry.hydrate(session, {}, frozenSeed, 0)
    hydrateMs = performance.now() - t
    record('A2 projections.hydrate', hydrateMs, `${registry.registrations?.size ?? 0} units（空 checkpoint → 全折）`)
  }
  await ctx.stop?.()
} catch (e) {
  record('A2 projections.hydrate', 0, `skipped: ${String(e?.message ?? e).slice(0, 60)}`)
}

// ============ 汇总 ============
const total = rows.reduce((a, r) => a + r.ms, 0)
console.log(`\n# 分段合计 ${total.toFixed(0)} ms`)
console.log(`# 注：B4+B5 与 A1 有重叠（A1 不重复 parse/冻结，但会做信封校验与 surface 折叠）`)
console.log(`\n| 段 | ms | 占比 | 备注 |`)
console.log(`|---|---:|---:|---|`)
for (const r of rows) {
  console.log(`| ${r.label} | ${r.ms.toFixed(0)} | ${((r.ms / total) * 100).toFixed(1)}% | ${r.note} |`)
}

// 机器可读输出，便于归档
console.log(`\n# JSON ${JSON.stringify({
  sessionId, sizeMB: +sizeMB.toFixed(2), frames: frames.length, lines: lines.length,
  events: events.length, segments: rows.map((r) => ({ label: r.label, ms: +r.ms.toFixed(1), note: r.note })),
})}`)
