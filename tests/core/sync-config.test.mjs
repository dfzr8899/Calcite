import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applySettings,defaults,remoteError,vaultRecord,writePacket} from '../../shared/core/sync-config.mjs';

const vaultId='4afc8f91-afc0-4ef5-a1d9-3ad18df20315';
const peer='a'.repeat(64);
const pat='fixture-pat';
const previous={...defaults,mode:'remote',remoteUrl:'https://github.com/test/vault.git',
  peerUrl:'http://192.168.1.5:3900',peerVaultId:vaultId,peerName:'既有设备',endpoints:['http://192.168.1.5:3900']};

test('persisted configuration round-trips without taking ownership of plaintext credentials',()=>{
  const patch={remoteUrl:'https://github.com/test/vault/',pat,peerToken:peer,auto:false};
  const {next,secrets}=applySettings(previous,patch,{});
  const state=vaultRecord(next,{vaultId,lastSynced:'b'.repeat(40),lastSyncedAt:123,conflicts:[{path:'/笔记.md',copy:null}]});
  const json=JSON.stringify(state);
  assert(!json.includes(pat));
  assert(!json.includes(peer));
  const restored=JSON.parse(json);
  assert.deepEqual(applySettings(restored.settings,{},secrets),{next,secrets});
  assert.deepEqual(restored.conflicts,[{path:'/笔记.md',copy:null}]);
  assert.equal(restored.lastSyncedAt,123);
  assert.equal(restored.settings.remoteUrl,previous.remoteUrl);
});

test('PAT survives an equivalent URL, clears for another repository, and respects explicit input',()=>{
  const secrets={pat,peer};
  assert.equal(applySettings(previous,{remoteUrl:'https://github.com/test/vault/'},secrets).secrets.pat,pat);
  assert.equal(applySettings(previous,{remoteUrl:'https://github.com/test/other'},secrets).secrets.pat,'');
  assert.equal(applySettings(previous,{remoteUrl:'https://github.com/test/other',pat:'new-pat'},secrets).secrets.pat,'new-pat');
  assert.equal(applySettings(previous,{pat:''},secrets).secrets.pat,'');
  assert.deepEqual(secrets,{pat,peer});
});

test('peer token follows the vault identity and explicit clearing removes the paired destination',()=>{
  const otherVault='2507964f-5c82-4cc0-8a37-b703095706f8';
  const secrets={pat,peer};
  const move=applySettings(previous,{peerUrl:'http://192.168.1.6:3900'},secrets);
  assert.equal(move.secrets.peer,peer);
  assert.deepEqual(move.next.endpoints,['http://192.168.1.6:3900']);
  assert.equal(applySettings(previous,{peerVaultId:otherVault},secrets).secrets.peer,'');
  const cleared=applySettings(previous,{peerToken:''},secrets);
  assert.deepEqual([cleared.next.peerUrl,cleared.next.peerVaultId,cleared.next.peerName,cleared.next.endpoints,cleared.secrets.peer],
    ['','','',[],'']);
  const pairing=writePacket('calcite-sync:',{vaultId:otherVault,url:'http://192.168.1.6:3900',token:'c'.repeat(64)});
  const linked=applySettings(previous,{pairing,mode:'lan',listen:true},secrets,{mobile:true});
  assert.equal(linked.next.listen,false);
  assert.equal(linked.next.peerVaultId,otherVault);
  assert.equal(linked.secrets.peer,'c'.repeat(64));
});

test('remote diagnostics preserve the underlying error code and redact URLs and bare tokens',()=>{
  const tokens=['ghp_'+'x'.repeat(36),'github_pat_'+'x'.repeat(80),'probe-secret'];
  const error=Error('request failed at https://example.invalid/fixture '+tokens.slice(0,2).join(' ')+' Bearer '+tokens[2]);
  const message=remoteError(Object.assign(error,{code:'ECONNRESET'}));
  assert.match(message,/ECONNRESET/);
  assert(!message.includes('example.invalid'));
  for(const token of tokens)assert(!message.includes(token));
});
