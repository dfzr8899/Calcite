const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {existsSync}=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {chromium}=require('playwright');
const git=require('isomorphic-git');
const QRCode=require('qrcode');

function memoryFilesystem(seed={}) {
  const store=new Map([['DOCUMENTS:',{type:'directory'}],['DATA:',{type:'directory'}],['CACHE:',{type:'directory'}]]);
  let time=Date.now();
  const error=code=>Object.assign(new Error(code),{code});
  const key=({directory,path})=>directory+':'+path.replace(/^\/+|\/+$/g,'');
  const parent=id=>id.includes('/')?id.slice(0,id.lastIndexOf('/')):id.slice(0,id.indexOf(':')+1);
  function item(id) {
    if(!store.has(id))throw error('ENOENT');
    return store.get(id);
  }
  function directory(id) {
    if(item(id).type!=='directory')throw error('ENOTDIR');
  }
  function mkdir(id,recursive) {
    if(store.has(id))return directory(id);
    if(recursive)mkdir(parent(id),true);
    else directory(parent(id));
    store.set(id,{type:'directory',mtime:++time,ctime:time,size:0});
  }
  const below=id=>[...store.keys()].filter(target=>target.startsWith(id+(id.endsWith(':')?'':'/'))&&target!==id);
  function write(id,data,recursive) {
    if(recursive)mkdir(parent(id),true);else directory(parent(id));
    if(store.get(id)?.type==='directory')throw error('EISDIR');
    store.set(id,{type:'file',mtime:++time,ctime:time,size:atob(data).length,data});
  }
  for(const [file,data] of Object.entries(seed))write('DOCUMENTS:'+file,data,true);
  return {
    store,
    async stat(options){const id=key(options);return {...item(id),name:id.split('/').at(-1).split(':').at(-1)};},
    async readdir(options){
      const id=key(options);
      directory(id);
      return {files:below(id).filter(child=>parent(child)===id).map(child=>({...item(child),name:child.slice(id.length).replace(/^\//,'')}))};
    },
    async readFile(options){const row=item(key(options));if(row.type==='directory')throw error('EISDIR');return {data:row.data};},
    async writeFile(options){write(key(options),options.data,options.recursive);return {uri:'file:///'+options.path};},
    async mkdir(options){mkdir(key(options),options.recursive);},
    async rmdir(options){
      const id=key(options);directory(id);
      const children=below(id);
      if(children.length&&!options.recursive)throw error('ENOTEMPTY');
      children.forEach(child=>store.delete(child));store.delete(id);
    },
    async rename({from,to,directory,toDirectory=directory}) {
      const id=key({directory,path:from}),dest=key({directory:toDirectory,path:to});
      item(id);
      const children=[id,...below(id)];
      for(const child of children){store.set(dest+child.slice(id.length),item(child));store.delete(child);}
    },
    async copy({from,to,directory,toDirectory=directory}){
      write(key({directory:toDirectory,path:to}),item(key({directory,path:from})).data,false);
    },
    async deleteFile(options){const id=key(options);item(id);store.delete(id);},
    async getUri(options){item(key(options));return {uri:'file:///'+options.path};},
    async checkPermissions(){return {publicStorage:'granted'};}
  };
}

async function gitSmoke() {
  const {createCapacitorGitFs,posixPath,dirname,toBase64,fromBase64}=await import('../src/platform/capacitor-git-fs.js');
  const {createGitEngine}=await import('../shared/core/git-engine.mjs');
  const bytes=randomBytes(3*1024*1024+2);
  assert.deepEqual(Buffer.from(fromBase64(toBase64(bytes))),bytes);
  const filesystem=memoryFilesystem(),fs=createCapacitorGitFs(filesystem),dir='/vault';
  const disk=fs.promises,author={name:'Calcite',email:'calcite@local'};
  const malfunction=createCapacitorGitFs({async readFile(){
    throw Object.assign(Error('Unrecognized filesystem corruption'),{code:'OS-PLUG-FILE-0013'});
  }},'DATA',{sandboxed:true});
  await assert.rejects(malfunction.promises.readFile('/vault/note.md'),error=>
    error.code==='EIO'&&error.nativeCode==='OS-PLUG-FILE-0013'&&/filesystem corruption/.test(error.message));
  await disk.mkdir(dir);
  await assert.rejects(disk.mkdir(dir),{code:'EEXIST'});
  await assert.rejects(disk.readFile(dir),{code:'EISDIR'});
  await assert.rejects(disk.readFile(dir+'/missing'),{code:'ENOENT'});
  await git.init({fs,dir,defaultBranch:'main'});
  await disk.writeFile(dir+'/binary',bytes);
  await git.add({fs,dir,filepath:'binary'});
  await disk.writeFile(dir+'/note.md','alpha\ncommon\nlast\n','utf8');
  await assert.rejects(disk.stat(dir+'/note.md/x'),{code:'ENOTDIR'});
  await git.add({fs,dir,filepath:'note.md'});
  const base=await git.commit({fs,dir,author,message:'base'});
  assert.deepEqual(Buffer.from((await git.readBlob({fs,dir,oid:base,filepath:'binary'})).blob),bytes);
  await git.branch({fs,dir,ref:'another'});
  await disk.writeFile(dir+'/note.md','first\ncommon\nlast\n','utf8');
  await git.add({fs,dir,filepath:'note.md'});
  await git.commit({fs,dir,author,message:'main change'});
  await git.checkout({fs,dir,ref:'another'});
  await disk.writeFile(dir+'/note.md','alpha\ncommon\nfinal\n','utf8');
  await git.add({fs,dir,filepath:'note.md'});
  await git.commit({fs,dir,author,message:'other change'});
  await git.checkout({fs,dir,ref:'main'});
  const result=await git.merge({fs,dir,ours:'main',theirs:'another',author});
  assert(result.oid);
  assert.equal(Buffer.from((await git.readBlob({fs,dir,oid:result.oid,filepath:'note.md'})).blob).toString(),'first\ncommon\nfinal\n');
  assert.equal((await git.readCommit({fs,dir,oid:result.oid})).commit.parent.length,2);
  const privateIo=createCapacitorGitFs(filesystem,'DATA',{sandboxed:true}).promises;
  const paths={resolve:posixPath,join:posixPath,dirname,sep:'/',relative:(root,file)=>file===root?'':file.slice(root.length+1)};
  const Engine=createGitEngine({fs:privateIo,path:paths,atomicWrite:privateIo.writeFile,sandboxed:true,
    within:(root,file)=>root===file||file.startsWith(root+'/')});
  await privateIo.mkdir('/CalciteVaults/私有',{recursive:true});
  const guarded=new Engine('\\CalciteVaults//私有///');
  await guarded.open();
  assert.equal(await guarded.guard.safe('.'),'/CalciteVaults/私有');
  assert.equal(await guarded.guard.safe('//CalciteVaults\\私有//.git/HEAD/'),'/CalciteVaults/私有/.git/HEAD');
  await assert.rejects(guarded.guard.safe('/CalciteVaults/私有/../私有-其他'),/超出/);
  assert(filesystem.store.has('DATA:CalciteVaults/私有/.git/HEAD'));
  console.log('Mobile Git passed: init, staging, commits, 3 MiB binary, POSIX codes, and three-way merge.');
}

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFzoAAAAASUVORK5CYII=';

function registerNativeMock(factory,seed,options={}) {
  if(!options.useSystemLanguage)localStorage.setItem('calcite.language','zh-CN');
  const filesystem=factory(seed);
  const prefs=new Map(Object.entries(options.prefs||{}).map(([key,value])=>[key,JSON.stringify(value)]));
  const outputs=[];
  const fixture={head:null,objects:[],written:0,waiting:false,requests:[]};
  const pendingExternalFiles=options.externalFile?[options.externalFile]:[];
  let externalListener, appStateListener;
  fixture.appState=isActive=>appStateListener?.({isActive});
  fixture.deliverExternalFile=file=>{
    pendingExternalFiles.push(file);
    externalListener?.({});
  };
  const rename=filesystem.rename;
  filesystem.rename=async options=>{
    if(/\/Batch-\d+\.md$/.test(options.to)&&++fixture.written===66) {
      fixture.waiting=true;
      await new Promise(resolve=>{fixture.release=resolve;});
    }
    return rename(options);
  };
  const mock={
    Filesystem:filesystem,
    CalciteAtomicFiles:{
      async rename({from,to,exclusive,temporary}){
        const key='DATA:'+to.replace(/^\//,'');
        if(exclusive){
          if(filesystem.store.has(key))throw Object.assign(Error('Destination already exists'),{code:'EEXIST'});
          if(temporary)fixture.exclusiveImports=(fixture.exclusiveImports||0)+1;
          filesystem.store.set(key,filesystem.store.get('DATA:'+from.replace(/^\//,'')));
          return;
        }
        return filesystem.rename({from,to,directory:'DATA'});
      },
      async sameFile({from,to}){
        return {same:filesystem.store.get('DATA:'+from.replace(/^\//,''))===filesystem.store.get('DATA:'+to.replace(/^\//,''))};
      },
      async flushDirectory(){}
    },
    Preferences:{async get({key}){
      if(options.holdGit&&key.startsWith('git:')&&!fixture.gitReleased)
        await new Promise(resolve=>{fixture.releaseGit=()=>{fixture.gitReleased=true;resolve();};});
      return {value:prefs.get(key)||null};
    },async set({key,value}){prefs.set(key,value);}},
    App:{async exitApp(){}},
    Network:{async getStatus(){return {connected:true,connectionType:'wifi'};}},
    CapacitorHttp:{async request({url,headers,disableRedirects,data:input}){
      const endpoint=new URL(url);
      const vaultId='cd3c2f18-4f14-473d-a844-ba43329f976a';
      const second=endpoint.hostname==='calcite-fixture-two.local';
      if((!second&&endpoint.hostname!=='calcite-fixture-one.local')||!disableRedirects||
        headers.Authorization!=='Bearer '+(second?'2':'1').repeat(64)||headers['x-calcite-vault']!==vaultId)
        throw Error('Unexpected pairing request');
      fixture.requests.push(endpoint.hostname+endpoint.pathname);
      let data={accepted:0};
      if(endpoint.pathname.endsWith('/info'))data={vaultId,deviceName:second?'另一台桌面':'测试桌面'};
      if(endpoint.pathname.endsWith('/negotiate')){
        const known=new Set(input.known);
        data={headOid:fixture.head,available:fixture.objects.map(row=>row.oid).filter(oid=>!known.has(oid)),need:[]};
      }
      if(endpoint.pathname.endsWith('/objects/pull')){
        const byId=new Map(fixture.objects.map(row=>[row.oid,row]));
        data={objects:input.oids.map(oid=>byId.get(oid))};
      }
      return {url,status:200,data,headers:{}};
    }},
    Clipboard:{async write(value){outputs.push(value);},async read(){return {value:''};}},
    Share:{async canShare(){return {value:true};},async share(data){outputs.push(data);}},
    CalciteRichClipboard:{async write(data){outputs.push(data);},async readImage(){return fixture.clipboardImage||{};}},
    CalciteExternalFiles:{async setLocale({locale}){fixture.locale=locale;},async consumePendingExternalFile(){
      return pendingExternalFiles.shift()||{};
    }},
    CalciteDocumentPrint:{async pdf(data){outputs.push({...data,print:true});}}
  };
  globalThis.androidBridge={};
  globalThis.Capacitor={
    PluginHeaders:Object.entries(mock).map(([name,value])=>({name,methods:[
      ...Object.entries(value).filter(([,method])=>typeof method==='function').map(([name])=>({name,rtype:'promise'})),
      {name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'promise'}
    ]})),
    nativePromise:(name,method,data)=>method==='removeListener'?Promise.resolve():mock[name][method](data),
    nativeCallback:(name,method,options,listener)=>{
      if(name==='CalciteExternalFiles'&&method==='addListener'&&options.eventName==='externalFileAvailable')
        externalListener=listener;
      if(name==='App'&&method==='addListener'&&options.eventName==='appStateChange')appStateListener=listener;
      return 1;
    },
    convertFileSrc:uri=>location.origin+'/_capacitor_file_/'+uri.replace(/^file:\/\/\//,'')
  };
  globalThis.calciteTest={filesystem,prefs,outputs,fixture};
}

async function progressiveFixture() {
  const {createCapacitorGitFs,posixPath,dirname}=await import('../src/platform/capacitor-git-fs.js');
  const {createGitEngine}=await import('../shared/core/git-engine.mjs');
  const fs=createCapacitorGitFs(memoryFilesystem()).promises;
  const dir='/remote';
  await fs.mkdir(dir);
  const paths={resolve:posixPath,join:posixPath,dirname,sep:'/',relative:(root,file)=>file.slice(root.length+1)};
  const Engine=createGitEngine({fs,path:paths,atomicWrite:fs.writeFile,within:(root,file)=>file===root||file.startsWith(root+'/'),sandboxed:true});
  const engine=new Engine(dir);
  await engine.open();
  for(let i=0;i<126;i++){
    const id=String(i).padStart(3,'0');
    await fs.writeFile(dir+'/Batch-'+id+'.md','# Progressive '+id);
  }
  const head=await engine.snapshot({name:'Calcite',email:'calcite@local'});
  return {head,objects:await Promise.all((await engine.objects(head)).map(oid=>engine.object(oid)))};
}

async function serveDist() {
  const dist=path.resolve(process.env.CALCITE_MOBILE_DIST||path.join(__dirname,'../dist'));
  const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.woff2':'font/woff2'};
  const server=http.createServer(async(req,res)=>{
    try {
      const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(relative.startsWith('/_capacitor_file_/')){
        res.writeHead(200,{'content-type':'image/png'});
        return res.end(Buffer.from(png,'base64'));
      }
      const file=path.resolve(dist,'.'+(relative==='/'?'/index.html':relative));
      if(!file.startsWith(dist+path.sep)){res.writeHead(403);return res.end();}
      const data=await fs.readFile(file);
      res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});
      res.end(data);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,url:'http://127.0.0.1:'+server.address().port};
}

async function touch(cdp,type,touchPoints) {
  await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:touchPoints.map(([x,y,id])=>({x,y,id}))});
}

function chromiumOptions() {
  if(process.env.CALCITE_CHROMIUM)return {executablePath:process.env.CALCITE_CHROMIUM};
  if(existsSync(chromium.executablePath())||process.platform!=='win32')return {};
  const roots=[process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean);
  const installed=roots.map(root=>path.join(root,'Google','Chrome','Application','chrome.exe')).find(existsSync);
  return installed?{executablePath:installed}:{};
}

async function externalFileSmoke(browser,url) {
  const vault='CalciteVaults/外部文件';
  const original=vault+'/v1.0.notes.md';
  const encode=text=>Buffer.from(text,'utf8').toString('base64');
  const text='# 外部文档\r\n\r\n$E=mc^2$\r\n\r\n## 第二节\r\n\r\n'+
    '| 测试 | 内容 |\r\n| --- | --- |\r\n| 甲 | 乙 |\r\n\r\n';
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  try {
    const options={externalFile:{name:'v1.0.notes.MD',text:text+'~~~js\r\nconst flag = true;\r\n~~~\r\n'},
      prefs:{vault:'/'+vault,['git:/'+vault]:{settings:{enabled:false}}}};
    await context.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+','+
      JSON.stringify({[original]:encode('# 原有笔记\n')})+','+JSON.stringify(options)+');'});
    const page=await context.newPage();
    await page.goto(url);
    const preview=page.getByRole('dialog',{name:'外部临时预览'});
    await preview.getByRole('heading',{name:'外部临时预览 · v1.0.notes.MD',exact:true}).waitFor();
    await preview.locator('.hljs-keyword').first().waitFor();
    await preview.locator('.katex').first().waitFor();
    await preview.getByRole('region',{name:'横向滚动表格'}).waitFor();
    await preview.getByText('大纲',{exact:true}).tap();
    await preview.getByRole('navigation',{name:'外部文件大纲'}).getByRole('button',{name:'第二节'}).tap();
    const documents=()=>page.evaluate(path=>[...calciteTest.filesystem.store.keys()].filter(key=>
      key.startsWith('DATA:'+path+'/')&&key.endsWith('.md')),vault);
    assert.deepEqual(await documents(),['DATA:'+original]);
    await preview.getByRole('button',{name:'导出 PDF'}).tap();
    await page.waitForFunction(()=>calciteTest.outputs.some(row=>row.print&&row.title==='v1.0.notes'));
    await preview.getByRole('button',{name:'导出长图'}).tap();
    await page.waitForFunction(()=>calciteTest.outputs.some(row=>row.files?.some(file=>file.endsWith('.png'))));
    await preview.getByRole('button',{name:'HTML',exact:true}).tap();
    await page.waitForFunction(()=>calciteTest.outputs.some(row=>row.files?.some(file=>file.endsWith('.html'))));
    assert.deepEqual(await documents(),['DATA:'+original]);

    await preview.getByRole('button',{name:'导入到当前知识库'}).tap();
    await preview.waitFor({state:'hidden'});
    await page.locator('#document-name').filter({hasText:'v1.0.notes (1).md'}).waitFor({state:'attached'});
    await page.locator('#source-editor .cm-content').getByText(/外部文档/).waitFor();
    const imported=await page.evaluate(path=>Object.fromEntries([...calciteTest.filesystem.store].filter(([key])=>
      key.startsWith('DATA:'+path+'/')&&key.endsWith('.md')).map(([key,row])=>[key,row.data])),vault);
    assert.equal(imported['DATA:'+original],encode('# 原有笔记\n'));
    assert.equal(imported['DATA:'+vault+'/v1.0.notes (1).md'],encode(options.externalFile.text.replaceAll('\r\n','\n')));

    assert.equal(await page.evaluate(()=>calciteTest.fixture.exclusiveImports),1);
    const deliver=file=>page.evaluate(file=>calciteTest.fixture.deliverExternalFile(file),file);
    await page.evaluate(()=>{
      calciteTest.fixture.deliverExternalFile({name:'另一份.markdown',text:'# 热启动文件'});
      calciteTest.fixture.deliverExternalFile({name:'排队.MD',text:'# 排队文件'});
    });
    await preview.getByRole('heading',{name:'热启动文件',exact:true}).waitFor();
    await preview.getByRole('button',{name:'关闭外部预览'}).tap();
    await preview.getByRole('heading',{name:'排队文件',exact:true}).waitFor();
    await preview.getByRole('button',{name:'关闭外部预览'}).tap();
    await preview.waitFor({state:'hidden'});
    await page.locator('#document-name').filter({hasText:'v1.0.notes (1).md'}).waitFor({state:'attached'});
    for(const error of ['外部文件为空。','外部文件包含二进制内容，无法预览。','没有权限读取外部文件。']){
      await deliver({error});
      await page.locator('#toast').filter({hasText:error}).waitFor();
      assert.equal(await preview.count(),0);
    }
    assert.equal((await documents()).length,2);
    console.log('External Markdown passed: cold and warm consumption, isolated preview, outline, PDF/PNG, LF duplicate import and read errors.');
  }finally{await context.close();}
}

async function uiSmoke() {
  const {server,url}=await serveDist();
  let browser;
  const seed={
    'CalciteVaults/测试/C1.md':Buffer.from('# 一级\n\n段落 ![本地](assets/p.png) ![[p.png]]\n\n## 第二级\n\n内层正文\n\n### 第三级\n\n[[C2]]\n\n## 同级\n\n结束。\n\n- [x] 已完成\n- 普通条目\n\n| 字段一 | 字段二 | 字段三 | 字段四 | 字段五 |\n| --- | --- | --- | --- | --- |\n| 单元格内容 | 很长的配置说明 | 示例列 | 示例列 | 最右侧 |\n').toString('base64'),
    'CalciteVaults/测试/C2.md':Buffer.from('# 目标\n\n[[C1]]\n').toString('base64'),
    'CalciteVaults/测试/assets/p.png':png,
    'CalciteVaults/测试/assets/orphan.png':png
  };
  try {
    browser=await chromium.launch(chromiumOptions());
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:2});
    await context.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+','+JSON.stringify(seed)+');'});
    const page=await context.newPage(),errors=[],consoleErrors=[];
    page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
    const cdp=await context.newCDPSession(page);
    await page.goto(url);
    await page.locator('#app:not([inert])').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-platform'),'mobile');
    await page.locator('#source-editor .cm-content').waitFor();
    await page.waitForFunction(()=>[...calciteTest.filesystem.store.keys()].some(key=>key.endsWith('/.git/HEAD')));
    const sheet=page.locator('.mobile-sheet[open]');
    const drawers=page.locator('#mobile-drawers');
    const tap=name=>page.getByRole('button',{name,exact:true}).tap();
    const syncCard=page.locator('.mobile-sheet[data-kind="sync"][open]');
    const contrast=selector=>page.locator(selector).evaluateAll(buttons=>{
      const luminance=color=>{
        const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(channel=>{
          const value=channel/255;
          return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;
        });
        return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
      };
      return buttons.map(button=>{
        const css=getComputedStyle(button);
        const foreground=luminance(getComputedStyle(button.querySelector('svg')||button).color);
        const background=luminance(css.backgroundColor);
        return {opacity:getComputedStyle(button.parentElement).opacity,ratio:(Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05)};
      });
    });
    async function closeDrawer() {
      const side=await drawers.getAttribute('data-open');
      assert(side);
      await page.getByRole('button',{name:'关闭抽屉',exact:true}).tap({position:{x:side==='left'?382:8,y:120}});
      await page.locator('#mobile-drawers[data-open]').waitFor({state:'detached'});
    }
    const contained=()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
    for(const [theme,glass] of [['dark','liquid'],['light','liquid'],['dark','solid'],['light','solid']]){
      await page.evaluate(([theme,glass])=>{calciteAppearance.set('theme',theme);calciteAppearance.set('glass',glass);},[theme,glass]);
      assert(await contained());
      const filter=await page.locator('.titlebar').evaluate(node=>getComputedStyle(node).backdropFilter);
      if(glass==='solid')assert.equal(filter,'none');
      else assert.equal(filter,'blur(14px) saturate(1.4)');
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      assert.equal(await page.locator('html').getAttribute('data-material'),glass==='solid'?'solid':'glass');
      await tap('打开文件抽屉');
      await drawers.locator('.sidebar').waitFor();
      {
        const icons=await contrast('.side-heading-actions :is(#file-sort,[data-action="refresh"])');
        assert.equal(icons.length,2);
        assert(icons.every(({opacity,ratio})=>opacity==='1'&&ratio>=3),JSON.stringify(icons));
        const create=await contrast('.mobile-file-actions .mobile-primary');
        assert(create[0].ratio>=4.5,JSON.stringify(create));
        console.log(theme+'/'+glass+' contrast: sort/refresh '+icons.map(icon=>icon.ratio.toFixed(2)+':1').join(', ')+
          ', new note '+create[0].ratio.toFixed(2)+':1.');
      }
      const newNote=drawers.getByRole('button',{name:'新建笔记',exact:true});
      assert.equal(await newNote.evaluate(node=>getComputedStyle(node).whiteSpace),'nowrap');
      const folder=drawers.getByRole('button',{name:'新建文件夹',exact:true});
      const noteBox=await newNote.boundingBox(),folderBox=await folder.boundingBox();
      assert.deepEqual([folderBox.width,folderBox.height,folderBox.y].map(Math.round),[44,44,Math.round(noteBox.y)]);
      assert.equal((await folder.textContent()).trim(),'');
      assert(noteBox.width>folderBox.width);
      await closeDrawer();
      await tap('更多文档操作');
      assert.equal(await sheet.locator('h2').textContent(),'文档操作');
      assert(await sheet.evaluate(node=>node.parentElement===document.body));
      const sheetFilter=await sheet.evaluate(node=>getComputedStyle(node).backdropFilter);
      assert.equal(sheetFilter,glass==='solid'?'none':'blur(16px) saturate(1.5)');
      await page.setViewportSize({width:360,height:780});
      await tap('大纲与反链');
      await assertOutlineSheet(page,{outline:'大纲',backlinks:'反链',filter:'筛选标题',close:'关闭大纲与反链'});
      await page.setViewportSize({width:390,height:844});
    }
    await page.evaluate(()=>calciteAppearance.set('glass','liquid'));
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
    await page.waitForFunction(()=>document.documentElement.dataset.material==='solid');
    assert.equal(await page.locator('.titlebar').evaluate(node=>getComputedStyle(node).backdropFilter),'none');
    await cdp.send('Emulation.setEmulatedMedia',{features:[]});
    await page.waitForFunction(()=>document.documentElement.dataset.material==='glass');

    await touch(cdp,'touchStart',[[6,320,1]]);
    await touch(cdp,'touchMove',[[120,320,1]]);
    await touch(cdp,'touchEnd',[]);
    await page.locator('#mobile-drawers[data-open=left]').waitFor();
    const row=drawers.locator('[data-file]').filter({hasText:'C1.md'});
    await row.scrollIntoViewIfNeeded();
    const rowBox=await row.boundingBox();
    await touch(cdp,'touchStart',[[rowBox.x+35,rowBox.y+rowBox.height/2,1]]);
    await sheet.waitFor();
    assert(await sheet.getByRole('button',{name:'重命名',exact:true}).isVisible());
    await touch(cdp,'touchEnd',[]);
    await tap('关闭操作表单');
    await tap('切换到阅读');
    await page.locator('#reading h1').waitFor();
    const tableWrap=page.locator('#reading .table-wrap').filter({has:page.locator('table')});
    await tableWrap.waitFor();
    assert(await tableWrap.evaluate(node=>{
      node.scrollLeft=48;
      return getComputedStyle(node).overflowX==='auto'&&node.scrollWidth>node.clientWidth&&
        node.scrollLeft>0&&[...node.querySelectorAll('th,td')].every(cell=>cell.offsetWidth>=96);
    }));
    assert(await contained());
    assert.equal(await page.locator('#reading li').filter({hasText:'已完成'}).evaluate(node=>getComputedStyle(node).listStyleType),'none');
    assert.equal(await page.locator('#reading li').filter({hasText:'普通条目'}).evaluate(node=>getComputedStyle(node).listStyleType),'disc');
    await page.waitForFunction(()=>[...document.querySelectorAll('#reading img')].filter(image=>image.complete&&image.naturalWidth>0).length===2);
    await touch(cdp,'touchStart',[[384,340,2]]);
    await touch(cdp,'touchMove',[[300,340,2]]);
    await touch(cdp,'touchEnd',[]);
    await page.locator('#mobile-drawers[data-open=right]').waitFor();
    await drawers.getByRole('button',{name:'折叠或展开 第二级',exact:true}).tap();
    await drawers.getByRole('button',{name:'第三级',exact:true}).waitFor({state:'hidden'});
    await page.locator('#reading').getByText('内层正文').waitFor({state:'hidden'});
    await drawers.getByRole('button',{name:'折叠或展开 第二级',exact:true}).tap();
    await drawers.getByRole('button',{name:'第三级',exact:true}).waitFor();
    await tap('关闭大纲与反链');
    await page.locator('#mobile-drawers[data-open]').waitFor({state:'detached'});
    await tap('切换到编辑');
    const editor=page.locator('#source-editor .cm-content');
    await editor.focus();
    await page.keyboard.press('Control+End');
    await page.evaluate(()=>{
      const viewport=window.visualViewport;
      const height=viewport.height-250;
      Object.defineProperty(viewport,'height',{configurable:true,get:()=>height});
      viewport.dispatchEvent(new Event('resize'));
    });
    const toolbar=page.getByRole('toolbar',{name:'Markdown 快捷键'});
    await toolbar.waitFor();
    await toolbar.getByRole('button',{name:'- [ ] 待办',exact:true}).tap();
    assert.match(await editor.innerText(),/- \[ \]/);
    await toolbar.getByRole('button',{name:'收起键盘',exact:true}).tap();
    await toolbar.waitFor({state:'hidden'});
    await page.evaluate(()=>delete window.visualViewport.height);
    await page.locator('footer[data-saved=true]').waitFor({state:'attached'});

    await tap('打开文件抽屉');
    await tap('设置中心');
    const settings=page.locator('.settings-center[open]');
    await settings.waitFor();
    assert.deepEqual(await settings.getByRole('tab').allTextContents(),['写作','同步','附件']);
    const settingsTabsFit=()=>settings.locator('[role=tablist]').evaluate(nav=>{
      const end=nav.getBoundingClientRect().right;
      return nav.scrollWidth<=nav.clientWidth&&[...nav.children].every(tab=>tab.scrollWidth<=tab.clientWidth&&tab.getBoundingClientRect().right<=end);
    });
    await page.setViewportSize({width:320,height:720});
    assert(await settingsTabsFit());
    await page.setViewportSize({width:390,height:844});
    assert(await settingsTabsFit());
    for(const label of ['写作','同步','附件']){
      await settings.getByRole('tab',{name:label,exact:true}).tap();
      await settings.getByRole('tabpanel',{name:label,exact:true}).waitFor();
      assert(await contained());
      assert.equal(await settings.locator('fieldset,[type=radio],[name=vim]').count(),0);
      assert.equal(await settings.getByText(/源码模式启用 Vim|Pandoc|Ctrl \+/).count(),0);
      assert(await settings.locator('input[type=checkbox]').evaluateAll(inputs=>inputs.every(input=>{
        const css=getComputedStyle(input);
        return input.classList.contains('lg-switch')&&css.appearance==='none'&&css.width==='40px'&&css.height==='22px';
      })));
      if(label==='写作'){
        await assertLanguageCard(settings);
        const macro=settings.locator('[name=macroInput]');
        await macro.scrollIntoViewIfNeeded();
        const after=await macro.boundingBox(),footer=await settings.locator('.lg-footer').boundingBox();
        assert(after.y+after.height<=footer.y);
      }
      if(label==='同步'){
        const panel=settings.getByRole('tabpanel',{name:label});
        await panel.getByRole('button',{name:'拍摄并扫描配对二维码'}).waitFor();
        await panel.locator('[role=status]').filter({hasText:'Token 仅在本次会话中保留'}).waitFor();
        assert(await page.evaluate(()=>[...calciteTest.filesystem.store.keys()].some(key=>key.startsWith('DATA:CalciteVaults/测试/'))));
        for(const theme of ['dark','light']) {
          const actions=await panel.locator('.sync-mobile-action').evaluateAll((buttons,theme)=>{
            const root=document.documentElement,old=root.dataset.theme;
            root.dataset.theme=theme;
            const styles=buttons.map(button=>{
              const css=getComputedStyle(button);
              return {height:button.getBoundingClientRect().height,border:css.borderTopWidth,background:css.backgroundColor};
            });
            root.dataset.theme=old;
            return styles;
          },theme);
          assert.equal(actions.length,2);
          assert(actions.every(({height,border,background})=>height>=40&&border==='1px'&&background!=='rgba(0, 0, 0, 0)'));
        }
        await panel.locator('[data-scan-file]').setInputFiles({name:'invalid.png',mimeType:'image/png',
          buffer:await QRCode.toBuffer('unrelated QR code')});
        const feedback='未识别到有效配对二维码';
        await panel.locator('[role=status]').filter({hasText:feedback}).waitFor();
        await page.locator('#toast').filter({hasText:feedback}).waitFor();
        const {writePacket}=await import('../shared/core/sync-config.mjs');
        const packet=writePacket('calcite-sync:',{url:'http://calcite-fixture-one.local:8128',peerName:'测试桌面',
          vaultId:'cd3c2f18-4f14-473d-a844-ba43329f976a',token:'1'.repeat(64)});
        await panel.locator('[data-scan-file]').setInputFiles({name:'pair.png',mimeType:'image/png',
          buffer:await QRCode.toBuffer(packet,{margin:3,width:420})});
        try{await panel.locator('[role=status]').filter({hasText:'已同步'}).filter({hasText:'测试桌面'}).waitFor();}
        catch(error){
          throw Error('Mobile pairing status: '+await panel.locator('[role=status]').textContent()+
            ' · '+await panel.locator('[data-log]').textContent()+' · '+[...errors,...consoleErrors].join(' | '),{cause:error});
        }
        assert.equal((await panel.locator('[role=status]').textContent()).match(/测试桌面/g)?.length,1);
        assert(!(await page.evaluate(()=>JSON.stringify([...calciteTest.prefs]))).includes('1'.repeat(64)));
      }
    }
    const orphan=settings.locator('.attachment-row').filter({hasText:'orphan.png'});
    await orphan.waitFor();
    await orphan.locator('input').tap();
    await settings.getByRole('button',{name:'移入回收站',exact:true}).tap();
    await page.locator('dialog[open]').filter({has:page.getByRole('heading',{name:'清理孤立图片'})})
      .getByRole('button',{name:'移入回收站',exact:true}).tap();
    await orphan.waitFor({state:'detached'});
    await settings.getByText('没有孤立附件').waitFor();
    assert(await settings.getByRole('button',{name:'全选'}).isDisabled());
    assert(await settings.getByRole('button',{name:'移入回收站'}).isDisabled());
    assert(await page.evaluate(()=>[...calciteTest.filesystem.store.keys()].some(key=>key.includes('/.trash/')&&key.endsWith('/orphan.png'))));
    await tap('关闭设置中心');
    const nav=drawers.getByRole('navigation',{name:'知识库导航'});
    assert.deepEqual(await nav.getByRole('button').allTextContents(),['文件','搜索','标签','图谱']);
    await page.evaluate(()=>{
      window.mobileInputFocuses=[];
      document.addEventListener('focusin',event=>{
        if(event.target.matches('#workspace-search,.graph-search input'))window.mobileInputFocuses.push(event.target.outerHTML);
      });
    });
    await nav.getByRole('button',{name:'搜索'}).tap();
    assert.deepEqual(await page.evaluate(()=>mobileInputFocuses),[]);
    assert.equal(await drawers.locator('[type=checkbox],[type=radio],fieldset').count(),0);
    await tap('正则');
    assert.equal(await drawers.getByRole('button',{name:'正则'}).getAttribute('aria-pressed'),'true');
    await tap('正则');
    await page.locator('#workspace-search').tap();
    await page.locator('#workspace-search').fill('内层正文');
    await page.locator('.search-result').filter({hasText:'内层正文'}).waitFor();
    assert((await page.evaluate(()=>mobileInputFocuses)).length>0);
    await page.evaluate(()=>{mobileInputFocuses.length=0;});
    await tap('图谱');
    await page.locator('canvas.graph-board').waitFor();
    assert.deepEqual(await page.evaluate(()=>mobileInputFocuses),[]);
    await tap('关闭图谱');
    assert.equal(await drawers.getAttribute('data-open'),'left');
    assert.equal(await drawers.locator('#workspace-search').inputValue(),'内层正文');
    assert.deepEqual(await page.evaluate(()=>mobileInputFocuses),[]);
    await tap('标签');
    await drawers.locator('#pane-title').getByText('标签索引').waitFor();
    await tap('文件');
    await drawers.locator('[data-file]').first().waitFor();
    await closeDrawer();

    await tap('更多文档操作');
    const mainCommands=await sheet.locator('.mobile-sheet-content button').allTextContents();
    assert(!mainCommands.some(label=>/另存为|复制路径|专注视图|切换自动保存|导出便携 Markdown 包|导出独立 HTML/.test(label)));
    const exportTile=sheet.getByRole('button',{name:'导出',exact:true});
    assert.equal((await exportTile.textContent()).trim(),'导出');
    assert.equal(await exportTile.locator('.lucide-chevron-right').count(),0);
    assert(await sheet.locator('.lucide-chevron-right').count()>0);
    for(const label of ['导出','格式化与目录']){
      await sheet.getByRole('button',{name:label,exact:true}).tap();
      assert.equal(await sheet.locator('h2').textContent(),label);
      assert.equal(await sheet.locator('.mobile-sheet-content').getByRole('button',{name:/^返回/}).count(),0);
      await sheet.locator('header').getByRole('button',{name:'返回',exact:true}).tap();
      assert.equal(await sheet.locator('h2').textContent(),'文档操作');
      assert(await sheet.locator('[data-sheet-back]').isHidden());
      assert.deepEqual(await sheet.locator('.mobile-sheet-content button').allTextContents(),mainCommands);
    }
    await sheet.getByRole('button',{name:'导出',exact:true}).tap();
    for(const name of ['导出 PDF','导出阅读长图','导出独立 HTML','导出便携 Markdown 包'])
      assert(await sheet.getByRole('button',{name,exact:true}).isVisible());
    await sheet.getByRole('button',{name:'导出 PDF',exact:true}).tap();
    await page.locator('#toast').filter({hasText:'另存为 PDF'}).waitFor();
    assert(await page.evaluate(()=>calciteTest.outputs.some(value=>value.print&&
      value.html.includes('<h1')&&value.html.includes('<table')&&value.html.includes('<style>'))));
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'导出',exact:true}).tap();
    await sheet.getByRole('button',{name:'导出便携 Markdown 包',exact:true}).tap();
    await page.locator('#toast').filter({hasText:'Markdown 便携包已导出'}).waitFor();
    assert(await page.evaluate(()=>[...calciteTest.filesystem.store.keys()].some(key=>key.endsWith('-Markdown.zip'))));
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'导出',exact:true}).tap();
    await sheet.getByRole('button',{name:'打开导出中心',exact:true}).tap();
    const exportDialog=page.locator('.export-center[open]');
    await exportDialog.waitFor();
    assert.deepEqual(await exportDialog.locator('[name=format] option').evaluateAll(rows=>rows.map(row=>row.value)),['pdf','html','png']);
    await exportDialog.locator('[name=format]').selectOption('html');
    await exportDialog.getByRole('tab',{name:'实时预览'}).tap();
    await exportDialog.locator('iframe').waitFor();
    await exportDialog.getByRole('tab',{name:'参数设置'}).tap();
    assert(await contained());
    await exportDialog.getByRole('button',{name:'保存导出'}).tap();
    await page.locator('#toast').filter({hasText:'HTML 已导出'}).waitFor();
    assert(await page.evaluate(()=>[...calciteTest.filesystem.store.keys()].some(key=>key.startsWith('DOCUMENTS:CalciteExports/')&&key.endsWith('.html'))));
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'导出',exact:true}).tap();
    await sheet.getByRole('button',{name:'导出阅读长图',exact:true}).tap();
    await page.locator('dialog[open]').getByRole('button',{name:'导出 PNG',exact:true}).tap();
    await page.locator('#toast').filter({hasText:'PNG 已导出'}).waitFor();
    const signature=await page.evaluate(()=>{
      const file=[...calciteTest.filesystem.store].find(([key])=>key.startsWith('DOCUMENTS:CalciteExports/')&&key.endsWith('.png'));
      return file&&file[1].data.slice(0,11);
    });
    assert.equal(signature,'iVBORw0KGgo');
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'导出',exact:true}).tap();
    await sheet.getByRole('button',{name:'一键复制为富文本',exact:true}).tap();
    await page.locator('#toast').filter({hasText:'富文本已复制'}).waitFor();
    assert(await page.evaluate(()=>calciteTest.outputs.some(value=>value.html?.includes('<h1'))));

    await tap('打开文件抽屉');
    await tap('图谱');
    const board=page.locator('canvas.graph-board');
    await board.waitFor();
    const bounds=await board.boundingBox(),x=Math.round(bounds.x+bounds.width/2),y=Math.round(bounds.y+bounds.height/2);
    await touch(cdp,'touchStart',[[x,y,5]]);
    await touch(cdp,'touchMove',[[x+35,y+15,5]]);
    await board.locator('xpath=self::*[@data-dragging]').waitFor();
    await touch(cdp,'touchEnd',[]);
    await touch(cdp,'touchStart',[[x-20,y,5],[x+20,y,6]]);
    await touch(cdp,'touchMove',[[x-45,y,5],[x+45,y,6]]);
    await board.locator('xpath=self::*[@data-dragging]').waitFor();
    await touch(cdp,'touchEnd',[]);
    assert(await contained());
    await tap('关闭图谱');
    await closeDrawer();

    await page.evaluate(()=>calciteTest.filesystem.writeFile({directory:'DATA',
      path:'CalciteVaults/测试/C2 (同步冲突 2026-11-21 0900).md',data:btoa('# Adopted mobile conflict\n')}));
    await tap('打开同步状态');
    await syncCard.getByText('最后同步',{exact:true}).waitFor();
    await syncCard.getByText('待同步版本',{exact:true}).waitFor();
    assert.notEqual(await syncCard.locator('[data-last-sync]').textContent(),'暂无记录');
    const negotiateCount=()=>page.evaluate(()=>calciteTest.fixture.requests.filter(url=>url.endsWith('/negotiate')).length);
    const beforeSync=await negotiateCount();
    await tap('立即同步');
    await syncCard.getByRole('button',{name:'查看同步冲突'}).waitFor();
    assert(await negotiateCount()>beforeSync);
    await tap('查看同步冲突');
    const conflict=page.locator('.history-dialog[open]');
    const opened=()=>conflict.getByRole('heading',{name:'同步冲突',exact:true}).waitFor();
    await opened();
    const compareBox=await conflict.boundingBox();
    assert(compareBox.height>0.9*await page.evaluate(()=>innerHeight));
    await tap('关闭版本历史');
    await tap('打开同步状态');
    await opened();
    await tap('关闭版本历史');
    await tap('打开文件抽屉');
    await drawers.locator('[data-file]').getByText('C2.md',{exact:true}).tap();
    await page.locator('#mobile-drawers[data-open]').waitFor({state:'detached'});
    await tap('查看同步冲突');
    await opened();
    await tap('关闭版本历史');
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'设置中心',exact:true}).tap();
    await settings.getByRole('tab',{name:'同步',exact:true}).tap();
    const syncPanel=settings.getByRole('tabpanel',{name:'同步',exact:true});
    await syncPanel.getByRole('heading',{name:'发现冲突 (1)',exact:true}).waitFor();
    assert(await syncPanel.locator('.lg-settings-scroll').evaluate(node=>node.firstElementChild.matches('[data-conflicts]')));
    await syncPanel.getByRole('button',{name:'立即处理冲突',exact:true}).tap();
    await syncPanel.getByRole('button',{name:'查看差异'}).tap();
    await opened();
    await conflict.getByText('查看完整版本',{exact:true}).tap();
    const columns=await conflict.locator('.sync-versions').evaluate(element=>getComputedStyle(element).gridTemplateColumns);
    assert.equal(columns.split(' ').length,1);
    assert(await contained());
    await tap('关闭版本历史');
    await syncPanel.getByRole('button',{name:'一键归档清理'}).tap();
    await syncPanel.locator('[data-conflicts]').waitFor({state:'hidden'});
    await tap('关闭设置中心');
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'版本历史',exact:true}).tap();
    await conflict.getByRole('heading',{name:'版本历史',exact:true}).waitFor();
    const version=conflict.getByRole('combobox',{name:'比较版本'});
    await version.selectOption({label:await version.locator('option').filter({hasText:'归档的历史冲突副本'}).textContent()});
    await conflict.locator('.history-diff').getByText(/Adopted mobile conflict/).waitFor();
    await conflict.getByRole('button',{name:'另存为新笔记'}).tap();
    await conflict.waitFor({state:'detached'});
    await page.waitForFunction(()=>[...calciteTest.filesystem.store.keys()].some(key=>key.endsWith('/C2（历史版本）.md')));
    await tap('打开文件抽屉');
    await drawers.locator('[data-file]').getByText('C2.md',{exact:true}).tap();
    await page.locator('#mobile-drawers[data-open]').waitFor({state:'detached'});
    await tap('更多文档操作');
    await sheet.getByRole('button',{name:'版本历史',exact:true}).tap();
    await conflict.getByRole('heading',{name:'版本历史',exact:true}).waitFor();
    await version.selectOption({label:await version.locator('option').filter({hasText:'归档的历史冲突副本'}).textContent()});
    await conflict.getByRole('button',{name:'恢复此版本'}).tap();
    await conflict.waitFor({state:'detached'});
    await page.waitForFunction(()=>[...calciteTest.filesystem.store].some(([key,entry])=>
      key.endsWith('/C2.md')&&atob(entry.data).includes('Adopted mobile conflict')));
    assert(await page.evaluate(()=>[...calciteTest.filesystem.store.keys()].some(key=>key.includes('/.trash/')&&key.includes('C2 (同步冲突'))));

    async function manageVault() {
      await tap('打开文件抽屉');
      await drawers.locator('.mobile-vault-trigger').tap();
      await sheet.getByRole('heading',{name:'知识库管理'}).waitFor();
    }
    const card=name=>sheet.getByRole('article',{name,exact:true});
    await manageVault();
    await card('测试').getByText('当前',{exact:true}).waitFor();
    await tap('新建空白知识库');
    await page.getByRole('textbox',{name:'知识库名称'}).fill('第二知识库');
    await tap('确定');
    await page.locator('#workspace-name').filter({hasText:'第二知识库'}).waitFor({state:'attached'});
    await manageVault();
    await card('第二知识库').getByText(/0 篇文档/).waitFor();
    await card('第二知识库').getByText('仅本地',{exact:true}).waitFor();
    await card('第二知识库').getByRole('button',{name:'重命名'}).tap();
    await page.getByRole('textbox',{name:'知识库名称'}).fill('重命名知识库');
    await tap('确定');
    await card('重命名知识库').getByText('当前',{exact:true}).waitFor();
    await tap('关闭操作表单');
    await tap('打开文件抽屉');
    await drawers.getByRole('button',{name:'新建文件夹',exact:true}).tap();
    await page.getByRole('textbox',{name:'名称',exact:true}).fill('我的文件夹');
    await tap('确定');
    await drawers.getByText('我的文件夹',{exact:true}).waitFor();
    await drawers.getByRole('button',{name:'新建笔记',exact:true}).tap();
    await page.getByRole('textbox',{name:'名称',exact:true}).fill('手机笔记');
    await tap('确定');
    await page.locator('.mobile-title').getByText('手机笔记.md').waitFor();
    await drawers.locator('.sidebar').waitFor({state:'hidden'});
    await manageVault();
    await card('重命名知识库').getByText(/1 篇文档/).waitFor();
    await tap('切换到 测试');
    await page.locator('#workspace-name').filter({hasText:'测试'}).waitFor({state:'attached'});
    await manageVault();
    await card('重命名知识库').getByRole('button',{name:'删除',exact:true}).tap();
    await page.getByRole('heading',{name:'删除知识库',exact:true}).waitFor();
    await tap('取消');
    await card('重命名知识库').waitFor();
    await card('重命名知识库').getByRole('button',{name:'删除',exact:true}).tap();
    await tap('确认删除');
    await card('重命名知识库').waitFor({state:'detached'});
    const {writePacket}=await import('../shared/core/sync-config.mjs');
    const secondPacket=writePacket('calcite-sync:',{url:'http://calcite-fixture-two.local:8128',peerName:'另一台桌面',
      vaultId:'cd3c2f18-4f14-473d-a844-ba43329f976a',token:'2'.repeat(64)});
    await tap('配对新建');
    await page.getByRole('textbox',{name:'知识库名称'}).fill('配对知识库');
    await sheet.locator('input[type=file]').setInputFiles({name:'pair.png',mimeType:'image/png',
      buffer:await QRCode.toBuffer(secondPacket,{margin:3,width:420})});
    await sheet.getByText('已读取配对二维码。',{exact:true}).waitFor();
    await tap('新建并同步');
    await sheet.waitFor({state:'hidden'});
    await manageVault();
    await card('配对知识库').getByText('已同步',{exact:true}).waitFor();
    await tap('切换到 测试');
    await page.locator('#workspace-name').filter({hasText:'测试'}).waitFor({state:'attached'});
    await manageVault();
    await card('配对知识库').getByRole('button',{name:'重命名',exact:true}).tap();
    await page.getByRole('textbox',{name:'知识库名称'}).fill('已配对的新库');
    await tap('确定');
    await card('已配对的新库').getByText('已同步',{exact:true}).waitFor();
    await card('测试').getByText('当前',{exact:true}).waitFor();
    const pairIsolation=await page.evaluate(()=>{
      const get=name=>JSON.parse(calciteTest.prefs.get('git:/CalciteVaults/'+name));
      return {original:get('测试'),second:get('已配对的新库'),oldName:get('配对知识库'),deleted:get('重命名知识库')};
    });
    assert.equal(pairIsolation.original.settings.peerUrl,'http://calcite-fixture-one.local:8128');
    assert.equal(pairIsolation.second.settings.peerUrl,'http://calcite-fixture-two.local:8128');
    assert.notEqual(pairIsolation.original.vaultId,pairIsolation.second.vaultId);
    assert.equal(pairIsolation.oldName,null);
    assert.equal(pairIsolation.deleted,null);
    await tap('关闭操作表单');
    await tap('打开同步状态');
    await tap('同步设置');
    const finalSync=settings.getByRole('tabpanel',{name:'同步',exact:true});
    await finalSync.locator('input[name=auto]').uncheck();
    await finalSync.getByRole('button',{name:'保存同步设置'}).tap();
    await finalSync.locator('[role=status]').filter({hasText:'设置已保存'}).waitFor();
    await page.evaluate(fixture=>Object.assign(calciteTest.fixture,fixture),await progressiveFixture());
    await finalSync.getByRole('button',{name:'立即同步',exact:true}).tap();
    await page.waitForFunction(()=>calciteTest.fixture.waiting);
    try {
      await finalSync.locator('[role=status]').filter({hasText:'正在写入工作区文件'}).waitFor();
      await tap('关闭设置中心');
      await tap('打开文件抽屉');
      await drawers.getByText('Batch-000.md',{exact:true}).tap();
      await page.locator('#document-name').filter({hasText:'Batch-000.md'}).waitFor({state:'attached'});
    }finally{await page.evaluate(()=>calciteTest.fixture.release());}
    await page.locator('[data-mobile-sync] [data-state=synced]').waitFor();
    assert.equal(await page.evaluate(()=>calciteTest.fixture.written),126);
    assert.deepEqual(errors,[]);
    const fresh=await browser.newContext({viewport:{width:320,height:650},hasTouch:true,isMobile:true});
    await fresh.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+',{});'});
    const welcome=await fresh.newPage();
    await welcome.goto(url);
    await welcome.locator('#app:not([inert])').waitFor();
    await welcome.getByRole('button',{name:'切换到阅读',exact:true}).tap();
    await welcome.locator('#reading h1').getByText('欢迎使用 Calcite').waitFor();
    const guide=await welcome.locator('#reading').innerText();
    assert.match(guide,/配对新建/);
    assert.doesNotMatch(guide,/Ctrl|右下角/);
    await fresh.close();

    const broken=await browser.newContext({viewport:{width:920,height:650},hasTouch:true,isMobile:true});
    const brokenSeed={'CalciteVaults/旧库/迁移笔记.md':Buffer.from('# 迁移成功').toString('base64'),
      'CalciteVaults/旧库/.git':Buffer.from('invalid Git metadata').toString('base64')};
    const oldVault='/Documents/CalciteVaults/旧库';
    const options={prefs:{
      vault:'file:///storage/emulated/0'+oldVault.replace('/旧库','//'+encodeURIComponent('旧库'))+'/',
      session:{mobileRoot:oldVault,activeId:'migrating',mode:'source',closedFiles:[oldVault+'/关闭的笔记.md'],
        tabs:[{id:'migrating',path:oldVault+'/迁移笔记.md',name:'迁移笔记.md',text:'# 迁移草稿',saved:'# 迁移成功'}]}
    },holdGit:true};
    await broken.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+','+
      JSON.stringify(brokenSeed)+','+JSON.stringify(options)+');'});
    const recovered=await broken.newPage();
    await recovered.goto(url);
    await recovered.locator('#app:not([inert])').waitFor();
    await recovered.locator('#source-editor .cm-content').getByText('迁移草稿').waitFor();
    await recovered.waitForFunction(()=>JSON.parse(calciteTest.prefs.get('session')).closedFiles[0]==='/CalciteVaults/旧库/关闭的笔记.md');
    assert(await recovered.evaluate(()=>calciteTest.filesystem.store.has('DATA:CalciteVaults/旧库/迁移笔记.md')));
    await recovered.evaluate(()=>calciteTest.fixture.releaseGit());
    await recovered.locator('[data-mobile-sync] [data-state="error"]').waitFor();
    assert(await recovered.locator('footer').isHidden());
    assert.equal(await recovered.locator('.workspace > :is(.sidebar,.outline-panel)').count(),0);
    await recovered.evaluate(()=>{
      document.documentElement.style.setProperty('--safe-area-inset-top','27px');
      document.documentElement.style.setProperty('--safe-area-inset-bottom','21px');
    });
    assert.equal(await recovered.locator('.titlebar').evaluate(node=>getComputedStyle(node).paddingTop),'27px');
    assert.equal(await recovered.locator('#source-editor .cm-scroller').evaluate(node=>getComputedStyle(node).paddingBottom),'21px');
    await recovered.getByRole('button',{name:'打开同步状态',exact:true}).tap();
    await recovered.locator('.mobile-sheet[open]').getByText(/无法初始化此知识库的同步.*\.git/).waitFor();
    await broken.close();

    const fallback=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    await fallback.addInitScript({content:'('+registerNativeMock.toString()+')('+memoryFilesystem.toString()+
      ',{},{"prefs":{"vault":"Documents/CalciteVaults/找不到/"}});'});
    const defaultVault=await fallback.newPage();
    await defaultVault.goto(url);
    await defaultVault.locator('#app:not([inert])').waitFor();
    assert.equal(await defaultVault.evaluate(()=>JSON.parse(calciteTest.prefs.get('vault'))),'/CalciteVaults/我的笔记');
    await fallback.close();
    await externalFileSmoke(browser,url);
    console.log('Mobile UI passed: vault lifecycle and isolated pairing, direct sync, four navigation entries, first-run guide, task lists, touch editing, exports, graph gestures, and conflict resolution.');
  }finally{await browser?.close();server.close();}
}

