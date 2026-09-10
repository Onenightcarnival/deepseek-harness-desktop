# Custom close-app logic for the NSIS installer/uninstaller.
#
# Constraints (see AGENTS.md pitfalls):
# - electron-builder's FIND_PROCESS is a path-prefix check when PowerShell is
#   available: any process under $INSTDIR counts as found. It false-positives
#   (wine's stub powershell exits 0 for everything; a broad custom install
#   dir can contain unrelated programs) and never gates the install with a
#   dialog/Quit. Known processes are killed, then the install proceeds;
#   locked files surface in the extraction stage, which has its own retry
#   dialog.
# - The stock close logic misses $INSTDIR-hosted helpers (node-pty's conpty
#   OpenConsole.exe / winpty-agent.exe) that can outlive the app. The sweep
#   runs unconditionally, scoped to known binary names; a bare path-prefix
#   sweep can kill unrelated processes under a broad custom $INSTDIR.
# - Uninstallers embedded in old installed builds quit non-zero on any false
#   positive, and the overwrite install then fails with "app cannot be
#   closed" (installUtil.nsh reuses that string for uninstall failures). The
#   old uninstaller is pre-run here; on failure its registry entry and old
#   payload are removed so the template's uninstall step self-skips and
#   extraction proceeds.

# With customCheckAppRunning defined the stock template skips its own
# getProcessInfo include and `Var pid` declaration; both are provided here.
!include "getProcessInfo.nsh"
Var customPid

!macro customKillPasses
  # Tree-kill by image name: the Electron main process, the dsh server
  # child (same image, run-as-node), and all their descendants.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $customPid"`
  Pop $0
  # Second pass without /T or filters: taskkill's tree mode aborts the whole
  # kill when a descendant is gone or unkillable mid-walk. The CLI shims run
  # the same image standalone (dsh/pnpm/node on the app exe) with no tree
  # link to the app.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  # Scoped path sweep: known helper binaries running from the install dir
  # (conpty agents, including orphans whose app has exited).
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -C "$$names = @('OpenConsole.exe','winpty-agent.exe','${APP_EXECUTABLE_FILENAME}'); Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase') -and $$names -contains $$_.Name} | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $0
  ${endIf}
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $customPid $1 $2 $3 $4

  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK customDoSweep
      Quit
    ${endIf}
  ${endIf}

  customDoSweep:
  DetailPrint "$(appClosing)"
  StrCpy $R1 0
  customKillLoop:
    !insertmacro customKillPasses
    Sleep 800
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      IntOp $R1 $R1 + 1
      ${if} $R1 < 4
        Goto customKillLoop
      ${endIf}
      # Still "found" after several rounds: a stuck process (extraction's
      # retry dialog surfaces it) or a FIND_PROCESS false positive. Log for
      # diagnosis and proceed; the install is not blocked here.
      ${if} $IsPowerShellAvailable == 0
        nsExec::Exec `"$PowerShellPath" -C "Get-Date | Out-File -Encoding utf8 -Append '$DESKTOP\dsh-install-debug.txt'; Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | Select-Object ProcessId,Name,Path | Format-List | Out-File -Encoding utf8 -Append '$DESKTOP\dsh-install-debug.txt'"`
        Pop $0
      ${endIf}
      DetailPrint "close check inconclusive - proceeding (see dsh-install-debug.txt on the desktop)"
    ${endIf}

!ifndef BUILD_UNINSTALLER
  # Pre-empt the template's uninstallOldVersion (see header). Runs at the
  # tail of the install-section close check, after the user clicked install,
  # not in customInit: onInit runs before any UI, and a multi-second silent
  # uninstall that kills the running app must not happen at double-click
  # time. Installer context only; the uninstaller must not recurse into
  # itself.
  ReadRegStr $R8 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $R8 != ""
    ReadRegStr $R7 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R7 != ""
    ${andIf} ${FileExists} "$R7\${UNINSTALL_FILENAME}"
      DetailPrint "正在卸载旧版本…"
      InitPluginsDir
      CopyFiles /SILENT "$R7\${UNINSTALL_FILENAME}" "$PLUGINSDIR\pre-old-uninstaller.exe"
      ExecWait '"$PLUGINSDIR\pre-old-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$R7' $R6
      ${if} $R6 != 0
        # Old uninstaller exited non-zero: bypass it. Without registry
        # entries the template's uninstall step self-skips; clearing the
        # payload dirs keeps stale files out of the new install (the same
        # set the uninstaller deletes).
        DetailPrint "旧版卸载器异常退出，绕过并清理旧文件…"
        DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
        DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
        RMDir /r "$R7\resources"
        RMDir /r "$R7\locales"
        Delete "$R7\*.*"
      ${endIf}
    ${endIf}
  ${endIf}
!endif
!macroend
