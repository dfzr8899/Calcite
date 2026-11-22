import { Buffer } from 'buffer';
import {fsError,posixPath} from '../../shared/core/vault-paths.mjs';
export {fsError,posixPath};

export const dirname = path => path.slice(0,path.lastIndexOf('/')) || '/';
export const basename = path => path.split('/').at(-1);

export function vaultStoragePath(value) {
  if(typeof value!=='string'||!value)return '';
  try {
    const path=value.startsWith('file://')?decodeURIComponent(new URL(value).pathname):value;
    return posixPath(path).replace(/^\/(?:.*\/)?Documents(?=\/CalciteVaults\/)/i,'');
  }catch{return '';}
}

// Multiples of three bytes and four characters keep each base64 chunk aligned.
const block = 3*8192;
export function toBase64(bytes) {
  if (typeof bytes==='string') bytes=new TextEncoder().encode(bytes);
  const chunks=[];
  for(let start=0;start<bytes.byteLength;start+=block)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(start,start+block))));
  return chunks.join('');
}
export function fromBase64(encoded) {
  const size=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
  const bytes=new Uint8Array(size);
  for(let start=0,offset=0;start<encoded.length;start+=block/3*4) {
    const chunk=atob(encoded.slice(start,start+block/3*4));
    for(let index=0;index<chunk.length;index++) bytes[offset++]=chunk.charCodeAt(index);
  }
  return bytes;
}

