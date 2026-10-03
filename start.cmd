@echo off
setlocal
title Prompt Injector
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is missing. Reinstall Node.js, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\@playwright\mcp\cli.js" goto install
if not exist "node_modules\@modelcontextprotocol\sdk\package.json" goto install
goto run

:install
echo Installing project dependencies...
call npm ci
if errorlevel 1 (
  echo Dependency installation failed. Check the error above.
  pause
  exit /b 1
)

:run
set "PROMPT_INJECTOR_OPEN_BROWSER=1"
echo Starting Prompt Injector. Keep this window open while using the site.
echo Press Ctrl+C to stop the backend.
call npm run web
if errorlevel 1 (
  echo Startup failed. Check the error above. If the port is already in use, stop the earlier backend.
  pause
  exit /b 1
)
endlocal
