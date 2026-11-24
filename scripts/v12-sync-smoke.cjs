const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const assert=require('node:assert/strict');
const git=require('isomorphic-git');
const rawFs=require('node:fs');
const {randomBytes}=require('node:crypto');
const net=require('node:net');

const run=promisify(execFile),project=path.resolve(__dirname,'..');
const boot=async profile=>{
  const root=path.join(profile,'vault');await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root}),{flag:'wx'}).catch(error=>{
    if(error.code!=='EEXIST')throw error;
  });
  const env={...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.argv[2];
  const app=await electron.launch({env,...(executablePath?{executablePath}:{args:[project]})});
  const close=()=>app.evaluate(({app})=>app.exit()).catch(()=>{});
  try {
    const page=await app.firstWindow();
    const invoke=(name,...args)=>page.evaluate(([name,args])=>window.desktop[name](...args),[name,args]);
    await page.locator('#app:not([inert])').waitFor();
    return {app,page,root,profile,invoke,close};
  }catch(error){await close();throw error;}
};
const patch=async(node,values)=>node.invoke('sync:configure',{...(await node.invoke('sync:status')).settings,...values});
const text=(node,file)=>fs.readFile(path.join(node.root,file),'utf8');
const put=(node,file,value)=>fs.writeFile(path.join(node.root,file),value);
const head=node=>git.resolveRef({fs:rawFs,dir:node.root,ref:'HEAD'});

