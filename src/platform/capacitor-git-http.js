import {t as tr} from "../../shared/i18n/index.mjs";
import {Capacitor,CapacitorHttp,registerPlugin} from '@capacitor/core';
import {lanFailure,privateSyncHost,syncUrl} from '../../shared/sync-url.mjs';
import {FILE_LIMIT,OID} from '../../shared/core/git-engine.mjs';
import {hmacSha256} from '../../shared/core/sha.mjs';
import {readPacket} from '../../shared/core/sync-config.mjs';
import {limit as EXCHANGE_LIMIT} from '../../shared/core/sync-exchange.mjs';
import {fromBase64,toBase64} from './capacitor-git-fs.js';
import {nativeSecureStore} from './capacitor-secure-storage.js';

const MAX=96*1024*1024;
const ENC_ALG='aes-256-gcm';
const legacyGitHttp=registerPlugin('CalciteLegacyGitHttp');
let needsLegacyBody;
const encoder=new TextEncoder();
const decoder=new TextDecoder();

function hexToBytes(hex) {
  const bytes=new Uint8Array(hex.length/2);
  for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);
  return bytes;
}
function randomHex(count=12) {
  const bytes=new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function hmacAuthHeader(tokenBytes,method,fullRoute,vaultId) {
  const ts=String(Date.now()),nonce=randomHex(12);
  const sig=hmacSha256(tokenBytes,`${ts}.${nonce}.${method}.${fullRoute}.${vaultId}`);
  return `Calcite-HMAC ${ts}.${nonce}.${sig}`;
}
async function encryptPayload(key,aad,plaintext) {
  const iv=new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const encrypted=new Uint8Array(await globalThis.crypto.subtle.encrypt(
    {name:'AES-GCM',iv,additionalData:encoder.encode(aad)},key,plaintext));
  return {
    iv:toBase64(iv),
    tag:toBase64(encrypted.subarray(encrypted.length-16)),
    ciphertext:encrypted.subarray(0,encrypted.length-16)
  };
}
async function decryptPayload(key,aad,ivBase64,tagBase64,ciphertext) {
  const iv=fromBase64(String(ivBase64||'').replace(/\s/g,''));
  const tag=fromBase64(String(tagBase64||'').replace(/\s/g,''));
  if(iv.length!==12||tag.length!==16)throw Error(tr("lanSync.invalidSyncRequest"));
  const combined=new Uint8Array(ciphertext.length+16);
  combined.set(ciphertext,0);
  combined.set(tag,ciphertext.length);
  return new Uint8Array(await globalThis.crypto.subtle.decrypt(
    {name:'AES-GCM',iv,additionalData:encoder.encode(aad)},key,combined));
}

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
    timer=setTimeout(()=>reject(Object.assign(Error(tr("capacitorGitHttp.nativeRequestTimedOut")),{name:'TimeoutError'})),milliseconds);
    if(signal) {
      cancel=()=>reject(Object.assign(Error(tr("capacitorGitHttp.theSyncRequestWasCanceled")),{name:'AbortError'}));
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
    if(size>MAX)throw Error(tr("capacitorGitHttp.theGitRequestExceedsTheMobileSize"));
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
      if(target.origin!==origin)throw Error(tr("gitSync.crossOriginGitRequestBlocked"));
      if(signal?.aborted)throw Error(tr("capacitorGitHttp.theSyncRequestWasCanceled"));
      const response=await boundedRequest(native,{url:target.href,method,headers,
        ...(body?{data:toBase64(await collect(body)),dataType:'file'}:{}),
        responseType:'arraybuffer',disableRedirects:true,connectTimeout:12000,readTimeout:120000},150000,signal);
      if(response.status>=300&&response.status<400||response.url&&new URL(response.url).origin!==origin)
        throw Error(tr("gitSync.gitServerRedirectBlocked"));
      const fields=Object.fromEntries(Object.entries(response.headers||{}).map(([key,value])=>[key.toLowerCase(),value]));
      // Both native platforms use Base64 for successful arraybuffer responses. Error bodies may be strings or JSON.
      const encoded=typeof response.data==='string'?response.data.replace(/\s/g,''):response.data??'';
      if(typeof encoded==='string'&&encoded.length>Math.ceil(MAX/3)*4)throw Error(tr("capacitorGitHttp.theRemoteResponseExceedsTheMobileSize"));
      const payload=response.status>=200&&response.status<300&&typeof encoded==='string'?fromBase64(encoded):
        new TextEncoder().encode(typeof encoded==='string'?encoded:JSON.stringify(encoded));
      return {statusCode:response.status,statusMessage:'',headers:fields,url:target.href,body:[payload]};
    }
  };
}

