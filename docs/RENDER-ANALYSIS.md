# 渲染链路分析

浏览器侧「打开一个长会话为什么慢」的完整测量。服务端冷读、内存与 fork 在
[MEASUREMENTS.md](MEASUREMENTS.md)；本文只负责**渲染链路**，并且是这一类数字的
唯一 owner（见 §12）。

## 1. 范围与问题

Q1 首屏字节花在哪（§5）· Q2 导航到首行的时间构成（§6）· Q3 批量翻页为何到秒级（§7）·
Q4 回合跳转为何到分钟级/崩溃（§8）· Q5 containment 是否造成滚动跳变（§9）·
Q6 markdown / KaTeX / 高亮本身多贵（§10）。

## 2. 测量条件

| fixture | 规模 | 首屏（50 条消息） | 用途 |
|---|---|---|---|
| `session-probe-long` | 240 000 事件 / 30 000 turn | 73 771 B 消息 + 6 761 101 B 投影 | Q1 Q2 Q4 |
| `session-probe-heavy` | 300 turn / 620 次工具调用 | 1 733 791 B 消息 + 68 265 B 投影 | Q1 Q7 |
| `session-probe-md` | 300 turn，markdown + 公式 | 100 行 / 183 个 KaTeX 节点 / 101 个代码块 | Q6 |
| `plain300` | 300 turn，纯文本 | 100 行 | Q6 对照 |

```sh
node tools/runtime-probe/make-session-cli.mjs --home "$RT/home" --id session-probe-long --events 240000 --pad 700 --cwd 'F:\dsh-rt\probe-workspace'
node tools/runtime-probe/make-session-cli.mjs --home "$RT/home" --id session-probe-heavy --turns 300 --profile tools --tool-bytes 30000 --seed 42
node tools/runtime-probe/make-session-cli.mjs --home "$RT/home" --id session-probe-md --turns 300 --profile markdown --seed 42
node tools/runtime-probe/make-session-cli.mjs --home "$RT/home" --id plain300 --turns 300 --profile plain --seed 42
```

- 被测 dsh：安装包 `0.2.2-rc.2`、运行时探针 `0.2.2-rc.1`（[COMPATIBILITY.md](COMPATIBILITY.md)）。
  环境：Windows 10.0.26200、Node 24.14.1、Chromium（内置浏览器）、隔离 home、1280×720。
- **运行隔离协议**：每个测量开新标签页；上一个页面超过 20 000 行则弃用下一次读数；
  重负载后静置 ≥5 s 让 GC 跑完。除 §6 方差说明外，所有表格都是 n=1，**单次值不是
  「典型值」**。
- 两个 fixture 都是合成的：工具输出按真实编码 agent 的字节分布构造（bash 日志 /
  文件读 / unified diff），但不是真实回放。绝对值只作量级参考，比例与机制才是结论。

## 3. 指标定义

```
nav ─▶ streamOpen ─▶ startedAt ─▶ server.t ─▶ frameStamp ─▶ firstItem ─▶ firstRow ─▶ settle
        请求腿        服务端产出      响应腿       本地派发      组装挂载
 └──────────── 五段 = streamOpen → firstRow 的精确划分 ────────────┘
nav → streamOpen 是推导值，未直接测量。
```

- **五段是 `streamOpen → firstRow` 的精确划分**：请求腿 `server.startedAt - streamOpen`、
  服务端 `server.t - startedAt`、响应腿 `frameStamp - server.t`、派发
  `firstItem - frameStamp`、挂载 `firstRow - firstItem`。五段之和恒等于窗口总长，
  没有「未归因」残差。
- `streamOpen` / `firstItem` 来自对 `remote.$stream` 的包装；`firstRow` 在
  MutationObserver 回调（微任务）里同步记录。
- `frameStamp` 用 **`event.timeStamp`**，不是监听器执行时刻：应用自己的 message
  监听器可能先同步解析完 6.8 MB 帧，期间还有微任务检查点（实测差 224 ms）。
- 长任务用 `long-animation-frame` 的 **`blockingDuration`**，不用 `duration - 50`
  （会系统性高估）。心跳是 `setTimeout(100)` 的滞后代理，只用于相对比较。
- 字节是 UTF-8 JSON 字节（`Buffer.byteLength`）。载荷用 B / MB=10⁶；堆是
  `usedJSHeapSize / 2²⁰`，文中标签写 MB，实为 MiB。

## 4. 静态链路

