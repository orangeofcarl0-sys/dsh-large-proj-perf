# Changelog

本插件的版本线：**插件版本**（`1.x.y`）与**支持的 dsh 版本区间**各自演进。每个条目
同时标注该版本实测验证过的 dsh 版本。

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)；补丁点的上游变化详见
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) 的版本矩阵。

## 重要版本速览

标题带 **⚠️ 重要** 的版本对使用者有实际影响。判定标准只有三条：

1. **破坏性**——升级后需要动手（改配置、重装插件、某项能力消失）；
2. **性能里程碑**——有实测数据支撑的量级变化；
3. **修复会崩溃或静默失效的 bug**——不是风格或文档修正。

| 版本 | 类型 | 一句话 |
|---|---|---|
| [1.14.0](#1140-2026-11-13-重要测量) | **测量补全** | 500 ms 链路归因闭合（服务端 encode + 写队列，不是浏览器）；markdown op 级成本；30k 跳转曲线外推 60–70 s |
| [1.13.0](#1130-2026-11-13-重要测量) | **测量补全** | 四条缺口全部动手：重会话生成、回合跳转（+1375 行 / 阻塞 1.7 s）、打开路径分段归因、滚动跳变 |
| [1.12.0](#1120-2026-11-13-重要性能) | **性能里程碑** | 首次测浏览器渲染：打开 7.4 s 到首行；离屏行 containment 让批量翻页阻塞 -47% |
| [1.11.0](#1110-2026-11-11-重要破坏性) | **破坏性** | 支持范围收紧到 `>=0.2.2-rc.1 <0.3.0-0`；更旧的 dsh 上不再加载 |
| [1.10.0](#1100-2026-11-11-重要破坏性) | **破坏性** | 移除三项在 0.2.2 上恒不生效的能力；配置键 22 → 17；修掉「改配置不生效」的晚绑定 bug |
| [1.9.0](#190-2026-11-11-重要性能) | **性能里程碑** | 事件缓存改为按字节限容，稳态 RSS 1324 → 690 MB |
| [1.8.0](#180-2026-11-11-重要性能) | **性能里程碑** | 冷读 21.2 s → 3.0 s（7×），瓶颈是 `turnOutline` 的 O(n²) 折叠 |
| [1.3.0](#130-2026-10-11-重要破坏性) | **破坏性** | 声明 `peerDependencies`，不满足 0.2.0 门禁的旧 profile 会被跳过加载 |
| [1.0.0](#100-2026-08-首个版本) | **首个版本** | 合并 fork-perf 与 projection-warmup 两个插件 |

未列入的版本是兼容性跟随（dsh 小版本升级）或文档/元数据修补，无需额外动作。
纯文档修补不标重要——例如 **1.10.1 不标**，它只修文档事实错误，行为零变化。

## [Unreleased]

## [1.14.0] — 2026-11-13 — ⚠️ 重要（测量）

继续调查 1.13 之后仍开放的四条。**结论多数是「此前的猜测不成立」**：

### 500 ms 链路开销：不是浏览器，是服务端

用 `remote.streams.socket` 上的 `message` 监听器取 `event.timeStamp`（真正的
帧到达时刻；监听器自身可能被应用解析大帧后的微任务检查点推迟），按同机
`Date.now()` 把打开拆成五段：

| 段 | 实测 |
|---|---:|
| 请求腿（流打开 → 服务端开始） | 43–76 ms |
| 服务端产出 | 3–52 ms（热）/ 2 495 ms（冷） |
| 响应腿（服务端完成 → 帧到达） | **658 ms**（热，6.8 MB）/ 2 313 ms（冷） |
| 本地派发（帧 → item） | **7–35 ms** |
| 组装挂载（item → 首行） | 100–260 ms |

响应腿再拆：新增 `tools/runtime-probe/bench-encode.mjs` 量同载荷的
`JSON.stringify` + deflate(level 1)：长会话 **265 ms**（51.5 + 213.8），
重会话 **36.8 ms**。剩余约 300 ms 来自 **`session/control` 基线堵在串行写队列**：
给 WS 帧加上 `streamId → endpoint` 归属后，热读长会话看到
`session/control` 6 830 981 B 与 `session/follow` 6 835 203 B 两帧相邻，
follow 比 control 晚 299 ms——`stream-server` 的 `this.writes` 是跨逻辑流的
串行队列，control 基线本身就是 6.8 MB 量级。

浏览器解析 6.8 MB JSON 只要 20–30 ms（V8 很快）。**旧的「解压假设」被推翻。**

### markdown / KaTeX：op 级隔离

`__dshPerf.benchMarkdown` 在页面里分别跑四个引擎（1 476 字符 / 4 围栏 / 4 公式）：

| 操作 | 每次 |
|---|---:|
| GFM 解析 | 7.46 ms |
| 建元素 + commit（分离容器，无布局） | **23.9 ms** |
| KaTeX | 1.28 ms / 式 |
| shiki tokenize | 3.5 ms / 145 字符 |

单条 1.5 KB 消息的 render 是 24 ms，其中解析只占 7.5 ms——**大头是 React 元素
创建与 commit**。离屏代码块永不进入视口门控，所以分离容器的 render 不含 shiki；
高亮单独用 `useCodeHighlighter` 回调量（结果里带 `renderIncludesHighlight: false`）。

### 30k 跳转：不是慢，是大概率崩

新增 `__dshPerf.jumpToTurn(n)`，阶梯式跳长会话（30 000 turn）：

| 目标 | 行数 | 最长任务 | 阻塞 | 堆 |
|---|---:|---:|---:|---:|
| 29 900 | 100 → 500 | 576 ms | 603 ms | — |
| 29 500 | 500 → 2 100 | 1 782 ms | 1 982 ms | — |
| 29 000 | 2 100 → 4 100 | 2 293 ms | 2 940 ms | — |
| 25 000 | 4 100 → **20 100** | — | — | **728 MB** |

斜率 ≈1.0–1.15 ms 阻塞/行、≈36 KB 堆/行。外推 turn 1：**60–70 s 阻塞、约 2 GB
堆**，默认 2 GB heap 上大概率 OOM。按计划的停止条件（rows > 20 000）在
20 100 行处停止，没有继续冒险。

### 方差：已量化，且发现了测量污染

同一 tiny 会话三次：首行 1 745 / 4 679 / 1 497 ms。中间那次继承了上一个
20 100 行页面留下的 **797 MB 堆 + 2 988 ms GC 任务**。**复用标签页会污染下一次
测量**；干净读数需要新标签页或 GC 静置。

### 验证

- `verify_compat.mjs` 82 → 88 条：WS socket 是普通运行时属性、帧从监听器同步
  接收、服务端 stringify + 串行写队列、客户端 WS 帧/`benchMarkdown`/`jumpToTurn`。
- 新增 `tools/runtime-probe/bench-encode.mjs`。

## [1.13.0] — 2026-11-13 — ⚠️ 重要（测量）

**把 1.12 留下的四条测量缺口逐条闭合**，并修掉采集器里三个会污染结论的缺陷。

### 修复的测量缺陷

- **阻塞时长改用 LoAF 的 `blockingDuration`**（规范值：各长任务 -50 的累加 +
  渲染段）。此前用 `duration - 50`，会系统性高估。
- **首行时间不再经过 120 ms 防抖**：在 `MutationObserver` 回调（变更后的微任务）
  里同步记录，防抖只留给 settle 判定。
- **采集 `renderStart` / `styleAndLayoutStart` / `scripts[]`**，把长帧拆成
  脚本 / 渲染 / 布局，并给出脚本 URL 归属。

### 新增测量能力

- **分段计时**：`performance.mark` 打在流打开 / 首个 item / 首行 / 首帧 / 稳定，
  样本带最多 16 条时间线；配 100 ms 心跳（`heartbeatMaxLagMs`）区分「填异步等待」
  与「大量短任务」。
- **逻辑流标签**：包装 `ctx.remote.$stream` 并保留 `options.name`，区分
  `session event stream` / `session control stream`，记录「打开 → 首个 item」。
  只在 `renderTiming=true` 时安装（它会改写应用所有逻辑流的公共入口）。
- **回合跳转窗口**：服务端把间隔 < 1 500 ms 的连续分页聚合成 `kind:'jump'`
  （页数/事件数/字节/耗时）；客户端记录行数与 turn 范围的变化。
- **滚动跳变**：逐帧采样 `scrollTop`，记录单帧最大位移、方向反转、锚点行漂移、
  `scrollHeight` 变化与输入意图。
- **`window.__dshPerf`**：`state()` / `jumpToFirst()` / `scrollTest({rounds})` / `flush()`。
- `perf.report` 改用独立的 64 KiB body 上限；非 200 时只丢最旧一半，不再清空整队。

### 新增素材

- `make-session-cli.mjs` 支持 `--turns` / `--profile plain|markdown|tools` /
  `--tool-bytes` / `--seed`。`tools` 档位按真实编码 agent 的字节分布生成
  bash 日志、文件读与 unified diff。
- **读回自检**：生成后用真实后端重新读出，核对事件数、turn 数、工具配对；
  失败直接退出 1。顺带修正了生成器注释里的错误——工具生命周期由
  `assistant/message` 的 `tool-call` 内容块声明，不是 `request/header.tools`。

### 实测结论

| 缺口 | 结果 |
|---|---|
| 消息体太小 | 重会话首屏 **1.73 MB**（长会话 74 KB 的 23 倍），投影只 68 KB——两轴分开 |
| 回合跳转 | 跳到 turn 1：**+1 375 行、阻塞 1 723 ms、最长任务 1 575 ms**、服务端一次发布 18.3 MB |
| 打开路径 | 拆成服务端首帧（热 52–188 ms）+ **约 500 ms 链路** + 100–260 ms 组装挂载；旧的「2.9 s 未归因」大部分其实是服务端时间 |
| 滚动跳变 | containment 开/关的锚点漂移都是 **22 px**，未测到额外跳变；默认维持开启 |

完整数据、剩余开放项与上游建议见 [docs/RENDER-ANALYSIS.md](docs/RENDER-ANALYSIS.md)。

### 验证

- `tests/test_render_timing.mjs` 30 → 40 条：`startedAt`/`sessionId`/`beforeSeq`、
  jump burst 聚合（3 页合成 1 条）、单页不记跳转。
- `verify_compat.mjs` 72 → 82 条：客户端新增标记、`$stream` 契约、
  `loadThrough` 单次发布、`data-chat-history` / `aria-busy` /
  `data-conversation-scroll` 三个 DOM 契约。
- `tools/runtime-probe` 新增 **scenario I**（重会话载荷 + control 基线量级）与
  **scenario J**（连续回翻 → 聚合为一次 jump）。

## [1.12.0] — 2026-11-13 — ⚠️ 重要（性能）

**首次把测量推进到浏览器侧。** 此前所有数字都是服务端的冷读/RSS，渲染从未被观测。

### 新增

- **`lib/render-timing.js`（`renderTiming`，默认关）**：包装
  `sessionProjections.snapshot` 与 `sessionController` 的
  `webController.follow` / `historyController.events`，记录每次打开/翻页的
  耗时、事件数与序列化字节；浏览器样本落在同一个 `stats.render` 下。
- **`lib/client.js`（首个浏览器端 bundle）**：`dsh.client = { platform: "web" }`
  \+ `exports["./client"]`，普通 `__ModuleLoader__.load` 脚本，无需构建。
  采集 `long-animation-frame` / `longtask` 与「导航 → 首行 / 稳定」，回传
  `perf.report`。
- **`lib/history-budget.js`（`maxInitialMessages` / `maxPageBytes`，默认关）**：
  首屏消息上限（同时压 `turnWindow.minMessages`）与单页字节上限。
- **`clientContainment`（默认开）**：长转录（>80 行）给第 30 行之后的离屏行加
  `content-visibility: auto`。

### 实测结论

- **一次打开 = 74 KB 消息 + 6.76 MB 投影。** 投影是消息的 **91 倍**，
  `turnOutline` 一个单元装着全部 30 000 个 turn。把首屏从 50 条压到 25 条只省
  0.5% 的字节——**首屏消息窗口不是瓶颈**，这是本轮最重要的否证。
- **导航 → 首行 7.4 s**：页面装载 1.6 s + 服务端首帧 2.5 s + 客户端阻塞 0.44 s
  \+ 未归因等待 2.9 s。
- **批量翻页才是「分钟级」的来源**：快速连续翻 10 页时客户端合并发布，
  一次性挂载上千行。无 containment：11 个长任务 / 2836 ms 阻塞 / 最长 416 ms；
  有 containment：18 个长任务 / **1489 ms 阻塞（-47%）** / 最长 244 ms。
- 稳态翻页很便宜：每页 200 事件 / 70 KB / 服务端 0.3–0.6 ms，单页无长任务；
  但 DOM 与堆单调增长（≈73 KB/行，600 行涨 44 MB）。

完整数据、归因与上游建议见新增的 [docs/RENDER-ANALYSIS.md](docs/RENDER-ANALYSIS.md)。

### 验证

- 新增 `tests/test_render_timing.mjs`（30 条）：配置门禁、计时点、窗口截断、
  字节上限、dispose 还原、安装时快照语义。
- `verify_compat.mjs` 新增 14 条：客户端清单（声明 + 文件存在 + 包名 id +
  工厂形状 + 配置门禁）、**上游渲染形状**（`ChatFlow` 仍无虚拟化、分页仍无字节
  上限、首屏仍是 500、`snapshot` 仍是同步）。
- `tools/runtime-probe` 新增 **scenario H**：量首屏/分页的字节数与服务端耗时，
  对比 `maxInitialMessages` 截断。
- `0.2.2-rc.2` 登记进 `KNOWN_DSH_VERSIONS`（`npm test` 对 rc.2 的真实包源码全绿）。

## [1.11.0] — 2026-11-11 — ⚠️ 重要（破坏性）

**支持范围收紧到 `>=0.2.2-rc.1 <0.3.0-0`。** 更旧的 dsh 上插件不再加载。

### Changed

- **`engines.dsh` 从 `>=0.1.0-rc.6 <0.3.0-0` 收紧为 `>=0.2.2-rc.1 <0.3.0-0`**，
  `peerDependencies` 里 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-session` 同步收紧。
  理由：v1.10.0 删掉三项依赖旧结构的能力后，0.1.x 上实际还能工作的只剩零拷贝 fork
  与分片 materialize，而这两项在 UI 链路上要么不被调用（零拷贝 fork，见 README
  「两条必须知道的限制」），要么只影响内存峰值不影响吞吐。让旧版本装上一个近乎
  空转的插件，比让门禁明确拒绝更糟。
- **`KNOWN_DSH_VERSIONS` 收敛为 `['0.2.2-rc.1']`**。历史上的 0.1.x / 0.2.0 / 0.2.1
  适配记录保留在 `docs/COMPATIBILITY.md` 的版本矩阵里（它们解释了代码中
  `0.1.3 eventState` 协议、legacy `encodeMaterialization` 签名等历史分支的来历），
  但不再进入运行时「已验证」清单——那些版本已进不来。
- **README 标题改为 `DSH Large Project Performance`**，开头新增「最近发生重要更新」
  提示块（破坏性变更 + 性能里程碑 + 升级指引）。dsh 版本徽章改为
  `>=0.2.2-rc.1`。

### 新增的验证

收紧声明范围不是改字符串就完事——声明错了会让插件在支持版本上被静默拒绝。为此加了
两条断言（`tests/verify_compat.mjs`）：

| 断言 | 防的是什么 |
|---|---|
| `lib/runtime.js` 与 `tests/verify_compat.mjs` 的已验清单逐项相同 | 两处清单漂移后，「实测过」与「运行时告警」会互相矛盾 |
| 已验清单里每个版本都落在 `engines.dsh` 内 | 实测通过新版本、却忘了同步 `engines.dsh` 时，宿主门禁会跳过加载，而运行时清单还在说「已验证」 |

另外用 dsh 自带的 `evaluatePluginCompatibility`（与宿主同一份实现）实测了门禁行为：

| 运行时 dsh | `>=0.2.2-rc.1` | `>=0.2.2-rc.1 <0.3.0-0` |
|---|---|---|
| 0.2.2-rc.1 | ACCEPT | **ACCEPT** |
| 0.2.1-rc.1 | SKIP | SKIP |
| 0.1.7-rc.2 | SKIP | SKIP |
| 0.2.3 | ACCEPT | ACCEPT |
| 0.3.0-rc.1 | ACCEPT（需要上界） | SKIP |

## [1.10.1] — 2026-11-11

文档全面重写。不是功能版本，但修掉了多处会让读者得出错误结论的文档缺陷。

**不标重要**：只有文档与元数据变化，代码行为零改动，升级不需要任何动作。

### Changed

- **两份实测文档合并为 [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md)**：原先
  `RUNTIME-ANALYSIS.md`（484 行）+ `MEMORY-ANALYSIS.md`（186 行）共 670 行，其中
  89 行是已删除的分片预热能力、50 行是被 v1.8 推翻的 v1.7 方案。合并后 346 行，
  分「时间」「空间」两大部分，**只保留对当前代码有指导意义的实测**；已删能力与
  被放弃的方向压成四个附录——保留它们的价值在于「我们试过了，这条路走不通」与
  「我们没试过」是两种不同的信息。
- **`README.md` 重写**：配置表按**重要性重排**（主力能力在前，调优项在后，不再是
  按功能分组的等权列表）；删除已失效的启动日志样例（日志在默认配置下不可见）；
  新增「`stats.get` 怎么读」小节，给出「想知道 X 就看 Y」的对照表。
- **`docs/ARCHITECTURE.md` 重写**（261 → 331 行）：问题分类从「A/B/C/D 四类」改为
  「写入 / 读取 / 驻留 三侧」——原来的四类里有两类（fork 深拷贝、`initFor`）都属
  写入侧，另有一类（LRU 裁剪）已删除。新增 §5「补丁基础设施」（`wrapMethod` 的还原
  语义、`sourceOf` 为什么要跳过 Proxy、三层回退、`retired` 状态当前无使用者）。

### Fixed

- **发布元数据仍在宣传 v1.10.0 已删除的能力**。`package.json` 的 `description` 与
  `locale/{zh,en}.json` 的 `meta.description` 都还写着「投影分片预热」「fork 缓存
  回填」——这两项在 1.10.0 已删除，而 npm 页面与 dsh 插件管理器展示的正是这段文字。
  改为按实测效果描述当前实际生效的能力（带具体数字）。
- **`docs/ARCHITECTURE.md` 标题写「四个补丁」但列了 5 节**，其中 3 节是已删除的
  能力（分片预热 / LRU 裁剪 / fast initFor）。重写后只有 4 个真实补丁，且默认关的
  两个能力（冷读回写、冷会话补行）明确归入「非补丁」小节。
- **`docs/ARCHITECTURE.md` 有两处「装配契约」章节**，前者整节都在描述 v1.10.0 已
  废弃的共享 `pc` 对象。合并为 §2 一节。
- **`README.md` 写「全套 8 套件」**，实际是 10 个、206 条断言。
- **`docs/COMPATIBILITY.md` 的版本矩阵说「0.2.2-rc.1 四处收紧」**，而同文件下一节
  标题是「五处变更」（第 5 条 `session/fork` 改道是 v1.6 补的，矩阵没同步）。
- **`docs/COMPATIBILITY.md` 两处仍用 `KNOWN_runtime_VERSIONS`**（真实常量名是
  `KNOWN_DSH_VERSIONS`）。
- CHANGELOG 里指向 `docs/RUNTIME-ANALYSIS.md` 的链接（该文件已合并删除）。

### 新增的验证

文档里的每个数字现在都能追溯到代码或实测：

| 断言 | 验证方式 |
|---|---|
| README 配置表 17 键与默认值 | 脚本比对 `DEFAULT_CONFIG`，missing/extra/mismatch 全为 0 |
| `stats.patches` 有 5 项 | 真实进程 `stats.get` 返回 5 项 |
| `stats.memoryBudget` 存在 | 同上 |
| 冷读 ~3.0 s | 同上，实测 2990 ms |
| 配置键 17 个 | 同上，`config.get` 返回 17 键 |
| 「插件日志默认不可见」 | 真实进程启动日志里 `dsh-perf` 行数为 **0**，而插件工作正常 |
| 全部 markdown 相对链接 | 脚本检查，0 dead |

### 关于 `retired` 状态

v1.10.0 的 CHANGELOG 说「保留该状态是因为未来某个补丁退役时还要用」。重写文档时
核实：**当前没有任何代码路径会设置它**。已在 ARCHITECTURE §5.3 写明这一点，并注明
「如果长期无人使用，可以在未来的大版本里删掉」——不再把它当作已有功能的描述。

## [1.10.0] — 2026-11-11 — ⚠️ 重要（破坏性）

**结构调整版。没有新增优化能力，只做减法与去重——并修掉一个藏了两轮的 bug。**

### Fixed

- **`api.js` 的晚绑定 bug（真实功能失效，不是风格问题）**：`installApi` 在装配时
  解构 `backfill` 与 `retrimPreparedCache`，但这两个值是别的模块在装配**之后**才写
  进共享 `pc` 的。因为 `installApi` 走 `ctx.inject(['webServer'])` 懒装配（webServer
  早于 `sessionPersistence` 就绪），解构到的是 `undefined` 且永不更新：
  - `config.set` 改 `preparedCacheSize` **不重裁**；
  - 打开 `backfillOnBoot` **不补跑扫描**。

  现在 `api.js` 通过 `runtime.backfill.get()` 在**每次请求时**取值。
  `tests/test_context.mjs` 复刻了失败现场（installApi 时 runtime 为空、之后才登记），
  断言补跑确实被触发（`scanCalls=1`），反向也验了「定时器未触发时不补跑」。

### Added

- **`lib/context.js`**：把共享 `pc` 拆成 `deps`（构造时全部就绪、`Object.freeze`
  的只读依赖）与 `runtime`（晚绑定槽）。只有需要晚绑定的 `api.js` 拿后者。
- **`lib/patch-target.js`**：方法替换样板归一。`resolveMethod` / `wrapMethod` /
  `sourceOf` 三个原语，统一了此前三处各写一遍且细节漂移的「判断自身属性 → 替换 →
  dispose 还原」。`sourceOf` 明确处理 cordis Proxy 把实例方法包成 `[native code]`
  的问题。
- **`lib/constants.js`**：魔法数字具名（`BACKFILL_DELAY_MS` / `API_BODY_LIMIT_BYTES` /
  `FOLD_GUARD_ITERATIONS` / `BYTES_PER_EVENT` / `DEFAULT_MEMORY_BUDGET_BYTES`）。
- **`lib/yield.js`**：`makeYieldLoop` 从 `runtime.js` 迁出——`runtime.js` 从此只放
  dsh 兼容垫片。
- **`stats.memoryBudget`**：内存预算的实时快照挂到 stats 上（`cachedEntries` /
  `estimatedBytes` / `budgetBytes`）。原先挂在 `pc.memoryBudgetStats` 上，但**没有
  任何调用方读取**，属于不可达的观测面。
- `tests/test_context.mjs`（12 断言）、`tests/test_patch_target.mjs`（25 断言）。

### Removed

删除三项在 dsh 0.2.2 上恒不生效的能力，共 262 行 + 3 个测试套件：

| 能力 | 行数 | 移除依据 |
|---|---:|---|
| 分片投影预热（`warmup`） | 145 | 恒 `alreadyHot`——上游在 `session/created` 同步广播里已把 29 个 cell 建满 |
| fast initFor | 65 | 依赖的 `persistence.coordinator` 在 0.2.2 已不存在（全包 `grep -c coordinator = 0`），恒 `inactive` |
| 冷会话 LRU 裁剪 | 52 | 同上 |

连带清理：配置键 22 → 17（删 `warmupEnabled` / `warmOnCreated` / `fastInitFor` /
`preparedCacheTrim` / `preparedCacheSize`）；stats 删 `warmed` / `skipped` /
`aborted` / `alreadyHot` / `warmRecent` / `recordWarm`；`session-walk.js` 在实现中途
被判定为过度设计（删掉 warmup 后 `activeRegistrations` 只剩一个消费者，而那个消费者
一行 `filter` 就够）并移除。

**保留 `retired` 状态**：虽然当前没有能力会走到它，但它是「上游吸收能力后补丁主动
让位」这一语义的唯一表达，未来某个补丁需要退役时还要用。

### Changed

- 所有模块签名从 `install(pc)` / `install(pc, ictx)` 改为 `install(deps)` —— `ctx`
  已在 `deps` 里，不再需要第二个参数。
- 三处补丁（`chunked-materialize` / `cold-writeback` / `memory-budget`）改用
  `wrapMethod`，**dispose 语义因此统一**：原型方法 → `delete` 自有属性回落原型；
  自有属性 → 写回原函数。此前 `fast-init-for` 直接 `delete` 不保留原值，是漂移的证据。
- `config.chunkSize` / `chunkYieldMs` / `minEvents` 的注释从「预热专用」改为
  「分片遍历的通用参数」——它们实际由 `backfill` 与 `coldWriteBack` 使用。
- 文档同步：README 能力表删三行、配置表 22 → 17 键；ARCHITECTURE 的第 2 节改为
  「已移除」并保留它留下的两条硬性知识（cell 形状、`init(header, cut)` 签名）；
  RUNTIME-ANALYSIS 的场景 C 标为历史记录；COMPATIBILITY 修正 `KNOWN_runtime_VERSIONS`
  → `KNOWN_DSH_VERSIONS` 的错名。

### 结构改善的量化

| 指标 | 1.9.0 | 1.10.0 |
|---|---:|---:|
| `lib/` 行数 | 1957 | **1836**（净减 121，删 262 加 141） |
| 模块数 | 15 | 15（删 3 加 3） |
| 配置键 | 22 | **17** |
| 测试套件 | 11 | **10** |
| 断言数 | 228 | **206** |
| `lib/` 内部 import 边 | 0（全靠 `pc` 隐式） | **6**（`constants` / `context` / `patch-target` / `yield` / `cache-identity` 被显式引用） |

### 未做的事

- **没有收紧 `engines.dsh`**。删除 warmup 后 0.1.x 上可用的能力只剩零拷贝 fork 与
  分片 materialize，但两者都带特征校验、不匹配会自动跳过。收紧到 `>=0.2.0` 是独立
  的破坏性决定（会主动拦住仍能用的用户），已在 README「已知限制」里如实写明，留待
  单独决策。
- **没有合并 `backfill` 与 `cold-writeback` 的折叠循环**。两者的数据来源不同
  （前者逐行流式解析日志，后者已有事件数组），强行合并会引入条件分支而不减少复杂度。

## [1.9.0] — 2026-11-11 — ⚠️ 重要（性能）

**空间维度的第一轮：把事件缓存从「按条数限容」改成「按字节限容」。**

### 静态 + 动态分析（`docs/MEMORY-ANALYSIS.md`）

dsh 有 **5 处**会持有完整事件数组 / 整棵事件树，其中 3 处按「会话条数」限容，
**没有一处按字节**：

| 位置 | 容量 | 按字节 |
|---|---|---|
| `SessionObservationReader.cache` | 5 条 | ✗ |
| `JsonlSessionPersistence.coldLogMemo` | 2 条 | ✗ |
| `Session.log` + `eventsSnapshot` | 每 live 会话一份 | — |
| `migrationPreparations` | 任务结束即删 | — |
| `SessionProjectionCache` rows | 无上限（单行可达 9 MB） | ✗ |

实测一份 24 万事件树：18.1 MB（zstd）→ 73.8 MB（解压文本）→ **87.7 MB（堆对象）**，
约 **5 倍**膨胀。真实 dsh 进程里：

| 步骤 | RSS |
|---|---:|
| 启动后（未读会话） | 388 MB |
| 读 1 个大会话 | 630 MB（清掉中间产物后 463 MB） |
| 再读 5 个不同大会话 | **1209 MB** |
| 读满 12 个 | 1324 MB（5 条上限生效，不再线性涨） |

即 **936 MB 常驻缓存**，而 `D:\dsh` 里真实存在 52 MB 的会话（单份 250 MB+）。

### Added

- **`lib/memory-budget.js`** + `memoryBudgetBytes` 配置键（默认 512 MiB，`0` 关闭）：
  - 包装 `sessionQuery._observations.store`，每次插入后按估算字节总量淘汰；
  - 同样处理 `persistence.coldLogMemo`（包装 `decodeStoredLog`）；
  - 估算用 `events.length × 400 B`（实测 365 B/事件，留余量）；
  - **只删 `refs === 0` 的条目**（与上游 `evictPastCapacity` 同一判据）；
    全部被 pin 时允许暂时超预算并计数；
  - 条数上限保持原样，两者取先触发者。
- `stats.memoryBudgetTrimmed` / `memoryBudgetFreedBytes` / `memoryBudgetOverBudget`。
- `tests/test_memory_budget.mjs`（19 断言）：未超预算不动、超预算按字节淘汰到
  预算内、MRU 保留、最旧先删、pinned 存活、超预算计数、预算 0 关闭、
  服务缺失不抛、dispose 还原、统计接口。
- `verify_compat` 新增 5 条断言：两处缓存的可达路径、上游确实只按条数限容、
  插件只删未 pinned 的条目、默认值与关闭语义。

### 实测效果（预算 128 MiB，8–12 个 18 MB 会话反复读 36 次）

| 配置 | 稳态 RSS |
|---|---:|
| 无字节预算（仅 5 条上限） | 1209 – 1324 MB |
| **字节预算 128 MiB** | **690 MB** |

36 次读累计淘汰 86 个条目 / 7874 MB 估算。GC 运行后 RSS 会掉到 372 MB ——
说明引用确实解除了，只是 V8 不保证立刻归还 OS。

代价：被淘汰的会话下次打开要重新解码 + 折叠。1.8.0 之后这一步是 3 秒而非 21 秒，
所以「用重折换内存」现在划算了。

### 明确不做

- **驱逐 live session**：`ctx.sessions` 没有安全接口，强删会破坏 agent 生命周期。
- **压缩 `Session.log`**：事件树是 `shared-frozen` 且被多处共享引用，替换会破坏
  identity 语义。
- **投影缓存行瘦身**：9.14 MB 里 `turnOutline` 占 6.45 MB，但改它要破 wire schema，
  会改变客户端跳转语义。本轮只在文档里记录这个成本。
- **空闲时主动驱逐**：属于「按需回收」，比「限容」复杂且需要触发时机，留待后续。

## [1.8.0] — 2026-11-11 — ⚠️ 重要（性能）

**冷读 21.2 秒 → 3.0 秒（7×）。** 前两轮都在猜瓶颈且猜错；这一轮先做归因，
结果指向一个此前完全没怀疑过的地方：**单个投影单元的二次复杂度**。

### 归因（场景 H，24 万事件 / 30 000 turn）

| 段 | 耗时 | 占比 |
|---|---:|---:|
| `open()` + `read()` 解码链路 | 1650 ms | 7.8% |
| `Session` 构造（信封 + surface） | 166 ms | 0.8% |
| 投影折叠 | 16728 ms | 78.9% |
| ├ **`turnOutline`** | **16061 ms** | **75.8%** |
| └ 其余 28 个单元合计 | 667 ms | 3.1% |

`turnOutline` 的 `apply` 每次 `turn/start` 执行 `turns: [...state.turns, next]`、
每次 `user/message` / `turn/end` 执行 `turns: [...state.turns.slice(0, -1), fixed]`
——**整数组复制**，N 个 turn 是 O(N²)。实测：5 000 turn 87 ms、10 000 turn
439 ms、20 000 turn 5238 ms（线性等价实现对应 2 / 12 / 7 ms，2 万 turn 时
上游慢 **701 倍**）。

> **纠正 v1.7 的错误结论**：v1.7 说「折叠循环 0 次迭代、16 秒在日志→内存事件数组」。
> 那只在缓存行命中时成立。真实冷读（空缓存）里折叠是绝对大头，解码链路只要 1.4 秒。

### Added

- **`lib/fast-turn-outline.js`** + `fastTurnOutline` 配置键（默认 `true`）：
  用 O(N) 等价 fold 替换 `turnOutline` 的 `def.apply`。
  - `preview` 逐字复刻上游（`limit*2` 提前截断、空白压缩、省略号规则，
    prompt 50 / response 120）；
  - fold 逐 case 复刻（turn 号不递增则忽略、只取第一条 user 消息、空白 prompt
    不写入、assistant draft 覆盖、`turn/end` 提交）；
  - **安装前跑运行时等价探针**：15 条覆盖全部分支的合成事件流，分别跑上游
    `apply` 与我们的 fold，`JSON.stringify` 结果必须相等，否则不上线。
    原因是拿不到原始源码——投影注册表把 `definition.apply` 包成了
    `(state, event) => definition.apply(state, event)`。
- `tests/test_fast_turn_outline.mjs`：11 组 preview 边界 + 逐字段 fold 比对 +
  三条边界 + 性能断言（6 000 turn 时至少 10 倍）。
- `tests/bench_cold_read.mjs`：分段归因基准（解码 / 解压 / 解析 / 深冻 /
  Session 构造），可复算。
- `verify_compat` 新增 5 条断言：上游仍是二次实现、preview 上限未变、
  我们的实现与之对齐、等价探针存在、`def.apply` 是转发包装这一事实。

### Changed

- **README 能力表把「turnOutline 折叠加速」列为首项**，并删掉 v1.7 那条
  「瓶颈不在投影折叠」的错误结论。
- `docs/RUNTIME-ANALYSIS.md` 新增场景 H（完整归因 + O(n²) 证据 + 修复实测），
  并把结论摘要的第二条改写为「76% 是单个投影单元的 O(n²)」。
- 配置键 20 → 21。

### 评估后放弃的方案（记录以免重复投入）

- **worker thread 移出解析**：分段归因证明它只能拿走解码链路的 6.4%
  （1.4 s 中的一部分，还要付跨线程复制成本），而 76% 在投影折叠上、worker
  拿不走。上一版计划的三条准入条件第一条（decode > 10 s）实测就不成立（1.36 s）。
- **帧索引**：帧扫描实测只占 0.6 ms；`open()` 一次就把 29 帧全解压完，
  且当前没有任何消费者按非零 offset 读。
- **事件瘦身**：`dsh-compaction-tool-result-pruner` 只在上下文压力时裁剪，
  且原始结果完整保留在日志里，日志体积不变。

### 下一步（若还要再压）

剩余 3 秒的构成：解码 1.65 s + 其余 28 个单元 0.67 s + 线性 fold 0.1 s + HTTP。
按成本排序：逐个检查其余单元的 `apply` 是否有同样的二次写法（本轮只测了
`turnOutline`）；解码那 1.65 s 只能靠 worker 或帧索引，上限 1 秒。

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

完整数据、方法与测量边界见新文档 [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md)。

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

## [1.3.0] — 2026-10-11 — ⚠️ 重要（破坏性）

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

## [1.0.0] — 2026-08 — 首个版本

### Added

- 合并 fork-perf 与 projection-warmup 两个插件为单一插件：
  - 零拷贝 fork（fork 时跳过逐事件深拷贝）
  - 投影分片预热（消除历史会话首次冷折叠的事件循环冻结）
  - fork 缓存回填
  - 分片 materialize（多帧 zstd，消除单巨字符串 / RangeError）
- 全部补丁带源码特征校验 + 三层回退（能力探测 / try-catch / 配置开关）。
