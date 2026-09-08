!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PeonDesktop"
  StrCmp $0 '$"$INSTDIR\peon-desktop.exe$" --background' 0 +2
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PeonDesktop"
!macroend
