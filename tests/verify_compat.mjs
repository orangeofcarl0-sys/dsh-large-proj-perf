// 真实 dsh 源码特征验证：直接读取全局安装的 dsh 内部包源码，断言插件
// 依赖的全部结构/特征标记仍然存在。mock 测试验证的是逻辑正确性，本测试
// 验证的是「补丁能否装上」——dsh 升级后跑一次就知道哪些补丁会静默失效。
//
// 依赖 scripts/link-deps.ps1 建立的 junction（解析 @deepseek-ai/dsh-session）。
//
// 0.1.3 起 persistence 子系统重写：dsh-session-persistence 变为 contract
//（SessionPersistence 基类 + 错误 + 校验），JSONL 实现移入
// dsh-session-persistence-jsonl（handle 模型；格式 v0→v1→v2 迁移链；
// seed cut 由事件流尾 session/end-seed marker 表达，不再进 header 字段）。

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
const KNOWN_VERSIONS = ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2', '0.1.2-alpha.5', '0.1.2-rc.1', '0.1.3-alpha.2']
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
// 0.1.3：create(childId, {eventState}) 是 fromRestore 零拷贝通道的公开入口
check('restore channel (eventState shared-frozen -> fromRestore) present',
  sessionSrc.includes('case "shared-frozen"') && sessionSrc.includes('Session.fromRestore'))
check('create(id, options) convenience present (0.1.3 fork path)',
  sessionSrc.includes('create(id, options)') && sessionSrc.includes('this.prepare(id, options)'))
check('restored header validation present', sessionSrc.includes('validateRestoredSessionHeader'))
// fork 的 meta 字段集：cwd/parentSession/isSeeded（cut 走 options.inheritedEventCount）
check('native fork meta field set unchanged',
  sessionSrc.includes('parentSession: liveSource.id') && sessionSrc.includes('isSeeded: true'))
check('inheritedEventCount option + SessionLogOffset export present',
  sessionSrc.includes('inheritedEventCount') && sessionSrc.includes('SessionLogOffset'))
// 0.1.3 seed cut 由事件流尾 marker 表达（backfill 推导前提）
check('seed cut marker (session/end-seed inherited) present',
  sessionSrc.includes('append("session/end-seed", { inherited: true })'))
// live append 事件深冻结（shared-frozen 复用前提）
check('live events deep-frozen on append', sessionSrc.includes('const event = deepFreeze({'))

// ---- dsh-session-persistence（contract 层）：API 重写，initFor 消失 ----
const persistSrc = src('dsh-session-persistence')
check('contract layer exported (SessionPersistence base class)',
  persistSrc.includes('var SessionPersistence = class extends Service'))
check('legacy coordinator retired (no initFor/preparations in contract)',
  !persistSrc.includes('initFor') && !persistSrc.includes('SessionPreparations'))

// ---- dsh-session-persistence-jsonl：分片 materialize + 冷会话补行 ----
const jsonlSrc = src('dsh-session-persistence-jsonl')
check('encodeMaterialization signature markers present (0.1.3)',
  jsonlSrc.includes('encodeMaterialization(meta, inheritedEventCount, events)')
  && jsonlSrc.includes('const body = eventLines(events)')
  && jsonlSrc.includes('compressZstdFrame'))
check('encodeMaterialization header-only branch (patch reuses it)',
  jsonlSrc.includes('events.length === 0') && jsonlSrc.includes('compressZstdFrame(header)'))
check('encodeMaterialization delegates on compression=none', jsonlSrc.includes('this.compression === "none"'))
check('toHeaderLine takes inheritedEventCount', jsonlSrc.includes('toHeaderLine(header, inheritedEventCount)'))
// 物理 header 字段集：seedLength 已退役（HEADER_KEYS 不含），required 含 isSeeded
check('physical header keys exclude seedLength (format v2)',
  jsonlSrc.includes('"isSeeded"') && jsonlSrc.includes('"delegationDepth"') && !jsonlSrc.includes('"seedLength"'))
check('eventLines has no packChunkRuns (0.1.3 simple join)',
  jsonlSrc.includes('function eventLines(events)') && !jsonlSrc.includes('packChunkRuns'))
// 冷日志驻留上限（prepared-cache-trim 退役依据）
check('cold log memo capped (COLD_LOG_MEMO_MAX_ENTRIES = 2)',
  jsonlSrc.includes('COLD_LOG_MEMO_MAX_ENTRIES = 2'))
// 文件名规则（backfill 扫描依据）：v0=session.jsonl，vN=session.vN.jsonl，zstd 后缀
const formatSrc = src('dsh-session-format')
check('generation filename v0/vN rule present',
  formatSrc.includes('session.jsonl') && formatSrc.includes('session.v${generation}.jsonl'))
check('zstd artifact suffix .zstd', jsonlSrc.includes('".zstd"'))

// ---- dsh-session-projection：预热依赖 ----
const projSrc = src('dsh-session-projection')
check('registry internals (registrations/cells WeakMap/cellFor/buildCell) present',
  ['registrations = ', 'cells: ', 'new WeakMap()', 'cellFor', 'buildCell', 'stateVersion'].every((m) => projSrc.includes(m)))

// ---- dsh-session-projection-cache：回填/补行依赖 ----
const cacheSrc = src('dsh-session-projection-cache')
check('cache API (recordFor/write/put) present',
  ['recordFor(id, expected)', 'async write(session)', 'async put(id, identity, rows)'].every((m) => cacheSrc.includes(m)))
check('cache identity carries isSeeded/inheritedEventCount (alpha.5)',
  cacheSrc.includes('identityOf(header, inheritedEventCount)') && cacheSrc.includes('isSeeded: header.isSeeded'))
check('SessionLogOffset imported into cache package', cacheSrc.includes('SessionLogOffset'))

// ---- 动态导出检查 ----
const dshSession = await import('@deepseek-ai/dsh-session')
check('SessionLogOffset exported at runtime', typeof dshSession.SessionLogOffset === 'function')

console.log(failures === 0 ? (warns > 0 ? `\nALL PASS (${warns} warning(s))` : '\nALL PASS') : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
