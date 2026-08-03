@echo off
setlocal
cd /d "%~dp0app"

if not exist "node_modules" (
    echo Installing dependencies (first run only)...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Please check that Node.js is installed.
        pause
        exit /b 1
    )
)

call npm start
if errorlevel 1 (
    echo.
    echo task_tracker exited with an error.
    pause
)
