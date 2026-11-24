const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {_electron:electron,chromium}=require('playwright');
const {memoryFilesystem,registerNativeMock,serveDist,chromiumOptions,assertLanguageCard}=require('./mobile-smoke.cjs');

const root=path.resolve(__dirname,'..');
const language=page=>page.locator('dialog[open] select[name=language]');
const note='# A note\n\n[[Pending Note]]\n\n用户内容。\n';

async function contracts(){
  const {resolveSystemLocale,setLocale,setStrictMessages,t,translate}=await import('../shared/i18n/index.mjs');
  const {default:zh}=await import('../shared/i18n/zh-CN.mjs');
  const {default:en}=await import('../shared/i18n/en-US.mjs');
  assert.deepEqual(Object.keys(zh).sort(),Object.keys(en).sort());
  const parameters=value=>Array.from(value.matchAll(/\{\{(\w+)\}\}/g),match=>match[1]).sort();
  for(const key of Object.keys(zh))assert.deepEqual(parameters(zh[key]),parameters(en[key]),key);
  for(const [raw,expected] of [['en-US','en-US'],['ja-JP','en-US'],['zh-CN','zh-CN'],['zh-TW','zh-CN'],['zh-Hans','zh-CN'],['zh-Hant','zh-CN']])
    assert.equal(resolveSystemLocale(raw),expected,raw);
  setStrictMessages(true);
  assert.throws(()=>t('missing.smokeKey'),/Missing message/);
  setLocale('en-US');
  assert.equal(t('sync.archiveCount',{count:3}),'Archived 3 legacy conflict copies.');
  assert.equal(translate('zh-CN','sync.archiveCount',{count:3}),'已归档 3 个历史冲突副本。');
  const {createSyncHistory}=await import('../shared/core/sync-history.mjs');
  const snapshotId='sync-1760000000000-remote-'+'a'.repeat(40)+'.snapshot';
  const snapshotContents=Buffer.from('# 原始版本\n');
  const history=createSyncHistory({root:'/vault',safe:async file=>file,join:(...parts)=>parts.join('/'),
    fs:{readdir:async()=>[snapshotId],readFile:async()=>snapshotContents},
    write:async()=>assert.fail('Rendering history must not write to disk')});
  const [english]=await history.list('/vault/Reference.md');
  assert.match(english.label,/Automatic sync backup.*newer remote edit/);
  setLocale('zh-CN');
  const [chinese]=await history.list('/vault/Reference.md');
  assert.match(chinese.label,/同步自动备份.*被远端新版覆盖/);
  assert.equal(chinese.id,english.id);
  assert.deepEqual(await history.read('/vault/Reference.md',snapshotId),snapshotContents);
  setStrictMessages(false);
  assert.equal(t('missing.smokeKey'),'This message is unavailable.');
  setLocale('zh-CN');
  console.log('Catalogs: '+Object.keys(zh).length+' matching keys, matching parameters, system locale and fallback passed.');
}

async function uiScan(page,selector){
  const strings=await page.locator(selector).evaluate(element=>{
    const omit='[lang="zh-CN"],.prose,.cm-editor,.milkdown,[data-file],[data-folder],#tabs,#document-name';
    const painted=node=>!node.closest(omit)&&node.getClientRects().length&&getComputedStyle(node).visibility==='visible';
    const messages=[];
    const walk=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    while(walk.nextNode()){
      const node=walk.currentNode;
      if(node.parentElement&&painted(node.parentElement))messages.push(node.textContent.trim());
    }
    for(const node of element.querySelectorAll('[title],[aria-label],[placeholder],[alt]')){
      if(!painted(node))continue;
      for(const attribute of ['title','aria-label','placeholder','alt']){
        const value=node.getAttribute(attribute);
        if(value)messages.push(value);
      }
    }
    return messages;
  });
  const leaked=strings.filter(value=>/\p{Script=Han}|^(?:main|language|syncSettings|mobileShell|mobileVaultManager|activity)\.[\w.]+$/u.test(value));
  assert.deepEqual(leaked,[],selector);
}

