const { _electron: electron }=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {VaultIndex,readNote}=require('../electron/index-service.cjs');
const {key}=require('../electron/workspace.cjs');

const project=path.resolve(__dirname,'..');
const round=value=>Number(value.toFixed(2));

async function verifyWatcher(scratch) {
  const profile=await fs.mkdtemp(path.join(scratch,'watch-'));
  const vault=path.join(profile,'vault'), alternate=path.join(profile,'alternate');
  await Promise.all([fs.mkdir(vault),fs.mkdir(alternate)]);
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env={...process.env,CALCITE_DATA_DIR:profile,CALCITE_TEST:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.argv[2];
  const app=await electron.launch({env,...(executablePath?{executablePath}:{args:[project]})});
  const metrics={};
  try {
    const page=await app.firstWindow();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const invoke=(name,...args)=>page.evaluate(([name,args])=>window.desktop[name](...args),[name,args]);
    await page.locator('#app:not([inert])').waitFor();
    await invoke('workspace-graph');
    await page.evaluate(()=>{
      window.externalBatches=[];
      window.desktop.onExternalChange(batch=>window.externalBatches.push(batch));
    });
    const excluded=path.join(vault,'.git');
    await fs.mkdir(excluded);
    await fs.writeFile(path.join(excluded,'ignored.md'),'# 隐藏目录');
    await fs.writeFile(path.join(vault,'ignored.md.tmp'),'# 临时文件');
    const folder=path.join(vault,'外部目录');
    await fs.mkdir(folder);
    const folderRow=page.locator('[data-folder]').getByText('外部目录',{exact:true});
    await folderRow.click();
    const file=path.join(folder,'实时.md');
    const row=page.locator('#side-content [data-file]').getByText('实时.md',{exact:true});
    const content=marker=>`# 实时\n\n${marker}\n\n`+Array.from({length:130},(_,n)=>`段落 ${n} ${marker}\n\n`).join('');
    await fs.writeFile(file,content('磁盘初始内容'));
    await row.click();
    assert.deepEqual((await invoke('workspace-graph')).nodes,[file]);
    await page.locator('footer [data-mode=source]').click();
    const editor=page.locator('#source-editor .cm-content');
    const scroller=page.locator('#source-editor .cm-scroller');
    await scroller.evaluate(element=>{element.scrollTop=460;});
    const cleanAt=performance.now();
    await fs.writeFile(file,content('磁盘清稿重载'));
    await page.waitForFunction(text=>document.querySelector('#source-editor .cm-content').textContent.includes(text),'磁盘清稿重载');
    metrics.externalCleanReloadMs=round(performance.now()-cleanAt);
    assert(await scroller.evaluate(element=>element.scrollTop)>300,'clean reload preserves scroll');
    assert(await row.isVisible(),'the open folder stays expanded');
    const notice=page.locator('#external-change');
    const append=async marker=>{
      await editor.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\n'+marker);
      await page.locator('.tab.active.dirty').waitFor();
    };
    await append('自动保存本机标记');
    await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存到本地');
    assert((await fs.readFile(file,'utf8')).includes('自动保存本机标记'));
    await page.evaluate(()=>window.externalBatches.length=0);
    const before=await invoke('search-index');
    await append('待保留草稿');
    const conflictAt=performance.now();
    await fs.writeFile(file,content('磁盘冲突稿'));
    await notice.getByRole('button',{name:'查看差异'}).waitFor();
    metrics.externalConflictMs=round(performance.now()-conflictAt);
    await notice.getByRole('button',{name:'查看差异'}).click();
    await page.locator('.history-dialog[open]').getByText('外部修改冲突',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭版本历史'}).click();
    await notice.getByRole('button',{name:'保留当前草稿'}).click();
    await notice.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('#save-state').textContent.includes('待手动保存'));
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal(await fs.readFile(file,'utf8'),content('磁盘冲突稿'));
    assert(await editor.getByText('待保留草稿',{exact:false}).isVisible());
    const delta=await invoke('search-index',before.cursor);
    assert.equal(delta.full,false);
    assert.deepEqual(delta.notes.map(note=>note.path),[file]);
    assert.equal(delta.notes[0].text,content('磁盘冲突稿'));
    await editor.focus();
    await page.keyboard.press('Control+s');
    await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存到本地');
    const owned=await invoke('search-index',delta.cursor);
    assert(owned.notes.some(note=>note.text.includes('待保留草稿')));
    await new Promise(resolve=>setTimeout(resolve,350));
    const events=await page.evaluate(()=>window.externalBatches.flatMap(batch=>batch.changes));
    assert.equal(events.filter(change=>change.type==='change').length,1,'internal write never becomes an external change');
    await append('下一份草稿');
    await fs.writeFile(file,content('采用磁盘稿'));
    await notice.getByRole('button',{name:'加载磁盘版本'}).click();
    await notice.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存到本地');
    await fs.unlink(file);
    await row.waitFor({state:'detached'});
    await page.locator('.tab.active[data-deleted]').waitFor();
    const rescued=path.join(folder,'另存恢复.md');
    await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},rescued);
    await notice.getByRole('button',{name:'另存为'}).click();
    await page.locator('.tab.active').getByText('另存恢复.md',{exact:true}).waitFor();
    assert.equal(await fs.readFile(rescued,'utf8'),content('采用磁盘稿'));
    const empty=path.join(vault,'外部空目录');
    const emptyRow=page.locator('[data-folder]').getByText('外部空目录',{exact:true});
    await fs.mkdir(empty);
    await emptyRow.waitFor();
    await fs.rmdir(empty);
    await emptyRow.waitFor({state:'detached'});
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},alternate);
    await page.locator('.workspace-picker summary').click();
    await page.getByRole('button',{name:'打开工作区文件夹…'}).click();
    await page.locator('#workspace-name').getByText('alternate',{exact:true}).waitFor();
    const departed=path.join(vault,'旧库.md'), activeNote=path.join(alternate,'新库.md');
    await fs.writeFile(departed,'# 不应出现在新库');
    await fs.writeFile(activeNote,'# 新库');
    await page.locator('#side-content [data-file]').getByText('新库.md',{exact:true}).waitFor();
    assert.deepEqual((await invoke('workspace-graph')).nodes,[activeNote]);
    assert(!await page.evaluate(file=>window.externalBatches.some(batch=>batch.changes.some(change=>change.path===file)),departed));
    await assert.rejects(invoke('read',rescued),/未授权/);
    await page.locator('.workspace-picker summary').click();
    await page.getByRole('button',{name:'关闭工作区文件夹'}).click();
    await page.locator('#workspace-name').getByText('本地工作区',{exact:true}).waitFor();
    assert.deepEqual(await invoke('tree'),[]);
    assert.deepEqual(errors,[]);
    return metrics;
  } finally {await app.evaluate(({app})=>app.exit()).catch(()=>{});}
}

