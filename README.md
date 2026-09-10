# dsh-large-proj-perf

[![Version](https://img.shields.io/badge/version-1.2.0-blue)]()
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.6..0.1.5--rc.1-green)]()
[![dsh-std](https://img.shields.io/badge/dsh--std-Community_v0.15-blue)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DSH（DeepSeek Harness）大会话性能插件：零拷贝 fork、分片投影预热、fork 缓存回填、
分片 materialize、冷会话内存治理——一次装齐，消除 fork / 历史加载 / 落盘对超大会话
（数十万事件）的事件循环阻塞与 OOM。

所有优化带**源码特征校验 + 协议探测 + 三层回退**（能力探测 / try-catch / 配置开关），
不匹配自动跳过、绝不盲补；上游吸收了某项能力后对应补丁**自动从 `active` 转
`retired`**——插件按项逐项退役，最终全部 `retired` 之日即整体退役之时。

## 特性一览

| 能力 | 解决什么 | 0.1.3-alpha.2 实测 | 状态 |
|---|---|---|---|
| 零拷贝 fork | fork 时逐事件 `snapshotJsonValue` 深拷贝阻塞 | 50ms → 5.6ms（真实环境） | 活跃（0.1.3 走 `create(eventState:'shared-frozen')` 通道） |
| 分片投影预热 | 打开历史会话的同步冷折叠冻结事件循环 | 74 万事件 20min → ~200ms | 活跃 |
| fork 缓存回填 | fork 子会话无投影缓存行，重开走全量读 | 分钟级 → 秒级 | 活跃（0.1.3 直读 `session.vN.jsonl.zstd` 多帧） |
| 分片 materialize | fork 落盘单巨字符串：60 万事件 501MB、74 万直接 RangeError | 多帧 zstd，字节兼容 | 活跃（0.1.3 三参签名已适配） |
| 冷会话 LRU 裁剪 | 冷会话事件树 ~700MB/个 ×5 叠加 OOM | 省 ~2.8GB | 0.1.3 上游系统修复（`coldLogMemo=2`），补丁自动跳空 |
| fast initFor | persistence 的 `structuredClone(seed)` 深拷贝 | 135ms → ~0ms | 已退役（rc.8 起上游原生；0.1.3 coordinator 移除） |
| heap 检测 | V8 heap 上限过低告警 | 运维辅助 | 活跃 |
| dsh-std 兼容 | Community v0.15 清单 + facet 宿主入口 | 面向未来宿主 | 就绪 |

运行时各补丁的实际状态经 `stats.get` 的 `patches` 字段暴露：
`active`（已安装生效）/ `retired`（上游已原生实现）/ `inactive`（环境缺失或特征
漂移）/ `off`（配置关闭）。

## 工作原理

dsh 0.1.x 在大会话上有三类同步阻塞（源码级定位 + 实测）：

| 问题 | 环节 | 实测 |
|---|---|---|
| A. fork 深拷贝 | `Session` 构造器逐事件 `snapshotJsonValue` + 旧 persistence `initFor` 的 `structuredClone(seed)` | 18.2MB / 20k 事件合计 ~480ms |
| B. projection 冷折叠 | `cellFor()` 冷时同步 `buildCell` 全量折叠 | 74 万事件阻塞 20+ 分钟（100% 单核） |
| C. fork 全量序列化 | `encodeMaterialization` 一次性序列化整个 seed | 60 万事件 501MB 单串；74 万 RangeError |

对应方案（全部独立开关、失败自动回退官方实现）：

1. **零拷贝 fork**：fork 的 seed 是 live 会话的 `snapshotEvents()`（事件在 append 时
   已 deepFreeze）。改走 fromRestore 通道原地冻结复用引用：
   - 0.1.3：`create({eventState:'shared-frozen'})` —— 复用原生
     `_resolveForkSource`/`_forkSeed` 全部边界与 OPEN_TURN 校验；fromRestore 把
     meta 直接当 header 校验，补丁补上 `version/id/createdAt`，并在 seed 尾部
     注入 `session/end-seed {inherited:true}` marker（v2 磁盘校验要求
     `cut == marker.seq`，原生快照通道自动追加、restore 通道不追加）；
   - alpha.5 / rc.1：`prepare({seedSource:'persistence'})` 旧通道（协议自动探测）。
2. **分片投影预热**：会话进入且事件数超阈值时，抢在首次冷折叠前分片重放 cells
   （每片间 `setImmediate`/`setTimeout` 让出），直写 `registration.cells`；有投影
   缓存行时取基线跳过已折叠前缀；fork 子会话预热后回填缓存行。
3. **分片 materialize**：每 `materializeChunkEvents` 事件一个 zstd frame（多帧是
   解码端 `scanZstdFrames` 的原生格式，字节兼容），消除单巨字符串。0.1.3 头帧
   直接复用上游 `encodeCurrentHeader` 编码器（`original(meta, inheritedEventCount,
   [])` 只产 header 帧），不重写格式层。
4. **冷会话 LRU 裁剪**：运行时把 `SessionPreparations.capacity` 降到
   `preparedCacheSize`（默认 1）并淘汰最旧 ready 条目；`config.set` 即时生效，
   dispose 恢复原容量。0.1.3 起上游以 `COLD_LOG_MEMO_MAX_ENTRIES = 2` + handle
   模型懒 materialize 系统代偿，该补丁在上游 0.1.3 自动跳空（老版本仍活跃）。
5. **fast initFor**：`structuredClone(seed)` → 冻结引用复用；rc.8 起上游原生实现，
   补丁自动退役（0.1.3 连 `PersistenceCoordinator` 本体也已移除）。
6. **heap 检测**：heap 上限低于阈值（默认 6GB）时告警并提示
   `--max-old-space-size`。

安全性：共享冻结引用与深拷贝语义等价（事件进入源会话时已完整校验并深冻结）；
三层回退保证任何不匹配都不破坏上游行为。

## 支持版本

| 版本线 | 形态 |
|---|---|
| 0.1.0-rc.6 / rc.7 / rc.8 | fork `prepare(seedSource)` 通道；initFor `structuredClone` 形态 |
| 0.1.1-rc.1 / rc.2 | 同 alpha.5 形态；rc.2 为 `(meta, events)` 裸 meta 签名 |
| 0.1.2-alpha.5 / 0.1.2-rc.1 | `snapshotEvents()`；fork meta `isSeeded`+`inheritedEventCount`；`(storage, events)` 签名 |
| 0.1.3-alpha.2 | persistence 子系统重写（见下） |
| 0.1.5-alpha.1 | 会话格式 **v3**（`SESSION_FORMAT_VERSION=3`）；cut/header 语义与 v2 一致，文件名 `session.v3.jsonl`；补丁点零行级变更 |
| 0.1.5-rc.1 | 仅新增已知事件类型（`deliverables/presented`、`subagent/catalog`）；补丁点零变化 |

### 0.1.3-alpha.2 关键变化（已全部适配）

- `dsh-session-persistence` 变为 contract 层（`SessionPersistence` 基类 + 错误 +
  校验），`PersistenceCoordinator`/`initFor`/`SessionPreparations` 移除；JSONL
  实现移入 `dsh-session-persistence-jsonl`。
- 格式 v0→v1→v2 迁移链（`dsh-session-format` 系列）；物理 header 移除
  `seedLength`，seed cut 由事件流尾 `session/end-seed {inherited:true}` marker
  表达（`cut == marker.seq`）；文件名变 `session.vN.jsonl[.zstd]`。
- `encodeMaterialization(meta, events)` → `(meta, inheritedEventCount, events)`；
  事件词汇收紧（`assistant/message` 需 `data.stream`、消息 `id/source/role` 校验）。

升级 dsh 后：启动日志显示 `dsh version: x.y.z (verified)`（版本探针）或列表外
版本告警；跑 `node tests/verify_compat.mjs`（对真实安装源码做结构断言，当前
25 项）；确认无 `signature mismatch` 告警。

## 安装

要求：Node **≥ 22.15.0**（`node:zlib` zstd 接口）；dsh `0.1.0-rc.6` ~ `0.1.5-rc.1`
（`package.json` 已声明 `engines`）。

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:orangeofcarl0-sys/dsh-large-proj-perf

# 本地开发
dsh plugin --profile web add file:<本仓库路径>
```

> 修改仓库代码后需把 `lib/`、`dsh-plugin.json`、`cordis.patch.yml`、`package.json`
> 同步到 `<DSH_HOME>/profiles/web/node_modules/dsh-large-proj-perf/`（`file:` 安装
> 不自动跟随），或重新 `dsh plugin add`。重启 `dsh web` 生效，日志出现
> `[dsh-perf] installed (...)` 即成功。

### 大会话内存（推荐启动方式）

多个超大会话的 live 事件树每个 ~700MB，默认 V8 heap 上限 ~4GB 会 OOM。插件已自动
做冷会话治理，但 heap 上限是**启动期参数**，进程内改不了——推荐用仓库脚本启动（内置
`--max-old-space-size=8192`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1
```

### 避免超长对话（主动规避）

本插件是「被动优化」，无法削减**正在使用的** live 事件树（每会话几百 MB 是它的
物理成本）。推荐配合 [dsh-fresh-start](https://github.com/orangeofcarl0-sys/dsh-fresh-start)：
`/fresh` 一键「总结 → 开新会话 → 归档老会话」，主动控制会话规模。本插件兜底
性能，fresh-start 控制规模。

## 配置

全部配置可经 Settings 卡片、`config.set` API 或 settings 持久化修改；数值项带下限
钳制（非法值被拒绝或收敛到下限：`materializeChunkEvents ≥ 1000`、`chunkSize ≥ 1`、
`preparedCacheSize ≥ 1` 等），NaN/Infinity 直接拒绝。

| 键 | 默认 | 说明 |
|---|---|---|
| `zeroCopyFork` | `true` | 零拷贝 fork（0.1.3 协议自动探测） |
| `fastInitFor` | `true` | fast initFor（rc.8+ 自动退役；0.1.3 无此形态） |
| `slowForkWarnMs` | `100` | fork 耗时告警阈值（ms） |
| `warmupEnabled` | `true` | 大会话投影分片预热总开关 |
| `minEvents` | `20000` | 低于此事件数不预热（同步冷折叠足够快） |
| `chunkSize` | `5000` | 每片折叠事件数（下限 1；片间让出事件循环） |
| `chunkYieldMs` | `0` | 让出方式：0=setImmediate；>0=setTimeout(ms) |
| `warmOnCreated` | `true` | session/created（含 resume 的大会话）即预热 |
| `backfillOnBoot` | `false` | 磁盘冷会话补投影缓存行（大文件解码同步，默认关） |
| `backfillMaxSessions` | `8` | 补行扫描会话数上限 |
| `backfillMinBytes` / `backfillMaxBytes` | `1MB` / `32MB` | 补行文件大小范围 |
| `chunkedMaterialize` | `true` | 分片落盘（0.1.3 头帧复用上游编码器） |
| `materializeChunkEvents` | `50000` | 每帧事件数（下限 1000） |
| `preparedCacheTrim` | `true` | 冷会话 LRU 裁剪总开关（false 恢复官方容量） |
| `preparedCacheSize` | `1` | 裁剪目标容量（官方默认 5 → 1，省 ~2.8GB） |
| `keepRecent` | `50` | 内存保留的最近记录数（fork/预热统计） |
| `heapWarnBytes` | `6GB` | heap 上限告警阈值 |

## API

`POST http://127.0.0.1:3080/dsh-large-proj-perf/api/<method>`（回环 + 同源校验）：

| 端点 | 说明 |
|---|---|
| `stats.get` | `dshVersion` 版本探针、`patches` 各补丁状态（active/retired/inactive/off）、fork/预热/补行计数与最近记录 |
| `stats.reset` | 清零计数与历史（保留版本探针与补丁状态） |
| `config.get` / `config.set` | 运行时开关；`config.set` 同时写 settings 持久化（`backfillOnBoot` 等生效即补跑） |

```sh
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/stats.get
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/config.set \
  -H 'Content-Type: application/json' -d '{"key":"backfillOnBoot","value":true}'
```

## dsh-std / 未来宿主

- `cordis.patch.yml`：当前 dsh（cordis 插件协议）的加载方式，`patch` 段声明
  `dsh-large-proj-perf` bundle；
- `dsh-plugin.json`：dsh-std **Community v0.15** 清单（`$schema` URN、
  `facets.host.entry: lib/std-host.js`、`compat.hosts` 版本范围、`overrides`
  5 个补丁点声明）——为未来 dsh-std 宿主预留的双轨入口。

## 开发与测试

```sh
# 一次到位：junction 链接全局 dsh 的嵌套依赖（仓库无 node_modules）
powershell -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1

# 全套 8 套件 134 断言（含 verify_compat 对真实安装源码的特征断言）
npm test
```

仓库布局：

```
lib/index.js            编排层（apply：配置/统计/日志/版本探针/补丁安装/定时器）
lib/runtime.js          日志、safeGet、sessionEventsOf、sessionLogOffset、版本探针
lib/config.js           默认值/下限钳制/settings schema 注册
lib/stats.js            统计与补丁生命周期状态（active/retired/inactive/off）
lib/api.js              stats/config HTTP 端点
lib/warmup.js           分片投影预热 + fork 缓存回填
lib/backfill.js         磁盘冷会话补行（readRaw / 0.1.3 直读双通道）
lib/patches/*.js        零拷贝 fork / fast initFor / 冷会话 LRU / 分片 materialize
lib/std-host.js         dsh-std 宿主入口（facets.host.entry）
```

补丁安装原则：**特征校验先行**（`String(原型方法)` 含特征字面量，不匹配打
`signature mismatch` 后跳过）；**协议探测**（如 fork 的 `eventState` vs
`seedSource` 双分支）；**try-catch 兜底**（零拷贝失败自动回退官方实现并计入
`fallbacks`）。所有补丁 dispose 时按原形状还原（原型方法 delete 回落 / 自有属性
原样写回）。

## 已知限制

- `backfillOnBoot` 的解码在插件层同步执行（虽按 chunkSize 分片让出），超大文件
  仍可能短暂冻结事件循环，故默认关闭，需要时手动开启。
- 0.1.3 上 `preparedCacheTrim` 自动跳空为 `inactive`（上游已系统代偿）；若你仍
  运行老版本 dsh，该补丁才真正生效。
- 插件不与 `dsh-perf`（配置订阅类）或 `dsh-pref-kit` 冲突，但行管理类插件禁用
  `session-projection-cache` 会削弱本插件的缓存/预热功能。

## License

MIT
