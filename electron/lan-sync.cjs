const http=require('node:http');
const os=require('node:os');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Readable}=require('node:stream');
const {Bonjour}=require('bonjour-service');
const {OID,FILE_LIMIT}=require('./git-engine.cjs');

const prefix='/api/sync/';
const {limit,pullLimit,pushLimit,binaryThreshold,objectBytes,pullEnvelopeBytes,pullObjectBytes,validList,exchange}=require('../shared/core/sync-exchange.mjs');
const {privateSyncHost,syncUrl,lanFailure}=require('../shared/sync-url.mjs');

async function readJSON(stream,max=limit) {
  let size=0;const chunks=[];
  for await(const chunk of stream) {
    const bytes=Buffer.from(chunk);size+=bytes.length;
    if(size>max)throw Error('同步请求超过体积上限。');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
function validAuth(header,token) {
  const expected=Buffer.from('Bearer '+token),given=Buffer.from(header||'');
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

async function listenPeer({engine,vaultId,deviceName,token,port=0,prepare,receive,onError,network=true}) {
  const bucket=new Map();
  let closed=false,activeTransfers=0;
  const service=http.createServer(async(req,res)=>{
    const send=(status,payload)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload));};
    const now=Date.now(),address=req.socket.remoteAddress;
    let rate=bucket.get(address);
    if(!rate||now-rate.since>60000) {
      if(bucket.size>=512)bucket.delete(bucket.keys().next().value);
      bucket.set(address,rate={since:now,requests:0});
    }
    if(!privateSyncHost(address||'',{proxy:true}))return send(403,{error:'仅接受局域网客户端。'});
    if(closed)return send(503,{error:'同步服务已停止。'});
    if(!validAuth(req.headers.authorization,token)||req.headers['x-calcite-vault']!==vaultId) {
      if(++rate.requests>360)return send(429,{error:'请求过于频繁。'});
      return send(401,{error:'配对信息已失效或无权访问。'});
    }
    const route=req.url;
    const transfer=route?.startsWith(prefix+'objects/')||route?.startsWith(prefix+'object/');
    if(transfer&&activeTransfers>=3)return send(429,{error:'桌面正在传输其他对象，请稍后重试。'});
    if(transfer)activeTransfers++;
    try {
      if(req.method==='GET'&&route===prefix+'info')return send(200,{vaultId,deviceName,headOid:await engine.head(),time:new Date().toISOString()});
      if(req.method==='GET'&&route?.startsWith(prefix+'object/')) {
        const oid=route.slice((prefix+'object/').length);
        if(!OID.test(oid)||!await engine.hasObject(await engine.head(),oid))return send(404,{error:'共享分支不包含该对象。'});
        const {type,bytes}=await engine.binaryObject(oid);
        res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
          'Content-Length':bytes.length,'x-calcite-object-type':type});
        await pipeline(Readable.from([bytes]),res);
        return;
      }
      if(req.method==='POST'&&route?.startsWith(prefix+'object/')) {
        const oid=route.slice((prefix+'object/').length),type=req.headers['x-calcite-object-type'];
        if(!OID.test(oid)||!['blob','tree','commit'].includes(type)||req.headers['content-type']!=='application/octet-stream')
          return send(415,{error:'二进制 Git 对象请求无效。'});
        const size=Number(req.headers['content-length']);
        if(!Number.isSafeInteger(size)||size<=0||size>FILE_LIMIT)return send(413,{error:'Git 对象超过大小上限。'});
        const bytes=Buffer.allocUnsafe(size);let offset=0;
        for await(const chunk of req) {
          if(offset+chunk.length>size)throw Error('二进制 Git 对象长度无效。');
          chunk.copy(bytes,offset);offset+=chunk.length;
        }
        if(offset!==size)throw Error('二进制 Git 对象未接收完整。');
        await engine.acceptBinary({oid,type,bytes});
        return send(200,{accepted:1});
      }
      if(req.method!=='POST'||![prefix+'negotiate',prefix+'objects/pull',prefix+'objects/push'].includes(route))return send(404,{error:'接口不存在。'});
      if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(415,{error:'需要 JSON 请求。'});
      if(Number(req.headers['content-length'])>limit)return send(413,{error:'同步请求超过体积上限。'});
      const data=await readJSON(req,route===prefix+'objects/push'?limit:4*1024*1024);
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error('同步请求无效。');
      if(route===prefix+'negotiate') {
        if(!validList(data.known)||data.headOid!=null&&!OID.test(data.headOid))throw Error('协商对象列表无效。');
        await prepare();
        const headOid=await engine.head(),objects=await engine.objects(headOid),known=new Set(data.known),ours=new Set(objects);
        const shallow=[...await engine.shallow()].filter(oid=>ours.has(oid));
        return send(200,{headOid,binaryPush:true,shallow,need:data.known.filter(oid=>!ours.has(oid)),available:objects.filter(oid=>!known.has(oid))});
      }
      if(route===prefix+'objects/pull') {
        if(!validList(data.oids)||data.oids.length>96)throw Error('请求对象批次无效。');
        const head=await engine.head();
        for(const oid of data.oids)
          if(!await engine.hasObject(head,oid))throw Error('只能下载共享分支可达的 Git 对象。');
        const objects=[];
        let size=pullEnvelopeBytes;
        for(const oid of data.oids) {
          const expected=engine.objectSize(oid);
          const exceeds=(type,bytes)=>size+Number(objects.length>0)+pullObjectBytes(oid,type,Math.ceil(bytes/3)*4)>pullLimit;
          if(expected!==undefined&&(exceeds('commit',expected)||data.binary&&expected>binaryThreshold)){
            if(objects.length)break;
            if(data.binary)return send(200,{objects,binary:oid});
            return send(413,{error:'此 Git 对象需通过二进制通道下载，请更新客户端。'});
          }
          const row=await engine.binaryObject(oid);
          if(exceeds(row.type,row.bytes.length)||data.binary&&row.bytes.length>binaryThreshold) {
            if(objects.length)break;
            if(data.binary)return send(200,{objects,binary:oid});
            return send(413,{error:'此 Git 对象需通过二进制通道下载，请更新客户端。'});
          }
          const data64=Buffer.from(row.bytes.buffer,row.bytes.byteOffset,row.bytes.byteLength).toString('base64');
          size+=Number(objects.length>0)+pullObjectBytes(oid,row.type,data64.length);
          objects.push({oid,type:row.type,data:data64});
        }
        return send(200,{objects});
      }
      if(!Array.isArray(data.objects)||data.objects.length>96||data.headOid!=null&&!OID.test(data.headOid))throw Error('上传对象批次无效。');
      if(data.objects.some(row=>typeof row?.data!=='string'||objectBytes(row.data)>FILE_LIMIT)||
        data.objects.length>1&&data.objects.reduce((sum,row)=>sum+objectBytes(row.data),0)>pushLimit)
        return send(413,{error:'上传对象批次超过大小上限。'});
      await engine.accept(data.objects);
      if(data.shallow!==undefined&&!validList(data.shallow))throw Error('浅历史边界无效。');
      if(data.headOid!=null)await receive(data.headOid,data.shallow);
      return send(200,{accepted:data.objects.length,headOid:await engine.head()});
    }catch(error){if(!res.headersSent&&!res.destroyed)return send(400,{error:error.message});}
    finally{if(transfer)activeTransfers--;}
  });
  service.headersTimeout=8000;service.requestTimeout=45000;service.keepAliveTimeout=3500;
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
      txt:{vaultId,deviceName,port:String(actual)}}).on('error',onError);
  }catch(error){onError(error);}
  const endpoints=network?localEndpoints(actual):[];
  if(!endpoints.length)endpoints.push('http://127.0.0.1:'+actual);
  return {port:actual,url:endpoints[0],endpoints,
    close(){closed=true;bonjour?.destroy();service.close();service.closeAllConnections();}};
}

