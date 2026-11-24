const { _electron: electron, chromium } = require('playwright');
const {memoryFilesystem,registerNativeMock,serveDist,chromiumOptions,assertOutlineSheet}=require('./mobile-smoke.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');

async function contrast(page,selectors,surface) {
  return page.evaluate(({selectors,surface})=>{
    const ctx = document.createElement('canvas').getContext('2d',{willReadFrequently:true});
    const style = getComputedStyle(document.documentElement);
    const token = name=>style.getPropertyValue(name).trim();
    function pixel(...colors) {
      ctx.clearRect(0,0,1,1);
      for (const color of colors) {
        ctx.fillStyle = color;
        ctx.fillRect(0,0,1,1);
      }
      return [...ctx.getImageData(0,0,1,1).data].slice(0,3);
    }
    const luma = rgb=>rgb.reduce((sum,n,i)=>{
      const s = n/255;
      return sum+[.2126,.7152,.0722][i]*(s<=.04045?s/12.92:((s+.055)/1.055)**2.4);
    },0);
    const ratio = (a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    const panel = document.querySelector(surface);
    const material = panel.querySelector(':scope > .paper-material')||panel;
    const background = getComputedStyle(material).backgroundColor;
    const ambient = token('--ambient-base');
    const gain = Number(token('--ambient-opacity'))*Number(token('--ambient-gain'));
    const grounds = [ambient,...['--ambient-near','--ambient-far']
      .map(name=>`color-mix(in srgb, ${token(name)} ${gain*100}%, ${ambient})`)];
    return Object.fromEntries(Object.entries(selectors).map(([name,selector])=>{
      const node = document.querySelector(selector);
      const entry = getComputedStyle(node);
      const fills = [];
      for (let layer = node; layer && layer!==panel; layer = layer.parentElement) {
        fills.unshift(getComputedStyle(layer).backgroundColor);
      }
      const lowest = Math.min(...grounds.map(ground=>{
        const underlay = [ground,background,...fills];
        return ratio(luma(pixel(...underlay,entry.color)),luma(pixel(...underlay)));
      }));
      return [name,Number(lowest.toFixed(2))];
    }));
  },{selectors,surface});
}

async function run() {
  const testDir = path.join(root,'.test-data');
  await fs.mkdir(testDir,{recursive:true});
  const profile = await fs.mkdtemp(path.join(testDir,'appearance-'));
  const vault = path.join(profile,'界面测试');
  await fs.mkdir(vault);
  const note = '# 写作与阅读\n\n## 玻璃纸面\n\n这一行用于检查正文、[[复习资料|双链]]和 `inline code` 的对比度。\n\n$$\nE = mc^2\n$$\n\n'+
    '| 条目 | 内容 |\n| --- | --- |\n| 对比度 | 中英文混排 |\n\n'+
    '```js\nconst label = "Calcite";\n```\n\n- [x] 已完成\n- [ ] 未完成\n\n'+
    Array.from({length:26},(_,i)=>`### 第 ${i+1} 节\n\n滚动正文时，这段文字会经过面包屑下方。`).join('\n\n');
  await fs.writeFile(path.join(vault,'写作与阅读.md'),note);
  await fs.writeFile(path.join(vault,'复习资料.md'),'# 复习资料\n\n返回 [[写作与阅读]]。');
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault,session:{light:true}}));
  const env = {...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.argv[2];
  const app = await electron.launch({env,...(executablePath?{executablePath}:{args:[root]})});
  try {
    const page = await app.firstWindow();
    const measure = Boolean(process.env.CALCITE_GLASS_MEASURE_VISIBLE);
    await app.evaluate(({BrowserWindow},show)=>{
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.setBackgroundThrottling(false);
      if (show) win.showInactive();
    },measure);
    page.setDefaultTimeout(12000);
    const client = await page.context().newCDPSession(page);
    const metrics = {};
    const preview = process.env.CALCITE_GLASS_PREVIEW;
    const screenshot = name=>preview&&page.screenshot({path:path.join(preview,name),animations:'disabled',timeout:30000});
    const appear = page.getByRole('button',{name:'主题与材质'});
    const chooser = page.locator('#appearance-panel');
    const attr = name=>page.locator('html').getAttribute('data-'+name);
    const filter = selector=>page.locator(selector).evaluate(node=>getComputedStyle(node).backdropFilter);
    const choose = name=>chooser.getByRole('button',{name,exact:true}).click();
    const mode = name=>page.locator(`footer [data-mode="${name}"]`).click();
    const nativeMaterial = await app.evaluate(()=>process.platform==='darwin'?'vibrancy':
      process.platform==='win32' && Number(process.getSystemVersion().split('.')[2])>=22621?'acrylic':'css');
    const waitMaterial = material=>page.locator(`html[data-window-material="${material}"]`).waitFor({state:'attached'});

    await page.locator('#app:not([inert])').waitFor();
    await waitMaterial(nativeMaterial);
    assert.equal(await attr('theme'),'light','legacy light theme should migrate before the editor starts');
    assert.equal(await attr('glass'),'liquid');
    assert.equal(await attr('material'),'glass');
    assert.equal(await filter('.sidebar'),'blur(18px) saturate(1.3)');
    assert.equal(await filter('.editor-section > .paper-material'),'none');
    assert.equal(await page.locator('html').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(238, 241, 246)');
    for(const selector of ['.sidebar','.editor-section','.outline-panel'])
      assert.equal(await page.locator(selector).evaluate(node=>getComputedStyle(node).borderRadius),'16px');
    assert.equal(await page.locator('.titlebar').evaluate(node=>getComputedStyle(node).borderBottomWidth),'0px');
    assert.equal(await page.locator('.sidebar').evaluate(node=>getComputedStyle(node,'::before').opacity),'0.025');
    await page.locator('#side-content .file-row').getByText('写作与阅读.md',{exact:true}).click();
    for (const [theme,label] of [['light','亮色'],['dark','暗色']]) {
      await appear.click();
      await choose(label);
      await page.keyboard.press('Escape');
      await chooser.waitFor({state:'hidden'});
      assert.equal(await attr('theme'),theme);
      await app.evaluate(({nativeTheme},theme)=>new Promise((resolve,reject)=>{
        if (nativeTheme.themeSource===theme) return resolve();
        const updated = () => {
          if (nativeTheme.themeSource!==theme) return;
          clearTimeout(timeout);
          nativeTheme.off('updated',updated);
          resolve();
        };
        const timeout = setTimeout(()=>{
          nativeTheme.off('updated',updated);
          reject(Error(`Expected nativeTheme.themeSource to be ${theme}, got ${nativeTheme.themeSource}.`));
        },2000);
        nativeTheme.on('updated',updated);
      }),theme);
      const activeFills = await page.evaluate(()=>[
        getComputedStyle(document.querySelector('.file-row.selected')).backgroundColor,
        getComputedStyle(document.querySelector('.mode-switch'),'::before').backgroundColor
      ]);
      const fill = theme==='light'?'rgba(255, 255, 255, 0.85)':'rgba(255, 255, 255, 0.09)';
      assert.deepEqual(activeFills,[fill,fill]);
      await mode('read');
      await page.locator('#reading .hljs-keyword').first().waitFor();
      await page.locator('#reading .katex').first().waitFor();
      const tasks=page.locator('#reading input[type=checkbox]');
      assert.equal(await tasks.count(),2);
      const controls=await tasks.evaluateAll(nodes=>nodes.map(node=>{
        const css=getComputedStyle(node);
        return {appearance:css.appearance,border:parseFloat(css.borderTopWidth),width:parseFloat(css.width)};
      }));
      assert(controls.every(({appearance,border,width})=>appearance==='none'&&border>0&&width>=16),JSON.stringify(controls));
      assert(await page.locator('#reading :is(p,td),.file-row.selected').evaluateAll(nodes=>
        nodes.every(node=>getComputedStyle(node).backdropFilter==='none')));
      assert.equal(await page.locator('#reading .katex').first().evaluate(el=>getComputedStyle(el).color),
        await page.locator('#reading p').first().evaluate(el=>getComputedStyle(el).color));
      const reading = await contrast(page,{
        text:'#reading p', link:'#reading .wiki-link', latex:'#reading .katex', table:'#reading td',
        header:'#reading th', inline:'#reading p code', code:'#reading .hljs-keyword'
      },'.editor-section');
      const chrome = await contrast(page,{file:'.sidebar .file-row:not(.selected)',selected:'.file-row.selected'},'.sidebar');
      await screenshot(`calcite-${theme}.png`);
      await mode('source');
      await page.locator('.cm-markdown-marker').first().waitFor();
      assert.equal(await page.locator('.mode-switch').evaluate(node=>getComputedStyle(node).getPropertyValue('--segment-index')),'1');
      const source = await contrast(page,{marker:'#source-editor .cm-markdown-marker',text:'#source-editor .cm-content'},'.editor-section');
      metrics[theme] = {...reading,...chrome,source:source.text,marker:source.marker};
      for (const [element,value] of Object.entries(metrics[theme])) assert(value>=4.5,`${theme} ${element}: ${value}:1`);
    }
    await mode('read');
    const crumb = page.locator('.breadcrumb');
    const top = (await crumb.boundingBox()).y;
    assert.equal(await crumb.evaluate(node=>getComputedStyle(node).position),'absolute');
    assert.equal(await filter('.breadcrumb'),'blur(18px) saturate(1.2)');
    const reading = page.locator('#reading');
    assert(await reading.evaluate(node=>node.clientHeight===node.closest('.editor-section').clientHeight));
    if (measure) {
      await page.waitForFunction(()=>document.visibilityState==='visible');
      const timing = await reading.evaluate(node=>new Promise(resolve=>{
        const timestamps = [];
        function step(timestamp) {
          timestamps.push(timestamp);
          node.scrollTop += 12;
          if (timestamps.length<48) requestAnimationFrame(step);
          else resolve(timestamps.slice(1).map((time,i)=>time-timestamps[i]));
        }
        requestAnimationFrame(step);
      }));
      timing.sort((a,b)=>a-b);
      console.log(`Visible-window scroll frame interval p95: ${timing[Math.floor(timing.length*.95)].toFixed(1)} ms.`);
    } else await reading.evaluate(node=>{node.scrollTop=576;});
    assert((await reading.evaluate(node=>node.scrollTop))>400);
    assert.equal((await crumb.boundingBox()).y,top);
    assert(await reading.evaluate((node,y)=>[...node.querySelectorAll('.reading-content :is(h1,h2,h3,p)')]
      .some(el=>el.getBoundingClientRect().top<y&&el.getBoundingClientRect().bottom>y-38),top+38));
    await screenshot('calcite-scroll.png');
    for (const selector of ['table','pre']) {
      const card = reading.locator(selector).first();
      await card.evaluate((node,y)=>{node.closest('#reading').scrollTop+=node.getBoundingClientRect().top-y-8;},top);
      const bounds = await card.boundingBox();
      assert(bounds.y<top+38&&bounds.y+bounds.height>top+38,`${selector} must pass under the glass`);
      if (selector==='pre' && preview) {
        await reading.evaluate(node=>{node.scrollTop+=16;});
        await screenshot('calcite-under-glass.png');
      }
    }
    await appear.click();
    assert.equal(await chooser.locator('fieldset,input[type=radio]').count(),0);
    assert(await chooser.evaluate(node=>node.parentElement===document.body));
    await page.evaluate(()=>window.calciteAppearance.set('glass','solid'));
    await waitMaterial('solid');
    for (const selector of ['.sidebar','.editor-section > .paper-material','.breadcrumb','#appearance-panel']) assert.equal(await filter(selector),'none');
    assert(await page.locator('.ambient-canvas').isHidden());
    assert.equal(await page.locator('.sidebar').evaluate(node=>getComputedStyle(node,'::before').opacity),'0');
    await choose('亮色');
    await screenshot('calcite-settings.png');
    await chooser.evaluate(node=>node.hidePopover());
    await page.locator('#settings-toggle').click();
    await page.locator('#settings-tab-appearance').click();
    const language=page.locator('#settings-appearance .lg-section .lg-group select[name=language]');
    await language.waitFor();
    assert(await language.evaluate(select=>Math.abs(select.offsetWidth-select.parentElement.offsetWidth)<1));
    await page.locator('.settings-center[open]').evaluate(dialog=>dialog.close());

    await page.addInitScript(()=>{
      const watcher = new MutationObserver(()=>{
        const root = document.documentElement;
        if (!root?.dataset.theme || !root.dataset.glass) return;
        window.firstAppearance = [root.dataset.theme,root.dataset.glass];
        watcher.disconnect();
      });
      watcher.observe(document,{subtree:true,attributes:true,attributeFilter:['data-theme','data-glass']});
    });
    await page.reload();
    await page.locator('#app:not([inert])').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.firstAppearance),['light','solid']);
    assert.deepEqual([await attr('theme'),await attr('glass')],['light','solid']);
    await appear.click();
    assert.equal(await chooser.getByRole('button',{name:'亮色'}).getAttribute('aria-pressed'),'true');
    await page.evaluate(()=>window.calciteAppearance.set('glass','liquid'));
    await waitMaterial(nativeMaterial);
    await page.evaluate(()=>window.calciteAppearance.set('theme','system'));
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.mode-switch').evaluate(node=>getComputedStyle(node,'::before').transitionDuration),'0s');
    await client.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
    await waitMaterial('solid');
    assert.equal(await attr('glass'),'liquid');
    assert(await page.locator('.ambient-canvas').isHidden());
    for (const selector of ['.sidebar','.editor-section > .paper-material','.breadcrumb','#appearance-panel']) assert.equal(await filter(selector),'none');
    console.log(JSON.stringify(metrics,null,2));
    console.log('Appearance smoke passed. First-paint migration, both themes, material levels, scrolling under glass, persistence, and reduced effects verified.');
  } finally {
    await app.evaluate(({app})=>app.exit()).catch(()=>{});
  }
}

