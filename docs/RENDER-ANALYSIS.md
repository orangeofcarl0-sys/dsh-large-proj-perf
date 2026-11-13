# 渲染链路分析

「长对话打开要等很久」这件事，本插件此前从未测过：`docs/MEASUREMENTS.md` 里的
21.2 s → 3.0 s 全部是**服务端**冷读，浏览器侧没有任何埋点。本文补上这一段。

> **验证边界**
> - 被测 dsh：安装包 `0.2.2-rc.2`，运行时版本探针 `0.2.2-rc.1`（见
>   `docs/COMPATIBILITY.md`）。
> - 素材（两轴分开，见 §3.1）：
>   - `session-probe-long`：24 万事件 / 30 000 turn，**投影主导**（既有 fixture）；
>   - `session-probe-heavy`：300 turn、620 次工具调用、首屏 1.73 MB，**消息主导**
>     （v1.13 新增，`--profile tools`）。
> - 测量入口：`renderTiming=true` 后，服务端写 `stats.render`，浏览器写
>   `window.__dshPerf`（`state()` / `jumpToFirst()` / `scrollTest()`）。
> - 环境：Windows 10.0.26200、Node 24.14.1、Chromium（ZCode 内置浏览器）、
>   隔离 home、1280×720 视口。
> - **两个 fixture 都是合成的**。重会话的工具输出按真实编码 agent 的字节分布
>   构造（bash 日志 / 文件读 / unified diff），但内容不是真实回放；绝对值仍是
>   量级参考，比例与机制才是结论。这一点在 §6 单列。

## 1. 链路

```
浏览器打开会话
  └─ WS session/follow（唯一入口）
       ├─ 服务端：observeSession → 投影折叠 → paginate 切一页
       └─ 一帧 snapshot：header + projections(6.76 MB) + records(74 KB)
  └─ 浏览器：JSON.parse → 逐事件 assert → 组装成 conversation nodes
  └─ 全量挂载：ChatFlow 对**已加载的每一行** entries.map()
```

关键点：**服务端只发一个消息对齐的窗口，之后解析/组装/挂载全在浏览器**，
而挂载没有虚拟化——已加载多少行就渲染多少行。

## 2. 静态事实（逐条已核对源码）

| # | 事实 | 位置 | 影响 |
|---|---|---|---|
| 1 | 聊天流水线**没有虚拟滚动**，`entries.map()` 渲染全部已加载行 | `dsh-client-ui-chat/src/client/chat/ChatFlow.tsx:52` | 挂载量 = 已加载消息数 |
| 2 | 客户端请求 `maxMessages: 500`，但 `turnWindow.minMessages: 50` 先触发 | `dsh-api-session-controller/src/client/sessions/session.ts:54`；`src/history.ts:143-165` | 短 turn 会话真实首屏 ≈50 条 |
| 3 | `loadOlder` **只增不减**，每页再 +50 条 | 同上 `:432-481` | DOM 与堆单调增长 |
| 4 | 分页只看**消息条数**，无字节/事件数上限；`paginate` 只做 `slice` | `src/history.ts:132-167` | 工具输出密集时单页可到数十 MB |
| 5 | 每次结构变化都 `O(N log N)` 排序（`localeCompare`）并重映射全部行 | `dsh-client-ui-conversation/.../chat-snapshot-builder.ts:522-535` | 工具密集回合里每次新节点都付一次全量代价 |
| 6 | `replaceWindow` 全量重建：清 map、排序全窗口、逐事件 `matchInput` | `.../conversation/assembler.ts:251-272` | 重连/重同步 = 全部重新渲染 |
| 7 | 已结算 markdown **无缓存**，KaTeX 同样无缓存 | shell bundle `lib/types/markdown/render.js`、`katex.js` | 全量重渲染时全部重新 parse |
| 8 | 行容器 `.flowItem` 只有 `min-width: 0`，无 `content-visibility` | `dsh-client-ui-chat/src/client/chat/ChatView.module.css:100-104` | 离屏行仍参与布局/绘制 |
| 9 | 服务端每次分页读都物化整个日志（`snapshotEvents()` 全数组拷贝） | `dsh-session/src/index.ts:759-768` | 页请求前置成本与窗口无关 |
| 10 | 投影快照随每帧一起发，`turnOutline` 含**全部 turn** | `dsh-session-turn-outline/src/projection.ts:133-136` | 30k turn ≈ 6.7 MB/次打开 |

