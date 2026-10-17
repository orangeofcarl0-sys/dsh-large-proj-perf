# 兼容性与插件规范

本文面向维护者：记录各 dsh 版本的内部形态差异、版本门禁规则，以及插件清单规范。

## 版本矩阵

按时间顺序。每一行说明该版本对插件作用点的影响。

| dsh 版本 | 内部形态与影响 |
|---|---|
| 0.1.0-rc.6 / rc.7 / rc.8 | fork 走 `prepare(seedSource)` 通道；initFor 为 `structuredClone` 形态。rc.8 起 initFor 上游原生零拷贝，fast initFor 补丁退役 |
| 0.1.1-rc.1 / rc.2 | 同 alpha.5 形态；rc.2 的 `encodeMaterialization` 是 `(meta, events)` 裸 meta 签名 |
| 0.1.2-alpha.5 / 0.1.2-rc.1 | 新增 `snapshotEvents()`；fork meta 带 `isSeeded` + `inheritedEventCount`；签名变 `(storage, events)` |
| 0.1.3-alpha.2 | **persistence 子系统重写**（见下）；投影缓存 identity 新增 `formatVersion` |
| 0.1.5-alpha.1 | 会话格式 **v3**（`SESSION_FORMAT_VERSION=3`）；cut/header 语义同 v2，文件名 `session.v3.jsonl` |
| 0.1.5-rc.1 | 仅新增已知事件类型（`deliverables/presented`、`subagent/catalog`） |
| 0.1.5-rc.2 | 相对 rc.1 四个关键包源码零差异（仅版本号） |
| 0.1.7-rc.1 | fork 内部重构：`_forkSeed` → `_forkBoundary` + 模块级 `buildForkSeed`；**open-turn 边界从「拒绝」改为「注入 turn 闭合事件」**；会话格式升 **v4**；事件词汇收紧（`tool/result` role=`tool`、新增 `system/message`） |
| 0.1.7-rc.2 | 新增 `toolHistory()` 增量折叠；persistence/format/projection-cache 零差异 |
| 0.2.0-rc.2 | 主版本升级。**插件管理引入严格 peer 门禁**；`dsh-session` 重构 tail-repair 并新增 `ToolCallRecovery`（`buildForkSeed`/`SESSION_FORMAT_VERSION` 等导出不变）；`llm-deepseek` 拆分为 `-api-key` / `-account` |
| 0.2.1-rc.1 | **门禁新增 `engines.dsh` 且独占生效**；jsonl 后端改为 cordis 插件形态（只导出 `name`/`apply`/`Config`）；persistence 改为 `ctx.effect` 资源生命周期 + `listConcurrency` 限流；`dsh-session` 新增 `appendPluginRecord`/`pluginRecordOf`；投影 `register()` 直接返回 effect。**fork 通道与四个补丁点源码零变化** |
| 0.2.1-rc.2 | **纯版本刷新**：13 个关键包 rc.1→rc.2 逐字节相同。唯一实质变更在 `dsh-web-app/cordis.patch.yml`（新增 `ui-deepseek-model-label-1017` 条目），不触及任何作用点 |

## 0.1.3-alpha.2 的关键变化

这次是破坏面最大的一次，四个作用点全部需要重新适配：

- `dsh-session-persistence` 变为 contract 层（`SessionPersistence` 基类 + 错误 + 校验），
  `PersistenceCoordinator` / `initFor` / `SessionPreparations` 移除；JSONL 实现移入
  `dsh-session-persistence-jsonl`。
- 格式 v0→v1→v2 迁移链（`dsh-session-format` 系列）；物理 header 移除 `seedLength`，
  seed cut 改由事件流尾 `session/end-seed {inherited:true}` marker 表达（`cut == marker.seq`）；
  文件名变 `session.vN.jsonl[.zstd]`。
- `encodeMaterialization(meta, events)` → `(meta, inheritedEventCount, events)`。
- 事件词汇收紧：`assistant/message` 需 `data.stream`，消息需 `id/source/role` 校验。

