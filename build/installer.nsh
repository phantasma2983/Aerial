!define LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\17c6ea6b-270a-5297-8e23-9bcda4a29a48"
!define APPID_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\7d047ff4-f1b4-58c5-a9ab-6eaec19eeed0"

!macro customInit
  ClearErrors
  ReadRegStr $R0 HKCU "${APPID_UNINSTALL_KEY}" "UninstallString"
  ${if} $R0 != ""
    WriteRegStr HKCU "${LEGACY_UNINSTALL_KEY}" "UninstallString" $R0

    ReadRegStr $R1 HKCU "${APPID_UNINSTALL_KEY}" "QuietUninstallString"
    ${if} $R1 != ""
      WriteRegStr HKCU "${LEGACY_UNINSTALL_KEY}" "QuietUninstallString" $R1
    ${endif}

    DeleteRegKey HKCU "${APPID_UNINSTALL_KEY}"
  ${endif}
!macroend
