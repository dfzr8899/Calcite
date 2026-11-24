const {getLocale, t:tr, resolveLocale, setLocale, setStrictMessages}=require("../shared/i18n/index.mjs");
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, Tray, nativeTheme, clipboard, safeStorage, net } = require('electron');
const {normalizeLineEndings}=require('../shared/text-files.mjs');
const {planLinkRefactor,planCanvasLinkRefactor}=require('../shared/core/link-refactor.mjs');
const {guardedSave}=require('../shared/core/guarded-save.mjs');
const {readSnapshot,refactorText,activityFor}=require('./data-safety.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const space = require('./workspace.cjs');
const {printSettings}=require('./export-settings.cjs');
const {portableMarkdown,orphanPictures,imageExtension}=require('./attachment-service.cjs');
const {zipSync}=require('fflate');
const {createVaultService} = require('./vault-service.cjs');
const {createGitSync}=require('./git-sync.cjs');
const {validArguments,documentType,markdown:md,MAX_NOTE,MAX_CANVAS} = require('./ipc-schema.cjs');
const history = () => space.historyStore(path.join(app.getPath('userData'), 'backups'));
const {GitEngine}=require('./git-engine.cjs');
const {isSyncVersion}=require('../shared/core/sync-history.mjs');
const {readConflictFile}=require('../shared/core/sync-conflicts.mjs');
let fileQueue = Promise.resolve();
function serialized(handler) {
  return (...args) => {
    const next = fileQueue.then(() => handler(...args));
    fileQueue = next.catch(() => {});
    return next;
  };
}
let win, tray, startupConfig, rendererReady = false, windowPainted = false;
let root = '', closing = false, configQueue = Promise.resolve();
let pendingExternal = [];
const vault=createVaultService({queue:task=>serialized(task)(),publish:event=>{
  if (rendererReady&&win&&!win.isDestroyed()) win.webContents.send('vault:external-change',event);
  else pendingExternal.push(event);
  if(event.source!=='sync')gitSync.arm();
},fail:console.error,onInternal:()=>gitSync.arm(),onAssetChange:()=>gitSync.arm()});
const gitSync=createGitSync({safeStorage,net,run:task=>serialized(task)(),network:!process.env.CALCITE_TEST,allowLocal:!!process.env.CALCITE_TEST,
  archive:file=>shell.trashItem(file),
  publish:value=>{if(rendererReady&&win&&!win.isDestroyed())win.webContents.send('sync:state',value);},
  async read(target){return (await config()).gitSync?.[pathKey(target)];},
  async write(target,value){const previous=(await config()).gitSync||{};await saveConfig({gitSync:{...previous,[pathKey(target)]:value}});},
  reserve(target,rows){if(target===root)vault.reserve(rows);},
  async applied(target,rows){
    if(target!==root)return;
    const written=rows.filter(row=>row.next&&md.test(row.file)).map(row=>({file:row.file,
      text:Buffer.isBuffer(row.next)&&row.next.length<=MAX_NOTE?row.next.toString('utf8'):undefined}));
    const directories=new Set();
    for(const {file} of written)for(let dir=path.dirname(file);dir!==root&&space.within(root,dir);dir=path.dirname(dir))directories.add(dir);
    await vault.internal({source:'sync',written,directories:[...directories],removed:rows.filter(row=>!row.next&&md.test(row.file)).map(row=>row.file)});
  }});
const grants = new Map();
const pathKey = value => process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
app.setName('Calcite');
if (process.platform==='win32') app.setAppUserModelId('io.calcite.notes');
app.setPath('userData',process.env.CALCITE_DATA_DIR||path.join(app.getPath('appData'),'Calcite'));
const appIcon = path.join(__dirname,'../assets',process.platform==='win32'?'icon.ico':'icon.png');
const entry = path.join(__dirname,'../dist/index.html');
const pendingFiles = new Set();
const fileArguments = (argv,cwd) => argv.filter(p=>typeof p==='string'&&md.test(p)&&!p.startsWith('-')).slice(0,512).map(p=>path.resolve(cwd,p));
const launchFiles = fileArguments(process.argv.slice(app.isPackaged?1:2),process.cwd());
const primaryInstance = app.requestSingleInstanceLock({paths:launchFiles});
if (!primaryInstance) app.quit();
const pendingLaunch = new Set(launchFiles);
const enqueueLaunch = serialized(async()=>{
  await startupConfig;
  const paths=[...pendingLaunch];
  pendingLaunch.clear();
  const opened=await authorizeFiles(paths);
  for (const file of opened) pendingFiles.add(file);
  if (rendererReady && pendingFiles.size) send({type:'open-files',paths:takePendingFiles()});
});
function takePendingFiles() {
  const paths = [...pendingFiles];
  pendingFiles.clear();
  return paths;
}
function showWindow() {
  if (!win || win.isDestroyed() || !windowPainted) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
app.on('second-instance',(_,argv,cwd,data)=>{
  const files=Array.isArray(data?.paths)?data.paths:argv.slice(app.isPackaged?1:2);
  for (const file of fileArguments(files,cwd)) pendingLaunch.add(file);
  if (startupConfig) enqueueLaunch().catch(console.error);
  if (!process.env.CALCITE_TEST) showWindow();
});
protocol.registerSchemesAsPrivileged([{scheme:'note-image',privileges:{standard:true,secure:true}}]);
const inVault = value => !!root&&space.within(root,value);
const allowed = value => inVault(value)||grants.has(pathKey(value));
async function check(file,image=false) {
  if (!path.isAbsolute(file)||file.includes('\0')) throw Error(tr("main.invalidFilePath"));
  const permitted = value => image ? inVault(value)||[...grants.values()].some(note=>
    md.test(note)&&space.within(path.dirname(note),value)) : allowed(value);
  if (!permitted(file)) throw Error(tr("main.thisPathIsNotAuthorizedOpenThe"));
  const real=await fs.realpath(file);
  if (!permitted(real)) throw Error(tr("main.symlinksOutsideTheWorkspaceCannotBeAccessed"));
  return real;
}

async function canonicalDocument(file,create=false) {
  if (typeof file!=='string'||!path.isAbsolute(file)||!documentType.test(file)) throw Error(tr("main.selectAMarkdownOrCanvasFile"));
  let real;
  try {real=await fs.realpath(file);}
  catch(error) {
    if (!create||error.code!=='ENOENT') throw error;
    return path.join(await fs.realpath(path.dirname(file)),path.basename(file));
  }
  if (!documentType.test(real)||!(await fs.stat(real)).isFile()) throw Error(tr("main.invalidDocumentFile"));
  return real;
}

function grant(file) {
  if (!inVault(file)) grants.set(pathKey(file),file);
}
const grantSnapshot = () => [...grants.values()];
async function authorizeFiles(files) {
  const opened=[];
  const count=grants.size;
  for (const selected of files) {
    const file=await canonicalDocument(selected).catch(()=>null);
    if (!file) continue;
    grant(file);
    opened.push(file);
  }
  if (grants.size!==count) await saveConfig({grantedFiles:grantSnapshot()});
  return opened;
}
const imageMime = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',avif:'image/avif',bmp:'image/bmp'};
async function readLocalImage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'note-image:' || parsed.hostname !== 'local') throw Error(tr("main.invalidLocalImageLink"));
  const file = await check(decodeURIComponent(parsed.pathname.slice(1)),true);
  const mime = imageMime[path.extname(file).slice(1).toLowerCase()];
  const handle = await fs.open(file,'r');
  try {
    const stat=await handle.stat();
    if (!mime || !stat.isFile() || !stat.size || stat.size>32*1024*1024) throw Error(tr("main.couldNotReadTheLocalImage"));
    const bytes=await handle.readFile();
    if (!validImage(mime,bytes)) throw Error(tr("main.invalidLocalImageFormat"));
    return {mime,bytes};
  } finally { await handle.close(); }
}
function validImage(mime,bytes) {
  if (!bytes.length||bytes.length>32*1024*1024)return false;
  const ascii=(start,end)=>bytes.toString('ascii',start,end);
  switch (mime) {
    case 'image/png': return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    case 'image/jpeg': return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    case 'image/gif': return ['GIF87a','GIF89a'].includes(ascii(0,6));
    case 'image/webp': return ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP';
    case 'image/avif': return ascii(4,8)==='ftyp'&&/avi[fs]/.test(ascii(8,64));
    case 'image/bmp': return ascii(0,2)==='BM';
    case 'image/svg+xml': return /^<svg(?:\s|>)/i.test(bytes.toString('utf8',0,65536).replace(/^(?:\s|<\?xml[^?]*\?>|<!--[\s\S]*?-->)+/i,''));
    default: return false;
  }
}
handleMain('export-image',async (_,url)=>{
  const {mime,bytes} = await readLocalImage(url);
  return 'data:'+mime+';base64,'+bytes.toString('base64');
});
const configPath = () => path.join(app.getPath('userData'),'workspace.json');
async function config() { try {return JSON.parse(await fs.readFile(configPath(),'utf8'));} catch {return {};} }
function saveConfig(extra) { const next=configQueue.then(async()=>{await space.atomicWriteFile(configPath(),JSON.stringify({...await config(),...extra}));});configQueue=next.catch(()=>{});return next; }
function send(action) { if (rendererReady && win && !win.isDestroyed()) win.webContents.send('action', action); }
function fromMainWindow(event) {
  if (!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame) return false;
  try { return path.relative(entry,fileURLToPath(event.senderFrame.url))===''; }
  catch { return false; }
}
function handleMain(channel,handler) {
  ipcMain.handle(channel,(event,...args)=>{
    if (!fromMainWindow(event)) throw Error(tr("main.thisActionIsOnlyAvailableFromThe"));
    if (!validArguments(channel,args)) throw Error(tr("main.theRequestParametersAreInvalidOrExceed"));
    return handler(event,...args);
  });
}
function restrictedSession(session) {
  if (!session||!validArguments('session',[session])) return undefined;
  const tabs=session.tabs.flatMap(tab=>{
    if (!tab.path||allowed(tab.path)) return [tab];
    return tab.text!==tab.saved||tab.deleted?[{...tab,path:null,mtime:null,saved:'',deleted:false}]:[];
  });
  return {...session,tabs};
}
const windowsBackdrop = process.platform==='win32' && Number(process.getSystemVersion().split('.')[2])>=22621;
const macVibrancy = process.platform==='darwin';
const clearWindow = '#00000000';
const opaqueWindow = () => nativeTheme.shouldUseDarkColors ? '#14161c' : '#eceff4';
let windowMaterial;

