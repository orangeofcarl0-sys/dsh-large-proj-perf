# 架构与实现

本文面向维护者，说明每项优化针对的具体阻塞点、实现方式，以及安全性与回退设计。

## 三类同步阻塞

dsh 0.1.x 在大会话上有三类同步阻塞，均为主线程事件循环占用：

| 问题 | 环节 | 实测 |
|---|---|---|
| A. fork 深拷贝 | `Session` 构造器逐事件 `snapshotJsonValue`，旧 persistence `initFor` 的 `structuredClone(seed)` | 18.2MB / 20k 事件合计 ~480ms |
| B. projection 冷折叠 | `cellFor()` 冷时同步 `buildCell` 全量折叠 | 74 万事件阻塞 20+ 分钟（100% 单核） |
| C. fork 全量序列化 | `encodeMaterialization` 一次性序列化整个 seed | 60 万事件 501MB 单串；74 万 RangeError |

## 各补丁的实现

所有补丁独立开关、失败自动回退官方实现。

### 1. 零拷贝 fork（问题 A）

fork 的 seed 是 live 会话的 `snapshotEvents()`，这些事件在 append 时已被
`deepFreeze`。补丁改走 fromRestore 通道，原地冻结复用引用而非深拷贝。

fork 协议经历三代，补丁按能力探测自动选择：

| 协议 | 版本 | 实现 |
|---|---|---|
| fork-seed | 0.1.7+ | 复用原生 `_resolveForkSource` + `_forkBoundary` + 模块级 `buildForkSeed`（slice + 注入 `session/end-seed {inherited:true}` marker + `openTurnClosers` 补 turn 闭合），只把 `create` 的写入通道换成 `eventState:'shared-frozen'`。`buildForkSeed` 新建的事件未冻结，送入前原地深冻结 |
| event-state | 0.1.3–0.1.5 | 复用 `_forkSeed`，补丁补 `version/id/createdAt` 到 meta，并在 seed 尾部注入 inherited marker（磁盘校验要求 `cut == marker.seq`；原生快照通道自动追加，restore 通道不追加） |
| seed-source | alpha.5 / rc.1 | `prepare({seedSource:'persistence'})` 旧通道 |

探测依据是方法存在性与源码字面量，任一不满足即整体跳过，绝不安装会破坏 fork 的补丁。

已知取舍：open-turn 边界 fork 时，fromRestore 模式会补一条非 inherited 的 live
end-seed 标记（原生快照通道不补）。该标记不参与 seed cut、不影响 v4 校验，代价是
子会话事件流比原生多一条标记。

### 2. 分片投影预热（问题 B）

会话进入且事件数超过 `minEvents` 时，抢在首次同步冷折叠前分片重放 cells：每片
`chunkSize` 个事件，片间用 `setImmediate`/`setTimeout` 让出事件循环，折叠完成后直写
`registration.cells`（WeakMap）。此后 `snapshot()` / `drive()` 全部命中热 cell。

有投影缓存行时取基线跳过已折叠前缀；fork 子会话预热后回填缓存行，否则被放弃时
永远没有缓存行，下次打开会走 `readFrom(0)` 全量读。

写入的 cell 必须与上游 `buildCell()` 同形——`{ state, observedSeq, views: [undefined, undefined] }`，
且初始化必须按上游签名 `init(header, inheritedEventCount)` 调用。缺 `views` 会在下一条
事件经 `drive()` 时抛 `TypeError`；无参 `init()` 会让所有从 header 取值的投影
（`agentPreset`、`workingDirectory`、`agentTeam`）抛错。两者均有回归断言守护。

### 3. 分片 materialize（问题 C）

每 `materializeChunkEvents` 个事件一个 zstd frame。多帧是解码端 `scanZstdFrames`
的原生格式，字节兼容。

头帧不复刻上游编码器，而是直接调用原方法 `original(meta, inheritedEventCount, [])`
——`events.length === 0` 时只产 header 帧，编码逻辑始终归上游所有。

### 4. 冷会话 LRU 裁剪

运行时把 `SessionPreparations.capacity` 降到 `preparedCacheSize`（默认 1）并淘汰最旧
ready 条目；`config.set` 即时生效，dispose 恢复原容量。

新版 dsh 已用 `COLD_LOG_MEMO_MAX_ENTRIES = 2` + handle 模型懒 materialize 系统代偿，
该补丁自动跳空为 `inactive`（老版本仍活跃）。

### 5. fast initFor

`structuredClone(seed)` 换成冻结引用复用。rc.8 起上游原生实现，补丁自动退役；
0.1.3 连 `PersistenceCoordinator` 本体也已移除。

### 6. heap 检测

heap 上限低于 `heapWarnBytes`（默认 6GB）时告警并提示 `--max-old-space-size`。

## 加载侧：上游已优化的部分与插件的作用点

长对话「打开」的成本分四段，其中前两段上游已自行优化：

| 阶段 | 上游现状 | 插件是否介入 |
|---|---|---|
| 磁盘解码 | 逐帧 zstd 解码 + 增量 `SessionLogScanner`（不拼整串），每 500ms `scheduler.yield()` | 否 |
| 老格式迁移 | 格式 < v4 的会话经 v0→v1→v2→v3→v4 链，**在 Worker Thread 内完成**并发布新世代文件 | 否 |
| 投影折叠 | `cellFor` 冷时**同步全量** `buildCell`（仍在主线程） | **是**：分片预热 + 缓存行基线 |
| 落盘编码 | `encodeMaterialization` 单 body 帧 | **是**：分片 zstd 多帧 |

### 投影缓存行的 identity 契约

插件写/读缓存行时必须使用与上游 `identityOf` 一致的键：`createdAt`、`cwd`、
`isSeeded`、`inheritedEventCount`，以及 **0.1.3 起新增的 `formatVersion`**
（= `header.version`）。

缺 `formatVersion` 时上游只把它当作 title 前驱提示，**不能作折叠短路**——补行与
基线复用会静默失效。该问题已于 1.2.0 修复，并有回归断言守护。

## 安全性与回退

共享冻结引用与深拷贝语义等价：事件进入源会话时已完整校验并深冻结，fork 的 seed
只是复用这些不可变对象。

三层回退保证任何不匹配都不破坏上游行为：

1. **能力探测**——依赖的方法/导出不存在时直接跳过；
2. **源码特征校验**——`String(原型方法)` 不含特征字面量时打 `signature mismatch` 并跳过；
3. **try-catch 兜底**——零拷贝 fork 失败时自动回退官方实现，并计入 `fallbacks` 计数。

所有补丁在 dispose 时按原形状还原：原型方法用 `delete` 回落，自有属性原样写回，
不留 bind 副本遮蔽。

## 代码结构

```
lib/index.js            编排层（apply：配置/统计/日志/版本探针/补丁安装/定时器）
lib/runtime.js          日志、safeGet、sessionEventsOf、sessionLogOffset、版本探针
lib/config.js           默认值/下限钳制/settings schema 注册
lib/stats.js            统计与补丁生命周期状态
lib/api.js              stats/config HTTP 端点
lib/warmup.js           分片投影预热 + fork 缓存回填
lib/backfill.js         磁盘冷会话补行（0.1.3 前 readRaw / 之后直读双通道）
lib/patches/*.js        零拷贝 fork / fast initFor / 冷会话 LRU / 分片 materialize
tests/run.mjs           测试运行器：每套件独立子进程（隔离内存，避免累积崩溃）
tools/                  开发者专用脚本（不随 npm 包发布）
```
