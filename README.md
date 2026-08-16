# dsh-large-proj-perf

[![Version](https://img.shields.io/badge/version-1.1.1-blue)]()
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.6-green)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DSH（DeepSeek Harness）大会话性能插件：零拷贝 fork、投影分片预热、分片 materialize，
一次装齐，消除 fork/历史加载对超大会话的事件循环阻塞。

> ⚠️ **版本兼容性警告**：本插件通过 monkey-patch dsh 内部方法实现（`SessionStore.fork`、
> `PersistenceCoordinator.initFor`、`JsonlSessionPersistence.encodeMaterialization`、
> `SessionPreparations` 等），**与 dsh 版本高度耦合**，当前针对 `0.1.0-rc.6` 开发并验证。
> dsh 升级后这些内部方法签名可能变化——所有补丁都带源码特征校验，不匹配时**自动跳过
> 优化并回退官方行为**（不会导致崩溃），但优化会静默失效。升级 dsh 后请确认启动日志
> 无 `signature mismatch` 告警，必要时重新适配本插件。

> ⚠️ **能力边界（重要）**：本插件只能**缓解**超大对话的性能/内存问题（分片、零拷贝、
> LRU 裁剪、预热等），**无法彻底解决**。根本原因在 dsh 的架构——live 会话事件树全量
> 驻留内存（每个超大会话 ~700MB）、历史加载全量解码 + 逐事件深拷贝。这些是上游架构
> 问题，插件 monkey-patch 触及不到。真正的根治依赖 dsh 上游支持事件分页加载/按需驻留，
> 或主动控制会话规模（见下文「避免超长对话」）。

## 问题

dsh `0.1.0-rc.6` 在大会话（数十万事件）上存在三类同步阻塞，导致 fork 卡顿、
历史加载报 `signal timed out (internal)`、严重时 OOM：

| 问题 | 环节 | 实测 |
|---|---|---|
| A. fork 深拷贝 | `Session` 构造器逐事件 `snapshotJsonValue`（纯 JS 深拷贝）+ persistence `initFor` 的 `structuredClone(seed)` | 18.2MB/20k 事件合计 ~480ms 同步阻塞 |
| B. projection 冷折叠 | `SessionProjectionRegistry.cellFor()` 冷时同步 `buildCell` 全量折叠 | 74 万事件冷折叠阻塞 20+ 分钟（100% 单核） |
| C. fork 全量序列化 | fork 子会话首次落盘 `encodeMaterialization` → `eventLines` = `map(JSON.stringify).join("\n")` 一次性序列化整个 seed | 60 万事件 = 501MB 单字符串；74 万事件直接 `RangeError: Invalid string length` |

**为什么「单个会话没事、fork 后出事」**：普通会话持久化走增量 `appendLines`
（每次序列化几十个事件），而 fork 子会话是全新 id，走 `materialize` 全量序列化
整个 seed——这是唯一会一次性序列化整条日志的路径。

## 方案

1. **零拷贝 fork**（`zeroCopyFork`，A）：fork 的 seed 事件本就是 `deepFreeze`
   不可变纯 JSON 树。补丁改走 `Session.prepare(..., { seedSource: 'persistence' })`
   的 `fromRestore` 通道——原地冻结复用引用，跳过整树深拷贝（346ms → 19ms）。
   子会话 header（`parentSession`/`seedLength`/`cwd`）与官方 fork 逐字段一致。
2. **fast init-for**（`fastInitFor`，A）：`PersistenceCoordinator.initFor` 里那次
   `structuredClone(seed)` 替换为冻结引用复用（135ms → ~0ms）。带 rc.6 源码特征
   校验（`structuredClone(e)` 标记），内部结构不匹配时自动跳过并告警。
3. **投影分片预热**（`warmupEnabled`，B）：会话进入（created/resume）且事件数超过
   阈值时，抢在首次同步冷折叠前，分片重放 cells——每 `chunkSize` 个事件
   `setImmediate` 让出事件循环，折叠完成后直写 `registration.cells`（WeakMap），
   此后 `snapshot()`/`drive()` 全部命中热 cell。可用时从投影缓存行取基线跳过已折叠
   前缀。实测 74 万事件：冷折叠 20 分钟 → 预热 200ms。
4. **fork 缓存回填**（B，随预热自动执行）：fork 子会话（`header.parentSession` 存在）
   预热完成后立即 `cache.write(child)` 建立投影缓存行——否则它被放弃时永远没有
   缓存行，下次打开历史 `coldSnapshot` 走 `readFrom(0)` 全量读。
5. **分片 materialize**（`chunkedMaterialize`，C）：`encodeMaterialization` 每
   `materializeChunkEvents` 个事件一个 zstd frame（多帧是 dsh 解码端
   `scanZstdFrames` 的原生格式，字节兼容），消除单巨字符串与 RangeError。
6. **冷会话补行**（`backfillOnBoot`，B 辅助，默认关）：磁盘缺缓存行的大会话流式
   补写。默认关的原因：`readRaw` 的 zstd 全量解码是同步的、插件层不可分片，
   大文件仍会冻结事件循环数秒~数十秒。
7. **冷会话 LRU 裁剪**（`preparedCacheTrim`/`preparedCacheSize`，D）：persistence
   的冷会话 LRU 默认缓存 5 个完整事件树（每个大会话 ~700MB，5×700MB 叠加是 OOM
   主因之一）。插件运行时把容量降到 `preparedCacheSize`（默认 1）并淘汰最旧的
   ready 条目，主动释放冷会话事件树——省 ~2.8GB。无需手动改 `cordis.patch.yml`；
   `config.set` 运行时改这两个键即时生效；dispose 恢复原 capacity（已淘汰条目
   不复活）。
8. **heap 上限检测**（`heapWarnBytes`，D）：`--max-old-space-size` 是 V8 启动期
   参数、进程内改不了。插件检测 heap 上限低于阈值（默认 6GB）时告警，并引导用
   `scripts/start-dsh.ps1`（内置 `--max-old-space-size=8192`）重启。

### 安全性

- 共享引用等价于深拷贝：事件在进入源会话时已通过完整 JSON 边界与 surface 验证并
  深冻结，任何代码都无法修改。
- 所有补丁带 rc.6 源码特征校验，内部结构不符自动跳过并告警，绝不盲补。
- 三层回退：(a) 调用时能力探测缺失 → 官方实现；(b) 补丁内运行时异常 → try/catch
  回退官方实现；(c) 配置开关 → 永远官方路径。
- dispose 完整还原所有补丁（冷会话 LRU 裁剪恢复 capacity 原值，已淘汰的缓存
  条目不复活）。

## 安装

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:orangeofcarl0-sys/dsh-large-proj-perf
# 或
dsh plugin --profile web add https://github.com/orangeofcarl0-sys/dsh-large-proj-perf

# 本地开发
dsh plugin --profile web add file:<本仓库路径>
```

> 注意：每次修改仓库代码后，需把 `lib/`、`cordis.patch.yml`、`package.json`
> 同步到 `<DSH_HOME>/profiles/web/node_modules/dsh-large-proj-perf/`（`file:` 安装
> 不会自动跟随源文件更新），或重新执行 `dsh plugin add`。

重启 `dsh web` 生效。日志出现 `[dsh-perf] installed (...)` 即成功。

> 环境要求：Node **≥ 22.15.0**（`node:zlib` 的 zstd 接口所需，低版本加载插件
> 会直接失败）。`package.json` 已声明 `engines`。

### 大会话内存（推荐启动方式）

多个超大会话（数十万事件）的 live 事件树每个 ~700MB，默认 V8 heap 上限 ~4GB
会让 dsh 在内存叠加时 OOM。插件已自动做冷会话 LRU 裁剪（省 ~2.8GB），但 heap
上限是 V8 启动期参数、进程内改不了，推荐用仓库自带脚本启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1
```

它等价于 `node --max-old-space-size=8192 .../dsh/lib/bin.js web`（停止旧进程 →
重启 → 打开浏览器）。若不使用该脚本，插件启动时会打 `V8 heap limit ... < ...`
告警提醒你加参数。

### 避免超长对话（主动规避）

本插件做的是「被动优化」——把 fork/历史加载/落盘的大会话阻塞降下来，但无法削减
**正在使用的 live 会话事件树**（每个 ~700MB，dsh 架构决定全量驻留）。要从根上避免
超长对话的内存/卡顿，推荐配套使用：

- **[dsh-fresh-start](https://github.com/orangeofcarl0-sys/dsh-fresh-start)**：
  输入 `/fresh` 一键「总结当前对话 → 开启新对话 → 归档老对话」。在一个会话工作
  一段时间后用它归档，释放 live 事件树内存，而不是让会话无限增长到 70 万+ 事件。

```sh
dsh plugin --profile web add github:orangeofcarl0-sys/dsh-fresh-start
```

两者配合：`dsh-large-proj-perf` 兜底性能，`dsh-fresh-start` 主动控制会话规模。

## API

`POST http://127.0.0.1:3080/dsh-large-proj-perf/api/<method>`：

- `stats.get` — fork 次数/零拷贝占比/回退、预热计数、补行计数、最近记录
- `stats.reset` — 清零
- `config.get` / `config.set` — 运行时开关，`config.set` 同时写 settings 持久化；
  数值项带下限钳制（如 `materializeChunkEvents ≥ 1000`、`chunkSize ≥ 1`），
  非法值（类型不符/NaN/低于下限取下限）被拒绝或收敛，不会进入危险区间

```sh
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/stats.get
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/config.set \
  -d '{"zeroCopyFork": false}'
```

## 验证

测试依赖真实的 dsh 内部包（`@deepseek-ai/dsh-session` 等），它们不在本仓库依赖里，
而是全局 dsh 安装的嵌套依赖，Node 解析不到。先链接再跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1
npm test   # 或单独跑：node tests/smoke_fork.mjs
```

- `tests/smoke_fork.mjs`（17 断言）：官方 fork 基线 / 零拷贝 fork 功能等价 /
  header 平价（含 origin 不继承）/ seed 前缀逐字节等价 /
  dispose 还原 / 版本漂移回退 —— ALL PASS
- `tests/test_fast_initfor.mjs`（8 断言）：initFor 补丁安装 / 源码特征漂移跳过 /
  无 persistence 服务存活 —— ALL PASS
- `tests/smoke_warmup.mjs`（11 断言）：分片预热与同步折叠一致 / checkpoint 基线 /
  并发 drive 让位 / dispose 中止 —— ALL PASS
- `tests/test_backfill.mjs`（8 断言）：fork 回填 / 磁盘冷会话补行 —— ALL PASS
- `tests/test_chunked_materialize.mjs`（5 断言）：分片多帧解码等价 / 阈值不变 —— ALL PASS
- `tests/test_cache_trim.mjs`（17 断言）：LRU 裁剪 / dispose 恢复 capacity / 运行时
  开关 / config.set 数值钳制 —— ALL PASS

## 局限

- **版本高度耦合（重要）**：补丁绑定 rc.6 内部结构（`_forkSeed`、
  `initFor`/`encodeMaterialization` 源码特征、`SessionPreparations.capacity` 等）。
  dsh 大版本升级后，特征校验会自动跳过优化并回退官方行为（不崩溃、不误补），
  但**优化会静默失效**——升级后务必确认启动日志无 `signature mismatch`，并按需
  重新适配。本插件不适合在 dsh 版本频繁变动时依赖其优化。
- `enqueue` 的逐事件 `structuredClone`（fork 第三次拷贝）在插件层无法安全消除——
  它在 write-behind 闭包内部，且承担"persistence 独立于生产者"的所有权语义。根治需
  上游改为按需快照。
- 冷会话 `coldSnapshot` 的全量 `readFrom(0)`（zstd 解码 + 逐事件
  `snapshotStoredEvents` 深拷贝）无法在插件层安全分片——`readRaw` 的同步解码是硬伤。
  根治需上游把 `readFromCore`/`loadStored` 改成分片让出事件循环。
- 超大会话（70 万+ 事件）加载本身有内存 OOM 风险，与插件无关；建议配合
  [dsh-fresh-start](https://github.com/orangeofcarl0-sys/dsh-fresh-start) 主动归档。
