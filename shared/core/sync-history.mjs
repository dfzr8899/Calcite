import {t as tr} from "../i18n/index.mjs";
import {sha1} from './sha.mjs';

const idPattern=/^sync-(\d{13})-(remote|local|legacy|restore|adopt|external|undo|saved)-([0-9a-f]{40})\.snapshot$/;
const labels={remote:"syncHistory.replacedByANewerRemoteEdit",local:"syncHistory.replacedByANewerLocalEdit",legacy:"syncHistory.archivedLegacyConflictCopy",
  external:"dataSafety.externalBackup",undo:"activity.undoBackup",saved:"syncHistory.localVersionSnapshot",restore:"syncHistory.noteBeforeRestoringAVersion",adopt:"syncHistory.noteBeforeAdoptingAConflictCopy"};
const hash=value=>sha1(value);
const MAX_SNAPSHOTS_PER_FILE=50;
export const isSyncVersion=id=>idPattern.test(id);

/** @param {{root: string, key?: (path: string) => string, join: (...parts: string[]) => string, safe: (path: string) => Promise<string>, fs: import('isomorphic-git').PromiseFsClient['promises'], write: (path: string, bytes: Uint8Array) => Promise<void>, maxPerFile?: number}} options */
export function createSyncHistory({root,key=value=>value,join,safe,fs,write,maxPerFile=MAX_SNAPSHOTS_PER_FILE}) {
  const missing=error=>error.code==='ENOENT'||error.code==='ENOTDIR';
  const folder=file=>safe(join(root,'.calcite','sync-history',hash(key(file))));
  async function pruneDir(dir) {
    if(!fs.unlink)return;
    const names=(await fs.readdir(dir).catch(error=>{if(!missing(error))throw error;return [];}))
      .filter(id=>idPattern.test(id))
      .sort((a,b)=>Number(idPattern.exec(b)[1])-Number(idPattern.exec(a)[1])||b.localeCompare(a));
    for(const stale of names.slice(maxPerFile))
      await fs.unlink(await safe(join(dir,stale))).catch(error=>{if(!missing(error))throw error;});
  }
  async function list(file) {
    await safe(file);
    const dir=await folder(file);
    const names=await fs.readdir(dir).catch(error=>{if(!missing(error))throw error;return [];});
    return names.flatMap(id=>{
      const match=idPattern.exec(id);
      return match?[{id,time:Number(match[1]),label:['external','undo','saved'].includes(match[2])?tr(labels[match[2]]):tr("syncHistory.automaticSyncBackup")+' '+tr(labels[match[2]])}]:[];
    }).sort((a,b)=>b.time-a.time||b.id.localeCompare(a.id));
  }
  return {
    list,
    async record(file,bytes,reason,identity){
      const digest=hash(identity+'\0'+hash(bytes));
      const existing=await list(file);
      const previous=existing.find(row=>row.id.endsWith('-'+reason+'-'+digest+'.snapshot'));
      if(previous)return previous.id;
      const dir=await folder(file);
      const id='sync-'+Date.now()+'-'+reason+'-'+digest+'.snapshot';
      await fs.mkdir(dir,{recursive:true});
      await write(await safe(join(dir,id)),bytes);
      if(existing.length>=maxPerFile)await pruneDir(dir);
      return id;
    },
    async read(file,id) {
      await safe(file);
      if(!isSyncVersion(id))throw Error(tr("syncHistory.syncSnapshotNotFound"));
      return fs.readFile(await safe(join(await folder(file),id)));
    },
    async relocate(from,to) {
      if(key(from)===key(to))return;
      const source=await folder(from),target=await folder(to);
      if(source===target)return;
      const names=(await fs.readdir(source).catch(error=>{if(!missing(error))throw error;return [];}))
        .filter(id=>idPattern.test(id));
      if(!names.length)return;
      await fs.mkdir(target,{recursive:true});
      for(const id of names){
        const src=await safe(join(source,id)),dst=await safe(join(target,id));
        const bytes=await fs.readFile(src).catch(error=>{if(!missing(error))throw error;return null;});
        if(!bytes)continue;
        await write(dst,bytes);
        if(fs.unlink)await fs.unlink(src).catch(error=>{if(!missing(error))throw error;});
      }
      if(fs.rmdir)await fs.rmdir(source).catch(()=>{});
      await pruneDir(target);
    }
  };
}
