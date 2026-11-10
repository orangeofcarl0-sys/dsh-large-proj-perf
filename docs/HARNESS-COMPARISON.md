# 其他 harness 怎么处理长会话

本文横向对比主流 coding agent harness 的会话存储与打开策略，用于判断 dsh 的
瓶颈是"架构必然而非实现缺陷"，以及哪些技术可以移植。

配套阅读：[RUNTIME-ANALYSIS.md](RUNTIME-ANALYSIS.md)（dsh 自己的实测数据）。

## 先给对照基线

同一个场景——**打开一个 24 万事件、18 MB（zstd）的会话，读它的状态**——各家做法：

| Harness | 存储 | 打开策略 | 是否增量/分页 | 打开成本量级 |
|---|---|---|---|---|
| **dsh 0.2.2** | JSONL + zstd 多帧 | 全量解码 → 构造 `Session`（surface 全量校验）→ 31 个投影单元 × N 事件折叠 | **否** | 无缓存 **16.6 s**；有缓存行 0.26 s |
| **OpenAI Codex CLI** | JSONL rollout + **SQLite 投影** | 元数据走 SQLite；正文按 `rollout_ordinal` 游标分页；构造上下文时**从文件尾反向扫描**到最近一次 compaction | **是**（turn/item 级游标 + 断点续跑） | 元数据查询级；无需全量解析 |
| **Claude Code** | JSONL | 顺序读文件但**只保留最后一个 compact 边界之后**的内容 | 部分（边界之后） | 与文件字节数成正比的 I/O，但解析/驻留只与尾巴成正比 |
| **Gemini CLI** | JSONL（含 `$patch`/`$rewindTo` 操作记录） | `loadConversationRecord` **一次性加载全部** | 否（列表可 metadataOnly） | 全量；有内存索引与 recent-window |
| **ZCode CLI / opencode** | **SQLite 行存**（`session`/`message`/`part`/`session_entry`） | 按 `session_id + type` 走索引 range scan | **是**（索引即分页） | 与"取多少"成正比，与历史长度无关 |
| **pi-coding-agent** | JSONL + 树形 `id/parentId` | 只发"summary + `firstKeptEntryId` 之后"的条目 | 部分（压缩边界之后） | 与尾巴成正比 |
| **Cursor** | VS Code `state.vscdb` + JSON blob | 整段对话是一个 JSON blob，读改写 | 否 | 与对话大小成正比（结构性慢） |
| **Aider** | Markdown / JSONL（给人看） | `--restore-chat-history` **默认 false**，正常启动不重放 | 不适用 | 不重放 |
| **Cline** | 整数组 JSON | `JSON.parse` 整个数组；写入是整数组重写 | 否 | 与对话大小成正比 |

结论很清楚：**把日志当读模型用、每次读都全量解码的，只有 dsh 和 Cline/Cursor
这一类**。Codex / ZCode / Claude Code 都已经在读路径上做了分层。

## 各家做法值得抄的部分

### OpenAI Codex CLI —— 最完整的一份设计

这是唯一把"打开超大历史会话"当**存储层问题**系统解决的实现。

**1. 增量投影进 SQLite，带断点续跑**

rollout 仍是 append-only JSONL（每行带 `ordinal`），但后台把它投影进两张表：

```sql
thread_items (thread_id, turn_id, item_id, rollout_ordinal, item_json, item_type, ...)
thread_turns (rollout_ordinal, status, rollout_byte_offset, rollout_end_byte_offset, ...)
thread_history_projection_state (thread_id, next_rollout_byte_offset, next_rollout_ordinal)
```

`thread_turns` 的 `rollout_byte_offset` / `rollout_end_byte_offset` 就是**一个
turn 在 JSONL 里的字节区间**。投影按 `BATCH_SOURCE_BYTES` 分批推进，只在完整
记录之间落事务，同时推进 `next_byte_offset` 与 `next_ordinal` —— 崩溃后能从断点
继续，不必重来。

**2. 打开时可只取元数据，正文按游标翻页**

`thread/read` 带 `includeTurns: false` 只走 SQLite；`thread/turns/list` /
`thread/items/list` 用 `rollout_ordinal` 作游标，`page_size + 1` 预取探测
`has_more`。

**3. 构造模型上下文时只读后缀**

从文件尾用 `ReverseJsonlScanner` 按 64 KiB 块反向扫描，遇到最新的
`CompactedItem`（同时带 replacement history 与 window number）就停。compaction
字段不完整时退回全量 replay（有明确降级路径）。

**4. fork 是 lineage 引用，不是复制**

子线程的 `session_meta` 只记 `history_base: { thread_id, end_ordinal_exclusive,
end_byte_offset }`。读取时沿 lineage 段打开各个父文件、只读各自区间。父事件
**一行都不复制**。

**对 dsh 的启示**：dsh 的 `fork` 现在复制整段前缀（实测 24 万事件要 25–48 秒），
这正是 Codex 用 lineage 指针解决的问题。但 dsh 的 header 只有
`isSeeded` + `inheritedEventCount`，没有"父 cut 的物理定位"，改成 lineage 需要
动持久化格式 —— 超出插件边界。

