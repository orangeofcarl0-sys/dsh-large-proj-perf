// 隔离 dsh 实例的 HTTP 客户端：普通 RPC（/api/<ns>/<method>）+ 插件自有 API。
//
// 鉴权链路（dsh 0.2.2-rc.1）：
//   1) 启动日志给出 http://127.0.0.1:<port>/?token=<b64url>
//   2) GET /connect?token=<t>&interactions=none → 302 + set-cookie（v2 签名 cookie）
//   3) 带 cookie POST /api/<namespace>/<method>
//
// Host/Origin 校验：Host 必须是回环（127.0.0.1:port）；不带 Origin 头即放行
// （curl/Node 客户端路径），因此这里**故意不设 Origin**。
//
// RPC 信封：{type:'client-request', rpcId, method:'<ns>/<method>', payload:{args:{request:{...}}}}
// 响应：{type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error}}

import { performance } from 'node:perf_hooks'

export function makeClient({ origin, token }) {
  const base = new URL(origin)
  let cookie = ''

  const headers = (extra = {}) => {
    const h = { host: base.host, ...extra }
    if (cookie !== '') h.cookie = cookie
    return h
  }

  // 用 launch token 换 API cookie。redirect:'manual' 才能读到 302 的 set-cookie。
  async function connect() {
    const url = new URL('/connect', base)
    url.searchParams.set('token', token)
    url.searchParams.set('interactions', 'none')
    const res = await fetch(url, { redirect: 'manual', headers: headers() })
    if (res.status !== 302) throw new Error(`/connect expected 302, got ${res.status}`)
    const raw = res.headers.getSetCookie?.() ?? []
    const pair = raw.map((c) => c.split(';', 1)[0]).filter((c) => c.includes('=')).join('; ')
    if (pair === '') throw new Error('/connect returned no session cookie')
    cookie = pair
    return cookie
  }

  let rpcSeq = 0
  // 普通 RPC。args 原样放进信封的 payload.args：多数方法是 { request: {...} }，
  // 但 descriptor 里参数名为 `_request` 的方法（如 session/list）必须按定义名传，
  // 否则 gateway 报 `args fields do not match the descriptor`。
  async function rpc(namespace, method, request, { argName = 'request' } = {}) {
    const endpoint = `${namespace}/${method}`
    const body = {
      type: 'client-request',
      rpcId: `probe-${++rpcSeq}`,
      method: endpoint,
      payload: { args: { [argName]: request } },
    }
    const t0 = performance.now()
    const res = await fetch(new URL(`/api/${endpoint}`, base), {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    const wallMs = performance.now() - t0
    const text = await res.text()
    if (res.status !== 200) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`)
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error(`${endpoint} non-JSON: ${text.slice(0, 200)}`) }
    if (parsed?.result?.ok !== true) {
      const err = parsed?.result?.error
      throw new Error(`${endpoint} rpc error ${err?.code ?? '?'}: ${err?.message ?? 'unknown'}`)
    }
    return { value: parsed.result.value, wallMs }
  }

  // 插件自有 API（/dsh-large-proj-perf/api/<method>）。不需要 cookie，只要回环 Host。
  async function pluginApi(method, payload) {
    const t0 = performance.now()
    const res = await fetch(new URL(`/dsh-large-proj-perf/api/${method}`, base), {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload ?? {}),
    })
    const wallMs = performance.now() - t0
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error(`plugin api ${method} non-JSON: ${text.slice(0, 200)}`) }
    if (parsed?.ok !== true) throw new Error(`plugin api ${method} HTTP ${res.status}: ${text.slice(0, 300)}`)
    return { value: parsed.value, wallMs }
  }

  return {
    connect,
    rpc,
    pluginApi,
    getCookie: () => cookie,
    // 原始 RPC：不解析结果直接返回 { status, text, wallMs }，用于取完整错误体。
    rawRpc: async (namespace, method, args) => {
      const endpoint = `${namespace}/${method}`
      const t0 = performance.now()
      const res = await fetch(new URL(`/api/${endpoint}`, base), {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ type: 'client-request', rpcId: `raw-${++rpcSeq}`, method: endpoint, payload: { args } }),
      })
      return { status: res.status, text: await res.text(), wallMs: performance.now() - t0 }
    },
    stats: () => pluginApi('stats.get'),
    statsReset: () => pluginApi('stats.reset'),
    configGet: () => pluginApi('config.get'),
    configSet: (patch) => pluginApi('config.set', patch),
    debugFork: (sessionId) => pluginApi('debug.fork', { sessionId }),
    // 让出 N ms
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
