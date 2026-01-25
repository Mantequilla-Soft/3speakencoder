# 3Speak Video Encoder - PowerShell Installer
# Run with: iwr -useb https://raw.githubusercontent.com/menobass/3speakencoder/main/install.ps1 | iex

Write-Host "🚀 3Speak Video Encoder - Windows Setup" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
try {
    $nodeVersion = node --version 2>$null
    Write-Host "✅ Node.js found: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Node.js is not installed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "📥 Please install Node.js first:" -ForegroundColor Yellow
    Write-Host "   1. Go to https://nodejs.org" -ForegroundColor Yellow
    Write-Host "   2. Download and install the LTS version" -ForegroundColor Yellow
    Write-Host "   3. Restart PowerShell and run this installer again" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to open Node.js website, then restart this installer"
    Start-Process "https://nodejs.org"
    exit 1
}

# Check if FFmpeg is installed
try {
    ffmpeg -version 2>$null | Out-Null
    Write-Host "✅ FFmpeg found" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "❌ FFmpeg is not installed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "📥 Installing FFmpeg with Chocolatey..." -ForegroundColor Yellow
    Write-Host "   If this fails, install manually from https://ffmpeg.org" -ForegroundColor Yellow
    Write-Host ""
    
    # Try to install chocolatey if not present
    try {
        choco --version 2>$null | Out-Null
    } catch {
        Write-Host "📦 Installing Chocolatey package manager..." -ForegroundColor Yellow
        Set-ExecutionPolicy Bypass -Scope Process -Force
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    }
    
    # Install FFmpeg
    choco install ffmpeg -y
    
    # Refresh PATH again
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
    Write-Host "✅ FFmpeg installed" -ForegroundColor Green
}

# Check if IPFS is installed
try {
    ipfs version 2>$null | Out-Null
    Write-Host "✅ IPFS found" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "❌ IPFS is not installed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "📥 Installing IPFS..." -ForegroundColor Yellow
    
    # Try with chocolatey first
    try {
        choco install ipfs -y
        Write-Host "✅ IPFS installed via Chocolatey" -ForegroundColor Green
    } catch {
        Write-Host "⚠️ Chocolatey install failed. Please install IPFS manually:" -ForegroundColor Yellow
        Write-Host "   1. Go to https://dist.ipfs.tech/kubo/" -ForegroundColor Yellow
        Write-Host "   2. Download the Windows version" -ForegroundColor Yellow
        Write-Host "   3. Extract and add to PATH" -ForegroundColor Yellow
        Write-Host "   4. Run: ipfs init" -ForegroundColor Yellow
        Read-Host "Press Enter to continue (assuming IPFS will be installed manually)"
    }
}

# Choose encoder mode
Write-Host ""
Write-Host "🎯 Choose your encoder mode:" -ForegroundColor Cyan
Write-Host "  1) Gateway Mode - Help 3Speak community (connects to 3Speak gateway)" -ForegroundColor White
Write-Host "  2) Direct API Mode - Private encoder for your apps (direct requests only)" -ForegroundColor White  
Write-Host "  3) Dual Mode - Both gateway jobs and direct API (recommended for developers)" -ForegroundColor White
Write-Host ""

do {
    $modeChoice = Read-Host "Enter your choice (1, 2, or 3)"
} while ($modeChoice -notin @("1", "2", "3"))

switch ($modeChoice) {
    "1" {
        $encoderMode = "gateway"
        Write-Host "✅ Gateway Mode selected - you'll help encode videos for 3Speak community" -ForegroundColor Green
    }
    "2" {
        $encoderMode = "direct"
        Write-Host "✅ Direct API Mode selected - private encoder for your applications" -ForegroundColor Green
    }
    "3" {
        $encoderMode = "dual"
        Write-Host "✅ Dual Mode selected - maximum flexibility for developers" -ForegroundColor Green
    }
}

# Get Hive username based on mode
Write-Host ""
if ($encoderMode -eq "direct") {
    Write-Host "👤 Hive username (optional for direct-API-only mode):" -ForegroundColor Cyan
    $hiveUsername = Read-Host "Hive username (or press Enter to skip)"
    if ([string]::IsNullOrWhiteSpace($hiveUsername)) {
        $hiveUsername = "direct-api-encoder"
        Write-Host "ℹ️ Using default username: $hiveUsername" -ForegroundColor Blue
    }
} else {
    Write-Host "👤 What's your Hive username? (required for gateway mode)" -ForegroundColor Cyan
    do {
        $hiveUsername = Read-Host "Hive username"
        if ([string]::IsNullOrWhiteSpace($hiveUsername)) {
            Write-Host "❌ Hive username is required for gateway mode!" -ForegroundColor Red
        }
    } while ([string]::IsNullOrWhiteSpace($hiveUsername))
}

