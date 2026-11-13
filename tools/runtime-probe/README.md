# runtime-probe

在**隔离的 dsh home** 里起一个真实 dsh 实例，用 HTTP RPC 驱动真实链路，测量
`dsh-large-proj-perf` 各能力是否真的生效、值多少。

结果见 [`docs/MEASUREMENTS.md`](../../docs/MEASUREMENTS.md)。

## 为什么需要它

`npm test` 的 e2e 用真实实现类（原型链驱动）验证「补丁装上后的行为」，但它
不验证「真实 dsh 进程里谁会调用这个补丁点」。两者的差距是实质性的：

- 零拷贝补丁挂在 `SessionStore.prototype.fork` 上，而 dsh 0.2.2 的
  `session/fork` RPC 已经**不调用**该方法；
- 预热的监听器排在 `dsh-api-session-controller` 之后，而后者在
  `session/created` 的同步广播里就把所有投影 cell 建完了。

这两条都只有起真实进程才能发现。

## 一次性准备

```bash
# 1) 隔离根（所有写入都在这里，不碰 ~/.dsh）
export RT=/f/dsh-rt/$(date +%Y%m%d-%H%M%S)
mkdir -p "$RT/home/profiles/rt" "$RT/agents" "$RT/out"

# 2) profile：只挂 base + web-app + 被测插件
#    见下文「profile 模板」

# 3) 把插件复制进去（不是 junction：dsh 会按包解析，junction 在某些路径下失败）
cp -r lib package.json cordis.patch.yml icon.svg locale \
  "$RT/home/profiles/rt/node_modules/dsh-large-proj-perf/"

# 4) 生成一个 24 万事件的 v4 长会话（走真实 SessionStore + 真实 jsonl 后端）
node tools/runtime-probe/make-session-cli.mjs \
  --home "$RT/home" --events 240000 --pad 700 \
  --id session-probe-long --cwd 'F:\dsh-rt\probe-workspace'
```

### profile 模板

`$RT/home/profiles/rt/package.json`：

```json
{
  "name": "dsh-profile-rt",
  "private": true,
  "dependencies": { "dsh-large-proj-perf": "file:./node_modules/dsh-large-proj-perf" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-large-proj-perf"
  ] } }
}
```

`$RT/home/profiles/rt/cordis.patch.yml`：关遥测、**关 `session-title-llm`**
（否则任何 resume 都会发真实模型请求）、保持会话搜索索引为 `never`。

## 运行

```bash
node tools/runtime-probe/run.mjs \
  --home "$RT/home" --agents "$RT/agents" --port 3190 \
  --scenario all --out "$RT/out"
```

`--scenario` 可接受 `A,B,C` 子集。报告写到 `<out>/report.json` 与 `report.md`，
多次调用**累积合并**（不会互相覆盖）。

## 十个场景

| 场景 | 驱动 | 回答什么问题 |
|---|---|---|
| A | `stats.get` + 启动日志 | 补丁真实状态是什么？日志可见吗？ |
| B | 清空投影缓存后冷读 | 不预热时打开大会话要多久、卡多久、吃多少内存？ |
| C | `session/rename`（触发 resume → `session/created`） | 预热跑成了吗？跑成后快多少？ |
| D | `session/fork` RPC | UI 的「分支会话」会调用零拷贝补丁吗？ |
| E | `debug.fork` + 同进程开关切换 | 补丁本身值多少（原生 vs 零拷贝）？ |
| F | 两次独立进程 + 环境变量定值 | 分片 materialize 的帧数/字节/耗时差异？ |
| G | 清缓存 → 冷读 → 重启 → 再读 | 冷读回写的跨进程收益（负结果） |
| H | `session/events` 的 500 条窗口 + `session/projections` | 长会话（投影主导）的字节构成与截断效果 |
| I | 重会话的首屏/翻页 + 各会话投影求和 | 消息主导型会话的页字节（1.7 MB/页）与 control 基线量级 |
| J | 连续 `beforeSeq` 回翻 | 服务端是否把 `loadThrough` 的连续分页聚合成一次 jump |

