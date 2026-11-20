@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   ============================================
echo      AI Debate Room - 4 v 4
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found. Install Node 18+ first.
  echo   https://nodejs.org/
  pause
  exit /b 1
)

if not exist "%~dp0data" mkdir "%~dp0data"

if exist ".env" (
  echo   Loading .env ...
  node --env-file=.env server.js
) else (
  node server.js
)

echo.
echo   Server stopped.
pause
