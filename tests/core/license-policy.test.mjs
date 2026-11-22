import assert from 'node:assert/strict';
import {test} from 'node:test';
import policy from '../../scripts/check-licenses.cjs';

const {checkLicenses,describe,declaredLicense}=policy;
const location='node_modules/legacy';
const legacy={version:'1.0.0',license:'ISC',integrity:'sha512-fixture'};
const empty={};
const baseline=[describe(location,legacy,empty)];
const lock=(name,entry,manifest=empty)=>({packages:{'':manifest,[name]:entry}});

test('license policy allows selecting an MIT/Apache option and rejects booleans with a required other license',()=>{
  assert(declaredLicense('MIT'));
  assert(declaredLicense('(MPL-2.0 OR Apache-2.0)'));
  assert(declaredLicense('MIT AND Apache-2.0'));
  assert(!declaredLicense('GPL-3.0-only AND (ISC OR MIT OR Zlib)'));
  assert(!declaredLicense('(MIT AND BSD-3-Clause)'));
  assert(!declaredLicense(undefined));
});

test('known exceptions only cover the exact locked installation and dependency scope',()=>{
  assert.deepEqual(checkLicenses(empty,lock(location,legacy),baseline),{accepted:1,violations:[]});
  assert.equal(checkLicenses(empty,lock(location,{...legacy,version:'1.0.1'}),baseline).violations.length,1);
  assert.equal(checkLicenses(empty,lock(location,{...legacy,integrity:'sha512-other'}),baseline).violations.length,1);
  assert.equal(checkLicenses(empty,lock('node_modules/new-lib',legacy),baseline).violations.length,1);
  const direct={dependencies:{legacy:'1.0.0'}};
  assert.equal(checkLicenses(direct,lock(location,legacy,direct),baseline).violations.length,1);
  assert.throws(()=>checkLicenses(direct,lock(location,legacy),baseline),/disagree/);
});
