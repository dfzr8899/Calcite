import {t as tr} from "../shared/i18n/index.mjs";
import {showDialog} from './mobile-ui.js';

export function createWorkspaceUI({platform,$,escape,base,active,getRoot,getTabs,getTree,setTree,refresh,openFile,flush,withLocked,toast,fail,settings,notifyActivity}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'feature-dialog';
  document.body.append(dialog);
  let dragged;
  const parent = value => value.replace(/[\\/][^\\/]+$/,'') || value;
  const separator = root => root.includes('\\') ? '\\' : '/';
  const join = (folder, name) => folder.replace(/[\\/]$/,'') + separator(folder) + name;
  const normalized=value=>value.replace(/\\/g,'/').replace(/\/$/,'');
  const canonical=value=>value===undefined||value===null?value:
    platform.os==='win32'?normalized(value).toLowerCase():normalized(value);
  const descendant = (folder, child) => {
    if (!child) return false;
    return canonical(child) === canonical(folder) || canonical(child).startsWith(canonical(folder)+'/');
  };

  function ask(title, fields, button=tr("canvasView.ok"), detail='') {
    if (dialog.open) dialog.close();
    dialog.innerHTML = '<form method="dialog"><h2>'+escape(title)+'</h2>'+
      (detail ? '<p>'+escape(detail)+'</p>' : '')+fields+
      `<div class="feature-buttons"><button value="cancel" formnovalidate>${tr("workspaceUi.cancel")}</button><button class="primary" value="ok">`+escape(button)+'</button></div></form>';
    dialog.returnValue = '';
    showDialog(dialog);
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? new FormData(dialog.querySelector('form')) : null), {once:true});
    });
  }

  async function apply(edit) {
    await withLocked(async () => {
      flush();
      const tabs = getTabs();
      const paths = tabs.filter(tab => tab.path && descendant(edit.path || '',tab.path));
      const drafts = tabs.filter(tab => tab.path).map(({path,text,saved,mtime}) => ({path,text,saved,mtime}));
      const result = await platform.workspace.edit({...edit,drafts});
      const changes = new Map(result.changes?.map(change => [canonical(change.from),change]));
      for (const tab of tabs) {
        const change = changes.get(canonical(tab.path));
        if (change) {
          if (change.path!==tab.path) delete tab.liveState;
          Object.assign(tab,{path:change.path,name:base(change.path),saved:change.saved,text:change.draft??change.saved,
            mtime:change.mtime,snapshot:change.snapshot,needsLf:change.needsLf});
          tab.dirty = tab.text !== tab.saved;
        }
      }
      if (result.path&&['rename','move'].includes(edit.type)) {
        for (const tab of paths) {
          if (!/\.canvas$/i.test(tab.path)) continue;
          tab.path=result.path+tab.path.slice(edit.path.length);
          tab.name=base(tab.path);
        }
      }
      if (edit.type === 'trash') {
        for (const tab of paths) {
          if (tab.dirty) Object.assign(tab,{path:null,mtime:null});
          else tabs.splice(tabs.indexOf(tab),1);
        }
      }
      setTree(result.tree,edit,result);
      if (edit.type === 'note') await openFile(result.path);
      else await refresh();
      if (edit.type === 'folder') toast(tr("workspaceUi.createdFolder",{arg1:base(result.path)}));
      if(result.activity)notifyActivity(result.activity);
      else if (edit.type === 'rename' || edit.type === 'move') {
        const {notes=0,references=0}=result.refactor||{};
        toast(references?tr("workspaceUi.updatedLinksInNotes",{arg1:notes,arg2:references}):tr("workspaceUi.fileLocationUpdated"));
      }
    });
  }

  async function menuAction(type, target, folder) {
    if(type==='move'){
      const root=getRoot();
      const directories=(rows,prefix='')=>rows.flatMap(row=>row.children?[{path:row.path,label:prefix+row.name},
        ...directories(row.children,prefix+row.name+'/')]:[]);
      const options=[{path:root,label:tr("workspaceUi.vaultRoot")},...directories(getTree())]
        .filter(row=>canonical(row.path)!==canonical(parent(target))&&!descendant(target,row.path));
      if(!options.length)return toast(tr("workspaceUi.noOtherFolderIsAvailable"));
      const form=await ask(tr("workspaceUi.moveToFolder"),`<label>${tr("workspaceUi.destinationFolder")}<select name="parent" required>`+
        options.map(row=>'<option value="'+escape(row.path)+'">'+escape(row.label)+'</option>').join('')+'</select></label>',tr("workspaceUi.move"));
      if(form)await apply({type:'move',path:target,parent:form.get('parent')});
      return;
    }
    if (type === 'trash') {
      const destination=tr('activity.trashTitle');
      const form = await ask(tr("workspaceUi.moveTo")+destination,'', tr("attachments.moveToTrash"),tr("workspaceUi.move2")+base(target)+tr("workspaceUi.to")+destination+tr("workspaceUi.unsavedEditsInOpenNotesWillBe"));
      if (form) await apply({type,path:target});
      return;
    }
    const title = type === 'rename' ? tr("documentMenu.rename") : type === 'note' ? tr("workspaceUi.newMarkdownNote") : tr("main.newFolder");
    const value = type === 'rename' ? base(target) : '';
    const form = await ask(title,`<label>${tr("canvasView.name")}<input name="name" required value="`+escape(value)+'" autofocus></label>');
    if (!form) return;
    await apply({type,path:target,parent:folder?target:parent(target),name:String(form.get('name'))});
    return true;
  }

  $('#new-folder').addEventListener('click', () => {
    const root = getRoot();
    if (root) menuAction('folder', root, true).catch(fail);
  });

  function dropTarget(event) {
    const row = event.target.closest('[data-folder],.tree-root');
    return row?.dataset.folder || (row ? getRoot() : '');
  }
  const sidebar = $('#side-content');
  sidebar.addEventListener('dragstart',event => {
    const row = event.target.closest('[draggable=true][data-file],[draggable=true][data-folder]');
    if (!row) return;
    dragged = row.dataset.file || row.dataset.folder;
    event.dataTransfer.setData('application/x-calcite-entry',dragged);
    event.dataTransfer.effectAllowed = 'move';
  });
  const clearDrop = () => sidebar.querySelectorAll('.drop-target').forEach(row => row.classList.remove('drop-target'));
  sidebar.addEventListener('dragover',event => {
    const target = dropTarget(event);
    if (!dragged || !target || descendant(dragged,target) || parent(dragged)===target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDrop();
    event.target.closest('[data-folder],.tree-root').classList.add('drop-target');
  });
  sidebar.addEventListener('dragleave',event => {
    const row = event.target.closest('[data-folder],.tree-root');
    if (row && !row.contains(event.relatedTarget)) row.classList.remove('drop-target');
  });
  sidebar.addEventListener('dragend',()=>{dragged=null;clearDrop();});
  sidebar.addEventListener('drop',event => {
    const target = dropTarget(event);
    clearDrop();
    if (!dragged || !target || descendant(dragged,target)) return;
    event.preventDefault();
    const path = dragged;
    dragged = null;
    apply({type:'move',path,parent:target}).catch(fail);
  });

  async function createMissing(destination,source=active()?.path) {
    const root = getRoot();
    if (!root) throw Error(tr("workspaceUi.openAWorkspaceFolderBeforeCreatingA"));
    const raw = destination.split('#')[0].trim();
    if (!raw) return;
    const explicit = /[\\/]/.test(raw);
    const fromRoot = /^[\\/]/.test(raw)||explicit&&!/^\.\.?[\\/]/.test(raw);
    const relative = decodeURIComponent(raw).replace(/\\/g,'/').replace(/^\//,'');
    const pieces = relative.split('/');
    const name = pieces.pop();
    const preference = settings().newNoteDirectory;
    const directory = fromRoot ? root : explicit ? (source?parent(source):root) : preference ? join(root,preference) : source&&descendant(root,source)?parent(source):root;
    const folder = pieces.length ? join(directory,pieces.join('/')) : directory;
    await apply({type:'note',parent:folder,name,createParents:true,openExisting:true});
  }
  return {ask,createMissing,menuAction};
}

