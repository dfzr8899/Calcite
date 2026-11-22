const { _electron: electron }=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');

const project=path.resolve(__dirname,'..');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFzoAAAAASUVORK5CYII=','base64');

async function run() {
  const scratch=path.join(project,'.test-data');
  await fs.mkdir(scratch,{recursive:true});
  const profile=await fs.mkdtemp(path.join(scratch,'security-'));
  const vault=path.join(profile,'vault');
  const outside=path.join(profile,'outside');
  const other=path.join(profile,'other');
  await Promise.all([vault,outside,other].map(dir=>fs.mkdir(dir)));
  const inside=path.join(vault,'内页.md'), standalone=path.join(outside,'独立.md'), unrelated=path.join(other,'未授权.md');
  await Promise.all([
    fs.writeFile(inside,'# 工作区内'),
    fs.writeFile(standalone,'# 独立'),
    fs.writeFile(unrelated,'# 未授权'),
    fs.writeFile(path.join(vault,'plain.txt'),'ordinary text'),
    fs.writeFile(path.join(outside,'pixel.png'),png),
    fs.writeFile(path.join(other,'pixel.png'),png),
    fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}))
  ]);
  const env={...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  let app=await electron.launch({args:[project,standalone],env});
  let sent=0;
  const server=http.createServer((_,response)=>{sent++;response.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const page=await app.firstWindow();
    await page.locator('#app:not([inert])').waitFor();
    const invoke=(channel,...args)=>page.evaluate(([channel,args])=>window.desktop[channel](...args),[channel,args]);
    assert.equal((await invoke('read',inside)).text,'# 工作区内');
    assert.equal((await invoke('read',standalone)).text,'# 独立');
    await assert.rejects(invoke('read',unrelated),/未授权/);
    await assert.rejects(invoke('read',path.join(vault,'plain.txt')),/参数无效/);
    await assert.rejects(invoke('session',{tabs:[],grantedFiles:[unrelated]}),/参数无效/);
    await assert.rejects(invoke('search-index',{generation:'test',revision:-1}),/参数无效/);
    await assert.rejects(invoke('close-vault',['relative.md']),/参数无效/);
    await assert.rejects(invoke('external','data:text/plain,test'),/HTTP/);
    const image=file=>'note-image://local/'+encodeURIComponent(file);
    assert.equal(await invoke('export-image',image(path.join(outside,'pixel.png'))),'data:image/png;base64,'+png.toString('base64'));
    await assert.rejects(invoke('export-image',image(path.join(other,'pixel.png'))),/未授权/);
    const blocked=await app.evaluate(async({BrowserWindow},{preload,inside})=>{
      const aux=new BrowserWindow({show:false,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
      try {
        await aux.loadURL('about:blank');
        return await aux.webContents.executeJavaScript('window.desktop.read('+JSON.stringify(inside)+').then(()=>false,error=>error.message.includes("主窗口"))');
      } finally {aux.destroy();}
    },{preload:path.join(project,'electron','preload.cjs'),inside});
    assert.equal(blocked,true);
    const readProfile=async()=>JSON.parse(await fs.readFile(path.join(profile,'workspace.json'),'utf8'));
    assert.deepEqual((await readProfile()).grantedFiles,[standalone]);
    await page.getByRole('button',{name:'关闭 独立.md',exact:true}).click();
    await page.locator('.tab.active').getByText('开始写作.md',{exact:true}).waitFor();
    assert.deepEqual((await readProfile()).grantedFiles,[]);
    await assert.rejects(invoke('read',standalone),/未授权/);
    await assert.rejects(invoke('export-image',image(path.join(outside,'pixel.png'))),/未授权/);
    const html='<html><body><h1>离线导出测试</h1><img src="http://127.0.0.1:'+server.address().port+'/image"></body></html>';
    for (const format of ['pdf','png']) {
      const target=path.join(profile,'offline.'+format);
      await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},target);
      if(format==='pdf')assert.equal(await invoke('pdf',html),true);
      else assert.equal(await invoke('export-document',{format,name:'offline',html}),true);
      const output=await fs.readFile(target);
      assert(format==='pdf'?output.subarray(0,4).toString()==='%PDF':output.subarray(1,4).toString()==='PNG');
    }
    assert.equal(sent,0);
    const saved=await readProfile();
    await app.evaluate(({app})=>app.exit());
    saved.session.tabs.push({id:'unauthorized',path:unrelated,name:'未授权.md',text:'# 草稿',saved:'',mtime:1});
    await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify(saved));
    app=await electron.launch({args:[project],env});
    const restored=await app.firstWindow();
    await restored.locator('#app:not([inert])').waitFor();
    const state=await restored.evaluate(()=>window.desktop.bootstrap());
    assert.equal(state.config.session.tabs.find(tab=>tab.id==='unauthorized').path,null);
    await assert.rejects(restored.evaluate(file=>window.desktop.read(file),unrelated),/未授权/);
    assert.deepEqual((await readProfile()).grantedFiles,[]);
    console.log('Security smoke passed. IPC sender, schema, restart authorization, scoped images and offline PDF/PNG verified.');
  } finally {
    await app.evaluate(({app})=>app.exit()).catch(()=>{});
    await new Promise(resolve=>server.close(resolve));
  }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