if(require.main===module)(async()=>{await gitSmoke();if(!process.argv.includes('--git-only'))await uiSmoke();})()
  .catch(error=>{console.error(error);process.exitCode=1;});

async function assertLanguageCard(settings) {
  const language=settings.locator('select[name=language]');
  await language.waitFor();
  for(const theme of ['light','dark']){
    assert(await language.evaluate((select,theme)=>{
      const root=document.documentElement,previous=root.dataset.theme;
      try{
        root.dataset.theme=theme;
        const image=select.closest('form').elements.attachmentStrategy;
        const card=select.closest('.lg-group'),other=image.closest('.lg-group');
        const rect=select.getBoundingClientRect(),bounds=card.getBoundingClientRect(),label=select.parentElement.getBoundingClientRect();
        const css=getComputedStyle(select),reference=getComputedStyle(image);
        return card.closest('.lg-settings-scroll')&&rect.left>12&&Math.abs(rect.width-label.width)<1&&
          Math.abs(bounds.left-other.getBoundingClientRect().left)<1&&css.boxSizing==='border-box'&&
          ['height','fontSize','paddingInline','borderRadius','appearance','backgroundImage'].every(key=>css[key]===reference[key]);
      }finally{root.dataset.theme=previous;}
    },theme));
  }
}

