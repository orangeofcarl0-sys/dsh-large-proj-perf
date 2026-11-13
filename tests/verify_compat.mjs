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

// 插件开发/验证过的版本（与 lib/runtime.js 的 KNOWN_DSH_VERSIONS 保持一致，
// 且必须落在 engines.dsh 声明的范围内）；不在列表里打 WARN（结构断言照跑，人工确认兼容性）
const KNOWN_VERSIONS = ['0.2.2-rc.1', '0.2.2-rc.2']
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

// ---- 已验版本清单与声明范围的一致性 ----
// 两处清单（lib/runtime.js 的 KNOWN_DSH_VERSIONS 与本文件的 KNOWN_VERSIONS）必须
// 完全相同，否则「实测过」与「运行时告警」会给出互相矛盾的判断。此外每条都必须
// 落在 engines.dsh 内——新版 dsh 被实测通过、却忘了同步 engines.dsh 时，宿主门禁
// 会直接跳过加载，而运行时清单还在说「已验证」。
const runtimeMod = await import('../lib/runtime.js')
const runtimeKnown = runtimeMod.KNOWN_DSH_VERSIONS
check('verified list: lib/runtime.js and tests/verify_compat.mjs agree',
  runtimeKnown.length === KNOWN_VERSIONS.length && runtimeKnown.every((v) => KNOWN_VERSIONS.includes(v)),
  `runtime=[${runtimeKnown.join(',')}] test=[${KNOWN_VERSIONS.join(',')}]`)

let semverForList = null
try { semverForList = createRequire(join(dshRoot, 'package.json'))('semver') } catch { /* 缺失则跳过 */ }
if (semverForList !== null && enginesDsh !== undefined) {
  const outside = runtimeKnown.filter((v) => !semverForList.satisfies(v, enginesDsh, { includePrerelease: true }))
  check('verified list: every verified version falls inside engines.dsh',
    outside.length === 0,
    outside.length === 0 ? `${runtimeKnown.length} 个版本都在 ${enginesDsh} 内` : `OUTSIDE ${enginesDsh}: ${outside.join(', ')}`)
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
// - debug.fork 必须由 debugApi 把关，默认关闭。
// （v1.10.0 移除了分片预热能力，对应的 alreadyHot / hot 状态断言已删除。
//   历史实测数据仍保留在 docs/RUNTIME-ANALYSIS.md 的场景 C。）
const statsSrc = readFileSync(new URL('../lib/stats.js', import.meta.url), 'utf8')
check('runtime probe: debug.fork is gated by debugApi',
  apiSrc.includes("method === 'debug.fork'") && apiSrc.includes('config.debugApi'))
check('stats: keeps the retired status (upstream-absorbed capability must be expressible)',
  statsSrc.includes('retired'))

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
    && !readFileSync(new URL('../lib/backfill.js', import.meta.url), 'utf8').includes('formatVersion: meta.version'))

// ---- turnOutline 折叠加速（v1.8）----
// 上游的 apply 每次 turn 都整数组复制（`[...state.turns, x]` 与
// `[...state.turns.slice(0, -1), y]`），N 个 turn 是 O(N²)：实测 2 万 turn 时
// 比线性版慢 700 倍，占 24 万事件冷读 21 秒里的 16 秒（76%）。
// 插件用 O(N) 等价 fold 替换它。这里锁三件事：
//   1. 上游确实还是那个二次实现（若改成线性，本能力该退役）；
//   2. 我们的 preview 与上游逐字一致（prompt/response 会进缓存与 wire）；
//   3. 探针式等价校验存在（拿不到原始源码，只能运行时比对）。
const turnOutlineSrc = src('dsh-session-turn-outline')
check('turnOutline: upstream apply is still quadratic (mirrors both array copies)',
  turnOutlineSrc.includes('turns: [...state.turns, {')
    && turnOutlineSrc.includes('turns: [...state.turns.slice(0, -1), {'),
  'if upstream goes linear, fastTurnOutline should retire')
check('turnOutline: preview limits unchanged (50 prompt / 120 response)',
  turnOutlineSrc.includes('PROMPT_PREVIEW_LIMIT = 50')
    && turnOutlineSrc.includes('RESPONSE_PREVIEW_LIMIT = 120'))
const fastTurnSrc = readFileSync(new URL('../lib/fast-turn-outline.js', import.meta.url), 'utf8')
check('turnOutline: fast fold mirrors the same preview limits',
  fastTurnSrc.includes('PROMPT_PREVIEW_LIMIT = 50') && fastTurnSrc.includes('RESPONSE_PREVIEW_LIMIT = 120'))
check('turnOutline: install is gated by a runtime equivalence probe',
  fastTurnSrc.includes('buildEquivalenceProbe') && fastTurnSrc.includes('probeEqual'))
