// webServer API：/dsh-large-proj-perf/api（stats / config），回环 + 同源校验

import { performance } from 'node:perf_hooks'

import { DEFAULT_CONFIG, NS } from './config.js'

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
  req.on('data', (chunk) => { data += chunk; if (data.length > 16384) { reject(new Error('body too large')); req.destroy() } })
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
  req.on('error', reject)
})

const writeJson = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

export function installApi(pc, ictx) {
  const { ctx, config, stats, logErr, safeGet, setConfigValue, retrimPreparedCache, backfill, disposers } = pc
  const actx = ictx ?? ctx
  const webServer = safeGet(actx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') return
  const off = webServer.register({
    kind: 'prefix',
    path: '/dsh-large-proj-perf/api',
    handler: async (req, res) => {
      if (!isTrusted(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      let method = ''
      try { method = new URL(req.url || '/', 'http://dsh.internal').pathname.slice('/dsh-large-proj-perf/api/'.length) } catch { method = '' }
      if (!method || method.includes('/')) return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
      try {
        if (method === 'stats.get') return writeJson(res, 200, { ok: true, value: stats })
        if (method === 'stats.reset') {
          // 只清计数器与历史；fastInitForInstalled 是安装状态标志（非测量值），刻意保留
          stats.forks = 0; stats.zeroCopy = 0; stats.fallbacks = 0; stats.forkRecent = []
          stats.warmed = 0; stats.skipped = 0; stats.aborted = 0; stats.alreadyHot = 0; stats.backfilled = 0; stats.backfillSkipped = 0
          stats.coldWriteBacks = 0; stats.coldWriteBackSkipped = 0; stats.coldWriteBackFailed = 0
          stats.warmRecent = []; stats.backfill = []; stats.coldWriteBackRecent = []
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
          const before = { ...config }
          if (payload && typeof payload === 'object') {
            for (const key of Object.keys(DEFAULT_CONFIG)) {
              if (key in payload) setConfigValue(key, payload[key])
            }
          }
          if (config.preparedCacheTrim !== before.preparedCacheTrim
            || config.preparedCacheSize !== before.preparedCacheSize) {
            try { retrimPreparedCache?.() } catch (error) {
              logErr(`prepared cache retrim failed: ${String(error?.message ?? error)}`)
            }
          }
          // 开机定时器只触发一次；过后才打开 backfillOnBoot 的，立即补跑一次扫描
          if (!before.backfillOnBoot && config.backfillOnBoot && backfill?.isFired()) {
            Promise.resolve(backfill.backfillColdSessions()).catch((e) => logErr(`backfill scan failed: ${String(e?.message ?? e)}`))
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
