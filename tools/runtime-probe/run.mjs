// 编排：起隔离实例 → 跑场景 → 落 report.json + report.md。
//
//   node tools/runtime-probe/run.mjs --home F:/dsh-rt/<stamp>/home --agents F:/dsh-rt/<stamp>/agents --port 3181
//
// 前置：
//   1. 该 home 下已有 profile（profiles/rt）且装好被观测插件；
//   2. 已用 make-session-cli.mjs 生成 session-probe-long。

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { SCENARIOS } from './scenarios.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const home = resolve(arg('home', ''))
if (!existsSync(home)) {
  console.error(`home not found: ${home}`)
  process.exit(1)
}
const agentsHome = resolve(arg('agents', join(home, '..', 'agents')))
const profile = arg('profile', 'rt')
const port = Number(arg('port', '3181'))
const outDir = resolve(arg('out', join(home, '..', 'out')))
const only = arg('scenario', 'all')
mkdirSync(outDir, { recursive: true })

const baseOpts = { home, agentsHome, profile, port, outDir }
const names = only === 'all' ? Object.keys(SCENARIOS) : only.split(',').map((s) => s.trim().toUpperCase())

const report = { startedAt: new Date().toISOString(), home, profile, port, scenarios: {} }

for (const name of names) {
  const fn = SCENARIOS[name]
  if (fn === undefined) {
    console.error(`unknown scenario ${name} (known: ${Object.keys(SCENARIOS).join(', ')})`)
    process.exit(1)
  }
  process.stdout.write(`\n=== scenario ${name} ===\n`)
  const t0 = Date.now()
  try {
    const result = await fn(baseOpts)
    report.scenarios[name] = { ok: true, ms: Date.now() - t0, result }
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    report.scenarios[name] = { ok: false, ms: Date.now() - t0, error: String(error?.stack ?? error) }
    console.error(`scenario ${name} FAILED:`, error)
  }
  // 每个场景后等一下端口释放
  await new Promise((r) => setTimeout(r, 1500))
}

report.finishedAt = new Date().toISOString()
const jsonPath = join(outDir, 'report.json')
// 累积写：同一 outDir 多次调用（如先跑单场景再补跑）不会互相覆盖。
let previous = {}
try { previous = JSON.parse(readFileSync(jsonPath, 'utf8'))?.scenarios ?? {} } catch { previous = {} }
const merged = { ...report, scenarios: { ...previous, ...report.scenarios } }
writeFileSync(jsonPath, JSON.stringify(merged, null, 2))
writeFileSync(join(outDir, 'report.md'), renderMarkdown(merged))
console.log(`\nwrote ${jsonPath}`)

function row(cells) { return `| ${cells.join(' | ')} |` }

