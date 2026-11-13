// dsh-large-proj-perf — host half（编排层）
//
// DSH 大会话性能插件：消除 fork / 历史加载 / 落盘对超大会话（数十万事件）的
// 事件循环阻塞与内存膨胀。实测数据见 docs/MEASUREMENTS.md 与
// docs/RENDER-ANALYSIS.md。
//
// 当前能力（按实测收益排序）：
//   turnOutline 折叠加速  —— 把该单元的 O(n²) fold 换成 O(n)，冷读 21.2s → 3.0s
//   事件缓存字节预算      —— dsh 的缓存只按条数限容，补上字节维度
//   分片 materialize      —— 多帧 zstd，消除单巨字符串 / RangeError
//   零拷贝 fork           —— 只对直接调 SessionStore.fork 的宿主有效
//   历史窗口预算          —— 首屏条数 / 单页字节上限（默认关，见 RENDER-ANALYSIS）
//   渲染耗时诊断          —— 服务端分页计时 + 浏览器长任务/首行时间（默认关）
//   冷会话补行            —— 启动后补跑冷会话的投影缓存（默认关）
//   冷读回写              —— 冷读后写缓存行（默认关，实测无耗时收益）
//   heap 上限告警         —— 启动期检查
//
// 安全性：所有补丁带源码特征校验（不符自动跳过并告警，绝不盲补）；三层回退
// （能力探测 / try-catch / 配置开关）；dispose 完整还原。
//
// 本文件只做装配与生命周期；各能力实现见 lib/ 下的模块。

import { getHeapStatistics } from 'node:v8'

import { BACKFILL_DELAY_MS } from './constants.js'
import { createDeps, createRuntime } from './context.js'
import { KNOWN_DSH_VERSIONS, makeLogger, probeDshVersion, safeGet, sessionEventsOf, sessionLogOffset } from './runtime.js'
import { makeYieldLoop } from './yield.js'
import { createConfig, registerSettings } from './config.js'
import { makeCacheIdentity } from './cache-identity.js'
import { createRecorders, createStats } from './stats.js'
import { install as installZeroCopyFork } from './patches/zero-copy-fork.js'
import { install as installChunkedMaterialize } from './patches/chunked-materialize.js'
import { createBackfill } from './backfill.js'
import { installColdWriteBack } from './cold-writeback.js'
import { installTurnOutlineFastFold } from './fast-turn-outline.js'
import { installMemoryBudget } from './memory-budget.js'
import { installRenderTiming } from './render-timing.js'
import { installHistoryBudget } from './history-budget.js'
import { installApi } from './api.js'

export const name = 'dsh-large-proj-perf'
export const inject = ['sessions']

