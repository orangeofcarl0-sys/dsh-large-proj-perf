# 架构与实现

> **验证边界**：本文对 dsh 内部实现的描述以 **dsh 0.2.2-rc.1** 为准。dsh 每升一个
> 版本，文中的方法名与结构都可能变化——升级后请以 `tests/verify_compat.mjs` 的
> 断言结果和实际启动日志为准，不要默认本文仍然成立。

本文面向维护者：说明每个补丁针对的具体阻塞点、如何探测宿主结构、装上之后改变了
什么，以及探测失败时会发生什么。

## 四类阻塞

`lib/index.js` 的模块头把它们编号为 A/B/C/D：

| 类别 | 环节 | 症状 |
|---|---|---|
| **A. fork 深拷贝** | `Session` 构造器逐事件 `snapshotJsonValue`；旧版 persistence 的 `initFor` 还会 `structuredClone(seed)` | fork 一个大会话要把全部事件深拷贝一遍 |
| **B. 投影冷折叠** | `cellFor()` 首次读取时同步 `buildCell` 全量折叠整个日志 | 打开历史大会话时主线程被占满 |
| **C. 落盘全量序列化** | `encodeMaterialization` 把整个 seed 拼成一个字符串 | 事件量极大时单个字符串超出 V8 上限 |
| **D. 冷会话内存驻留** | 准备缓存保留多份完整冷会话事件树 | 多份叠加触发 OOM |

A 和 C 在**写入**侧，B 在**读取**侧，D 在**驻留**侧。

## 装配契约

理解补丁的前提是理解编排层如何把它们接起来（`lib/index.js`）。

`apply(ctx)` 构造一个共享对象 `pc`，传给每个补丁的 `install(pc, ictx?)`：

```js
const pc = {
  ctx, config, stats, log, logErr, disposers,
  safeGet, sessionEventsOf, sessionLogOffset,   // 读宿主的工具函数
  yieldLoop, setPatchStatus, recordFork, recordWarm, setConfigValue,
}
```

约定：

- **`disposers`**：补丁把自己需要的还原动作 push 进来，`apply` 返回的函数按**逆序**
  执行，并逐个 try-catch。
- **`setPatchStatus(key, status)`**：写入 `stats.patches[key]`，这是 `stats.get` 里
  `patches` 字段的唯一来源。
- **`safeGet(ctx, name)`**：包一层 try。cordis 下取不存在的服务会抛，直接 `ctx.get`
  会让整个 `apply` 中断。
- **懒装配**：`sessionPersistence` 与 `webServer` 不是启动即就绪的服务。`apply` 用
  `ctx.inject(['sessionPersistence'], cb)` 等它出现后再装持久化侧补丁，用
  `ctx.inject(['webServer'], cb)` 装 HTTP 端点。这就是为什么 `installFastInitFor` /
  `installPreparedCacheTrim` / `installChunkedMaterialize` 接收 `ictx`（子上下文），
  而 `installZeroCopyFork` 直接用根 `ctx`（`sessions` 在 `inject` 里已声明为必需）。

## 四个补丁

每个补丁遵循同一套模式：**探测 → 安装 → 失败即跳过并上报状态**。没有任何补丁会在
特征不符时强行 patch。

### 1. 零拷贝 fork（问题 A）

- **patch 什么**：`SessionStore.prototype.fork`。
- **为什么能省**：fork 的 seed 来自 live 会话的 `snapshotEvents()`，这些事件在 append
  时已被 `deepFreeze`。原生 fork 会把它们重新深拷贝一遍；补丁改走 fromRestore 通道，
  直接复用这些不可变对象的引用。
- **探测条件**（按优先级，`lib/patches/zero-copy-fork.js`）：

  | 协议标签（日志原样输出） | 判定条件 |
  |---|---|
  | `0.1.7 forkSeed` | `dsh-session` 导出 `buildForkSeed`，且原型上有 `_forkBoundary`、`_resolveForkSource`、`create` |
  | `0.1.3 eventState` | 无 `buildForkSeed`，但有 `create`、`_forkSeed`，且 `prepare` 源码含 `eventState` |
  | `alpha.5 seedSource` | 上述都不成立，但 `prepare` 源码含 `seedSource` 与 `persistence` |
  | `unknown` | 全不成立 → 不安装补丁 |

- **装上之后**：用原生 helper 构造 seed（`buildForkSeed` 新建的 marker 与 turn 闭合
  事件未冻结，补丁原地补齐冻结），然后走 `create(id, { seed, eventState: 'shared-frozen' })`。
