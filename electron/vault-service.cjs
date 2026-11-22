const path=require('node:path');
const {VaultIndex,readNote,digest}=require('./index-service.cjs');
const {entry,tracked,watchVault}=require('./watcher.cjs');
const {key,within,markdown}=require('./workspace.cjs');
const {documentType}=require('./ipc-schema.cjs');

function createVaultService({queue,publish,fail,onInternal=()=>{}}) {
  let active;

  function expireWrites(state) {
    const now=Date.now();
    for (const [id,record] of state.own) if (record.until<now) state.own.delete(id);
  }

  function start(root) {
    const previous=active;
    active=null;
    previous?.controller.abort();
    previous?.watcher.close().catch(fail);
    if (!root) return;
    const controller=new AbortController();
    const state={root,controller,index:new VaultIndex(root,controller.signal),own:new Map(),rows:new Map()};
    active=state;
    state.watcher=watchVault(root,changes=>queue(()=>deliver(state,changes)).catch(fail),fail);
    state.ready=state.watcher.ready.then(()=>state.index.scan(row=>state.rows.set(key(row.path),row)));
    state.ready.catch(fail);
  }

  async function deliver(state,changes) {
    if (state!==active) return;
    await state.ready;
    if (state!==active) return;
    const events=[];
    expireWrites(state);
    for (const change of changes) {
      const file=change.path;
      if (!tracked(state.root,file)) continue;
      const id=key(file);
      const previous=state.rows.has(id);
      const item=await entry(state.root,file);
      const directory=Boolean(item?.row.children||(!item&&change.type.endsWith('Dir')));
      const markdownFile=markdown.test(file);
      const own=state.own.get(id);
      const signature=item?.signature??null;
      if(own?.signature===signature)continue;
      const data=own?.reserved&&item&&!directory&&markdownFile?await readNote(state.root,file,item):null;
      if(own?.reserved&&own.hash===data?.hash)continue;
      if (own) state.own.delete(id);
      if (directory&&!item) {
        for(const [child,row] of state.rows)if(within(file,row.path)){
          state.index.observe(row.path);
          state.rows.delete(child);
        }
      } else if(!directory&&markdownFile)state.index.observe(file,item,data);
      if (item&&file!==state.root) state.rows.set(id,item.row);
      else state.rows.delete(id);
      const type=directory?(item?'addDir':'unlinkDir'):item?(previous?'change':'add'):'unlink';
      events.push({type,path:file,...(item?{row:item.row}:{})});
    }
    if (state!==active) return;
    if (events.length) publish({root:state.root,changes:events});
  }

  async function index() {
    const state=active;
    await state?.ready;
    if(!state||state!==active)return;
    await state.index.refresh();
    return state===active?state.index:undefined;
  }

  function reserve(rows) {
    if(!active)return;
    for(const row of rows)if(within(active.root,row.file)&&markdown.test(row.file)) {
      active.own.set(key(row.file),{reserved:true,hash:row.next?digest(row.next.toString('utf8')):undefined,until:Date.now()+15000});
    }
  }

  async function internal({removed=[],written=[],directories=[],source}) {
    const state=active;
    if (!state) return;
    await state.ready;
    if (state!==active) return;
    expireWrites(state);
    const own=(file,item,hash)=>state.own.set(key(file),{signature:item?.signature??null,hash,until:Date.now()+3000});
    const events=[];
    for (const file of removed) {
      if (!within(state.root,file)) continue;
      own(file);
      state.rows.delete(key(file));
      state.index.observe(file);
      if (documentType.test(file)) events.push({type:'unlink',path:file});
    }
    for (const {file,text} of written) {
      if (!within(state.root,file)||!documentType.test(file)) continue;
      const item=await entry(state.root,file);
      if (!item||item.row.children) continue;
      const markdownFile=markdown.test(file);
      const data=markdownFile&&typeof text==='string'?{item,text,hash:digest(text)}:null;
      own(file,item,data?.hash);
      events.push({type:state.rows.has(key(file))?'change':'add',path:file,row:item.row});
      state.rows.set(key(file),item.row);
      if(markdownFile)state.index.observe(file,item,data);
    }
    for (const file of directories) {
      if (path.relative(state.root,file)==='') continue;
      const item=await entry(state.root,file);
      if (item?.row.children) {
        own(file,item);
        state.rows.set(key(file),item.row);
        events.push({type:'addDir',path:file,row:item.row});
      }
    }
    if (state===active) {
      if(source&&events.length)publish({root:state.root,changes:events,source});
      else if(!source)onInternal();
    }
  }

  async function tree() {
    const state=active;
    await state?.ready;
    if (!state||state!==active) return [];
    const folders=new Map();
    for (const row of state.rows.values()) {
      const parent=key(path.dirname(row.path));
      if (!folders.has(parent)) folders.set(parent,[]);
      folders.get(parent).push(row);
    }
    const children=(dir,depth=0)=>depth>12?[]:(folders.get(key(dir))||[])
      .map(row=>row.children?{...row,children:children(row.path,depth+1)}:row)
      .sort((a,b)=>Number(!!b.children)-Number(!!a.children)||a.name.localeCompare(b.name,'zh-CN'));
    return children(state.root);
  }

  async function entriesWithin(dir) {
    const state=active;
    await state?.ready;
    if (!state||state!==active) return [];
    return [...state.rows.values()].filter(row=>within(dir,row.path));
  }

  return {start,index,internal,reserve,tree,entriesWithin,close:()=>start('')};
}

module.exports={createVaultService};
