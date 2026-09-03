// 真实 dsh 源码特征验证：直接读取全局安装的 dsh 内部包源码，断言插件
// 依赖的全部结构/特征标记仍然存在。mock 测试验证的是逻辑正确性，本测试
// 验证的是「补丁能否装上」——dsh 升级后跑一次就知道哪些补丁会静默失效。
//
// 依赖 scripts/link-deps.ps1 建立的 junction（解析 @deepseek-ai/dsh-session）。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let failures = 0
let warns = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}
const warn = (label, extra = '') => {
  console.log(`WARN  ${label}${extra ? '  ' + extra : ''}`)
  warns++
}

// ---- 定位真实 dsh 根（junction 里 dsh-session 的上级上级） ----
const require = createRequire(import.meta.url)
const sessionEntry = require.resolve('@deepseek-ai/dsh-session/package.json')
// .../dsh/node_modules/@deepseek-ai/dsh-session/package.json → 上 3 级到 dsh 根
const dshRoot = join(dirname(sessionEntry), '..', '..', '..')
const dshPkg = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8'))

// 插件开发/验证过的版本；不在列表里打 WARN（结构断言照跑，人工确认兼容性）
const KNOWN_VERSIONS = ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2', '0.1.2-alpha.5', '0.1.2-rc.1']
console.log(`dsh version: ${dshPkg.version} (root: ${dshRoot})`)
if (!KNOWN_VERSIONS.includes(dshPkg.version)) {
  warn(`dsh ${dshPkg.version} not in known list ${KNOWN_VERSIONS.join('/')}`, 'verify compatibility manually')
}

const src = (pkg, file) => readFileSync(join(dshRoot, 'node_modules', '@deepseek-ai', pkg, file ?? 'lib/index.js'), 'utf8')

// ---- dsh-session：fork 通道（零拷贝 fork 依赖） ----
const sessionSrc = src('dsh-session')
check('fork source present', sessionSrc.includes('fork(source, boundary, childSessionId)'))
check('fork internals (_resolveForkSource/_forkSeed/prepare/enter/announce) present',
  ['_resolveForkSource', '_forkSeed', 'prepare(id, options)', 'enter(', 'announce('].every((m) => sessionSrc.includes(m)))
check('restore channel (seedSource persistence -> fromRestore) present',
  sessionSrc.includes('seedSource === "persistence"') && sessionSrc.includes('Session.fromRestore'))
check('restored header validation present', sessionSrc.includes('validateRestoredSessionHeader'))
// fork 的 meta 字段集：alpha.5 起为 cwd/parentSession/isSeeded（seedLength 移入
// options.inheritedEventCount）；零拷贝补丁复刻此集合
check('native fork meta field set unchanged',
  sessionSrc.includes('parentSession: liveSource.id') && sessionSrc.includes('isSeeded: true'))
check('inheritedEventCount option + SessionLogOffset export present (alpha.5 restore channel)',
  sessionSrc.includes('inheritedEventCount') && sessionSrc.includes('SessionLogOffset'))

// ---- dsh-session-persistence：initFor 补丁 + 冷会话 LRU 裁剪 ----
const persistSrc = src('dsh-session-persistence')
const initForMarker = persistSrc.includes('structuredClone(e)')
const initForEventsRef = persistSrc.includes('const seed = session.events')
const initForSnapshot = persistSrc.includes('session.snapshotEvents()')
// 三种形态都接受：rc.6/rc.7 structuredClone 深拷贝（补丁可装）；rc.8 events 引用
// 复用；alpha.5 snapshotEvents() 快照——后两者均为上游原生实现，补丁预期退役
check('initFor marker OR upstream native seed source', initForMarker || initForEventsRef || initForSnapshot,
  initForMarker ? '(patch installable)' : `(upstream native; patch retired: ${initForSnapshot ? 'snapshotEvents' : 'events ref'})`)
