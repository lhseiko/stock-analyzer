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

REM 选定 Node 路径：优先托管版本（自动探测版本目录，不写死版本号），否则系统 PATH 中的 node
REM 注意：批处理中「括号块内的 %VAR% 在解析时展开」，所以不能在同一个块里先 set 再用 %VAR%。
REM       这里统一用 CALL 子过程（运行时求值），规避延迟展开陷阱。
set "NODE_ROOT=C:\Users\16507\.workbuddy\binaries\node\versions"
set "MANAGED_NODE="

REM ① 优先 versions\current 指向的版本；② 再扫 versions\* 任意子目录
if exist "%NODE_ROOT%\current" for /f "usebackq delims=" %%V in ("%NODE_ROOT%\current") do call :TryNode "%NODE_ROOT%\%%V\node.exe"
if not defined MANAGED_NODE if exist "%NODE_ROOT%" for /d %%D in ("%NODE_ROOT%\*") do call :TryNode "%%D\node.exe"

REM ③ 回退 PATH 上的 node；④ 全失败则明确报错（不再静默）
if defined MANAGED_NODE (
    set "NODE_EXE=%MANAGED_NODE%"
) else (
    where node >nul 2>&1
    if not errorlevel 1 (
        set "NODE_EXE=node"
    ) else (
        echo [错误] 未找到 Node.js，无法启动。
        echo 已检查: %NODE_ROOT%
        pause
        exit /b 1
    )
)
goto :AfterNodePick

:TryNode
if not defined MANAGED_NODE if exist "%~1" set "MANAGED_NODE=%~1"
exit /b 0

:AfterNodePick

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