> **只有服务端**。浏览器侧的分段计时、回合跳转窗口与滚动跳变由
> `lib/client.js` 采集（`renderTiming=true`），通过 `window.__dshPerf` 驱动，
> 见 `docs/RENDER-ANALYSIS.md` §3.2/§3.4/§3.5——本工具不驱动浏览器。

## 素材生成

```sh
# 长会话：30 000 turn、小消息（投影主导）
node tools/runtime-probe/make-session-cli.mjs --home "$RT/home" \
  --id session-probe-long --events 240000 --pad 700 --cwd 'F:\dsh-rt\probe-workspace'

# 重会话：300 turn、620 次工具调用（消息主导，首屏约 1.7 MB）
node tools/runtime-probe/make-session-cli.mjs --home "$RT/home" \
  --id session-probe-heavy --turns 300 --profile tools --tool-bytes 30000 --seed 42 \
  --cwd 'F:\dsh-rt\probe-workspace'
```

`--profile` 三档：`plain`（单行随机文本）、`markdown`（标题/列表/表格/围栏代码/
公式/CJK）、`tools`（追加 bash 日志、文件读、unified diff 的 `tool/call` +
`tool/result`）。生成后用真实后端**读回自检**（事件数、turn 数、工具配对），
失败直接退出 1，不打印路径。

## 关键约束

- **不碰 `~/.dsh`**：home 与 agents home 都指向 `$RT`。
- **不发 LLM 请求**：profile 关掉 `session-title-llm`；只用
  `list`/`events`/`projections`/`rename`/`fork` 这些不触发模型调用的端点。
- **端口必须空闲**：dsh 不重试也不自动换端口，占用时整个启动失败。`startDsh`
  会先探测并在 `stop()` 里用 `taskkill /T /F` 收掉子进程树（Windows 上
  `child.kill('SIGTERM')` 不会让 node 退出）。
- **RSS 用异步采样**：同步 `execFileSync` 会堵住探测器自己的事件循环，导致正在
  await 的 RPC promise 无法推进（实测踩过）。
- **环境变量名不能写字符串字面量**：home 覆盖变量名由码点构造
  （`server.mjs` 的 `HOME_ENV`），因为本机文本处理链会改写 `DSH_` 前缀的字面量。

## 观测面

| 来源 | 能给什么 | 不能给什么 |
|---|---|---|
| `stats.get` | 补丁状态、fork 计数与逐次耗时、预热/回行计数、`alreadyHot` | 冷折叠耗时、materialize 帧数与耗时、堆用量 |
| `stats.patches` | 补丁是否装上 | **是否被真实链路调用** |
| 外部墙钟 | RPC 端到端 | 纯折叠成本（含序列化/网络） |
| pinger | 事件循环阻塞的**代理**指标 | 真实峰值（受采样间隔限制） |
| `WorkingSetSize` | 进程总内存 | V8 heapUsed（含映射文件与未回收页） |
| zstd 帧计数 | 分片是否发生 | 分片的收益 |

## 已知会踩的坑

- `session/list` 的参数名是 `_request` 而不是 `request`（descriptor 用了定义名）；
  传错会得到 `args fields do not match the descriptor`。
- `chunkedMaterialize` / `fastInitFor` 只在 install 时读一次配置，
  运行期 `config.set` 改不动 → 用 `DSH_PERF_*` 环境变量在启动时定值。
- 合成会话的事件类型必须来自 `KNOWN_SESSION_EVENT_TYPES`，`request/header` 不能带
  空的 `tools` / `adapterDefaults`，`tool/call` 必须先在同一个 header 里声明工具
  生命周期。`make-session.mjs` 已按这些约束构造（纯文本 turn，无工具调用）。
- 高重复度填充文本会被 zstd 压到 0.5% 以下，测不出真实量级；`make-session.mjs`
  用伪随机文本，24 万事件约 18 MB。
