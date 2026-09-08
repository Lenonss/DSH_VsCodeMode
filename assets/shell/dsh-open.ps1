# dsh-open.ps1 — DSH 文件编辑 shell launcher（csc 不可用时的降级版，轻微控制台闪窗）。
# 行为与 dsh-open.cs 一致：读 dsh-open.ini base → 探测端口 → 投递待打开请求（有已打开
# DSH 页面时由其就地执行，2s 未领取取回并回退开新页）。
# 由 dsh-vscode-mode 设置页一键注册写入 HKCU\...\shell\DSHEditor\command。
# 作者 ddj 2026-09-08
param([string[]]$Path)
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3080'
$ini = Join-Path $PSScriptRoot 'dsh-open.ini'
if (Test-Path $ini) {
    foreach ($line in Get-Content $ini) {
        if ($line -match '^\s*base\s*=\s*(.+?)\s*$') { $base = $Matches[1]; break }
    }
}

$alive = $false
try {
    $uri = [Uri]$base
    $port = if ($uri.IsDefaultPort) { if ($uri.Scheme -ieq 'https') { 443 } else { 80 } } else { $uri.Port }
    $client = New-Object Net.Sockets.TcpClient
    $alive = $client.ConnectAsync($uri.Host, $port).Wait(1000) -and $client.Connected
    $client.Close()
} catch { $alive = $false }

if (-not $alive) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "DSH Web UI 未运行（$base）。`n请先启动 DSH，再使用「在 DSH 文件编辑中打开」。",
        'DSH 文件编辑') | Out-Null
    exit 1
}

$paths = @($Path | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_) })
if (-not $paths -or $paths.Count -eq 0) { exit 0 }

# 复用已有页面：投递待打开请求，clients>0 表示有页面在（2s 后确认领取，未领取取回回退）
$handoff = $null
try {
    $rpcBase = $base.TrimEnd('/') + '/edrv/rpc'
    $body = @{ method = 'edrv.external.handoff'; args = @{ paths = $paths } } | ConvertTo-Json -Depth 4 -Compress
    $handoff = Invoke-RestMethod -Uri $rpcBase -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 4
    if ($handoff.clients -gt 0) {
        Start-Sleep -Milliseconds 2000
        $stateBody = @{ method = 'edrv.external.pendingState'; args = @{ token = $handoff.token; take = $true } } | ConvertTo-Json -Depth 4 -Compress
        $state = Invoke-RestMethod -Uri $rpcBase -Method Post -ContentType 'application/json' -Body $stateBody -TimeoutSec 4
        if ($state.delivered) { exit 0 }
    }
} catch { # 移交失败回退开新页
}

$encoded = @($paths | ForEach-Object { [Uri]::EscapeDataString($_) }) -join ','
Start-Process ($base.TrimEnd('/') + '/?edrvOpen=1&edrvPaths=' + $encoded)