### Claude Code —— 压缩边界 + 只加载尾巴

resume 时以 64 KiB 块顺序读，但**遇到新的 compact 边界就把已累积内容清零、
重设 `boundaryStartOffset`**，调用方最终只拿到 `postBoundaryBuf`。记录类型里有
`compact_boundary` / `microcompact_boundary` 两种边界，摘要消息带
`isCompactSummary: true`。

**代价与限制**：仍是 O(文件字节数) 的 I/O 与边界扫描；社区 issue 显示 20–48 MB
transcript 会 resume 白屏，703 MB 会话因目录去重 O(N²) 卡 50 秒。

**对 dsh 的启示**：dsh 已有 compaction 事件（`compaction/start` /
`compaction/summary` / `compaction/end`），但 `Session` 仍是全量事件数组，读路径
没有"只折 compaction 之后"的语义。这条**可以在插件层做**（见下"可移植清单"#4）。

### ZCode CLI / opencode —— 事件日志归日志，可查询视图归 SQLite

`~/.zcode/cli/db/db.sqlite`（实测 5.6 GB）里：

```sql
session (id, project_id, title, ...)
message (id, session_id, time_created, data)
part    (id, message_id, session_id, data)
session_entry (id, session_id, type, time_created, data)
```

关键索引：`message_session_time_created_id_idx(session_id, time_created, id)`、
`session_entry_session_type_idx(session_id, type)`。`session_entry` 是 **upsert 型
事件表**，查询是"按 session + type 取一段、带索引排序"，不是全表扫。

压缩表示上，ZCode 用 `timelineMarker{type:"compact"}` 行 + `tailStartMessageId`，
并把边界之前的实体标记为 `coveredByStableCompact` —— **压缩边界是可索引的行，
不需要扫描才能发现**。

**对 dsh 的启示**：证明 Node 进程里几 GB SQLite + WAL 可运维；也说明"日志是真相、
索引是派生"这套分工可行。dsh 已有 `dsh-session-query-sqlite`（FTS5）与
`dsh-session-turn-outline`（turn → seq 大纲），只差"item 级 + 帧偏移"这一层。

### Gemini CLI —— 日志里的可变视图操作

JSONL 行类型除消息外还有 `MetadataUpdateRecord`（`$set` 部分字段）、
`RewindRecord`（`$rewindTo`）、`MessagePatchRecord`（`$patch {updates, removeIds,
orderIds}`）。这是"**不改旧行，追加一条修正**"的干净形态，与 append-only 语义
完全兼容。

压缩侧有两点值得注意：
- 压缩前先做工具输出截断：从新到旧保留最近 function response 共 **50k tokens**，
  超出的写入临时文件并替换为占位符（**不写进 chat log**）；
- 保留点切在"不含 function response 的 user message"处，目标保留最新约 30%。

**对 dsh 的启示**：50k-token 工具输出预算 + 落盘占位符是**可独立移植的小优化**，
且直接减少事件体积 —— 多数"24 万事件"就是被巨型工具输出灌出来的。

### 其余三家

- **pi-coding-agent**：压缩时**追加**一条 `CompactionEntry{summary,
  firstKeptEntryId}`，模型侧只发 summary + 之后条目，原始 entry 不删。这是
  "摘要作为一条日志记录"的最干净形态，与 dsh 的 compaction 语义最接近。
- **Cursor**：整段对话序列化成**一个 JSON blob**，读改写。长会话变慢是结构性的。
- **Aider**：`--restore-chat-history` 默认 false —— 正常启动根本不重放历史；
  摘要放在 **worker thread** 里做（`ChatSummary` 默认 1024 tokens、深度上限 3）。
- **Cline**：整数组 JSON，写入是整数组重写（`overwriteApiConversationHistory`）。

## 可移植技术清单

按"对 dsh 的收益 / 实现成本"排序。

