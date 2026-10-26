<#
.SYNOPSIS
  Installs, upgrades or removes Switchboard on Windows (docs/setup.md -> One-line install).

.DESCRIPTION
  irm https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.ps1 | iex

  With options:
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.ps1))) -Service

  Downloads a GitHub release of Switchboard and its .sha256, verifies the checksum with
  Get-FileHash (nothing is unpacked on a mismatch), unpacks it into
  <Dir>\switchboard-<version> (the layout of the manual install, which the in-app updater
  takes over from: docs/updates.md), runs `npm ci --omit=dev`, optionally registers the
  login service (a Task Scheduler logon task, tools/service/install.ts) and starts
  Switchboard. Running it again upgrades to the latest release or repairs the installed one.

  It never asks for administrator rights, never edits profiles and sends no telemetry: the
  only network requests are GitHub (the release) and the npm registry (`npm ci`).

  Environment: SWITCHBOARD_VERSION, SWITCHBOARD_PORT (default 13001), SWITCHBOARD_DATA_DIR,
  SWITCHBOARD_UPDATE_REPO (owner/name, forks) and, for tests, SWITCHBOARD_INSTALL_SOURCE (a
  folder URL such as file:///C:/temp/release holding switchboard-<v>.tar.gz and its .sha256).

.PARAMETER Dir
  Install folder (default: %LOCALAPPDATA%\Programs\Switchboard).
.PARAMETER Version
  Install that release (x.y.z) instead of the latest.
.PARAMETER Service
  Also start Switchboard at login.
.PARAMETER NoService
  Do not register the login service (the default without an interactive console).
.PARAMETER NoStart
  Install only; do not start Switchboard.
.PARAMETER Uninstall
  Stop it, remove the login service and the install folder; keeps your data.
.PARAMETER Purge
  With -Uninstall: also remove the data folder.
#>
[CmdletBinding()]
param(
  [string]$Dir,
  [string]$Version,
  [switch]$Service,
  [switch]$NoService,
  [switch]$NoStart,
  [switch]$Uninstall,
  [switch]$Purge
)

# Everything runs in a child scope: under `irm ... | iex` the script shares the caller's
# session, which must keep its own preferences, variables and functions.
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0

function Fail([string]$Message) {
  throw "switchboard install: $Message"
}

function Say([string]$Message) {
  Write-Host $Message
}

$Repo = if ($env:SWITCHBOARD_UPDATE_REPO) { $env:SWITCHBOARD_UPDATE_REPO } else { 'MarcinGadomski94/switchboard' }
$Port = if ($env:SWITCHBOARD_PORT) { $env:SWITCHBOARD_PORT } else { '13001' }
$Source = $env:SWITCHBOARD_INSTALL_SOURCE
if (-not $Version -and $env:SWITCHBOARD_VERSION) { $Version = $env:SWITCHBOARD_VERSION }
$MarkerName = '.switchboard-install'

if ($Purge -and -not $Uninstall) { Fail '-Purge only goes with -Uninstall' }
if ($Service -and $NoService) { Fail 'choose -Service or -NoService, not both' }
if ($Port -notmatch '^\d+$') { Fail "SWITCHBOARD_PORT must be a number, got $Port" }
if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 'Windows PowerShell 5 or PowerShell 7 is needed' }
if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) { Fail 'install.ps1 is for Windows; on macOS and Linux use install.sh (docs/setup.md)' }

$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
if (-not $Dir) { $Dir = Join-Path $LocalAppData 'Programs\Switchboard' }
$Dir = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\')
if ($Dir -eq [System.IO.Path]::GetPathRoot($Dir).TrimEnd('\') -or $Dir -eq $HOME.TrimEnd('\')) { Fail "refusing to use $Dir as the install folder" }
$DataDir = if ($env:SWITCHBOARD_DATA_DIR) { $env:SWITCHBOARD_DATA_DIR } else { Join-Path $LocalAppData 'Switchboard' }
$DataDir = [System.IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$ServiceDefinition = Join-Path $DataDir 'service\switchboard-task.xml'
$Url = "http://127.0.0.1:$Port"
$PidFile = Join-Path $Dir 'switchboard.pid'
$LogFile = Join-Path $Dir 'switchboard.log'

function Show-NodeHelp([string]$Problem) {
  Write-Warning $Problem
  Say ''
  Say 'Switchboard needs Node.js 24 or newer (with npm) on PATH. Install it, open a new terminal, then run this again:'
  Say '  winget install OpenJS.NodeJS.LTS'
  Say 'Nothing was installed.'
}

function Test-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Show-NodeHelp 'Node.js was not found.'; Fail 'Node.js 24 or newer is needed' }
  $major = 0
  $text = "$(& node --version 2>$null)"
  if ($text -match '^v(\d+)\.') { $major = [int]$Matches[1] }
  if ($major -lt 24) { Show-NodeHelp "Node.js $text is too old."; Fail 'Node.js 24 or newer is needed' }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Show-NodeHelp 'npm was not found next to Node.js.'; Fail 'npm is needed' }
}

