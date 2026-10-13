@echo off
rem ---- Switch console to UTF-8 (see start .bat for the reason).
chcp 65001 >nul

setlocal
cd /d "%~dp0"

echo.
echo  ============================================
echo   Video Downloader  -  Install Dependencies
echo  ============================================
echo.
echo  Registry : registry.npmmirror.com
echo  Target   : %~dp0node_modules
echo.

if exist "node_modules\electron\dist\electron.exe" (
  echo  [SKIP] Dependencies are already installed and ready.
  echo         Just double-click the START .bat.
  echo.
  echo         ^(Delete the node_modules folder if you really want a clean
  echo          reinstall.^)
  echo.
  pause
  exit /b 0
)

rem ---- Locate npm -------------------------------------------------------
set "NPM="
for %%I in (npm.cmd) do if not defined NPM set "NPM=%%~$PATH:I"

if not defined NPM (
  for %%P in (
    "%ProgramFiles%\nodejs\npm.cmd"
    "%ProgramFiles(x86)%\nodejs\npm.cmd"
    "%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
    "%APPDATA%\npm\npm.cmd"
  ) do (
    if not defined NPM if exist %%P set "NPM=%%~P"
  )
)

if not defined NPM (
  echo  [ERROR] Node.js / npm was not found on this computer.
  echo.
  echo          Installing dependencies requires Node.js once. Options:
  echo            1^) Install Node.js LTS, then run this file again:
  echo               https://nodejs.org/
  echo               ^(mirror: https://npmmirror.com/mirrors/node/^)
  echo            2^) Or copy a ready-made node_modules folder into this
  echo               directory ^(ask whoever built the project^).
  echo.
  echo          Note: the START .bat does NOT need Node.js - it can run the
  echo          program directly as long as node_modules is already there.
  echo.
  pause
  exit /b 1
)

echo  Using npm: %NPM%
echo.
echo  Installing, this may take a few minutes ...
echo.

call "%NPM%" install
if errorlevel 1 (
  echo.
  echo  [FAIL] npm install failed.
  echo         Check network / proxy, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo  [OK] Done. Now double-click the START .bat to launch.
echo.
pause
