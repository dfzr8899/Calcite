import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSyncScheduler} from '../../shared/core/sync-scheduler.mjs';

const available={connected:true,connectionType:'wifi'};
const policy={enabled:true,configured:false,auto:true,mode:'lan',pending:false,wifiOnly:false};

test('scheduler coalesces local edits into a snapshot even for an unpaired vault',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const events=[];
  const scheduler=createSyncScheduler({policy:()=>policy,network:()=>available,snapshot:async()=>{events.push('snapshot');},
    sync:async()=>assert.fail('unpaired vault must not sync'),probe:async()=>false,snapshotDelay:10});
  t.after(()=>scheduler.dispose());
  scheduler.changed();
  t.mock.timers.tick(9);
  scheduler.changed();
  t.mock.timers.tick(9);
  assert.deepEqual(events,[]);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(events,['snapshot']);
});

test('scheduler serializes concurrent manual requests and keeps one queued rerun',async t=>{
  const requests=[];
  const scheduler=createSyncScheduler({policy:()=>({...policy,configured:true}),network:()=>available,
    snapshot:async()=>{},sync:()=>new Promise(resolve=>requests.push(resolve)),probe:async()=>false});
  t.after(()=>scheduler.dispose());
  const first=scheduler.manual();
  const next=scheduler.manual();
  assert.equal(scheduler.manual(),next);
  await Promise.resolve();
  assert.equal(requests.length,1);
  requests[0]('first');
  assert.equal(await first,'first');
  assert.equal(requests.length,2);
  requests[1]('next');
  assert.equal(await next,'next');
});

test('manual sync on an unreachable network snapshots before reporting offline',async t=>{
  const events=[];
  const scheduler=createSyncScheduler({policy:()=>({...policy,configured:true}),network:()=>({connected:false,connectionType:'none'}),
    snapshot:async()=>{events.push('snapshot');},sync:async()=>assert.fail('offline transport called'),probe:async()=>false,
    onOffline:()=>events.push('offline')});
  t.after(()=>scheduler.dispose());
  await assert.rejects(scheduler.manual(),{code:'SYNC_OFFLINE'});
  assert.deepEqual(events,['snapshot','offline']);
});
