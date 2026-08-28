# dsh-large-proj-perf

[![Version](https://img.shields.io/badge/version-1.1.1-blue)]()
[![dsh](https://img.shields.io/badge/dsh-0.1.0..0.1.1--rc-green)]()
[![dsh-std](https://img.shields.io/badge/dsh--std-Community_v0.15-blue)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DSH（DeepSeek Harness）大会话性能插件：零拷贝 fork、投影分片预热、分片 materialize、
冷会话内存治理——一次装齐，消除 fork / 历史加载 / 落盘对超大会话（数十万事件）的
事件循环阻塞与 OOM。所有优化带源码特征校验与三层回退，上游吸收某项能力后对应
补丁**自动退役**。

## 特性一览

| 能力 | 解决什么 | 实测 | 状态（rc.2） |
|---|---|---|---|
| 零拷贝 fork | fork 时逐事件深拷贝阻塞 | 346ms → 19ms | 活跃 |
| 分片投影预热 | 打开历史会话的同步冷折叠冻结事件循环 | 74 万事件 20min → ~200ms | 活跃 |
| fork 缓存回填 | fork 子会话无投影缓存行，重开走全量读 | 分钟级 → 秒级 | 活跃 |
| 分片 materialize | fork 落盘单巨字符串：60 万事件 501MB、74 万直接 RangeError | 多帧 zstd，字节兼容 | 活跃 |
| 冷会话 LRU 裁剪 | 冷会话事件树 ~700MB/个 ×5 叠加 OOM | 省 ~2.8GB | 活跃 |
| fast initFor | persistence 的 `structuredClone(seed)` | 135ms → ~0ms | 已退役（rc.8 上游原生实现） |
| heap 检测 | V8 heap 上限过低告警 | 运维辅助 | 活跃 |
| dsh-std 兼容 | Community v0.15 清单 + facet 入口 | 面向未来宿主 | 就绪 |

运行时各补丁的实际状态经 `stats.get` 的 `patches` 字段暴露（`active`/`retired`/
`inactive`/`off`）——**插件按项退役而非整体下线，全部转 `retired` 之日即退役之时**。

## 工作原理

dsh 0.1.x 在大会话上有三类同步阻塞（源码级定位 + 实测）：

| 问题 | 环节 | 实测 |
|---|---|---|
| A. fork 深拷贝 | `Session` 构造器逐事件 `snapshotJsonValue` + persistence `initFor` 的 `structuredClone(seed)` | 18.2MB/20k 事件合计 ~480ms |
| B. projection 冷折叠 | `cellFor()` 冷时同步 `buildCell` 全量折叠 | 74 万事件阻塞 20+ 分钟（100% 单核） |
| C. fork 全量序列化 | `encodeMaterialization` 一次性序列化整个 seed | 60 万事件 501MB 单串；74 万 RangeError |

对应方案（全部独立开关、失败自动回退官方实现）：

1. **零拷贝 fork**：fork 的 seed 是 `deepFreeze` 不可变 JSON 树，改走
   `Session.prepare(seedSource:'persistence')` 的 fromRestore 通道原地冻结复用引用；
   子会话 header 与官方逐字段一致。
2. **分片投影预热**：会话进入且事件数超阈值时，抢在首次冷折叠前分片重放 cells
   （每片间 `setImmediate` 让出），直写 `registration.cells`；有投影缓存行时取基线
   跳过已折叠前缀。fork 子会话预热后回填缓存行。
3. **分片 materialize**：每 `materializeChunkEvents` 事件一个 zstd frame（多帧是
   解码端 `scanZstdFrames` 原生格式，字节兼容），消除单巨字符串。
4. **冷会话 LRU 裁剪**：运行时把 `SessionPreparations.capacity` 降到
   `preparedCacheSize`（默认 1）并淘汰最旧 ready 条目；`config.set` 即时生效，
   dispose 恢复原 capacity。
5. **fast initFor**：`structuredClone(seed)` → 冻结引用复用。rc.8 起上游原生实现
   （`const seed = session.events`），补丁自动退役——特征缺失但检测到上游零拷贝
   形态时打 info，不误报漂移。
6. **heap 检测**：heap 上限低于阈值（默认 6GB）时告警并引导加
   `--max-old-space-size`。

安全性：共享冻结引用与深拷贝语义等价（事件进入源会话时已完整校验并深冻结）；
所有补丁带源码特征校验，不符自动跳过并告警，绝不盲补；三层回退（能力探测 /
try-catch / 配置开关）；dispose 完整还原。

## 与上游 dsh 的关系

本插件通过 monkey-patch 内部方法实现，**与 dsh 版本高度耦合**。已在
`0.1.0-rc.6` / `rc.7` / `rc.8` / `0.1.1-rc.1` / `rc.2` 上开发并验证。升级 dsh 后：

- 启动日志会显示 `dsh version: x.y.z (verified)`（探针）或列表外版本告警；
- 跑 `node tests/verify_compat.mjs`（对真实安装源码做 16 项结构断言）；
- 确认无 `signature mismatch` 告警——补丁不匹配时自动跳过（不崩溃），但优化
  会静默失效。

上游已吸收 / 仍独有（rc.2 源码核实，详见 `stats.patches`）：

| 插件能力 | 上游 0.1.1-rc.2 状态 | 插件状态 |
|---|---|---|
| fastInitFor | **rc.8 已原生实现** | 已退役 |
| zeroCopyFork | `snapshotJsonValue(source)` 仍在 | 活跃 |
| 投影分片预热 | `cellFor` 仍同步全量 `buildCell` | 活跃 |
| 分片 materialize | 仍一次性全量序列化 | 活跃 |
| 冷会话 LRU 裁剪 | 容量可配置但默认偏大 | 活跃 |

上游 rc.7 修复了历史分页栈溢出（可用性）、rc.8 优化了 SQLite 后端——均不与本插件
重叠，也未触碰根因（历史加载全量解码、live 事件树全量驻留）。

## 安装

要求：Node **≥ 22.15.0**（`node:zlib` zstd 接口）；dsh `0.1.0-rc.6` ~ `0.1.1-rc.2`
（`package.json` 已声明 `engines`）。

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:orangeofcarl0-sys/dsh-large-proj-perf

# 本地开发
dsh plugin --profile web add file:<本仓库路径>
```

> 修改仓库代码后需把 `lib/`、`cordis.patch.yml`、`package.json`、`dsh-plugin.json`
> 同步到 `<DSH_HOME>/profiles/web/node_modules/dsh-large-proj-perf/`（`file:` 安装
> 不自动跟随），或重新 `dsh plugin add`。重启 `dsh web` 生效，日志出现
> `[dsh-perf] installed (...)` 即成功。

### 大会话内存（推荐启动方式）

多个超大会话的 live 事件树每个 ~700MB，默认 V8 heap 上限 ~4GB 会 OOM。插件已自动
做 LRU 裁剪（省 ~2.8GB），但 heap 上限是启动期参数，推荐用仓库脚本启动（内置
`--max-old-space-size=8192`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1
```

### 避免超长对话（主动规避）

本插件是「被动优化」，无法削减**正在使用的** live 事件树。推荐配合
[dsh-fresh-start](https://github.com/orangeofcarl0-sys/dsh-fresh-start)：`/fresh`
一键「总结 → 开新会话 → 归档老会话」，主动控制会话规模。两者配合：本插件兜底
性能，fresh-start 控制规模。

## 配置

全部配置可经 Settings 卡片、`config.set` API 或 settings 持久化修改；数值项带下限
钳制（非法值被拒绝或收敛到下限，`materializeChunkEvents ≥ 1000`、`chunkSize ≥ 1`、
`preparedCacheSize ≥ 1` 等）。

| 键 | 默认 | 说明 |
|---|---|---|
| `zeroCopyFork` | `true` | 零拷贝 fork |
| `fastInitFor` | `true` | fast initFor（rc.8+ 自动退役） |
| `slowForkWarnMs` | `100` | fork 耗时告警阈值 |
| `warmupEnabled` | `true` | 大会话投影分片预热总开关 |
| `minEvents` | `20000` | 低于此事件数不预热 |
| `chunkSize` | `5000` | 每片折叠事件数（下限 1） |
| `chunkYieldMs` | `0` | 片间让出方式：0=setImmediate，>0=setTimeout |
| `warmOnCreated` | `true` | session/created 即预热 |
| `backfillOnBoot` | `false` | 磁盘冷会话补投影缓存行（readRaw 同步解码，默认关） |
| `backfillMaxSessions` / `MinBytes` / `MaxBytes` | `8` / `1MB` / `32MB` | 补行扫描范围 |
| `chunkedMaterialize` | `true` | 分片落盘 |
| `materializeChunkEvents` | `50000` | 每帧事件数（下限 1000） |
| `preparedCacheTrim` | `true` | 冷会话 LRU 裁剪总开关 |
| `preparedCacheSize` | `1` | 裁剪目标容量（下限 1） |
| `keepRecent` | `50` | 内存保留的最近记录数 |
| `heapWarnBytes` | `6GB` | heap 上限告警阈值 |

## API

`POST http://127.0.0.1:3080/dsh-large-proj-perf/api/<method>`（回环 + 同源校验）：

| 端点 | 说明 |
|---|---|
| `stats.get` | `dshVersion` 版本探针、`patches` 各补丁状态、fork/预热/补行计数与最近记录 |
| `stats.reset` | 清零计数与历史（保留安装状态标志） |
| `config.get` / `config.set` | 运行时开关；`config.set` 同时写 settings 持久化 |

```sh
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/stats.get
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/config.set \
  -d '{"zeroCopyFork": false}'
```

## 与其他性能插件共存

| 插件 | 层面 | 与本插件关系 |
|---|---|---|
| [@linxin666/dsh-perf](https://www.npmjs.com/package/@linxin666/dsh-perf) | 观测（HUD/指标）+ 写批频控 + 前端渲染降载 | **零方法重叠**（它纯配置+订阅，不 patch 方法）；写批延迟与本插件的 materialize 是不同路径 |
| [dsh-pref-kit](https://github.com/gameswu/dsh-pref-kit) | 源头流式增量合并（事件量 −11~56%） | 上下游互补：它减少新事件，本插件治理存量与 fork |

三者可同时安装（分层互补）。唯一注意点：两者行管理实验项的白名单都含
`session-projection-cache`——**不要禁用该行**，否则本插件的投影缓存回填/基线
读取失效（有防御回退，不崩溃但功能打折）。

## dsh-std 兼容（Community v0.15）

标准已发布 rc（`@dsh-std/core`/`manifest`/`composition`/`sdk`/`lifecycle`
0.1.0-rc1），核心是 `dsh-plugin.json` 插件清单。本插件提供标准兼容面，**双轨加载**：

- **当前 dsh（0.1.x）**：走 `cordis.patch.yml` 加载 `lib/index.js`，行为不变。
- **未来标准宿主**：按 `dsh-plugin.json` 加载——`facets.host.entry` 指向
  `lib/std-host.js`（facet 激活模块，形态与 `@dsh-std/sdk` 的 `defineFacet` 等价，
  零运行时依赖）；`overrides` 如实声明五个补丁点；宿主经协议提供 cordis 上下文时
  桥接激活，否则空激活。

## 开发

测试依赖真实 dsh 内部包（全局 dsh 安装的嵌套依赖，Node 解析不到），先链接再跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1
npm test   # 8 套件，112 断言
```

| 套件 | 断言 | 覆盖 |
|---|---|---|
| `verify_compat` | 16 | 真实安装源码的补丁特征断言（升级 dsh 后先跑这个） |
| `test_manifest` | 22 | dsh-std 清单结构 / entry 存在 / overrides / facet 形态 |
| `smoke_fork` | 17 | fork 基线 / 零拷贝等价 / header 平价 / dispose / 漂移回退 |
| `test_fast_initfor` | 10 | 补丁安装 / 漂移跳过 / rc.8 退役形态 |
| `test_cache_trim` | 23 | LRU 裁剪 / dispose 恢复 / 运行时开关 / 配置钳制 / 探针与补丁状态 |
| `smoke_warmup` | 11 | 预热与同步折叠一致 / 基线 / 并发让位 / 中止 |
| `test_chunked_materialize` | 5 | 多帧解码等价 / 阈值 |
| `test_backfill` | 8 | fork 回填 / 磁盘补行 |

## 能力边界与局限

- **缓解，不根治**：根因在 dsh 架构——live 事件树全量驻留（~700MB/超大会话）、
  历史加载全量解码 + 逐事件深拷贝。monkey-patch 触及不到，根治依赖上游支持事件
  分页加载 / 按需驻留。
- `enqueue` 逐事件 `structuredClone`（fork 第三次拷贝）在插件层无法安全消除
  （write-behind 闭包内部，承担所有权语义）。
- 冷会话 `coldSnapshot` 的全量 `readFrom(0)`（同步 zstd 解码）无法在插件层分片。
- 版本高度耦合：dsh 大版本升级后特征校验会自动跳过优化（不崩溃、不误补），但
  优化静默失效——升级后务必跑 `verify_compat`。本插件不适合在 dsh 频繁变动时
  依赖其优化。
- `dsh-plugin.json` 的 `compat.hosts` 版本范围字符串格式，标准尚未严格定义，
  定稿后可能需微调。
