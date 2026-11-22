/** @import {SyncConfig} from './types.mjs' */
/** @typedef {'snapshot'|'sync'|'probe'} RequestKind */
/** @typedef {Pick<SyncConfig, 'enabled'|'mode'|'auto'|'wifiOnly'> & {configured: boolean, pending: boolean}} SyncPolicy */
/** @typedef {{kind: RequestKind, manual: boolean, promise: Promise<unknown>, resolve: (value: unknown) => void, reject: (error: unknown) => void}} QueuedSync */
/**
 * @typedef {object} SchedulerOptions
 * @property {() => SyncPolicy} policy
 * @property {() => {connected: boolean, connectionType: string}} network
 * @property {() => Promise<unknown>} snapshot
 * @property {() => Promise<unknown>} sync
 * @property {() => Promise<boolean>} probe
 * @property {() => void} [onOffline]
 * @property {(error: unknown, manual: boolean) => void} [onError]
 * @property {number} [snapshotDelay]
 * @property {number} [syncDelay]
 * @property {number} [cooldown]
 * @property {number[]} [backoff]
 */

/** @param {SchedulerOptions} options */
export function createSyncScheduler({policy,network,snapshot,sync,probe,onOffline=()=>{},onError=()=>{},
  snapshotDelay=2500,syncDelay=12000,cooldown=60000,backoff=[15000,30000,60000]}) {
  /** @type {Promise<unknown>|null|undefined} */
  let runner;
  /** @type {QueuedSync|null|undefined} */
  let queued;
  let snapshotTimer,syncTimer,probeTimer,closed=false,foreground=true,probeIndex=0,lastSync=0;

  function online(settings) {
    const connection=network();
    const local=['wifi','ethernet'].includes(connection.connectionType);
    const reachable=connection.connected||settings.mode==='lan'&&(local||connection.connectionType==='cellular');
    return reachable&&(settings.wifiOnly!==true||local||connection.connectionType==='unknown');
  }
  function scheduleProbe(reset=false) {
    clearTimeout(probeTimer);
    const settings=policy();
    if(closed||!foreground||!settings.enabled||!settings.auto||settings.mode!=='lan'||!settings.configured)return;
    if(reset)probeIndex=0;
    probeTimer=setTimeout(()=>{
      request('probe').catch(()=>{});
    },backoff[Math.min(probeIndex,backoff.length-1)]);
    probeTimer.unref?.();
  }
  function later() {
    clearTimeout(syncTimer);
    syncTimer=setTimeout(()=>request('sync').catch(()=>{}),syncDelay);
    syncTimer.unref?.();
  }
  async function execute(kind,manual) {
    const settings=policy();
    if(closed||!settings.enabled)return;
    if(kind==='snapshot'){
      await snapshot();
      if(settings.auto&&settings.configured) {
        if(online(settings))later();
        else onOffline();
      }
      return;
    }
    if(!manual&&!settings.auto)return;
    if(!manual&&(!settings.configured||!online(settings))) {
      if(settings.configured)onOffline();
      if(kind==='probe'){probeIndex++;scheduleProbe();}
      return;
    }
    if(kind==='probe'){
      let available=false,reported=false;
      try{available=await probe();}catch(error){onError(error,false);reported=true;}
      if(available){
        const due=probeIndex>0||Date.now()-lastSync>=cooldown;
        probeIndex=0;
        if(due)await execute('sync',false);
      }else{probeIndex++;if(!reported)onOffline();}
      scheduleProbe();
      return;
    }
    if(!manual&&!foreground)return;
    if(manual&&!online({...settings,wifiOnly:false})) {
      await snapshot();onOffline();
      throw Object.assign(Error('当前离线，修改已保留为本地版本。'),{code:'SYNC_OFFLINE'});
    }
    const result=await sync();
    lastSync=Date.now();
    probeIndex=0;
    scheduleProbe();
    return result;
  }
  /** @param {RequestKind} kind */
  function request(kind,manual=false) {
    if(closed)return Promise.resolve();
    if(runner) {
      if(kind==='probe'){scheduleProbe();return runner;}
      if(!queued){
        let resolve,reject;
        const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});
        queued={kind,manual,promise,resolve,reject};
      }else{
        if(kind==='sync')queued.kind=kind;
        queued.manual ||= manual;
      }
      return queued.promise;
    }
    runner=Promise.resolve().then(()=>execute(kind,manual)).catch(error=>{
      if(!closed){onError(error,manual);if(!manual&&kind!=='snapshot'){probeIndex++;scheduleProbe();}}
      if(manual)throw error;
    }).finally(()=>{
      runner=null;
      const next=queued;queued=null;
      if(next)request(next.kind,next.manual).then(next.resolve,next.reject);
    });
    return runner;
  }
  function changed() {
    clearTimeout(snapshotTimer);
    clearTimeout(syncTimer);
    if(closed||!policy().enabled)return;
    snapshotTimer=setTimeout(()=>request('snapshot').catch(()=>{}),snapshotDelay);
    snapshotTimer.unref?.();
  }
  function enter(active=true) {
    foreground=active;
    clearTimeout(probeTimer);
    if(active){
      if(policy().pending||Date.now()-lastSync>=cooldown)request('sync').catch(()=>{});
      scheduleProbe(true);
    }
  }
  return {changed,enter,
    reconnect(){
      if(foreground)request('sync').catch(()=>{});
      scheduleProbe(true);
    },
    manual:()=>request('sync',true),
    refresh:()=>scheduleProbe(true),
    dispose(){closed=true;clearTimeout(snapshotTimer);clearTimeout(syncTimer);clearTimeout(probeTimer);}
  };
}
