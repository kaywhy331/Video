param([string]$LogPath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
if ([string]::IsNullOrWhiteSpace($LogPath)) { $LogPath = Join-Path $root 'VideoFactory-Last-Installer-Build.log' }
@('VideoFactory Desktop installer build log', ('Started: ' + (Get-Date).ToString('o')), ('Folder: ' + $root), '') |
  Set-Content -Path $LogPath -Encoding UTF8

function Invoke-LoggedCommand {
  param([string]$Executable, [string[]]$Arguments, [string]$Label)
  Write-Host "`n== $Label ==" -ForegroundColor Cyan
  Add-Content -Path $LogPath -Value "`n== $Label ==" -Encoding UTF8
  & $Executable @Arguments 2>&1 | Tee-Object -FilePath $LogPath -Append
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode." }
}

try {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $node -or -not $npm) { throw 'Node.js 22 LTS with npm is required.' }
  $nodeParts = (& $node.Source --version).TrimStart('v').Split('.')
  $nodeMajor = [int]$nodeParts[0]
  $nodeMinor = if ($nodeParts.Length -gt 1) { [int]$nodeParts[1] } else { 0 }
  if (-not (($nodeMajor -eq 22 -and $nodeMinor -ge 12) -or $nodeMajor -eq 24)) {
    throw 'Node.js 22.12+ LTS or Node.js 24 is required.'
  }
  Invoke-LoggedCommand $node.Source @('scripts/preflight.mjs', '--before-install') 'Preflight check'
  Invoke-LoggedCommand $npm.Source @('install', '--include=dev', '--no-fund', '--no-audit') 'Dependency installation'
  Invoke-LoggedCommand $npm.Source @('run', 'doctor') 'Installed dependency check'
  Invoke-LoggedCommand $npm.Source @('run', 'validate') 'Source validation'
  Invoke-LoggedCommand $npm.Source @('run', 'package:win') 'Windows installer packaging'
  Write-Host "`nInstaller build complete. Check the release folder." -ForegroundColor Green
  exit 0
} catch {
  Add-Content -Path $LogPath -Value "`nFATAL: $($_.Exception.Message)" -Encoding UTF8
  Write-Host "`nInstaller build failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Log: $LogPath" -ForegroundColor Cyan
  exit 1
}
