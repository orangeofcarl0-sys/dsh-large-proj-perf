# 兼容性与插件规范

> **验证边界**：本文的实测结论以 **dsh 0.2.2-rc.1** 为基准。版本矩阵里每一行的
> 结论来自该版本发布时对关键包源码的逐字节比对，不是对未来的预测。

本文面向维护者：记录各 dsh 版本对插件作用点的影响、破坏性变更、两个容易混淆的
版本语义，以及插件清单规范。

## 两个版本的区分

这是本插件最容易误读的地方，先说清楚：

| 概念 | 位置 | 含义 |
|---|---|---|
| **声明范围（允许）** | `package.json` 的 `engines.dsh` | `>=0.1.0-rc.6 <0.3.0-0`。dsh 的加载门禁只读这一项；范围内就允许加载 |
| **实测验证过** | `lib/runtime.js` 的 `KNOWN_runtime_VERSIONS` | 逐个版本跑过全量测试的清单。不在其中不会阻止加载，但会在启动时打 WARNING |
| **门禁拒绝** | 同上 `engines.dsh` | 超出声明范围 → 日志 `skipping profile bundle`，插件不加载 |

三者不是一回事。升级 dsh 到 0.3.x 时门禁会拒绝——那时必须先更新 `engines.dsh`，
再补充实测。

## 版本矩阵

按时间顺序，记录每个版本对插件作用点的影响。

| dsh 版本 | 形态与影响 |
|---|---|
| 0.1.0-rc.6 / rc.7 / rc.8 | fork 走 `prepare(seedSource)` 通道；`initFor` 含 `structuredClone`。rc.8 起上游原生零拷贝，本插件的 fast initFor 随之退役 |
| 0.1.1-rc.1 / rc.2 | 同 alpha.5 形态；rc.2 的 `encodeMaterialization` 是 `(meta, events)` 裸 meta 签名 |
| 0.1.2-alpha.5 / 0.1.2-rc.1 | 新增 `snapshotEvents()`；fork meta 带 `isSeeded` + `inheritedEventCount`；签名变 `(storage, events)` |
| 0.1.3-alpha.2 | **persistence 子系统重写**（见下节）；投影缓存 identity 新增 `formatVersion` |
| 0.1.5-alpha.1 | 会话格式 **v3**（`SESSION_FORMAT_VERSION=3`）；cut/header 语义同 v2，文件名 `session.v3.jsonl` |
| 0.1.5-rc.1 / rc.2 | 仅新增已知事件类型与版本号，作用点零变化 |
| 0.1.7-rc.1 / rc.2 | fork 内部重构：`_forkSeed` → `_forkBoundary` + 模块级 `buildForkSeed`；open-turn 边界从「拒绝」改为「注入 turn 闭合事件」；会话格式升 **v4**；事件词汇收紧 |
| 0.2.0-rc.2 | 插件管理引入严格 peer 门禁；`dsh-session` 重构 tail-repair 并新增 `ToolCallRecovery`（`buildForkSeed` / `SESSION_FORMAT_VERSION` 导出不变）；`llm-deepseek` 拆分为 `-api-key` / `-account` |
| 0.2.1-rc.1 | 门禁新增 `engines.dsh` 且**独占生效**；jsonl 后端改为 cordis 插件形态（只导出 `name`/`apply`/`Config`）；persistence 改为 `ctx.effect` 生命周期 + `listConcurrency` 限流；投影 `register()` 改为返回 effect |
| 0.2.1-rc.2 ~ rc.5 | **纯版本刷新**。关键包源码与 rc.1/rc.3 逐字节一致，作用点零影响 |
| 0.2.2-rc.1 | **四处收紧**（见下节）。这是 0.2.x 线上第一个需要改插件代码的版本 |

**未验证的版本**：`0.1.3` 正式版、`0.1.4`、`0.1.6` 没有实测。它们夹在两个已验证版本
之间，且相邻版本的 persistence / fork 结构未再变化，预期不构成风险；真遇到时跑
`node tests/verify_compat.mjs` 确认。

## 0.1.3-alpha.2：persistence 重写

破坏面最大的一次，四个作用点全部需要重新适配：

- `dsh-session-persistence` 变为 contract 层（`SessionPersistence` 基类 + 错误 +
  校验），`PersistenceCoordinator` / `initFor` / `SessionPreparations` 移除；JSONL
  实现移入 `dsh-session-persistence-jsonl`。
