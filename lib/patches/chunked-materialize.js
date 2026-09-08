// 补丁 4：分片 materialize（问题 C）
//
// fork 子会话首次落盘 encodeMaterialization 一次性序列化整个 seed（60 万事件
// 501MB 单串、74 万 RangeError）。补丁改为每 materializeChunkEvents 事件一个
// zstd frame——多帧是解码端 scanZstdFrames 的原生格式，字节兼容。
//
// 形态演进（特征探测选择分支）：
//   - rc.2 及之前：(meta, events)，eventLines(events, this.packChunks)
//   - alpha.5 / rc.1：(storage, events)，toHeaderLine(header, inheritedEventCount)
//     （seedLength 为 isSeeded 条件字段——旧分支复刻该语义）
//   - 0.1.3：(meta, inheritedEventCount, events)，实现搬入
//     @deepseek-ai/dsh-session-persistence-jsonl；header 由
//     dsh-session-format-catalog.encodeCurrentHeader 编码（seed cut 不再是
//     header 字段，改由事件流尾 session/end-seed marker 表达）。
//
// 0.1.3 分支的头帧直接复用原方法（original(meta, inheritedEventCount, [])——
// events.length===0 时只编码 header 帧），不重写上游编码器。

import { performance } from 'node:perf_hooks'
import { constants as zlibConstants, zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'

const zstdCompressAsync = promisify(zstdCompress)
const CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

export async function install(pc, ictx) {
  const { ctx, config, log, logErr, disposers, sessionLogOffset, setPatchStatus, safeGet } = pc
  const actx = ictx ?? ctx
  if (!config.chunkedMaterialize) { setPatchStatus('chunkedMaterialize', 'off'); return }
  const persistence = safeGet(actx, 'sessionPersistence')
  if (!persistence || typeof persistence.encodeMaterialization !== 'function') {
    log('chunked materialize: encodeMaterialization not found; skipped')
    setPatchStatus('chunkedMaterialize', 'inactive'); return
  }
  // ctx.get('sessionPersistence') 经 cordis Proxy 返回 createShadowMethod（bind
  // 后的函数，String 为 [native code]），签名校验永远失败。改取原型方法（真实
  // 源码）做特征校验；自有属性场景（测试 mock）回退实例方法。patch 经 Proxy
  // set 陷阱落到真实实例，不受影响。
  const candidate = Object.getPrototypeOf(persistence)?.encodeMaterialization ?? persistence.encodeMaterialization
  const src = String(candidate ?? '')
  // 0.1.3 形态：jsonl 包 (meta, inheritedEventCount, events)，无 packChunks
  const isNew = src.includes('encodeMaterialization(meta, inheritedEventCount, events)')
    && src.includes('const body = eventLines(events)')
  // 旧形态：rc.1/alpha.5 的 (storage, events) 或 rc.2 (meta, events)
  const isOld = src.includes('eventLines(events, this.packChunks)') && src.includes('compressZstdFrame')
  if (!isNew && !isOld) {
    logErr('encodeMaterialization signature mismatch (dsh internals changed?); chunked materialize skipped')
    setPatchStatus('chunkedMaterialize', 'inactive'); return
  }
  const originalRaw = persistence.encodeMaterialization
  const original = originalRaw.bind(persistence)
  // dispose 时按原形状还原：原型方法 → delete 自有补丁属性（回落原型）；
  // 自有属性（测试 mock 等）→ 原样写回，不留 bind 副本遮蔽
  const hadOwn = Object.prototype.hasOwnProperty.call(persistence, 'encodeMaterialization')

  // 旧形态的 packChunkRuns（0.1.3 已移除，语义拆分进 dsh-session 的
  // encodeSeqRanges）；导入失败时退化（无 packChunks 配置则无影响）。
  let packChunkRuns = null
  try { packChunkRuns = (await import('@deepseek-ai/dsh-session')).packChunkRuns ?? null } catch { /* 退化 */ }
  const eventLinesChunk = (events) => ((packChunkRuns && persistence.packChunks) ? packChunkRuns(events) : events)
    .map((r) => JSON.stringify(r)).join('\n') + '\n'
  // alpha.5 复刻：toHeaderLine(header, inheritedEventCount)——seedLength 为
  // isSeeded 条件字段（值 = SessionLogOffset(inheritedEventCount ?? 0)）。
  const toHeaderLine = (header, inheritedEventCount) => {
    const cut = sessionLogOffset(inheritedEventCount ?? 0)
    if (cut === void 0) throw new TypeError(`inheritedEventCount must be a non-negative safe integer, got ${String(inheritedEventCount)}`)
    if (header.isSeeded && inheritedEventCount === void 0) throw new Error('seeded session header requires an inherited event count')
    if (!header.isSeeded && cut !== 0) throw new Error('unseeded session header inherited event count must be 0')
    return {
      type: 'session',
      version: header.version,
      id: header.id,
      createdAt: header.createdAt,
      ...(header.cwd !== void 0 ? { cwd: header.cwd } : {}),
      ...(header.parentSession !== void 0 ? { parentSession: header.parentSession } : {}),
      ...(header.isSeeded ? { seedLength: cut } : {}),
      ...(header.origin !== void 0 ? { origin: header.origin } : {}),
      delegationDepth: header.delegationDepth ?? 0,
      ...(header.agentPreset !== void 0 ? { agentPreset: header.agentPreset } : {}),
    }
  }

  persistence.encodeMaterialization = async function (...args) {
    let meta, inheritedEventCount, events
    if (isNew) {
      ;[meta, inheritedEventCount, events] = args
    } else {
      const storage = args[0]
      events = args[1]
      meta = storage?.meta ?? storage
      inheritedEventCount = storage?.meta !== void 0 ? storage.inheritedEventCount : void 0
    }
    if (this.compression === 'none' || events.length <= config.materializeChunkEvents) {
      return original(...args)
    }
    // 头帧：0.1.3 复用原方法（events.length===0 只产 header 帧，编码器归上游）；
    // 旧形态按 alpha.5 复刻
    let headerFrame
    if (isNew) {
      headerFrame = await original(meta, inheritedEventCount, [])
    } else {
      const header = JSON.stringify(toHeaderLine(meta, inheritedEventCount)) + '\n'
      headerFrame = await zstdCompressAsync(Buffer.from(header), CHECKSUM_OPTIONS)
    }
    const frames = [headerFrame]
    for (let i = 0; i < events.length; i += config.materializeChunkEvents) {
      const chunk = events.slice(i, i + config.materializeChunkEvents)
      const body = eventLinesChunk(chunk)
      frames.push(await zstdCompressAsync(Buffer.from(body), CHECKSUM_OPTIONS))
      if (i + config.materializeChunkEvents < events.length) await pc.yieldLoop()
    }
    return Buffer.concat(frames)
  }
  disposers.push(() => {
    if (hadOwn) persistence.encodeMaterialization = originalRaw
    else delete persistence.encodeMaterialization
  })
  setPatchStatus('chunkedMaterialize', 'active')
  log(`chunked materialize installed (chunk=${config.materializeChunkEvents} events/frame, protocol: ${isNew ? '0.1.3' : 'legacy'})`)
}
