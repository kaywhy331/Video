param(
  [string]$ReleaseDirectory,
  [int]$LaunchTimeoutSeconds = 90,
  [int]$UninstallTimeoutSeconds = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
if ([string]::IsNullOrWhiteSpace($ReleaseDirectory)) {
  $ReleaseDirectory = Join-Path $root 'release'
}
$ReleaseDirectory = [System.IO.Path]::GetFullPath($ReleaseDirectory)
$receiptPath = Join-Path $ReleaseDirectory 'WINDOWS_PACKAGE_SMOKE.json'
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$node = Get-Command node.exe -ErrorAction Stop
$helper = Join-Path $PSScriptRoot 'smoke-packaged-app.mjs'
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$workRoot = Join-Path $temporaryBase ("videofactory-package-smoke-{0}" -f [Guid]::NewGuid().ToString('N'))
$archiveRoot = Join-Path $workRoot 'archive'
$installRoot = Join-Path $workRoot 'installed'
$archiveDataRoot = Join-Path $workRoot 'archive-data'
$installedDataRoot = Join-Path $workRoot 'installed-data'
$sourceCommit = (& git rev-parse --verify 'HEAD^{commit}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the source commit for package smoke provenance.' }
if ($sourceCommit -notmatch '^[a-fA-F0-9]{40}$') {
  throw 'Package smoke provenance requires an exact 40-character source commit.'
}
$sourceTree = (& git rev-parse --verify 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0 -or $sourceTree -notmatch '^[a-fA-F0-9]{40}$') {
  throw 'Package smoke provenance requires an exact 40-character source tree.'
}
$workflowCommit = if ([string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) { $null } else { $env:GITHUB_SHA.Trim() }
if ($null -ne $workflowCommit -and $workflowCommit -ne $sourceCommit) {
  throw 'Package smoke HEAD does not match the workflow source commit.'
}
$sourceStatus = (& git status --porcelain=v1 --untracked-files=all) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect package smoke source cleanliness.' }
if (-not [string]::IsNullOrWhiteSpace($sourceStatus)) {
  throw 'Package smoke release evidence requires a clean source worktree and index.'
}
$sourceRef = if ([string]::IsNullOrWhiteSpace($env:GITHUB_REF)) {
  $branch = ([string](& git symbolic-ref --quiet --short HEAD)).Trim()
  if ([string]::IsNullOrWhiteSpace($branch)) { 'HEAD' } else { $branch }
} else {
  $env:GITHUB_REF.Trim()
}
$sourceRepository = if ([string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY)) {
  $remote = ([string](& git config --get remote.origin.url)).Trim()
  if ([string]::IsNullOrWhiteSpace($remote)) { 'local' } else { $remote }
} else {
  $env:GITHUB_REPOSITORY.Trim()
}

$receipt = [ordered]@{
  receiptVersion = 2
  status = 'running'
  generatedAt = $null
  appVersion = $version
  source = [ordered]@{
    commit = $sourceCommit
    tree = $sourceTree
    ref = $sourceRef
    repository = $sourceRepository
    workflowCommit = $workflowCommit
    runId = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) { $null } else { $env:GITHUB_RUN_ID }
    runAttempt = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT)) { $null } else { $env:GITHUB_RUN_ATTEMPT }
    dirty = $false
  }
  runner = [ordered]@{
    platform = 'win32'
    osVersion = [System.Environment]::OSVersion.VersionString
    architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    image = if ([string]::IsNullOrWhiteSpace($env:ImageOS)) { $null } else { $env:ImageOS }
  }
  qualification = [ordered]@{
    validation = 'release'
    scope = 'hosted_windows_package_smoke'
    cleanMachine = $false
    developerToolingPresent = $true
    productionQualification = $false
  }
  packages = [ordered]@{}
  checks = [ordered]@{}
}

function Write-SmokeReceipt {
  $receipt['generatedAt'] = (Get-Date).ToUniversalTime().ToString('o')
  $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
}

function Resolve-SinglePackage {
  param([Parameter(Mandatory = $true)][string]$Extension)

  $escapedVersion = [regex]::Escape($version)
  $matches = @(Get-ChildItem -LiteralPath $ReleaseDirectory -File | Where-Object {
    $_.Name -match "^VideoFactory-Desktop-$escapedVersion-[A-Za-z0-9_-]+\.$Extension$"
  })
  if ($matches.Count -ne 1) {
    throw "Expected exactly one VideoFactory $Extension package for $version; found $($matches.Count)."
  }
  return $matches[0]
}

function New-PackageRecord {
  param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

  return [ordered]@{
    name = $File.Name
    sizeBytes = $File.Length
    sha256 = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Resolve-SingleExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $matches = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter $Name)
  if ($matches.Count -ne 1) {
    throw "Expected exactly one $Name beneath the package root; found $($matches.Count)."
  }
  return $matches[0]
}

