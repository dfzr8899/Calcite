import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import git from 'isomorphic-git';
import {sha1,sha256,hmacSha256} from '../../shared/core/sha.mjs';
import {refactorJournal} from '../../shared/core/refactor-journal.mjs';
import {createActivityLog} from '../../shared/core/activity-log.mjs';
import {planLinkRefactor,planCanvasLinkRefactor} from '../../shared/core/link-refactor.mjs';
import {VaultIndex} from '../../shared/core/vault-index.mjs';
import {createSyncHistory,isSyncVersion} from '../../shared/core/sync-history.mjs';
import {createGitEngine} from '../../shared/core/git-engine.mjs';
import {findConflicts} from '../../shared/core/sync-conflicts.mjs';
import {exchange} from '../../shared/core/sync-exchange.mjs';
import {createSyncScheduler} from '../../shared/core/sync-scheduler.mjs';
import {withinNativePath} from '../../shared/core/vault-paths.mjs';
import {setLocale} from '../../shared/i18n/index.mjs';
import {createCapacitorPeer} from '../../src/platform/capacitor-git-http.js';

const require=createRequire(import.meta.url);
const {listenPeer,peerClient}=require('../../electron/lan-sync.cjs');
const author={name:'Test',email:'test@calcite.local'};

test('pure-JS sha1, sha256 and hmacSha256 match Node crypto across edge sizes',()=>{
  const samples=[
    '',
    'abc',
    '中文与 emoji 🧪 校验',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'x'.repeat(128),
    new Uint8Array(Array.from({length:1024},(_,i)=>i%256))
  ];
  for(const sample of samples){
    const buf=typeof sample==='string'?Buffer.from(sample,'utf8'):Buffer.from(sample);
    assert.equal(sha1(sample),crypto.createHash('sha1').update(buf).digest('hex'));
    assert.equal(sha256(sample),crypto.createHash('sha256').update(buf).digest('hex'));
  }
  for(const key of ['short',crypto.randomBytes(32),crypto.randomBytes(64),crypto.randomBytes(100)]){
    const keyInput=typeof key==='string'?key:new Uint8Array(key);
    for(const msg of ['','hello world','1700000000000.abcdef0123456789.POST./api/sync/negotiate.uuid']){
      assert.equal(hmacSha256(keyInput,msg),crypto.createHmac('sha256',key).update(msg).digest('hex'));
    }
  }
});

test('refactor-journal quarantines corrupt and diverged journals instead of bricking startup',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-journal-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const journalPath=path.join(dir,'.calcite','refactor-journal.json');
  await fs.mkdir(path.dirname(journalPath),{recursive:true});

  // 1. Corrupt JSON journal
  await fs.writeFile(journalPath,'{not-valid-json');
  const failures=[];
  const journal=refactorJournal(dir,{
    io:fs,path,write:async(f,d)=>{await fs.writeFile(f,d);return true;},rename:async(a,b)=>{await fs.rename(a,b);},
    sameFile:async()=>false,linkMove:async(a,b)=>fs.rename(a,b),safe:async f=>f,
    onRecoverFailure:(err,quarantined)=>failures.push({err,quarantined})
  });
  assert.equal(await journal.recover(),false);
  assert.equal(failures.length,1);
  assert.match(path.basename(failures[0].quarantined),/^refactor-journal-failed-\d+\.json$/);
  await assert.rejects(fs.access(journalPath),{code:'ENOENT'});

  // 2. Diverged target file during rollback
  const target=path.join(dir,'note.md');
  await fs.writeFile(target,'externally overwritten content');
  await fs.writeFile(journalPath,JSON.stringify({
    version:1,from:path.join(dir,'a.md'),to:path.join(dir,'b.md'),
    changes:[{from:target,path:target,previous:'before',saved:'after'}]
  }));
  assert.equal(await journal.recover(),false);
  assert.equal(failures.length,2);
  await assert.rejects(fs.access(journalPath),{code:'ENOENT'});
});

