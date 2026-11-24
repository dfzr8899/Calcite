import {t as tr} from "../shared/i18n/index.mjs";
export function pathMenu(copy) {
  return {
    id:'path', label:tr("documentMenu.copyPath"),
    items:[['relative',tr("documentMenu.copyRelativePath")],['absolute',tr("documentMenu.copyAbsolutePath")],['wiki',tr("documentMenu.copyWikiLink")]]
      .map(([type,label])=>({id:type+'Path',label,run:()=>copy(type)}))
  };
}

export function documentMenu({run,label,keycaps,enabled,copy}) {
  const command = (id,text,danger=false) => ({
    id,label:text||label(id),key:keycaps(id),disabled:!enabled(id),danger,run:()=>run(id)
  });
  const submenu = (id,label,items) => ({id,label,items:items.map(entry=>command(...entry))});
  const path = pathMenu(copy);
  path.items.forEach(item=>{item.disabled=!enabled('relativePath');});
  path.items.push(command('moveNote',tr("documentMenu.moveToFolder")));
  return [
    {label:tr("documentMenu.saveRename"),items:[command('save'),command('saveAs'),command('renameNote',tr("documentMenu.rename"))]},
    {label:tr("documentMenu.editNote"),items:[command('properties'),command('template'),
      submenu('format',tr("documentMenu.formattingContents"),[
        ['formatTable',tr("documentMenu.formatThisTable")],['formatTables',tr("documentMenu.formatAllTables")],['toc'],
        ['numberHeadings',tr("documentMenu.addOrUpdateSectionNumbers")],['clearHeadings'],['linkReferences']
      ])]},
    {label:tr("documentMenu.exportPaths"),items:[submenu('export',tr("documentMenu.export"),[
      ['exportCenter'],['pdf'],['html'],['png',tr("documentMenu.exportLongImage")],['copyRich',tr("documentMenu.copyAsRichText")],
      ['portableMarkdown'],['docx',tr("documentMenu.exportWord")],['epub',tr("documentMenu.exportEpub")]
    ]),path]},
    {label:tr("documentMenu.historyReading"),items:[command('history'),command('reveal'),submenu('focus',tr("documentMenu.focusView"),[
      ['typewriter',tr("documentMenu.typewriterMode")],['paragraph',tr("documentMenu.paragraphFocus")],['daily']
    ])]},
    {label:tr("documentMenu.dangerZone"),items:[command('trashNote',tr("documentMenu.deleteFile"),true)]}
  ];
}
