# Windows fallback launcher. The shared helper validates the private queue and waits for ACK.
# @author ddj 2026-09-28
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Path)
$ErrorActionPreference = 'Stop'
if (-not $Path -or $Path.Count -eq 0) { exit 0 }
try {
    $ini = Join-Path $PSScriptRoot 'dsh-open.ini'
    $config = @{}
    foreach ($line in [IO.File]::ReadAllLines($ini)) {
        $equal = $line.IndexOf('=')
        if ($equal -gt 0) { $config[$line.Substring(0, $equal).Trim()] = $line.Substring($equal + 1).Trim() }
    }
    foreach ($key in @('node', 'helper')) {
        $value = $config[$key]
        if (-not $value -or -not [IO.Path]::IsPathRooted($value) -or
            [IO.Path]::GetFullPath($value) -ine $value -or -not [IO.File]::Exists($value)) {
            throw "Missing absolute $key in DSH bridge configuration."
        }
    }
    if ([IO.Path]::GetExtension($config.node) -ine '.exe') { throw 'A stored Node or Electron executable is required.' }
    if ($config.nodeMode -notin @('node', 'electron')) { throw 'Missing nodeMode in DSH bridge configuration.' }
    if ($config.nodeMode -eq 'electron') { $env:ELECTRON_RUN_AS_NODE = '1' }
    else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    $absolute = @($Path | ForEach-Object { [IO.Path]::GetFullPath($_) })
    & $config.node $config.helper --config $ini -- @absolute
    if ($LASTEXITCODE -ne 0) { throw 'DSH OPEN was not confirmed. See the producer error above.' }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'DSH 文件编辑') | Out-Null
    exit 1
}
