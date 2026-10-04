; Autostart uses the bundle identifier, not the display/product name.
; A Start Menu identity is required by desktop notifications, including when
; NSIS is invoked with the optional shortcut flags disabled.
!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$SMPROGRAMS\Visnia"
  CreateShortcut "$SMPROGRAMS\Visnia\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\Visnia\${PRODUCTNAME}.lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro IsShortcutTarget "$SMPROGRAMS\Visnia\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    Delete "$SMPROGRAMS\Visnia\${PRODUCTNAME}.lnk"
    RMDir "$SMPROGRAMS\Visnia"
  ${EndIf}
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${BUNDLEID}"
  ${EndIf}
!macroend
