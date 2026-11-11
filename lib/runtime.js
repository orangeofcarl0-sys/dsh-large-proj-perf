// dsh-large-proj-perf — dsh 兼容垫片（日志 / 服务访问 / 版本探针）
//
// 这里只放「随 dsh 版本变化需要适配的东西」。分片让出（原 makeYieldLoop）已移到
// yield.js，配置常量已移到 constants.js。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

export const TAG = '[dsh-perf]'

// 插件开发/验证过的 dsh 版本。运行时探针检测到列表外版本时打告警，并提示跑
// tests/verify_compat.mjs 确认补丁特征是否仍匹配（特征校验会自动跳过，但会静默失效）。
//
// 与 `engines.dsh`（>=0.2.2-rc.1 <0.3.0-0）保持一致：加载门禁已经挡掉更旧的版本，
// 所以能跑到这里的只可能是 0.2.2-rc.1 或更高的小版本。历史上的 0.1.x / 0.2.0 /
// 0.2.1 适配记录保留在 docs/COMPATIBILITY.md 的版本矩阵里，不进入本列表。
export const KNOWN_DSH_VERSIONS = ['0.2.2-rc.1']

// cordis 环境下对缺失服务调用 ctx.get 可能抛错——统一安全取服务
export const safeGet = (ctx, name) => {
  try { return ctx.get(name) } catch { return void 0 }
}

// 日志优先走 ctx.logger（可被 dsh 日志级别控制），不可用/无对应方法时回退 console
export const makeLogger = (ctx) => {
  const logger = safeGet(ctx, 'logger') ?? ctx.logger
  const log = (...args) => {
    if (typeof logger?.info === 'function') logger.info(TAG, ...args)
    else console.log(TAG, ...args)
  }
  const logErr = (...args) => {
    if (typeof logger?.error === 'function') logger.error(TAG, ...args)
    else console.error(TAG, ...args)
  }
  return { log, logErr }
}

// alpha.5 起 Session 公共快照为 snapshotEvents()（rc.2 及之前是 events getter）。
// 兼容两者；mock 测试对象带 events 属性也能走通。
export const sessionEventsOf = (session) => typeof session?.snapshotEvents === 'function'
  ? session.snapshotEvents()
  : session?.events

// SessionLogOffset（alpha.5 新增）：非负安全整数 + brand。真实环境从 dsh-session
// 取（顶层动态加载，缺失时用恒等 fallback——数值语义等价，仅少 brand 标记）。
export let sessionLogOffset = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) return void 0
  return value
}
try {
  const mod = await import('@deepseek-ai/dsh-session')
  if (typeof mod.SessionLogOffset === 'function') sessionLogOffset = mod.SessionLogOffset
} catch { /* 测试 mock 环境：恒等 fallback */ }

// 版本探针：优先直接解析 @deepseek-ai/dsh（宿主进程内通常可解析）；bundle/
// 安装位置拿不到时，从 dsh-session 的安装路径上溯到 dsh 根读 package.json。
export function probeDshVersion() {
  try {
    const entry = require.resolve('@deepseek-ai/dsh/package.json')
    return JSON.parse(readFileSync(entry, 'utf8')).version
  } catch { /* 走 dsh-session 反推 */ }
  try {
    const entry = require.resolve('@deepseek-ai/dsh-session/package.json')
    const root = join(dirname(entry), '..', '..', '..')
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  } catch { return void 0 }
}
