# 实测数据

本插件所有性能主张的来源。分三个维度：**时间**（打开一个大会话要多久）、
**空间**（它在内存里占多少）、**渲染**（浏览器把窗口画出来要多久——完整版在
[RENDER-ANALYSIS.md](RENDER-ANALYSIS.md)，这里只放摘要）。

- 被测 dsh：`0.2.2-rc.1`
- 素材：24 万事件 / 18.1 MB（zstd）的 v4 会话，用真实 `SessionStore` +
  真实 `JsonlSessionPersistence` 生成
- 环境：Windows 10.0.26200、Node 24.14.1、隔离 home、`--max-old-space-size=2048`
- 复跑工具：[`tools/runtime-probe/`](../tools/runtime-probe/README.md)

> **每个数字都标了「能证明什么 / 不能证明什么」。** 前几轮吃过教训：把「同进程
> 已 live 的读」当成「跨进程冷读命中缓存」，据此做出了无效优化。读这份文档时
> 请同样注意边界。

## 结论速览

| 指标 | 优化前 | 优化后 | 依据 |
|---|---:|---:|---|
| 首次冷读（24 万事件） | 21.2 s | **3.0 s** | §1.3 |
| 同进程二次读 | ~14 s | **0.35 s** | §1.3 |
| 稳态 RSS（8–12 个 18 MB 会话） | 1324 MB | **690 MB** | §2.3 |
| 单份事件树堆占用 | — | **87.7 MB**（18 MB zstd 的 4.8 倍） | §2.1 |

优化后剩余 3 秒的构成：解码 1.65 s + 其余 28 个投影单元 0.67 s +
`turnOutline` 线性 fold 0.1 s + HTTP 序列化。

---

# 一、时间维度

## 1.1 分段归因：解码链路只要 1.4 秒

`tests/bench_cold_read.mjs` 对同一份日志分段计时（独立复算，不经过 dsh）：

| 段 | ms | 占比 | 备注 |
|---|---:|---:|---|
| 帧扫描 | 0.6 | 0.0% | **29 帧**（约 625 KB/帧） |
| 逐帧解压 | 412.6 | 30.4% | 膨胀到 73.8 MB |
| utf8 + split | 122.7 | 9.0% | 240 032 行 |
| `JSON.parse` | 559.2 | 41.3% | 240 031 个事件 |
| 全图深冻 | 94.2 | 6.9% | 240 031 个事件 |
| `Session.fromRestore` | 166.2 | 12.3% | 信封校验 + surface 折叠 |
| **合计** | **1355** | | |

用真实 `persistence.open` / `handle.read` 交叉验证：`open()` 1622 ms、
`read()` **26 ms**（帧解压与行解析在 `open` 时就做完了，`read` 只切视图）。

**能证明**：把 18 MB 日志变成内存事件数组，全部工作约 1.4–1.65 秒。
**不能证明**：这是 dsh 的固有下限——换成 worker thread 或帧索引还能再压。

## 1.2 逐投影单元归因：76% 在一个单元上

真实 dsh 进程里对 29 个注册单元逐个计时（24 万事件）：

| 单元 | 折叠耗时 | 占全部折叠 |
|---|---:|---:|
| **`turnOutline`** | **16 061 ms** | **96.0%** |
| `titleInput` | 194 ms | 1.2% |
| `contextPressure` | 42 ms | 0.3% |
| 其余 26 个合计 | 431 ms | 2.6% |
| **合计** | **16 728 ms** | |

完整归因（冷读总耗时 21 190 ms）：

```
open() + read() 解码链路          1650 ms   7.8%
Session 构造（信封 + surface）     166 ms   0.8%
投影折叠                        16728 ms  78.9%
├─ turnOutline                  16061 ms  75.8%  ← 唯一的问题点
└─ 其余 28 个                      667 ms   3.1%
```

## 1.3 `turnOutline` 是 O(n²)，换成 O(N) 后冷读 21.2 s → 3.0 s

它的 `apply` 每次 `turn/start` 执行 `turns: [...state.turns, next]`，每次
`user/message` / `turn/end` 执行 `turns: [...state.turns.slice(0, -1), fixed]`
——**整数组复制**。N 个 turn 累积是 O(N²)。

