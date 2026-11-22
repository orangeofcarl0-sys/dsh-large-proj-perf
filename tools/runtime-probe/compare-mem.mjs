// 汇总多个 mem-open arm 的 report.json，输出 compare.md / compare.json。
//
//   node tools/runtime-probe/compare-mem.mjs --out F:/dsh-rt/<stamp>/mem-multi \
//     F:/dsh-rt/<stamp>/mem-multi/fixed-512/report.json \
//     F:/dsh-rt/<stamp>/mem-multi/fixed-128/report.json \
//     F:/dsh-rt/<stamp>/mem-multi/content-512/report.json

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outDir = outIndex === -1 ? null : args[outIndex + 1]
const files = args.filter((entry) => entry.endsWith('.json'))
if (files.length === 0) {
  console.error('usage: compare-mem.mjs [--out <dir>] <report.json...>')
  process.exit(2)
}

const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
const round = (value, digits = 1) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits

const arms = files.map((file) => {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const summary = report.summary
  const sessions = summary.sessions ?? []
  const final = sessions.at(-1) ?? null
  const reopen = summary.reopen ?? null
  const projectionValue = summary.meta?.projectionCache?.body?.value ?? null
  const firstRows = sessions.map((session) => session.timeline?.firstRowMs).filter((value) => typeof value === 'number')
  const retained = sessions.map((session) => session.cache?.retainedMiB).filter((value) => typeof value === 'number')
  return {
    label: summary.meta?.label ?? file,
    file,
    budgetBytes: summary.meta?.budgetFromStats ?? summary.meta?.budgetBytes ?? null,
    dshVersion: summary.meta?.dshVersion ?? null,
    sessions,
    final,
    reopen,
    firstRowMedianMs: round(median(firstRows)),
    retainedMedianMiB: round(median(retained)),
    retainedSumMiB: round(retained.reduce((sum, value) => sum + value, 0)),
    projection: projectionValue,
  }
})

const line = (cells) => `| ${cells.join(' | ')} |`
const markdown = [
  '# 多会话内存 A/B',
  '',
  line(['arm', '预算 MiB', '缓存条目', '缓存事件', 'estimated MiB', 'trimmed', '末会话稳定 Host 堆 MiB', 'Σ每会话增量 MiB', '首行中位 ms', '重开首行 ms', '重开 trimmed Δ', '投影行 rows/bytes']),
  line(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
  ...arms.map((arm) => {
    const settled = arm.final?.cache?.settled ?? {}
    return line([
      arm.label,
      arm.budgetBytes === null ? '—' : round(arm.budgetBytes / 1048576),
      settled.cachedEntries ?? '—',
      settled.cachedEvents ?? '—',
      settled.estimatedBytes === null || settled.estimatedBytes === undefined ? '—' : round(settled.estimatedBytes / 1048576),
      settled.trimmed ?? '—',
      arm.final?.stable?.hostHeapMiB ?? '—',
      arm.retainedSumMiB ?? '—',
      arm.firstRowMedianMs ?? '—',
      arm.reopen?.timeline?.firstRowMs ?? '—',
      arm.reopen?.cache?.delta?.trimmed ?? '—',
      arm.projection === null ? '—' : `${arm.projection.rows} / ${arm.projection.bytes}`,
    ])
  }),
  '',
  '## 逐会话增量',
  '',
  ...arms.flatMap((arm) => [
    `### ${arm.label}`,
    '',
    line(['#', '会话', '点击前 Host 堆', '稳定 Host 堆', '增量', '缓存条目 Δ', '事件 Δ', 'actual B/event', '首行 ms']),
    line(['---:', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']),
    ...arm.sessions.map((session, index) => line([
      String(index + 1),
      `\`${session.sessionId}\``,
      session.baseline?.hostHeapMiB ?? '—',
      session.stable?.hostHeapMiB ?? '—',
      session.cache?.retainedMiB ?? '—',
      session.cache?.delta?.cachedEntries ?? '—',
      session.cache?.eventsAdded ?? '—',
      session.cache?.actualBytesPerEvent ?? '—',
      session.timeline?.firstRowMs ?? '—',
    ])),
    '',
  ]),
].join('\n')

const payload = { generatedAt: new Date().toISOString(), arms }
if (outDir !== null) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'compare.md'), markdown)
  writeFileSync(join(outDir, 'compare.json'), JSON.stringify(payload, null, 2))
  console.log(`wrote ${join(outDir, 'compare.md')} and compare.json`)
} else {
  console.log(markdown)
}
