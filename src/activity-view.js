import {t as tr,getLocale} from '../shared/i18n/index.mjs';
import {showDialog} from './mobile-ui.js';

export function createActivityView({platform,root,escape,ask,toast,fail,openFile,applyUndo}) {
  let dialog,section='log',displayedRoot;
  const label=entry=>tr('activity.'+entry.type);
  const undoLabel=entry=>tr(entry.type==='trash'?'activity.restore':'activity.undoAction');
  const displayPath=entry=>entry.type==='trash'?entry.from:entry.type==='restore'?entry.to:
    [entry.from,entry.to].filter(Boolean).join(' → ');
  const button=(entry,kind)=>'<button type="button" data-'+kind+'="'+escape(entry.id)+'">'+escape(undoLabel(entry))+'</button>';
  const markdown=/\.(?:md|markdown|mdown|canvas)$/i;
  function absolute(path){
    const dir=displayedRoot;
    return dir.includes('\\')?dir.replace(/\\$/,'')+'\\'+path.replaceAll('/','\\'):
      dir.replace(/\/$/,'')+'/'+path;
  }
  function renderItem(entry) {
    const files=entry.files.map(row=>{
      const link=row.path&&markdown.test(row.path)&&!row.path.startsWith('.calcite/');
      const location=[row.from,row.path===row.from?null:row.path].filter(Boolean).join(' → ');
      const detail=row.count===null?tr('activity.countUnknown'):tr('activity.replacements',{count:row.count});
      return '<li>'+(link?'<button data-open="'+escape(row.path)+'">'+escape(location)+'</button>':escape(location))+
        '<small>'+escape(detail)+'</small></li>';
    }).join('');
    const rewritten=entry.files.filter(row=>row.written).length;
    return '<details class="lg-group activity-entry" data-id="'+escape(entry.id)+'"><summary>'+
      '<strong>'+escape(label(entry))+'</strong><time>'+escape(new Date(entry.time).toLocaleString(getLocale()))+'</time>'+
      '<span>'+escape(displayPath(entry))+'</span></summary><div class="activity-entry-body"><p>'+
      escape(tr('activity.summary',{files:entry.files.length,count:rewritten,replacements:entry.files.reduce((sum,row)=>sum+(row.count||0),0)}))+
      '</p><p>'+escape(tr('activity.skipped'))+'</p>'+
      (entry.rolledBack?'<p>'+escape(tr('activity.recoveryRollback'))+'</p>':'')+
      '<ul>'+files+'</ul>'+
      (entry.undoable?button(entry,'undo'):'<small>'+escape(tr('activity.undoUnavailable'))+'</small>')+'</div></details>';
  }
  async function render(focusId) {
    const current=dialog;
    const path=root();
    const result=await platform.activity.list();
    if(current!==dialog||path!==root())return;
    displayedRoot=path;
    const rows=section==='trash'?result.trash:result.entries;
    current.querySelector('[data-activity-list]').innerHTML=rows.length?rows.map(renderItem).join(''):
      '<p>'+escape(tr(section==='trash'?'activity.trashEmpty':'activity.logEmpty'))+'</p>';
    current.querySelector('[data-empty]').hidden=section!=='trash'||!rows.length;
    for(const control of current.querySelectorAll('[data-section]'))
      control.setAttribute('aria-pressed',String(control.dataset.section===section));
    if(focusId){
      const item=current.querySelector('[data-id="'+CSS.escape(focusId)+'"]');
      if(item){item.open=true;item.scrollIntoView({block:'nearest'});}
    }
  }
  async function undo(entry) {
    const workspace=root();
    if(!workspace)return;
    let result=await applyUndo(entry);
    if(result?.confirmation){
      const {changed,token}=result.confirmation;
      const form=await ask(tr('activity.confirmUndo'),
        '<ul class="activity-confirm-files">'+changed.map(file=>'<li>'+escape(file)+'</li>').join('')+'</ul>',
        tr('activity.backupAndUndo'),tr('activity.undoConflict'));
      if(!form||workspace!==root())return;
      result=await applyUndo(entry,token);
      if(result?.confirmation)throw Error(tr('activity.reviewAgain'));
    }
    if(!result?.activity)return;
    const restored=result.activity.type==='restore';
    toast(tr(restored?'activity.restoredPath':'activity.undone',{path:result.activity.to}));
    if(dialog?.open)await render();
  }
  async function open(view='log',focusId) {
    if(!root()||!platform.activity){toast(tr('main.openAWorkspaceFirst'));return;}
    section=view;
    if(!dialog?.open){
      const node=document.createElement('dialog');
      node.className='feature-dialog activity-view';
      node.setAttribute('aria-label',tr('activity.title'));
      node.innerHTML='<header><h2>'+escape(tr('activity.title'))+'</h2><form method="dialog"><button aria-label="'+
        escape(tr('activity.close'))+'">×</button></form></header><nav>'+
        '<button type="button" data-section="log">'+escape(tr('activity.title'))+'</button>'+
        '<button type="button" data-section="trash">'+escape(tr('activity.trashTitle'))+'</button></nav>'+
        '<div data-activity-list class="activity-list"></div>'+
        '<footer><button type="button" data-empty hidden>'+escape(tr('activity.emptyTrash'))+'</button></footer>';
      dialog=node;
      node.addEventListener('close',()=>{node.remove();if(dialog===node)dialog=null;},{once:true});
      node.onclick=async event=>{
        const control=event.target.closest('button');
        if(!control||!node.contains(control))return;
        try{
          if(control.dataset.section){section=control.dataset.section;await render();}
          if(control.dataset.open&&displayedRoot===root()){node.close();await openFile(absolute(control.dataset.open));}
          if(control.dataset.undo&&displayedRoot===root()){
            const result=await platform.activity.list();
            const entry=[...result.entries,...result.trash].find(row=>row.id===control.dataset.undo);
            if(entry)await undo(entry);
          }
          if(control.hasAttribute('data-empty')){
            const workspace=root();
            const confirmed=await ask(tr('activity.emptyTrash'),'',tr('activity.emptyTrash'),tr('activity.confirmEmpty'));
            if(confirmed&&workspace===root()){
              const count=await platform.activity.empty();
              toast(tr('activity.emptied',{count}));
              await render();
            }
          }
        }catch(error){fail(error);}
      };
      showDialog(node);
    }
    await render(focusId);
  }
  function notify(entry) {
    const workspace=root();
    const count=entry.files.filter(row=>row.written).length;
    const replacements=entry.files.reduce((sum,row)=>sum+(row.count||0),0);
    const actions=[{label:tr('activity.viewLog'),run:()=>open('log',entry.id)}];
    if(entry.undoable)actions.push({label:undoLabel(entry),run:()=>undo(entry)});
    toast(label(entry)+' · '+tr('activity.summary',{files:entry.files.length,count,replacements}),
      actions.map(action=>({...action,run:()=>workspace===root()?action.run():undefined})));
  }
  return {open,notify};
}
