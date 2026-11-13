// CLI：生成 v4 长会话到隔离 home 的 sessions 根。
//
//   node tools/runtime-probe/make-session-cli.mjs --home <home> \
//     [--id session-probe-long] [--events 240000] [--pad 700] [--cwd <path>]
//
//   node tools/runtime-probe/make-session-cli.mjs --home <home> \
//     [--id session-probe-heavy] [--turns 300] [--profile tools] \
//     [--tool-bytes 12000] [--seed 42] [--cwd <path>]
//
// 两种模式：
//   --events N          按事件数生成（plain 档位，8 事件/turn）。默认 240000：
//                       超过 minEvents(20000) 三档、超过 materializeChunkEvents(50000)
//                       两档，能同时驱动预热与分片落盘两条链路。
//   --turns N           按 turn 数生成，配合 --profile markdown|tools。
//                       turn 数直接决定 turnOutline 投影大小；tools 档位让页字节
//                       由工具输出主导。
//
// 生成后会做读回自检（真实后端重新读出并核对事件数/turn 数/工具配对）。
// 自检失败直接退出 1，不打印路径。

import { resolve, join } from 'node:path'
import { existsSync, statSync } from 'node:fs'

import { generateSession } from './make-session.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const home = resolve(arg('home', ''))
if (!existsSync(home)) {
  console.error(`home not found: ${home}`)
  process.exit(1)
}
const sessionsRoot = join(home, 'sessions')
const turns = arg('turns', undefined)
const events = Number(arg('events', '240000'))
if (turns === undefined && (!Number.isInteger(events) || events <= 0 || events % 8 !== 0)) {
  console.error('--events must be a positive multiple of 8（buildTurnEvents 每 turn 产出 8 个事件）')
  process.exit(1)
}
const pad = Number(arg('pad', '160'))
const profile = arg('profile', turns === undefined ? 'plain' : 'markdown')
const toolBytes = Number(arg('tool-bytes', '12000'))
const seed = arg('seed', undefined)
const id = arg('id', `session-probe-${Date.now().toString(36)}`)
const cwd = arg('cwd', 'F:\\dsh-rt\\probe-workspace')

const startedAt = Date.now()
try {
  const result = await generateSession({
    sessionsRoot, id, cwd,
    ...(turns === undefined ? { eventCount: events } : { turns: Number(turns) }),
    pad, profile, toolBytes,
    ...(seed === undefined ? {} : { seed: Number(seed) }),
    verify: true,
  })
  console.log(JSON.stringify({
    id: result.id,
    profile,
    events: result.events,
    turns: result.turns,
    toolCalls: result.toolCalls,
    verified: result.verified,
    path: result.path,
    sizeMB: result.path !== null && existsSync(result.path) ? +(statSync(result.path).size / 1048576).toFixed(2) : null,
    generationMs: Date.now() - startedAt,
    sessionsRoot,
  }, null, 2))
} catch (error) {
  console.error(`generation failed: ${String(error?.message ?? error)}`)
  process.exit(1)
}
