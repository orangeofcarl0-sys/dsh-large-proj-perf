# 发布流程（npm）

> **验证边界**：本文的流程以 **dsh 0.2.2-rc.1**、npm 11.x 为基准。命令行为若变化，
> 以实际输出为准。

本文面向发布者：清单约定、发布前检查、发布与核验、版本号策略。

## 发布约定

| 项 | 约定 | 依据 |
|---|---|---|
| 包名 | 非 scoped，`dsh-` 前缀 | 与其他社区插件一致（`dsh-better-sidebar`、`dsh-spend` 等） |
| `publishConfig.access` | `public` | 所有权威插件都显式声明，防误设私有 / 发布被拒 |
| `type` | `module` | 与官方包一致（ESM） |
| `main` / `exports` | `lib/index.js`；显式暴露 `./locale/*.json`、`./cordis.patch.yml`、`./package.json` | 宿主经 Node 解析读取 locale 与 patch 子路径 |
| `files` | 白名单：`lib`、`scripts`、`docs`、`locale/*.json`、`icon.svg`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE` | 避免发布测试与开发产物 |
| `engines.node` | `>=22.15.0` | 依赖 `node:zlib` 的 zstd 接口 |
| `engines.dsh` | 与支持的 dsh 区间一致 | dsh 0.2.1+ 的加载门禁只读此项 |
| `peerDependencies` | 与 `engines.dsh` 保持一致 | 0.2.0 及之前的门禁读此项 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | dsh 加载插件的必需声明 |
| `icon` + `locale/*.json` | 双语标题、描述、图标 | 插件管理器的展示元数据 |
| `scripts.prepublishOnly` | `npm test` | 发布前强制跑全套测试 |

声明 `files` 白名单后，npm 只自动附带 `package.json`、`README*`、`LICENSE*` 与
`main` 指向的文件。`CHANGELOG.md`、`docs/` 必须显式列入白名单才会发布。
`tests/`、`tools/` 不在白名单内，因此不会发布——这是有意的：`tests/` 需要 junction
到全局 dsh，对终端用户无意义。

## 发布前检查清单

```sh
# 0) 前置：把全局 dsh 的嵌套依赖 junction 到仓库（否则下一步必失败）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1

# 1) 全套测试必须全绿（prepublishOnly 也会再跑一次）
npm test

# 2) 确认打包内容
npm pack --dry-run

# 3) 确认版本号与 CHANGELOG 对应
grep '"version"' package.json
```

打包内容应含：`LICENSE`、`README.md`、`CHANGELOG.md`、`cordis.patch.yml`、
`icon.svg`、`locale/*.json`、`docs/**`、`package.json`、`lib/**`、`scripts/*.ps1`。
**不应**出现 `tests/`、`tools/`、`*.log`、`*.tgz`、`node_modules/`。

> `scripts/` 会被发布（用户需要 `start-dsh.ps1`）；**开发者专用脚本放 `tools/`**
> （不在白名单内）。当前 `scripts/` 下只有 PowerShell 脚本，若将来放入 shell 脚本，
> 注意 `files: ["scripts"]` 会把它们一并发布。

`prepublishOnly` 跑的是 `npm test` → `tests/run.mjs`，它让每个套件在独立子进程中
执行：早期版本把所有套件串在同一个 Node 进程里，重负载套件（zstd 压缩/解压数十 MB）
累积的堆碎片会在发布时偶发触发 V8 崩溃（实测 exit 134）。子进程隔离既消除该崩溃，
也让单个套件的失败不掩盖其余套件的结论。

## 发布

```sh
# 首次（或凭证过期后）：登录官方 registry
npm login --registry=https://registry.npmjs.org

# 发布（publishConfig.access=public 已声明，无需额外参数）
npm publish
```

**必须走官方 registry**（`registry.npmjs.org`）——镜像站只读，不可发布。若本机到
官方 registry 的直连不通，按你的网络环境自行配置代理，例如：

```sh
export npm_config_proxy=<your-proxy-url>
export npm_config_https_proxy=<your-proxy-url>
```

### 发布后核验

```sh
# 1) 确认 dist-tag 指向新版本
npm view dsh-large-proj-perf dist-tags

# 2) 拉回 tarball 并比对 shasum（与发布输出里的 shasum 应一致）
npm pack dsh-large-proj-perf@<version>

# 3) 解包检查内容
tar -tzf dsh-large-proj-perf-<version>.tgz
```

`npm publish` 报成功后，registry 的完整元数据可能有数分钟传播延迟，期间 tarball
可能返回 404。此时**不要重复发布**（会因版本已存在而失败），按上面的命令轮询即可。

```sh
# 建 tag（建议）
git tag -a v<version> -m "<version>"
git push origin v<version>
```

## 版本号策略

- 插件版本（`1.x.y`）与 dsh 版本区间各自独立演进。
- **仅扩展支持的 dsh 版本、不改任何插件行为** → patch。
- **新增能力，或适配 dsh 破坏性变更并改代码** → minor。
- **破坏插件自身 API**（配置键移除、导出变更） → major。

升级 dsh 大版本（如 0.3）时，**必须同步更新 `engines.dsh` 的上界**，否则 dsh 会因
门禁跳过本插件（见 `docs/COMPATIBILITY.md`「两个版本的区分」）。

**版本号以 `package.json` 为唯一来源。** 文档中不写死版本号，避免漂移。
