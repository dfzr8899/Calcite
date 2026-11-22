const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const git=require('isomorphic-git');
const {performance}=require('node:perf_hooks');
const {_electron:electron,chromium}=require('playwright');
const {createVaultService}=require('../electron/vault-service.cjs');
const {VaultIndex}=require('../electron/index-service.cjs');
const {entry}=require('../electron/watcher.cjs');
const {GitEngine}=require('../electron/git-engine.cjs');
const {memoryFilesystem,registerNativeMock,serveDist,chromiumOptions}=require('./mobile-smoke.cjs');

const project=path.resolve(__dirname,'..');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFzoAAAAASUVORK5CYII=';
const fixture=[
  '---','# untouched YAML comment','title: 原标题','unknown:', '  flag: true','  list: [alpha, beta]',
  '  text: |','    行一','    行二','tags: [project/phase]','---','# 测试标题','',
  '| 公式 | 代码 |','| --- | --- |','| $x^2$ | `inline-code` |','',
  '- 外层','  - 内层','','    ```js','    const literal = "$notMath$";','    ```','',
  '- [x] 完成索引','- [ ] 再验证','',
  '[[另一篇#章节|文本别名]] ![[附件.png|图注]] #project/phase/two','',
  '唯一检索词',''
].join('\n');

async function verifyIndex(scratch) {
  const root=path.join(scratch,'five-hundred');
  await fs.mkdir(root);
  const notes=Array.from({length:500},(_,i)=>path.join(root,'Note-'+String(i).padStart(3,'0')+'.md'));
  for(let offset=0;offset<notes.length;offset+=50)
    await Promise.all(notes.slice(offset,offset+50).map((file,i)=>fs.writeFile(file,offset+i===0?fixture:'# Note '+(offset+i)+'\n\n索引内容')));
  const read=fs.open,reads=[];
  const failures=[];
  fs.open=async(file,...args)=>{
    if(typeof file==='string'&&file.endsWith('.md'))reads.push(file);
    return read(file,...args);
  };
  const vault=createVaultService({queue:task=>Promise.resolve().then(task),publish(){},fail:error=>failures.push(error)});
  try{
    const start=performance.now();
    vault.start(root);
    assert.equal((await vault.tree()).length,500);
    assert.equal(reads.length,0,'directory tree may not open a note body');
    const treeMs=performance.now()-start,cold=performance.now();
    const index=await vault.index();
    assert.equal(index.paths().length,500);
    assert.equal(reads.length,500);
    const indexMs=performance.now()-cold;
    const [first]=await index.workspaceNotes('metadata',[]);
    assert.equal(first.title,'原标题');
    assert.deepEqual(first.frontmatter.unknown.list,['alpha','beta']);
    assert.equal(first.headings[0].line,12);
    assert.equal(first.headings[0].level,1);
    assert(first.tags.includes('project/phase/two'));
    assert.deepEqual(first.wikilinks.map(({target,heading,alias,embedded})=>[target,heading,alias,embedded]),
      [['另一篇','章节','文本别名',false],['附件.png','','图注',true]]);
    assert.deepEqual(first.tasks,[{text:'完成索引',checked:true},{text:'再验证',checked:false}]);
    await index.flushCache();
    reads.length=0;
    const warmed=new VaultIndex(root),warm=performance.now();
    await warmed.build();
    const warmMs=performance.now()-warm;
    assert.equal(warmed.paths().length,500);
    assert.equal(reads.length,0,'warm index may use valid persistent records');
    assert.equal(warmed.search('唯一检索词')[0].path,notes[0]);
    const cursor=warmed.searchSnapshot().cursor;
    await fs.writeFile(notes[122],'# 已增量更新\n\n新增长度用于确保元数据版本发生变化。');
    const delta=performance.now();
    warmed.observe(notes[122],await entry(root,notes[122]));
    await warmed.refresh();
    const updateMs=performance.now()-delta;
    assert.deepEqual(reads,[notes[122]]);
    assert.deepEqual(warmed.searchSnapshot(cursor).notes.map(note=>note.path),[notes[122]]);
    await warmed.flushCache();
    assert.deepEqual(failures,[]);
    console.log('500 notes '+JSON.stringify({treeMs:+treeMs.toFixed(1),coldIndexMs:+indexMs.toFixed(1),
      warmIndexMs:+warmMs.toFixed(1),oneNoteMs:+updateMs.toFixed(1),treeReads:0,warmReads:0,deltaReads:1}));
  }finally{
    vault.close();
    fs.open=read;
  }
}