check('initFor internals present',
  ['reservationFor', 'attachPrepared', 'createWriteBehind', 'this.serialize(', 'this.onCreated('].every((m) => persistSrc.includes(m)))
check('SessionPreparations structure (capacity/entries Map/ready phase) present',
  ['capacity', 'entries = ', 'phase === "ready"'].every((m) => persistSrc.includes(m)))

// ---- dsh-session-persistence-jsonl：分片 materialize + 冷会话补行 ----
const jsonlSrc = src('dsh-session-persistence-jsonl')
check('encodeMaterialization signature markers present',
  jsonlSrc.includes('eventLines(events, this.packChunks)') && jsonlSrc.includes('compressZstdFrame'))
check('encodeMaterialization (storage, events) signature (alpha.5)', jsonlSrc.includes('encodeMaterialization(storage, events)'))
check('encodeMaterialization delegates on compression=none', jsonlSrc.includes('this.compression === "none"'))

// toHeaderLine(header, inheritedEventCount)：字段集对比——alpha.5 的 seedLength 是
// isSeeded 条件字段（`header.isSeeded ? { seedLength: cut }`），正则同步提取
const realFields = new Set()
for (const m of jsonlSrc.matchAll(/\.\.\.header\.(\w+) !== void 0/g)) realFields.add(m[1])
for (const m of jsonlSrc.matchAll(/header\.(\w+) \?\? /g)) realFields.add(m[1])
for (const m of jsonlSrc.matchAll(/header\.isSeeded \? \{ (\w+)/g)) realFields.add(m[1])
realFields.add('type'); realFields.add('version'); realFields.add('id'); realFields.add('createdAt')
const pluginFields = ['type', 'version', 'id', 'createdAt', 'cwd', 'parentSession', 'seedLength', 'origin', 'delegationDepth', 'agentPreset']
const missing = pluginFields.filter((f) => !realFields.has(f))
const extra = [...realFields].filter((f) => !pluginFields.includes(f))
check('toHeaderLine field set matches plugin replica', missing.length === 0 && extra.length === 0,
  `missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`)
check('toHeaderLine takes inheritedEventCount (alpha.5)', jsonlSrc.includes('toHeaderLine(header, inheritedEventCount)'))

// eventLines 用 packChunkRuns（插件降级路径的等价前提）
check('eventLines packs via packChunkRuns', /function eventLines[\s\S]{0,200}packChunkRuns\(events\)/.test(jsonlSrc))
check('readRaw returns {meta, filename, content}', jsonlSrc.includes('filename: "session.jsonl"') && jsonlSrc.includes('content'))

// ---- dsh-session-projection：预热依赖 ----
const projSrc = src('dsh-session-projection')
check('registry internals (registrations/cells WeakMap/cellFor/buildCell) present',
  ['registrations = ', 'cells: ', 'new WeakMap()', 'cellFor', 'buildCell', 'stateVersion'].every((m) => projSrc.includes(m)))

// ---- dsh-session-projection-cache：回填/补行依赖 ----
const cacheSrc = src('dsh-session-projection-cache')
// alpha.5：putSoft(id, identity, rows, what) → put(id, identity, rows)；identity
// 含 isSeeded/inheritedEventCount（identityOf）
check('cache API (recordFor/write/put) present',
  ['recordFor(id, expected)', 'async write(session)', 'async put(id, identity, rows)'].every((m) => cacheSrc.includes(m)))
check('cache identity carries isSeeded/inheritedEventCount (alpha.5)',
  cacheSrc.includes('identityOf(header, inheritedEventCount)') && cacheSrc.includes('isSeeded: header.isSeeded'))
check('SessionLogOffset imported into cache package', cacheSrc.includes('SessionLogOffset'))

// ---- 动态导出检查 ----
const dshSession = await import('@deepseek-ai/dsh-session')
check('packChunkRuns exported', typeof dshSession.packChunkRuns === 'function')

console.log(failures === 0 ? (warns > 0 ? `\nALL PASS (${warns} warning(s))` : '\nALL PASS') : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
