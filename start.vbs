Option Explicit
' Stock Analyzer - hidden launcher (no console window / no flash-exit)
' Called from desktop .lnk; runs latest code from D drive.
' IMPORTANT: always kill the old service on port 3005 first so the user sees the latest code.
'
' 20261005 修复：上一版把 Dim 写在注释块之后，而 VBScript 逐行执行，
'   导致第 1 行赋值 baseDir 时 Dim 尚未执行 -> 报「变量未定义: 'baseDir'」(800A01F4)，
'   双击图标只弹错误框、服务根本起不来。现将所有 Dim 提到脚本最前面（紧跟 Option Explicit），
'   再往下才是注释与逻辑，彻底规避「注释把 Dim 和赋值隔开」这一类坑。
'
' 20261004 启动提速：原先把「等旧进程释放端口」和「等服务就绪」都写成固定盲等
'   （WScript.Sleep 800 + 3500，合计约 4.3 秒纯等待），而实测服务端约 0.9 秒就已监听，
'   浏览器却要等满 4.3 秒才开——用户感知的「启动慢」几乎全是这两处死等。
' 现改为：① 杀进程后只等 300ms（端口几十毫秒即释放）；
'        ② 清掉上一轮就绪标记，再轮询 server.js 在监听成功时写出的 data\.server-ready，
'           一出现就立刻开浏览器（通常 ~1.0 秒）；最多轮询 12 秒兜底，超时也照常开窗。
'        标记文件为纯文件系统判断，不依赖 HTTP/网络，绕开本机 HTTP_PROXY 对探测的干扰。

' 20261005b 修复「双击图标无反应」：上一版把 Node 路径写死成
'   C:\Users\16507\.workbuddy\binaries\node\versions\22.22.2\node.exe
'   但实际目录名带后缀（22.22.2-3，managed 运行时会有 -N 后缀）→ FileExists 为假
'   → 回退成裸 "node"（PATH 上没有）→ WshShell.Run 隐藏窗口静默失败 → 双击毫无反应。
'   现改为「自动定位」：① 读 versions\current 指向；② 逐个扫 versions\* 找 node.exe；
'   ③ 再试 PATH 上的 node；④ 全失败则弹框明确报错（不再静默）。这样以后 Node 升级也不会失效。

' ---- 所有变量声明必须置于首次赋值之前（Option Explicit 强制）----
Dim WshShell, fso, q, nodeExe, baseDir, target, cmd, readyFile
Dim i, portOk, verRoot, curFile, curName, vdir, sub, nodeFile, found
Dim ts, rawCur

baseDir = "D:\stock analyzer\stock-analyzer"
target  = baseDir & "\server.js"
readyFile = baseDir & "\data\.server-ready"

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = baseDir
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)

' ---- 自动定位 Node 可执行文件（不写死版本号，防 WorkBuddy 升级后失效）----
verRoot = "C:\Users\16507\.workbuddy\binaries\node\versions"
nodeExe = ""

' ① 优先读 versions\current（内容即当前版本目录名，如 22.22.2-3）
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

' ② 扫 versions\* 子目录，取第一个存在的 node.exe（不依赖版本号写法）
If Len(nodeExe) = 0 Then
    On Error Resume Next
    For Each sub In fso.GetFolder(verRoot).SubFolders
        nodeFile = sub.Path & "\node.exe"
        If fso.FileExists(nodeFile) Then nodeExe = nodeFile : Exit For
    Next
    On Error GoTo 0
End If

' ③ 回退到 PATH 上的 node（裸名，交给 cmd 解析）
If Len(nodeExe) = 0 Then nodeExe = "node"

' ④ 兜底：找不到任何 node 时明确报错（替代此前的静默失败——用户只看到「双击没反应」）
found = True
If nodeExe <> "node" Then found = fso.FileExists(nodeExe)
If Not found Then
    MsgBox "找不到 Node.js，无法启动股票分析工作台。" & vbCrLf & vbCrLf & _
           "已检查目录：" & verRoot & vbCrLf & _
           "请把此提示截图发给开发者。", 16, "Stock Analyzer 启动失败"
    WScript.Quit 1
End If

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
portOk = False
For i = 0 To 120
    If fso.FileExists(readyFile) Then portOk = True : Exit For
    WScript.Sleep 100
Next
' 兜底：标记始终没出现也照常开窗（不会卡死不响应）
If Not portOk Then WScript.Sleep 500
' 用 Chr(34) 拼出成对引号；此前的 """" 会被解析成两个空串，start 把空参数当窗口标题吃掉而开不出页面。
WshShell.Run "cmd /c start " & q & q & " " & q & "http://localhost:3005" & q, 0, False