test('activity-log handles corrupt JSON, root restore, and orphan trash directory cleanup',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-activity-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const logFile=path.join(dir,'.calcite','activity-log.json');
  await fs.mkdir(path.dirname(logFile),{recursive:true});
  await fs.writeFile(logFile,'{{{corrupt');

  const activity=createActivityLog(dir,{
    io:fs,path,write:async(f,d)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,d);return true;},
    rename:async(a,b)=>{await fs.rename(a,b);return true;},
    id:()=>crypto.randomUUID(),hash:sha256,archive:async()=>{},
    sameFile:async()=>false,linkMove:async(a,b)=>fs.rename(a,b),safe:async f=>f
  });

  // Corrupt log recovers cleanly
  const initial=await activity.list();
  assert.deepEqual(initial,{entries:[],trash:[]});

  // Root-level file soft-delete + undo restore cleans empty trash dir
  const note=path.join(dir,'RootNote.md');
  await fs.writeFile(note,'# Root\n');
  const deleted=await activity.softDelete(note);
  const trashEntryDir=path.join(dir,'.calcite','trash',deleted.id);
  assert.deepEqual((await fs.readdir(trashEntryDir)).sort(),['entry.json','payload']);
  const undone=await activity.undo(deleted.id);
  assert.equal(undone.path,note);
  assert.equal(await fs.readFile(note,'utf8'),'# Root\n');
  await assert.rejects(fs.access(trashEntryDir),{code:'ENOENT'});

  // Orphaned UUID trash dirs are cleaned by emptyTrash
  const orphanDir=path.join(dir,'.calcite','trash','01234567-89ab-4def-8123-456789abcdef');
  await fs.mkdir(orphanDir,{recursive:true});
  await fs.writeFile(path.join(orphanDir,'stale.png'),'bytes');
  await activity.emptyTrash();
  await assert.rejects(fs.access(orphanDir),{code:'ENOENT'});
});

test('activity-log quarantines malformed JSON structures and keeps rename result consistent with disk',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-activity-shape-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const calciteDir=path.join(dir,'.calcite');
  const logFile=path.join(calciteDir,'activity-log.json');
  const journalFile=path.join(calciteDir,'refactor-journal.json');
  await fs.mkdir(calciteDir,{recursive:true});

  const makeActivity=(overrides={})=>createActivityLog(dir,{
    io:fs,path,write:async(f,d)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,d);return true;},
    rename:async(a,b)=>{await fs.rename(a,b);return true;},
    id:()=>crypto.randomUUID(),hash:sha256,archive:async()=>{},
    sameFile:async()=>false,linkMove:async(a,b)=>fs.rename(a,b),safe:async f=>f,
    ...overrides
  });

  // 1. Valid JSON with non-array structure ({}) during direct rename
  await fs.writeFile(logFile,'{}');
  const srcA=path.join(dir,'Alpha.md'),dstA=path.join(dir,'Beta.md');
  await fs.writeFile(srcA,'# Alpha\n');
  const activity=makeActivity();
  const entry=await activity.refactor('rename',srcA,dstA,[]);
  assert.equal(entry.type,'rename');
  assert.equal(entry.undoable,true);
  await assert.rejects(fs.access(srcA),{code:'ENOENT'});
  assert.equal(await fs.readFile(dstA,'utf8'),'# Alpha\n');
  await assert.rejects(fs.access(journalFile),{code:'ENOENT'});
  const filesAfterObj=await fs.readdir(calciteDir);
  assert(filesAfterObj.some(name=>/^activity-log-corrupt-.*\.json$/.test(name)));
  const listed=await activity.list();
  assert.equal(listed.entries.length,1);
  assert.equal(listed.entries[0].id,entry.id);
  // Undo succeeds on the recovered log
  await activity.undo(entry.id);
  assert.equal(await fs.readFile(srcA,'utf8'),'# Alpha\n');
  await assert.rejects(fs.access(dstA),{code:'ENOENT'});

  // 2. Non-array scalar and malformed array rows (null, missing fields)
  for(const payload of ['null','123','"bad"','[null,{"id":123},{"id":"x","type":"rename","files":"bad"}]']){
    await fs.writeFile(logFile,payload);
    assert.deepEqual((await activity.list()).entries,[]);
  }

  // 3. Mixed array preserves valid entries while quarantining malformed ones
  const validRows=JSON.parse(await fs.readFile(logFile,'utf8').catch(()=>'[]'));
  const seededEntry={id:crypto.randomUUID(),time:Date.now(),type:'rename',from:'X.md',to:'Y.md',files:[],undoable:false,skippedUnchanged:true};
  await fs.writeFile(logFile,JSON.stringify([seededEntry,null,{broken:true},...validRows]));
  const cleaned=await activity.list();
  assert.equal(cleaned.entries.length,1);
  assert.equal(cleaned.entries[0].id,seededEntry.id);

  // 4. Directory in place of activity-log.json is quarantined and rename still succeeds
  await fs.unlink(logFile);
  await fs.mkdir(logFile);
  const srcB=path.join(dir,'Gamma.md'),dstB=path.join(dir,'Delta.md');
  await fs.writeFile(srcB,'# Gamma\n');
  const entryB=await activity.refactor('rename',srcB,dstB,[]);
  assert.equal(entryB.undoable,true);
  assert.equal(await fs.readFile(dstB,'utf8'),'# Gamma\n');
  await assert.rejects(fs.access(journalFile),{code:'ENOENT'});

  // 5. Post-commit activity-log write failure still returns success matching disk state and clears journal
  const srcC=path.join(dir,'Epsilon.md'),dstC=path.join(dir,'Zeta.md');
  await fs.writeFile(srcC,'# Epsilon\n');
  const failingLogActivity=makeActivity({
    write:async(f,d)=>{
      if(path.basename(f)==='activity-log.json')throw Object.assign(Error('EACCES'),{code:'EACCES'});
      await fs.mkdir(path.dirname(f),{recursive:true});
      await fs.writeFile(f,d);
      return true;
    }
  });
  const entryC=await failingLogActivity.refactor('rename',srcC,dstC,[]);
  assert.equal(entryC.undoable,false);
  assert.equal(await fs.readFile(dstC,'utf8'),'# Epsilon\n');
  await assert.rejects(fs.access(srcC),{code:'ENOENT'});
  await assert.rejects(fs.access(journalFile),{code:'ENOENT'});
});

