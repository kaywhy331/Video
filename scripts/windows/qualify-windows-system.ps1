param(
  [Parameter(Mandatory = $true)][string]$ReleaseDirectory,
  [Parameter(Mandatory = $true)][ValidateSet('nvidia', 'intel', 'amd', 'software')][string]$HardwareClass,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._ -]{2,79}$')][string]$DeviceClass,
  [string]$StorageMatrixPath,
  [string]$OutputPath = (Join-Path (Get-Location) 'SYSTEM_QUALIFICATION_OBSERVATION.json'),
  [ValidateRange(30, 300)][int]$LaunchTimeoutSeconds = 120,
  [ValidateRange(15, 180)][int]$UninstallTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$observationVersion = 1
$evidenceKind = 'videofactory-windows-system-observation'
$ReleaseDirectory = [System.IO.Path]::GetFullPath($ReleaseDirectory)
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if ($StorageMatrixPath) { $StorageMatrixPath = [System.IO.Path]::GetFullPath($StorageMatrixPath) }
$outputTemporaryPath = "$OutputPath.tmp-$([Guid]::NewGuid().ToString('N'))"
if (Test-Path -LiteralPath $OutputPath -PathType Container) { throw 'OutputPath must identify a file.' }
if (Test-Path -LiteralPath $OutputPath -PathType Leaf) { Remove-Item -LiteralPath $OutputPath -Force }

function Get-LowerSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
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

function Resolve-OneFile {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Pattern,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $matches = @(Get-ChildItem -LiteralPath $Directory -File | Where-Object { $_.Name -match $Pattern })
  if ($matches.Count -ne 1) { throw "Expected exactly one $Label; found $($matches.Count)." }
  return $matches[0]
}

function Resolve-InstalledFile {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $matches = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter $Name)
  if ($matches.Count -ne 1) { throw "Expected exactly one installed $Name; found $($matches.Count)." }
  return $matches[0]
}

function Invoke-NativeProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $started = Get-Date
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "$Label failed with exit code $($process.ExitCode)." }
  return [ordered]@{
    status = 'passed'
    exitCode = $process.ExitCode
    durationMs = [int]((Get-Date) - $started).TotalMilliseconds
  }
}

function Read-QualificationEvents {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw 'The packaged application did not write its system qualification event stream.'
  }
  $lines = @(Get-Content -LiteralPath $Path | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($lines.Count -lt 4) { throw 'The system qualification event stream is incomplete.' }
  $events = @()
  for ($index = 0; $index -lt $lines.Count; $index++) {
    $event = $lines[$index] | ConvertFrom-Json
    if ($event.schemaVersion -ne 1 -or $event.sequence -ne ($index + 1)) {
      throw 'The system qualification event stream has an invalid schema or sequence.'
    }
    $events += $event
  }
  return $events
}

function Assert-ReleaseChecksums {
  param([Parameter(Mandatory = $true)][string]$Directory)
  $sumPath = Join-Path $Directory 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $sumPath -PathType Leaf)) { throw 'SHA256SUMS.txt is missing.' }
  $verified = 0
  $records = @{}
  foreach ($line in Get-Content -LiteralPath $sumPath) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -notmatch '^([a-f0-9]{64})  ([^\\/:*?""<>|]+)$') {
      throw "Malformed SHA256SUMS entry: $line"
    }
    $file = Join-Path $Directory $Matches[2]
    if ($records.ContainsKey($Matches[2])) { throw "SHA256SUMS repeats an artifact: $($Matches[2])" }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Checksummed artifact is missing: $($Matches[2])" }
    if ((Get-LowerSha256 -Path $file) -ne $Matches[1]) { throw "Artifact checksum mismatch: $($Matches[2])" }
    $records[$Matches[2]] = $Matches[1]
    $verified += 1
  }
  if ($verified -lt 10) { throw 'The release checksum set is unexpectedly incomplete.' }
  return [pscustomobject]@{ Count = $verified; Records = $records }
}

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [System.Runtime.InteropServices.OSPlatform]::Windows
)) { throw 'Windows system qualification must run on Windows.' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant() -ne 'x64') {
  throw 'Windows system qualification requires x64 Windows.'
}
if (-not (Test-Path -LiteralPath $ReleaseDirectory -PathType Container)) {
  throw "Release directory does not exist: $ReleaseDirectory"
}
if ($StorageMatrixPath -and -not (Test-Path -LiteralPath $StorageMatrixPath -PathType Leaf)) {
  throw "Storage matrix input does not exist: $StorageMatrixPath"
}

