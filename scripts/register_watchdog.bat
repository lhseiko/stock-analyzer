@echo off
REM Register the Stock Analyzer watchdog to run every 5 minutes via Windows Task Scheduler.
REM Double-click this file. Windows may ask for permission (UAC) - allow it so the task can be created.
REM To remove later, run unregister_watchdog.bat (same folder).
set "VBS=D:\stock analyzer\stock-analyzer\scripts\watchdog.vbs"
schtasks /create /tn "StockAnalyzerWatchdog" /tr "wscript.exe \"D:\stock analyzer\stock-analyzer\scripts\watchdog.vbs\"" /sc minute /mo 5 /f
if %errorlevel%==0 (
  echo.
  echo Watchdog task "StockAnalyzerWatchdog" registered (runs every 5 minutes).
  echo It probes http://127.0.0.1:3005/api/health and relaunches start.vbs if the service is down.
) else (
  echo.
  echo Failed to register. Try right-clicking this file and choosing "Run as administrator".
)
echo.
pause
