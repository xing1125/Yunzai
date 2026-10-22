@echo off
rem ============================================================================
rem  Start Yunzai bot ONLY (win/node v25, hidden background) + live log window
rem  - Single instance guard: skip if :2536 already listening.
rem  - The live log window scrolls bot_stdout.log in real time (tail -f style).
rem  - Closing the log window does NOT stop the bot.
rem ============================================================================
setlocal
set "YZ=D:\trss-yunzai"
set "NODE=D:\trss-yunzai\win\node\node.exe"

echo Checking :2536 ...
powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort 2536 -State Listen -ErrorAction SilentlyContinue){exit 0}else{exit 1}" >nul 2>&1
if %errorlevel%==0 goto already

echo [%date% %time%] starting Yunzai >> "%YZ%\bot_stdout.log"
echo [START] launching Yunzai with node v25 - hidden background ...
powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'app.js' -WorkingDirectory '%YZ%' -WindowStyle Hidden -RedirectStandardOutput '%YZ%\bot_stdout.log' -RedirectStandardError '%YZ%\bot_stderr.log'"

echo [LIVE ] opening live log window ...
start "Yunzai Live Log" powershell -NoProfile -Command "Get-Content -Path '%YZ%\bot_stdout.log' -Wait -Tail 30"

echo.
echo [OK] Yunzai is running in background - the live log window shows real-time output.
echo     Closing the log window does NOT stop the bot.
echo.
pause
exit /b 0

:already
echo [SKIP] Yunzai already running on :2536 - opening live log window ...
start "Yunzai Live Log" powershell -NoProfile -Command "Get-Content -Path '%YZ%\bot_stdout.log' -Wait -Tail 30"
echo [OK] Live log window opened. Closing it does NOT stop the bot.
echo.
pause
exit /b 0
