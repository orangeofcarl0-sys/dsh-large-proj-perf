# 内存分析（dsh 0.2.2-rc.1）

本文是 **24 万事件大会话的内存占用**的静态 + 动态分析。时间维度的优化见
[RUNTIME-ANALYSIS.md](RUNTIME-ANALYSIS.md)（冷读 21.2 s → 3.0 s）。

- 被测 dsh：`0.2.2-rc.1`
- 素材：6 个 18 MB（zstd）的 v4 会话 + 其余小会话，共 12 个 / 217.7 MB
- 隔离 home，`--max-old-space-size=2048`，基线 RSS 388 MB

## 结论摘要

| 指标 | 实测 |
|---|---|
| 一份 24 万事件树在 V8 堆里的原始占用 | **87.7 MB**（18 MB zstd → 73.8 MB 解压文本 → 87.7 MB 对象） |
| 在真实 dsh 进程里常驻一份 | **约 75 MB**（RSS 388 → 463 MB） |
| 连开 6 个 18 MB 会话 | **388 → 1209 MB（+821 MB）** |
| 连开 12 个（含重复读） | **1324 MB**，不再线性增长（缓存上限生效） |
| 常驻缓存总量 | **约 936 MB**（1324 − 388） |

**核心问题：dsh 的所有事件缓存都按「会话条数」限容，没有一处按「字节数」。**
默认容量加起来最多可同时驻留 **7 份完整事件树**。6 个 18 MB 的会话就吃掉 821 MB；
真实环境里 52 MB 的会话（`D:\dsh` 里就有）单份就能到 400 MB 以上。

## 静态分析：谁在持有事件数组

dsh 里有 5 处会持有**完整事件数组或整棵事件树**：

| # | 位置 | 容量 | 按字节限容 | 可被插件触及 |
|---|---|---|---|---|
| 1 | `SessionObservationReader.cache` | **5 条**（`preparedSessionCacheSize`） | ✗ | ✓ `sessionQuery._observations.cache` / `.cacheCapacity` |
| 2 | `JsonlSessionPersistence.coldLogMemo` | **2 条**（`COLD_LOG_MEMO_MAX_ENTRIES`） | ✗ | ✓ `persistence.coldLogMemo` |
| 3 | `Session.log` + `eventsSnapshot` | 每 live 会话一份 | — | ✗（`ctx.sessions` 无驱逐接口） |
| 4 | `JsonlSessionPersistence.migrationPreparations` | 按需，任务结束即删 | — | ✓（但通常为空） |
| 5 | `SessionProjectionCache` 的 rows | 1051 条（每会话一条） | ✗（单行可达 9 MB） | ✓ `cache.recordFor/put` |

### 关键细节

**① `ObservationCache`（5 条）**

`dsh-session-query/lib/index.js:334` 的 `cache = new Map()`，容量来自
`config.preparedSessionCacheSize ?? 5`（`:1053`）。淘汰逻辑（`:441-448`）：

```js
evictPastCapacity(keep) {
  if (this.cache.size <= this.cacheCapacity) return
  for (const [id, candidate] of this.cache) {
    if (candidate === keep || candidate.refs > 0) continue
    this.cache.delete(id)
    if (this.cache.size <= this.cacheCapacity) return
  }
}
```

**只看 `size`，不看 `bytes`。** 5 个 18 MB 会话与 5 个 10 KB 会话在它眼里一样。

**② `coldLogMemo`（2 条）**

`dsh-session-persistence-jsonl/lib/index.js:2425`，`memoizeStoredLog`（`:2889-2895`）
按 `COLD_LOG_MEMO_MAX_ENTRIES = 2` 淘汰。它缓存的是 **`freezeStoredEvents(events)`
的完整解析结果**——不是文件字节。

这就是为什么 `open() + read()` 第二次只要 26 ms：第一次已把整棵事件树放进 memo。

**③ `Session.log`（每 live 会话一份）**

`dsh-session/lib/index.js:1327` 的 `log = []` 是 append-only 的完整事件数组；
`:1433` 的 `eventsSnapshot` 再缓存一份 `Object.freeze([...this.log])` ——
**同一棵树的第二个数组**（元素共享，所以只多一个指针数组，约 2 MB/24 万）。
`drive`/`snapshot` 每次调用都可能消费它。

**④ 投影缓存行（已实测 9.14 MB / 会话）**

上一轮实测：24 万事件会话的 `checkpoint` 行是 9.14 MB，其中 `turnOutline`
单占 6.45 MB（71%）。`SessionProjectionCache` **完全没有容量上限**（
`dsh-session-projection-cache` 全文无 LRU / TTL / 上限），磁盘只增不减，
启动时 `loadAll()` 把全部记录读入内存。

真实环境 `D:\dsh\storages\session_projcache`：1051 个文件 / 13 MB。
若都按 9 MB 量级积累，这会成为启动期的固定内存成本。

## 动态分析：实测曲线

在同一进程里依次读会话，记录 RSS（`Win32_Process.WorkingSetSize`）：

| 步骤 | RSS | 增量 |
|---|---:|---:|
| 启动后（未读任何会话） | 388 MB | — |
| 读第 1 个大会话（24 万事件） | 630 MB | +242 MB |
| 同会话再读 3 次 | 463 MB | −167 MB（GC 回收中间产物） |
| 再读 5 个不同大会话 | **1209 MB** | +746 MB |
| 再读 6 个（含重复） | 1324 MB | +115 MB（开始被淘汰） |

读法：

- **第一次读的 +242 MB 里，约 75 MB 是常驻的**（清掉中间产物后停在 463 MB），
  其余是解码/解析过程中的临时分配。
- **每多开一个大会话约 +149 MB**（746 / 5）。这比单份 75 MB 高，因为
  第一次读同一会话时临时分配更多，且 5 条上限内全部常驻。
