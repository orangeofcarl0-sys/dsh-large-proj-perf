// v1.16 测试：文档一致性。
//
// 三类回归，全部来自 1.10–1.15 的实际事故：
//   1. 相对链接与锚点失效（改标题/删文档后没人复算 slug）；
//   2. README 配置表与 DEFAULT_CONFIG 双向漂移；
//   3. README 的 stats.get 样例与 createStats() 形状不一致。
//
// 只读仓库文件，不需要 dsh 安装。

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { createStats } from '../lib/stats.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const DOCS = [
  'README.md',
  'CHANGELOG.md',
  'docs/ARCHITECTURE.md',
  'docs/MEASUREMENTS.md',
  'docs/RENDER-ANALYSIS.md',
  'docs/HARNESS-COMPARISON.md',
  'docs/COMPATIBILITY.md',
  'docs/PUBLISHING.md',
  'tools/runtime-probe/README.md',
]

// GitHub 风格的标题 slug：去掉 HTML 与标点，空格逐个变成连字符（不折叠）。
// Emoji 在 GitHub 上会保留，但本仓库的标题不使用 emoji，所以这里按标点处理。
const slugify = (text) => text
  .replace(/`([^`]*)`/g, '$1')
  .replace(/<[^>]+>/g, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s_-]/gu, '')
  .replace(/\s/g, '-')

const headingsOf = (source) => {
  const slugs = new Set()
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    // 显式锚点优先：<a id="v1-15-0"></a> 不受 slug 算法差异影响。
    const explicit = /<a\s+id="([^"]+)"/.exec(line)
    if (explicit !== null) slugs.add(explicit[1])
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match !== null) slugs.add(slugify(match[2]))
  }
  return slugs
}

// ---- 1. 相对链接 + 锚点 ----
const cachedHeadings = new Map()
const anchorsFor = (path) => {
  if (!cachedHeadings.has(path)) cachedHeadings.set(path, headingsOf(readFileSync(path, 'utf8')))
  return cachedHeadings.get(path)
}

let linkCount = 0
let brokenLinks = 0
for (const doc of DOCS) {
  const abs = join(root, doc)
  if (!existsSync(abs)) { check(`docs: ${doc} exists`, false); brokenLinks++; continue }
  const source = readFileSync(abs, 'utf8')
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g
    let match
    while ((match = pattern.exec(line)) !== null) {
      const target = match[1]
      if (/^(https?:|mailto:|#)/.test(target)) {
        if (target.startsWith('#') && target.length > 1) {
          linkCount++
          if (!anchorsFor(abs).has(target.slice(1))) {
            console.log(`       dead anchor: ${doc} -> ${target}`)
            brokenLinks++
          }
        }
        continue
      }
      linkCount++
      const [rawPath, anchor] = target.split('#')
      const resolved = normalize(join(dirname(abs), decodeURIComponent(rawPath)))
      if (!resolved.startsWith(root) || !existsSync(resolved)) {
        console.log(`       dead link: ${doc} -> ${target}`)
        brokenLinks++
        continue
      }
      if (anchor !== undefined && anchor !== '' && resolved.endsWith('.md')) {
        if (!anchorsFor(resolved).has(anchor)) {
          console.log(`       dead anchor: ${doc} -> ${target}`)
          brokenLinks++
        }
      }
    }
  }
}
check('docs: every relative link and anchor resolves', brokenLinks === 0, `${linkCount} links, ${brokenLinks} broken`)

// ---- 2. README 配置表 ↔ DEFAULT_CONFIG ----
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const configSection = (() => {
  const start = /^##\s+配置/m.exec(readme)
  if (start === null) return ''
  const rest = readme.slice(start.index + start[0].length)
  const end = /^##\s/m.exec(rest)
  return end === null ? rest : rest.slice(0, end.index)
})()
const tableKeys = new Set()
for (const line of configSection.split('\n')) {
  const match = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/.exec(line)
  if (match !== null) tableKeys.add(match[1])
}
const defaultKeys = new Set(Object.keys(DEFAULT_CONFIG))
const missingInReadme = [...defaultKeys].filter((key) => !tableKeys.has(key))
const extraInReadme = [...tableKeys].filter((key) => !defaultKeys.has(key))
check('docs: README config table covers every DEFAULT_CONFIG key', missingInReadme.length === 0, missingInReadme.join(','))
check('docs: README config table has no unknown key', extraInReadme.length === 0, extraInReadme.join(','))

// ---- 3. README stats 样例 ↔ createStats() ----
const statsBlock = (() => {
  const match = /"render"\s*:\s*\{/.exec(readme)
  if (match === null) return null
  let depth = 0
  const start = match.index + match[0].length - 1
  for (let i = start; i < readme.length; i++) {
    if (readme[i] === '{') depth++
    else if (readme[i] === '}') {
      depth--
      if (depth === 0) return readme.slice(start, i + 1)
    }
  }
  return null
})()
const renderKeys = Object.keys(createStats().render).sort()
const sampleKeys = statsBlock === null ? [] : [...statsBlock.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s*:/g)].map((m) => m[1]).sort()
check('docs: README stats sample includes every render key',
  renderKeys.every((key) => sampleKeys.includes(key)), renderKeys.filter((key) => !sampleKeys.includes(key)).join(','))
check('docs: README stats sample has no unknown render key',
  sampleKeys.every((key) => renderKeys.includes(key)), sampleKeys.filter((key) => !renderKeys.includes(key)).join(','))
check('docs: README documents memoryBudget:null shape',
  /"memoryBudget"\s*:\s*(null|\{)/.test(readme))

// ---- 4. 文档里引用的仓库内文件真实存在 ----
// 跳过 glob；`lib/` 只查顶层模块（`lib/types/...` 这类是上游 shell bundle 的路径）。
let deadRefs = 0
for (const doc of DOCS.filter((name) => name !== 'CHANGELOG.md')) {
  const source = readFileSync(join(root, doc), 'utf8')
  for (const line of source.split('\n')) {
    // 历史记录里明确标注「已删除/已移除/已并入」的路径允许不存在。
    if (/删除|移除|并入/.test(line)) continue
    for (const match of line.matchAll(/`((?:docs|lib|tools|tests|scripts)\/[^`\s]+)`/g)) {
      const raw = match[1].replace(/[),.;:]+$/, '').replace(/:\d+(?:-\d+)?$/, '')
      if (raw.includes('*')) continue
      if (raw.startsWith('lib/') && raw.split('/').length > 2) continue
      if (!existsSync(join(root, raw))) {
        console.log(`       dead path ref: ${doc} -> ${raw}`)
        deadRefs++
      }
    }
  }
}
check('docs: backticked repository paths exist', deadRefs === 0, `${deadRefs} dead`)

// ---- 5. 渲染文档的体量上限（1.16 起 ≤300 行）----
const renderLines = readFileSync(join(root, 'docs/RENDER-ANALYSIS.md'), 'utf8').split('\n').length - 1
check('docs: RENDER-ANALYSIS stays under 300 lines', renderLines <= 300, `${renderLines} lines`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