## dsh 版本门禁

dsh 0.2.0 起，profile bundle 加载前会校验插件 `package.json` 的 `peerDependencies`
中**所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 项**：运行时版本不满足 range 即
**跳过整个插件**（启动日志打 `skipping profile bundle "<name>": ... incompatible`），
可用 `dsh plugin allow-version <pkg>@<ver> --profile web` 做精确版本豁免。

**0.2.1 新增 `engines.dsh`，且它独占生效**：只要插件声明了 `engines.dsh`，门禁就
**只**看它，`peerDependencies` 里的 dsh 项被完全忽略（`unmetRequirements()` 的
`if (Object.hasOwn(engines, "dsh"))` 分支直接返回）。

本插件的声明：

```json
"engines": {
  "node": ">=22.15.0",
  "dsh": ">=0.1.0-rc.6 <0.3.0-0"
},
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh": ">=0.1.0-rc.6 <0.3.0-0",
  "@deepseek-ai/dsh-session": ">=0.1.0-rc.6 <0.3.0-0"
}
```

- 只声明真实依赖：`dsh-session`（`snapshotEvents` / `buildForkSeed` / `SessionLogOffset`）
  与 `dsh`（版本探针）。
- 上界 `<0.3.0-0` 覆盖整个 0.1.x–0.2.x 线：既让门禁守住兼容边界，又不会在小版本推进时
  误杀自己。**升级 dsh 大版本（0.3+）前必须先更新此范围。**
- 保留 `peerDependencies` 是为旧版本兜底：0.2.0 及之前不认 `engines.dsh`，只读 peer
  范围。两处保持一致即可同时满足两代门禁。
- `verify_compat.mjs` 直接 `import` 宿主真实的 `evaluatePluginCompatibility` 实算一遍，
  拿不到该导出时回退 semver 离线复算。报警 = 重启后必被跳过。

## 插件清单规范

dsh 从插件 `package.json` 读取两类信息，缺一不可：

| 用途 | 字段 | 说明 |
|---|---|---|
| **加载** | `dsh.bundle.patch` | bundle patch 文件路径（或路径数组），profile 加载时按序应用；缺它插件不会被当作 bundle |
| **展示** | `icon` + `./locale/*.json` | 插件管理器与设置页的标题、描述、图标；缺了会退化为裸包名 |

本插件的完整声明：

```json
"icon": "./icon.svg",
"exports": {
  ".": { "default": "./lib/index.js" },
  "./locale/*.json": "./locale/*.json",
  "./package.json": "./package.json",
  "./cordis.patch.yml": "./cordis.patch.yml"
},
"files": ["lib", "scripts", "locale/*.json", "icon.svg", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE"],
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`locale/en.json` / `locale/zh.json` 结构与官方 bundle 一致：

```json
{ "meta": { "title": "…", "description": "…" } }
```

注意 `exports` 必须显式暴露 `./locale/*.json` 与 `./cordis.patch.yml`——宿主通过
`optionalResourcePath("<pkg>/locale/en.json")` 走 Node 解析读取，未导出的子路径读不到。

图标走 `icon` 字段（相对路径，须在包目录内，≤256 KiB，支持 SVG/PNG/JPEG/WebP），
也可改用 `exports` 暴露的 `./icon` 资源。

## 升级 dsh 后的检查清单

1. 启动日志确认 `dsh version: x.y.z (verified)`，且无 `signature mismatch` 与
   `skipping profile bundle`。
2. `node tests/verify_compat.mjs` 全通过。
3. `npm test` 全通过（含真实组件 e2e）。
4. 若新版本不在 `KNOWN_DSH_VERSIONS`，按需登记（`lib/runtime.js` 与
   `tests/verify_compat.mjs` 各一份）。
5. 实机启动 web profile，`stats.get` 确认各点位为预期的 `active` / `inactive`。