export function createCapacitorPeer({url,token,vaultId,native=CapacitorHttp,probeTimeout=6000,transferTimeout=180000}) {
  const base=syncUrl(url,{lan:true});
  if(!/^[0-9a-f]{64}$/.test(token)||!/^[0-9a-f-]{36}$/.test(vaultId))throw Error(tr("capacitorGitHttp.invalidLanPairingDetails"));
  const host=base.href.replace(/\/$/,'');
  const tokenBytes=hexToBytes(token);
  let useHmac=false,encKey=null;
  async function request(route,input,binary=false,upload=false) {
    try {
      const method=input?'POST':'GET';
      const fullRoute='/api/sync/'+route;
      const useEnc=Boolean(encKey)&&route!=='info';
      const aad=`${method} ${fullRoute} ${vaultId}`;
      const headers={
        Authorization:useHmac&&route!=='info'?hmacAuthHeader(tokenBytes,method,fullRoute,vaultId):'Bearer '+token,
        'x-calcite-vault':vaultId,
        'Content-Type':useEnc||upload?'application/octet-stream':'application/json',
        ...(upload?{'x-calcite-object-type':input.type}:{})
      };
      let bodyOptions={};
      if(useEnc) {
        headers['x-calcite-enc']=ENC_ALG;
        if(input) {
          const plain=upload?input.bytes:encoder.encode(JSON.stringify(input));
          const {iv,tag,ciphertext}=await encryptPayload(encKey,aad,plain);
          headers['x-calcite-iv']=iv;
          headers['x-calcite-tag']=tag;
          bodyOptions={data:toBase64(ciphertext),dataType:'file'};
        }
      } else if(upload) {
        bodyOptions={data:toBase64(input.bytes),dataType:'file'};
      } else if(input) {
        bodyOptions={data:input};
      }
      const response=await boundedRequest(native,{url:host+fullRoute,method,headers,...bodyOptions,
        responseType:binary||useEnc?'arraybuffer':'json',disableRedirects:true,
        connectTimeout:route==='info'?4000:10000,readTimeout:route==='info'?4500:transferTimeout},
        route==='info'?probeTimeout:transferTimeout);
      if(response.url&&new URL(response.url).origin!==base.origin)throw Error(tr("capacitorGitHttp.crossOriginRedirectBlocked"));
      const responseHeaders=Object.fromEntries(Object.entries(response.headers||{}).map(([key,value])=>[key.toLowerCase(),value]));
      if(response.status!==200) {
        let detail=typeof response.data==='object'?response.data?.error:undefined;
        if(typeof response.data==='string') {
          if(useEnc&&responseHeaders['x-calcite-enc']===ENC_ALG) {
            try {
              const plain=await decryptPayload(encKey,aad,responseHeaders['x-calcite-iv'],responseHeaders['x-calcite-tag'],
                fromBase64(response.data.replace(/\s/g,'')));
              detail=JSON.parse(decoder.decode(plain))?.error;
            } catch {}
          }
          if(!detail) {
            try{detail=JSON.parse(response.data)?.error;}catch{}
          }
          if(!detail&&(binary||useEnc)) {
            try{detail=JSON.parse(decoder.decode(fromBase64(response.data.replace(/\s/g,''))))?.error;}catch{}
          }
        }
        throw lanFailure(host,null,response.status,detail);
      }
      if(useEnc) {
        if(responseHeaders['x-calcite-enc']!==ENC_ALG)throw Error(tr("lanSync.invalidSyncRequest"));
        const encoded=typeof response.data==='string'?response.data.replace(/\s/g,''):'';
        const maxBytes=binary?FILE_LIMIT:EXCHANGE_LIMIT;
        if(typeof response.data!=='string'||encoded.length>Math.ceil((maxBytes+16)/3)*4)
          throw Error(tr(binary?"lanSync.invalidBinaryObjectResponse":"lanSync.syncRequestExceedsTheSizeLimit"));
        let plain;
        try {
          plain=await decryptPayload(encKey,aad,responseHeaders['x-calcite-iv'],responseHeaders['x-calcite-tag'],
            encoded?fromBase64(encoded):new Uint8Array(0));
        } catch(error) {
          throw Object.assign(Error(tr(binary?"gitEngine.gitObjectHashVerificationFailed":"lanSync.invalidSyncRequest"),{cause:error}),{code:'LAN_INTEGRITY'});
        }
        if(binary)return {headers:responseHeaders,bytes:plain};
        return JSON.parse(decoder.decode(plain));
      }
      if(binary)return {headers:responseHeaders,data:response.data};
      return typeof response.data==='string'?JSON.parse(response.data):response.data;
    }catch(error){throw typeof error?.code==='string'&&error.code.startsWith('LAN_')?error:lanFailure(host,error);}
  }
  const api={
    incremental:false,
    async enableCapabilities(capabilities) {
      if(!capabilities||typeof capabilities!=='object')return;
      if(capabilities.incremental===true)api.incremental=true;
      if(capabilities.hmac===true&&globalThis.crypto?.getRandomValues)useHmac=true;
      if(capabilities.enc===ENC_ALG&&globalThis.crypto?.subtle&&!await usesLegacyBody(native)) {
        try{
          encKey=await globalThis.crypto.subtle.importKey('raw',tokenBytes,'AES-GCM',false,['encrypt','decrypt']);
        }catch{encKey=null;}
      }
    },
    call(route,input) {
      if(!['info','negotiate','objects/pull','objects/push'].includes(route))throw Error(tr("capacitorGitHttp.invalidLanRequestType"));
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
      if(!OID.test(oid))throw Error(tr("capacitorGitHttp.invalidGitObjectId"));
      const response=await request('object/'+oid,null,true);
      const {headers}=response;
      if(response.bytes) {
        if(!String(headers['content-type']).startsWith('application/octet-stream')||response.bytes.length>FILE_LIMIT)
          throw Error(tr("lanSync.invalidBinaryObjectResponse"));
        return {oid,type:headers['x-calcite-object-type'],bytes:response.bytes};
      }
      // Android's Base64.DEFAULT inserts line breaks. Remove them before sizing and decoding chunks.
      const encoded=typeof response.data==='string'?response.data.replace(/\s/g,''):'';
      if(!String(headers['content-type']).startsWith('application/octet-stream')||!encoded||
        encoded.length>Math.ceil(FILE_LIMIT/3)*4)throw Error(tr("lanSync.invalidBinaryObjectResponse"));
      return {oid,type:headers['x-calcite-object-type'],bytes:fromBase64(encoded)};
    }
  };
  return api;
}

