# Custom close-app logic for the NSIS installer/uninstaller.
#
# Hard-won facts behind this design (details in AGENTS.md pitfalls):
# - electron-builder's FIND_PROCESS is NOT a by-name check when PowerShell
#   is available: it reports "found" if ANY process's path is under
#   $INSTDIR. It false-positives (wine's stub powershell exits 0 for
#   everything; a broad custom install dir can contain unrelated running
#   programs), so it must NEVER gate the install with a dialog/Quit.
#   Kill what we know, then proceed — genuinely locked files surface in
#   the extraction stage, which has its own retry dialog.
# - The default close logic misses $INSTDIR-hosted helpers (node-pty's
#   conpty OpenConsole.exe / winpty-agent.exe) which can outlive the app,
#   so the sweep runs unconditionally — and scoped to KNOWN binary names
#   (a bare path-prefix sweep could kill unrelated processes when
#   $INSTDIR is a broad custom directory).
# - Old installed builds embed uninstallers with the previous, quitting
#   logic: their silent run exits non-zero on any false positive and the
#   overwrite install dies with the misleading "app cannot be closed"
#   (installUtil.nsh reuses that string for uninstall failures).
#   customInit pre-runs the old uninstaller itself and, if it fails,
#   drops its registry entry + old payload so the template's uninstall
#   step is skipped and extraction proceeds on a clean slate.

# When customCheckAppRunning is defined the stock template skips its own
# getProcessInfo include and `Var pid` declaration — provide our own.
!include "getProcessInfo.nsh"
Var customPid

!macro customKillPasses
  # Tree-kill by image name: the Electron main process, the dsh server
  # child (same image, run-as-node), and all their descendants.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $customPid"`
  Pop $0
  # Second pass without /T or filters: taskkill's tree mode aborts the
  # whole kill when any descendant is gone/unkillable mid-walk. The CLI
  # shims also run this same image standalone (dsh/pnpm/node on the app
  # exe) with no tree link to the app.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  # Scoped path sweep: known helper binaries still executing out of the
  # install dir (conpty agents — including orphans whose app is long gone).
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
      # Still "found" after several rounds: a genuinely stuck process
      # (extraction's own retry dialog will surface it) or a FIND_PROCESS
      # false positive. Either way: log for diagnosis and PROCEED —
      # never block the install here.
      ${if} $IsPowerShellAvailable == 0
        nsExec::Exec `"$PowerShellPath" -C "Get-Date | Out-File -Encoding utf8 -Append '$DESKTOP\dsh-install-debug.txt'; Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | Select-Object ProcessId,Name,Path | Format-List | Out-File -Encoding utf8 -Append '$DESKTOP\dsh-install-debug.txt'"`
        Pop $0
      ${endIf}
      DetailPrint "close check inconclusive - proceeding (see dsh-install-debug.txt on the desktop)"
    ${endIf}
!macroend

# Pre-empt the template's uninstallOldVersion (see header). Per-user
# installs only (matches this app's install mode).
!macro customInit
  ReadRegStr $R8 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $R8 != ""
    ReadRegStr $R7 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R7 != ""
    ${andIf} ${FileExists} "$R7\${UNINSTALL_FILENAME}"
      InitPluginsDir
      CopyFiles /SILENT "$R7\${UNINSTALL_FILENAME}" "$PLUGINSDIR\pre-old-uninstaller.exe"
      ExecWait '"$PLUGINSDIR\pre-old-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$R7' $R6
      ${if} $R6 != 0
        # Broken old uninstaller (pre-fix builds quit non-zero on false
        # positives): bypass it. Without registry entries the template's
        # uninstall step self-skips; clearing the payload dirs keeps
        # stale files out of the new install (mirrors what the
        # uninstaller would have deleted).
        DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
        DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
        RMDir /r "$R7\resources"
        RMDir /r "$R7\locales"
        Delete "$R7\*.*"
      ${endIf}
    ${endIf}
  ${endIf}
!macroend
