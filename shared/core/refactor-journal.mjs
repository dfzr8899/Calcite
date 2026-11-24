import {Buffer} from 'buffer';
import {t as tr} from '../i18n/index.mjs';

/** @typedef {{from: string, path: string, previous: string, saved: string}} RefactorRow */
/** @typedef {{version: number, from: string, to: string, staging?: string, rollback?: boolean, committed?: boolean, binary?: boolean, exclusive?: boolean, trash?: string, metadata?: any, changes: RefactorRow[]}} RefactorPlan */
/** @typedef {{join(...parts: string[]): string, dirname(path: string): string}} JournalPaths */

const missing=error=>error.code==='ENOENT';
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const temporary=/^\.calcite-tmp-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const basename=file=>file.split(/[\\/]/).at(-1);
const conflict=()=>Error(tr('dataSafety.refactorChanged'));

/**
 * @param {string} root
 * @param {{io: any, path: JournalPaths, safe: (file: string) => Promise<string>,
 *  write: (file: string, data: string|Uint8Array, check?: () => Promise<boolean>) => Promise<boolean>,
 *  rename?: (from: string, to: string) => Promise<void>, linkMove?: (from: string, to: string) => Promise<void>,
 *  sameFile?: (from: string, to: string) => Promise<boolean>, flush?: (dir: string) => Promise<void>,
 *  key?: (file: string)=>string, onCommit?: (plan: RefactorPlan, recovered: boolean) => Promise<void>,
 *  onRecoverFailure?: (error: unknown, quarantined: string|null) => void}} host
 */
