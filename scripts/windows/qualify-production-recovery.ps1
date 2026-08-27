param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('provider', 'ingest', 'render', 'upload_session', 'upload_commit', 'restore')]
  [string]$Kind,
  [Parameter(Mandatory = $true)][string]$DatabasePath,
  [Parameter(Mandatory = $true)][string]$WorkId,
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$InitialPid,
  [Parameter(Mandatory = $true)][string]$AppExecutable,
  [Parameter(Mandatory = $true)][string]$ReleaseProvenance,
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._ -]{7,119}$')]
  [string]$DeviceClass,
  [string]$OutputPath = '',
  [ValidateRange(30, 7200)][int]$BoundaryTimeoutSeconds = 1800,
  [ValidateRange(30, 14400)][int]$CompletionTimeoutSeconds = 3600,
  [ValidateRange(1, 30)][int]$PollIntervalSeconds = 2,
  [string]$NodeExecutable = 'node'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$DatabasePath = [System.IO.Path]::GetFullPath($DatabasePath)
$AppExecutable = [System.IO.Path]::GetFullPath($AppExecutable)
$ReleaseProvenance = [System.IO.Path]::GetFullPath($ReleaseProvenance)
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path (Get-Location) "validation\results\production-recovery-$Kind-observation.json"
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$recorderPath = Join-Path $repositoryRoot 'scripts\production-recovery-observation.mjs'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
  'videofactory-production-recovery-{0}' -f [Guid]::NewGuid().ToString('N')
)
$beforePath = Join-Path $temporaryRoot 'before.json'
$afterPath = Join-Path $temporaryRoot 'after.json'
$processPath = Join-Path $temporaryRoot 'process.json'
$previousDataRoot = $env:VIDEOFACTORY_DEV_DATA_ROOT

function Get-CanonicalTimestamp {
  param([Parameter(Mandatory = $true)][DateTime]$Value)
  return $Value.ToUniversalTime().ToString(
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [System.Globalization.CultureInfo]::InvariantCulture
  )
}

function Get-TextSha256 {
  param([Parameter(Mandatory = $true)][string]$Value)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Write-Utf8Json {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )
  $json = $Value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($Path, "$json`n", [System.Text.UTF8Encoding]::new($false))
}

function Invoke-GitText {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = & git -C $repositoryRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $($output -join ' ')" }
  return (($output | Out-String).Trim())
}

function Invoke-GitOptionalText {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = & git -C $repositoryRoot @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return '' }
  return (($output | Out-String).Trim())
}

function Test-CheckoutClean {
  $status = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=all 2>&1)
  return $LASTEXITCODE -eq 0 -and $status.Count -eq 0
}

function Invoke-SnapshotCapture {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('before', 'after')][string]$Phase,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][int]$ProcessId
  )
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    Remove-Item -LiteralPath $Destination -Force
  }
  $messages = @(& $script:resolvedNode $recorderPath capture `
    "--database=$DatabasePath" `
    "--kind=$Kind" `
    "--work-id=$WorkId" `
    "--phase=$Phase" `
    "--release-provenance=$ReleaseProvenance" `
    "--app=$AppExecutable" `
    "--process-id=$ProcessId" `
    "--output=$Destination" 2>&1)
  return [pscustomobject]@{
    Passed = $LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $Destination -PathType Leaf)
    Message = (($messages | ForEach-Object { [string]$_ }) -join "`n").Trim()
  }
}

function Wait-ForSnapshot {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('before', 'after')][string]$Phase,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][int]$WatchedPid
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastMessage = ''
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-Process -Id $WatchedPid -ErrorAction SilentlyContinue)) {
      throw "The packaged application process $WatchedPid exited before the $Phase recovery boundary was captured."
    }
    $capture = Invoke-SnapshotCapture -Phase $Phase -Destination $Destination -ProcessId $WatchedPid
    if ($capture.Passed) { return }
    $lastMessage = $capture.Message
    Start-Sleep -Seconds $PollIntervalSeconds
  }
  throw "Timed out waiting for the $Phase recovery boundary. Last recorder result: $lastMessage"
}

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [System.Runtime.InteropServices.OSPlatform]::Windows
)) { throw 'Production recovery qualification must run on Windows.' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant() -ne 'x64') {
  throw 'Production recovery qualification requires x64 Windows.'
}

$ciVariables = @('CI', 'GITHUB_ACTIONS', 'TF_BUILD', 'JENKINS_URL', 'TEAMCITY_VERSION', 'APPVEYOR')
$activeCiVariables = @($ciVariables | Where-Object {
  -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
})
if ($activeCiVariables.Count -ne 0) {
  throw "Production recovery qualification cannot run in CI: $($activeCiVariables -join ', ')."
}

