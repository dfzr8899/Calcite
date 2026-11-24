const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const {_electron:electron,chromium}=require('playwright');
const git=require('isomorphic-git');
const {GitEngine}=require('../electron/git-engine.cjs');
const {atomicWriteFile}=require('../electron/workspace.cjs');
const {memoryFilesystem,registerNativeMock,serveDist,chromiumOptions}=require('./mobile-smoke.cjs');

const project=path.resolve(__dirname,'..');
const author={name:'Data Safety',email:'data-safety@calcite.local'};
const raw='\uFEFF---\r\npreview: "[[Old]]"  \r\n---\r\n\r\n[[Old#Heading|Alias]] [link](./Old.md#Heading)  \r\n\r\n' +
  '~~~md\r\n[[Old]] [link](./Old.md)\r\n~~~\r\n\r\n'+String.fromCharCode(96)+'[[Old]]'+String.fromCharCode(96)+'  ';
const expected=raw.replace('[[Old#Heading|Alias]]','[[New#Heading|Alias]]').replace('./Old.md#Heading','./New.md#Heading');
const interrupted=raw.replace('Old#Heading','BatchOld#Heading').replace('./Old.md#Heading','./BatchOld.md#Heading');
const completed=interrupted.replace('BatchOld#Heading','BatchNew#Heading').replace('./BatchOld.md#Heading','./BatchNew.md#Heading');
const batchCanvasInitial=JSON.stringify({nodes:[{id:'batch-card',type:'file',file:'BatchOld.md',x:0,y:0,width:240,height:120}],edges:[]},null,2)+'\n';
const batchCanvasCompleted=JSON.stringify({nodes:[{id:'batch-card',type:'file',file:'BatchNew.md',x:0,y:0,width:240,height:120}],edges:[]},null,2)+'\n';
const chapter=(dir,i)=>path.join(dir,'Batch-'+String(i).padStart(2,'0')+'.md');

async function forceExit(dir) {
  const {createActivityLog}=await import('../shared/core/activity-log.mjs');
  let count=0;
  const changes=[
    ...Array.from({length:30},(_,i)=>({
      from:chapter(dir,i),path:chapter(dir,i),previous:interrupted,saved:completed,count:2
    })),
    {from:path.join(dir,'BatchBoard.canvas'),path:path.join(dir,'BatchBoard.canvas'),previous:batchCanvasInitial,saved:batchCanvasCompleted,count:1}
  ];
  await createActivityLog(dir,{io:fs,path,safe:async file=>file,id:randomUUID,
    hash:value=>createHash('sha256').update(value).digest('hex'),archive:async()=>{},
    write:(file,data,check=async()=>true)=>atomicWriteFile(file,data,async()=>{
      if(file===chapter(dir,11)&&++count===1)process.exit(88);
      return check();
    })
  }).refactor('rename',path.join(dir,'BatchOld.md'),path.join(dir,'BatchNew.md'),changes);
}