function setWindowAppearance({theme,glass,reduceTransparency}) {
  nativeTheme.themeSource = theme;
  const material = glass==='solid' || reduceTransparency || nativeTheme.inForcedColorsMode ? 'solid'
    : windowsBackdrop ? (glass==='mica'?'mica':'acrylic')
    : macVibrancy && glass==='liquid' ? 'vibrancy' : 'css';
  if (windowMaterial!==material) {
    if (windowsBackdrop) win.setBackgroundMaterial(['acrylic','mica'].includes(material)?material:'none');
    if (macVibrancy) win.setVibrancy(material==='vibrancy'?'under-window':null);
    windowMaterial = material;
  }
  const background = material==='solid'||material==='css' ? opaqueWindow() : clearWindow;
  if (win.getBackgroundColor().toLowerCase()!==background) win.setBackgroundColor(background);
  return {material,theme:nativeTheme.shouldUseDarkColors?'dark':'light'};
}

handleMain('window:set-appearance',(_,settings)=>setWindowAppearance(settings));
function refreshApplicationMenu() {
  if(tray){
    tray.setToolTip(rendererReady?tr("main.calciteRunning"):tr("main.calciteStarting"));
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:tr("main.showCalcite"),click:showWindow},
      {label:tr("main.openMarkdown"),click:()=>{showWindow();send('open');}},
      {type:'separator'},
      {label:tr("main.quitCalcite"),click:()=>win?.close()}
    ]));
  }
  const command=(key,action)=>({label:tr(key),click:()=>send(action)});
  const role=(key,value)=>({label:tr(key),role:value});
  const separator={type:'separator'};
  const items=[
    {label:tr('main.files'),submenu:[
      command('main.newNote','new'),command('main.openNote','open'),command('main.openFolder','folder'),separator,
      command('main.save','save'),command('main.saveAs','saveAs'),command('main.exportPdf','pdf'),separator,command('main.quit','quit')
    ]},
    {label:tr('main.edit'),submenu:[
      role('main.undo','undo'),role('main.redo','redo'),separator,role('main.cut','cut'),role('main.copy','copy'),
      role('main.paste','paste'),role('main.selectAll','selectAll')
    ]},
    {label:tr('main.view'),submenu:[
      command('main.commandPalette','palette'),command('main.find','find'),command('main.toggleSidebar','sidebar'),
      command('main.focusMode','focus'),role('main.fullScreen','togglefullscreen'),role('main.zoomIn','zoomIn'),
      role('main.zoomOut','zoomOut'),role('main.resetZoom','resetZoom')
    ]},
    {label:tr('main.windowMenu'),submenu:[role('main.minimize','minimize'),role('main.closeWindow','close')]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(items));
}

