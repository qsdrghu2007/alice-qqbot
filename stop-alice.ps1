param([switch]$WhatIf)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$port = 3210
try {
    $config = Get-Content -LiteralPath (Join-Path $root "data\config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $config.port) { $port = [int]$config.port }
} catch {
    $port = 3210
}

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
    Write-Host "Alice 未运行（端口 $port 没有监听）。"
    exit 0
}

$owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
$targets = @()
foreach ($ownerPid in $owners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -eq "node.exe") {
        $targets += $ownerPid
    }
}

if ($targets.Count -eq 0) {
    Write-Host "端口 $port 被其他程序占用，未关闭。"
    exit 1
}

foreach ($ownerPid in $targets) {
    if ($WhatIf) {
        Write-Host "将关闭 Alice（PID $ownerPid）。"
        continue
    }

    Write-Host "正在关闭 Alice（PID $ownerPid）..."
    & taskkill.exe /PID $ownerPid /T /F 2>$null | Out-Null
}

if ($WhatIf) { exit 0 }

Start-Sleep -Seconds 1
$still = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($still.Count -eq 0) {
    Write-Host "Alice 已关闭。"
    exit 0
}

Write-Host "端口 $port 仍在监听，请手动检查。"
exit 1
