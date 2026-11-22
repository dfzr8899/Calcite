import assert from 'node:assert/strict';
import {win32,posix} from 'node:path';
import {test} from 'node:test';
import {posixPath,withinNativePath,withinPosix} from '../../shared/core/vault-paths.mjs';
import {createGitEngine} from '../../shared/core/git-engine.mjs';

test('Windows scope accepts mixed separators and case and rejects sibling roots or other volumes',()=>{
  const root='C:\\Calcite\\算法';
  assert(withinNativePath(win32,root,'c:/calcite/算法/图论/../笔记.md'));
  assert(withinNativePath(win32,root,'C:/Calcite/算法'));
  assert(!withinNativePath(win32,root,'C:/Calcite/算法归档/笔记.md'));
  assert(!withinNativePath(win32,root,'C:/Calcite/算法/../机密.md'));
  assert(!withinNativePath(win32,root,'D:/Calcite/算法/笔记.md'));
  assert(!withinNativePath(win32,'\\\\host\\vault\\notes','\\\\host\\other\\notes'));
});

test('Android Git scope normalizes legacy paths without touching the host filesystem',async()=>{
  const root='/CalciteVaults/算法';
  const Sandbox=createGitEngine({
    fs:{async lstat(){assert.fail('sandboxed paths must skip host lstat');}},
    path:{...posix,resolve:posixPath,join:posixPath},atomicWrite:async()=>{},
    within:withinPosix,sandboxed:true
  });
  const engine=new Sandbox('\\CalciteVaults//算法///');
  assert.equal(await engine.guard.safe('.'),root);
  assert.equal(await engine.guard.safe('\\CalciteVaults\\算法/图论/../笔记.md'),root+'/笔记.md');
  await assert.rejects(engine.guard.safe(root+'/../算法归档/笔记.md'),/超出/);
  await assert.rejects(engine.guard.safe(root+'/驱动器:笔记.md'),/路径无效/);
  assert.throws(()=>posixPath('/../笔记.md'),{code:'EACCES'});
  assert.throws(()=>posixPath(root,'bad\0path'),{code:'EINVAL'});
});