- 格式 v0→v1→v2 迁移链；物理 header 移除 `seedLength`，seed cut 改由事件流尾
  `session/end-seed {inherited:true}` marker 表达（`cut == marker.seq`）；文件名变
  `session.vN.jsonl[.zstd]`。
- `encodeMaterialization(meta, events)` → `(meta, inheritedEventCount, events)`。
- 事件词汇收紧：`assistant/message` 需 `data.stream`，消息需 `id/source/role` 校验。

对本插件：`preparedCacheTrim` 从此刻起永久 `inactive`（coordinator 已不存在），
`chunkedMaterialize` 换到新签名分支，`zeroCopyFork` 换到 `eventState` 分支。

## 0.2.2-rc.1：五处变更

### 1. append 生命周期（`dsh-session`）

store 拥有的 Session 在 `session/created` 派发完成前**禁止 append**：

```js
// dsh-session 的 publicationEntry()
const entry = attachments.get(this)
if (entry === null) throw new Error(`session "${this.id}" cannot append outside a SessionStore`)
if (entry !== void 0 && entry.announcement !== 'complete')
  throw new Error(`session "${this.id}" cannot append before session/created completes`)
```

`prepare()` / `create()` 会把会话登记为 `null`（只读），`enter()` 后是 `pending`，
`announce()` 成功才转 `complete`；`announce()` 抛错则转 `failed` 且不可重试。

**对本插件：无影响。** 零拷贝 fork 走 `create(childId, {...})`，其内部
`prepare → enter → announce` 在同一次同步调用里完成，`create()` 返回时已是
`complete`。只有「先 prepare、跨 await 再 announce」的写法才会踩到。

### 2. 原生 fork 不再写 `parentSession`

```js
// 0.1.7 – 0.2.1
meta: { cwd, parentSession: liveSource.id, isSeeded: true }
// 0.2.2+
meta: { cwd, isSeeded: true }
```

字段本身在 header 类型里仍存在，只是原生 fork 不再自动设置。

**对本插件：已适配，两处受影响：**

- `lib/patches/zero-copy-fork.js` 原本无条件写 `parentSession`，导致同一版本内
  「走零拷贝」与「回退原生」产出的 header 不同。现按原生源码探测
  `nativeSetsParentSession = String(originalFork).includes('parentSession: liveSource.id')`。
- `lib/warmup.js` 原本用 `header.parentSession !== undefined` 判断 fork 子会话以触发
  缓存回填；该判断在 0.2.2 下恒假，回填会静默失效。现改为
  `parentSession !== undefined || inheritedEventCount > 0`。

### 3. 投影注册与读路径（`dsh-session-projection`）

| 变化 | 说明 |
|---|---|
| `register()` 变异步 | 返回 thenable + disposer，内部读 `ctx.fiber.assertActive()` |
| 新增 `refs === 0` 语义 | 最后一个使用者释放后 key 仍留在 `registrations` 里，但**不参与** drive / snapshot / restore / checkpoint |
| `snapshot()` 不再全量物化 | 只 `cellFor()` 被请求的 key，Host-only 单元不再被附带折叠 |
| 新增 `summaryKeys()` / `onEventChanged()` | 摘要 key 集合、事件级变更订阅；`wire.summary !== false` 决定是否进摘要 |
| `cachedSnapshot()` 标记废弃 | 只返回别处已算过的值，不得用于决策 |

**对本插件：无破坏，但有一处适配；运行时实测该项能力在 0.2.2 上已失效。**

我们不调用 `register()`（只用内部 `registrations` / `cells` / `buildCell`），
异步化不影响。预热写入的 cell 仍被 `snapshot()` 采用。适配点：预热循环跳过
`refs === 0` 的已释放单元（见 `lib/warmup.js`）。

**运行时实测（[RUNTIME-ANALYSIS.md](RUNTIME-ANALYSIS.md) 场景 C）**：
`dsh-api-session-controller` 在 `session/created` 的同步广播里调
`snapshot(session)`（不带 keys），`cellFor()` 随即对全部 29 个单元执行
`buildCell()` 一次性折完并写入 `registration.cells`。插件的预热监听器注册更晚，
轮到它时所有 cell 已存在，逐单元返回 `hot`，`stats.warmed` 恒为 0。这是 0.2.2
上预热失效的根因，不能靠调整监听器顺序解决（顺序由 bundle 加载次序决定）。

### 4. 平台门禁（`dsh-app-boot`）

新增可选声明 `dsh.bundle.platforms`（Node `process.platform` 名数组）。声明后，
运行平台不在列表内会抛 `UnsupportedBundlePlatformError` 并跳过该 bundle。

