' Orpheus 网关启停器
' 通过 wscript.exe 调用（GUI 子系统）：不会创建任何控制台窗口
' 用法：wscript.exe //B //Nologo gateway-launcher.vbs on|off
Option Explicit

Dim sh, root, nodeExe, serverJs, mode, wmi, procs, p, cmdLine
Set sh = CreateObject("WScript.Shell")

root = "C:\Users\m1778\Documents\Codex\2026-10-07\hermes-gpt-agent\outputs\orpheus"
nodeExe = "C:\Program Files\nodejs\node.exe"
serverJs = root & "\src\server.js"

mode = ""
If WScript.Arguments.Count > 0 Then mode = LCase(Trim(WScript.Arguments(0)))

If mode = "off" Then
    ' 用 WMI 精确结束 orpheus 网关进程（不用 PowerShell，避免引号与窗口问题）
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
    For Each p In procs
        cmdLine = LCase(p.CommandLine & "")
        If InStr(cmdLine, "orpheus") > 0 And InStr(cmdLine, "server.js") > 0 Then
            p.Terminate
        End If
    Next
Else
    sh.CurrentDirectory = root
    sh.Run """" & nodeExe & """ """ & serverJs & """", 0, False
End If
