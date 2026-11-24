const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {t:tr}=require('../shared/i18n/index.mjs');
const {normalizeLineEndings}=require('../shared/text-files.mjs');
const {createActivityLog}=require('../shared/core/activity-log.mjs');
const {atomicWriteFile,syncDirectory,within,key}=require('./workspace.cjs');
const missing=error=>error.code==='ENOENT';
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

function refactorText(bytes) {
  try{return decoder.decode(bytes);}
  catch{throw Error(tr('dataSafety.invalidUtf8'));}
}

async function readSnapshot(file,limit) {
  const handle=await fs.open(file,'r');
  try{
    for(let attempt=0;attempt<3;attempt++){
      const before=await handle.stat();
      if(!before.isFile()||before.size>limit)throw Error(tr('main.theDocumentIsInvalidOrExceedsThe'));
      const bytes=Buffer.alloc(before.size+1);
      const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
      const after=await handle.stat(),current=await fs.stat(file);
      if(bytesRead!==before.size||after.ctimeMs!==before.ctimeMs||after.mtimeMs!==before.mtimeMs||
        current.ino!==after.ino||current.dev!==after.dev||current.ctimeMs!==after.ctimeMs)continue;
      const content=bytes.subarray(0,bytesRead),raw=content.toString('utf8'),text=normalizeLineEndings(file,raw);
      return {raw,text,mtime:after.mtimeMs,needsLf:raw!==text,
        snapshot:{mtimeMs:after.mtimeMs,size:content.length,hash:createHash('sha256').update(content).digest('hex')}};
    }
    throw Error(tr('dataSafety.unstableFile'));
  }finally{await handle.close();}
}

function activityFor(root,archive,onRecoverFailure) {
  async function safe(file) {
    if(typeof file!=='string'||file.includes('\0')||file!==path.resolve(file)||!within(root,file)||
      (process.platform==='win32'&&file.slice(path.parse(file).root.length).includes(':')))
      throw Error(tr('dataSafety.invalidJournal'));
    for(let parent=file;parent!==root;parent=path.dirname(parent)){
      const info=await fs.lstat(parent).catch(error=>{if(!missing(error))throw error;return null;});
      if(info?.isSymbolicLink())throw Error(tr('dataSafety.invalidJournal'));
      // realpath catches junctions and other path redirections, including ancestors.
      if(info){
        if(key(await fs.realpath(parent))!==key(parent))throw Error(tr('dataSafety.invalidJournal'));
        break;
      }
    }
    return file;
  }
  return createActivityLog(root,{io:fs,path,safe,key,write:atomicWriteFile,flush:syncDirectory,
    archive,onRecoverFailure,id:randomUUID,hash:value=>createHash('sha256').update(value).digest('hex'),
    async sameFile(from,to){
      const [left,right]=await Promise.all([fs.stat(from,{bigint:true}),fs.stat(to,{bigint:true})]);
      return left.ino===right.ino&&left.dev===right.dev;
    },
    async linkMove(from,to){
      await fs.link(from,to);
      await syncDirectory(path.dirname(to));
      await fs.unlink(from);
      await syncDirectory(path.dirname(from));
    },
    async rename(from,to){
      await fs.rename(from,to);
      await syncDirectory(path.dirname(from));
      if(path.dirname(to)!==path.dirname(from))await syncDirectory(path.dirname(to));
    }});
}

module.exports={readSnapshot,refactorText,activityFor};
