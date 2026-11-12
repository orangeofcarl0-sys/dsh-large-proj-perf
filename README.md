# DSH Large Project Performance

[![npm version](https://img.shields.io/npm/v/dsh-large-proj-perf.svg)](https://www.npmjs.com/package/dsh-large-proj-perf)
[![npm downloads](https://img.shields.io/npm/dm/dsh-large-proj-perf.svg?label=npm%20monthly)](https://www.npmjs.com/package/dsh-large-proj-perf)
[![npm total downloads](https://img.shields.io/npm/d18m/dsh-large-proj-perf.svg?label=npm%20total)](https://www.npmjs.com/package/dsh-large-proj-perf)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.1-green)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **⚠️ 最近发生重要更新**（1.10.x，破坏性）
>
> - **1.10.0 移除三项在 dsh 0.2.2 上恒不生效的能力**，配置键从 22 个减到 17 个
>   （`warmupEnabled` / `warmOnCreated` / `fastInitFor` / `preparedCacheTrim` /
>   `preparedCacheSize` 已删除），并修掉「改配置不生效」的晚绑定 bug。
> - 支持范围收紧为 **dsh >= 0.2.2-rc.1 且 < 0.3.0**。更旧的 dsh 上会被加载门禁
>   跳过（日志 `skipping profile bundle`）。
> - 性能里程碑来自 **1.8.0**（冷读 21.2 s → 3.0 s）与 **1.9.0**（稳态
>   RSS 1324 → 690 MB）。
>
> 从 1.4.0 或更早升级的用户，升级前请先读
> [CHANGELOG 的重要版本速览](CHANGELOG.md#重要版本速览)。

DeepSeek Harness（dsh）**大会话**性能插件。针对数十万事件的长会话，降低打开时的
延迟与内存占用。

> 包名里的 "large-proj" 是历史遗留；它优化的对象是**会话规模**，与项目大小无关。

每项能力都带**源码特征校验 + 协议探测 + 三层回退**（能力探测 / try-catch / 配置
开关）。dsh 内部结构变化时对应补丁会自动跳过并告警，功能回退到官方实现，不会出错。

## 能力与效果

数字都是 dsh 0.2.2 上的实测值，来源与测量边界见
[docs/MEASUREMENTS.md](docs/MEASUREMENTS.md)（时间/空间）与
[docs/RENDER-ANALYSIS.md](docs/RENDER-ANALYSIS.md)（浏览器渲染）。

| 能力 | 解决什么 | 实测效果 | 默认 |
|---|---|---|---|
| **turnOutline 折叠加速** | 该投影单元每次 turn 整数组复制（O(n²)），占冷读 76% | 冷读 **21.2 s → 3.0 s** | 开 |
| **事件缓存字节预算** | dsh 的缓存只按「会话条数」限容；6 个 18 MB 会话涨到 1.2 GB | 稳态 RSS **1324 → 690 MB** | 开（512 MiB） |
| **离屏行 containment** | 聊天列表没有虚拟滚动，已加载的每一行都参与布局 | 批量翻页阻塞 **2836 → 1489 ms**（-47%） | 开 |
| 分片 materialize | 落盘时把整个会话序列化成一个巨大字符串 | 2 帧 → 6 帧，消除 `RangeError` | 开 |
| 零拷贝 fork | fork 时逐事件深拷贝整个会话 | 直测 -16% ~ -21%（**但 UI 不走这条路**，见下） | 开 |
| 渲染耗时诊断 | 打开会话慢在哪一段无从得知 | `renderTiming` 记录首行/稳定/长任务 + 服务端分页 | 关 |
| 历史窗口预算 | 一页只按消息条数切，无字节上限 | 合成会话 70 KB/页，未触及；留给工具输出密集的会话 | 关 |
| 冷读回写 | 冷读后把投影状态写成缓存行 | **无耗时收益**，只让列表读看到新数据 | 关 |
| 冷会话补行 | 磁盘上的大会话没有投影缓存行 | 启动 15 s 后批量补写 | 关 |
| heap 上限告警 | V8 heap 上限过低时无任何提示 | 启动时检查并告警 | — |

### 两条必须知道的限制

**① `stats.patches` 显示 `active` 不等于在真实链路上被调用。**

零拷贝 fork 挂在 `SessionStore.prototype.fork` 上，而 dsh 0.2.2 的服务端
`session/fork` RPC 改走 `agents.create({seed})`，**不再调用该方法**——实测 Web UI
分支会话后 `stats.forks = 0`。补丁本身有效（用 `debugApi` 的 `debug.fork` 直测），
但在 UI 链路上是死代码。

**② 插件日志在默认配置下不可见。**

正常日志走 `ctx.logger.info`，dsh 默认日志级别会过滤掉它——隔离实例里
`[dsh-perf]` 行数为 0，尽管插件已正常装载。排错请用 `stats.get`，不要靠 grep 日志。

## 安装

要求 Node **≥ 22.15.0**（需要 `node:zlib` 的 zstd 接口）与 **dsh ≥ 0.2.2-rc.1**。

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

重启 `dsh web` 后，用 `stats.get` 确认装载成功（日志默认不可见，见上）：

```sh
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/stats.get
```

`file:` 安装是拷贝而非链接，不跟随源码改动。改完代码需要重新
`dsh plugin --profile web add file:<路径>`，或手动同步 `lib/`、`cordis.patch.yml`、
`package.json`、`icon.svg`、`locale/` 到
`<dsh home>/profiles/web/node_modules/dsh-large-proj-perf/`（dsh home 默认 `~/.dsh`）。

### 建议同时调高 V8 heap 上限

多个大会话并存时，每个 live 事件树可达数百 MB（实测 24 万事件 = 87.7 MB 堆对象，
首次读的 RSS 增量可达 242 MB）。heap 上限是**启动期参数**，进程内改不了：

```powershell
# 仓库自带脚本，内置 --max-old-space-size=8192
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1

# 或自己加参数
node --max-old-space-size=8192 <dsh 入口> web
```

插件会在上限低于 6 GiB 时打告警，但不会代为修改。

## 配置

可经 dsh 的 Settings 卡片、`config.set` API 或 settings 持久化修改。数值项带下限
钳制（非法值被收敛到下限），NaN / Infinity 直接拒绝。

| 键 | 默认 | 单位 | 说明 |
|---|---|---|---|
| `fastTurnOutline` | `true` | — | `turnOutline` 的 O(n²) → O(n) |
| `memoryBudgetBytes` | `536870912` | 字节 | 事件缓存总预算（512 MiB）；`0` 关闭 |
| `clientContainment` | `true` | — | 长转录离屏行 `content-visibility`（批量翻页阻塞 -47%） |
| `heapWarnBytes` | `6442450944` | 字节 | heap 上限告警阈值（6 GiB） |
| `zeroCopyFork` | `true` | — | 零拷贝 fork |
| `slowForkWarnMs` | `100` | ms | fork 耗时超过此值打告警 |
| `chunkedMaterialize` | `true` | — | 分片落盘 |
| `materializeChunkEvents` | `50000` | 事件 | 每帧事件数（下限 1000） |
| `minEvents` | `20000` | 事件 | 低于此事件数的会话不做额外处理 |
| `chunkSize` | `5000` | 事件 | 分片遍历每片的事件数（下限 1） |
| `chunkYieldMs` | `0` | ms | 让出方式：0 = `setImmediate`，>0 = `setTimeout` |
| `keepRecent` | `50` | 条 | 内存保留的最近统计记录数 |
| `renderTiming` | `false` | — | 渲染诊断：服务端分页/投影计时 + 浏览器首行/长任务 |
| `maxInitialMessages` | `0` | 条 | 首屏消息上限（同时压 `turnWindow.minMessages`）；`0` 不限制 |
| `maxPageBytes` | `0` | 字节 | 单页估算字节上限；`0` 不限制 |
| `coldWriteBack` | `false` | — | 冷读后回写投影缓存行（无耗时收益） |
| `backfillOnBoot` | `false` | — | 启动后补写磁盘冷会话的投影缓存行 |
| `backfillMaxSessions` | `8` | 个 | 补行扫描会话数上限 |
| `backfillMinBytes` | `1048576` | 字节 | 补行的最小文件大小（1 MiB） |
| `backfillMaxBytes` | `33554432` | 字节 | 补行的最大文件大小（32 MiB） |
| `debugApi` | `false` | — | 暴露 `debug.fork` 调试端点（仅用于测量） |

**哪些键运行期改得动**：`fastTurnOutline` / `chunkedMaterialize` / `zeroCopyFork` /
`maxInitialMessages` / `maxPageBytes` 只在安装时读一次，改了要重启（或用启动期
环境变量，见下）；`clientContainment` 由浏览器在启动时取一次。其余键在下次使用时重读。

启动期还可用环境变量覆盖任意配置键（仅用于离线测量）：键名是大写蛇形加
`DSH_PERF_` 前缀，例如 `DSH_PERF_CHUNKED_MATERIALIZE=false`。

## 验证与排错

### HTTP API

`POST http://127.0.0.1:<dsh 端口>/dsh-large-proj-perf/api/<method>`，仅接受回环地址
且校验同源。端口由 dsh 的 web app 决定（默认 3080）：

| 端点 | 说明 |
|---|---|
| `stats.get` | 版本探针、各补丁状态与命中计数 |
| `stats.reset` | 清零计数（保留 `patches` 与 `dshVersion`） |
| `config.get` / `config.set` | 读取/修改运行时开关，`set` 同时写 settings 持久化 |
| `debug.fork` | 仅当 `debugApi=true` 时存在：直接调用 `SessionStore.prototype.fork` |
| `perf.report` | 仅当 `renderTiming=true` 时存在：浏览器回传首行/稳定/长任务样本 |

```sh
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/stats.get

# config.set 提交「键 → 值」扁平对象，可一次改多个键
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/config.set \
  -H 'Content-Type: application/json' -d '{"backfillOnBoot":true}'
```

请求体是扁平对象（如 `{"minEvents":20000,"chunkSize":5000}`），**不是**
`{"key":...,"value":...}`——后者会被静默忽略：接口仍返回 200 和当前配置，
但一个键都没改。

### `stats.get` 怎么读

```jsonc
{
  "dshVersion": "0.2.2-rc.1",
  "patches": { "zeroCopyFork": "active", "fastTurnOutline": "active", ... },
  "forks": 0, "zeroCopy": 0, "fallbacks": 0, "forkRecent": [],
  "memoryBudget": { "budgetBytes": 536870912, "cachedEntries": 0, "estimatedBytes": 0 },
  "memoryBudgetTrimmed": 0, "memoryBudgetFreedBytes": 0, "memoryBudgetOverBudget": 0,
  "coldWriteBacks": 0, "backfilled": 0, "backfillSkipped": 0,
  "render": {
    "snapshotCount": 0, "snapshotMs": 0, "snapshotMaxMs": 0, "lastUnits": 0,
    "pages": [], "clients": [], "reports": 0, "dropped": 0
  }
}
```

`render` 只在 `renderTiming=true` 时有值：`pages` 是服务端每页的
`{kind, ms, maxMessages, records, bytes}`，`clients` 是浏览器回传的
`{kind, rows, firstRowMs, settleMs, longTasks, blockingMs, maxTaskMs, heapMB}`。
读法与实测见 [docs/RENDER-ANALYSIS.md](docs/RENDER-ANALYSIS.md)。

判断某能力是否真的在起作用，看命中计数而不是 `patches`：

| 想知道 | 看 |
|---|---|
| 零拷贝 fork 有没有被调用 | `zeroCopy`（长期 0 = 没被调用） |
| 内存预算有没有在淘汰 | `memoryBudgetTrimmed`（>0 说明生效） |
| 冷读回写 / 补行有没有跑 | `coldWriteBacks` / `backfilled` |

### 常见问题

**看不到任何 `[dsh-perf]` 日志**
这是**默认配置下的常态**，不是故障（见上文「两条必须知道的限制」）。用 `stats.get`
判断插件状态。

**`stats.patches` 显示 `active`，但好像没效果**
`active` 只表示装上了，不表示被调用。用上表的命中计数判断。

**日志出现 `signature mismatch`**
dsh 内部结构已变，对应补丁已自动跳过（功能回退到官方实现，不影响正确性）。升级本
插件到与新 dsh 匹配的版本即可。注意 `tests/` 不随 npm 包发布，从 npm 安装的情况下
无法在安装目录里跑兼容性检查——升级插件是唯一正解。

**日志出现 `skipping profile bundle`**
插件被 dsh 的版本门禁拦下了。从 dsh 0.2.1 起，门禁读插件 `package.json` 的
`engines.dsh`；本插件声明 `>=0.2.2-rc.1 <0.3.0-0`。dsh 超出该范围时，要么升级插件，
要么用 `dsh plugin allow-version <pkg>@<ver> --profile web` 做精确版本豁免（有风险）。

**API 请求 404 或连不上**
端口可能不是 3080。看 `dsh web` 启动日志里打印的 URL，或 `dsh web --help` 确认。

**改完配置没反应**
三种情况：`fastTurnOutline` / `chunkedMaterialize` / `zeroCopyFork` /
`maxInitialMessages` / `maxPageBytes` 只在安装时读一次，改了要重启；
`clientContainment` 由浏览器在页面启动时取一次，改完刷新页面；`backfillOnBoot`
相关的补行任务在启动 15 秒后才跑；其余开关通过 `config.set` 修改后即时生效。

**没有任何 `[dsh-perf]` 日志且 `stats.get` 也连不上**
插件没被加载。检查 `dsh --profile web --dump-config` 里是否有 `large-proj-perf`
条目，以及启动日志有无 `skipping profile bundle`。

## 已知限制

- **这是被动优化**，削减不了正在使用的 live 事件树（每会话数百 MB 是物理成本）。
  建议配合 [dsh-fresh-start](https://github.com/orangeofcarl0-sys/dsh-fresh-start)
  主动控制会话规模。
- **零拷贝 fork 在 dsh 0.2.2 的 UI fork 链路上不生效**（原因见上）。
- **只验证过 dsh 0.2.2**。`engines.dsh` 声明为 `>=0.2.2-rc.1 <0.3.0-0`——更旧的
  dsh 上插件能力已基本为零（v1.10.0 移除三项依赖旧结构的能力后，0.1.x 只剩零拷贝
  fork 与分片 materialize），因此直接由门禁拒绝，而不是让用户装上一个近乎空转的
  插件。0.3.x 上会被同样拒绝，届时需要新版本插件。
- **打开一个会话的字节大头不是消息，是投影**：实测一次打开 74 KB 消息 +
  **6.76 MB 投影**（`turnOutline` 装着全部 turn）。这不是插件能削减的部分，
  诊断数据与上游建议见 [docs/RENDER-ANALYSIS.md](docs/RENDER-ANALYSIS.md)。
- **浏览器侧没有虚拟滚动**（上游 `ChatFlow` 直接 `entries.map()`）。插件只能用
  `content-visibility` 减轻离屏行的布局代价，不能减少挂载数量；向上翻页会持续
  累积 DOM 与堆（实测约 73 KB/行）。
- **`retired` 补丁状态当前无使用者**：v1.10.0 移除了唯一会设置它的能力。保留该状态
  是因为它是「上游吸收能力后补丁主动让位」的唯一表达。

## 开发

```sh
# 前置：把全局 dsh 的嵌套依赖 junction 到仓库（仓库本身不含 node_modules）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1

# 全套 11 个套件（运行器会打印实测断言总数，当前 250）
npm test
```

测试分三层：`verify_compat` 对真实安装的 dsh 源码做特征断言并实算版本门禁；
`e2e_real_components` 用真实实现类（原型链驱动）验证补丁装上后的行为；其余套件
覆盖逻辑与边界。

这三层都**不验证真实 dsh 进程里的调用链**。那需要起一个隔离实例并驱动 HTTP RPC，
工具在 [`tools/runtime-probe/`](tools/runtime-probe/README.md)：

```sh
node tools/runtime-probe/run.mjs --home <隔离 home> --agents <agents home> \
  --port 3190 --scenario all --out <输出目录>
```

## 文档

| 文档 | 读者 | 内容 |
|---|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 维护者 | 问题分类、各能力的探测与实现、装配契约、如何新增能力 |
| [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) | 维护者 | 时间/空间两维度的实测数据、测量边界、已移除能力的记录 |
| [docs/RENDER-ANALYSIS.md](docs/RENDER-ANALYSIS.md) | 维护者 | 浏览器渲染链路：静态机制、真实浏览器实测、瓶颈排序与上游建议 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | 维护者 | 版本矩阵、0.2.2 的五处破坏性变更、插件清单规范 |
| [docs/HARNESS-COMPARISON.md](docs/HARNESS-COMPARISON.md) | 参考 | 其他 coding agent harness 怎么处理长会话 |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | 发布者 | 发布流程与约定 |
| [CHANGELOG.md](CHANGELOG.md) | — | 版本变更记录 |
