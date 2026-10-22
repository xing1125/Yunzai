@echo off
setlocal enabledelayedexpansion
title 荧 · Bot 启动器
cd /d D:\trss-yunzai

echo.
echo   ===== 荧 · Bot 启动器 =====
echo   目录: %CD%
echo.

where pm2 >nul 2>&1
if errorlevel 1 (
  echo   [错误] 没找到 pm2，请先执行: npm i -g pm2
  echo.
  pause
  exit /b 1
)

where curl >nul 2>&1
if errorlevel 1 (
  set "_hascurl=0"
) else (
  set "_hascurl=1"
)

if "!_hascurl!"=="1" (
  curl -f -s -o nul -m 2 http://127.0.0.1:2536/guoba/ >nul 2>&1
  if not errorlevel 1 (
    echo   [状态] 已在运行，直接打开后台
    goto open
  )
)

echo   [状态] 未运行，正在后台拉起...
call "%~dp0startup.cmd"
if errorlevel 1 (
  echo.
  echo   [错误] startup.cmd 返回失败，检查 pm2 是否安装正常
  echo.
  pause
  exit /b 1
)

if "!_hascurl!"=="0" (
  echo   [等待] 固定等 30 秒
  ping -n 31 127.0.0.1 >nul
  goto open
)

echo   [等待] 端口就绪中（首次启动约 30 秒，下面的点每 2 秒一个）
set /a _n=0
:wait
curl -f -s -o nul -m 2 http://127.0.0.1:2536/guoba/ >nul 2>&1
if not errorlevel 1 goto open
set /a _n+=1
if !_n! geq 40 goto fail
<nul set /p "=."
ping -n 3 127.0.0.1 >nul
goto wait

:open
echo.
echo   [完成] 后台地址: http://127.0.0.1:2536/guoba/
start "" http://127.0.0.1:2536/guoba/
ping -n 4 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo   [失败] 80 秒内端口没起来，看日志定位:
echo          call pm2 logs TRSS-Yunzai --lines 60
echo          或看 %CD%\bot_stderr.log
echo.
pause
exit /b 1
