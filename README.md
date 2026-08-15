# dsh-large-proj-perf

[![Version](https://img.shields.io/badge/version-1.0.0-blue)]()
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.6-green)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DSH（DeepSeek Harness）大会话性能插件：零拷贝 fork、投影分片预热、分片 materialize，
一次装齐，消除 fork/历史加载对超大会话的事件循环阻塞。

## 问题

dsh `0.1.0-rc.6` 在大会话（数十万事件）上存在三类同步阻塞，导致 fork 卡顿、
历史加载报 `signal timed out (internal)`、严重时 OOM：

| 问题 | 环节 | 实测 |
|---|---|---|
| A. fork 深拷贝 | `Session` 构造器逐事件 `snapshotJsonValue`（纯 JS 深拷贝）+ persistence `initFor` 的 `structuredClone(seed)` | 18.2MB/20k 事件合计 ~480ms 同步阻塞 |
| B. projection 冷折叠 | `SessionProjectionRegistry.cellFor()` 冷时同步 `buildCell` 全量折叠 | 74 万事件冷折叠阻塞 20+ 分钟（100% 单核） |
| C. fork 全量序列化 | fork 子会话首次落盘 `encodeMaterialization` → `eventLines` = `map(JSON.stringify).join("\n")` 一次性序列化整个 seed | 60 万事件 = 501MB 单字符串；74 万事件直接 `RangeError: Invalid string length` |

**为什么「单个会话没事、fork 后出事」**：普通会话持久化走增量 `appendLines`
（每次序列化几十个事件），而 fork 子会话是全新 id，走 `materialize` 全量序列化
整个 seed——这是唯一会一次性序列化整条日志的路径。

## 方案

1. **零拷贝 fork**（`zeroCopyFork`，A）：fork 的 seed 事件本就是 `deepFreeze`
   不可变纯 JSON 树。补丁改走 `Session.prepare(..., { seedSource: 'persistence' })`
   的 `fromRestore` 通道——原地冻结复用引用，跳过整树深拷贝（346ms → 19ms）。
   子会话 header（`parentSession`/`seedLength`/`cwd`）与官方 fork 逐字段一致。
2. **fast init-for**（`fastInitFor`，A）：`PersistenceCoordinator.initFor` 里那次
   `structuredClone(seed)` 替换为冻结引用复用（135ms → ~0ms）。带 rc.6 源码特征
   校验（`structuredClone(e)` 标记），内部结构不匹配时自动跳过并告警。
3. **投影分片预热**（`warmupEnabled`，B）：会话进入（created/resume）且事件数超过
   阈值时，抢在首次同步冷折叠前，分片重放 cells——每 `chunkSize` 个事件
   `setImmediate` 让出事件循环，折叠完成后直写 `registration.cells`（WeakMap），
   此后 `snapshot()`/`drive()` 全部命中热 cell。可用时从投影缓存行取基线跳过已折叠
   前缀。实测 74 万事件：冷折叠 20 分钟 → 预热 200ms。
4. **fork 缓存回填**（B，随预热自动执行）：fork 子会话（`header.parentSession` 存在）
   预热完成后立即 `cache.write(child)` 建立投影缓存行——否则它被放弃时永远没有
   缓存行，下次打开历史 `coldSnapshot` 走 `readFrom(0)` 全量读。
5. **分片 materialize**（`chunkedMaterialize`，C）：`encodeMaterialization` 每
   `materializeChunkEvents` 个事件一个 zstd frame（多帧是 dsh 解码端
   `scanZstdFrames` 的原生格式，字节兼容），消除单巨字符串与 RangeError。
6. **冷会话补行**（`backfillOnBoot`，B 辅助，默认关）：磁盘缺缓存行的大会话流式
   补写。默认关的原因：`readRaw` 的 zstd 全量解码是同步的、插件层不可分片，
   大文件仍会冻结事件循环数秒~数十秒。

### 安全性

- 共享引用等价于深拷贝：事件在进入源会话时已通过完整 JSON 边界与 surface 验证并
  深冻结，任何代码都无法修改。
- 所有补丁带 rc.6 源码特征校验，内部结构不符自动跳过并告警，绝不盲补。
- 三层回退：(a) 调用时能力探测缺失 → 官方实现；(b) 补丁内运行时异常 → try/catch
  回退官方实现；(c) 配置开关 → 永远官方路径。
- dispose 完整还原所有补丁。

## 安装

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:orangeofcarl0-sys/dsh-large-proj-perf
# 或
dsh plugin --profile web add https://github.com/orangeofcarl0-sys/dsh-large-proj-perf

# 本地开发
dsh plugin --profile web add file:<本仓库路径>
```

> 注意：每次修改仓库代码后，需把 `lib/`、`cordis.patch.yml`、`package.json`
> 同步到 `<DSH_HOME>/profiles/web/node_modules/dsh-large-proj-perf/`（`file:` 安装
> 不会自动跟随源文件更新），或重新执行 `dsh plugin add`。

重启 `dsh web` 生效。日志出现 `[dsh-perf] installed (...)` 即成功。

## API

`POST http://127.0.0.1:3080/dsh-large-proj-perf/api/<method>`：

- `stats.get` — fork 次数/零拷贝占比/回退、预热计数、补行计数、最近记录
- `stats.reset` — 清零
- `config.get` / `config.set` — 运行时开关，`config.set` 同时写 settings 持久化

```sh
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/stats.get
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/config.set \
  -d '{"zeroCopyFork": false}'
```

## 验证

- `tests/smoke_fork.mjs`（14 断言）：官方 fork 基线 / 零拷贝 fork 功能等价 /
  dispose 还原 / 版本漂移回退 —— ALL PASS
- `tests/test_fast_initfor.mjs`（8 断言）：initFor 补丁安装 / 源码特征漂移跳过 /
  无 persistence 服务存活 —— ALL PASS
- `tests/smoke_warmup.mjs`（11 断言）：分片预热与同步折叠一致 / checkpoint 基线 /
  并发 drive 让位 / dispose 中止 —— ALL PASS
- `tests/test_backfill.mjs`（8 断言）：fork 回填 / 磁盘冷会话补行 —— ALL PASS
- `tests/test_chunked_materialize.mjs`（5 断言）：分片多帧解码等价 / 阈值不变 —— ALL PASS

## 局限

- `enqueue` 的逐事件 `structuredClone`（fork 第三次拷贝）在插件层无法安全消除——
  它在 write-behind 闭包内部，且承担"persistence 独立于生产者"的所有权语义。根治需
  上游改为按需快照。
- 冷会话 `coldSnapshot` 的全量 `readFrom(0)`（zstd 解码 + 逐事件
  `snapshotStoredEvents` 深拷贝）无法在插件层安全分片——`readRaw` 的同步解码是硬伤。
  根治需上游把 `readFromCore`/`loadStored` 改成分片让出事件循环。
- 超大会话（70 万+ 事件）加载本身有内存 OOM 风险，与插件无关。
- 补丁绑定 rc.6 内部结构（`_forkSeed`、`initFor`/`encodeMaterialization` 源码特征）；
  大版本升级后特征校验会自动跳过优化并保持官方行为，重新适配即可。
