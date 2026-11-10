# Changelog

本插件的版本线：**插件版本**（`1.x.y`）与**支持的 dsh 版本区间**各自演进。每个条目
同时标注该版本实测验证过的 dsh 版本。

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)；补丁点的上游变化详见
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) 的版本矩阵。

## [Unreleased]

## [1.7.0] — 2026-11-11

**第三轮优化：一次被自己实测推翻的方案，以及由此得到的正确结论。**

上一轮把冷读 16.6 秒拆成「`session/events` 1.8–2.7s」+「`session/projections`
16.6s」，据此推定差值是投影折叠，于是设计「冷读后回写缓存行」让折叠只付一次。
实现完成后做了跨进程实测（场景 G）—— **方案无效**，但也因此第一次定位到真正的
瓶颈不在投影层。

### 实测结果（场景 G，24 万事件）

| 情形 | 首次读 | 缓存行 |
|---|---|---|
| 无缓存行 | 18938 ms | 无 |
| 有缓存行（新进程） | **19061 ms** | 9.14 MB / 29 units |
| 有缓存行（同进程二次） | 16913 ms | 同上 |

回写本身完全成功（`coldWriteBacks=1`、identity 逐字段匹配、所有行 `seq` 等于
日志末尾、`recordFor` 探针显示 HIT），**但对冷读耗时零影响**。

逐项排除后：`stateSchema.parse` 合计 52 ms、`restore` 的折叠循环 0 次迭代。
16 秒花在「把日志变成内存事件数组」——逐行 `JSON.parse`、关系校验、整图深冻、
`Session` 构造时的 surface 折叠。这些都在缓存行之前，投影缓存完全帮不到。

### Added

- **`lib/cache-identity.js`**：投影缓存 identity 的唯一构造器。此前 `warmup.js`
  与 `backfill.js` 各抄一份，字段顺序与条件展开容易与上游 `identityOf()` 漂移，
  一旦漂移行就永久失配且静默回退全量重折。
- **`lib/cold-writeback.js`** + `coldWriteBack` 配置键（默认 `false`）：包装
  `sessionProjectionCache.hydratePrepared`，冷读后把状态写成缓存行。
  **默认关**——实测无耗时收益，却每次写约 10 MB（`turnOutline` 单占 71%）。
  保留的唯一理由是让 dsh 的列表读（`cachedSnapshot`，零 I/O）看到更新数据。
- **`docs/HARNESS-COMPARISON.md`**：Codex CLI / Claude Code / Gemini CLI /
  ZCode(opencode) / Cursor·Aider·Cline 的会话存储与打开策略对比，附可移植技术
  清单。核心结论：dsh 缺的是「日志 → 派生索引 → 只读后缀」三层里的中间层。
- `stats.coldWriteBacks` / `coldWriteBackSkipped` / `coldWriteBackFailed` /
  `coldWriteBackRecent`。
- 探测工具新增**场景 G**（四回合跨进程回写验证）。

### Fixed

- **`backfill.js` 的 `def.init()` 无参调用**（严重）：与 1.3.1 修过的 warmup 是
  同一个 bug——`agentPreset` / `workingDirectory` / `agentTeam` 从 header 取值，
  无参调用抛 `TypeError` 导致整个补行静默失败。现按上游签名传
  `(header, inheritedEventCount)`。
- **`backfill.js` 不跳过 `refs === 0` 的已释放单元**：0.2.2 起这些 key 不再被
  读取，折叠它们纯属浪费。
- **`backfill.js` 只补缺失行、陈旧行永不刷新**：原逻辑 `recordFor !== undefined`
  就 skip，于是会话追加新事件后，旧行永远不更新，读取时仍要从旧水位继续折。
  现改为「缺失 **或** 行水位落后于日志末尾」才补。
- **`backfill.js` 同步整文件 zstd 解码**：`zstdDecompressSync` 一次性解压整个
  文件会冻结事件循环数秒到数十秒（这正是本能力默认关的原因）。改为逐帧异步
  解压 + 帧间让出，与上游 `readZstdPrefix` 的让出语义对齐。
