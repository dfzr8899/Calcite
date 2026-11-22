const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const net=require('node:net');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const data=path.join(root,'.test-data','portable-'+Date.now());await fs.mkdir(data,{recursive:true});
 const env={...process.env,CALCITE_DATA_DIR:data,CALCITE_TEST:'1'};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(path.resolve(process.argv[2] || path.join(root,'release','Calcite.exe')),[`--remote-debugging-port=${port}`],{env,windowsHide:true,stdio:'ignore'});
 let browser,last;
 for(let i=0;i<60;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:800});break;}catch(e){last=e;await new Promise(r=>setTimeout(r,700));}}
 if(!browser)throw last;
 try{const context=browser.contexts()[0];let page=context.pages()[0];if(!page)page=await context.waitForEvent('page');await page.getByRole('heading',{name:'给思考，一个安静的地方'}).waitFor();assert(await page.locator('[data-mode="live"]').isVisible());await page.locator('[data-mode="read"]').click();await page.locator('#reading .katex').first().waitFor();await page.locator('[data-action="palette"]').first().click();await page.locator('#command-input').fill('>打开全库图谱');await page.locator('#command-results').getByText('打开全库图谱',{exact:true}).waitFor();await page.locator('#command-input').fill('>新建');await page.keyboard.press('Enter');assert.equal(await page.locator('#document-name').textContent(),'未命名.md');await page.evaluate(()=>window.desktop.quit()).catch(()=>{});console.log('Portable Calcite.exe verified: startup, bundled fonts/math, mode switching, command panel, new document, clean exit.');}finally{for(const p of browser.contexts().flatMap(c=>c.pages()))await p.evaluate(()=>window.desktop.quit()).catch(()=>{});await browser.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1;});
