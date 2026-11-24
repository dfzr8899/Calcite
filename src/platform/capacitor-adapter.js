import {t as tr,getLocale} from "../../shared/i18n/index.mjs";
import {Capacitor,registerPlugin} from '@capacitor/core';
import {Filesystem,Directory} from '@capacitor/filesystem';
import {Preferences} from '@capacitor/preferences';
import {Clipboard} from '@capacitor/clipboard';
import {Network} from '@capacitor/network';
import {App} from '@capacitor/app';
import {Share} from '@capacitor/share';
import {sha256} from '../../shared/core/sha.mjs';
import {randomId} from '../random-id.js';
import {createCapacitorGitFs,basename,dirname,fromBase64,posixPath,vaultStoragePath} from './capacitor-git-fs.js';
import {createCapacitorIndex,indexEntry,markdown,within} from './capacitor-index.js';
import {createLocalGit} from './capacitor-local-git.js';
import {createMobileExport,imageData,imageMime} from './capacitor-export.js';
import {markdownImages,localReference} from '../../shared/markdown-images.mjs';
import {normalizeLineEndings} from '../../shared/text-files.mjs';
import {planLinkRefactor,planCanvasLinkRefactor} from '../../shared/core/link-refactor.mjs';
import {createActivityLog} from '../../shared/core/activity-log.mjs';
import {guardedSave} from '../../shared/core/guarded-save.mjs';

const decoder=new TextDecoder('utf-8',{ignoreBOM:true});
const strictDecoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

