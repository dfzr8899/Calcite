import assert from 'node:assert/strict';
import {test} from 'node:test';
import {enterEmbed} from '../../shared/core/transclusion.mjs';

const key=filename=>filename.replaceAll('\\','/').toLowerCase();

test('transclusion stops direct and indirect cycles using canonical note paths',()=>{
  const root=new Set([key('C:\\Vault\\A.md')]);
  assert.equal(enterEmbed(root,'c:/vault/a.md',key),null);
  const nested=enterEmbed(root,'C:/Vault/B.md',key);
  assert.equal(enterEmbed(nested,'C:\\VAULT\\A.md',key),null);
  assert.equal(enterEmbed(nested,'C:/vault/b.md',key),null);
});

test('reusing the same embed on separate branches is not a cycle',()=>{
  const root=new Set(['a.md']);
  const identity=value=>value;
  const left=enterEmbed(enterEmbed(root,'b.md',identity),'d.md',identity);
  const right=enterEmbed(enterEmbed(root,'c.md',identity),'d.md',identity);
  assert.deepEqual([...left],['a.md','b.md','d.md']);
  assert.deepEqual([...right],['a.md','c.md','d.md']);
  assert.deepEqual([...root],['a.md']);
});
