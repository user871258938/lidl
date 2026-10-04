@echo off
chcp 65001 >nul
title Lidl Extender
cd /d "%~dp0"

echo ============================================
echo   Lidl Extender - starting (headless mode)
echo   No browser window will be shown
echo ============================================
echo.

REM Force headless browser (no visible browser window)
set HEADLESS=true

node script.js

echo.
echo --------------------------------------------
echo   Script stopped (exit code: %errorlevel%)
echo   Close this window when done.
echo --------------------------------------------
pause
