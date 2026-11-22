export function pathMenu(copy) {
  return {
    id:'path', label:'复制路径',
    items:[['relative','复制相对路径'],['absolute','复制绝对路径'],['wiki','复制双链']]
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
  path.items.push(command('moveNote','移动到文件夹…'));
  return [
    {label:'保存与命名',items:[command('save'),command('saveAs'),command('renameNote','重命名')]},
    {label:'编辑笔记',items:[command('properties'),command('template'),
      submenu('format','格式化与目录',[
        ['formatTable','格式化当前表格'],['formatTables','格式化全文表格'],['toc'],
        ['numberHeadings','添加或更新章节编号'],['clearHeadings'],['linkReferences']
      ])]},
    {label:'导出与路径',items:[submenu('export','导出',[
      ['exportCenter'],['pdf'],['html'],['png','导出阅读长图'],['copyRich','一键复制为富文本'],
      ['portableMarkdown'],['docx','导出 Word'],['epub','导出 EPUB']
    ]),path]},
    {label:'历史与阅读',items:[command('history'),command('reveal'),submenu('focus','专注视图',[
      ['typewriter','打字机模式'],['paragraph','段落聚焦'],['daily']
    ])]},
    {label:'危险操作',items:[command('trashNote','删除文件',true)]}
  ];
}
