// dsh-large-proj-perf — dsh-std host facet（Community v0.15 清单入口）
//
// 面向未来标准宿主（@dsh-std 生态）的激活模块：dsh-plugin.json 的
// facets.host.entry 指向本文件。形态与 @dsh-std/sdk 的 defineFacet 产物等价
// （activate/deactivate/snapshot），但刻意不 import 任何 @dsh-std 运行时包——
// 当前 dsh（0.1.x）不消费标准、node_modules 里也没有 @dsh-std/*，保持零依赖。
//
// 桥接语义：插件是性能补丁，需要 cordis 上下文（sessions/persistence 等）才
// 能打补丁。标准宿主若经协议提供 cordis 上下文（未来 @dsh-std 若定义
// 「cordis.dsh/v1alpha1 ContextProvider」类协议），activate 会桥接并复用
// lib/index.js 的 apply；没有桥接时激活为空操作（补丁不装，符合三层回退），
// deactivate/snapshot 始终可用。

let disposer = null
let cordisBridge = null

export const facet = {
  async activate(context) {
    // 宿主可用时提供激活标识（ActivationContext.identity 等）；这里只记状态。
    // 未来协议钩子：context.protocols.client({ apiVersion: 'cordis.dsh/v1alpha1', kind: 'ContextProvider' })
    const bridge = context?.protocols?.client?.({ apiVersion: 'cordis.dsh/v1alpha1', kind: 'ContextProvider' })
    if (bridge && typeof bridge.apply === 'function') {
      cordisBridge = bridge
      const { apply } = await import('./index.js')
      disposer = apply(bridge)
    }
    return undefined
  },
  async deactivate(reason) {
    if (disposer) {
      try { disposer() } catch { /* dispose 容错与 lib/index.js 一致 */ }
      disposer = null
    }
    cordisBridge = null
    return undefined
  },
  async snapshot() {
    return {
      state: disposer ? 'active' : 'degraded',
      message: disposer
        ? 'cordis patches applied via bridge'
        : 'no cordis bridge protocol; patches not applied (host does not expose cordis context)',
      extensions: [],
    }
  },
}

export default facet
