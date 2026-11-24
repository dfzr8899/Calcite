const {t:tr}=require("../shared/i18n/index.mjs");
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {key,markdown,within,atomicWrite}=require('./workspace.cjs');
const {documentType}=require('./ipc-schema.cjs');
const {entry,tracked}=require('./watcher.cjs');
const {MAX_NOTE}=require('./ipc-schema.cjs');

const {VaultIndex:SharedIndex,SEARCH_LIMIT,CACHE_LIMIT,CACHE_DIRECTORY,CACHE_FILE}=require('../shared/core/vault-index.mjs');
const digest=text=>createHash('sha256').update(text).digest('hex');

async function readNote(root,file,known,signal) {
  if (signal?.aborted) return null;
  const item=known??await entry(root,file);
  if (!item || item.row.children || signal?.aborted) return null;
  const handle=await fs.open(file,'r').catch(error=>{
    if (!['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(error.code)) throw error;
  });
  if (!handle) return null;
  try {
    const stat=await handle.stat();
    const signature=[stat.ino,stat.birthtimeMs,stat.mtimeMs,stat.ctimeMs,stat.size].join(':');
    if (!stat.isFile() || signature!==item.signature || signal?.aborted) return null;
    if (item.size<=MAX_NOTE) {
      const text=await handle.readFile('utf8');
      return {item,text,hash:digest(text)};
    }
    const bytes=Buffer.alloc(SEARCH_LIMIT);
    const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    return {item,text:bytes.toString('utf8',0,bytesRead),truncated:true};
  } finally {await handle.close();}
}

const inaccessible=error=>['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(error.code);

async function cachePath(root,create=false) {
  const dir=path.join(root,CACHE_DIRECTORY);
  if(create)await fs.mkdir(dir).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const stat=await fs.lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||path.relative(dir,await fs.realpath(dir)))throw Error(tr("indexService.invalidIndexCacheDirectory"));
  return path.join(dir,CACHE_FILE);
}

class VaultIndex extends SharedIndex {
  constructor(root,signal) {
    super(root,{path,key,within,generation:randomUUID(),signal,read:(file,item)=>readNote(root,file,item,signal),
      async readCache(){
        const file=await cachePath(root);
        const stat=await fs.lstat(file);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>CACHE_LIMIT)return '';
        return fs.readFile(file,'utf8');
      },
      async writeCache(text){
        if(signal?.aborted)return;
        const file=await cachePath(root,true);
        await fs.writeFile(path.join(path.dirname(file),'.gitignore'),'*\n',{flag:'wx'}).catch(error=>{
          if(error.code!=='EEXIST')throw error;
        });
        if(!signal?.aborted)await atomicWrite(file,text);
      }});
  }

  async scan(onRow=()=>{}) {
    const walk=async dir=>{
      if(this.signal?.aborted)return;
      const children=await fs.readdir(dir,{withFileTypes:true}).catch(error=>{
        if(!inaccessible(error))throw error;
        return [];
      });
      const allowed=children.filter(item=>!item.isSymbolicLink()&&(item.isDirectory()||item.isFile()&&documentType.test(item.name)));
      for(let start=0;start<allowed.length&&!this.signal?.aborted;start+=48){
        const batch=allowed.slice(start,start+48);
        const entries=await Promise.all(batch.map(item=>entry(this.root,path.join(dir,item.name))));
        for(const item of entries){
          if(!item||this.signal?.aborted)continue;
          onRow(item.row);
          if(item.row.children)await walk(item.row.path);
          else this.observe(item.row.path,item);
        }
      }
    };
    await walk(this.root);
  }

  async build(onRow){
    await this.scan(onRow);
    await this.refresh();
    await this.flushCache();
  }
}

module.exports={VaultIndex,readNote,digest};