同一批事件与语义等价的「只替换末项」写法对比（`tests/test_fast_turn_outline.mjs`
的可复算版本）：

| turn 数 | 上游实现 | 线性等价实现 | 倍数 |
|---:|---:|---:|---:|
| 5 000 | 87 ms | 2 ms | 43× |
| 10 000 | 439 ms | 12 ms | 37× |
| 20 000 | 5238 ms | 7 ms | **701×** |

翻倍 turn 数时上游耗时约 12 倍增长，坐实二次复杂度。

**修复实测**（`lib/fast-turn-outline.js`，24 万事件 / 30 000 turn）：

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| 首次冷读 | 21 190 ms | **3 008 ms** |
| 同进程二次读 | ~14 000 ms | **349 ms** |
| `turnOutline` 输出 | 30 000 条 turn | 30 000 条，**逐字段一致** |

替换投影语义必须逐字段等价。实现做了三层保证：`preview` 逐字复刻上游（含
`limit*2` 提前截断、空白压缩、省略号；prompt 50 / response 120）；fold 逐 case
复刻；**安装前跑运行时等价探针**（15 条覆盖全部分支的合成事件流，逐字段比对，
不等就不上线）。

> 用探针而非源码特征校验，是因为投影注册表把 `definition.apply` 包成了
> `(state, event) => definition.apply(state, event)`——拿不到原始源码。

## 1.4 其他实测（用于判断哪些能力值得留）

### 真实 fork RPC 不经过零拷贝补丁

`session/fork`（Web UI 的「分支会话」）：

| 指标 | 值 |
|---|---:|
| fork 全程 | 25 811 ms |
| `stats.forks` | **0** |
| 子会话落盘帧数 | 6 |

`stats.forks = 0` 是决定性的：上游 0.2.2 的 `session/fork` 自己 `buildForkSeed`
后调 `agents.create`，**不调用 `SessionStore.prototype.fork`**——零拷贝补丁挂在
那个方法上，在这条链路上从未被调用。

### 直测补丁点：零拷贝本身有效，但收益远小于预期

用 `debugApi` 暴露的 `debug.fork` 直接调 `ctx.sessions.fork`，同进程 A/B，
各 5 次（24 万事件）：

| 模式 | median | min | max | zeroCopy |
|---|---:|---:|---:|---:|
| 原生（`zeroCopyFork=false`） | 20 125 ms | 18 820 ms | 21 014 ms | 0 |
| 零拷贝（`zeroCopyFork=true`） | **15 802 ms** | 15 684 ms | 16 018 ms | 5 |

收益 **16–21%**，不是「数百 ms → 个位数 ms」。原因：`buildForkSeed` 本身要做
`events.slice(0, boundary+1)`，24 万个元素的数组切片就要复制整个数组；`shared-frozen`
省掉的只是逐事件的 `snapshotJsonValue` + `deepFreeze`。

> 曾尝试把补丁改挂到 `sessions.prepare({seed})` 覆盖真实 fork 路径——实测**负收益**
> （25.8 s → 48.4 s，深冻结 24 万事件的开销超过它省下的拷贝），已回退。

### 分片 materialize：改变帧数，不改变字节与耗时

两次独立进程，`chunkedMaterialize` 通过环境变量在启动时定值：

| chunkedMaterialize | zstd 帧数 | 文件字节 | fork + materialize |
|---|---:|---:|---:|
| `true` | **6** | 19 017 754 | 24 988 ms |
| `false` | **2** | 19 022 443 | 27 331 ms |

帧数 6 = 1 头帧 + 5 数据帧（240 018 / 50 000 = 4.8），关闭时 2 帧。
**字节数差 0.02%，总耗时无稳定改善。**

**能证明**：分片确实生效。**不能证明**：它提升吞吐。它解决的是单次
`Buffer.concat` / 单个 zstd frame 的内存峰值与 `RangeError`，需要数百 MB 级会话
才能体现。

### 观测面限制：日志默认不可见

插件所有正常日志走 `ctx.logger.info`（`lib/runtime.js`）。dsh 0.2.2 的默认日志
级别把 `info` 吞掉了——隔离实例里 `[dsh-perf]` 日志行数为 **0**，尽管插件已正常
装载、API 完全可用。

