@echo off
REM Double-click this file — no command line knowledge needed. It opens a
REM console window itself, installs what it needs, and starts the Companion.
cd /d "%~dp0"

echo Setting up your Neurovance Companion...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed on this computer yet — the Companion needs it to run.
  echo.
  echo Get it here ^(takes about a minute^): https://nodejs.org
  echo Pick the LTS version, install it, then come back and double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Installing ^(only needed the first time — this can take a minute^)...
call npm install --silent
if errorlevel 1 (
  echo.
  echo Something went wrong during setup. Try double-clicking this file again — if it keeps failing, ask for help.
  pause
  exit /b 1
)

echo.
echo Starting the Companion. Go to Neurovance, click "Pair a computer" to get a code, then paste it below.
echo.
call npm start
