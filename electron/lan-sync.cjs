const {t:tr}=require("../shared/i18n/index.mjs");
const http=require('node:http');
const os=require('node:os');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Readable}=require('node:stream');
const {Bonjour}=require('bonjour-service');
const {OID,FILE_LIMIT}=require('./git-engine.cjs');
const {hmacSha256}=require('../shared/core/sha.mjs');

const prefix='/api/sync/';
const {limit,pullLimit,pushLimit,binaryThreshold,objectBytes,pullEnvelopeBytes,pullObjectBytes,validList,exchange}=require('../shared/core/sync-exchange.mjs');
const {privateSyncHost,syncUrl,lanFailure}=require('../shared/sync-url.mjs');
const ENC_ALG='aes-256-gcm';
const HMAC_WINDOW_MS=5*60*1000;

async function readBytes(stream,max=limit) {
  let size=0;const chunks=[];
  for await(const chunk of stream) {
    const bytes=Buffer.from(chunk);size+=bytes.length;
    if(size>max)throw Error(tr("lanSync.syncRequestExceedsTheSizeLimit"));
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
async function readJSON(stream,max=limit) {
  const bytes=await readBytes(stream,max);
  return JSON.parse(bytes.toString('utf8')||'{}');
}
function encryptPayload(token,aad,plaintext) {
  const key=Buffer.from(token,'hex'),iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv(ENC_ALG,key,iv);
  cipher.setAAD(Buffer.from(aad,'utf8'));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext};
}
function decryptPayload(token,aad,ivBase64,tagBase64,ciphertext) {
  const iv=Buffer.from(String(ivBase64||''),'base64'),tag=Buffer.from(String(tagBase64||''),'base64');
  if(iv.length!==12||tag.length!==16)throw Error(tr("lanSync.invalidSyncRequest"));
  const decipher=crypto.createDecipheriv(ENC_ALG,Buffer.from(token,'hex'),iv);
  decipher.setAAD(Buffer.from(aad,'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]);
}
function hmacAuthHeader(token,method,route,vaultId) {
  const ts=String(Date.now()),nonce=crypto.randomBytes(12).toString('hex');
  const sig=hmacSha256(Buffer.from(token,'hex'),`${ts}.${nonce}.${method}.${route}.${vaultId}`);
  return `Calcite-HMAC ${ts}.${nonce}.${sig}`;
}
function validAuth(header,token,method,route,vaultId,nonces) {
  const value=String(header||'');
  if(value.startsWith('Calcite-HMAC ')) {
    const parts=value.slice('Calcite-HMAC '.length).split('.');
    if(parts.length!==3||!/^\d{10,16}$/.test(parts[0])||!/^[0-9a-f]{16,64}$/i.test(parts[1])||!/^[0-9a-f]{64}$/i.test(parts[2]))return false;
    const ts=Number(parts[0]),now=Date.now();
    if(Math.abs(now-ts)>HMAC_WINDOW_MS)return false;
    const expected=Buffer.from(hmacSha256(Buffer.from(token,'hex'),`${parts[0]}.${parts[1]}.${method}.${route}.${vaultId}`),'hex');
    const given=Buffer.from(parts[2],'hex');
    if(given.length!==expected.length||!crypto.timingSafeEqual(given,expected))return false;
    if(nonces) {
      if(nonces.has(parts[1]))return false;
      if(nonces.size>=4096)for(const [k,exp] of nonces){if(exp<now||nonces.size>=4096)nonces.delete(k);else break;}
      nonces.set(parts[1],now+HMAC_WINDOW_MS);
    }
    return true;
  }
  const expected=Buffer.from('Bearer '+token),given=Buffer.from(value);
  return given.length===expected.length&&crypto.timingSafeEqual(given,expected);
}
function localEndpoints(port,interfaces=os.networkInterfaces()) {
  const virtual=/(?:VirtualBox|VMware|Hyper-V|WSL|vEthernet|Docker|Meta|Mihomo|Clash|TAP|TUN)/i;
  const candidates=Object.entries(interfaces).flatMap(([name,rows])=>(rows||[]).flatMap(row=>{
    const proxy=/^198\.(?:18|19)\./.test(row.address);
    if(row.internal||!privateSyncHost(row.address,{proxy:true})||/^fe[89ab]/i.test(row.address))return [];
    const priority=(virtual.test(name)||proxy||/^192\.168\.56\./.test(row.address)?2:0)+Number(row.family!=='IPv4');
    return [{priority,address:row.family==='IPv6'?'['+row.address+']':row.address}];
  }));
  const addresses=candidates.sort((a,b)=>a.priority-b.priority).map(row=>row.address);
  return [...new Set(addresses)].map(address=>'http://'+address+':'+port);
}

async function listenPeer({engine,vaultId,deviceName,token,port=0,prepare,receive,onError=()=>{},network=true}) {
  const bucket=new Map(),nonces=new Map();
  let closed=false,activeTransfers=0;
  const service=http.createServer(async(req,res)=>{
    const route=req.url||'';
    const wantEncrypted=req.headers['x-calcite-enc']===ENC_ALG;
    const aad=`${req.method} ${route} ${vaultId}`;
    const send=(status,payload)=>{
      const raw=Buffer.from(JSON.stringify(payload),'utf8');
      if(wantEncrypted&&status<500&&status!==401&&status!==403&&status!==429) {
        const {iv,tag,ciphertext}=encryptPayload(token,aad,raw);
        res.writeHead(status,{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
          'x-calcite-enc':ENC_ALG,'x-calcite-iv':iv,'x-calcite-tag':tag,'Content-Length':ciphertext.length});
        res.end(ciphertext);
        return;
      }
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(raw);
    };
    const now=Date.now(),address=req.socket.remoteAddress;
    let rate=bucket.get(address);
    if(!rate||now-rate.since>60000) {
      if(bucket.size>=512)bucket.delete(bucket.keys().next().value);
      bucket.set(address,rate={since:now,requests:0});
    }
    if(!privateSyncHost(address||'',{proxy:true}))return send(403,{error:tr("lanSync.onlyLanClientsAreAllowed")});
    if(closed)return send(503,{error:tr("lanSync.syncServiceHasStopped")});
    if(!validAuth(req.headers.authorization,token,req.method,route,vaultId,nonces)||req.headers['x-calcite-vault']!==vaultId) {
      if(++rate.requests>360)return send(429,{error:tr("lanSync.tooManyRequests")});
      return send(401,{error:tr("lanSync.pairingHasExpiredOrIsNotAuthorized")});
    }
    const transfer=route.startsWith(prefix+'objects/')||route.startsWith(prefix+'object/');
    if(transfer&&activeTransfers>=3)return send(429,{error:tr("lanSync.theDesktopIsTransferringOtherObjectsTry")});
    if(transfer)activeTransfers++;
    try {
      if(req.method==='GET'&&route===prefix+'info')return send(200,{vaultId,deviceName,headOid:await engine.head(),
        time:new Date().toISOString(),capabilities:{incremental:true,enc:ENC_ALG,hmac:true}});
      if(req.method==='GET'&&route.startsWith(prefix+'object/')) {
        const oid=route.slice((prefix+'object/').length);
        if(!OID.test(oid)||!await engine.hasObject(await engine.head(),oid))return send(404,{error:tr("lanSync.theSharedBranchDoesNotContainThis")});
        const {type,bytes}=await engine.binaryObject(oid);
        if(wantEncrypted) {
          const {iv,tag,ciphertext}=encryptPayload(token,aad,Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength));
          res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
            'Content-Length':ciphertext.length,'x-calcite-object-type':type,'x-calcite-enc':ENC_ALG,'x-calcite-iv':iv,'x-calcite-tag':tag});
          await pipeline(Readable.from([ciphertext]),res);
          return;
        }
        res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
          'Content-Length':bytes.length,'x-calcite-object-type':type});
        await pipeline(Readable.from([bytes]),res);
        return;
      }
      if(req.method==='POST'&&route.startsWith(prefix+'object/')) {
        const oid=route.slice((prefix+'object/').length),type=req.headers['x-calcite-object-type'];
        if(!OID.test(oid)||!['blob','tree','commit'].includes(type)||req.headers['content-type']!=='application/octet-stream')
          return send(415,{error:tr("lanSync.invalidBinaryGitObjectRequest")});
        const size=Number(req.headers['content-length']);
        if(!Number.isSafeInteger(size)||size<=0||size>FILE_LIMIT)return send(413,{error:tr("lanSync.gitObjectExceedsTheSizeLimit")});
        const rawBytes=Buffer.allocUnsafe(size);let offset=0;
        for await(const chunk of req) {
          if(offset+chunk.length>size)throw Error(tr("lanSync.invalidBinaryGitObjectLength"));
          chunk.copy(rawBytes,offset);offset+=chunk.length;
        }
        if(offset!==size)throw Error(tr("lanSync.theBinaryGitObjectWasNotReceived"));
        const bytes=wantEncrypted?decryptPayload(token,aad,req.headers['x-calcite-iv'],req.headers['x-calcite-tag'],rawBytes):rawBytes;
        await engine.acceptBinary({oid,type,bytes});
        return send(200,{accepted:1});
      }
      if(req.method!=='POST'||![prefix+'negotiate',prefix+'objects/pull',prefix+'objects/push'].includes(route))return send(404,{error:tr("lanSync.endpointNotFound")});
      const contentType=String(req.headers['content-type']||'');
      if(wantEncrypted?contentType!=='application/octet-stream':!contentType.startsWith('application/json'))
        return send(415,{error:tr("lanSync.aJsonRequestIsRequired")});
      if(Number(req.headers['content-length'])>limit)return send(413,{error:tr("lanSync.syncRequestExceedsTheSizeLimit")});
      const maxRead=route===prefix+'objects/push'?limit:8*1024*1024;
      let data;
      if(wantEncrypted) {
        const cipherBytes=await readBytes(req,maxRead);
        const plain=decryptPayload(token,aad,req.headers['x-calcite-iv'],req.headers['x-calcite-tag'],cipherBytes);
        data=JSON.parse(plain.toString('utf8')||'{}');
      } else data=await readJSON(req,maxRead);
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error(tr("lanSync.invalidSyncRequest"));
      if(route===prefix+'negotiate') {
        if(!validList(data.known)||data.headOid!=null&&!OID.test(data.headOid))throw Error(tr("lanSync.invalidObjectNegotiationList"));
        if(data.anchor!=null&&!OID.test(data.anchor))throw Error(tr("lanSync.invalidObjectNegotiationList"));
        await prepare();
        const headOid=await engine.head();
        if(data.anchor) {
          const canDelta=await engine.hasCommit(data.anchor);
          if(!canDelta)return send(200,{headOid,binaryPush:true,anchorMatched:false,available:[],need:[]});
          const objects=await engine.objectsSince(headOid,data.anchor),known=new Set(data.known),ours=new Set(objects);
          const shallow=[...await engine.shallow()].filter(oid=>ours.has(oid));
          return send(200,{headOid,binaryPush:true,anchorMatched:true,shallow,
            need:data.known.filter(oid=>!ours.has(oid)),available:objects.filter(oid=>!known.has(oid))});
        }
        const objects=await engine.objects(headOid),known=new Set(data.known),ours=new Set(objects);
        const shallow=[...await engine.shallow()].filter(oid=>ours.has(oid));
        return send(200,{headOid,binaryPush:true,shallow,need:data.known.filter(oid=>!ours.has(oid)),available:objects.filter(oid=>!known.has(oid))});
      }
      if(route===prefix+'objects/pull') {
        if(!validList(data.oids)||data.oids.length>96)throw Error(tr("lanSync.invalidObjectRequestBatch"));
        const head=await engine.head();
        for(const oid of data.oids)
          if(!await engine.hasObject(head,oid))throw Error(tr("lanSync.onlyGitObjectsReachableFromTheShared"));
        const objects=[];
        let size=pullEnvelopeBytes;
        for(const oid of data.oids) {
          const expected=engine.objectSize(oid);
          const exceeds=(type,bytes)=>size+Number(objects.length>0)+pullObjectBytes(oid,type,Math.ceil(bytes/3)*4)>pullLimit;
          if(expected!==undefined&&(exceeds('commit',expected)||data.binary&&expected>binaryThreshold)){
            if(objects.length)break;
            if(data.binary)return send(200,{objects,binary:oid});
            return send(413,{error:tr("lanSync.updateYourClientToDownloadThisGit")});
          }
          const row=await engine.binaryObject(oid);
          if(exceeds(row.type,row.bytes.length)||data.binary&&row.bytes.length>binaryThreshold) {
            if(objects.length)break;
            if(data.binary)return send(200,{objects,binary:oid});
            return send(413,{error:tr("lanSync.updateYourClientToDownloadThisGit")});
          }
          const data64=Buffer.from(row.bytes.buffer,row.bytes.byteOffset,row.bytes.byteLength).toString('base64');
          size+=Number(objects.length>0)+pullObjectBytes(oid,row.type,data64.length);
          objects.push({oid,type:row.type,data:data64});
        }
        return send(200,{objects});
      }
      if(!Array.isArray(data.objects)||data.objects.length>96||data.headOid!=null&&!OID.test(data.headOid))throw Error(tr("lanSync.invalidObjectUploadBatch"));
      if(data.objects.some(row=>typeof row?.data!=='string'||objectBytes(row.data)>FILE_LIMIT)||
        data.objects.length>1&&data.objects.reduce((sum,row)=>sum+objectBytes(row.data),0)>pushLimit)
        return send(413,{error:tr("lanSync.objectUploadBatchExceedsTheSizeLimit")});
      await engine.accept(data.objects);
      if(data.shallow!==undefined&&!validList(data.shallow))throw Error(tr("lanSync.invalidShallowHistoryBoundary"));
      if(data.headOid!=null)await receive(data.headOid,data.shallow);
      return send(200,{accepted:data.objects.length,headOid:await engine.head()});
    }catch(error){if(!res.headersSent&&!res.destroyed)return send(400,{error:error.message});}
    finally{if(transfer)activeTransfers--;}
  });
  service.headersTimeout=8000;service.requestTimeout=180000;service.keepAliveTimeout=3500;
  await new Promise((resolve,reject)=>{
    service.once('error',reject);
    const listening=()=>{service.removeListener('error',reject);resolve();};
    service.listen(port,network?'::':'127.0.0.1',listening);
  });
  service.on('error',onError);
  const actual=service.address().port;
  let bonjour;
  if(network)try{
    bonjour=new Bonjour({},onError);
    bonjour.publish({name:'Calcite '+vaultId.slice(0,8),type:'calcite-sync',port:actual,
      txt:{deviceName,port:String(actual)}}).on('error',onError);
  }catch(error){onError(error);}
  const endpoints=network?localEndpoints(actual):[];
  if(!endpoints.length)endpoints.push('http://127.0.0.1:'+actual);
  return {port:actual,url:endpoints[0],endpoints,
    close(){closed=true;bonjour?.destroy();service.close();service.closeAllConnections();}};
}