function systemLanguage() {
  return process.env.CALCITE_TEST ? 'zh-CN' : app.getPreferredSystemLanguages()[0] || app.getLocale();
}
handleMain('window:language',async(_, language)=>{
  await saveConfig({language});
  setLocale(resolveLocale(language,systemLanguage()));
  refreshApplicationMenu();
});
app.whenReady().then(async()=>{
  setStrictMessages(!!process.env.CALCITE_TEST || !app.isPackaged);

  if (!primaryInstance) return;
  protocol.handle('note-image', async req => {
    try {
      const image = await readLocalImage(req.url);
      return new Response(image.bytes,{headers:{'Content-Type':image.mime,'X-Content-Type-Options':'nosniff'}});
    } catch { return new Response('',{status:404}); }
  });
  const savedConfig = config();
  const language = (await savedConfig).language ?? "auto";
  setLocale(resolveLocale(language,systemLanguage()));
  startupConfig = savedConfig.then(async cfg => {
    if (typeof cfg.root==='string'&&path.isAbsolute(cfg.root)) {
      root=await fs.realpath(cfg.root).then(async file=>(await fs.stat(file)).isDirectory()?file:'').catch(()=> '');
    }
    const recovered=await recoverRefactor(root);
    vault.start(root);
    await gitSync.switchVault(root);
    if (Array.isArray(cfg.grantedFiles)) for (const file of cfg.grantedFiles.slice(0,512)) {
      const canonical=await canonicalDocument(file).catch(()=>null);
      if (canonical&&pathKey(canonical)===pathKey(file)) grant(canonical);
    }
    const session=restrictedSession(cfg.session);
    if (session) {
      for (const tab of session.tabs) if (tab.path) await check(tab.path).catch(error=>{
        if (error.code==='ENOENT'&&inVault(tab.path)) tab.deleted=true;
        else Object.assign(tab,{path:null,mtime:null,saved:'',deleted:false});
      });
    }
    return {root,recovered,features:validArguments('features',[cfg.features])?cfg.features:{},session};
  });
  const previousTheme = (await savedConfig).session?.light;
  await enqueueLaunch();
  win = new BrowserWindow({
    show: false,
    width: 1480, height: 960, minWidth: 900, minHeight: 600,
    frame: false,
    backgroundColor: windowsBackdrop||macVibrancy ? clearWindow : opaqueWindow(),
    ...(windowsBackdrop && {backgroundMaterial:'acrylic'}),
    ...(macVibrancy && {vibrancy:'under-window',visualEffectState:'active',titleBarStyle:'hiddenInset'}),
    title: 'Calcite',
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}
  });
  if (macVibrancy) win.setWindowButtonVisibility(false);
  windowMaterial = windowsBackdrop?'acrylic':macVibrancy?'vibrancy':'css';
  win.once('ready-to-show',()=>{
    windowPainted = true;
    if (!process.env.CALCITE_TEST) showWindow();
  });
  const sendWindowState = canRestore => win.webContents.send('window-state', canRestore);
  win.on('maximize', () => sendWindowState(true));
  win.on('unmaximize', () => sendWindowState(win.isFullScreen()));
  win.on('enter-full-screen', () => sendWindowState(true));
  win.on('leave-full-screen', () => sendWindowState(win.isMaximized()));
  win.on('focus', () => {gitSync.focus(true);win.webContents.send('window-focus-state',true);});
  win.on('blur', () => {gitSync.focus(false);win.webContents.send('window-focus-state',false);});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  win.webContents.on('did-start-loading',()=>{rendererReady=false;tray?.setToolTip(tr("main.calciteStarting"));});
  win.on('close',e=>{if(!closing&&rendererReady){e.preventDefault();send('quit');}});
  if (process.platform === 'win32' && !process.env.CALCITE_TEST) {
    tray = new Tray(appIcon);
    tray.setToolTip(tr("main.calciteStarting"));
    tray.on('click',showWindow);
  }
  refreshApplicationMenu();
  await win.loadFile(entry,{
    query: {language,systemLanguage:systemLanguage(),...(process.env.CALCITE_TEST?{languageTest:'1'}:{}),
      ...(typeof previousTheme==='boolean'?{legacyTheme:previousTheme?'light':'dark'}:{})}
  });
}).catch(error=>{
  dialog.showErrorBox(tr("main.calciteCouldNotStart"),error.message);
  app.exit(1);
});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>{gitSync.stop();vault.close();});
handleMain('window-control', (event, control) => {
  switch (control) {
    case 'minimize': win.minimize(); break;
    case 'maximize':
      if (win.isFullScreen()) win.setFullScreen(false);
      else if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'close': win.close(); break;
  }
});
handleMain('bootstrap',async()=>{
  const config = await startupConfig;
  return {root,config,dataPath:app.getPath('userData'),initialFiles:takePendingFiles()};
});
handleMain('renderer-ready',event=>{
  rendererReady = true;
  tray?.setToolTip(tr("main.calciteRunning"));
  for (const batch of pendingExternal) if (batch.root===root) win.webContents.send('vault:external-change',batch);
  pendingExternal=[];
  return takePendingFiles();
});
function activity(dir=root,onRecoverFailure) {
  if(!dir)throw Error(tr('main.openAWorkspaceFirst'));
  return activityFor(dir,(file,current)=>new GitEngine(dir).history.record(file,current,'undo','undo-review'),onRecoverFailure);
}

