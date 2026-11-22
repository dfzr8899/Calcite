const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {_electron:electron,chromium}=require('playwright');
const {memoryFilesystem,registerNativeMock,serveDist,chromiumOptions}=require('./mobile-smoke.cjs');

const root=path.resolve(__dirname,'..');
const demo=path.join(root,'docs','demo-vault');
const destination=path.join(root,'docs','screenshots');
const desktop={width:1440,height:960},mobile={width:390,height:844};
const mainNote='夜空观测手册.md',mobileNote='夜空随手记.md';
const names=['desktop-dark.png','desktop-light.png','graph-view.png','export-center.png','mobile-dark.png'];

async function prepare(page) {
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#app:not([inert])').waitFor();
  return errors;
}

async function settle(page) {
  await page.evaluate(async()=>{
    await document.fonts.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
}

async function save(page,output,name,size,cdp) {
  await page.locator('#toast.show').waitFor({state:'hidden'});
  await settle(page);
  const png=cdp?Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png',
    captureBeyondViewport:true,clip:{x:0,y:0,...size,scale:1}})).data,'base64'):
    await page.screenshot({animations:'disabled',caret:'hide',scale:'device'});
  assert.equal(png.readUInt32BE(16),size.width*2,name+' width');
  assert.equal(png.readUInt32BE(20),size.height*2,name+' height');
  await fs.writeFile(path.join(output,name),png);
}

async function theme(page,value) {
  await page.evaluate(theme=>window.calciteAppearance.set('theme',theme),value);
  await page.locator('html[data-theme="'+value+'"]:not([data-appearance-switching])').waitFor({state:'attached'});
}

async function captureDesktop(output) {
  const vault=path.join(output,'夜空笔记');
  await fs.cp(demo,vault,{recursive:true});
  const profile=path.join(output,'profile');
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env={...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const source=path.join(vault,mainNote);
  const app=await electron.launch({args:[root,source],env});
  try {
    const page=await app.firstWindow();
    await app.evaluate(({BrowserWindow},size)=>{
      const window=BrowserWindow.getAllWindows()[0];
      window.setContentSize(size.width,size.height);
      window.center();
      window.webContents.setBackgroundThrottling(false);
      window.showInactive();
    },desktop);
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride',{...desktop,deviceScaleFactor:2,mobile:false});
    const errors=await prepare(page);
    const tree=page.locator('#side-content');
    const file=name=>tree.locator('[data-file]').getByText(name,{exact:true});
    for(const folder of ['01 观测规划','02 影像处理','03 星图与器材']){
      const row=tree.locator('[data-folder]').getByText(folder,{exact:true});
      await row.click();
    }
    await file('光害等级.md').click();
    await file('星野摄影.md').click();
    await page.locator('#tabs').getByText(mainNote,{exact:true}).click();
    await page.locator('footer [data-mode=read]').click();
    const note=page.locator('#reading');
    await note.getByRole('heading',{name:'夜空观测手册',exact:true}).waitFor();
    await note.locator('.katex-display').waitFor();
    await note.locator('table').waitFor();
    await note.locator('pre .hljs-keyword').first().waitFor();
    await note.locator('.wiki-link').first().waitFor();
    await page.locator('#outline').getByRole('button',{name:'星点拖影上限',exact:true}).waitFor();

    await page.mouse.move(720,5);
    await theme(page,'dark');
    await save(page,output,'desktop-dark.png',desktop,cdp);
    await theme(page,'light');
    await save(page,output,'desktop-light.png',desktop,cdp);
    await page.locator('#export-quick').click();
    const exports=page.locator('.export-center[open]');
    await exports.locator('.export-parameters').waitFor();
    const preview=exports.frameLocator('iframe').locator('.preview-sheet h1').first();
    await preview.waitFor();
    await page.mouse.move(720,5);
    await save(page,output,'export-center.png',desktop,cdp);
    await exports.getByRole('button',{name:'关闭导出中心'}).click();
    await theme(page,'dark');

    await page.evaluate(()=>{
      const StandardWorker=window.Worker;
      window.screenshotGraphReady=false;
      window.Worker=class extends StandardWorker {
        constructor(...args){
          super(...args);
          this.addEventListener('message',event=>{
            if(event.data instanceof Float32Array)window.screenshotGraphReady=true;
          });
        }
      };
    });
    await page.getByRole('button',{name:'全库图谱',exact:true}).click();
    const graph=page.locator('.graph-dialog[open]');
    await graph.locator('.graph-count').getByText('17 篇笔记',{exact:true}).waitFor();
    await page.waitForFunction(()=>window.screenshotGraphReady);
    await graph.getByText('目录分组',{exact:true}).click();
    await page.mouse.move(720,5);
    await save(page,output,'graph-view.png',desktop,cdp);
    assert.deepEqual(errors,[]);
  } finally {
    await app.close();
  }
}

async function captureMobile(output) {
  const seed=Object.fromEntries(await Promise.all([mobileNote,mainNote].map(async file=>
    ['CalciteVaults/夜空笔记/'+file,(await fs.readFile(path.join(demo,file))).toString('base64')])));
  const {server,url}=await serveDist();
  let browser;
  try {
    browser=await chromium.launch(chromiumOptions());
    const context=await browser.newContext({
      viewport:{...mobile,height:1044},deviceScaleFactor:2,hasTouch:true,isMobile:true,colorScheme:'dark'
    });
    await context.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+','+JSON.stringify(seed)+');'});
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.locator('#app:not([inert])').waitFor();
    await theme(page,'dark');
    await page.getByRole('button',{name:'打开文件抽屉',exact:true}).tap();
    await page.locator('#mobile-drawers [data-file]').getByText(mobileNote,{exact:true}).tap();
    await page.locator('#mobile-drawers:not([data-open])').waitFor({state:'attached'});
    const editor=page.locator('#source-editor .cm-content');
    await editor.getByText('夜空随手记',{exact:true}).waitFor();
    await editor.focus();
    // Shrinking the visual viewport reproduces the soft-keyboard event with a stable capture area.
    await page.setViewportSize(mobile);
    await page.getByRole('toolbar',{name:'Markdown 快捷键'}).waitFor();
    await save(page,output,'mobile-dark.png',mobile);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();
    server.close();
  }
}

async function capture() {
  await fs.access(path.join(root,'dist','index.html'));
  const scratch=path.join(root,'.test-data');
  await fs.mkdir(scratch,{recursive:true});
  const output=await fs.mkdtemp(path.join(scratch,'screenshots-'));
  await captureDesktop(output);
  await captureMobile(output);
  await fs.mkdir(destination,{recursive:true});
  for(const name of names)await fs.copyFile(path.join(output,name),path.join(destination,name));
  console.log('Captured '+names.length+' screenshots in docs/screenshots.');
}

capture().catch(error=>{console.error(error);process.exitCode=1;});
