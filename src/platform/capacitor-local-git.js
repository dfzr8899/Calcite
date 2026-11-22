import git from 'isomorphic-git';
import {Buffer} from 'buffer';
import {randomId} from '../random-id.js';
import {posixPath,dirname,basename,vaultStoragePath} from './capacitor-git-fs.js';
import {createCapacitorGitHttp,createCapacitorPeer,importRemoteConfig} from './capacitor-git-http.js';
import {createMobileSecrets} from './capacitor-secure-storage.js';
import {createGitEngine} from '../../shared/core/git-engine.mjs';
import {applySettings,configured,defaults,remoteError,repositoryUrl,vaultRecord,wifiOnly} from '../../shared/core/sync-config.mjs';
import {peerFailure} from '../../shared/sync-url.mjs';
import {createSyncScheduler} from '../sync-scheduler.js';
import {pendingCommits,syncRemote} from '../../shared/sync-remote.mjs';
import {exchange,pullLimit} from '../../shared/core/sync-exchange.mjs';
import {findConflicts,readConflict,readConflictFile,rememberConflicts,resolveConflict} from '../../shared/core/sync-conflicts.mjs';
import {isSyncVersion} from '../../shared/core/sync-history.mjs';
import {within} from './capacitor-index.js';

const paths={resolve:posixPath,join:posixPath,dirname,sep:'/',relative:(root,file)=>root===file?'':file.slice(root==='/'?1:root.length+1),
  extname(file){const name=basename(file),dot=name.lastIndexOf('.');return dot>0?name.slice(dot):'';}};
const mobileDefaults={...defaults,enabled:true,deviceName:'Calcite 手机'};
function restoreConflicts(rows,dir) {
  if(!Array.isArray(rows))return [];
  const relocate=value=>{
    const file=vaultStoragePath(value);
    // Older settings could retain an absolute path after this vault was renamed.
    const relative=file!==dir&&within(dir,file)?paths.relative(dir,file):/^\/CalciteVaults\/[^/]+\/(.+)$/.exec(file)?.[1];
    if(!relative||relative.split('/').some(part=>/^\.(?:git|calcite|trash)$/i.test(part)))return null;
    return posixPath(dir,relative);
  };
  return rows.flatMap(row=>{
    const path=relocate(row?.path),copy=relocate(row?.copy);
    return path&&(!row.copy||copy)?[{...row,path,copy}]:[];
  });
}

