# runtime-probe 报告

- 开始：2026-11-10T18:30:22.948Z
- 结束：2026-11-10T18:41:18.169Z
- home：`F:\dsh-rt\20261111-011250\home`
- profile：rt　端口：3199

## A 装机核验

| 项 | 值 |
| --- | --- |
| dshVersion | `0.2.2-rc.1` |
| patches.zeroCopyFork | **active** |
| patches.warmup | **active** |
| patches.fastInitFor | **inactive** |
| patches.preparedCacheTrim | **inactive** |
| patches.chunkedMaterialize | **active** |
| 配置键数 | 19 |
| debugApi 默认 | false |
| dsh-perf 日志行数 | 0 |

启动日志（`dsh-perf`）：

```
```

## B 冷读基线（warmup 关闭）

| 指标 | 值 |
| --- | --- |
| session/events | 2712.8 ms |
| session/projections | 259.7 ms |
| 投影 key 数 | 20 |
| pinger P50/P95/P99/max | 7.5/2293.5/2293.5/2293.5 ms |
| pinger stalls | 3 |
| RSS 峰值 / 增量 | 626.9 / 136.4 MB |
| warmed / skipped | 0 / 0 |

## C 预热（warmup 开）

| 指标 | 值 |
| --- | --- |
| rename(resume) 墙钟 | 28018.3 ms |
| rename 结果 | ok |
| warmed | 0 |
| alreadyHot（上游已建满 cell） | 1 |
| skipped | 0 |
| warmRecent | ```[{"t":1794335510140,"id":"session-probe-long","events":240028,"units":0,"hotUnits":29,"baseSeq":-1,"ms":24653.2677}]``` |
| 预热后 projections | 95.6 ms |
| pinger P50/P95/P99/max | 2.7/5/8.7/2388.8 ms |
| RSS 峰值 / 增量 | 892.5 / 266.8 MB |

## D 真实 fork RPC

| 指标 | 值 |
| --- | --- |
| childId | `session-fde7d8c4-07b3-484d-839c-ca9d6d875684` |
| fork 墙钟 | 27283.1 ms |
| **pluginForks** | **0** |
| pluginZeroCopy | 0 |
| 子会话 zstd frame 数 | 6 |
| 子会话字节 | 19017927 |

## E debug.fork 同进程 A/B

| 模式 | n | min | median | max | forks | zeroCopy | fallbacks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| native | 5 | 25408.3 ms | 25776.1 ms | 26371.1 ms | 5 | 0 | 0 |
| zeroCopy | 5 | 20481.7 ms | 21760.3 ms | 27166.7 ms | 5 | 5 | 0 |

| record.path 序列 | zero-copy / zero-copy / zero-copy / zero-copy / zero-copy |

## F 分片落盘

| chunkedMaterialize | 帧数 | 字节 | fork+encode | pinger P99 |
| --- | --- | --- | --- | --- |
| true | 6 | 19017965 | undefined ms | 5540.9 ms |
| false | 2 | 19022657 | undefined ms | 5358.4 ms |

