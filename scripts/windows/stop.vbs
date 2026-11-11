' LeetCode Companion - stop the background dashboard.
Option Explicit
Dim sh, fso, root, dataDir, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
dataDir = root & "\data"
If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
sh.CurrentDirectory = root
code = sh.Run("cmd /c npm run down > """ & dataDir & "\launcher.log"" 2>&1", 0, True)
If code = 0 Then
  sh.Popup "LeetCode Companion is stopped.", 3, "LeetCode Companion", 64
Else
  MsgBox "Could not stop LeetCode Companion." & vbCrLf & vbCrLf & "Details: " & dataDir & "\launcher.log", vbExclamation, "LeetCode Companion"
End If
