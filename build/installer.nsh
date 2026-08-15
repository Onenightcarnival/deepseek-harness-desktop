# Custom close-app logic for the NSIS installer/uninstaller.
#
# The default CHECK_APP_RUNNING kills by process NAME when PowerShell is
# unavailable, which misses helper processes living in $INSTDIR (node-pty's
# conpty OpenConsole.exe / winpty-agent.exe spawned by the bundled dsh
# server). Those keep files locked, the old version's uninstall fails, and
# the user sees "app cannot be closed". This override tree-kills by image
# name (/T catches the dsh server and every descendant) AND sweeps by path
# prefix when PowerShell is available, with retries.

# When customCheckAppRunning is defined the stock template skips its own
# getProcessInfo include and `Var pid` declaration — provide our own.
!include "getProcessInfo.nsh"
Var customPid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $customPid $1 $2 $3 $4

  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK customDoStop
      Quit
    ${endIf}

    customDoStop:
    DetailPrint "$(appClosing)"
    StrCpy $R1 0

    customKillLoop:
      IntOp $R1 $R1 + 1

      # Tree-kill by image name: the Electron main process, the dsh server
      # child (same image, run-as-node), and all their descendants.
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $customPid"`
      Pop $0

      # Path sweep: anything still executing out of the install dir
      # (conpty agents and other helpers not parented to the app).
      ${if} $IsPowerShellAvailable == 0
        nsExec::Exec `"$PowerShellPath" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
        Pop $0
      ${endIf}

      Sleep 1000

      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        ${if} $R1 > 4
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY customKillLoop
          Quit
        ${endIf}
        Goto customKillLoop
      ${endIf}
  ${endIf}
!macroend
