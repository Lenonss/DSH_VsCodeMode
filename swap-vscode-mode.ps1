# swap-vscode-mode.ps1
# Fix: the running DSH loads a stale npm copy of dsh-vscode-mode.
# This script waits for DSH to exit, moves the stale copy aside, and
# replaces it with a junction to the dev working directory so the
# freshly-built lib/ (with the MCP management UI) is what DSH loads.
#
# Usage:
#   1. Fully exit DSH (the app, not just the browser tab). You may run this
#      script FIRST; it will wait until DSH is gone.
#   2. Run this script (right-click -> Run with PowerShell, or:
#         powershell -ExecutionPolicy Bypass -File swap-vscode-mode.ps1
#   3. Restart DSH.

$target = 'D:\Work\ToolsDev\DeepSeekHarnessPlugin\packages\dsh-edit-review'
$base   = Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules'
$pkg    = Join-Path $base 'dsh-vscode-mode'

Write-Host '== dsh-vscode-mode swap script =='
Write-Host "Package path: $pkg"
Write-Host "Dev source  : $target"

# --- 1) wait until DSH (port 3080) is no longer listening ---
Write-Host 'Waiting for DSH to exit (port 3080)...'
$deadline = (Get-Date).AddMinutes(5)
for (;;) {
    $listening = netstat -ano | Select-String ':3080' | Select-String 'LISTENING'
    if (-not $listening) { break }
    if ((Get-Date) -gt $deadline) {
        Write-Host 'TIMEOUT: DSH still running after 5 min. Fully close DSH and re-run.'
        exit 1
    }
    Start-Sleep -Seconds 2
}
Write-Host 'DSH is stopped.'

# --- 2) move stale copy aside ---
if (Test-Path $pkg) {
    $stale = Join-Path $base ('dsh-vscode-mode.stale-' + (Get-Date -Format 'HHmmss'))
    Move-Item -Path $pkg -Destination $stale -Force
    Write-Host "Moved stale npm copy to: $stale"
}

# --- 3) create junction to dev working directory ---
New-Item -ItemType Junction -Path $pkg -Target $target | Out-Null
$cj = Join-Path $pkg 'lib\client.js'
$hj = Join-Path $pkg 'lib\index.js'
if (-not (Test-Path $cj) -or -not (Test-Path $hj)) { Write-Host 'ERROR: junction created but lib output missing!'; exit 1 }
$len = (Get-Item $cj).Length
$clientText = Get-Content $cj -Raw
$hostText = Get-Content $hj -Raw
Write-Host "Junction created -> $target"
Write-Host "client.js size: $len"

# --- 4) report：按内容标记核对，而不是易变的文件大小 ---
$hasLauncher = $clientText.Contains('edrv-qm-launcher')
$hasQuickRpc = $hostText.Contains('quickMenu')
Write-Host "client has quick-menu launcher: $hasLauncher"
Write-Host "host has quickMenu rpc        : $hasQuickRpc"
if (-not $hasQuickRpc) {
    Write-Host 'WARNING: 本地 lib 尚未构建出快捷菜单代码，先 npm run build 再重启 DSH。'
}
Write-Host 'OK: dev build linked. Restart DSH.'
