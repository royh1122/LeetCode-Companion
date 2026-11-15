' LeetCode Companion - start the dashboard invisibly (no window, no taskbar entry).
' Runs "npm run up -- --background" hidden; the dashboard opens in your browser when ready.
' On failure, shows a message pointing at the log files.
Option Explicit
Dim sh, fso, root, dataDir, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
sh.CurrentDirectory = root
' Same folder as the server uses: LCC_DATA_DIR if set (relative to the project), else data.
dataDir = sh.ExpandEnvironmentStrings("%LCC_DATA_DIR%")
If dataDir = "%LCC_DATA_DIR%" Or dataDir = "" Then dataDir = root & "\data" Else dataDir = fso.GetAbsolutePathName(dataDir)
If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
code = sh.Run("cmd /c npm run up -- --background > """ & dataDir & "\launcher.log"" 2>&1", 0, True)
If code <> 0 Then
  MsgBox "LeetCode Companion could not start." & vbCrLf & vbCrLf & _
    "Details are in:" & vbCrLf & dataDir & "\launcher.log" & vbCrLf & dataDir & "\server.log", _
    vbExclamation, "LeetCode Companion"
End If
