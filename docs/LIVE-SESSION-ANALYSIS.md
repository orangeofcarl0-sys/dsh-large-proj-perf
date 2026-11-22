# Live Session 驱逐与日志窗口化：源码级分析

> 目标：回答两个问题——插件能否安全驱逐 live Session/Agent？能否把 live Session 的事件日志改成窗口？
>
> 结论先行：**两件事都不能由插件安全完成**。live 驱逐的唯一完整路径是 `AgentHandle.dispose()`，而 Web 控制器在 resume 后立刻丢弃了这个 capability；日志窗口化要求 `Session` 的 `seq = log.length = 数组下标` 不变量整体改写，牵动投影、fork、持久化、分页与搜索，属于上游契约变更。
>
> 本文只记录分析与测量，不改变默认行为。动态数据见 §10。

## 1. 范围与版本

- dsh `0.2.2-rc.5`；`dsh-session` / `dsh-agent` / `dsh-agent-loop` / `dsh-api-session-controller` 在 rc.3–rc.5 源码一致（COMPATIBILITY 已记录）。
- 只讨论 Host 侧 live 对象；不讨论浏览器 DOM/渲染进程内存。
- “驱逐”指让 live Session/Agent 释放事件树并退出注册表；“窗口化”指 live Session 只保留最近一段事件，旧事件按需从持久化读回。

## 2. 所有权：谁持有 live Session 与 Agent

### 2.1 SessionStore（`ctx.sessions`）

`SessionStore` 的公开面只有：

| 方法 | 作用 | 是否可驱逐 |
|---|---|---|
| `get(id)` / `list()` | 查 live Session | 否 |
| `create/prepare` | 构造并进入 | 否 |
| `enter(session)` | 加入 store，**返回 detach 闭包** | 闭包可移除，但由创建者持有 |
| `announce(session)` | 发 `session/created` | 否 |
| `flush(session)` | 持久化 barrier | 否 |
| `fork(source, boundary, childId)` | 同步 fork | 否 |

`enter()` 的 detach 闭包是单次、身份绑定的；它只从 store 删除条目并发 `session/disposed`，**不 cancel turn、不 flush、不关持久化句柄**。生产环境里这个闭包由创建 fiber 的 effect 持有（`SessionStore.create` 的 `ctx.effect` 或 agent-loop 的创建事务），没有按 id 取回的公开方法。

### 2.2 AgentRegistry（`ctx.agents`）

公开面：`get/list/create/resume/register/enter/announce`。没有 `dispose`/`detach`。

`create()`/`resume()` 返回 `AgentHandle = { agent, dispose }`。`dispose` 是 **capability**：只有 handle 的持有者能完整 teardown。它被存放在两处：

1. 返回的 `AgentHandle`；
2. `AgentLoop` 私有的 `FactoryOwnership.liveAgents`（插件卸载时统一 drain）。

`AgentRegistry` 的 entry 只存 `{id, agent, carrier, announced, ...}`，**不存 dispose 闭包**；`get(id)` 只返回裸 `Agent`。运行时 `Agent` 上能看到 `scope`（`ReactLoopAgent` 的非公开字段），但 `scope.dispose()` 只解绑 agent-scoped 注册，不停止 driver、不 cancel、不 flush、不发 disposed，属于“半拆”。

### 2.3 Web promote 路径

`session/follow` 带 `activate: true` 时：

```
web/controller.follow
  → historyController.usingObservation（读 lease，read-only）
  → observation.retain() + promote()
  → agents.resolveObservedAgent()
  → SessionAgentController.resolve()
  → agents.resume(...)  → AgentHandle
  → return (await ...).agent        ← handle 在这里被丢弃
```

`promote()` 是 detached background task，和 follow stream 解耦（`web/controller.ts` 的注释明确说 activation 不随 stream 取消）。WebSocket 关闭时 gateway 只 abort stream/queue；**没有任何 RPC 会 dispose Agent/Session**。

### 2.4 结论

