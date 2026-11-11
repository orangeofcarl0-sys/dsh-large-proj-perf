// webServer API：/dsh-large-proj-perf/api（stats / config），回环 + 同源校验

import { performance } from 'node:perf_hooks'

import { API_BODY_LIMIT_BYTES } from './constants.js'
import { DEFAULT_CONFIG, NS } from './config.js'

const API_PREFIX = '/dsh-large-proj-perf/api'

// 仅回环地址 + 同源（Host/Origin/sec-fetch-site 三重校验），LAN 不可达
const isTrusted = (request) => {
  try {
    const host = request.headers && request.headers.host
    if (typeof host !== 'string' || host === '') return false
    const hostUrl = new URL('http://' + host)
    const hostname = hostUrl.hostname
    const loopback = hostname === 'localhost' || hostname === '[::1]'
      || (hostname.split('.').length === 4 && hostname.split('.')[0] === '127'
        && hostname.split('.').every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
    if (!loopback) return false
    if (request.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = request.headers.origin
    if (origin === void 0) return true
    return new URL(origin).host === hostUrl.host
  } catch { return false }
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    data += chunk
    if (data.length > API_BODY_LIMIT_BYTES) { reject(new Error('body too large')); req.destroy() }
  })
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
  req.on('error', reject)
})

const writeJson = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

/**
 * 安装插件自有 API。
 *
 * @param deps - 只读依赖（见 context.js）
 * @param runtime - 晚绑定槽。**必须在每次请求时**通过它取 backfill 句柄——
 *   在装配时解构会重现 v1.9.0 及之前的晚绑定 bug（webServer 先于
 *   sessionPersistence 就绪，解构到的是 undefined，之后永不更新）。
 */
export function installApi(deps, runtime) {
  const { ctx, config, stats, logErr, safeGet, setConfigValue, disposers } = deps
  const webServer = safeGet(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') return

  const off = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      let method = ''
      try { method = new URL(req.url || '/', 'http://dsh.internal').pathname.slice(API_PREFIX.length + 1) } catch { method = '' }
      if (!method || method.includes('/')) return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })

      try {
        if (method === 'stats.get') return writeJson(res, 200, { ok: true, value: stats })

        if (method === 'stats.reset') {
          // 只清计数器与历史；patches 与 dshVersion 是安装状态，刻意保留。
          stats.forks = 0; stats.zeroCopy = 0; stats.fallbacks = 0; stats.forkRecent = []
          stats.backfilled = 0; stats.backfillSkipped = 0; stats.backfill = []
          stats.coldWriteBacks = 0; stats.coldWriteBackSkipped = 0; stats.coldWriteBackFailed = 0
          stats.coldWriteBackRecent = []
          stats.memoryBudgetTrimmed = 0; stats.memoryBudgetFreedBytes = 0; stats.memoryBudgetOverBudget = 0
          return writeJson(res, 200, { ok: true })
        }

        if (method === 'config.get') return writeJson(res, 200, { ok: true, value: config })

        // 调试观测面：直接调 SessionStore.prototype.fork（零拷贝补丁的唯一挂载点）。
        // dsh 0.2.2 起服务端 session/fork RPC 改走 agents.create({seed})，不再经过
        // 该方法，因此 HTTP 侧常规路径测不到补丁；此端点仅用于运行时测量。
        if (method === 'debug.fork') {
          if (!config.debugApi) return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'debug endpoints disabled (set debugApi=true)' } })
          const payload = await readBody(req)
          const sessionId = payload?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') return writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } })
          const store = ctx.sessions
          if (store === void 0 || typeof store.fork !== 'function') return writeJson(res, 500, { ok: false, error: { code: 'unavailable', message: 'ctx.sessions.fork is unavailable' } })
          const t0 = performance.now()
          const child = store.fork(sessionId)
          const ms = performance.now() - t0
          const last = stats.forkRecent.at(-1)
          return writeJson(res, 200, { ok: true, value: { childId: child?.id ?? null, wallMs: ms, record: last ?? null } })
        }

        if (method === 'config.set') {
          const payload = await readBody(req)
          const beforeBackfillOnBoot = config.backfillOnBoot
          if (payload && typeof payload === 'object') {
            for (const key of Object.keys(DEFAULT_CONFIG)) {
              if (key in payload) setConfigValue(key, payload[key])
            }
          }
          // 启动定时器只触发一次；过后才打开 backfillOnBoot 的，立即补跑一次扫描。
          // 句柄必须**此刻**从 runtime 取——装配时它还不存在。
          const backfill = runtime.backfill.get()
          if (!beforeBackfillOnBoot && config.backfillOnBoot && backfill?.isFired()) {
            Promise.resolve(backfill.backfillColdSessions())
              .catch((e) => logErr(`backfill scan failed: ${String(e?.message ?? e)}`))
          }
          try {
            const settings = ctx.get('settings')
            if (settings && typeof settings.update === 'function') await settings.update(NS, { ...config })
          } catch { /* 内存态已生效 */ }
          return writeJson(res, 200, { ok: true, value: config })
        }

        return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
      } catch (error) {
        return writeJson(res, 500, { ok: false, error: { code: 'rejected', message: String(error?.message ?? error) } })
      }
    },
  })
  if (typeof off === 'function') disposers.push(off)
}