| # | 技术 | 解决什么 | dsh 现状 | 移植成本 | 优先级 |
|---|---|---|---|---|---|
| 1 | **冷读后回写投影缓存行** | 同一会话每个进程重付一次全量折叠 | 上游 `coldSnapshot()` 有实现但**无调用点**（死代码） | **低**（插件层 1 个函数） | **已实现（本插件 1.7.0）** |
| 2 | **启动时批量物化缓存行** | 首次打开仍要 16.6s | 插件 `backfillOnBoot`（默认关）已有雏形 | **低**（修几个 bug） | **已实现（本插件 1.7.0）** |
| 3 | **帧索引：只解压目标 seq 区间** | 读 5 条消息也要全量解码（1.8–2.7s） | 多帧 zstd 已具备结构前提，但 `handle.read(offset)` 仍全量解码 | **中**（需要 `seq → frame` 稀疏表 + 格式版本协商；且当前无消费者按非零 offset 读） | P1 |
| 4 | **只折压缩边界之后** | 折叠量可降到"上次压缩之后的尾巴" | 有 compaction 事件，但读路径无此语义 | **中高**（要改投影语义，且历史事件仍要 decode） | P1 |
| 5 | **item 级 SQLite 索引** | `list` / 导航 / 首屏完全不碰日志 | 已有 `session-query-sqlite`（FTS5）与 `turn-outline`，缺 item 级 + 帧偏移 | **高**（新派生索引 + 双写一致性 + backfill 降级路径） | P1 |
| 6 | **fork 用 lineage 指针** | 24 万事件 fork 25–48s、+300–500MB | header 只有 `isSeeded` + `inheritedEventCount` | **很高**（动持久化格式、GC、父日志归档） | P2（需上游） |
| 7 | **工具输出上限 + 占位符** | 事件体积被巨型输出灌爆 | 无（`dsh-compaction-tool-result-pruner` 只在压缩时清） | **低中**（写入侧拦截 + 落盘引用） | P1（独立插件） |
| 8 | **摘要作为一条日志记录** | 替代长前缀 | 已有 compaction 三事件 | 低（已基本具备） | — |
| 9 | **压缩放在 worker thread** | 避免主线程阻塞 | 摘要走 LLM 调用，本就不阻塞 | 低 | — |
| 10 | **日志内可变视图操作（`$patch`）** | 改历史而不破坏 append-only | 有 `feedback/message-put` 等替代事件 | 低 | — |

## dsh 具体缺的是哪一层

把上面的横向对比压成一句：**dsh 把 append-only 日志同时当读了模型，而且每次读
都全量解码。**

其他 harness 的分工是三层：

```
日志（真相，只追加）  →  派生索引（可重建、可落后）  →  读路径（只碰索引 + 后缀）
```

dsh 只有第一层和第三层，缺中间那层；而第三层又直接读第一层。具体缺失：

1. **没有"帧 → seq"的物理索引**，所以任何读都要从第 0 帧解码。（Codex 的
   `rollout_byte_offset`、ZCode 的 `rowid` 索引都补了这一层。）
2. **投影缓存只有"整会话一条完整 checkpoint"**，没有更密的断点，也没有"冷读后
   回写"，所以缓存 miss 就等于从 `seq 0` 重折一遍。（Codex 的
   `next_rollout_byte_offset` 断点续跑补了这一层。）
3. **fork 复制前缀**而不是引用 lineage，所以 fork 成本与前缀长度线性相关。
4. **压缩边界不可索引**，读路径无法"只折尾巴"。（Claude Code / pi 都靠边界
   止步。）

前两条里，第 2 条**可以完全在插件层解决** —— 这正是 1.7.0 做的事：把"冷读一次
之后就不再重付"这条补齐。

## 一句话结论

不是 dsh 的实现写得差，而是它的读路径停在"日志即读模型"这一代；Codex / ZCode /
Claude Code 都已经把读路径搬到"索引 + 后缀"。本插件能补的是其中最便宜的一环
（冷读回写 + 批量物化），其余三条需要改持久化格式，属于上游范畴。

## 来源

本机代码与数据（可直接复核）：

- `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`（多帧 zstd、
  `readZstdPrefix`、`ZSTD_DECODE_YIELD_INTERVAL_MS=500`、`COLD_LOG_MEMO_MAX_ENTRIES=2`）
- `@deepseek-ai/dsh-session-projection-cache/lib/index.js`（`coldSnapshot` 无调用点、
  `identityOf` / `identityMatches`、checkpoint 阈值为 `writeEveryEvents: 200` +
  `writeIntervalMs: 5000`）
- `@deepseek-ai/dsh-session-projection/lib/index.js`（`restore` / `hydrate` /
  `buildCell` / `checkpoint`）
- `@deepseek-ai/dsh-session-query/lib/index.js`（`ObservationCache` 容量 5、
  `preparedProjections` 是冷读唯一漏斗）
- `@deepseek-ai/dsh-session-query-sqlite/README.md`、`@deepseek-ai/dsh-session-turn-outline/README.md`
- `C:\Users\66494\.codex\thread_history_1.sqlite`（`thread_items` / `thread_turns` /
  `thread_history_projection_state` schema）
- `C:\Users\66494\.codex\sessions\2026\10\12\rollout-*.jsonl`（`history_mode:
  "paginated"` + `history_base`）
- `C:\Users\66494\.zcode\cli\db\db.sqlite`（`session`/`message`/`part`/`session_entry` schema 与索引）

公开资料（描述依据公开文档与社区解析，未经官方确认的已标注可信度）：

- Codex CLI 的 paginated history / lineage fork：其仓库 PR 与 `thread-store` 源码
- Claude Code 的 `compact_boundary` / `readTranscriptForLoad`：本机 `claude.exe`
  字符串 + 社区 issue（#105417、#107848、#92089）
- Gemini CLI 的 `chatCompressionService` / checkpointing：其仓库源码
- Cursor / Aider / Cline：社区解析工具与各自仓库（Cursor 无官方格式文档，可信度中低）