| # | 事实 | 位置 | 什么会推翻它 |
|---|---|---|---|
| 1 | 聊天流水线**无虚拟滚动**，`entries.map()` 渲染全部已加载行 | `dsh-client-ui-chat/src/client/chat/ChatFlow.tsx` | 上游引入窗口化/虚拟列表 |
| 2 | 客户端请求 `maxMessages: 500`，但 `turnWindow.minMessages: 50` 先触发 | `dsh-api-session-controller/src/client/sessions/session.ts`、`src/history.ts` | 上游调整 turnWindow 默认值 |
| 3 | `loadOlder` 只增不减，每页再 +50 条 | 同上 `history.ts` | 上游加窗口淘汰 |
| 4 | 分页只看消息条数，无字节/事件数上限；`paginate` 只做 `slice` | `src/history.ts` | 上游给 paginate 加字节上限 |
| 5 | 每次结构变化都 `O(N log N)` 排序并重映射全部行 | `dsh-client-ui-conversation/.../chat-snapshot-builder.ts` | 上游改增量排序 |
| 6 | `replaceWindow` 全量重建：清 map、排序、逐事件 `matchInput` | `.../conversation/assembler.ts` | 上游改增量替换 |
| 7 | 已结算 markdown 与 KaTeX **无缓存** | shell bundle `lib/types/markdown/render.js` | 上游加 LRU |
| 8 | 行容器 `.flowItem` 无 `content-visibility` | `dsh-client-ui-chat/src/client/chat/ChatView.module.css` | 上游自己加 containment |
| 9 | 服务端每次分页都物化整个日志（`snapshotEvents()` 全数组拷贝） | `dsh-session/src/index.ts` | 上游改按需切片 |
| 10 | 投影快照随每帧下发，`turnOutline` 含全部 turn | `dsh-session-turn-outline/src/projection.ts` | 上游改按需分页 |

`tests/verify_compat.mjs` 对 1/2/4/8/9 有断言锁住。上游一旦做虚拟化或加字节上限，
本节与相应插件能力应一起退役。

## 5. 打开载荷

| 项 | 长会话 | 重会话 | 来源 |
|---|---:|---:|---|
| 记录数（事件） | 231 | 311 | `records.length` |
| records 字节 | 73 771 | **1 733 791** | `Buffer.byteLength(JSON.stringify(records))` |
| projections 字节 | **6 761 101** | 68 265 | `Buffer.byteLength(JSON.stringify(projections))` |
| 服务端冷/热读 | 1 916 / 14 ms | 235 / 60 ms | 首次 / 同进程第二次 `session/events` |

**两条不同的主导项**：长会话里投影是消息的 **91×**；重会话里消息是投影的
**25×**。想压首屏字节，必须先分清面对的是哪一类——这也是保留两个 fixture 的
唯一理由。长会话的 6.76 MB 几乎全是 `turnOutline`；同一秒里的 `session/control`
基线是 6 762 693 B，与 follow 首帧相邻（§6 的写队列等待由此而来）。

## 6. 打开延迟

### 五段归因

| 段 | 热读 | 冷读 | 计算 |
|---|---:|---:|---|
| 请求腿 | 43–76 ms | 73 ms | `startedAt - streamOpen` |
| 服务端产出 | 3–52 ms | **1 937 ms** | `server.t - startedAt` |
| 响应腿 | **481 ms** | **1 725 ms** | `frameStamp - server.t` |
| 本地派发 | 7–35 ms | 7–35 ms | `firstItem - frameStamp` |
| 组装挂载 | 100–260 ms | 100–260 ms | `firstRow - firstItem` |
| **合计** | **634–904 ms** | **3 842–4 030 ms** | `firstRow - streamOpen` |
| 导航 → stream open（推导） | 0.70–0.97 s | 0.57–0.76 s | `navToFirstRow - 合计` |
| 导航 → 首行 | **1.6 s** | **4.6 s** | 外部墙钟 |

冷读是进程内第一次；热读是同 socket、同进程。五段之和恒等于 `streamOpen → firstRow`，
**没有「未归因」残差**；与 `nav → 首行` 的差额是未直接测量的「导航 → stream open」。

响应腿再拆（`ws.send` 回调；同机同载荷）：

| 情形 | 写队列（`server.t → send`） | deflate + 写入（`send → 回调`） | 网络 + inflate（`回调 → 帧到达`） | 合计 |
|---|---:|---:|---:|---:|
| 热读（6.84 MB，紧跟 control） | **174 ms**（等 control 写完） | 207 ms | ~100 ms | **481 ms** |
| 冷读（6.84 MB，刚折叠完 1.94 s） | 73 ms | **1 493 ms** | ~159 ms | **1 725 ms** |

