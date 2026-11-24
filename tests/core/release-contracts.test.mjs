import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import git from 'isomorphic-git';
import {normalizeLineEndings} from '../../shared/text-files.mjs';

const source=name=>fs.readFile(new URL('../../'+name,import.meta.url),'utf8');

test('release identity is 1.1.0 and workspace/build artifacts are ignored at every depth',async t=>{
  const [manifest,lock,android,ios,ignore]=await Promise.all(
    ['package.json','package-lock.json','android/app/build.gradle','ios/App/App.xcodeproj/project.pbxproj','.gitignore'].map(source)
  );
  assert.equal(JSON.parse(manifest).version,'1.1.0');
  assert.equal(JSON.parse(lock).packages[''].version,'1.1.0');
  assert.deepEqual([...android.matchAll(/versionName\s+"([^"]+)"/g)].map(match=>match[1]),['1.1.0']);
  assert.deepEqual([...ios.matchAll(/MARKETING_VERSION\s*=\s*([^;]+);/g)].map(match=>match[1]),['1.1.0','1.1.0']);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'calcite-ignore-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await git.init({fs,dir});
  await fs.writeFile(path.join(dir,'.gitignore'),ignore);
  for(const filepath of ['node_modules/example.js','dist/index.html','release/setup.exe','nested/setup.exe','nested/debug.apk',
    'android/app/build/example.bin','android/.gradle/cache','.env','nested/.env.local','vault/.calcite/index-v1.json','.test-data/run/log']){
    assert(await git.isIgnored({fs,dir,filepath}),filepath);
  }
  assert.equal(await git.isIgnored({fs,dir,filepath:'.env.example'}),false);
});

test('LF normalization preserves binary bytes even with a text extension',()=>{
  for(const [file,bytes] of [
    ['fixture.png',Buffer.from('fake\r\nimage')],
    ['nul.md',Buffer.from([65,13,10,0,66])],
    ['control.md',Buffer.from([65,13,10,7,66])],
    ['invalid.md',Buffer.from([65,13,10,255,66])]
  ]) assert.equal(normalizeLineEndings(file,bytes),bytes);
  assert.equal(Buffer.from(normalizeLineEndings('note.md',Buffer.from('\uFEFF甲\r\n乙\r'))).toString(),'\uFEFF甲\n乙\n');
});
