# Changelog

本插件的版本线：**插件版本**（`1.x.y`）与**支持的 dsh 版本区间**各自演进。每个条目
同时标注该版本验证过的 dsh 版本。

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)；补丁点的上游变化详见 README 的
「支持版本」表。

## [Unreleased]

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
