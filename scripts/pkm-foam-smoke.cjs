const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {marked}=require('marked');
const git=require('isomorphic-git');
const {_electron:electron,chromium}=require('playwright');
const {VaultIndex}=require('../electron/index-service.cjs');
const {memoryFilesystem,registerNativeMock,serveDist,chromiumOptions}=require('./mobile-smoke.cjs');

const project=path.resolve(__dirname,'..');
const fixture={
  'A.md':[
    '# A','','引用段落前文','[[dp/模板#二号章节|动态规划]] 与 [[模板]]','引用段落后文','',
    '![[B]]','','[[Drafts/待建]]、[[graph/模板#没有这个标题]]、[旧文件](dp/无.md)','',
    '[相对链接](./dp/模板.md#二号章节 "原始标题")','',
    '直接写法 [[dp/模板]]；内嵌 ![[dp/模板#二号章节]]。','',
    '行内 `[[dp/模板]]` 和 ``包含 ` 与 [[dp/模板]]``。','',
    '- 列表示例','','  ```md','  [[dp/模板]] [不要改](dp/模板.md)','  ```','','~~~','[[dp/模板]]','~~~','',
    '#算法/图论/最短路'
  ].join('\n')+'\n',
  'B.md':'# B\n\n![[A]]\n',
  'Lonely.md':'# Lonely\n\n完全独立。\n',
  'dp/模板.md':'---\ntitle: 动态规划模板\n---\n# 模板\n\n## 一号章节\n\n这一段应省略。\n\n## 二号章节\n\n这一段应内嵌。\n\n[[../A]]\n',
  'graph/模板.md':'# 图论模板\n\n#算法/图论/搜索\n',
  'Archive/Marker.md':'# Moved destination\n',
  '模板/每日.md':'---\nkind: daily\n---\n# {{title}}\n\n{{date}} / {{time}} / {{weekday}} / {{vault}}\n'
};
const preferences={dailyDirectory:'Journal',dailyFilePattern:'日志-YYYY_MM_DD',dailyTemplate:'模板/每日.md'};

async function seed(vault){
  for(const [file,text] of Object.entries(fixture)){
    const dest=path.join(vault,file);
    await fs.mkdir(path.dirname(dest),{recursive:true});
    await fs.writeFile(dest,text);
  }
}

