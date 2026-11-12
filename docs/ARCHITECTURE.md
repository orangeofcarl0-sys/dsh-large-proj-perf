# 架构与实现

> **验证边界**：本文对 dsh 内部实现的描述以 **dsh 0.2.2-rc.1** 为准。dsh 每升一个
> 版本，文中的方法名与结构都可能变化——升级后请以 `tests/verify_compat.mjs` 的
> 断言结果和实际 `stats.get` 为准，不要默认本文仍然成立。

本文面向维护者：说明每个能力针对的具体阻塞点、如何探测宿主结构、装上之后改变了
什么、探测失败时会发生什么，以及如何新增一个能力。

性能数字见 [MEASUREMENTS.md](MEASUREMENTS.md)；版本矩阵见
[COMPATIBILITY.md](COMPATIBILITY.md)。

## 1. 问题分类

大会话的代价可以分成四侧：

| 侧 | 环节 | 症状 |
|---|---|---|
| **写入** | `Session` 构造时逐事件 `snapshotJsonValue` + `deepFreeze`；`encodeMaterialization` 把整个 seed 拼成一个字符串 | fork 与落盘都要复制/序列化全部事件 |
| **读取** | 打开时把 18 MB zstd 变成内存事件数组；再对 29 个投影单元逐个 `def.apply` 折叠全部事件 | 首次打开 21 秒（实测，见 MEASUREMENTS §1） |
| **驻留** | 三处事件缓存都按「会话条数」限容，不按字节 | 6 个 18 MB 会话 → 1.2 GB RSS（实测，见 MEASUREMENTS §2） |
| **渲染** | 浏览器拿到窗口后**全量挂载**（上游没有虚拟滚动），且投影快照里装着全部 turn | 打开 7.4 秒到首行；批量翻页可达秒级阻塞（见 RENDER-ANALYSIS） |

对应的能力：

| 侧 | 能力 | 实测效果 |
|---|---|---|
| 读取 | `fastTurnOutline` | 冷读 21.2 s → 3.0 s |
| 驻留 | `memoryBudget` | 稳态 RSS 1324 MB → 690 MB |
| 渲染 | `clientContainment`（浏览器侧） | 批量翻页阻塞 2836 → 1489 ms |
| 渲染 | `renderTiming`（诊断） | 首行/稳定/长任务 + 服务端每页耗时与字节 |
| 写入 | 零拷贝 fork | 直测 -16% ~ -21%（但 UI 不走这条路） |
| 写入 | `chunkedMaterialize` | 帧数 2 → 6，字节不变 |
| 读取 | `coldWriteBack` | 无耗时收益，默认关 |

## 2. 装配契约：`deps` 与 `runtime`

所有模块的入口是 `install(deps)` 或 `createXxx(deps)`。`deps` 由
`lib/context.js` 的 `createDeps()` 构造，**构造时全部就绪且 `Object.freeze`**：

```js
// lib/context.js
createDeps({ ctx, config, stats, log, logErr, disposers,
             safeGet, sessionEventsOf, sessionLogOffset,
             cacheIdentityOf, yieldLoop, setConfigValue,
             setPatchStatus, recordFork })
```

约定：

- **`disposers`**：模块把还原动作 push 进来，`apply` 返回的函数按**逆序**执行并逐个
  try-catch。
- **`setPatchStatus(key, status)`**：写入 `stats.patches[key]`，这是 `stats.get` 里
  `patches` 字段的唯一来源。
- **`safeGet(ctx, name)`**：包一层 try。cordis 下取不存在的服务会抛，直接 `ctx.get`
  会让整个 `apply` 中断。
- **懒装配**：`sessionPersistence` / `webServer` / `sessionProjections` /
  `sessionQuery` / `sessionProjectionCache` 都不是启动即就绪的。`apply` 用
  `ctx.inject([...], cb)` 等它们出现；回调里把 `deps.ctx` 换成子上下文
  （`withCtx(deps, sub)`），其余字段原样复用。

### `runtime`：为什么需要第二级

`deps` 是只读的，但有一类东西**在装配时还不存在**：`backfill` 句柄由
`index.js` 在 `setTimeout` 之后创建，而 `api.js` 的 `config.set` 要用它判断
「启动定时器是否已触发」。

如果 `api.js` 在 `installApi` 时解构它，拿到的是 `undefined` 且永不更新——这正是
v1.9.0 及之前的一个真实 bug：**打开 `backfillOnBoot` 不会补跑扫描**。
（`installApi` 走 `ctx.inject(['webServer'])`，webServer 早于 backfill 创建。）

