@echo off
chcp 65001 >nul 2>&1
title Stock Analyzer 启动（诊断模式）
REM ============================================================================
REM 备用启动器（诊断模式）：当双击桌面图标没反应时，双击本文件即可启动工作台。
REM 与 start.vbs 的区别：本文件不隐藏窗口，会把每一步都打印出来，便于定位问题。
REM 20261005b 新增：配合修复 start.vbs「Node 路径写死导致静默失败」的问题。
REM ============================================================================
cd /d "%~dp0"
set "PORT=3005"
set "SA_NO_BG_AI=1"

echo ============================================
echo   Stock Analyzer 启动（诊断模式）
echo ============================================
echo.
echo [1/5] 清理占用 3005 的旧服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3005" ^| findstr LISTENING') do (
    echo       杀掉 PID %%a
    taskkill /F /PID %%a >nul 2>&1
)
ping -n 2 127.0.0.1 >nul 2>&1

echo [2/5] 定位 Node.js...
set "NODE_ROOT=C:\Users\16507\.workbuddy\binaries\node\versions"
set "MANAGED_NODE="
if exist "%NODE_ROOT%\current" for /f "usebackq delims=" %%V in ("%NODE_ROOT%\current") do call :TryNode "%NODE_ROOT%\%%V\node.exe"
if not defined MANAGED_NODE if exist "%NODE_ROOT%" for /d %%D in ("%NODE_ROOT%\*") do call :TryNode "%%D\node.exe"

if defined MANAGED_NODE (
    set "NODE_EXE=%MANAGED_NODE%"
    echo       找到: %MANAGED_NODE%
) else (
    where node >nul 2>&1
    if not errorlevel 1 (
        set "NODE_EXE=node"
        echo       使用 PATH 中的 node
    ) else (
        echo.
        echo [错误] 未找到 Node.js，无法启动。
        echo        已检查目录: %NODE_ROOT%
        echo        请把这段文字截图发给开发者。
        echo.
        pause
        exit /b 1
    )
)
goto :AfterNodePick

:TryNode
if not defined MANAGED_NODE if exist "%~1" set "MANAGED_NODE=%~1"
exit /b 0

:AfterNodePick

echo [3/5] 启动服务（前台运行，关闭本窗口即停止服务）...
echo [4/5] 就绪后浏览器会自动打开；若没弹出，手动访问 http://localhost:3005
echo [5/5] 地址: http://localhost:3005
echo.

REM 后台延迟开浏览器（不阻塞下面前台 node）
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3005"

"%NODE_EXE%" server.js

echo.
echo [服务已停止] 若上方有红色报错，请把报错内容发给开发者。
pause
