import {Capacitor,CapacitorHttp,registerPlugin} from '@capacitor/core';
import {lanFailure,privateSyncHost,syncUrl} from '../../shared/sync-url.mjs';
import {FILE_LIMIT,OID} from '../../shared/core/git-engine.mjs';
import {readPacket} from '../../shared/core/sync-config.mjs';
import {fromBase64,toBase64} from './capacitor-git-fs.js';
import {nativeSecureStore} from './capacitor-secure-storage.js';

const MAX=96*1024*1024;
const legacyGitHttp=registerPlugin('CalciteLegacyGitHttp');
let needsLegacyBody;

function usesLegacyBody(native) {
  if(native!==CapacitorHttp||Capacitor.getPlatform()!=='android'||!Capacitor.isPluginAvailable('CalciteLegacyGitHttp'))return false;
  return needsLegacyBody??=legacyGitHttp.required().then(result=>result.value);
}
async function nativeRequest(native,options) {
  if(options.dataType==='file'&&await usesLegacyBody(native))return legacyGitHttp.request(options);
  return native.request(options);
}
async function boundedRequest(native,options,milliseconds,signal) {
  let timer,cancel;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Object.assign(Error('原生请求超时'),{name:'TimeoutError'})),milliseconds);
    if(signal) {
      cancel=()=>reject(Object.assign(Error('同步请求已取消。'),{name:'AbortError'}));
      signal.addEventListener('abort',cancel,{once:true});
      if(signal.aborted)cancel();
    }
  });
  try{return await Promise.race([deadline,nativeRequest(native,options)]);}
  finally{clearTimeout(timer);if(cancel)signal.removeEventListener('abort',cancel);}
}
async function collect(body) {
  const chunks=[];
  let size=0;
  for await(const row of body instanceof Uint8Array?[body]:body) {
    const chunk=typeof row==='string'?new TextEncoder().encode(row):new Uint8Array(row);
    size+=chunk.length;
    if(size>MAX)throw Error('Git 协议请求超过手机端体积上限。');
    chunks.push(chunk);
  }
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return bytes;
}

export function createCapacitorGitHttp(repo,{native=CapacitorHttp,testLoopback=false}={}) {
  const origin=syncUrl(repo,{testLoopback}).origin;
  return {
    async request({url,method='GET',headers={},body,signal}) {
      const target=syncUrl(url,{testLoopback,request:true});
      if(target.origin!==origin)throw Error('拒绝跨站 Git 请求。');
      if(signal?.aborted)throw Error('同步请求已取消。');
      const response=await boundedRequest(native,{url:target.href,method,headers,
        ...(body?{data:toBase64(await collect(body)),dataType:'file'}:{}),
        responseType:'arraybuffer',disableRedirects:true,connectTimeout:12000,readTimeout:40000},45000,signal);
      if(response.status>=300&&response.status<400||response.url&&new URL(response.url).origin!==origin)
        throw Error('Git 服务器重定向已拦截。');
      const fields=Object.fromEntries(Object.entries(response.headers||{}).map(([key,value])=>[key.toLowerCase(),value]));
      // Both native platforms use Base64 for successful arraybuffer responses. Error bodies may be strings or JSON.
      const encoded=typeof response.data==='string'?response.data.replace(/\s/g,''):response.data??'';
      if(typeof encoded==='string'&&encoded.length>Math.ceil(MAX/3)*4)throw Error('远端返回体积超过手机端上限。');
      const payload=response.status>=200&&response.status<300&&typeof encoded==='string'?fromBase64(encoded):
        new TextEncoder().encode(typeof encoded==='string'?encoded:JSON.stringify(encoded));
      return {statusCode:response.status,statusMessage:'',headers:fields,url:target.href,body:[payload]};
    }
  };
}

