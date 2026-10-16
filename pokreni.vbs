' Finansije - pokretac.
' Pokrece lokalni server bez konzole i otvara aplikaciju u svom prozoru.
' Ako server vec radi, samo otvara novi prozor.

Option Explicit

Dim sh, fso, base, nodeExe, candidates, i
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)

candidates = Array( _
  sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\nodejs\node.exe", _
  "C:\Program Files\nodejs\node.exe", _
  "C:\Program Files (x86)\nodejs\node.exe" _
)

nodeExe = ""
For i = 0 To UBound(candidates)
  If nodeExe = "" And fso.FileExists(candidates(i)) Then nodeExe = candidates(i)
Next
If nodeExe = "" Then nodeExe = "node"   ' oslonac na PATH

sh.CurrentDirectory = base
sh.Run """" & nodeExe & """ """ & base & "\server.js"" --open", 0, False
