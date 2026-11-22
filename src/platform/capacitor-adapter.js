import {Capacitor,registerPlugin} from '@capacitor/core';
import {Filesystem,Directory} from '@capacitor/filesystem';
import {Preferences} from '@capacitor/preferences';
import {Clipboard} from '@capacitor/clipboard';
import {Network} from '@capacitor/network';
import {App} from '@capacitor/app';
import {Share} from '@capacitor/share';
import {randomId} from '../random-id.js';
import {createCapacitorGitFs,basename,dirname,fromBase64,posixPath,vaultStoragePath} from './capacitor-git-fs.js';
import {createCapacitorIndex,indexEntry,markdown,within} from './capacitor-index.js';
import {createLocalGit} from './capacitor-local-git.js';
import {createMobileExport,imageData,imageMime} from './capacitor-export.js';
import {markdownImages,localReference} from '../../shared/markdown-images.mjs';
import {normalizeLineEndings} from '../../shared/text-files.mjs';
import {planLinkRefactor} from '../../shared/core/link-refactor.mjs';

const base='/CalciteVaults';
const extension= /\.(?:md|markdown|mdown|canvas)$/i;
const welcome='# 欢迎使用 Calcite\n\n- 点左上角打开抽屉。点顶部的知识库名称可切换或管理知识库，点底部的「新建笔记」即可开始写作。\n- 点右上角的「编辑」或「阅读」切换模式。在「…」中打开大纲和反向链接。\n- 要同步到电脑，先在电脑上生成配对串或二维码，再在手机的知识库管理中选择「配对新建」。配对后，点顶栏的同步状态，再点「立即同步」。\n';
const unavailable=async()=>{throw Error('此功能在 Calcite 桌面版可用。');};
const noop=()=>{};
const empty=async()=>[];
const visible=name=>!name.startsWith('.')&&!['node_modules','dist','release'].includes(name);
const noteName=(name,ext='.md')=>extension.test(name)?name:name+ext;
const validName=name=>{
  const value=String(name||'').trim();
  if(!value||value.length>100||/^[.]|[. ]$|[\\/:*?"<>|\x00-\x1f]/.test(value))throw Error('请输入有效的文件或文件夹名称。');
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

export function capacitorAdapter() {
  const android=Capacitor.getPlatform()==='android';
  const directory=android?Directory.Data:Directory.Documents;
  const fs=createCapacitorGitFs(Filesystem,directory,{sandboxed:true});
  const io=fs.promises;
  let indexController=new AbortController();
  let index=createCapacitorIndex('',io,atomicWrite,indexController.signal);
  const desktopEvents=new Set(), focus=new Set();
  let root='',queue=Promise.resolve(),generation=0,revision=0,storageWarning='';
  const images=new Map();
  const uriCache=new Map(),imagePaths=new Map();
  const replacements=new Map();
  const readSetting=async key=>{
    const {value}=await Preferences.get({key});
    try {return value&&JSON.parse(value);}catch{return undefined;}
  };
  const saveSetting=(key,value)=>Preferences.set({key,value:JSON.stringify(value)});
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
      throw Error('路径不在当前 Vault 内。');
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
    return entries.filter(entry=>visible(entry.name))
      .sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
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
          if(parent.depth===32)throw Error('Vault 目录层级超过 32 层。');
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
    if(dir){
      if(dirname(dir)!==base||!(await io.stat(dir)).isDirectory())throw Error('找不到此 Vault。');
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
    return {root,tree:rows,retained:retained.filter(path=>dir&&within(dir,path)),initialFiles:flat(rows).filter(row=>markdown.test(row.path)).slice(0,1).map(row=>row.path)};
  }
  async function vaults() {
    await io.mkdir(base,{recursive:true});
    return (await io.readdir(base,{withFileTypes:true})).filter(item=>item.isDirectory()&&visible(item.name))
      .map(item=>({path:posixPath(base,item.name),name:item.name})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
  }
  async function vaultPath(path) {
    const dir=posixPath(path);
    if(dirname(dir)!==base||!visible(basename(dir))||!(await io.stat(dir)).isDirectory())throw Error('找不到此知识库。');
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
        if(entry.name!==basename(entry.name)||entry.name==='.'||entry.name==='..')throw Error('旧 Vault 包含无效路径。');
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
        storageWarning='部分旧知识库无法迁移，公开目录中的原件仍保留。'+String(error.message||error);
      }
      if(storageWarning)return;
      await saveSetting('androidPrivateVaults',true);
    }catch(error){
      storageWarning='旧 Vault 无法迁移到应用私有空间，公开目录中的原件仍保留。'+String(error.message||error);
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
    if(!visible(label))throw Error('此名称由应用保留，请使用其他名称。');
    return posixPath(base,label);
  };
  async function createVault(name,withWelcome=false) {
    const dir=newVaultPath(name);
    await io.mkdir(dir);
    if(withWelcome)await io.writeFile(posixPath(dir,'欢迎使用 Calcite.md'),welcome);
    return dir;
  }
  async function read(path) {
    const file=scoped(path);
    if(!extension.test(file))throw Error('请选择 Markdown 或 Canvas 文件。');
    const load=async()=>{
      const stat=await io.stat(file);
      const raw=await io.readFile(file,'utf8'),text=normalizeLineEndings(file,raw);
      return {text,mtime:stat.mtimeMs,needsLf:text!==raw};
    };
    try{return await load();}
    catch(error){
      const replacing=replacements.get(file);
      if(error.code!=='ENOENT'||!replacing)throw error;
      await replacing;
      return load();
    }
  }
  async function atomicWrite(file,data) {
    const temp=posixPath(dirname(file),'.calcite-'+randomId()+'.tmp');
    try {
      await io.writeFile(temp,data);
      try {await io.rename(temp,file);}
      catch(error) {
        if(error.code!=='EEXIST'||!(await fs.exists(file))?.isFile())throw error;
        const backup=posixPath(dirname(file),'.calcite-backup-'+basename(file));
        let done;
        replacements.set(file,new Promise(resolve=>{done=resolve;}));
        try{
          await io.rename(file,backup);
          try {await io.rename(temp,file);}
          catch(error){await io.rename(backup,file);throw error;}
          await io.unlink(backup).catch(error=>{if(error.code!=='ENOENT')console.warn(error);});
        }finally{done();replacements.delete(file);}
      }
    } catch(error){await io.unlink(temp).catch(()=>{});throw error;}
  }
  async function save({path,name,text,saved,mtime,saveAs}) {
    if(path&&!saveAs) {
      const previous=await fs.exists(scoped(path));
      if(!previous)return {conflict:true};
      const disk=normalizeLineEndings(path,await io.readFile(path,'utf8'));
      if(typeof mtime==='number'&&disk!==normalizeLineEndings(path,saved??''))
        return {conflict:true,text:disk,mtime:previous.mtimeMs};
    } else {
      const label=validName(noteName(name||'未命名.md'));
      path=scoped(posixPath(root,label));
      if(await fs.exists(path)) {
        const ext=label.match(extension)[0];
        let count=2;
        do {path=scoped(posixPath(root,label.slice(0,-ext.length)+' '+(count++)+ext));}
        while(await fs.exists(path));
      }
    }
    text=normalizeLineEndings(path,text);
    await atomicWrite(path,text);
    const info=await io.stat(path);
    revision++;
    if(markdown.test(path)){
      const item=indexEntry(path,info);
      index.observe(path,item,{item,text});
    }
    localGit.schedule(root,path);
    return {path,mtime:info.mtimeMs};
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
      await trash(from);
      await localGit.schedule(root);
      return {tree:await tree()};
    }
    if(!['move','rename'].includes(type))throw Error('未知文件操作。');
    const label=type==='move'?basename(from):validName(info.isDirectory()?name:noteName(name,basename(from).match(extension)?.[0]||'.md'));
    const to=scoped(posixPath(type==='move'?scoped(parent,true):dirname(from),label));
    if(to===from)return {path:to,tree:await tree(),changes:[]};
    if(await fs.exists(to)||within(from,to))throw Error('目标位置不可用或已存在。');
    await index.refresh();
    const {changes,refactor}=await planLinkRefactor(index,from,to,drafts,async file=>{
      const {mtimeMs}=await io.stat(scoped(file));
      return {text:await io.readFile(file,'utf8'),mtime:mtimeMs};
    });
    for(const change of changes){
      if(await io.readFile(change.from,'utf8')!==change.previous)throw Error('笔记已在别处修改，请重试。');
    }
    const written=[];
    await io.rename(from,to);
    try{
      for(const change of changes){
        if(change.saved!==change.previous){
          if(await io.readFile(change.path,'utf8')!==change.previous)throw Error('笔记已在别处修改，请重试。');
          await atomicWrite(change.path,change.saved);
          written.push(change);
        }
        change.mtime=(await io.stat(change.path)).mtimeMs;
      }
    }catch(error){
      const rollback=await Promise.allSettled(written.map(change=>atomicWrite(change.path,change.previous)));
      try{await io.rename(to,from);}
      catch(failure){throw Error(error.message+'。文件移动回滚失败：'+failure.message);}
      if(rollback.some(row=>row.status==='rejected'))throw Error(error.message+'。部分引用回滚失败。');
      throw error;
    }
    revision++;
    uriCache.clear();imagePaths.clear();
    localGit.schedule(root,...written.map(change=>change.path));
    return {path:to,tree:await tree(),refactor,changes:changes.map(({previous,...row})=>({
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
    if(!file)throw Error('本地图片路径无效。');
    const path=scoped(file);
    return {path,bytes:await io.readFile(path)};
  }
  async function attach({note,strategy,directory,mime,bytes}) {
    if(!Object.hasOwn(attachmentTypes,mime)||!bytes?.length||bytes.length>32*1024*1024)
      throw Error('请选择小于 32 MiB 的受支持图片。');
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
    for(const row of await index.workspaceNotes('attachments',drafts))for(const ref of markdownImages(row.text)) {
      const target=await resolveImage(row.path,ref.destination,ref.wiki);
      if(target)used.add(target);
    }
    for(const canvas of flat(rows).filter(entry=>/\.canvas$/i.test(entry.path))){
      const content=JSON.parse(await io.readFile(canvas.path,'utf8'));
      if(!Array.isArray(content.nodes))throw Error('有画布格式无效，请修复后再清理附件。');
      for(const node of content.nodes){
        if(typeof node.file!=='string')continue;
        const target=await resolveImage(canvas.path,node.file,true);
        if(target)used.add(target);
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
    if(data.length>Math.ceil(32*1024*1024/3)*4)throw Error('剪贴板图片超过 32 MiB。');
    return new File([fromBase64(data)],'图片.'+attachmentTypes[type],{type});
  }
  return {
    type:'capacitor',os:Capacitor.getPlatform(),
    fs:{open:empty,read,save:data=>serialize(()=>save(data)),release:noop,reveal:unavailable,revealImage:unavailable,
      attachment:data=>serialize(()=>attach(data)),imageSource,history:(path,id)=>localGit.history(root,path,id)},
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
        next ||= await createVault('我的笔记',true);
        const {initialFiles}=await mount(next,[],restored&&selected!==normalized?selected:undefined);
        const session=restoreSession(await readSetting('session'));
        return {root,config:{session,features:await readSetting('features')},initialFiles:
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
        if(await fs.exists(dir))throw Error('已有同名知识库。');
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
        const replacement=next||await createVault(dir===posixPath(base,'我的笔记')?'我的笔记 2':'我的笔记');
        // Move the directory out of the vault list before recursive removal.
        const removed=posixPath(base,'.deleted-'+randomId());
        await io.rename(dir,removed);
        let result;
        try{result=dir===root?await mount(replacement,retained):{root,tree:await tree(),retained};}
        catch(error){await io.rename(removed,dir);throw error;}
        const cleanup=await Promise.allSettled([localGit.remove(dir),io.rmdir(removed,{recursive:true})]);
        return {...result,deletedVault:dir,warning:cleanup.some(item=>item.status==='rejected')?
          '知识库已移除，部分本机数据清理失败。':''};
      }),
      tree:()=>tree(),edit:update=>serialize(()=>edit(update)),
      async listCanvases(){return (await io.readdir(root)).filter(name=>/\.canvas$/i.test(name));},
      async readCanvas(name){const {text}=await read(posixPath(root,validName(name)));return {text,version:text};},
      saveCanvas:({name,board,version})=>serialize(async()=>{
        const file=scoped(posixPath(root,noteName(validName(name),'.canvas')));
        const text=JSON.stringify(board,null,2);
        if(version!==undefined&&(await read(file)).text!==version)throw Error('画布已在别处修改，请重新打开。');
        if(version===undefined&&await fs.exists(file))throw Error('同名画布已存在。');
        await atomicWrite(file,text);localGit.schedule(root,file);
        return {name:basename(file),version:text};
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
      for(const path of paths)if(!allowed.has(path))throw Error('附件引用已变化，请重新扫描。');
      for(const path of new Set(paths))await trash(scoped(path));
      if(paths.length)await localGit.schedule(root);
      return paths.length;
    })},
    sync:localGit.api,
    clipboard:{writeText:string=>Clipboard.write({string}),readText:async()=>(await Clipboard.read()).value,readImage:clipboardImage},
    preferences:{saveSession:value=>saveSetting('session',value),saveFeatures:value=>saveSetting('features',value)},
    window:{control:unavailable,setAppearance:async()=>({material:'css'}),discard:async()=>confirm('丢弃未保存的修改？'),
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
      back:listener=>App.addListener('backButton',listener)}
  };
}