function renderMarkdown(r) {
  const lines = [
    '# runtime-probe 报告',
    '',
    `- 开始：${r.startedAt}`,
    `- 结束：${r.finishedAt}`,
    `- home：\`${r.home}\``,
    `- profile：${r.profile}　端口：${r.port}`,
    '',
  ]
  const a = r.scenarios.A
  if (a?.ok === true) {
    lines.push('## A 装机核验', '', row(['项', '值']), row(['---', '---']))
    lines.push(row(['dshVersion', `\`${a.result.dshVersion}\``]))
    for (const [k, v] of Object.entries(a.result.patches)) lines.push(row([`patches.${k}`, `**${v}**`]))
    lines.push(row(['配置键数', String(a.result.configKeys)]))
    lines.push(row(['debugApi 默认', String(a.result.debugApiDefault)]))
    lines.push(row(['dsh-perf 日志行数', String(a.result.perfLogLines.length)]))
    lines.push('', '启动日志（`dsh-perf`）：', '', '```')
    for (const l of a.result.perfLogLines) lines.push(l)
    lines.push('```', '')
  }
  const b = r.scenarios.B
  if (b?.ok === true) {
    lines.push('## B 冷读基线', '', row(['指标', '值']), row(['---', '---']))
    lines.push(row(['session/events', `${b.result.eventsMs} ms`]))
    lines.push(row(['session/projections', `${b.result.projectionsMs} ms`]))
    lines.push(row(['投影 key 数', String(b.result.projectionKeyCount)]))
    lines.push(row(['pinger P50/P95/P99/max', `${b.result.pinger.p50}/${b.result.pinger.p95}/${b.result.pinger.p99}/${b.result.pinger.max} ms`]))
    lines.push(row(['pinger stalls', String(b.result.pinger.stalls)]))
    lines.push(row(['RSS 峰值 / 增量', `${b.result.rss.maxMB} / ${b.result.rss.deltaMB} MB`]))
    lines.push('')
  }
  const c = r.scenarios.C
  if (c?.ok === true) {
    lines.push('## C resume 冷读 + 投影热读', '', row(['指标', '值']), row(['---', '---']))
    lines.push(row(['rename(resume) 墙钟', `${c.result.resumeAndRenameMs} ms`]))
    lines.push(row(['rename 结果', c.result.renameOk ? 'ok' : `FAIL: ${c.result.renameErr}`]))
    lines.push(row(['resume 后 projections', `${c.result.projectionsAfterMs} ms`]))
    lines.push(row(['投影 key 数', String(c.result.projectionKeyCount)]))
    lines.push(row(['pinger P50/P95/P99/max', `${c.result.pinger.p50}/${c.result.pinger.p95}/${c.result.pinger.p99}/${c.result.pinger.max} ms`]))
    lines.push(row(['RSS 峰值 / 增量', `${c.result.rss.maxMB} / ${c.result.rss.deltaMB} MB`]))
    lines.push('')
  }
  const d = r.scenarios.D
  if (d?.ok === true) {
    lines.push('## D 真实 fork RPC', '', row(['指标', '值']), row(['---', '---']))
    lines.push(row(['childId', `\`${d.result.childId}\``]))
    lines.push(row(['fork 墙钟', `${d.result.forkMs} ms`]))
    lines.push(row(['**pluginForks**', `**${d.result.pluginForks}**`]))
    lines.push(row(['pluginZeroCopy', String(d.result.pluginZeroCopy)]))
    lines.push(row(['子会话 zstd frame 数', String(d.result.childFileFrames)]))
    lines.push(row(['子会话字节', String(d.result.childFileBytes)]))
    lines.push('')
  }
  const e = r.scenarios.E
  if (e?.ok === true) {
    lines.push('## E debug.fork 同进程 A/B', '', row(['模式', 'n', 'min', 'median', 'max', 'forks', 'zeroCopy', 'fallbacks']), row(['---', '---', '---', '---', '---', '---', '---', '---']))
    for (const [label, v] of Object.entries(e.result.runs)) {
      lines.push(row([label, String(v.n), `${v.min} ms`, `${v.median} ms`, `${v.max} ms`, String(v.pluginForks), String(v.pluginZeroCopy), String(v.pluginFallbacks)]))
    }
    lines.push('', row(['record.path 序列', e.result.runs.zeroCopy.recordPaths.join(' / ')]))
    lines.push('')
  }
  const f = r.scenarios.F
  if (f?.ok === true) {
    lines.push('## F 分片落盘', '', row(['chunkedMaterialize', '帧数', '字节', 'fork+encode', 'pinger P99']), row(['---', '---', '---', '---', '---']))
    for (const [label, v] of [['true', f.result.enabled], ['false', f.result.disabled]]) {
      lines.push(row([label, String(v.fileFrames), String(v.fileBytes), `${v.forkAndMaterializeMs} ms`, `${v.pinger.p99} ms`]))
    }
    lines.push('')
  }
  const g = r.scenarios.G
  if (g?.ok === true) {
    const w = g.result.withWriteBack
    const c = g.result.control
    lines.push('## G 冷读回写（跨进程验证）', '')
    lines.push(row(['', '首次冷读', '重启后再读', '加速比', '缓存行已创建', 'coldWriteBacks']), row(['---', '---', '---', '---', '---', '---']))
    lines.push(row(['**开启**', `${w.coldReadMs} ms`, `${w.restartReadMs} ms`, `**${w.speedup}×**`, String(w.cacheRowCreated), String(w.coldWriteBacks)]))
    lines.push(row(['对照（关闭）', `${c.coldReadMs} ms`, `${c.restartReadMs} ms`, `${c.speedup}×`, String(c.cacheRowCreated), '—']))
    lines.push('', `投影 key 数 ${w.projectionKeys}，asOfSeq ${w.asOfSeq}`, '')
    if (w.coldWriteBackRecent?.length > 0) {
      lines.push('回写记录：', '', '```', JSON.stringify(w.coldWriteBackRecent, null, 2), '```', '')
    }
  }
  const h = r.scenarios.H
  if (h?.ok === true) {
    lines.push('## H 渲染链路的分页载荷', '',
      row(['配置', '消息', '记录', '记录字节', '响应字节', '冷读', '热读', '投影 key', '投影字节', '投影']),
      row(['---', '---', '---', '---', '---', '---', '---', '---', '---', '---']))
    for (const [label, v] of [['上游（500）', h.result.upstream], ['maxInitialMessages=25', h.result.capped]]) {
      lines.push(row([
        label, String(v.messages), String(v.records), String(v.recordsBytes), String(v.bytes),
        `${v.coldMs} ms`, `${v.warmMs} ms`, String(v.projectionKeys), String(v.projectionBytes), `${v.projectionMs} ms`,
      ]))
    }
    lines.push('', `renderTiming 计时点记录：上游 ${h.result.upstream.renderPages.length} 条 / 截断 ${h.result.capped.renderPages.length} 条`, '')
    const rows = [...h.result.upstream.renderPages, ...h.result.capped.renderPages]
    if (rows.length > 0) {
      lines.push('```', JSON.stringify(rows, null, 2), '```', '')
    }
  }
  // 兜底：A–H 之外的场景（I/J 以及以后新增的）不能静默消失。
  const handled = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
  for (const [name, value] of Object.entries(r.scenarios)) {
    if (handled.has(name) || value?.ok !== true) continue
    lines.push(`## ${name}`, '', '```json', JSON.stringify(value.result, null, 2), '```', '')
  }

  return lines.join('\n') + '\n'
}
