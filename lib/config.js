// dsh-large-proj-perf — 配置：默认值、下限钳制、settings 持久化注册

export const NS = 'dsh-large-proj-perf'

export const DEFAULT_CONFIG = {
  // ---- fork（A）----
  zeroCopyFork: true,   // 零拷贝 fork（跳过 seed 深拷贝）
  fastInitFor: true,    // persistence initFor 冻结引用复用
  slowForkWarnMs: 100,  // fork 耗时超过该值打告警日志
  // ---- projection 预热（B）----
  warmupEnabled: true,  // 大会话投影分片预热
  minEvents: 20000,     // 事件数低于此值不做预热（同步冷折叠足够快）
  chunkSize: 5000,      // 每片折叠的事件数（片间让出事件循环）
  chunkYieldMs: 0,      // 让出方式：0=setImmediate；>0 则 setTimeout 该毫秒数
  warmOnCreated: true,  // session/created（含 resume 的大会话）即预热
  keepRecent: 50,       // 内存保留的最近记录数
  // ---- 冷会话缓存补行（B 辅助，默认关）----
  // readRaw 内部的 zstd 全量解码同步、插件层不可分片，大文件仍会冻结事件
  // 循环数秒~数十秒；默认关闭，需要时经 config.set 打开。
  backfillOnBoot: false,
  backfillMaxSessions: 8,
  backfillMinBytes: 1048576,
  backfillMaxBytes: 33554432,
  // ---- 分片 materialize（C）----
  chunkedMaterialize: true,    // fork 子会话落盘分片序列化，消除 500MB 单字符串/OOM
  materializeChunkEvents: 50000, // 每帧的事件数
  // ---- 内存优化（D）----
  preparedCacheTrim: true,     // 冷会话 LRU 裁剪总开关（false 恢复官方 capacity）
  preparedCacheSize: 1,        // persistence 冷会话 LRU 容量（默认 5 → 1，省 ~2.8GB）
  heapWarnBytes: 6442450944,   // heap 上限低于此值（6GB）打警告，提示 --max-old-space-size
}

// 数值配置下限：settings 载入与 config.set 两条入口都过这道闸。
// materializeChunkEvents<=0 会让分片循环永不前进（死循环+frames 无限增长），
// chunkSize<=0 会让预热空转，preparedCacheSize<=0 会清空 dsh 内部 LRU。
export const CONFIG_MIN = {
  slowForkWarnMs: 0,
  minEvents: 0,
  chunkSize: 1,
  chunkYieldMs: 0,
  keepRecent: 0,
  backfillMaxSessions: 0,
  backfillMinBytes: 0,
  backfillMaxBytes: 0,
  materializeChunkEvents: 1000,
  preparedCacheSize: 1,
  heapWarnBytes: 0,
}

export function createConfig() {
  const config = { ...DEFAULT_CONFIG }
  // 配置唯一写入口：未知键忽略、类型不符忽略、数值做下限钳制（拒绝 NaN/Infinity）。
  // 保证 config 里的数值永远安全，消费端（分片循环等）无需再防御。
  const setConfigValue = (key, value) => {
    if (!(key in DEFAULT_CONFIG)) return
    if (typeof value !== typeof DEFAULT_CONFIG[key]) return
    const min = CONFIG_MIN[key]
    if (min !== void 0) {
      if (!Number.isFinite(value)) return
      value = Math.max(value, min)
    }
    config[key] = value
  }
  return { config, setConfigValue }
}

// schemastery 可选依赖：顶层 await 加载，缺失时降级为纯内存配置
let schemaLib = null
try { schemaLib = (await import('@deepseek-ai/schemastery')).default ?? null } catch { schemaLib = null }

// settings 服务存在则注册 schema 并把持久化值灌回 config；否则保持纯内存。
export function registerSettings(ctx, config, setConfigValue, { logErr }, disposers) {
  try {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.register !== 'function' || !schemaLib) return
    // schema 由 DEFAULT_CONFIG 键驱动生成（boolean/number 按默认值类型推断），
    // 避免与 DEFAULT_CONFIG 双清单漂移
    const schema = schemaLib.object(Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, def]) => [
      key,
      typeof def === 'boolean' ? schemaLib.boolean().default(def) : schemaLib.number().default(def),
    ])))
    const off = settings.register(NS, schema, { base: { ...DEFAULT_CONFIG } })
    if (typeof off === 'function') disposers.push(off)
    const resolved = settings.get(NS)
    if (resolved && typeof resolved === 'object') {
      for (const [key, value] of Object.entries(resolved)) setConfigValue(key, value)
    }
  } catch (error) {
    logErr('settings register failed:', String(error?.message ?? error))
  }
}