1. **deflate 在冷读后慢 7×**：孤立 benchmark 214 ms、热读 207 ms、冷读后 1 493 ms
   （libuv zlib 线程池与折叠/GC 抢 CPU）。
2. **写队列跨流串行**：control（6.76 MB）的 send 回调一结束，follow 的 send 才被调用；
   热读的 174 ms 精确等于 control 写耗时（379 ms）的尾部，`stream-server` 的
   `this.writes` 只有一个队列。

另一轮冷读落在 4.6–7.4 s 区间（页面装载 0.7–1.6 s、服务端折叠 1.9–2.5 s）。
那一轮没有拆五段，**不再引用它的分段**；它只说明 run 间方差（§12）。

## 7. 翻页与批量发布

| 指标 | 值 |
|---|---:|
| 每页事件 / 字节 | 200 / ≈70 KB |
| 服务端耗时（warm） | 0.3–0.6 ms |
| 单页挂载长任务 | **0 个**（≥50 ms 的没有） |
| 堆增长 | 65 → 109 MiB（600 行）≈ **73 KiB/行** |

堆的 73 KiB/行是**600 行区间的增量**；§8 的 728 MB 是 20 100 行的**总量**，两者不能互算成斜率。

单页无压力，问题在**批量发布**：快速连续翻 10 页（每 250 ms 一次），客户端把多页
合并成一次结构更新，一次性挂载上千行：

| 配置 | 新增行 | 长任务 | 总阻塞 | 最长任务 |
|---|---:|---:|---:|---:|
| 无 `content-visibility` | 100 → 1 000 | 11 | **2 836 ms** | 416 ms |
| 有 `content-visibility` | 100 → 1 100 | 18 | **1 489 ms** | 244 ms |

> 对照**不是严格控制**：两轮行数差 100（1 000 vs 1 100），阻塞差 47% 远大于行数差，
> 但绝对值应按「同量级」而不是「精确 −47%」引用。

`content-visibility` 是本插件唯一有实测收益的客户端优化，因此默认开启。它把批量
发布的主线程阻塞砍到约一半，但不改变「一次发布 N 行」这个上游行为。

## 8. 回合跳转

点回合导航到未加载的早期 turn 会触发 `loadThrough`：逐页回翻、**全部攒完才发布
一次**。重会话（300 turn，跳到 turn 1，n=1）：

| 侧 | 指标 | 值 |
|---|---|---:|
| 服务端 | burst 聚合 | 3 页 / 3 330 事件 / **18.3 MB** / 2.0 ms（热读） |
| 客户端 | 行数 / turn 范围 | 125 → **1 500**（+1 375）/ 276–300 → 1–300 |
| 客户端 | 装载 → 首次可见 | 2 129 ms |
| 客户端 | 装载 → 稳定 | 3 271 ms |
| 客户端 | 长任务 / 阻塞 / 最长 | 3 个 / **1 723 ms** / **1 575 ms** |
| 客户端 | 心跳最大滞后 | 1 917 ms |

长会话（30 000 turn）的阶梯跳转：

| 目标 turn | 行数变化 | `loadMs` | 最长任务 | 总阻塞 |
|---|---:|---:|---:|---:|
| 29 900 | 100 → 500 | 558 ms | 576 ms | 603 ms |
| 29 500 | 500 → 2 100 | 1 732 ms | 1 782 ms | 1 982 ms |
| 29 000 | 2 100 → 4 100 | 2 275 ms | 2 293 ms | 2 940 ms |
| 25 000 | 4 100 → **20 100** | —（窗口被下一轮覆盖） | — | —（堆 **728 MiB**） |

**边际阻塞斜率递减**：1.51 → 0.86 → 0.48 ms/行（603/400、1 379/1 600、958/2 000）。
它对应的 `loadMs`/新增行是 1.40 / 1.08 / 1.14。**第 4 步没有阻塞样本，所以不对
20 100 行以上做任何外推**；「60–70 s / 2 GB」是已被实测推翻的旧外推（§12）。

**跳到 turn 1（最极端点，n=1）**：干净页面上直接 `jumpToTurn(1)`。服务端**成功**：
300 页 / 239 800 事件 / **83.4 MB**，聚合记录 85 ms。客户端随后卡住约 **140 秒**，
之后标签页被浏览器重载（`pageNow` 回到 31 s、`jumpSamples` 归零、行数回到 100）。
结局不是「慢几分钟」，而是**渲染进程被 OOM 杀掉后重载**。停止条件定在
`rows > 20 000`，正是因为再往下不是「更慢」而是「可能崩溃」。

