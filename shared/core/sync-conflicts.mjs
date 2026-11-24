import {t as tr} from "../i18n/index.mjs";
const conflictName=/^(.*) \((?:同步冲突|conflict) \d{4}-\d\d-\d\d \d{4}(?: \d+)?\)(\.[^/]+)?$/;
const missing=error=>error.code==='ENOENT'||error.code==='ENOTDIR';

export function conflictCopyName(relative,extension,stamp,serial=0) {
  return relative.slice(0,relative.length-extension.length)+
    ` (conflict ${stamp}${serial?' '+serial:''})`+extension;
}

/** @import {ConflictItem} from './types.mjs' */
/** @param {ConflictItem[]} previous @param {ConflictItem[]} incoming */
export function rememberConflicts(previous,incoming) {
  return [...new Map([...previous,...incoming].map(row=>[row.copy||row.path,row])).values()].slice(-100);
}

/** @param {ConflictItem[]} previous */
export async function findConflicts(engine,previous,io,join,{all=false}={}) {
  const current=[];
  for(const row of previous) {
    if(!row.copy||await io.stat(await engine.guard.safe(row.copy)).then(()=>true,error=>{
      if(!missing(error))throw error;
      return false;
    }))current.push(row);
  }
  const files=(all?null:engine.legacyCandidates)??(await engine.worktree()).keys();
  for(const file of files) {
    const parts=file.match(conflictName);
    if(!parts)continue;
    const copy=join(engine.root,file);
    if(await io.stat(await engine.guard.safe(copy)).then(stat=>stat.isFile(),error=>{
      if(!missing(error))throw error;
      return false;
    }))current.push({path:join(engine.root,parts[1]+(parts[2]||'')),copy});
  }
  return all?[...new Map(current.map(row=>[row.copy||row.path,row])).values()]:rememberConflicts([],current);
}

export async function readConflictFile(engine,file,io) {
    if(!file)return {text:'',missing:true};
    const target=await engine.workspaceFile(file);
    try{
      const stat=await io.stat(target);
      if(!stat.isFile()||stat.size>50*1024*1024)throw Error(tr("syncConflicts.invalidFileTypeOrFileLargerThan"));
      const bytes=await io.readFile(target);
      let text;
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error(tr("syncConflicts.thisConflictContainsABinaryFileA"));}
      if(text.includes('\0'))throw Error(tr("syncConflicts.thisConflictContainsABinaryFileA"));
      return {text,mtime:stat.mtimeMs};
    }catch(error){if(!missing(error))throw error;return {text:'',missing:true};}
}

export async function readConflict(engine,row,io) {
  const [local,incoming]=await Promise.all([readConflictFile(engine,row.path,io),readConflictFile(engine,row.copy,io)]);
  return {local,incoming};
}

/**
 * @param {ConflictItem} row
 * @param {'apply'|'keep'|'archive'} choice
 * @param {{io: {readFile(path: string): Promise<Uint8Array>, unlink(path: string): Promise<void>}, write(path: string, bytes: Uint8Array): Promise<void>, archive(path: string): Promise<unknown>, beforeWrite?: (rows: {file: string, next: Uint8Array|null, previous: Uint8Array|null}[]) => void|Promise<void>}} hooks
 */
export async function resolveConflict(engine,row,choice,hooks) {
  const {io,write,archive,beforeWrite=()=>{}}=hooks;
  const file=await engine.guard.safe(row.path);
  const copy=row.copy&&await engine.guard.safe(row.copy);
  const read=path=>io.readFile(path).catch(error=>{if(missing(error))return null;throw error;});
  const rows=[];
  if(choice==='apply') {
    const next=copy?await read(copy):null;
    if(copy&&!next)throw Error(tr("syncConflicts.theConflictCopyMovedRefreshTheList"));
    const previous=await read(file);
    if(previous||next)rows.push({file,next,previous});
  }
  if(copy)rows.push({file:copy,next:null,previous:await read(copy)});
  await beforeWrite(rows);
  const update=async(row,value)=>{
    if(value)await write(row.file,value);
    else await io.unlink(row.file).catch(error=>{if(!missing(error))throw error;});
  };
  const changed=rows.find(row=>row.file===file);
  if(copy&&rows.at(-1).previous)
    await engine.history.record(file,rows.at(-1).previous,'legacy',copy);
  if(changed?.previous)
    await engine.history.record(file,changed.previous,'adopt',copy||file);
  if(changed)await update(changed,changed.next);
  try{if(copy&&rows.at(-1).previous)await archive(copy);}
  catch(error){if(changed)await update(changed,changed.previous);throw error;}
  return rows;
}