- 12 个会话后停在 1324 MB —— 说明 `cacheCapacity=5` 在起作用，不会无限增长。
  但**936 MB 的常驻缓存**对 6 个 18 MB 的会话来说仍然过高。

### 为什么「18 MB 的会话 → 149 MB 内存」

| 层 | 大小 | 说明 |
|---|---:|---|
| zstd 文件 | 18.1 MB | 磁盘上的样子 |
| 解压后 JSONL 文本 | 73.8 MB | **4.1×** |
| 解析后 JS 对象 | 87.7 MB | **4.8×**；每个事件是一个对象 + `data` 子对象 + 消息里的 content 数组 |
| `Session.log` + `eventsSnapshot` | +2 MB | 两个指针数组共享元素 |
| 29 个投影 cell | 数 MB | 取决于单元；`turnOutline` 的 turns 数组随 turn 数线性增长 |
| 解码中间产物 | +150 MB 级 | `Buffer.concat` 的 73.8 MB + `split('\n')` 的 24 万个字符串 |

**zstd 压缩比 ≈ 4.1×，对象膨胀再 ≈ 1.2×，合计约 5 倍。** 一个 52 MB 的会话
（`D:\dsh` 里真实存在）在内存里就是 250 MB 以上，而 dsh 允许 7 份并存。

## 可以在插件层做什么

按可行性排序。前提：**不改 dsh 源码，只包装实例字段**。

### A. 让缓存按字节限容（**已实现**，v1.9.0）

`lib/memory-budget.js` + `memoryBudgetBytes`（默认 512 MiB，0 关闭）：

- 包装 `sessionQuery._observations.store`，在每次插入后按「估算字节总量」淘汰；
- 同样处理 `persistence.coldLogMemo`（包装 `decodeStoredLog`）；
- 估算用 `events.length × 400 B`（实测 87.7 MB / 240031 事件 ≈ 365 B，留余量）；
- 只删 `refs === 0` 的条目（与上游同一判据），全部被 pin 时允许暂时超预算并计数；
- 条数上限保持原样，两者取先触发者。

**实测（预算 128 MiB，8–12 个 18 MB 会话反复读 36 次）**：

| 配置 | 稳态 RSS |
|---|---:|
| 无字节预算（仅 5 条上限） | 1209 – 1324 MB |
| **字节预算 128 MiB** | **690 MB** |

`stats.memoryBudgetTrimmed` 记录淘汰条目数、`memoryBudgetFreedBytes` 记录估算释放量
（36 次读累计淘汰 86 个条目 / 7874 MB 估算）。淘汰后 GC 一旦运行，RSS 会掉回
372 MB —— 说明引用确实被解除，只是 V8 不保证立刻归还 OS。

代价：被淘汰的会话下次打开要重新解码 + 折叠。1.8.0 之后这一步是 3 秒（不是 21 秒），
所以「用重折换内存」现在是划算的。

### B. 主动在空闲时驱逐（未做）

`ctx.sessions` 没有驱逐接口，但 `ObservationCache` 有——可以在「会话列表刷新后
N 秒」或「内存超过阈值时」把最旧的非 pinned 条目删掉。
与 A 的区别：A 是「限容」，B 是「按需回收」。B 更复杂且需要触发时机，建议先做 A。

### C. 投影缓存行瘦身（中等价值）

缓存行 9.14 MB 里 `turnOutline` 占 6.45 MB。它存的是 30 000 个 turn 的
prompt/response 预览（各 50/120 字符上限）。可选：
- 只存最近 N 个 turn（但会改变 `turnOutline` 的语义，影响客户端跳转）；
- 或把 turns 数组改成紧凑编码（列存）。两者都会破坏 wire schema，**不建议**。

**更实际的是**：把 `coldWriteBack` 保持默认关（已经是），并**给投影缓存域加
一个总量上限告警**——当 `session_projcache` 目录超过阈值时提示用户清理。

### D. 不建议做的

- **驱逐 live session**：`ctx.sessions` 没有安全接口，强删会破坏 agent 生命周期。
- **压缩 `Session.log`**：事件树是 `shared-frozen` 且被多处共享引用，替换会破坏
  identity 语义。
- **改 `eventsSnapshot`**：它是 dsh 的公开快路径，动它会牵连 `drive` / `snapshot`。

## 尚未测的

- **`turnOutline` cell 自身的内存**：30 000 条 turn（各含两个 ≤120 字符字符串）
  约 6.45 MB —— 已从缓存行大小推得，但没单独量它在 live cell 里的占用。
- **`eventsSnapshot` 的增量**：按指针数组估算约 2 MB，未单独验证。
- **GC 行为**：本轮只用了 `--max-old-space-size=2048` 与 `--expose-gc` 做单点测量，
  没有观察长时间运行下的堆增长率与 minor/major GC 频率。
- **多个 live 会话并存**：本轮所有读都是 cold read（`ObservationCache` 里的
  `prepared Session`），没有测「多个 agent 同时 live」的情形——那会额外各占一份
  `Session.log` + 投影 cell。

## 测量方法的边界

- RSS 含映射文件、未回收页与 V8 堆外内存，比 `heapUsed` 偏大。
  单份的 87.7 MB 是 `heapUsed` 增量（精确），而「+149 MB/会话」是 RSS 增量
  （含临时分配，偏大）。
- 会话是合成的（真实实现类写出的合法 v4 会话），事件内容用伪随机文本，
  压缩比 4.1× 与真实会话（`D:\dsh` 里 2.6 MB / 9.2 MB ≈ 3.5×）接近但略高。
- 单机、单次运行。内存数字重复测量会更稳定（GC 时机比 CPU 时机可控），
  但本轮每档只跑了一次。