- **与原生行为对齐**：`parentSession` 是否写入子会话 header 取决于原生 fork 是否写。
  0.1.7–0.2.1 原生会写，0.2.2 起不写。补丁按 `String(originalFork)` 探测
  （`nativeSetsParentSession`），两代都产出与原生一致的 header——否则同一 dsh 版本
  上「走零拷贝」与「回退原生」的 header 会不同。
- **失败时**：`catch` 里回退调用原生 `fork`，并把该次 fork 记为
  `path: 'native-fallback'`（计入 `stats.fallbacks`）。服务缺失时直接跳过，状态
  `inactive`。

### 2. 分片投影预热（问题 B）

- **patch 什么**：不 patch 方法，而是订阅 `session/created`，在事件数超过 `minEvents`
  时主动把投影单元折出来写进 `registry.registrations.get(key).cells`。
- **为什么能省**：上游的 `cellFor()` 在 cell 缺失时同步折叠整个日志。预热抢在第一次
  读取之前把 cell 建好并分片让出事件循环，后续 `snapshot()` / `drive()` 直接命中。
- **探测条件**：`ctx.sessionProjections` 存在且暴露 `cellFor` / `buildCell` /
  `registrations`。缺任何一个即 `inactive` 并打日志。
- **cell 形状必须与上游 `buildCell` 一致**：

  ```js
  { state, observedSeq, views: [undefined, undefined] }
  ```

  且初始化必须调用 `def.init(header, inheritedEventCount)`。这两点都是硬性要求：
  缺 `views` 会让下一条事件经 `drive()` 时抛 `TypeError`；无参调用 `init()` 会让所有
  从 header 取值的投影（`agentPreset`、`workingDirectory`、`agentTeam` 等）抛错。
  两者都有回归断言守护。
- **0.2.2 起**：`registrations` 会保留已释放（`refs === 0`）的 key，这类单元不再被
  drive / snapshot / restore 读取，预热时会跳过。
- **缓存基线**：有投影缓存行时以它为起点跳过已折叠前缀。identity 键必须与上游
  `identityOf` 完全一致（见下）。
- **fork 缓存回填**：预热完成后，如果会话带继承前缀（`parentSession` 存在，或
  `inheritedEventCount > 0`），立即回填投影缓存行——否则该子会话被放弃后永远没有
  缓存行，下次打开会走全量读。

### 3. 分片 materialize（问题 C）

- **patch 什么**：`sessionPersistence.encodeMaterialization(meta, inheritedEventCount, events)`。
- **为什么能省**：上游把整个 `events` 拼成一个 body 字符串再压成一个 zstd frame；
  事件量大时这个字符串本身就超限。补丁改成每 `materializeChunkEvents` 个事件一个
  frame。多帧是解码端 `scanZstdFrames` 已支持的格式，字节兼容。
- **探测条件**：源码含 `encodeMaterialization(meta, inheritedEventCount, events)` 与
  `const body = eventLines(events)`（新形态），或含 `eventLines(events, this.packChunks)`
  与 `compressZstdFrame`（旧形态）。都不匹配即 `inactive`。
- **头帧**：新形态直接调用原方法并传空事件数组（`await original(meta, inheritedEventCount, [])`
  ——上游在 `events.length === 0` 时只产 header 帧），不重写编码器。旧形态则按 alpha.5
  的 `toHeaderLine` 复刻。
- **还原**：dispose 时按原形状还原——原型方法就 `delete` 自有属性回落，自有属性
  （测试 mock）则写回原值。

### 4. 冷会话 LRU 裁剪（问题 D）

- **patch 什么**：`sessionPersistence.coordinator.preparations.capacity`。
- **为什么能省**：把容量从官方默认降到 `preparedCacheSize`（默认 1）并主动淘汰最旧的
  ready 条目。
- **探测条件**：`persistence.coordinator.preparations.entries` 存在。0.1.3 起上游移除了
  `PersistenceCoordinator`，因此该补丁在新版上恒为 `inactive`——这是预期行为，不是故障。
- **`config.set`**：改 `preparedCacheSize` 会重跑裁剪；dispose 恢复原 capacity（已淘汰
  的条目不复活）。

### 5. fast initFor（问题 A 的 persistence 侧）

- **patch 什么**：旧版 `coordinator.initFor` 里的 `structuredClone(seed)`。
- **探测条件**：`coordinator.initFor` 源码含 `structuredClone(e)`。
- **退役**：源码含 `const seed = session.events` 或 `session.snapshotEvents()` 说明上游
  已原生零拷贝，补丁置 `retired` 并跳过。这是本插件唯一会走到 `retired` 的补丁。

## 运行时检查（不是补丁）

heap 上限检查写在 `lib/index.js` 里，不 patch 任何方法，也不进 `stats.patches`：

