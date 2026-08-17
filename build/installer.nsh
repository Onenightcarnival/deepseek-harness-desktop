# Custom close-app logic for the NSIS installer/uninstaller.
#
# Two failure modes the stock CHECK_APP_RUNNING misses:
# 1. It kills by process NAME only, so helper processes living in $INSTDIR
#    (node-pty's conpty OpenConsole.exe / winpty-agent.exe spawned by the
#    bundled dsh server) survive and keep files locked.
# 2. Its whole cleanup runs ONLY when the app exe is currently running.
#    Orphaned helpers can outlive the app (crash, or conpty agents left
#    behind after quit) — the user closes the app, the check finds nothing,
#    nothing gets swept, and extraction / old-file deletion later fails
#    with the same misleading "app cannot be closed" dialog
#    (extractAppPackage.nsh and installUtil.nsh reuse that string).
#
# So: the INSTDIR path sweep runs UNCONDITIONALLY, and killing is done in
# several redundant passes (tree kill, plain image kill, path sweep).

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
  # whole kill when any descendant is gone/unkillable mid-walk, and a
  # malformed PID filter would silently kill nothing. The CLI shims also
  # run this same image standalone (dsh/pnpm/node on the app exe) with no
  # tree link to the app.
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  # Path sweep: anything still executing out of the install dir — conpty
  # agents and other helpers, including ORPHANS from sessions whose app is
  # long gone. This pass is why the macro must run even when the app exe
  # itself is not running.
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
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

  # Always at least one full sweep, app running or not (see header).
  !insertmacro customKillPasses
  Sleep 500

  # If the app exe itself is (still) alive, keep at it with retries.
  StrCpy $R1 0
  customKillLoop:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      IntOp $R1 $R1 + 1
      ${if} $R1 > 8
        # Diagnostics before giving up: dump what still lives in $INSTDIR
        # to the desktop, so "cannot be closed" reports become actionable.
        ${if} $IsPowerShellAvailable == 0
          nsExec::Exec `"$PowerShellPath" -C "Get-Date | Out-File -Encoding utf8 -Append '$DESKTOP\dsh-install-debug.txt'; Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | Select-Object ProcessId,Name,Path | Format-List | Out-File -Encoding utf8 -Append '$DESKTOP\dsh-install-debug.txt'"`
          Pop $0
        ${endIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY customKillLoop
        Quit
      ${endIf}
      !insertmacro customKillPasses
      Sleep 1500
      Goto customKillLoop
    ${endIf}
!macroend