`tests/verify_compat.mjs` 对 1/2/4/8/9 有断言锁住——上游一旦做了虚拟化或加了
字节上限，本节与相关能力就该退役。

## 3. 动态实测

### 3.1 首屏载荷：6.76 MB 投影 vs 74 KB 消息

`tools/runtime-probe` 的 **scenario H**（长会话）与 **scenario I**（重会话）一起量。
两轴分开：长会话 30 000 turn、小消息（投影主导）；重会话 300 turn、工具输出
主导（消息主导）。

| 项 | 长会话（H） | 重会话（I） |
|---|---:|---:|
| 消息条数 | 50 | 50 |
| 记录数（事件） | 231 | 311 |
| records 字节 | 73 674 | **1 733 791** |
| projections 字节 | **6 761 101** | 68 265 |
| 服务端冷读 | 1 916 ms | 235 ms |
| 服务端热读 | 14 ms | 60 ms |

**两条不同的主导项**：长会话里投影是消息的 91 倍；重会话里消息是投影的 25 倍。
想压首屏字节，必须看你面对的是哪一类 —— 所以两个 fixture 都保留。

### 3.2 打开一个会话：五段归因

真实浏览器、单页单实例。`lib/client.js` 现在给每段打点，`lib/render-timing.js`
记服务端 `startedAt`（同机 `Date.now()`，可直接对齐），并用
`remote.streams.socket` 上的 `message` 监听器记 **`event.timeStamp`**——那才是
帧到达时刻；我们监听器的执行时刻可能落在应用解析完大帧之后（微任务检查点），
不能拿来归因。

**2026-11-13 的修正**：旧版把「服务端完成 → 客户端 item」笼统记成 ~500 ms 链路，
并怀疑是浏览器解压。实际拆开后，**大头的服务端自己的 `JSON.stringify` + deflate，
以及被 control 基线堵住的串行写队列**；浏览器的解析 + 派发只有 7–35 ms。

一次热读长会话（6.76 MB 投影）的五段：

| 段 | 计算 | 实测 |
|---|---|---:|
| 请求腿 | `server.startedAt - client.streamOpenAt` | **43–76 ms** |
| 服务端产出 | `server.t - server.startedAt` | 3–52 ms（热）/ 2 495 ms（冷） |
| 响应腿 | `client.frameStamp - server.t` | **658 ms**（热，6.8 MB）/ 2 313 ms（冷） |
| 本地派发（解析 + item） | `firstItemAt - frameStamp` | **7–35 ms** |
| 组装挂载（item → 首行） | 现有 marks | 100–260 ms |

响应腿再拆（`tools/runtime-probe/bench-encode.mjs`，同机同载荷）：

| 会话 | 帧字节 | `JSON.stringify` | deflate(level 1) | 合计 | Node inflate |
|---|---:|---:|---:|---:|---:|
| 长（6.76 MB 投影） | 6 835 041 | 51.5 ms | 213.8 ms | **265.4 ms** | 39.8 ms |
| 重（1.73 MB 消息） | 1 802 664 | 7.3 ms | 29.4 ms | **36.8 ms** | 8.2 ms |

剩下的响应腿时间去哪了？**被 `session/control` 基线堵住了，并且 deflate 在冷读后
明显变慢**。给 WS 帧加上 `streamId → endpoint` 归属、再 hook `ws` 的
`WebSocket.prototype.send` 回调后，响应腿拆成三段：

| 情形 | 写队列等待（`server.t → send 调用`） | deflate + 写入（`send → 回调`） | 网络 + inflate（`回调 → 帧到达`） | 合计 |
|---|---:|---:|---:|---:|
| 冷读（6.84 MB，服务端刚折叠完 1.94 s） | 73 ms | **1 493 ms** | ~190 ms | ~1 756 ms |
| 热读（6.84 MB，同一 socket 上紧跟 control） | **174 ms**（等 control 写完） | 207 ms | ~100 ms | ~481 ms |

两个关键事实：

- **deflate 在冷读后慢 7 倍**：孤立 benchmark 是 214 ms，热读 207 ms，冷读后
  实测 **1 493 ms**。libuv 的 zlib 线程池与服务端刚做完的折叠/GC 抢 CPU。
  这解释了为什么冷读响应腿会到 2.3 s，而热读只有约 0.5 s。
