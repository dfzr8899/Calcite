import {Buffer} from 'buffer';
import {t as tr} from '../i18n/index.mjs';
import {refactorJournal} from './refactor-journal.mjs';

const maxSnapshots=20, maxBytes=50*1024*1024;
const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
const validTypes=new Set(['rename','move','trash','restore','undo','recovery']);
const validFileRow=row=>Boolean(row)&&typeof row==='object'&&!Array.isArray(row)&&
  (row.from===null||typeof row.from==='string')&&
  (row.path===null||typeof row.path==='string')&&
  (row.count===null||(typeof row.count==='number'&&Number.isFinite(row.count)))&&
  typeof row.written==='boolean';
const validEntry=row=>Boolean(row)&&typeof row==='object'&&!Array.isArray(row)&&
  typeof row.id==='string'&&row.id.length>0&&
  validTypes.has(row.type)&&
  typeof row.time==='number'&&Number.isFinite(row.time)&&
  (row.from===null||typeof row.from==='string')&&
  (row.to===null||typeof row.to==='string')&&
  Array.isArray(row.files)&&row.files.every(validFileRow)&&
  typeof row.undoable==='boolean';
const validSnapshotRow=row=>Boolean(row)&&typeof row==='object'&&!Array.isArray(row)&&
  typeof row.from==='string'&&typeof row.path==='string'&&
  typeof row.bytes==='string'&&typeof row.hash==='string';
const missing=error=>error.code==='ENOENT';
const unavailable=()=>Error(tr('activity.undoUnavailable'));

