// dsh-large-proj-perf — 统计与补丁生命周期状态

export function createStats() {
  const stats = {
    // 版本探针
    dshVersion: null,
    // 各补丁状态：
    //   active   = 已安装（不代表本轮被调用）
    //   inactive = 环境缺失 / 特征漂移，自动跳过
    //   off      = 被配置显式关闭
    //   retired  = 上游已原生实现该能力，补丁主动退役
    //
    // 当前没有能力会走到 `retired`（v1.10.0 移除了唯一的使用者 fastInitFor）。
    // 保留这个状态是因为它是「上游吸收能力后补丁主动让位」这一语义的唯一表达，
    // 未来某个补丁需要退役时还要用它。
    patches: {},
    // fork（zero-copy-fork.js）：计数 + 慢 fork 日志 + 最近记录
    forks: 0, zeroCopy: 0, fallbacks: 0, forkRecent: [],
    // 冷会话补行（backfill.js，默认关）
    backfilled: 0, backfillSkipped: 0, backfill: [],
    // 冷读回写（cold-writeback.js，默认关）
    coldWriteBacks: 0, coldWriteBackSkipped: 0, coldWriteBackFailed: 0, coldWriteBackRecent: [],
    // 内存预算（memory-budget.js）：按字节淘汰事件缓存。
    // 关闭/不适用时恒为 null——载荷形状不随配置变化，消费端不必做「键是否存在」分支。
    memoryBudget: null,
    memoryBudgetTrimmed: 0, memoryBudgetFreedBytes: 0, memoryBudgetOverBudget: 0,
    // 渲染诊断（render-timing.js，默认关）：服务端分页/投影耗时 + 浏览器样本。
    // 关闭时这些字段保持 0/空——stats.get 的载荷形状恒定。
    render: {
      snapshotCount: 0, snapshotMs: 0, snapshotMaxMs: 0, lastUnits: 0,
      pages: [],        // 服务端：{kind,ms,startedAt,records,bytes,hasMore,sessionId,beforeSeq}；jump 用 recordsTotal/bytesTotal
      sends: [],        // 服务端 ws.send：{t(排队完成),sentAt,bytes}
      jumps: 0,         // 服务端识别出的回合跳转次数（连续分页聚合）
      clients: [],      // 浏览器：{kind,rows,firstRowMs,settleMs,...}
      reports: 0,       // 收到过多少批浏览器样本
      dropped: 0,       // 因超限/非法被丢弃的样本数
    },
  }

  // 唯一的复位清单：api.js 的 stats.reset 只调它。
  // 不可枚举——stats.get 直接序列化本对象，JSON 形状必须与以前完全一致。
  // patches 与 dshVersion 是安装状态，刻意保留；memoryBudget.budgetBytes 同理。
  Object.defineProperty(stats, 'reset', {
    value: function reset() {
      stats.forks = 0; stats.zeroCopy = 0; stats.fallbacks = 0; stats.forkRecent = []
      stats.backfilled = 0; stats.backfillSkipped = 0; stats.backfill = []
      stats.coldWriteBacks = 0; stats.coldWriteBackSkipped = 0; stats.coldWriteBackFailed = 0
      stats.coldWriteBackRecent = []
      if (stats.memoryBudget !== null) {
        stats.memoryBudget.cachedEntries = 0
        stats.memoryBudget.estimatedBytes = 0
      }
      stats.memoryBudgetTrimmed = 0; stats.memoryBudgetFreedBytes = 0; stats.memoryBudgetOverBudget = 0
      stats.render.snapshotCount = 0; stats.render.snapshotMs = 0; stats.render.snapshotMaxMs = 0
      stats.render.lastUnits = 0; stats.render.pages = []; stats.render.jumps = 0
      stats.render.sends = []
      stats.render.clients = []; stats.render.reports = 0; stats.render.dropped = 0
    },
  })

  return stats
}

// 各 \"最近记录\" 数组尾部保留 keepRecent 条
const trimRecent = (arr, keepRecent) => {
  if (arr.length > keepRecent) arr.splice(0, arr.length - keepRecent)
}

export function createRecorders(stats, config, log) {
  const setPatchStatus = (name, status) => { stats.patches[name] = status }

  const recordFork = (entry) => {
    stats.forks += 1
    if (entry.path === 'zero-copy') stats.zeroCopy += 1
    if (entry.path === 'native-fallback') stats.fallbacks += 1
    stats.forkRecent.push(entry)
    trimRecent(stats.forkRecent, config.keepRecent)
    if (entry.ms >= config.slowForkWarnMs) {
      log(`slow fork: ${entry.events} events in ${entry.ms.toFixed(1)}ms (${entry.path})`)
    }
  }

  return { setPatchStatus, recordFork }
}