test('rename and undo atomically update and restore both Markdown links and canvas file cards',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-canvas-undo-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const key=file=>process.platform==='win32'?file.toLowerCase():file;
  const within=(parent,child)=>withinNativePath(path,parent,child);

  const original=path.join(dir,'Original.md');
  const renamed=path.join(dir,'Renamed.md');
  const refNote=path.join(dir,'Ref.md');
  const board=path.join(dir,'Board.canvas');
  const folder=path.join(dir,'Folder');
  const nestedNote=path.join(folder,'Inside.md');
  const nestedBoard=path.join(folder,'Nested.canvas');
  const movedFolder=path.join(dir,'MovedFolder');

  await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(original,'# Original\n');
  await fs.writeFile(refNote,'See [[Original]] and [link](./Original.md)\n');
  const boardInitial=JSON.stringify({nodes:[{id:'c1',type:'file',file:'Original.md',x:0,y:0,width:240,height:120}],edges:[]},null,2)+'\n';
  await fs.writeFile(board,boardInitial);
  await fs.writeFile(nestedNote,'# Inside\n');
  const nestedBoardInitial=JSON.stringify({nodes:[{id:'c2',type:'file',file:'Folder/Inside.md',x:0,y:0,width:240,height:120}],edges:[]},null,2)+'\n';
  await fs.writeFile(nestedBoard,nestedBoardInitial);

  const activity=createActivityLog(dir,{
    io:fs,path,key,write:async(f,d)=>{await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,d);return true;},
    rename:async(a,b)=>{await fs.rename(a,b);return true;},
    id:()=>crypto.randomUUID(),hash:sha256,archive:async()=>{},
    sameFile:async()=>false,linkMove:async(a,b)=>fs.rename(a,b),safe:async f=>f
  });

  async function runRefactor(type,from,to,canvases) {
    const index=new VaultIndex(dir,{
      path,key,within,generation:'test',
      async read(filename,item){return {item,text:await fs.readFile(filename,'utf8')};}
    });
    const scanNotes=async current=>{
      for(const item of await fs.readdir(current,{withFileTypes:true})){
        if(item.name.startsWith('.'))continue;
        const full=path.join(current,item.name);
        if(item.isDirectory())await scanNotes(full);
        else if(/\.md$/i.test(item.name)){
          const st=await fs.stat(full);
          index.observe(full,{row:{path:full,modified:st.mtimeMs},size:st.size,signature:st.mtimeMs+':'+st.size});
        }
      }
    };
    await scanNotes(dir);
    await index.refresh();
    const readText=async f=>({text:await fs.readFile(f,'utf8'),mtime:(await fs.stat(f)).mtimeMs});
    const {move,changes:mdChanges}=await planLinkRefactor(index,from,to,[],readText);
    const {changes:canvasChanges}=await planCanvasLinkRefactor(index,move,canvases,[],readText);
    return activity.refactor(type,from,to,[...mdChanges,...canvasChanges]);
  }

  // 1. Rename note -> updates Markdown + Canvas -> Undo restores both
  const renameEntry=await runRefactor('rename',original,renamed,[board,nestedBoard]);
  assert.equal(await fs.readFile(refNote,'utf8'),'See [[Renamed]] and [link](./Renamed.md)\n');
  assert.equal(JSON.parse(await fs.readFile(board,'utf8')).nodes[0].file,'Renamed.md');
  await activity.undo(renameEntry.id);
  assert.equal(await fs.readFile(original,'utf8'),'# Original\n');
  await assert.rejects(fs.access(renamed),{code:'ENOENT'});
  assert.equal(await fs.readFile(refNote,'utf8'),'See [[Original]] and [link](./Original.md)\n');
  assert.equal(await fs.readFile(board,'utf8'),boardInitial);

  // 2. Rename folder containing both note and canvas -> updates nested canvas -> Undo restores without false conflict
  const folderEntry=await runRefactor('rename',folder,movedFolder,[board,nestedBoard]);
  const movedNestedBoard=path.join(movedFolder,'Nested.canvas');
  assert.equal(JSON.parse(await fs.readFile(movedNestedBoard,'utf8')).nodes[0].file,'MovedFolder/Inside.md');
  await activity.undo(folderEntry.id);
  assert.equal(await fs.readFile(nestedBoard,'utf8'),nestedBoardInitial);
  await assert.rejects(fs.access(movedFolder),{code:'ENOENT'});
});

