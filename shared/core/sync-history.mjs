import Sha1 from 'sha.js/sha1.js';

const idPattern=/^sync-(\d{13})-(remote|local|legacy|restore|adopt)-([0-9a-f]{40})\.snapshot$/;
const labels={remote:'被远端新版覆盖',local:'被本机新版覆盖',legacy:'归档的历史冲突副本',
  restore:'恢复历史版本前的正文',adopt:'采用冲突版本前的正文'};
const hash=value=>new Sha1().update(value).digest('hex');
export const isSyncVersion=id=>idPattern.test(id);

/** @param {{root: string, key?: (path: string) => string, join: (...parts: string[]) => string, safe: (path: string) => Promise<string>, fs: import('isomorphic-git').PromiseFsClient['promises'], write: (path: string, bytes: Uint8Array) => Promise<void>}} options */
export function createSyncHistory({root,key=value=>value,join,safe,fs,write}) {
  const missing=error=>error.code==='ENOENT'||error.code==='ENOTDIR';
  const folder=file=>safe(join(root,'.calcite','sync-history',hash(key(file))));
  async function list(file) {
    await safe(file);
    const dir=await folder(file);
    const names=await fs.readdir(dir).catch(error=>{if(!missing(error))throw error;return [];});
    return names.flatMap(id=>{
      const match=idPattern.exec(id);
      return match?[{id,time:Number(match[1]),label:'同步自动备份 · '+labels[match[2]]}]:[];
    }).sort((a,b)=>b.time-a.time||b.id.localeCompare(a.id));
  }
  return {
    list,
    async record(file,bytes,reason,identity){
      const digest=hash(identity+'\0'+hash(bytes));
      const previous=(await list(file)).find(row=>row.id.endsWith('-'+reason+'-'+digest+'.snapshot'));
      if(previous)return previous.id;
      const dir=await folder(file);
      const id='sync-'+Date.now()+'-'+reason+'-'+digest+'.snapshot';
      await fs.mkdir(dir,{recursive:true});
      await write(await safe(join(dir,id)),bytes);
      return id;
    },
    async read(file,id) {
      await safe(file);
      if(!isSyncVersion(id))throw Error('找不到该同步快照。');
      return fs.readFile(await safe(join(await folder(file),id)));
    }
  };
}
