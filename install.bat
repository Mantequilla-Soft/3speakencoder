@echo off
setlocal enabledelayedexpansion
echo 3Speak Video Encoder - Windows Installer
echo =========================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js is not installed!
    echo.
    echo 📥 Please install Node.js first:
    echo    1. Go to https://nodejs.org
    echo    2. Download and install the LTS version
    echo    3. Restart this installer
    echo.
    pause
    exit /b 1
)

echo ✅ Node.js found: 
node --version

REM Check if FFmpeg is installed
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo.
    echo ❌ FFmpeg is not installed!
    echo.
    echo 📥 Installing FFmpeg with Chocolatey...
    echo    If this fails, install manually from https://ffmpeg.org
    echo.
    
    REM Try to install chocolatey if not present
    choco --version >nul 2>&1
    if errorlevel 1 (
        echo 📦 Installing Chocolatey package manager...
        powershell -Command "Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))"
    )
    
    REM Install FFmpeg
    choco install ffmpeg -y
    
    REM Refresh environment
    refreshenv
)

echo ✅ FFmpeg found

REM Check if IPFS is installed
ipfs version >nul 2>&1
if errorlevel 1 (
    echo.
    echo ❌ IPFS is not installed!
    echo.
    echo 📥 Installing IPFS with Chocolatey...
    echo    If this fails, install manually from https://dist.ipfs.tech/kubo/
    echo.
    
    REM Install IPFS
    choco install ipfs -y
    
    REM Refresh environment
    refreshenv
    
    REM Initialize IPFS if not done
    if not exist "%USERPROFILE%\.ipfs" (
        echo 🔧 Initializing IPFS...
        ipfs init
    )
) else (
    echo ✅ IPFS found
)

REM Check for aria2 (optional but recommended for fast downloads)
where aria2c >nul 2>&1
if errorlevel 1 (
    echo.
    echo ⚡ OPTIONAL: aria2 not found - downloads will use single-stream fallback
    echo    For faster downloads on high-latency connections, install aria2:
    echo    https://github.com/aria2/aria2/releases/latest
    echo    Then add aria2c.exe to your PATH and re-run if desired.
    echo.
) else (
    echo ✅ aria2 detected - parallel downloads enabled
)

REM Choose encoder mode
echo.
echo 🎯 Choose your encoder mode:
echo   1^) Embed Community - Encode videos for the 3Speak community ^(recommended^)
echo   2^) Direct API Mode - Private encoder for your apps ^(direct requests only^)
echo   3^) Dual Mode - Community jobs AND a private direct API ^(for developers^)
echo.
set /p MODE_CHOICE="Enter your choice (1, 2, or 3): "

if "%MODE_CHOICE%"=="1" (
    set "ENCODER_MODE=embed"
    echo ✅ Embed Community Mode selected - you'll help encode videos for the 3Speak community
) else if "%MODE_CHOICE%"=="2" (
    set "ENCODER_MODE=direct"
    echo ✅ Direct API Mode selected - private encoder for your applications
) else if "%MODE_CHOICE%"=="3" (
    set "ENCODER_MODE=dual"
    echo ✅ Dual Mode selected - community jobs plus your private direct API
) else (
    echo ❌ Invalid choice. Defaulting to Embed Community Mode.
    set "ENCODER_MODE=embed"
)

REM Get Hive username based on mode
echo.
if "%ENCODER_MODE%"=="direct" (
    echo 👤 Hive username ^(optional for direct-API-only mode^):
    set /p HIVE_USERNAME="Hive username (or press Enter to skip): "
    if "!HIVE_USERNAME!"=="" (
        set "HIVE_USERNAME=direct-api-encoder"
        echo ℹ️ Using default username: direct-api-encoder
    )
) else (
    echo 👤 What's your Hive username? ^(required for encoding^)
    set /p HIVE_USERNAME="Hive username: "
    if "!HIVE_USERNAME!"=="" (
        echo ❌ Hive username is required for community encoding.
        pause
        exit /b 1
    )
)

REM Setup installation directory
set "INSTALL_DIR=%USERPROFILE%\3speak-encoder"

echo.
echo 📁 Installation directory: %INSTALL_DIR%

if exist "%INSTALL_DIR%" (
    echo 📁 Directory exists, updating...
    cd /d "%INSTALL_DIR%"
    git pull
) else (
    echo 📥 Downloading 3Speak Encoder...
    git clone https://github.com/Mantequilla-Soft/3speakencoder.git "%INSTALL_DIR%"
    cd /d "%INSTALL_DIR%"
)

echo.
echo 📦 Installing dependencies...
call npm install

echo.
echo 🔨 Building encoder...
call npm run build

REM 🔑 Preserve or generate persistent encoder identity key
echo.
if exist ".env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /B "ENCODER_PRIVATE_KEY=" .env') do set ENCODER_PRIVATE_KEY=%%b
)
if "!ENCODER_PRIVATE_KEY!"=="" (
    echo 🔑 Generating new encoder identity key...
    for /f "delims=" %%i in ('powershell -NoProfile -Command "$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)"') do set ENCODER_PRIVATE_KEY=%%i
    echo ✅ Encoder identity key generated
) else (
    echo ✅ Reusing existing encoder identity
)