- **写队列是跨流串行的**：热读时 control（6.76 MB）的 send 回调一结束，
  follow 的 send 才被调用——队列等待 174 ms 精确等于 control 的
  deflate+写入时间（379 ms）的尾部。`stream-server` 的 `this.writes`
  只有一个队列。

一次热读长会话的相邻两帧：

```
send#1 queued 744655 → sent 745034   6 762 693 B   (control, 379 ms)
send#2 queued 745034 → sent 745241   6 835 203 B   (follow,  207 ms)
```

**结论**：`~500 ms` 已完全闭合。它不是浏览器解压，而是：

1. **本帧自己的 deflate**：热读 207 ms；冷读后 **1 493 ms**（线程池争用）；
2. **排在 control 基线后面等写**：热读 174 ms，精确对齐 control 的写耗时；
3. 浏览器解析 + 派发 7–35 ms（JSON.parse 6.8 MB ≈ 20–30 ms，V8 很快）；
4. 网络 + inflate 100–190 ms。

冷读响应腿 2.3 s 的构成因此是：写队列 73 ms + deflate 1 493 ms + 网络/inflate
190 ms。**问题在服务端 CPU 争用与串行写队列，不在客户端。**

### 3.3 翻页便宜，累积才是贵

同一会话向上滚动，每页 50 条消息：

| 指标 | 值 |
|---|---:|
| 每页事件数 / 字节 | 200 / ≈69 700 B |
| 服务端耗时（warm） | **0.3 – 0.6 ms** |
| 客户端新增行 | +100 |
| 单页挂载长任务 | **0 个**（≥50 ms 的没有） |
| 堆增长 | 65 → 109 MB（600 行）≈ **73 KB/行** |

单页无压力；问题在**批量发布**：快速连续翻 10 页（每 250 ms 一次），客户端把
多页合并成一次结构更新，一次性挂载上千行：

| 配置 | 新增行 | 长任务 | 总阻塞 | 最长任务 |
|---|---:|---:|---:|---:|
| 无 `content-visibility` | 100 → 1 000 | 11 | **2 836 ms** | 416 ms |
| 有 `content-visibility` | 100 → 1 100 | 18 | **1 489 ms** | 244 ms |
| 更早一轮（1 700 行时） | 700 → 1 700 | 23 | 1 894 ms | 302 ms |

**这就是「分钟级」的机制**：不是单页慢，是批量发布时把 N 页一次性挂载。行数
再往上翻倍，排序与重映射是 `O(N log N)` / `O(N)`，阻塞会继续涨。

`content-visibility` 把阻塞砍掉 47%、最长任务砍到 244 ms——这是本插件目前
唯一有实测收益的客户端优化，因此默认开启。

### 3.4 回合跳转：一次挂载 1 375 行

点回合导航到未加载的早期 turn 会触发 `loadThrough`：逐页回翻、**全部攒完才
发布一次**。测量（重会话，300 turn，跳到 turn 1）：

| 侧 | 指标 | 值 |
|---|---|---:|
| 服务端 | 聚合出的 jump | 3 页 / 3 330 事件 / **18.3 MB** / 2.0 ms（热读） |
| 客户端 | 行数 | 125 → **1 500**（+1 375） |
| 客户端 | turn 范围 | 276–300 → **1–300** |
| 客户端 | 装载 → 首次可见 | 2 129 ms |
| 客户端 | 装载 → 稳定 | 3 271 ms |
| 客户端 | 长任务 / 阻塞 / 最长 | 3 个 / **1 723 ms** / **1 575 ms** |
| 客户端 | 心跳最大滞后 | 1 917 ms |

一次跳转的主线程阻塞，是普通翻页的 50 倍以上。**这是「分钟级」路径的直接
证据**：行数与阻塞同向增长，30 000 turn 的会话跳到 turn 1 会把量级再抬一个
数量级（该极端情形未实测，只测了 300 turn）。

服务端 burst 聚合的判据是「连续 `older` 页间隔 < 1 500 ms」。单页普通翻页
不会记成 jump（`scenario J` 与单测都锁住了这条）。