foreach ($requiredFile in @($DatabasePath, $AppExecutable, $ReleaseProvenance, $recorderPath)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required production recovery file is missing: $requiredFile"
  }
}
if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) {
  throw "Production recovery data root is missing: $DataRoot"
}
$expectedDatabasePath = [System.IO.Path]::GetFullPath((Join-Path $DataRoot 'data\videofactory.sqlite'))
if (-not $DatabasePath.Equals($expectedDatabasePath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'DatabasePath must be the database owned by the supplied packaged-application DataRoot.'
}
if (Test-Path -LiteralPath $OutputPath -PathType Container) { throw 'OutputPath must identify a JSON file.' }
if (Test-Path -LiteralPath $OutputPath -PathType Leaf) { Remove-Item -LiteralPath $OutputPath -Force }

$nodeCommand = Get-Command $NodeExecutable -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) { throw "Node executable was not found: $NodeExecutable" }
$resolvedNode = $nodeCommand.Source
$nodeVersion = ((& $resolvedNode --version 2>&1) | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v[0-9]+\.') {
  throw 'The Node executable could not report a supported version.'
}
if ($null -eq (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'git is required to prove the exact clean source checkout.'
}

$provenance = Get-Content -LiteralPath $ReleaseProvenance -Raw | ConvertFrom-Json
if ($provenance.qualification -ne 'release' -or $provenance.source.dirty -ne $false) {
  throw 'Release provenance is not clean release-qualified provenance.'
}
$headCommit = Invoke-GitText -Arguments @('rev-parse', 'HEAD')
$headTree = Invoke-GitText -Arguments @('rev-parse', 'HEAD^{tree}')
if ($headCommit -ne [string]$provenance.source.commit -or $headTree -ne [string]$provenance.source.tree) {
  throw 'The checkout HEAD/tree does not match the packaged release provenance.'
}
if (-not (Test-CheckoutClean)) {
  throw 'Production recovery qualification requires a clean exact checkout; ignored generated observations are allowed.'
}
$sourceRef = Invoke-GitOptionalText -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD')
if ([string]::IsNullOrWhiteSpace($sourceRef)) { $sourceRef = 'HEAD' }
$sourceRepository = Invoke-GitOptionalText -Arguments @('config', '--get', 'remote.origin.url')
if ([string]::IsNullOrWhiteSpace($sourceRepository)) { $sourceRepository = 'local' }

$initialProcess = Get-Process -Id $InitialPid -ErrorAction SilentlyContinue
if ($null -eq $initialProcess) { throw "Initial packaged application process is not running: $InitialPid" }
try {
  $initialProcessPath = [System.IO.Path]::GetFullPath([string]$initialProcess.Path)
  if (-not $initialProcessPath.Equals($AppExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'InitialPid does not belong to the supplied packaged application executable.'
  }
} catch [System.ComponentModel.Win32Exception] {
  throw 'The packaged application process path could not be inspected.'
}

$machineGuid = [string](Get-ItemPropertyValue `
  -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' `
  -Name 'MachineGuid')
if ($machineGuid -notmatch '^[A-Fa-f0-9-]{32,40}$') { throw 'Windows MachineGuid is unavailable or malformed.' }
$machineFingerprintSha256 = Get-TextSha256 -Value "videofactory-production-recovery-machine:v1:$machineGuid"
$startedAt = Get-CanonicalTimestamp -Value (Get-Date)

try {
  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  Write-Host "Waiting for the $Kind forced-termination boundary..."
  Wait-ForSnapshot -Phase 'before' -Destination $beforePath `
    -TimeoutSeconds $BoundaryTimeoutSeconds -WatchedPid $InitialPid

  $taskkillOutput = @(& taskkill.exe /PID $InitialPid /T /F 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Forced process-tree termination failed: $($taskkillOutput -join ' ')"
  }
  $killDeadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $killDeadline -and $null -ne (Get-Process -Id $InitialPid -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 250
  }
  if ($null -ne (Get-Process -Id $InitialPid -ErrorAction SilentlyContinue)) {
    throw 'Forced termination returned successfully, but the initial process exit was not observed.'
  }
  $killedAt = Get-CanonicalTimestamp -Value (Get-Date)

  $env:VIDEOFACTORY_DEV_DATA_ROOT = $DataRoot
  $restartedProcess = Start-Process -FilePath $AppExecutable -PassThru
  if ($restartedProcess.Id -eq $InitialPid) { throw 'The restarted packaged application reused the terminated PID.' }
  $restartedAt = Get-CanonicalTimestamp -Value (Get-Date)

  Write-Host "Waiting for verified $Kind recovery completion..."
  Wait-ForSnapshot -Phase 'after' -Destination $afterPath `
    -TimeoutSeconds $CompletionTimeoutSeconds -WatchedPid $restartedProcess.Id
  $completedAt = Get-CanonicalTimestamp -Value (Get-Date)

  $trace = [ordered]@{
    startedAt = $startedAt
    killedAt = $killedAt
    restartedAt = $restartedAt
    completedAt = $completedAt
    terminationMethod = 'windows_terminate_process'
    forced = $true
    processTree = $true
    exitObserved = $true
    initialPid = $InitialPid
    restartedPid = $restartedProcess.Id
    source = [ordered]@{
      commit = $headCommit
      tree = $headTree
      ref = $sourceRef
      repository = $sourceRepository
      workflowCommit = $null
      runId = $null
      runAttempt = $null
      dirty = $false
    }
    environment = [ordered]@{
      platform = 'win32'
      architecture = 'x64'
      release = [Environment]::OSVersion.Version.ToString()
      node = $nodeVersion
      ci = $false
      deviceClass = $DeviceClass
      machineFingerprintSha256 = $machineFingerprintSha256
    }
  }
  Write-Utf8Json -Path $processPath -Value $trace

  $finalizeMessages = @(& $resolvedNode $recorderPath finalize `
    "--before=$beforePath" `
    "--after=$afterPath" `
    "--process=$processPath" `
    "--output=$OutputPath" 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
    throw "Production recovery observation finalization failed: $($finalizeMessages -join ' ')"
  }
  Write-Host "Production recovery raw observation written: $OutputPath"
  Write-Host "Restarted packaged application PID: $($restartedProcess.Id)"
  Write-Warning 'The raw observation contains hashed and local work identifiers. Keep it private; only the six-file collector emits the privacy-preserving receipt.'
} finally {
  if ($null -eq $previousDataRoot) {
    Remove-Item Env:VIDEOFACTORY_DEV_DATA_ROOT -ErrorAction SilentlyContinue
  } else {
    $env:VIDEOFACTORY_DEV_DATA_ROOT = $previousDataRoot
  }
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
