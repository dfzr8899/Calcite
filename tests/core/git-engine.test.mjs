import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import git from 'isomorphic-git';
import {createGitEngine} from '../../shared/core/git-engine.mjs';
import {resolveConflict} from '../../shared/core/sync-conflicts.mjs';
import {withinNativePath} from '../../shared/core/vault-paths.mjs';

const author={name:'Test',email:'test@calcite.local'};

async function diverge(t,base,left,right,advanceRemote=false){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-core-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const Engine=createGitEngine({fs,path,atomicWrite:fs.writeFile,within:(parent,file)=>withinNativePath(path,parent,file)});
  const engine=new Engine(dir);
  const args={fs,dir};
  const remoteTime=1780000000;
  const read=file=>fs.readFile(path.join(dir,file),'utf8');
  await engine.open();
  async function commit(changes,message){
    for(const [name,text] of Object.entries(changes)){
      if(text===null){
        await fs.unlink(path.join(dir,name));
        await git.remove({...args,filepath:name});
      }else{
        await fs.writeFile(path.join(dir,name),text);
        await git.add({...args,filepath:name});
      }
    }
    const timestamp=message==='remote'?remoteTime:message==='unrelated'?remoteTime+30:remoteTime-10;
    return git.commit({...args,author:{...author,timestamp,timezoneOffset:0},committer:{...author,timestamp,timezoneOffset:0},message});
  }
  await commit(base,'base');
  await git.branch({...args,ref:'remote'});
  const ours=await commit(left,'local');
  await git.checkout({...args,ref:'remote'});
  let theirs=await commit(right,'remote');
  if(advanceRemote)theirs=await commit({'unrelated.md':'newer remote commit\n'},'unrelated');
  await git.checkout({...args,ref:'main'});
  for(const [file,content] of Object.entries(left))if(content!==null){
    const timestamp=file.startsWith('remote-wins')?remoteTime-5:file.startsWith('tie')?remoteTime:remoteTime+5;
    await fs.utimes(path.join(dir,file),timestamp,timestamp);
  }
  const result=await engine.apply(theirs,author);
  return {args,dir,engine,ours,theirs,read,...result};
}

test('Git merges disjoint lines across LF/CRLF and preserves a real zero-byte file',async t=>{
  const merged=await diverge(t,
    {'lines.md':'one\r\ncommon\r\nlast\r\n','empty.md':'base\n','left.md':'base\n'},
    {'lines.md':'local\ncommon\nlast\n','left.md':'local\n'},
    {'lines.md':'one\r\ncommon\r\nremote\r\n','empty.md':''});
  assert.deepEqual(merged.conflicts,[]);
  assert.equal(await merged.read('lines.md'),'local\ncommon\nremote\n');
  assert.equal(await merged.read('empty.md'),'');
  assert.equal(await merged.read('left.md'),'local\n');
  const {commit}=await git.readCommit({...merged.args,oid:await merged.engine.head()});
  assert.deepEqual(commit.parent,[merged.ours,merged.theirs]);
});

test('Git unions repository rules and archives complete losing versions with local ties',async t=>{
  const merged=await diverge(t,
    {'.gitignore':'base\n','.gitattributes':'* text\n','remote-wins.md':'base\n','tie.md':''},
    {'.gitignore':'base\nleft\ncommon\n','.gitattributes':'* text\n*.png binary\n','remote-wins.md':'本机\n','tie.md':'本机\n'},
    {'.gitignore':'base\nright\ncommon\n','.gitattributes':'* text\n*.jpg binary\n','remote-wins.md':'远端\r\n','tie.md':'远端\r\n'},true);
  assert.deepEqual(merged.conflicts,[]);
  assert.deepEqual((await merged.read('.gitignore')).trim().split('\n').sort(),['base','common','left','right']);
  assert.deepEqual((await merged.read('.gitattributes')).trim().split('\n').sort(),['* text','*.jpg binary','*.png binary']);
  assert(!(await fs.readdir(merged.dir)).some(file=>file.includes('同步冲突')));
  assert.equal(await merged.read('remote-wins.md'),'远端\n');
  assert.equal(await merged.read('tie.md'),'本机\n');
  for(const [name,label,archived] of [['remote-wins.md','远端','本机\n'],['tie.md','本机','远端\r\n']]){
    const file=path.join(merged.dir,name);
    const [version]=await merged.engine.history.list(file);
    assert.match(version.label,new RegExp(label));
    assert.equal(String(await merged.engine.history.read(file,version.id)),archived);
    await merged.engine.restoreVersion(file,version.id);
    assert.equal(await merged.read(name),archived);
  }
});

test('Git applies timestamps to edit/delete conflicts and archives a losing nonempty version',async t=>{
  const merged=await diverge(t,{'remove-local.md':'base\n','remove-remote.md':'base\n'},
    {'remove-local.md':null,'remove-remote.md':'local\n'},
    {'remove-local.md':'remote\n','remove-remote.md':null});
  assert.deepEqual(merged.conflicts,[]);
  assert.equal(await merged.read('remove-local.md'),'remote\n');
  assert.equal(await merged.read('remove-remote.md'),'local\n');
  assert.equal(merged.resolved.length,2);
});

test('adopting a legacy conflict archives both complete versions before changing the file',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-legacy-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const Engine=createGitEngine({fs,path,atomicWrite:fs.writeFile,within:(parent,file)=>withinNativePath(path,parent,file)});
  const engine=new Engine(dir);
  const file=path.join(dir,'note.md'),copy=path.join(dir,'note (同步冲突 2026-11-22 1245).md');
  await fs.writeFile(file,'本机旧版\r\n');
  await fs.writeFile(copy,'另一版\n');
  const hooks={io:fs,write:fs.writeFile,archive:fs.unlink};
  await resolveConflict(engine,{path:file,copy},'apply',hooks);
  assert.equal(await fs.readFile(file,'utf8'),'另一版\n');
  await assert.rejects(fs.access(copy),{code:'ENOENT'});
  const versions=await engine.history.list(file);
  const previous=versions.find(row=>row.label.includes('采用冲突版本前'));
  const legacy=versions.find(row=>row.label.includes('归档的历史冲突副本'));
  assert.equal(String(await engine.history.read(file,previous.id)),'本机旧版\r\n');
  assert.equal(String(await engine.history.read(file,legacy.id)),'另一版\n');
});
