[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)

    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-PathEntryEqual {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )

    try {
        return [string]::Equals(
            (Get-NormalizedPath $Left),
            (Get-NormalizedPath $Right),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    catch {
        return [string]::Equals(
            $Left.Trim().TrimEnd("\", "/"),
            $Right.Trim().TrimEnd("\", "/"),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
}

if (
    [Environment]::OSVersion.Platform -ne
    [PlatformID]::Win32NT
) {
    throw "This installer only supports Windows."
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw "APPDATA is not available for the current user."
    }

    $InstallRoot = Join-Path $env:APPDATA "TribalWars\tw-backend"
}

$InstallRoot = Get-NormalizedPath $InstallRoot
$ProjectPath = Join-Path $PSScriptRoot "backend\backend.csproj"
$AppDirectory = Join-Path $InstallRoot "app"
$BinDirectory = Join-Path $InstallRoot "bin"
$LauncherPath = Join-Path $BinDirectory "tw-backend.cmd"
$StagingDirectory = Join-Path $InstallRoot (
    ".staging-" + [Guid]::NewGuid().ToString("N")
)
$BackupDirectory = Join-Path $InstallRoot (
    ".backup-" + [Guid]::NewGuid().ToString("N")
)
$InstalledNewApp = $false

if (-not (Test-Path -LiteralPath $ProjectPath -PathType Leaf)) {
    throw "Backend project not found at '$ProjectPath'."
}

$Dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($null -eq $Dotnet) {
    throw "The .NET 10 SDK is required. Install it from https://dotnet.microsoft.com/download/dotnet/10.0"
}

$InstalledSdks = @(& $Dotnet.Source --list-sdks)
if ($LASTEXITCODE -ne 0 -or -not ($InstalledSdks -match "^10\.")) {
    throw "The .NET 10 SDK is required. Installed SDKs: $($InstalledSdks -join ', ')"
}

$RunningInstallation = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ExecutablePath -and
        (Test-PathEntryEqual $_.ExecutablePath (Join-Path $AppDirectory "backend.exe"))
    } |
    Select-Object -First 1

if ($null -ne $RunningInstallation) {
    throw "tw-backend is currently running (PID $($RunningInstallation.ProcessId)). Stop it before upgrading."
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

try {
    Write-Step "Publishing the .NET backend"
    & $Dotnet.Source publish $ProjectPath `
        --configuration Release `
        --runtime win-x64 `
        --self-contained false `
        --output $StagingDirectory `
        -p:UseAppHost=true

    if ($LASTEXITCODE -ne 0) {
        throw "dotnet publish failed with exit code $LASTEXITCODE."
    }

    $PublishedExecutable = Join-Path $StagingDirectory "backend.exe"
    if (-not (Test-Path -LiteralPath $PublishedExecutable -PathType Leaf)) {
        throw "Publishing completed without producing backend.exe."
    }

    if (Test-Path -LiteralPath $AppDirectory) {
        Write-Step "Replacing the existing backend"
        Move-Item -LiteralPath $AppDirectory -Destination $BackupDirectory
    }

    Move-Item -LiteralPath $StagingDirectory -Destination $AppDirectory
    $InstalledNewApp = $true

    New-Item -ItemType Directory -Path $BinDirectory -Force | Out-Null

    $Launcher = @'
@echo off
setlocal
set "TW_BACKEND_HOME=%~dp0..\app"
pushd "%TW_BACKEND_HOME%" >nul
"%TW_BACKEND_HOME%\backend.exe" %*
set "TW_BACKEND_EXIT=%ERRORLEVEL%"
popd >nul
exit /b %TW_BACKEND_EXIT%
'@

    Set-Content -LiteralPath $LauncherPath `
        -Value $Launcher `
        -Encoding Ascii

    if (-not $NoPathUpdate) {
        Write-Step "Adding tw-backend to the user PATH"
        $UserPath = [Environment]::GetEnvironmentVariable(
            "Path",
            [EnvironmentVariableTarget]::User
        )
        $PathEntries = @(
            $UserPath -split ";" |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        $AlreadyOnPath = $false

        foreach ($Entry in $PathEntries) {
            if (Test-PathEntryEqual $Entry $BinDirectory) {
                $AlreadyOnPath = $true
                break
            }
        }

        if (-not $AlreadyOnPath) {
            $NewUserPath = (@($PathEntries) + $BinDirectory) -join ";"
            [Environment]::SetEnvironmentVariable(
                "Path",
                $NewUserPath,
                [EnvironmentVariableTarget]::User
            )
        }

        $CurrentEntries = @(
            $env:Path -split ";" |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        if (-not ($CurrentEntries | Where-Object {
            Test-PathEntryEqual $_ $BinDirectory
        })) {
            $env:Path = "$env:Path;$BinDirectory"
        }
    }

    if (Test-Path -LiteralPath $BackupDirectory) {
        Remove-Item -LiteralPath $BackupDirectory -Recurse -Force
    }

    Write-Host ""
    Write-Host "tw-backend installed successfully." -ForegroundColor Green
    Write-Host "Location: $AppDirectory"
    Write-Host "Command:  tw-backend"

    if (-not $NoPathUpdate) {
        Write-Host ""
        Write-Host "Open a new terminal before using tw-backend from PATH."
    }
}
catch {
    if (Test-Path -LiteralPath $BackupDirectory) {
        if (
            $InstalledNewApp -and
            (Test-Path -LiteralPath $AppDirectory)
        ) {
            Remove-Item -LiteralPath $AppDirectory -Recurse -Force
        }

        Move-Item -LiteralPath $BackupDirectory -Destination $AppDirectory
    }

    throw
}
finally {
    if (Test-Path -LiteralPath $StagingDirectory) {
        Remove-Item -LiteralPath $StagingDirectory -Recurse -Force
    }
}
