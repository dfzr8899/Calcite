const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const project=path.resolve(__dirname,'..');

(async()=>{
  const scratch=path.join(project,'.test-data');
  await fs.mkdir(scratch,{recursive:true});
  const profile=await fs.mkdtemp(path.join(scratch,'interaction-'));
  const vault=path.join(profile,'vault'), folder=path.join(vault,'分组');
  await fs.mkdir(folder,{recursive:true});
  const note=path.join(vault,'层级.md');
  await fs.writeFile(note,[
    '# 样稿','含选区文字与 [[分栏目标#目标章节]]。','## 第一节','父级正文',
    '### 第一子节','子级正文','#### 深层目标','深层正文','### 第二子节','第二子级正文',
    '## 第二节','同级正文'
  ].join('\n\n')+'\n');
  await fs.writeFile(path.join(vault,'分栏目标.md'),'# 分栏目标\n\n## 目标章节\n\n对照阅读。\n');
  await fs.writeFile(path.join(folder,'示例.canvas'),'{"nodes":[],"edges":[]}\n');
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env={...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.argv[2];
  const app=await electron.launch({env,...(executablePath?{executablePath}:{args:[project,note]})});
  let page;
  const errors=[];
  try{
    page=await app.firstWindow();
    page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#app:not([inert])').waitFor();
    await app.evaluate(({BrowserWindow,clipboard})=>{
      BrowserWindow.getAllWindows()[0].setSize(900,600);
      clipboard.writeText=text=>{globalThis.lastCalciteCopy=text;};
    });
    const treeFile=name=>page.locator('#side-content [data-file]').filter({hasText:name});
    await treeFile('层级.md').click();
    const more=page.getByRole('button',{name:'更多文档操作'});
    const main=page.locator('.floating-menu-main:visible');
    const submenu=page.locator('#floating-submenu');
    const contextItem=name=>main.getByRole('menuitem',{name,exact:true});
    async function assertLayer(id) {
      await main.waitFor();
      assert.equal(await main.count(),1);
      assert.equal(await main.getAttribute('id'),id);
      const visible=await page.locator('.floating-menu:visible').evaluateAll(nodes=>nodes.map(node=>{
        const {left,top,right,bottom}=node.getBoundingClientRect();
        return {left,top,right,bottom,width:innerWidth,height:innerHeight,parent:node.parentElement.parentElement===document.body};
      }));
      assert(visible.length<=2);
      for(const {left,top,right,bottom,width,height,parent} of visible)
        assert(parent&&left>=7&&top>=7&&right<=width-7&&bottom<=height-7,JSON.stringify(visible));
    }
    await more.click();
    await assertLayer('more-menu');
    const documentCommands=main.locator('button[role=menuitem]');
    assert.equal(await documentCommands.count(),12,await main.evaluate(node=>node.outerHTML));
    assert.deepEqual(await main.evaluate(node=>[node.scrollHeight-node.clientHeight,node.scrollWidth-node.clientWidth]),[0,0]);
    assert.equal(await main.getByRole('menuitem',{name:/附件管家|同步与配对|自动保存|即时编辑/}).count(),0);
    for(const id of ['format','export','path','focus']) {
      await main.locator('[data-submenu="'+id+'"]').hover();
      await submenu.waitFor();
      await assertLayer('more-menu');
      assert.equal(await page.locator('.floating-menu-child:visible').count(),1);
      assert.equal(await main.locator('[aria-expanded=true]').count(),1);
    }
    await contextItem('查看版本历史').hover();
    assert(await submenu.isHidden(),'moving to an ordinary command closes the submenu immediately');
    await main.locator('[data-submenu=export]').hover();
    await submenu.hover();
    await page.waitForTimeout(160);
    assert(await submenu.isVisible(),'the submenu remains open while hovered');
    await page.mouse.move(12,80);
    await submenu.waitFor({state:'hidden'});
    await main.locator('[data-submenu=path]').hover();
    await main.dispatchEvent('scroll');
    assert(await submenu.isHidden(),'scroll closes the submenu immediately');
    await main.locator('[data-submenu=focus]').focus();
    await page.keyboard.press('ArrowRight');
    await submenu.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await main.count(),0);
    assert(await submenu.isHidden());

    await page.locator('#export-quick').click();
    await page.waitForFunction(()=>document.querySelector('.export-center iframe')?.srcdoc.includes('preview-sheet'));
    await page.keyboard.press('Escape');
    await page.locator('#split-quick').click();
    await page.locator('#split-pane article h1').getByText('样稿').waitFor();
    await page.locator('[data-split-close]').click();
    const star=page.locator('#document-star');
    await star.click();
    assert.equal(await star.getAttribute('aria-pressed'),'true');
    await star.click();
    assert.equal(await star.getAttribute('aria-pressed'),'false');
    const autoSave=page.locator('#auto-save');
    for(const [value,word] of [['false','关'],['true','开']]) {
      await autoSave.click();
      assert.equal(await autoSave.getAttribute('aria-pressed'),value);
      assert.equal(await autoSave.innerText(),'自动保存：'+word);
    }
    await page.locator('#settings-toggle').click();
    const settings=page.locator('.settings-center[open]');
    for(const name of ['写作与公式','快捷键','同步与配对','附件管家','外观']) {
      await settings.getByRole('tab',{name,exact:true}).click();
      await settings.getByRole('tabpanel',{name,exact:true}).waitFor();
    }
    await settings.getByRole('tab',{name:'附件管家',exact:true}).click();
    await settings.getByText('没有发现孤立图片。').waitFor();
    await settings.getByRole('button',{name:'关闭设置中心'}).click();
    await page.locator('#sync-status').click();
    const syncPopover=page.locator('#sync-popover:popover-open');
    await syncPopover.getByRole('button',{name:'立即同步'}).waitFor();
    assert(await syncPopover.evaluate(node=>node.parentElement===document.body&&
      node.getBoundingClientRect().bottom<document.querySelector('#sync-status').getBoundingClientRect().top));
    await syncPopover.getByRole('button',{name:'同步设置'}).click();
    const sync=settings.getByRole('tabpanel',{name:'同步与配对'});
    await sync.waitFor();
    const syncForm=sync.locator('.sync-fields:not([inert])');
    await syncForm.waitFor();
    await sync.getByText(/适合手机与电脑连同一 Wi-Fi/).waitFor();
    await sync.locator('[name=mode]').selectOption('remote');
    await sync.getByText(/绑定自己的 GitHub \/ Gitee/).waitFor();
    await sync.locator('[name=mode]').selectOption('lan');
    assert.equal(await sync.locator('[name=enabled]').isChecked(),false);
    assert.equal(await sync.locator('[name=listen]').isChecked(),false);
    await sync.getByRole('button',{name:'显示配对二维码'}).click();
    await sync.getByAltText('配对二维码').waitFor();
    assert.match(await sync.getByAltText('配对二维码').getAttribute('src'),/^data:image\/png/);
    assert(await sync.locator('[name=enabled]').isChecked());
    assert(await sync.locator('[name=listen]').isChecked());
    await sync.locator('[name=pairing]').fill('错误配对串');
    await sync.getByRole('button',{name:'保存同步设置'}).click();
    await sync.locator('[role=status]').filter({hasText:'配对串无效。'}).waitFor();
    assert.doesNotMatch(await settings.innerText(),/Error invoking remote method/);
    assert.equal(await page.locator('#toast').innerText(),'配对串无效。');
    await settings.getByRole('button',{name:'关闭设置中心'}).click();

    await more.click();
    await treeFile('分栏目标.md').click({button:'right'});
    await assertLayer('file-menu');
    await contextItem('复制路径').hover();
    await submenu.getByRole('menuitem',{name:'复制双链'}).click();
    assert.equal(await app.evaluate(()=>globalThis.lastCalciteCopy),'[[分栏目标]]');
    await treeFile('分栏目标.md').click({button:'right'});
    await contextItem('在右侧分栏打开').click();
    await page.locator('#split-pane article h1').getByText('分栏目标').waitFor();
    assert.equal(await page.locator('#document-name').innerText(),'层级.md');
    await page.locator('[data-split-close]').click();
    await page.locator('.folder-row').filter({hasText:'分组'}).click({button:'right'});
    await contextItem('展开子文件夹').click();
    await treeFile('示例.canvas').click({button:'right'});
    await assertLayer('file-menu');
    await contextItem('在右侧分栏打开').click();
    assert.match(await page.locator('#split-pane textarea').inputValue(),/"nodes":\[\]/);
    await page.locator('[data-split-close]').click();
    await treeFile('示例.canvas').click({button:'right'});
    await contextItem('重命名').click();
    const rename=page.locator('dialog[open]');
    await rename.locator('[name=name]').fill('更新.canvas');
    await rename.getByRole('button',{name:'确定'}).click();
    await treeFile('更新.canvas').waitFor();
    await page.locator('.workspace:not([inert])').waitFor();
    await fs.stat(path.join(folder,'更新.canvas'));

    const paragraph=page.locator('#live-editor .ProseMirror > p').filter({hasText:'含选区文字'});
    const position=await paragraph.evaluate(node=>{
      node.closest('.ProseMirror').focus({preventScroll:true});
      node.scrollIntoView({block:'center'});
      const selection=getSelection(),range=document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();selection.addRange(range);
      const rect=range.getClientRects()[0];
      return {x:rect.left+10,y:rect.top+rect.height/2};
    });
    await page.mouse.click(position.x,position.y,{button:'right'});
    await assertLayer('editor-menu');
    assert(await contextItem('粘贴为纯文本').isEnabled());
    assert(await contextItem('复制为富文本').isEnabled());
    await contextItem('格式').hover();
    await submenu.getByRole('menuitem',{name:'粗体'}).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('footer [data-mode=read]').click();
    const read=page.locator('#reading .reading-content');
    const readingText=read.locator('p').filter({hasText:'含选区文字'});
    await readingText.waitFor();
    await readingText.evaluate(node=>{
      const range=document.createRange();range.selectNodeContents(node);
      getSelection().removeAllRanges();getSelection().addRange(range);
    });
    await readingText.click({button:'right'});
    await assertLayer('editor-menu');
    assert(await contextItem('导出选中块为长图').isEnabled());
    await contextItem('复制').click();
    assert.match(await app.evaluate(()=>globalThis.lastCalciteCopy),/含选区文字/);
    await read.locator('.wiki-link').click({button:'right'});
    await contextItem('在右侧分栏打开').click();
    await page.locator('#split-pane article h2').getByText('目标章节').waitFor();
    await page.locator('[data-split-close]').click();

    const outline=page.locator('#outline');
    const row=name=>outline.getByRole('button',{name,exact:true});
    const chapter=name=>read.getByRole('heading',{name,exact:true});
    await row('第一子节').click({button:'right'});
    await assertLayer('outline-menu');
    await contextItem('复制标题双链').click();
    assert.equal(await app.evaluate(()=>globalThis.lastCalciteCopy),'[[层级#第一子节]]');
    await row('第一子节').click({button:'right'});
    await contextItem('折叠此章节').click();
    await chapter('深层目标').waitFor({state:'hidden'});
    await outline.getByRole('button',{name:'折叠或展开 第一节',exact:true}).click();
    for(const title of ['第一子节','第二子节','深层目标']) {
      await row(title).waitFor({state:'hidden'});
      await chapter(title).waitFor({state:'hidden'});
    }
    await read.getByText('父级正文').waitFor({state:'hidden'});
    await chapter('第二节').waitFor();
    const filter=page.getByRole('searchbox',{name:'筛选标题'});
    await filter.fill('深层目标');
    await row('深层目标').click();
    await chapter('深层目标').waitFor();
    await filter.clear();
    await chapter('深层目标').waitFor({state:'hidden'});
    await row('深层目标').waitFor({state:'hidden'});
    await outline.getByRole('button',{name:'折叠或展开 第一节',exact:true}).click();
    await row('第二子节').waitFor();
    await chapter('第二子节').waitFor();
    assert.equal(await outline.getByRole('button',{name:'折叠或展开 第一子节',exact:true}).getAttribute('aria-expanded'),'false');
    assert(await row('深层目标').isHidden());
    await read.getByText('同级正文').click({button:'right'});
    await contextItem('切换到源码模式').click();
    const source=page.locator('#source-editor .cm-content');
    await source.waitFor();
    await source.getByText('深层目标',{exact:false}).waitFor({state:'hidden'});
    await row('第一子节').click({button:'right'});
    await contextItem('展开此章节').click();
    await source.getByText('深层目标',{exact:false}).waitFor();
    await source.focus();
    for(const key of ['Control+End','ArrowUp','End','Shift+Home'])await page.keyboard.press(key);
    const sourceLine=source.locator('.cm-line').filter({hasText:'同级正文'});
    const sourcePoint=await sourceLine.evaluate(node=>{
      const range=document.createRange();range.selectNodeContents(node);
      const rect=range.getClientRects()[0];
      return {x:rect.left+3,y:rect.top+rect.height/2};
    });
    await page.mouse.click(sourcePoint.x,sourcePoint.y,{button:'right'});
    await contextItem('剪切').click();
    await sourceLine.waitFor({state:'hidden'});
    assert.equal(await app.evaluate(()=>globalThis.lastCalciteCopy),'同级正文');
    await page.locator('footer [data-mode=live]').click();
    await paragraph.click({button:'right'});
    await contextItem('插入').hover();
    await submenu.getByRole('menuitem',{name:'手动分页符'}).click();
    await page.locator('#live-editor .note-pagebreak').waitFor();
    await page.locator('footer [data-mode=read]').click();
    await read.locator('.note-pagebreak').waitFor();

    const tab=page.locator('.tab').filter({hasText:'分栏目标.md'});
    await tab.click({button:'right'});
    await assertLayer('tab-menu');
    await contextItem('关闭当前标签').click();
    await tab.waitFor({state:'detached'});
    await page.locator('.tab.active').click({button:'right'});
    await assertLayer('tab-menu');
    await more.click();
    await assertLayer('more-menu');
    await page.locator('#workspace-name').click();
    assert.equal(await main.count(),0);
    assert.deepEqual(errors,[]);
    console.log('Interaction smoke passed: bounded exclusive menus, settings and one-click LAN pairing, nested outline folds, and four context menu surfaces.');
  }catch(error){
    if(page)await page.screenshot({path:path.join(profile,'failure.png'),timeout:3000}).catch(()=>{});
    console.error('Renderer errors:',errors);
    throw error;
  }finally{await app.evaluate(({app})=>app.exit()).catch(()=>{});}
})().catch(error=>{console.error(error);process.exitCode=1;});
