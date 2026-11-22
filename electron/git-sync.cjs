const crypto=require('node:crypto');
const os=require('node:os');
const fs=require('node:fs/promises');
const path=require('node:path');
const git=require('isomorphic-git');
const httpClient=require('isomorphic-git/http/node');
const QRCode=require('qrcode');
const {atomicWrite}=require('./workspace.cjs');
const {GitEngine}=require('./git-engine.cjs');
const {exchange,listenPeer,peerClient}=require('./lan-sync.cjs');
const {createConfigPair}=require('./config-pair.cjs');
const {applySettings,configured,defaults:base,repositoryUrl,remoteError,vaultRecord,wifiOnly,writePacket}=require('../shared/core/sync-config.mjs');
const {peerFailure,syncUrl}=require('../shared/sync-url.mjs');
const {syncRemote,pendingCommits}=require('../shared/sync-remote.mjs');
const {createSyncScheduler}=require('../shared/core/sync-scheduler.mjs');
const {findConflicts,readConflict,rememberConflicts,resolveConflict}=require('../shared/core/sync-conflicts.mjs');

const newToken=()=>crypto.randomBytes(32).toString('hex');
const defaults={...base,deviceName:os.hostname().slice(0,80)};
const author=s=>({name:s.settings.name||'Calcite',email:s.settings.email||'calcite@local'});
const sharing=s=>s.server&&!s.settings.peerUrl?'本机局域网共享已就绪（端口 '+s.server.port+'），请在手机端扫码或发起同步。':'';