- 读 `v8.getHeapStatistics().heap_size_limit`，低于 `heapWarnBytes`（默认 6 GiB）时
  打 WARNING，并给出 `--max-old-space-size` 的具体建议。
- 不会尝试修改上限——那是启动期参数。

## 加载侧：上游已做的与插件补的

长会话「打开」的成本分四段。前两段上游已自行优化，插件不介入：

| 阶段 | 上游现状（0.2.2-rc.1） | 插件是否介入 |
|---|---|---|
| 磁盘解码 | 增量扫描 + 逐帧 zstd 解码，按 `ZSTD_DECODE_YIELD_INTERVAL_MS`（500ms）让出 | 否 |
| 历史格式迁移 | **主线程** `decodeStreamingMigration`，按 `MIGRATION_DECODE_YIELD_INTERVAL_MS`（500ms）让出；Worker 仅用于 `verifyCurrentGenerationInWorker` **校验**已发布的世代 | 否 |
| 投影折叠 | `cellFor` 冷时同步全量 `buildCell` | **是**：分片预热 + 缓存基线 |
| 落盘编码 | `encodeMaterialization` 单 body 帧 | **是**：分片 zstd 多帧 |

注意迁移是主线程完成的，两个 yield 常量也各不相同——不要把「Worker」和「迁移」关联
起来。

### 投影缓存行的 identity 契约

插件读写缓存行时必须与上游 `identityOf` 构造同一个键。真实形状
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

两个易错点：`formatVersion` 缺失或不等时上游**不会**把它当折叠短路（只能当 title
前驱提示）；`cwd` 是全有或全无，不能写成 `cwd: undefined`。`lib/warmup.js` 与
`lib/backfill.js` 都按此构造，并有回归断言。

## 安全性与回退

**共享冻结引用不改变语义**：事件进入源会话时已完整校验并 `deepFreeze`，fork 的 seed
只是复用这些不可变对象，与深拷贝等价。

三层回退，任一层不满足都不会破坏上游行为：

1. **能力探测**——依赖的方法/导出不存在就跳过；
2. **源码特征校验**——`String(原型方法)` 不含特征字面量就跳过，日志打
   `signature mismatch`，状态置 `inactive`；
3. **运行时兜底**——零拷贝 fork 抛错时回退原生实现，计入 `stats.fallbacks`。

所有补丁都在 dispose 时还原。注意还原方式并不完全统一：`chunked-materialize`
区分「自有属性」与「原型方法」两种情形分别还原，`fast-init-for` 则是直接
`delete coordinator.initFor`（不保留原值）。新增补丁时请按前者的写法。

## 如何新增一个补丁

1. 在 `lib/patches/` 建模块，导出 `install(pc, ictx?)`。
2. 开头读 `config.<你的开关>`，关闭时 `setPatchStatus(key, 'off')` 后 return。
3. 取服务用 `pc.safeGet(actx, name)`，不要直接 `actx.get`。
4. 取原型方法做特征校验用 `Object.getPrototypeOf(obj)?.method`；cordis 的 Proxy 会把
   实例方法包成 `[native code]`，字符串校验会永远失败。
5. 每一条「跳过」分支都要 `setPatchStatus(key, 'inactive')` 并打日志说明原因——静默
   跳过是最难排查的故障。
6. 把还原动作 push 进 `pc.disposers`。
7. 在 `lib/config.js` 加开关与默认值，在 `tests/verify_compat.mjs` 加对应的宿主特征
   断言，在 `tests/e2e_real_components.mjs` 加行为断言。

## 代码结构

```
lib/index.js            编排层：配置/统计/日志/版本探针/补丁安装/定时器/装配契约
lib/runtime.js          日志、safeGet、sessionEventsOf、sessionLogOffset、版本探针
lib/config.js           默认值、下限钳制、settings schema 注册
lib/stats.js            统计与补丁生命周期状态
lib/api.js              stats/config HTTP 端点（回环 + 同源校验）
lib/warmup.js           分片投影预热 + fork 缓存回填
lib/backfill.js         磁盘冷会话补行（readRaw 优先，缺失时直读文件）
lib/patches/*.js        四个补丁
tests/                  不随 npm 包发布；见 README「开发」
tools/                  开发者脚本，不随包发布
```

## 已知的清单问题

以下两处 `package.json` 问题已知，但改 manifest 会影响版本门禁行为，因此单独决策：

- `@deepseek-ai/cordis` 声明为 `peerDependencies`，但 `lib/` 里没有任何 import，只有
  `tests/` 用到。严格按「运行时真实依赖」的标准，它不该出现。
- `lib/config.js` 顶层 `await import('@deepseek-ai/schemastery')`，但该包既不在
  `dependencies` 也不在 `peerDependencies`，目前依赖 dsh 的嵌套安装找到它。
