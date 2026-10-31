# 3Speak Video Encoder - Windows installer (Windows PowerShell 5.1 and PowerShell 7)
#   iwr -useb https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.ps1 | iex
#
# Installs what's missing (Git, Node.js 20+, FFmpeg, IPFS), downloads the encoder and writes .env.
# Uses winget, which needs no administrator rights; Chocolatey only in an administrator window.
#
# Unattended (answers from the environment instead of prompts):
#   ENCODER_MODE=embed|direct|dual  HIVE_USERNAME=...  START_NOW=y|n
#   INSTALL_DIR=...  ENCODER_REPO=<git url or path>  (defaults: ~\3speak-encoder, GitHub)

$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$KuboVersion = '0.43.1'
$NodeMajor = 20

function Write-Ok($msg)   { Write-Host "[ok] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Step($msg) { Write-Host ""; Write-Host $msg -ForegroundColor Cyan }
function Stop-Install($msg) {
    Write-Host ""
    Write-Host "[x] $msg" -ForegroundColor Red
    Write-Host "   Fix that, then run the installer again." -ForegroundColor Yellow
    if (-not $env:CI) { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

# Prompt, unless the answer is already in the environment (unattended installs, CI)
function Read-Answer($envName, $prompt) {
    $preset = [Environment]::GetEnvironmentVariable($envName)
    if ($null -ne $preset) { return $preset }
    return Read-Host $prompt
}

function Test-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Installers change PATH in the registry; pick that up without opening a new window
function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Add-UserPath($dir) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (($userPath -split ';') -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$dir").TrimStart(';'), 'User')
    }
    Update-SessionPath
}

# Full path of a program: on PATH, or in the places winget, Chocolatey, Scoop and manual installs put it
function Find-Program($name) {
    $cmd = Get-Command "$name.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\$name.exe",
        "$env:ProgramData\chocolatey\bin\$name.exe",
        "$env:USERPROFILE\scoop\shims\$name.exe",
        "$env:ProgramFiles\nodejs\$name.exe",
        "$env:ProgramFiles\Git\cmd\$name.exe",
        "$env:ProgramFiles\ffmpeg\bin\$name.exe",
        "C:\ffmpeg\bin\$name.exe",
        "$env:LOCALAPPDATA\Programs\kubo\$name.exe"
    )
    foreach ($path in $candidates) { if (Test-Path $path) { return $path } }
    # winget's portable packages (FFmpeg) when it couldn't create the Links shortcut
    $found = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter "$name.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}

# winget first (no admin needed for most packages), Chocolatey only when this window is elevated
function Install-Package($label, $wingetId, $chocoName) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "Installing $label with winget..." -ForegroundColor Yellow
        winget install --id $wingetId --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
        Update-SessionPath
        if ($LASTEXITCODE -eq 0) { return $true }
        Write-Warn "winget couldn't install $label (exit code $LASTEXITCODE)"
    }
    if ((Get-Command choco -ErrorAction SilentlyContinue) -and (Test-Admin)) {
        Write-Host "Installing $label with Chocolatey..." -ForegroundColor Yellow
        choco install $chocoName -y --no-progress
        Update-SessionPath
        if ($LASTEXITCODE -eq 0) { return $true }
        Write-Warn "Chocolatey couldn't install $label (exit code $LASTEXITCODE)"
    }
    return $false
}

function Get-NodeMajor($nodeExe) {
    if (-not $nodeExe) { return 0 }
    $v = & $nodeExe --version 2>$null
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
}

Write-Host "3Speak Video Encoder - Windows Setup" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
Write-Step "Checking what's installed..."

# Git
if (-not (Find-Program 'git')) {
    if (-not (Install-Package 'Git' 'Git.Git' 'git')) {
        Stop-Install "Git is required. Install it from https://git-scm.com/download/win"
    }
}
$git = Find-Program 'git'
if (-not $git) { Stop-Install "Git was installed but can't be found. Close this window, open a new PowerShell and run the installer again." }
Write-Ok "Git: $git"

