import {t as tr} from "../i18n/index.mjs";
import git from 'isomorphic-git';
import diff3 from 'diff3';
import {sha1} from './sha.mjs';
import {Buffer} from 'buffer';
import {isTextFile,normalizeLineEndings} from '../text-files.mjs';
import {localTimestamp} from '../local-time.mjs';
import {fileSignature} from './vault-index.mjs';
import {createSyncHistory} from './sync-history.mjs';
import {conflictCopyName} from './sync-conflicts.mjs';

/** @import {PromiseFsClient, ParsedObject, RawObject} from 'isomorphic-git' */
/** @import {ConflictItem, PathOperations} from './types.mjs' */
/** @typedef {PromiseFsClient['promises'] & {rename(from: string, to: string): Promise<void>}} GitFs */
/** @typedef {{name: string, email: string}} GitAuthor */
/** @typedef {{relative: string, file: string, previous: string|null|undefined, next: string|null|undefined}} GitChange */
/** @typedef {{phase: string, done?: number, total?: number}} SyncProgress */
/** @typedef {{conflictStrategy?: import('./types.mjs').SyncConfig['conflictStrategy'], beforeWrite?: (rows: (Omit<GitChange,'next'> & {next: Uint8Array|null})[]) => void|Promise<void>, progress?: (value: SyncProgress) => void, onBatch?: (rows: GitChange[]) => void|Promise<void>}} ApplyHooks */
/**
 * @typedef {object} GitOptions
 * @property {GitFs} fs
 * @property {PathOperations & {join(...parts: string[]): string, extname(path: string): string}} path
 * @property {(path: string, bytes: string|Uint8Array) => Promise<void>} atomicWrite
 * @property {(root: string, file: string) => boolean} within
 * @property {boolean} [caseInsensitive]
 * @property {boolean} [sandboxed]
 * @property {<T>(task: () => Promise<T>) => Promise<T>} [withSession]
 * @property {GitFs['stat']} [freshStat]
 */

export const FILE_LIMIT=50*1024*1024;
export const OID=/^[0-9a-f]{40}$/;
const ignored=['*.tmp','*.crdownload','desktop.ini','.DS_Store','.trash/','.calcite/','.calcite-tmp-*','.env','.env.*','*.pfx','*.p12','*.key',
  '*.exe','*.out','*.o','*.obj','*.pdb','*.class','node_modules/'];
const missing=error=>['ENOENT','ENOTDIR'].includes(error.code);
const gitOid=(type,bytes)=>sha1(type+' '+bytes.length+'\0',bytes);
const objectTypes=['blob','tree','commit'];
const internalPath=file=>file.split('/').some(part=>/^\.(?:git$|calcite$|trash$|calcite-tmp-)/i.test(part));
const rulesFile=/(?:^|\/)\.(?:gitignore|gitattributes)$/i;
const historyTrailer='Calcite-Sync-Backup: ';

// Wait for every operation in a group before propagating a failure or starting a rollback.
async function settleGroup(rows,task) {
  const results=await Promise.allSettled(rows.map(task));
  const failure=results.find(row=>row.status==='rejected');
  if(failure)throw failure.reason;
}

const lineParts=text=>text.match(/[^\n]*\n|[^\n]+$/g)||[];
/** @param {Uint8Array} base @param {Uint8Array} ours @param {Uint8Array} theirs */
function mergeText(base,ours,theirs) {
  if(Math.max(base.length,ours.length,theirs.length)>2*1024*1024)return null;
  const decode=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  let values;
  try{values=[base,ours,theirs].map(bytes=>decode.decode(bytes));}catch{return null;}
  if(values.some(value=>value.includes('\0')))return null;
  const result=diff3(lineParts(values[1]),lineParts(values[0]),lineParts(values[2]));
  if(result.some(segment=>segment.conflict))return null;
  return Buffer.from(result.map(segment=>segment.ok.join('')).join(''));
}

/** Keep the relative order of each side's rules wherever the two orders agree. */
function mergeRules(base,ours,theirs) {
  const lines=bytes=>bytes?.toString('utf8').replace(/^\uFEFF/,'').split('\n').filter(Boolean)||[];
  const left=lines(ours),right=lines(theirs);
  const combined=mergeText(base||Buffer.alloc(0),ours||Buffer.alloc(0),theirs||Buffer.alloc(0));
  // A three-way merge can omit lines deliberately removed on one side.
  const union=[...new Set([...lines(combined),...left,...right])];
  return Buffer.from(union.length?union.join('\n')+'\n':'');
}