**后果**：任何依赖日志的排查（包括「grep `signature mismatch`」）在默认配置下都是
空的。插件唯一的可靠观测面是 `stats.get`。这一点已写入 README 排错节。

---

# 二、空间维度

## 2.1 一份事件树在堆里是 87.7 MB

实测（`--expose-gc`，逐段量 `heapUsed` 增量）：

| 层 | 大小 | 相对 zstd |
|---|---:|---:|
| zstd 文件 | 18.1 MB | 1.0× |
| 解压后 JSONL 文本 | 73.8 MB | 4.1× |
| 解析后 JS 对象 | **87.7 MB** | **4.8×** |

深冻（`Object.freeze` 全图）**不额外占内存**（+0 MB，只改标志位）。

真实 dsh 进程里常驻一份约 **75 MB**（RSS 388 → 463 MB，清掉解码中间产物后）。

## 2.2 静态：5 处持有事件数组，3 处按条数限容

| # | 位置 | 容量 | 按字节限容 | 插件是否可介入 |
|---|---|---|---|---|
| 1 | `SessionObservationReader.cache` | **5 条**（`preparedSessionCacheSize`） | ✗ | ✓ |
| 2 | `JsonlSessionPersistence.coldLogMemo` | **2 条**（`COLD_LOG_MEMO_MAX_ENTRIES`） | ✗ | ✓ |
| 3 | `Session.log` + `eventsSnapshot` | 每 live 会话一份 | — | ✗（`ctx.sessions` 无驱逐接口） |
| 4 | `migrationPreparations` | 任务结束即删 | — | ✓（通常为空） |
| 5 | `SessionProjectionCache` rows | 无上限（单行可达 9 MB） | ✗ | ✓ |

上游 `evictPastCapacity` 的判据只有一句：`if (this.cache.size <= this.cacheCapacity) return`
——**只看条数，不看字节**。5 个 18 MB 会话与 5 个 10 KB 会话在它眼里一样。

## 2.3 动态：连开多个大会话的 RSS 曲线

同一进程里依次读会话，记录 `WorkingSetSize`：

| 步骤 | RSS | 增量 |
|---|---:|---:|
| 启动后（未读任何会话） | 388 MB | — |
| 读第 1 个大会话 | 630 MB | +242 MB |
| 同会话再读 3 次 | 463 MB | −167 MB（GC 回收中间产物） |
| 再读 5 个不同大会话 | **1209 MB** | +746 MB |
| 再读 6 个（含重复） | 1324 MB | +115 MB（开始被淘汰） |

12 个会话后停在 1324 MB —— 说明 `cacheCapacity=5` 在起作用，不会无限增长。但
**936 MB 的常驻缓存**对 6 个 18 MB 的会话仍然过高。

## 2.4 修复：字节预算把稳态 RSS 压到 690 MB

`lib/memory-budget.js` 给前两处缓存加字节预算（默认 512 MiB，`0` 关闭），
超出时从最旧的**未被 pin**（`refs === 0`）条目开始淘汰。估算用
`events.length × 400 B`（实测 365 B/事件，留余量）。

实测（预算 128 MiB，8–12 个 18 MB 会话反复读 36 次）：

| 配置 | 稳态 RSS |
|---|---:|
| 无字节预算（仅 5 条上限） | 1209 – 1324 MB |
| **字节预算 128 MiB** | **690 MB** |

36 次读累计淘汰 86 个条目。GC 运行后 RSS 会掉到 372 MB —— 引用确实解除了，
只是 V8 不保证立刻归还给 OS。

**代价**：被淘汰的会话下次打开要重新解码 + 折叠。这在 1.8.0 之后是 3 秒而非 21 秒，
所以「用重折换内存」现在划算了——**时间优化反过来使能了空间优化**。

## 2.5 为什么「18 MB 的会话 → 149 MB 增量」

单份堆占用是 87.7 MB，但首次读同会话的 RSS 增量是 242 MB、连开时约 149 MB/个。
差额来自解码过程的临时分配：`Buffer.concat` 的 73.8 MB + `split('\n')` 的
24 万个字符串 + `JSON.parse` 的中间对象。这些会被 GC 回收（所以同会话二次读的
RSS 反而下降），但峰值确实存在。

---

# 三、渲染维度（摘要）