| 路径 | 可达性 | 完整性 | 安全 |
|---|---|---|---|
| `AgentHandle.dispose()` | 只有创建者持有；Web 路径拿不到 | 完整 teardown | 会 cancel turn/清 inbox；仅 idle 时安全 |
| `sessions.enter()` detach | 创建者闭包；无按 id API | 只移出 store | 不停止 Agent，留下 zombie |
| `agents.enter()` detach | 创建者闭包；无按 id API | 只移出 registry | 不停止 driver |
| `agent.scope.dispose()` | 运行时私有字段 | 半拆 scope | 不可用 |
| 私有 `detachEntered` / `store.delete` | TS private | 不完整 | 不可用 |

插件唯一“合法”的 ownership 获取方式，是在浏览器 promote **之前**自己 `ctx.agents.resume()` 拿到 handle；代价是插件必须先创建 live Agent，且要复刻 controller 的 preset/agentOptions 组合。对“用户打开哪个会话就驱逐哪个”的通用场景不可行。

## 3. 完整 teardown 的语义

`dsh-agent-loop/src/index.ts` 的 `teardown()`（约 494–556 行）是唯一完整路径：

1. `abort.abort(...)`，停止接受新工作；
2. `machine.cancel({kind:'disposed'}, {keepInbox: !ready})`：取消当前 turn；已 publish 的 agent 会清空 inbox；
3. `await machine.whenIdle()`：等 driver/turn 收敛；
4. `machine.scope.dispose()`：解绑 agent-scoped 注册；
5. `stored.handle.close()`：持久化 drain + 释放写所有权；
6. `detachAgent()` + `detachSession()`：移出两个注册表，发 `agent/disposed`、`session/disposed`；
7. `untrack()`：从 factory ownership 移除。

因此：

- **不是“无损”操作**：当前回答会以 aborted 结束，排队输入可能丢失；
- `session/disposed` 会触发 projection-cache 的 final flush（fire-and-forget），但 `SessionStore` 本身不 flush；
- 没有 refcount/observer 计数，无法知道“是否还有页面在看这个会话”；`activate: true` 的语义就是“页面走了也要继续跑”。

## 4. 日志窗口化的核心不变量

### 4.1 `seq = log.length = 数组下标`

`Session` 的关键事实（`dsh-session/src/index.ts`）：

```ts
get seq() { return SessionLogOffset(this.log.length) }
append: seq = this.log.length
snapshotEvents(from, to) { return Object.freeze(this.log.slice(from, to)) }
eventAt(seq) { return this.log[seq] }
```

seed 校验同样要求 `snapshot.seq === index`，fork 的 boundary 查找直接 `events[boundary]`。窗口数组只要不从 0 开始，上述所有“绝对 seq = 数组下标”的假设同时失效。

`inheritedEventCount` 不是窗口基址：它是完整日志里的一个切点，`isOwnSeq(seq) = seq >= inherited && seq < this.seq`；`inheritedEventCount > log.length` 会抛错，seed 仍必须从 0 连续。

### 4.2 消费者矩阵

| 消费者 | 依赖 | 窗口后的结果 |
|---|---|---|
| `sessionQuery` live observation | `snapshotEvents(0, seq)`，`cursor = seq-1` | `events` 只含后缀，但 cursor 仍是绝对值；分页按绝对下标取错 |
| projection `cellFor/buildCell` | 从 `init` 开始对全量事件 `apply` | 晚注册单元只折窗口，所有依赖早期事件的投影值错误 |
| projection `advanceCell` | 逐 seq 前进，缺 seq 抛错 | 窗口基址之后的 cell 若落后于基址，直接抛 `cannot advance across missing seq` |
| `turnOutline` | 全量 `turn/start…turn/end` | 早期 turn 消失；窗口从 turn 中间开始时产生半个 turn |
| projection-cache | `checkpoint` 信任 cell 状态 | 错误状态会带正确 end seq 写盘，静默污染冷读 |
| JSONL persistence | `assertContiguous`、整文件 decode/materialize | 连续日志契约破坏；catch-up suffix append 失败 |
| `SessionStore.fork` / `agents.create({seed})` | 从 0 连续 prefix + boundary | boundary 取错、prefix 缺失，child 构造失败 |
| `session/page` / `events` | `paginate(events)` 用数组下标当 seq | 取错事件或越界；`hasMore` 在窗口边界判断错 |
| `session/projections` live | `sessionProjections.snapshot(live)` | cell 已存在时可用；缺失时折窗口，错误 |
| title/telemetry/search/subagent | `snapshotEvents()` 全量扫描 | 旧事件丢失，索引/标题/回放不完整 |

