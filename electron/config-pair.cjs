const {t:tr}=require("../shared/i18n/index.mjs");
const http=require('node:http');
const crypto=require('node:crypto');
const QRCode=require('qrcode');
const {privateSyncHost}=require('../shared/sync-url.mjs');
const {writePacket}=require('../shared/core/sync-config.mjs');
const {localEndpoints}=require('./lan-sync.cjs');

async function createConfigPair(config,{network=true}={}) {
  const key=crypto.randomBytes(32),cap=crypto.randomBytes(32),iv=crypto.randomBytes(12);
  const algorithm=crypto.createCipheriv('aes-256-gcm',key,iv);
  const cipher=Buffer.concat([algorithm.update(JSON.stringify(config),'utf8'),algorithm.final(),algorithm.getAuthTag()]);
  const body=JSON.stringify({iv:iv.toString('base64'),data:cipher.toString('base64')});
  const expires=Date.now()+60000;
  let timer,consumed=false;
  const server=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const auth=String(req.headers.authorization||'').match(/^Bearer ([0-9a-f]{64})$/i);
    if(req.method!=='GET'||req.url!=='/api/sync/config'||!privateSyncHost(req.socket.remoteAddress||'',{proxy:true})||
      !auth||!crypto.timingSafeEqual(Buffer.from(auth[1],'hex'),cap)) {
      res.writeHead(404).end();
      return;
    }
    if(consumed||Date.now()>=expires){res.writeHead(410).end();return;}
    consumed=true;
    res.writeHead(200,{'Content-Type':'application/json','Connection':'close'}).end(body);
    server.close();
  });
  server.headersTimeout=5000;
  server.requestTimeout=8000;
  function close(){clearTimeout(timer);server.close();server.closeAllConnections();}
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,network?'::':'127.0.0.1',resolve));
  timer=setTimeout(close,60000).unref();
  try{
    const port=server.address().port;
    const urls=(network?localEndpoints(port):['http://127.0.0.1:'+port]).slice(0,3);
    if(!urls.length)throw Error(tr("configPair.noLanAddressFoundConnectToWi"));
    const packet=writePacket('calcite-remote:',{urls,cap:cap.toString('hex'),key:key.toString('base64'),expires});
    return {close,view:{packet,image:await QRCode.toDataURL(packet,{margin:2,width:300}),expires}};
  }catch(error){close();throw error;}
  finally{key.fill(0);}
}

module.exports={createConfigPair};
