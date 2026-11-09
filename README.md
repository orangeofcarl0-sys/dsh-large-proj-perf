# dsh-large-proj-perf

[![npm version](https://img.shields.io/npm/v/dsh-large-proj-perf.svg)](https://www.npmjs.com/package/dsh-large-proj-perf)
[![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.1-green)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DeepSeek Harness（dsh）**大会话**性能插件。针对数十万事件的长会话，消除 fork、
历史会话打开、超大会话落盘对事件循环的阻塞，并治理冷会话内存。

> 名字里的 "large-proj" 是历史遗留；它优化的对象是**会话规模**，与项目大小无关。

四项优化都以补丁形式挂在 dsh 内部方法上，每项都带**源码特征校验 + 协议探测 +
三层回退**（能力探测 / try-catch / 配置开关）。dsh 内部结构变化时对应补丁会自动
跳过并告警，功能回退到官方实现，不会出错。

## 能力与效果

| 能力 | 解决什么 | 效果 | 状态 |
|---|---|---|---|
| 零拷贝 fork | fork 时逐事件深拷贝整个会话 | 20k 事件 fork 数百 ms → 个位数 ms | 补丁 |
| 分片投影预热 | 打开历史会话时同步冷折叠冻结事件循环 | 74 万事件从分钟级降到亚秒级 | 补丁 |
| 分片 materialize | 落盘时把整个会话序列化成一个巨大字符串 | 多帧 zstd，字节兼容 | 补丁 |
| fork 缓存回填 | fork 子会话没有投影缓存行，重开走全量读 | 预热后即时可见 | 补丁 |
| 冷会话 LRU 裁剪 | 冷会话事件树各占数百 MB，多份叠加 OOM | 降低驻留份数 | 补丁 |
| heap 上限告警 | V8 heap 上限过低时无任何提示 | 启动即告警并给出参数建议 | 运行时检查 |

「补丁」的实际状态经 `stats.get` 的 `patches` 字段暴露，取值：

- `active` — 已安装生效
- `inactive` — 环境里没有对应结构，或源码特征不匹配（自动跳过）
- `off` — 被配置显式关闭
- `retired` — 上游已原生实现该能力，补丁主动退役（目前只有 `fastInitFor` 会到这一步）

`heap 上限告警` 不是补丁，不在 `stats.patches` 里。

## 安装

要求 Node **≥ 22.15.0**（需要 `node:zlib` 的 zstd 接口），dsh `0.1.0-rc.6` ~ `0.2.2-rc.1`。

> 上方 `dsh` 徽章标注的是**当前开发基线**（最近一次实测通过的版本），不是支持范围的全部。
> 实际允许范围见 `package.json` 的 `engines.dsh`。

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-large-proj-perf

# 从 GitHub 安装
dsh plugin --profile web add github:orangeofcarl0-sys/dsh-large-proj-perf

# 本地开发（指向工作副本）
dsh plugin --profile web add file:<本仓库路径>

# 卸载
dsh plugin --profile web remove dsh-large-proj-perf
```

重启 `dsh web` 后，启动日志出现这一行即装载成功：

```
[dsh-perf] installed (zeroCopy=true, fastInitFor=true, warmup=true minEvents=20000, chunkedMaterialize=true)
```

`file:` 安装是拷贝而非链接，不跟随源码改动。改完代码需要重新
`dsh plugin --profile web add file:<路径>`，或手动同步 `lib/`、`cordis.patch.yml`、
`package.json`、`icon.svg`、`locale/` 到
`<dsh home>/profiles/web/node_modules/dsh-large-proj-perf/`（dsh home 默认 `~/.dsh`）。

### 建议同时调高 V8 heap 上限

多个大会话并存时，每个 live 事件树可达数百 MB，默认 ~4GB 上限容易 OOM。heap 上限是
**启动期参数**，进程内改不了：

```powershell
# 仓库自带脚本，内置 --max-old-space-size=8192
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1

# 或自己加参数
node --max-old-space-size=8192 <dsh 入口> web
```

插件会在上限低于 6GB 时打告警，但不会代为修改。

## 配置

可经 dsh 的 Settings 卡片、`config.set` API 或 settings 持久化修改。数值项带下限
钳制（非法值被收敛到下限），NaN / Infinity 直接拒绝。

| 键 | 默认 | 单位 | 说明 |
|---|---|---|---|
| `zeroCopyFork` | `true` | — | 零拷贝 fork |
| `fastInitFor` | `true` | — | fast initFor（新版 dsh 自动退役） |
| `slowForkWarnMs` | `100` | ms | fork 耗时超过此值打告警 |
| `warmupEnabled` | `true` | — | 投影分片预热总开关 |
| `minEvents` | `20000` | 事件 | 低于此事件数不预热 |
| `chunkSize` | `5000` | 事件 | 每片折叠事件数（下限 1） |
| `chunkYieldMs` | `0` | ms | 让出方式：0 = `setImmediate`，>0 = `setTimeout` |
| `warmOnCreated` | `true` | — | `session/created`（含 resume）即预热 |
| `keepRecent` | `50` | 条 | 内存保留的最近统计记录数 |
| `backfillOnBoot` | `false` | — | 启动后补写磁盘冷会话的投影缓存行 |
| `backfillMaxSessions` | `8` | 个 | 补行扫描会话数上限 |
| `backfillMinBytes` | `1048576` | 字节 | 补行的最小文件大小（1 MiB） |
| `backfillMaxBytes` | `33554432` | 字节 | 补行的最大文件大小（32 MiB） |
| `chunkedMaterialize` | `true` | — | 分片落盘 |
| `materializeChunkEvents` | `50000` | 事件 | 每帧事件数（下限 1000） |
| `preparedCacheTrim` | `true` | — | 冷会话 LRU 裁剪总开关 |
| `preparedCacheSize` | `1` | 份 | 裁剪目标容量（dsh 官方默认 5） |
| `heapWarnBytes` | `6442450944` | 字节 | heap 上限告警阈值（6 GiB） |

`backfillOnBoot` 默认关闭：它的解码在插件层同步执行，超大文件仍可能短暂冻结事件
循环，需要时再开。开启后补行任务在启动 **15 秒**后触发，不会立刻执行。

## 验证与排错

启动日志会打印探测到的 dsh 版本和各补丁结果，例如：

```
[dsh-perf] dsh version: 0.2.2-rc.1 (verified)
[dsh-perf] zero-copy fork installed (SessionStore.prototype.fork patched, protocol: 0.1.7 forkSeed)
[dsh-perf] chunked materialize installed (chunk=50000 events/frame, protocol: 0.1.3)
```

`protocol:` 后面可能是 `0.1.7 forkSeed`、`0.1.3 eventState`、`alpha.5 seedSource`
之一，取决于 dsh 版本，都是正常输出。

### HTTP API

`POST http://127.0.0.1:<dsh 端口>/dsh-large-proj-perf/api/<method>`，仅接受回环地址
且校验同源。端口由 dsh 的 web app 决定（默认 3080）：

| 端点 | 说明 |
|---|---|
| `stats.get` | 版本探针、各补丁状态、fork/预热/补行计数与最近记录 |
| `stats.reset` | 清零计数（保留版本探针、补丁状态与 `fastInitForInstalled`） |
| `config.get` / `config.set` | 读取/修改运行时开关，`set` 同时写 settings 持久化 |

```sh
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/stats.get

# config.set 提交「键 → 值」扁平对象，可一次改多个键
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/config.set \
  -H 'Content-Type: application/json' -d '{"backfillOnBoot":true}'
```

请求体是扁平对象（如 `{"minEvents":20000,"chunkSize":5000}`），**不是**
`{"key":...,"value":...}` 形式——后者会被静默忽略：接口仍返回 200 和当前配置，
但一个键都没改。

### 常见问题

**日志出现 `signature mismatch`**
dsh 内部结构已变，对应补丁已自动跳过（功能回退到官方实现，不影响正确性）。升级本
插件到与新 dsh 匹配的版本即可。注意 `tests/` 不随 npm 包发布，如果你是从 npm 安装
的，无法在安装目录里跑兼容性检查——升级插件是唯一正解。

**日志出现 `skipping profile bundle`**
插件被 dsh 的版本门禁拦下了。从 dsh 0.2.1 起，门禁读插件 `package.json` 的
`engines.dsh`；本插件声明 `>=0.1.0-rc.6 <0.3.0-0`。dsh 超出该范围时，要么升级插件，
要么用 `dsh plugin allow-version <pkg>@<ver> --profile web` 做精确版本豁免（有风险，
上游可能确实改了插件依赖的结构）。

**API 请求 404 或连不上**
端口可能不是 3080。看 `dsh web` 启动日志里打印的 URL，或 `dsh web --help` 确认。

**改完配置没反应**
`backfillOnBoot` 相关的补行任务在启动 15 秒后才跑；其余开关（`chunkSize`、
`preparedCacheSize` 等）通过 `config.set` 修改后即时生效。经 Settings 卡片修改需
确认已保存到 settings。

**没有任何 `[dsh-perf]` 日志**
插件没被加载。检查 `dsh --profile web --dump-config` 里是否有 `large-proj-perf`
条目，以及启动日志有无 `skipping profile bundle`。

## 已知限制

- **这是被动优化**，削减不了正在使用的 live 事件树（每会话数百 MB 是物理成本）。
  建议配合 [dsh-fresh-start](https://github.com/orangeofcarl0-sys/dsh-fresh-start)
  主动控制会话规模。
- `backfillOnBoot` 的解码在插件层同步执行，超大文件仍可能短暂冻结事件循环。
- `preparedCacheTrim` 在新版 dsh 上会自动跳空为 `inactive`（上游已用
  `COLD_LOG_MEMO_MAX_ENTRIES` + 懒 materialize 系统代偿），只在老版本上生效。
- 若其他插件禁用了 `session-projection-cache`，本插件的缓存与预热能力会被削弱。

## 开发

```sh
# 前置：把全局 dsh 的嵌套依赖 junction 到仓库（仓库本身不含 node_modules）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1

# 全套 8 套件
npm test
```

运行器会打印实测断言总数。测试分三层：`verify_compat` 对真实安装的 dsh 源码做特征
断言并实算版本门禁；`e2e_real_components` 用真实实现类（原型链驱动）验证补丁装上后
的行为；其余套件覆盖逻辑与边界。

## 深入阅读

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 四类阻塞的定位、各补丁的探测条件与行为、装配契约、如何新增补丁 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | 版本矩阵、破坏性变更记录、版本门禁语义、插件清单规范 |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | 发布流程与约定 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