### 4.3 休眠的窗口原语

| 原语 | 现状 | 为什么不能直接用 |
|---|---|---|
| `SurfaceManager(log, baseSeq)` | 构造函数支持加载窗口 + baseSeq | `Session` 永远传 0；没有从 checkpoint 恢复 surface fold 状态的 API |
| `SessionProjectionRegistry.restore(checkpoint, events, baseSeq, ...)` | 真正支持“checkpoint + 后缀” | 生产调用全部传 0；`baseSeq > 0` 时每个 live unit 都必须有可用 row，否则抛错 |
| `SessionProjectionRegistry.restoreFloor(checkpoint)` | 专为“从哪个 seq 开始读后缀”设计 | 无生产调用 |
| `SessionHandle.read(offset, length)` | 逻辑切片 | JSONL 后端仍先解码整文件再 slice；没有 tail-only index |
| `maxMessages` / `beforeSeq` / `turnWindow` | 响应分页 | 只在完整 observation.events 上切片，不减少 Host 内存 |

## 5. 上游最小改动候选

### 5.1 驱逐

最小可用方案不是“插件调用私有 dispose”，而是上游提供一个有明确语义的 public API：

- `AgentRegistry.dispose(id)`，内部必须拿到 `AgentHandle.dispose`；或在 service 层按 id 保留 handle；
- 调用前要求 `agent.status === 'idle'`，或有 observer refcount；
- 明确 `cancel`/`flush`/`inbox` 策略；
- 提供 `session/disposed` 后的 projection-cache flush 保证；
- 暴露“当前有几个 observer/follower”的计数，否则无法判断是否有人在看。

改动面：`dsh-agent`（registry API）、`dsh-agent-loop`（handle 保留/所有权）、`dsh-api-session-controller`（不再丢弃 handle，或在 promote 时登记）、可能还有 `dsh-api-gateway`/web controller 的 observer 生命周期。比窗口化小，但仍跨 3–4 个包。

### 5.2 窗口化

最小完整方案需要：

- `Session` 增加 `logBase`，`seq = base + log.length`；`eventAt/snapshotEvents/ownEvents/append` 全部 base-aware；
- `SurfaceManager` 用 baseSeq 构造，并能从 checkpoint 恢复 fold 状态；
- projection registry 在 `base > 0` 时用 `restore(checkpoint, suffix, baseSeq)`，并计算“所有 live/retained cell 的最小 retained seq”作为可驱逐水位；
- persistence 增加 tail index（按 seq 定位），`appendUnstoredSuffix` 不再假设 `snapshotEvents(storedCount)`；
- `paginate`/`SessionPageRequest` 增加 baseSeq，`hasMore` 相对 base 计算；
- `SessionStore.fork` 要么保证 `base <= boundary+1`，要么异步从持久化补 prefix；`buildForkSeed`/`openTurnClosers` 需要完整 turn prefix；
- title/telemetry/search/subagent 等全量读者改为 checkpoint+suffix 或显式降级。

改动面：`dsh-session`、`dsh-session-query`、`dsh-session-projection`、`dsh-session-projection-cache`、`dsh-session-persistence(-jsonl)`、`dsh-api-session-controller`、`dsh-agent-loop`、subagent/title/telemetry/search；公开同步 API 的语义会变。**不建议作为插件补丁。**

## 6. 插件侧可做的替代

- 读路径分页：`lib/history-budget.js` 已经在 `sessionController.follow` / `historyController.events` 上收紧 `maxMessages`/`turnWindow`；它减少 wire 字节与浏览器挂载行数，**不减少 Host 的 live log**。
- 冷缓存预算：`lib/memory-budget.js` 对 observation cache / `coldLogMemo` 有效（见 MEASUREMENTS §2.4.2），但对 live Session 无效。
- 冷读 checkpoint：`restoreFloor`/`restore` 可以在**冷读**时用“checkpoint + 后缀”降低 fold 成本，但不能减少 live log；可作为上游窗口化设计的试验田。

