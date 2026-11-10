// 事件循环阻塞的**外部**代理指标。
//
// 插件内部没有 monitorEventLoopDelay，也没有任何 materialize/冷折叠的埋点，
// 所以阻塞只能用「从进程外按固定间隔发一个极轻请求、量它的往返时间」来观测：
// 事件循环被同步折叠/压缩占住时，连 stats.get 这种纯内存读取都会排队。
//
// 注意这是**代理指标**，不是事件循环延迟本身：
//   - 它包含 HTTP + socket + 序列化开销（基线通常 1-3ms）；
//   - 采样间隔内的阻塞只会抬高「下一次」采样，真实峰值可能更高；
//   - 结论要用「相对基线抬高多少」而非绝对值。

import { performance } from 'node:perf_hooks'

export function startPinger(client, { intervalMs = 100, label = 'pinger' } = {}) {
  const samples = []
  let stopped = false
  let inFlight = false

  const timer = setInterval(async () => {
    if (stopped || inFlight) return
    inFlight = true
    const t0 = performance.now()
    try {
      await client.stats()
      samples.push({ t: Date.now(), ms: performance.now() - t0, ok: true })
    } catch (error) {
      samples.push({ t: Date.now(), ms: performance.now() - t0, ok: false, error: String(error?.message ?? error) })
    } finally {
      inFlight = false
    }
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    label,
    samples,
    stop() {
      stopped = true
      clearInterval(timer)
      return summarize(samples)
    },
  }
}

function pct(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return +sorted[idx].toFixed(1)
}

export function summarize(samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b)
  const failed = samples.length - ok.length
  if (ok.length === 0) return { n: samples.length, failed, p50: null, p95: null, p99: null, max: null }
  return {
    n: samples.length,
    failed,
    p50: pct(ok, 50),
    p95: pct(ok, 95),
    p99: pct(ok, 99),
    max: +ok.at(-1).toFixed(1),
    // 相邻采样间隔超过 3× 采样周期的次数：长阻塞的直接证据
    stalls: countStalls(samples),
  }
}

function countStalls(samples, factor = 3) {
  if (samples.length < 3) return 0
  const gaps = []
  for (let i = 1; i < samples.length; i++) gaps.push(samples[i].t - samples[i - 1].t)
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0
  return gaps.filter((g) => g > median * factor).length
}
