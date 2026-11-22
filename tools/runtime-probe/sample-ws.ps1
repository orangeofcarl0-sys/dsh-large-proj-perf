param(
  [Parameter(Mandatory = $true)][string]$ProcessIds,
  [int]$IntervalMs = 200
)

# 持续输出 "epochMs,pid,WorkingSetBytes"。Node 侧按 pid 聚合。
Write-Output ("debug raw=[{0}] type={1}" -f $ProcessIds, $ProcessIds.GetType().FullName)
$parts = $ProcessIds.Split(',')
Write-Output ("debug parts={0} count={1}" -f ($parts -join '|'), $parts.Count)
$ids = @($parts | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
if ($ids.Count -eq 0) {
  Write-Error "no process ids: [$ProcessIds]"
  exit 2
}
while ($true) {
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ($null -ne $p) {
      Write-Output ("{0},{1},{2}" -f $ts, $p.Id, $p.WorkingSet64)
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
