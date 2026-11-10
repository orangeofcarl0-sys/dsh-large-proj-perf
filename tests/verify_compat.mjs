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
const KNOWN_VERSIONS = ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2', '0.1.2-alpha.5', '0.1.2-rc.1', '0.1.3-alpha.2', '0.1.5-alpha.1', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-rc.1']
console.log(`dsh version: ${dshPkg.version} (root: ${dshRoot})`)
if (!KNOWN_VERSIONS.includes(dshPkg.version)) {
  warn(`dsh ${dshPkg.version} not in known list ${KNOWN_VERSIONS.join('/')}`, 'verify compatibility manually')
}

const src = (pkg, file) => readFileSync(join(dshRoot, 'node_modules', '@deepseek-ai', pkg, file ?? 'lib/index.js'), 'utf8')

// ---- dsh-session：fork 通道（零拷贝 fork 依赖） ----
const sessionSrc = src('dsh-session')
check('fork source present', sessionSrc.includes('fork(source, boundary, childSessionId)'))
// fork 内部结构：0.1.7+ = _resolveForkSource + _forkBoundary + 模块级
// buildForkSeed（含 marker 注入与 openTurnClosers）；0.1.3–0.1.5 = _forkSeed
const forkInternalsNew = ['_resolveForkSource', '_forkBoundary', 'prepare(id, options)', 'enter(', 'announce('].every((m) => sessionSrc.includes(m))
  && sessionSrc.includes('function buildForkSeed')
const forkInternalsLegacy = ['_resolveForkSource', '_forkSeed', 'prepare(id, options)', 'enter(', 'announce('].every((m) => sessionSrc.includes(m))
check('fork internals present (0.1.7 forkBoundary+buildForkSeed, or legacy forkSeed)',
  forkInternalsNew || forkInternalsLegacy,
  forkInternalsNew ? '(0.1.7 protocol)' : forkInternalsLegacy ? '(legacy protocol)' : '')
// 0.1.3：create(childId, {eventState}) 是 fromRestore 零拷贝通道的公开入口
check('restore channel (eventState shared-frozen -> fromRestore) present',
  sessionSrc.includes('case "shared-frozen"') && sessionSrc.includes('Session.fromRestore'))
check('create(id, options) convenience present (0.1.3 fork path)',
  sessionSrc.includes('create(id, options)') && sessionSrc.includes('this.prepare(id, options)'))
check('restored header validation present', sessionSrc.includes('validateRestoredSessionHeader'))
// fork 的 meta 字段集：cut 走 options.inheritedEventCount，isSeeded 恒有；
// parentSession 在 0.1.7–0.2.1 由原生设置、0.2.2 起移除。插件必须按原生行为
// 对齐（否则同一版本内「走零拷贝」与「回退原生」产出的 header 不同）。
const nativeSetsParent = sessionSrc.includes('parentSession: liveSource.id')
check('native fork meta keeps isSeeded', sessionSrc.includes('isSeeded: true'))
const forkPatchSrc = readFileSync(new URL('../lib/patches/zero-copy-fork.js', import.meta.url), 'utf8')
check('fork patch aligns parentSession with native behavior',
  forkPatchSrc.includes('nativeSetsParentSession')
    && forkPatchSrc.includes("forkSource.includes('parentSession: liveSource.id')"),
  nativeSetsParent ? `native sets it (dsh ${dshPkg.version})` : `native omits it (dsh ${dshPkg.version}); patch omits too`)
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
// 0.1.3 起 identity 额外要求 formatVersion —— 插件写入的行必须带该字段，
// 否则只能当 title 前驱提示（补行/基线的折叠短路资格静默失效）
check('cache identity requires formatVersion (fold-shortcut gate)',
  cacheSrc.includes('stored.formatVersion === expected.formatVersion'))
check('SessionLogOffset imported into cache package', cacheSrc.includes('SessionLogOffset'))

// ---- 动态导出检查 ----
const dshSession = await import('@deepseek-ai/dsh-session')
check('SessionLogOffset exported at runtime', typeof dshSession.SessionLogOffset === 'function')
// 0.1.7+：零拷贝 fork 依赖 buildForkSeed（模块级导出）；旧版本无此导出属正常
if (typeof dshSession.buildForkSeed !== 'function') {
  check('buildForkSeed export (0.1.7 fork-seed protocol)', forkInternalsLegacy && !forkInternalsNew,
    '(absent but legacy protocol present → zero-copy uses legacy branch)')
} else {
  check('buildForkSeed export (0.1.7 fork-seed protocol)', typeof dshSession.buildForkSeed === 'function')
}
// 格式版本探针：升级时用于感知格式线变化（当前 4；v2/v3/v4 的 cut 语义一致）
check('SESSION_FORMAT_VERSION exposed (format probe)', typeof dshSession.SESSION_FORMAT_VERSION === 'number',
  `v${dshSession.SESSION_FORMAT_VERSION}`)