## 7. 动态验证设计

### 7.1 观测面

- `debug.sessions`：只读列出 `agents` / `sessions` / observation cache / `coldLogMemo` 的计数与数组长度。禁止调用 `snapshotEvents()` / `deriveMessages()`，避免观测本身分配。
- `debug.heap`：`process.memoryUsage()` + `v8.getHeapStatistics()` + `getHeapSpaceStatistics()`。
- `debugAgentHandles`（默认 false，分析专用）：包装 `AgentRegistry.prototype.resume/create` 捕获 `AgentHandle`，暴露 `globalThis.__dshPerfProbe` 的 `dispose/detach/trim`。分析结束删除。
- `analyze-heap.mjs`：解析 `edges`，建反向邻接，按目标算 retained size 与 retainer path。

### 7.2 实验

| 实验 | 状态/动作 | 关键指标 | 判据 |
|---|---|---|---|
| A liveness | cache-only → live+cache → after-close → dispose | `agents/sessions` 计数、`logEvents`、`eventsSnapshot`、`derived`、cache refs | 关页后 `agents>0` 证 live；dispose 后归零 |
| B 驱逐 | control / dispose / detach | 堆降幅、agents/sessions、重开首行 | dispose 释放接近 live 表示；detach 几乎不降 |
| C1 窗口上限 | 清 snapshot → 尾部 log → 清 derived | 每步堆降、快照 retainer | 低于预测 50% 说明隐藏引用主导 |
| C3 分页对照 | `maxInitialMessages` 0 vs 25 | Host 堆 | 应无变化 |

> 动态结果见 §10（`mem-live` / `mem-open` 实测）。

## 8. 结论（静态部分）

1. **插件侧 live 驱逐：对 Web 已 promote 的会话不可行**。没有公开按 id dispose；
   Web 控制器丢弃唯一 handle；detach 只移注册表，不释放 Agent。插件只有在浏览器
   promote **之前**自己 `agents.resume()` 才能拿到 handle，代价是先创建 live
   Agent 并复刻 controller 的 preset 组合，不能用于通用场景。
2. **插件侧日志窗口化：不可行**。`seq = log.length` 是 Session 的根不变量；窗口化要同时改投影、fork、持久化、分页与全量读者。
3. **上游最小改动**：优先做“有 observer refcount 的 idle Agent dispose”；窗口化只在有明确收益且能接受公开契约变更时再做。
4. 插件当前能做的仍是冷缓存预算与读路径分页；不要用私有 `scope.dispose`/`detachEntered` 冒充驱逐。

## 9. 源码索引

- `dsh-session/src/index.ts`：`Session`、`seq`、`snapshotEvents`、`SessionStore.enter/detachEntered/fork`。
- `dsh-agent/src/index.ts`：`AgentHandle`、`AgentRegistry.enter/detachEntered`。
- `dsh-agent-loop/src/index.ts`：`initializeAgent`、`teardown`、`FactoryOwnership`。
- `dsh-api-session-controller/src/agent.ts`：`resumeObserved` 丢弃 handle。
- `dsh-api-session-controller/src/web/controller.ts`：`follow`/`promote`。
- `dsh-session-query/src/observation.ts`：live/prepared observation、`preparedLease`。
- `dsh-session-projection/src/index.ts`：`cellFor/buildCell/advanceCell/restore/restoreFloor`。
- `dsh-session-persistence-jsonl/src/storage.ts`：`assertContiguous`、`read(offset)` 的整文件解码。
- `dsh-api-session-controller/src/history.ts`：`paginate` 的绝对下标。
- `lib/memory-budget.js`、`lib/history-budget.js`：插件现有边界。

## 10. 动态结果

数据来自 `mem-live.mjs`（单会话状态机）与 `mem-open.mjs --sessions 5`（5 会话 liveness）；dsh 0.2.2-rc.5，隔离 home，host GC 后取 3 次 `heapUsed` 中位数。快照来自 `mem-live --snapshot-states live`。

### 10.1 A：liveness 与表示归属（1 个目标会话）