export function apply(ctx) {
  const disposers = []
  const { config, setConfigValue } = createConfig()
  const stats = createStats()
  const { log, logErr } = makeLogger(ctx)
  const { setPatchStatus, recordFork } = createRecorders(stats, config, log)

  // 装配上下文：`deps` 是构造时全部就绪的只读依赖（各模块拿它）；
  // `runtime` 是晚绑定槽（只有 api.js 需要，且在**调用时**取值）。
  // 详见 context.js 里记录的晚绑定 bug。
  const deps = createDeps({
    ctx, config, stats, log, logErr, disposers,
    safeGet, sessionEventsOf, sessionLogOffset,
    cacheIdentityOf: makeCacheIdentity(sessionLogOffset),
    yieldLoop: makeYieldLoop(config),
    setConfigValue, setPatchStatus, recordFork,
  })
  const runtime = createRuntime()

  // 版本探针：启动即探测 dsh 版本。列表内 → 确认日志；列表外 → 告警提示
  // 跑 verify_compat（补丁特征校验会自动跳过优化，但会静默失效）。
  const dshVersion = probeDshVersion()
  stats.dshVersion = dshVersion ?? null
  if (dshVersion === void 0) {
    log('dsh version: unknown (probe failed; patches rely on source-signature checks)')
  } else if (KNOWN_DSH_VERSIONS.includes(dshVersion)) {
    log(`dsh version: ${dshVersion} (verified)`)
  } else {
    logErr(`dsh version: ${dshVersion} NOT in verified list (${KNOWN_DSH_VERSIONS.join('/')}); run tests/verify_compat.mjs and check startup logs for signature mismatch`)
  }

  registerSettings(ctx, config, setConfigValue, { logErr }, disposers)

  // heap 上限检测：--max-old-space-size 是 V8 启动期参数，进程内无法改；低于
  // 阈值时告警，引导用 scripts/start-dsh.ps1（内置 8192MB）或加参数重启。
  try {
    const limit = getHeapStatistics().heap_size_limit
    if (limit > 0 && limit < config.heapWarnBytes) {
      log(`WARNING: V8 heap limit is ${(limit / 1048576).toFixed(0)}MB (< ${(config.heapWarnBytes / 1048576).toFixed(0)}MB). Large sessions may OOM. Restart with: node --max-old-space-size=8192 .../bin.js web`)
    } else if (limit > 0) {
      log(`V8 heap limit: ${(limit / 1048576).toFixed(0)}MB (ok)`)
    }
  } catch { /* 忽略 */ }

  // ---------- 补丁安装 ----------
  installZeroCopyFork(deps)

  // sessionPersistence / webServer / 各投影服务都是懒装配：已就绪直接装，
  // 未就绪经 ctx.inject 等就绪后再装。
  const installPersistenceSide = (sub) => {
    const subDeps = withCtx(deps, sub)
    Promise.resolve(installChunkedMaterialize(subDeps))
      .catch((e) => logErr(`chunked materialize install failed: ${String(e?.message ?? e)}`))
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionPersistence'], installPersistenceSide)
    // api.js 拿 runtime 以便在调用时取 backfill 句柄（晚绑定）。
    ctx.inject(['webServer'], (sub) => installApi(withCtx(deps, sub), runtime))
    ctx.inject(['sessionProjectionCache'], (sub) => installColdWriteBack(withCtx(deps, sub)))
    // turnOutline 折叠加速必须在任何 fold 之前装上，所以走懒装配。
    ctx.inject(['sessionProjections'], (sub) => installTurnOutlineFastFold(withCtx(deps, sub)))
    // 内存预算：需要 sessionQuery（事件缓存）与 sessionPersistence（coldLogMemo）。
    ctx.inject(['sessionQuery'], (sub) => installMemoryBudget(withCtx(deps, sub)))
    // 渲染诊断与窗口预算：都挂在 sessionController 的分页入口上。
    // **顺序有意义**：先装计时（内层），再装预算（外层）——这样计时记录到的是
    // 截断之后的真实请求，而不是客户端原始请求。两者必须在同一个 inject
    // 回调里按序安装；拆成两个 inject 无法保证回调先后。
    ctx.inject(['sessionController', 'sessionProjections'], (sub) => {
      const subDeps = withCtx(deps, sub)
      installRenderTiming(subDeps)
      installHistoryBudget(subDeps)
    })
  } else {
    installPersistenceSide(ctx)
    installApi(deps, runtime)
    installColdWriteBack(deps)
    installTurnOutlineFastFold(deps)
    installMemoryBudget(deps)
    installRenderTiming(deps)
    installHistoryBudget(deps)
  }

  // ---------- 冷会话补行（默认关）----------
  const backfill = createBackfill(deps)
  const backfillTimer = setTimeout(() => {
    backfill.markFired()
    Promise.resolve(backfill.backfillColdSessions())
      .catch((e) => logErr(`backfill scan failed: ${String(e?.message ?? e)}`))
  }, BACKFILL_DELAY_MS)
  if (typeof backfillTimer.unref === 'function') backfillTimer.unref()
  disposers.push(() => clearTimeout(backfillTimer))
  // 登记到 runtime：api.js 的 config.set 在**调用时**取它（晚绑定），
  // 这样「启动 15 秒后才打开 backfillOnBoot」也能补跑一次扫描。
  runtime.backfill.set({
    backfillColdSessions: backfill.backfillColdSessions,
    isFired: backfill.isFired,
  })

  log(`installed (zeroCopy=${config.zeroCopyFork}, chunkedMaterialize=${config.chunkedMaterialize}, fastTurnOutline=${config.fastTurnOutline}, memoryBudget=${config.memoryBudgetBytes > 0 ? `${(config.memoryBudgetBytes / 1048576).toFixed(0)}MB` : 'off'})`)

  return () => {
    runtime.backfill.clear()
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { logErr('dispose failed:', String(error?.message ?? error)) }
    }
    log('disposed')
  }
}

// 把一个懒装配得到的子上下文套进现有 deps，其余字段保持不变。
// 只替换 `ctx`——因为懒装配回调给的 `sub` 才能 get 到目标服务。
function withCtx(deps, sub) {
  return Object.freeze({ ...deps, ctx: sub })
}