async function recoverRefactor(dir) {
  if(!dir)return false;
  let failed=false;
  const recovered=await activity(dir,(error,quarantined)=>{
    failed=true;
    console.warn('Quarantined unrecoverable refactor journal:',quarantined,error);
  }).recover();
  if(recovered)console.info(tr('dataSafety.recovered'),dir);
  return failed?'quarantined':recovered;
}

async function setVault(next,retained) {
  const recovered=await recoverRefactor(next);
  const previous=root;
  await gitSync.switchVault('');
  root=next;
  pendingExternal=[];
  vault.start(root);
  await gitSync.switchVault(root);
  const keep=new Set(retained.map(pathKey));
  for (const [key,file] of grants) if (!keep.has(key)||inVault(file)) grants.delete(key);
  const recentVaults=[...new Set([...(await config()).recentVaults||[],previous,root].filter(Boolean))]
    .filter(dir=>dir!==root);
  if(root)recentVaults.push(root);
  await saveConfig({root,recentVaults:recentVaults.slice(-12),grantedFiles:grantSnapshot()});
  return {root,recovered,tree:root?await vault.tree():[],retained:retained.filter(allowed)};
}
handleMain('folder',serialized(async(_,retained=[])=>{
  const chosen=await dialog.showOpenDialog(win,{title:tr('main.openFolder'),properties:['openDirectory']});
  if(chosen.canceled)return null;
  return setVault(await fs.realpath(chosen.filePaths[0]),retained);
}));
handleMain('recent-vaults',async()=>{
  const recent=[...new Set([root,...((await config()).recentVaults||[]).slice().reverse()].filter(Boolean))];
  return recent.map(dir=>({path:dir,name:path.basename(dir)||dir}));
});
handleMain('switch-vault',serialized(async(_,dir,retained=[])=>{
  const known=((await config()).recentVaults||[]).find(item=>pathKey(item)===pathKey(dir));
  if(!known)throw Error(tr("main.openThisVaultThroughTheFolderPicker"));
  const real=await fs.realpath(known);
  if(pathKey(real)!==pathKey(known)||!(await fs.stat(real)).isDirectory())throw Error(tr("main.theVaultPathChangedSelectItAgain"));
  return setVault(real,retained);
}));
handleMain('close-vault',serialized((_,retained=[])=>setVault('',retained)));
handleMain('tree',()=>vault.tree());
handleMain('open',serialized(async(_,defaultPath)=>{
  const chosen=await dialog.showOpenDialog(win,{title:tr('main.openNote'),defaultPath,properties:['openFile','multiSelections'],filters:[{name:'Markdown',extensions:['md','markdown','mdown']}]});
  return chosen.canceled?[]:authorizeFiles(chosen.filePaths);
}));
handleMain('release-file',serialized(async(_,file)=>{
  if (grants.delete(pathKey(file))) await saveConfig({grantedFiles:grantSnapshot()});
}));
handleMain('read',async(_,file,allowMissing)=>{
  try{
    const real=await check(file);
    if(!documentType.test(real))throw Error(tr("main.onlyMarkdownAndCanvasFilesCanBe"));
    const {raw,...disk}=await readSnapshot(real,md.test(real)?MAX_NOTE:MAX_CANVAS);
    return disk;
  }catch(error){
    if(allowMissing&&error.code==='ENOENT')return null;
    throw error;
  }
});
handleMain('save',serialized(async(_,data)=>{
  let p=data.path;
  const chosen=!p||data.saveAs;
  if(chosen){
    const r=await dialog.showSaveDialog(win,{title:tr('main.saveAs'),defaultPath:p||path.join(root||app.getPath('documents'),path.basename(data.name||'未命名.md')),filters:[{name:'Markdown',extensions:['md']}]});
    if(r.canceled)return null;
    p=await canonicalDocument(r.filePath,true);
  }
  if(!chosen&&!allowed(p))throw Error(tr("main.accessToThisFileIsNotAuthorized"));
  const limit=md.test(p)?MAX_NOTE:MAX_CANVAS;
  const text=normalizeLineEndings(p,data.text);
  if(Buffer.byteLength(text)>limit) throw Error(tr("main.theDocumentExceedsTheSizeLimit"));
  const read=async()=>{
    try {
      const real=chosen?await canonicalDocument(p):await check(p);
      if(path.relative(real,p))throw Error(tr('main.cannotWriteToASymlink'));
      return await readSnapshot(real,limit);
    }catch(error){
      if(error.code!=='ENOENT')throw error;
      const parent=path.dirname(p);
      if(path.relative(await fs.realpath(parent),parent))throw Error(tr('main.cannotWriteToASymlink'));
      return null;
    }
  };
  const cfg=await config();
  const result=await guardedSave(p,data,{read,chosen,write:(value,guard)=>space.atomicWriteFile(p,value,guard),
    archive:previous=>history().record(p,previous,(cfg.features)?.historyLimit)});
  if(result.conflict||result.reloaded){
    const {raw,...publicResult}=result;
    return publicResult;
  }
  if(result.written)await vault.internal({written:[{file:p,text}]});
  if(chosen&&!inVault(p)) {
    grant(p);
    await saveConfig({grantedFiles:grantSnapshot()});
  }
  const {raw,...disk}=await readSnapshot(p,limit);
  return {path:p,...disk};
}));
handleMain('session',async(_,data)=>{await saveConfig({session:restrictedSession(data)});return true;});
handleMain('search',async(_,query)=>(await vault.index())?.search(query)??[]);
handleMain('search-index',async(_,cursor)=>(await vault.index())?.searchSnapshot(cursor)??{cursor:null,full:true,notes:[],removed:[]});
handleMain('external',async(_,url)=>{
  const target=new URL(url);
  if (!['http:','https:'].includes(target.protocol)||target.username||target.password) throw Error(tr("main.onlyHttpAndHttpsLinksCanBe"));
  await shell.openExternal(target.href);
});
handleMain('reveal',async(_,p,openFolder=false)=>{
  const real=await check(p);
  if (openFolder) {
    if (!(await fs.stat(real)).isDirectory()) throw Error(tr("main.selectAFolderToOpen"));
    if (await shell.openPath(real)) throw Error(tr("main.couldNotOpenTheFolderInFile"));
  } else shell.showItemInFolder(real);
});
handleMain('reveal-image',async(_,p)=>{
  const real=await check(p,true);
  if (!/\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)$/i.test(real)||!(await fs.stat(real)).isFile())
    throw Error(tr("main.localImageUnavailable"));
  shell.showItemInFolder(real);
});
handleMain('clipboard-write-text',(_,text)=>{clipboard.writeText(text);});
handleMain('clipboard-paste',(event,plain)=>{
  if(plain)event.sender.pasteAndMatchStyle();
  else event.sender.paste();
});
handleMain('discard',async()=>{return (await dialog.showMessageBox(win,{type:'warning',message:tr("main.thisNoteHasUnsavedChanges"),detail:tr("main.closingItWillDiscardYourChanges"),buttons:[tr("main.keepEditing"),tr("main.discardChanges")],defaultId:0,cancelId:0})).response===1;});
async function withExportWindow(html,options,render) {
  const filename = path.join(app.getPath('userData'),'export-'+crypto.randomUUID()+'.html');
  const target=pathToFileURL(filename).href;
  const window=new BrowserWindow({...options,show:false,webPreferences:{
    partition:'calcite-export-'+crypto.randomUUID(),sandbox:true,contextIsolation:true,nodeIntegration:false,
    webSecurity:true,javascript:false,backgroundThrottling:false
  }});
  const contents=window.webContents;
  const requests=contents.session.webRequest;
  contents.setWindowOpenHandler(()=>({action:'deny'}));
  contents.on('will-navigate',event=>event.preventDefault());
  contents.on('will-redirect',event=>event.preventDefault());
  requests.onBeforeRequest((details,callback)=>{
    const document=details.resourceType==='mainFrame'&&details.url===target;
    const embedded=['image','font'].includes(details.resourceType)&&/^data:(?:image|font)\//i.test(details.url);
    callback({cancel:!document&&!embedded});
  });
  try {
    await fs.writeFile(filename,html,{flag:'wx'});
    await window.loadFile(filename);
    return await render(contents);
  } finally {
    requests.onBeforeRequest(null);
    window.destroy();
    await fs.unlink(filename).catch(()=>{});
  }
}
handleMain('pdf',async(_,html,options={})=>{
  const safeName=(options.title||tr("main.note")).replace(/[<>:"/\\|?*]/g,'_');
  const selected=await dialog.showSaveDialog(win,{title:tr('main.exportPdf'),defaultPath:safeName+'.pdf',filters:[{name:'PDF',extensions:['pdf']}]});
  if(selected.canceled)return false;
  const {css,print}=printSettings(options);
  const prepared=html+'<style>'+css+'</style>';
  await withExportWindow(prepared,{},async contents=>fs.writeFile(selected.filePath,await contents.printToPDF(print)));
  return true;
});
handleMain('pandoc-export', async (_, {format,html,name})=>{
  if (!['docx','epub'].includes(format) || typeof html!=='string') throw Error(tr("main.unknownExportFormat"));
  const selected=await dialog.showSaveDialog(win,{title:tr('documentMenu.export'),defaultPath:name+'.'+format,filters:[{name:format.toUpperCase(),extensions:[format]}]});
  if (selected.canceled) return false;
  const folder=await fs.mkdtemp(path.join(app.getPath('temp'),'calcite-export-'));
  const input=path.join(folder,'input.html');
  const output=path.join(folder,'document.'+format);
  try {
    await fs.writeFile(input,html,'utf8');
    await runFile('pandoc',['--sandbox','--from=html','--to='+format,'--output',output,input],
      {cwd:folder,windowsHide:true,timeout:90000,maxBuffer:1024*1024});
    await fs.copyFile(output,selected.filePath);
    return true;
  } catch (error) {
    if (error.code==='ENOENT') throw Error(tr("main.installPandocAndAddItToPath"));
    throw Error(tr("main.pandocExportFailed")+(error.stderr?.trim().slice(0,500)||error.message));
  } finally {
    await fs.unlink(input).catch(()=>{});
    await fs.unlink(output).catch(()=>{});
    await fs.rmdir(folder).catch(()=>{});
  }
});
handleMain('quit',serialized(async()=>{await gitSync.switchVault('');closing=true;win.close();}));
handleMain('sync:status',()=>gitSync.view());
handleMain('sync:configure',serialized((_,settings)=>gitSync.configure(settings)));
handleMain('sync:run',()=>gitSync.request());
handleMain('sync:test',()=>gitSync.test());
handleMain('sync:pair',()=>gitSync.pair());
handleMain('sync:revoke',serialized(()=>gitSync.revoke()));
handleMain('sync:remote-pair',serialized(()=>gitSync.remotePair()));
handleMain('sync:cancel-remote-pair',serialized(()=>gitSync.cancelRemotePair()));
handleMain('sync:network',(_,online)=>gitSync.network(online));
handleMain('sync:resolve',serialized((_,file,choice)=>gitSync.resolve(file,choice)));
handleMain('sync:conflict-files',(_,file)=>gitSync.conflictFiles(file));
handleMain('sync:archive-conflicts',serialized(()=>gitSync.archiveConflicts()));
handleMain('sync:restore-version',serialized((_,file,id)=>gitSync.restoreVersion(file,id)));
handleMain('sync:clear-conflict',serialized(async(_,file)=>{
  if(!inVault(file))throw Error(tr("main.theConflictPathIsOutsideTheCurrent"));
  return gitSync.clearConflict(file);
}));

async function workspaceEntry(target, allowRoot = false) {
  if (!root || typeof target !== 'string' || !space.within(root, target) || !allowRoot && path.relative(root,target) === '') {
    throw Error(tr("main.selectAFileOrFolderInThe"));
  }
  const real = await check(target);
  if (path.relative(real, target)) throw Error(tr("main.thisActionCannotBePerformedOnA"));
  return real;
}
async function createNoteDirectory(target,created) {
  if (!root || typeof target !== 'string' || !space.within(root,target)) throw Error(tr("main.createTheNoteInsideTheWorkspace"));
  let folder = root;
  for (const part of path.relative(root,target).split(path.sep).filter(Boolean)) {
    folder = path.join(folder,space.validName(part));
    await fs.mkdir(folder).then(()=>created.push(folder)).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(tr("main.theNoteDirectoryContainsASymlinkOr"));
  }
  return folder;
}
handleMain('workspace-edit', serialized(async (_, edit) => {
  const { type, drafts = [] } = edit;
  if (type === 'note' || type === 'folder') {
    const directories=[];
    const folder = edit.createParents ? await createNoteDirectory(edit.parent,directories) : await workspaceEntry(edit.parent, true);
    let name = space.validName(edit.name.trim());
    if (type === 'note' && !md.test(name)) name += '.md';
    const target = path.join(folder,name);
    const written=[];
    if (type === 'folder') {await fs.mkdir(target);directories.push(target);}
    else {
      const text = typeof edit.text === 'string' ? edit.text : '';
      if (Buffer.byteLength(text)>2*1024*1024) throw Error(tr("main.theNoteTemplateIsTooLarge"));
      const normalized=normalizeLineEndings(target,text);
      try { await fs.writeFile(target,normalized,{flag:'wx'});written.push({file:target,text:normalized}); }
      catch (error) {
        if (error.code!=='EEXIST' || !edit.openExisting) throw error;
        const existing = await workspaceEntry(target);
        if (!(await fs.stat(existing)).isFile()) throw error;
      }
    }
    await vault.internal({written,directories});
    return {path:target, tree:await vault.tree()};
  }
  const from = await workspaceEntry(edit.path);
  const info=await fs.stat(from);
  if (!info.isDirectory()&&(!info.isFile()||!documentType.test(from))) throw Error(tr("main.thisActionRequiresANoteCanvasOr"));
  const directory = info.isDirectory();
  const index=await vault.index();
  const descendants=directory?await vault.entriesWithin(from):[];
  const directories=directory?[...new Set([from,...descendants.filter(row=>row.children).map(row=>row.path)])]:[];
  const canvases=directory?descendants.filter(row=>!row.children&&/\.canvas$/i.test(row.path)).map(row=>row.path):
    /\.canvas$/i.test(from)?[from]:[];
  if (type === 'trash') {
    const removed=[...new Set([from,...directories,...canvases,...(directory?index.pathsWithin(from):[])])];
    const logged=await activity().softDelete(from);
    await vault.internal({removed});
    return {tree:await vault.tree(),activity:logged};
  }
  if (type !== 'rename' && type !== 'move') throw Error(tr("main.unknownFileAction"));
  const folder = type === 'move' ? await workspaceEntry(edit.parent,true) : path.dirname(from);
  let name = type === 'rename' ? space.validName(edit.name.trim()) : path.basename(from);
  if (!directory) {
    const extension=canvases.includes(from)?/\.canvas$/i:md;
    if (!extension.test(name)) name += path.extname(from);
  }
  const to = path.join(folder,name);
  if (from === to) return {path:to,tree:await vault.tree(),changes:[]};
  if (directory && path.relative(from,to) && space.within(from,to)) throw Error(tr("main.aFolderCannotBeMovedIntoItself"));
  const caseOnly = process.platform === 'win32' && from.toLowerCase() === to.toLowerCase();
  if (!caseOnly && await fs.lstat(to).then(() => true, e => {if(e.code==='ENOENT')return false;throw e;})) throw Error(tr("main.aFileOrFolderWithThatName"));
  const {move,changes:noteChanges,refactor:noteRefactor}=await planLinkRefactor(index,from,to,drafts,async note=>{
    const file=await workspaceEntry(note);
    const {mtimeMs}=await fs.stat(file);
    return {text:refactorText(await fs.readFile(file)),mtime:mtimeMs};
  });
  const allCanvases=(await vault.entriesWithin(root)).filter(row=>!row.children&&/\.canvas$/i.test(row.path)).map(row=>row.path);
  const {changes:canvasChanges,refactor:canvasRefactor}=await planCanvasLinkRefactor(index,move,allCanvases,drafts,async canvasFile=>{
    const file=await workspaceEntry(canvasFile);
    const stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>MAX_CANVAS)return null;
    return {text:refactorText(await fs.readFile(file)),mtime:stat.mtimeMs};
  });
  const changes=[...noteChanges,...canvasChanges];
  const refactor={notes:noteRefactor.notes+canvasRefactor.notes,references:noteRefactor.references+canvasRefactor.references};
  const limit = (await config()).features?.historyLimit;
  for (const change of changes) {
    if (await fs.readFile(change.from,'utf8') !== change.previous) throw Error(tr("main.aWorkspaceFileChangedWhileLinksWere"));
    if (change.saved !== change.previous) await history().record(change.from,change.previous,limit);
  }
  const logged=await activity().refactor(type,from,to,changes,caseOnly?path.join(folder,'.calcite-tmp-'+crypto.randomUUID()):undefined);
  const syncHistory=new GitEngine(root).history;
  for(const change of changes){
    const {raw,snapshot,mtime,needsLf}=await readSnapshot(change.path,md.test(change.path)?MAX_NOTE:MAX_CANVAS);
    Object.assign(change,raw===change.saved?{mtime,snapshot,needsLf}:{mtime:null});
    if(change.path!==change.from){
      await history().relocate(change.from,change.path,limit);
      await syncHistory.relocate(change.from,change.path).catch(()=>{});
    }
  }
  const writtenMap=new Map();
  for(const change of changes)if(change.path!==change.from||change.previous!==change.saved)
    writtenMap.set(pathKey(change.path),{file:change.path,...(md.test(change.path)?{text:change.saved}:{})});
  for(const file of canvases.map(move))if(!writtenMap.has(pathKey(file)))writtenMap.set(pathKey(file),{file});
  await vault.internal({removed:[...new Set([...directories,...canvases,...changes.filter(change=>change.path!==change.from).map(change=>change.from)])],
    directories:directories.map(move),written:[...writtenMap.values()]});
  return {path:to,tree:await vault.tree(),refactor,activity:logged,changes:changes.map(({previous,...change})=>({
    ...change,saved:normalizeLineEndings(change.path,change.saved)
  }))};
}));
handleMain('activity:list',serialized(()=>activity().list()));
handleMain('activity:empty',serialized(()=>activity().emptyTrash()));
handleMain('activity:undo',serialized(async (_,id,token)=>{
  const result=await activity().undo(id,token);
  if(!result.activity)return result;
  const removed=new Set(result.affected.filter(row=>row.from&&row.from!==row.path).map(row=>row.from));
  if(result.from)for(const row of await vault.entriesWithin(result.from))removed.add(row.path);
  const written=new Set(result.affected.map(row=>row.path)),directories=[];
  async function scan(file){
    const stat=await fs.lstat(file);
    if(stat.isSymbolicLink())return;
    if(stat.isDirectory()){
      directories.push(file);
      for(const item of await fs.readdir(file))if(!item.startsWith('.'))await scan(path.join(file,item));
    }else if(documentType.test(file))written.add(file);
  }
  await scan(result.path);
  await vault.internal({removed:[...removed],written:[...written].map(file=>({file})),directories});
  return {...result,tree:await vault.tree()};
}));
handleMain('note-target', async (_, {source,destination,wiki}) => {
  if (!source&&!root) return null;
  if (source) await check(source);
  const raw=destination.split('#')[0];
  if (root&&/\.canvas$/i.test(raw)) {
    let name;
    try {name=decodeURIComponent(raw);} catch {return null;}
    const local=path.resolve(source?path.dirname(source):root,name);
    const fromRoot=path.resolve(root,'.'+(name.startsWith('/')?name:'/'+name));
    const entries=(await vault.entriesWithin(root)).filter(row=>!row.children&&/\.canvas$/i.test(row.path));
    const match=(wiki&&!name.startsWith('/')?[local,fromRoot]:[name.startsWith('/')?fromRoot:local])
      .map(candidate=>entries.find(row=>pathKey(row.path)===pathKey(candidate))).find(Boolean);
    if (match) return {path:await check(match.path)};
    return null;
  }
  const index=await vault.index();
  const anchor=source||path.join(root,'未命名.md');
  const resolve=index?.directory.resolve||space.resolver(root||path.dirname(anchor),[]);
  const {target,heading}=resolve(anchor,destination,wiki);
  if (!target||!allowed(target)||!md.test(target)) return null;
  try { return {path:await check(target),heading:heading?.slice(1)}; }
  catch(error) { if(error.code!=='ENOENT')throw error; return null; }
});
handleMain('backlinks', async (_, target, drafts) => {
  if (!root) return [];
  const real=await check(target);
  const index=await vault.index();
  return allowed(real)?index?.backlinks(real,drafts)??[]:[];
});
handleMain('workspace-graph', async (_, drafts=[]) => (await vault.index())?.graph(drafts)??{nodes:[],edges:[]});
handleMain('workspace-health',async(_,drafts=[]) => (await vault.index())?.health(drafts)??{orphans:[],issues:[]});
handleMain('workspace-links',async(_,{source,destinations,headings})=>{
  if(!root)return [];
  if(source)await check(source);
  const index=await vault.index();
  const anchor=source||path.join(root,'未命名.md');
  return destinations.map(destination=>index?.inspect(anchor,destination,true,headings)||{status:'placeholder'});
});
handleMain('workspace-notes', async (_,scope,drafts) => (await vault.index())?.workspaceNotes(scope,drafts)??[]);
const canvasName = name => {
  if (typeof name !== 'string') throw Error(tr("main.enterANameForTheCanvas"));
  const parts=name.trim().replaceAll('\\','/').split('/').filter(Boolean);
  if(!parts.length)throw Error(tr("main.enterANameForTheCanvas"));
  const last=space.validName(parts.pop().replace(/\.canvas$/i,''))+'.canvas';
  return path.join(...parts.map(space.validName),last);
};
handleMain('canvas-files', async () => {
  if (!root) return [];
  const locale=getLocale();
  return (await vault.entriesWithin(root))
    .filter(entry=>!entry.children&&/\.canvas$/i.test(entry.path))
    .map(entry=>path.relative(root,entry.path).replaceAll('\\','/'))
    .sort((a,b)=>a.localeCompare(b,locale,{numeric:true}));
});
handleMain('canvas-read', async (_,name) => {
  if (!root) throw Error(tr("gitSync.openAWorkspaceFirst"));
  const target = await workspaceEntry(path.join(root,canvasName(name)));
  const info = await fs.stat(target);
  if (!info.isFile() || info.size>5*1024*1024) throw Error(tr("main.theCanvasIsUnavailableOrExceeds5"));
  const text = await fs.readFile(target,'utf8');
  return {text,version:crypto.createHash('sha256').update(text).digest('hex')};
});
handleMain('canvas-save', serialized(async (_, {name,board,version}) => {
  if (!root) throw Error(tr("gitSync.openAWorkspaceFirst"));
  const directory=await workspaceEntry(root,true);
  const relativeTarget=canvasName(name);
  const target=path.join(directory,relativeTarget);
  if (!Array.isArray(board?.nodes)||!Array.isArray(board?.edges)) throw Error(tr("main.invalidCanvasFormat"));
  const text=JSON.stringify(board,null,2)+'\n';
  if (Buffer.byteLength(text)>5*1024*1024) throw Error(tr("main.theCanvasExceeds5Mb"));
  if (version) {
    await workspaceEntry(target);
    const expected=async()=>crypto.createHash('sha256').update(await fs.readFile(target,'utf8')).digest('hex')===version;
    if (!await expected() || !await space.atomicWrite(target,text,expected)) throw Error(tr("main.theCanvasWasChangedByAnotherProgram"));
  } else {
    const parent=path.dirname(target);
    if(parent!==directory)await workspaceEntry(parent,true);
    await fs.writeFile(target,text,{flag:'wx'});
  }
  await vault.internal({written:[{file:target}]});
  return {name:relativeTarget.replaceAll('\\','/'),version:crypto.createHash('sha256').update(text).digest('hex')};
}));
handleMain('features', (_, features) => saveConfig({features}));
handleMain('history', async (_, note, id) => {
  if(!path.isAbsolute(note))throw Error(tr("main.invalidFilePath"));
  const engine=inVault(note)?new GitEngine(root):null;
  if(engine)note=await engine.workspaceFile(note);
  if(engine&&id==='current'&&(await engine.history.list(note)).length)
    return (await readConflictFile(engine,note,fs)).text;
  if(engine&&id&&isSyncVersion(id))return Buffer.from(await engine.history.read(note,id)).toString('utf8');
  if(!engine||id)await check(note);
  if(id)return history().read(note,id);
  const backups=engine?await engine.history.list(note):[];
  return [...backups,...await history().list(note)].sort((a,b)=>b.time-a.time);
});
handleMain('attachment', serialized(async (_, {note, strategy, directory, mime, bytes}) => {
  const ext = {'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/avif':'avif','image/bmp':'bmp','image/svg+xml':'svg'}[mime];
  if (!ext || !bytes?.byteLength || bytes.byteLength > 32*1024*1024) throw Error(tr("main.selectAPngJpegGifWebpAvif"));
  note = await check(note);
  const parent = path.dirname(note);
  const anchor = strategy === 'workspace' && root && space.within(root,note) ? root : parent;
  const pattern = strategy === 'workspace' ? directory : directory.replaceAll('${filename}',path.basename(note,path.extname(note)));
  const parts = pattern.replace(/^\.[\\/]/,'').split(/[\\/]/).map(space.validName);
  let folder = anchor;
  for (const part of parts) {
    folder = path.join(folder,part);
    await fs.mkdir(folder).catch(e => {if(e.code!=='EEXIST')throw e;});
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(tr("main.theAttachmentsFolderContainsASymlinkOr"));
  }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g,'');
  const target = path.join(folder,stamp + '-' + crypto.randomUUID().slice(0,8) + '.' + ext);
  const image=Buffer.from(bytes);
  if (!validImage(mime,image)) throw Error(tr("main.theImageContentsDoNotMatchIts"));
  await fs.writeFile(target,image,{flag:'wx'});
  if(inVault(target))gitSync.arm();
  return space.encode(path.relative(parent,target));
}));
handleMain('attachments:scan',serialized(async(_,drafts=[])=>{
  if(!root)throw Error(tr("gitSync.openAWorkspaceFirst"));
  return orphanPictures(root,{index:await vault.index(),drafts});
}));
handleMain('attachments:trash',serialized(async(_,{paths,drafts=[]})=>{
  if(!root)throw Error(tr("gitSync.openAWorkspaceFirst"));
  const permitted=new Set((await orphanPictures(root,{drafts,verify:true})).map(row=>pathKey(row.path)));
  const files=[];
  for(const file of new Set(paths)) {
    if(!inVault(file)||!imageExtension.test(file)||!permitted.has(pathKey(file))) throw Error(tr("main.attachmentsChangedScanThemAgainBeforeCleaning"));
    files.push(await workspaceEntry(file));
  }
  for(const file of files)await shell.trashItem(file);
  if(files.length)gitSync.arm();
  return files.length;
}));
handleMain('export-document', async (_, {html,format,name,width=1000,scale=1}) => {
  if (!['html','png'].includes(format)) throw Error(tr("main.unknownExportFormat"));
  const selected = await dialog.showSaveDialog(win,{title:tr('documentMenu.export'),defaultPath:name + '.' + format,filters:[{name:format.toUpperCase(),extensions:[format]}]});
  if (selected.canceled) return false;
  if (format === 'html') await fs.writeFile(selected.filePath,html,'utf8');
  else {
    await withExportWindow(html,{width,height:720,useContentSize:true},async contents=>{
      const client = contents.debugger;
      client.attach('1.3');
      await client.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
      const {result} = await client.sendCommand('Runtime.evaluate',{
        expression:'(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));return Math.ceil(document.body.getBoundingClientRect().height);})()',
        awaitPromise:true,returnByValue:true
      });
      const height = Math.max(1,result.value);
      if (!Number.isFinite(height) || height*scale>30000 || width*height*scale*scale>48000000) throw Error(tr("main.theContentIsTooLongLowerThe"));
      const capture=client.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,
        optimizeForSpeed:true,clip:{x:0,y:0,width,height,scale}});
      // A hidden static page may stop producing frames before Chromium requests the screenshot.
      const repaint=setInterval(()=>{if(!contents.isDestroyed())contents.invalidate();},180);
      let deadline;
      try {
        const {data}=await Promise.race([capture,new Promise((_,reject)=>{
          deadline=setTimeout(()=>reject(Error(tr("main.imageRenderingTimedOutLowerTheScale"))),20000);
        })]);
        await fs.writeFile(selected.filePath,Buffer.from(data,'base64'));
      } finally {
        clearInterval(repaint);
        clearTimeout(deadline);
      }
    });
  }
  return true;
});
handleMain('export-rich',async(_,{html,text})=>{clipboard.write({html,text});return true;});
handleMain('export-markdown',serialized(async(_,{note,text,format})=>{
  note=await check(note);
  const filename=path.basename(note), name=filename.replace(md,'');
  const selected=format==='zip'?await dialog.showSaveDialog(win,{title:tr('documentMenu.export'),defaultPath:name+'.zip',filters:[{name:'ZIP',extensions:['zip']}]}):
    await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});
  if(selected.canceled)return false;
  const document=await portableMarkdown({note,text,root:inVault(note)?root:'',
    readImage:file=>readLocalImage('note-image://local/'+encodeURIComponent(file))});
  if(format==='zip') {
    if(!/\.zip$/i.test(selected.filePath))throw Error(tr("main.selectAZipFile"));
    await space.atomicWrite(selected.filePath,Buffer.from(zipSync(Object.fromEntries([[filename,Buffer.from(document.text)],...document.entries]),{level:3})));
  } else {
    const folder=path.join(await fs.realpath(selected.filePaths[0]),space.validName(name+'-Markdown'));
    await fs.mkdir(folder);
    if(document.entries.size)await fs.mkdir(path.join(folder,'assets'));
    for(const [file,bytes] of document.entries)await fs.writeFile(path.join(folder,file),bytes,{flag:'wx'});
    await fs.writeFile(path.join(folder,filename),document.text,{flag:'wx'});
  }
  return true;
}));