Web app 启动时还会自动创建一个空白会话（seq=3），所以 `agents/sessions` 计数是“空白 + 目标”；下表的 liveness 以目标 id 为准。

| 状态 | Host heap MiB | agents | sessions | cache | 目标 logEvents | snapshot | derived |
|---|---:|---:|---:|---:|---:|---:|---:|
| cache-only | 318.7 | 0 | 0 | 1 | — | — | — |
| live | 332.5 | 2 | 2 | 1 | 91,036 | true | 0 |
| after-close | 331.8 | 2 | 2 | 1 | 91,036 | true | 0 |
| reopen | 333.8 | 2 | 2 | 1 | 91,036 | true | 0 |

- **关页后目标 Agent/Session 仍 live**（`targetAgentLive=true`），reopen 只用了 470–484 ms（热）。
- cache entry `events=91,035`，prepared Session `log=91,036`，`sharedFirstEvent=true`：live Session 与 cache 条目**共享 event 对象**，不是第二棵事件树。
- live 快照：目标 `Session` 自身 retained **1.8 MiB**——`log` 指针数组 0.9 MiB（91,048 elements）、`eventsSnapshot` 0.7 MiB（91,048 elements）、`derived` 0；prepared Session retained 1.1 MiB。约 116 MiB 的 event 对象由 cache 条目持有，因此不计入 Session 的 retained。
- 进程增量 13.8 MiB 中除 Session 数组 1.8 MiB 外，其余是 Web boot 自动创建的空白会话、Agent/loop、projection cells 与固定开销。
- 快照 retainer path 经过 `__dshPerfProbe.handles` 是探针自身的强引用（分析工件）；`AgentRegistry.store` 也持有同一个 Agent。

### 10.2 B：真 dispose vs 仅 detach

| arm | after-close → after-action | 堆变化 | agents | sessions | cache | reopen |
|---|---|---:|---:|---:|---:|---|
| control | 331.8 → 331.8 | 0 | 2 | 2 | 1 | 470 ms |
| dispose | 331.8 → 325.2 | **−6.6 MiB** | 1 | 1 | 1 | 3,539 ms |
| dispose + 清 cache | 331.8 → 210.2 | **−121.6 MiB** | 1 | 1 | 0 | 3,559 ms |
| detach only | 331.8 → 331.8 | 0 | 2 | **1** | 1 | 2,061 ms；重开后堆 **436.6 MiB（+104.8）** |

- 真实 `AgentHandle.dispose()` 只释放 **6.6 MiB**：observation cache 仍持有约 116 MiB 的 event 对象。dispose 后再清 cache，释放 **121.6 MiB**；event tree 实测约 **115 MiB**（91,040 事件 ≈ 1,324 B/事件），多出的约 6 MiB 是 live Session/agent 开销（与 dispose-only 的 6.6 MiB 同量级）。
- detach-only 堆完全不变（Agent 仍 live），但 Session 从 store 消失；重开同一会话时堆反而 +104.8 MiB，`sessions` 仍是 1——旧的 Agent/Session 变成 zombie，新的读取又建了一份表示。**私有 detach 不是驱逐。**

5 会话 Web（`mem-open --sessions`，每次关 Chrome 后取 `debug.sessions`）：

| # | 稳定 Host heap MiB | 目标关页后 live | cache entries | trimmed |
|---|---:|---:|---:|---:|
| 1 | 332.9 | true | 1 | 0 |
| 2 | 459.5 | true | 2 | 0 |
| 3 | 586.7 | true | 3 | 0 |
| 4 | 713.8 | true | 4 | 0 |
| 5 | 833.6 | true | 4 | 1 |

5 个目标 Agent 在各自关页后全部 live；第 5 个会话触发 cache 淘汰 1 条，堆仍按约 120 MiB/会话增长——**缓存淘汰不释放 live Agent 的事件树**。

### 10.3 C1：日志窗口的内存上限

| arm | before → after | 移除事件 | cache | reopen |
|---|---|---:|---:|---|
| trim（保留 cache） | 332.5 → 331.0（**−1.5 MiB**） | 83,042 | 1 | 20,005 ms，rows=0 |
| trim + 清 cache | 331.8 → 225.1（**−106.7 MiB**） | 83,044 | 0 | 20,005 ms，rows=0 |