async function noClipping(items){
  const failures=await items.evaluateAll(nodes=>nodes.flatMap(node=>{
    const bounds=node.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return [];
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
    const text=[];
    while(walker.nextNode())if(walker.currentNode.textContent.trim()){
      const range=document.createRange();
      range.selectNodeContents(walker.currentNode);
      text.push(...range.getClientRects());
    }
    const visible=text.filter(rect=>rect.height&&rect.width);
    return visible.some(rect=>rect.left<bounds.left-1||rect.right>bounds.right+1||rect.bottom>bounds.bottom+1) ||
      new Set(visible.map(rect=>Math.round(rect.top))).size>1 ? [node.textContent.trim()] : [];
  }));
  assert.deepEqual(failures,[]);
}

async function desktop(){
  const scratch=path.join(root,'.test-data');
  await fs.mkdir(scratch,{recursive:true});
  const temp=await fs.mkdtemp(path.join(scratch,'i18n-'));
  const vault=path.join(temp,'vault'), profile=path.join(temp,'profile'),file=path.join(vault,'Reference.md');
  await fs.mkdir(vault);
  await fs.mkdir(profile);
  await fs.writeFile(file,note);
  const existingName=path.join(vault,'已有笔记.md');
  await fs.writeFile(existingName,'# 原稿\n');
  const auditFile=path.join(vault,'Audit.md'), auditLink=path.join(vault,'Audit link.md');
  await fs.writeFile(auditFile,'# Audit\r\n');
  await fs.writeFile(auditLink,'[[Audit]]\r\n');
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env={...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[root,file],env});
  try{
    const page=await app.firstWindow();
    page.setDefaultTimeout(10000);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,600));
    await page.locator('#app:not([inert])').waitFor();
    await page.locator('#settings-toggle').click();
    await page.locator('#settings-tab-appearance').click();
    await language(page).selectOption('en-US');
    await page.locator('html[lang=en-US]').waitFor();
    await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
    await language(page).waitFor();
    await uiScan(page,'.settings-center[open]');
    assert.deepEqual(await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.slice(0,3).map(item=>item.label)),['Files','Edit','View']);
    await page.locator('#settings-tab-sync').click();
    await page.getByText('Recent Sync Activity',{exact:true}).click();
    await app.evaluate(({BrowserWindow})=>{
      const detail={key:'sync.concurrentArchived',params:{path:'Reference.md'}};
      BrowserWindow.getAllWindows()[0].webContents.send('sync:state',{
        settings:{enabled:true,mode:'lan'},status:'synced',pendingCount:0,conflicts:[],
        logs:[{time:Date.now(),mode:'lan',status:'synced',detail,backup:'Reference.md',message:'旧提示'}]
      });
    });
    await page.locator('.settings-center[open]').getByText(/had concurrent edits/).waitFor();
    await uiScan(page,'.settings-center[open]');
    await page.getByRole('button',{name:'Close Settings',exact:true}).click();
    await page.waitForFunction(async()=> (await window.desktop['workspace-graph']()).edges
      .some(edge=>edge.from.endsWith('Audit link.md')&&edge.to.endsWith('Audit.md')));
    const renamed=await page.evaluate(file=>window.desktop['workspace-edit']({type:'rename',path:file,name:'Audit next.md'}),auditFile);
    await fs.writeFile(auditLink,'changed after refactor\r\n');
    await page.locator('.side-tools [data-action=activity]').click();
    const activity=page.locator('.activity-view[open]');
    const record=activity.locator('[data-id="'+renamed.activity.id+'"]');
    await record.locator('summary').click();
    await uiScan(page,'.activity-view[open]');
    await record.getByRole('button',{name:'Undo',exact:true}).click();
    await page.getByRole('heading',{name:'Review changes before undoing'}).waitFor();
    await uiScan(page,'dialog[open]:has-text("Review changes before undoing")');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await activity.locator('[data-section=trash]').click();
    await uiScan(page,'.activity-view[open]');
    await activity.getByRole('button',{name:'Close Activity Log'}).click();
    await page.locator('[data-pane=health]').click();
    const placeholders=page.locator('[data-health=placeholders] summary');
    await placeholders.waitFor();
    assert.match(await placeholders.textContent(),/Placeholders/);
    await uiScan(page,'#app');
    await noClipping(page.locator('footer [data-mode],#sync-status'));
    assert.equal(await fs.readFile(file,'utf8'),note);
    assert.equal(await fs.readFile(existingName,'utf8'),'# 原稿\n');
    await page.locator('#settings-toggle').click();
    await page.locator('#settings-tab-appearance').click();
    await language(page).selectOption('auto');
    await page.locator('html[lang=zh-CN]').waitFor();
    assert.equal(await app.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].label),'文件');
    assert.equal(JSON.parse(await fs.readFile(path.join(profile,'workspace.json'),'utf8')).language,'auto');
  }finally{await app.close();}
  console.log('Desktop: live DOM and menu switch, settings, logs and vault check at 900px passed.');
}

