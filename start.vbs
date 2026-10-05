Option Explicit
' Stock Analyzer - hidden launcher (no console window / no flash-exit)
' Called from the desktop shortcut; runs the latest code from the D drive.
' IMPORTANT: always kill the old service on port 3005 first so the user sees the latest code.
'
' HISTORY / PITFALLS (all ASCII on purpose - see note at the bottom):
'
' 20261005a  Every Dim must be placed BEFORE the first assignment.
'   VBScript executes line by line and has NO hoisting. A previous version put the
'   Dim block *after* a comment block, so the assignment ran before the Dim was
'   reached -> "Variable is undefined: 'baseDir'" (800A01F4) and the service never
'   started. Keep ALL Dim statements right after Option Explicit.
'
' 20261005b  Never hardcode the Node path.
'   The managed runtime directory carries a suffix (e.g. 22.22.2-3, not 22.22.2),
'   so a hardcoded path failed FileExists, fell back to a bare "node" that does not
'   exist on PATH, and WshShell.Run died silently in a hidden window -> double click
'   did nothing at all. We now auto-detect Node (see below).
'
' 20261005c  THIS FILE MUST STAY PURE ASCII (no Chinese text anywhere).
'   wscript.exe reads a .vbs file using the system ANSI code page (GBK on this box),
'   NOT UTF-8. Chinese characters saved as UTF-8 are mis-decoded into garbage bytes,
'   and some of those bytes break the comment/string boundaries -> the parser reports
'   "Expected identifier" (800A03F2) at a seemingly unrelated line. Keeping the whole
'   file ASCII makes UTF-8 and GBK identical, so this class of bug can never happen.
'   => Do NOT add Chinese comments to this file. Use English, or see the notes in
'      start.bat / this project's docs instead.
'
' 20261004  Startup speed-up.
'   The old version used two fixed blind waits (WScript.Sleep 800 + 3500 = ~4.3s)
'   even though the server is listening in ~0.9s. We now poll the ready-marker file
'   that server.js writes inside its app.listen callback, so the browser opens as
'   soon as the service is actually up (usually ~1.0s). A 12s timeout is the safety net.

' ---- ALL variable declarations must come before the first assignment ----
Dim WshShell, fso, q, nodeExe, baseDir, target, cmd, readyFile
Dim i, portOk, verRoot, curFile, curName, subFld, nodeFile, found
Dim ts, rawCur

baseDir = "D:\stock analyzer\stock-analyzer"
target = baseDir & "\server.js"
readyFile = baseDir & "\data\.server-ready"

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = baseDir
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

' ---- Auto-detect Node (never hardcode the version) ----
'   (1) read versions\current, whose content is the active version dir name
'   (2) scan versions\* and take the first node.exe found
'   (3) fall back to a bare "node" from PATH
'   (4) if none of the above works, show a message box instead of failing silently
verRoot = "C:\Users\16507\.workbuddy\binaries\node\versions"
nodeExe = ""

curFile = verRoot & "\current"
If fso.FileExists(curFile) Then
    On Error Resume Next
    Set ts = fso.OpenTextFile(curFile, 1, False)
    If Err.Number = 0 Then
        rawCur = ts.ReadAll
        ts.Close
        curName = Trim(Replace(Replace(rawCur, vbCr, ""), vbLf, ""))
        If Len(curName) > 0 Then
            nodeFile = verRoot & "\" & curName & "\node.exe"
            If fso.FileExists(nodeFile) Then nodeExe = nodeFile
        End If
    End If
    On Error GoTo 0
End If

If Len(nodeExe) = 0 Then
    On Error Resume Next
    For Each subFld In fso.GetFolder(verRoot).SubFolders
        nodeFile = subFld.Path & "\node.exe"
        If fso.FileExists(nodeFile) Then nodeExe = nodeFile : Exit For
    Next
    On Error GoTo 0
End If

If Len(nodeExe) = 0 Then nodeExe = "node"

found = True
If nodeExe <> "node" Then found = fso.FileExists(nodeExe)
If Not found Then
    MsgBox "Cannot find Node.js, so the Stock Analyzer cannot start." & vbCrLf & vbCrLf & _
           "Checked folder: " & verRoot & vbCrLf & _
           "Please send a screenshot of this message to the developer.", 16, "Stock Analyzer"
    WScript.Quit 1
End If

' Kill any old process still listening on port 3005 (only the listener, not other apps).
' A helper .bat keeps the tricky cmd quoting out of VBScript.
WshShell.Run q & baseDir & "\kill_port_3005.bat" & q, 0, True

' The port is usually released within tens of milliseconds; a short margin is enough.
WScript.Sleep 300

' Remove the previous ready marker so we can only ever observe THIS new instance.
If fso.FileExists(readyFile) Then fso.DeleteFile readyFile, True

' Start a fresh Node service on the fixed port 3005.
' SA_NO_AUTO_OPEN=1 tells server.js NOT to open the browser itself; this launcher does it.
' Without that flag both would open a window, which is why the user used to see two pages.
WshShell.Environment("PROCESS")("PORT") = "3005"
WshShell.Environment("PROCESS")("SA_NO_AUTO_OPEN") = "1"
' SA_NO_BG_AI=1 disables the two background LLM scheduled tasks (event scan + dedicated-factor
' monthly trigger) so the Qwen LLM endpoint is only hit on explicit user action - this stops
' silent Aliyun billing while the app runs unattended. Delete the line below to re-enable.
WshShell.Environment("PROCESS")("SA_NO_BG_AI") = "1"
cmd = q & nodeExe & q & " " & q & target & q
WshShell.Run cmd, 0, False

' Wait until the service is really listening (server.js writes readyFile in app.listen).
portOk = False
For i = 0 To 120
    If fso.FileExists(readyFile) Then portOk = True : Exit For
    WScript.Sleep 100
Next
' Safety net: open the browser anyway if the marker never showed up (never hang).
If Not portOk Then WScript.Sleep 500
' Use paired quotes. The old """" literal is parsed as TWO empty strings, so "start"
' would swallow the first argument as a window title and the page would never open.
WshShell.Run "cmd /c start " & q & q & " " & q & "http://localhost:3005" & q, 0, False