> 客户端也有一条 `kind:'jump'` 样本，它标记的是「`data-chat-history` 进入
> loading 到行数稳定」的时间窗。自动补页同样会触发这个窗口，所以**判定
> 「这是不是一次 loadThrough」要以服务端的 burst 记录为准**，客户端样本只提供
> 时间与阻塞。

### 3.5 滚动跳变：containment 没有引入可测漂移

`content-visibility` 的已知风险是占位高度造成滚动锚点漂移（CSSWG #9833）。
用 `__dshPerf.scrollTest({rounds:2})` 走固定轨迹（顶 → 底 → 顶），逐帧采样
`scrollTop`，并比较同一锚点行的屏幕位置：

| 配置 | 单帧最大位移 | 方向反转 | 锚点漂移 | `scrollHeight` 变化 |
|---|---:|---:|---:|---:|
| containment 开 | 191 996 px（整篇跳） | 4 | **22 px** | 0 |
| containment 关 | 210 166 px（整篇跳） | 1 | **22 px** | 0 |

两者漂移相同（22 px，约视口高度的 3%），`scrollHeight` 变化都为 0。**没有
观察到 containment 造成的额外跳变**，默认值维持开启。

> 边界：这是程序化整篇跳，不是人手滚动的手感评估；22 px 的来源也未拆解
> （可能是估算高度在滚动过程中被真实高度替换）。真实鼠标滚轮下的主观顺滑度
> 仍需人工确认。

**滚轮路径校验**：用 CUA 发真实滚轮事件（3 次 × -1500 px）后，样本带
`intentional: true`，且判定器不再报 `jump`：

| 手势 | maxFramePx | intentional | jump |
|---|---:|---|---|
| 打开后自动滚到底（程序化） | 16 683 | false | **true** |
| 用户滚轮 -1500 ×3 | 3 146 | **true** | **false** |

第一版判定只用了「单帧 > 半个视口」，把用户滚轮也记成了跳变。现在要求
**没有近期输入意图**才计为意外跳变；有意图的滚动只看 `maxFramePx` 与
`anchorDriftPx`。

### 3.6 markdown / KaTeX / 高亮的 op 级成本

`__dshPerf.benchMarkdown({text, iterations})` 在页面里直接跑四个引擎，样本
1 476 字符 / 4 个围栏 / 4 个公式：

| 操作 | 实现 | 每次 |
|---|---|---:|
| 解析 | `extractMarkdownPlainText`（GFM，无 math） | **7.46 ms** |
| 建元素 + commit | `MarkdownText` 挂到分离容器（无布局、无视口高亮） | **23.9 ms** |
| KaTeX | `FenceMathBlock`（`renderToString` + `DOMParser`） | **1.28 ms / 式** |
| shiki tokenize | `useCodeHighlighter` 回调（绕开视口门控） | **3.5 ms / 145 字符** |

**结论**：单条 1.5 KB 消息的 markdown 成本约 **24 ms**（render）里，解析只占 7.5 ms，
**大头是 React 元素创建与 commit**；公式 1.3 ms/个、代码高亮 3.5 ms/块另算。
首屏 50 条消息、若全部可见，理论上限约 1.2 s —— 与实际挂载任务 300–560 ms
同量级（只有可见块高亮、流式渲染只重解析尾部两块）。

> 离屏代码块**永远不会高亮**（`CodeBlock` 的 `IntersectionObserver` 门控），
> 所以分离容器里的 `renderMs` **不含** shiki；代码高亮必须单独用 hook 量，
> 结果里的 `renderIncludesHighlight: false` 就是这个含义。

端到端 A/B（300 turn、同 turn 数）：`session-probe-md` 首屏 100 行里有
**183 个 KaTeX 节点 + 101 个代码块**，挂载最长任务 330 ms；`plain300` 同规模
最长任务 359 ms。在这个体量下，内容类型对挂载任务的差异小于运行波动——
真正随内容增长的是上面那张 op 级表。

### 3.7 30 000 turn 的跳转曲线：不是慢，是大概率崩

用 `__dshPerf.jumpToTurn(n)` 阶梯式跳转长会话（30 000 turn），每步等稳定：