export function createCapacitorGitFs(filesystem,directory='DOCUMENTS',{sandboxed=false}={}) {
  const args=path=>({path:posixPath(path).slice(1),directory});
  let session;
  function invalidate(path,subtree=false) {
    if(!session)return;
    const file=posixPath(path);
    for(const cache of [session.stats,session.dirs]){
      cache.delete(file);
      if(subtree)for(const key of cache.keys())if(key.startsWith(file+'/'))cache.delete(key);
    }
    for(let parent=dirname(file);parent!=='/';parent=dirname(parent)){
      session.stats.delete(parent);
      session.dirs.delete(parent);
    }
    session.dirs.delete('/');
  }
  async function withSession(task) {
    if(session)return task();
    session={stats:new Map(),dirs:new Map()};
    try{return await task();}finally{session=undefined;}
  }
  async function call(method,path,extra) {
    try {return await filesystem[method]({...args(path),...extra});}
    catch(error) {
      const message=String(error.message||error);
      const code=/^E[A-Z]+$/.test(error.code||'')?error.code:
        /not a directory|parent.*file|only directories are supported/i.test(message)?'ENOTDIR':
        /is a directory|not supported for directories/i.test(message)?'EISDIR':
        /already exists|OS-PLUG-FILE-0010/i.test(message+' '+error.code)?'EEXIST':
        /does not exist|not found|no such file|OS-PLUG-FILE-00(?:08|11)/i.test(message+' '+error.code)?'ENOENT':
        /permission denied|access denied|not permitted|EACCES|EPERM|OS-PLUG-FILE-0007/i.test(message+' '+error.code)?'EACCES':
        /no space|disk full|ENOSPC/i.test(message)?'ENOSPC':
        /not empty|OS-PLUG-FILE-0012/i.test(message+' '+error.code)?'ENOTEMPTY':'EIO';
      throw fsError(code,path,error);
    }
  }
  async function freshStat(path) {
    if (posixPath(path)==='/') return wrapStat({type:'directory'});
    let info;
    try {info=await call('stat',path);}
    catch(error) {
      if(error.code!=='ENOENT'||sandboxed)throw error;
      const parent=dirname(posixPath(path));
      if(!(await stats(parent)).isDirectory())throw fsError('ENOTDIR',path);
      throw error;
    }
    return wrapStat(info);
  }
  function stats(path) {
    if(!session)return freshStat(path);
    const key=posixPath(path),cache=session.stats;
    if(!cache.has(key)){
      const pending=freshStat(path).catch(error=>{
        if(cache.get(key)===pending)cache.delete(key);
        throw error;
      });
      cache.set(key,pending);
    }
    return cache.get(key);
  }
  function wrapStat(info) {
    const dir=info.type==='directory';
    const mtimeMs=info.mtime||0, ctimeMs=info.ctime||mtimeMs;
    return {type:info.type,size:info.size||0,mode:dir?0o40755:0o100644,mtimeMs,ctimeMs,
      mtime:new Date(mtimeMs),ctime:new Date(ctimeMs),uid:0,gid:0,ino:0,dev:0,
      isDirectory:()=>dir,isFile:()=>!dir,isSymbolicLink:()=>false};
  }
  async function exists(path) {
    try {return await stats(path);}
    catch(error) {if(error.code!=='ENOENT')throw error;}
  }
  async function ensureDirectory(path) {
    if(!(await stats(path)).isDirectory())throw fsError('ENOTDIR',path);
  }
  async function ensureFile(path) {
    if((await stats(path)).isDirectory())throw fsError('EISDIR',path);
  }
  const promises={
    stat:stats,lstat:stats,
    async readlink(path) {await stats(path);throw fsError('EINVAL',path);},
    async symlink(_,path) {throw fsError('ENOTSUP',path);},
    async readFile(path,options) {
      if(!sandboxed)await ensureFile(path);
      const {data}=await call('readFile',path);
      const bytes=typeof data==='string'?fromBase64(data):new Uint8Array(await data.arrayBuffer());
      const result=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      const encoding=typeof options==='string'?options:options?.encoding;
      return encoding?result.toString(encoding):result;
    },
    async writeFile(path,data,options) {
      if(!sandboxed)await ensureDirectory(dirname(posixPath(path)));
      const existing=!sandboxed||options?.flag?.includes('x')?await exists(path):null;
      if(existing?.isDirectory())throw fsError('EISDIR',path);
      if(existing&&options?.flag?.includes('x'))throw fsError('EEXIST',path);
      const encoding=typeof options==='string'?options:options?.encoding;
      const bytes=typeof data==='string'?Buffer.from(data,encoding):data;
      await call('writeFile',path,{data:toBase64(bytes)});
      invalidate(path);
    },
    async unlink(path) {
      if(!sandboxed)await ensureFile(path);
      await call('deleteFile',path);
      invalidate(path);
    },
    async readdir(path,options) {
      if(!sandboxed)await ensureDirectory(path);
      const key=posixPath(path),active=session;
      let rows=active?.dirs.get(key);
      if(!rows){
        rows=(await call('readdir',path)).files.map(info=>({name:info.name,...wrapStat(info)}));
        if(active===session&&active){
          active.dirs.set(key,rows);
          for(const row of rows)active.stats.set(posixPath(key,row.name),row);
        }
      }
      return options?.withFileTypes?rows:rows.map(row=>row.name);
    },
    async mkdir(path,options) {
      if(sandboxed&&options?.recursive) {
        if(posixPath(path)==='/')return;
        try{await call('mkdir',path,{recursive:true});}
        catch(error){if(error.code!=='EEXIST'||!(await stats(path)).isDirectory())throw error;}
        invalidate(path);
        return;
      }
      const existing=await exists(path);
      if(existing) {
        if(options?.recursive&&existing.isDirectory())return;
        throw fsError('EEXIST',path);
      }
      if(!options?.recursive)await ensureDirectory(dirname(posixPath(path)));
      await call('mkdir',path,{recursive:Boolean(options?.recursive)});
      invalidate(path);
    },
    async rmdir(path,options) {
      await ensureDirectory(path);
      if(!options?.recursive&&(await promises.readdir(path)).length)throw fsError('ENOTEMPTY',path);
      await call('rmdir',path,{recursive:Boolean(options?.recursive)});
      invalidate(path,true);
    },
    async rename(from,to) {
      if(!sandboxed){await stats(from);await ensureDirectory(dirname(posixPath(to)));}
      await call('rename',from,{from:args(from).path,to:args(to).path,toDirectory:directory});
      invalidate(from,true);
      invalidate(to,true);
    }
  };
  return {promises,exists,withSession,freshStat};
}
