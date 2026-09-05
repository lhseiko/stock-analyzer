@echo off
chcp 65001 >nul 2>&1
title 股票分析工作台
REM 始终启动 D 盘最新开发目录中的代码
cd /d "%~dp0"
set PORT=3005

echo ============================================
echo   股票分析工作台 (Stock Analyzer)
echo ============================================
echo.

REM 关键：先强制杀掉占用 3005 端口的旧服务，确保启动的是最新代码
echo 正在检查并清理占用端口 3005 的旧服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3005" ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo 端口清理完成，等待释放...
ping -n 2 127.0.0.1 >nul 2>&1

REM 选定 Node 路径：优先托管版本，否则系统 PATH 中的 node
set MANAGED_NODE=C:\Users\16507\.workbuddy\binaries\node\versions\22.22.2\node.exe
if exist "%MANAGED_NODE%" (
    set NODE_EXE=%MANAGED_NODE%
) else (
    where node >nul 2>&1
    if not errorlevel 1 (
        set NODE_EXE=node
    ) else (
        echo [错误] 未找到 Node.js，请安装 Node.js 后重试。
        echo 托管路径: %MANAGED_NODE%
        pause
        exit /b 1
    )
)

echo 正在启动股票分析工作台...
echo 地址： http://localhost:3005
echo 服务器启动后约 3 秒自动打开浏览器...
echo.

REM 用一个独立的延迟进程打开浏览器（不阻塞服务器主进程）
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3005"

REM 前台运行 node：node 本身是常驻服务进程，会一直保持此窗口（绝不闪退）。
REM 关闭此窗口即停止服务器。
"%NODE_EXE%" server.js
echo.
echo [服务已停止] 若上方有红色报错，请把报错内容发给我。
pause
