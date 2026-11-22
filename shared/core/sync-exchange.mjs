import {OID} from './git-engine.mjs';

/** @typedef {InstanceType<ReturnType<typeof import('./git-engine.mjs').createGitEngine>>} GitEngine */
/** @typedef {Pick<GitEngine, 'objects'|'accept'|'acceptBinary'|'head'|'objectSize'|'binaryObject'|'object'|'tracked'> & Partial<Pick<GitEngine,'shallow'|'importShallow'>>} ExchangeEngine */
/** @typedef {Awaited<ReturnType<GitEngine['object']>>} EncodedObject */
/** @typedef {Awaited<ReturnType<GitEngine['binaryObject']>>} BinaryObject */
/** @typedef {{available?: string[], need?: string[], shallow?: string[], headOid?: string|null, objects?: EncodedObject[], binary?: string, binaryPush?: boolean}} PeerResponse */
/**
 * @typedef {object} ExchangePeer
 * @property {(route: string, message: Record<string, unknown>) => Promise<PeerResponse>} call
 * @property {(oid: string) => Promise<BinaryObject>} [readObject]
 * @property {(object: BinaryObject) => Promise<unknown>} [writeObject]
 * @property {() => Promise<boolean>} [canWriteObject]
 */
/**
 * @typedef {object} ExchangeOptions
 * @property {(value: {phase: string, done?: number, total?: number}) => void} [progress]
 * @property {number} [batchBytes]
 * @property {(task: () => Promise<void>) => Promise<unknown>|void} [write]
 */

export const limit=72*1024*1024;
export const pullLimit=2*1024*1024;
export const pushLimit=4*1024*1024;
export const binaryThreshold=512*1024;
export const objectBytes=data=>data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);
// Git OIDs, types and Base64 are ASCII, so character counts are wire byte counts here.
export const pullEnvelopeBytes=JSON.stringify({objects:[]}).length;
export const pullObjectBytes=(oid,type,base64Length)=>JSON.stringify({oid,type,data:''}).length+base64Length;
const empty=Object.freeze([]);
const utf8=new TextEncoder();
export const validList=value=>Array.isArray(value)&&value.length<=30000&&value.every(oid=>typeof oid==='string'&&OID.test(oid));

/**
 * @param {ExchangeEngine} engine
 * @param {ExchangePeer} client
 * @param {string|null} head
 * @param {(head: string) => Promise<unknown>} apply
 * @param {ExchangeOptions} [options]
 */
export async function exchange(engine,client,head,apply,{progress=()=>{},batchBytes=pushLimit,write=task=>task()}={}) {
  progress({phase:'negotiate'});
  const known=await engine.objects(head);
  const initial=await client.call('negotiate',{headOid:head,known});
  if(!validList(initial.available)||!validList(initial.need)||initial.headOid!=null&&!OID.test(initial.headOid))throw Error('对端协商响应无效。');
  if(initial.shallow!==undefined&&!validList(initial.shallow))throw Error('对端浅历史边界无效。');
  const pending=initial.available;
  let pulled=0;
  while(pulled<pending.length) {
    progress({phase:'pull',done:pulled,total:pending.length});
    const oids=pending.slice(pulled,pulled+96);
    const {objects,binary}=await client.call('objects/pull',{oids,binary:!!client.readObject});
    if(!Array.isArray(objects)||objects.length>oids.length||objects.some((row,i)=>row?.oid!==oids[i]))throw Error('对端对象响应不完整。');
    if(objects.length&&utf8.encode(JSON.stringify({objects})).length>pullLimit)throw Error('局域网拉取批次超过 2 MiB。');
    if(!objects.length) {
      if(!client.readObject||binary!==oids[0])throw Error('对端对象响应不完整。');
      const object=await client.readObject(binary);
      if(object?.oid!==binary)throw Error('对端二进制对象 ID 不匹配。');
      await write(()=>engine.acceptBinary(object));
      pulled++;
    }else{
      await write(()=>engine.accept(objects));
      pulled+=objects.length;
    }
    progress({phase:'pull',done:pulled,total:pending.length});
  }
  if(initial.headOid){
    if(initial.shallow?.length&&engine.importShallow)await write(()=>engine.importShallow(initial.shallow));
    await apply(initial.headOid);
  }
  const result=await engine.head();
  if(!result||result===initial.headOid)return {push:0,head:result};
  progress({phase:'negotiate'});
  const knownResult=await engine.objects(result);
  const response=await client.call('negotiate',{headOid:result,known:knownResult});
  if(!validList(response.need))throw Error('对端缺失对象列表无效。');
  let batch=[],size=0,pushed=0;
  const send=async()=>{
    if(!batch.length)return;
    await client.call('objects/push',{objects:batch});
    pushed+=batch.length;
    batch=[];size=0;
    progress({phase:'push',done:pushed,total:response.need.length});
  };
  const items=new Set(knownResult);
  progress({phase:'push',done:0,total:response.need.length});
  for(const oid of response.need) {
    if(!items.has(oid))throw Error('对端请求了非共享对象。');
    const expected=engine.objectSize(oid);
    if(batch.length===96||expected!=null&&size+expected>batchBytes)await send();
    if(expected>batchBytes&&response.binaryPush&&client.writeObject&&(!client.canWriteObject||await client.canWriteObject())) {
      await client.writeObject(await engine.binaryObject(oid));
      progress({phase:'push',done:++pushed,total:response.need.length});
      continue;
    }
    const chunk=await engine.object(oid);
    const bytes=objectBytes(chunk.data);
    if(size+bytes>batchBytes)await send();
    batch.push(chunk);size+=bytes;
    if(size>=batchBytes)await send();
  }
  await send();
  const shallow=engine.shallow?[...await engine.shallow()].filter(oid=>items.has(oid)):[];
  await client.call('objects/push',{objects:empty,headOid:result,...(shallow.length?{shallow}:{})});
  const [baseline,final]=await Promise.all([engine.tracked(initial.headOid),engine.tracked(result)]);
  let push=0;
  for(const file of new Set([...final.keys(),...baseline.keys()]))if(final.get(file)!==baseline.get(file))push++;
  return {push,head:result};
}