# Node.js 20+
$node = Find-Program 'node'
if ((Get-NodeMajor $node) -lt $NodeMajor) {
    if ($node) { Write-Warn "Node.js $(& $node --version) is too old; the encoder needs $NodeMajor or newer" }
    if (-not (Install-Package 'Node.js LTS' 'OpenJS.NodeJS.LTS' 'nodejs-lts')) {
        Stop-Install "Node.js $NodeMajor+ is required. Install the LTS version from https://nodejs.org"
    }
    $node = Find-Program 'node'
}
if ((Get-NodeMajor $node) -lt $NodeMajor) {
    Stop-Install "Node.js $NodeMajor+ is installed but this window still sees an old or no version. Open a new PowerShell and run the installer again."
}
$nodeDir = Split-Path $node
if (($env:Path -split ';') -notcontains $nodeDir) { $env:Path = "$nodeDir;$env:Path" }   # npm lives next to node
Write-Ok "Node.js $(& $node --version): $node"

# FFmpeg (the full build: it includes libx264 and the hardware encoders)
if (-not (Find-Program 'ffmpeg')) {
    if (-not (Install-Package 'FFmpeg' 'Gyan.FFmpeg' 'ffmpeg-full')) {
        Write-Host ""
        Write-Host "   Install FFmpeg yourself:" -ForegroundColor Yellow
        Write-Host "   1. Download the 'full' build from https://www.gyan.dev/ffmpeg/builds/" -ForegroundColor Yellow
        Write-Host "   2. Extract it, e.g. to C:\ffmpeg (so C:\ffmpeg\bin\ffmpeg.exe exists)" -ForegroundColor Yellow
        Stop-Install "FFmpeg could not be installed automatically."
    }
}
$ffmpeg = Find-Program 'ffmpeg'
if (-not $ffmpeg) { Stop-Install "FFmpeg was installed but ffmpeg.exe can't be found. Open a new PowerShell and run the installer again." }
& $ffmpeg -hide_banner -version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-Install "$ffmpeg doesn't run (exit code $LASTEXITCODE). Reinstall FFmpeg." }
$ffprobe = Join-Path (Split-Path $ffmpeg) 'ffprobe.exe'
if (-not (Test-Path $ffprobe)) { $ffprobe = Find-Program 'ffprobe' }
if (-not $ffprobe) { Stop-Install "ffprobe.exe (part of FFmpeg) is missing next to $ffmpeg. Reinstall FFmpeg." }
Write-Ok "FFmpeg: $ffmpeg"

# IPFS (Kubo), downloaded straight from the IPFS project: no package manager or admin needed
$ipfs = Find-Program 'ipfs'
if (-not $ipfs) {
    Write-Host "Installing IPFS (Kubo $KuboVersion)..." -ForegroundColor Yellow
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $zip = Join-Path $env:TEMP "kubo-$KuboVersion.zip"
    $kuboDir = "$env:LOCALAPPDATA\Programs\kubo"
    $file = "kubo_v${KuboVersion}_windows-$arch.zip"
    # GitHub first: dist.ipfs.tech is sometimes unreachable
    foreach ($url in @("https://github.com/ipfs/kubo/releases/download/v$KuboVersion/$file", "https://dist.ipfs.tech/kubo/v$KuboVersion/$file")) {
        try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -TimeoutSec 120; break }
        catch { Write-Warn "Couldn't download ${url}: $($_.Exception.Message)" }
    }
    try {
        if (-not (Test-Path $zip)) { throw "download failed" }
        $unpacked = Join-Path $env:TEMP "kubo-$KuboVersion"
        if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $unpacked -Force
        New-Item -ItemType Directory -Force -Path $kuboDir | Out-Null
        Copy-Item (Join-Path $unpacked 'kubo\ipfs.exe') $kuboDir -Force
        Remove-Item $zip, $unpacked -Recurse -Force -ErrorAction SilentlyContinue
        Add-UserPath $kuboDir
    } catch {
        Write-Warn "IPFS download failed: $($_.Exception.Message)"
    }
    $ipfs = Find-Program 'ipfs'
}
if ($ipfs) {
    Write-Ok "IPFS: $ipfs"
    if (-not (Test-Path "$env:USERPROFILE\.ipfs")) {
        Write-Host "Initializing IPFS..." -ForegroundColor Yellow
        & $ipfs init --profile server | Out-Null
    }
} else {
    Stop-Install "IPFS (Kubo) could not be installed. Download kubo_v${KuboVersion}_windows-amd64.zip from https://github.com/ipfs/kubo/releases/tag/v$KuboVersion and extract ipfs.exe to $env:LOCALAPPDATA\Programs\kubo"
}

