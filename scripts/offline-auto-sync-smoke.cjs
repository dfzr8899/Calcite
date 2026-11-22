const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const git=require('isomorphic-git');
const {memoryFilesystem}=require('./mobile-smoke.cjs');
const {boot,patch,text,put,head,gitFixture}=require('./v12-sync-smoke.cjs');

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,timeout=22000) {
  const end=Date.now()+timeout;
  let failure;
  while(Date.now()<end) {
    try{if(await check())return;}
    catch(error){failure=error;}
    await pause(80);
  }
  throw Error('Timed out: '+label,{cause:failure});
}
const offline={connected:false,connectionType:'none'},wifi={connected:true,connectionType:'wifi'};
const data={name:'Calcite',email:'calcite@local'};
const folder='/CalciteVaults/Stage4';

async function phone({testLoopback=false,initialNetwork=offline,peerTimeouts={}}={}) {
  const {createCapacitorGitFs,dirname}=await import('../src/platform/capacitor-git-fs.js');
  const {createLocalGit}=await import('../src/platform/capacitor-local-git.js');
  const {createMobileSecrets}=await import('../src/platform/capacitor-secure-storage.js');
  const store=memoryFilesystem(),reads=[];
  const readFile=store.readFile.bind(store);
  store.readFile=options=>{reads.push(options.path);return readFile(options);};
  const f=createCapacitorGitFs(store,'DOCUMENTS',{sandboxed:true}),disk=f.promises,preferences=new Map(),protectedValues=new Map();
  const stats={active:0,max:0,posts:0,blocked:false,incoming:[],batches:[],binaryPulls:0};
  const native={async request(options){
    assert.equal(options.disableRedirects,true);
    if(stats.blocked)throw Error('network offline');
    if(stats.hang&&options.url.endsWith('/objects/pull'))return new Promise(()=>{});
    stats.active++;stats.max=Math.max(stats.max,stats.active);
    if(options.method==='POST')stats.posts++;
    try{
      const response=await fetch(options.url,{method:options.method,headers:options.headers,redirect:'manual',
        signal:AbortSignal.timeout(options.readTimeout),
        ...(options.data!==undefined?{body:options.dataType==='file'?Buffer.from(options.data,'base64'):JSON.stringify(options.data)}:{})});
      const bytes=Buffer.from(await response.arrayBuffer());
      const binaryPull=options.responseType==='arraybuffer'&&new URL(options.url).pathname.startsWith('/api/sync/object/');
      if(binaryPull&&response.ok) {
        stats.binaryPulls++;
        if(stats.corruptBinaryPull)bytes[0]^=0xff;
      }
      let body=options.responseType==='arraybuffer'?bytes.toString('base64'):bytes.toString('utf8');
      // Android CapacitorHttp uses Base64.DEFAULT, including a line break every 76 characters.
      if(binaryPull)body=body.replace(/.{1,76}/g,'$&\n');
      return {status:response.status,url:response.url,headers:Object.fromEntries(response.headers),
        data:body};
    }finally{stats.active--;}
  }};
  const secretStore=createMobileSecrets({
    available:async()=>({available:true}),get:async({key})=>({value:protectedValues.get(key)}),
    async set({key,value}){
      if(value)protectedValues.set(key,value);
      else{
        if(stats.failClear)throw Error('Test keychain deletion failure');
        protectedValues.delete(key);
      }
    }
  });
  let queue=Promise.resolve();
  const serialize=task=>{const next=queue.then(task);queue=next.catch(()=>{});return next;};
  await disk.mkdir(folder,{recursive:true});
  const local=createLocalGit({fs:f,readSetting:async key=>preferences.get(key),
    saveSetting:async(key,value)=>{preferences.set(key,structuredClone(value));},serialize,
    atomicWrite:(file,value)=>disk.writeFile(file,value),async archive(file){
      const target=folder+'/.trash/'+file.split('/').at(-1);
      await disk.mkdir(dirname(target),{recursive:true});await disk.rename(file,target);
    },async applied(_,rows){
      stats.incoming.push(...rows.map(row=>row.file));
      stats.batches.push({files:rows.length,status:(await local.api.status()).status});
      await disk.readdir(folder);
      if(await f.exists(folder+'/X.md'))await disk.readFile(folder+'/X.md','utf8');
    },secretStore,native,testLoopback,peerTimeouts,
    timing:{snapshotDelay:120,syncDelay:220,cooldown:1200,backoff:[300,500,900]}});
  local.network(initialNetwork);
  await serialize(()=>local.mount(folder));
  return {local,api:local.api,stats,native,disk,preferences,protectedValues,reads,
    mtime(file,time){store.store.get('DOCUMENTS:'+folder.slice(1)+'/'+file).mtime=time;},
    async put(file,value){await serialize(async()=>{await disk.writeFile(folder+'/'+file,value);local.schedule(folder);});},
    read:(file,encoding='utf8')=>disk.readFile(folder+'/'+file,encoding||undefined),
    head:()=>git.resolveRef({fs:f,dir:folder,ref:'HEAD'}),
    close:()=>serialize(()=>local.mount(''))};
}