async function verifyLineEndings(scratch) {
  const {normalizeLineEndings}=await import('../shared/text-files.mjs');
  const {properties,splitFrontmatter,writeProperties}=await import('../shared/note-metadata.mjs');
  const raw=fixture.replaceAll('\n','\r\n');
  const {yaml}=splitFrontmatter(raw);
  const before=properties(yaml);
  const result=writeProperties(raw,{...before,title:'新标题'});
  assert.equal(splitFrontmatter(result).body,splitFrontmatter(raw).body);
  assert(result.includes('unknown:\r\n  flag: true\r\n  list: [alpha, beta]\r\n  text: |\r\n    行一\r\n    行二\r\n'));
  assert.deepEqual(properties(splitFrontmatter(result).yaml).unknown,before.unknown);
  assert.equal(normalizeLineEndings('test.md',result).includes('\r'),false);
  const binary=Buffer.from([0x89,0x50,0x0d,0x0a,0x00,0xff]);
  assert.equal(normalizeLineEndings('bogus.txt',binary),binary);
  const fakeImage=Buffer.from('binary\r\n bytes','latin1');
  assert.equal(normalizeLineEndings('image.png',fakeImage),fakeImage);
  const invalid=Buffer.from([0xff,0x0d,0x0a]);
  assert.equal(normalizeLineEndings('legacy.txt',invalid),invalid);

  const src=path.join(scratch,'legacy'),dst=path.join(scratch,'target');
  await Promise.all([fs.mkdir(src),fs.mkdir(dst)]);
  const origin=new GitEngine(src),target=new GitEngine(dst);
  await Promise.all([origin.open(),target.open()]);
  const author={name:'Calcite Test',email:'editor@calcite.local'};
  const inputs={'note.md':'标题\r\n公共行\r\n第二行\r\n','data.json':'{\r\n"ok":true\r\n}\r\n',
    'protected.txt':binary,'image.png':fakeImage};
  for(const [name,bytes] of Object.entries(inputs))await fs.writeFile(path.join(src,name),bytes);
  await git.add({...origin.args,filepath:['.gitignore',...Object.keys(inputs)]});
  const remote=await git.commit({...origin.args,author,message:'legacy CRLF'});
  await fs.unlink(path.join(dst,'.gitignore'));
  await target.accept(await Promise.all((await origin.objects(remote)).map(oid=>origin.object(oid))));
  const applied=await target.apply(remote,author);
  assert.equal(applied.conflicts.length,0);
  assert.equal(await fs.readFile(path.join(dst,'note.md'),'utf8'),'标题\n公共行\n第二行\n');
  assert.equal(await fs.readFile(path.join(dst,'data.json'),'utf8'),'{\n"ok":true\n}\n');
  assert.deepEqual(await fs.readFile(path.join(dst,'protected.txt')),binary);
  assert.deepEqual(await fs.readFile(path.join(dst,'image.png')),fakeImage);
  const normalized=await target.head();
  assert.notEqual(normalized,remote);
  assert.deepEqual((await git.readCommit({...target.args,oid:normalized})).commit.parent,[remote]);
  assert.equal(await target.snapshot(author),normalized,'fast-forward normalization leaves no staged or working changes');
  await fs.writeFile(path.join(src,'note.md'),'远程标题\r\n公共行\r\n第二行\r\n');
  await git.add({...origin.args,filepath:'note.md'});
  const incoming=await git.commit({...origin.args,author,message:'legacy device edit'});
  await fs.writeFile(path.join(dst,'note.md'),'标题\n公共行\n本机第二行\n');
  await target.snapshot(author);
  await target.accept(await Promise.all((await origin.objects(incoming)).map(oid=>origin.object(oid))));
  assert.equal((await target.apply(incoming,author)).conflicts.length,0);
  assert.equal(await fs.readFile(path.join(dst,'note.md'),'utf8'),'远程标题\n公共行\n本机第二行\n');
  await fs.mkdir(path.join(dst,'.calcite'));
  await fs.writeFile(path.join(dst,'.calcite','index-v1.json'),'{"local":true}');
  await fs.writeFile(path.join(dst,'todo.yml'),'done: true\r\n');
  const saved=await target.snapshot(author);
  assert.equal(await fs.readFile(path.join(dst,'todo.yml'),'utf8'),'done: true\n');
  assert(!(await target.tracked(saved)).has('.calcite/index-v1.json'));
  console.log('LF checks passed for editor text, legacy Git fast-forward and protected binary bytes.');
}