async function verifyLan(scratch) {
  const a=await boot(path.join(scratch,'lan-a'));
  const b=await boot(path.join(scratch,'lan-b'));
  try{
    await put(a,'并行.md','首行\n\n中间段\n\n尾行\n');
    await patch(a,{enabled:true,listen:true,auto:false});
    await a.invoke('sync:run');
    const pair=await a.invoke('sync:pair');
    assert(pair.image.startsWith('data:image/png;base64,'));
    const packet=JSON.parse(Buffer.from(pair.packet.slice('calcite-sync:'.length),'base64url'));
    const denied=await fetch(packet.url+'/api/sync/info',{headers:{Authorization:'Bearer '+('0'.repeat(64)),'x-calcite-vault':packet.vaultId}});
    assert.equal(denied.status,401);await denied.arrayBuffer();
    await patch(b,{enabled:true,auto:false,pairing:pair.packet});
    assert.equal((await b.invoke('sync:test')).ok,true);
    await b.invoke('sync:run');
    assert.equal(await text(b,'并行.md'),await text(a,'并行.md'));
    await b.page.locator('[data-file]').getByText('并行.md',{exact:true}).click();
    await b.page.evaluate(()=>{window.externalBatches=[];window.desktop.onExternalChange(event=>window.externalBatches.push(event));});
    await put(a,'甲.md','# 甲\n\n[[并行]]');
    await put(b,'乙.md','# 乙\n\n[[甲]]');
    await put(a,'并行.md','甲首行\n\n中间段\n\n尾行\n');
    await put(b,'并行.md','首行\n\n中间段\n\n乙尾行\n');
    await b.invoke('sync:run');
    for(const node of [a,b]) {
      assert.match(await text(node,'甲.md'),/\[\[并行\]\]/);
      assert.match(await text(node,'乙.md'),/\[\[甲\]\]/);
      assert.equal(await text(node,'并行.md'),'甲首行\n\n中间段\n\n乙尾行\n');
      // Direct fs writes are ingested asynchronously by the desktop watcher.
      await node.page.waitForFunction(async()=>(await window.desktop['workspace-graph']()).edges.some(
        row=>row.from.endsWith('乙.md')&&row.to.endsWith('甲.md')),null,{timeout:5000});
    }
    assert.equal(await head(a),await head(b));
    await b.page.locator('#live-editor .ProseMirror').getByText('甲首行').waitFor();
    const events=await b.page.evaluate(()=>window.externalBatches.flatMap(batch=>batch.changes.map(change=>({source:batch.source,path:change.path}))));
    assert(events.some(row=>row.source==='sync'&&row.path.endsWith('并行.md')));
    assert(await b.page.locator('#external-change').isHidden(),'authorized sync does not show an external warning for a clean tab');
    await b.page.locator('#auto-save').click();
    await b.page.locator('footer [data-mode=source]').click();
    const editor=b.page.locator('#source-editor .cm-content');
    await editor.focus();await b.page.keyboard.press('Control+End');await b.page.keyboard.insertText('\n未落盘的本机草稿');
    await b.page.locator('.tab.active.dirty').waitFor();
    await put(a,'并行.md','甲首行\n\n中间段\n\n乙尾行\n\n远端新段落\n');
    await b.invoke('sync:run');
    const warning=b.page.locator('#external-change');
    await warning.getByText('同步版本已到达，当前草稿已保留。').waitFor();
    assert((await editor.textContent()).includes('未落盘的本机草稿'));
    assert.match(await text(b,'并行.md'),/远端新段落/);
    await warning.getByRole('button',{name:'加载磁盘新版'}).click();
    await warning.waitFor({state:'hidden'});
    await put(a,'并行.md','甲首行\n\n甲改同行\n\n乙尾行\n');
    await put(b,'并行.md','甲首行\n\n乙改同行\n\n乙尾行\n');
    const newer=new Date(Date.now()+5000);
    await fs.utimes(path.join(b.root,'并行.md'),newer,newer);
    const result=await b.invoke('sync:run');
    assert.equal(result.status,'synced');
    for(const node of [a,b]) {
      assert(!(await fs.readdir(node.root)).some(name=>name.includes('同步冲突')));
      assert.match(await text(node,'并行.md'),/乙改同行/);
    }
    assert.equal(await head(a),await head(b));
    const note=path.join(b.root,'并行.md');
    const archived=(await b.invoke('history',note)).find(row=>row.label?.includes('同步自动备份'));
    assert(archived);
    assert.match(await b.invoke('history',note,archived.id),/甲改同行/);
    const peerNote=path.join(a.root,'并行.md');
    const peerBackup=(await a.invoke('history',peerNote)).find(row=>row.label?.includes('同步自动备份'));
    assert.match(await a.invoke('history',peerNote,peerBackup.id),/甲改同行/);
    await b.page.locator('#settings-toggle').click();
    const settings=b.page.locator('.settings-center[open]');
    await settings.getByRole('tab',{name:'同步与配对'}).click();
    await settings.getByText('最近同步日志').click();
    await settings.getByRole('button',{name:'版本历史',exact:true}).first().click();
    const dialog=b.page.locator('.history-dialog[open]');
    await dialog.getByRole('heading',{name:'版本历史',exact:true}).waitFor();
    await dialog.locator('.history-diff').getByText(/甲改同行/).waitFor();
    await dialog.getByRole('button',{name:'恢复此版本'}).click();
    await dialog.waitFor({state:'hidden'});
    assert.match(await text(b,'并行.md'),/甲改同行/);

    const legacy='.gitignore (同步冲突 2026-11-22 1245)';
    await put(b,legacy,'# Previous ignore rules\nlegacy-only\n');
    await b.invoke('sync:run');
    const conflicts=settings.locator('[data-conflicts]');
    await conflicts.locator('summary').click();
    await conflicts.getByRole('button',{name:'查看差异'}).click();
    await dialog.getByRole('heading',{name:'同步冲突',exact:true}).waitFor();
    await dialog.getByText('查看完整版本').click();
    assert.match(await dialog.locator('.sync-versions pre').first().textContent(),/node_modules/);
    assert.match(await dialog.locator('.sync-versions pre').last().textContent(),/legacy-only/);
    await dialog.getByRole('button',{name:'关闭版本历史'}).click();
    await conflicts.getByRole('button',{name:'一键归档清理'}).click();
    await conflicts.waitFor({state:'hidden'});
    assert(!(await fs.readdir(b.root)).includes(legacy));
    const rule=path.join(b.root,'.gitignore');
    const ruleBackup=(await b.invoke('history',rule)).find(row=>row.label?.includes('历史冲突'));
    assert.match(await b.invoke('history',rule,ruleBackup.id),/legacy-only/);
    await settings.getByRole('button',{name:'.gitignore的版本历史',exact:true}).click();
    await dialog.getByRole('heading',{name:'版本历史',exact:true}).waitFor();
    await dialog.locator('.history-diff').getByText('legacy-only').waitFor();
    await dialog.getByRole('button',{name:'关闭版本历史'}).click();
    await a.invoke('sync:revoke');
    const stale=await fetch(packet.url+'/api/sync/info',{headers:{Authorization:'Bearer '+packet.token,'x-calcite-vault':packet.vaultId}}).catch(()=>null);
    // When a random port is in use, revocation may stop the old port as well.
    assert(!stale||stale.status===401);await stale?.arrayBuffer();
    console.log('LAN sync passed: pairing, three-way merge, automatic history diff and restore, dotfile conflict comparison and bulk archival.');
  }finally{await Promise.all([a.close(),b.close()]);}
}