> 服务端 burst 判据是「连续 `older` 页间隔 < 1 500 ms」。客户端也有 `kind:'jump'`
> 样本，但它只标记 `data-chat-history` 的 loading 窗口，自动补页同样会触发；
> **是不是一次 `loadThrough` 以服务端 burst 为准**。

## 9. 滚动

`content-visibility` 的已知风险是占位高度造成锚点漂移（CSSWG #9833）。固定轨迹
（顶 → 底 → 顶）逐帧采样 `scrollTop`，并比较同一锚点行的屏幕位置：

| 配置 | 单帧最大位移 | 方向反转 | 锚点漂移 | `scrollHeight` 变化 |
|---|---:|---:|---:|---:|
| containment 开 | 191 996 px（整篇跳） | 4 | **22 px** | 0 |
| containment 关 | 210 166 px（整篇跳） | 1 | **22 px** | 0 |

两者漂移相同（22 px ≈ 视口高度的 3%），`scrollHeight` 变化都为 0——**没有观察到
containment 造成的额外跳变**，默认值维持开启。22 px 的来源未拆解（可能是估算
高度在滚动中被真实高度替换）。

**滚轮路径**：真实滚轮（3 次 × −1500 px）后，样本带 `intentional: true`，
且不再报 `jump`：

| 手势 | maxFramePx | intentional | jump |
|---|---:|---|---|
| 打开后自动滚到底（程序化） | 16 683 | false | **true** |
| 用户滚轮 −1500 ×3 | 3 146 | **true** | **false** |

判定要求「单帧位移 ≥ 半个视口 **且** 最近 300 ms 没有输入意图」。程序化整篇跳与
真实滚轮只覆盖「有没有意外跳变」；**主观顺滑度仍需人工**（§12 开放项）。

## 10. 内容成本

`__dshPerf.benchMarkdown({text, iterations})` 在页面里跑四个引擎，样本 1 476 字符 /
4 个围栏 / 4 个公式：

| 操作 | 实现 | 每次 |
|---|---|---:|
| 解析 | `extractMarkdownPlainText`（GFM，无 math） | **7.46 ms** |
| 建元素 + commit | `MarkdownText` 挂到分离容器（无布局、无视口高亮） | **23.9 ms** |
| KaTeX | `FenceMathBlock`（`renderToString` + `DOMParser`） | **1.28 ms / 式** |
| shiki tokenize | `useCodeHighlighter` 回调（绕开视口门控） | **3.5 ms / 145 字符** |

单条 1.5 KB 消息的 render 约 **24 ms**，其中解析只占 7.5 ms；大头是 React 元素
创建与 commit。公式 1.3 ms/个、代码高亮 3.5 ms/块另算。

> **per-op 与 per-row 没有调和。** 50 条可见消息 × 24 ms ≈ 1.2 s，但实测挂载
> 任务是 300–560 ms。差异来自「不是所有消息都可见/都含公式」、React 批处理与
> 流式重解析——**不要用 op 表乘行数来预测端到端时间**。

端到端 A/B（300 turn）：`session-probe-md` 首屏 100 行里 183 个 KaTeX 节点 +
101 个代码块，挂载最长任务 **330 ms**；`plain300` 同规模 **359 ms**——差异小于
run 间波动（§12）。离屏代码块**永远不会高亮**（`CodeBlock` 的 `IntersectionObserver`
门控），所以分离容器的 `renderMs` 不含 shiki；`renderIncludesHighlight: false`
就是这个含义。

## 11. 瓶颈排序

1. **投影载荷**——长会话占首屏字节 99%，6.76 MB/次打开，不随窗口大小变化。
2. **批量挂载**——`loadThrough` 一次挂 1 375 行 / 阻塞 1.7 s（§8）；`loadOlder`
   的合并发布同理。**唯一能把等待推到分钟级的路径**。
3. **服务端首帧**——热读 3–52 ms；冷读 1.9 s（投影折叠 + 大载荷序列化）。
4. **帧编码与写队列**——本帧 deflate 207–1 493 ms；排在 control 基线后面再等
   174 ms（§6）。
5. **markdown 渲染**——1.5 KB 消息约 24 ms（解析 7.5 ms），随可见内容增长（§10）。
6. **首屏消息窗口**——长会话 74 KB 可忽略；重会话是主导项，但 50 条已是最小
   可用窗口，不值得再收紧。

