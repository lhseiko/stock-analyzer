Option Explicit
' Stock Analyzer watchdog - pure ASCII (GBK-safe).
' Polls http://127.0.0.1:3005/api/health once; if the service is not healthy, it silently
' relaunches start.vbs (which kills the old listener on port 3005 and starts a fresh one).
' Designed to run from Windows Task Scheduler every 5 minutes (see register_watchdog.bat).

Dim WshShell, fso, baseDir, logDir, url, startVbs
Dim http, code, resp, healthy, logFile, ts, f2

baseDir  = "D:\stock analyzer\stock-analyzer"
logDir   = baseDir & "\logs"
url      = "http://127.0.0.1:3005/api/health"
startVbs = baseDir & "\start.vbs"
healthy   = False

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Probe the health endpoint. Any failure (no service, timeout, non-200, bad body)
' leaves healthy = False, which triggers a relaunch below.
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
If Err.Number = 0 Then
    http.Open "GET", url, False
    http.setRequestHeader "Cache-Control", "no-cache"
    http.Send
    code = http.Status
    resp = http.ResponseText
    If code = 200 And InStr(resp, "status") > 0 And InStr(resp, "ok") > 0 Then healthy = True
End If
On Error GoTo 0

If Not healthy Then
    ' Only relaunch if start.vbs still exists, so a broken install cannot loop forever.
    If fso.FileExists(startVbs) Then
        ' Log each relaunch attempt for post-mortem (timestamp + observed HTTP status).
        On Error Resume Next
        If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
        logFile = logDir & "\watchdog.log"
        ts = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) _
           & " " & Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2)
        Set f2 = fso.OpenTextFile(logFile, 8, True) ' 8 = append, create if missing
        f2.WriteLine ts & " health=" & code & " relaunch start.vbs"
        f2.Close
        On Error GoTo 0
        WshShell.Run "wscript.exe " & Chr(34) & startVbs & Chr(34), 0, False
    End If
End If
