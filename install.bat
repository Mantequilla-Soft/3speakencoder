@echo off
REM 3Speak Video Encoder - Windows installer launcher.
REM Double-click this file. It runs install.ps1 (the real installer), using the copy next
REM to this file or downloading the latest one, so both installers always behave the same.
setlocal

set "PS1=%~dp0install.ps1"
if not exist "%PS1%" (
    set "PS1=%TEMP%\3speak-install.ps1"
    echo Downloading the installer...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.ps1' -OutFile '%TEMP%\3speak-install.ps1'"
    if errorlevel 1 (
        echo Could not download the installer. Check your internet connection and try again.
        pause
        exit /b 1
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "CODE=%ERRORLEVEL%"
if not defined CI pause
exit /b %CODE%