async function mobile(){
  const {server,url}=await serveDist();
  let browser;
  try{
    browser=await chromium.launch(chromiumOptions());
    const page=await browser.newPage({viewport:{width:360,height:760},locale:'ja-JP',isMobile:true,hasTouch:true});
    page.setDefaultTimeout(10000);
    const seed={'CalciteVaults/Study/Reference.md':Buffer.from(note).toString('base64')};
    const options={useSystemLanguage:true,prefs:{vault:'/CalciteVaults/Study'}};
    await page.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+','+
      JSON.stringify(seed)+','+JSON.stringify(options)+');'});
    await page.goto(url+'?languageTest=1');
    await page.locator('#app:not([inert])').waitFor();
    await page.locator('html[lang=en-US]').waitFor();
    assert.equal(await page.evaluate(()=>window.calciteTest.fixture.locale),'en-US');
    await page.locator('[data-mobile-drawer=left]').tap();
    await noClipping(page.locator('.mobile-side-tabs button,.mobile-file-actions .mobile-primary'));
    await page.locator('.mobile-side-top [data-action=settings]').tap();
    await page.locator('#settings-tab-writing').getByText('Editor',{exact:true}).waitFor();
    await uiScan(page,'.settings-center[open]');
    await noClipping(page.locator('.settings-center [role=tab]'));
    await assertLanguageCard(page.locator('.settings-center[open]'));
    await language(page).selectOption('zh-CN');
    await page.locator('html[lang=zh-CN]').waitFor();
    await page.locator('#settings-tab-writing').getByText('写作',{exact:true}).waitFor();
    await language(page).selectOption('auto');
    await page.locator('html[lang=en-US]').waitFor();
    await page.getByRole('button',{name:'Close Settings',exact:true}).tap();
    const vaultTrigger=page.locator('.mobile-vault-trigger');
    if(!await vaultTrigger.isVisible())await page.locator('[data-mobile-drawer=left]').tap();
    await vaultTrigger.tap();
    const manager=page.locator('.mobile-sheet[open][data-kind=vaults]');
    await manager.getByText('Manage Vaults',{exact:true}).waitFor();
    await uiScan(page,'.mobile-sheet[open]');
    await manager.locator('[data-sheet-close]').tap();
    await page.locator('[data-mobile-more]').tap();
    const tiles=page.locator('.mobile-sheet[open] [data-layout=tiles] button');
    assert.deepEqual(await tiles.locator('span').allTextContents(),['Outline','Bookmark','Export','Graph']);
    await noClipping(tiles);
    await uiScan(page,'.mobile-sheet[open]');
    await page.locator('.mobile-sheet[open]').getByRole('button',{name:'Activity Log',exact:true}).tap();
    const activity=page.locator('.activity-view[open]');
    await activity.waitFor();
    await uiScan(page,'.activity-view[open]');
    await noClipping(activity.locator('nav button'));
    await activity.getByRole('button',{name:'Local Trash',exact:true}).tap();
    await uiScan(page,'.activity-view[open]');
    await activity.getByRole('button',{name:'Close Activity Log'}).tap();
    await page.locator('[data-mobile-sync]').tap();
    await page.locator('.mobile-sheet[open][data-kind=sync]').waitFor();
    await uiScan(page,'.mobile-sheet[open]');
    await page.locator('.mobile-sheet[open] [data-sheet-close]').tap();
    await page.evaluate(()=>window.calciteTest.fixture.deliverExternalFile({name:'Outside.md',text:'# Outside'}));
    await page.locator('.external-preview[open]').getByText('Import into Current Vault',{exact:true}).waitFor();
    await uiScan(page,'.external-preview[open]');
    await noClipping(page.locator('.external-preview-actions button'));
    assert.equal(await page.evaluate(()=>atob(window.calciteTest.filesystem.store.get('DATA:CalciteVaults/Study/Reference.md').data)),
      Buffer.from(note).toString('latin1'));
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
  console.log('Android bridge: auto language, hot switch, vault manager, external preview and tiles at 360px passed.');
}

(async()=>{await contracts();await desktop();await mobile();})().catch(error=>{console.error(error);process.exitCode=1;});