function createGitSync({safeStorage,net,read,write,run,publish,reserve,applied,archive,network=true,allowLocal=false,timing={}}) {
  let state,foreground=true,connection={connected:true,connectionType:'unknown'};
  const secured=()=>safeStorage.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text';
  const decode=value=>{
    if(!value||!secured())return '';
    try{return safeStorage.decryptString(Buffer.from(value,'base64'));}catch{return '';}
  };
  const encode=value=>value&&secured()?safeStorage.encryptString(value).toString('base64'):undefined;
  function report(s,status,message,counts,progress) {
    if(s!==state)return;
    s.status=status;
    s.progress=progress;
    if(message)s.logs=[{time:Date.now(),mode:s.settings.mode,status,message,...counts},...s.logs].slice(0,20);
    publish(view());
  }
  function current() {
    if(!state)throw Error('请先打开工作区。');
    return state;
  }
  function view() {
    if(!state)return {settings:{...defaults},status:'off',logs:[],conflicts:[],pendingCount:0,canEncrypt:secured()};
    const {settings,status,logs,conflicts,server,pat,peerToken,pendingCount}=state;
    return {settings:{...settings},status,progress:state.progress,notice:sharing(state),logs:[...logs],conflicts:[...conflicts],pendingCount,canEncrypt:secured(),
      hasToken:!!pat,hasPeerToken:!!peerToken,port:server?.port};
  }
  async function remember(s) {
    const record=vaultRecord({...s.settings},{vaultId:s.vaultId,lastSynced:s.lastSynced,remoteSync:s.remoteSync,conflicts:s.conflicts.slice(0,100)});
    record.encrypted={pat:encode(s.pat),peer:encode(s.peerToken),lan:encode(s.token)};
    await write(s.root,record);
  }
  async function enable(s) {
    if(!s.initialized){await s.engine.open();s.initialized=true;}
  }
  async function refresh(s) {
    s.pendingCount=await pendingCommits(s.engine,s.lastSynced);
    s.conflicts=await findConflicts(s.engine,s.conflicts,fs,path.join);
  }
  async function snapshot(s,announce=true) {
    if(s!==state||!s.settings.enabled)return;
    await enable(s);
    const old=await s.engine.head(),head=await s.engine.snapshot(author(s));
    if(announce){
      await refresh(s);
      report(s,s.conflicts.length?'conflict':s.pendingCount?'pending':'synced',head!==old?'已提交本地版本。':null);
    }
    return head;
  }
  async function accept(s,head,timings) {
    if(s!==state||!s.settings.enabled)throw Error('工作区同步已关闭。');
    const result=await s.engine.apply(head,author(s),{
      beforeWrite:rows=>reserve(s.root,rows),
      progress:value=>report(s,'working',null,null,timings?{...value,timings}:value),
      onBatch:rows=>applied(s.root,rows)
    });
    s.conflicts=rememberConflicts(s.conflicts,result.conflicts);
    if(result.conflicts.length)await remember(s);
    for(const row of result.resolved)report(s,'working',row.relative+' 存在并发修改，已保留最新版本。'+
      (row.backedUp?'旧版已存入版本历史。':''),{backup:row.backedUp?row.path:undefined});
    return result.changes.length;
  }
  async function startServer(s) {
    s.server?.close();s.server=null;
    if(!s.settings.enabled||s.settings.mode!=='lan'||!s.settings.listen)return;
    const options={engine:s.engine,vaultId:s.vaultId,deviceName:s.settings.deviceName,token:s.token,network,
      onError:()=>report(s,'pending','局域网广播或监听遇到错误。'),
      prepare:()=>s.snapshotInProgress||run(()=>snapshot(s,false)),
      receive:(head,shallow)=>{
        const job=run(async()=>{
          const start=Date.now();
          if(s!==state||!s.settings.enabled)throw Error('工作区已切换。');
          await snapshot(s,false);
          if(shallow?.length)await s.engine.importShallow(shallow);
          await git.writeRef({...s.engine.args,ref:'refs/remotes/peer/main',value:head,force:true});
          const pull=await accept(s,head);
          s.lastSynced=await s.engine.head();
          await refresh(s);await remember(s);
          report(s,s.conflicts.length?'conflict':'synced','已接收局域网 Git 提交。',{pull,push:0,conflict:s.conflicts.length,duration:Date.now()-start});
        });
        if(!s.snapshotInProgress)return job;
        job.catch(error=>report(s,'pending',error.message));
      }};
    const preferred=s.settings.port||27183;
    for(let port=preferred;port<preferred+(s.settings.port?1:32);port++)try{
      s.server=await listenPeer({...options,port});
      if(!s.settings.port)s.settings.port=s.server.port;
      return;
    }catch(error){
      if(error.code!=='EADDRINUSE'||s.settings.port||port===preferred+31)throw error;
    }
  }
  async function switchVault(root) {
    const old=state;
    if(old) {
      old.controller.dispose();old.server?.close();old.transfer?.close();
      if(old.settings.enabled&&old.initialized)await snapshot(old,false).catch(()=>{});
    }
    state=null;
    if(!root){publish(view());return;}
    const saved=await read(root);
    const s=state={root,engine:new GitEngine(root),settings:{...defaults,...saved?.settings},vaultId:saved?.vaultId||crypto.randomUUID(),
      lastSynced:saved?.lastSynced,remoteSync:saved?.remoteSync,pendingCount:0,token:decode(saved?.encrypted?.lan)||newToken(),
      pat:decode(saved?.encrypted?.pat),peerToken:decode(saved?.encrypted?.peer),logs:[],
      conflicts:Array.isArray(saved?.conflicts)?saved.conflicts.slice(0,100):[],status:'off'};
    s.controller=createSyncScheduler({
      ...timing,policy:()=>({...s.settings,wifiOnly:wifiOnly(s.settings),configured:configured(s.settings),pending:s.pendingCount>0}),
      network:()=>connection,snapshot:()=>run(()=>snapshot(s)),sync:()=>run(()=>sync(s)),probe:()=>peer(s).then(()=>true),
      onOffline:()=>{if(s.status!=='offline')report(s,'offline','当前网络不满足同步条件，修改保留在本机。');},
      onError:error=>report(s,s.conflicts.length?'conflict':
        ['SYNC_OFFLINE','LAN_UNREACHABLE','LAN_TIMEOUT','LAN_REFUSED'].includes(error.code)?'offline':'pending',error.message)
    });
    if(s.settings.enabled)try{
      const previousPort=s.settings.port;
      await enable(s);await refresh(s);await startServer(s);
      if(s.settings.port!==previousPort)await remember(s);
      s.controller.changed();s.controller.enter(foreground);
      report(s,s.conflicts.length?'conflict':'pending');
    }catch(error){report(s,'pending',error.message);}
    else publish(view());
  }

  async function configure(options) {
    const s=current(),previous=s.settings;
    const prior={pat:s.pat,peer:s.peerToken};
    const {next,secrets}=applySettings(previous,options,prior,{testLoopback:allowLocal});
    if(next.enabled)await enable(s);
    s.settings=next;s.pat=secrets.pat;s.peerToken=secrets.peer;
    const serverChanged=['enabled','mode','listen','port','deviceName'].some(key=>next[key]!==previous[key]);
    try{
      if(serverChanged||!s.server&&next.enabled&&next.mode==='lan'&&next.listen)await startServer(s);
      await remember(s);
    }catch(error){
      s.settings=previous;s.pat=prior.pat;s.peerToken=prior.peer;
      if(serverChanged)await startServer(s).catch(()=>{});
      throw error;
    }
    if(next.remoteUrl!==previous.remoteUrl||next.branch!==previous.branch||s.pat!==prior.pat||!next.enabled)s.transfer?.close();
    report(s,next.enabled?(s.conflicts.length?'conflict':sharing(s)?'synced':'pending'):'off',
      next.enabled?sharing(s)||'同步设置已保存。':'已关闭同步。');
    s.controller.refresh();
    if(next.enabled)s.controller.changed();
    return view();
  }
  async function peer(s) {
    const urls=s.settings.endpoints?.length?s.settings.endpoints:[s.settings.peerUrl];
    return Promise.any(urls.map(async url=>{
      const client=peerClient({url,token:s.peerToken,vaultId:s.settings.peerVaultId});
      const info=await client.call('info');
      if(info?.vaultId!==s.settings.peerVaultId)throw Error('对端 Vault ID 不匹配。');
      return {client,info};
    })).catch(error=>{throw peerFailure(error);});
  }
  function remote(s) {
    const url=repositoryUrl(s.settings.remoteUrl,allowLocal),origin=new URL(url).origin;
    return {url,http:{async request(args){
      const target=syncUrl(args.url,{testLoopback:allowLocal,request:true});
      if(target.origin!==origin)throw Error('拒绝跨站 Git 请求。');
      const timeout=AbortSignal.timeout(40000);
      const signal=args.signal?AbortSignal.any([args.signal,timeout]):timeout;
      let result;
      if(net?.fetch) {
        const chunks=[];
        if(args.body)for await(const chunk of args.body instanceof Uint8Array?[args.body]:args.body)
          chunks.push(Buffer.from(chunk));
        const response=await net.fetch(target.href,{method:args.method,headers:args.headers,signal,
          redirect:'manual',credentials:'omit',bypassCustomProtocolHandlers:true,
          ...(args.body?{body:Buffer.concat(chunks)}:{})});
        result={url:target.href,statusCode:response.status,statusMessage:response.statusText,
          headers:Object.fromEntries(response.headers),body:response.body||[]};
      }else{
        result=await httpClient.request({...args,signal,fetchOptions:{...args.fetchOptions,followRedirects:false}});
      }
      if(result.statusCode>=300&&result.statusCode<400){
        await result.body.cancel?.().catch(()=>{});
        result.body.destroy?.();
        throw Error('Git 服务器重定向已拦截。');
      }
      return result;
    }},onAuth:authUrl=>s.pat&&new URL(authUrl).origin===origin?{username:s.settings.remoteUser||'oauth2',password:s.pat}:null};
  }

  async function test() {
    const s=current();
    if(s.settings.mode==='lan') {
      if(!s.settings.peerUrl)return {ok:!!s.server,message:sharing(s)||'请先开启服务或填写对端地址。'};
      try {const {info}=await peer(s);return {ok:true,message:'已连接 '+String(info.deviceName||'对端').slice(0,80)};}
      catch(error){return {ok:false,message:error.message};}
    }
    try {
      const result=await git.getRemoteInfo2({...remote(s),forPush:true,protocolVersion:1});
      return {ok:true,message:result.refs.some(row=>row.ref.startsWith('refs/heads/'))?'连接成功，远程仓库接受推送协议。':'连接成功，空仓库等待首次推送。'};
    }catch(error){return {ok:false,message:remoteError(error)};}
  }

  async function sync(s) {
    if(s!==state||!s.settings.enabled)return view();
    const start=Date.now();
    const progress=value=>report(s,'working',null,null,value);
    progress({phase:'snapshot'});
    try {
      s.snapshotInProgress=snapshot(s,false);
      const head=await s.snapshotInProgress;
      let pull=0,result;
      const receive=async(remoteHead,timings)=>{pull+=await accept(s,remoteHead,timings);};
      if(s.settings.mode==='lan'&&s.settings.peerUrl) {
        progress({phase:'connect'});
        const {client}=await peer(s);
        result=await exchange(s.engine,client,head,async remoteHead=>{
          await git.writeRef({...s.engine.args,ref:'refs/remotes/peer/main',value:remoteHead,force:true});
          await receive(remoteHead);
        },{progress});
      }else if(s.settings.mode==='remote'&&s.settings.remoteUrl) {
        const transport=remote(s),branch=s.settings.branch;
        const last=s.remoteSync?.url===transport.url&&s.remoteSync.branch===branch?s.remoteSync.head:undefined;
        result=await syncRemote(s.engine,transport,branch,receive,{last,progress});
        s.remoteSync={url:transport.url,branch,head:result.head};
      }else {
        await refresh(s);
        report(s,s.conflicts.length?'conflict':sharing(s)?'synced':'pending',sharing(s)||'已保存本机 Git 版本，等待配置对端。');
        return view();
      }
      s.lastSynced=result.head;
      await refresh(s);await remember(s);
      report(s,s.conflicts.length?'conflict':'synced',result.upToDate?'已是最新。':'同步完成。',
        {pull,push:result.push,conflict:s.conflicts.length,duration:Date.now()-start,timings:result.timings});
      return view();
    }finally{s.snapshotInProgress=null;}
  }

  function arm() {
    if(!state?.settings.enabled)return;
    const s=state;
    if(s.status!=='working')report(s,s.conflicts.length?'conflict':'pending');
    s.controller.changed();
  }
  async function pair() {
    const s=current();if(!s.server)throw Error('请先开启局域网共享。');
    const {url,endpoints}=s.server;
    const packet=writePacket('calcite-sync:',{url,endpoints:endpoints.slice(0,10),peerName:s.settings.deviceName,vaultId:s.vaultId,token:s.token});
    return {packet,url,vaultId:s.vaultId,image:await QRCode.toDataURL(packet,{margin:2,width:300})};
  }
  async function remotePair() {
    const s=current();
    if(!s.settings.enabled||s.settings.mode!=='remote'||!s.settings.remoteUrl)throw Error('请先保存远程仓库设置。');
    const {remoteUrl,remoteUser,branch,name,email,wifiOnly}=s.settings;
    s.transfer?.close();
    s.transfer=await createConfigPair({remoteUrl,remoteUser,branch,name,email,wifiOnly,pat:s.pat},{network});
    return s.transfer.view;
  }
  async function revoke() {
    const s=current();s.token=newToken();await startServer(s);await remember(s);report(s,'pending','原有配对已吊销。');
    return s.server?pair():null;
  }
  async function clearConflict(copy) {
    const s=current();s.conflicts=s.conflicts.filter(row=>(row.copy||row.path)!==copy);
    await remember(s);report(s,s.conflicts.length?'conflict':'pending');return view();
  }
  async function resolve(copy,choice) {
    const s=current(),row=s.conflicts.find(item=>(item.copy||item.path)===copy);
    if(!row)throw Error('找不到该冲突，请刷新冲突列表。');
    await enable(s);
    const rows=await resolveConflict(s.engine,row,choice,{io:fs,write:atomicWrite,archive,beforeWrite:items=>reserve(s.root,items)});
    await s.engine.snapshot(author(s));
    if(rows.length)await applied(s.root,rows);
    await clearConflict(copy);await refresh(s);arm();
    return view();
  }
  async function archiveConflicts() {
    const s=current();
    const rows=await findConflicts(s.engine,s.conflicts,fs,path.join,{all:true});
    const archives=[];
    for(const row of rows){
      if(!row.copy)continue;
      const changes=await resolveConflict(s.engine,row,'archive',{io:fs,write:atomicWrite,archive,
        beforeWrite:items=>reserve(s.root,items)});
      s.conflicts=s.conflicts.filter(item=>item.copy!==row.copy);
      await applied(s.root,changes);
      archives.push(row.path);
    }
    await snapshot(s,false);
    s.engine.legacyCandidates=undefined;
    await refresh(s);await remember(s);arm();
    report(s,s.status,'已归档 '+archives.length+' 个历史冲突副本。',{archives});
    return view();
  }
  return {switchVault,configure,view,test,arm,pair,revoke,remotePair,clearConflict,resolve,archiveConflicts,
    conflictFiles(copy) {
      const s=current(),row=s.conflicts.find(item=>(item.copy||item.path)===copy);
      if(!row)throw Error('找不到该冲突，请刷新冲突列表。');
      return readConflict(s.engine,row,fs);
    },
    async restoreVersion(file,id){
      const s=current();
      await s.engine.restoreVersion(file,id,{beforeWrite:rows=>reserve(s.root,rows),onBatch:rows=>applied(s.root,rows)});
      arm();
    },
    cancelRemotePair(){state?.transfer?.close();},
    request(){
      const s=current();if(!s.settings.enabled)throw Error('请先启用同步。');
      return configured(s.settings)?s.controller.manual():run(()=>sync(s));
    },
    focus(active){foreground=active;state?.controller.enter(active);},
    network(online){
      if(connection.connected===online)return;
      connection={connected:online,connectionType:'unknown'};
      if(online)state?.controller.reconnect();
      else if(state?.settings.enabled&&configured(state.settings))report(state,'offline','网络已断开，修改保留在本机。');
    },
    stop(){state?.controller.dispose();state?.server?.close();state?.transfer?.close();}
  };
}

module.exports={createGitSync};
