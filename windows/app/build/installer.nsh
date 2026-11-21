; При удалении Glazok Studio убираем виртуальные камеры (при обновлении — оставляем: их тут же зарегистрирует новая версия)
!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro GlazokRemoveCam "0"
    !insertmacro GlazokRemoveCam "1"
    !insertmacro GlazokRemoveCam "2"
    !insertmacro GlazokRemoveCam "3"
    !insertmacro GlazokRemoveCam "4"
    Delete "$LOCALAPPDATA\GlazokStudio\GlazokVCam.dll"
    RMDir "$LOCALAPPDATA\GlazokStudio"
  ${endIf}
!macroend

!macro GlazokRemoveCam N
  DeleteRegKey HKCU "Software\Classes\CLSID\{6B3D3F10-9C1E-4D7A-8A54-2F1B0C7E4A0${N}}"
  DeleteRegKey HKCU "Software\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\{6B3D3F10-9C1E-4D7A-8A54-2F1B0C7E4A0${N}}"
!macroend