async function benchmark(scratch) {
  const vault=await fs.mkdtemp(path.join(scratch,'index-1000-'));
  const name=i=>`Note-${String(i).padStart(4,'0')}`;
  const note=(i,next)=>`---\ntags: [benchmark, topic/topic-${i%10}]\nweight: ${i}\n---\n# ${name(i)}\n\n[[${name(next)}]]\n\n`+
    Array.from({length:12},(_,line)=>`Fixture paragraph ${line} for sample-${i}. Incremental indexing keeps allocation and IO local to changed nodes. `).join('\n');
  for (let group=0;group<10;group++) {
    const folder=path.join(vault,'目录-'+group);
    await fs.mkdir(folder);
    await Promise.all(Array.from({length:100},(_,offset)=>{
      const i=group*100+offset;
      return fs.writeFile(path.join(folder,name(i)+'.md'),note(i,(i+1)%1000));
    }));
  }
  const index=new VaultIndex(vault);
  const canceled=new AbortController();
  const abandoned=new VaultIndex(vault,canceled.signal);
  await abandoned.build(()=>canceled.abort());
  assert.equal(abandoned.paths().length,0,'closing a vault can cancel a cold index');
  const cold=performance.now();
  await index.build();
  const coldIndexMs=round(performance.now()-cold);
  assert.equal(index.paths().length,1000);
  assert.equal(index.graph([]).edges.length,1000);
  const source=path.join(vault,'目录-0',name(0)+'.md');
  const target=path.join(vault,'目录-0',name(1)+'.md');
  const newTarget=path.join(vault,'目录-9',name(999)+'.md');
  assert(index.backlinks(target,[]).some(row=>row.path===source));
  assert(!index.backlinks(target,[{path:source,text:note(0,999)}]).some(row=>row.path===source));
  assert(index.graph([{path:source,text:note(0,999)}]).edges.some(edge=>edge.from===source&&edge.to===newTarget));
  const cursor=index.searchSnapshot().cursor;
  await fs.writeFile(source,note(0,999));
  const incremental=performance.now();
  index.apply([{file:source,data:await readNote(vault,source)}]);
  const oneFileUpdateMs=round(performance.now()-incremental);
  const delta=index.searchSnapshot(cursor);
  assert.equal(delta.cursor.revision,cursor.revision+1);
  assert.deepEqual(delta.notes.map(row=>row.path),[source]);
  assert(!index.backlinks(target,[]).some(row=>row.path===source));
  assert(index.backlinks(newTarget,[]).some(row=>row.path===source));
  const measure=operation=>{
    for(let i=0;i<3;i++) operation();
    const samples=Array.from({length:40},()=>{
      const start=performance.now();operation();return performance.now()-start;
    }).sort((a,b)=>a-b);
    return {median:round(samples[20]),p95:round(samples[37])};
  };
  const result={notes:1000,coldIndexMs,oneFileUpdateMs,
    backlinksMs:measure(()=>index.backlinks(newTarget,[])),graphDataMs:measure(()=>index.graph([])),
    indexedSearchMs:measure(()=>index.search('sample-999.'))};

  const alternate=path.join(vault,'重复名字');
  await fs.mkdir(alternate);
  const duplicate=path.join(alternate,name(999)+'.md');
  await fs.writeFile(duplicate,'# 重复名称');
  index.apply([{file:duplicate,data:await readNote(vault,duplicate)}]);
  assert(!index.backlinks(newTarget,[]).some(row=>row.path===source),'a new ambiguous name invalidates its existing edges');
  await fs.unlink(duplicate);
  index.apply([{file:duplicate,data:null}]);
  assert(index.backlinks(newTarget,[]).some(row=>row.path===source),'removing ambiguity restores links without re-reading source');
  const large=path.join(vault,'large.md');
  await fs.writeFile(large,'---\ntags: [large]\n---\n# Large\n\n'+('Large line\n'.repeat(210000)));
  index.apply([{file:large,data:await readNote(vault,large)}]);
  assert.equal(index.notes.get(key(large))?.text,null);
  assert((await index.workspaceNotes('metadata')).some(row=>row.path===large&&row.tags.includes('large')));
  assert(!index.searchSnapshot().notes.some(row=>row.path===large));
  return {result,vault,target:newTarget};
}

