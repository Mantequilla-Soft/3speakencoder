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

REM Choose encoder mode
echo.
echo 🎯 Choose your encoder mode:
echo   1^) Gateway Mode - Help 3Speak community ^(connects to 3Speak gateway^)
echo   2^) Direct API Mode - Private encoder for your apps ^(direct requests only^)
echo   3^) Dual Mode - Both gateway jobs and direct API ^(recommended for developers^)
echo.
set /p MODE_CHOICE="Enter your choice (1, 2, or 3): "

if "%MODE_CHOICE%"=="1" (
    set "ENCODER_MODE=gateway"
    echo ✅ Gateway Mode selected - you'll help encode videos for 3Speak community
) else if "%MODE_CHOICE%"=="2" (
    set "ENCODER_MODE=direct"
    echo ✅ Direct API Mode selected - private encoder for your applications
) else if "%MODE_CHOICE%"=="3" (
    set "ENCODER_MODE=dual"
    echo ✅ Dual Mode selected - maximum flexibility for developers
) else (
    echo ❌ Invalid choice. Defaulting to Gateway Mode.
    set "ENCODER_MODE=gateway"
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
    echo 👤 What's your Hive username? ^(required for gateway mode^)
    set /p HIVE_USERNAME="Hive username: "
    if "!HIVE_USERNAME!"=="" (
        echo ❌ Hive username is required for gateway mode!
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
    git clone https://github.com/menobass/3speakencoder.git "%INSTALL_DIR%"
    cd /d "%INSTALL_DIR%"
)

echo.
echo 📦 Installing dependencies...
call npm install

REM 🔑 Generate persistent encoder identity key (CRITICAL for dashboard tracking)
echo.
echo 🔑 Generating persistent encoder identity key...
for /f "delims=" %%i in ('powershell -command "[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))"') do set ENCODER_PRIVATE_KEY=%%i
echo ✅ Encoder identity key generated - this keeps your encoder identity consistent!

REM Generate API key for direct modes
if "%ENCODER_MODE%"=="direct" (
    echo.
    echo 🔑 Generating secure API key for direct requests...
    REM Generate random API key using PowerShell
    for /f "delims=" %%i in ('powershell -command "[System.Web.Security.Membership]::GeneratePassword(64, 0)"') do set API_KEY=%%i
    echo ✅ Generated secure API key
    echo ⚠️  Keep this key secret - you'll need it to make API requests!
)
if "%ENCODER_MODE%"=="dual" (
    echo.
    echo 🔑 Generating secure API key for direct requests...
    for /f "delims=" %%i in ('powershell -command "[System.Web.Security.Membership]::GeneratePassword(64, 0)"') do set API_KEY=%%i
    echo ✅ Generated secure API key
    echo ⚠️  Keep this key secret - you'll need it to make API requests!
)

REM Create .env file based on mode
echo.
echo ⚙️ Creating configuration...

if "%ENCODER_MODE%"=="gateway" (
    REM Gateway-only mode
    (
    echo # 3Speak Encoder Configuration - Gateway Mode
    echo HIVE_USERNAME=%HIVE_USERNAME%
    echo.
    echo # Gateway mode settings
    echo REMOTE_GATEWAY_ENABLED=true
    echo.
    echo # Direct API disabled for gateway-only mode
    echo DIRECT_API_ENABLED=false
    echo.
    echo # 🔑 Persistent Encoder Identity ^(CRITICAL - keeps same identity across restarts^)
    echo ENCODER_PRIVATE_KEY=%ENCODER_PRIVATE_KEY%
    echo # ⚠️  This is NOT your Hive key - it's for encoder authentication only
    echo # ✅ Keep this secret and backed up - losing it creates a "new encoder"
    echo.
    echo # MongoDB Direct Verification ^(DISABLED by default^)
    echo # 🚨 Only enable for 3Speak infrastructure nodes with database access
    echo MONGODB_VERIFICATION_ENABLED=false
    echo # MONGODB_URI=mongodb://username:password@host:port/database
    echo # DATABASE_NAME=spk-encoder-gateway
    echo.
    echo # Gateway Aid Fallback ^(DISABLED by default^)
    echo # 🆘 Only for approved community nodes - contact 3Speak team
    echo GATEWAY_AID_ENABLED=false
    echo # GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1
    echo.
    echo # Gateway Monitor Verification ^(RECOMMENDED for community encoders^)
    echo # 🌐 Public REST API for race condition prevention
    echo GATEWAY_MONITOR_ENABLED=false
    echo # GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api
    echo.
    echo # Logging
    echo LOG_LEVEL=info
    ) > .env
) else if "%ENCODER_MODE%"=="direct" (
    REM Direct API-only mode
    (
    echo # 3Speak Encoder Configuration - Direct API Mode
    echo HIVE_USERNAME=%HIVE_USERNAME%
    echo.
    echo # Disable gateway mode ^(direct API only^)
    echo REMOTE_GATEWAY_ENABLED=false
    echo.
    echo # Direct API settings
    echo DIRECT_API_ENABLED=true
    echo DIRECT_API_PORT=3002
    echo DIRECT_API_KEY=%API_KEY%
    echo.
    echo # 🔑 Persistent Encoder Identity ^(CRITICAL - keeps same identity across restarts^)
    echo ENCODER_PRIVATE_KEY=%ENCODER_PRIVATE_KEY%
    echo # ⚠️  This is NOT your Hive key - it's for encoder authentication only
    echo # ✅ Keep this secret and backed up - losing it creates a "new encoder"
    echo.
    echo # MongoDB Direct Verification ^(DISABLED by default^)
    echo # 🚨 Only enable for 3Speak infrastructure nodes with database access
    echo MONGODB_VERIFICATION_ENABLED=false
    echo # MONGODB_URI=mongodb://username:password@host:port/database
    echo # DATABASE_NAME=spk-encoder-gateway
    echo.
    echo # Gateway Aid Fallback ^(DISABLED by default^)
    echo # 🆘 Only for approved community nodes - contact 3Speak team
    echo GATEWAY_AID_ENABLED=false
    echo # GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1
    echo.
    echo # Gateway Monitor Verification ^(RECOMMENDED for community encoders^)
    echo # 🌐 Public REST API for race condition prevention
    echo GATEWAY_MONITOR_ENABLED=false
    echo # GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api
    echo.
    echo # Logging
    echo LOG_LEVEL=info
    ) > .env
) else (
    REM Dual mode
    (
    echo # 3Speak Encoder Configuration - Dual Mode
    echo HIVE_USERNAME=%HIVE_USERNAME%
    echo.
    echo # Gateway mode enabled
    echo REMOTE_GATEWAY_ENABLED=true
    echo.
    echo # Direct API enabled
    echo DIRECT_API_ENABLED=true
    echo DIRECT_API_PORT=3002
    echo DIRECT_API_KEY=%API_KEY%
    echo.
    echo # 🔑 Persistent Encoder Identity ^(CRITICAL - keeps same identity across restarts^)
    echo ENCODER_PRIVATE_KEY=%ENCODER_PRIVATE_KEY%
    echo # ⚠️  This is NOT your Hive key - it's for encoder authentication only
    echo # ✅ Keep this secret and backed up - losing it creates a "new encoder"
    echo.
    echo # MongoDB Direct Verification ^(DISABLED by default^)
    echo # 🚨 Only enable for 3Speak infrastructure nodes with database access
    echo MONGODB_VERIFICATION_ENABLED=false
    echo # MONGODB_URI=mongodb://username:password@host:port/database
    echo # DATABASE_NAME=spk-encoder-gateway
    echo.
    echo # Gateway Aid Fallback ^(DISABLED by default^)
    echo # 🆘 Only for approved community nodes - contact 3Speak team
    echo GATEWAY_AID_ENABLED=false
    echo # GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1
    echo.
    echo # Gateway Monitor Verification ^(RECOMMENDED for community encoders^)
    echo # 🌐 Public REST API for race condition prevention
    echo GATEWAY_MONITOR_ENABLED=false
    echo # GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api
    echo.
    echo # Logging
    echo LOG_LEVEL=info
    ) > .env
)

REM Create desktop shortcut
echo.
echo 🖥️ Creating desktop shortcut...

set "SHORTCUT_PATH=%USERPROFILE%\Desktop\3Speak Encoder.lnk"
powershell -Command "$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%SHORTCUT_PATH%'); $Shortcut.TargetPath = 'cmd.exe'; $Shortcut.Arguments = '/k \"cd /d \"%INSTALL_DIR%\" && npm start\"'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.IconLocation = 'shell32.dll,21'; $Shortcut.Description = '3Speak Video Encoder - Help encode videos for Web3'; $Shortcut.Save()"

REM Create start menu entry
set "STARTMENU_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\3Speak Encoder.lnk"
powershell -Command "$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%STARTMENU_PATH%'); $Shortcut.TargetPath = 'cmd.exe'; $Shortcut.Arguments = '/k \"cd /d \"%INSTALL_DIR%\" && npm start\"'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.IconLocation = 'shell32.dll,21'; $Shortcut.Description = '3Speak Video Encoder - Help encode videos for Web3'; $Shortcut.Save()"

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
echo    ✅ Connect to 3Speak gateway
echo    ✅ Fetch available encoding jobs
echo    ✅ Process videos and upload to IPFS
echo    ✅ Submit results back to 3Speak
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
    npm start
) else (
    echo.
    echo ✨ Setup complete! Start encoding when ready:
    echo    - Use desktop shortcut
    echo    - Or: cd "%INSTALL_DIR%" ^&^& npm start
)

pause