async function mobileOutlineAppearance() {
  const {server,url}=await serveDist();
  let browser;
  try{
    browser=await chromium.launch(chromiumOptions());
    const context=await browser.newContext({viewport:{width:360,height:780},hasTouch:true,isMobile:true,locale:'en-US'});
    const text=['# First heading','## Decisions','### Context','#### Design','##### Details',
      '###### Long sixth-level heading with enough text to wrap within the narrow mobile viewport while keeping the entire title readable',
      ...Array.from({length:20},(_,index)=>'## More headings '+(index+1))].join('\n\n');
    const seed={'CalciteVaults/Outline/Outline.md':Buffer.from(text).toString('base64')};
    const options={useSystemLanguage:true,prefs:{vault:'/CalciteVaults/Outline'}};
    await context.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+','+
      JSON.stringify(seed)+','+JSON.stringify(options)+');'});
    const page=await context.newPage();
    await page.goto(url);
    await page.locator('html[lang=en-US] #app:not([inert])').waitFor();
    await page.evaluate(()=>document.documentElement.style.setProperty('--safe-bottom','24px'));
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>calciteAppearance.set('theme',theme),theme);
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      await page.locator('[data-mobile-more]').tap();
      await page.locator('.mobile-sheet[open]').getByRole('button',{name:'Outline',exact:true}).tap();
      await assertOutlineSheet(page,{outline:'Outline',backlinks:'Backlinks',filter:'Filter Headings',close:'Close Outline & Backlinks',scrolls:true});
    }
    await page.locator('[data-mobile-more]').tap();
    await page.locator('.mobile-sheet[open]').getByRole('button',{name:'Outline',exact:true}).tap();
    const handle=page.locator('#mobile-drawers[data-open="right"] .mobile-inspector-handle');
    await handle.waitFor();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#right-sidebar')).transform==='none');
    const box=await handle.boundingBox();
    const x=box.x+box.width/2,y=box.y+box.height/2;
    const session=await context.newCDPSession(page);
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+70}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await handle.waitFor({state:'hidden'});
    console.log('Mobile inspector appearance passed at 360px in English in dark and light themes, including safe area, scrolling and drag dismissal.');
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

run().then(mobileOutlineAppearance).catch(error=>{console.error(error);process.exitCode=1;});
