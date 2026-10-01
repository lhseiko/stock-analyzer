Option Explicit
' Agent restart launcher (20261001a): silent server start WITHOUT opening a browser.
' Used by TRAE agent via WMI Win32_Process.Create so the server outlives the toolhost command.
' Env parity with start.vbs: PORT=3005 / SA_NO_AUTO_OPEN=1 (no browser) / SA_NO_BG_AI=1 (billing guard).
Dim WshShell, q
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\stock analyzer\stock-analyzer"
q = Chr(34)
WshShell.Environment("PROCESS")("PORT") = "3005"
WshShell.Environment("PROCESS")("SA_NO_AUTO_OPEN") = "1"
WshShell.Environment("PROCESS")("SA_NO_BG_AI") = "1"
WshShell.Run q & "D:\nodejs\node.exe" & q & " " & q & "D:\stock analyzer\stock-analyzer\server.js" & q, 0, False
