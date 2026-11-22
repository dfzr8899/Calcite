!define MARKDOWN_PROGID "Calcite.Markdown"
!define APP_CAPABILITIES "Software\Calcite\Capabilities"
!define OPEN_COMMAND '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'

!macro registerMarkdownExtension EXT
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${MARKDOWN_PROGID}" ""
  WriteRegStr SHCTX "${APP_CAPABILITIES}\FileAssociations" "${EXT}" "${MARKDOWN_PROGID}"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\Calcite.Open" "MUIVerb" "用 Calcite 打开"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\Calcite.Open" "Icon" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\Calcite.Open\command" "" "${OPEN_COMMAND}"
!macroend

!macro unregisterMarkdownExtension EXT
  DeleteRegValue SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${MARKDOWN_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${EXT}"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\Calcite.Open"
  DeleteRegKey /ifempty SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell"
  DeleteRegKey /ifempty SHCTX "Software\Classes\SystemFileAssociations\${EXT}"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\${MARKDOWN_PROGID}" "" "Markdown 文档"
  WriteRegStr SHCTX "Software\Classes\${MARKDOWN_PROGID}\DefaultIcon" "" "$SYSDIR\imageres.dll,-2"
  WriteRegStr SHCTX "Software\Classes\${MARKDOWN_PROGID}\shell\open\command" "" "${OPEN_COMMAND}"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Calcite"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" "${OPEN_COMMAND}"
  WriteRegStr SHCTX "${APP_CAPABILITIES}" "ApplicationName" "Calcite"
  WriteRegStr SHCTX "${APP_CAPABILITIES}" "ApplicationDescription" "打开和编辑本地 Markdown 文档"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Calcite" "${APP_CAPABILITIES}"
  !insertmacro registerMarkdownExtension ".md"
  !insertmacro registerMarkdownExtension ".markdown"
  !insertmacro registerMarkdownExtension ".mdown"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro unregisterMarkdownExtension ".md"
  !insertmacro unregisterMarkdownExtension ".markdown"
  !insertmacro unregisterMarkdownExtension ".mdown"
  DeleteRegKey SHCTX "Software\Classes\${MARKDOWN_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey SHCTX "${APP_CAPABILITIES}"
  DeleteRegKey /ifempty SHCTX "Software\Calcite"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Calcite"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
