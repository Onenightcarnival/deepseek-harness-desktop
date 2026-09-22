# Close-app logic and progress detail for the NSIS installer/uninstaller.
#
# Close check (customCheckAppRunning):
# - FIND_PROCESS is a path-prefix check when PowerShell is available (any
#   process under $INSTDIR counts) and false-positives. It only drives the
#   "app is running" confirmation; it never blocks the install by itself.
# - The sweep runs unconditionally, scoped to known image names: the app exe
#   (tree kill + plain kill) and the conpty helpers OpenConsole.exe /
#   winpty-agent.exe under $INSTDIR. After a few rounds the install proceeds;
#   locked files surface in the extraction stage, which has its own retry
#   dialog.
# - The previous build's uninstaller is pre-run at the tail of the check; on
#   a non-zero exit its registry keys and payload are removed so the stock
#   uninstall step self-skips.

# With customCheckAppRunning defined the stock template skips its own
# getProcessInfo include and `Var pid` declaration; both are provided here.
!include "getProcessInfo.nsh"
Var customPid

# Progress detail: the stock template hides the details list
# (ShowInstDetails nevershow) and silences DetailPrint (SetDetailsPrint none).
# Both are re-enabled at the start of the install/uninstall section;
# DetailPrint then drives the status line above the progress bar and the list
# below it. MUI InstFiles control ids: 1016 details list, 1027 "Show details"
# button. Silent runs are left alone.
!macro customShowDetails
  ${IfNot} ${Silent}
    SetDetailsPrint both
    FindWindow $R9 "#32770" "" $HWNDPARENT
    GetDlgItem $R8 $R9 1016
    ShowWindow $R8 5
    GetDlgItem $R8 $R9 1027
    ShowWindow $R8 0
  ${endIf}
!macroend

# Phase line in the installer's UI language: Simplified Chinese (2052) or
# English. No LangString: one left undefined for any bundled language is a
# warning, and the build compiles with warnings as errors.
!macro customDetail zh en
  ${If} $LANGUAGE == 2052
    DetailPrint "${zh}"
  ${Else}
    DetailPrint "${en}"
  ${EndIf}
!macroend

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
  !insertmacro customShowDetails
  !insertmacro customDetail "正在检查运行中的实例…" "Checking for running instances..."
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
  !insertmacro customDetail "正在关闭运行中的 ${PRODUCT_NAME}…" "Closing running ${PRODUCT_NAME}..."
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
      !insertmacro customDetail "运行检查无法确定，继续安装（详情见桌面上的 dsh-install-debug.txt）" "Close check inconclusive, proceeding (see dsh-install-debug.txt on the desktop)"
    ${endIf}

!ifndef BUILD_UNINSTALLER
  # Pre-run of the previous build's uninstaller (installer context only),
  # after the user clicked install: onInit runs before any UI.
  ReadRegStr $R8 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $R8 != ""
    ReadRegStr $R7 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R7 != ""
    ${andIf} ${FileExists} "$R7\${UNINSTALL_FILENAME}"
      !insertmacro customDetail "正在卸载旧版本…" "Uninstalling the previous version..."
      InitPluginsDir
      CopyFiles /SILENT "$R7\${UNINSTALL_FILENAME}" "$PLUGINSDIR\pre-old-uninstaller.exe"
      ExecWait '"$PLUGINSDIR\pre-old-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$R7' $R6
      ${if} $R6 != 0
        # Old uninstaller exited non-zero: bypass it. Without registry
        # entries the template's uninstall step self-skips; clearing the
        # payload dirs keeps stale files out of the new install (the same
        # set the uninstaller deletes).
        !insertmacro customDetail "旧版卸载器异常退出，绕过并清理旧文件…" "The previous uninstaller failed; bypassing it and removing old files..."
        DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
        DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
        RMDir /r "$R7\resources"
        RMDir /r "$R7\locales"
        Delete "$R7\*.*"
      ${endIf}
    ${endIf}
  ${endIf}
  # Next in the stock section: the embedded 7z payload is written to the
  # plugins dir, decompressed (Nsis7z drives the progress bar), and copied
  # into $INSTDIR. One phase line covers the three steps.
  !insertmacro customDetail "正在解压程序文件（几百 MB，需要一到两分钟）…" "Extracting program files (a few hundred MB, one to two minutes)..."
!endif
!macroend

!ifndef BUILD_UNINSTALLER
# Runs right after the payload landed in $INSTDIR. The stock section then
# keeps a copy of the installer in LocalAppData (for the updater), writes the
# uninstaller, registry entries and shortcuts.
!macro customFiles_x64
  !insertmacro customDetail "正在保存安装包副本、创建卸载程序和快捷方式…" "Keeping a copy of the installer, creating the uninstaller and shortcuts..."
!macroend

!macro customInstall
  !insertmacro customDetail "安装完成。" "Installation complete."
!macroend
!endif
