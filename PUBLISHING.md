# 发布流程（npm）

本插件以**非 scoped 公共包**发布（与 `dsh-better-sidebar`、`dsh-spend` 等社区插件一致），
包名 `dsh-large-proj-perf`。

## 发布约定（对照官方与社区插件）

| 约定 | 我们的取值 | 依据 |
|---|---|---|
| 包名 | 非 scoped，`dsh-` 前缀 | `dsh-better-sidebar` / `dsh-spend` / `dsh-fresh-start` |
| `publishConfig.access` | `public` | 所有权威插件均显式声明（防误设私有 / 发布被拒） |
| `type` | `module` | 官方包与社区插件一致（ESM） |
| `main` / `exports` | `lib/index.js` + `.` 与 `./package.json` | 官方包 `exports` 亦含 `./package.json` |
| `files` | 白名单：`lib`、`scripts`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE` | 社区插件用白名单；避免发测试与开发产物 |
| `license` / `repository` / `bugs` / `homepage` | 齐备 | 官方包与社区插件均齐备 |
| `engines.node` | `>=22.15.0` | 依赖 `node:zlib` 的 zstd 接口 |
| `peerDependencies` | 真实依赖的 dsh 包 + `@deepseek-ai/cordis` | dsh 0.2.0 起据此做加载门禁 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | dsh 加载插件的必需声明 |
| `scripts.prepublishOnly` | `npm test` | 发布前强制跑全套测试 |

注意：声明 `files` 白名单后，npm 只自动附带 `package.json`、`README*`、`LICENSE*`
与 `main` 指向的文件——`CHANGELOG.md` 必须显式列入白名单才会发布。
`PUBLISHING.md`、`tests/`、`.github/` 等由 `files` 白名单与 `.npmignore` 排除。

## 发布前检查清单

```sh
# 1) 全套测试必须全绿（prepublishOnly 也会再跑一次）
npm test

# 2) 检查真实安装源码的特征断言与 peer 门禁复算
node tests/verify_compat.mjs

# 3) 检查实际打包内容（不产生文件）
npm run pack:check

# 4) 确认版本号与 CHANGELOG 对应（版本号只在 package.json 一处）
grep '"version"' package.json
```

打包内容应只含：`LICENSE`、`README.md`、`CHANGELOG.md`、`cordis.patch.yml`、
`package.json`、`lib/**`、`scripts/*.ps1`。**不应**出现 `tests/`、`*.log`、`*.tgz`、
`node_modules/`。

## 发布

```sh
# 首次（或凭证过期后）：登录官方 registry
npm login --registry=https://registry.npmjs.org

# 发布（publishConfig.access=public 已声明，无需额外参数）
npm publish
```

> 本机 `registry.npmjs.org` 直连可能不通，需经代理（见 `~/.dsh` 下的升级记录）：
> ```sh
> export npm_config_proxy=socks5h://127.0.0.1:10808
> export npm_config_https_proxy=socks5h://127.0.0.1:10808
> ```
> 注意：**发布必须走官方 registry**（`registry.npmjs.org`），镜像站只读、不可发布。

## 版本号策略

- 插件版本（`1.x.y`）与 dsh 版本区间各自独立演进；
- **仅扩展支持的 dsh 版本区间**（不改变任何插件行为）→ patch（`1.3.1`）；
- 新增能力 / 适配 dsh 破坏性变更并调整代码 → minor（`1.4.0`）；
- 破坏插件自身 API（配置键移除、导出变更）→ major（`2.0.0`）。

升级 dsh 大版本（如 0.3）时，**必须同步更新 `peerDependencies` 的范围上界**，
否则 dsh 会因门禁跳过本插件（见 README「插件管理：0.2.0 的 peer 门禁」）。

## 安装（面向用户）

```sh
# 从 npm 安装
dsh plugin --profile web add dsh-large-proj-perf

# 或从 GitHub 安装（跟踪 master）
dsh plugin --profile web add github:orangeofcarl0-sys/dsh-large-proj-perf
```

`file:` 安装不会自动跟随仓库改动，需手动同步 `lib/`、`cordis.patch.yml`、
`package.json` 或重新 `dsh plugin add`。
