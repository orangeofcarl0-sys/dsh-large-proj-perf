# dsh-large-proj-perf 测试依赖链接脚本
#
# 为什么需要：
#   测试（tests/*.mjs）需要真实的 dsh 内部包（@deepseek-ai/dsh-session、dsh-scope、
#   cordis、schemastery）。这些包不在本仓库依赖里——它们是全局 dsh 安装的嵌套依赖：
#     %APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\
#   Node 的 ESM 解析只从导入文件逐级向上找 node_modules，看不到全局安装目录，
#   所以直接 node tests/xxx.mjs 会报 ERR_MODULE_NOT_FOUND。
#
# 做什么：
#   在仓库根建一个 junction（node_modules\@deepseek-ai → 上述目录），测试即可
#   复用全局 dsh 的原班依赖——版本与已安装 dsh 严格一致（插件特征校验针对的
#   就是这套源码）。node_modules 已被 .gitignore。全局 dsh 升级后 junction
#   指向的内容随之更新，重跑测试即可验证插件对新版本的兼容性。
#
# 用法（PowerShell，任意目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1
# 解除链接（只删 junction，不动 dsh 安装）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\link-deps.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = 'Continue'
$log = '[dsh-link]'
$KnownDshVersions = @('0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1')   # 插件开发验证过的 dsh 版本

$DshRoot = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh'
$DshInternal = Join-Path $DshRoot 'node_modules\@deepseek-ai'
$RepoRoot = Split-Path -Parent $PSScriptRoot   # 仓库根（scripts/ 的上一级）
$LinkPath = Join-Path $RepoRoot 'node_modules\@deepseek-ai'

if ($Remove) {
  if (Get-Item $LinkPath -ErrorAction SilentlyContinue) {
    # 只删 junction 本身（cmd rmdir 不会触碰目标内容；勿用 Remove-Item -Recurse）
    cmd /c rmdir "`"$LinkPath`""
    Write-Host "$log removed $LinkPath"
  } else {
    Write-Host "$log nothing to remove"
  }
  exit 0
}

if (-not (Test-Path $DshInternal)) {
  Write-Host "$log ERROR: dsh internal packages not found at $DshInternal"
  Write-Host "$log        install dsh first: npm install -g @deepseek-ai/dsh"
  exit 1
}

# dsh 版本提示（插件与 dsh 内部结构高度耦合，版本漂移时特征校验会跳过补丁）
try {
  $dshPkg = Get-Content (Join-Path $DshRoot 'package.json') -Raw | ConvertFrom-Json
  Write-Host "$log dsh version: $($dshPkg.version)"
  if ($KnownDshVersions -notcontains $dshPkg.version) {
    Write-Host "$log WARNING: plugin verified on dsh $($KnownDshVersions -join '/'); run tests/verify_compat.mjs on this version"
  }
} catch { }

# 必需包自检
foreach ($pkg in @('dsh-session', 'dsh-scope', 'cordis', 'schemastery')) {
  if (-not (Test-Path (Join-Path $DshInternal $pkg))) {
    Write-Host "$log ERROR: required package @deepseek-ai/$pkg missing under dsh install"
    exit 1
  }
}

# 幂等：已是我们建的 junction 则直接退出
$item = Get-Item $LinkPath -ErrorAction SilentlyContinue
if ($item) {
  if ($item.LinkType -eq 'Junction') {
    Write-Host "$log already linked -> $DshInternal"
    exit 0
  }
  Write-Host "$log ERROR: $LinkPath exists and is not a junction; remove it manually and re-run"
  exit 1
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LinkPath) | Out-Null
cmd /c mklink /J "`"$LinkPath`"" "`"$DshInternal`"" | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $LinkPath)) {
  Write-Host "$log ERROR: mklink failed"
  exit 1
}
Write-Host "$log linked node_modules\@deepseek-ai -> $DshInternal"
Write-Host "$log tests ready: npm test  (or e.g. node tests/smoke_fork.mjs)"
exit 0