/** @param {GitOptions} options */
export function createGitEngine({fs,path,atomicWrite,within,caseInsensitive=false,sandboxed=false,withSession=task=>task(),freshStat=fs.stat}) {
  function confined(root) {
    async function safe(file) {
      const absolute=path.resolve(sandboxed&&file==='.'?root:file);
      if(!within(root,absolute))throw Error(tr("gitEngine.gitPathIsOutsideTheCurrentWorkspace"));
      if(!sandboxed&&(await fs.lstat(root)).isSymbolicLink())throw Error(tr("gitEngine.theWorkspaceDirectoryChangedOpenItAgain"));
      let parent=root;
      for(const piece of path.relative(root,absolute).split(path.sep).filter(Boolean)) {
        if(piece.includes(':')||/[\x00-\x1f]/.test(piece))throw Error(tr("gitEngine.invalidGitPath"));
        if(sandboxed)continue;
        parent=path.join(parent,piece);
        const info=await fs.lstat(parent).catch(error=>{if(!missing(error))throw error;});
        if(!info)break;
        if(info.isSymbolicLink())throw Error(tr("gitEngine.gitSyncCannotReadOrWriteSymlinks"));
      }
      return absolute;
    }
    /** @param {Exclude<keyof GitFs, 'rename'>} method */
    const guarded=method=>async(file,...args)=>fs[method](await safe(file),...args);
    /** @type {GitFs} */
    const promises={
      readFile:guarded('readFile'),writeFile:guarded('writeFile'),lstat:guarded('lstat'),
      stat:guarded('stat'),readdir:guarded('readdir'),mkdir:guarded('mkdir'),rmdir:guarded('rmdir'),
      unlink:guarded('unlink'),chmod:guarded('chmod'),readlink:guarded('readlink'),
      rename:async(from,to)=>fs.rename(await safe(from),await safe(to)),
      symlink:async()=>{throw Error(tr("gitEngine.gitSyncCannotCreateSymlinks"));}
    };
    promises.writeFile=async(file,data,options)=>{
      const absolute=await safe(file);
      const relative=path.relative(root,absolute).split(path.sep).join('/');
      if(sandboxed&&/^\.git\/(?:index|objects\/[0-9a-f]{2}\/[0-9a-f]{38})$/.test(relative))
        return atomicWrite(absolute,data);
      return fs.writeFile(absolute,data,options);
    };
    return {safe,client:{promises}};
  }
  
  function treePath(root,file) {
    if(!file||file.startsWith('/')||file.includes('\\')||file.split('/').some(piece=>!piece||internalPath(piece)||/^(?:\.\.?|\.gitmodules)$/i.test(piece)
        ||/[<>:"|?*\x00-\x1f]|[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece))) throw Error(tr("gitEngine.theGitTreeContainsAnUnsafeOr"));
    const absolute=path.resolve(root,...file.split('/'));
    if(!within(root,absolute))throw Error(tr("gitEngine.aGitTreePathPointsOutsideThe"));
    return absolute;
  }
  class GitEngine {
    constructor(root) {
      this.root=path.resolve(root);
      this.guard=confined(this.root);
      this.args={fs:this.guard.client,dir:this.root};
      this.reachableCache=null;
      this.objectSizes=new Map();
      this.history=createSyncHistory({root:this.root,join:path.join,safe:this.guard.safe,fs,write:atomicWrite,key:file=>{
        const relative=path.relative(this.root,file);
        return caseInsensitive?relative.toLowerCase():relative;
      }});
      this.checkpointFile=path.join(this.root,'.git','calcite-worktree.json');
      this.normalizedTimes=new Map();
      this.dirtyPaths=new Set();
    }
  
    async open() {
      const folder=path.join(this.root,'.git');
      const stat=await fs.lstat(folder).catch(error=>{if(!missing(error))throw error;});
      if(!stat)await git.init({...this.args,defaultBranch:'main'});
      else if(!stat.isDirectory()||stat.isSymbolicLink())throw Error(tr("gitEngine.theWorkspaceGitMustBeALocal"));
      if(await git.getConfig({...this.args,path:'core.worktree'}))throw Error(tr("gitEngine.gitConfigurationsLinkedToAnotherWorktreeAre"));
      const ignore=await this.guard.safe(path.join(this.root,'.gitignore'));
      if(!stat&&!await fs.lstat(ignore).catch(error=>{if(!missing(error))throw error;}))
        await atomicWrite(ignore,['# Calcite',...ignored,''].join('\n'));
      if(!await git.currentBranch({...this.args,fullname:true}))throw Error(tr("gitEngine.theRepositoryHasADetachedHeadSwitch"));
    }
  
    async head() {
      return git.resolveRef({...this.args,ref:'HEAD'}).catch(error=>{if(error.code==='NotFoundError')return null;throw error;});
    }

    markDirty(files) {
      for(const file of files)this.dirtyPaths.add(path.relative(this.root,file).split(path.sep).join('/'));
    }

    async workspaceFile(file) {
      const absolute=await this.guard.safe(file);
      return treePath(this.root,path.relative(this.root,absolute).split(path.sep).join('/'));
    }

    /** @param {string} file @param {string} id @param {{beforeWrite?: (rows: {file: string, next: Uint8Array, previous: Uint8Array|null}[]) => void|Promise<void>, onBatch?: (rows: {file: string, next: Uint8Array, previous: Uint8Array|null}[]) => void|Promise<void>}} [hooks] */
    async restoreVersion(file,id,{beforeWrite=()=>{},onBatch=()=>{}}={}) {
      file=await this.workspaceFile(file);
      const next=await this.history.read(file,id);
      const previous=await fs.readFile(file).catch(error=>{if(!missing(error))throw error;return null;});
      if(previous&&Buffer.from(previous).equals(next))return;
      await beforeWrite([{file,next,previous}]);
      if(previous)await this.history.record(file,previous,'restore','restore '+id);
      await fs.mkdir(path.dirname(file),{recursive:true});
      await atomicWrite(file,next);
      await onBatch([{file,next,previous}]);
    }
  
    /** @returns {Promise<Map<string, Awaited<ReturnType<GitFs['stat']>>>>} */
    async worktree() {
      const result=new Map(),dirs=[this.root];
      for(let i=0;i<dirs.length;){
        const batch=dirs.slice(i,i+8);
        i+=batch.length;
        await settleGroup(batch,async dir=>{
          const entries=await fs.readdir(dir,{withFileTypes:true}).catch(error=>{if(!missing(error))throw error;return [];});
          for(const entry of entries){
            const file=path.join(dir,entry.name);
            const relative=path.relative(this.root,file).split(path.sep).join('/');
            if(internalPath(relative)||entry.name.startsWith('.calcite-backup-'))continue;
            if(entry.isDirectory())dirs.push(file);
            else if(!sandboxed||entry.isFile())result.set(relative,entry);
          }
        });
      }
      return result;
    }

    async indexStamp() {
      const file=await this.guard.safe(path.join(this.root,'.git','index'));
      const bytes=await fs.readFile(file).catch(error=>{if(!missing(error))throw error;return null;});
      return bytes?gitOid('blob',bytes):null;
    }

    async loadCheckpoint(head) {
      if(!sandboxed)return null;
      const index=await this.indexStamp();
      let data;
      try{data=JSON.parse(/** @type {string} */ (await fs.readFile(this.checkpointFile,'utf8')));}
      catch(error){if(missing(error)||error instanceof SyntaxError)return null;throw error;}
      if(data?.version!==1||data.head!==head||data.index!==index||!Array.isArray(data.files)||
        data.files.some(row=>!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||typeof row[1]!=='string'))return null;
      return new Map(/** @type {[string, string][]} */ (data.files));
    }

    async saveCheckpoint(head,files) {
      const value={version:1,head,index:await this.indexStamp(),files:[...files]};
      await atomicWrite(this.checkpointFile,JSON.stringify(value));
    }

    /** @returns {Promise<Map<string, {oid:string, signature:string}>>} */
    async stagedFiles() {
      const rows=await git.walk({...this.args,trees:[git.STAGE()],map:async(file,[entry])=>{
        if(internalPath(file))return null;
        const type=await entry.type();
        if(type==='tree')return undefined;
        if(type!=='blob'||![0o100644,0o100755].includes(await entry.mode()))throw Error(tr("gitEngine.gitSyncDoesNotSupportSymlinksOr"));
        const stat=await entry.stat();
        const mtimeMs=stat.mtimeSeconds*1000+Math.floor(stat.mtimeNanoseconds/1000000);
        return [file,{oid:await entry.oid(),signature:fileSignature({mtimeMs,size:stat.size})}];
      }});
      return new Map(rows);
    }

    /** @param {GitAuthor} author */
    snapshot(author) {
      return withSession(()=>this.snapshotWorkingTree(author));
    }

    /** @param {GitAuthor} author */
    async snapshotWorkingTree(author) {
      const head=await this.head();
      const checkpoint=await this.loadCheckpoint(head);
      const entries=sandboxed?await this.worktree():null;
      if(entries)this.legacyCandidates=[...entries.keys()].filter(file=>/ \((?:同步冲突|conflict) /.test(file));
      /** @type {[string, number, number, number][]} */
      let rows=[];
      let staged,tracked;
      if(entries){
        staged=checkpoint?null:await this.stagedFiles();
        tracked=checkpoint?null:await this.tracked(head);
        const known=checkpoint??new Map([...staged].map(([file,row])=>[file,row.signature]));
        for(const [file,stat] of entries){
          if(known.has(file)){
            if(this.dirtyPaths.has(file)||known.get(file)!==fileSignature(stat)||staged&&staged.get(file)?.oid!==tracked.get(file))
              rows.push([file,1,2,1]);
          }else if(tracked?.has(file)){
            throw Error(tr("gitEngine.theGitIndexAndDiskHaveDifferent"));
          }else if(!await git.isIgnored({...this.args,filepath:file}))rows.push([file,0,2,0]);
        }
        for(const file of known.keys())if(!entries.has(file)){
          if(staged&&staged.get(file)?.oid!==tracked.get(file))throw Error(tr("gitEngine.theGitIndexAndDiskHaveDifferent"));
          rows.push([file,1,0,1]);
        }
        if(staged)for(const file of tracked.keys())if(!staged.has(file)&&!entries.has(file))rows.push([file,1,0,0]);
        if(checkpoint&&!rows.length){this.dirtyPaths.clear();return head;}
      }else{
        const status=await git.statusMatrix({...this.args,filter:file=>!internalPath(file)});
        if(!entries)this.legacyCandidates=status.filter(([file,,work])=>work&&/ \((?:同步冲突|conflict) /.test(file)).map(([file])=>file);
        rows=status
          .filter(([,old,work,stage])=>old!==work||old!==stage);
      }
      const dirty=new Map();
      for(const [file,,work,stage] of rows) {
        const absolute=await this.guard.safe(treePath(this.root,file));
        if(stage===3||stage===2&&work!==2)throw Error(tr("gitEngine.theGitIndexAndDiskHaveDifferent"));
        if(work){
          const stat=await fs.stat(absolute);
          if(stat.size>FILE_LIMIT)throw Error(tr("gitEngine.cannotCommitAFileLargerThan50")+file);
          dirty.set(file,fileSignature(stat));
        }
      }
      if(checkpoint&&rows.some(([,old,work])=>old&&work))tracked=await this.tracked(head);
      const unchanged=new Set();
      for(const [file,,work] of rows)if(work&&(entries||isTextFile(file))){
        const absolute=await this.guard.safe(treePath(this.root,file));
        const bytes=/** @type {Uint8Array} */ (await fs.readFile(absolute));
        const stagedOid=staged?.get(file)?.oid;
        if(stagedOid&&stagedOid!==tracked.get(file)&&stagedOid!==gitOid('blob',bytes))
          throw Error(tr("gitEngine.theGitIndexAndDiskHaveDifferent"));
        // Keep locally refactored Markdown byte-for-byte intact when auto-sync
        // snapshots it. Editor saves and incoming Git compatibility are separate.
        const normalized=/\.(?:md|markdown|mdown)$/i.test(file)?bytes:normalizeLineEndings(file,bytes);
        if(normalized!==bytes){
          const stat=await freshStat(absolute);
          if(!Buffer.from(await fs.readFile(absolute)).equals(bytes))throw Error(tr("gitEngine.aFileChangedBeforeItCouldBe"));
          await atomicWrite(absolute,normalized);
          const signature=fileSignature(await freshStat(absolute));
          this.normalizedTimes.set(file,{signature,time:stat.mtimeMs});
          dirty.set(file,signature);
        }
        if(tracked?.get(file)===gitOid('blob',normalized))unchanged.add(file);
      }
      const changes=rows.filter(([file])=>!unchanged.has(file));
      const stageChanges=rows.filter(([file])=>!unchanged.has(file)||staged?.get(file)?.oid!==tracked?.get(file)&&staged?.has(file));
      await this.stage(stageChanges.map(([relative,,work])=>({relative,next:work})));
      const next=changes.length?await git.commit({...this.args,author,message:`auto: update ${changes.length} notes`}):head;
      if(entries){
        const files=checkpoint??new Map([...staged.keys()].map(file=>[file,fileSignature(entries.get(file)??{mtimeMs:0,size:0})]));
        for(const [file,,work] of rows) {
          if(work)files.set(file,dirty.get(file));
          else files.delete(file);
        }
        await this.saveCheckpoint(next,files);
        this.dirtyPaths.clear();
      }
      return next;
    }
  
    /** @param {string|null|undefined} oid @returns {Promise<Map<string, string>>} */
    async tracked(oid) {
      if(!oid)return new Map();
      const rows=await git.walk({...this.args,trees:[git.TREE({ref:oid})],map:async(file,[entry])=>{
        if(file==='.')return undefined;
        treePath(this.root,file);
        const type=await entry.type();
        if(type==='tree')return undefined;
        if(type!=='blob'||![0o100644,0o100755].includes(await entry.mode())) throw Error(tr("gitEngine.gitSyncDoesNotSupportSymlinksOr"));
        return [file,await entry.oid()];
      }});
      const result=new Map(/** @type {[string, string][]} */ (rows));
      if(caseInsensitive&&new Set([...result.keys()].map(file=>file.toLowerCase())).size!==result.size)throw Error(tr("gitEngine.theGitBranchContainsFilenamesThatConflict"));
      return result;
    }
  
    async blob(oid) {
      if(!oid)return null;
      const bytes=Buffer.from((await git.readBlob({...this.args,oid})).blob);
      if(bytes.length>FILE_LIMIT)throw Error(tr("gitEngine.theRemoteContainsAFileLargerThan"));
      return bytes;
    }

    /** @param {{relative: string, next: number|string|null|undefined}[]} rows */
    async stage(rows,force=false) {
      const removed=rows.filter(row=>!row.next).map(row=>row.relative);
      const written=rows.filter(row=>row.next).map(row=>row.relative);
      if(removed.length)await git.remove({...this.args,filepath:removed});
      // Bound both the number of paths and the bytes git.add can hold while staging.
      let batch=[],size=0;
      const flush=async()=>{
        if(batch.length)await git.add({...this.args,filepath:batch,force});
        batch=[];size=0;
      };
      for(const relative of written) {
        const bytes=(await fs.stat(await this.guard.safe(treePath(this.root,relative)))).size;
        if(batch.length===(sandboxed?8:32)||size+bytes>8*1024*1024)await flush();
        batch.push(relative);size+=bytes;
        if(size>=8*1024*1024)await flush();
      }
      await flush();
    }

    async incomingBackups(theirs,right) {
      const {commit}=await git.readCommit({...this.args,oid:theirs});
      if(commit.parent.length!==2||!commit.message.includes(historyTrailer))return [];
      const parents=await Promise.all(commit.parent.map(oid=>this.tracked(oid).catch(error=>{
        if(error.code==='NotFoundError')return new Map();
        throw error;
      })));
      const result=[];
      for(const line of commit.message.split('\n')){
        if(!line.startsWith(historyTrailer))continue;
        let record;
        try{record=JSON.parse(line.slice(historyTrailer.length));}catch{continue;}
        const {relative,loser,winner}=record||{};
        if(typeof relative!=='string'||!isTextFile(relative)||rulesFile.test(relative)||!OID.test(loser)||
          !['local','remote'].includes(winner)||loser===right.get(relative)||!parents.some(tree=>tree.get(relative)===loser))continue;
        const file=await this.guard.safe(treePath(this.root,relative));
        result.push({relative,file,loser,winner,reason:winner==='local'?'local':'remote',identity:commit.parent.join(' ')});
      }
      return result;
    }

    async fileChangeClock() {
      const commits=new Map(),trees=new Map(),shallow=await this.shallow();
      const readCommit=oid=>{
        if(!commits.has(oid))commits.set(oid,git.readCommit({...this.args,oid}).then(row=>row.commit));
        return commits.get(oid);
      };
      const readDirectory=(oid,dir)=>{
        const key=oid+' '+dir;
        if(!trees.has(key))trees.set(key,git.readTree({...this.args,oid,filepath:dir||undefined})
          .then(({tree})=>new Map(tree.map(entry=>[entry.path,entry.oid])))
          .catch(error=>{
            if(!['NotFoundError','ObjectTypeError'].includes(error.code))throw error;
            return new Map();
          }));
        return trees.get(key);
      };
      return async(head,relative,version,base)=>{
        const slash=relative.lastIndexOf('/');
        const dir=slash<0?'':relative.slice(0,slash),name=relative.slice(slash+1);
        const visited=new Set();
        const queue=[head];
        let latest=0;
        while(queue.length){
          const oid=queue.shift();
          if(!oid||visited.has(oid))continue;
          visited.add(oid);
          const commit=await readCommit(oid);
          const stamp=commit.committer.timestamp*1000;
          if(!commit.parent.length||shallow.has(oid)){
            if(stamp>latest)latest=stamp;
            continue;
          }
          let matchedParent=false;
          for(const parent of commit.parent){
            if(parent===base)continue;
            const previous=await readCommit(parent).catch(error=>{
              if(error.code!=='NotFoundError')throw error;
              return null;
            });
            if(previous&&(await readDirectory(previous.tree,dir)).get(name)===version){
              matchedParent=true;
              queue.push(parent);
            }
          }
          if(!matchedParent&&stamp>latest)latest=stamp;
        }
        return latest||(await readCommit(head)).committer.timestamp*1000;
      };
    }
  
    /** @param {string} theirs @param {GitAuthor} author @param {ApplyHooks} [hooks] */
    apply(theirs,author,hooks) {
      return withSession(()=>this.applyWorkingTree(theirs,author,hooks));
    }

    /** @param {string} theirs @param {GitAuthor} author @param {ApplyHooks} [hooks] */
    async applyWorkingTree(theirs,author,{conflictStrategy='lww-history',beforeWrite=()=>{},progress=()=>{},onBatch=()=>{}}={}) {
      if(!OID.test(theirs))throw Error(tr("gitEngine.invalidRemoteCommitId"));
      const ours=await this.head();
      if(theirs===ours)return {changes:[],conflicts:[],resolved:[]};
      const fast=!ours||await git.isDescendent({...this.args,oid:theirs,ancestor:ours,depth:-1});
      if(!fast&&await git.isDescendent({...this.args,oid:ours,ancestor:theirs,depth:-1}))return {changes:[],conflicts:[],resolved:[]};
      const base=ours&&!fast?(await git.findMergeBase({...this.args,oids:[ours,theirs]}))[0]:ours;
      const checkpoint=await this.loadCheckpoint(ours);
      const [before,left,right]=await Promise.all([this.tracked(base),this.tracked(ours),this.tracked(theirs)]);
      const files=new Set([...left.keys(),...right.keys()]);
      /** @type {GitChange[]} */
      const changes=[];
      /** @type {ConflictItem[]} */
      const conflicts=[];
      const resolved=[],backups=await this.incomingBackups(theirs,right);
      const copies=new Set();
      const occupied=new Set([...files].map(file=>caseInsensitive?file.toLowerCase():file));
      let changeTime;
      for(const relative of files) {
        const old=before.get(relative),local=left.get(relative),remote=right.get(relative);
        if(local===remote||remote===old)continue;
        const file=await this.guard.safe(treePath(this.root,relative));
        if(local===old) {changes.push({relative,file,previous:local,next:remote});continue;}
        const [previous,incoming,ancestor]=await Promise.all([this.blob(local),this.blob(remote),this.blob(old)]);
        /** @param {Buffer|null} bytes */
        const text=bytes=>{
          if(!bytes)return null;
          const normalized=normalizeLineEndings(relative,bytes);
          return normalized===bytes?bytes:Buffer.from(normalized);
        };
        const leftText=text(previous),rightText=text(incoming),baseText=text(ancestor);
        if(baseText&&rightText?.equals(baseText))continue;
        if(baseText&&leftText?.equals(baseText)){
          changes.push({relative,file,previous:local,next:remote});
          continue;
        }
        if(leftText&&rightText?.equals(leftText))continue;
        const combined=rulesFile.test(relative)?mergeRules(baseText,leftText,rightText):
          conflictStrategy==='lww-history'&&leftText&&rightText&&isTextFile(relative)?
            mergeText(baseText||Buffer.alloc(0),leftText,rightText):null;
        if(combined) {
          if(!previous||!combined.equals(previous)) {
            const oid=await git.writeBlob({...this.args,blob:combined});
            changes.push({relative,file,previous:local,next:oid});
          }
          continue;
        }
        if(conflictStrategy==='lww-history'&&isTextFile(relative)){
          changeTime??=await this.fileChangeClock();
          const remoteTime=await changeTime(theirs,relative,remote,base);
          const stat=local?await freshStat(file).catch(error=>{if(!missing(error))throw error;return null;}):null;
          const normalized=this.normalizedTimes.get(relative);
          const modified=stat?(normalized?.signature===fileSignature(stat)?normalized.time:stat.mtimeMs):
            await changeTime(ours,relative,local,base);
          const remoteWins=remoteTime>modified,loser=remoteWins?previous:incoming;
          resolved.push({path:file,relative,winner:remoteWins?'remote':'local',backedUp:Boolean(loser)});
          if(loser)backups.push({file,relative,loser:remoteWins?local:remote,winner:remoteWins?'remote':'local',
            reason:remoteWins?'remote':'local',identity:ours+' '+theirs});
          if(remoteWins)changes.push({relative,file,previous:local,next:remote});
          continue;
        }
        let copy;
        if(incoming) {
          const extension=path.extname(relative);
          const stamp=localTimestamp();
          let serial=0,relativeCopy;
          do{
            relativeCopy=conflictCopyName(relative,extension,stamp,serial);
            serial++;
            copy=await this.guard.safe(treePath(this.root,relativeCopy));
          }while(occupied.has(caseInsensitive?relativeCopy.toLowerCase():relativeCopy)||
            await fs.lstat(copy).then(()=>true,error=>{if(!missing(error))throw error;return false;}));
          occupied.add(caseInsensitive?relativeCopy.toLowerCase():relativeCopy);
          copies.add(relativeCopy);
          changes.push({relative:relativeCopy,file:copy,previous:null,next:remote});
        }
        conflicts.push({path:file,copy:copy||null});
      }
      // Check all working copies before updating any file. A concurrently edited note
      // remains untouched and the caller can snapshot it before retrying the merge.
      const matches=async(row,value)=>{
        const current=await fs.readFile(await this.guard.safe(row.file)).catch(error=>{if(missing(error))return null;throw error;});
        return current?Boolean(value&&gitOid('blob',current)===value):!value;
      };
      const width=sandboxed?8:1,groups=[];
      let group=[],size=0;
      for(const row of changes) {
        const bytes=Math.max(this.objectSize(row.next)??(row.next?FILE_LIMIT:0),this.objectSize(row.previous)??(row.previous?FILE_LIMIT:0));
        if(group.length&&(group.length===width||size+bytes>8*1024*1024)){groups.push(group);group=[];size=0;}
        group.push(row);size+=bytes;
      }
      if(group.length)groups.push(group);
      for(const rows of groups)await settleGroup(rows,async row=>{
        if(!await matches(row,row.previous))throw Error(tr("gitEngine.aFileChangedWhileSyncWasPreparing"));
      });
      for(const backup of backups){
        await this.history.record(backup.file,await this.blob(backup.loser),backup.reason,backup.identity);
        if(backup.identity!==ours+' '+theirs)
          resolved.push({path:backup.file,relative:backup.relative,winner:backup.winner,backedUp:true});
      }
      const applied=[],pending=[];
      const directories=new Map(),writtenStats=new Map();
      const indexFile=await this.guard.safe(path.join(this.root,'.git','index'));
      const previousIndex=changes.length?await fs.readFile(indexFile).catch(error=>{if(missing(error))return null;throw error;}):null;
      let indexTouched=false,lastBatch=Date.now(),normalizedFastForward=false;
      const write=async(row,value,normalize=false)=>{
        await this.guard.safe(row.file);
        let bytes=await this.blob(value);
        if(normalize&&bytes&&!copies.has(row.relative)){
          const next=normalizeLineEndings(row.relative,bytes);
          if(next!==bytes){
            bytes=Buffer.from(next);
            row.next=await git.writeBlob({...this.args,blob:bytes});
            normalizedFastForward=true;
          }
        }
        await beforeWrite([{...row,next:bytes}]);
        if(bytes) {
          const parent=path.dirname(row.file);
          if(!directories.has(parent))directories.set(parent,fs.mkdir(parent,{recursive:true}));
          await directories.get(parent);
          await atomicWrite(row.file,bytes);
        }else {
          await fs.unlink(row.file);
          for(let parent=path.dirname(row.file);parent!==this.root&&within(this.root,parent);parent=path.dirname(parent)){
            if(internalPath(path.relative(this.root,parent).split(path.sep).join('/')))break;
            try{await fs.rmdir(parent);directories.delete(parent);}
            catch{break;}
          }
        }
      };
      const publish=async()=>{
        if(!pending.length)return;
        await onBatch(pending.splice(0));
        lastBatch=Date.now();
      };
      try {
        progress({phase:'write',done:0,total:changes.length});
        for(const rows of groups) {
          await settleGroup(rows,async row=>{
            if(!await matches(row,row.previous))throw Error(tr("gitEngine.anotherProgramWroteToAFileDuring"));
            await write(row,row.next,true);applied.push(row);pending.push(row);
            if(checkpoint&&row.next)writtenStats.set(row.relative,fileSignature(await freshStat(row.file)));
          });
          if(pending.length>=20||Date.now()-lastBatch>=1000) {
            await publish();
            progress({phase:'write',done:applied.length,total:changes.length});
          }
        }
        await publish();
        progress({phase:'write',done:applied.length,total:changes.length});
        progress({phase:'index'});
        indexTouched=changes.length>0;
        await this.stage(changes,true);
        if(fast&&!normalizedFastForward) {
          // open() requires a symbolic HEAD before a sync begins.
          const ref=/** @type {string} */ (await git.currentBranch({...this.args,fullname:true}));
          await git.writeRef({...this.args,ref,value:theirs,force:true});
        } else {
          const message=fast?'sync: normalize text line endings':conflicts.length?'sync: retain both versions':'sync: merge remote changes';
          const trailers=backups.filter(row=>row.identity===ours+' '+theirs).map(({relative,loser,winner})=>
            historyTrailer+JSON.stringify({relative,loser,winner}));
          await git.commit({...this.args,author,message:[message,...trailers].join('\n'),parent:fast?[theirs]:[ours,theirs]});
        }
      } catch(error) {
        let incomplete=false;
        for(const row of applied.reverse()) try {
          if(!await matches(row,row.next)){incomplete=true;continue;}
          await write(row,row.previous);
        }catch{incomplete=true;}
        try{
          if(indexTouched) {
            if(previousIndex)await atomicWrite(indexFile,previousIndex);
            else await fs.unlink(indexFile).catch(error=>{if(!missing(error))throw error;});
          }
          if(applied.length)await onBatch(applied.map(row=>({...row,next:row.previous})));
        }catch{incomplete=true;}
        throw Error(error.message+(incomplete?tr("gitEngine.someFilesChangedAgainDuringRollbackCheck"):''));
      }
      if(checkpoint){
        for(const row of changes){
          if(row.next)checkpoint.set(row.relative,writtenStats.get(row.relative));
          else checkpoint.delete(row.relative);
          this.normalizedTimes.delete(row.relative);
        }
        await this.saveCheckpoint(await this.head(),checkpoint);
      }
      if(conflicts.length)this.legacyCandidates=undefined;
      return {changes,conflicts,resolved};
    }
  
    /** @returns {Promise<Set<string>>} */
    async shallow() {
      const file=await this.guard.safe(path.join(this.root,'.git','shallow'));
      const raw=await fs.readFile(file,'utf8').catch(error=>{if(!missing(error))throw error;return '';});
      return new Set(String(raw).split(/\r?\n/).filter(oid=>OID.test(oid)));
    }

    async importShallow(oids) {
      const boundaries=await this.shallow();
      let changed=false;
      for(const oid of oids){
        if(boundaries.has(oid))continue;
        const {commit}=await git.readCommit({...this.args,oid});
        for(const parent of commit.parent)try{await git.readCommit({...this.args,oid:parent});}
        catch(error){
          if(error.code!=='NotFoundError')throw error;
          boundaries.add(oid);changed=true;break;
        }
      }
      if(changed){
        await atomicWrite(await this.guard.safe(path.join(this.root,'.git','shallow')),[...boundaries].join('\n')+'\n');
        this.reachableCache=null;
      }
    }

    async hasCommit(oid) {
      if(!oid||!OID.test(oid))return false;
      try{await git.readCommit({...this.args,oid});return true;}
      catch(error){if(error.code==='NotFoundError')return false;throw error;}
    }

    /** Collect objects reachable from `head` while pruning subtrees already present in `stop` commit(s). */
    async objectsSince(head,stop) {
      if(!head)return [];
      if(!stop||head===stop)return head===stop?[]:this.objects(head);
      if(!await this.hasCommit(stop))return this.objects(head);
      const isAncestor=await git.isDescendent({...this.args,oid:head,ancestor:stop,depth:-1}).catch(()=>false);
      if(!isAncestor)return this.objects(head);
      const shallow=await this.shallow();
      const stopCommit=await git.readCommit({...this.args,oid:stop});
      const skip=new Set([stop,stopCommit.commit.tree]);
      const seen=new Set(),queue=[head];
      const skipTrees=[stopCommit.commit.tree];
      while(skipTrees.length){
        const treeOid=skipTrees.pop();
        const {type,object}=/** @type {ParsedObject} */ (await git.readObject({...this.args,oid:treeOid,format:'parsed'}));
        if(type!=='tree')continue;
        for(const item of object){
          if(!skip.has(item.oid)){
            skip.add(item.oid);
            if(item.type==='tree')skipTrees.push(item.oid);
          }
        }
      }
      while(queue.length){
        const oid=queue.pop();
        if(skip.has(oid)||seen.has(oid))continue;
        if(!OID.test(oid)||seen.size>=120000)throw Error(tr("gitEngine.tooManyGitObjectsForASingle"));
        seen.add(oid);
        if(this.objectSizes.get(oid)?.type==='blob')continue;
        const {type,object}=/** @type {ParsedObject} */ (await git.readObject({...this.args,oid,format:'parsed'}));
        if(type==='commit')queue.push(object.tree,...(shallow.has(oid)?[]:object.parent));
        if(type==='tree')for(const item of object)queue.push(item.oid);
        if(type==='blob'){
          if(object.length>FILE_LIMIT)throw Error(tr("gitEngine.theCommitHistoryContainsAnObjectLarger"));
          this.rememberObject(oid,type,object.length);
        }
      }
      return [...seen];
    }

    async objects(head,stop=null) {
      if(!head)return [];
      if(!stop&&this.reachableCache?.head===head)return this.reachableCache.list;
      const shallow=await this.shallow();
      const seen=new Set(),queue=[head];
      while(queue.length) {
        const oid=queue.pop();
        if(oid===stop||seen.has(oid))continue;
        if(!OID.test(oid)||seen.size>=120000)throw Error(tr("gitEngine.tooManyGitObjectsForASingle"));
        seen.add(oid);
        if(this.objectSizes.get(oid)?.type==='blob')continue;
        const {type,object}=/** @type {ParsedObject} */ (await git.readObject({...this.args,oid,format:'parsed'}));
        if(type==='commit')queue.push(object.tree,...(shallow.has(oid)?[]:object.parent));
        if(type==='tree')for(const item of object)queue.push(item.oid);
        if(type==='blob') {
          if(object.length>FILE_LIMIT)throw Error(tr("gitEngine.theCommitHistoryContainsAnObjectLarger"));
          this.rememberObject(oid,type,object.length);
        }
      }
      const list=[...seen];
      if(!stop)this.reachableCache={head,list,seen};
      return list;
    }

    async hasObject(head,oid) {
      if(!head)return false;
      if(this.reachableCache?.head!==head)return (await this.objects(head)).includes(oid);
      return this.reachableCache.seen.has(oid);
    }
  
    rememberObject(oid,type,size) {
      if(this.objectSizes.size>=60000)this.objectSizes.delete(this.objectSizes.keys().next().value);
      this.objectSizes.set(oid,{type,size});
    }

    objectSize(oid) {return this.objectSizes.get(oid)?.size;}

    async binaryObject(oid) {
      const {type,object}=/** @type {RawObject} */ (await git.readObject({...this.args,oid,format:'content'}));
      if(!objectTypes.includes(type)||object.length>FILE_LIMIT)throw Error(tr("gitEngine.theGitObjectSTypeIsInvalid"));
      this.rememberObject(oid,type,object.length);
      return {oid,type,bytes:object};
    }

    async object(oid) {
      const {type,bytes}=await this.binaryObject(oid);
      return {oid,type,data:Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64')};
    }

    async acceptBinary({oid,type,bytes}) {
      if(!OID.test(oid)||!objectTypes.includes(type)||!bytes||bytes.length>FILE_LIMIT)throw Error(tr("gitEngine.theGitObjectIsInvalidOrExceeds"));
      if(gitOid(type,bytes)!==oid)throw Error(tr("gitEngine.gitObjectHashVerificationFailed"));
      await git.writeObject({...this.args,type,object:bytes,format:'content'});
      this.rememberObject(oid,type,bytes.length);
    }
  
    async accept(objects) {
      const unique=[...new Map(objects.map(item=>[item?.oid,item])).values()];
      if(unique.length!==objects.length)throw Error(tr("gitEngine.theGitObjectBatchContainsDuplicateIds"));
      const width=sandboxed?6:1;
      for(let i=0;i<unique.length;i+=width)await settleGroup(unique.slice(i,i+width),async item=>{
        if(!item||typeof item.data!=='string')throw Error(tr("gitEngine.invalidGitObject"));
        const bytes=Buffer.from(item.data,'base64');
        if(bytes.length>FILE_LIMIT||bytes.toString('base64')!==item.data)throw Error(tr("gitEngine.theGitObjectEncodingIsInvalidOr"));
        await this.acceptBinary({...item,bytes});
      });
    }
  }
  return GitEngine;
}
