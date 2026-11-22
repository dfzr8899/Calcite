const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');

async function run() {
  const testDir = path.join(root,'.test-data');
  await fs.mkdir(testDir,{recursive:true});
  const profile = await fs.mkdtemp(path.join(testDir,'layout-'));
  const vault = path.join(profile,'复习笔记');
  const chapter = path.join(vault,'2026 年 6 月');
  await fs.mkdir(chapter,{recursive:true});
  const second = '# 第二套\n\n## 仔细阅读\n\n本文包含 **中英混排**、*斜体*与 Markdown。\n\n参阅 [[复习计划|复习]]，示例为 `[[字面量]]`。\n\n| 原文 | 译文 |\n| --- | --- |\n| Read for meaning | 先读懂意思 |\n\n'+
    Array.from({length:32},(_,i)=>`### 第 ${i+1} 段\n\n从主题句出发，再定位上下文。`).join('\n\n');
  await fs.writeFile(path.join(chapter,'第二套.md'),second);
  await fs.writeFile(path.join(chapter,'第三套.md'),'# 第三套\n\n## 段落匹配\n\n独立的复习记录。');
  await fs.writeFile(path.join(vault,'复习计划.md'),'# 复习计划\n\n  回顾 [[第二套|试题复盘]]，然后参考 [[外部笔记]]。');
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env = {...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};
  delete env.ELECTRON_RUN_AS_NODE;

  const executablePath = process.argv[2];
  const app = await electron.launch({env,...(executablePath?{executablePath}:{args:[root]})});
  try {
    const page = await app.firstWindow();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    const tab = name=>page.locator('.titlebar .tab').filter({hasText:name});
    const file = name=>page.locator('#side-content .file-row').filter({hasText:name});
    const preview = process.env.CALCITE_LAYOUT_PREVIEW;
    await page.locator('#app:not([inert])').waitFor();
    await page.getByRole('button',{name:'主题与材质'}).click();
    await page.locator('#appearance-panel').getByRole('button',{name:'暗色',exact:true}).click();
    await page.keyboard.press('Escape');
    const fileTree = page.locator('#side-content');
    const toolbar=page.getByRole('toolbar',{name:'文件操作'});
    assert.equal(await toolbar.getByRole('button').count(),4);
    assert.equal(await page.locator('#pane-title').textContent(),'');
    assert.equal(await toolbar.locator('#file-sort').evaluate(button=>getComputedStyle(button).color),'rgb(148, 163, 184)');
    assert((await fileTree.boundingBox()).y >= (await toolbar.boundingBox()).y+(await toolbar.boundingBox()).height);
    const firstFolder = fileTree.locator('[data-folder]').first();
    await firstFolder.waitFor();
    assert((await firstFolder.boundingBox()).y >= (await fileTree.boundingBox()).y+6);
    await page.locator('[data-folder]').filter({hasText:'2026 年 6 月'}).click();
    await file('第二套.md').click();
    await page.locator('#outline').getByRole('button',{name:'仔细阅读',exact:true}).waitFor();
    assert.equal(await page.locator('#document-name').textContent(),'第二套.md');
    assert.match(await page.locator('#breadcrumb-root').textContent(),/复习笔记 \/ 2026 年 6 月/);
    assert.equal(await file('第二套.md').getAttribute('aria-current'),'true');
    await page.locator('.breadcrumb').getByRole('button',{name:'2026 年 6 月'}).click();
    assert.equal(await page.locator('[data-folder]').evaluate(node=>node===document.activeElement),true);
    await page.locator('#document-name').click();
    assert.equal(await file('第二套.md').evaluate(node=>node===document.activeElement),true);
    assert.equal(await page.locator('#live-editor th').first().evaluate(node=>getComputedStyle(node).paddingBlockStart),'10px');

    // The second click changes selection before the first file read resolves.
    await page.evaluate(()=>{
      [...document.querySelectorAll('.file-row')].find(row=>row.textContent.includes('第三套.md')).click();
      document.querySelector('.tab.active .tab-label').click();
    });
    await tab('第三套.md').waitFor();
    assert.match(await page.locator('.tab.active').textContent(),/第二套\.md/);
    assert.equal(await page.locator('#document-name').textContent(),'第二套.md');
    assert.equal(await file('第二套.md').getAttribute('aria-current'),'true');
    await page.waitForFunction(()=>document.querySelector('#backlink-count').textContent==='1');
    await page.mouse.move(7,70);
    const close = tab('第三套.md').locator('[data-close]');
    await close.evaluate(node=>node.blur());
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.tab:not(.active):last-child [data-close]')).opacity==='0');
    await tab('第三套.md').hover();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.tab:not(.active):last-child [data-close]')).opacity==='1');
    await page.mouse.move(7,70);
    if (preview) await page.screenshot({path:path.join(preview,'calcite-live.png')});

    await page.getByRole('tab',{name:'大纲'}).press('ArrowRight');
    await page.locator('#backlinks-view').waitFor();
    await page.locator('#backlinks').getByText('复习计划.md',{exact:true}).click();
    assert.deepEqual(await page.locator('#backlinks mark').allTextContents(),['第二套']);
    if (preview) await page.screenshot({path:path.join(preview,'calcite-backlinks.png')});
    assert(await page.locator('#outline-view').isHidden());
    await tab('第三套.md').locator('.tab-label').click();
    assert.equal(await page.locator('#document-name').textContent(),'第三套.md');
    assert.equal(await file('第三套.md').getAttribute('aria-current'),'true');
    assert.equal(await page.locator('#backlink-count').textContent(),'0');
    await page.getByRole('tab',{name:'大纲'}).click();
    await page.locator('#outline').getByRole('button',{name:'段落匹配',exact:true}).waitFor();
    assert.equal(await page.locator('#outline').getByRole('button',{name:'仔细阅读',exact:true}).count(),0);

    await tab('第二套.md').locator('.tab-label').click();
    await page.locator('footer [data-mode="source"]').click();
    const markers = page.locator('#source-editor .cm-markdown-marker');
    await markers.first().waitFor();
    const tokens = await markers.allTextContents();
    for (const marker of ['#','**','*','`','|','[[',']]']) assert(tokens.includes(marker),marker);
    assert.equal(tokens.filter(marker=>marker==='[[').length,1);
    assert.match(await page.locator('#source-editor .cm-scroller').evaluate(node=>getComputedStyle(node).fontFamily),/Microsoft YaHei/);
    assert(await page.locator('#source-editor .cm-scroller').evaluate(node=>{
      const canvas = document.createElement('canvas').getContext('2d');
      const family = getComputedStyle(node).fontFamily;
      canvas.font = '14px '+family;
      return Math.abs(canvas.measureText('WWWW').width-canvas.measureText('iiii').width)<0.1;
    }),'Latin glyphs in source mode must remain monospaced');
    if (preview) await page.screenshot({path:path.join(preview,'calcite-source.png')});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const breadcrumbTop = (await page.locator('.breadcrumb').boundingBox()).y;
    await page.locator('#source-editor .cm-scroller').evaluate(node=>{node.scrollTop=200;});
    await page.waitForFunction(()=>document.querySelector('#source-editor .cm-scroller').scrollTop>100);
    assert.equal((await page.locator('.breadcrumb').boundingBox()).y,breadcrumbTop);

    await page.locator('footer [data-mode="read"]').click();
    await page.locator('#reading h1').getByText('第二套',{exact:true}).waitFor();
    const reading = page.locator('#reading');
    assert.equal(await reading.evaluate(node=>getComputedStyle(node,'::-webkit-scrollbar').width),'4px');
    assert(await page.locator('#reading .reading-content').evaluate(node=>parseFloat(getComputedStyle(node).paddingBottom)>=120));
    await page.mouse.move(8,69);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#reading')).getPropertyValue('--scroll-thumb')==='rgba(0, 0, 0, 0)');
    await reading.hover();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#reading')).getPropertyValue('--scroll-thumb')==='rgba(233, 239, 255, 0.21)');
    await page.mouse.move(8,69);
    assert(await reading.evaluate(node=>new Promise(resolve=>{
      const timeout = setTimeout(()=>resolve(false),2000);
      node.addEventListener('scroll',()=>{
        clearTimeout(timeout);
        resolve(node.hasAttribute('data-scrolling'));
      },{once:true});
      node.scrollBy(0,80);
    })),'scrolling should reveal the thumb with the pointer outside the editor');
    const jump = page.locator('#outline').getByRole('button',{name:'第 8 段',exact:true});
    await jump.click();
    await page.waitForFunction(()=>document.querySelector('#outline [aria-current="location"]')?.textContent==='第 8 段');
    await page.waitForFunction(()=>!document.querySelector('#reading').hasAttribute('data-scrolling'));
    const heading = page.locator('#reading h3').getByText('第 8 段',{exact:true});
    const edge = await page.locator('.breadcrumb').boundingBox();
    assert((await heading.boundingBox()).y>=edge.y+edge.height,'outline jumps must clear the sticky breadcrumb');
    await page.locator('.titlebar [data-action="sidebar"]').click();
    await page.locator('#left-sidebar').waitFor({state:'hidden'});
    await page.locator('footer [data-action="outline"]').click();
    await page.locator('#right-sidebar').waitFor({state:'hidden'});
    await page.locator('.titlebar [data-action="sidebar"]').click();
    await page.locator('footer [data-action="outline"]').click();
    await page.keyboard.press('Control+k');
    await page.locator('#palette').waitFor();
    assert.equal(await page.locator('#command-input').evaluate(node=>document.activeElement===node),true);
    if (preview) await page.screenshot({path:path.join(preview,'calcite-command.png')});
    await page.keyboard.press('Escape');
    await page.locator('.command-hint').click();
    await page.locator('#command-input').fill('>专注');
    await page.keyboard.press('Enter');
    await page.locator('#left-sidebar').waitFor({state:'hidden'});
    await page.locator('#right-sidebar').waitFor({state:'hidden'});
    assert(await page.locator('#palette').isHidden());
    await page.keyboard.press('Escape');
    await page.locator('#left-sidebar').waitFor();
    await page.locator('#right-sidebar').waitFor();
    await page.locator('.workspace-picker summary').click();
    await page.getByRole('button',{name:'切换明暗主题'}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    await page.locator('.workspace-picker summary').click();
    await page.getByRole('button',{name:'切换明暗主题'}).click();

    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(900,600));
    await page.waitForFunction(()=>innerWidth<=920);
    assert(await page.getByRole('tab',{name:'大纲'}).isVisible());
    assert.equal(await page.locator('#app').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    if (preview) await page.screenshot({path:path.join(preview,'calcite-compact.png')});
    await page.evaluate(()=>{
      const add = document.querySelector('.add-tab');
      for (let i=0;i<10;i++) add.click();
    });
    const tabs = page.locator('#tabs');
    await page.waitForFunction(()=>document.querySelector('#tabs').hasAttribute('data-overflow-start'));
    const lastTab = await tabs.locator('.tab.active').boundingBox();
    const tabBar = await tabs.boundingBox();
    assert(lastTab.x+lastTab.width<=tabBar.x+tabBar.width);
    assert.equal(await tabs.getAttribute('data-overflow-end'),null);
    await tabs.evaluate(node=>{node.scrollLeft=(node.scrollWidth-node.clientWidth)/2;});
    await page.waitForFunction(()=>document.querySelector('#tabs[data-overflow-start][data-overflow-end]'));
    assert.match(await tabs.evaluate(node=>getComputedStyle(node).maskImage),/linear-gradient/);
    await tabs.locator('.tab-label').first().evaluate(node=>node.click());
    await page.waitForFunction(()=>document.querySelector('#tabs').scrollLeft===0);
    const first = await tabs.locator('.tab').first().boundingBox();
    const toggle = await page.locator('.sidebar-toggle').boundingBox();
    assert(first.x>=toggle.x+toggle.width+8);
    assert.equal(await tabs.getAttribute('data-overflow-start'),null);
    assert.notEqual(await tabs.getAttribute('data-overflow-end'),null);
    await tabs.evaluate(node=>{node.scrollLeft=70;});
    await page.waitForFunction(()=>document.querySelector('#tabs[data-overflow-start]'));
    await page.locator('.sidebar-toggle').focus();
    await page.keyboard.press('Tab');
    assert(await tabs.locator('.tab-label').first().evaluate(node=>node===document.activeElement));
    await page.waitForFunction(()=>document.querySelector('#tabs').scrollLeft===0);
    assert.equal(await tabs.getAttribute('data-overflow-start'),null);
    assert.deepEqual(errors,[]);
    console.log('Layout smoke passed. Title tabs, selection races, breadcrumbs, outline, backlinks, source markers, palette and compact layout verified.');
  } finally {
    await app.evaluate(({app})=>app.exit()).catch(()=>{});
  }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
