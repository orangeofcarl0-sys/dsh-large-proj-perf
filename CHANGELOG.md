# Changelog

本插件的版本线：**插件版本**（`1.x.y`）与**支持的 dsh 版本区间**各自演进。每个条目
同时标注该版本验证过的 dsh 版本。

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)；补丁点的上游变化详见 README 的
「支持版本」表。

## [Unreleased]

## [1.3.2] — 2026-10-17

面向 **dsh 0.2.1-rc.2** 的兼容版本。rc.2 是**纯版本刷新**：13 个关键包
（`dsh-session`、`dsh-session-persistence(-jsonl)`、`dsh-session-projection(-cache)`、
`dsh-app-boot`、`dsh-agent-loop`、`dsh-web-app`、`dsh-plugin-manager`、
`dsh-host-webserver`、`dsh-home-paths` 等）rc.1→rc.2 逐字节相同，四个补丁点零影响。

### Added

- **插件清单展示元数据**（按官方 bundle 规范）：`icon.svg`、
  `locale/en.json`、`locale/zh.json`（双语标题与描述），并在 `exports` 中暴露
  `./locale/*.json` 与 `./cordis.patch.yml`、在 `files` 中纳入这些资源。
  此前插件在插件管理器中只显示裸包名、无图标。
- `verify_compat` 新增 4 条断言：bundle 声明完整（`dsh.bundle.patch`）、双语
  `locale` 可解析、`exports` 暴露子路径、展示元数据可被宿主 `readPluginMeta` 解析。

### Changed

- 已知版本列表加入 `0.2.1-rc.2`；支持范围上限更新为 `0.2.1-rc.2`。
- **README 重整**：从 315 行精简到 156 行，只保留使用者需要的内容（能力与效果、
  安装、配置、验证、已知限制）。维护者向内容拆到 `docs/`：
  - `docs/ARCHITECTURE.md` —— 三类同步阻塞、各补丁实现原理、加载侧分工、
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
- dsh-std Community v0.15 清单与 facet 宿主入口（1.3.0 已移除）。
- 冷会话 LRU 裁剪（`preparedCacheTrim` / `preparedCacheSize`）与 heap 上限检测。

### Compatibility

- 适配 dsh `0.1.2-alpha.5` 破坏性变更：`Session.events` → `snapshotEvents()`；
  fork meta `seedLength` → `isSeeded` + `options.inheritedEventCount`；
  `encodeMaterialization(meta, events)` → `(storage, events)`；投影缓存 identity 新增
  `isSeeded`/`inheritedEventCount`（`putSoft` → `put`）。
- 适配 dsh `0.1.2-rc.1`（补丁点源码零差异）。

## [1.1.1]

### Fixed

- 分片 materialize 在 cordis Proxy 环境下从不安装（`ctx.get` 返回的 shadow method
  使签名校验永远失败）；改为取原型方法做特征校验。

## [1.1.0]

### Added

- 冷会话 LRU 裁剪：运行时下调 `SessionPreparations.capacity` 并淘汰最旧 ready 条目
  （官方默认 5 → 1，省约 2.8GB）。
- heap 上限检测与启动参数引导。

## [1.0.0]

### Added

- 合并 fork-perf 与 projection-warmup 两个插件为单一插件：
  - 零拷贝 fork（fork 时跳过逐事件深拷贝）
  - 投影分片预热（消除历史会话首次冷折叠的事件循环冻结）
  - fork 缓存回填
  - 分片 materialize（多帧 zstd，消除单巨字符串 / RangeError）
- 全部补丁带源码特征校验 + 三层回退（能力探测 / try-catch / 配置开关）。
