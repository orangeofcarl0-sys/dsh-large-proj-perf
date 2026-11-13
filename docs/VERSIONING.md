# 版本号与发布节奏

> 本文是版本号规则的唯一来源。当前版本值只看 `package.json` 的 `version`；
> 本文不写死版本号，避免漂移。

## 1. 一句话

**版本号在发布时决定，不在每轮开发结束时决定。** 开发中的变更先累积在
[CHANGELOG.md](../CHANGELOG.md) 的 `[Unreleased]` 下；决定发布时，才按变更性质
选 MAJOR / MINOR / PATCH。

## 2. 为什么改

npm 上可见的版本序列是 `1.4.0 → 1.10.1 → 1.16.0`，看起来像跳号。实际原因是：

| npm 可见 | 本地 CHANGELOG | 说明 |
|---|---|---|
| 1.4.0 | 1.4.0 | 旧习惯发布 |
| — | 1.5–1.9 | 开发轮次，版本号每轮 +1，但从未 publish |
| 1.10.1 | 1.10.1 | 最后一次按旧习惯发布 |
| — | 1.11–1.15 | 开发轮次，未 publish |
| 1.16.0 | 1.16.0 | 当前发布；含 1.11–1.16 全部变更 |

内容没有丢，但版本号失去了发布语义，而且把破坏性变更（1.11.0 收紧
`engines.dsh`）埋进了 minor。从 1.16.0 起执行本文规则；**已发布的 1.16.0 不回滚、
不重发**。

## 3. 选号规则

| 变更性质 | 号 | 例子 |
|---|---|---|
| **破坏性**：`engines.dsh` 收紧到不兼容、移除配置键或能力、改变默认行为、导出变更 | **MAJOR** | 1.11.0 把 engines 从 `>=0.1.0-rc.6` 收紧到 `>=0.2.2-rc.1`，按本规则应为 2.0.0 |
| **新增能力**：新配置键（默认关）、新诊断字段、可观察的行为改进 | **MINOR** | 新增 `renderTiming` / `stats.render.sends` |
| **修复与杂项**：bug 修复、文档、元数据、只扩展支持的 dsh 版本且不改行为 | **PATCH** | 1.10.1 |

判定顺序：先看有没有破坏性，再看有没有新增能力，最后才是 patch。

**`engines.dsh` 的收紧一律算 MAJOR**，即使代码零改动——用户升级后插件会被加载
门禁拒绝，这是实实在在的破坏。

## 4. 开发中的版本

- 不逐轮改 `package.json`。内部轮次的变更全部写在 `## [Unreleased]`。
- 需要发布测试版时用预发布号：`X.Y.Z-dev.N` / `X.Y.Z-rc.N`，并显式
  `npm publish --tag next`；`latest` 只指向稳定版。
- 一个版本号只能发布一次。发布前先确认不存在：
  `npm view dsh-large-proj-perf@<version> version`。

## 5. 发布清单

1. `npm test` 全绿（`prepublishOnly` 会再跑一次）。
2. 把 `[Unreleased]` 改成 `## [X.Y.Z] — YYYY-MM-DD`，按 §3 选号。
3. `package.json` 的 `version` 改成同一个值。
4. `npm pack --dry-run` 核对文件清单。
5. 提交 `release: X.Y.Z`，打 `vX.Y.Z` tag。
6. `npm publish --registry https://registry.npmjs.org`。
7. `npm view dsh-large-proj-perf version dist-tags.latest` 确认指向新版本。
8. push commit 与 tag。

具体命令与 registry 注意事项见 [PUBLISHING.md](PUBLISHING.md)。

## 6. 发错了怎么办

- 优先**向前修**：发一个新的 PATCH / MINOR，而不是删版本。
- 只有发布 72 小时内、且属于安全 / 法律 / 不可修复的元数据错误时，才考虑
  `npm unpublish`；它会让已安装的用户看到版本消失。
- 已 push 的 tag 不删改；补一个新版本，tag 跟着新版本走。

## 7. 与文档的关系

- `package.json` 的 `version` 是当前值；`CHANGELOG.md` 的第一个版本条目必须与它
  相等。这条由 `tests/verify_docs.mjs` 断言。
- 文档正文不写死当前版本号；需要指代版本时用「当前发布」或相对描述。
- 历史条目保留发布当时的版本号与数字，不随新版本回改。