const base='/CalciteVaults';
const sessionFile=posixPath(base,'.calcite-session.json');
const extension= /\.(?:md|markdown|mdown|canvas)$/i;
const welcome=()=>`${tr("capacitorAdapter.welcomeToCalciteOpenTheDrawerFrom")}
`;
const unavailable=async()=>{throw Error(tr("capacitorAdapter.thisFeatureIsAvailableInCalciteOn"));};
const noop=()=>{};
const empty=async()=>[];
const visible=name=>!name.startsWith('.')&&!['node_modules','dist','release'].includes(name);
const noteName=(name,ext='.md')=>extension.test(name)?name:name+ext;
const validName=name=>{
  const value=String(name||'').trim();
  if(!value||value.length>100||/^[.]|[. ]$|[\\/:*?"<>|\x00-\x1f]/.test(value))throw Error(tr("capacitorAdapter.enterAValidFileOrFolderName"));
  return value;
};
const encodeRelative=path=>path.split('/').map(part=>encodeURIComponent(part).replaceAll('(','%28').replaceAll(')','%29')).join('/');
const attachmentTypes={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp',
  'image/svg+xml':'svg','image/avif':'avif','image/bmp':'bmp'};
function relative(from,to) {
  const parts=from.split('/'),target=to.split('/');
  while(parts.length&&parts[0]===target[0]){parts.shift();target.shift();}
  return [...parts.map(()=>'..'),...target].join('/');
}

const RichClipboard=registerPlugin('CalciteRichClipboard');
const DocumentCapture=registerPlugin('CalciteDocumentCapture');
const DocumentPrint=registerPlugin('CalciteDocumentPrint');
const ExternalFiles=registerPlugin('CalciteExternalFiles');
const AtomicFiles=registerPlugin('CalciteAtomicFiles');
const SystemBars=registerPlugin('CalciteSystemBars');

export function capacitorAdapter() {
  const android=Capacitor.getPlatform()==='android';
  const externalFiles=android&&Capacitor.isPluginAvailable('CalciteExternalFiles');
  const directory=android?Directory.Data:Directory.Documents;
  const fs=createCapacitorGitFs(Filesystem,directory,{sandboxed:true});
  const io=fs.promises;
  let indexController=new AbortController();
  let index=createCapacitorIndex('',io,atomicWrite,indexController.signal);
  const desktopEvents=new Set(), focus=new Set();
  let root='',queue=Promise.resolve(),generation=0,revision=0,storageWarning='';
  const images=new Map();
  const uriCache=new Map(),imagePaths=new Map();
  const readSetting=async key=>{
    const {value}=await Preferences.get({key});
    try {return value&&JSON.parse(value);}catch{return undefined;}
  };
  const saveSetting=(key,value)=>Preferences.set({key,value:JSON.stringify(value)});
  let sessionQueue=Promise.resolve();
  function compactSession(value) {
    if(!value||typeof value!=='object')return value;
    const stripTabs=tabs=>Array.isArray(tabs)?tabs.map(({text,saved,...meta})=>meta):tabs;
    const workspaces=value.workspaces&&typeof value.workspaces==='object'
      ?Object.fromEntries(Object.entries(value.workspaces).map(([dir,ws])=>{
        if(!ws||typeof ws!=='object')return [dir,ws];
        const {mobileSession,...rest}=ws;
        if(!mobileSession||typeof mobileSession!=='object')return [dir,rest];
        return [dir,{...rest,mobileSession:{...mobileSession,tabs:stripTabs(mobileSession.tabs)}}];
      }))
      :value.workspaces;
    return {...value,tabs:stripTabs(value.tabs),workspaces};
  }
  function saveSession(value) {
    const next=sessionQueue.then(async()=>{
      await io.mkdir(base,{recursive:true});
      await atomicWrite(sessionFile,JSON.stringify(value));
      await saveSetting('session',compactSession(value));
    });
    sessionQueue=next.catch(()=>{});
    return next;
  }
  function serialize(task) {
    const next=queue.then(task);
    queue=next.catch(()=>{});
    return next;
  }
  const localGit=createLocalGit({fs,readSetting,saveSetting,serialize,atomicWrite,archive:trash,storageWarning:()=>storageWarning,
    async applied(dir,changes){
      if(dir!==root)return;
      revision++;
      const entries=[],parents=new Set();
      for(const {file,next} of changes) {
        uriCache.delete(file);
        if(!file.slice(dir.length+1).split('/').every(visible))continue;
        if(!next) {
          images.delete(file);index.observe(file);
          if(extension.test(file))entries.push({path:file,type:'unlink'});
          continue;
        }
        if(!extension.test(file)&&!imageMime(file))continue;
        const info=await io.stat(file);
        const entry={path:file,name:basename(file),...info};
        if(imageMime(file))images.set(file,entry);
        if(markdown.test(file))index.observe(file,indexEntry(file,info));
        if(extension.test(file)) {
          entries.push({path:file,type:'change',row:browserRows([entry])[0]});
          for(let parent=dirname(file);parent!==dir;parent=dirname(parent))parents.add(parent);
        }
      }
      for(const parent of parents)entries.push({path:parent,type:'addDir',row:{path:parent,name:basename(parent),children:[]}});
      if(entries.length)desktopEvents.forEach(listener=>listener({root:dir,source:'sync',changes:entries}));
    }});
  function scoped(path,allowRoot=false) {
    const file=posixPath(path);
    if(!root||!within(root,file)||(!allowRoot&&root===file)||file.slice(root.length+1).split('/').some(part=>part.startsWith('.')))
      throw Error(tr("capacitorAdapter.thePathIsOutsideTheCurrentVault"));
    return file;
  }
  async function listDirectory(dir,recover){
    let entries=await io.readdir(dir,{withFileTypes:true});
    const backups=recover?entries.filter(entry=>entry.isFile()&&entry.name.startsWith('.calcite-backup-')):[];
    for(const {name} of backups) {
      const target=posixPath(dir,name.slice('.calcite-backup-'.length)),backup=posixPath(dir,name);
      if(await fs.exists(target))await io.unlink(backup);
      else await io.rename(backup,target);
    }
    if(backups.length)entries=await io.readdir(dir,{withFileTypes:true});
    const locale=getLocale();
    return entries.filter(entry=>visible(entry.name))
      .sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,locale,{numeric:true}));
  }
  async function all(dir,recover=false) {
    const result=[],pending=[{path:dir,children:result,depth:0}];
    for(let i=0;i<pending.length;){
      const batch=pending.slice(i,i+8);
      i+=batch.length;
      const lists=await Promise.all(batch.map(parent=>listDirectory(parent.path,recover)));
      for(const [slot,parent] of batch.entries())for(const entry of lists[slot]){
        const path=posixPath(parent.path,entry.name);
        const row={...entry,path};
        if(entry.isDirectory()){
          if(parent.depth===32)throw Error(tr("capacitorAdapter.theVaultPathIsMoreThan32"));
          row.children=[];
          pending.push({path,children:row.children,depth:parent.depth+1});
        }
        parent.children.push(row);
      }
    }
    return result;
  }
  const flat=rows=>rows.flatMap(row=>row.children?flat(row.children):[row]);
  function browserRows(rows) {
    return rows.filter(row=>row.children||extension.test(row.path)).map(({path,name,mtimeMs,ctimeMs,children})=>
      ({path,name,modified:mtimeMs,created:ctimeMs,...(children?{children:browserRows(children)}:{})}));
  }
  async function tree(recover=false) {
    if(!root)return [];
    const dir=root,serial=generation,version=revision;
    const rows=await all(dir,recover);
    if(dir!==root||serial!==generation)return [];
    if(version===revision) {
      const present=new Set();
      images.clear();
      for(const entry of flat(rows)){
        if(imageMime(entry.path))images.set(entry.path,entry);
        if(!markdown.test(entry.path))continue;
        present.add(entry.path);
        index.observe(entry.path,indexEntry(entry.path,entry));
      }
      for(const path of index.items.keys())if(!present.has(path))index.observe(path);
    }
    return browserRows(rows);
  }
  async function mount(dir,retained=[],legacyKey) {
    if(dir===root)return {root,tree:await tree(),retained,initialFiles:[]};
    let recovered=false;
    if(dir){
      if(dirname(dir)!==base||!(await io.stat(dir)).isDirectory())throw Error(tr("capacitorAdapter.thisVaultCouldNotBeFound"));
      let quarantined=false;
      const didRecover=await activity(dir,(error,failedPath)=>{
        quarantined=true;
        console.warn('Quarantined unrecoverable refactor journal:',failedPath,error);
      }).recover();
      recovered=quarantined?'quarantined':didRecover;
      if(didRecover)console.info(tr('dataSafety.recovered'),dir);
      await saveSetting('vault',dir);
    }
    root=dir;
    generation++;
    indexController.abort();
    indexController=new AbortController();
    index=createCapacitorIndex(dir,io,atomicWrite,indexController.signal);
    images.clear();uriCache.clear();imagePaths.clear();
    const rows=await tree(true);
    localGit.mount(dir,legacyKey);
    return {root,recovered,tree:rows,retained:retained.filter(path=>dir&&within(dir,path)),initialFiles:flat(rows).filter(row=>markdown.test(row.path)).slice(0,1).map(row=>row.path)};
  }
  async function vaults() {
    await io.mkdir(base,{recursive:true});
    const locale=getLocale();
    return (await io.readdir(base,{withFileTypes:true})).filter(item=>item.isDirectory()&&visible(item.name))
      .map(item=>({path:posixPath(base,item.name),name:item.name})).sort((a,b)=>a.name.localeCompare(b.name,locale));
  }
  async function vaultPath(path) {
    const dir=posixPath(path);
    if(dirname(dir)!==base||!visible(basename(dir))||!(await io.stat(dir)).isDirectory())throw Error(tr("capacitorAdapter.thisVaultCouldNotBeFound2"));
    return dir;
  }
  async function switchVault(dir,retained) {
    localGit.guardTransfer(root,dir);
    if(dir!==root)await localGit.checkpoint(root);
    return mount(dir,retained);
  }
  async function migrateVaults() {
    if(await readSetting('androidPrivateVaults'))return;
    const previous=createCapacitorGitFs(Filesystem,Directory.Documents,{sandboxed:true}).promises;
    async function copyFolder(from,to) {
      await io.mkdir(to,{recursive:true});
      for(const entry of await previous.readdir(from,{withFileTypes:true})) {
        if(entry.name!==basename(entry.name)||entry.name==='.'||entry.name==='..')throw Error(tr("capacitorAdapter.theOldVaultContainsAnInvalidPath"));
        const source=posixPath(from,entry.name),target=posixPath(to,entry.name);
        if(entry.isDirectory())await copyFolder(source,target);
        else await Filesystem.copy({from:source.slice(1),to:target.slice(1),directory:Directory.Documents,toDirectory:directory});
      }
    }
    try{
      const old=await previous.readdir(base,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
      await io.mkdir(base,{recursive:true});
      for(const {name} of old.filter(entry=>entry.isDirectory()&&visible(entry.name)))try {
        const target=posixPath(base,validName(name));
        if(await fs.exists(target))continue;
        const staging=posixPath(base,'.calcite-migration-'+name);
        if(await fs.exists(staging))await io.rmdir(staging,{recursive:true});
        await copyFolder(target,staging);
        await io.rename(staging,target);
      }catch(error){
        storageWarning=tr("capacitorAdapter.someOldVaultsCouldNotBeMigrated")+String(error.message||error);
      }
      if(storageWarning)return;
      await saveSetting('androidPrivateVaults',true);
    }catch(error){
      storageWarning=tr("capacitorAdapter.theOldVaultCouldNotBeMigrated")+String(error.message||error);
    }
  }
  function restoreSession(session) {
    if(!session)return session;
    const storedRoot=vaultStoragePath(session.mobileRoot);
    if(!root||storedRoot!==root)return session;
    const rebase=value=>{
      const path=vaultStoragePath(value);
      return path&&within(root,path)?path:value;
    };
    const row=value=>({...value,path:rebase(value.path)});
    const workspaces={...session.workspaces};
    const previous=workspaces[session.mobileRoot];
    if(previous){
      delete workspaces[session.mobileRoot];
      workspaces[root]={...previous,bookmarks:previous.bookmarks?.map(row)||[]};
    }
    return {...session,mobileRoot:root,tabs:session.tabs?.map(row),closedFiles:session.closedFiles?.map(rebase),workspaces};
  }
  const newVaultPath=name=>{
    const label=validName(name);
    if(!visible(label))throw Error(tr("capacitorAdapter.thisNameIsReservedChooseAnother"));
    return posixPath(base,label);
  };
  async function createVault(name,withWelcome=false) {
    const dir=newVaultPath(name);
    await io.mkdir(dir);
    if(withWelcome)await io.writeFile(posixPath(dir,tr('vault.welcomeFile')),welcome());
    return dir;
  }
  async function readSnapshot(file,allowMissing=false) {
    try{
      for(let attempt=0;attempt<3;attempt++){
        const before=await fs.freshStat(file);
        if(!before.isFile()||before.size>(markdown.test(file)?16:5)*1024*1024)
          throw Error(tr('main.theDocumentIsInvalidOrExceedsThe'));
        const bytes=await io.readFile(file);
        const hash=sha256(bytes);
        const after=await fs.freshStat(file);
        if(before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes.length!==after.size)continue;
        const raw=decoder.decode(bytes),text=normalizeLineEndings(file,raw);
        return {raw,text,mtime:after.mtimeMs,needsLf:raw!==text,
          snapshot:{mtimeMs:after.mtimeMs,size:bytes.length,hash}};
      }
      throw Error(tr('dataSafety.unstableFile'));
    }catch(error){
      if(allowMissing&&error.code==='ENOENT')return null;
      throw error;
    }
  }
  async function read(path,allowMissing) {
    const file=scoped(path);
    if(!extension.test(file))throw Error(tr('main.selectAMarkdownOrCanvasFile'));
    const disk=await readSnapshot(file,allowMissing);
    if(!disk)return null;
    const {raw,...result}=disk;
    return result;
  }
  async function renameAtomic(from,to,temporary=false,exclusive=false) {
    // The Android Filesystem plugin deletes an existing target before renaming
    // and may fall back to copy/delete. Use the native atomic primitive here.
    try{await AtomicFiles.rename({from,to,temporary,exclusive});}
    catch(error){if(exclusive&&error.code==='EEXIST')return false;throw Error(tr('dataSafety.atomicReplaceFailed'),{cause:error});}
    fs.invalidate(from,true);
    fs.invalidate(to,true);
    return true;
  }
  async function atomicWrite(file,data,beforeReplace=async()=>true,exclusive=false) {
    const temp=posixPath(dirname(file),'.calcite-tmp-'+randomId());
    try {
      await io.writeFile(temp,data,{flag:'wx'});
      if(!await beforeReplace())return false;
      return await renameAtomic(temp,file,true,exclusive);
    }finally{
      await io.unlink(temp).catch(error=>{if(error.code!=='ENOENT')console.warn(error);});
    }
  }
  async function flushDirectory(path) {
    try{await AtomicFiles.flushDirectory({path});}
    catch(error){throw Error(tr('dataSafety.atomicReplaceFailed'),{cause:error});}
  }
  function activity(dir=root,onRecoverFailure) {
    if(!dir)throw Error(tr('main.openAWorkspaceFirst'));
    return createActivityLog(dir,{io,path:{join:posixPath,dirname},write:atomicWrite,rename:renameAtomic,
      id:randomId,hash:value=>sha256(value),
      archive:(file,bytes)=>localGit.recordUndo(dir,file,bytes),
      flush:flushDirectory,onRecoverFailure,
      async sameFile(from,to){
        try{return (await AtomicFiles.sameFile({from,to})).same;}
        catch(error){throw Error(tr('dataSafety.atomicReplaceFailed'),{cause:error});}
      },
      async linkMove(from,to){
        if(!await renameAtomic(from,to,false,true))throw Error(tr('activity.undoOccupied'));
        await io.unlink(from);
        await flushDirectory(dirname(from));
      },
      async safe(file){
        if(!within(dir,file)||posixPath(file)!==file)throw Error(tr('dataSafety.invalidJournal'));
        return file;
      }});
  }
  async function save(data) {
    let {path,name,saveAs}=data;
    const chosen=!path||saveAs;
    if(!chosen)path=scoped(path);
    else {
      const label=validName(noteName(name||tr('main.untitledName')));
      path=scoped(posixPath(root,label));
      if(await fs.exists(path)) {
        const ext=label.match(extension)[0];
        let count=2;
        do {path=scoped(posixPath(root,label.slice(0,-ext.length)+' '+(count++)+ext));}
        while(await fs.exists(path));
      }
    }
    const result=await guardedSave(path,data,{chosen,read:()=>readSnapshot(path,true),
      write:(text,guard)=>atomicWrite(path,text,guard),
      archive:text=>data.resolution?localGit.recordExternal(root,path,text):
        !localGit.isEnabled()?localGit.recordSaved(root,path,text):Promise.resolve()});
    if(result.conflict||result.reloaded){
      const {raw,...publicResult}=result;
      return publicResult;
    }
    if(result.written)await savedFile(path,result.text);
    return {path,...await read(path)};
  }
  async function savedFile(path,text) {
    const info=await io.stat(path);
    revision++;
    if(markdown.test(path)){
      const item=indexEntry(path,info);
      index.observe(path,item,{item,text});
    }
    localGit.schedule(root,path);
    return {path,mtime:info.mtimeMs};
  }
  async function importExternalFile(dir,{name,text}) {
    if(!root||dir!==root)throw Error(tr("capacitorAdapter.theActiveVaultChangedConfirmTheImport"));
    if(typeof text!=='string'||!text.trim())throw Error(tr("capacitorAdapter.theExternalFileIsEmpty"));
    const stem=name.replace(/\.(?:md|markdown|mdown|txt)$/i,'').slice(0,84).replace(/[\uD800-\uDBFF]$/,'')
      .replace(/[. ]+$/,'')||tr('android.untitled').replace(/\.md$/,'');
    const content=normalizeLineEndings('.md',text);
    for(let i=0;;i++){
      const label=validName(stem+(i?' ('+i+')':'')+'.md');
      const file=scoped(posixPath(root,label));
      if(await fs.exists(file))continue;
      if(await atomicWrite(file,content,async()=>!await fs.exists(file),true))return savedFile(file,content);
    }
  }
  async function trash(path) {
    const target=posixPath(root,'.trash',randomId(),basename(path));
    await io.mkdir(dirname(target),{recursive:true});
    await io.rename(path,target);
  }
  async function edit({type,path,parent,name,text='',drafts=[],openExisting,createParents}) {
    if(type==='note'||type==='folder') {
      const target=scoped(posixPath(scoped(parent||root,true),validName(type==='note'?noteName(name):name)));
      if(type==='folder')await io.mkdir(target);
      else if(!(openExisting&&await fs.exists(target))) {
        if(createParents)await io.mkdir(dirname(target),{recursive:true});
        await io.writeFile(target,normalizeLineEndings(target,text),{flag:'wx'});
      }
      await localGit.schedule(root);
      return {path:target,tree:await tree()};
    }
    const from=scoped(path),info=await io.stat(from);
    if(type==='trash') {
      const logged=await activity().softDelete(from);
      await localGit.schedule(root);
      return {tree:await tree(true),activity:logged};
    }
    if(!['move','rename'].includes(type))throw Error(tr("main.unknownFileAction"));
    const label=type==='move'?basename(from):validName(info.isDirectory()?name:noteName(name,basename(from).match(extension)?.[0]||'.md'));
    const to=scoped(posixPath(type==='move'?scoped(parent,true):dirname(from),label));
    if(to===from)return {path:to,tree:await tree(),changes:[]};
    if(await fs.exists(to)||within(from,to))throw Error(tr("capacitorAdapter.theDestinationIsUnavailableOrAlreadyExists"));
    await index.refresh();
    const {move,changes:noteChanges,refactor:noteRefactor}=await planLinkRefactor(index,from,to,drafts,async file=>{
      const {mtimeMs}=await io.stat(scoped(file));
      const bytes=await io.readFile(file);
      try{return {text:strictDecoder.decode(bytes),mtime:mtimeMs};}
      catch{throw Error(tr('dataSafety.invalidUtf8'));}
    });
    const allCanvases=flat(await all(root)).filter(entry=>/\.canvas$/i.test(entry.path)).map(entry=>entry.path);
    const {changes:canvasChanges,refactor:canvasRefactor}=await planCanvasLinkRefactor(index,move,allCanvases,drafts,async file=>{
      const stat=await io.stat(scoped(file));
      if(!stat.isFile()||stat.size>5*1024*1024)return null;
      const bytes=await io.readFile(file);
      return {text:strictDecoder.decode(bytes),mtime:stat.mtimeMs};
    });
    const changes=[...noteChanges,...canvasChanges];
    const refactor={notes:noteRefactor.notes+canvasRefactor.notes,references:noteRefactor.references+canvasRefactor.references};
    for(const change of changes){
      if(await io.readFile(change.from,'utf8')!==change.previous)throw Error(tr("capacitorAdapter.theNoteChangedElsewhereTryAgain"));
    }
    const logged=await activity().refactor(type,from,to,changes);
    for(const change of changes){
      const {raw,mtime,snapshot,needsLf}=await readSnapshot(change.path);
      Object.assign(change,raw===change.saved?{mtime,snapshot,needsLf}:{mtime:null});
      if(change.path!==change.from)await localGit.relocateHistory(root,change.from,change.path).catch(()=>{});
    }
    revision++;
    uriCache.clear();imagePaths.clear();
    localGit.schedule(root,...changes.map(change=>change.path));
    return {path:to,tree:await tree(),refactor,activity:logged,changes:changes.map(({previous,...row})=>({
      ...row,saved:normalizeLineEndings(row.path,row.saved)
    }))};
  }
  async function resolveImage(note,raw,wiki=false) {
    if(!note||!root)return null;
    const decoded=localReference(raw);
    if(!decoded||!imageMime(decoded))return null;
    let candidates;
    try {
      candidates=decoded.startsWith('/')?[posixPath(root,decoded)]:[posixPath(dirname(note),decoded),...(wiki?[posixPath(root,decoded)]:[])];
    }catch{return null;}
    if(wiki&&!decoded.includes('/')) {
      const matches=[...images.keys()].filter(path=>basename(path).toLowerCase()===decoded.toLowerCase());
      if(matches.length===1)candidates.push(matches[0]);
    }
    for(const candidate of [...new Set(candidates)]) {
      if(within(root,candidate)&&candidate.slice(root.length+1).split('/').every(visible)&&
        await fs.exists(candidate).then(info=>info?.isFile()))return candidate;
    }
    return null;
  }
  async function displayImage(path) {
    if(!uriCache.has(path))uriCache.set(path,Filesystem.getUri({path:path.slice(1),directory}).then(({uri})=>{
      const url=new URL(Capacitor.convertFileSrc(uri),location.href);
      if(url.protocol!==location.protocol||url.host!==location.host)return null;
      imagePaths.set(url.href,path);
      return url.href;
    }).catch(()=>null));
    return await uriCache.get(path)||imageData(path,await io.readFile(path));
  }
  async function imageSource(note,raw,wiki) {
    const path=await resolveImage(note,raw,wiki);
    return path?displayImage(path):null;
  }
  async function readImage(url) {
    const file=imagePaths.get(url);
    if(!file)throw Error(tr("capacitorAdapter.invalidLocalImagePath"));
    const path=scoped(file);
    return {path,bytes:await io.readFile(path)};
  }
  async function attach({note,strategy,directory,mime,bytes}) {
    if(!Object.hasOwn(attachmentTypes,mime)||!bytes?.length||bytes.length>32*1024*1024)
      throw Error(tr("capacitorAdapter.selectASupportedImageSmallerThan32"));
    note=scoped(note);
    const parent=dirname(note),pattern=directory.replaceAll('\${filename}',basename(note).replace(extension,''));
    const folder=scoped(posixPath(strategy==='workspace'?root:parent,...pattern.replace(/^\.[\\/]/,'').split(/[\\/]/).map(validName)),true);
    const path=posixPath(folder,randomId()+'.'+attachmentTypes[mime]);
    await io.mkdir(folder,{recursive:true});
    await io.writeFile(path,bytes,{flag:'wx'});
    images.set(path,{path,mtimeMs:Date.now(),size:bytes.length});
    await localGit.schedule(root);
    return encodeRelative(relative(parent,path));
  }
  async function scan(drafts=[]) {
    const rows=await tree();
    await index.refresh();
    const used=new Set();
    const byName=new Map();
    for(const file of images.keys()){
      const name=basename(file).toLowerCase();
      if(!byName.has(name))byName.set(name,[]);
      byName.get(name).push(file);
    }
    async function markText(text,file) {
      for(const ref of markdownImages(text)) {
        const target=await resolveImage(file,ref.destination,ref.wiki);
        if(target)used.add(target);
      }
      for(const hit of text.matchAll(/[^\s<>"'`|()[\]{}]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?=$|[\s<>"'#?`|()[\]{}])/gi)) {
        const local=localReference(hit[0]);
        if(local)for(const candidate of byName.get(basename(local).toLowerCase())||[])used.add(candidate);
      }
    }
    for(const row of await index.workspaceNotes('attachments',drafts))await markText(row.text,row.path);
    for(const canvas of flat(rows).filter(entry=>/\.canvas$/i.test(entry.path))){
      const content=JSON.parse(await io.readFile(canvas.path,'utf8'));
      if(!Array.isArray(content.nodes))throw Error(tr("capacitorAdapter.fixTheInvalidCanvasBeforeCleaningUp"));
      for(const node of content.nodes){
        if(typeof node?.file==='string'){
          for(const candidate of [node.file,'/'+node.file.replace(/^\//,'')]) {
            const target=await resolveImage(canvas.path,candidate,true);
            if(target)used.add(target);
          }
        }
        if(typeof node?.background==='string'){
          const target=await resolveImage(canvas.path,'/'+node.background.replace(/^\//,''),true);
          if(target)used.add(target);
        }
        if(node?.type==='text'&&typeof node.text==='string')await markText(node.text,canvas.path);
      }
    }
    return Promise.all([...images.values()].filter(entry=>!used.has(entry.path)).map(async entry=>
      ({path:entry.path,relative:entry.path.slice(root.length+1),preview:await displayImage(entry.path),mtime:entry.mtimeMs,size:entry.size})));
  }
  const exports=createMobileExport({filesystem:Filesystem,share:Share,clipboard:Clipboard,readImage,resolveImage,readFile:io.readFile,
    nativePrint:android?options=>DocumentPrint.pdf(options):undefined,
    nativeCapture:Capacitor.isPluginAvailable('CalciteDocumentCapture')?options=>DocumentCapture.png(options):undefined});
  exports.isLocalImage=url=>imagePaths.has(url);
  const richFallback=exports.rich;
  exports.rich=async payload=>{
    if(Capacitor.isPluginAvailable('CalciteRichClipboard')) {
      await RichClipboard.write(payload);
      return true;
    }
    return richFallback(payload);
  };
  async function queryIndex(method,...args) {
    const active=index;
    await active.refresh();
    return (active===index?active:index)[method](...args);
  }
  async function clipboardImage() {
    const fromNative=android&&Capacitor.isPluginAvailable('CalciteRichClipboard')?
      await RichClipboard.readImage():null;
    const {type,data}=fromNative?.data?fromNative:await Clipboard.read().then(({value})=>{
      const match=/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(value||'');
      return {type:match?.[1],data:match?.[2]};
    });
    if(!data||!Object.hasOwn(attachmentTypes,type))return null;
    if(data.length>Math.ceil(32*1024*1024/3)*4)throw Error(tr("capacitorAdapter.theClipboardImageExceeds32Mib"));
    return new File([fromBase64(data)],tr('common.image')+'.'+attachmentTypes[type],{type});
  }
  return {
    type:'capacitor',os:Capacitor.getPlatform(),
    fs:{open:empty,read,save:data=>serialize(()=>save(data)),release:noop,reveal:unavailable,revealImage:unavailable,
      attachment:data=>serialize(()=>attach(data)),imageSource,history:(path,id)=>localGit.history(root,path,id),
      ...(externalFiles?{consumeExternalFile:()=>ExternalFiles.consumePendingExternalFile(),
        importExternalFile:(dir,file)=>serialize(()=>importExternalFile(dir,file))}:{})},
    workspace:{
      async bootstrap(){
        if(android)await migrateVaults();
        const dirs=await vaults();
        const selected=await readSetting('vault');
        const normalized=vaultStoragePath(selected),defaultPath=posixPath(base,'我的笔记');
        const restored=dirs.find(item=>item.path===normalized);
        const fallback=dirs.find(item=>item.path===defaultPath);
        let next=restored?.path||fallback?.path;
        if(!next&&dirs.length&&(!selected||await fs.exists(defaultPath)))next=dirs[0].path;
        next ||= await createVault(tr('vault.initialName'),true);
        const {initialFiles,recovered}=await mount(next,[],restored&&selected!==normalized?selected:undefined);
        let rawSession;
        try{rawSession=JSON.parse(await io.readFile(sessionFile,'utf8'));}
        catch(error){
          if(error?.code!=='ENOENT'&&!(error instanceof SyntaxError))console.warn(error);
          rawSession=await readSetting('session');
        }
        const session=restoreSession(rawSession);
        return {root,config:{session,recovered,features:await readSetting('features')},initialFiles:
          session?.tabs?.some(tab=>tab.path&&within(root,tab.path))?[]:initialFiles};
      },
      vaults:()=>serialize(async()=>Promise.all((await vaults()).map(async item=>({
        ...item,count:flat(await all(item.path)).filter(row=>extension.test(row.path)).length,
        status:await localGit.summary(item.path)
      })))),
      folder:unavailable,
      close:()=>serialize(()=>mount('')),
      switchVault:(path,retained)=>serialize(async()=>switchVault(await vaultPath(path),retained)),
      createVault:(name,retained)=>serialize(async()=>{
        localGit.guardTransfer(root);
        await localGit.checkpoint(root);
        return mount(await createVault(name),retained);
      }),
      renameVault:(path,name,retained)=>serialize(async()=>{
        const previous=await vaultPath(path),dir=newVaultPath(name);
        if(dir===previous)return null;
        if(await fs.exists(dir))throw Error(tr("capacitorAdapter.aVaultWithThatNameAlreadyExists"));
        localGit.guardTransfer(previous);
        await localGit.checkpoint(previous);
        await io.rename(previous,dir);
        try{await localGit.move(previous,dir);}
        catch(error){await io.rename(dir,previous);throw error;}
        const result=previous===root?await mount(dir):{root,tree:await tree()};
        return {...result,renamedFrom:previous,renamedTo:dir,retained};
      }),
      deleteVault:(path,retained)=>serialize(async()=>{
        const dir=await vaultPath(path);
        const remaining=(await vaults()).filter(item=>item.path!==dir);
        const next=dir===root?remaining[0]?.path:root;
        localGit.guardTransfer(dir,next);
        const initialName=tr('vault.initialName');
        const replacement=next||await createVault(dir===posixPath(base,initialName)?tr('vault.fallbackName'):initialName);
        // Move the directory out of the vault list before recursive removal.
        const removed=posixPath(base,'.deleted-'+randomId());
        await io.rename(dir,removed);
        let result;
        try{result=dir===root?await mount(replacement,retained):{root,tree:await tree(),retained};}
        catch(error){await io.rename(removed,dir);throw error;}
        const cleanup=await Promise.allSettled([localGit.remove(dir),io.rmdir(removed,{recursive:true})]);
        return {...result,deletedVault:dir,warning:cleanup.some(item=>item.status==='rejected')?
          tr("capacitorAdapter.theVaultWasRemovedButSomeLocal"):''};
      }),
      tree:()=>tree(),edit:update=>serialize(()=>edit(update)),
      async listCanvases(){
        if(!root)return [];
        const locale=getLocale();
        return flat(await all(root))
          .filter(entry=>/\.canvas$/i.test(entry.path))
          .map(entry=>entry.path.slice(root.length+1))
          .sort((a,b)=>a.localeCompare(b,locale,{numeric:true}));
      },
      async readCanvas(name){
        const parts=String(name||'').trim().replaceAll('\\','/').split('/').filter(Boolean);
        if(!parts.length)throw Error(tr("main.enterANameForTheCanvas"));
        const last=validName(parts.pop().replace(/\.canvas$/i,''))+'.canvas';
        const {text}=await read(posixPath(root,...parts.map(validName),last));
        return {text,version:sha256(text)};
      },
      saveCanvas:({name,board,version})=>serialize(async()=>{
        const parts=String(name||'').trim().replaceAll('\\','/').split('/').filter(Boolean);
        if(!parts.length)throw Error(tr("main.enterANameForTheCanvas"));
        const last=validName(parts.pop().replace(/\.canvas$/i,''))+'.canvas';
        const file=scoped(posixPath(root,...parts.map(validName),last));
        const text=JSON.stringify(board,null,2)+'\n';
        if(version!==undefined){
          const expected=async()=>sha256((await read(file)).text)===version;
          if(!await expected()||!await atomicWrite(file,text,expected))throw Error(tr("capacitorAdapter.theCanvasChangedElsewhereReopenIt"));
        }else{
          if(await fs.exists(file))throw Error(tr("capacitorAdapter.aCanvasWithThatNameAlreadyExists"));
          await io.mkdir(dirname(file),{recursive:true});
          await atomicWrite(file,text);
        }
        localGit.schedule(root,file);
        return {name:file.slice(root.length+1),version:sha256(text)};
      })
    },
    index:{target:async({source,destination,wiki})=>{
      const {target,heading}=await queryIndex('resolve',source||posixPath(root,'index.md'),destination,wiki);
      return target&&index.notes.has(target)?{path:target,heading:heading?.replace(/^#/,'')}:null;
    },backlinks:(...args)=>queryIndex('backlinks',...args),
      health:drafts=>queryIndex('health',drafts),
      links:async({source,destinations,headings})=>{
        const active=index;
        await active.refresh();
        const anchor=source||posixPath(root,'未命名.md');
        return destinations.map(destination=>(active===index?active:index).inspect(anchor,destination,true,headings));
      },
      notes:(...args)=>queryIndex('workspaceNotes',...args),graph:data=>queryIndex('graph',data),
      searchSnapshot:data=>queryIndex('searchSnapshot',data),search:query=>queryIndex('search',query)},
    export:exports,
    attachments:{scan:drafts=>serialize(()=>scan(drafts)),trash:({paths,drafts})=>serialize(async()=>{
      const allowed=new Set((await scan(drafts)).map(row=>row.path));
      for(const path of paths)if(!allowed.has(path))throw Error(tr("capacitorAdapter.attachmentReferencesChangedScanAgain"));
      for(const path of new Set(paths))await trash(scoped(path));
      if(paths.length)await localGit.schedule(root);
      return paths.length;
    })},
    activity:{list:()=>serialize(()=>activity().list()),empty:()=>serialize(()=>activity().emptyTrash()),
      undo:(id,token)=>serialize(async()=>{
        const result=await activity().undo(id,token);
        if(!result.activity)return result;
        revision++;
        uriCache.clear();imagePaths.clear();
        for(const {from,path} of result.affected){
          if(from&&from!==path)index.observe(from);
          if(markdown.test(path))index.observe(path);
        }
        localGit.schedule(root,...result.affected.flatMap(row=>[row.from,row.path]).filter(Boolean));
        return {...result,tree:await tree(true)};
      })},
    sync:localGit.api,
    clipboard:{writeText:string=>Clipboard.write({string}),readText:async()=>(await Clipboard.read()).value,readImage:clipboardImage},
    preferences:{saveSession,saveFeatures:value=>saveSetting('features',value),
      ...(externalFiles?{syncNativeLanguage:locale=>ExternalFiles.setLocale({locale})}:{})},
    window:{control:unavailable,async setAppearance({theme}={}){
      const active=theme==='dark'?'dark':theme==='light'?'light':
        globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
      if(android&&Capacitor.isPluginAvailable('CalciteSystemBars')) {
        await SystemBars.setAppearance({theme:active}).catch(()=>{});
      }
      return {material:'css',theme:active};
    },discard:async()=>confirm(tr("capacitorAdapter.discardUnsavedChanges")),
      quit:async()=>App.exitApp(),async ready(){
        await Network.getStatus().then(localGit.network).catch(()=>{});
        await Network.addListener('networkStatusChange',localGit.network).catch(()=>{});
        window.addEventListener('online',()=>Network.getStatus().then(localGit.network).catch(()=>{}));
        window.addEventListener('offline',()=>localGit.network({connected:false,connectionType:'none'}));
        await App.addListener('appStateChange',event=>{
          localGit.focus(event.isActive);
          focus.forEach(listener=>listener(event.isActive));
          if(!event.isActive&&root)localGit.commit(root).catch(console.error);
          if(event.isActive&&root){
            const dir=root;
            tree().then(rows=>{
              if(dir===root)desktopEvents.forEach(listener=>listener({root:dir,tree:rows,changes:[]}));
            }).catch(console.error);
          }
        });
        return [];
      },async external(url){if(/^https?:\/\//i.test(url))window.open(url,'_blank','noopener,noreferrer');}},
    events:{action:noop,externalChange:listener=>desktopEvents.add(listener),focus:listener=>focus.add(listener),
      windowState:noop,sync:localGit.subscribe,network:listener=>Network.addListener('networkStatusChange',listener),
      ...(externalFiles?{externalFile:listener=>ExternalFiles.addListener('externalFileAvailable',listener)}:{}),
      back:listener=>App.addListener('backButton',listener)}
  };
}
