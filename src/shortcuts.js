import {t as tr} from "../shared/i18n/index.mjs";
export const defaultShortcuts={
  new:'Mod+N',open:'Mod+O',folder:'Mod+Shift+O',save:'Mod+S',saveAs:'Mod+Shift+S',palette:'Mod+K',find:'Mod+F',
  searchWorkspace:'Mod+Shift+F',sidebar:'Mod+B',focus:'F8',closeTab:'Mod+W',reopen:'Mod+Shift+T',
  nextTab:'Mod+Tab',previousTab:'Mod+Shift+Tab',formatTable:'Mod+Alt+T',tasks:'Alt+C',
  wrapBold:'Mod+Alt+B',wrapItalic:'Mod+Alt+I',wrapCode:'Mod+Alt+E',wrapStrike:'Mod+Alt+D',wrapMath:'Mod+Alt+M'
};

export function eventShortcut(event,mac) {
  if(event.isComposing||event.getModifierState?.('AltGraph'))return '';
  const key=event.key.length===1?event.key.toUpperCase():event.key;
  if (!/^[A-Z0-9]$|^F(?:[1-9]|1[0-2])$|^Tab$/.test(key)) return '';
  const mod=mac?event.metaKey:event.ctrlKey;
  const modifiers=[mod&&'Mod',mac&&event.ctrlKey&&'Ctrl',!mac&&event.metaKey&&'Meta',event.altKey&&'Alt',event.shiftKey&&'Shift'].filter(Boolean);
  return modifiers.length||/^F\d+$/.test(key)?[...modifiers,key].join('+'):'';
}

export const keycaps=(binding,mac)=>String(binding||'').replace('Mod',mac?'⌘':'Ctrl').replaceAll('+',mac?' ':' + ');

import {errorMessage} from './error-message.js';

export function mountShortcuts(panel,{commands,bindings,save,escape,mac,fail}) {
  panel.innerHTML=`<label>${tr("shortcuts.searchCommands")}<input type="search" autocomplete="off"></label><p role="status"></p><div class="shortcut-list"></div>`+
    `<div class="feature-buttons"><button type="button" data-reset>${tr("shortcuts.resetAllDefaults")}</button><button type="button" class="primary" data-save>${tr("shortcuts.saveShortcuts")}</button></div>`;
  const search=panel.querySelector('input'),list=panel.querySelector('.shortcut-list'),message=panel.querySelector('[role=status]');
  let next={...bindings}, recording;
  const all=()=>({...defaultShortcuts,...next});
  function draw() {
    const query=search.value.trim().toLowerCase();
    list.innerHTML=commands.filter(([id,label])=>(id+' '+label).toLowerCase().includes(query)).map(([id,label])=>
      `<div><span>${escape(label)}</span><button type="button" data-record="${id}">${recording===id?tr("shortcuts.pressANewShortcut"):escape(keycaps(all()[id],mac)||tr("shortcuts.record"))}</button>`+
      `<button type="button" data-default="${id}" ${Object.hasOwn(next,id)?'':'disabled'}>${tr("shortcuts.reset")}</button></div>`).join('');
  }
  search.addEventListener('input',draw);
  panel.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(button?.dataset.record) {recording=button.dataset.record;message.textContent=tr("shortcuts.pressAKeyCombinationOrEscTo");draw();panel.querySelector(`[data-record="${recording}"]`)?.focus();}
    if(button?.dataset.default) {delete next[button.dataset.default];recording=null;message.textContent='';draw();}
    if(button?.hasAttribute('data-reset')) {next={};recording=null;message.textContent=tr("shortcuts.defaultsAreRestoredAfterSaving");draw();}
    if(button?.hasAttribute('data-save')) {
      button.disabled=true;
      Promise.resolve(save({...next})).then(()=>{message.textContent=tr("shortcuts.shortcutsSaved");})
        .catch(error=>{message.textContent=errorMessage(error);fail(error);})
        .finally(()=>{button.disabled=false;});
    }
  });
  panel.addEventListener('keydown',event=>{
    if(!recording) return;
    event.preventDefault();event.stopPropagation();
    if(event.key==='Escape') {recording=null;message.textContent='';draw();return;}
    const shortcut=eventShortcut(event,mac);
    if(!shortcut)return;
    const conflict=Object.entries(all()).find(([id,value])=>id!==recording&&value===shortcut);
    if(conflict){message.textContent=tr("shortcuts.shortcutAlreadyInUse")+(commands.find(([id])=>id===conflict[0])?.[1]||conflict[0]);return;}
    next[recording]=shortcut;recording=null;message.textContent='';draw();
  });
  draw();
}
