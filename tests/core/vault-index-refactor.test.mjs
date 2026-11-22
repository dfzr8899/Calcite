import assert from 'node:assert/strict';
import {win32 as path} from 'node:path';
import {test} from 'node:test';
import {VaultIndex} from '../../shared/core/vault-index.mjs';
import {planLinkRefactor} from '../../shared/core/link-refactor.mjs';
import {withinNativePath} from '../../shared/core/vault-paths.mjs';

const root='D:\\Vault';
const file=relative=>path.join(root,relative);
const row=(path,text,modified)=>({row:{path,modified},size:text.length,signature:modified+':'+text.length});

function memoryVault(files){
  const reads=[];
  const index=new VaultIndex(root,{
    path,key:filename=>filename.toLowerCase(),
    within:(parent,child)=>withinNativePath(path,parent,child),generation:'memory',
    async read(filename,item){
      reads.push(filename);
      return {item,text:files.get(filename)};
    }
  });
  for(const [name,text] of files)index.observe(name,row(name,text,1));
  return {index,reads};
}

test('rename rewrites wiki aliases, section embeds and relative links while preserving Markdown code',async()=>{
  const source=file('主笔记.md'),old=file('专题/旧 版#.md'),moved=file('归档/新 模板()%#[校验].md');
  const protectedText=[
    '行内 `[[专题/旧 版%23]]`',
    '',
    '> - 嵌套围栏',
    '>',
    '>   ```md',
    '>   [[专题/旧 版%23]] [示例](./专题/旧%20版%23.md)',
    '>   ```',
    '',
    '~~~md',
    '![[专题/旧 版%23#小节]]',
    '~~~'
  ].join('\n');
  const original=['---','example: "[[专题/旧 版%23]]"','---','',
    '[[专题/旧 版%23|别名]] ![[专题/旧 版%23#小节]]',
    '[入口](./专题/旧%20版%23.md#小节)','',protectedText,''].join('\r\n');
  const files=new Map([[source,original],[old,'# 文档\n\n## 小节\n\n正文']]);
  const {index,reads}=memoryVault(files);
  await index.refresh();
  assert.deepEqual(index.notes.get(source.toLowerCase()).wikilinks.map(({alias,heading})=>[alias,heading]),[['别名',''],['','小节']]);
  const {changes,refactor}=await planLinkRefactor(index,old,moved,[],
    async name=>({text:files.get(name),mtime:1}));
  const updated=changes.find(change=>change.from===source).saved;
  assert.deepEqual(refactor,{notes:1,references:3});
  assert(updated.includes('[[新 模板()%25%23%5B校验%5D|别名]]'));
  assert(updated.includes('![[新 模板()%25%23%5B校验%5D#小节]]'));
  assert(updated.includes('[入口](./%E5%BD%92%E6%A1%A3/%E6%96%B0%20%E6%A8%A1%E6%9D%BF%28%29%25%23%5B%E6%A0%A1%E9%AA%8C%5D.md#小节)'));
  assert(updated.includes(protectedText));
  assert(updated.includes('example: "[[专题/旧 版%23]]"'));
  assert(!updated.includes('\r'));
  assert.deepEqual(reads,[source,old]);
});

test('index invalidates one changed note and updates reverse links when a target becomes ambiguous',async()=>{
  const origin=file('起点.md'),left=file('dp/模板.md'),right=file('graph/模板.md');
  const files=new Map([[origin,'段落 [[模板]]'],[left,'# 旧标题']]);
  const {index,reads}=memoryVault(files);
  await index.refresh();
  assert.equal(index.backlinks(left,[])[0].linked[0].line,1);
  reads.length=0;
  files.set(right,'# 同名');
  index.observe(right,row(right,files.get(right),2));
  await index.refresh();
  assert.deepEqual(reads,[right]);
  assert.equal(index.inspect(origin,'模板').status,'ambiguous');
  assert.equal(index.backlinks(left,[])[0]?.linked.length??0,0);
  files.set(origin,'段落 [[dp/模板]]');
  index.observe(origin,row(origin,files.get(origin),3));
  await index.refresh();
  assert.deepEqual(reads,[right,origin]);
  assert.deepEqual(index.graph([]).edges,[{from:origin,to:left}]);
});