async function verifyByteBatches(scratch) {
  const {GitEngine}=require('../electron/git-engine.cjs');
  const {localEndpoints,listenPeer,peerClient}=require('../electron/lan-sync.cjs');
  const {exchange,pullLimit}=await import('../shared/core/sync-exchange.mjs');
  const {applySettings,defaults}=await import('../shared/core/sync-config.mjs');
  assert.deepEqual(localEndpoints(27183,{
    'VirtualBox Host-Only':[{address:'192.168.56.1',family:'IPv4'}],
    'Mihomo':[{address:'198.18.0.1',family:'IPv4'}],
    'Wi-Fi':[{address:'192.168.43.2',family:'IPv4'}]
  }),['http://192.168.43.2:27183','http://192.168.56.1:27183','http://198.18.0.1:27183']);
  const start=Date.now(),dir=path.join(scratch,'large'),copy=path.join(scratch,'large-copy');
  await Promise.all([fs.mkdir(dir),fs.mkdir(copy)]);
  const source=new GitEngine(dir),target=new GitEngine(copy);
  const author={name:'Calcite',email:'calcite@local'};
  await Promise.all([source.open(),target.open()]);
  await fs.unlink(path.join(copy,'.gitignore'));
  assert.match(await fs.readFile(path.join(dir,'.gitignore'),'utf8'),/node_modules\//);
  const files=Array.from({length:24},(_,i)=>['file-'+i+'.bin',randomBytes(480*1024)]);
  files.push(['oversized.bin',randomBytes(2*1024*1024+123)]);
  for(const [file,bytes] of files)await fs.writeFile(path.join(dir,file),bytes);
  await source.snapshot(author);
  const vaultId='cd3c2f18-4f14-473d-a844-ba43329f976a',token='a'.repeat(64);
  const service=await listenPeer({engine:source,vaultId,token,network:false,prepare:()=>{},receive:()=>{},onError:()=>{}});
  try {
    const previous={...defaults,peerUrl:service.url,peerVaultId:vaultId,peerName:'PC',endpoints:[service.url]};
    const {next,secrets}=applySettings(previous,{peerUrl:'http://192.168.43.2:27184'},{peer:token});
    assert.equal(secrets.peer,token);
    assert.deepEqual(next.endpoints,[next.peerUrl]);
    assert.equal(applySettings(previous,{peerUrl:''},{peer:token}).secrets.peer,'');
    const remote=peerClient({url:service.url,token,vaultId}),sizes=[],binary=[],stages=[];
    const rss=process.memoryUsage.rss();
    let peak=rss;
    const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage.rss());},15);
    try{
      await exchange(target,{async readObject(oid){binary.push(oid);return remote.readObject(oid);},async call(route,input){
        const result=await remote.call(route,input);
        if(route==='objects/pull') {
          const bytes=Buffer.byteLength(JSON.stringify(result));
          assert(bytes<=pullLimit,'JSON and Base64 must fit in 2 MiB');
          sizes.push(bytes);
        }
        return result;
      }},null,oid=>target.apply(oid,author,{progress:value=>stages.push(value)}),{progress:value=>stages.push(value)});
    }finally{clearInterval(timer);}
    assert(sizes.length>=9&&sizes.reduce((sum,bytes)=>sum+bytes,0)>10*1024*1024);
    assert.equal(binary.length,1);
    assert(stages.some(row=>row.phase==='pull'&&row.done>0&&row.done<row.total));
    assert(stages.some(row=>row.phase==='index'));
    assert(peak-rss<240*1024*1024,'transfer RSS delta exceeded 240 MiB');
    for(const [file,bytes] of files)assert.deepEqual(await fs.readFile(path.join(copy,file)),bytes);
    const oversizeOid=(await source.tracked(await source.head())).get('oversized.bin');
    assert.deepEqual(binary,[oversizeOid]);
    await assert.rejects(remote.call('objects/pull',{oids:[oversizeOid],binary:false}),/HTTP 413.*二进制通道/);
    assert.deepEqual(Buffer.from((await remote.readObject(oversizeOid)).bytes),files.at(-1)[1]);
    await fs.writeFile(path.join(dir,'new.md'),'# New commit');
    const nextHead=await source.snapshot(author),gitFs=source.args.fs.promises,readObjectFile=gitFs.readFile;
    const oldBlob=path.join(dir,'.git','objects',oversizeOid.slice(0,2),oversizeOid.slice(2));
    gitFs.readFile=async(file,...args)=>{
      assert.notEqual(path.normalize(file),oldBlob,'negotiation reopened an already validated historical blob');
      return readObjectFile(file,...args);
    };
    try{assert((await source.objects(nextHead)).includes(oversizeOid));}
    finally{gitFs.readFile=readObjectFile;}
    console.log('LAN bytes passed: '+sizes.length+' batches, '+Math.round((peak-rss)/1024/1024)+' MiB peak RSS delta, '+(Date.now()-start)+' ms.');
  }finally{service.close();}
}

