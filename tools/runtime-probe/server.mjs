// 隔离 dsh 实例的启动 / 就绪 / RSS 采样 / 停止。
//
// home 覆盖靠 dsh 的 home 环境变量（bootstrap-only，不能写进 .env）；agents home
// 独立覆盖全局 AGENTS.md / skills。就绪标志是唯一一条：
//   dsh web: http://127.0.0.1:<port>/?token=<base64url>
// 失败走 stderr + <home>/logs/startup-*.log，stdout 永远不会有 token 行。

import { spawn, execFile, execFileSync } from 'node:child_process'
import { createWriteStream, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection } from 'node:net'

const DSH_BIN = process.env.DSH_BIN
  ?? 'C:/Users/66494/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'

// home / agents-home 的环境变量名由码点构造，而不是写字符串字面量。
// 原因：这两个名字以 "DSH" 开头，而本机的文本处理链会把 "DSH" 渲染成别的前缀，
// 直接写字面量会被替换成不存在的变量名（dsh 找不到该变量 → 回落到 ~/.dsh，
// 于是报 "profile does not exist"）。码点来源：dsh-home-paths/lib/index.js 的
// DSH_HOME_ENV / DSH_AGENTS_HOME_ENV 常量。
const HOME_ENV = String.fromCharCode(68, 83, 72, 95, 72, 79, 77, 69)
const AGENTS_ENV = String.fromCharCode(68, 83, 72, 95, 65, 71, 69, 78, 84, 83, 95, 72, 79, 77, 69)
const TELEMETRY_ENV = String.fromCharCode(68, 83, 72, 95, 84, 69, 76, 69, 77, 69, 84, 82, 89, 95, 68, 73, 83, 65, 66, 76, 69, 68)

const READY_RE = /dsh web: (https?:\/\/[^\s]*[?&]token=[A-Za-z0-9_-]+)/

// 起一个实例，等就绪，返回句柄。timeoutMs 到点仍无 token 行则抛错并附带日志尾部。
export async function startDsh({ home, agentsHome, profile, port, outDir, extraArgs = [], extraEnv = {}, readyTimeoutMs = 120000 }) {
  // 端口必须已释放：dsh 不重试也不自动换端口，占用时整个启动失败。
  if (!(await waitPortFree(port, 3000))) {
    throw new Error(`port ${port} is still in use; a previous dsh instance did not exit`)
  }
  const outLog = join(outDir, `dsh-${port}.out.log`)
  const errLog = join(outDir, `dsh-${port}.err.log`)
  const outStream = createWriteStream(outLog, { flags: 'w' })
  const errStream = createWriteStream(errLog, { flags: 'w' })

  const args = [DSH_BIN, '--profile', profile, '--host', '127.0.0.1', '--port', String(port), '--no-open', ...extraArgs]
  const child = spawn(process.execPath, args, {
    cwd: home,
    env: { ...process.env, [HOME_ENV]: home, [AGENTS_ENV]: agentsHome, [TELEMETRY_ENV]: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d.toString(); outStream.write(d) })
  child.stderr.on('data', (d) => { stderr += d.toString(); errStream.write(d) })

  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

  const deadline = Date.now() + readyTimeoutMs
  let match
  while (Date.now() < deadline) {
    match = READY_RE.exec(stdout)
    if (match !== null) break
    const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 250))])
    if (done !== null) {
      throw new Error(`dsh exited before readiness (code ${done.code})\n--- stderr ---\n${stderr.slice(-4000)}`)
    }
  }
  if (match === null) {
    child.kill()
    throw new Error(`dsh not ready within ${readyTimeoutMs}ms\n--- stdout tail ---\n${stdout.slice(-2000)}\n--- stderr tail ---\n${stderr.slice(-4000)}`)
  }

  const readyUrl = new URL(match[1])
  const token = readyUrl.searchParams.get('token')
  const origin = readyUrl.origin

  return {
    child,
    pid: child.pid,
    origin,
    token,
    readyUrl: match[1],
    logs: { out: outLog, err: errLog },
    readLogs: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode !== null) { outStream.end(); errStream.end(); return }
      // Windows 上 child.kill('SIGTERM') 不会让 node 退出（没有 SIGTERM 语义），
      // 必须 taskkill /T /F 连子进程树一起收掉，否则端口一直被占，下一次
      // startDsh 会 EADDRINUSE（实测踩过）。
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
      } catch { /* already gone */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
      outStream.end()
      errStream.end()
      await waitPortFree(port, 8000)
    },
  }
}

// 探测端口是否已释放；占用则等，超时后返回 false（调用方决定是否报错）。
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const done = (free) => { socket.destroy(); resolve(free) }
    socket.setTimeout(600)
    socket.once('connect', () => done(false))
    socket.once('timeout', () => done(true))
    socket.once('error', () => done(true))
  })
}

export async function waitPortFree(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// 按 PID 取进程工作集（RSS 等价物）。process.memoryUsage() 在别的进程里拿不到，
// 而 dsh 没有暴露内存端点，所以走 Win32_Process。
//
// 必须用异步版本：同步 execFileSync 会阻塞**探测器自己**的事件循环，导致正在
// await 的 RPC promise 无法推进，测量进程整个卡死（实测踩过）。
export function readRssMBAsync(pid) {
  return new Promise((resolve) => {
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").WorkingSetSize`,
    ], { encoding: 'utf8', timeout: 15000 }, (error, stdout) => {
      if (error) return resolve(null)
      const n = Number(String(stdout).trim())
      resolve(Number.isFinite(n) && n > 0 ? n / 1048576 : null)
    })
  })
}

export function readRssMB(pid) {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").WorkingSetSize`,
    ], { encoding: 'utf8', timeout: 15000 })
    const n = Number(String(out).trim())
    return Number.isFinite(n) && n > 0 ? n / 1048576 : null
  } catch { return null }
}

// 采样序列；异步、串行、不阻塞调用方。
export function startRssSampler(pid, intervalMs = 200) {
  const samples = []
  let running = false
  let stopped = false
  const tick = async () => {
    if (stopped || running) return
    running = true
    const mb = await readRssMBAsync(pid)
    running = false
    if (mb !== null) samples.push({ t: Date.now(), mb })
  }
  const timer = setInterval(tick, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  void tick()
  return {
    samples,
    stop() {
      stopped = true
      clearInterval(timer)
      const values = samples.map((s) => s.mb)
      if (values.length === 0) return { samples: 0, minMB: null, maxMB: null, deltaMB: null }
      return {
        samples: values.length,
        minMB: +Math.min(...values).toFixed(1),
        maxMB: +Math.max(...values).toFixed(1),
        deltaMB: +(Math.max(...values) - values[0]).toFixed(1),
      }
    },
  }
}

// 读启动日志里的 dsh-perf 行（供报告逐字引用）。
export function dshPerfLines(stdout) {
  return stdout.split('\n').filter((line) => line.includes('dsh-perf'))
}

export function homeLogsHint(home) {
  const dir = join(home, 'logs')
  return existsSync(dir) ? dir : null
}

export { DSH_BIN, readFileSync }
