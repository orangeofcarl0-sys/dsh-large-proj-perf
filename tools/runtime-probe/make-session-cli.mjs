// CLI：生成 v4 长会话到隔离 home 的 sessions 根。
//
//   node tools/runtime-probe/make-session.mjs --home <home> [--id <sessionId>] [--events 240000] [--cwd <path>]
//
// 事件数默认 240000：超过 minEvents(20000) 三档、超过 materializeChunkEvents(50000)
// 两档，能同时驱动预热与分片落盘两条链路。

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
const events = Number(arg('events', '240000'))
const pad = Number(arg('pad', '160'))
const id = arg('id', `session-probe-${Date.now().toString(36)}`)
const cwd = arg('cwd', 'F:\\dsh-rt\\probe-workspace')

const result = await generateSession({ sessionsRoot, id, eventCount: events, cwd, pad })
console.log(JSON.stringify({
  id: result.id,
  events: result.events,
  path: result.path,
  sizeMB: result.path !== null && existsSync(result.path) ? +(statSync(result.path).size / 1048576).toFixed(2) : null,
  sessionsRoot,
}, null, 2))