export function refactorJournal(root,{io,path,safe,write,rename=io.rename,linkMove,sameFile,flush=async()=>{},key=file=>file,onCommit=async()=>{},onRecoverFailure=()=>{}}) {
  const dir=path.join(root,'.calcite');
  const journal=path.join(dir,'refactor-journal.json');
  const stat=async file=>io.lstat(await safe(file)).catch(error=>{if(!missing(error))throw error;return null;});
  async function read(file) {
    const bytes=await io.readFile(await safe(file));
    try{return decoder.decode(bytes);}
    catch{throw Object.assign(Error(tr('dataSafety.invalidUtf8')),{code:'EILSEQ'});}
  }
  const readNote=(file,binary)=> (binary?io.readFile(file).then(bytes=>Buffer.from(bytes).toString('base64')):read(file)).catch(error=>{
    if(!missing(error)&&error.code!=='EILSEQ')throw error;
    return null;
  });
  const remove=async file=>{
    await io.unlink(await safe(file)).catch(error=>{if(!missing(error))throw error;});
    await flush(path.dirname(file));
  };
  const persist=async (plan,check)=>write(await safe(journal),JSON.stringify(plan),check);

  /** @param {RefactorPlan} plan */
  async function validate(plan) {
    if(plan?.version!==1||typeof plan.from!=='string'||typeof plan.to!=='string'||
      !Array.isArray(plan.changes)||plan.from===plan.to||plan.from===root||plan.to===root)
      throw Error(tr('dataSafety.invalidJournal'));
    const move=file=>file===plan.from||file.startsWith(plan.from+(plan.from.includes('\\')?'\\':'/'))?
      plan.to+file.slice(plan.from.length):file;
    const paths=new Set();
    if(plan.staging&&(key(plan.from)!==key(plan.to)||path.dirname(plan.staging)!==path.dirname(plan.from)||
      !temporary.test(basename(plan.staging))))throw Error(tr('dataSafety.invalidJournal'));
    for(const row of plan.changes) {
      if(typeof row?.from!=='string'||typeof row.previous!=='string'||typeof row.saved!=='string'||
        row.previous===row.saved||row.path!==move(row.from)||paths.has(key(row.path)))
        throw Error(tr('dataSafety.invalidJournal'));
      paths.add(key(row.path));
    }
    const payload=typeof plan.trash==='string'&&/^[a-f0-9-]{36}$/.test(plan.trash)?
      path.join(dir,'trash',plan.trash,'payload'):null;
    if(plan.trash&&(!payload||plan.changes.length||![plan.from,plan.to].includes(payload)))
      throw Error(tr('dataSafety.invalidJournal'));
    for(const file of [plan.from,plan.to,...plan.changes.flatMap(row=>[row.from,row.path])]) {
      if(file===payload){await safe(file);continue;}
      if(file.slice(root.length).split(/[\\/]/).some(part=>/^\.(?:git|calcite|trash)$/i.test(part)))
        throw Error(tr('dataSafety.invalidJournal'));
      await safe(file);
    }
    if(plan.staging)await safe(plan.staging);
  }

  async function at(file,caseOnly) {
    if(!caseOnly)return Boolean(await stat(file));
    const parent=path.dirname(file);
    return (await io.readdir(await safe(parent))).includes(basename(file));
  }

  /** @param {RefactorPlan} plan */
  async function location(plan) {
    const from=await at(plan.from,plan.staging),to=await at(plan.to,plan.staging);
    const staging=plan.staging&&Boolean(await stat(plan.staging));
    if(from&&to&&plan.exclusive&&sameFile){
      if(await sameFile(await safe(plan.from),await safe(plan.to))){
        await remove(plan.rollback?plan.to:plan.from);
        return plan.rollback?plan.from:plan.to;
      }
      if(plan.rollback)return plan.from;
    }
    if(Number(from)+Number(to)+Number(Boolean(staging))!==1)throw conflict();
    return from?plan.from:to?plan.to:plan.staging;
  }

  async function moveLocated(current,target,staging,exclusive=false) {
    if(current===target)return;
    if(staging&&current!==staging){
      await rename(await safe(current),await safe(staging));
      current=staging;
    }
    if(await at(target,staging))throw conflict();
    const move=exclusive&&linkMove?linkMove:rename;
    await move(await safe(current),await safe(target));
  }

  /** @param {RefactorPlan} plan */
  async function finish(plan) {
    const current=await location(plan);
    const note=async file=>readNote(await safe(file),plan.binary);
    const bytes=value=>plan.binary?Buffer.from(value,'base64'):value;
    if(plan.rollback) {
      // Reverse only writes still present. An independent external change is
      // retained, along with the original file/folder location.
      if(current===plan.to)for(const row of plan.changes) {
        if(await note(row.path)===row.saved)
          await write(await safe(row.path),bytes(row.previous),async()=>await note(row.path)===row.saved);
      }
      await moveLocated(current,plan.from,plan.staging,plan.exclusive);
    }else{
      for(const row of plan.changes) {
        const file=row.from===row.path?row.path:current+row.from.slice(plan.from.length);
        const text=await note(file);
        if(text!==row.previous&&(current!==plan.to||text!==row.saved))throw conflict();
      }
      await moveLocated(current,plan.to,plan.staging,plan.exclusive);
      for(const row of plan.changes) {
        if(await note(row.path)===row.saved)continue;
        if(!await write(await safe(row.path),bytes(row.saved),async()=>await note(row.path)===row.previous))throw conflict();
      }
    }
  }
  async function ensureIgnored() {
    const ignore=path.join(root,'.gitignore');
    const previous=await read(ignore).catch(error=>{if(!missing(error))throw error;return null;});
    const entries=previous?.split(/\r?\n/)??[];
    const missingRules=[
      ...(!entries.some(line=>/^\/?\.calcite\/$/.test(line))?['.calcite/']:[]),
      ...(!entries.includes('.calcite-tmp-*')?['.calcite-tmp-*']:[])
    ];
    if(!missingRules.length)return;
    const newline=previous?.includes('\r\n')?'\r\n':'\n';
    const expected=async()=>await read(ignore).catch(error=>{if(!missing(error))throw error;return null;})===previous;
    const prefix=previous&&!previous.endsWith('\n')?previous+newline:previous??'';
    if(!await write(await safe(ignore),prefix+missingRules.join(newline)+newline,expected))throw conflict();
  }

  /** @param {RefactorPlan} plan */
  async function run(plan,recovering=false) {
    if(!plan.committed){
      try{await finish(plan);}
      catch(error){
        if(plan.rollback)throw error;
        plan.rollback=true;
        await persist(plan);
        await finish(plan);
        if(!recovering){await remove(journal);throw error;}
      }
      plan.committed=true;
      if(plan.metadata||recovering)await persist(plan);
    }
    await onCommit(plan,recovering);
    await remove(journal);
  }

  async function cleanup(dir) {
    for(const item of await io.readdir(await safe(dir),{withFileTypes:true})) {
      const file=path.join(dir,item.name);
      if(item.isFile()&&temporary.test(item.name))await remove(file);
      else if(item.isDirectory()&&(item.name==='.calcite'||(!item.name.startsWith('.')&&
        !['node_modules','dist','release'].includes(item.name))))await cleanup(file);
    }
  }
  return {
    prepare:ensureIgnored,
    async apply(from,to,changes,staging,options={}) {
      /** @type {RefactorPlan} */
      const plan={version:1,from,to,staging,...options,changes:changes.filter(row=>row.previous!==row.saved)
        .map(({from,path,previous,saved})=>({from,path,previous,saved}))};
      await validate(plan);
      if(await stat(journal))throw Error(tr('dataSafety.pendingJournal'));
      await ensureIgnored();
      await io.mkdir(await safe(dir),{recursive:true});
      await flush(root);
      if(!await persist(plan,async()=>!await stat(journal)))throw Error(tr('dataSafety.pendingJournal'));
      await run(plan);
    },
    async recover() {
      const pending=await stat(journal);
      let recovered=false;
      if(pending) {
        try{
          const plan=JSON.parse(await read(journal));
          await validate(plan);
          await run(plan,true);
          recovered=true;
        }catch(error){
          // Quarantine a damaged or externally diverged journal instead of
          // bricking workspace startup or future file operations forever.
          let quarantined=null;
          const target=path.join(dir,'refactor-journal-failed-'+Date.now()+'.json');
          try{
            await rename(await safe(journal),await safe(target));
            quarantined=target;
          }catch{
            await remove(journal).catch(()=>{});
          }
          onRecoverFailure(error,quarantined);
        }
      }
      await cleanup(root).catch(()=>{});
      return recovered;
    }
  };
}