- **插件能力** —— `renderTiming`（关）：五段归因、LoAF、跳转/滚动窗口、markdown 微基准（§6 §8 §9 §10）。
- `clientContainment`（开）：批量翻页阻塞 2 836→1 489 ms；未测到滚动漂移（§7 §9）。
- `maxInitialMessages`（关）：长会话 ≤0.5% 字节；重会话可减半首屏（§5）。
- `maxPageBytes`（关）：长会话 70 KB/页；重会话 1.7 MB/页，按需开启（§5 §7）。

`lib/render-timing.js` / `lib/history-budget.js` 只在配置打开时安装；`lib/client.js`
的 CSS 只在 `clientContainment=true` 时注入，`$stream` 钩子与 WS 帧监听只在
`renderTiming=true` 时安装，并有 `__dshPerf.stop()` / `pagehide` 生命周期终点。

### 够不到的上游问题（按收益排序）

1. **`turnOutline` 不要全量下发**：回合导航只需「最近 N 个 + 按需分页」。
2. **`loadThrough` 不要合并发布**：逐页提交，配合虚拟滚动把挂载量钉在视口附近。
3. **control 与 follow 不要共用串行写队列**：control 基线本身可达 6.8 MB。
4. **冷读后不要立刻做大帧 deflate**：让帧编码与折叠错峰，或换独立线程池。
5. **给 `paginate` 加字节上限**：现在只按消息条数切页（重会话单页 1.7 MB）。
6. **已结算 markdown 加 `(text, labels)` LRU**：每次重渲染都重新 parse。

## 12. 有效性、复现与撤回

**边界**：单机、单次运行（除注明的 n），绝对值不可跨机比较；合成素材的压缩比接近
真实会话但不是回放；堆是 `performance.memory` 采样值（GC 影响 ±10%）；五段的 T0 是
`streamOpen`，差额是未直接测量的「导航 → stream open」；未做跨机器、真实人手滚动的
主观评分、多标签页并发与 `turnOutline` cell 的独立堆占用。

**复现索引**：`run.mjs --scenario H,I` + `__dshPerf.state()` 复现载荷/延迟；
`bench-encode.mjs` + `stats.render.sends` 复现响应腿；`jumpToTurn(n)` 与
`stats.render.pages` 的 `kind:'jump'` 复现跳转；`scrollTest({rounds})` 与 CUA 滚轮
复现滚动；`benchMarkdown({text, iterations})` 复现内容成本。

### 撤回表

| 旧说法 | 为什么撤回 | 现在用什么 |
|---|---|---|
| 响应腿 ~500 ms 是浏览器解压 | 浏览器解析只 7–35 ms | deflate 207–1 493 ms + 写队列 174 ms |
| 响应腿 658 / 2 313 ms | 未拆分 run 的值，且与分段和不闭合 | 481 / 1 725 ms（拆分后可逐项相加） |
| 30k turn 跳 turn 1 要 60–70 s / ~2 GB | 外推；实际 OOM 重载 | §8 的 turn 1 实测（n=1） |
| 堆增长 36 KB/行 与 73 KB/行 混用 | 前者是总量÷行数，后者是 600 行增量 | 分开标注，不互算 |
| 缓存行命中 0.26 s / 冷读 16.6 s | 同进程 live 读，不是跨进程冷读 | [MEASUREMENTS.md](MEASUREMENTS.md) §1.3 |
| 打开 7.4 s 是当前头条 | 是另一轮冷读，T0 与负载都不同 | 热 1.6 s / 冷 4.6 s（§6） |
| 五段「完全闭合」2.9 s | 五段只覆盖 `streamOpen→firstRow` | 导航 → stream open 单列（§6） |
| 31 个投影单元 | 实际是 29 | [MEASUREMENTS.md](MEASUREMENTS.md) §1.2 |

### 数字归属

| 类别 | owner | 其他文档只许 |
|---|---|---|
| 浏览器/渲染全部数字 | 本文 | 引用 + 相对链接 |
| 服务端冷读 / RSS / fork | [MEASUREMENTS.md](MEASUREMENTS.md) | 同上 |
| 架构 | [ARCHITECTURE.md](ARCHITECTURE.md) | 零数字，全改链接 |
| 头条 | [README.md](../README.md) | 每条带链接 |
| 历史 | [CHANGELOG.md](../CHANGELOG.md) | 按发布时，不追改正文 |