export function createCapacitorPeer({url,token,vaultId,native=CapacitorHttp,probeTimeout=6000,transferTimeout=45000}) {
  const base=syncUrl(url,{lan:true});
  if(!/^[0-9a-f]{64}$/.test(token)||!/^[0-9a-f-]{36}$/.test(vaultId))throw Error('局域网配对资料无效。');
  const host=base.href.replace(/\/$/,'');
  async function request(route,input,binary=false,upload=false) {
    try {
      const response=await boundedRequest(native,{url:host+'/api/sync/'+route,method:input?'POST':'GET',
        headers:{Authorization:'Bearer '+token,'x-calcite-vault':vaultId,'Content-Type':upload?'application/octet-stream':'application/json',
          ...(upload?{'x-calcite-object-type':input.type}:{})},
        ...(upload?{data:toBase64(input.bytes),dataType:'file'}:input?{data:input}:{}),
        responseType:binary?'arraybuffer':'json',disableRedirects:true,
        connectTimeout:route==='info'?4000:10000,readTimeout:route==='info'?4500:45000},
        route==='info'?probeTimeout:transferTimeout);
      if(response.url&&new URL(response.url).origin!==base.origin)throw Error('已拦截跨站重定向。');
      if(response.status!==200) {
        let detail=response.data?.error;
        if(!binary&&typeof response.data==='string') {
          try{detail=JSON.parse(response.data)?.error;}catch{}
        }
        throw lanFailure(host,null,response.status,detail);
      }
      if(binary)return response;
      return typeof response.data==='string'?JSON.parse(response.data):response.data;
    }catch(error){throw error.code?.startsWith('LAN_')?error:lanFailure(host,error);}
  }
  return {
    call(route,input) {
      if(!['info','negotiate','objects/pull','objects/push'].includes(route))throw Error('局域网请求类型无效。');
      return request(route,input);
    },
    async canWriteObject() {
      const legacy=usesLegacyBody(native);
      if(!legacy)return true;
      let timer;
      try{return !await Promise.race([legacy,new Promise(resolve=>{timer=setTimeout(()=>resolve(true),probeTimeout);})]);}
      finally{clearTimeout(timer);}
    },
    writeObject:row=>request('object/'+row.oid,row,false,true),
    async readObject(oid) {
      if(!OID.test(oid))throw Error('Git 对象 ID 无效。');
      const response=await request('object/'+oid,null,true);
      const headers=Object.fromEntries(Object.entries(response.headers||{}).map(([key,value])=>[key.toLowerCase(),value]));
      // Android's Base64.DEFAULT inserts line breaks. Remove them before sizing and decoding chunks.
      const encoded=typeof response.data==='string'?response.data.replace(/\s/g,''):'';
      if(!String(headers['content-type']).startsWith('application/octet-stream')||!encoded||
        encoded.length>Math.ceil(FILE_LIMIT/3)*4)throw Error('二进制对象响应无效。');
      return {oid,type:headers['x-calcite-object-type'],bytes:fromBase64(encoded)};
    }
  };
}

export async function importRemoteConfig(packet,native=CapacitorHttp) {
  const {urls,cap,key,expires}=readPacket(packet,'calcite-remote:')||{};
  if(!Array.isArray(urls)||!urls.length||urls.length>3||!/^[0-9a-f]{64}$/.test(cap)||
    typeof key!=='string'||!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+65000)
    throw Error('远程配置配对串无效或已过期。');
  const endpoints=urls.map(value=>syncUrl(value,{lan:true}));
  if(endpoints.some(endpoint=>!privateSyncHost(endpoint.hostname,{proxy:true})))throw Error('请通过局域网领取远程配置。');
  const subtle=globalThis.crypto?.subtle;
  const password=subtle&&await subtle.importKey('raw',fromBase64(key),'AES-GCM',false,['decrypt']);
  let failure;
  for(const endpoint of endpoints) {
    let response;
    try{
      response=await boundedRequest(native,{url:endpoint.origin+'/api/sync/config',method:'GET',
        headers:{Authorization:'Bearer '+cap},responseType:'json',disableRedirects:true,connectTimeout:3500,readTimeout:5000},6000);
    }catch(error){failure=lanFailure(endpoint.origin,error);continue;}
    if(response.status===404||response.status===410)throw Error('远程配置已领取或已过期，请在桌面重新生成二维码。');
    if(response.status!==200||response.url&&new URL(response.url).origin!==endpoint.origin){
      failure=lanFailure(endpoint.origin,null,response.status);continue;
    }
    try{
      const {iv,data}=typeof response.data==='string'?JSON.parse(response.data):response.data;
      if(typeof iv!=='string'||typeof data!=='string'||data.length>16000)throw Error();
      const plaintext=password?new TextDecoder().decode(await subtle.decrypt({name:'AES-GCM',iv:fromBase64(iv)},password,fromBase64(data))):
        (await nativeSecureStore.decryptPair({key,iv,data})).value;
      return JSON.parse(plaintext);
    }catch{throw Error('无法读取远程配置，请在桌面重新生成二维码。');}
  }
  throw failure;
}