| 目标 turn | 行数变化 | `loadMs` | 最长任务 | 总阻塞 | 心跳滞后 | 堆 |
|---|---:|---:|---:|---:|---:|---:|
| 29 900 | 100 → 500 | 558 ms | 576 ms | 603 ms | 663 ms | — |
| 29 500 | 500 → 2 100 | 1 732 ms | 1 782 ms | 1 982 ms | 2 088 ms | — |
| 29 000 | 2 100 → 4 100 | 2 275 ms | 2 293 ms | 2 940 ms | 2 992 ms | — |
| 25 000 | 4 100 → **20 100** | （窗口被下一轮覆盖） | — | — | — | **728 MB** |

斜率约 **1.0–1.15 ms 阻塞 / 行**、**≈36 KB 堆 / 行**。据此外推 30 000 turn
（≈60 000 消息、数万行）：单次跳转要 60–70 秒的主线程阻塞、约 2 GB 堆。

**turn 1 的实测（2026-11-13 补）**：在干净页面上直接 `jumpToTurn(1)`。服务端
**成功**：300 页 / 239 800 事件 / **83.4 MB**，聚合记录 85 ms。客户端随后卡住
约 **140 秒**，之后标签页被浏览器重载（`pageNow` 回到 31 s、`jumpSamples` 归零、
行数回到 100）。**结论不是「慢几分钟」，而是渲染进程被 OOM 杀掉后重载。**

> 第 4 步（turn 25 000）的客户端样本丢了（步进期间窗口被后续 settle 覆盖，
> 且 LoAF 缓冲可能溢出），所以那一行只有行数与堆，没有阻塞值；turn 1 的
> 结果补上了最极端的一点。停止条件之所以定在 `rows > 20 000`，正是因为再往下
> 不是「更慢」而是「可能崩溃」——现在这条已经被验证。

## 4. 结论：瓶颈排序

1. **投影载荷（6.76 MB/次打开）**——长会话里占首屏字节的 99%。`turnOutline`
   一个单元就装着全部 30 000 个 turn。客户端要接收、解压、`JSON.parse`、并为
   回合导航建索引。**服务端与客户端都跑不掉**，且不随窗口大小变化。
2. **批量挂载**——`loadThrough` 一次挂 1 375 行 / 阻塞 1.7 s（§3.4）；
   `loadOlder` 的合并发布同样如此。这是唯一能把等待推到分钟级的路径。
3. **服务端首帧**——热读 51–188 ms；冷读 2.5–3.7 s（投影折叠 + 大载荷序列化）。
4. **服务端帧编码与写队列**——本帧 `JSON.stringify` + deflate 36–265 ms；
   排在 `session/control` 基线（同为 6.8 MB 量级）后面再等约 300 ms（§3.2）。
5. **markdown 渲染**——1.5 KB 消息约 24 ms（其中解析 7.5 ms），公式 1.3 ms/个、
   代码高亮 3.5 ms/块（§3.6）。它随可见内容增长，不与投影无关。
6. **首屏消息窗口（74 KB）**——长会话里量级上无足轻重；重会话里它是主导项，
   但 50 条已经是最小可用窗口，不值得再收紧。

## 5. 插件做了什么、没做什么

| 能力 | 默认 | 实测收益 | 依据 |
|---|---|---|---|
| `renderTiming` | 关 | 诊断用：五段打开归因（请求腿/服务端/响应腿/派发/挂载）、LoAF 脚本归属、跳转/滚动窗口、markdown 微基准 | §3.2 §3.4 §3.5 §3.6 |
| `clientContainment` | **开** | 批量翻页阻塞 **2 836 → 1 489 ms**（-47%），最长任务 416 → 244 ms；未测到滚动漂移 | §3.3 §3.5 |
| `maxInitialMessages` | 关 | 长会话 ≤0.5% 字节，**不划算**；重会话可减半首屏字节 | §3.1 |
| `maxPageBytes` | 关 | 长会话每页 70 KB；重会话每页 1.7 MB，值得按需开启 | §3.1 |

`lib/render-timing.js` 与 `lib/history-budget.js` 只在配置打开时安装，关闭时
零开销；`lib/client.js` 的 CSS 只在 `clientContainment=true` 时注入，`$stream`
钩子与 WS 帧监听只在 `renderTiming=true` 时安装。

诊断模式下还会暴露 `window.__dshPerf`：
`state()`（流表 + WS 帧 + 最近样本）、`jumpToTurn(n)` / `jumpToFirst()`、
`scrollTest({rounds})`、`benchMarkdown({text, iterations})`、`flush()`。

