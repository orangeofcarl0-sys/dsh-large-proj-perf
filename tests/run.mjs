// 测试运行器：每个套件在**独立子进程**中执行。
//
// 为什么不用 `&&` 串起来：所有套件跑在同一个 Node 进程里时，重负载套件
// （test_chunked_materialize 反复 zstd 压缩/解压数十 MB 文本）留下的堆碎片与
// 大对象会累积，最终在 V8 堆上触发偶发崩溃（发布时实测出现过 exit 134）。
// 每套件一个进程既隔离内存、又让单个套件的崩溃不影响其余套件的结论。
//
// 汇总里打印**实测断言数**（统计各套件 stdout 的 PASS/FAIL 行）。文档引用断言
// 总数时应取自本输出，而不是手写一个数字——手写的会随测试增删漂移。

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// 运行顺序：兼容性/契约 → 各点位 → 真实组件 e2e（重负载放最后）
const ORDER = [
  'verify_compat.mjs',
  'verify_docs.mjs',
  'test_context.mjs',
  'test_patch_target.mjs',
  'test_client_bundle.mjs',
  'smoke_fork.mjs',
  'test_cold_writeback.mjs',
  'test_fast_turn_outline.mjs',
  'test_memory_budget.mjs',
  'test_render_timing.mjs',
  'test_backfill.mjs',
  'test_chunked_materialize.mjs',
  'e2e_real_components.mjs',
]

const present = new Set(readdirSync(here).filter((f) => f.endsWith('.mjs')))
// ORDER 里列了但文件不存在，是配置错误（拼写/误删），必须显式失败；
// 旧实现会静默跳过，少跑套件也报“全绿”。
const missing = ORDER.filter((f) => !present.has(f))
if (missing.length > 0) {
  console.error(`ORDER 中的测试文件不存在：${missing.join(', ')}`)
  process.exit(1)
}
const suites = ORDER.filter((f) => present.has(f))
const unknown = [...present].filter((f) => !ORDER.includes(f) && f !== 'run.mjs' && f !== 'zstd_frames.mjs' && !f.startsWith('bench_'))
if (unknown.length > 0) {
  console.error(`未纳入运行器的测试文件：${unknown.join(', ')}`)
  process.exit(1)
}

let failed = 0
let assertions = 0
const results = []
for (const suite of suites) {
  const started = Date.now()
  // 用 pipe 而非 inherit，以便同时转发输出并统计断言行。
  // 超时兜底：单个套件卡死不应让整轮 CI 永久挂住。
  const r = spawnSync(process.execPath, [join(here, suite)], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    timeout: 600000,
  })
  const out = r.stdout ?? ''
  if (out !== '') process.stdout.write(out)
  let suiteAssertions = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('PASS ') || line.startsWith('FAIL ')) suiteAssertions += 1
  }
  assertions += suiteAssertions
  const ms = Date.now() - started
  const ok = r.status === 0
  if (!ok) failed += 1
  results.push({ suite, ok, ms, status: r.status, signal: r.signal, assertions: suiteAssertions })
}

console.log('\n================ 汇总 ================')
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL'
  const detail = r.ok
    ? `${r.ms}ms  ${r.assertions} 断言`
    : `exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}  ${r.assertions} 断言`
  console.log(`${mark}  ${r.suite.padEnd(30)} ${detail}`)
}
console.log(`${suites.length - failed}/${suites.length} 套件通过，共 ${assertions} 条断言`)

process.exit(failed === 0 ? 0 : 1)