- **`backfill.js` 的 seed cut 推导**补上 `meta.seedLength` 回退（老格式 v0）。

### Changed

- **README 能力表删掉「缓存行命中 65 倍」的说法**。那个 0.26 s 是**同进程内会话
  已 live** 的读（`sessions.get` 快路径），不是跨进程冷读命中缓存行；两者不可
  混为一谈，此前的表述会让人以为给大会话建一次缓存行就能解决打开慢。
- `docs/RUNTIME-ANALYSIS.md` 新增场景 G 全节，并在结论摘要里把「冷读 16.6 秒
  不在投影折叠上」列为第二条核心结论。
- 配置键 19 → 20。

## [1.6.0] — 2026-11-11

**首次真实运行时分析。** 此前所有验证都是静态的（源码特征断言 + 真实类 e2e），
证明「补丁装得上」，但从未验证「真实 dsh 进程里谁调用它、值多少」。本轮在隔离
home 里起真实 dsh 0.2.2-rc.1，用 HTTP RPC 驱动真实链路，测出两个此前未知的
失效，并修正了文档里多处过度宣称。

完整数据、方法与测量边界见新文档 [`docs/RUNTIME-ANALYSIS.md`](docs/RUNTIME-ANALYSIS.md)。

### Added

- **`tools/runtime-probe/`**：隔离实例运行时探测工具集（客户端、起停、RSS 采样、
  事件循环 pinger、长会话生成器、六个场景、报告渲染）。整目录被 `.npmignore`
  排除，不随包发布。含 `README.md` 说明复跑方式与已知坑位。
- **`docs/RUNTIME-ANALYSIS.md`**：六个场景的原始数字、每个数字能证明什么/不能
  证明什么、失效根因的源码定位。
- **`debugApi` 配置键**（第 19 个，默认 `false`）：打开后在插件自有 API 前缀下
  暴露 `debug.fork`，直接调用 `SessionStore.prototype.fork`。这是测量零拷贝补丁
  的唯一途径——dsh 0.2.2 的常规 fork RPC 已经不经过该方法。
- **`stats.alreadyHot` 计数**：会话进入时上游已把全部投影折完的次数。此前这种
  情形会让 `warmed=0` 且 `skipped=0`，看起来像「预热从未被调用」，掩盖了真实原因。
- **启动期环境变量覆盖配置**（`DSH_PERF_<SNAKE_CASE_KEY>`）：用于离线测量。
  `chunkedMaterialize` / `fastInitFor` 只在 install 时读一次配置，运行期
  `config.set` 改不动，只能靠它做独立进程对照。
- `verify_compat` 新增 5 条断言：`debug.fork` 必须由 `debugApi` 把关、
  `stats.alreadyHot` 存在、预热对已建 cell 返回 `hot` 而非 `skip`、
  环境变量覆盖由 `DEFAULT_CONFIG` 键驱动。

### Fixed

- **`stats.patches.active` 的语义被澄清为「已安装」，不再是「已生效」**。README
  原文写「`active` — 已安装生效」，但实测两项 `active` 的能力从未在真实链路上被
  调用。文档已改为「已安装（不代表本轮被调用）」，并指出要用 `zeroCopy` /
  `warmed` / `alreadyHot` 等命中计数判断。
- **预热对已存在 cell 的状态从 `skip` 改为 `hot`**，并单独计数。原实现把「上游
  已折完」与「并发 drive 抢建」混为一种 `skip`，无法区分「预热无事可做」与
  「预热被抢先」。

### Changed

- **README 能力表按运行时实测重写**：效果列改为实测数字（零拷贝 -21%、分片
  materialize 帧数 2→6 但字节不变、预热失效），并新增一条醒目提示——补丁状态
  为 `active` 不等于在真实链路上被调用。
