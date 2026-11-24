import {normalizeLineEndings} from '../shared/text-files.mjs';

export const tabSnapshot=({id,path,name,text,saved,mtime,snapshot,pinned,viewMode,scrollByMode,deleted,holdAutoSave})=>
  ({id,path,name,text,saved,mtime,snapshot,pinned,viewMode,scrollByMode,deleted,holdAutoSave});

export function restoreWorkspaceSession(session,allowEmpty=false) {
  if (!Array.isArray(session?.tabs)||!allowEmpty&&!session.tabs.length) return null;
  const tabs=session.tabs.map(tab=>{
    const file=tab.path||tab.name||'笔记.md';
    const text=normalizeLineEndings(file,tab.text),saved=normalizeLineEndings(file,tab.saved);
    return {...tab,text,saved,needsLf:saved!==tab.saved||tab.needsLf,dirty:text!==saved};
  });
  return {
    tabs,activeId:tabs.some(tab=>tab.id===session.activeId)?session.activeId:tabs[0]?.id||'',
    mode:session.mode||'live',autoSave:session.autoSave!==false,treeSort:session.treeSort||'name',
    treeDescending:!!session.treeDescending,closedFiles:session.closedFiles||[],workspaces:session.workspaces||{},
    sidebarHidden:!!session.sidebarHidden,outlineHidden:!!session.outlineHidden
  };
}