function Get-ReleaseVersion([string]$Text) {
  if ($Text -match '^v?(\d+)\.(\d+)\.(\d+)$') { return "$([int]$Matches[1]).$([int]$Matches[2]).$([int]$Matches[3])" }
  return $null
}

function Get-LocalPath([string]$FileUrl) {
  return ([System.Uri]$FileUrl).LocalPath
}

function Save-File([string]$From, [string]$To) {
  if ($From.StartsWith('file://')) {
    Copy-Item -LiteralPath (Get-LocalPath $From) -Destination $To
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $From -OutFile $To -UseBasicParsing -Headers @{ 'User-Agent' = 'switchboard-installer' }
  }
}

function Resolve-Version {
  if ($Version) {
    $v = Get-ReleaseVersion $Version
    if (-not $v) { Fail "`"$Version`" is not a release version (x.y.z)" }
    return $v
  }
  if ($Source) {
    if (-not $Source.StartsWith('file://')) { Fail 'SWITCHBOARD_INSTALL_SOURCE needs -Version unless it is a file:// folder' }
    $best = $null
    foreach ($file in Get-ChildItem -LiteralPath (Get-LocalPath $Source) -Filter 'switchboard-*.tar.gz' -File) {
      if ($file.Name -match '^switchboard-(\d+\.\d+\.\d+)\.tar\.gz$') {
        $candidate = [version]$Matches[1]
        if ($null -eq $best -or $candidate -gt $best) { $best = $candidate }
      }
    }
    if ($null -eq $best) { Fail "no switchboard-<version>.tar.gz in $(Get-LocalPath $Source)" }
    return $best.ToString()
  }
  Say "Looking up the latest release of $Repo..."
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'switchboard-installer' } -UseBasicParsing
    if (-not $release.draft -and -not $release.prerelease) {
      $v = Get-ReleaseVersion $release.tag_name
      if ($v) { return $v }
    }
  } catch {
    Write-Verbose "GitHub API: $_"
  }
  Fail "could not find the latest release of $Repo (GitHub rate limit?); pass -Version x.y.z"
}

function Get-ExpectedHash([string]$File, [string]$Name) {
  $lines = @(Get-Content -LiteralPath $File | Where-Object { $_.Trim() -ne '' })
  if ($lines.Count -ne 1) { return $null }
  if ($lines[0].Trim() -match '^([0-9a-fA-F]{64}) [ *](.+)$' -and $Matches[2] -eq $Name) { return $Matches[1].ToLowerInvariant() }
  return $null
}

function Get-HttpStatus {
  try {
    $response = Invoke-WebRequest -Uri "$Url/" -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0 -ErrorAction Stop
    return [int]$response.StatusCode
  } catch {
    $inner = $_.Exception
    if ($inner.PSObject.Properties['Response'] -and $inner.Response) { return [int]$inner.Response.StatusCode }
    return 0
  }
}

function Get-ServiceText {
  if (-not (Test-Path -LiteralPath $ServiceDefinition)) { return $null }
  return [System.IO.File]::ReadAllText($ServiceDefinition)
}

function Test-ServicePointsHere {
  $text = Get-ServiceText
  if ($null -eq $text) { return $false }
  return $text.Contains("$Dir\") -or $text.Contains((Join-Path $DataDir 'versions') + '\')
}

function Get-StartedProcess {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$id)) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -and $process.CommandLine.Contains($Dir) -and $process.CommandLine.Contains('main.ts')) { return $id }
  return $null
}

function Stop-Started {
  $id = Get-StartedProcess
  if ($id) {
    Say "Stopping the Switchboard this installer started (pid $id)..."
    Stop-Process -Id $id -ErrorAction SilentlyContinue
    Wait-Process -Id $id -Timeout 30 -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Wait-ForAnswer {
  for ($i = 0; $i -lt 60; $i++) {
    if ((Get-HttpStatus) -ne 0) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Invoke-Checked([string]$WorkingDirectory, [string]$Command, [string[]]$Arguments, [string]$Problem) {
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { Fail $Problem }
  } finally {
    Pop-Location
  }
}

function Test-WantService([string]$NewVersion) {
  if ($Service) { return $true }
  if ($NoService) { return $false }
  if (Test-ServicePointsHere) {
    Say "The login service already starts this install: keeping it, pointed at $NewVersion."
    return $true
  }
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
    $answer = Read-Host 'Start Switchboard at login (a logon task)? [y/N]'
    return $answer -match '^(y|yes)$'
  }
  return $false
}

function Install-Switchboard {
  Test-Node
  $v = Resolve-Version
  $name = "switchboard-$v.tar.gz"
  $base = if ($Source) { $Source.TrimEnd('/') } else { "https://github.com/$Repo/releases/download/v$v" }
  $app = Join-Path $Dir "switchboard-$v"
  $marker = Join-Path $Dir $MarkerName
  $previous = $null
  if (Test-Path -LiteralPath $marker) {
    $line = Get-Content -LiteralPath $marker | Where-Object { $_ -like 'version=*' } | Select-Object -First 1
    if ($line) { $previous = $line.Substring(8).Trim() }
  }
  if (Test-Path -LiteralPath $app) { Say "Repairing Switchboard $v in $app" } else { Say "Installing Switchboard $v into $app" }

  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $work = Join-Path $Dir ".staging-$PID"
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $work 'unpacked') | Out-Null
  try {
    Say "Downloading $name..."
    $checksumFile = Join-Path $work "$name.sha256"
    $tarball = Join-Path $work $name
    Save-File "$base/$name.sha256" $checksumFile
    Save-File "$base/$name" $tarball
    $expected = Get-ExpectedHash $checksumFile $name
    if (-not $expected) { Fail "$name.sha256 is not a sha256 line for $name; nothing was installed" }
    $actual = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Fail "checksum mismatch for $name (expected $expected, got $actual); nothing was installed" }
    Say "Checksum OK ($actual)"

    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar' }
    $entries = & $tar -tzf $tarball
    if ($LASTEXITCODE -ne 0) { Fail "$name is not a readable tar.gz" }
    foreach ($entry in $entries) {
      if (-not $entry.StartsWith("switchboard-$v/") -or $entry -match '(^|[/\\])\.\.([/\\]|$)') { Fail "$name has entries outside switchboard-$v/; nothing was installed" }
    }
    Invoke-Checked $work $tar @('-xzf', $name, '-C', 'unpacked') "unpacking $name failed"
    $staged = Join-Path $work "unpacked\switchboard-$v"
    $packaged = (Get-Content -LiteralPath (Join-Path $staged 'package.json') -Raw | ConvertFrom-Json).version
    if ($packaged -ne $v) { Fail "the package says version `"$packaged`", not $v" }
    if (-not (Test-Path -LiteralPath (Join-Path $staged 'src\server\main.ts')) -or -not (Test-Path -LiteralPath (Join-Path $staged 'dist\web\index.html'))) { Fail 'the package misses src\server\main.ts or dist\web; nothing was installed' }

    Say 'Installing dependencies (npm ci --omit=dev)...'
    Invoke-Checked $staged 'npm.cmd' @('ci', '--omit=dev', '--no-audit', '--no-fund') 'npm ci failed; nothing was installed'

    if (-not $NoStart -or (Test-Path -LiteralPath $app)) { Stop-Started }
    if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination (Join-Path $work 'replaced') }
    Move-Item -LiteralPath $staged -Destination $app
    Set-Content -LiteralPath $marker -Value "version=$v" -Encoding ASCII
    Say "Installed Switchboard $v in $app"
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }

  $startedByService = $false
  if (Test-WantService $v) {
    Say 'Registering the login service (Task Scheduler)...'
    $serviceArgs = @('tools\service\install.ts')
    if (-not $NoStart) { $serviceArgs += '--start' }
    Invoke-Checked $app 'node' $serviceArgs 'registering the login service failed (see above)'
    $startedByService = -not $NoStart
  }

  $serviceText = Get-ServiceText
  foreach ($old in Get-ChildItem -LiteralPath $Dir -Directory -Filter 'switchboard-*') {
    if ($old.FullName -eq $app) { continue }
    if ($previous -and $old.Name -eq "switchboard-$previous") { continue }
    if ($serviceText -and $serviceText.Contains($old.FullName + '\')) { continue }
    Remove-Item -LiteralPath $old.FullName -Recurse -Force
    Say "Removed the older $($old.FullName)"
  }

  if ($NoStart) {
    Say ''
    Say "Done. Start it with:  Set-Location `"$app`"; npm start   then open $Url"
    return
  }
  if (-not $startedByService) {
    if ((Get-HttpStatus) -ne 0) {
      Write-Warning "Something already answers on $Url (another Switchboard?); not starting a second one."
      Say "Stop it first, or set SWITCHBOARD_PORT, then run npm start in $app"
      return
    }
    Say 'Starting Switchboard...'
    $node = (Get-Command node).Source
    $process = Start-Process -FilePath $node -ArgumentList @("`"$(Join-Path $app 'src\server\main.ts')`"") -WorkingDirectory $app -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -PassThru
    Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII
  }
  if (-not (Wait-ForAnswer)) { Fail "Switchboard did not answer on $Url within 60 s; see $LogFile" }
  Say ''
  Say "Switchboard $v is running: open $Url"
  if (-not $startedByService) { Say "It runs in the background (log: $LogFile). Run this installer again with -Service to start it at login." }
}

function Test-Removable {
  if (Test-Path -LiteralPath (Join-Path $Dir $MarkerName)) { return $true }
  foreach ($entry in Get-ChildItem -LiteralPath $Dir -Force) {
    if ($entry.Name -notmatch '^(switchboard-|\.staging-)' -and $entry.Name -notin @('switchboard.log', 'switchboard.log.err', 'switchboard.pid')) { return $false }
  }
  return $true
}

function Uninstall-Switchboard {
  Say "Uninstalling Switchboard from $Dir"
  $installed = Test-Path -LiteralPath $Dir
  if ($installed) { Stop-Started }
  if (Test-ServicePointsHere) {
    $candidates = @()
    if ($installed) { $candidates += @(Get-ChildItem -LiteralPath $Dir -Directory -Filter 'switchboard-*' | ForEach-Object { $_.FullName }) }
    $versions = Join-Path $DataDir 'versions'
    if (Test-Path -LiteralPath $versions) { $candidates += @(Get-ChildItem -LiteralPath $versions -Directory | ForEach-Object { $_.FullName }) }
    $app = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'tools\service\uninstall.ts') } | Select-Object -First 1
    if ($app -and (Get-Command node -ErrorAction SilentlyContinue)) {
      Say 'Removing the login service...'
      try {
        Invoke-Checked $app 'node' @('tools\service\uninstall.ts') 'removing the login service failed'
      } catch {
        Write-Warning "Removing the login service failed; run npm run service:uninstall in $app"
      }
    } else {
      Write-Warning "The login service $ServiceDefinition points here but no install is left to remove it; run schtasks /Delete /TN Switchboard /F"
    }
  } elseif (Test-Path -LiteralPath $ServiceDefinition) {
    Say "Leaving the login service alone: it starts a Switchboard from another folder ($ServiceDefinition)."
  }
  if ($installed) {
    if (-not (Test-Removable)) { Fail "$Dir holds files this installer did not make; remove it by hand" }
    Remove-Item -LiteralPath $Dir -Recurse -Force
    Say "Removed $Dir"
  } else {
    Say "Nothing installed in $Dir"
  }
  foreach ($folder in @((Join-Path $DataDir 'versions'), (Join-Path $DataDir 'updates'))) {
    if (Test-Path -LiteralPath $folder) {
      Remove-Item -LiteralPath $folder -Recurse -Force
      Say "Removed $folder (versions the in-app updater installed)"
    }
  }
  if ($Purge) {
    if ($DataDir -eq [System.IO.Path]::GetPathRoot($DataDir).TrimEnd('\') -or $DataDir -eq $HOME.TrimEnd('\')) { Fail "refusing to purge $DataDir" }
    if (Test-Path -LiteralPath $DataDir) {
      Remove-Item -LiteralPath $DataDir -Recurse -Force
      Say "Removed your data in $DataDir"
    }
  } elseif (Test-Path -LiteralPath $DataDir) {
    Say "Kept your data in $DataDir (run with -Uninstall -Purge to remove it too)"
  }
}

if ($Uninstall) { Uninstall-Switchboard } else { Install-Switchboard }
}
