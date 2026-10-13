@echo off
rem ---- Switch console to UTF-8. Windows console defaults to GBK(CP936) while
rem ---- Node/Electron write UTF-8 bytes, which would show up as mojibake.
chcp 65001 >nul

setlocal
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ATTACH_CONSOLE=
cd /d "%~dp0"

echo.
echo  ============================================
echo   Video Downloader  -  Launcher
echo  ============================================
echo.

rem ---- Electron binary that ships inside node_modules. No npm/node needed. ----
set "ELECTRON_BIN=%~dp0node_modules\electron\dist\electron.exe"

if exist "%ELECTRON_BIN%" goto :run_electron

rem ---- electron.exe missing: is the package there at all? ----
if not exist "node_modules\electron\package.json" (
  echo  [ERROR] Dependencies are not installed.
  echo.
  echo          This folder must contain a prepared node_modules directory
  echo          ^(with electron inside^). Please restore it, or run the
  echo          INSTALL .bat on a machine that has Node.js.
  echo.
  pause
  exit /b 1
)

rem ---- package exists but binary was never downloaded (postinstall skipped) ----
echo  [ERROR] electron.exe was not found at:
echo          %ELECTRON_BIN%
echo.
echo          The npm package is present but its binary download was skipped.
echo          Fix it with one of these, then run this file again:
echo            1^) run the INSTALL .bat  ^(needs Node.js^)
echo            2^) delete node_modules and reinstall
echo.
pause
exit /b 1

:run_electron
echo  Starting Video Downloader ...
echo.

"%ELECTRON_BIN%" .
set "CODE=%errorlevel%"

if not "%CODE%"=="0" (
  echo.
  echo  [ERROR] Video Downloader exited with code %CODE%.
  echo.
  pause
)