test('sync-history relocates snapshots on rename, prunes beyond maxPerFile, and supports saved snapshots',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-hist-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const history=createSyncHistory({
    root:dir,join:path.join,safe:async f=>f,fs,
    write:async(f,bytes)=>fs.writeFile(f,bytes),maxPerFile:3
  });
  const fileA=path.join(dir,'old.md'),fileB=path.join(dir,'sub','new.md');
  const ids=[];
  for(let i=0;i<5;i++){
    await new Promise(r=>setTimeout(r,2));
    ids.push(await history.record(fileA,Buffer.from('v'+i),'saved','local-save'));
  }
  assert(ids.every(isSyncVersion));
  const beforeMove=await history.list(fileA);
  assert.equal(beforeMove.length,3);
  setLocale('en-US');
  assert.equal((await history.list(fileA))[0].label,'Local saved version');
  setLocale('zh-CN');
  assert.equal((await history.list(fileA))[0].label,'本地保存版本');

  await history.relocate(fileA,fileB);
  assert.deepEqual(await history.list(fileA),[]);
  const afterMove=await history.list(fileB);
  assert.equal(afterMove.length,3);
  assert.equal(String(await history.read(fileB,afterMove[0].id)),'v4');
});

test('git-engine BFS merge clock, objectsSince, empty dir pruning, and English conflict detection',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-engine-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const Engine=createGitEngine({fs,path,atomicWrite:fs.writeFile,within:(p,f)=>withinNativePath(path,p,f),sandboxed:true});
  const engine=new Engine(dir);
  await engine.open();

  // Create initial nested note + English conflict copy
  await fs.mkdir(path.join(dir,'nested','deep'),{recursive:true});
  await fs.writeFile(path.join(dir,'nested','deep','note.md'),'base\n');
  await fs.writeFile(path.join(dir,'note (conflict 2026-11-23 1200).md'),'conflict copy\n');
  const base=await engine.snapshot(author);
  assert(await engine.hasCommit(base));
  assert.equal(await engine.hasCommit('0'.repeat(40)),false);

  // Branch & delete nested note to verify empty dir pruning on apply + objectsSince delta
  await git.branch({fs,dir,ref:'remote'});
  await git.checkout({fs,dir,ref:'remote'});
  await fs.unlink(path.join(dir,'nested','deep','note.md'));
  await git.remove({fs,dir,filepath:'nested/deep/note.md'});
  const remoteHead=await git.commit({fs,dir,author:{...author,timestamp:1780000100,timezoneOffset:0},
    committer:{...author,timestamp:1780000100,timezoneOffset:0},message:'delete nested'});
  await git.checkout({fs,dir,ref:'main'});

  const delta=await engine.objectsSince(remoteHead,base);
  const full=await engine.objects(remoteHead);
  assert(delta.length<full.length);
  assert(delta.includes(remoteHead));
  assert(!delta.includes(base));

  await engine.apply(remoteHead,author);
  await assert.rejects(fs.access(path.join(dir,'nested','deep')),{code:'ENOENT'});
  await assert.rejects(fs.access(path.join(dir,'nested')),{code:'ENOENT'});

  // Verify English conflict copy detected in sandboxed legacyCandidates
  const found=await findConflicts(engine,[],fs,path.join,{all:true});
  assert(found.some(row=>row.copy?.endsWith('note (conflict 2026-11-23 1200).md')));

  // Verify fileChangeClock walks merge parent[1] (side branch)
  const dir2=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-bfs-'));
  t.after(()=>fs.rm(dir2,{recursive:true,force:true}));
  const engine2=new Engine(dir2);
  await engine2.open();
  await fs.writeFile(path.join(dir2,'base.md'),'base\n');
  await git.add({fs,dir:dir2,filepath:'base.md'});
  await git.commit({fs,dir:dir2,author:{...author,timestamp:1780000000,timezoneOffset:0},committer:{...author,timestamp:1780000000,timezoneOffset:0},message:'base'});
  await git.branch({fs,dir:dir2,ref:'side'});
  await fs.writeFile(path.join(dir2,'main-only.md'),'m\n');
  await git.add({fs,dir:dir2,filepath:'main-only.md'});
  await git.commit({fs,dir:dir2,author:{...author,timestamp:1780000010,timezoneOffset:0},committer:{...author,timestamp:1780000010,timezoneOffset:0},message:'main'});
  await git.checkout({fs,dir:dir2,ref:'side'});
  await fs.writeFile(path.join(dir2,'side-only.md'),'s\n');
  await git.add({fs,dir:dir2,filepath:'side-only.md'});
  const sideTip=await git.commit({fs,dir:dir2,author:{...author,timestamp:1780000555,timezoneOffset:0},committer:{...author,timestamp:1780000555,timezoneOffset:0},message:'side'});
  await git.checkout({fs,dir:dir2,ref:'main'});
  await engine2.apply(sideTip,author);
  const mergedHead=await engine2.head();
  const sideBlob=(await engine2.tracked(mergedHead)).get('side-only.md');
  const clock=await engine2.fileChangeClock();
  assert.equal(await clock(mergedHead,'side-only.md',sideBlob,null),1780000555*1000);
});