所以分成两级：

| 对象 | 何时就绪 | 谁能用 | 用法 |
|---|---|---|---|
| `deps` | 构造时 | 所有模块 | 直接解构 |
| `runtime` | 运行期逐步登记 | **只有 `api.js`** | **每次用时** `runtime.backfill.get()` |

**新增模块时只拿 `deps`。** 如果确实需要晚绑定的东西，说明它依赖了运行期才出现的
状态——把该状态登记进 `runtime`，并在使用时取值，绝不在装配时解构。

## 3. 四个补丁

每个补丁遵循同一套模式：**探测 → 安装 → 失败即跳过并上报状态**。没有任何补丁会在
特征不符时强行 patch。方法替换统一走 `lib/patch-target.js` 的 `wrapMethod`
（见 §5）。

### 3.1 零拷贝 fork

**patch 什么**：`SessionStore.prototype.fork(source, boundary, childSessionId)`。

**为什么能省**：原生 fork 把源会话的事件逐个 `snapshotJsonValue` 深拷贝再
`deepFreeze`。但 live 事件在 append 时已 `deepFreeze`，可以走 `SessionStore` 的
`eventState: 'shared-frozen'` 通道（`Session.fromRestore`）直接复用引用。

**探测条件**（三协议，按优先序自动选择）：

| 标签（日志原样输出） | 依据 |
|---|---|
| `0.1.7 forkSeed` | 模块导出 `buildForkSeed` + 原型有 `_forkBoundary` / `_resolveForkSource` |
| `0.1.3 eventState` | 原型有 `_forkSeed` + `prepare` 源码含 `eventState` |
| `alpha.5 seedSource` | `prepare` 源码含 `seedSource` 与 `persistence` |
| `unknown` | 都不匹配——补丁仍装上，但每次 fork 走 `capable=false` 分支 |

**与原生对齐**：0.2.2 起原生 fork 不再给子会话写 `parentSession`，补丁必须与同版本
原生行为一致。实现按原生源码探测 `nativeSetsParentSession`，两代都对。

**探测失败**：`SessionStore.fork` 不存在 → `inactive`；`sessions` 服务缺失 →
`inactive`；运行期抛错 → 打日志并回退原生（计入 `stats.fallbacks`）。

**已知局限**：dsh 0.2.2 的服务端 `session/fork` RPC 不再调用这个方法，改为自建
`buildForkSeed` 后走 `agents.create({seed})`。所以本补丁在 Web UI 的分支会话链路上
**从未被调用**（实测 `stats.forks = 0`）。直测（`debugApi` 暴露的 `debug.fork`）
仍有 -16% ~ -21% 的收益。

### 3.2 分片 materialize

**patch 什么**：`persistence.encodeMaterialization(...)`。

**为什么能省**：上游把整个 `events` 拼成一个 body 字符串再压成一个 zstd frame。
事件量极大时单个字符串会触及 V8 上限（`RangeError`）。补丁改成每
`materializeChunkEvents` 个事件一个 frame——多帧是解码端 `scanZstdFrames` 的
原生格式，字节兼容。

**形态探测**：

| 形态 | 签名特征 |
|---|---|
| 0.1.3+（`isNew`） | `encodeMaterialization(meta, inheritedEventCount, events)` + `const body = eventLines(events)` |
| legacy | `eventLines(events, this.packChunks)` + `compressZstdFrame` |

0.1.3 分支的头帧直接复用原方法（`events.length === 0` 时只产 header 帧，编码器归
上游），不重写。

**探测失败**：方法不存在 → `inactive`；签名不匹配 → 打 `signature mismatch` 日志 +
`inactive`。

**实测边界**：只改变帧数（2 → 6），不改变字节总数与耗时。它解决的是内存峰值与
`RangeError`，不是吞吐。

### 3.3 turnOutline 折叠加速

**patch 什么**：`registry.registrations.get('turnOutline').def.apply` 与 `.def.init`。

**为什么能省**：上游 `apply` 每次 `turn/start` 执行 `turns: [...state.turns, next]`、
每次 `user/message` / `turn/end` 执行 `turns: [...state.turns.slice(0, -1), fixed]`
——整数组复制，N 个 turn 是 O(N²)。实测 2 万 turn 时比线性实现慢 701 倍，占整个
冷读的 76%。

