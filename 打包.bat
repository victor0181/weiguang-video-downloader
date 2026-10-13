@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  Build the portable (green / no-installer) Windows package.
REM  NOTE: keep this file pure ASCII + CRLF.
REM  Windows console default codepage is CP936 while Node writes
REM  UTF-8 bytes, so any Chinese text in a .bat turns into garbage.
REM ============================================================

set "EL=node_modules\electron\dist\electron.exe"
if not exist "%EL%" (
  echo [ERROR] Electron runtime not found:
  echo         %EL%
  echo         Please run the install script first.
  pause
  exit /b 1
)

echo ============================================================
echo   Build portable package
echo ============================================================
echo.

REM Reuse the bundled Electron as a plain Node runtime (ELECTRON_RUN_AS_NODE).
set "ELECTRON_RUN_AS_NODE=1"
"%EL%" tools\build-portable.js %*
set "ELECTRON_RUN_AS_NODE="
set "CODE=%errorlevel%"

echo.
if not "%CODE%"=="0" (
  echo [ERROR] Build failed with code %CODE%.
) else (
  echo Done. See the dist folder.
)
pause