浏览器侧的完整分析见 [RENDER-ANALYSIS.md](RENDER-ANALYSIS.md)。结论只看这几条：

| 指标 | 值 | 说明 |
|---|---:|---|
| 一次打开的投影载荷（长会话） | **6.76 MB** | 消息载荷的 91 倍；`turnOutline` 装着全部 30 000 turn |
| 一次打开的消息载荷（重会话） | **1.73 MB** | 300 turn / 620 次工具调用；投影只有 68 KB |
| 打开到首行（热读） | 1.5–2.6 s | 请求腿 43–76 ms + 服务端 3–52 ms + 响应腿 658 ms + 派发 7–35 ms + 挂载 100–260 ms |
| 响应腿的构成 | 写队列 73–174 ms + deflate 207–1 493 ms + 网络/inflate 100–190 ms | 用 `ws.send` 回调拆开；冷读后 deflate 从 207 ms 涨到 1 493 ms（线程池争用）；浏览器解析只有 20–30 ms |
| **回合跳转（300 turn）** | +1 375 行 / 阻塞 1 723 ms | `loadThrough` 一次发布 18.3 MB |
| **回合跳转（30k turn 阶梯）** | 20 100 行 / 堆 728 MB | 斜率 ≈1.0–1.15 ms 阻塞/行、≈36 KB 堆/行 |
| **30k turn 跳到 turn 1** | **渲染进程 OOM 后被重载** | 服务端先传 300 页 / 239 800 事件 / 83.4 MB（聚合 85 ms），客户端卡约 140 s 后标签页重载 |
| 每翻一页 | 70 KB（长）/ 1.7 MB（重） | 长会话服务端 0.3 ms；单页无长任务 |
| 快速翻 10 页（批量发布） | 阻塞 2.8 s | 无 containment；开启后 **1.5 s（-47%）** |
| markdown 单条 1.5 KB | 解析 7.5 ms / render 24 ms | 公式 1.3 ms/个、代码高亮 3.5 ms/块 |
| 滚动锚点漂移（containment 开/关） | 22 px / 22 px | 程序化整篇跳，未测到额外跳变 |
| 堆增长 | ≈36–73 KB/行 | 取决于内容；20 100 行到 728 MB |

**关键否证**：长会话的首屏消息窗口不是瓶颈——把它从 50 条压到 25 条只省 0.5%
的字节；瓶颈在投影载荷与「批量发布时的全量挂载」。

---

# 四、测量方法的边界

**通用**

- RPC 墙钟包含 HTTP + socket + JSON 序列化，不等于纯计算成本。
- RSS 用 `Win32_Process.WorkingSetSize`，含映射文件、未回收页与 V8 堆外内存，
  比 `heapUsed` 偏大。单份的 87.7 MB 是 `heapUsed` 增量（精确），
  「+149 MB/会话」是 RSS 增量（含临时分配，偏大）。
- 会话是**合成**的（真实实现类写出的合法 v4 会话，事件类型与信封逐字段对齐）。
  压缩比 4.1× 与真实会话（本机另一份 2.6 MB / 9.2 MB ≈ 3.5×）接近但略高。
- 单机运行。内存数字比 CPU 稳定（GC 时机比调度可控），但每档只跑了一次。

**事件循环停顿**

- pinger 是**外部代理指标**：含 HTTP + socket + 序列化开销（基线 2–7 ms），
  且采样间隔内的阻塞只会抬高「下一次」采样，真实峰值可能更高。
  结论只用「相对基线抬高多少」，不用绝对值。
- 冷读期间的 pinger P99 是 1.5–2.3 秒级（改造前），这是「阻塞」的直接外部证据。

**未做的测量**

- **多个 agent 同时 live**：本文所有读都是 cold read（`ObservationCache` 里的
  prepared Session），没有测「多个会话同时 live」——那会额外各占一份
  `Session.log` + 投影 cell。
- **长时间运行的堆增长率与 GC 频率**：只做了单点测量。
- **`turnOutline` cell 在 live 状态下的内存**：6.45 MB 是从缓存行大小推的，
  没单独量。

---

# 附录 A：已移除能力的实测记录

这些能力在 v1.10.0 被删除。保留结论是为了避免重复投入——**"我们试过了，这条路
在当前 dsh 上走不通"** 和 "我们没试过" 是两种完全不同的信息。

