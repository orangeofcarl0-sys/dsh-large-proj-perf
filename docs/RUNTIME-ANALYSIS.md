# 运行时分析（dsh 0.2.2-rc.1）

本文是**在真实 dsh 进程里测得**的结果，不是静态推演。静态验证（源码特征断言 +
真实类 e2e）证明「补丁装得上」，本文回答「装上之后在真实链路上是否被调用、
值多少」。两者结论不一致的地方，以本文为准。

- 被测 dsh：`0.2.2-rc.1`（全局安装 `C:\Users\66494\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）
- 被测插件：`1.5.0` + 本轮新增的 `debugApi` / 环境变量覆盖
- 运行方式：隔离 home（不碰 `~/.dsh`），profile 只挂 `dsh-base` + `dsh-web-app` + 本插件
- 素材：24 万事件、18.1 MB（zstd 后）的 v4 会话，用真实 `SessionStore` + 真实
  `JsonlSessionPersistence` 生成
- Node `v24.14.1`，Windows 10.0.26200

复跑方式见 [`tools/runtime-probe/README.md`](../tools/runtime-probe/README.md)。

**测量用的两个开关**（1.6.0 新增）：

- `debugApi=true`：暴露 `debug.fork`，直接调 `SessionStore.prototype.fork`。
  没有它就无法测零拷贝补丁——常规 fork RPC 不经过该方法。
- `DSH_PERF_<SNAKE_CASE_KEY>` 环境变量：启动期覆盖任意配置键。
  `chunkedMaterialize` / `fastInitFor` 只在安装时读一次配置，运行期
  `config.set` 改不动，只有这个途径能做独立进程对照。

## 结论摘要

| 能力 | 静态结论 | 运行时结论 | 证据 |
|---|---|---|---|
| 零拷贝 fork | `active` | **在 UI 的 fork 链路上从未被调用**；直测同进程 A/B 约 **-16% ~ -21%** | 场景 D：`pluginForks=0`；场景 E |
| 投影分片预热 | `active` | **完全失效**，29 个投影单元全部 `hot`（上游已建满） | 场景 C：`warmed=0`、`alreadyHot=1` |
| 分片 materialize | `active` | 生效，但只改变帧数，不改变总字节与总耗时 | 场景 F：6 帧 vs 2 帧，字节差 0.02% |
| fork 缓存回填 | `active` | 不可达（依赖预热成功，预热不触发） | 场景 C |
| 冷会话 LRU 裁剪 | `inactive` | 依赖的 `coordinator.preparations` 在 0.2.2 已不存在 | 场景 A |
| fast initFor | `inactive` | 依赖的 `persistence.coordinator` 在 0.2.2 已不存在 | 场景 A |
| heap 上限告警 | 运行时检查 | 生效，但日志不可见（见下） | 场景 A |

**最重要的一条**：**`stats.patches` 说 `active` 不等于「在真实链路上被调用」**。
零拷贝与预热都是 `active`，但一个从未被 UI 调用、一个每轮都静默跳过。

**第二重要的一条（v1.8 修正 v1.7）**：**16.6 秒里 76% 是单个投影单元的 O(n²) 折叠。**
`turnOutline` 的 `apply` 每次 turn 都整数组复制，30 000 个 turn 时占冷读 21 秒里的
16 秒。其余 28 个单元合计只占 3%，解码链路只占 1.65 秒。
用 O(N) 等价 fold 替换后，冷读 **21.2 s → 3.0 s**。

> v1.7 曾说「折叠循环 0 次迭代」——那只在缓存行命中时成立。真实冷读（空缓存）
> 里折叠是绝对大头。这是本轮最重要的自我纠正。

**第三重要的一条**：上一轮测到的「有缓存行时 0.26 秒」是**同进程内会话已 live**
的情形（走 `sessions.get` 快路径），不是跨进程冷读命中缓存行。两者不可混为一谈。

## 一个必须先说明的观测面限制

插件所有正常日志都走 `ctx.logger.info`（`lib/runtime.js:21-32`）。dsh 0.2.2 的默认
日志级别把 `info` 吞掉了 —— 隔离实例里 **`[dsh-perf]` 日志行数为 0**（场景 A
实测），尽管插件已正常装载、API 完全可用。

后果：任何依赖日志的排查手段（包括 README「验证与排错」里让人 grep
`signature mismatch` 的建议）在这套默认配置下**都是空的**。插件唯一的可靠观测面
是 `stats.get`。这一点已写入 README 排错节。

## 场景 A：装机核验

```
dshVersion = 0.2.2-rc.1
patches = { zeroCopyFork: active, warmup: active,
            fastInitFor: inactive, preparedCacheTrim: inactive,
            chunkedMaterialize: active }