# aria2 is optional (faster downloads); don't fail without it
if (Find-Program 'aria2c') { Write-Ok "aria2 found: parallel downloads enabled" }
else { Write-Host "[i] Optional: install aria2 for faster downloads (winget install aria2.aria2)" -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------
Write-Step "Choose your encoder mode:"
Write-Host "  1) Embed Community - Encode videos for the 3Speak community (recommended)"
Write-Host "  2) Direct API Mode - Private encoder for your apps (direct requests only)"
Write-Host "  3) Dual Mode - Community jobs AND a private direct API (for developers)"

$modeMap = @{ '1' = 'embed'; '2' = 'direct'; '3' = 'dual'; 'embed' = 'embed'; 'direct' = 'direct'; 'dual' = 'dual' }
do {
    $modeChoice = Read-Answer 'ENCODER_MODE' 'Enter your choice (1, 2, or 3)'
    $encoderMode = $modeMap["$modeChoice".Trim().ToLower()]
    if (-not $encoderMode -and $env:ENCODER_MODE) { Stop-Install "ENCODER_MODE must be embed, direct or dual" }
} while (-not $encoderMode)
Write-Ok "$encoderMode mode"

if ($encoderMode -eq 'direct') {
    $hiveUsername = Read-Answer 'HIVE_USERNAME' 'Hive username (optional for direct-API-only mode, Enter to skip)'
    if ([string]::IsNullOrWhiteSpace($hiveUsername)) { $hiveUsername = 'direct-api-encoder' }
} else {
    do {
        $hiveUsername = Read-Answer 'HIVE_USERNAME' "What's your Hive username? (required for encoding)"
        if ([string]::IsNullOrWhiteSpace($hiveUsername)) {
            if ($null -ne $env:HIVE_USERNAME) { Stop-Install "HIVE_USERNAME is empty" }
            Write-Host "[x] Hive username is required for community encoding" -ForegroundColor Red
        }
    } while ([string]::IsNullOrWhiteSpace($hiveUsername))
}
$hiveUsername = $hiveUsername.Trim()

# ---------------------------------------------------------------------------
# Download and build
# ---------------------------------------------------------------------------
$installDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { "$env:USERPROFILE\3speak-encoder" }
$repo = if ($env:ENCODER_REPO) { $env:ENCODER_REPO } else { 'https://github.com/Mantequilla-Soft/3speakencoder.git' }
Write-Step "Installing to $installDir"

if (Test-Path (Join-Path $installDir '.git')) {
    Write-Host "Already there, updating..." -ForegroundColor Yellow
    Set-Location $installDir
    & $git pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Warn "git pull failed (local changes?); continuing with the current code" }
} else {
    & $git clone $repo $installDir
    if ($LASTEXITCODE -ne 0) { Stop-Install "Downloading the encoder failed (git clone $repo)" }
    Set-Location $installDir
}

Write-Step "Installing dependencies (a few minutes the first time)..."
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Stop-Install "npm ci failed (see the errors above)" }

Write-Step "Building..."
npm run build --silent
if ($LASTEXITCODE -ne 0) { Stop-Install "The build failed (see the errors above)" }

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Cryptographically secure random bytes. RandomNumberGenerator::GetBytes(int) only
# exists on .NET 6+ (PowerShell 7), so use Create().GetBytes() for Windows PowerShell 5.1.
function New-RandomBytes([int]$count) {
    $bytes = New-Object byte[] $count
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ,$bytes
}

$envPath = Join-Path $installDir '.env'
$encoderPrivateKey = $null
if (Test-Path $envPath) {
    $match = Select-String -Path $envPath -Pattern '^ENCODER_PRIVATE_KEY=(.+)$' | Select-Object -First 1
    if ($match) { $encoderPrivateKey = $match.Matches[0].Groups[1].Value.Trim() }
    Copy-Item $envPath "$envPath.bak" -Force
    Write-Ok "Previous settings saved to .env.bak"
}
if ([string]::IsNullOrWhiteSpace($encoderPrivateKey)) {
    $encoderPrivateKey = [Convert]::ToBase64String((New-RandomBytes 32))
    Write-Ok "New encoder identity generated"
} else {
    Write-Ok "Keeping the existing encoder identity"
}

$apiKey = $null
if ($encoderMode -in @('direct', 'dual')) {
    $apiKey = -join ((New-RandomBytes 32) | ForEach-Object { $_.ToString('x2') })
}