function peerClient({url,token,vaultId}) {
  const target=syncUrl(url,{lan:true});
  const host=target.href.replace(/\/$/,'');
  let encrypted=false,useHmac=false;
  async function request(route,input,read,binary) {
    const method=input?'POST':'GET';
    const fullRoute=prefix+route;
    const encryptNow=encrypted&&route!=='info';
    const aad=`${method} ${fullRoute} ${vaultId}`;
    const headers={
      Authorization:useHmac&&route!=='info'?hmacAuthHeader(token,method,fullRoute,vaultId):'Bearer '+token,
      'x-calcite-vault':vaultId,
      'Content-Type':binary||encryptNow?'application/octet-stream':'application/json',
      ...(binary?{'x-calcite-object-type':input.type}:{})
    };
    let body;
    if(input){
      const plain=binary?Buffer.from(input.bytes.buffer,input.bytes.byteOffset,input.bytes.byteLength):Buffer.from(JSON.stringify(input),'utf8');
      if(encryptNow){
        const sealed=encryptPayload(token,aad,plain);
        headers['x-calcite-enc']=ENC_ALG;headers['x-calcite-iv']=sealed.iv;headers['x-calcite-tag']=sealed.tag;
        body=sealed.ciphertext;
      }else body=plain;
    }else if(encryptNow) headers['x-calcite-enc']=ENC_ALG;
    try{
      const response=await fetch(host+fullRoute,{method,redirect:'error',signal:AbortSignal.timeout(route==='info'?4500:180000),
      headers,...(body!==undefined?{body}:{})});
      if(!response.ok) {
        let reply=null;
        if(encryptNow&&response.headers.get('x-calcite-enc')===ENC_ALG) {
          try {
            const raw=await readBytes(response.body,8192);
            reply=JSON.parse(decryptPayload(token,aad,response.headers.get('x-calcite-iv'),response.headers.get('x-calcite-tag'),raw).toString('utf8')||'{}');
          } catch {}
        } else {
          reply=await readJSON(response.body,8192).catch(()=>null);
        }
        throw lanFailure(host,null,response.status,reply?.error);
      }
      if(encryptNow) {
        if(response.headers.get('x-calcite-enc')!==ENC_ALG)throw Error(tr("lanSync.invalidSyncRequest"));
        const raw=await readBytes(response.body,route==='objects/pull'?pullLimit+64:route.startsWith('object/')?FILE_LIMIT:limit);
        let plain;
        try {
          plain=decryptPayload(token,aad,response.headers.get('x-calcite-iv'),response.headers.get('x-calcite-tag'),raw);
        } catch(error) {
          throw Object.assign(Error(tr(route.startsWith('object/')?"gitEngine.gitObjectHashVerificationFailed":"lanSync.invalidSyncRequest"),{cause:error}),{code:'LAN_INTEGRITY'});
        }
        return await read(response,plain);
      }
      return await read(response);
    }catch(error){throw typeof error?.code==='string'&&error.code.startsWith('LAN_')?error:lanFailure(host,error);}
  }
  const api={
    incremental:false,
    enableCapabilities(capabilities){
      if(!capabilities)return;
      if(capabilities.incremental)api.incremental=true;
      if(capabilities.enc===ENC_ALG)encrypted=true;
      if(capabilities.hmac)useHmac=true;
    },
    call:(route,input)=>request(route,input,async(response,plain)=>plain?JSON.parse(plain.toString('utf8')||'{}'):readJSON(response.body,route==='objects/pull'?pullLimit:limit)),
    writeObject:row=>request('object/'+row.oid,row,async(response,plain)=>plain?JSON.parse(plain.toString('utf8')||'{}'):readJSON(response.body),true),
    readObject:oid=>request('object/'+oid,null,async(response,plain)=>{
      const size=Number(response.headers.get('content-length'));
      if(!Number.isSafeInteger(size)||size<=0||size>FILE_LIMIT||
        response.headers.get('content-type')!=='application/octet-stream') {
        await response.body?.cancel();
        throw Error(tr("lanSync.invalidBinaryObjectResponse"));
      }
      const bytes=plain?new Uint8Array(plain.buffer,plain.byteOffset,plain.byteLength):new Uint8Array(await response.arrayBuffer());
      return {oid,type:response.headers.get('x-calcite-object-type'),bytes};
    })
  };
  return api;
}

module.exports={listenPeer,peerClient,exchange,localEndpoints};
