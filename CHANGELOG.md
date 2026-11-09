# Changelog

本插件的版本线：**插件版本**（`1.x.y`）与**支持的 dsh 版本区间**各自演进。每个条目
同时标注该版本实测验证过的 dsh 版本。

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)；补丁点的上游变化详见
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) 的版本矩阵。

## [Unreleased]

## [1.5.0] — 2026-11-09

文档全面重整。不是功能版本，但修正了多处会让读者得出错误结论的文档缺陷。

### Changed

- **README 重写为纯用户向**：是什么 / 安装 / 配置 / 验证与排错 / 已知限制 / 开发 /
  深入阅读。新增「常见问题」小节，覆盖 `signature mismatch`、门禁跳过、端口不符、
  配置不生效、插件未加载五种情形。
- **`PUBLISHING.md` 移入 `docs/`** 并重写：补上前置条件（必须先跑
  `scripts/link-deps.ps1`，否则 `npm test` 必失败）、git tag 步骤、发布后核验流程；
  移除机器相关的代理地址与 token 脚本路径。移入 `docs/` 后，README 的链接在已发布
  的 npm 包里不再失效（原文件被 `.npmignore` 排除，构成发布包内死链）。
- **配置表补全**：18 个键逐行列出（原先把 `backfillMinBytes` / `backfillMaxBytes`
  合并成一行），新增「单位」列——`heapWarnBytes`、`backfillMinBytes`、
  `backfillMaxBytes` 的单位是**字节**，此前未说明。
- **`docs/ARCHITECTURE.md` 重写**：问题分类统一为 A/B/C/D 四类（原文用「三类」却
  列了 6 个编号小节）；补上缺失的「装配契约」（`pc` 对象、`ctx.inject` 懒装配、
  `safeGet`）与「如何新增补丁」两节；`heap 检测` 从「各补丁」中移出，明确它不是补丁、
  不进 `stats.patches`。
- **`docs/COMPATIBILITY.md` 重写**：破坏性变更按版本时间序重排（原先 0.2.2 排在
  0.1.3 之前）；「三处收紧」改为「四处」（原文标题与四个小节不一致）；明确区分
  `engines.dsh`（允许范围）与 `KNOWN_runtime_VERSIONS`（实测验证过）——这是原文最
  容易被误读的地方。
- 移除 README 的 version / dsh 静态徽章：它们与 `package.json` 重复且会在每次发版时
  漂移。只保留 license 徽章。
- `locale/en.json` 标题由 `Large Project Performance` 改为
  `Large Session Performance`；中英文描述均补上原先遗漏的 heap 上限告警能力。

### Fixed

- **`docs/ARCHITECTURE.md` 称历史格式迁移「在 Worker Thread 内完成」——与实现相反。**
  实测 0.2.2-rc.1：`prepareMigration` 在**主线程**调用 `decodeStreamingMigration`，
  Worker 仅用于 `verifyCurrentGenerationInWorker` 校验已发布的世代。同时补充区分
  `ZSTD_DECODE_YIELD_INTERVAL_MS` 与 `MIGRATION_DECODE_YIELD_INTERVAL_MS` 两个
  各为 500ms 的常量（原文混为一谈）。
- **`docs/COMPATIBILITY.md` 抄录的 `files` 数组漏了 `docs`**，与 `package.json` 不符。
  改为「必需字段表 + 指向 `package.json`」，不再复制整份 JSON。
- **`docs/ARCHITECTURE.md` 的缓存 identity 字段顺序写错**：实际
  `lifecycleIdentityOf` 是 `formatVersion` 在首位、`cwd` 为条件展开，原文将
  `formatVersion` 排在末位且未说明条件语义。
- `docs/COMPATIBILITY.md` 引用的 `optionalResourcePath` 签名补齐为
  `(specifier, parentURL)`（原文只写了单参数）。
- CHANGELOG 修正：删除指向不存在的「README 支持版本表」的失效引用（改指
  `docs/COMPATIBILITY.md`）；1.1.0 与 1.2.0 重复记录同一批功能的问题（LRU / heap
  保留在 1.2.0）；为 1.0.0 / 1.1.0 / 1.1.1 补日期；统一
  `### Compatibility notes` 命名。
