' LeetCode Companion - stop the background dashboard.
Option Explicit
Dim sh, fso, root, dataDir, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
sh.CurrentDirectory = root
' Same folder as start.vbs. Stop writes its own log, so a failed start's launcher.log survives.
dataDir = sh.ExpandEnvironmentStrings("%LCC_DATA_DIR%")
If dataDir = "%LCC_DATA_DIR%" Or dataDir = "" Then dataDir = root & "\data" Else dataDir = fso.GetAbsolutePathName(dataDir)
If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
code = sh.Run("cmd /c npm run down > """ & dataDir & "\launcher-stop.log"" 2>&1", 0, True)
If code = 0 Then
  sh.Popup "LeetCode Companion is stopped.", 3, "LeetCode Companion", 64
Else
  MsgBox "Could not stop LeetCode Companion." & vbCrLf & vbCrLf & "Details: " & dataDir & "\launcher-stop.log", vbExclamation, "LeetCode Companion"
End If