**语义等价的硬要求**：这是替换投影语义，任何一个字段与上游不同都会让同一会话在
不同路径下渲染出不同 outline，并把差异写进缓存行。三层保证：

1. `preview` 逐字复刻上游（`limit*2` 提前截断、空白压缩、省略号；prompt 50 /
   response 120）；
2. fold 逐 case 复刻（turn 号不递增则忽略、只取第一条 user 消息、空白 prompt 不
   写入、assistant draft 覆盖、`turn/end` 提交）；
3. **安装前跑运行时等价探针**：15 条覆盖全部分支的合成事件流，分别跑上游 `apply`
   与我们的 fold，`JSON.stringify` 结果必须相等，否则 `inactive` 并打日志。

> 为什么用运行时探针而不是源码特征串：投影注册表把 `definition.apply` 包成了
> `(state, event) => definition.apply(state, event)`，**拿不到原始源码**。

另外 `init` 必须返回**新的**可变状态——上游 `init` 返回模块级共享的 `EMPTY_OUTLINE`
常量，原地改它会污染所有会话。

### 3.4 事件缓存字节预算

**patch 什么**：两处

| 目标 | 手法 |
|---|---|
| `sessionQuery._observations.store` | 包装实例方法，每次插入后按估算字节总量淘汰 |
| `persistence` 原型的 `decodeStoredLog` | 包装原型方法，decompress 完成后裁剪 `coldLogMemo` |

**为什么需要**：上游的淘汰判据只有 `cache.size <= cacheCapacity`——只看条数。实测
6 个 18 MB 会话 → 1.2 GB RSS。

**估算**：`events.length × 400 B`（实测 365 B/事件，留余量）。目的不是精确，是区分
「5 个大会话」与「5 个小会话」。

**安全判据**：只删 `refs === 0`（未被 lease 钉住）的条目，与上游
`evictPastCapacity` 同一判据。全部被 pin 时允许暂时超预算并计入
`stats.memoryBudgetOverBudget`。

**观测**：`stats.memoryBudget = { budgetBytes, cachedEntries, estimatedBytes }`。

**探测失败**：`sessionQuery._observations.cache` 不可达（上游改了私有字段名）→
`inactive`，不做任何猜测。

### 3.5 渲染链路：诊断、窗口预算、客户端 containment

浏览器侧的完整分析见 [RENDER-ANALYSIS.md](RENDER-ANALYSIS.md)。实现分三块：

**`lib/render-timing.js`（诊断，默认关）**
包装两个点：`sessionProjections.snapshot`（同步热路径，记录耗时与单元数）与
`sessionController` 内部 `webController.follow` / `historyController.events`
（记录首帧耗时、事件数、序列化字节、`hasMore`）。写进
`stats.render.{snapshotCount, snapshotMs, snapshotMaxMs, lastUnits, pages[]}`。

> **为什么能包装内部对象**：`sessionController` 是 cordis 服务，其构造函数把
> `historyController` / `webController` 放在实例上（`dsh-api-session-controller`
> `src/index.ts:208-210`）。二者都是普通对象，直接替换方法即可；这与
> `memory-budget.js` 摸 `sessionQuery._observations` 是同一类做法，都带能力探测。

**`lib/history-budget.js`（默认关）**
`maxInitialMessages`（消息上限，**同时压 `turnWindow.minMessages`**）与
`maxPageBytes`（按 JSON 长度估算，超限时下调 `maxMessages` 重算，最多 3 次）。
只改请求参数，不改分页语义；`hasMore` 仍由上游按实际切页位置计算。

> 实测教训：客户端请求 `maxMessages: 500`，但 `paginate` 在「≥50 条消息且跨过
> ≥2 个 turn」时就切页，所以短 turn 会话的真实首屏是 ~50 条。**只压
> maxMessages 对这种会话完全无效**（150 与 500 产出同样的 231 个事件）。

**`lib/client.js`（浏览器端，受 config 控制）**
dsh 的客户端模块表按「经典脚本 + 惰性工厂」加载：`package.json` 声明
`dsh.client = { platform: 'web' }` 与 `exports["./client"]`，文件形如
`window.__ModuleLoader__.load({ id, factory })`（与官方 decoration 模板一致，无需构建）。

- `clientContainment`（默认开）：行数 >80 时在 flow 容器上打
  `data-dsh-perf-dense`，CSS 给第 30 行之后的离屏行加
  `content-visibility: auto; contain-intrinsic-size: auto 120px`。
