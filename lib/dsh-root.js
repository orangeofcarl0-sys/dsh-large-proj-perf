// dsh 安装根解析：版本探针与 ws 发送计时共用同一组候选。
//
// 插件自己装在别处，`ws` 与 `@deepseek-ai/dsh` 的 package.json 都在 dsh 的安装
// 根下。候选按可靠性排序，逐条尝试、失败继续：
//
//   1. 宿主进程内可直接解析的 `@deepseek-ai/dsh/package.json`（最可靠）；
//   2. `process.argv[1]`（dsh 的 bin.js）上跳一级——bundle 形态下唯一线索；
//   3. `@deepseek-ai/dsh-session` 的安装路径上跳三级。
//
// 这里只产出**路径候选**，不读内容：调用方决定是读版本还是建 require。

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** 返回 dsh `package.json` 的路径候选（可能为空数组）。 */
export function dshPackageJsonCandidates() {
  const candidates = []
  try { candidates.push(require.resolve('@deepseek-ai/dsh/package.json')) } catch { /* 继续 */ }
  try {
    const entry = process.argv[1]
    if (typeof entry === 'string' && entry !== '') candidates.push(join(dirname(entry), '..', 'package.json'))
  } catch { /* 继续 */ }
  try {
    const sessionPkg = require.resolve('@deepseek-ai/dsh-session/package.json')
    candidates.push(join(dirname(sessionPkg), '..', '..', '..', 'package.json'))
  } catch { /* 继续 */ }
  return candidates
}