test('sync-exchange uses incremental anchor negotiation and falls back if anchor unmatched',async()=>{
  const anchor='1'.repeat(40),head='2'.repeat(40),deltaOid='3'.repeat(40),oldOid='4'.repeat(40);
  const calls=[];
  const engine={
    head:async()=>head,
    hasCommit:async oid=>oid===anchor,
    objectsSince:async(h,a)=>{assert.equal(h,head);assert.equal(a,anchor);return [head,deltaOid];},
    objects:async()=>[head,deltaOid,oldOid],
    object:async id=>({oid:id,type:'blob',data:Buffer.from('ok').toString('base64')}),
    objectSize:()=>2,
    tracked:async()=>new Map()
  };
  const client={
    incremental:true,
    async call(route,body){
      calls.push({route,body});
      if(route==='negotiate'&&body.anchor)return {headOid:head,available:[],need:[],anchorMatched:false};
      if(route==='negotiate')return {headOid:head,available:[],need:[]};
      return {};
    }
  };
  const res=await exchange(engine,client,head,async()=>{},{anchor});
  assert.deepEqual(res,{push:0,head});
  assert.equal(calls[0].body.anchor,anchor);
  assert.deepEqual(calls[0].body.known,[head,deltaOid]);
  assert.equal(calls[1].body.anchor,undefined);
  assert.deepEqual(calls[1].body.known,[head,deltaOid,oldOid]);
});