- 历史条目中不可复算的包数统计（「13/17 个关键包」「依赖集 86 项」「305 个已装包」）
  改为定性描述，不再给读者无法核验的精确数字。

### Added

- `tests/run.mjs` 现在统计并打印**实测断言总数**（汇总表按套件显示，末行给总数）。
  此前 README 写「147 断言」但运行器从不打印该数字，且静态 `check(` 计数为 150。
  本次实测为 **148**。文档引用断言数时应取自该输出。
- `scripts/link-deps.ps1` 移除第三份硬编码的 dsh 版本列表（只到 `0.1.1-rc.2`，
  每次运行都会误报 WARNING）。版本判定统一交给 `tests/verify_compat.mjs`。

## [1.4.0] — 2026-11-06

面向 **dsh 0.2.2-rc.1** 的兼容版本。这是 0.2.x 线上的实质变更版本（此前
0.2.1-rc.3 / rc.4 / rc.5 三个 dsh 版本均为纯版本刷新，`dsh-session` 源码零变化）。

### Fixed

- **零拷贝 fork 的 `parentSession` 与原生分歧**：0.2.2 起原生 `fork()` 不再给子会话
  写 `parentSession`（0.1.7–0.2.1 均写）。插件原本无条件写入，导致同一 dsh 版本内
  「走零拷贝」与「回退原生」产出的 header 不同，下游按该字段识别分支会话的逻辑
  时灵时不灵。现按原生源码探测（`nativeSetsParentSession`），两代都与原生一致。
- **预热对 fork 子会话的缓存回填在 0.2.2 静默失效**：原判断
  `header.parentSession !== undefined` 在 0.2.2 下恒假。改为
  `parentSession !== undefined || inheritedEventCount > 0`，覆盖 fork 与 resume
  两类带继承前缀的会话。
- **预热遍历已释放的投影单元**：0.2.2 起 `registrations` 保留 `refs === 0` 的 key
  但不再被 drive/snapshot/restore 读取，预热它们纯属浪费。现跳过这类条目
  （老版本无该字段，按活跃处理）。

### Changed

- 已知版本列表加入 `0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-rc.1`；支持范围上限更新为
  `0.2.2-rc.1`。
- 测试适配 0.2.2 的投影 API：`register()` 变异步且读 `ctx.fiber`，
  `drive()` 会广播 `eventListeners`；e2e 脚手架的 mock ctx 相应补齐。
- `fork` 相关断言从「写死 `parentSession`」改为「与同版本原生行为一致」，
  避免上游行为变化时误报。

### Compatibility notes（0.2.2 的四处收紧）

详见 `docs/COMPATIBILITY.md`：

1. **append 生命周期**：store 拥有的 Session 在 `session/created` 派发完成前禁止
   append；`prepare()` 后处于只读态，`announce()` 成功才解锁。本插件的零拷贝 fork
   走 `create()`（prepare→enter→announce 同步完成），不受影响。
2. **`parentSession` 移除**：见上。
3. **投影读路径重构**：`snapshot()` 不再全量物化，只计算被请求的 key；新增
   `refs === 0` 语义、`summaryKeys()`、`onEventChanged()`。本插件不调用
   `register()`，预热写入的 cell 仍被 `snapshot()` 采用（实测零冷折叠）。

另：`dsh-app-boot` 新增 `dsh.bundle.platforms` 平台门禁（可选声明）。本插件为纯
JS、无平台限定，保持不声明。

## [1.3.3] — 2026-10-24

面向 **dsh 0.2.1-rc.3** 的兼容版本。rc.3 是**纯版本刷新**：关键包
（`dsh-session`、`dsh-session-persistence(-jsonl)`、`dsh-session-projection(-cache)`、
`dsh-app-boot`、`dsh-web-app`、`dsh-plugin-manager` 等）rc.2→rc.3 源码逐字节相同，
四个补丁点与投影缓存零影响。

### Changed

- 已知版本列表加入 `0.2.1-rc.3`；实测验证上限更新为 `0.2.1-rc.3`。

## [1.3.2] — 2026-10-17

