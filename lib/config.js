// dsh-large-proj-perf — 配置：默认值、下限钳制、settings 持久化注册

import { DEFAULT_MEMORY_BUDGET_BYTES } from './constants.js'

export const NS = 'dsh-large-proj-perf'

export const DEFAULT_CONFIG = {
  // ---- fork ----
  zeroCopyFork: true,   // 零拷贝 fork（跳过 seed 深拷贝）
  slowForkWarnMs: 100,  // fork 耗时超过该值打告警日志
  // ---- 分片遍历的通用参数（backfill 与分片 materialize 共用）----
  minEvents: 20000,     // 事件数低于此值的会话不做额外处理（同步折叠足够快）
  chunkSize: 5000,      // 每片处理的事件数（片间让出事件循环）
  chunkYieldMs: 0,      // 让出方式：0=setImmediate；>0 则 setTimeout 该毫秒数
  keepRecent: 50,       // 内存保留的最近统计记录数
  // ---- 冷会话缓存补行（默认关）----
  // 解码按 zstd frame 逐帧异步、帧间让出；折叠按 chunkSize 让出。仍是「读全量
  // 日志 + 折全部单元」的重活，默认关闭，需要时经 config.set 打开。
  backfillOnBoot: false,
  backfillMaxSessions: 8,
  backfillMinBytes: 1048576,
  backfillMaxBytes: 33554432,
  // ---- 分片 materialize ----
  chunkedMaterialize: true,    // fork 子会话落盘分片序列化，消除 500MB 单字符串/OOM
  materializeChunkEvents: 50000, // 每帧的事件数
  // ---- 冷读回写（默认关）----
  // 冷读投影后把已折好的状态写成缓存行。**实测无耗时收益**（见
  // docs/RUNTIME-ANALYSIS.md 场景 G：有行 19.1s vs 无行 18.9s）——冷读的大头
  // 不在折叠循环，而在「日志 → 内存事件数组」与各单元的状态校验。打开它的
  // 唯一好处是让 dsh 自己的列表读（cachedSnapshot，零 I/O）看到更新的行；
  // 代价是每次冷读多写一个可能上 10MB 的记录。默认关。
  coldWriteBack: false,
  // ---- 内存治理 ----
  // dsh 的事件缓存全部按「会话条数」限容（ObservationCache 5 条、coldLogMemo
  // 2 条），没有一处按字节。实测一份 24 万事件树占 87.7 MB，连开 6 个 18 MB
  // 会话 RSS 涨 821 MB。这里给它们加一个字节预算，超出时淘汰最旧的未 pin 条目。
  // 0 = 关闭。默认 512 MiB（约 6 份 24 万事件会话）。
  memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
  heapWarnBytes: 6442450944,   // heap 上限低于此值（6GB）打警告，提示 --max-old-space-size
  // ---- 折叠加速 ----
  // 把 turnOutline 的 O(n²) fold 换成 O(n)（上游每次 turn 都整数组复制，
  // 2 万 turn 时比线性版慢 700 倍；实测占冷读 21 秒里的 16 秒）。
  // 逐 case 语义等价，仅改写「如何构造新数组」。
  fastTurnOutline: true,
  // ---- 渲染链路（浏览器侧）----
  // 打开会话时，服务端只发一个「消息对齐的窗口」，之后解析/组装/挂载全在浏览器。
  // 下面四项分别管「测量」与「窗口大小」，默认全部关闭：它们改变的是用户可见面，
  // 没有实测数据前不擅自改变。详见 docs/RENDER-ANALYSIS.md。
  //
  // renderTiming：开启服务端分页/投影计时与浏览器样本采集（诊断模式）。
  // 关闭时 render-timing.js 完全不安装，零开销。
  renderTiming: false,
  // clientContainment：长转录（>80 行）给第 30 行之后的离屏行加
  // content-visibility:auto，削减布局与绘制。
  // 实测（24 万事件会话，快速连续翻 10 页 → 1000 行）：
  //   关闭 11 个长任务 / 2836 ms 阻塞 / 最长 416 ms
  //   开启 18 个长任务 / 1489 ms 阻塞 / 最长 244 ms（阻塞 -47%）
  // 默认开启；若在你的会话里出现向上滚动位置跳动，改为 false 即可。
  clientContainment: true,
  // maxInitialMessages：首屏窗口的消息上限（客户端自己请求 500）。0 = 不限制。
  // 只降不升；hasMore 语义不变，客户端会按需续拉。
  maxInitialMessages: 0,
  // maxPageBytes：单页的估算字节上限（JSON 文本长度）。超限时按比例下调
  // maxMessages 重算。0 = 不限制。工具输出密集的会话可到数十 MB/页。
  maxPageBytes: 0,
  // ---- 调试观测面（默认关）----
  // 打开后在插件自有 API 前缀下额外暴露 debug.fork：直接调用
  // SessionStore.prototype.fork，用于测量零拷贝补丁本身。dsh 0.2.2 起
  // 服务端 session/fork RPC 改走 agents.create({seed})，不再经过
  // SessionStore.fork——不打开这个开关就无法从 HTTP 侧触发该补丁点。
  debugApi: false,
}

// 数值配置下限：settings 载入与 config.set 两条入口都过这道闸。
// materializeChunkEvents<=0 会让分片循环永不前进（死循环+frames 无限增长），
// chunkSize<=0 会让分片循环空转。
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
  heapWarnBytes: 0,
}

export function createConfig() {
  const config = { ...DEFAULT_CONFIG }
  // 启动期环境变量覆盖：仅用于离线测量与排障（settings 服务未挂载时，运行期
  // config.set 只能改那些「每次调用重读 config」的开关；chunkedMaterialize /
  // renderTiming / memoryBudgetBytes 在 install 时判一次，改不回来）。变量名统一
  // 前缀 DSH_PERF_，值按 DEFAULT_CONFIG 的类型解析；非法值忽略。
  const env = globalThis.process?.env ?? {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const raw = env[`DSH_PERF_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`]
    if (raw === undefined || raw === '') continue
    const def = DEFAULT_CONFIG[key]
    if (typeof def === 'boolean') {
      if (raw === '1' || raw === 'true') config[key] = true
      else if (raw === '0' || raw === 'false') config[key] = false
    } else if (typeof def === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n)) config[key] = n
    }
  }
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
