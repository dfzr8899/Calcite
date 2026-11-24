const {contextBridge,ipcRenderer}=require('electron');
const names=['bootstrap','folder','recent-vaults','switch-vault','close-vault','tree','open','release-file','read','save','session','search','search-index','external','reveal','discard','pdf','quit','workspace-edit','activity:list','activity:undo','activity:empty','note-target','backlinks','workspace-notes','workspace-links','workspace-health','features','history','attachment','attachments:scan','attachments:trash','export-document','export-rich','export-markdown','export-image','pandoc-export','workspace-graph','canvas-files','canvas-read','canvas-save'];
const subscribe=(channel,callback)=>{
  const listener=(_,payload)=>callback(payload);
  ipcRenderer.on(channel,listener);
  return ()=>ipcRenderer.removeListener(channel,listener);
};
const syncMethods=['status','configure','run','test','pair','revoke','clear-conflict','remote-pair','cancel-remote-pair','network','resolve',
  'conflict-files','archive-conflicts','restore-version'];
contextBridge.exposeInMainWorld('desktop',{
  ...Object.fromEntries(names.map(name=>[name,(...args)=>ipcRenderer.invoke(name,...args)])),
  revealImage: path=>ipcRenderer.invoke('reveal-image',path),
  writeClipboardText: text=>ipcRenderer.invoke('clipboard-write-text',text),
  pasteClipboard: plain=>ipcRenderer.invoke('clipboard-paste',plain),
  ...Object.fromEntries(syncMethods.map(name=>['sync:'+name,(...args)=>ipcRenderer.invoke('sync:'+name,...args)])),
  onAction: callback => subscribe('action',callback),
  onExternalChange: callback => subscribe('vault:external-change',callback),
  onSync: callback => subscribe('sync:state',callback),
  rendererReady: () => ipcRenderer.invoke('renderer-ready'),
  platform: process.platform,
  windowControl: control => ipcRenderer.invoke('window-control', control),
  setLanguage: language => ipcRenderer.invoke('window:language',language),
  setWindowAppearance: settings => ipcRenderer.invoke('window:set-appearance',settings),
  onWindowFocus: callback => subscribe('window-focus-state',callback),
  onWindowState: callback => subscribe('window-state',callback)
});
