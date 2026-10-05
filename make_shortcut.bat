@echo off
REM 20261005b：快捷方式改为「显式调用 wscript.exe + 脚本路径作为参数」，
REM 不再依赖 .vbs 文件关联。若系统安全策略/杀软禁用了 .vbs 关联，
REM 旧写法（TargetPath 直接指向 start.vbs）会双击毫无反应；显式指定宿主可绕开该问题。
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; $d=$s.SpecialFolders('Desktop'); $lnk=Join-Path $d 'Stock Analyzer.lnk'; $sc=$s.CreateShortcut($lnk); $sc.TargetPath=(Join-Path $env:SystemRoot 'System32\wscript.exe'); $sc.Arguments='\"D:\stock analyzer\stock-analyzer\start.vbs\"'; $sc.WorkingDirectory='D:\stock analyzer\stock-analyzer'; $sc.IconLocation='D:\stock analyzer\stock-analyzer\icon.ico,0'; $sc.Description='Stock Analyzer'; $sc.WindowStyle=7; $sc.Save(); Write-Host ('OK: '+[string]$lnk)"
echo.
echo If you see "OK:" above, the desktop shortcut was created successfully.
pause
