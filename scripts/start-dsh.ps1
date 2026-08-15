# dsh-large-proj-perf 推荐启动脚本
# 停止旧 dsh web → 以 --max-old-space-size=8192 重启 → 自动打开浏览器
#
# 为什么需要这个脚本：
#   多个超大会话（数十万事件）的 live 事件树每个 ~700MB，默认 V8 heap 上限
#   ~4GB 会让 dsh 在内存叠加时 OOM。本插件运行时会把冷会话 LRU 降到 1
#   （省 ~2.8GB），但 V8 heap 上限是启动期参数、进程内改不了，必须通过
#   启动参数 --max-old-space-size 提高。此脚本封装了这一步骤。
#
# 用法（PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dsh.ps1
# 或复制到任意位置双击/快捷方式调用。

$ErrorActionPreference = 'Continue'
$log = '[dsh-start]'
$Url = 'http://127.0.0.1:3080'
$MaxOldSpaceMb = 8192   # V8 heap 上限（MB）；大会话场景建议 >= 8192

Write-Host "$log stopping dsh..."
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match '@deepseek-ai[/\\]+dsh[/\\]+lib[/\\]+bin\.js' })
if ($procs.Count -gt 0) {
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    $still = netstat -ano | Select-String ':3080\s.*LISTENING'
    if (-not $still) { break }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "$log stopped ($($procs.Count) process(es))."
} else {
  Write-Host "$log no running dsh found; starting fresh."
}

Write-Host "$log starting dsh web (max-old-space-size=$MaxOldSpaceMb)..."
$bin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$node = (Get-Command node.exe).Source
$cmd = "start `"`" /min `"$node`" --max-old-space-size=$MaxOldSpaceMb `"$bin`" web"
Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" `
  -ArgumentList '/c', $cmd `
  -WorkingDirectory $env:USERPROFILE `
  -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(30)
$ready = $false
while ((Get-Date) -lt $deadline) {
  $listening = netstat -ano | Select-String ':3080\s.*LISTENING'
  if ($listening) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}
if ($ready) {
  Write-Host "$log dsh is up at $Url"
  Start-Process $Url
  exit 0
} else {
  Write-Host "$log WARNING: port 3080 not ready after 30s; open $Url manually."
  exit 1
}