export function createLocalGit({fs,readSetting,saveSetting,serialize,atomicWrite,archive,applied,
  secretStore=createMobileSecrets(),native,testLoopback=false,timing={},peerTimeouts={},storageWarning=()=>''}) {
  // isomorphic-git's browser index parser uses Buffer as a global.
  globalThis.Buffer??=Buffer;
  const io=fs.promises,listeners=new Set();
  const Engine=createGitEngine({fs:io,path:paths,atomicWrite,sandboxed:true,within,withSession:fs.withSession,freshStat:fs.freshStat});
  let state,connection={connected:true,connectionType:'unknown'},foreground=true;
  const remoteTransfers=new Set();

  function view(s=state) {
    if(!s)return {settings:{...mobileDefaults},status:'off',logs:[],conflicts:[],pendingCount:0,canEncrypt:true};
    const {settings,status,logs,conflicts,pendingCount,secrets}=s;
    return {settings:{...settings},status,progress:s.progress,logs:[...logs],conflicts:[...conflicts],pendingCount,
      lastSyncedAt:s.lastSyncedAt,
      canEncrypt:secretStore.available,hasToken:!!secrets.pat,hasPeerToken:!!secrets.peer};
  }
  function report(s,status,message,counts,progress) {
    if(s!==state)return;
    s.status=status;
    s.progress=progress;
    if(message)s.logs=[{time:Date.now(),mode:s.settings.mode,status,message,...counts},...s.logs].slice(0,20);
    const value=view(s);
    listeners.forEach(listener=>listener(value));
  }
  function current() {
    if(!state)throw Error('请先打开 Vault。');
    return state;
  }
  const author=s=>({name:s.settings.name,email:s.settings.email});
  const remember=s=>saveSetting('git:'+s.dir,vaultRecord(s.settings,{vaultId:s.id,lastSynced:s.lastSynced,
    lastSyncedAt:s.lastSyncedAt,remoteSync:s.remoteSync,conflicts:s.conflicts}));
  async function open(s) {
    if(!s.initialized){
      try{await s.engine.open();s.initialized=true;}
      catch(error){report(s,'error','本地 Git 初始化失败：'+error.message);throw error;}
    }
  }
  async function refresh(s) {
    s.pendingCount=await pendingCommits(s.engine,s.lastSynced);
    s.conflicts=await findConflicts(s.engine,s.conflicts,io,posixPath);
  }
  async function snapshot(s,announce=true) {
    if(s!==state||!s.settings.enabled)return;
    await open(s);
    const old=await s.engine.head(),head=await s.engine.snapshot(author(s));
    if(announce) {
      await refresh(s);
      const linked=configured(s.settings);
      report(s,s.conflicts.length?'conflict':linked&&s.pendingCount?'pending':'synced',
        head!==old?'已提交本地版本。':null);
    }
    return head;
  }
  async function peer(s) {
    const info=await Promise.any((s.settings.endpoints?.length?s.settings.endpoints:[s.settings.peerUrl]).map(async url=>{
      const client=createCapacitorPeer({url,token:s.secrets.peer,vaultId:s.settings.peerVaultId,native,...peerTimeouts});
      const answer=await client.call('info');
      if(answer?.vaultId!==s.settings.peerVaultId)throw Error('对端 Vault ID 不匹配。');
      return {client,answer};
    })).catch(error=>{throw peerFailure(error);});
    return info;
  }
  function remote(s) {
    const url=repositoryUrl(s.settings.remoteUrl,testLoopback),origin=new URL(url).origin;
    return {url,http:createCapacitorGitHttp(url,{native,testLoopback}),
      onAuth:address=>s.secrets.pat&&new URL(address).origin===origin?
        {username:s.settings.remoteUser||'oauth2',password:s.secrets.pat}:null};
  }
  async function sync(s) {
    if(s!==state||!s.settings.enabled)return view();
    const start=Date.now();
    const settings=s.settings;
    const check=()=>{
      if(s!==state||s.settings!==settings)throw Error('工作区或同步设置已变更，请重新同步。');
    };
    const write=task=>serialize(async()=>{check();return task();});
    const progress=value=>{
      if(s.settings===settings)report(s,'working',null,null,value);
    };
    progress({phase:'snapshot'});
    let pull=0;
    if(!configured(settings)) {
      await write(()=>snapshot(s));
      return view(s);
    }
    const head=await write(async()=>{s.changedDuringSync=false;return snapshot(s,false);});
    progress({phase:'connect'});
    const accept=(oid,timings)=>write(async()=>{
      if(await s.engine.head()!==head||s.changedDuringSync){
        s.changedDuringSync=false;
        await snapshot(s,false);
      }
      const result=await s.engine.apply(oid,author(s),{progress:timings?value=>progress({...value,timings}):progress,
        onBatch:rows=>applied?.(s.dir,rows)});
      s.conflicts=rememberConflicts(s.conflicts,result.conflicts);
      if(result.conflicts.length)await remember(s);
      for(const row of result.resolved)report(s,'working',row.relative+' 存在并发修改，已保留最新版本。'+
        (row.backedUp?'旧版已存入版本历史。':''),{backup:row.backedUp?row.path:undefined});
      pull+=result.changes.length;
    });
    let result;
    if(settings.mode==='lan') {
      const {client}=await peer(s);
      check();
      const guarded={
        ...client,
        call:(...args)=>{check();return client.call(...args);},
        readObject:oid=>{check();return client.readObject(oid);},
        writeObject:row=>{check();return client.writeObject(row);}
      };
      result=await exchange(s.engine,guarded,head,accept,{progress,batchBytes:pullLimit,write});
    } else {
      check();
      remoteTransfers.add(s.dir);
      try{
        const transport=remote(s),branch=settings.branch;
        const last=s.remoteSync?.url===transport.url&&s.remoteSync.branch===branch?s.remoteSync.head:undefined;
        result=await syncRemote(s.engine,transport,branch,accept,{last,progress,currentHead:()=>write(async()=>{
          if(!s.changedDuringSync)return s.engine.head();
          s.changedDuringSync=false;
          return snapshot(s,false);
        })});
        s.remoteSync={url:transport.url,branch,head:result.head};
      }
      finally{remoteTransfers.delete(s.dir);}
    }
    await write(async()=>{
      s.lastSynced=result.head;
      s.lastSyncedAt=Date.now();
      await refresh(s);
      await remember(s);
    });
    report(s,s.conflicts.length?'conflict':s.changedDuringSync?'pending':'synced',result.upToDate?'已是最新。':'同步完成。',
      {pull,push:result.push,conflict:s.conflicts.length,duration:Date.now()-start,timings:result.timings});
    return view(s);
  }
  function mount(dir,legacyKey) {
    state?.controller?.dispose();
    state=null;
    if(!dir)return;
    const s=state={dir,settings:mobileDefaults,secrets:{},logs:[],status:'pending',conflicts:[],pendingCount:0};
    s.ready=initialize(s,legacyKey).catch(error=>{
      report(s,'error','无法初始化此知识库的同步：'+error.message);
    });
    return s.ready;
  }
  async function initialize(s,legacyKey) {
    const {dir}=s;
    const canonical=await readSetting('git:'+dir);
    const saved=canonical||(legacyKey&&await readSetting('git:'+legacyKey));
    const id=saved?.vaultId||randomId();
    const secrets=await secretStore.read(id);
    if(s!==state)return;
    Object.assign(s,{id,settings:{...mobileDefaults,...(saved?.settings||saved),listen:false},secrets,
      engine:new Engine(dir),conflicts:restoreConflicts(saved?.conflicts,dir),
      lastSynced:saved?.lastSynced,lastSyncedAt:saved?.lastSyncedAt,remoteSync:saved?.remoteSync});
    s.controller=createSyncScheduler({
      ...timing,policy:()=>({...s.settings,configured:configured(s.settings),pending:s.pendingCount>0,wifiOnly:wifiOnly(s.settings)}),
      network:()=>connection,snapshot:()=>serialize(()=>snapshot(s)),sync:async()=>{
        s.changedDuringSync=false;
        return sync(s);
      },
      probe:()=>peer(s).then(()=>true),
      onOffline:()=>{if(s.status!=='offline')report(s,'offline','当前网络不满足同步条件，修改保留在本机。');},
      onError:error=>report(s,s.status==='error'?'error':s.conflicts.length?'conflict':
        ['SYNC_OFFLINE','LAN_UNREACHABLE','LAN_TIMEOUT','LAN_REFUSED'].includes(error.code)?'offline':'pending',error.message)
    });
    if(!canonical?.vaultId)await remember(s);
    if(s!==state)return;
    if(s.settings.enabled) {
      if(await fs.exists(posixPath(dir,'.git'))) {
        await open(s);
        await refresh(s);
      }
      if(s!==state)return;
      s.controller.changed();
      s.controller.enter(foreground);
      s.controller.refresh();
      report(s,s.conflicts.length?'conflict':(s.lastSyncedAt||s.lastSynced)&&!s.pendingCount?'synced':'pending',storageWarning());
    }else report(s,'off',storageWarning());
  }
  async function saveConfig(s,options,next,secrets) {
    if(s!==state)throw Error('工作区已切换，请重新配置。');
    if(next.enabled)await open(s);
    const before={settings:s.settings,secrets:s.secrets};
    const writes={};
    if(options.pat!==undefined||next.remoteUrl!==before.settings.remoteUrl)writes.pat=secrets.pat;
    if(secrets.peer!==before.secrets.peer)writes.peer=secrets.peer;
    s.settings=next;s.secrets=secrets;
    try{
      await secretStore.write(s.id,writes);
      await remember(s);
    }catch(error){
      Object.assign(s,before);
      const restore=Object.fromEntries(Object.keys(writes).map(name=>[name,before.secrets[name]]));
      try{await secretStore.write(s.id,restore);}
      catch(rollbackError){
        throw Error(error.message+' 恢复先前凭据失败，请重新打开 Vault 后重试。',
          {cause:new AggregateError([error,rollbackError])});
      }
      throw error;
    }
    if(next.enabled){
      s.controller.changed();
      s.controller.refresh();
    }
    report(s,next.enabled?(s.conflicts.length?'conflict':'pending'):'off','已保存同步设置。');
    return view(s);
  }
  async function configure(options) {
    const s=await ready();
    const before=s.settings;
    const {next,secrets}=applySettings(before,options,s.secrets,{mobile:true,testLoopback});
    if(options.pairing)await peer({...s,settings:next,secrets});
    return serialize(()=>{
      if(before!==s.settings)throw Error('同步设置已变更，请重新操作。');
      return saveConfig(s,options,next,secrets);
    });
  }
  async function test() {
    const s=await ready();
    if(!configured(s.settings))return {ok:false,message:'请先扫描、粘贴配对串，或填写仓库地址。'};
    try{
      if(s.settings.mode==='lan') {
        const {answer}=await peer(s);
        return {ok:true,message:'已连接 '+String(answer.deviceName||'桌面端').slice(0,80)};
      }
      await git.getRemoteInfo2({...remote(s),forPush:true,protocolVersion:1});
      return {ok:true,message:'已连接远程仓库。'};
    }catch(error){return {ok:false,message:s.settings.mode==='lan'?error.message:remoteError(error)};}
  }
  async function ready() {
    const s=current();
    await s.ready;
    if(s!==state)throw Error('工作区已切换，请重试。');
    if(!s.controller)throw Error(s.logs[0]?.message||'同步初始化失败。');
    return s;
  }
  const run=async()=>{
    const s=await ready();
    if(!s.settings.enabled)throw Error('请先启用同步。');
    if(!configured(s.settings))return serialize(async()=>{await snapshot(s);return view(s);});
    return s.controller.manual();
  };
  async function resolve(copy,choice) {
    const s=current();
    const row=s.conflicts.find(item=>(item.copy||item.path)===copy);
    if(!row||!['keep','apply','archive'].includes(choice))throw Error('找不到该冲突，或处理方式无效。');
    await open(s);
    const rows=await resolveConflict(s.engine,row,choice,{io,write:atomicWrite,archive});
    s.conflicts=s.conflicts.filter(item=>item!==row);
    await s.engine.snapshot(author(s));
    await refresh(s);
    await remember(s);
    if(rows.length)await applied?.(s.dir,rows);
    s.controller.changed();
    report(s,s.conflicts.length?'conflict':'pending','已处理冲突。');
    return view(s);
  }
  async function archiveConflicts() {
    const s=await ready();
    const rows=await findConflicts(s.engine,s.conflicts,io,posixPath,{all:true});
    const archives=[];
    for(const row of rows){
      if(!row.copy)continue;
      const changes=await resolveConflict(s.engine,row,'archive',{io,write:atomicWrite,archive});
      s.conflicts=s.conflicts.filter(item=>item.copy!==row.copy);
      await applied?.(s.dir,changes);
      archives.push(row.path);
    }
    await snapshot(s,false);
    s.engine.legacyCandidates=undefined;
    await refresh(s);await remember(s);
    s.controller.changed();
    report(s,s.conflicts.length?'conflict':s.pendingCount?'pending':'synced',
      '已归档 '+archives.length+' 个历史冲突副本。',{archives});
    return view(s);
  }
  return {
    async summary(dir) {
      if(state?.dir===dir) {
        const {settings,status}=state;
        return status==='error'?'error':!settings.enabled||!configured(settings)?'local':status==='synced'?'synced':'pending';
      }
      const saved=await readSetting('git:'+dir);
      const settings={...mobileDefaults,...(saved?.settings||saved)};
      if(!settings.enabled||!configured(settings))return 'local';
      try {
        if((saved.lastSyncedAt||saved.lastSynced)&&!saved.conflicts?.length&&await fs.exists(posixPath(dir,'.git','HEAD'))&&
          await new Engine(dir).head()===saved.lastSynced)return 'synced';
      }catch{return 'error';}
      return 'pending';
    },
    guardTransfer(...paths) {
      if(paths.some(path=>remoteTransfers.has(path)))throw Error('远程同步正在进行，请完成后再管理此知识库。');
    },
    async checkpoint(dir){
      const s=state;
      if(s?.dir!==dir)return;
      await s.ready;
      if(s!==state||!s.engine)return;
      await snapshot(s,false).catch(error=>report(s,'error','无法保存本地 Git 版本：'+error.message));
    },
    mount,schedule(dir,...files){
      if(state?.dir!==dir||!state.settings.enabled)return;
      state.engine?.markDirty(files);
      state.changedDuringSync=true;
      state.controller?.changed();
      if(!['working','error'].includes(state.status))report(state,state.conflicts.length?'conflict':'pending');
    },
    commit:dir=>{
      const s=state;
      return s?.dir===dir?serialize(async()=>{await s.ready;if(s.engine)return snapshot(s,s.status!=='working');}):Promise.resolve();
    },
    focus(active){foreground=active;state?.controller?.enter(active);},
    network(value){
      if(connection.connected===value.connected&&connection.connectionType===value.connectionType)return;
      connection=value;
      if(connection.connected||state?.settings.mode==='lan'&&['wifi','ethernet','cellular'].includes(connection.connectionType))state?.controller?.reconnect();
      else if(state&&configured(state.settings))report(state,'offline','网络已断开，修改保留在本机。');
    },
    forget(dir){if(state?.dir===dir){state.controller?.dispose();state=null;}},
    async move(old,dir){
      const data=await readSetting('git:'+old);
      if(!data)return;
      await saveSetting('git:'+dir,{...data,conflicts:restoreConflicts(data.conflicts,dir)});
      try{await saveSetting('git:'+old,null);}
      catch(error){await saveSetting('git:'+dir,null);throw error;}
    },
    async remove(dir){
      const data=await readSetting('git:'+dir);
      await saveSetting('git:'+dir,null);
      if(data?.vaultId)await secretStore.write(data.vaultId,{peer:'',pat:''});
    },
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    api:{status:async()=>view(),run,test,configure,
      async importRemote(packet){
        const s=current(),config=await importRemoteConfig(packet,native);
        if(s!==state)throw Error('工作区已切换，请重新扫描。');
        return configure({...config,mode:'remote',enabled:true});
      },
      resolve:(copy,choice)=>serialize(()=>resolve(copy,choice)),
      archiveConflicts:()=>serialize(archiveConflicts),
      async conflictFiles(copy){
        const s=await ready(),row=s.conflicts.find(item=>(item.copy||item.path)===copy);
        if(!row)throw Error('找不到该冲突，请刷新冲突列表。');
        return readConflict(s.engine,row,io);
      },
      restoreVersion:(file,id)=>serialize(async()=>{
        const s=await ready();
        await s.engine.restoreVersion(file,id,{onBatch:rows=>applied?.(s.dir,rows)});
        s.engine.markDirty([file]);
        s.changedDuringSync=true;
        s.controller.changed();
      }),
      clearConflict:copy=>serialize(()=>resolve(copy,'archive'))},
    async history(dir,file,id) {
      if(!dir)throw Error('请先打开 Vault。');
      const engine=new Engine(dir);
      file=await engine.workspaceFile(file);
      if(id==='current'&&(await engine.history.list(file)).length)return (await readConflictFile(engine,file,io)).text;
      if(id&&isSyncVersion(id))return new TextDecoder().decode(/** @type {Uint8Array} */ (await engine.history.read(file,id)));
      const snapshots=id?[]:await engine.history.list(file);
      if(!await fs.exists(posixPath(dir,'.git','HEAD')))return snapshots;
      const filepath=file.slice(dir.length+1);
      if(id)return new TextDecoder().decode((await git.readBlob({fs,dir,oid:id,filepath})).blob);
      const versions=[];
      for(const {oid,commit} of await git.log({fs,dir,depth:30}).catch(error=>{
        if(error.code==='NotFoundError')return [];
        throw error;
      })) {
        try{await git.readBlob({fs,dir,oid,filepath});}
        catch(error){if(error.code==='NotFoundError')continue;throw error;}
        versions.push({id:oid,time:commit.author.timestamp*1000});
      }
      return [...snapshots,...versions].sort((a,b)=>b.time-a.time);
    }
  };
}