- `renderTiming`（默认关）：`PerformanceObserver` 收
  `long-animation-frame` / `longtask`，`MutationObserver` 盯 flow 行数，
  回传「导航 → 首行 / 稳定 / 长任务 / 堆」到 `perf.report`。

**硬约束**：`exports["./client"]` 指向的文件缺失会让整个 `clientModules`
服务**启动失败**（不是降级）。`tests/verify_compat.mjs` 有断言同时检查声明、
文件存在与包名 id，缺一不可。

## 4. 非补丁：运行时检查与默认关的能力

### 4.1 heap 上限告警（不是补丁）

`lib/index.js` 在 `apply` 时读一次 `getHeapStatistics().heap_size_limit`，低于
`heapWarnBytes`（默认 6 GiB）打告警。它不在 `stats.patches` 里——不是补丁，没有
install / dispose 生命周期。

### 4.2 冷读回写（默认关）

包装 `sessionProjectionCache.hydratePrepared`，冷读后把已折好的状态写成缓存行。

**实测无耗时收益**（有行 19.1 s vs 无行 18.9 s，见 MEASUREMENTS 附录 A.2）。
保留原因只有一条：让 dsh 自己的列表读（`cachedSnapshot`，零 I/O）看到更新数据。
默认关，因为每次要写约 10 MB。

### 4.3 冷会话补行（默认关）

`lib/backfill.js`：启动 15 秒后扫描磁盘上的大会话，把缺失或陈旧的投影缓存行补上。
解码按 zstd frame 逐帧异步 + 帧间让出，折叠按 `chunkSize` 让出。默认关——它仍是
「读全量日志 + 折全部单元」的重活。

## 5. 补丁基础设施

### 5.1 `wrapMethod`：统一的方法替换样板

`lib/patch-target.js` 提供三个原语：

| 原语 | 作用 |
|---|---|
| `resolveMethod(target, name)` | 取原始方法并判断它来自原型还是自有属性 |
| `wrapMethod(target, name, factory, disposers)` | 替换 + 登记还原 |
| `sourceOf(target, name)` | 取「真实源码」用于特征校验 |

**还原语义**（这是三处补丁此前若不一致就会出错的地方）：

- 原始方法来自**原型**（真实 dsh 服务）→ `delete` 自有属性，让方法回落原型。
  不 delete 会在实例上留副本，遮蔽原型，上游热更新失效。
- 原始方法是**自有属性**（测试 mock、自定义后端）→ 写回原函数。

`sourceOf` 处理的是 cordis 的 Proxy：`ctx.get(name)` 返回的方法被 bind 过，
`String()` 得到 `function () { [native code] }`，特征校验会永远失败。必须沿原型链
取未 bind 的那一份。

### 5.2 三层回退

任一层不满足都不会破坏上游行为：

1. **能力探测**——依赖的方法/导出不存在就跳过；
2. **源码特征校验**（或运行时等价探针）——不匹配就跳过，状态置 `inactive`；
3. **运行时兜底**——补丁抛错时回退原实现（零拷贝 fork 计入 `stats.fallbacks`）。

### 5.3 补丁状态

`stats.patches[key]` 的取值：

| 值 | 含义 |
|---|---|
| `active` | 已安装（**不代表本轮被调用**） |
| `inactive` | 环境缺失 / 特征漂移，自动跳过 |
| `off` | 被配置显式关闭 |
| `retired` | 上游已原生实现该能力，补丁主动退役 |

**`retired` 当前没有使用者**：v1.10.0 移除了唯一会设置它的 `fastInitFor`。保留这个
值是因为它是「上游吸收能力后补丁让位」这一语义的唯一表达；如果长期无人使用，可以在
未来的大版本里删掉。

## 6. 如何新增一个能力

1. 在 `lib/` 建模块，导出 `install(deps)` 或 `createXxx(deps)`。
2. 开头读 `deps.config.<你的开关>`，关闭时 `setPatchStatus(key, 'off')` 后 return。
3. 取服务用 `deps.safeGet(deps.ctx, name)`，不要直接 `ctx.get`。
4. 需要替换方法时用 `wrapMethod`，不要手写「判断自身属性 + 替换 + 还原」。
5. 特征校验用 `sourceOf`；如果拿不到原始源码（例如被包装了一层），改用运行时
   等价探针——参考 `fast-turn-outline.js` 的 `buildEquivalenceProbe`。
