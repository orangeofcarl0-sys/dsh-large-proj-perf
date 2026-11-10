# 运行时探测报告归档

本目录的 `report.json` / `report.md` 是 `docs/RUNTIME-ANALYSIS.md` 所引数据的原始输出，
由 [`tools/runtime-probe/run.mjs`](../../tools/runtime-probe/run.mjs) 生成。

- 被测 dsh：`0.2.2-rc.1`
- 被测插件：`1.6.0`
- 素材：24 万事件、约 19 MB（zstd）的 v4 会话
- 已脱敏：`home` 换为 `<isolated-home>`，所有 launch token 换为 `<redacted>`

复跑：

```sh
node tools/runtime-probe/run.mjs --home <隔离 home> --agents <agents home> \
  --port 3190 --scenario all --out <输出目录>
```

数字会随机器负载波动（同日两次完整运行中，同一场景的绝对值可差 1.5 倍），
**比例与状态量（`warmed` / `pluginForks` / 帧数）才是结论**。
