param(
  [string]$Repo = "calebrussel77/dev-browser",
  [string]$InstallDir = "$env:LOCALAPPDATA\dev-browser\bin"
)

$ErrorActionPreference = "Stop"

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "dev-browser currently ships a Windows x64 binary only."
}

$BinaryName = "dev-browser-windows-x64.exe"
$DownloadUrl = "https://github.com/$Repo/releases/latest/download/$BinaryName"
$Destination = Join-Path $InstallDir "dev-browser.exe"
$TempDestination = "$Destination.download"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "Downloading dev-browser from $DownloadUrl"
Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempDestination
Move-Item -Force -LiteralPath $TempDestination -Destination $Destination

$CurrentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$PathParts = @()
if ($CurrentUserPath) {
  $PathParts = $CurrentUserPath -split ";"
}

$AlreadyOnPath = $PathParts | Where-Object {
  $_.TrimEnd("\") -ieq $InstallDir.TrimEnd("\")
}

if (-not $AlreadyOnPath) {
  $NewUserPath = if ($CurrentUserPath) {
    "$CurrentUserPath;$InstallDir"
  } else {
    $InstallDir
  }

  [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
  $env:Path = "$env:Path;$InstallDir"
  Write-Host "Added $InstallDir to your user PATH. Open a new terminal if this one does not pick it up."
}

Write-Host "Installed dev-browser to $Destination"
Write-Host "Next: dev-browser install"