// ---- 插件契约：dsh 版本门禁自检 ----
// 0.2.0 起，profile bundle 加载前校验插件 package.json 的 peerDependencies 中所有
// `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 项；0.2.1 起新增 `engines.dsh` 且它
// **独占生效**——声明了就只看它，peer 范围被完全忽略。这里优先用 dsh 自带的
// evaluatePluginCompatibility 实算（与宿主同一份实现），拿不到时用 semver 离线
// 复算同一规则：不满足即重启后插件被静默跳过（`skipping profile bundle`）。
const pluginPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const enginesDsh = typeof pluginPkg.engines?.dsh === 'string' ? pluginPkg.engines.dsh : undefined
const dshPeers = Object.entries(pluginPkg.peerDependencies ?? {})
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
check('plugin contract: declares a dsh requirement (engines.dsh or dsh peers)',
  enginesDsh !== undefined || dshPeers.length > 0,
  enginesDsh !== undefined
    ? `engines.dsh@${enginesDsh} (peer range ignored by 0.2.1+)`
    : dshPeers.map(([n, r]) => `${n}@${r}`).join(', '))

let gate = null
try { gate = await import('@deepseek-ai/dsh-app-boot') } catch { /* 旧版本无该导出 */ }
if (gate !== null && typeof gate.evaluatePluginCompatibility === 'function') {
  const issue = gate.evaluatePluginCompatibility(pluginPkg, {}, dshPkg.version)
  check('plugin contract: real evaluatePluginCompatibility accepts runtime', issue === undefined,
    issue === undefined ? `dsh ${dshPkg.version} accepted` : `WOULD BE SKIPPED: ${JSON.stringify(issue.requirements)}`)
} else {
  let semver = null
  try { semver = createRequire(join(dshRoot, 'package.json'))('semver') } catch { /* 缺失则跳过复算 */ }
  if (semver !== null) {
    const ranges = enginesDsh !== undefined ? [['engines.dsh', enginesDsh]] : dshPeers
    const mismatched = ranges.filter(([, range]) => !semver.satisfies(dshPkg.version, range, { includePrerelease: true }))
    check('plugin contract: declared dsh requirement satisfies runtime version', mismatched.length === 0,
      mismatched.length === 0 ? `dsh ${dshPkg.version} within declared range` : `WOULD BE SKIPPED: ${mismatched.map(([n, r]) => `${n}@${r}`).join(', ')}`)
  }
}

// ---- 插件清单规范：bundle 声明 + 展示元数据 ----
// 加载侧只认 dsh.bundle.patch；展示侧读 icon 与 <pkg>/locale/{en,zh}.json，
// 且这些子路径必须在 exports 中显式暴露，否则宿主经 Node 解析读不到。
const patchDecl = pluginPkg.dsh?.bundle?.patch
check('plugin manifest: dsh.bundle.patch declared (load path)', typeof patchDecl === 'string' || Array.isArray(patchDecl),
  Array.isArray(patchDecl) ? patchDecl.join(', ') : String(patchDecl))
const pluginRoot = new URL('../', import.meta.url)
const localeFiles = ['locale/en.json', 'locale/zh.json']
const missingLocale = localeFiles.filter((f) => {
  try { JSON.parse(readFileSync(new URL(f, pluginRoot), 'utf8')); return false } catch { return true }
})
check('plugin manifest: bilingual locale metadata parses', missingLocale.length === 0,
  missingLocale.length === 0 ? localeFiles.join(', ') : `missing/invalid: ${missingLocale.join(', ')}`)
check('plugin manifest: exports locale subpath (host resolution)',
  pluginPkg.exports?.['./locale/*.json'] !== undefined)
check('plugin manifest: exports cordis.patch.yml subpath',
  pluginPkg.exports?.['./cordis.patch.yml'] !== undefined)
if (gate !== null && typeof gate.readPluginMeta === 'function') {
  const meta = gate.readPluginMeta(pluginPkg.name, pluginRoot.href)
  check('plugin manifest: host readPluginMeta resolves title/description/icon',
    meta !== undefined && meta.error === undefined
      && meta.title?.en !== undefined && meta.description?.zh !== undefined
      && typeof meta.icon === 'string' && meta.icon.startsWith('data:image/'),
    meta?.error ?? `title.en=${meta?.title?.en ?? 'MISSING'}`)
}

// 依赖声明自检：运行期真实 import 的包必须被声明。cordis 是宿主提供的单例，
// 按官方惯例放 peerDependencies；schemastery 是普通运行时依赖，放 dependencies
// （参照官方 dsh-plugin-manager）。两者漏声明都会导致「能跑但能力静默降级」。
check('plugin manifest: declares schemastery (runtime import in config.js)',
  typeof pluginPkg.dependencies?.['@deepseek-ai/schemastery'] === 'string',
  pluginPkg.dependencies?.['@deepseek-ai/schemastery'] ?? 'MISSING')
