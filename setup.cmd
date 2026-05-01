@echo off
cd /d "%~dp0"
echo [1/2] Installing required packages...
call npm install
if errorlevel 1 goto :fail
echo [2/2] Creating local Evo settings...
call npm run setup
if errorlevel 1 goto :fail
echo.
echo Setup finished.
echo This system works locally on this PC.
echo It does not register itself to a server.
echo Open a new PowerShell session after setup.
echo Then use codex or claude as usual.
echo Local data is stored in the ".evo" folder of the directory where you run the CLI.
echo Read README.md (Japanese section) for the full step-by-step guide.
goto :end

:fail
echo.
echo Setup failed. Scroll up to see the error message.
exit /b 1

:end
