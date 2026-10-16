; 覆盖 electron-builder 默认的“程序正在运行”弹窗检查：
; 检测到 Baoluo.exe 运行时自动关闭，不要求用户手动操作。
!macro customCheckAppRunning
  nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  StrCmp $R0 "0" app_found app_not_running

  app_found:
    DetailPrint "正在自动关闭已运行的 ${PRODUCT_NAME}..."
    ; 先请求正常退出，给程序一点保存状态的时间
    nsProcess::_CloseProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Sleep 1200

    StrCpy $R1 "0"
    kill_loop:
      nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
      Pop $R0
      StrCmp $R0 "0" still_running app_not_running

      still_running:
        IntOp $R1 $R1 + 1
        nsProcess::_KillProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
        Sleep 600
        ${If} $R1 > 5
          nsExec::Exec `%SYSTEMROOT%\System32\taskkill.exe /f /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
          Sleep 600
        ${EndIf}
        ${If} $R1 > 10
          ; 实在无法结束（例如以更高权限运行）时不再无限循环，
          ; 让安装流程自行处理文件占用，而不是卡死安装器。
          Goto app_not_running
        ${EndIf}
        Goto kill_loop

  app_not_running:
    nsProcess::_Unload
!macroend

; 卸载向导第一页加一个勾选框：要不要把应用数据（模型、运行时、设置，约 4GB，
; 在 %APPDATA%\Baoluo 下）一起清掉。默认不勾，勾了才删。
!include "nsDialogs.nsh"
; 读指针文件（自定义数据目录路径）时要用到 TrimNewLines
!include "TextFunc.nsh"

!macro customUnWelcomePage
  ; 只在这个宏里声明：安装器那一遍不会展开本宏，声明在外面会触发"变量未使用"警告
  ; （electron-builder 把警告当错误）
  Var /GLOBAL boloDeleteAppData
  Var /GLOBAL boloAppDataCheckbox

  UninstPage custom un.boloAppDataPageCreate un.boloAppDataPageLeave

  Function un.boloAppDataPageCreate
    !insertmacro MUI_HEADER_TEXT "卸载 宝螺" "确认后点「卸载」开始"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 20u "程序文件会被删除；下面的数据默认保留，重装后可继续使用。"
    Pop $0
    ${NSD_CreateCheckbox} 0 26u 100% 12u "同时清除应用数据"
    Pop $boloAppDataCheckbox
    nsDialogs::Show
  FunctionEnd

  Function un.boloAppDataPageLeave
    ${NSD_GetState} $boloAppDataCheckbox $boloDeleteAppData
  FunctionEnd
!macroend

!macro customUnInstall
  ; 更新安装时 uninstaller 也会跑一遍，这时候不能删数据
  ${if} ${isUpdated}
    Goto boloSkipAppData
  ${endIf}

  ${If} ${Silent}
    ; 静默卸载：只有显式带 --delete-app-data 才删
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${If} ${Errors}
      Goto boloSkipAppData
    ${EndIf}
  ${Else}
    ${If} $boloDeleteAppData != 1
      Goto boloSkipAppData
    ${EndIf}
  ${EndIf}

  DetailPrint "正在清除应用数据…"

  ; 与 electron-builder 自带逻辑一致：全机器安装时切到"当前用户"上下文再删
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}

  RMDir /r "$APPDATA\Baoluo"
  ; 改 productName 之前留下的历史目录
  RMDir /r "$APPDATA\宝螺"
  RMDir /r "$LOCALAPPDATA\baoluo-updater"
  RMDir /r "$LOCALAPPDATA\Baoluo"
  ; 默认数据目录（模型/运行时）现在在 C:\Baoluo\data
  RMDir /r "$PROFILE\Baoluo\data"

  ; 用户可能把数据目录改到了别的盘（设置 → 通用设置 → 数据目录），
  ; 指针文件里记着路径，这里一并清掉，避免卸载后残留几 GB。
  ClearErrors
  FileOpen $R2 "$APPDATA\Baoluo\data-root.txt" r
  ${IfNot} ${Errors}
    FileRead $R2 $R3
    FileClose $R2
    ${TrimNewLines} "$R3" $R3
    ${If} $R3 != ""
      DetailPrint "正在清除自定义数据目录：$R3"
      RMDir /r "$R3"
    ${EndIf}
  ${EndIf}

  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}

  boloSkipAppData:
!macroend
