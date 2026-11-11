// dsh-large-proj-perf — 统计与补丁生命周期状态

export function createStats() {
  return {
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
    // 内存预算（memory-budget.js）：按字节淘汰事件缓存
    memoryBudgetTrimmed: 0, memoryBudgetFreedBytes: 0, memoryBudgetOverBudget: 0,
  }
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
