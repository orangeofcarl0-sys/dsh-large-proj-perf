// dsh-large-proj-perf — 统计与补丁生命周期状态

export function createStats() {
  return {
    // 版本探针
    dshVersion: null,
    // 各补丁状态：active=已安装生效；retired=上游已原生实现（补丁跳过）；
    // inactive=环境缺失/特征漂移；off=配置关闭。上游吸收某能力后对应项
    // 自动转 retired——这就是插件「逐项退役」的可见化。
    patches: {},
    // fork
    forks: 0, zeroCopy: 0, fallbacks: 0, fastInitForInstalled: false, forkRecent: [],
    // warmup
    // alreadyHot：会话进入时上游已把全部投影折完（0.2.2 的常态，见 warmup.js）。
    // 这种会话按 warmed 计会掩盖「插件没干活」的事实，单独计数。
    warmed: 0, skipped: 0, aborted: 0, alreadyHot: 0, backfilled: 0, backfillSkipped: 0,
    // 冷读回写（cold-writeback.js）：把冷读折好的状态写成缓存行
    coldWriteBacks: 0, coldWriteBackSkipped: 0, coldWriteBackFailed: 0,
    warmRecent: [], backfill: [], coldWriteBackRecent: [],
  }
}

// recordFork/recordWarm 尾部保留 keepRecent 条最近记录
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

  const recordWarm = (entry) => {
    stats.warmRecent.push(entry)
    trimRecent(stats.warmRecent, config.keepRecent)
    if (entry.ms > 1000) log(`warmed ${entry.id}: ${entry.events} events in ${entry.ms.toFixed(0)}ms (${entry.units} units, base seq ${entry.baseSeq})`)
  }

  return { setPatchStatus, recordFork, recordWarm }
}
