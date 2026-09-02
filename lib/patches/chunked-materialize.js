// 补丁 4：分片 materialize（问题 C）
//
// rc.2 及之前：fork 子会话首次落盘 encodeMaterialization 一次性序列化整个
// seed（60 万事件 501MB 单串、74 万 RangeError）。补丁改为每
// materializeChunkEvents 事件一个 zstd frame——多帧是解码端 scanZstdFrames
// 的原生格式，字节兼容。
// alpha.5：签名变为 (storage, events)（storage = {meta, inheritedEventCount}），
// toHeaderLine(header, inheritedEventCount) 使 seedLength 成为 isSeeded 条件
// 字段——本模块复刻该语义并向后兼容 rc.2 的裸 meta 形态。

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
  // 注意：ctx.get('sessionPersistence') 返回 cordis Proxy，访问其方法会得到
  // createShadowMethod（bind 过的函数，String 为 [native code]），签名校验
  // 永远失败。改用原型方法（真实源码）做特征校验；自有属性场景（测试 mock）
  // 回退到实例方法。patch 本身经 Proxy set 陷阱落到真实实例，不受影响。
  const candidate = Object.getPrototypeOf(persistence)?.encodeMaterialization ?? persistence.encodeMaterialization
  const src = String(candidate ?? '')
  if (!src.includes('eventLines(events, this.packChunks)') || !src.includes('compressZstdFrame')) {
    logErr('encodeMaterialization signature mismatch (dsh internals changed?); chunked materialize skipped')
    setPatchStatus('chunkedMaterialize', 'inactive'); return
  }
  const originalRaw = persistence.encodeMaterialization
  const original = originalRaw.bind(persistence)
  // dispose 时按原形状还原：原型方法 → delete 自有补丁属性（回落原型）；
  // 自有属性（测试 mock 等）→ 原样写回，不留 bind 副本遮蔽
  const hadOwn = Object.prototype.hasOwnProperty.call(persistence, 'encodeMaterialization')

  let packChunkRuns = null
  try { packChunkRuns = (await import('@deepseek-ai/dsh-session')).packChunkRuns } catch { /* 退化 */ }
  if (!packChunkRuns) {
    logErr('dsh-session packChunkRuns unavailable; chunked materialize degrades to unpacked lines when packChunks is enabled (format drift vs native)')
  }
  const eventLinesChunk = (events) => ((packChunkRuns && persistence.packChunks) ? packChunkRuns(events) : events)
    .map((r) => JSON.stringify(r)).join('\n') + '\n'
  // alpha.5 复刻：toHeaderLine(header, inheritedEventCount)——seedLength 变为
  // isSeeded 条件字段（值 = SessionLogOffset(inheritedEventCount ?? 0)），且
  // seeded 会话必须有 inheritedEventCount、unseeded 会话必须为 0。
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

  // alpha.5 起签名为 (storage, events)；rc.2 及之前为 (meta, events)。
  // storage.meta 缺失时按旧形态处理（storage 即 meta）。
  persistence.encodeMaterialization = async function (storage, events) {
    const meta = storage?.meta ?? storage
    const inheritedEventCount = storage?.meta !== void 0 ? storage.inheritedEventCount : void 0
    if (this.compression === 'none' || events.length <= config.materializeChunkEvents) {
      return original(storage, events)
    }
    const header = JSON.stringify(toHeaderLine(meta, inheritedEventCount)) + '\n'
    const headerFrame = await zstdCompressAsync(Buffer.from(header), CHECKSUM_OPTIONS)
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
  log(`chunked materialize installed (chunk=${config.materializeChunkEvents} events/frame)`)
}