async function desktopEditor(scratch) {
  const vault=path.join(scratch,'editor-vault'),profile=path.join(scratch,'editor-profile');
  await Promise.all([fs.mkdir(vault),fs.mkdir(profile)]);
  const note=path.join(vault,'编辑验证.md');
  await fs.writeFile(note,fixture.replaceAll('\n','\r\n'));
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env={...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[project],env});
  try{
    const page=await app.firstWindow();
    page.setDefaultTimeout(12000);
    await page.locator('#app:not([inert])').waitFor();
    await page.locator('[data-file]').getByText('编辑验证.md',{exact:true}).click();
    await page.locator('#live-editor td [data-type=math_inline]').waitFor();
    await page.locator('#live-editor li pre').getByText(/notMath/).waitFor();
    await page.locator('footer [data-mode=read]').click();
    const reading=page.locator('#reading');
    await reading.locator('td .katex').waitFor();
    assert.equal(await reading.locator('td code').textContent(),'inline-code');
    assert.match(await reading.locator('li pre code').textContent(),/\$notMath\$/);
    assert.equal(await reading.locator(':scope .reading-content > hr').count(),0);
    await page.keyboard.press('Control+f');
    await page.locator('#document-find [name=query]').fill('唯一检索词');
    const highlighted=()=>page.waitForFunction(()=>CSS.highlights.get('note-find')?.size===1&&
      [...CSS.highlights.get('note-find')][0].startContainer.isConnected);
    await highlighted();
    await reading.getByRole('button',{name:'编辑属性'}).click();
    await page.locator('dialog[open] [name=key]').fill('title');
    await page.locator('dialog[open] [name=value]').fill('编辑后标题');
    await page.getByRole('button',{name:'保存属性'}).click();
    await reading.getByText('编辑后标题',{exact:true}).waitFor();
    await highlighted();
    await page.locator('#document-find [data-find=close]').click();
    await page.locator('footer [data-mode=source]').click();
    await page.locator('#source-editor .cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n');
    await page.evaluate(encoded=>{
      const data=new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],'pasted.png',{type:'image/png'}));
      document.querySelector('#source-editor .cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    },png);
    await page.waitForFunction(()=>document.querySelector('#source-editor .cm-content').innerText.includes('assets/'));
    await page.keyboard.press('Control+s');
    let saved;
    const deadline=Date.now()+12000;
    do {
      saved=await fs.readFile(note,'utf8');
      if(saved.includes('assets/'))break;
      await new Promise(resolve=>setTimeout(resolve,65));
    }while(Date.now()<deadline);
    assert(!saved.includes('\r'));
    assert.match(saved,/title: 编辑后标题/);
    assert.match(saved,/unknown:\n  flag: true\n  list: \[alpha, beta\]/);
    const match=/!\[pasted\.png\]\((assets\/[^)]+)\)/.exec(saved);
    assert(match);
    assert.deepEqual(await fs.readFile(path.join(vault,match[1])),Buffer.from(png,'base64'));
    console.log('Desktop editor passed: nested GFM, YAML field edit, search highlight after redraw and image paste.');
  }finally{await app.evaluate(({app})=>app.exit()).catch(()=>{});}
}

async function androidEditor() {
  const {server,url}=await serveDist();
  let browser;
  try {
    browser=await chromium.launch(chromiumOptions());
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const files=Object.fromEntries(Array.from({length:500},(_,i)=>['CalciteVaults/性能测试/'+String(i).padStart(3,'0')+'.md',
      Buffer.from(i===0?fixture.replaceAll('\n','\r\n'):'# 文件 '+i+'\n\n全库检索样本').toString('base64')]));
    await context.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+','+JSON.stringify(files)+
      ',{"prefs":{"git:/CalciteVaults/性能测试":{"settings":{"enabled":false}}}});'+
      'window.bodyReads=[];const nativeRead=calciteTest.filesystem.readFile;calciteTest.filesystem.readFile=options=>{if(options.path.endsWith(".md"))bodyReads.push(options.path);return nativeRead(options);};'});
    const page=await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(url);
    await page.locator('#app:not([inert])').waitFor();
    await page.locator('#source-editor .cm-content').getByText(/原标题/).waitFor();
    await page.getByRole('button',{name:'打开文件抽屉',exact:true}).tap();
    await page.waitForFunction(()=>document.querySelectorAll('#side-content [data-file]').length===500);
    assert.deepEqual(await page.evaluate(()=>[...new Set(bodyReads)]),['CalciteVaults/性能测试/000.md']);
    await page.getByRole('button',{name:'关闭抽屉',exact:true}).tap({position:{x:382,y:120}});
    await page.locator('#source-editor .cm-content').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n');
    await page.evaluate(data=>{
      calciteTest.fixture.clipboardImage={type:'image/png',data};
      document.querySelector('#source-editor .cm-content').dispatchEvent(new ClipboardEvent('paste',{
        clipboardData:new DataTransfer(),bubbles:true,cancelable:true
      }));
    },png);
    await page.waitForFunction(()=>document.querySelector('#source-editor .cm-content').innerText.includes('assets/'));
    await page.waitForFunction(()=>{
      const stored=calciteTest.filesystem.store.get('DATA:CalciteVaults/性能测试/000.md');
      return stored&&atob(stored.data).includes('assets/')&&!atob(stored.data).includes('\r');
    });
    console.log('Android bridge mock passed: 500 tree entries with only the opened note read, native clipboard image and LF save.');
  }finally{await browser?.close();server.close();}
}

(async()=>{
  const scratch=await fs.mkdtemp(path.join(project,'.test-data','editor-index-'));
  await verifyIndex(scratch);
  await verifyLineEndings(scratch);
  if(!process.argv.includes('--core-only')){
    await desktopEditor(scratch);
    await androidEditor();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