6. 每一条「跳过」分支都要 `setPatchStatus(key, 'inactive')` 并打日志说明原因。
   静默跳过是最难排查的故障。
7. 新配置键进 `lib/config.js` 的 `DEFAULT_CONFIG`；数值项同时进 `CONFIG_MIN`
   （防止 `0` 或负数导致死循环 / 清空缓存）。
8. 测试：`tests/verify_compat.mjs` 加宿主特征断言（上游结构还在吗），
   `tests/e2e_real_components.mjs` 加行为断言（装上后行为对吗），
   必要时新增独立套件（逻辑/边界）。跑 `npm test` 并把断言数记进 CHANGELOG。
9. 如果能在真实进程里测出数字，写进 [MEASUREMENTS.md](MEASUREMENTS.md) 并标明
   测量条件与边界。

## 7. 代码结构

```
lib/index.js              编排层：版本探针/补丁装配/定时器/生命周期
lib/context.js            装配契约：deps（冻结、只读）与 runtime（晚绑定槽）
lib/runtime.js            dsh 兼容垫片：日志、safeGet、sessionEventsOf、版本探针
lib/yield.js              分片遍历之间的让出原语
lib/constants.js          跨模块共享的具名常量
lib/config.js             默认值、下限钳制、settings 注册、环境变量覆盖
lib/stats.js              统计与补丁生命周期状态
lib/api.js                HTTP 端点（回环 + 同源校验）
lib/cache-identity.js     投影缓存行 identity 的唯一构造器
lib/patch-target.js       方法替换样板：resolveMethod / wrapMethod / sourceOf
lib/patches/zero-copy-fork.js      零拷贝 fork
lib/patches/chunked-materialize.js 分片 materialize
lib/fast-turn-outline.js           turnOutline 折叠加速
lib/memory-budget.js               事件缓存字节预算
lib/render-timing.js               渲染链路计时（服务端分页/投影 + 浏览器样本）
lib/history-budget.js              首屏消息上限与单页字节上限（默认关）
lib/client.js                      浏览器端：离屏行 containment + 渲染计时采集
lib/backfill.js                    磁盘冷会话补行（默认关）
lib/cold-writeback.js              冷读回写（默认关）
tests/                    不随 npm 包发布
tools/                    开发者脚本，不随包发布
```

### 投影缓存行的 identity 契约

读写缓存行时必须与上游 `identityOf` 构造同一个键。真实形状
（`dsh-session-projection-cache`）：

```js
// lifecycleIdentityOf(header)
{
  formatVersion: header.version,   // 第一位
  createdAt: header.createdAt,
  ...header.cwd === void 0 ? {} : { cwd: header.cwd },   // 条件展开
  isSeeded: header.isSeeded,
}
// identityOf(header, inheritedEventCount) 再追加
{ ..., inheritedEventCount: SessionLogOffset(inheritedEventCount) }
```

三个陷阱：`formatVersion` 必须在首位（字段顺序无关但语义上它是格式代的第一 witness）；
`cwd` 缺失时必须**整键省略**，不能写成 `cwd: undefined`；`isSeeded` 是**无条件**写入
（缺失按 `false`）。

`lib/cache-identity.js` 是唯一构造器（v1.10.0 起），`backfill.js` 与
`cold-writeback.js` 都用它——此前两处各抄一份，字段一漂移行就永久失配且静默回退全量
重折。

## 8. 依赖声明

| 包 | 声明位置 | 理由 |
|---|---|---|
| `@deepseek-ai/cordis` | `peerDependencies`（`~4.1.0`） | 宿主提供的单例运行时。官方 `dsh-app-boot` / `dsh-web-app` / `dsh-session-projection` / `dsh-plugin-manager` 全部这样声明。`lib/` 不 import 它并不意味着可以省略——它是插件所处的运行时契约 |
| `@deepseek-ai/schemastery` | `dependencies`（`^3.19.0`） | `lib/config.js` 顶层 `await import()` 的普通运行时依赖。官方 `dsh-plugin-manager` 同样放在 `dependencies` |

`schemastery` 漏声明时的后果不是崩溃，而是**静默降级**：`config.js` 里
`try { schemaLib = await import(...) } catch { schemaLib = null }` 会吞掉失败，
`registerSettings` 见 `schemaLib` 为空就直接 return——配置仍按默认值生效，但不再经
settings 持久化。用户改了配置却发现重启后丢失，是最难排查的一类问题。
`tests/verify_compat.mjs` 有断言锁住这两个声明。
