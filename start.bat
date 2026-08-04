@echo off
setlocal
cd /d "%~dp0app"

if not exist "node_modules" (
    echo Installing dependencies - first run only...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Please check that Node.js is installed.
        pause
        exit /b 1
    )
)

echo Starting task_tracker...
call npm start
echo.
echo task_tracker has closed (exit code %errorlevel%).
if exist "..\data\app.log" (
    echo Recent log lines from data\app.log:
    powershell -NoProfile -Command "Get-Content -Tail 15 '..\data\app.log'"
)
pause