**对本插件：不声明。** 本插件是纯 JS、无平台限定，不声明即所有平台均可加载。

### 5. `session/fork` RPC 不再经过 `SessionStore.fork`

`dsh-api-session-controller` 的 `session/fork` 自己构建 seed 后直接调
`agents.create`（`lib/index.js:775-806`）：

```js
const seed = buildForkSeed(source.events, boundary);
await this.ctx.agents.create({
  sessionId: childId,
  seed,
  inheritedEventCount: SessionLogOffset(boundary + 1),
  meta: { ...source.header.cwd === void 0 ? {} : { cwd: source.header.cwd },
          isSeeded: true, ... },
  ...
});
```

全安装包内服务端已无任何 `sessions.fork(` 调用方（只有浏览器端
`dsh-client-ui-chat` / `dsh-client-ui-workspace` 的 client.js 里有同名前端方法）。

**对本插件：零拷贝 fork 补丁在 UI 链路上失效。** 补丁挂在
`SessionStore.prototype.fork` 上，而这条 RPC 不调用它。运行时实测
（[RUNTIME-ANALYSIS.md](RUNTIME-ANALYSIS.md) 场景 D）：真实 fork 后
`stats.forks = 0`。补丁本身仍可工作（场景 E 用 `debug.fork` 直测：24 万事件
20.1s → 15.8s），但没有真实调用方。

注意：把补丁改挂到 `sessions.prepare({seed})` 覆盖这条路径**是负收益**——实测
会让 fork 从 25.8s 涨到 48.4s（深冻结 24 万事件的开销超过它省下的拷贝）。
因此当前版本选择保持补丁原状并如实标注，而非扩展覆盖。

## 插件清单规范

dsh 从插件 `package.json` 读两类信息，缺一不可：

| 用途 | 字段 | 说明 |
|---|---|---|
| **加载** | `dsh.bundle.patch` | patch 文件路径（或路径数组），profile 加载时按序应用；缺它插件不会被当作 bundle |
| **门禁** | `engines.dsh` | 版本范围。声明后 `peerDependencies` 里的 dsh 项被完全忽略 |
| **展示** | `icon` + `locale/*.json` | 插件管理器与设置页的标题、描述、图标；缺了会退化为裸包名 |

本插件的实际声明以 `package.json` 为准，不要照抄本文——复制会漂移。关键点：

- `exports` 必须显式暴露 `./locale/*.json` 与 `./cordis.patch.yml`。宿主用
  `optionalResourcePath(specifier, parentURL)` 走 Node 解析读取这两类子路径，
  未导出的子路径读不到。
- `icon` 用相对路径（须在包目录内、≤256 KiB、支持 SVG/PNG/JPEG/WebP），也可改用
  `exports` 暴露的 `./icon` 资源。本插件用前者。
- `locale/en.json` 与 `locale/zh.json` 的结构与官方 bundle 一致：
  `{ "meta": { "title": "…", "description": "…" } }`。
- `files` 白名单必须包含 `docs`（README 里链到它）、`locale/*.json`、`icon.svg`、
  `cordis.patch.yml`。`tests/` 与 `tools/` 不在白名单内，因此不随包发布。

`engines.dsh` 若声明为非字符串，宿主会**抛错**而不是跳过——这与「范围不满足被跳过」
是两种不同失败模式，改这一项时注意类型。

## 升级 dsh 后的检查清单

1. 启动日志确认 `dsh version: x.y.z (verified)`，且没有 `signature mismatch` 与
   `skipping profile bundle`。
2. `node tests/verify_compat.mjs` 全通过（依赖 `scripts/link-deps.ps1` 先建好 junction）。
3. `npm test` 全通过（含真实组件 e2e），记下运行器打印的断言总数。
4. 若新版本不在 `KNOWN_runtime_VERSIONS`，在 `lib/runtime.js` 与
   `tests/verify_compat.mjs` 两处登记（两处必须保持一致）。
5. 实机启动 web profile，用 `stats.get` 确认各点位状态符合预期。真实状态键只有
   5 个：`zeroCopyFork`、`fastInitFor`、`preparedCacheTrim`、`chunkedMaterialize`、
   `warmup`（heap 检查不在其中）。
6. 如果这次升级需要更新 `engines.dsh`（例如跨到 0.3.x），同步更新 README 的支持
   版本一行与 `docs/ARCHITECTURE.md` 顶部的验证边界。