async function desktop(profile) {
  const vault=path.join(profile,'vault');
  await fs.mkdir(vault);
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault,language:'en-US'}));
  const note=path.join(vault,'External.md'),untouched=path.join(vault,'Untouched.md');
  const reference=path.join(vault,'Reference.md');
  await Promise.all([
    fs.writeFile(note,'# Start\n\nalpha\n'),
    fs.writeFile(untouched,'# Unrelated\r\n'),fs.writeFile(reference,raw),
    fs.writeFile(path.join(vault,'Old.md'),'# Heading\r\n  '),
    fs.writeFile(path.join(vault,'BatchOld.md'),'# Heading\r\n'),
    fs.writeFile(path.join(vault,'BatchBoard.canvas'),batchCanvasInitial),
    ...Array.from({length:30},(_,i)=>fs.writeFile(chapter(vault,i),interrupted))
  ]);
  const folder=path.join(vault,'Archive');
  await fs.mkdir(folder);
  const original=new Map([
    ['First.md','# Heading\r\n  '],['Second.md','# Second\n'],
    ...Array.from({length:8},(_,i)=>['Link-'+i+'.md',
      '---\r\ntitle: unchanged  \r\n---\r\n[[First#Heading|alias]] [first](./First.md) [second](./Second.md)  \r\n~~~md\r\n[[First]] [[Second]]\r\n~~~'])
  ]);
  for(const [name,text] of original)await fs.writeFile(path.join(vault,name),text);
  const env={...process.env,CALCITE_DATA_DIR:profile,CALCITE_TEST:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>electron.launch({args:[project],env});
  const app=await launch();
  const invoke=(page,name,...args)=>page.evaluate(([name,args])=>window.desktop[name](...args),[name,args]);
  try{
    const page=await app.firstWindow();
    await page.locator('#app:not([inert])').waitFor();
    await page.locator('#side-content [data-file]').getByText('External.md',{exact:true}).click();
    await page.locator('footer [data-mode=source]').click();
    const editor=page.locator('#source-editor .cm-content');
    const notice=page.locator('#external-change');
    async function append(value) {
      await editor.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n'+value);
      await page.locator('.tab.active.dirty').waitFor();
    }
    async function waitText(value) {
      await page.waitForFunction(value=>document.querySelector('#source-editor .cm-content').textContent.includes(value),value);
    }
    const mtime=new Date('2026-11-22T10:00:00Z');
    await fs.utimes(note,mtime,mtime);
    await fs.writeFile(note,'# Start\n\nbravo\n');
    await fs.utimes(note,mtime,mtime);
    await waitText('bravo');
    assert.equal(await page.locator('#toast').textContent(),'Reloaded external changes');
    const baseline=await invoke(page,'read',note);
    await append('my draft for archive');
    await fs.writeFile(note,'# Start\n\ncharl\n');
    await fs.utimes(note,mtime,mtime);
    const blocked=await invoke(page,'save',{path:note,text:'stale overwrite',saved:baseline.text,
      mtime:baseline.mtime,snapshot:baseline.snapshot});
    assert.equal(blocked.conflict,true);
    assert.equal(blocked.snapshot.size,baseline.snapshot.size);
    assert.equal(blocked.snapshot.mtimeMs,baseline.snapshot.mtimeMs);
    assert.notEqual(blocked.snapshot.hash,baseline.snapshot.hash);
    await notice.waitFor();
    await page.keyboard.press('Control+s');
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(await fs.readFile(note,'utf8'),'# Start\n\ncharl\n');
    await notice.getByRole('button',{name:'View diff'}).click();
    const comparison=page.locator('.external-versions');
    await comparison.getByText('charl',{exact:false}).waitFor();
    await comparison.getByText('my draft for archive',{exact:false}).waitFor();
    await page.locator('[data-resolution=reload]').click();
    await notice.waitFor({state:'hidden'});
    await waitText('charl');
    await append('use the draft');
    await fs.writeFile(note,'# New edit to archive\n');
    await notice.getByRole('button',{name:'Keep my changes and overwrite'}).click();
    await notice.waitFor({state:'hidden'});
    assert.match(await fs.readFile(note,'utf8'),/use the draft/);
    const versions=await invoke(page,'history',note);
    const snapshots=await Promise.all(versions.map(({id})=>invoke(page,'history',note,id)));
    assert(snapshots.some(text=>text.includes('my draft for archive')));
    assert(snapshots.includes('# New edit to archive\n'));
    const originalTime=(await fs.stat(untouched)).mtimeMs;
    await invoke(page,'workspace-edit',{type:'rename',path:path.join(vault,'Old.md'),name:'New.md'});
    assert.deepEqual(await fs.readFile(reference),Buffer.from(expected));
    assert.deepEqual(await fs.readFile(path.join(vault,'New.md')),Buffer.from('# Heading\r\n  '));
    assert.equal((await fs.stat(untouched)).mtimeMs,originalTime);

    await page.waitForFunction(async()=> (await window.desktop['workspace-graph']()).edges
      .some(edge=>edge.from.endsWith('Link-7.md')&&edge.to.endsWith('First.md')));
    await page.waitForFunction(async()=> (await window.desktop.tree()).some(row=>row.name==='Archive'));
    const unaffected=new Map();
    for(const row of await fs.readdir(vault,{withFileTypes:true})){
      if(!row.isFile()||!row.name.endsWith('.md')||original.has(row.name))continue;
      const file=path.join(vault,row.name);
      unaffected.set(file,{bytes:await fs.readFile(file),mtime:(await fs.stat(file)).mtimeMs});
    }
    const edit=(type,file,extra={})=>invoke(page,'workspace-edit',{type,path:path.join(vault,file),...extra});
    const first=await edit('rename','First.md',{name:'Renamed.md'});
    const second=await edit('move','Second.md',{parent:folder});
    const third=await edit('trash','Renamed.md');
    for(const [operation,count] of [[first,2],[second,1]]){
      const changed=operation.activity.files.filter(row=>row.written);
      assert.equal(changed.length,8,JSON.stringify(operation.activity));
      assert(changed.every(row=>row.count===count));
      assert(operation.activity.skippedUnchanged&&operation.activity.undoable);
    }
    assert(third.activity.undoable);
    assert(third.activity.files.every(row=>row.count===0&&!row.written));
    assert.deepEqual(await fs.readFile(path.join(vault,'Link-0.md')),Buffer.from(original.get('Link-0.md')
      .replace('[[First#Heading','[[Renamed#Heading').replace('(./First.md)','(./Renamed.md)').replace('(./Second.md)','(./Archive/Second.md)')));
    const newest=(await invoke(page,'activity:list')).entries.slice(0,3);
    assert.deepEqual(newest.map(row=>row.type),['trash','move','rename']);
    assert.equal((await fs.stat(untouched)).mtimeMs,originalTime);
    const unchanged=await fs.readFile(untouched);
    const openLog=page.locator('.side-tools [data-action=activity]');
    await openLog.click();
    const activity=page.locator('.activity-view[open]');
    await activity.locator('[data-section=trash]').click();
    await activity.locator('summary').first().click();
    await activity.getByRole('button',{name:'Restore',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Restored to Renamed.md'));
    assert.equal(await fs.readFile(path.join(vault,'Renamed.md'),'utf8'),original.get('First.md'));
    await activity.getByRole('button',{name:'Close Activity Log'}).click();
    await invoke(page,'activity:undo',second.activity.id);
    await invoke(page,'activity:undo',first.activity.id);
    for(const [name,text] of original)assert.deepEqual(await fs.readFile(path.join(vault,name)),Buffer.from(text));
    assert.equal((await fs.stat(untouched)).mtimeMs,originalTime);
    assert.deepEqual(await fs.readFile(untouched),unchanged);
    const again=await edit('rename','First.md',{name:'Again.md'});
    const changedRef=path.join(vault,'Link-0.md');
    const outside=await fs.readFile(changedRef,'utf8')+'\r\nExternal edit after refactor  ';
    await fs.writeFile(changedRef,outside);
    await openLog.click();
    const record=activity.locator('[data-id="'+again.activity.id+'"]');
    await record.locator('summary').click();
    await record.getByRole('button',{name:'Undo',exact:true}).click();
    const confirm=page.getByRole('heading',{name:'Review changes before undoing'});
    await confirm.waitFor();
    assert.equal(await fs.readFile(changedRef,'utf8'),outside);
    await page.getByRole('button',{name:'Back up and undo'}).click();
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Undone and restored to First.md'));
    const history=await invoke(page,'history',changedRef);
    const backup=history.find(version=>version.label==='Version backed up before undo');
    assert(backup);
    assert.equal(await invoke(page,'history',changedRef,backup.id),outside);
    for(const [name,text] of original)assert.deepEqual(await fs.readFile(path.join(vault,name)),Buffer.from(text));
    const deletion=await edit('trash','First.md');
    await fs.writeFile(path.join(vault,'First.md'),'a new file');
    const restored=await invoke(page,'activity:undo',deletion.activity.id);
    assert.equal(path.basename(restored.path),'First (restored).md');
    assert.equal(await fs.readFile(restored.path,'utf8'),original.get('First.md'));
    assert.equal(await fs.readFile(path.join(vault,'First.md'),'utf8'),'a new file');
    await edit('trash','First (restored).md');
    assert.equal(await invoke(page,'activity:empty'),1);
    assert.equal((await invoke(page,'activity:list')).trash.length,0);
    for(const [file,initial] of unaffected){
      assert.deepEqual(await fs.readFile(file),initial.bytes,file);
      assert.equal((await fs.stat(file)).mtimeMs,initial.mtime,file);
    }

    // Canvas card link update + undo consistency on rename and move
    const canvasTarget=path.join(vault,'CanvasTarget.md');
    const canvasRef=path.join(vault,'CanvasRef.md');
    const canvasBoard=path.join(vault,'Board.canvas');
    const boardBefore=JSON.stringify({nodes:[{id:'card1',type:'file',file:'CanvasTarget.md',x:10,y:10,width:240,height:120}],edges:[]},null,2)+'\n';
    await invoke(page,'workspace-edit',{type:'note',parent:vault,name:'CanvasTarget.md',text:'# Canvas Target\n'});
    await invoke(page,'workspace-edit',{type:'note',parent:vault,name:'CanvasRef.md',text:'Link [[CanvasTarget]]\n'});
    await invoke(page,'canvas-save',{name:'Board.canvas',board:JSON.parse(boardBefore)});
    const canvasRename=await edit('rename','CanvasTarget.md',{name:'CanvasRenamed.md'});
    assert.equal(await fs.readFile(canvasRef,'utf8'),'Link [[CanvasRenamed]]\n');
    assert.equal(JSON.parse(await fs.readFile(canvasBoard,'utf8')).nodes[0].file,'CanvasRenamed.md');
    await invoke(page,'activity:undo',canvasRename.activity.id);
    assert.equal(await fs.readFile(canvasTarget,'utf8'),'# Canvas Target\n');
    assert.equal(await fs.readFile(canvasRef,'utf8'),'Link [[CanvasTarget]]\n');
    assert.equal(await fs.readFile(canvasBoard,'utf8'),boardBefore);
    const canvasMove=await edit('move','CanvasTarget.md',{parent:folder});
    assert.equal(JSON.parse(await fs.readFile(canvasBoard,'utf8')).nodes[0].file,'Archive/CanvasTarget.md');
    await invoke(page,'activity:undo',canvasMove.activity.id);
    assert.equal(await fs.readFile(canvasBoard,'utf8'),boardBefore);

    // Malformed activity-log.json ({}) must not fail rename or leave inconsistent disk state
    const logPath=path.join(vault,'.calcite','activity-log.json');
    await fs.writeFile(logPath,'{}');
    const corruptRename=await edit('rename','CanvasTarget.md',{name:'CanvasRecovered.md'});
    assert.equal(corruptRename.activity.undoable,true);
    assert.equal(await fs.readFile(path.join(vault,'CanvasRecovered.md'),'utf8'),'# Canvas Target\n');
    assert.equal(JSON.parse(await fs.readFile(canvasBoard,'utf8')).nodes[0].file,'CanvasRecovered.md');
    await assert.rejects(fs.stat(path.join(vault,'.calcite','refactor-journal.json')),{code:'ENOENT'});
    assert((await fs.readdir(path.join(vault,'.calcite'))).some(name=>/^activity-log-corrupt-.*\.json$/.test(name)));
    await invoke(page,'activity:undo',corruptRename.activity.id);
    assert.equal(await fs.readFile(canvasBoard,'utf8'),boardBefore);

    console.log('Activity: exact counts, untouched bytes and mtimes, undo guard and archived external edit, collision-safe restore, empty trash, canvas undo, and corrupt activity-log recovery.');
  }finally{await app.close();}
  const crash=spawnSync(process.execPath,[__filename,'--crash',vault],{env,timeout:20000,encoding:'utf8'});
  assert.equal(crash.status,88,crash.stderr||crash.error?.message);
  const journal=path.join(vault,'.calcite','refactor-journal.json');
  assert.equal(JSON.parse(await fs.readFile(journal,'utf8')).changes.length,31);
  assert((await fs.readdir(vault)).some(name=>name.startsWith('.calcite-tmp-')));
  assert.deepEqual(await fs.readFile(chapter(vault,10)),Buffer.from(completed));
  assert.deepEqual(await fs.readFile(chapter(vault,11)),Buffer.from(interrupted));
  assert.equal(await fs.readFile(path.join(vault,'BatchBoard.canvas'),'utf8'),batchCanvasInitial);
  const reopening=await launch();
  try{
    const page=await reopening.firstWindow();
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='Recovered the interrupted link update');
    await assert.rejects(fs.stat(journal),{code:'ENOENT'});
    assert(!(await fs.readdir(vault)).some(name=>name.startsWith('.calcite-tmp-')));
    assert.equal(await fs.readFile(path.join(vault,'BatchNew.md'),'utf8'),'# Heading\r\n');
    await assert.rejects(fs.stat(path.join(vault,'BatchOld.md')),{code:'ENOENT'});
    for(let i=0;i<30;i++)assert.deepEqual(await fs.readFile(chapter(vault,i)),Buffer.from(completed));
    assert.equal(await fs.readFile(path.join(vault,'BatchBoard.canvas'),'utf8'),batchCanvasCompleted);
    const {entries}=await invoke(page,'activity:list');
    assert(entries.some(row=>row.type==='recovery'&&row.files.filter(file=>file.written).length===31));
    const recovered=entries.find(row=>row.type==='rename'&&row.to==='BatchNew.md');
    assert(recovered?.undoable);
    await invoke(page,'activity:undo',recovered.id);
    for(let i=0;i<30;i++)assert.deepEqual(await fs.readFile(chapter(vault,i)),Buffer.from(interrupted));
    assert.equal(await fs.readFile(path.join(vault,'BatchBoard.canvas'),'utf8'),batchCanvasInitial);
  }finally{await reopening.close();}
  console.log('Desktop: hash check, clean reload, dirty guard, both history backups, exact bytes, 30-note crash recovery.');
}

async function retention(scratch) {
  const dir=path.join(scratch,'retention');
  await fs.mkdir(dir);
  const {activityFor}=require('../electron/data-safety.cjs');
  const log=activityFor(dir,async()=>{});
  await fs.writeFile(path.join(dir,'entry-0.md'),'unchanged\r\n');
  for(let i=1;i<=52;i++)await log.refactor('rename',path.join(dir,'entry-'+(i-1)+'.md'),path.join(dir,'entry-'+i+'.md'),[]);
  const {entries}=await log.list();
  assert.equal(entries.length,50);
  assert.equal(entries.filter(row=>row.undoable).length,20);
  assert.equal((await fs.readdir(path.join(dir,'.calcite','undo-snapshots'))).length,20);
  assert.equal(await fs.readFile(path.join(dir,'entry-52.md'),'utf8'),'unchanged\r\n');
  console.log('Activity: 50-entry audit retention and 20-batch snapshot retention verified.');
}

async function syncStrategies(scratch) {
  const {defaults,applySettings}=await import('../shared/core/sync-config.mjs');
  assert.equal(defaults.conflictStrategy,'lww-history');
  for(const strategy of ['lww-history','conflict-copy']){
    const dir=path.join(scratch,strategy);
    await fs.mkdir(dir);
    const engine=new GitEngine(dir),args=engine.args;
    await engine.open();
    const note=path.join(dir,'note.md');
    async function commit(line,rule,stamp) {
      await fs.writeFile(note,line);
      const rules=path.join(dir,'.gitignore');
      const base=(await fs.readFile(rules,'utf8')).split('\n').filter(row=>!row.startsWith('test-')).join('\n');
      await fs.writeFile(rules,base.trimEnd()+'\n'+rule+'\n');
      await fs.writeFile(path.join(dir,'.gitattributes'),rule+' text\n');
      await git.add({...args,filepath:['note.md','.gitignore','.gitattributes']});
      return git.commit({...args,author:{...author,timestamp:stamp,timezoneOffset:0},message:rule});
    }
    await commit('base\n','test-base',1700000000);
    await git.branch({...args,ref:'peer'});
    await commit('local\n','test-local',1700000010);
    await git.checkout({...args,ref:'peer'});
    const incoming=await commit('remote\r\n','test-remote',1700000020);
    await git.checkout({...args,ref:'main'});
    await fs.utimes(note,1700000010,1700000010);
    const options=applySettings(defaults,{conflictStrategy:strategy},{}).next;
    const result=await engine.apply(incoming,author,{conflictStrategy:options.conflictStrategy});
    for(const file of ['.gitignore','.gitattributes']){
      const rules=await fs.readFile(path.join(dir,file),'utf8');
      assert.match(rules,/test-local/);assert.match(rules,/test-remote/);
    }
    if(strategy==='conflict-copy'){
      assert.equal(await fs.readFile(note,'utf8'),'local\n');
      assert.equal(result.conflicts.length,1);
      assert.match(path.basename(result.conflicts[0].copy),/^note \(conflict \d{4}-\d\d-\d\d \d{4}\)\.md$/);
      assert.equal(await fs.readFile(result.conflicts[0].copy,'utf8'),'remote\r\n');
    }else{
      assert.equal(result.conflicts.length,0);
      assert.equal(await fs.readFile(note,'utf8'),'remote\n');
      const [version]=await engine.history.list(note);
      assert.equal(String(await engine.history.read(note,version.id)),'local\n');
    }
  }
  console.log('Git: both configurable policies preserve the alternate version, repository rules union in both modes.');
}

async function mobile() {
  const {server,url}=await serveDist();
  const browser=await chromium.launch(chromiumOptions());
  try{
    const context=await browser.newContext({viewport:{width:360,height:780},hasTouch:true,isMobile:true});
    const key='DATA:CalciteVaults/Safety/Note.md';
    await context.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+
      ','+JSON.stringify({[key.slice(5)]:Buffer.from('# Mobile\n\ninitial\n').toString('base64')})+
      ',{prefs:{vault:"/CalciteVaults/Safety"},useSystemLanguage:true}); localStorage.setItem("calcite.language","en-US");'});
    const page=await context.newPage();
    await page.goto(url);
    await page.locator('#app:not([inert])').waitFor();
    const external=(text,notify)=>page.evaluate(async ({key,text,notify})=>{
      await calciteTest.filesystem.writeFile({directory:'DATA',path:key.slice(5),data:btoa(text)});
      if(notify)calciteTest.fixture.appState(true);
    },{key,text,notify});
    await external('# Mobile\n\nforeground\n',true);
    await page.getByText('foreground',{exact:true}).waitFor();
    const editor=page.locator('#source-editor .cm-content'),notice=page.locator('#external-change');
    if(!await editor.isVisible())await page.locator('[data-mobile-mode]').click();
    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\nmobile draft');
    await external('# Mobile\n\nexternal draft\n',false);
    await notice.waitFor();
    assert.equal(await page.evaluate(key=>atob(calciteTest.filesystem.store.get(key).data),key),'# Mobile\n\nexternal draft\n');
    await notice.getByRole('button',{name:'Keep my changes and overwrite'}).click();
    await notice.waitFor({state:'hidden'});
    assert.match(await page.evaluate(key=>atob(calciteTest.filesystem.store.get(key).data),key),/mobile draft/);
    assert(await page.evaluate(()=>[...calciteTest.filesystem.store].some(([file,row])=>file.includes('/sync-history/')&&row.data&&atob(row.data)==='# Mobile\n\nexternal draft\n')));
    console.log('Android bridge: appStateChange reload, pre-save dirty guard, and conflict backup.');
  }finally{await browser.close();server.close();}
}

async function run() {
  const scratch=await fs.mkdtemp(path.join(project,'.test-data','data-safety-'));
  try{
    await desktop(scratch);
    await retention(scratch);
    await syncStrategies(scratch);
    await mobile();
  }finally{await fs.rm(scratch,{recursive:true,force:true});}
}
(process.argv[2]==='--crash'?forceExit(process.argv[3]):run()).catch(error=>{console.error(error);process.exitCode=1;});