async function safety() {
  const {syncUrl}=await import('../shared/sync-url.mjs');
  const {createCapacitorGitHttp,createCapacitorPeer}=await import('../src/platform/capacitor-git-http.js');
  for(const host of ['192.168.1.42','10.0.0.2','172.16.1.2','172.31.255.7','100.64.1.2','100.127.255.2',
    '[fc00::2]','[fd00::2]','[fe80::1]','[febf::1]','[::1]','127.0.0.1','localhost','calcite.local'])
    assert.equal(syncUrl('http://'+host,{lan:true}).protocol,'http:');
  for(const host of ['192.169.1.2','172.15.0.2','172.32.0.2','100.63.1.2','100.128.1.2','[fec0::1]','[2001:db8::1]',
    '8.8.8.8','github.com','x.local.example.org'])
    assert.throws(()=>syncUrl('http://'+host,{lan:true}),/HTTPS/);
  assert.throws(()=>createCapacitorGitHttp('http://github.com/repo.git'),/HTTPS/);
  assert.throws(()=>createCapacitorGitHttp('https://user:token@github.com/repo.git'),/令牌/);
  let requests=0;
  const native={async request(options){requests++;assert(options.disableRedirects);return {status:302,url:options.url};}};
  const client=createCapacitorGitHttp('https://git.example.com/notes.git',{native});
  await assert.rejects(client.request({url:'https://example.org/notes.git'}),/跨站/);
  assert.equal(requests,0);
  await assert.rejects(client.request({url:'https://git.example.com/notes.git'}),/重定向/);
  assert.equal(requests,1);
  assert.throws(()=>createCapacitorPeer({url:'http://203.0.113.2',token:'0'.repeat(64),vaultId:'0'.repeat(36),native}),/HTTPS/);
  console.log('URL policy passed: private IPv4, IPv6, CGNAT, loopback and .local; public HTTP, userinfo and redirects blocked.');
}

async function credentialClearing() {
  const mobile=await phone();
  try {
    const pat='fixture-local-credential';
    await mobile.api.configure({enabled:false,mode:'remote',remoteUrl:'https://git.example.test/repo.git',pat});
    mobile.stats.failClear=true;
    for(let attempt=0;attempt<2;attempt++){
      await assert.rejects(mobile.api.configure({pat:''}),/无法从系统安全存储清除凭据，请重试/);
      assert.equal((await mobile.api.status()).hasToken,true);
      assert([...mobile.protectedValues.values()].includes(pat));
    }
    mobile.stats.failClear=false;
    assert.equal((await mobile.api.configure({pat:''})).hasToken,false);
    assert.equal(mobile.protectedValues.size,0);
    console.log('Credential clearing passed: native failures surface, the token remains visible as configured, and retry removes it.');
  }finally{await mobile.close();}
}