/** Hosts supply scoped filesystem operations, a SHA-256 digest and an atomic writer. */
export function createActivityLog(root,host) {
  const {io,path,safe,write,rename=io.rename,key=file=>file,hash,id,archive}=host;
  const cache=path.join(root,'.calcite');
  const logFile=path.join(cache,'activity-log.json');
  const snapshots=path.join(cache,'undo-snapshots');
  const trash=path.join(cache,'trash');
  const snapshotFile=id=>path.join(snapshots,id+'.json');
  const trashDir=id=>path.join(trash,id);
  const payload=id=>path.join(trashDir(id),'payload');
  const notFound=error=>{if(!missing(error))throw error;return null;};
  const stat=async file=>io.lstat(await safe(file)).catch(notFound);
  const bytes=async file=>Buffer.from(await io.readFile(await safe(file)));
  const load=async (file,fallback=null)=>{
    const raw=await bytes(file).catch(notFound);
    if(raw===null)return fallback;
    try{return JSON.parse(raw.toString('utf8'));}
    catch{return fallback;}
  };
  const listDir=async dir=>(await io.readdir(await safe(dir),{withFileTypes:true}).catch(notFound))??[];
  const relative=file=>file.slice(root.length).replace(/^[\\/]/,'').replaceAll('\\','/');
  function absolute(file) {
    const parts=typeof file==='string'?file.split('/'):[];
    if(!parts.length||parts.some(part=>!part||part==='.'||part==='..'||/[\\:\0]/.test(part)||
      /^\.(?:git|calcite|trash)$/i.test(part)))throw Error(tr('activity.invalidPath'));
    return path.join(root,...parts);
  }
  const writeJson=async (file,data)=>write(await safe(file),JSON.stringify(data));
  const unlink=async file=>io.unlink(await safe(file)).catch(notFound);
  async function quarantineLog() {
    const target=path.join(cache,'activity-log-corrupt-'+Date.now()+'-'+id().slice(0,8)+'.json');
    try{
      await rename(await safe(logFile),await safe(target));
      return target;
    }catch{
      await removeTree(logFile).catch(()=>{});
      return null;
    }
  }
  async function entries() {
    const info=await stat(logFile);
    if(!info)return [];
    if(!info.isFile()){
      await quarantineLog();
      return [];
    }
    const raw=await bytes(logFile).catch(notFound);
    if(raw===null)return [];
    let parsed;
    try{parsed=JSON.parse(raw.toString('utf8'));}
    catch{
      await quarantineLog();
      return [];
    }
    if(!Array.isArray(parsed)){
      await quarantineLog();
      return [];
    }
    const valid=parsed.filter(validEntry);
    if(valid.length!==parsed.length){
      await quarantineLog();
      if(valid.length)await writeJson(logFile,valid).catch(()=>{});
    }
    return valid;
  }
  const moved=(file,from,to)=>key(file)===key(from)||key(file).startsWith(key(from)+'/')?to+file.slice(from.length):file;
  const mapMoved=(file,from,to)=>absolute(moved(relative(file),relative(from),relative(to)));
  const logRow=(type,from,to,files,undoable=false)=>({
    id:id(),time:Date.now(),type,from,to,files,undoable,skippedUnchanged:true
  });

  async function prune(rows) {
    let size=0,count=0;
    const keep=new Set();
    for(const row of rows){
      if(!row.undoable||row.type==='trash'||!validId(row.id))continue;
      const saved=await stat(snapshotFile(row.id));
      if(!saved?.isFile()||count===maxSnapshots||size+saved.size>maxBytes)row.undoable=false;
      else {keep.add(row.id+'.json');size+=saved.size;count++;}
    }
    // Write the new retention state before dropping the referenced snapshots.
    await writeJson(logFile,rows);
    for(const item of await listDir(snapshots))
      if(item.isFile()&&validId(item.name.slice(0,-5))&&item.name.endsWith('.json')&&!keep.has(item.name))
        await unlink(path.join(snapshots,item.name)).catch(()=>{});
  }

  const journal=refactorJournal(root,{...host,async onCommit(plan,recovered){
    const entry=plan.metadata?.entry;
    try{
      const rows=await entries();
      if(entry&&!plan.rollback&&!rows.some(row=>row.id===entry.id)){
        const original=rows.find(row=>row.id===plan.metadata.undoes);
        if(original)original.undoable=false;
        rows.unshift(entry);
      }
      if(recovered){
        // Use the operation ID to avoid repeating a recovery record if the
        // process exits between publishing the log and removing the journal.
        const recoveryKey=entry?.id??hash(JSON.stringify([plan.from,plan.to,plan.changes]));
        if(!rows.some(row=>row.recoveryKey===recoveryKey))rows.unshift({
          ...logRow('recovery',relative(plan.rollback?plan.to:plan.from),relative(plan.rollback?plan.from:plan.to),
            entry?.files??plan.changes.map(row=>({from:relative(row.from),path:relative(row.path),count:null,written:!plan.rollback}))),
          recoveryKey,rolledBack:Boolean(plan.rollback)
        });
      }
      if(entry||recovered)await prune(rows.slice(0,50));
    }catch(error){
      if(recovered)throw error;
      if(entry)entry.undoable=false;
      console.warn('Activity log update failed after commit:',error);
    }
  }});

  async function walk(file,visit) {
    const info=await stat(file);
    if(!info)throw unavailable();
    if(info.isDirectory()){
      for(const item of await listDir(file))await walk(path.join(file,item.name),visit);
    }else await visit(file,info);
  }

  async function refactor(type,from,to,changes,staging) {
    const before=new Map(),files=new Map();
    let size=0,undoable=true;
    const add=async (file,target,info,change)=>{
      const from=relative(file),path=relative(target),written=Boolean(change&&change.previous!==change.saved);
      files.set(from,{from,path,count:written?change.count??0:0,written});
      size+=info.size;
      if(!undoable||!info.isFile()||size>maxBytes){undoable=false;return;}
      const original=await bytes(file);
      if(original.length!==info.size||written&&!original.equals(Buffer.from(change.previous)))throw Error(tr('dataSafety.refactorChanged'));
      before.set(from,{from,path,bytes:original.toString('base64'),hash:hash(written?Buffer.from(change.saved):original)});
    };
    const byFile=new Map(changes.map(row=>[key(row.from),row]));
    await walk(from,(file,info)=>add(file,mapMoved(file,from,to),info,byFile.get(key(file))));
    for(const change of changes)
      if(change.previous!==change.saved&&!files.has(relative(change.from))){
        const info=await stat(change.from);
        if(!info)throw Error(tr('dataSafety.refactorChanged'));
        await add(change.from,change.path,info,change);
      }
    const entry=logRow(type,relative(from),relative(to),[...files.values()],undoable);
    if(entry.undoable){
      const raw=JSON.stringify([...before.values()]);
      entry.undoable=Buffer.byteLength(raw)<=maxBytes;
      if(entry.undoable){
        await prepareDirectory(snapshots);
        await write(await safe(snapshotFile(entry.id)),raw);
      }
    }
    await journal.apply(from,to,changes,staging,{metadata:{entry}});
    return entry;
  }

  async function prepareDirectory(dir) {
    await journal.prepare();
    await io.mkdir(await safe(dir),{recursive:true});
    if(host.flush)for(let parent=dir;parent!==root;parent=path.dirname(parent))await host.flush(await safe(parent));
  }

  async function softDelete(file) {
    const files=[];
    await walk(file,source=>{const from=relative(source);files.push({from,path:null,count:0,written:false});});
    const entry=logRow('trash',relative(file),null,files,true);
    const target=payload(entry.id);
    entry.to=relative(target);
    await prepareDirectory(trashDir(entry.id));
    await writeJson(path.join(trashDir(entry.id),'entry.json'),entry);
    await journal.apply(file,target,[],undefined,{trash:entry.id,metadata:{entry}});
    return entry;
  }

  async function trashEntries() {
    const rows=[];
    for(const row of await listDir(trash)){
      if(!row.isDirectory()||!validId(row.name)||!await stat(payload(row.name)))continue;
      const entry=await load(path.join(trashDir(row.name),'entry.json'));
      if(validEntry(entry)&&entry.id===row.name&&entry.type==='trash'&&typeof entry.from==='string')rows.push(entry);
    }
    return rows.sort((a,b)=>b.time-a.time);
  }

  async function currentEntry(entryId) {
    if(!validId(entryId))throw unavailable();
    return (await entries()).find(row=>row.id===entryId)??(await trashEntries()).find(row=>row.id===entryId);
  }

  async function inspect(entryId) {
    const entry=await currentEntry(entryId);
    if(!entry?.undoable)throw unavailable();
    if(entry.type==='trash'){
      if(typeof entry.from!=='string'||!await stat(payload(entry.id)))throw unavailable();
      return {entry,changed:[],token:null};
    }
    if(typeof entry.from!=='string'||typeof entry.to!=='string')throw unavailable();
    const source=absolute(entry.to),target=absolute(entry.from);
    if(!await stat(source)||(key(source)!==key(target)&&await stat(target)))throw Error(tr('activity.undoOccupied'));
    const saved=await load(snapshotFile(entry.id));
    if(!Array.isArray(saved)||!saved.every(validSnapshotRow))throw unavailable();
    const byPath=new Map(saved.map(row=>[key(row.path),row]));
    const changed=[],fingerprints=[];
    await walk(source,async file=>{
      if(!byPath.has(key(relative(file))))throw Error(tr('activity.undoStructureChanged'));
    });
    for(const row of saved){
      const file=absolute(row.path);
      const info=await stat(file);
      if(!info?.isFile())throw Error(tr('activity.undoStructureChanged'));
      if(info.size>maxBytes)throw Error(tr('activity.undoStructureChanged'));
      const digest=hash(await bytes(file));
      fingerprints.push(digest);
      if(digest!==row.hash)changed.push(row.path);
    }
    return {entry,changed,token:hash(JSON.stringify([entry.id,fingerprints])),saved};
  }

  async function restore(entryId) {
    const {entry}=await inspect(entryId);
    if(entry.type!=='trash')throw unavailable();
    const from=payload(entry.id);
    const original=absolute(entry.from),parent=path.dirname(original);
    await io.mkdir(await safe(parent),{recursive:true});
    let target=original;
    const name=original.split(/[\\/]/).at(-1);
    const dot=(await stat(from)).isDirectory()?-1:name.lastIndexOf('.');
    const stem=dot<1?name:name.slice(0,dot),suffix=dot<1?'':name.slice(dot);
    for(let i=1;await stat(target);i++)
      target=path.join(parent,stem+(i===1?' (restored)':' (restored '+i+')')+suffix);
    const files=entry.files.map(file=>({...file,from:null,path:moved(file.from,entry.from,relative(target))}));
    const restored=logRow('restore',relative(from),relative(target),files);
    await journal.apply(from,target,[],undefined,{trash:entry.id,exclusive:Boolean(host.linkMove&&(await stat(from)).isFile()),metadata:{entry:restored,undoes:entry.id}});
    await removeTree(trashDir(entry.id)).catch(()=>{});
    return {from:null,path:target,activity:restored,affected:files.map(row=>({from:null,path:absolute(row.path)}))};
  }

  async function undo(entryId,token) {
    const state=await inspect(entryId),{entry,changed,saved}=state;
    if(entry.type==='trash')return restore(entryId);
    if(changed.length&&token!==state.token)return {confirmation:{changed,token:state.token}};
    const source=absolute(entry.to),target=absolute(entry.from);
    const changedSet=new Set(changed);
    const writes=[],affected=[];
    for(const row of saved){
      const from=absolute(row.path),path=absolute(row.from);
      const current=await bytes(from),digest=hash(current);
      if(digest!==row.hash&&!changedSet.has(row.path))throw Error(tr('dataSafety.refactorChanged'));
      const original=Buffer.from(row.bytes,'base64');
      if(changedSet.has(row.path))await archive(path,current);
      if(!current.equals(original))writes.push({from,path,previous:current.toString('base64'),saved:row.bytes});
      if(from!==path||!current.equals(original))affected.push({from,path});
    }
    if((await inspect(entryId)).token!==state.token)throw Error(tr('dataSafety.refactorChanged'));
    const changedWrites=new Set(writes.map(row=>key(row.path)));
    const undone=logRow('undo',entry.to,entry.from,entry.files.map(row=>({
      from:row.path,path:row.from,count:changedWrites.has(key(absolute(row.from)))&&!changedSet.has(row.path)?row.count:0,
      written:changedWrites.has(key(absolute(row.from)))
    })));
    const staging=key(source)===key(target)?path.join(path.dirname(source),'.calcite-tmp-'+id()):undefined;
    await journal.apply(source,target,writes,staging,{binary:true,
      exclusive:Boolean(!staging&&host.linkMove&&(await stat(source)).isFile()),metadata:{entry:undone,undoes:entry.id}});
    return {from:source,path:target,activity:undone,affected};
  }

  async function removeTree(file) {
    if((await stat(file))?.isDirectory()){
      for(const item of await listDir(file))await removeTree(path.join(file,item.name));
      await io.rmdir(await safe(file));
    }else await unlink(file);
  }

  async function emptyTrash() {
    const rows=await trashEntries();
    for(const row of rows)await removeTree(trashDir(row.id));
    for(const item of await listDir(trash))
      if(item.isDirectory()&&validId(item.name))await removeTree(trashDir(item.name)).catch(()=>{});
    if(!rows.length)return 0;
    const all=await entries(), removed=new Set(rows.map(row=>row.id));
    for(const row of all)if(removed.has(row.id))row.undoable=false;
    await prune(all);
    return rows.length;
  }

  return {refactor,softDelete,undo,restore,emptyTrash,recover:journal.recover,async list(){
    const bin=await trashEntries(), ids=new Set(bin.map(row=>row.id));
    return {entries:(await entries()).map(row=>row.type==='trash'?{...row,undoable:ids.has(row.id)}:row),trash:bin};
  }};
}