test('sync-scheduler periodically polls remote Git in foreground and stops in background',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let syncCalls=0;
  const scheduler=createSyncScheduler({
    policy:()=>({enabled:true,configured:true,auto:true,mode:'remote',pending:false,wifiOnly:false}),
    network:()=>({connected:true,connectionType:'wifi'}),
    snapshot:async()=>{},
    sync:async()=>{syncCalls++;},
    probe:async()=>false,
    remotePoll:1000
  });
  t.after(()=>scheduler.dispose());
  scheduler.enter(true);
  await new Promise(r=>setImmediate(r));
  assert.equal(syncCalls,1);
  t.mock.timers.tick(999);
  await new Promise(r=>setImmediate(r));
  assert.equal(syncCalls,1);
  t.mock.timers.tick(1);
  await new Promise(r=>setImmediate(r));
  assert.equal(syncCalls,2);
  scheduler.enter(false);
  t.mock.timers.tick(5000);
  await new Promise(r=>setImmediate(r));
  assert.equal(syncCalls,2);
});

test('LAN sync negotiates AES-256-GCM + Calcite-HMAC + incremental anchor and rejects replay/tampering',async t=>{
  const dirA=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-lan-a-'));
  const dirB=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-lan-b-'));
  t.after(()=>Promise.all([fs.rm(dirA,{recursive:true,force:true}),fs.rm(dirB,{recursive:true,force:true})]));
  const Engine=createGitEngine({fs,path,atomicWrite:fs.writeFile,within:(p,f)=>withinNativePath(path,p,f)});
  const engineA=new Engine(dirA),engineB=new Engine(dirB);
  await engineA.open();
  await engineB.open();
  await fs.writeFile(path.join(dirA,'secret.md'),'# Encrypted LAN Payload\n');
  const headA=await engineA.snapshot(author);

  const token=crypto.randomBytes(32).toString('hex');
  const vaultId='cd3c2f18-4f14-473d-a844-ba43329f976a';
  const server=await listenPeer({
    engine:engineA,vaultId,deviceName:'WinHost',token,network:false,
    prepare:async()=>engineA.head(),
    receive:async oid=>engineA.apply(oid,author)
  });
  t.after(()=>server.close());

  const url='http://127.0.0.1:'+server.port;
  const client=peerClient({url,token,vaultId});
  const info=await client.call('info');
  assert.equal(info.capabilities.enc,'aes-256-gcm');
  assert.equal(info.capabilities.hmac,true);
  assert.equal(info.capabilities.incremental,true);
  client.enableCapabilities(info.capabilities);

  // Full encrypted sync A -> B
  const headB0=await engineB.snapshot(author);
  const synced=await exchange(engineB,client,headB0,async oid=>{await engineB.apply(oid,author);});
  assert.equal(await fs.readFile(path.join(dirB,'secret.md'),'utf8'),'# Encrypted LAN Payload\n');
  assert.equal(await fs.readFile(path.join(dirA,'secret.md'),'utf8'),'# Encrypted LAN Payload\n');
  const headAfterB=synced.head;

  // Replay protection: reusing the exact same Calcite-HMAC header returns 401
  const ts=String(Date.now()),nonce='a1b2c3d4e5f6a1b2c3d4e5f6';
  const sig=hmacSha256(Buffer.from(token,'hex'),`${ts}.${nonce}.GET./api/sync/info.${vaultId}`);
  const auth=`Calcite-HMAC ${ts}.${nonce}.${sig}`;
  const req=()=>new Promise((resolve,reject)=>{
    const r=http.request(url+'/api/sync/info',{method:'GET',headers:{Authorization:auth,'x-calcite-vault':vaultId},agent:false},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });
    r.on('error',reject);r.end();
  });
  assert.equal(await req(),200);
  assert.equal(await req(),401);

  // Tampered AES-GCM ciphertext returns 400
  const ts2=String(Date.now()),nonce2='11223344556677889900aabb';
  const sig2=hmacSha256(Buffer.from(token,'hex'),`${ts2}.${nonce2}.POST./api/sync/negotiate.${vaultId}`);
  const tamperStatus=await new Promise((resolve,reject)=>{
    const r=http.request(url+'/api/sync/negotiate',{
      method:'POST',agent:false,
      headers:{
        Authorization:`Calcite-HMAC ${ts2}.${nonce2}.${sig2}`,
        'x-calcite-vault':vaultId,
        'Content-Type':'application/octet-stream',
        'x-calcite-enc':'aes-256-gcm',
        'x-calcite-iv':crypto.randomBytes(12).toString('base64'),
        'x-calcite-tag':crypto.randomBytes(16).toString('base64')
      }
    },res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    r.on('error',reject);
    r.end(Buffer.from('tampered-ciphertext'));
  });
  assert.equal(tamperStatus,400);

  // Android Capacitor peer client interoperates with desktop AES-256-GCM + Calcite-HMAC + incremental anchor
  const dirC=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-lan-c-'));
  t.after(()=>fs.rm(dirC,{recursive:true,force:true}));
  const engineC=new Engine(dirC);
  await engineC.open();
  const seenHeaders=[];
  const mockCapacitorHttp={
    request({url:targetUrl,method='GET',headers={},data,dataType,responseType}) {
      seenHeaders.push({...headers});
      return new Promise((resolve,reject)=>{
        let payload;
        if(data!==undefined){
          payload=dataType==='file'?Buffer.from(data,'base64'):
            Buffer.from(typeof data==='string'?data:JSON.stringify(data),'utf8');
        }
        const reqHeaders={...headers,...(payload?{'Content-Length':payload.length}:{})};
        const r=http.request(targetUrl,{method,headers:reqHeaders,agent:false},res=>{
          const chunks=[];
          res.on('data',chunk=>chunks.push(chunk));
          res.on('end',()=>{
            const raw=Buffer.concat(chunks);
            const body=responseType==='arraybuffer'?raw.toString('base64'):raw.toString('utf8');
            resolve({url:targetUrl,status:res.statusCode,headers:res.headers,data:body});
          });
        });
        r.on('error',reject);
        if(payload)r.write(payload);
        r.end();
      });
    }
  };
  const androidPeer=createCapacitorPeer({url,token,vaultId,native:mockCapacitorHttp});
  const androidInfo=await androidPeer.call('info');
  await androidPeer.enableCapabilities(androidInfo.capabilities);
  assert.equal(androidPeer.incremental,true);
  const headC0=await engineC.snapshot(author);
  const pulled=await exchange(engineC,androidPeer,headC0,async oid=>{await engineC.apply(oid,author);});
  assert.equal(await fs.readFile(path.join(dirC,'secret.md'),'utf8'),'# Encrypted LAN Payload\n');
  // Verify encrypted + HMAC headers were actually used after /info
  assert(seenHeaders.slice(1).every(h=>h['x-calcite-enc']==='aes-256-gcm'&&String(h.Authorization).startsWith('Calcite-HMAC ')));

  // Push a new Android edit back to Windows desktop using incremental anchor
  await fs.writeFile(path.join(dirC,'from-android.md'),'# From Android Encrypted\n');
  const androidHead=await engineC.snapshot(author);
  const pushed=await exchange(engineC,androidPeer,androidHead,async oid=>{await engineC.apply(oid,author);},{anchor:pulled.head});
  assert.equal(pushed.push,1);
  assert.equal(await fs.readFile(path.join(dirA,'from-android.md'),'utf8'),'# From Android Encrypted\n');
  assert(headAfterB);
});
