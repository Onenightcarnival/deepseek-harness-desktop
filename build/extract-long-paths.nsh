# Loaded from customCheckAppRunning after electron-builder defines extraction.
# Preserve its archive layout; extraction and copying both support long paths.
!ifmacrondef extractUsing7za
  !error "electron-builder extraction hook changed: extractUsing7za is missing"
!endif
!macroundef extractUsing7za

!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  # Nsis7z also needs the extended prefix or silently omits deep entries.
  SetOutPath "\\?\$PLUGINSDIR\7z-out"
  Nsis7z::Extract "${FILE}"
  Pop $R0
  SetOutPath $R0

  !insertmacro customDetail "正在复制程序文件…" "Copying application files..."
  dshCopyRetry:
    # Robocopy supports long paths. Exit codes 0-7 are successful outcomes;
    # /E copies the payload without deleting unrelated destination files.
    nsExec::Exec `"$SYSDIR\robocopy.exe" "$PLUGINSDIR\7z-out" "$OUTDIR" /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NP /NFL /NDL /UNILOG:"$TEMP\dsh-install-copy.log"`
    Pop $0
    ${If} $0 == "error"
    ${OrIf} $0 == "timeout"
      StrCpy $0 16
    ${EndIf}
    ${If} $0 >= 8
      DetailPrint "File copy failed (code $0). Log: $TEMP\dsh-install-copy.log"
      ${IfNot} ${Silent}
        ${If} $LANGUAGE == 2052
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "程序文件复制失败（错误码 $0）。请检查文件占用或目录权限，然后重试。$\r$\n日志：$TEMP\dsh-install-copy.log" IDRETRY dshCopyRetry
        ${Else}
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Application files could not be copied (code $0). Check file locks and directory permissions, then retry.$\r$\nLog: $TEMP\dsh-install-copy.log" IDRETRY dshCopyRetry
        ${EndIf}
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
!macroend
