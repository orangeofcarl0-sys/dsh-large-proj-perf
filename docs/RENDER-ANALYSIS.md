# 渲染链路分析

「长对话打开要等很久」这件事，本插件此前从未测过：`docs/MEASUREMENTS.md` 里的
21.2 s → 3.0 s 全部是**服务端**冷读，浏览器侧没有任何埋点。本文补上这一段。

> **验证边界**
> - 被测 dsh：安装包 `0.2.2-rc.2`，运行时版本探针 `0.2.2-rc.1`（见
>   `docs/COMPATIBILITY.md`）。
> - 素材：`tools/runtime-probe/make-session-cli.mjs` 生成的 24 万事件 v4 会话
>   （30 000 turn，每 turn 8 事件，assistant 文本 pad≈700 字符）。
> - 环境：Windows 10.0.26200、Node 24.14.1、Chromium（ZCode 内置浏览器）、
>   隔离 home、1280×720 视口。
> - **素材是合成的，消息体很小**。真实会话的工具输出常是这里的几十倍，所以
>   下文的**绝对值是下限**，比例与机制才是结论。这一点在 §6 单列。

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

`tools/runtime-probe` 新增 **scenario H**（`session/events` 与 `session/follow`
共用同一个 paginate，因此便于在 unary 通道上量）：

| 项 | 上游（客户端原样请求） | `maxInitialMessages=25` |
|---|---:|---:|
| 消息条数 | 50 | 25 |
| 记录数（事件） | 231 | 130 |
| records 字节 | 73 674 | 38 740 |
| **projections 字节** | **6 761 101** | **6 761 101** |
| 服务端冷读 | 1 916 ms | 1 863 ms |
| 服务端热读 | 14 ms | 10 ms |

**投影载荷是消息载荷的 91 倍**，且不随消息窗口缩小。把首屏从 50 条压到 25 条
只省下 35 KB，占总载荷的 0.5%——这是本轮最重要的否证：**首屏消息窗口不是瓶颈**。

### 3.2 打开一个会话：7.4 秒到首行

真实浏览器、清空缓存后单页单实例（`client.js` 样本）：

| 指标 | 值 | 说明 |
|---|---:|---|
| 导航 → DOMContentLoaded | 237 ms | |
| 导航 → load | 1 591 ms | 壳与插件 bundle |
| 服务端 `follow` 首帧 | **2 511 ms** | 投影折叠 + 6.76 MB 序列化 |
| 导航 → 第一行出现 | **7 446 ms** | |
| 导航 → 行数稳定 | 8 257 ms | 之后 800 ms 无变化 |
| 主线程长任务 | 4 个 / 阻塞 443 ms | 最长 426 ms（在 6.96 s 处） |
| 堆 | 68 → 147 MB | |

四段分解：**1.6 s 页面装载 + 2.5 s 服务端 + 0.4 s 客户端阻塞 + ~2.9 s 等待**。

最后那 ~2.9 s 落在「快照到达」与「首行挂载」之间，期间**没有长任务**（主线程
空闲）。已排除的候选：投影折叠（服务端已计时）、本插件的计时点（无）、
markdown（在挂载任务里）。**归因未闭合**，见 §6。

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

## 4. 结论：瓶颈排序

1. **投影载荷（6.76 MB/次打开）**——占首屏字节的 99%。`turnOutline` 一个单元
   就装着全部 30 000 个 turn。客户端要接收、解压、`JSON.parse`、并为回合导航
   建索引。**服务端与客户端都跑不掉**，且不随窗口大小变化。
2. **批量挂载（一次上千行）**——`loadOlder` 的合并发布 + 无虚拟化 + `O(N log N)`
   排序。这是唯一能把等待推到分钟级的路径。
3. **服务端首帧 2.5 s**——投影折叠（本插件已把 `turnOutline` 从 O(n²) 改 O(n)）
   \+ 6.76 MB 的 zod 校验与序列化。
4. **首屏消息窗口（74 KB）**——量级上无足轻重，不值得作为默认收紧项。
5. **markdown / KaTeX**——只影响「全量重渲染」时的单次成本；没有测量数据能
   把它单独分离出来（synthetic 内容无公式）。

## 5. 插件做了什么、没做什么

| 能力 | 默认 | 实测收益 | 依据 |
|---|---|---|---|
| `renderTiming` | 关 | 诊断用：服务端分页/投影计时 + 浏览器首行/稳定/长任务 | §3 |
| `clientContainment` | **开** | 批量翻页阻塞 **2 836 → 1 489 ms**（-47%），最长任务 416 → 244 ms | §3.3 |
| `maxInitialMessages` | 关 | 实测 ≤0.5% 字节，**不划算**；保留给「turn 特别长」的会话 | §3.1 |
| `maxPageBytes` | 关 | 合成会话每页 70 KB，远未触及；保留给工具输出密集的真实会话 | §3.3 |

`lib/render-timing.js` 与 `lib/history-budget.js` 都只在配置打开时安装，关闭时
零开销；`lib/client.js` 的 CSS 只在 `clientContainment=true` 时注入。

**够不到的上游问题**：
- 虚拟滚动（要改 `ChatFlow`，插件只能改 CSS 与数据窗口）；
- markdown/KaTeX 结果缓存（在 shell bundle 内，无扩展点）；
- `turnOutline` 全量下发（投影契约的一部分）；
- `loadOlder` 的合并发布策略。

## 6. 测量边界与缺口

- **合成素材的消息体很小**（pad≈700 字符）。真实会话的工具输出、代码块、diff
  会让「每行字节」高一个量级，首屏与翻页的客户端成本随之上升。本文的
  **绝对时间是下限，比例关系可信**。
- **回合跳转（`loadThrough`）没有单独测量**。它会把目标之前的所有页一次性拉入
  并按 §2-6 全量发布，是比快速滚动更极端的批量路径——按 §3.3 的斜率推测会更慢，
  但没有实测数据。
- **打开路径里 ~2.9 s 的空闲段未归因**。候选是 WebSocket 大帧解压、投影入座
  （30k turn 建索引）、以及应用层的额外 RPC；现有埋点分不开。
- **真实滚动体验**只做了「滚到顶」的压力测试，没有做人眼可感知的滚动跳变评估。
  `content-visibility` 的默认值基于阻塞指标，不基于主观滚动手感。
- 单机、单次运行；同一场景的绝对值可随机器负载波动，比例更稳定。

## 7. 给上游的建议（按收益排序）

1. **`turnOutline` 不要全量下发**：回合导航只需「最近 N 个 + 按需分页」，或改为
   独立的按需端点。当前实现让每次打开都付 6.7 MB。
2. **给 `paginate` 加字节上限**：现在只按消息条数切页，工具输出密集时单页可达
   数十 MB。
3. **`loadOlder` 不要合并发布**：逐页提交，配合虚拟滚动把挂载量钉在视口附近。
4. **已结算 markdown 加一个按 `(text, labels)` 的 LRU**：`renderSettled` 目前
   每次重渲染都重新 parse。