面向 **dsh 0.2.1-rc.2** 的兼容版本。rc.2 是**纯版本刷新**：关键包
（`dsh-session`、`dsh-session-persistence(-jsonl)`、`dsh-session-projection(-cache)`、
`dsh-app-boot`、`dsh-agent-loop`、`dsh-web-app`、`dsh-plugin-manager`、
`dsh-host-webserver`、`dsh-home-paths` 等）rc.1→rc.2 源码逐字节相同，四个补丁点零影响。

### Added

- **插件清单展示元数据**（按官方 bundle 规范）：`icon.svg`、
  `locale/en.json`、`locale/zh.json`（双语标题与描述），并在 `exports` 中暴露
  `./locale/*.json` 与 `./cordis.patch.yml`、在 `files` 中纳入这些资源。
  此前插件在插件管理器中只显示裸包名、无图标。
- `verify_compat` 新增 4 条断言：bundle 声明完整（`dsh.bundle.patch`）、双语
  `locale` 可解析、`exports` 暴露子路径、展示元数据可被宿主 `readPluginMeta` 解析。

### Changed

- 已知版本列表加入 `0.2.1-rc.2`；实测验证上限更新为 `0.2.1-rc.2`。
- **README 重整**：精简为使用者向内容（能力与效果、
  安装、配置、验证与排错、已知限制）。维护者向内容拆到 `docs/`：
  - `docs/ARCHITECTURE.md` —— 各补丁实现原理、加载侧分工、
    identity 契约、安全性与回退、代码结构；
  - `docs/COMPATIBILITY.md` —— 版本矩阵、0.1.3 破坏面、版本门禁规则、
    插件清单规范、升级检查清单。
- `files` 白名单纳入 `docs/`，随 npm 包发布。

## [1.3.1] — 2026-10-17

面向 **dsh 0.2.1-rc.1** 的兼容与修复版本。

### Added

- **`engines.dsh` 声明**（`>=0.1.0-rc.6 <0.3.0-0`）。0.2.1 起门禁优先读
  `engines.dsh` 且**独占生效**——声明后 `peerDependencies` 的 dsh 项被完全忽略。
  两处声明保持一致，同时满足 0.2.0（只认 peer）与 0.2.1+（只认 engines）两代门禁。
- `verify_compat` 改为直接 `import` 宿主真实的 `evaluatePluginCompatibility` 实算
  门禁（拿不到时回退 semver 离线复算），并把 `engines.dsh` 纳入断言。
- e2e 新增 2 组回归断言，锁定本次修复的两个预热缺陷。

### Fixed

- **预热用 `def.init()` 无参调用**（严重）：上游投影契约是
  `init(header, inheritedEventCount)`，`agentPreset` / `workingDirectory` /
  `agentTeam` 等真实投影从 header 取值，无参调用抛 `TypeError` 导致该 unit
  预热静默失败。现按上游 `restore()` 语义传 `(session.header, session.inheritedEventCount)`。
- **预热写入的 cell 缺 `views` 字段**（严重）：上游 `buildCell()` 产出
  `{state, observedSeq, views: [undefined, undefined]}`，`drive()` / `advanceCell()`
  会读写 `views[0]/[1]`。缺该字段时，预热后的会话在**下一条事件到达**时抛
  `TypeError: Cannot read properties of undefined (reading '1')`。现按 `buildCell` 同形写入。

### Changed

- **测试适配 0.2.1 的 jsonl 后端形态**：该包不再导出 `default` 类，只导出
  cordis 插件（`name`/`apply`/`Config`）。e2e 改为经真实 `Context.plugin` 装载后
  从 `ctx.sessionPersistence` 取实例（同时保留 0.2.0 及之前的原型直取路径）。
- 已知版本列表加入 `0.2.1-rc.1`。

## [1.3.0] — 2026-10-11

面向 **dsh 0.2.0** 的发布准备版本。

### Added

- **0.2.0 插件契约**：`peerDependencies` 声明真实依赖的 dsh 包
  （`@deepseek-ai/dsh`、`@deepseek-ai/dsh-session`，范围 `>=0.1.0-rc.6 <0.3.0-0`）。
  dsh 0.2.0 起会据此做严格 peer 门禁，范围外会被跳过加载。