export async function importRemoteConfig(packet,native=CapacitorHttp) {
  const {urls,cap,key,expires}=readPacket(packet,'calcite-remote:')||{};
  if(!Array.isArray(urls)||!urls.length||urls.length>3||!/^[0-9a-f]{64}$/.test(cap)||
    typeof key!=='string'||!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+65000)
    throw Error(tr("capacitorGitHttp.theRemoteSetupCodeIsInvalidOr"));
  const endpoints=urls.map(value=>syncUrl(value,{lan:true}));
  if(endpoints.some(endpoint=>!privateSyncHost(endpoint.hostname,{proxy:true})))throw Error(tr("capacitorGitHttp.retrieveRemoteSettingsOverTheLocalNetwork"));
  const subtle=globalThis.crypto?.subtle;
  const password=subtle&&await subtle.importKey('raw',fromBase64(key),'AES-GCM',false,['decrypt']);
  let failure;
  for(const endpoint of endpoints) {
    let response;
    try{
      response=await boundedRequest(native,{url:endpoint.origin+'/api/sync/config',method:'GET',
        headers:{Authorization:'Bearer '+cap},responseType:'json',disableRedirects:true,connectTimeout:3500,readTimeout:5000},6000);
    }catch(error){failure=lanFailure(endpoint.origin,error);continue;}
    if(response.status===404||response.status===410)throw Error(tr("capacitorGitHttp.remoteSettingsWereAlreadyRetrievedOrHave"));
    if(response.status!==200||response.url&&new URL(response.url).origin!==endpoint.origin){
      failure=lanFailure(endpoint.origin,null,response.status);continue;
    }
    try{
      const {iv,data}=typeof response.data==='string'?JSON.parse(response.data):response.data;
      if(typeof iv!=='string'||typeof data!=='string'||data.length>16000)throw Error();
      const plaintext=password?new TextDecoder().decode(await subtle.decrypt({name:'AES-GCM',iv:fromBase64(iv)},password,fromBase64(data))):
        (await nativeSecureStore.decryptPair({key,iv,data})).value;
      return JSON.parse(plaintext);
    }catch{throw Error(tr("capacitorGitHttp.couldNotReadRemoteSettingsGenerateA"));}
  }
  throw failure;
}
