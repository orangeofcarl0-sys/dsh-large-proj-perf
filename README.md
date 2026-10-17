# dsh-large-proj-perf

[![Version](https://img.shields.io/badge/version-1.3.2-blue)]()
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.6..0.2.1--rc.2-green)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DSH（DeepSeek Harness）大会话性能插件。消除 fork、历史会话加载、超大会话落盘对
事件循环的阻塞，并治理冷会话内存——面向数十万事件的会话。

所有优化都带**源码特征校验 + 协议探测 + 三层回退**（能力探测 / try-catch / 配置
开关）：dsh 内部结构变化时补丁自动跳过并告警，绝不盲补。上游原生实现了某项能力后，
对应补丁自动从 `active` 转为 `retired`。

## 能力与效果

| 能力 | 症状 | 效果 | 当前状态 |
|---|---|---|---|
| 零拷贝 fork | fork 逐事件 `snapshotJsonValue` 深拷贝 | 49ms → 5.9ms | 活跃 |
| 分片投影预热 | 打开历史会话时同步冷折叠冻结事件循环 | 74 万事件 20 分钟 → ~200ms | 活跃 |
| fork 缓存回填 | 子会话无投影缓存行，重开走全量读 | 分钟级 → 秒级 | 活跃 |
| 分片 materialize | 落盘单巨字符串：60 万事件 501MB、74 万 RangeError | 多帧 zstd，字节兼容 | 活跃 |
| 冷会话 LRU 裁剪 | 冷会话事件树 ~700MB/个 × 5 叠加 OOM | 省 ~2.8GB | 上游已代偿 |
| fast initFor | persistence 的 `structuredClone(seed)` | 135ms → ~0ms | 已退役 |
| heap 检测 | V8 heap 上限过低无提示 | 启动告警并给出参数建议 | 活跃 |

运行时状态经 `stats.get` 的 `patches` 字段暴露：`active`（已安装生效）、
`retired`（上游已原生实现）、`inactive`（环境缺失或特征漂移）、`off`（配置关闭）。

## 安装

要求 Node **≥ 22.15.0**（`node:zlib` 的 zstd 接口），dsh `0.1.0-rc.6` ~ `0.2.1-rc.2`。

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:orangeofcarl0-sys/dsh-large-proj-perf

# 从 npm 安装
dsh plugin --profile web add dsh-large-proj-perf

# 本地开发
dsh plugin --profile web add file:<本仓库路径>
```

重启 `dsh web` 后，启动日志出现 `[dsh-perf] installed (...)` 即装载成功。

> `file:` 安装不跟随源码改动。改完代码需把 `lib/`、`cordis.patch.yml`、
> `package.json`、`icon.svg`、`locale/` 同步到
> `<DSH_HOME>/profiles/web/node_modules/dsh-large-proj-perf/`，或重新 `dsh plugin add`。

### 建议同时调高 V8 heap 上限

多个大会话并存时，每个 live 事件树约 700MB，默认 ~4GB 上限容易 OOM。heap 上限是
**启动期参数**，进程内改不了。用仓库脚本启动（内置 `--max-old-space-size=8192`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1
```

插件会在上限低于 6GB 时打告警，但不代为修改。

## 配置

可经 Settings 卡片、`config.set` API 或 settings 持久化修改。数值项带下限钳制
（如 `materializeChunkEvents ≥ 1000`、`chunkSize ≥ 1`），NaN/Infinity 直接拒绝。

| 键 | 默认 | 说明 |
|---|---|---|
| `zeroCopyFork` | `true` | 零拷贝 fork |
| `fastInitFor` | `true` | fast initFor（新版 dsh 自动退役） |
| `slowForkWarnMs` | `100` | fork 耗时告警阈值（ms） |
| `warmupEnabled` | `true` | 投影分片预热总开关 |
| `minEvents` | `20000` | 低于此事件数不预热 |
| `chunkSize` | `5000` | 每片折叠事件数（片间让出事件循环） |
| `chunkYieldMs` | `0` | 让出方式：0 = `setImmediate`，>0 = `setTimeout(ms)` |
| `warmOnCreated` | `true` | `session/created`（含 resume）即预热 |
| `backfillOnBoot` | `false` | 磁盘冷会话补投影缓存行（大文件解码同步，默认关） |
| `backfillMaxSessions` | `8` | 补行扫描会话数上限 |
| `backfillMinBytes` / `backfillMaxBytes` | `1MB` / `32MB` | 补行文件大小范围 |
| `chunkedMaterialize` | `true` | 分片落盘 |
| `materializeChunkEvents` | `50000` | 每帧事件数（下限 1000） |
| `preparedCacheTrim` | `true` | 冷会话 LRU 裁剪总开关 |
| `preparedCacheSize` | `1` | 裁剪目标容量（官方默认 5） |
| `keepRecent` | `50` | 内存保留的最近统计记录数 |
| `heapWarnBytes` | `6GB` | heap 上限告警阈值 |

## 验证是否生效

启动日志会打印探测到的 dsh 版本与各补丁安装结果：

```
[dsh-perf] dsh version: 0.2.1-rc.2 (verified)
[dsh-perf] zero-copy fork installed (SessionStore.prototype.fork patched, protocol: 0.1.7 forkSeed)
[dsh-perf] chunked materialize installed (chunk=50000 events/frame, protocol: 0.1.3)
```

出现 `signature mismatch` 说明 dsh 内部结构已变，对应补丁跳过（功能回退到官方实现，
不会出错）。此时升级插件或运行兼容性检查：

```sh
node tests/verify_compat.mjs
```

### HTTP API

`POST http://127.0.0.1:3080/dsh-large-proj-perf/api/<method>`（仅回环 + 同源）：

| 端点 | 说明 |
|---|---|
| `stats.get` | 版本探针、各补丁状态、fork/预热/补行计数与最近记录 |
| `stats.reset` | 清零计数（保留版本探针与补丁状态） |
| `config.get` / `config.set` | 运行时开关，`set` 同时写 settings 持久化 |

```sh
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/stats.get
curl -X POST http://127.0.0.1:3080/dsh-large-proj-perf/api/config.set \
  -H 'Content-Type: application/json' -d '{"key":"backfillOnBoot","value":true}'
```

## 已知限制

- **这是被动优化**，削减不了正在使用的 live 事件树（每会话几百 MB 是物理成本）。
  建议配合 [dsh-fresh-start](https://github.com/orangeofcarl0-sys/dsh-fresh-start)
  主动控制会话规模：`/fresh` 一键「总结 → 开新会话 → 归档老会话」。
- `backfillOnBoot` 的解码在插件层同步执行（虽按 `chunkSize` 分片让出），超大文件
  仍可能短暂冻结事件循环，故默认关闭。
- `preparedCacheTrim` 在新版 dsh 上自动跳空为 `inactive`（上游已系统代偿）；仅在
  老版本 dsh 上真正生效。
- 与其他插件不冲突，但若某个行管理类插件禁用了 `session-projection-cache`，
  本插件的缓存与预热能力会被削弱。

## 开发

```sh
# 链接全局 dsh 的嵌套依赖（仓库本身无 node_modules）
powershell -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1

# 全套 8 套件 147 断言
npm test
```

测试分两层：`verify_compat` 对真实安装源码做特征断言与门禁实算；`e2e_real_components`
直接驱动 dsh 的真实实现类（`JsonlSessionPersistence` / `SessionProjectionRegistry` /
`SessionStore`），逐点位验证「补丁装上 → 行为正确」。其余套件覆盖逻辑与边界。

## 更多文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 三类同步阻塞的定位、各补丁实现原理、加载侧分工、安全性与回退设计 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | 版本矩阵、各版本内部形态、dsh 版本门禁规则、插件清单规范 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [PUBLISHING.md](PUBLISHING.md) | 发布流程与约定 |

## License

MIT