configKeys = 19
debugApi 默认 = false
[dsh-perf] 日志行 = 0
```

`fastInitFor` 与 `preparedCacheTrim` 为 `inactive` 是可预期的：两者都要求
`persistence.coordinator`（`lib/patches/fast-init-for.js:14`、
`prepared-cache-trim.js:13`），而 0.2.2 的 `dsh-session-persistence-jsonl` 全文
**没有任何 `coordinator` 字样**（`grep -c coordinator = 0`）。它们不是「上游已原生
实现」（那会是 `retired`），而是**依赖的服务结构已消失**。

这也说明 README 能力表里把这两项列为「补丁」会让读者以为它们在工作。它们目前
只是历史兼容层。

## 场景 B：冷读基线（预热与投影缓存都未命中）

清空 `storages/session_projcache` 后，重启实例、`warmupEnabled=false`、
`minEvents=2e6`（确保不预热），第一次读该会话。下表的**冷读**两列是清空缓存后
的两次独立测量；「有缓存」列是同机上先跑过一轮、缓存行已存在的情形，仅作对照。

| 指标 | 冷读 #1 | 冷读 #2 | 有缓存行时 |
|---|---|---|---|
| `session/events`（maxMessages=5） | 1905.6 ms | 1837.1 ms | 2712.8 ms |
| `session/projections` | **16793.8 ms** | **16641.0 ms** | **259.7 ms** |
| pinger P50 / P95 / P99 / max | 7.2 / 1542.6 / 1542.6 / 1542.6 ms | 6.3 / 1580.2 / 1580.2 / 1580.2 ms | — / — / 2293.5 / 2293.5 ms |
| pinger 停顿次数（gap > 3× 中位数） | 3 | 2 | — |
| RSS 峰值 / 增量 | 806.7 / 424.6 MB | 780.7 / 393.5 MB | 626.9 / 136.4 MB |

读法：

- **冷读投影 16.6–16.8 秒**（24 万事件、29 个投影单元、20 个 wire key）。两次测量
  相差 < 1%，量级稳定可复现。这是插件想优化的那个数字。
- **「有缓存行时 260 ms」那一列不是跨进程冷读**：它是同一进程里会话已成为 live
  session 之后的读（`sessions.get` 命中，`snapshot()` 走既有 cell）。**不要把它
  当成"缓存行命中"的收益** —— 场景 G 专门测了跨进程命中缓存行，结果是零加速。
- pinger 的 P99 是 **1.5–2.3 秒级**：期间事件循环被同步工作占住，连 `stats.get`
  这种纯内存读取都要排队。这是「阻塞」的直接外部证据。
- RSS 增长 400+ MB（冷读）/ 136 MB（live 会话）：24 万事件的整棵事件树 + 投影
  状态。与 README「每会话数百 MB」的说法一致。
- `session/events` 也要 1.8-2.7 秒 —— 它同样读全量日志（`observeSession` 先
  `loadSource` 再切页）。所以「打开历史会话」在 0.2.2 上不是「只读一页」。

## 场景 C：预热（warmup 打开，resume 触发）

> **本节是历史记录。该能力已在 v1.10.0 移除** —— 实测结论就是「在这条路径上永远
> 跑不成」，保留说明是为了让后来者不重复投入。它留下的两条硬性知识（cell 形状、
> `init(header, cut)` 签名）已写入 [ARCHITECTURE.md](ARCHITECTURE.md) 第 2 节。

`warmupEnabled=true`、`minEvents=20000`，用 `session/rename` 触发服务端 resume
（`resolveAgent` → `handle.read(0)` → `sessions.prepare` → `enter` → `announce`，
`announce` 内同步 emit `session/created`）：

| 指标 | 值 |
|---|---|
| rename 全程（含 resume） | **18475 – 51095 ms**（见下方说明） |
| `stats.warmed` | **0** |
| `stats.skipped` | 0 |
| `stats.aborted` | 0 |
| `stats.alreadyHot` | **1**（该会话被判定为「上游已建满 cell」） |
| `warmRecent` | `[{ events: 240022, units: 0, hotUnits: 29, ms: 23375 }]` |
| 预热后 `session/projections` | 146 – 168 ms |
| pinger P99 / max | 7 / 1556 ms |

> 复测中 rename 墙钟从 18.5s 涨到 51.1s，主要波动来自磁盘缓存与 GC 状态
> （这台机器同时在跑其他负载）。**该数字不适合当作结论**；结论只用
> `warmed=0` / `hotUnits=29` 这类状态量。

**预热一次都没跑成。** 加上临时诊断后（本轮已从发布代码中移除）看到：

```
[probe] created session-probe-long events 240006 warmupEnabled true proj? object
[probe] warmSession registry? object snapshot? function cellFor? function buildCell? function
[probe] events 240006 minEvents 20000
[probe] registrations 29 refs0 0 alreadyHot 1
[probe] unit turnBoundary => skip baseSeq -1
[probe] unit sandboxMode => skip baseSeq -1
...（29 个 unit 全部 skip）
```

### 根因：监听器顺序 + 上游在本进程内已建满 cell

`session/created` 是**同步广播**（`dsh-session/lib/index.js:1909-1935`），按监听器
注册顺序调用。dsh 自己的 `dsh-api-session-controller` 在
`lib/index.js:3825` 注册了：

```js
ctx.on("session/created", (session) => {
  ctx.emit("api-session/added", this.listState.summaryFor(session));
});
```

`summaryFor` → `sessionProjections.snapshot(session)` → `cellFor()`，而 `cellFor`
在 cell 缺失时用 `buildCell(def, header, inheritedEventCount, session.snapshotEvents())`
**一次性全量折叠并写入 `registration.cells`**（`dsh-session-projection/lib/index.js:514-521`）。

插件的监听器注册得更晚（bundle 加载顺序：base → web-app → 第三方插件），所以轮到
它时 29 个 cell 中绝大多数已经建好。`foldUnit` 第一行
（`lib/warmup.js:55`）就是：

```js
if (registration.cells.get(session) !== void 0) return { status: 'skip', baseSeq: -1 }
```

于是全部 skip，`foldedUnits` 保持 0，`warmed` 不增。

### 这个失效有多严重

- 预热的设计前提是「抢在首次同步冷折叠之前」。在 0.2.2 的
  `initializeAgent` 顺序下（`announce` 在 `setup` 之前，`dsh-agent-loop/lib/index.js:1571-1572`），
  这个前提**不成立**：cell 在 announce 的同步广播里就被建完了。
- 但它并不比「没有插件」更差：cell 已热，后续读投影只要 146 ms。真正消失的是
  **分片让出的效果** —— 那 16.6 秒的同步折叠仍然完整发生在 `session/created`
  广播路径上，pinger 的 1556 ms 停顿就是它（合并进 resume 的 18.5 秒里）。
- 因此 `warmup` 的 `active` 状态是**名义上的**，与 `stats.warmed=0` 并存。

### 附带确认的一个实现缺口

`warmupEnabled=false` **不能阻止启动扫描**：`lib/index.js:102-104` 遍历
`ctx.sessions.list()` 时没有该开关的守卫。本轮未单独构造场景验证它（启动时
`sessions.list()` 通常为空，因为会话是懒加载的），但代码路径明确。

### 本轮新增的观测字段

`stats.alreadyHot`（1.6.0 新增）就是为这个失效模式加的：会话进入时若全部投影
已由上游折完，`foldedUnits` 为 0，原实现既不增 `warmed` 也不增 `skipped`，
`warmRecent` 也是空的 —— 三种状态（未达门槛 / 已折完 / 预处理中）无从区分。
现在这种情形计入 `alreadyHot` 且 `warmRecent` 会留下 `hotUnits: 29` 的记录。

同样，`foldUnit` 对已存在的 cell 从返回 `skip` 改为返回 `hot`，让「上游抢先」
与「并发 drive 抢建」在语义上分开。

## 场景 D：真实 fork RPC

`session/fork`（Web UI 的「分支会话」走的就是这条）：

| 指标 | 值 |
|---|---|
| fork 全程 | **25811 ms** |
| `stats.forks` | **0** |
| `stats.zeroCopy` | 0 |
| 子会话落盘帧数 | 6 |
| 子会话字节 | 19,017,817 |

`stats.forks = 0` 是决定性的：插件的零拷贝补丁挂在
`SessionStore.prototype.fork`（`lib/patches/zero-copy-fork.js:188`），而 0.2.2 的
`session/fork` RPC 自己构建 seed 后调 `agents.create`：

```js
const seed = buildForkSeed(source.events, boundary);
await this.ctx.agents.create({
  sessionId: childId,
  seed,
  inheritedEventCount: SessionLogOffset(boundary + 1),
  meta: { ..., isSeeded: true, ... },
  ...
});
```

（`dsh-api-session-controller/lib/index.js:775-806`）

全安装包内**没有任何服务端代码调用 `sessions.fork(`** —— 只有浏览器端
`dsh-client-ui-chat` / `dsh-client-ui-workspace` 的 client.js 里出现过
`ctx.sessions.fork`，那是前端 API 层的同名方法，与 `SessionStore` 无关。

**所以零拷贝补丁在 dsh 0.2.2 的常规 fork 路径上是一个死补丁**：装得上、
`active`、每次 fork 都计数为 0。

## 场景 E：直测补丁点（`debug.fork`，同进程 A/B）

用本轮新增的 `debug.fork` 直接调 `ctx.sessions.fork(sourceId)`，同进程切换
`zeroCopyFork` 开关，各跑 5 次（24 万事件源会话）：

| 模式 | n | min | median | max | forks | zeroCopy | fallbacks |
|---|---|---|---|---|---|---|---|
| 原生（`zeroCopyFork=false`） | 5 | 18820 ms | **20125 ms** | 21014 ms | 5 | 0 | 0 |
| 零拷贝（`zeroCopyFork=true`） | 5 | 15684 ms | **15802 ms** | 16018 ms | 5 | 5 | 0 |

> 同日复测（机器负载更高，绝对值整体上移，比例基本不变）：
> 原生 median **25776 ms**、零拷贝 median **21760 ms**（**-15.6%**）。
> 两次独立运行的收益区间是 **-16% ~ -21%**，方向一致。

- 补丁**确实被调用**（`zeroCopy=5`，`record.path` 全为 `zero-copy`），没有回退。
- 但收益只有 **16–21%**，不是 README 原先宣称的「数百 ms → 个位数 ms」。
- 原因：`buildForkSeed` 本身要做 `events.slice(0, boundary+1)`，24 万个元素的数组
  切片就要复制整个数组；而 `fromRestore`/`shared-frozen` 省掉的只是逐事件的
  `snapshotJsonValue` + `deepFreeze`。在 24 万事件量级上，后者占的份额远没有
  README 举例的 18 MB 会话那么高。
- **这是同进程 A/B**，JIT、page cache、堆状态都相同，所以比例可信（绝对值受机器
  负载影响很大）。

注意：`session/fork` RPC 的 25.8 秒 **不能**与这里的 20 秒直接比较 —— RPC 还要
`observeSession`（全量读日志，~1.8s）+ `composeAgent` + `agents.create`（含
`prepare` 的又一次 seed 构造）+ `persistence.create` + workspace attach。

## 场景 F：分片 materialize

两次独立进程，`chunkedMaterialize` 通过环境变量在启动时定值（该开关只在 install
时读一次，`config.set` 改不动），各跑一次真实 `session/fork`：

| chunkedMaterialize | zstd 帧数 | 文件字节 | fork + materialize |
|---|---|---|---|
| `true` | **6** | 19,017,754 | 24988 ms |
| `false` | **2** | 19,022,443 | 27331 ms |

> 同日复测（负载更高）：`true` 6 帧 / 19,017,965 B / 35.3s；`false` 2 帧 /
> 19,022,657 B / 33.3s。帧数与字节完全复现，耗时方向反转但差异在噪声内。

- **分片确实生效**：6 帧 = 1 个头帧 + 5 个数据帧（240018 / 50000 = 4.8），
  关闭时 2 帧 = 1 头帧 + 1 数据帧。两次独立运行帧数与字节数完全一致。
- **但字节数几乎相同**（差 0.02%），总耗时也没有稳定改善（两次运行方向相反）。
- 结论：该补丁解决的是**单次 `Buffer.concat` / 单个 zstd frame 的内存峰值与
  `RangeError`**，不是吞吐。它在本轮 19 MB 的会话上没有触发量级差异 —— 需要
  数百 MB 级会话才能体现它要解决的问题。

## 场景 G：冷读回写（v1.7，**负面结果**）

### 假设

上一轮把 16.6 秒的冷读拆成「`session/events` 1.8–2.7 s（解码 + surface 折叠）」
与「`session/projections` 16.6 s」，差值推定为投影折叠。据此假设：**只要把折好的
状态存成缓存行，下次命中就该接近 0.26 秒**。同时发现 dsh 自己的
`sessionProjectionCache.coldSnapshot()` 是死代码（全安装包 0 个生产调用点），
冷读从不回写 —— 于是实现了「冷读后回写」。

### 实测

24 万事件会话，清空 `storages/session_projcache`，`warmupEnabled=false`：

| 情形 | 首次读 | 同进程二次读 | 缓存行 |
|---|---|---|---|
| **无缓存行**（回写关） | 18938 ms | — | 无 |
| **有缓存行**（回写开，新进程） | **19061 ms** | 16913 ms | 9.14 MB / 29 units |

回写本身**完全成功**，可核实：

- `session-probe-long.json` 已落盘，9.14 MB；
- `stats.coldWriteBacks = 1`，`coldWriteBackRecent = [{ units: 29, events: 240031, ms: 268 }]`；
- identity 与读取侧逐字段一致（`formatVersion: 4, createdAt, cwd, isSeeded: false,
  inheritedEventCount: 0`）；
- 所有行的 `seq = 240031`，正好等于日志末尾，`restore` 的折叠循环因此**一次都不执行**；
- `recordFor` 探针显示 **HIT**。

### 结论：缓存行命中没有带来任何加速

19.1 s vs 18.9 s，差异在噪声内。这推翻了"折叠是大头"的推定。

### 那 16 秒到底花在哪

逐项排除后的结果：

| 环节 | 实测 | 说明 |
|---|---|---|
| `recordFor` 命中判定 | 微秒级 | 同步内存 Map 查询 |
| 各单元 `stateSchema.parse(row.val)` | **52 ms**（`turnOutline` 33 ms） | 29 个单元合计 |
| `restore` 的折叠循环 | **0 次迭代** | `startIndex = row.seq + 1 = events.length` |
| `@deepseek-ai/schemastery` 校验 | 无法单独测（本轮尝试失败） | 见下 |

所以 16 秒既不在这三项里，也不在 `hydratePrepared` 之外的 IO 上（`readFile` 18 MB
只需几百毫秒）。剩余可能集中在：

1. `SessionLogScanner` 逐行 `JSON.parse` + `assertV4RowAdmission`（24 万行）；
2. `scanner.finish()` 的 `assertReleasedV4Relationships` + `adoptSessionEvent` +
   `freezeStoredEvents`（深冻整棵事件图，24 万个对象）；
3. `Session` 构造时 `SurfaceManager` 对每个 seed 事件调 `validateNext`（O(N) 折叠）。

这三项**都在缓存行之前**——它们不需要投影，纯粹是"把日志变成内存里的事件数组"。
这也解释了为什么 `session/events`（不做投影）在**刚启动的进程**里也要 1.8–2.7 s，
而缓存行完全帮不到它。

> 未能定位到上述三项里的具体份额：`schemastery` 的 API 与 zod 不同
> （`z.number().int` 不存在），本轮没找到等价构造方式来单独计量
> `wire.viewSchema.parse`。这是本轮的方法缺口，已在"测量方法的边界"里记录。

### 因此该能力默认关闭

`coldWriteBack` 默认 `false`：它没有可测量的耗时收益，却每次冷读写一个约 10 MB
的记录（`turnOutline` 单占 6.45 MB / 71%）。

保留它的理由只有一条：让 `session_projcache` 的行跟上日志，从而让 dsh 自己的
**列表读**（`cachedSnapshot`，零 I/O）看到更新的数据 —— 那是另一个问题，与本轮
要解决的"打开慢"无关。

## 场景 H：16.6 秒的精确归因（v1.8）

v1.7 的归因是错的。当时说「折叠循环 0 次迭代」——那只在**缓存行命中**时成立；
真实冷读（空缓存）里折叠是大头。v1.8 用分段基准 + 逐单元计时拿到了完整画像。

### 第一步：解码链路只要 1.4 秒

`tests/bench_cold_read.mjs`（独立复算，用同一份 18.14 MB / 24 万事件日志）：

| 段 | ms | 占比 | 备注 |
|---|---:|---:|---|
| B1 帧扫描 | 0.6 | 0.0% | **29 帧** |
| B2 逐帧解压 | 412.6 | 30.4% | 膨胀到 73.8 MB |
| B3 utf8 + split | 122.7 | 9.0% | 240032 行 |
| B4 `JSON.parse` | 559.2 | 41.3% | 240031 个事件 |
| B5 全图深冻 | 94.2 | 6.9% | 240031 个事件 |
| A1 `Session.fromRestore` | 166.2 | 12.3% | 信封校验 + surface 折叠 |
| **合计** | **1355** | | |

再用真实 `persistence.open` / `handle.read` 交叉验证：`open()` 1622 ms、`read()`
**26 ms**（帧解压 + 行解析在 `open` 时就做完了，`read` 只切视图）。

**结论：解码 + 解析 + 冻结 + Session 构造，全部加起来约 1.4–1.65 秒。**

### 第二步：剩下 19 秒全在一个投影单元上

在真实 dsh 进程里逐单元计时（29 个注册单元 × 24 万事件）：

| 单元 | 折叠耗时 | 占全部折叠 |
|---|---:|---:|
| **`turnOutline`** | **16061 ms** | **96.0%** |
| `titleInput` | 194 ms | 1.2% |
| `contextPressure` | 42 ms | 0.3% |
| 其余 26 个合计 | 431 ms | 2.6% |
| **合计** | **16728 ms** | |

完整归因：

```
冷读总耗时                        21190 ms
├─ open() + read() 解码链路         1650 ms   7.8%
├─ Session 构造（信封+surface）      166 ms   0.8%
└─ 投影折叠                        16728 ms  78.9%
   ├─ turnOutline                  16061 ms  75.8%  ← 唯一的问题点
   └─ 其余 28 个                      667 ms   3.1%
```

### 第三步：`turnOutline` 是 O(n²)

它的 `apply` 每次 `turn/start` 都执行 `turns: [...state.turns, next]`，每次
`user/message` / `turn/end` 执行 `turns: [...state.turns.slice(0, -1), fixed]` ——
**整数组复制**。N 个 turn 累积是 O(N²)。

同一批事件，与语义等价的「只替换末项」写法对比（`tests/test_fast_turn_outline.mjs`
的可复算版本）：

| turn 数 | 上游实现 | 线性等价实现 | 倍数 |
|---:|---:|---:|---:|
| 5 000 | 87 ms | 2 ms | 43× |
| 10 000 | 439 ms | 12 ms | 37× |
| 20 000 | 5238 ms | 7 ms | **701×** |

翻倍 turn 数时上游耗时约 12 倍增长，坐实二次复杂度。

### 修复与实测

`lib/fast-turn-outline.js` 用 O(N) 等价 fold 替换该单元的 `def.apply`。
因为是替换投影语义，**必须逐字段等价**：

- `preview` 逐字复刻上游（含 `limit*2` 的提前截断、空白压缩、省略号规则）；
- fold 逐 case 复刻（含 turn 号不递增则忽略、只取第一条 user 消息、
  空白 prompt 不写入、assistant draft 覆盖、turn/end 提交）；
- **安装前跑运行时等价探针**：用 15 条覆盖全部分支的合成事件流，分别跑上游
  `apply` 与我们的 fold，`JSON.stringify` 结果必须相等，否则不上线。
  （拿不到原始源码做特征校验——投影注册表把 `definition.apply` 包成了
  `(state, event) => definition.apply(state, event)`。）

实测（24 万事件、30 000 个 turn）：

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| 首次冷读 | 21190 ms | **3008 ms** |
| 同进程二次读 | ~14000 ms | **349 ms** |
| `turnOutline` 输出 | 30000 条 turn | 30000 条 turn，**逐字段一致** |

### 这个修复说明了什么

不是「dsh 的折叠都慢」，而是**一个投影单元的 `apply` 用了二次复杂度的写法**。
其余 28 个单元合计只占 3%。这也解释了为什么前面几轮针对「折叠层」的优化
（缓存回写、预热）都无效——它们没有触及那个 76%。

## 对插件结论的影响

1. **零拷贝 fork 在 0.2.2 上是死代码。** 要么给 `session/fork` 的
   `agents.create({seed})` 路径补一个补丁点（把 `seed` 换成 `eventState:'shared-frozen'`
   通道），要么如实标注「仅对直接调 `SessionStore.fork` 的宿主有效」。
2. **预热在 0.2.2 上完全失效**，原因是 `session/created` 的同步广播里上游先建满
   cell。要修复必须换挂载点（例如在 `sessions.enter` 之前介入，或改为包装
   `buildCell` 让它在折叠时分片让出），不能靠调整监听器顺序（那是上游的注册顺序）。
3. **`fastInitFor` / `preparedCacheTrim` 在当前 dsh 上永远不会 `active`**，应标为
   历史兼容层而非「补丁」。
4. **`stats.patches` 的 `active` 不等于生效**。需要额外的「本轮实际命中数」指标
   （`warmed` / `zeroCopy`）才能判断。
5. **日志不可见**是默认配置下的常态，排错必须依赖 `stats.get`。
6. **（v1.8）优化目标已经对准了**。冷读 21 s → 3.0 s 已落地（`fastTurnOutline`）。
   剩余的 3 秒构成：解码 1.65 s + 其余 28 个单元 0.67 s + `turnOutline` 线性 fold
   约 0.1 s + HTTP 序列化。要再往下走，按成本排序：
   - `JSON.parse` + 帧解压合计 0.97 s —— 只能靠移入 worker 或帧索引，收益上限 1 秒；
   - 其余 28 个单元 0.67 s —— 逐个 case 看有没有同样的二次写法（需再逐单元测一次
     `apply` 的复杂度，本轮只测了 `turnOutline` 是二次的）。

   注意：v1.7 里写「16 秒在日志 → 内存事件数组」是**错的**，那一段实测只要 1.4 s。
   详见场景 H。

7. **（v1.8）worker 方案已评估并放弃**：它只能拿走解码链路的 6.4%（1.4 s 中的
   一部分，还要付跨线程复制成本），而 76% 在投影折叠上。上一版计划里的三条
   准入条件第一条（decode > 10 s）实测就不成立（1.36 s）。

## 测量方法的边界

- pinger 是**外部代理指标**：含 HTTP + socket + JSON 序列化开销（基线 2-7ms），
  且采样间隔内的阻塞只会抬高「下一次」采样，真实峰值可能更高。结论只用
  「相对基线抬高多少」，不用绝对值。
- RPC 墙钟包含序列化与网络栈，不等于纯折叠成本。
- 单机、单次运行。场景 B 复测两次一致（< 1%），但 E/F 只有 5 次 / 2 次样本，
  不能当作统计显著的性能结论。
- RSS 用 `Win32_Process.WorkingSetSize`，含映射文件与未回收页，比 V8 `heapUsed`
  偏大。
- **场景 G 的归因不完整**：能证明"缓存行命中不加速"，也能量出
  `stateSchema.parse`（52 ms）与折叠循环（0 次迭代），但**没能**把剩下的约 16 秒
  进一步拆到 `JSON.parse` / 关系校验 / 深冻 / surface 折叠各自头上。原因是
  `schemastery` 的 API 与 zod 不同（`z.number().int` 不存在），本轮没构造出
  等价的 `wire.viewSchema` 来单独计时。再要拆需要换一种打点方式（例如在
  `SessionLogScanner` 与 `SurfaceManager` 上包一层计时器）。
- 会话是**合成**的（真实实现类写出的合法 v4 会话，事件类型与信封逐字段对齐），
  内容分布与真实会话不同，压缩比可能偏高或偏低。