$embedEnabled = if ($encoderMode -in @('embed', 'dual')) { 'true' } else { 'false' }
$directEnabled = if ($encoderMode -in @('direct', 'dual')) { 'true' } else { 'false' }
$directApiSettings = if ($directEnabled -eq 'true') { "DIRECT_API_PORT=3002`r`nDIRECT_API_KEY=$apiKey" } else { '' }

$envContent = @"
# 3Speak Encoder Configuration - $($encoderMode.ToUpper()) Mode
HIVE_USERNAME=$hiveUsername

# Persistent encoder identity. NOT your Hive key; keep it secret and backed up:
# losing it makes this machine a "new encoder".
ENCODER_PRIVATE_KEY=$encoderPrivateKey

# Embed System - community encoding jobs from 3Speak
EMBED_SYSTEM_ENABLED=$embedEnabled
EMBED_SYSTEM_MODE=community
EMBED_GATEWAY_URL=https://embed.3speak.tv

# Direct API - private encoding requests from your own apps
DIRECT_API_ENABLED=$directEnabled
$directApiSettings

# FFmpeg found by the installer. Change it if you move or reinstall FFmpeg.
FFMPEG_PATH=$ffmpeg
FFPROBE_PATH=$ffprobe
"@

# UTF-8 without a byte-order mark (Out-File -Encoding UTF8 adds one on Windows PowerShell 5.1)
[IO.File]::WriteAllText($envPath, $envContent, (New-Object Text.UTF8Encoding $false))
Write-Ok "Configuration written to .env"

# ---------------------------------------------------------------------------
# Shortcuts
# ---------------------------------------------------------------------------
function New-Shortcut($path) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$installDir\scripts\run-encoder.ps1`""
    $shortcut.WorkingDirectory = $installDir
    $shortcut.IconLocation = 'shell32.dll,21'
    $shortcut.Description = '3Speak Video Encoder'
    $shortcut.Save()
}
try {
    New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) '3Speak Encoder.lnk')
    New-Shortcut "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\3Speak Encoder.lnk"
    Write-Ok "Desktop and Start menu shortcuts created"
} catch {
    Write-Warn "Couldn't create shortcuts: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# IPFS daemon
# ---------------------------------------------------------------------------
function Test-IpfsApi {
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:5001/api/v0/id' -Method Post -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
if ($ipfs -and -not (Test-IpfsApi)) {
    Write-Host "Starting the IPFS daemon..." -ForegroundColor Yellow
    $ipfsLog = Join-Path $env:TEMP '3speak-ipfs-daemon.log'
    Start-Process -FilePath $ipfs -ArgumentList 'daemon' -WindowStyle Hidden -RedirectStandardOutput $ipfsLog -RedirectStandardError "$ipfsLog.err"
    # The first start can be slow (repo setup, antivirus scanning the new ipfs.exe)
    for ($i = 0; $i -lt 60 -and -not (Test-IpfsApi); $i++) { Start-Sleep 1 }
    if (Test-IpfsApi) {
        Write-Ok "IPFS daemon running"
    } else {
        Get-Content $ipfsLog, "$ipfsLog.err" -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "   $_" }
        Stop-Install "The IPFS daemon didn't start (its output is above). Run '$ipfs daemon' in a window to see why."
    }
}

# ---------------------------------------------------------------------------
# Final check, the same way the encoder will look things up
# ---------------------------------------------------------------------------
Write-Step "Checking the installation (npm run doctor)..."
npm run doctor --silent
if ($LASTEXITCODE -ne 0) { Stop-Install "The installation check found a problem (see above)" }

Write-Host ""
Write-Host "3Speak Encoder installed!" -ForegroundColor Green
Write-Host "   Folder:    $installDir"
Write-Host "   Hive user: $hiveUsername"
Write-Host "   Mode:      $encoderMode"
Write-Host "   Dashboard: http://localhost:3001 (once it's running)"
if ($apiKey) {
    Write-Host "   Direct API: http://localhost:3002, key: $apiKey" -ForegroundColor Yellow
    Write-Host "   Keep that key secret." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "   Start it with the '3Speak Encoder' desktop shortcut, or: cd `"$installDir`"; npm start"

$startNow = Read-Answer 'START_NOW' "Start the encoder now? (y/n)"
if ($startNow -match '^[Yy]') {
    Start-Job -ScriptBlock { Start-Sleep 5; Start-Process 'http://localhost:3001' } | Out-Null
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$installDir\scripts\run-encoder.ps1"
}