- **真实组件端到端测试**（`tests/e2e_real_components.mjs`）：直接驱动 dsh 安装包内的
  真实实现类（`JsonlSessionPersistence` / `SessionProjectionRegistry` /
  `SessionStore`），逐点位验证「补丁安装 → 行为正确」；mock 套件继续覆盖逻辑与边界。
- `verify_compat` 增加 peer 门禁离线复算（用 dsh 自带 semver 复算同一规则）。
- 发布元数据：`publishConfig.access=public`、`prepublishOnly` 测试门禁、`.npmignore`、
  本 CHANGELOG 与 `PUBLISHING.md`。

### Fixed

- **`zero-copy-fork` 缺少 `ctx.sessions` 服务防御**：服务缺失时会抛错并中断整个
  `apply`（其余补丁全部装不上）。现改为记录日志并将 `zeroCopyFork` 标记为
  `inactive` 后静默跳过。
- **投影缓存 identity 缺 `formatVersion`**（0.1.3 起的静默失效）：导致 warmup 基线
  无法复用上游缓存行、backfill 写入的行不能作折叠短路。两个 identity 构造器均已
  补上该字段。

### Compatibility

- 新增支持 dsh `0.2.0-rc.2`（`dsh-session` 重构 tail-repair、新增 `ToolCallRecovery`；
  `buildForkSeed`/`SESSION_FORMAT_VERSION` 等导出不变）。
- 登记 dsh `0.1.7-rc.1` / `0.1.7-rc.2`：fork 内部重构（`_forkSeed` →
  `_forkBoundary` + `buildForkSeed`）、open-turn 边界改为注入 turn 闭合事件、
  会话格式 v4。零拷贝补丁新增 0.1.7 协议分支（三协议自动探测）。
- 登记 dsh `0.1.5-alpha.1` / `0.1.5-rc.1` / `0.1.5-rc.2`（格式 v3、toolHistory）。
- 登记 dsh `0.1.2-rc.1`。

### Removed

- **dsh-std 支持**（`dsh-plugin.json` 清单、`lib/std-host.js` facet 入口、
  `tests/test_manifest.mjs`）。标准宿主始终未落地，dsh 亦不消费该清单；dsh 自身的
  插件加载链路（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`）不受影响。

## [1.2.0] — 2026-09-04

### Added

- `stats.get` 暴露每个补丁的生命周期状态（`active`/`retired`/`inactive`/`off`），
  实现「上游吸收某项能力后对应补丁自动退役」的可见化。
- 冷会话 LRU 裁剪（`preparedCacheTrim` / `preparedCacheSize`）与 heap 上限检测。
- dsh-std Community v0.15 清单与 facet 宿主入口（1.3.0 已移除）。

### Compatibility

- 适配 dsh `0.1.2-alpha.5` 破坏性变更：`Session.events` → `snapshotEvents()`；
  fork meta `seedLength` → `isSeeded` + `options.inheritedEventCount`；
  `encodeMaterialization(meta, events)` → `(storage, events)`；投影缓存 identity 新增
  `isSeeded`/`inheritedEventCount`（`putSoft` → `put`）。
- 适配 dsh `0.1.2-rc.1`（补丁点源码零差异）。

## [1.1.1] — 2026-08

### Fixed

- 分片 materialize 在 cordis Proxy 环境下从不安装（`ctx.get` 返回的 shadow method
  使签名校验永远失败）；改为取原型方法做特征校验。

## [1.1.0] — 2026-08

> 该版本的变更记录未完整留存；随后 1.2.0 重新记录了本阶段引入的能力
> （`stats` 生命周期状态、冷会话 LRU 裁剪、heap 检测），以其为准。

## [1.0.0] — 2026-08

### Added

- 合并 fork-perf 与 projection-warmup 两个插件为单一插件：
  - 零拷贝 fork（fork 时跳过逐事件深拷贝）
  - 投影分片预热（消除历史会话首次冷折叠的事件循环冻结）
  - fork 缓存回填
  - 分片 materialize（多帧 zstd，消除单巨字符串 / RangeError）
- 全部补丁带源码特征校验 + 三层回退（能力探测 / try-catch / 配置开关）。