async function verifyStablePort(scratch) {
  const claimed=net.createServer();
  try{await new Promise((resolve,reject)=>claimed.once('error',reject).listen(27183,'127.0.0.1',resolve));}
  catch(error){if(error.code!=='EADDRINUSE')throw error;}
  const profile=path.join(scratch,'stable-port');
  let desktop;
  try {
    desktop=await boot(profile);
    const status=await patch(desktop,{enabled:true,listen:true,auto:false,port:0});
    assert(status.port>27183);
    assert.equal(status.settings.port,status.port);
    assert.match((await desktop.invoke('sync:run')).notice,new RegExp('共享已就绪.*'+status.port));
    const pair=await desktop.invoke('sync:pair');
    await desktop.close();
    desktop=await boot(profile);
    assert.equal((await desktop.invoke('sync:status')).port,status.port);
    if(status.canEncrypt){
      const {readPacket}=await import('../shared/core/sync-config.mjs');
      const {peerClient}=require('../electron/lan-sync.cjs');
      const {url,token,vaultId}=readPacket(pair.packet,'calcite-sync:');
      assert.equal((await peerClient({url,token,vaultId}).call('info')).vaultId,vaultId);
    }
  }finally{
    if(desktop)await desktop.close();
    if(claimed.listening)await new Promise(resolve=>claimed.close(resolve));
  }
}

