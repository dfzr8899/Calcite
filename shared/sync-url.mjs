import {getLocale, knownDiagnostic, t as tr} from "./i18n/index.mjs";
function privateV4(host) {
  const list=host.split('.');
  if(list.length!==4||list.some(part=>!/^\d{1,3}$/.test(part)||Number(part)>255))return false;
  const [a,b]=list.map(Number);
  return a===10||a===127||a===192&&b===168||a===172&&b>=16&&b<=31||a===100&&b>=64&&b<=127;
}

export function privateSyncHost(host,{proxy=false}={}) {
  const allowedV4=value=>privateV4(value)||proxy&&/^198\.(?:18|19)\.\d{1,3}\.\d{1,3}$/.test(value);
  const name=host.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if(name==='localhost'||name.endsWith('.local')||allowedV4(name))return true;
  if(name.startsWith('::ffff:')) {
    const mapped=name.slice(7);
    if(mapped.includes('.'))return allowedV4(mapped);
    const words=mapped.split(':');
    if(words.length===2&&words.every(part=>/^[0-9a-f]{1,4}$/.test(part))) {
      const [a,b]=words.map(part=>parseInt(part,16));
      return allowedV4([a>>>8,a&255,b>>>8,b&255].join('.'));
    }
  }
  return name==='::1'||/^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(name);
}

export function syncUrl(value,{lan=false,testLoopback=false,request=false}={}) {
  let url;
  try{url=new URL(value);}catch{throw Error(tr("syncUrl.enterAValidSyncAddress"));}
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  const httpAllowed=lan?privateSyncHost(hostname,{proxy:true}):
    testLoopback&&['127.0.0.1','::1','localhost'].includes(hostname);
  if(url.username||url.password||url.hash||(!request&&url.search)||
      !(url.protocol==='https:'||url.protocol==='http:'&&httpAllowed)) {
    throw Error(lan?tr("syncUrl.plainHttpIsLimitedToPrivateNetworks"):
      tr("syncUrl.remoteGitRequiresAnHttpsUrlWithout"));
  }
  return url;
}

export function lanFailure(address,error,status,detail) {
  const target=new URL(address);
  const endpoint=target.hostname+':'+(target.port||(target.protocol==='https:'?443:80));
  const reason=[error?.code,error?.name,error?.message,error?.cause?.code].filter(Boolean).join(' ');
  let code='LAN_UNREACHABLE',summary;
  if(status===401) {
    code='LAN_AUTH';summary=tr("syncUrl.thePairingTokenIsInvalidOrWas");
  }else if(status) {
    const close=getLocale()==='zh-CN'?'）。':'). ';
    const sep=getLocale()==='zh-CN'?' ':'';
    code='LAN_HTTP';summary=`${tr("syncUrl.requestFailedHttp")}${sep}${status}${close}`+(typeof detail==='string'?detail.slice(0,250):'');
  }else if(/timed?\s*out|timeout|etimedout/i.test(reason)) {
    code='LAN_TIMEOUT';summary=tr("syncUrl.connectionTimedOutCheckThatThePhone");
  }else if(/econnrefused|connection refused/i.test(reason)) {
    code='LAN_REFUSED';summary=tr("syncUrl.connectionRefusedCheckThatDesktopSharingIs");
  }else {
    summary=tr("syncUrl.couldNotConnectToThePeerCheck");
    if(error?.message&&(knownDiagnostic(error.message)||/\p{Script=Han}/u.test(error.message)))summary+=' '+error.message;
  }
  return Object.assign(Error(`${tr("syncUrl.lan")} `+endpoint+' · '+summary,{cause:error}),{code});
}

export function peerFailure(error) {
  const failures=error.errors||[error];
  return failures.find(row=>row.code==='LAN_AUTH'||/不匹配|does not match/i.test(row.message))||failures[0];
}