# Setup installation directory
$installDir = "$env:USERPROFILE\3speak-encoder"

Write-Host ""
Write-Host "📁 Installation directory: $installDir" -ForegroundColor Blue

if (Test-Path $installDir) {
    Write-Host "📁 Directory exists, updating..." -ForegroundColor Yellow
    Set-Location $installDir
    git pull
} else {
    Write-Host "📥 Downloading 3Speak Encoder..." -ForegroundColor Yellow
    git clone https://github.com/menobass/3speakencoder.git $installDir
    Set-Location $installDir
}

Write-Host ""
Write-Host "📦 Installing dependencies..." -ForegroundColor Yellow
npm install

# 🔑 Generate persistent encoder identity key (CRITICAL for dashboard tracking)
Write-Host ""
Write-Host "🔑 Generating persistent encoder identity key..." -ForegroundColor Yellow
$encoderPrivateKey = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
Write-Host "✅ Encoder identity key generated - this keeps your encoder identity consistent!" -ForegroundColor Green

# Generate API key for direct modes
$apiKey = $null
if ($encoderMode -in @("direct", "dual")) {
    Write-Host ""
    Write-Host "🔑 Generating secure API key for direct requests..." -ForegroundColor Yellow
    $apiKey = [System.Web.Security.Membership]::GeneratePassword(64, 0)
    Write-Host "✅ Generated secure API key" -ForegroundColor Green
    Write-Host "⚠️  Keep this key secret - you'll need it to make API requests!" -ForegroundColor Red
}

# Create .env file based on mode
Write-Host ""  
Write-Host "⚙️ Creating configuration..." -ForegroundColor Yellow

$envContent = @"
# 3Speak Encoder Configuration - $($encoderMode.ToUpper()) Mode
HIVE_USERNAME=$hiveUsername

"@

switch ($encoderMode) {
    "gateway" {
        $envContent += @"
# Gateway mode settings
REMOTE_GATEWAY_ENABLED=true

# Direct API disabled for gateway-only mode
DIRECT_API_ENABLED=false

# 🔑 Persistent Encoder Identity (CRITICAL - keeps same identity across restarts)
ENCODER_PRIVATE_KEY=$encoderPrivateKey
# ⚠️  This is NOT your Hive key - it's for encoder authentication only
# ✅ Keep this secret and backed up - losing it creates a "new encoder"

# MongoDB Direct Verification (DISABLED by default)
# 🚨 Only enable for 3Speak infrastructure nodes with database access
MONGODB_VERIFICATION_ENABLED=false
# MONGODB_URI=mongodb://username:password@host:port/database
# DATABASE_NAME=spk-encoder-gateway

# Gateway Aid Fallback (DISABLED by default)
# 🆘 Only for approved community nodes - contact 3Speak team
GATEWAY_AID_ENABLED=false
# GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1

# Gateway Monitor Verification (RECOMMENDED for community encoders)
# 🌐 Public REST API for race condition prevention
GATEWAY_MONITOR_ENABLED=false
# GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api

# Logging
LOG_LEVEL=info
"@
    }
    "direct" {
        $envContent += @"
# Disable gateway mode (direct API only)
REMOTE_GATEWAY_ENABLED=false

# Direct API settings
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=$apiKey

# 🔑 Persistent Encoder Identity (CRITICAL - keeps same identity across restarts)
ENCODER_PRIVATE_KEY=$encoderPrivateKey
# ⚠️  This is NOT your Hive key - it's for encoder authentication only
# ✅ Keep this secret and backed up - losing it creates a "new encoder"

# MongoDB Direct Verification (DISABLED by default)
# 🚨 Only enable for 3Speak infrastructure nodes with database access
MONGODB_VERIFICATION_ENABLED=false
# MONGODB_URI=mongodb://username:password@host:port/database
# DATABASE_NAME=spk-encoder-gateway

# Gateway Aid Fallback (DISABLED by default)
# 🆘 Only for approved community nodes - contact 3Speak team
GATEWAY_AID_ENABLED=false
# GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1

# Gateway Monitor Verification (RECOMMENDED for community encoders)
# 🌐 Public REST API for race condition prevention
GATEWAY_MONITOR_ENABLED=false
# GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api

# Logging
LOG_LEVEL=info
"@
    }
    "dual" {
        $envContent += @"
# Gateway mode enabled
REMOTE_GATEWAY_ENABLED=true

# Direct API enabled
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=$apiKey

# 🔑 Persistent Encoder Identity (CRITICAL - keeps same identity across restarts)
ENCODER_PRIVATE_KEY=$encoderPrivateKey
# ⚠️  This is NOT your Hive key - it's for encoder authentication only
# ✅ Keep this secret and backed up - losing it creates a "new encoder"

# MongoDB Direct Verification (DISABLED by default)
# 🚨 Only enable for 3Speak infrastructure nodes with database access
MONGODB_VERIFICATION_ENABLED=false
# MONGODB_URI=mongodb://username:password@host:port/database
# DATABASE_NAME=spk-encoder-gateway

# Gateway Aid Fallback (DISABLED by default)
# 🆘 Only for approved community nodes - contact 3Speak team
GATEWAY_AID_ENABLED=false
# GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1

# Gateway Monitor Verification (RECOMMENDED for community encoders)
# 🌐 Public REST API for race condition prevention
GATEWAY_MONITOR_ENABLED=false
# GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api

# Logging
LOG_LEVEL=info
"@
    }
}

