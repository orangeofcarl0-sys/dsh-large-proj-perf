// 汇总一批 session-stats.mjs 输出的 JSON，给出真实语料的行为分布中值。
//
//   node tools/runtime-probe/corpus-stats.mjs --stats-dir F:/dsh-rt/real-sample/stats
//
// 只读聚合；不输出对话文本。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const statsDir = arg('stats-dir', '')
if (statsDir === '') { console.error('--stats-dir is required'); process.exit(2) }
const minEvents = Number(arg('min-events', '100'))
const jsonOutput = process.argv.includes('--json')

const q = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}
const round = (value, digits = 1) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits

const sessions = readdirSync(statsDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(statsDir, name), 'utf8')))
  .filter((session) => session.events >= minEvents)
if (sessions.length === 0) { console.error('no sessions matched'); process.exit(1) }

const metrics = {
  events: sessions.map((s) => s.events),
  turns: sessions.map((s) => s.turns),
  eventsPerTurn: sessions.map((s) => s.eventsPerTurn.mean),
  jsonPerEvent: sessions.map((s) => s.jsonBytesPerEvent.mean),
  stringsPerEvent: sessions.map((s) => s.stringsPerEvent),
  nodesPerEvent: sessions.map((s) => s.nodesPerEvent.mean),
  toolCallsPerTurn: sessions.map((s) => s.toolCalls / Math.max(1, s.turns)),
  toolResultP50: sessions.map((s) => s.toolResultBytes.p50 ?? 0),
  toolResultP90: sessions.map((s) => s.toolResultBytes.p90 ?? 0),
  cjkRatio: sessions.map((s) => s.cjkRatio ?? 0),
}
const summary = Object.fromEntries(Object.entries(metrics).map(([key, values]) => [key, {
  p25: round(q(values, 0.25), key === 'cjkRatio' ? 4 : 1),
  p50: round(q(values, 0.5), key === 'cjkRatio' ? 4 : 1),
  p75: round(q(values, 0.75), key === 'cjkRatio' ? 4 : 1),
  p90: round(q(values, 0.9), key === 'cjkRatio' ? 4 : 1),
  max: round(Math.max(...values), key === 'cjkRatio' ? 4 : 1),
}]))

const typeAgg = new Map()
const totalEvents = sessions.reduce((sum, session) => sum + session.events, 0)
for (const session of sessions) {
  for (const type of session.typeStats) {
    const record = typeAgg.get(type.type) ?? { count: 0, jsonBytes: 0, json50: [], strings: [] }
    record.count += type.count
    record.jsonBytes += type.jsonBytes
    record.json50.push(type.json.p50)
    record.strings.push(type.strings.mean)
    typeAgg.set(type.type, record)
  }
}
const types = [...typeAgg.entries()]
  .sort((a, b) => b[1].jsonBytes - a[1].jsonBytes)
  .slice(0, 16)
  .map(([type, record]) => ({
    type,
    share: round(record.count / Math.max(1, totalEvents), 4),
    jsonP50: round(q(record.json50, 0.5)),
    stringsMean: round(q(record.strings, 0.5)),
  }))

const output = {
  sessions: sessions.length,
  events: totalEvents,
  metrics: summary,
  types,
}
if (jsonOutput) console.log(JSON.stringify(output, null, 2))
else {
  const line = (cells) => `| ${cells.join(' | ')} |`
  const rows = Object.entries(summary).map(([key, value]) => line([key, value.p25, value.p50, value.p75, value.p90, value.max]))
  console.log(`sessions ${sessions.length}, events ${totalEvents}`)
  console.log(line(['metric', 'p25', 'p50', 'p75', 'p90', 'max']))
  console.log(line(['---', '---:', '---:', '---:', '---:', '---:']))
  console.log(rows.join('\n'))
  console.log('\ntypes:')
  for (const type of types) console.log(`${type.type.padEnd(28)} share=${type.share} jsonP50=${type.jsonP50} strings=${type.stringsMean}`)
}