async function assertOutlineSheet(page,{outline,backlinks,filter,close,scrolls=false}) {
  const panel=page.locator('#mobile-drawers[data-open="right"] #right-sidebar');
  await panel.waitFor();
  const tabs=panel.getByRole('tablist');
  await tabs.getByRole('tab',{name:outline,exact:true}).tap();
  const search=panel.getByRole('searchbox',{name:filter});
  const list=panel.locator('#outline');
  const first=list.locator('.outline-row').first();
  await first.waitFor();
  const closeButton=panel.getByRole('button',{name:close,exact:true});
  assert.equal(await panel.locator('[data-desktop-inspector-toggle], .lucide-panel-right-close').count(),0);
  assert.equal(await closeButton.locator('.lucide-x').count(),1);
  assert.equal(await panel.locator('.mobile-inspector-handle').isVisible(),true);
  const closeSize=await closeButton.boundingBox();
  assert.deepEqual([closeSize.width,closeSize.height],[40,40]);
  const geometry=await panel.evaluate(node=>{
    const bounds=node.getBoundingClientRect();
    const search=node.querySelector('.outline-search').getBoundingClientRect();
    const list=node.querySelector('#outline').getBoundingClientRect();
    const first=node.querySelector('.outline-row').getBoundingClientRect();
    const css=getComputedStyle(node);
    return {width:bounds.width/innerWidth,height:bounds.height/innerHeight,left:bounds.left,
      bottom:bounds.bottom-innerHeight,viewport:innerWidth,position:css.position,transform:css.transform,
      radius:css.borderTopLeftRadius,bottomRadius:css.borderBottomLeftRadius,
      safeBottom:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom'))||0,
      bottomPadding:parseFloat(css.paddingBottom),
      searchBottom:search.bottom,listTop:list.top,firstTop:first.top,firstBottom:first.bottom,listBottom:list.bottom};
  });
  assert.equal(geometry.viewport,360);
  assert(geometry.width>=.95&&geometry.width<=1&&geometry.left>=0&&geometry.left<=8,JSON.stringify(geometry));
  assert(geometry.height>=.70&&geometry.height<=.78,JSON.stringify(geometry));
  assert(Math.abs(geometry.bottom)<=1,JSON.stringify(geometry));
  assert.equal(geometry.position,'fixed');
  assert.equal(geometry.transform,'none');
  assert.equal(geometry.radius,'20px');
  assert.equal(geometry.bottomRadius,'0px');
  assert(geometry.bottomPadding>=geometry.safeBottom+8,JSON.stringify(geometry));
  assert.equal(await list.evaluate(node=>getComputedStyle(node).overflowY),'auto');
  if(scrolls)assert(await list.evaluate(node=>node.scrollHeight>node.clientHeight));
  assert(geometry.searchBottom<=geometry.listTop&&geometry.listTop+7<=geometry.firstTop&&
    geometry.firstBottom<=geometry.listBottom,JSON.stringify(geometry));
  const title=await first.locator('.outline-item').textContent();
  await search.fill(title);
  await first.locator('.outline-item').getByText(title,{exact:true}).waitFor();
  await search.fill('');
  const deepest=list.locator('.outline-row[data-level="6"] .outline-item span').first();
  if(await deepest.count()){
    assert(await deepest.evaluate(node=>{
      const style=getComputedStyle(node);
      return style.whiteSpace==='normal'&&node.scrollWidth<=node.clientWidth+1&&
        parseFloat(getComputedStyle(node.closest('.outline-row')).paddingInlineStart)<=53;
    }));
  }
  const linkTab=tabs.getByRole('tab',{name:new RegExp('^'+backlinks+' \\(\\d+\\)$')});
  await linkTab.tap();
  await panel.locator('#backlinks-view').waitFor();
  assert.equal(await search.isHidden(),true);
  assert(await linkTab.evaluate(node=>{
    const range=document.createRange();
    range.selectNodeContents(node);
    const text=range.getBoundingClientRect(),button=node.getBoundingClientRect();
    return text.left>=button.left&&text.right<=button.right&&getComputedStyle(node).textOverflow==='clip';
  }));
  await tabs.getByRole('tab',{name:outline,exact:true}).tap();
  await closeButton.tap();
  await panel.waitFor({state:'hidden'});
}

module.exports={memoryFilesystem,registerNativeMock,serveDist,chromiumOptions,assertLanguageCard,assertOutlineSheet};