## A.1 分片投影预热（v1.6 引入，v1.10.0 移除）

设计：订阅 `session/created`，在事件数超 `minEvents` 时抢在首次冷折叠之前把投影
单元折出来，每片之间让出事件循环。

实测（24 万事件，`warmupEnabled=true`）：

| 指标 | 值 |
|---|---|
| `stats.warmed` | **0** |
| `stats.alreadyHot` | 1 |
| `warmRecent` | `[{ events: 240022, units: 0, hotUnits: 29, ms: 23375 }]` |

**根因**：`session/created` 是**同步广播**，按监听器注册顺序调用。
`dsh-api-session-controller` 先注册，在监听里同步调 `summaryFor` →
`sessionProjectionCache.flushSoft` → `checkpoint(session)` →
`cellFor()` → `buildCell()`，把 29 个单元一次性全量折完并写入
`registration.cells`。插件监听器注册更晚（bundle 加载顺序：base → web-app →
第三方插件），轮到它时 cell 已全部存在。

**不能靠调整监听器顺序解决**——顺序由 bundle 加载次序决定。

它留下的两条硬性知识仍然有效（已写入 ARCHITECTURE）：

1. cell 形状必须与上游 `buildCell` 一致：`{ state, observedSeq, views: [undefined, undefined] }`；
2. 初始化必须调用 `def.init(header, inheritedEventCount)`——无参调用会让所有从
   header 取值的投影抛 `TypeError`。

## A.2 冷读回写（v1.7 引入，保留但默认关）

设计：包装 `sessionProjectionCache.hydratePrepared`，冷读后把已折好的状态写成
缓存行。依据是发现上游 `coldSnapshot()` 是死代码（全安装包 0 个生产调用点）。

实测（清空缓存，`warmupEnabled=false`）：

| 情形 | 首次读 | 缓存行 |
|---|---:|---|
| 无缓存行 | 18 938 ms | 无 |
| 有缓存行（新进程） | **19 061 ms** | 9.14 MB / 29 units |
| 有缓存行（同进程二次） | 16 913 ms | 同上 |

**回写完全成功**（`coldWriteBacks=1`、identity 逐字段匹配、所有行 `seq` 等于日志
末尾、`recordFor` 探针 HIT），**但对冷读耗时零影响**。

当时的错误假设是「16.6 秒里大头是投影折叠」。逐项排除后（`stateSchema.parse`
合计 52 ms、`restore` 折叠循环 0 次迭代）才发现：那 16 秒在「日志 → 内存事件数组」
（§1.1 的 1.4 秒）**之前**——准确说是 §1.2 揭穿的 `turnOutline`。

**保留原因**：它没有耗时收益，但能让 dsh 自己的列表读（`cachedSnapshot`，零 I/O）
看到更新数据。默认关，因为要写约 10 MB（`turnOutline` 单占 6.45 MB / 71%）。

## A.3 三项因上游结构消失而移除的能力

| 能力 | 移除依据 |
|---|---|
| fast initFor | 依赖的 `persistence.coordinator` 在 0.2.2 已不存在（全包 `grep -c coordinator = 0`），恒 `inactive` |
| 冷会话 LRU 裁剪 | 同上（依赖 `coordinator.preparations`） |

## A.4 两个被评估后放弃的方向

| 方向 | 放弃理由 |
|---|---|
| **worker thread 移出解析** | 分段归因证明它只能拿走解码链路的 6.4%（§1.1 的 1.4 s 中的一部分，还要付跨线程复制成本），而 76% 在投影折叠上、worker 拿不走。准入条件「decode > 10 s」实测 1.36 s 就不成立 |
| **帧索引（只解压目标 seq 区间）** | 帧扫描只占 0.6 ms；`open()` 一次就把 29 帧全解压完；且当前没有任何消费者按非零 offset 读（`handle.read(0, undefined)` 是唯一形态） |

---

# 附录 B：原始报告

`docs/runtime-report/` 是某一轮完整运行的原始输出（`report.json` / `report.md`），
已脱敏（`home` 换为 `<isolated-home>`，launch token 换为 `<redacted>`）。
数字会随机器负载波动（同日两次完整运行中，同一场景的绝对值可差 1.5 倍）——
**比例与状态量才是结论**。
