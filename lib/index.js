// dsh-large-proj-perf — host half（编排层）
//
// DSH 大会话性能插件：消除 fork / 历史加载 / 落盘对超大会话（数十万事件）的
// 事件循环阻塞与 OOM。问题与方案细节、实测数据见 README。
//
//   A. fork 深拷贝      → 零拷贝 fork（fromRestore 通道）+ fast initFor
//   B. projection 冷折叠 → 分片预热（片间让出事件循环）+ fork 缓存回填
//   C. fork 全量序列化   → 分片 materialize（多帧 zstd）
//   D. 内存治理          → 冷会话 LRU 裁剪 + heap 上限检测
//
// 安全性：所有补丁带源码特征校验（不符自动跳过并告警，绝不盲补）；三层回退
// （能力探测 / try-catch / 配置开关）；dispose 完整还原；上游吸收某能力后对应
// 补丁自动退役（stats.patches 可见）。升级 dsh 后先跑 tests/verify_compat.mjs。
//
// 本文件只做装配与生命周期；各能力实现见 lib/ 下的模块。

import { getHeapStatistics } from 'node:v8'

import { KNOWN_DSH_VERSIONS, makeLogger, makeYieldLoop, probeDshVersion, safeGet, sessionEventsOf, sessionLogOffset } from './runtime.js'
import { createConfig, registerSettings } from './config.js'
import { createRecorders, createStats } from './stats.js'
import { install as installZeroCopyFork } from './patches/zero-copy-fork.js'
import { install as installFastInitFor } from './patches/fast-init-for.js'
import { install as installPreparedCacheTrim } from './patches/prepared-cache-trim.js'
import { install as installChunkedMaterialize } from './patches/chunked-materialize.js'
import { createWarmup } from './warmup.js'
import { createBackfill } from './backfill.js'
import { installApi } from './api.js'

export const name = 'dsh-large-proj-perf'
export const inject = ['sessions']

export function apply(ctx) {
  const disposers = []
  const { config, setConfigValue } = createConfig()
  const stats = createStats()
  const { log, logErr } = makeLogger(ctx)
  const { setPatchStatus, recordFork, recordWarm } = createRecorders(stats, config, log)

  // 各模块共享的运行时上下文（依赖注入；显式传参取代共享闭包）
  const pc = {
    ctx, config, stats, log, logErr, disposers,
    safeGet, sessionEventsOf, sessionLogOffset,
    yieldLoop: makeYieldLoop(config),
    setPatchStatus, recordFork, recordWarm, setConfigValue,
  }

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
  installZeroCopyFork(pc)
  // sessionPersistence/webServer 是懒装配服务：已就绪直接装，未就绪经
  // ctx.inject 等就绪后再装。
  const installPersistenceSide = (sub) => {
    installFastInitFor(pc, sub)
    installPreparedCacheTrim(pc, sub)
    Promise.resolve(installChunkedMaterialize(pc, sub)).catch((e) => logErr(`chunked materialize install failed: ${String(e?.message ?? e)}`))
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionPersistence'], installPersistenceSide)
    ctx.inject(['webServer'], (sub) => installApi(pc, sub))
  } else {
    installPersistenceSide(ctx)
    installApi(pc, ctx)
  }

  // ---------- 预热 + 回填 ----------
  const { warmSession } = createWarmup(pc)
  setPatchStatus('warmup', config.warmupEnabled ? 'active' : 'off')
  if (config.warmOnCreated && typeof ctx.on === 'function') {
    const offCreated = ctx.on('session/created', (session) => {
      if (!config.warmupEnabled) return
      Promise.resolve(warmSession(session)).catch((e) => {
        logErr(`warmup failed for ${session.id}: ${String(e?.message ?? e)}`)
      })
    })
    if (typeof offCreated === 'function') disposers.push(offCreated)
  }
  for (const session of ctx.sessions?.list?.() ?? []) {
    Promise.resolve(warmSession(session)).catch(() => {})
  }

  const backfill = createBackfill(pc)
  const backfillTimer = setTimeout(() => {
    backfill.markFired()
    Promise.resolve(backfill.backfillColdSessions()).catch((e) => logErr(`backfill scan failed: ${String(e?.message ?? e)}`))
  }, 15000)
  if (typeof backfillTimer.unref === 'function') backfillTimer.unref()
  disposers.push(() => clearTimeout(backfillTimer))
  pc.backfill = { backfillColdSessions: backfill.backfillColdSessions, isFired: backfill.isFired }

  log(`installed (zeroCopy=${config.zeroCopyFork}, fastInitFor=${config.fastInitFor}, warmup=${config.warmupEnabled} minEvents=${config.minEvents}, chunkedMaterialize=${config.chunkedMaterialize})`)

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { logErr('dispose failed:', String(error?.message ?? error)) }
    }
    log('disposed')
  }
}