async function gitFixture(folder,token) {
  const repository=path.join(folder,'remote.git');
  await fs.mkdir(folder,{recursive:true});
  await run('git',['init','--bare',repository]);
  await run('git',['--git-dir='+repository,'config','http.receivepack','true']);
  const base=(await run('git',['--exec-path'])).stdout.trim();
  const exe=path.join(base,process.platform==='win32'?'git-http-backend.exe':'git-http-backend');
  const expected='Basic '+Buffer.from('fixture:'+token).toString('base64');
  const seen=[];
  const server=http.createServer((req,res)=>{
    seen.push(req.url);
    if(req.headers.authorization!==expected) {
      res.writeHead(401,{'WWW-Authenticate':'Basic realm="Calcite test"'});res.end();return;
    }
    const url=new URL(req.url,'http://127.0.0.1');
    if(!url.pathname.startsWith('/remote.git/')){res.writeHead(404);res.end();return;}
    const child=spawn(exe,[],{windowsHide:true,env:{...process.env,GIT_PROJECT_ROOT:folder,GIT_HTTP_EXPORT_ALL:'1',
      PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']||'',
      CONTENT_LENGTH:req.headers['content-length']||'',GIT_PROTOCOL:req.headers['git-protocol']||'',REMOTE_USER:'fixture'}});
    req.pipe(child.stdin);
    child.stdin.on('error',()=>{});
    let header=Buffer.alloc(0),ready=false;
    child.stdout.on('data',buffer=>{
      if(ready){res.write(buffer);return;}
      header=Buffer.concat([header,buffer]);
      const divider=header.toString('latin1').match(/\r?\n\r?\n/);
      if(!divider)return;
      const headers={};let code=200;
      for(const row of header.subarray(0,divider.index).toString().split(/\r?\n/)) {
        const colon=row.indexOf(':');if(colon<1)continue;
        const key=row.slice(0,colon),value=row.slice(colon+1).trim();if(key.toLowerCase()==='status')code=parseInt(value,10);else headers[key]=value;
      }
      res.writeHead(code,headers);res.write(header.subarray(divider.index+divider[0].length));ready=true;
    });
    child.stderr.resume();
    child.on('error',()=>{if(!res.headersSent)res.writeHead(500);res.end();});
    child.on('close',()=>{if(!res.headersSent)res.writeHead(500);res.end();});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {repository,seen,url:'http://127.0.0.1:'+server.address().port+'/remote.git',close:()=>{server.close();server.closeAllConnections();}};
}

async function verifyRemote(scratch) {
  const {repositoryUrl,remoteError,applySettings,defaults}=await import('../shared/core/sync-config.mjs');
  const github='https://github.com/example/first-sync';
  assert.equal(repositoryUrl(github+'/'),github+'.git');
  assert.equal(repositoryUrl(github+'.git'),github+'.git');
  assert.equal(repositoryUrl('https://gitee.com/example/first-sync'),'https://gitee.com/example/first-sync');
  assert.equal(applySettings({...defaults,remoteUrl:github},{remoteUrl:github+'.git'},{pat:'retained'}).secrets.pat,'retained');
  assert.match(remoteError(Error('fetch failed',{cause:Object.assign(Error('connection reset'),{code:'ECONNRESET'})})),/ECONNRESET.*connection reset/);
  assert.match(remoteError(Error('net::ERR_PROXY_CONNECTION_FAILED')),/ERR_PROXY_CONNECTION_FAILED/);
  assert.match(remoteError(Object.assign(Error('socket timeout'),{code:'ETIMEDOUT'})),/超时.*ETIMEDOUT/);
  const token='fixture-pat-Calcite-only-123';
  const server=await gitFixture(path.join(scratch,'server'),token);
  let a,b;
  try{
    a=await boot(path.join(scratch,'remote-a'));
    b=await boot(path.join(scratch,'remote-b'));
    const origin=new URL(server.url).host;
    for(const node of [a,b])await node.app.evaluate(({session},proxy)=>session.defaultSession.setProxy({
      mode:'fixed_servers',proxyRules:'http='+proxy,proxyBypassRules:'<-loopback>'
    }),origin);
    const remoteUrl='http://127.0.0.1:65432/remote.git';
    const settings={enabled:true,mode:'remote',auto:false,remoteUrl,remoteUser:'fixture',pat:token};
    await put(a,'首次.md','# 首次\n');await patch(a,settings);
    assert.match((await a.invoke('sync:test')).message,/空仓库/);
    await a.invoke('sync:run');
    assert(server.seen.some(url=>url.startsWith(remoteUrl+'/git-receive-pack')));
    await put(a,'历史.md','# 历史\n');await a.invoke('sync:run');
    await patch(b,settings);await b.invoke('sync:run');
    assert.equal(await text(b,'首次.md'),'# 首次\n');
    assert.match(await text(b,'.git/shallow'),/[0-9a-f]{40}/);
    server.seen.length=0;
    const start=performance.now();
    const unchanged=await b.invoke('sync:run');
    const elapsed=performance.now()-start;
    assert(elapsed<1000,'desktop info/refs fast path: '+elapsed+' ms');
    assert.equal(unchanged.logs[0].message,'已是最新。');
    assert(server.seen.length&&server.seen.every(url=>url.includes('/info/refs?service=git-upload-pack')));
    console.log('Windows remote fast path: '+elapsed.toFixed(1)+' ms total, '+JSON.stringify(unchanged.logs[0].timings));
    await put(a,'甲远程.md','# 甲');await a.invoke('sync:run');
    await put(b,'乙远程.md','# 乙');await b.invoke('sync:run');
    await a.invoke('sync:run');
    assert.equal(await text(a,'乙远程.md'),'# 乙');assert.equal(await text(b,'甲远程.md'),'# 甲');
    for(const target of [a,b]) {
      const json=await fs.readFile(path.join(target.profile,'workspace.json'),'utf8');
      const config=await fs.readFile(path.join(target.root,'.git','config'),'utf8');
      assert(!json.includes(token));assert(!config.includes(token));
      const status=await target.invoke('sync:status');
      assert(!JSON.stringify(status).includes(token));
      if(status.canEncrypt)assert(Object.values(JSON.parse(json).gitSync).some(row=>row.encrypted.pat));
    }
    const large=await fs.open(path.join(b.root,'大文件.bin'),'w');
    await large.truncate(50*1024*1024+1);await large.close();
    const before=await head(b);
    await assert.rejects(b.invoke('sync:run'),/50 MiB/);
    assert.equal(await head(b),before);
    await patch(b,{pat:'wrong-credential'});
    const rejected=await b.invoke('sync:test');
    assert.equal(rejected.ok,false);
    assert.match(rejected.message,/401|403|AUTH|Authentication/i);
    console.log('BYOS sync passed: empty remote, authenticated fetch/merge/push, encrypted persistence, auth failure and 50 MiB protection.');
  }finally{await Promise.all([a?.close(),b?.close()]);server.close();}
}

if(require.main===module)(async()=>{
  const base=path.join(project,'.test-data');await fs.mkdir(base,{recursive:true});
  const scratch=await fs.mkdtemp(path.join(base,'v12-sync-'));
  await verifyByteBatches(scratch);await verifyStablePort(scratch);await verifyLan(scratch);await verifyRemote(scratch);
})().catch(error=>{console.error(error);process.exitCode=1;});

module.exports={gitFixture,boot,patch,text,put,head};
