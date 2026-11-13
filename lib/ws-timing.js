// 服务端发送链路计时：把「服务端产出之后」拆成三段。
//
//   stream-server 调用 send 的时刻（queuedAt）  ← 之前是写队列等待
//   send 回调（sentAt）                          ← 之间是 JSON 序列化之后的 deflate + 写入
//   客户端 message 的 event.timeStamp             ← 之间是网络 + 浏览器 inflate
//
// 这是响应腿唯一能拆开的办法：`stream-server` 的 `this.writes` 是跨逻辑流的串行
// 队列，control 基线会挡住 follow，光看客户端只能看到「帧很晚到」，看不出是在等
// 队列还是在 deflate。
//
// 只依赖 `stats/config/log/disposers`，**不依赖 sessionController**；所以它在
// render-timing.js 的 controller 能力门禁之前安装，页面计时点全都装不上时它仍
// 可以工作。无法解析 `ws` 时静默跳过（不影响其它计时点）。

import { createRequire } from 'node:module'

import { dshPackageJsonCandidates } from './dsh-root.js'

/** 只记录足够大的帧，避免把心跳/控制帧灌进环。 */
const SEND_MIN_BYTES = 65536

/** 从 dsh 安装根解析 ws：插件自己的依赖树里没有它。 */
function resolveWebSocket() {
  for (const candidate of dshPackageJsonCandidates()) {
    try {
      const mod = createRequire(candidate)('ws')
      const WebSocket = mod?.WebSocket ?? mod
      if (typeof WebSocket?.prototype?.send === 'function') return WebSocket
    } catch { /* 换下一个候选 */ }
  }
  return null
}

/**
 * 安装 ws.send 计时。
 *
 * @param deps - 只读依赖（stats/config/log/disposers）
 * @returns 是否安装成功
 */
export function installSendTiming(deps) {
  const { stats, config, log, disposers } = deps
  const WebSocket = resolveWebSocket()
  if (WebSocket === null) {
    log('render timing: ws.send timing unavailable')
    return false
  }
  const proto = WebSocket.prototype
  const original = proto.send
  const record = (entry) => {
    const sends = stats.render.sends
    sends.push(entry)
    if (sends.length > config.keepRecent) sends.splice(0, sends.length - config.keepRecent)
  }

  function send(data, options, callback) {
    // 帧是 UTF-8 文本：用字节数而不是 UTF-16 码元数，CJK 内容才与线上一致。
    const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : (data?.length ?? 0)
    if (size < SEND_MIN_BYTES) return original.call(this, data, options, callback)
    const queuedAt = Date.now()
    const done = (error) => {
      record({ t: queuedAt, sentAt: Date.now(), bytes: size })
      if (typeof callback === 'function') callback(error)
    }
    // ws 的签名有 (data, cb) 与 (data, options, cb) 两种。
    if (typeof options === 'function') return original.call(this, data, done)
    return original.call(this, data, options, done)
  }

  proto.send = send
  // 只有仍是我们装的那一层才还原：别人后来包过的话，不能把他们的 wrapper 抹掉。
  disposers.push(() => { if (proto.send === send) proto.send = original })
  return true
}
