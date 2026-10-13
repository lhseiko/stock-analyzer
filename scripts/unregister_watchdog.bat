@echo off
REM Remove the Stock Analyzer watchdog scheduled task.
schtasks /delete /tn "StockAnalyzerWatchdog" /f
if %errorlevel%==0 (
  echo Watchdog task "StockAnalyzerWatchdog" removed.
) else (
  echo No watchdog task found, or removal failed (it may already be gone).
)
echo.
pause