check('plugin manifest: cordis declared as peer (host singleton)',
  typeof pluginPkg.peerDependencies?.['@deepseek-ai/cordis'] === 'string'
    && pluginPkg.dependencies?.['@deepseek-ai/cordis'] === undefined,
  pluginPkg.peerDependencies?.['@deepseek-ai/cordis'] ?? 'MISSING')

// config.set 的请求体契约：扁平「键 → 值」对象。若改成 {key,value} 形式或反过来，
// 调用方会静默失效（接口总是 200），所以用断言把契约钉在代码形状上。
const apiSrc = readFileSync(new URL('../lib/api.js', import.meta.url), 'utf8')
check('api contract: config.set accepts a flat key/value body',
  /for \(const key of Object\.keys\(DEFAULT_CONFIG\)\)/.test(apiSrc)
    && /if \(key in payload\) setConfigValue\(key, payload\[key\]\)/.test(apiSrc))

// 运行时观测面契约（见 docs/RUNTIME-ANALYSIS.md）：
// - debug.fork 必须由 debugApi 把关，默认关闭；
// - stats 必须有 alreadyHot 计数，否则「上游已建满 cell」会被误读成预热成功；
// - 预热对已存在的 cell 必须返回 hot 而不是 skip（区分「别人折完」与「无事可做」）。
const warmupSrc = readFileSync(new URL('../lib/warmup.js', import.meta.url), 'utf8')
const statsSrc = readFileSync(new URL('../lib/stats.js', import.meta.url), 'utf8')
check('runtime probe: debug.fork is gated by debugApi',
  apiSrc.includes("method === 'debug.fork'") && apiSrc.includes('config.debugApi'))
check('runtime probe: stats counts alreadyHot sessions',
  statsSrc.includes('alreadyHot: 0') && warmupSrc.includes('stats.alreadyHot += 1'))
check('runtime probe: warmup labels pre-built cells as hot, not skip',
  warmupSrc.includes("status: 'hot'") && warmupSrc.includes("outcome.status === 'hot'"))

// config 的环境变量覆盖（离线测量用）：必须由 DEFAULT_CONFIG 键驱动，不另立清单。
const configSrc = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')
check('config: env override is derived from DEFAULT_CONFIG keys',
  configSrc.includes('DSH_PERF_') && /for \(const key of Object\.keys\(DEFAULT_CONFIG\)\)/.test(configSrc))

// ---- 冷读回写（v1.7）----
// 依据：dsh 0.2.2 的冷读回写路径 sessionProjectionCache.coldSnapshot() 无任何
// 生产调用点（全安装包只有定义 + tool-cordis 的 API 目录快照），所以冷读永不
// 回写、缓存行只能靠 live 的 checkpoint 维护。
//
// 但实测证明「有缓存行也不快」（场景 G：19.1s vs 18.9s），所以本能力默认关。
// 这些断言锁三件事：
//   1. 挂载点仍然存在（上游改名 → 插件静默 inactive，需要提前知道）；
//   2. 默认值必须是 false（无收益却写 10MB 的能力不能默认开）；
//   3. 上游 coldSnapshot 仍无生产调用者（若上游自己接上，本能力应退役）。
check('cold write-back: hydratePrepared exists on cache (mount point)',
  cacheSrc.includes('hydratePrepared(session, events)'))
check('cold write-back: registry.hydrate is what gives us warm cells',
  projSrc.includes('hydrate(session, checkpoint, events, baseSeq)'))
check('cold write-back: upstream coldSnapshot still has no production caller',
  !/\.coldSnapshot\(/.test(src('dsh-session-query')) && !/\.coldSnapshot\(/.test(src('dsh-api-session-controller')),
  'plugin capability is worth keeping')
check('cold write-back: defaults to false (measured no speedup, writes ~10MB)',
  /coldWriteBack:\s*false/.test(configSrc))
// 共享 identity 构造器：字段顺序与条件展开必须与上游 identityOf 逐字一致，
// 否则缓存行永久失配（历史上有两份手抄副本漂移的风险）。
check('cache identity: upstream identityOf shape unchanged',
  cacheSrc.includes('formatVersion: header.version')
    && cacheSrc.includes('...header.cwd === void 0 ? {} : { cwd: header.cwd }')
    && /isSeeded: header\.isSeeded/.test(cacheSrc))
const identitySrc = readFileSync(new URL('../lib/cache-identity.js', import.meta.url), 'utf8')
check('cache identity: single shared constructor (no duplicates in lib/)',
  identitySrc.includes('export function makeCacheIdentity')
    && !readFileSync(new URL('../lib/warmup.js', import.meta.url), 'utf8').includes('formatVersion: header?.version')
    && !readFileSync(new URL('../lib/backfill.js', import.meta.url), 'utf8').includes('formatVersion: meta.version'))

console.log(failures === 0 ? (warns > 0 ? `\nALL PASS (${warns} warning(s))` : '\nALL PASS') : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