async function benchmarkIpc(scratch,vault,target) {
  const profile=await fs.mkdtemp(path.join(scratch,'index-ipc-'));
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env={...process.env,CALCITE_DATA_DIR:profile,CALCITE_TEST:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.argv[2];
  const app=await electron.launch({env,...(executablePath?{executablePath}:{args:[project]})});
  try {
    const page=await app.firstWindow();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    await page.locator('#app:not([inert])').waitFor();
    const sample=await page.evaluate(async target=>{
      const first=await window.desktop['workspace-graph']();
      const operations={backlinks:()=>window.desktop.backlinks(target,[]),graphData:()=>window.desktop['workspace-graph'](),
        search:()=>window.desktop.search('sample-999.')};
      const results={};
      for(const [name,query] of Object.entries(operations)) {
        const times=[];
        await query();
        for(let i=0;i<25;i++) {
          const start=performance.now();
          await query();
          times.push(performance.now()-start);
        }
        times.sort((a,b)=>a-b);
        results[name]={median:times[12],p95:times[23]};
      }
      return {first,results};
    },target);
    assert.equal(sample.first.nodes.length,1001);
    assert.equal(sample.first.edges.length,1000);
    const graphTiming=await page.evaluate(()=>new Promise((resolve,reject)=>{
      let graphHudMs;
      const start=performance.now();
      const observer=new MutationObserver(()=>{
        const graph=document.querySelector('.graph-dialog[open]');
        if (graph?.querySelector('.graph-count').textContent!=='1001 篇笔记') return;
        graphHudMs??=performance.now()-start;
        if (!graph.querySelector('.graph-message').hidden) return;
        clearTimeout(timer);observer.disconnect();
        resolve({graphHudMs,graphOpenAndLayoutMs:performance.now()-start});
      });
      const timer=setTimeout(()=>{observer.disconnect();reject(Error('Large graph did not finish layout'));},15000);
      observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden']});
      document.querySelector('button[data-action="graph"]').click();
    }));
    await page.keyboard.press('Escape');
    await page.locator('[data-pane="search"]').click();
    const search=page.locator('#workspace-search');
    const match=query=>page.locator('.search-result').filter({hasText:query}).first().waitFor();
    await search.fill('tag:benchmark sample-998.');
    await match('sample-998.');
    const warmSearchUiMs=await page.evaluate(()=>new Promise((resolve,reject)=>{
      const start=performance.now();
      const results=document.querySelector('#search-results');
      const observer=new MutationObserver(()=>{
        if (![...results.querySelectorAll('.search-result')].some(row=>row.textContent.includes('sample-999.'))) return;
        clearTimeout(timer);observer.disconnect();resolve(performance.now()-start);
      });
      const timer=setTimeout(()=>{observer.disconnect();reject(Error('Search did not return the expected note'));},7000);
      observer.observe(results,{childList:true,subtree:true});
      const input=document.querySelector('#workspace-search');
      input.value='tag:benchmark sample-999.';
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }));
    return {queriesMs:Object.fromEntries(Object.entries(sample.results).map(([name,data])=>
      [name,{median:round(data.median),p95:round(data.p95)}])),graphHudMs:round(graphTiming.graphHudMs),
      graphOpenAndLayoutMs:round(graphTiming.graphOpenAndLayoutMs),warmSearchUiMs:round(warmSearchUiMs)};
  } finally {await app.evaluate(({app})=>app.exit()).catch(()=>{});}
}

async function run() {
  const scratch=path.join(project,'.test-data');
  await fs.mkdir(scratch,{recursive:true});
  const watcher=await verifyWatcher(scratch);
  const {result:index,vault,target}=await benchmark(scratch);
  const ipc=await benchmarkIpc(scratch,vault,target);
  console.log(JSON.stringify({watcher,index,ipc},null,2));
}

run().catch(error=>{console.error(error);process.exitCode=1;});
