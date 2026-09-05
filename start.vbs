Option Explicit
' Stock Analyzer - hidden launcher (no console window / no flash-exit)
' Called from desktop .lnk; runs latest code from D drive.
' IMPORTANT: always kill the old service on port 3005 first so the user sees the latest code.
Dim WshShell, fso, q, nodeExe, baseDir, target, cmd
baseDir = "D:\stock analyzer\stock-analyzer"
target  = baseDir & "\server.js"

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = baseDir
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

' Prefer managed Node (WorkBuddy), fallback to PATH node
nodeExe = "C:\Users\16507\.workbuddy\binaries\node\versions\22.22.2\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

' Kill any old process still listening on port 3005 (only the listener, not other apps)
' Use a helper .bat so the tricky cmd quoting stays out of VBScript.
WshShell.Run q & baseDir & "\kill_port_3005.bat" & q, 0, True

' Wait for the port to be released
WScript.Sleep 800

' Start a fresh Node service on fixed port 3005
' SA_NO_AUTO_OPEN=1 tells server.js NOT to open the browser itself.
' This launcher opens it below. Without this flag BOTH would open a window,
' which is why the user saw two identical web pages on every double click.
WshShell.Environment("PROCESS")("PORT") = "3005"
WshShell.Environment("PROCESS")("SA_NO_AUTO_OPEN") = "1"
cmd = q & nodeExe & q & " " & q & target & q
WshShell.Run cmd, 0, False

' Wait for the service to be ready, then open the browser
WScript.Sleep 3500
WshShell.Run "cmd /c start """" ""http://localhost:3005""", 0, False