function Invoke-PackagedLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$DataRoot
  )

  $userDataRoot = "$DataRoot-electron"
  $resultPath = Join-Path $workRoot "$Kind-launch.json"
  & $node.Source $helper `
    --executable $Executable `
    --data-root $DataRoot `
    --user-data-root $userDataRoot `
    --expected-version $version `
    --kind $Kind `
    --result $resultPath `
    --timeout-seconds $LaunchTimeoutSeconds
  if ($LASTEXITCODE -ne 0) {
    throw "$Kind packaged application launch failed with exit code $LASTEXITCODE."
  }
  if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
    throw "$Kind packaged application launch did not produce a result."
  }
  return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
}

function Invoke-Installer {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -Wait
  if ($process.ExitCode -ne 0) {
    throw "$Label failed with exit code $($process.ExitCode)."
  }
  return $process.ExitCode
}

function Wait-ForInstallRemoval {
  $deadline = (Get-Date).AddSeconds($UninstallTimeoutSeconds)
  do {
    if (-not (Test-Path -LiteralPath $installRoot)) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "The NSIS uninstall left its installation directory after $UninstallTimeoutSeconds seconds."
}

$uninstallerPath = $null
try {
  if (-not (Test-Path -LiteralPath $ReleaseDirectory -PathType Container)) {
    throw "Release directory does not exist: $ReleaseDirectory"
  }
  New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

  $installer = Resolve-SinglePackage -Extension 'exe'
  $archive = Resolve-SinglePackage -Extension 'zip'
  $receipt['packages']['installer'] = New-PackageRecord -File $installer
  $receipt['packages']['archive'] = New-PackageRecord -File $archive

  Expand-Archive -LiteralPath $archive.FullName -DestinationPath $archiveRoot -Force
  $archiveExecutable = Resolve-SingleExecutable -Directory $archiveRoot -Name 'VideoFactory Desktop.exe'
  $receipt['checks']['archiveLaunch'] = Invoke-PackagedLaunch `
    -Kind 'archive' `
    -Executable $archiveExecutable.FullName `
    -DataRoot $archiveDataRoot

  $installStarted = Get-Date
  $installExitCode = Invoke-Installer `
    -Executable $installer.FullName `
    -Arguments @('/S', "/D=$installRoot") `
    -Label 'Silent NSIS install'
  $installedExecutable = Resolve-SingleExecutable -Directory $installRoot -Name 'VideoFactory Desktop.exe'
  $uninstaller = Resolve-SingleExecutable -Directory $installRoot -Name 'Uninstall VideoFactory Desktop.exe'
  $uninstallerPath = $uninstaller.FullName
  $receipt['checks']['installerInstall'] = [ordered]@{
    status = 'passed'
    exitCode = $installExitCode
    durationMs = [int]((Get-Date) - $installStarted).TotalMilliseconds
    executablePresent = $true
    uninstallerPresent = $true
  }

  $receipt['checks']['installedLaunch'] = Invoke-PackagedLaunch `
    -Kind 'installed' `
    -Executable $installedExecutable.FullName `
    -DataRoot $installedDataRoot

  $uninstallStarted = Get-Date
  $uninstallExitCode = Invoke-Installer `
    -Executable $uninstallerPath `
    -Arguments @('/S') `
    -Label 'Silent NSIS uninstall'
  Wait-ForInstallRemoval
  $uninstallerPath = $null
  $receipt['checks']['uninstall'] = [ordered]@{
    status = 'passed'
    exitCode = $uninstallExitCode
    durationMs = [int]((Get-Date) - $uninstallStarted).TotalMilliseconds
    installDirectoryRemoved = $true
  }

  $receipt['status'] = 'passed'
  Write-SmokeReceipt
  Write-Host "Packaged Windows smoke passed; receipt: $receiptPath" -ForegroundColor Green
} catch {
  $receipt['status'] = 'failed'
  $receipt['failure'] = [ordered]@{
    message = $_.Exception.Message
    type = $_.Exception.GetType().FullName
  }
  Write-SmokeReceipt
  throw
} finally {
  if ($uninstallerPath -and (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    try {
      Invoke-Installer -Executable $uninstallerPath -Arguments @('/S') -Label 'Failure cleanup uninstall' | Out-Null
    } catch {
      Write-Warning "Failure cleanup could not run the package uninstaller: $($_.Exception.Message)"
    }
  }

  $resolvedWorkRoot = [System.IO.Path]::GetFullPath($workRoot)
  $expectedPrefix = $temporaryBase.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar + 'videofactory-package-smoke-'
  if ($resolvedWorkRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedWorkRoot)) {
    Remove-Item -LiteralPath $resolvedWorkRoot -Recurse -Force
  }
}