async function core(vault) {
  const {mapLinks,wikiIdentifiers}=await import('../shared/note-links.mjs');
  const {planLinkRefactor,replaceReference,splitReferenceBlock,updateReferenceDefinitions}=await import('../shared/core/link-refactor.mjs');
  const {tagTree,dailyNoteName,expandNoteTemplate}=await import('../shared/pkm-workflows.mjs');
  const exact=relative=>path.join(vault,relative);
  const index=new VaultIndex(vault);
  await index.build();
  const a=exact('A.md'), dp=exact('dp/模板.md'), graph=exact('graph/模板.md');
  const identifiers=wikiIdentifiers(index.paths(),file=>path.relative(vault,file).replaceAll('\\','/'),index.key);
  assert.equal(identifiers.get(dp),'dp/模板');
  assert.equal(identifiers.get(graph),'graph/模板');
  const ambiguous=index.inspect(a,'模板');
  assert.equal(ambiguous.status,'ambiguous');
  assert.deepEqual(ambiguous.candidates.map(row=>row.identifier),['dp/模板','graph/模板']);
  const heading=index.inspect(a,'dp/模板#二号章节',true,true);
  assert.equal(heading.slug,'二号章节');
  assert.equal(heading.headings.find(row=>row.text==='二号章节').line,10);
  assert.equal(index.inspect(a,'graph/模板#错').status,'broken-heading');
  const {orphans,issues}=index.health();
  assert(orphans.includes(exact('Lonely.md'))&&!orphans.includes(dp));
  assert(issues.some(row=>row.status==='placeholder'&&row.destination==='Drafts/待建'));
  assert(issues.some(row=>row.status==='broken'&&row.destination==='dp/无.md'));
  const diagnosis=issues.find(row=>row.status==='ambiguous');
  assert.match(replaceReference(fixture['A.md'],diagnosis,'graph/模板'),/与 \[\[graph\/模板\]\]/);
  assert.throws(()=>replaceReference('\n'+fixture['A.md'],diagnosis,'graph/模板'),/已变化/);
  const [{linked}]=index.backlinks(dp,[]).filter(row=>row.path===a);
  assert.match(linked[0].text,/引用段落前文\n.+\n引用段落后文/);
  assert.equal(linked[0].text.slice(...linked[0].marks[0]),'dp/模板#二号章节');
  const moved=exact('Archive/新 模板.md');
  const draft=fixture['A.md']+'\n草稿 [[dp/模板]]\n';
  const read=async file=>({text:await fs.readFile(file,'utf8'),mtime:(await fs.stat(file)).mtimeMs});
  const {changes,refactor}=await planLinkRefactor(index,dp,moved,[{path:a,text:draft,saved:fixture['A.md']}],read);
  const changed=changes.find(row=>row.from===a);
  assert.deepEqual(refactor,{notes:1,references:5});
  assert.match(changed.saved,/\[\[新 模板#二号章节\|动态规划\]\]/);
  assert.match(changed.saved,/!\[\[新 模板#二号章节\]\]/);
  assert.match(changed.saved,/\.\/Archive\/%E6%96%B0%20%E6%A8%A1%E6%9D%BF\.md#二号章节 "原始标题"/);
  assert.match(changed.saved,/行内 `\[\[dp\/模板\]\]`/);
  assert.match(changed.saved,/\[\[dp\/模板\]\] \[不要改\]\(dp\/模板\.md\)/);
  assert.match(changed.saved,/~~~\n\[\[dp\/模板\]\]\n~~~/);
  assert.match(changed.draft,/草稿 \[\[新 模板\]\]/);
  assert.equal(mapLinks('    [[dp/模板]]\n\n\\[[dp/模板]]\n',(value,wiki)=>wiki?'错误':value),'    [[dp/模板]]\n\n\\[[dp/模板]]\n');
  const generate=text=>updateReferenceDefinitions(text,links=>links.map(link=>index.inspect(a,link)),
    target=>path.relative(vault,target));
  const generated=await generate(fixture['A.md']+'\n[手写]: ./a.md\n');
  assert(generated.count>=3);
  assert.match(generated.text,/\[dp\/模板#二号章节\|动态规划\]: \.\/dp\/.+#%E4%BA%8C/);
  assert.match(generated.text,/\[手写\]: \.\/a\.md/);
  assert.match(marked.parse(generated.text),/<a href="\.\/dp\/[^"]+" title="动态规划模板">dp\/模板#二号章节\|动态规划<\/a>/);
  assert.equal((await generate(generated.text)).text,generated.text);
  assert(splitReferenceBlock(generated.text).suffix);
  const withReferences=await planLinkRefactor(index,dp,moved,[],file=>file===a?{text:generated.text,mtime:1}:read(file));
  assert.match(withReferences.changes.find(row=>row.from===a).saved,/\[新 模板#二号章节\|动态规划\]: \.\/Archive\//);
  const [algorithm]=tagTree(await index.workspaceNotes('metadata',[]));
  assert.equal(algorithm.label,'算法');
  assert.deepEqual(new Set(algorithm.paths),new Set([a,graph]));
  assert.deepEqual(algorithm.children[0].children.map(row=>row.label),['搜索','最短路'].sort((a,b)=>a.localeCompare(b,'zh-CN')));
  const date=new Date(2026,10,22,9,7);
  assert.equal(dailyNoteName('日志-YYYY_MM_DD',date),'日志-2026_11_22');
  assert.equal(expandNoteTemplate('{{date}} {{time}} {{title}} {{weekday}} {{vault}}',{date,title:'今日',vault:'PKM'}),
    '2026-11-22 09:07 今日 星期日 PKM');
  await index.flushCache();
  console.log('PKM core passed: lexical refactor, ambiguity, backlinks, tag tree, daily variables and Markdown-compatible references.');
}

async function desktop(profile,vault){
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault,features:preferences}));
  const env={...process.env,CALCITE_DATA_DIR:profile,CALCITE_TEST:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[project],env});
  try{
    const page=await app.firstWindow();
    page.setDefaultTimeout(12000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const note=name=>page.locator('#side-content [data-file]').getByText(name,{exact:true});
    await note('A.md').click();
    await page.locator('[data-mode=read]').click();
    const reader=page.locator('#reading');
    const alias=reader.getByRole('link',{name:'动态规划',exact:true});
    await alias.hover();
    await page.locator('.hover-preview:visible').getByText('这一段应内嵌。',{exact:true}).waitFor();
    assert.equal(await page.locator('.hover-preview').getByText('这一段应省略。',{exact:true}).count(),0);
    await page.locator('#reading .note-embed-content').getByText('检测到循环内嵌',{exact:true}).waitFor();
    await alias.click();
    await page.locator('.tab.active').getByText('模板.md',{exact:true}).waitFor();
    await page.locator('#backlinks-tab').click();
    await page.locator('#backlinks summary').getByText('A.md',{exact:true}).click();
    const backlink=page.locator('#backlinks .backlink-context').filter({hasText:'引用段落前文'}).first();
    await backlink.locator('mark').getByText('dp/模板#二号章节',{exact:true}).waitFor();
    await backlink.click();
    await page.locator('#source-editor .cm-content').getByText('引用段落前文',{exact:true}).waitFor();
    assert.match(await page.evaluate(()=>getSelection()?.anchorNode?.parentElement.closest('.cm-line')?.textContent||''),/dp\/模板#二号章节/);
    await page.locator('[data-mode=read]').click();
    await page.locator('#reading a[data-link-status=placeholder]').click();
    await page.locator('.tab.active').getByText('待建.md',{exact:true}).waitFor();
    await fs.access(path.join(vault,'Drafts','待建.md'));
    await page.locator('[data-pane=health]').click();
    await page.locator('[data-health=orphans]').getByText('Lonely.md').waitFor();
    await page.locator('[data-health=broken]').getByText(/失效章节/).waitFor();
    await page.locator('[data-fix-issue]').getByText('graph/模板',{exact:true}).click();
    await page.locator('#toast').getByText(/已将引用指向/).waitFor();
    assert.match(await fs.readFile(path.join(vault,'A.md'),'utf8'),/与 \[\[graph\/模板\]\]/);
    await page.locator('[data-pane=tags]:visible').click();
    await page.locator('details[data-tag=算法] > summary').click();
    await page.locator('button.tag-filter').getByText(/全部 #算法 · 2/).click();
    assert.equal(await page.locator('details[data-tag=算法] > [data-file]').count(),2);
    await page.locator('.tab').getByText('A.md',{exact:true}).click();
    await page.locator('[data-mode=source]').click();
    const editor=page.locator('#source-editor .cm-content');
    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n[[模');
    const completion=page.locator('.link-completion button').filter({hasText:'dp/模板.md'});
    await completion.click();
    assert.match(await editor.innerText(),/\[\[dp\/模板\]\]/);
    await page.keyboard.insertText('\n[[dp/模板#二号');
    await page.locator('.link-completion button').getByText('二号章节',{exact:true}).click();
    await page.keyboard.press('Control+s');
    await page.locator('[data-action=more]:visible').click();
    await page.getByRole('menuitem',{name:'格式化与目录',exact:true}).click();
    await page.getByRole('menuitem',{name:'补全/更新文末标准引用定义',exact:true}).click();
    await page.locator('#toast').getByText(/已补全/).waitFor();
    assert.match(await fs.readFile(path.join(vault,'A.md'),'utf8'),/calcite:refs:start/);
    await page.locator('[data-mode=live]').click();
    await page.locator('#live-editor .live-embed-slot').getByText('检测到循环内嵌',{exact:true}).waitFor();
    await page.locator('[data-pane=files]:visible').click();
    await page.locator('#side-content [data-folder]').getByText('dp',{exact:true}).click({button:'right'});
    await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
    const dialog=page.locator('dialog[open]').last();
    await dialog.locator('[name=name]').fill('programming');
    await dialog.getByRole('button',{name:'确定',exact:true}).click();
    await page.locator('#toast').getByText(/已自动更新/).waitFor();
    const renamed=await fs.readFile(path.join(vault,'A.md'),'utf8');
    assert.match(renamed,/\[\[programming\/模板#二号章节\|动态规划\]\]/);
    assert.match(renamed,/\[programming\/模板#二号章节\|动态规划\]:/);
    assert.match(renamed,/行内 `\[\[dp\/模板\]\]`/);
    await page.locator('[data-action=daily]:visible').click();
    await page.locator('.tab.active').getByText(/^日志-\d{4}_\d{2}_\d{2}\.md$/).waitFor();
    const [daily]=await fs.readdir(path.join(vault,'Journal'));
    const body=await fs.readFile(path.join(vault,'Journal',daily),'utf8');
    assert.match(body,/# 日志-\d{4}_\d{2}_\d{2}\n\n\d{4}-\d{2}-\d{2} \/ \d{2}:\d{2} \/ 星期. \/ vault/);
    await page.locator('[data-action=random]:visible').click();
    await page.locator('.tab.active').getByText(daily,{exact:true}).waitFor({state:'hidden'});
    assert.deepEqual(errors,[]);
    console.log('Windows renderer passed: hover and section preview, health repair, placeholders, tags, completion, references, live cycles, folder refactor, daily template, and random note.');
  }finally{await app.evaluate(({app})=>app.exit()).catch(()=>{});}
}

async function android(){
  const {server,url}=await serveDist();
  let browser;
  try{
    browser=await chromium.launch(chromiumOptions());
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const seed=Object.fromEntries(Object.entries(fixture).map(([file,text])=>['CalciteVaults/PKM/'+file,Buffer.from(text).toString('base64')]));
    await context.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+','+
      JSON.stringify(seed)+',{"prefs":{"features":{"mobileLiveEditing":true}}});'});
    const page=await context.newPage();
    page.setDefaultTimeout(12000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.locator('#app:not([inert])').waitFor();
    const tap=name=>page.getByRole('button',{name,exact:true}).tap();
    await tap('打开文件抽屉');
    await page.locator('#side-content [data-file]').getByText('A.md',{exact:true}).tap();
    await tap('更多文档操作');
    const sheet=page.locator('.mobile-sheet[open]');
    await sheet.getByRole('button',{name:'视图切换'}).tap();
    await sheet.getByRole('button',{name:'即时编辑',exact:true}).tap();
    await page.locator('#live-editor .live-embed-slot').getByText('检测到循环内嵌',{exact:true}).waitFor();
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'视图切换'}).tap();
    await sheet.getByRole('button',{name:'阅读',exact:true}).tap();
    await page.locator('#reading .note-embed-content').getByText('检测到循环内嵌',{exact:true}).waitFor();
    const cdp=await context.newCDPSession(page);
    const link=page.locator('#reading').getByRole('link',{name:'动态规划',exact:true});
    await link.scrollIntoViewIfNeeded();
    const rect=await link.boundingBox();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]});
    await page.locator('[data-kind=link-preview][open]').getByText('这一段应内嵌。',{exact:true}).waitFor();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await sheet.getByRole('button',{name:'关闭操作表单'}).tap();
    const readHead=before=>{
      const store=calciteTest.filesystem.store, dir='DATA:CalciteVaults/PKM/.git/';
      const head=store.get(dir+'HEAD');
      const oid=head&&store.get(dir+atob(head.data).trim().replace('ref: ',''))?.data;
      return oid&&oid!==before?oid:null;
    };
    const previousHead=await (await page.waitForFunction(readHead)).jsonValue();
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'移动到文件夹…'}).tap();
    const move=page.locator('dialog.feature-dialog[open]').last();
    await move.getByLabel('目标文件夹').selectOption({label:'Archive'});
    await move.getByRole('button',{name:'移动',exact:true}).tap();
    await page.locator('#toast').getByText(/已自动更新/).waitFor();
    const read=key=>page.evaluate(file=>{
      const entry=calciteTest.filesystem.store.get('DATA:CalciteVaults/PKM/'+file);
      return entry&&new TextDecoder().decode(Uint8Array.from(atob(entry.data),character=>character.charCodeAt(0)));
    },key);
    assert.match(await read('B.md'),/!\[\[A\]\]/);
    assert.match(await read('Archive/A.md'),/\[相对链接\]\(\.\.\/dp\//);
    assert.match(await read('dp/模板.md'),/\[\[\.\.\/Archive\/A\]\]/);
    await page.waitForFunction(readHead,previousHead);
    const gitFiles=await page.evaluate(()=>Object.fromEntries([...calciteTest.filesystem.store]
      .filter(([key,entry])=>key.startsWith('DATA:CalciteVaults/PKM/.git/')&&entry.type==='file')
      .map(([key,entry])=>[key.slice('DATA:CalciteVaults/'.length),entry.data])));
    const {createCapacitorGitFs}=await import('../src/platform/capacitor-git-fs.js');
    const mirror=createCapacitorGitFs(memoryFilesystem(gitFiles));
    const oid=await git.resolveRef({fs:mirror,dir:'/PKM',ref:'HEAD'});
    const {blob}=await git.readBlob({fs:mirror,dir:'/PKM',oid,filepath:'dp/模板.md'});
    assert.match(Buffer.from(blob).toString('utf8'),/\[\[\.\.\/Archive\/A\]\]/);
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'知识库体检',exact:true}).tap();
    await page.locator('[data-health=placeholders] strong').getByText(/Drafts\/待建/).waitFor();
    await page.locator('[data-health=broken]').getByText(/歧义链接/).waitFor();
    assert.deepEqual(errors,[]);
    console.log('Android native bridge mock passed: reading embeds, touch preview, move refactor, and health view.');
  }finally{await browser?.close();server.close();}
}

(async()=>{
  const scratchRoot=path.join(project,'.test-data');
  await fs.mkdir(scratchRoot,{recursive:true});
  const scratch=await fs.mkdtemp(path.join(scratchRoot,'pkm-foam-'));
  const vault=path.join(scratch,'vault');
  await seed(vault);
  await core(vault);
  if(!process.argv.includes('--core-only')&&!process.argv.includes('--android-only'))await desktop(scratch,vault);
  if(!process.argv.includes('--core-only')&&!process.argv.includes('--desktop-only'))await android();
})().catch(error=>{console.error(error);process.exitCode=1;});