- 只裁 live `log` 时几乎不降（1.5 MiB）：event 对象仍被 cache 条目持有；`eventsSnapshot` 清掉只省 0.7 MiB。
- 同时清 cache 后，释放 106.7 MiB；83,044 个事件对应实测 **1,347 B/事件**，新模型估 1,469 B/事件（+9%）。`derived` 为 0，projection cells 没有成为主要隐藏 retainer。
- 但 `seq/eventAt` 立刻失效：重开 20 s、rows=0。**内存上限是真实的，正确性代价也是真实的**；窗口化需要 baseSeq 贯穿 Session/分页/投影/持久化，而不是插件裁数组。

### 10.4 C3：wire 分页对照

沿用上轮 `maxInitialMessages` 0 vs 25：

| 配置 | Host 稳态 heap MiB | 渲染进程稳态 MiB | 行数 |
|---|---:|---:|---:|
| 0 | 333.3 | 188.4 | 100 |
| 25 | 333.7 | 184.5 | 51 |

Host 稳态只差 +0.4 MiB（噪声），渲染进程 −3.9 MiB。**响应窗口不是日志窗口**。

### 10.5 动态结论

1. live Agent 在关页后继续存在；缓存预算淘汰的是 cache 条目，不是 Agent。
2. 真 dispose 单独只能释放 live-only 部分（6.6 MiB）；必须同时清 observation cache 才能释放事件树（121.6 MiB）。
3. detach-only 会留下 zombie，重开导致第二份表示（+104.8 MiB），不可用。
4. 日志窗口化的内存上限与实测 1,347 B/event 同量级（新模型 1,469，+9%），但会破坏 seq/读取/fork；只能上游做 baseSeq。
5. 上游最小可行方向：public idle dispose（带 observer refcount）+ dispose 时清 observation cache；窗口化作为更大的契约变更单独立项。

### 10.6 C2（baseSeq 原型）为什么没有执行

C1 已过门槛（实测 1,347 B/event，新模型 1,469，+9%；`derived=0`），但一个可运行的 `baseSeq`
原型不是插件补丁：需要同时改 `Session`（seq/eventAt/snapshotEvents/append/
SurfaceManager）、`session-query`（observation/paginate）、`session-projection`
（restore/水位）、`session-persistence-jsonl`（tail index）、
`api-session-controller`（分页 baseSeq）、`agent-loop`（fork seed）等 6–8 个包，
并保持同步读 API 的语义。本轮只在隔离副本外做静态设计（§5.2），没有把 dsh
源码 fork 成可运行原型；这是下一轮上游协作的起点，而不是插件能补的洞。

复现本轮动态数据：`tools/runtime-probe/mem-live.mjs`（control / dispose /
dispose --clear-cache / detach / trim / trim --clear-cache）与
`mem-open.mjs --sessions ...`；堆归属用
`analyze-heap.mjs --target session:<id>`。所有运行都在隔离 home，未触碰
`D:\dsh`。

### 10.7 数据形状的外部效度

§10.1–§10.3 的绝对 MiB 和 1,347 B/event 来自 91k/4KB 合成 fixture；liveness/
dispose/detach 的机制结论来自代码路径，不依赖事件大小。真实会话结构差异很大
（本机 6 个样本：events/turn p50 58–272，JSON 2,050–7,784 B/event，tool call
100–4,410，含图片/reasoning/compaction），因此另做了一轮只读真实会话 + 等长
伪文本合成复核：新估算误差 −18%~+14%，真实结构 passive read 在 512 MiB 保留
5 份 665.8 MiB、256 MiB 保留 3 份 352.1 MiB。另按 16 个真实会话的中值生成
230 turn 类真会话（JSON 2,081 B/event、字符串 52/event），5 个生成会话估算误差
−4.6%~+2.3%。细节见 MEASUREMENTS §2.4.1/§2.4.6/§2.4.7。**不要用 91k fixture
的“4 份/2 份”直接外推到不同消息分布的会话。**
