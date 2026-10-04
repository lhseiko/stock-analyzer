Option Explicit
' Stock Analyzer - hidden launcher (no console window / no flash-exit)
' Called from desktop .lnk; runs latest code from D drive.
' IMPORTANT: always kill the old service on port 3005 first so the user sees the latest code.
'
' 20261004 启动提速：原先把「等旧进程释放端口」和「等服务就绪」都写成固定盲等
'   （WScript.Sleep 800 + 3500，合计约 4.3 秒纯等待），而实测服务端约 0.9 秒就已监听，
'   浏览器却要等满 4.3 秒才开——用户感知的「启动慢」几乎全是这两处死等。
' 现改为：① 杀进程后只等 300ms（端口几十毫秒即释放）；
'        ② 清掉上一轮就绪标记，再轮询 server.js 在监听成功时写出的 data\.server-ready，
'           一出现就立刻开浏览器（通常 ~1.0 秒）；最多轮询 12 秒兜底，超时也照常开窗。
'        标记文件为纯文件系统判断，不依赖 HTTP/网络，绕开本机 HTTP_PROXY 对探测的干扰。
Dim WshShell, fso, q, nodeExe, baseDir, target, cmd, readyFile
baseDir = "D:\stock analyzer\stock-analyzer"
target  = baseDir & "\server.js"
readyFile = baseDir & "\data\.server-ready"

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

' 杀进程后端口通常几十毫秒即释放，无需盲等 800ms（保守留余量）
WScript.Sleep 300

' 清掉上一轮的就绪标记，确保下面轮询到的必定是本次新起的服务实例
If fso.FileExists(readyFile) Then fso.DeleteFile readyFile, True

' Start a fresh Node service on fixed port 3005
' SA_NO_AUTO_OPEN=1 tells server.js NOT to open the browser itself.
' This launcher opens it below. Without this flag BOTH would open a window,
' which is why the user saw two identical web pages on every double click.
WshShell.Environment("PROCESS")("PORT") = "3005"
WshShell.Environment("PROCESS")("SA_NO_AUTO_OPEN") = "1"
' SA_NO_BG_AI=1 disables the two background LLM scheduled tasks (event scan + dedicated-factor
' monthly trigger) so the Qwen LLM endpoint is only hit on explicit user action — stops silent
' Aliyun billing when the app runs unattended. To re-enable background AI, delete the line below.
WshShell.Environment("PROCESS")("SA_NO_BG_AI") = "1"
cmd = q & nodeExe & q & " " & q & target & q
WshShell.Run cmd, 0, False

' 等服务真正监听成功（server.js 在 app.listen 回调里写入 readyFile），出现即开浏览器。
' 原盲等 3500ms → 现在通常 ~1.0 秒开浏览器，去掉约 2.5 秒纯等待。
Dim i, portOk
portOk = False
For i = 0 To 120
    If fso.FileExists(readyFile) Then portOk = True : Exit For
    WScript.Sleep 100
Next
' 兜底：标记始终没出现也照常开窗（不会卡死不响应）
If Not portOk Then WScript.Sleep 500
WshShell.Run "cmd /c start """" ""http://localhost:3005""", 0, False
