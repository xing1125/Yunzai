@echo off
REM ===== TRSS-Yunzai autostart (Task Scheduler at logon / called by start-yunzai.cmd) =====
REM NOTE: every pm2 call MUST be prefixed with CALL. pm2 resolves to pm2.cmd, and invoking a
REM .cmd from another .cmd without CALL transfers control and never comes back -- that is
REM exactly what made the launcher hang at "[状态] 未运行，正在后台拉起...".
cd /d D:\trss-yunzai

where pm2 >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pm2 not found in PATH. Run: npm i -g pm2
  exit /b 1
)

REM 清空代理变量：若本脚本不是从资源管理器双击、而是从带代理的终端（IDE / 沙箱）
REM 里被调用，pm2 会把 HTTP_PROXY 一并记进应用环境。等那个代理进程退出，
REM Bot 的所有外网请求就会走死端口，表现为插件莫名超时。
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="
set "ALL_PROXY="
set "all_proxy="

REM 清掉同名残留（旧部署的 dump 里留过一条指向 D:\Yunzai\app.js 的僵尸，
REM 不删的话 pm2 start 会因为「同名应用已在列表」直接跳过）
call pm2 delete TRSS-Yunzai >nul 2>&1

REM 一律按 ecosystem 文件声明式启动，不依赖 dump
REM --update-env：强制用当前（已清理过的）环境变量覆盖 pm2 里缓存的那一份
call pm2 start config/pm2.yaml --update-env >nul 2>&1
call pm2 save >nul 2>&1
exit /b 0
