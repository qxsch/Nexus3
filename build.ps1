<#
.SYNOPSIS
  Builds the NEXUS-3 desktop packages into build-artifact/.

.EXAMPLE
  .\build.ps1                                  # Windows MSI, x64, version 1.0.0
  .\build.ps1 -Os windows -Arch arm64
  .\build.ps1 -Os linux -Arch all -Version 1.2.0
  .\build.ps1 -Os all -Arch all -Version 1.2.0
  .\build.ps1 -Os macos -Arch all              # only on a Mac

.DESCRIPTION
  Windows MSIs are per-user installers and must be built on Windows (WiX requirement).
  Linux AppImages are built natively on Linux, or in the electronuserland/builder
  container everywhere else. macOS packages only build on macOS, so `-Os all` covers
  Windows and Linux and macOS has to be asked for by name.
#>
#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('windows', 'linux', 'macos', 'all')]
    [string]$Os = 'windows',

    [ValidateSet('x64', 'arm', 'arm64', 'all')]
    [string]$Arch = 'x64',

    [string]$Version = '1.0.0',

    # Force the Linux build through Docker even on a Linux host.
    [switch]$Docker,

    # Produce an unpacked app directory instead of installers (fast smoke test).
    [switch]$Dir,

    [switch]$SkipInstall,

    [string]$DockerImage = 'electronuserland/builder:latest'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$DesktopDir = Join-Path $Root 'desktop'
$OutDir = Join-Path $Root 'build-artifact'
$OnWindows = [bool]$IsWindows

if ($Version -notmatch '^\d+\.\d+\.\d+([-+].+)?$') {
    throw "Version must look like 1.2.3 (got '$Version')."
}

$targets = if ($Os -eq 'all') { @('windows', 'linux') } else { @($Os) }
$arches = switch ($Arch) {
    'all' { @('x64', 'arm64') }
    'arm' { @('arm64') }
    default { @($Arch) }
}

Write-Host ""
Write-Host "NEXUS-3 build" -ForegroundColor Cyan
Write-Host "  version   $Version"
Write-Host "  os        $($targets -join ', ')"
Write-Host "  arch      $($arches -join ', ')"
Write-Host "  output    $OutDir"
Write-Host ""

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not (Test-Path (Join-Path $DesktopDir 'build/icon.png'))) {
    if ($OnWindows) {
        Write-Host "-> generating app icon" -ForegroundColor DarkGray
        & pwsh -NoProfile -File (Join-Path $DesktopDir 'build/make-icon.ps1')
    }
    else {
        throw "desktop/build/icon.png is missing. Regenerate it on Windows with desktop/build/make-icon.ps1."
    }
}

function Invoke-Checked {
    param([string]$Exe, [string[]]$Arguments, [string]$WorkDir)
    Write-Host "-> $Exe $($Arguments -join ' ')" -ForegroundColor DarkGray
    Push-Location $WorkDir
    try {
        & $Exe @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Exe exited with $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}

function Install-Deps {
    if ($SkipInstall) { return }
    if (Test-Path (Join-Path $DesktopDir 'node_modules/electron')) { return }
    $cmd = if (Test-Path (Join-Path $DesktopDir 'package-lock.json')) { 'ci' } else { 'install' }
    Invoke-Checked -Exe 'npm' -Arguments @($cmd, '--no-audit', '--no-fund') -WorkDir $DesktopDir
}

function Build-Windows {
    if (-not $OnWindows) {
        throw "Windows MSI packages can only be built on Windows (WiX toolset). Run this script on your Windows machine."
    }
    Install-Deps
    $builderArgs = @('--no-install', 'electron-builder', '--config', 'electron-builder.yml')
    if ($Dir) { $builderArgs += @('--dir', '--win') } else { $builderArgs += @('--win', 'msi') }
    foreach ($a in $arches) { $builderArgs += "--$a" }
    $builderArgs += @("-c.extraMetadata.version=$Version", "-c.directories.output=$OutDir", '--publish', 'never')
    Invoke-Checked -Exe 'npx' -Arguments $builderArgs -WorkDir $DesktopDir
}

function Build-Linux {
    $useDocker = $Docker -or $OnWindows -or $IsMacOS
    $archFlags = ($arches | ForEach-Object { "--$_" }) -join ' '
    $targetFlag = if ($Dir) { '--dir --linux' } else { '--linux AppImage' }

    if (-not $useDocker) {
        Install-Deps
        $builderArgs = @('--no-install', 'electron-builder', '--config', 'electron-builder.yml') +
                       ($targetFlag -split ' ') +
                       ($arches | ForEach-Object { "--$_" }) +
                       @("-c.extraMetadata.version=$Version", "-c.directories.output=$OutDir", '--publish', 'never')
        Invoke-Checked -Exe 'npx' -Arguments $builderArgs -WorkDir $DesktopDir
        return
    }

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker is required to build Linux packages from $([System.Environment]::OSVersion.Platform). Install Docker Desktop or run this script on Linux."
    }

    # Linux node_modules must not collide with the host's, hence the named volume.
    $inner = "npm install --no-audit --no-fund && npx --no-install electron-builder --config electron-builder.yml $targetFlag $archFlags -c.extraMetadata.version=$Version -c.directories.output=/project/build-artifact --publish never"
    $dockerArgs = @(
        'run', '--rm',
        '-v', "${Root}:/project",
        '-v', 'nexus3-linux-modules:/project/desktop/node_modules',
        '-v', 'nexus3-electron-cache:/root/.cache/electron',
        '-v', 'nexus3-builder-cache:/root/.cache/electron-builder',
        '-w', '/project/desktop',
        $DockerImage,
        '/bin/bash', '-c', $inner
    )
    Invoke-Checked -Exe 'docker' -Arguments $dockerArgs -WorkDir $Root
}

function Build-MacOS {
    if (-not $IsMacOS) {
        throw "macOS packages can only be built on macOS. Use a Mac, or the macos runner in .github/workflows/release.yml."
    }
    Install-Deps
    $builderArgs = @('--no-install', 'electron-builder', '--config', 'electron-builder.yml')
    if ($Dir) { $builderArgs += '--dir' }
    $builderArgs += '--mac'
    foreach ($a in $arches) { $builderArgs += "--$a" }
    $builderArgs += @("-c.extraMetadata.version=$Version", "-c.directories.output=$OutDir", '--publish', 'never')
    Invoke-Checked -Exe 'npx' -Arguments $builderArgs -WorkDir $DesktopDir
}

foreach ($t in $targets) {
    Write-Host ""
    Write-Host "== building $t ==" -ForegroundColor Cyan
    switch ($t) {
        'windows' { Build-Windows }
        'linux' { Build-Linux }
        'macos' { Build-MacOS }
    }
}

if (-not $Dir) {
    Get-ChildItem -Path $OutDir -Directory -Force |
        Where-Object { $_.Name -like '*-unpacked' -or $_.Name -like '.icon-*' -or $_.Name -eq 'mac' -or $_.Name -eq 'mac-arm64' } |
        Remove-Item -Recurse -Force
    Get-ChildItem -Path $OutDir -File -Include 'builder-effective-config.yaml', 'builder-debug.yml', '*.blockmap', 'latest*.yml' -Recurse |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "artifacts in $OutDir" -ForegroundColor Green
Get-ChildItem -Path $OutDir | Sort-Object Name |
    Select-Object Name, @{ N = 'MB'; E = { [math]::Round($_.Length / 1MB, 1) } } |
    Format-Table -AutoSize
