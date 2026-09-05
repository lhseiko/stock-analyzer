@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; $d=$s.SpecialFolders('Desktop'); $lnk=Join-Path $d 'Stock Analyzer.lnk'; $sc=$s.CreateShortcut($lnk); $sc.TargetPath='D:\stock analyzer\stock-analyzer\start.vbs'; $sc.WorkingDirectory='D:\stock analyzer\stock-analyzer'; $sc.IconLocation='D:\stock analyzer\stock-analyzer\icon.ico,0'; $sc.Description='Stock Analyzer'; $sc.WindowStyle=7; $sc.Save(); Write-Host ('OK: '+[string]$lnk)"
echo.
echo If you see "OK:" above, the desktop shortcut was created successfully.
pause