**够不到的上游问题**：
- 虚拟滚动（要改 `ChatFlow`，插件只能改 CSS 与数据窗口）；
- markdown/KaTeX 结果缓存（在 shell bundle 内，无扩展点）；
- `turnOutline` 全量下发（投影契约的一部分）；
- `loadThrough` 的合并发布策略；
- `session/control` 与 follow 共用一条串行写队列（要改 gateway）。

## 6. 测量的边界

六条旧缺口的状态：

| 旧缺口 | 状态 | 结果 |
|---|---|---|
| 合成素材消息体太小 | **已闭合** | 新增 `--profile markdown` / `tools`；重会话首屏 1.73 MB，是长会话的 23 倍。工具事件带读回自检（生成器注释里那条「生命周期在 request/header」是错的，实际由 `assistant/message` 的 tool-call 块声明） |
| 回合跳转未测 | **已闭合** | 服务端 burst 聚合 + 客户端 jump 窗口；300 turn 实测 1 375 行 / 阻塞 1.7 s（§3.4）；30 000 turn 跳到 turn 1 实测**渲染进程被 OOM 杀掉后重载**（§3.7） |
| 打开路径 2.9 s 未归因 | **已闭合** | 五段拆开（§3.2）：请求腿 43–76 ms、服务端 3–2 495 ms、响应腿 481–2 313 ms、派发 7–35 ms、挂载 100–260 ms。响应腿再用 `ws.send` 回调拆成 **写队列 73–174 ms + deflate 207–1 493 ms + 网络/inflate 100–190 ms**；浏览器解析只有 20–30 ms |
| 真实滚动手感 | **部分闭合** | 程序化整篇跳锚点漂移 22 px，containment 开关无差异；并补了真实滚轮路径（`intentional` 标记、误报修正）。**主观手感仍需人工** |
| markdown/KaTeX 单独成本 | **已闭合** | op 级：解析 7.5 ms、render 24 ms、公式 1.3 ms、高亮 3.5 ms/块（§3.6） |
| 单机单次运行的方差 | **已量化** | 同一 tiny 会话三次：首行 1 745 / 4 679 / 1 497 ms。差异来自**上一个 20 100 行页面留下的 797 MB 堆与 3 s GC 任务**——复用标签页会污染下一次测量；干净测量需要新标签页或 GC 静置 |

仍然开放：

- **主观滚动手感**：程序化轨迹 + 真实滚轮都已覆盖「有没有意外跳变」，
  但「顺不顺滑」仍需人眼；这一条无法自动化。
- **测量协议的自动化 harness**：干净测量需要新标签页/GC 静置，目前靠人工保证。
- **跨机器差异**：所有数字来自单机（Windows 10 / Node 24 / Chromium），
  绝对值不可跨机比较，比例与机制可以。

## 7. 给上游的建议（按收益排序）

1. **`turnOutline` 不要全量下发**：回合导航只需「最近 N 个 + 按需分页」，或改为
   独立的按需端点。当前实现让每次打开都付 6.7 MB。
2. **`loadThrough` 不要合并发布**：逐页提交，配合虚拟滚动把挂载量钉在视口附近。
   300 turn 实测一次跳 1 375 行、阻塞 1.7 s；30 000 turn 跳到 turn 1 实测
   **渲染进程 OOM 重载**（服务端要先传 83.4 MB / 239 800 事件）。
3. **`session/control` 与 follow 不要共用串行写队列**：control 基线本身可达
   6.8 MB，会把 per-session follow 堵在后面（实测队列等待 174 ms，精确等于
   control 的写耗时尾部）。按流分队列或让 follow 优先。
4. **冷读后不要立刻做大帧 deflate**：实测同一帧的 deflate 从 207 ms 涨到
   1 493 ms（线程池与折叠/GC 抢 CPU）。可以让帧编码与折叠错峰，或把 deflate
   放到独立线程池。
5. **给 `paginate` 加字节上限**：现在只按消息条数切页，工具输出密集时单页可达
   1.7 MB（重会话实测）。
6. **已结算 markdown 加一个按 `(text, labels)` 的 LRU**：`renderSettled` 目前
   每次重渲染都重新 parse；单条 1.5 KB 消息的 render 是 24 ms，其中解析只有 7.5 ms。