$envContent | Out-File -FilePath ".env" -Encoding UTF8

# Create desktop shortcut
Write-Host ""
Write-Host "🖥️ Creating desktop shortcut..." -ForegroundColor Yellow

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = "$desktopPath\3Speak Encoder.lnk"

$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-Command `"cd '$installDir'; npm start`""
$Shortcut.WorkingDirectory = $installDir
$Shortcut.IconLocation = "shell32.dll,21"
$Shortcut.Description = "3Speak Video Encoder - Help encode videos for Web3"
$Shortcut.Save()

# Create start menu entry
$startMenuPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\3Speak Encoder.lnk"
$Shortcut = $WshShell.CreateShortcut($startMenuPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-Command `"cd '$installDir'; npm start`""
$Shortcut.WorkingDirectory = $installDir
$Shortcut.IconLocation = "shell32.dll,21"
$Shortcut.Description = "3Speak Video Encoder - Help encode videos for Web3"
$Shortcut.Save()

Write-Host ""
Write-Host "🎉 3Speak Encoder installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "📍 Installation directory: $installDir" -ForegroundColor Blue
Write-Host "👤 Configured for user: $hiveUsername" -ForegroundColor Blue
Write-Host "🎯 Mode: $($encoderMode.ToUpper())" -ForegroundColor Blue
Write-Host ""

# Mode-specific instructions
switch ($encoderMode) {
    "gateway" {
        Write-Host "🌐 Gateway Mode - Community Encoding:" -ForegroundColor Cyan
        Write-Host "   • Dashboard: http://localhost:3001" -ForegroundColor White
        Write-Host "   • Will automatically fetch and process 3Speak community videos" -ForegroundColor White
        Write-Host "   • Helps decentralize video processing for Web3" -ForegroundColor White
    }
    "direct" {
        Write-Host "🔌 Direct API Mode - Private Encoding:" -ForegroundColor Cyan
        Write-Host "   • Dashboard: http://localhost:3001" -ForegroundColor White
        Write-Host "   • API Endpoint: http://localhost:3002" -ForegroundColor White
        Write-Host "   • Your API Key: $apiKey" -ForegroundColor Yellow
        Write-Host "   • Use this key to make direct encoding requests to your private encoder" -ForegroundColor White
        Write-Host ""
        Write-Host "📝 Example API Request:" -ForegroundColor Blue
        Write-Host "   curl -X POST http://localhost:3002/api/encode \" -ForegroundColor Gray
        Write-Host "        -H `"Authorization: Bearer $apiKey`" \" -ForegroundColor Gray  
        Write-Host "        -H `"Content-Type: application/json`" \" -ForegroundColor Gray
        Write-Host "        -d '{`"videoUrl`":`"https://example.com/video.mp4`", `"title`":`"My Video`"}'" -ForegroundColor Gray
    }
    "dual" {
        Write-Host "🚀 Dual Mode - Maximum Flexibility:" -ForegroundColor Cyan
        Write-Host "   • Dashboard: http://localhost:3001" -ForegroundColor White
        Write-Host "   • API Endpoint: http://localhost:3002" -ForegroundColor White
        Write-Host "   • Your API Key: $apiKey" -ForegroundColor Yellow
        Write-Host "   • Processes both 3Speak community jobs AND your direct requests" -ForegroundColor White
        Write-Host "   • Perfect for developers who want to help the community and use private API" -ForegroundColor White
    }
}

Write-Host ""
Write-Host "🚀 To start encoding:" -ForegroundColor Cyan
Write-Host "   cd $installDir" -ForegroundColor Gray
Write-Host "   npm start" -ForegroundColor Gray
Write-Host ""
Write-Host "💡 The encoder will automatically:" -ForegroundColor Blue
if ($encoderMode -ne "direct") {
    Write-Host "   ✅ Connect to 3Speak gateway (if enabled)" -ForegroundColor Green
    Write-Host "   ✅ Fetch available community encoding jobs" -ForegroundColor Green
}
if ($encoderMode -ne "gateway") {
    Write-Host "   ✅ Start direct API server for your applications" -ForegroundColor Green
}
Write-Host "   ✅ Process videos and upload to IPFS" -ForegroundColor Green
Write-Host "   ✅ Provide real-time dashboard monitoring" -ForegroundColor Green
Write-Host ""
Write-Host "❓ Need help? Check the README.md or join our Discord!" -ForegroundColor Yellow
Write-Host ""

# Check if IPFS daemon is running and start if needed
Write-Host "📦 Checking IPFS daemon..." -ForegroundColor Yellow
try {
    $ipfsId = Invoke-RestMethod -Uri "http://127.0.0.1:5001/api/v0/id" -Method Post -TimeoutSec 3 2>$null
    Write-Host "✅ IPFS daemon is running" -ForegroundColor Green
} catch {
    Write-Host "⚠️ IPFS daemon is not running. Starting IPFS daemon..." -ForegroundColor Yellow
    try {
        # Initialize IPFS if not done
        if (-not (Test-Path "$env:USERPROFILE\.ipfs")) {
            Write-Host "🔧 Initializing IPFS..." -ForegroundColor Yellow
            ipfs init
        }
        
        # Start daemon in background
        Start-Process -FilePath "ipfs" -ArgumentList "daemon" -WindowStyle Hidden
        Write-Host "✅ IPFS daemon started in background" -ForegroundColor Green
        
        # Wait for daemon to start
        Write-Host "⏳ Waiting for IPFS daemon to be ready..." -ForegroundColor Yellow
        $timeout = 0
        do {
            Start-Sleep 1
            $timeout++
            try {
                $ipfsId = Invoke-RestMethod -Uri "http://127.0.0.1:5001/api/v0/id" -Method Post -TimeoutSec 1 2>$null
                Write-Host "✅ IPFS daemon is now running!" -ForegroundColor Green
                break
            } catch {
                # Still waiting
            }
        } while ($timeout -lt 10)
        
        if ($timeout -ge 10) {
            Write-Host "⚠️ IPFS daemon might not be ready yet. The encoder will check again when it starts." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "⚠️ Could not start IPFS daemon automatically. Please start it manually:" -ForegroundColor Yellow
        Write-Host "   ipfs daemon" -ForegroundColor Gray
    }
}

# Offer to start immediately
$startNow = Read-Host "🚀 Start the encoder now? (y/n)"

if ($startNow -match "^[Yy]") {
    Write-Host ""
    Write-Host "🎬 Starting 3Speak Encoder..." -ForegroundColor Green
    Write-Host "📱 Opening dashboard at http://localhost:3001" -ForegroundColor Blue
    
    # Open browser after delay
    Start-Job -ScriptBlock {
        Start-Sleep 3
        Start-Process "http://localhost:3001"
    } | Out-Null
    
    # Start the encoder
    npm start
} else {
    Write-Host ""
    Write-Host "✨ Setup complete! Start encoding when ready:" -ForegroundColor Green
    Write-Host "   - Use desktop shortcut" -ForegroundColor Gray
    Write-Host "   - Or: cd `"$installDir`" && npm start" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Press any key to continue..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")