// 用**真实实现类**生成一个 v4 长会话，写进隔离 home 的 sessions 根。
//
// 为什么不用本机现成会话：
//   - D:\dsh\sessions 里 >5MB 的会话全部是 v0/v2/v3 老格式，读取会走迁移路径；
//   - 唯一的 v4 大会话只有 4939 事件，够不到 minEvents=20000 的预热门槛。
//
// 做法与 tests/e2e_real_components.mjs 同源：真实 SessionStore + 真实
// JsonlSessionPersistence（经 cordis Context.plugin 装载），因此产出的
// header/事件信封/多帧 zstd 都与 dsh 自己写下的一致。

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 伪随机文本：真实会话的压缩比约 2.6MB zstd / 9.2MB 解压（≈3.5×），
// 而重复度高的填充串会被压到 0.5% 以下，测不出分片收益。这里按码点均匀
// 取样，压缩比接近真实内容。
let rngState = 0x9e3779b9
function nextRand() {
  rngState ^= rngState << 13; rngState >>>= 0
  rngState ^= rngState >>> 17
  rngState ^= rngState << 5; rngState >>>= 0
  return rngState / 0x100000000
}
function text(len) {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;-_/\\()[]{}'
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[(nextRand() * ALPHABET.length) | 0]
  return s
}

// 合法事件流：一个「真实 turn 骨架」的循环。
//
// 0.2.2 的读回校验比构造器更严（`assertCurrentLlmShape` / `assertMessageEventShape`
// / 工具生命周期核对）：
//   - 未知事件类型被拒；
//   - request/header 必须带 provider/model 与合法 reason，且空 tools /
//     空 adapterDefaults 必须省略而不能是空容器；
//   - assistant/message 必须 role=assistant + source.kind=model + provider/model，
//     且必须有 turn/step/stream 结算字段；
//   - tool/call 必须在同一 request/header 里先声明该工具的生命周期，否则
//     `tool/call X has no advertised tool lifecycle`。
// 因此骨架里不放工具调用，只放纯文本 turn（8 事件/turn），全部通过校验。
export function buildEvents(n, { pad = 160 } = {}) {
  const ev = []
  let seq = 0
  let turn = 0
  const push = (type, data, extra) => {
    ev.push({ type, seq: seq++, time: 1_700_000_000_000 + seq, data, ...(extra ?? {}) })
  }
  while (ev.length < n) {
    turn += 1
    const p = text(pad)
    const route = { provider: 'probe-provider', model: 'probe-model' }

    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('user/message', {
      content: [{ type: 'text', text: p }],
      source: { kind: 'user' },
      role: 'user',
      id: `probe-user-${turn}`,
    }, { surfaceOp: 'append' })
    push('request/header', {
      header: { config: { ...route, maxTokens: 128000 } },
      reason: 'initial',
    })
    push('request/context', { ...route, contextWindow: 1000000 })
    push('assistant/message', {
      turn,
      step: 1,
      stream: [],
      message: {
        role: 'assistant',
        id: `probe-assistant-${turn}`,
        source: { kind: 'model', ...route },
        content: [{ type: 'text', text: p }],
      },
    }, { surfaceOp: 'append' })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return ev.slice(0, n)
}

// 旧构造器（保留以便对照）：0.2.2 已不认 `usage`，仅供不需要读回校验的
// materialize 路径复用。
export function buildEventsLegacy(n, { pad = 160 } = {}) {
  const ev = []
  let turn = 0
  for (let seq = 0; seq < n; seq++) {
    const kind = seq % 5
    const time = 1_700_000_000_000 + seq
    const p = text(pad)
    if (kind === 0) ev.push({ type: 'turn/start', seq, time, data: { turn: ++turn, pad: p } })
    else if (kind === 1) ev.push({ type: 'step/start', seq, time, data: { turn, step: 1, pad: p } })
    else if (kind === 2) ev.push({ type: 'step/end', seq, time, data: { turn, step: 1, pad: p } })
    else if (kind === 3) ev.push({ type: 'turn/end', seq, time, data: { turn, reason: { kind: 'completed' }, pad: p } })
    else ev.push({ type: 'usage', seq, time, data: { turn, step: 1, usage: { inputTokens: 10, outputTokens: 20 }, pad: p } })
  }
  return ev
}

// 装载真实 jsonl 后端（0.2.1+ 只导出 cordis 插件，必须经 Context.plugin）。
async function loadJsonlBackend(dshRoot, root) {
  const { Context } = await import('@deepseek-ai/cordis')
  const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const ctx = new Context()
  ctx.plugin({ name: 'probe-jsonl', apply: (c, cfg) => jsonl.apply(c, cfg) }, { root, compression: 'zstd' })
  for (let i = 0; i < 150; i++) {
    const svc = ctx.get('sessionPersistence')
    if (svc !== undefined) return { ctx, service: svc }
    await sleep(20)
  }
  throw new Error('real jsonl backend did not register sessionPersistence')
}

// 生成会话并落盘。返回 { id, events, bytes, path }。
export async function generateSession({ dshRoot, sessionsRoot, id, eventCount, cwd, pad = 160 }) {
  const persistenceMod = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const sessionMod = await import('@deepseek-ai/dsh-session')
  const { Session, SESSION_FORMAT_VERSION, SessionStore } = sessionMod

  mkdirSync(sessionsRoot, { recursive: true })
  // 后端 root 就设成隔离 home 的 sessions 根：路径布局与 dsh 自己产出的完全一致
  // （<root>/<projectKey(cwd)>/<session-id>/session.v4.jsonl.zstd）。
  const { ctx, service } = await loadJsonlBackend(dshRoot, sessionsRoot)

  const header = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
  const events = buildEvents(eventCount, { pad })
  const session = Session.create(id, events, header)

  const handle = await service.create(session.header, { inheritedEventCount: 0 })
  await handle.append(session.snapshotEvents())
  await handle.close()

  // 关掉装载后端的 Context（释放文件句柄/表锁），否则 dsh 起不来同一个根。
  try { await ctx.stop?.() } catch { /* best effort */ }
  await sleep(200)

  const stored = await service.stat?.(id)
  const path = stored?.location?.path ?? null
  await persistenceMod // 保持 import 引用，避免被裁剪
  return { id, events: events.length, path, sessionStoreProto: typeof SessionStore }
}

export { dirname }
