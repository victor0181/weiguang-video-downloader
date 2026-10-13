@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  Video Downloader self test launcher
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

if not exist "tools\out" mkdir "tools\out"

echo ============================================================
echo   Video Downloader  self test
echo ============================================================
echo.

echo [1/4] Bilibili API health check  (no Electron needed)
set "ELECTRON_RUN_AS_NODE=1"
"%EL%" tools\api-test.js
set "ELECTRON_RUN_AS_NODE="
echo.

echo [2/4] Link parser test
set "ELECTRON_RUN_AS_NODE=1"
"%EL%" tools\parse-test.js
set "ELECTRON_RUN_AS_NODE="
echo.

echo [3/4] Douyin end-to-end (parse -^> download -^> verify)
"%EL%" tools\douyin-test.js
echo.

echo [4/4] Bilibili end-to-end (parse -^> download -^> merge -^> verify)
"%EL%" tools\selftest.js
echo.

echo ============================================================
echo   All checks finished.
echo ============================================================
pause