async function lanAndConflicts(scratch) {
  const desktop=await boot(path.join(scratch,'desktop-lan'));
  const mobile=await phone({peerTimeouts:{transferTimeout:1200}});
  try {
    for(const file of ['X.md','Y.md','C1.md','C2.md','D.md'])await put(desktop,file,'# '+file+'\n\n共同的行\n');
    await patch(desktop,{enabled:true,listen:true,auto:false});
    await desktop.invoke('sync:run');
    const pair=await desktop.invoke('sync:pair');
    await mobile.api.configure({enabled:true,auto:true,mode:'lan',pairing:pair.packet,...data});
    mobile.local.network({connected:true,connectionType:'cellular'});
    await until(async()=>await mobile.read('X.md')===await text(desktop,'X.md'),'initial LAN pairing');
    await until(async()=>(await mobile.api.status()).status==='synced','LAN initial status');
    const base=await mobile.head();
    mobile.local.network(offline);
    mobile.stats.blocked=true;
    await mobile.put('X.md','# X\n\n手机离线修改\n');
    await put(desktop,'Y.md','# Y\n\n桌面在线修改\n');
    await until(async()=>await mobile.head()!==base,'local commit while disconnected');
    await until(async()=>(await mobile.api.status()).status==='offline','offline status');
    assert.match(await text(desktop,'X.md'),/共同的行/);
    mobile.stats.blocked=false;
    mobile.local.network(wifi);
    await until(async()=>(await mobile.api.status()).status==='synced'&&
      (await text(desktop,'X.md')).includes('手机离线修改')&&
      (await mobile.read('Y.md')).includes('桌面在线修改'),'automatic LAN push and pull');
    assert.equal(await mobile.head(),await head(desktop));
    console.log('A passed: automatic LAN sync on cellular hotspot and two-way Wi-Fi reconnect.');

    await mobile.api.configure({auto:false});
    const states=[];
    const unsubscribe=mobile.local.subscribe(value=>states.push({status:value.status,...value.progress}));
    await Promise.all(Array.from({length:126},(_,i)=>put(desktop,'Bulk-'+i+'.md','# 批量笔记 '+i)));
    mobile.stats.hang=true;
    const hung=assert.rejects(mobile.api.run(),/局域网 .*连接超时/);
    await until(()=>states.some(row=>row.phase==='pull'),'hung pull started');
    assert.match(await mobile.read('X.md'),/手机离线修改/);
    await hung;
    assert.notEqual((await mobile.api.status()).status,'working');
    mobile.stats.hang=false;
    const started=Date.now();
    mobile.stats.batches.length=0;
    await mobile.api.run();
    const duration=Date.now()-started;
    assert(duration<20000);
    assert(mobile.stats.batches.length>=4&&mobile.stats.batches.every(row=>row.status==='working'));
    assert(states.some(row=>row.phase==='write'&&row.done>0&&row.done<row.total));
    assert(states.some(row=>row.phase==='index'));
    assert.match(await mobile.read('Bulk-125.md'),/125/);
    const desktopBinary=randomBytes(2*1024*1024+1);
    await fs.writeFile(path.join(desktop.root,'Desktop-large.bin'),desktopBinary);
    const beforePull=await mobile.head();
    mobile.stats.corruptBinaryPull=true;
    await assert.rejects(mobile.api.run(),/Git 对象哈希校验失败/);
    assert.equal(await mobile.head(),beforePull);
    await assert.rejects(mobile.read('Desktop-large.bin',null),{code:'ENOENT'});
    mobile.stats.corruptBinaryPull=false;
    await mobile.api.run();
    assert(mobile.stats.binaryPulls>=2);
    assert.deepEqual(Buffer.from(await mobile.read('Desktop-large.bin',null)),desktopBinary);
    const large=randomBytes(2*1024*1024+123);
    await mobile.put('Mobile-large.bin',large);
    await mobile.api.run();
    assert.deepEqual(await fs.readFile(path.join(desktop.root,'Mobile-large.bin')),large);
    unsubscribe();
    await mobile.api.configure({auto:true});
    console.log('Mobile batch passed: 126 notes in '+duration+' ms, timeout recovery, Android wrapped Base64 download, corrupt-object rejection and binary upload.');

    mobile.local.network(offline);mobile.stats.blocked=true;
    for(const file of ['C1.md','C2.md']) {
      await put(desktop,file,'# Conflicts\n\n桌面改了同行\n');
      await mobile.put(file,'# Conflicts\n\n手机改了同行\n');
    }
    mobile.mtime('C1.md',Date.now()-60000);
    mobile.mtime('C2.md',Date.now()+60000);
    const original=desktop.page.locator('[data-file]').getByText('C1.md',{exact:true});
    await original.click();
    mobile.stats.blocked=false;mobile.local.network(wifi);
    await until(async()=>(await mobile.api.status()).logs.filter(row=>row.backup).length>=2,'automatic conflict backups');
    for(const [name,winner,loser] of [['C1.md',/桌面改了同行/,/手机改了同行/],['C2.md',/手机改了同行/,/桌面改了同行/]]) {
      await until(async()=>winner.test(await text(desktop,name)),'desktop LWW '+name);
      assert.match(await mobile.read(name),winner);
      const file=folder+'/'+name;
      const version=(await mobile.local.history(folder,file)).find(row=>row.label?.includes('同步自动备份'));
      assert(version);
      assert.match(await mobile.local.history(folder,file,version.id),loser);
    }
    assert(!(await fs.readdir(desktop.root)).some(file=>file.includes('同步冲突')));
    assert(!(await mobile.disk.readdir(folder)).some(file=>file.includes('同步冲突')));
    console.log('C passed: same-line conflicts, both LWW directions, mobile version history and zero conflict copies.');

    await desktop.page.locator('[data-file]').getByText('D.md',{exact:true}).click();
    await desktop.page.locator('#auto-save').click();
    await desktop.page.locator('footer [data-mode=source]').click();
    const editor=desktop.page.locator('#source-editor .cm-content');
    await editor.focus();
    await desktop.page.keyboard.press('Control+End');
    await desktop.page.keyboard.insertText('\n活跃标签未保存草稿');
    await desktop.page.locator('.tab.active.dirty').waitFor();
    await mobile.put('D.md','# D\n\n手机同步版本\n');
    mobile.stats.max=0;
    await Promise.all(Array.from({length:12},()=>mobile.api.run()));
    assert.equal(mobile.stats.max,1);
    await desktop.page.locator('#external-change').getByText('同步版本已到达，当前草稿已保留。').waitFor();
    assert.match(await editor.textContent(),/活跃标签未保存草稿/);
    assert.match(await text(desktop,'D.md'),/手机同步版本/);
    await until(async()=>{
      const copies=(await fs.readdir(desktop.root)).filter(file=>/^D \(同步草稿 /.test(file));
      return copies.length===1&&(await text(desktop,copies[0])).includes('活跃标签未保存草稿');
    },'durable conflict draft copy');
    console.log('D passed: rapid sync requests remained serialized, active draft stayed in the editor and a separate copy.');
  }finally{await mobile.close();await desktop.close();}
}

async function byos(scratch) {
  const pat=randomBytes(32).toString('hex');
  const remote=await gitFixture(path.join(scratch,'remote'),pat);
  const desktop=await boot(path.join(scratch,'desktop-remote'));
  const mobile=await phone({testLoopback:true});
  try{
    await put(desktop,'Remote.md','起始\n\n公共段落\n\n尾行\n');
    await Promise.all(Array.from({length:174},(_,i)=>put(desktop,'Book-'+i+'.md','# Note '+i+'\n')));
    await patch(desktop,{enabled:true,mode:'remote',auto:false,remoteUrl:remote.url,remoteUser:'fixture',pat});
    await desktop.invoke('sync:run');
    const transfer=await desktop.invoke('sync:remote-pair');
    assert(transfer.expires>=Date.now()+50000);
    assert(!transfer.packet.includes(pat));
    const importer=await import('../src/platform/capacitor-git-http.js');
    const imported=await mobile.api.importRemote(transfer.packet);
    assert.equal(imported.settings.remoteUrl,remote.url);
    assert.equal(imported.hasToken,true);
    await assert.rejects(importer.importRemoteConfig(transfer.packet,mobile.native),/桌面|领取/);
    mobile.local.network(wifi);
    await until(async()=>(await mobile.read('Remote.md')).includes('公共段落'),'initial BYOS transfer');
    await until(async()=>(await mobile.api.status()).status==='synced','remote initial status');
    const noteReads=()=>[...new Set(mobile.reads.filter(file=>file.endsWith('.md')))];
    await mobile.api.configure({auto:false});
    remote.seen.length=mobile.reads.length=0;
    const fastStart=performance.now();
    const fast=await mobile.api.run();
    const fastTime=performance.now()-fastStart;
    assert(fastTime<1000,'mobile info/refs fast path: '+fastTime+' ms');
    assert.equal(fast.logs[0].message,'已是最新。');
    assert(remote.seen.length&&remote.seen.every(url=>url.includes('/info/refs?service=git-upload-pack')));
    assert.deepEqual(noteReads(),[]);
    console.log('Mobile 175-note fast path: '+fastTime.toFixed(1)+' ms total, '+JSON.stringify(fast.logs[0].timings)+', 0 note reads');
    await mobile.disk.unlink(folder+'/.git/calcite-worktree.json');
    mobile.reads.length=0;
    assert.equal((await mobile.api.run()).logs[0].message,'已是最新。');
    assert.deepEqual(noteReads(),[],'the Calcite Git index seeds the upgraded metadata without rehashing notes');
    const checkpoint=JSON.parse(await mobile.read('.git/calcite-worktree.json'));
    await mobile.disk.writeFile(folder+'/.git/calcite-worktree.json',JSON.stringify({...checkpoint,files:[null]}));
    mobile.reads.length=0;
    assert.equal((await mobile.api.run()).logs[0].message,'已是最新。');
    assert.deepEqual(noteReads(),[],'a malformed metadata cache is rebuilt from the Git index');
    mobile.reads.length=0;
    await mobile.put('Book-37.md','# One dirty note\n');
    const dirty=await mobile.api.run();
    assert.deepEqual(noteReads(),[folder.slice(1)+'/Book-37.md']);
    assert.equal(dirty.logs[0].push,1);
    console.log('Mobile 175-note push: '+dirty.logs[0].duration+' ms total, '+JSON.stringify(dirty.logs[0].timings)+
      ', only Book-37.md read across bridge');
    await desktop.invoke('sync:run');
    await mobile.api.configure({auto:true});
    const base=await mobile.head();
    mobile.local.network(offline);mobile.stats.blocked=true;
    await mobile.put('Remote.md','手机开始\n\n公共段落\n\n尾行\n');
    const binary=randomBytes(1024*1024+2);
    await mobile.put('Binary.bin',binary);
    await put(desktop,'Remote.md','起始\n\n公共段落\n\n桌面尾行\n');
    await desktop.invoke('sync:run');
    await until(async()=>await mobile.head()!==base,'BYOS local commit while offline');
    mobile.stats.blocked=false;
    mobile.local.network({connected:true,connectionType:'cellular'});
    const expected='手机开始\n\n公共段落\n\n桌面尾行\n';
    await until(async()=>(await mobile.read('Remote.md'))===expected&&(await mobile.api.status()).status==='synced','automatic BYOS merge and push');
    await desktop.invoke('sync:run');
    assert.equal(await text(desktop,'Remote.md'),expected);
    assert.deepEqual(await fs.readFile(path.join(desktop.root,'Binary.bin')),binary);
    assert(!JSON.stringify([...mobile.preferences]).includes(pat));
    assert(!(await mobile.read('.git/config')).includes(pat));
    assert(!(await fs.readFile(path.join(desktop.profile,'workspace.json'),'utf8')).includes(pat));
    assert(!(await text(desktop,'.git/config')).includes(pat));
    assert([...mobile.protectedValues.values()].includes(pat));
    assert((await mobile.api.status()).logs.some(row=>row.mode==='remote'&&row.pull>0&&row.push>0&&Number.isFinite(row.duration)));
    const merged=(await mobile.api.status()).logs.find(row=>row.pull>0&&row.push>0&&row.timings);
    console.log('Mobile 175-note divergent remote: '+merged.duration+' ms total, '+JSON.stringify(merged.timings));
    console.log('B passed: one-use QR import, offline local commit, cellular reconnect, authenticated binary fetch/merge/push and no plaintext PAT on disk.');
  }finally{await mobile.close();await desktop.close();await remote.close();}
}

(async()=>{
  const base=path.resolve(__dirname,'../.test-data');
  await fs.mkdir(base,{recursive:true});
  const scratch=await fs.mkdtemp(path.join(base,'offline-auto-sync-'));
  await safety();
  await credentialClearing();
  await lanAndConflicts(scratch);
  await byos(scratch);
})().catch(error=>{console.error(error);process.exitCode=1;});