- **README 排错节重写**：新增「看不到任何 `[dsh-perf]` 日志」条目并说明这是默认
  配置下的常态（正常日志走 `logger.info`，dsh 默认级别会过滤掉；实测隔离实例里
  该前缀行数为 0 而插件工作正常）。新增「`stats.patches` 显示 `active` 但没效果」
  条目。原「没有任何日志 = 插件没加载」的说法会误导，已拆分为两条。
- **README 已知限制**补充两条实测失效说明（UI fork 链路不经过补丁点、预热在
  0.2.2 上不生效）。
- **`docs/COMPATIBILITY.md`**：0.2.2 一节由「四处收紧」扩为「五处变更」，新增
  「`session/fork` RPC 不再经过 `SessionStore.fork`」；第 3 条补上预热失效的
  运行时证据与根因。
- **`tools/runtime-probe/scenarios.mjs` 的场景 F 改用真实 `session/fork` RPC**。
  原设计用 `debug.fork`，但后者只建内存 session 不落盘，测不到 materialize。

### 已知遗留（不在本版本修复）

- **预热在 0.2.2 上仍然不生效**。根因是 `session/created` 的同步广播里
  `dsh-api-session-controller` 已调 `snapshot()` 建满全部 cell，而它的监听器
  注册早于本插件。修复需要换挂载点（例如包装 `buildCell` 让折叠过程分片让出），
  改动面与风险都超出「文档修正 + 观测面」的范围。
- **零拷贝补丁在 UI fork 链路上仍是死代码**。尝试把补丁改挂到
  `sessions.prepare({seed})` 覆盖该路径，实测**负收益**：fork 从 25.8s 涨到
  48.4s（深冻结 24 万事件的开销超过它省下的拷贝）。已回退，改为如实标注。
- `fastInitFor` / `preparedCacheTrim` 依赖的 `coordinator` 结构在 0.2.2 已不存在，
  当前恒为 `inactive`。它们是历史兼容层，不是可用能力。

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

- **README 的 `config.set` 示例格式错误**：示例写的是
  `{"key":"backfillOnBoot","value":true}`，但接口实际按扁平对象逐键匹配
  （`for (const key of Object.keys(DEFAULT_CONFIG)) if (key in payload) ...`）。
  照文档发送会得到 200 和当前配置，却一个键都没改——静默失败。已改正示例并补充
  「扁平对象、不是 key/value 形式」的说明，同时加断言锁住该契约。
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

- **补声明 `@deepseek-ai/schemastery` 到 `dependencies`**（`^3.19.0`）。`lib/config.js`
  顶层 `await import()` 它，此前完全没声明，仅仅搭上了 dsh 嵌套安装的便车。漏声明的
  后果不是崩溃而是**静默降级**：import 失败被 try-catch 吞掉 → `schemaLib` 为 null →
  `registerSettings` 直接 return → 配置不再经 settings 持久化，用户改的配置重启即丢。
- `verify_compat` 新增 2 条断言锁住两个依赖声明（schemastery 在 dependencies、
  cordis 在 peer 且不在 dependencies）。

### Changed

- **`@deepseek-ai/cordis` 的 peer 范围由 `^4.0.1` 收紧为 `~4.1.0`**，与官方包
  （`dsh-app-boot` / `dsh-web-app` / `dsh-session-projection` / `dsh-plugin-manager`
  等）一致。cordis 是宿主提供的单例运行时，`~` 可防止跨 minor 的 API 漂移。
  实测 `evaluatePluginCompatibility` 在所有已验证 dsh 版本上仍判定 COMPATIBLE
  （`engines.dsh` 声明后门禁本就忽略 peer 项）。

- `tests/run.mjs` 现在统计并打印**实测断言总数**（汇总表按套件显示，末行给总数）。
  此前 README 写「147 断言」但运行器从不打印该数字，且静态 `check(` 计数为 150。
  本次实测为 **151**。文档引用断言数时应取自该输出。
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