REM Generate API key for direct modes (hex, so it is safe to echo into .env)
if not "%ENCODER_MODE%"=="embed" (
    echo.
    echo 🔑 Generating secure API key for direct requests...
    for /f "delims=" %%i in ('powershell -NoProfile -Command "$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })"') do set API_KEY=%%i
    echo ✅ Generated secure API key
    echo ⚠️  Keep this key secret - you'll need it to make API requests.
)

REM TLDR: Install Aria2
echo ⚙️ Download and install Aria2 for Windows and set it in your path

REM Create .env file based on mode
echo.
echo ⚙️ Creating configuration...

set "EMBED_ENABLED=false"
set "DIRECT_ENABLED=false"
if not "%ENCODER_MODE%"=="direct" set "EMBED_ENABLED=true"
if not "%ENCODER_MODE%"=="embed" set "DIRECT_ENABLED=true"

(
echo # 3Speak Encoder Configuration - %ENCODER_MODE% mode
echo HIVE_USERNAME=%HIVE_USERNAME%
echo.
echo # 🔑 Persistent Encoder Identity ^(CRITICAL - keeps same identity across restarts^)
echo ENCODER_PRIVATE_KEY=%ENCODER_PRIVATE_KEY%
echo # ⚠️  This is NOT your Hive key - it's for encoder authentication only
echo # ✅ Keep this secret and backed up - losing it creates a "new encoder"
echo.
echo # Embed System - community encoding jobs from 3Speak
echo EMBED_SYSTEM_ENABLED=%EMBED_ENABLED%
echo EMBED_SYSTEM_MODE=community
echo EMBED_GATEWAY_URL=https://embed.3speak.tv
echo.
echo # Direct API - private encoding requests from your own apps
echo DIRECT_API_ENABLED=%DIRECT_ENABLED%
) > .env

if "%DIRECT_ENABLED%"=="true" (
    echo DIRECT_API_PORT=3002
    echo DIRECT_API_KEY=%API_KEY%
) >> .env

(
echo.
echo # FFMPEG_PATH is optional - ffmpeg is found on your PATH automatically.
echo # FFMPEG_PATH=C:\path\to\ffmpeg.exe
) >> .env

REM Create desktop shortcut
echo.
echo 🖥️ Creating desktop shortcut...

set "SHORTCUT_PATH=%USERPROFILE%\Desktop\3Speak Encoder.lnk"
powershell -Command "$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%SHORTCUT_PATH%'); $Shortcut.TargetPath = 'cmd.exe'; $Shortcut.Arguments = '/k \"cd /d \"%INSTALL_DIR%\" && powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-encoder.ps1\"'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.IconLocation = 'shell32.dll,21'; $Shortcut.Description = '3Speak Video Encoder - Help encode videos for Web3'; $Shortcut.Save()"

REM Create start menu entry
set "STARTMENU_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\3Speak Encoder.lnk"
powershell -Command "$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%STARTMENU_PATH%'); $Shortcut.TargetPath = 'cmd.exe'; $Shortcut.Arguments = '/k \"cd /d \"%INSTALL_DIR%\" && powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-encoder.ps1\"'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.IconLocation = 'shell32.dll,21'; $Shortcut.Description = '3Speak Video Encoder - Help encode videos for Web3'; $Shortcut.Save()"

echo.
echo 🎉 3Speak Encoder installed successfully!
echo.
echo 📍 Installation directory: %INSTALL_DIR%
echo 👤 Configured for user: %HIVE_USERNAME%
echo.
echo 🚀 To start encoding:
echo    - Double-click the desktop shortcut
echo    - Or run: npm start in %INSTALL_DIR%
echo.
echo 🌐 Then open: http://localhost:3001
echo.
echo 💡 The encoder will automatically:
if not "%ENCODER_MODE%"=="direct" (
    echo    ✅ Register with the 3Speak embed system
    echo    ✅ Poll for community encoding jobs every 60 seconds
)
if not "%ENCODER_MODE%"=="embed" (
    echo    ✅ Start direct API server on http://localhost:3002
    echo    🔑 Your API key: %API_KEY%
)
echo    ✅ Process videos and upload to IPFS
echo    ✅ Provide real-time dashboard monitoring
echo.
echo ❓ Need help? Check the README.md or join our Discord!
echo.

REM Check if IPFS daemon is running and start if needed
echo 📦 Checking IPFS daemon...
curl -s --connect-timeout 3 http://127.0.0.1:5001/api/v0/id >nul 2>&1
if errorlevel 1 (
    echo ⚠️ IPFS daemon is not running. Starting IPFS daemon...
    echo 💡 Starting IPFS daemon in background...
    start /b ipfs daemon
    echo ⏳ Waiting for IPFS daemon to start...
    timeout /t 3 /nobreak >nul
    echo ✅ IPFS daemon started
) else (
    echo ✅ IPFS daemon is running
)

REM Offer to start immediately
set /p START_NOW="🚀 Start the encoder now? (y/n): "

if /i "%START_NOW%"=="y" (
    echo.
    echo 🎬 Starting 3Speak Encoder...
    echo 📱 Opening dashboard at http://localhost:3001
    
    REM Open browser after delay
    timeout /t 3 /nobreak >nul
    start http://localhost:3001
    
    REM Start the encoder
    call npm start
) else (
    echo.
    echo ✨ Setup complete! Start encoding when ready:
    echo    - Use desktop shortcut
    echo    - Or: cd "%INSTALL_DIR%" ^&^& npm start
)

pause