function peerClient({url,token,vaultId}) {
  const target=syncUrl(url,{lan:true});
  const host=target.href.replace(/\/$/,'');
  async function request(route,input,read,binary) {
    try{
      const response=await fetch(host+prefix+route,{method:input?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(route==='info'?4500:45000),
      headers:{Authorization:'Bearer '+token,'x-calcite-vault':vaultId,'Content-Type':binary?'application/octet-stream':'application/json',
        ...(binary?{'x-calcite-object-type':input.type}:{})},
      ...(input?{body:binary?input.bytes:JSON.stringify(input)}:{})});
      if(!response.ok) {
        const reply=await readJSON(response.body,8192).catch(()=>null);
        throw lanFailure(host,null,response.status,reply?.error);
      }
      return await read(response);
    }catch(error){throw error.code?.startsWith('LAN_')?error:lanFailure(host,error);}
  }
  return {
    call:(route,input)=>request(route,input,response=>readJSON(response.body,route==='objects/pull'?pullLimit:limit)),
    writeObject:row=>request('object/'+row.oid,row,response=>readJSON(response.body),true),
    readObject:oid=>request('object/'+oid,null,async response=>{
      const size=Number(response.headers.get('content-length'));
      if(!Number.isSafeInteger(size)||size<=0||size>FILE_LIMIT||
        response.headers.get('content-type')!=='application/octet-stream') {
        await response.body?.cancel();
        throw Error('二进制对象响应无效。');
      }
      return {oid,type:response.headers.get('x-calcite-object-type'),bytes:new Uint8Array(await response.arrayBuffer())};
    })
  };
}

module.exports={listenPeer,peerClient,exchange,localEndpoints};
