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
  if (fn === undefined) { console.error(`unknown scenario ${name}`); continue }
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
    lines.push('## B 冷读基线（warmup 关闭）', '', row(['指标', '值']), row(['---', '---']))
    lines.push(row(['session/events', `${b.result.eventsMs} ms`]))
    lines.push(row(['session/projections', `${b.result.projectionsMs} ms`]))
    lines.push(row(['投影 key 数', String(b.result.projectionKeyCount)]))
    lines.push(row(['pinger P50/P95/P99/max', `${b.result.pinger.p50}/${b.result.pinger.p95}/${b.result.pinger.p99}/${b.result.pinger.max} ms`]))
    lines.push(row(['pinger stalls', String(b.result.pinger.stalls)]))
    lines.push(row(['RSS 峰值 / 增量', `${b.result.rss.maxMB} / ${b.result.rss.deltaMB} MB`]))
    lines.push(row(['warmed / skipped', `${b.result.warmed} / ${b.result.skipped}`]))
    lines.push('')
  }
  const c = r.scenarios.C
  if (c?.ok === true) {
    lines.push('## C 预热（warmup 开）', '', row(['指标', '值']), row(['---', '---']))
    lines.push(row(['rename(resume) 墙钟', `${c.result.resumeAndRenameMs} ms`]))
    lines.push(row(['rename 结果', c.result.renameOk ? 'ok' : `FAIL: ${c.result.renameErr}`]))
    lines.push(row(['warmed', String(c.result.warmed)]))
    lines.push(row(['alreadyHot（上游已建满 cell）', String(c.result.alreadyHot)]))
    lines.push(row(['skipped', String(c.result.skipped)]))
    lines.push(row(['warmRecent', '```' + JSON.stringify(c.result.warmRecent) + '```']))
    lines.push(row(['预热后 projections', `${c.result.projectionsAfterMs} ms`]))
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
  return lines.join('\n') + '\n'
}
