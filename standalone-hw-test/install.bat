@echo off
REM Hardware Acceleration Test - Quick Install Script
REM Works on Windows

echo ================================================================
echo    Hardware Acceleration Test - Installation
echo ================================================================
echo.

REM Check for Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [X] Node.js is not installed
    echo     Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo [OK] Node.js found
node --version

REM Check for npm
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [X] npm is not installed
    pause
    exit /b 1
)

echo [OK] npm found
npm --version

REM Check for FFmpeg
where ffmpeg >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [!] FFmpeg is not installed
    echo     The test will fail without FFmpeg
    echo     Install it from: https://ffmpeg.org/download.html
    echo.
    set /p continue="Continue anyway? (y/n): "
    if /i not "%continue%"=="y" exit /b 1
) else (
    echo [OK] FFmpeg found
    ffmpeg -version | findstr "ffmpeg version"
)

echo.
echo Installing dependencies...
call npm install

echo.
echo ================================================================
echo    Installation Complete!
echo ================================================================
echo.
echo Run the test with:
echo    npm start
echo.
echo    or
echo.
echo    npm test
echo.
pause