check('turnOutline: def.apply is a forwarding wrapper (no raw source available)',
  // 记录这个事实：投影注册表把 definition.apply 包成
  // `(state, event) => definition.apply(state, event)`，所以插件拿不到原始源码、
  // 无法用特征串校验——这正是必须用运行时等价探针的原因。
  projSrc.includes('apply: (state, event) => definition.apply(state, event)'))

// ---- 内存预算（v1.9）----
// 依据：dsh 的事件缓存全部按「会话条数」限容，没有一处按字节。实测一份 24 万
// 事件树占 87.7 MB，连开 6 个 18 MB 会话 RSS 涨 821 MB。插件给它们加字节预算。
// 这些断言锁住：两处缓存的可达路径、以及淘汰判据（只删 refs===0）。
const querySrc = src('dsh-session-query')
check('memory budget: observation cache reachable via _observations.cache',
  querySrc.includes('_observations = new SessionObservationReader')
    && querySrc.includes('cache = /* @__PURE__ */ new Map()'))
check('memory budget: eviction upstream only counts entries, not bytes',
  // 上游 evictPastCapacity 的判据是 `cache.size <= cacheCapacity`——正是我们要补的缺口。
  /evictPastCapacity\(keep\)\s*\{\s*if \(this\.cache\.size <= this\.cacheCapacity\) return/.test(querySrc.replace(/\n\s*/g, ' ')))
check('memory budget: cold log memo is also entry-count bounded',
  cacheSrc !== undefined && src('dsh-session-persistence-jsonl').includes('COLD_LOG_MEMO_MAX_ENTRIES = 2'))
const memBudgetSrc = readFileSync(new URL('../lib/memory-budget.js', import.meta.url), 'utf8')
const constantsSrc = readFileSync(new URL('../lib/constants.js', import.meta.url), 'utf8')
check('memory budget: plugin only evicts unpinned entries (refs === 0)',
  memBudgetSrc.includes('candidate?.refs > 0') && memBudgetSrc.includes('continue'))
check('memory budget: defaults to 512 MiB, 0 disables',
  // 默认值住在 constants.js（具名常量），config.js 引用它；0 关闭的分支在模块里。
  /DEFAULT_MEMORY_BUDGET_BYTES = 536870912/.test(constantsSrc)
    && configSrc.includes('memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES')
    && memBudgetSrc.includes("setPatchStatus('memoryBudget', 'off')"))

// ---- 客户端 bundle 清单（v1.12）----
// dsh 的 client-modules 会读 dsh.client，并要求 exports["./client"] 指向真实文件。
// **文件缺失会让整个 clientModules 服务启动失败**（不是降级），所以这里既查声明
// 也查文件内容，缺一不可。
const clientRel = typeof pluginPkg.exports?.['./client'] === 'string'
  ? pluginPkg.exports['./client']
  : pluginPkg.exports?.['./client']?.default
check('client manifest: dsh.client.platform is web',
  pluginPkg.dsh?.client?.platform === 'web', String(pluginPkg.dsh?.client?.platform))
check('client manifest: exports "./client" points at a bundle',
  typeof clientRel === 'string' && clientRel.startsWith('./'), String(clientRel))
if (typeof clientRel === 'string' && clientRel.startsWith('./')) {
  let clientSrc = ''
  try { clientSrc = readFileSync(new URL(clientRel, pluginRoot), 'utf8') } catch { clientSrc = '' }
  check('client manifest: the declared bundle exists (missing file breaks clientModules)',
    clientSrc !== '', clientRel)
  check('client manifest: bundle registers through the module loader',
    clientSrc.includes('__ModuleLoader__.load('), 'classic script + lazy factory')
  check('client manifest: bundle declares the same id as the package',
    clientSrc.includes(`'dsh-large-proj-perf'`), 'dsh-large-proj-perf')
  check('client manifest: bundle exports a factory returning apply()',
    /factory:\s*function/.test(clientSrc) && /apply:\s*function/.test(clientSrc))
  check('client manifest: bundle gates every UI change on host config',
    // 界面改动只在 clientContainment 明确为 true 时启用；采集器默认开装、
    // 配置未开启 renderTiming 就整体拆除。
    clientSrc.includes('config.clientContainment === true')
      && clientSrc.includes('config.renderTiming !== true'))
  check('client manifest: collector reads spec LoAF blockingDuration',
    clientSrc.includes('blockingDuration'), 'falls back to duration-50 only when absent')
  check('client manifest: exposes the diagnostic entrypoint',
    clientSrc.includes('window.__dshPerf = api'))
  check('client manifest: labels logical streams through $stream',
    clientSrc.includes("ctx.get('remote')") && clientSrc.includes('original.call(this, wrapped)'))
  check('client manifest: tracks jump and scroll windows',
    clientSrc.includes("kind: 'jump'") && clientSrc.includes("kind: 'scroll'")
      && clientSrc.includes('data-chat-history'))
  check('client manifest: records WS frame arrival for the transport split',
    clientSrc.includes('remote.streams') && clientSrc.includes('frameArrivalMs')
      && clientSrc.includes('addEventListener(\'message\', onFrame)'))
  check('client manifest: exposes jumpToTurn and the markdown benchmark',
    clientSrc.includes('jumpToTurn: function') && clientSrc.includes('benchMarkdown: function'))
  check('client manifest: markdown benchmark uses the seeded primitives',
    clientSrc.includes("require('@deepseek-ai/dsh-client-ui-primitives')")
      && clientSrc.includes('extractMarkdownPlainText') && clientSrc.includes('FenceMathBlock')
      && clientSrc.includes('useCodeHighlighter'))
}

// ---- 渲染链路上游形状（docs/RENDER-ANALYSIS.md 的静态前提）----
// 这些断言的作用不是「验证插件」，而是**锁住分析结论所依赖的上游事实**：
// 一旦上游做了虚拟化或加了字节上限，本插件的渲染相关能力就该退役。
const chatFlowSrc = src('dsh-client-ui-chat', 'src/client/chat/ChatFlow.tsx')
check('render: chat flow still maps every entry (no virtualization to exploit)',
  chatFlowSrc.includes('entries.map(') && !chatFlowSrc.includes('useVirtualizer'))
const uiChatCss = src('dsh-client-ui-chat', 'src/client/chat/ChatView.module.css')
check('render: row wrapper has no content-visibility upstream',
  !uiChatCss.includes('content-visibility'),
  'plugin injects it client-side only')
const historySrc = src('dsh-api-session-controller', 'src/history.ts')
check('render: pagination is still message-count only (no byte cap)',
  historySrc.includes('export function paginate(') && !historySrc.includes('maxPageBytes'),
  'plugin adds the byte/count budget')
const sessionClientSrc = src('dsh-api-session-controller', 'src/client/sessions/session.ts')
check('render: first page is still 500 messages',
  /HISTORY_PAGE_OPTIONS = \{ maxMessages: 500/.test(sessionClientSrc),
  'plugin can clamp it via maxInitialMessages')
check('render: projection snapshot is still synchronous (timing point is safe to wrap)',
  /snapshot\(\s*session: Session,\s*keys\?: ProjectionKeySelection,?\s*\): ProjectionSnapshot/.test(
    src('dsh-session-projection', 'src/index.ts').replace(/\n\s*/g, ' ')))

// ---- 渲染归因所依赖的上游形状（v1.13）----
// 这些是「分段计时 / 跳转 / 滚动」三类测量的前提。上游一旦改名或改结构，
// 对应采集就应降级为 streams:null / 只测 DOM，而不是猜。
const journalSrc = src('dsh-api-gateway', 'src/client/journal-stream.ts')
check('render attribution: logical streams carry a name and an opener',
  journalSrc.includes('name: options.name') && journalSrc.includes('open: signal =>'),
  'client wraps $stream to label session event vs control streams')
const controlSrc = src('dsh-api-session-controller', 'src/client/transport.ts')
check('render attribution: control and event streams have distinct names',
  controlSrc.includes("'session event stream'") && controlSrc.includes("'session control stream'"))
check('render attribution: loadThrough still publishes the whole prefix once',
  sessionClientSrc.includes('prependWindow(pending.pages.reverse().flat()'),
  'server-side burst detection mirrors this single-publish shape')
check('render attribution: history status is exposed on the DOM',
  src('dsh-client-ui-chat', 'src/client/chat/ChatView.tsx').includes('data-chat-history'))
check('render attribution: turn marks expose aria-busy while jumping',
  src('dsh-client-ui-chat', 'src/client/chat/TurnNavigator.tsx').includes('aria-busy'))
check('render attribution: the scroll container is a stable attribute',
  src('dsh-client-ui-conversation', 'src/client/skeleton/ConversationContent.tsx').includes('data-conversation-scroll'))

// ---- 传输分段所依赖的上游形状（v1.14）----
// 帧到达时间戳靠 `remote.streams.socket`（TS private，运行时是普通属性）；
// 响应腿再拆 encode 靠 stream-server 的 stringify + 串行写队列。
const streamClientSrc = src('dsh-api-gateway', 'src/client/stream-client.ts')
check('render attribution: the mux socket is a plain runtime property',
  streamClientSrc.includes('this.socket = socket'), 'plugin attaches a message listener')
check('render attribution: frames are received synchronously from the socket listener',
  streamClientSrc.includes("addEventListener(\"message\", received)") || streamClientSrc.includes("addEventListener('message', received)"),
  'frame -> item is microtasks only')
const streamServerSrc = src('dsh-api-gateway', 'src/stream-server.ts')
check('render attribution: the server stringifies and serializes writes per item',
  streamServerSrc.includes('JSON.stringify(message)') && streamServerSrc.includes('this.writes = delivery'),
  'encode bucket is measurable out of band')




console.log(failures === 0 ? (warns > 0 ? `\nALL PASS (${warns} warning(s))` : '\nALL PASS') : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
