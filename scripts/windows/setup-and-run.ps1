param(
  [switch]$Demo,
  [switch]$SkipInstall,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $root 'VideoFactory-Last-Startup.log'
}

$logDirectory = Split-Path -Parent $LogPath
if ($logDirectory -and -not (Test-Path $logDirectory)) {
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

@(
  'VideoFactory Desktop startup log',
  ('Started: ' + (Get-Date).ToString('o')),
  ('Folder: ' + $root),
  ('Windows: ' + [System.Environment]::OSVersion.VersionString),
  ''
) | Set-Content -Path $LogPath -Encoding UTF8

function Write-Stage {
  param([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::Gray)
  Write-Host $Message -ForegroundColor $Color
  Add-Content -Path $LogPath -Value $Message -Encoding UTF8
}

function Invoke-LoggedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Write-Stage "`n== $Label ==" Cyan
  Write-Stage ("Command: {0} {1}" -f $Executable, ($Arguments -join ' ')) DarkGray

  & $Executable @Arguments 2>&1 | Tee-Object -FilePath $LogPath -Append
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode."
  }
}

try {
  Write-Stage 'VideoFactory Desktop - setup and launch' Cyan

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw 'Node.js was not found. Install the current Node.js 22 LTS Windows x64 release, then reopen this folder and run RUN-ON-WINDOWS.cmd again.'
  }

  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
  }
  if (-not $npmCommand) {
    throw 'npm was not found. Reinstall Node.js with npm enabled.'
  }

  $nodeVersionText = (& $nodeCommand.Source --version).Trim()
  $nodeParts = $nodeVersionText.TrimStart('v').Split('.')
  $nodeMajor = [int]$nodeParts[0]
  $nodeMinor = if ($nodeParts.Length -gt 1) { [int]$nodeParts[1] } else { 0 }
  Write-Stage "Node.js detected: $nodeVersionText" Green
  Write-Stage ("npm detected: " + (& $npmCommand.Source --version).Trim()) Green

  $supportedNode = (($nodeMajor -eq 22 -and $nodeMinor -ge 12) -or $nodeMajor -eq 24)
  if (-not $supportedNode) {
    throw "VideoFactory requires Node.js 22.12+ LTS or Node.js 24. Detected $nodeVersionText. Install the current Node.js 22 LTS Windows x64 release."
  }

  if (-not (Test-Path (Join-Path $root 'package.json'))) {
    throw 'package.json is missing. Make sure the ZIP was fully extracted before running the launcher.'
  }

  $package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if (-not $package.dependencies -or -not $package.devDependencies -or -not $package.devDependencies.electron) {
    throw 'This source package is incomplete because required npm dependencies are missing from package.json. Download the corrected alpha.2 package.'
  }

  Invoke-LoggedCommand -Executable $nodeCommand.Source -Arguments @('scripts/preflight.mjs', '--before-install') -Label 'Preflight check'

  if (-not $SkipInstall) {
    Invoke-LoggedCommand -Executable $npmCommand.Source -Arguments @('install', '--include=dev', '--no-fund', '--no-audit') -Label 'Dependency installation'
  }

  Invoke-LoggedCommand -Executable $npmCommand.Source -Arguments @('run', 'doctor') -Label 'Installed dependency check'

  if ($Demo) {
    Invoke-LoggedCommand -Executable $npmCommand.Source -Arguments @('run', 'demo:media') -Label 'Demo media generation'
  }

  Write-Stage "`nStarting VideoFactory Desktop..." Green
  Write-Stage 'Keep this terminal open while running the development build. Closing the Electron app will return here.' DarkGray
  Invoke-LoggedCommand -Executable $npmCommand.Source -Arguments @('run', 'dev') -Label 'VideoFactory development server'

  Write-Stage "`nVideoFactory exited normally." Green
  exit 0
}
catch {
  $message = $_.Exception.Message
  Add-Content -Path $LogPath -Value "`nFATAL: $message" -Encoding UTF8
  Add-Content -Path $LogPath -Value $_.ScriptStackTrace -Encoding UTF8

  Write-Host ''
  Write-Host 'VideoFactory could not start.' -ForegroundColor Red
  Write-Host $message -ForegroundColor Yellow
  Write-Host ''
  Write-Host "Full details were saved to:`n$LogPath" -ForegroundColor Cyan
  exit 1
}