$ciVariables = @('CI', 'GITHUB_ACTIONS', 'TF_BUILD', 'JENKINS_URL', 'TEAMCITY_VERSION', 'APPVEYOR')
$activeCiVariables = @($ciVariables | Where-Object { -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
if ($activeCiVariables.Count -ne 0) { throw "Qualification cannot run in CI: $($activeCiVariables -join ', ')." }

$developerCommands = @('node', 'npm', 'npx', 'python', 'python3', 'py', 'pip', 'git', 'devenv', 'msbuild')
$presentDeveloperCommands = @($developerCommands | Where-Object { $null -ne (Get-Command $_ -ErrorAction SilentlyContinue) })
if ($presentDeveloperCommands.Count -ne 0) {
  throw "Clean-install qualification requires no developer toolchain commands: $($presentDeveloperCommands -join ', ')."
}
$developerEnvironmentVariables = @(
  'NODE_OPTIONS', 'NODE_PATH', 'npm_config_user_agent', 'PYTHONPATH', 'VIRTUAL_ENV',
  'CONDA_PREFIX', 'VisualStudioVersion', 'VSINSTALLDIR', 'VSCODE_GIT_ASKPASS_NODE'
)
$activeDeveloperEnvironment = @($developerEnvironmentVariables | Where-Object {
  -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
})
if ($activeDeveloperEnvironment.Count -ne 0) {
  throw "Clean-install qualification found a developer environment: $($activeDeveloperEnvironment -join ', ')."
}
$machineGuid = [string](Get-ItemPropertyValue `
  -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' `
  -Name 'MachineGuid')
if ($machineGuid -notmatch '^[A-Fa-f0-9-]{32,40}$') { throw 'Windows MachineGuid is unavailable or malformed.' }
$machineFingerprintSha256 = Get-TextSha256 -Value "videofactory-windows-machine:v1:$machineGuid"

$provenancePath = Join-Path $ReleaseDirectory 'RELEASE_PROVENANCE.json'
if (-not (Test-Path -LiteralPath $provenancePath -PathType Leaf)) { throw 'RELEASE_PROVENANCE.json is missing.' }
$provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
if ($provenance.appVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
  throw 'Release provenance has an unsupported app version.'
}
if ($provenance.source.commit -notmatch '^[a-f0-9]{40}$' -or $provenance.source.tree -notmatch '^[a-f0-9]{40}$') {
  throw 'Release provenance does not contain exact source identities.'
}
if ($provenance.source.dirty -ne $false) { throw 'Release provenance source is dirty.' }

$checksumEvidence = Assert-ReleaseChecksums -Directory $ReleaseDirectory
$verifiedChecksums = $checksumEvidence.Count
$manifestArtifacts = @($provenance.artifacts)
if ($manifestArtifacts.Count -lt 9) { throw 'Release provenance contains an incomplete artifact inventory.' }
$manifestArtifactNames = @($manifestArtifacts | ForEach-Object { [string]$_.name })
if (@($manifestArtifactNames | Select-Object -Unique).Count -ne $manifestArtifactNames.Count) {
  throw 'Release provenance repeats an artifact name.'
}
$expectedChecksumNames = @(($manifestArtifactNames + 'RELEASE_PROVENANCE.json') | Sort-Object)
$actualChecksumNames = @($checksumEvidence.Records.Keys | ForEach-Object { [string]$_ } | Sort-Object)
if (($expectedChecksumNames -join "`n") -ne ($actualChecksumNames -join "`n")) {
  throw 'SHA256SUMS does not exactly match the release provenance inventory.'
}
foreach ($artifact in $manifestArtifacts) {
  $name = [string]$artifact.name
  if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Release provenance contains an unsafe artifact name: $name" }
  $path = Join-Path $ReleaseDirectory $name
  if ([long]$artifact.sizeBytes -ne (Get-Item -LiteralPath $path).Length) {
    throw "Release provenance size mismatch: $name"
  }
  if ([string]$artifact.sha256 -ne $checksumEvidence.Records[$name]) {
    throw "Release provenance checksum mismatch: $name"
  }
}
if (-not $checksumEvidence.Records.ContainsKey('QUALIFY_WINDOWS_SYSTEM.ps1')) {
  throw 'The released Windows system qualifier is not checksummed.'
}
if ((Get-LowerSha256 -Path $PSCommandPath) -ne $checksumEvidence.Records['QUALIFY_WINDOWS_SYSTEM.ps1']) {
  throw 'The executing qualifier bytes do not match the released checksummed qualifier.'
}
$escapedVersion = [regex]::Escape([string]$provenance.appVersion)
$installer = Resolve-OneFile -Directory $ReleaseDirectory -Pattern "^VideoFactory-Desktop-$escapedVersion-x64\.exe$" -Label 'release installer'
$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("videofactory-system-qualification-{0}" -f [Guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $workRoot 'installed'
$dataRoot = Join-Path $workRoot 'first-run-data'
$userDataRoot = Join-Path $workRoot 'electron-user-data'
$eventPath = Join-Path $dataRoot 'qualification\windows-package-runtime.jsonl'
$dataRootInitiallyAbsent = -not (Test-Path -LiteralPath $dataRoot)
$uninstallerPath = $null
$previousDataRoot = $env:VIDEOFACTORY_DEV_DATA_ROOT
$previousSystemFlag = $env:VIDEOFACTORY_SYSTEM_QUALIFICATION
$previousStorageInput = $env:VIDEOFACTORY_SYSTEM_QUALIFICATION_INPUT
$observation = $null

try {
  New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
  $install = Invoke-NativeProcess -Executable $installer.FullName -Arguments @('/S', "/D=$installRoot") -Label 'Silent clean install'
  $installedExecutable = Resolve-InstalledFile -Directory $installRoot -Name 'VideoFactory Desktop.exe'
  $uninstaller = Resolve-InstalledFile -Directory $installRoot -Name 'Uninstall VideoFactory Desktop.exe'
  $uninstallerPath = $uninstaller.FullName

  $env:VIDEOFACTORY_DEV_DATA_ROOT = $dataRoot
  $env:VIDEOFACTORY_SYSTEM_QUALIFICATION = '1'
  if ($StorageMatrixPath) { $env:VIDEOFACTORY_SYSTEM_QUALIFICATION_INPUT = $StorageMatrixPath }
  else { Remove-Item Env:VIDEOFACTORY_SYSTEM_QUALIFICATION_INPUT -ErrorAction SilentlyContinue }

  $startedAt = Get-Date
  $process = Start-Process -FilePath $installedExecutable.FullName -ArgumentList @(
    "--user-data-dir=$userDataRoot",
    '--disable-gpu'
  ) -PassThru
  if (-not $process.WaitForExit($LaunchTimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "The packaged application did not finish qualification within $LaunchTimeoutSeconds seconds."
  }
  if ($process.ExitCode -ne 0) { throw "The packaged application exited with code $($process.ExitCode)." }
  $launchDurationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds

  $events = @(Read-QualificationEvents -Path $eventPath)
  $start = @($events | Where-Object { $_.event -eq 'qualification_started' })
  $diagnostics = @($events | Where-Object { $_.event -eq 'system_diagnostics' })
  $renderer = @($events | Where-Object { $_.event -eq 'renderer_ready' })
  $storage = @($events | Where-Object { $_.event -eq 'storage_probe' })
  $storageIntegrity = @($events | Where-Object { $_.event -eq 'storage_matrix_complete' })
  if ($start.Count -ne 1 -or $start[0].details.scope -ne 'windows_system') {
    throw 'The packaged application did not enter Windows system qualification scope.'
  }
  if ($diagnostics.Count -ne 1) { throw 'The packaged application did not record exactly one diagnostic observation.' }
  if ($renderer.Count -ne 1) { throw 'The packaged application did not record exactly one renderer observation.' }
  if ($storageIntegrity.Count -ne 1) { throw 'The packaged application did not record storage/database completion integrity.' }
  if (
    $storageIntegrity[0].details.databaseIntegrity -ne 'ok' `
      -or $storageIntegrity[0].details.databaseUnchanged -ne $true
  ) { throw 'Storage qualification changed or corrupted application database state.' }
  if (
    $renderer[0].details.activeView -ne 'settings' `
      -or $renderer[0].details.initialSetupRequired -ne $true `
      -or $renderer[0].details.setupReady -ne $false `
      -or $renderer[0].details.setupChecklistVisible -ne $true
  ) { throw 'The clean first run did not open the fail-closed setup checklist.' }

  $expectedHardwareKey = @{
    nvidia = 'nvencUsable'
    intel = 'qsvUsable'
    amd = 'amfUsable'
    software = 'softwareUsable'
  }[$HardwareClass]
  if ($diagnostics[0].details.$expectedHardwareKey -ne $true -or $diagnostics[0].details.softwareUsable -ne $true) {
    throw "The $HardwareClass encoder observation or software fallback did not pass."
  }
  if ($StorageMatrixPath) {
    $storageInput = Get-Content -LiteralPath $StorageMatrixPath -Raw | ConvertFrom-Json
    if ($storage.Count -ne @($storageInput.cases).Count) { throw 'The packaged storage observation count does not match its input matrix.' }
    if (@($storage | Where-Object { $_.details.matched -ne $true }).Count -ne 0) {
      throw 'One or more storage failure modes were not actually observed.'
    }
  }

  $databasePath = Join-Path $dataRoot 'data\videofactory.sqlite'
  if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) { throw 'The first run did not initialize SQLite.' }
  $database = Get-Item -LiteralPath $databasePath
  $installedExecutableSha256 = Get-LowerSha256 -Path $installedExecutable.FullName
  $uninstall = Invoke-NativeProcess -Executable $uninstallerPath -Arguments @('/S') -Label 'Silent uninstall'
  $deadline = (Get-Date).AddSeconds($UninstallTimeoutSeconds)
  while ((Test-Path -LiteralPath $installRoot) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-Path -LiteralPath $installRoot) { throw 'The uninstaller did not remove its isolated installation directory.' }
  $uninstallerPath = $null

  $observation = [ordered]@{
    observationVersion = $observationVersion
    evidenceKind = $evidenceKind
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    appVersion = [string]$provenance.appVersion
    source = $provenance.source
    runner = [ordered]@{
      platform = 'win32'
      architecture = 'x64'
      osVersion = [System.Environment]::OSVersion.VersionString
      ci = $false
      deviceClass = $DeviceClass
      machineFingerprintSha256 = $machineFingerprintSha256
      hardwareClass = $HardwareClass
    }
    environment = [ordered]@{
      cleanMachine = $true
      developerEnvironmentPresent = $false
      developerCommandsPresent = @()
      dataRootInitiallyAbsent = $dataRootInitiallyAbsent
    }
    artifacts = [ordered]@{
      verifiedChecksums = $verifiedChecksums
      installer = [ordered]@{
        name = $installer.Name
        sizeBytes = $installer.Length
        sha256 = (Get-LowerSha256 -Path $installer.FullName)
      }
      releaseProvenanceSha256 = (Get-LowerSha256 -Path $provenancePath)
      qualifierSha256 = (Get-LowerSha256 -Path $PSCommandPath)
    }
    installation = [ordered]@{
      install = $install
      executableSha256 = $installedExecutableSha256
      executablePresent = $true
      uninstallerPresent = $true
      launch = [ordered]@{
        status = 'passed'
        exitCode = $process.ExitCode
        durationMs = $launchDurationMs
      }
      databaseInitialized = $true
      databaseSizeBytes = $database.Length
      firstRunSetupObserved = $true
      uninstall = $uninstall
      installDirectoryRemoved = $true
    }
    eventStream = [ordered]@{
      sha256 = (Get-LowerSha256 -Path $eventPath)
      eventCount = $events.Count
    }
    diagnostics = $diagnostics[0].details
    renderer = $renderer[0].details
    storage = @($storage | ForEach-Object { $_.details })
    storageIntegrity = $storageIntegrity[0].details
  }

  $parent = Split-Path -Parent $OutputPath
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $json = $observation | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($outputTemporaryPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $outputTemporaryPath -Destination $OutputPath
  Write-Host "Windows system observation passed: $OutputPath" -ForegroundColor Green
} finally {
  if ($uninstallerPath -and (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    try { Invoke-NativeProcess -Executable $uninstallerPath -Arguments @('/S') -Label 'Failure cleanup uninstall' | Out-Null }
    catch { Write-Warning "Failure cleanup could not uninstall: $($_.Exception.Message)" }
  }
  $env:VIDEOFACTORY_DEV_DATA_ROOT = $previousDataRoot
  $env:VIDEOFACTORY_SYSTEM_QUALIFICATION = $previousSystemFlag
  $env:VIDEOFACTORY_SYSTEM_QUALIFICATION_INPUT = $previousStorageInput
  if (Test-Path -LiteralPath $outputTemporaryPath -PathType Leaf) {
    Remove-Item -LiteralPath $outputTemporaryPath -Force
  }
  if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
}
