import assert from 'node:assert/strict';
import {test} from 'node:test';
import {exchange,objectBytes,pullLimit,pushLimit} from '../../shared/core/sync-exchange.mjs';

const oid=index=>index.toString(16).padStart(40,'0');
const blob=(id,size=2)=>({oid:id,type:'blob',data:Buffer.alloc(size).toString('base64')});

test('exchange caps pull requests at 96 objects and waits for each write before applying HEAD',async()=>{
  const objects=Array.from({length:130},(_,i)=>oid(i+1));
  const head=oid(200);
  const requests=[],accepts=[],progress=[];
  const engine={objects:async()=>[],head:async()=>head,async accept(rows){accepts.push(...rows.map(row=>row.oid));}};
  const client={async call(route,data){
    if(route==='negotiate')return {headOid:head,available:objects,need:[]};
    assert.equal(route,'objects/pull');
    requests.push(data.oids);
    return {objects:data.oids.map(id=>blob(id))};
  }};
  const result=await exchange(engine,client,null,async remote=>{
    assert.equal(remote,head);
    assert.deepEqual(accepts,objects);
  },{progress:value=>progress.push(value)});
  assert.deepEqual(requests.map(batch=>batch.length),[96,34]);
  assert.deepEqual(progress.at(-1),{phase:'pull',done:130,total:130});
  assert.deepEqual(result,{push:0,head});
});

test('exchange streams a large blob and packs JSON batches under byte and count limits',async()=>{
  const remote=oid(1),head=oid(2),large=oid(3);
  const small=Array.from({length:100},(_,i)=>oid(i+4));
  const full=[large,...small];
  const sends=[],progress=[];
  const engine={
    objects:async value=>value===head?full:[],
    head:async()=>head,
    objectSize:id=>id===large?pushLimit+1:2,
    binaryObject:async id=>({oid:id,type:'blob',bytes:new Uint8Array(pushLimit+1)}),
    object:async id=>{assert.notEqual(id,large);return blob(id);},
    tracked:async id=>id===head?new Map([['large.bin',large]]):new Map()
  };
  let rounds=0;
  const client={
    async call(route,request){
      if(route==='negotiate')return ++rounds===1?{headOid:remote,available:[],need:[]}:{need:full,binaryPush:true};
      assert.equal(route,'objects/push');
      sends.push(request);
      return {};
    },
    async writeObject(row){assert.equal(row.oid,large);assert.equal(row.bytes.length,pushLimit+1);sends.push(row.oid);}
  };
  assert.deepEqual(await exchange(engine,client,null,async()=>{},{progress:value=>progress.push(value)}),{push:1,head});
  assert.equal(sends[0],large);
  assert.deepEqual(sends.slice(1,-1).map(row=>row.objects.length),[96,4]);
  for(const row of sends.slice(1,-1))assert(row.objects.reduce((size,item)=>size+objectBytes(item.data),0)<=pushLimit);
  assert.deepEqual(sends.at(-1),{headOid:head,objects:[]});
  assert.deepEqual(progress.at(-1),{phase:'push',done:101,total:101});
});

test('exchange falls back to bounded JSON batches and rejects reordered pull responses',async()=>{
  const ids=[oid(1),oid(2),oid(3)];
  const sizes=[6,6,3];
  const engine={
    objects:async()=>ids,head:async()=>oid(4),objectSize:()=>undefined,
    object:async id=>blob(id,sizes[ids.indexOf(id)]),tracked:async()=>new Map()
  };
  let rounds=0;
  const writes=[];
  await exchange(engine,{
    async call(route,request){
      if(route==='negotiate')return ++rounds===1?{headOid:null,available:[],need:[]}:{need:ids};
      writes.push(request.objects.map(row=>row.oid));return {};
    }
  },null,async()=>{},{batchBytes:10});
  assert.deepEqual(writes,[[ids[0]],ids.slice(1),[]]);
  await assert.rejects(exchange(engine,{
    async call(route){return route==='negotiate'?{headOid:null,available:ids,need:[]}:{objects:[blob(ids[1])]};}
  },null,async()=>assert.fail('must not apply a partial pull')),/响应不完整/);
});

test('exchange rejects oversized JSON responses before writing to the local object store',async()=>{
  const ids=[oid(1),oid(2)];
  const objects=ids.map(id=>blob(id,pullLimit/2));
  const engine={objects:async()=>[],accept:async()=>assert.fail('oversized response must not reach Git storage')};
  const client={call:async route=>route==='negotiate'?{headOid:oid(3),available:ids,need:[]}:{objects}};
  await assert.rejects(exchange(engine,client,null,async()=>assert.fail('must not apply a partial pull')),/超过 2 MiB/);
});
