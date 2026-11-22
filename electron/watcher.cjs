const fs = require('node:fs/promises');
const path = require('node:path');
const { watch } = require('chokidar');
const { within, key } = require('./workspace.cjs');
const { documentType } = require('./ipc-schema.cjs');

const excluded = new Set(['node_modules','dist','release']);
function tracked(root, file) {
  return within(root,file) && !path.relative(root,file).split(path.sep).some(part=>
    part.startsWith('.') || part.toLowerCase().endsWith('.tmp') || excluded.has(part.toLowerCase()));
}

async function entry(root, file) {
  if (!tracked(root,file)) return null;
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || path.relative(file,await fs.realpath(file))) return null;
    if (!stat.isDirectory() && (!stat.isFile() || !documentType.test(file))) return null;
    return {
      row:{path:file,name:path.basename(file),modified:stat.mtimeMs,created:stat.birthtimeMs,
        ...(stat.isDirectory()?{children:[]}:{})},
      signature:[stat.ino,stat.birthtimeMs,stat.mtimeMs,stat.ctimeMs,stat.size].join(':'),
      size:stat.size
    };
  } catch (error) {
    if (['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

function watchVault(root, onBatch, onError) {
  const pending = new Map();
  let stopped = false, timer;
  const watcher = watch(root,{
    ignoreInitial:true, followSymlinks:false, atomic:100,
    awaitWriteFinish:{stabilityThreshold:120,pollInterval:30},
    ignored:(file,stat)=>!tracked(root,file)||Boolean(stat&&(stat.isSymbolicLink()||stat.isFile()&&!documentType.test(file)))
  });
  let finish;
  const ready = new Promise(resolve=>{
    finish=resolve;
    watcher.once('ready',resolve);
    watcher.once('error',resolve);
  });
  watcher.on('error',error=>{if (!stopped) onError(error);});
  watcher.on('all',(type,file)=>{
    if (stopped || !tracked(root,file) || !['add','change','unlink','addDir','unlinkDir'].includes(type)) return;
    if (!type.endsWith('Dir') && !documentType.test(file)) return;
    const id=key(file);
    const previous=pending.get(id);
    if (!(previous?.type==='add' && type==='change')) pending.set(id,{type,path:file});
    if(!timer) timer=setTimeout(()=>{
      timer=undefined;
      const changes=[...pending.values()];
      pending.clear();
      if (!stopped) onBatch(changes);
    },85);
  });
  return {ready,async close(){stopped=true;clearTimeout(timer);pending.clear();finish();await watcher.close();}};
}

module.exports={entry,tracked,watchVault};
