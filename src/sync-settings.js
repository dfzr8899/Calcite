import {getLocale, t as tr} from "../shared/i18n/index.mjs";
import {errorMessage} from './error-message.js';
import {settingsGroup,settingToggle} from './mobile-ui.js';
import {peerTokenPattern,readPacket,vaultIdPattern,wifiOnly} from '../shared/core/sync-config.mjs';
import {syncUrl} from '../shared/sync-url.mjs';
import {phaseTimes,syncLabel,syncMessage} from './sync-status.js';
export {syncLabel,syncMessage};
const input=(key,label,type='text',extra='')=>`<label>${label}<input name="${key}" type="${type}" ${extra}></label>`;
const toggle=settingToggle;

function conflictStrategyField() {
  return `<label>${tr('dataSafety.strategy')}<select name="conflictStrategy" aria-describedby="sync-strategy-help">
    <option value="lww-history">${tr('dataSafety.lww')}</option>
    <option value="conflict-copy">${tr('dataSafety.copy')}</option>
  </select><small id="sync-strategy-help">${tr('dataSafety.strategyHelp')}</small></label>`;
}

// The system photo/file picker supplies an image; pairing does not start a live camera stream.
export function validatePairing(text) {
  if(!/^calcite-(?:sync|remote):/.test(text))throw Error(tr("syncConfig.invalidPairingCode"));
  const prefix=text.slice(0,text.indexOf(':')+1),packet=readPacket(text,prefix);
  if(!packet||(prefix==='calcite-sync:'?
    !vaultIdPattern.test(packet.vaultId)||!peerTokenPattern.test(packet.token)||typeof packet.url!=='string':
    !Array.isArray(packet.urls)||!packet.urls.length||!peerTokenPattern.test(packet.cap)||typeof packet.key!=='string'||!Number.isFinite(packet.expires)))throw Error(tr("syncConfig.invalidPairingCode"));
  for(const url of prefix==='calcite-sync:'?[packet.url]:packet.urls)syncUrl(url,{lan:true});
  return text;
}

export async function decodePairing(file) {
  const [image,{default:jsQR}]=await Promise.all([createImageBitmap(file),import('jsqr')]);
  try{
    const canvas=document.createElement('canvas'),scale=Math.min(1,1800/Math.max(image.width,image.height));
    canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
    const context=canvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(image,0,0,canvas.width,canvas.height);
    const result=jsQR(context.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);
    return validatePairing(result?.data||'');
  }finally{image.close();}
}

function mobileSyncForm() {
  const switches=settingToggle('enabled',tr("syncSettings.enableGitSync"))+
    settingToggle('auto',tr("syncSettings.syncAutomatically"))+
    settingToggle('wifiOnly',tr("syncSettings.syncAutomaticallyOnlyOnWiFiOr"),{detail:tr("syncSettings.turnThisOffWhenUsingAPhone")});
  const pairing=`<label>${tr("syncSettings.connectionType")}<select name="mode"><option value="lan">${tr("syncSettings.lan")}</option><option value="remote">${tr("syncSettings.remoteGit")}</option></select></label>
    <p class="sync-mode-help" data-mode-help></p>
    <button class="sync-mobile-action primary" type="button" data-scan>${tr("mobileVaultManager.scanPairingQrCode")}</button>
    <input type="file" accept="image/*" capture="environment" data-scan-file hidden>
    <label>${tr("mobileVaultManager.pairingCode")}<input name="pairing" type="password" placeholder="${tr("syncSettings.pasteALanOrRemoteGitPairing")}" autocomplete="off" maxlength="8192"></label>
    <button class="sync-mobile-action" type="button" data-connect>${tr("syncSettings.pasteCodeAndConnect")}</button>`;
  const advanced=`<details class="lg-group lg-details"><summary>${tr("syncSettings.advancedSetup")}</summary>
    <div class="lg-detail-content">
      <div class="sync-grid">${input('name',tr("syncSettings.committerName"),'text','maxlength="100" required')}${input('email',tr("syncSettings.committerEmail"),'email','maxlength="200" required')}</div>
      <div data-mode-fields="lan">
        ${input('peerUrl',tr("syncSettings.lanUrlIpv4Ipv6OrMeshAddress"),'url')}
        ${input('peerVaultId',tr("syncSettings.peerVaultId"),'text','maxlength="36"')}
        ${input('peerToken',tr("syncSettings.peerTokenLeaveBlankToKeepThe"),'password','autocomplete="off" maxlength="64"')}
      </div>
      <div data-mode-fields="remote" hidden>
        ${input('remoteUrl',tr("syncSettings.httpsRepositoryUrl"),'url')}${input('branch',tr("syncSettings.remoteBranch"),'text','maxlength="120" required')}
        ${input('remoteUser',tr("syncSettings.httpsUsernameOptional"),'text','maxlength="128"')}
        ${input('pat',tr("syncSettings.personalAccessTokenLeaveBlankToKeep"),'password','autocomplete="off" maxlength="2048"')}
        <button type="button" data-forget>${tr("syncSettings.clearToken")}</button>
      </div>
    </div></details>`;
  return `<form class="sync-fields lg-settings-form" novalidate inert>
    <div class="lg-settings-scroll">
      <section class="lg-conflicts" data-conflicts hidden><h4></h4>
        <button type="button" class="primary" data-show-conflicts aria-controls="mobile-sync-conflict-list" aria-expanded="false">${tr("syncSettings.resolveConflicts")}</button>
        <div id="mobile-sync-conflict-list" hidden></div>
        <button type="button" data-archive-conflicts>${tr("syncSettings.archiveAndCleanUp")}</button>
      </section>
      ${settingsGroup(tr("syncSettings.syncControls"),switches+conflictStrategyField())}${settingsGroup(tr("syncSettings.connectionPairing"),pairing)}
      ${advanced}
      <details class="lg-group lg-details"><summary>${tr("syncSettings.recentSyncActivity")}</summary><ul data-log></ul></details>
    </div><div class="lg-footer"><p role="status">${tr("syncSettings.loadingSyncStatus")}</p>
      <div class="feature-buttons lg-sync-actions">
        <button type="button" data-test>${tr("syncSettings.testConnection")}</button><button class="primary" type="button" data-sync>${tr("main.syncNow")}</button>
        <button type="submit">${tr("syncSettings.saveSyncSettings")}</button>
      </div>
    </div>
  </form>`;
}

export async function mountSyncSettings(panel,{mobile=false,sync,subscribe,copy,compare,history,escape,fail,notify=()=>{},signal}) {
  panel.innerHTML=mobile?mobileSyncForm():`<form class="sync-fields lg-settings-form" inert><div class="lg-settings-scroll">
      ${settingsGroup(tr("syncSettings.syncControls"),toggle('enabled',tr("syncSettings.enableGitSync"))+toggle('auto',tr("syncSettings.syncAutomatically"))+
        toggle('wifiOnly',tr("syncSettings.syncAutomaticallyOnlyOnWiFiOr2"),{detail:tr("syncSettings.turnThisOffWhenUsingAPhone2")})+conflictStrategyField())}
      <label>${tr("syncSettings.mode")}<select name="mode"><option value="lan">${tr("syncSettings.lan")}</option><option value="remote">${tr("syncSettings.remoteGit")}</option></select></label>
      <p class="sync-mode-help" data-mode-help></p>
      <div class="sync-grid">${input('name',tr("syncSettings.committerName"),'text','maxlength="100" required')}${input('email',tr("syncSettings.committerEmail"),'email','maxlength="200" required')}</div>
      <section class="lg-group" data-mode-fields="lan"><h4>${tr("syncUrl.lan")}</h4>
      ${toggle('listen',tr("syncSettings.allowPeersToConnect"))+
        `<div class="sync-grid">${input('deviceName',tr("syncSettings.deviceName"),'text','maxlength="80" required')}${input('port',tr("syncSettings.listenPort0ForAutomatic"),'number','min="0" max="65535"')}</div>`}
      ${input('pairing',tr("syncSettings.pastePeerPairingCode"),'password','autocomplete="off" maxlength="8192"')}
      <details><summary>${tr("syncSettings.setALanAddress")}</summary>
      ${input('peerUrl',tr("syncSettings.lanUrlIpv4Ipv6OrMeshAddress"),'url')}${input('peerVaultId',tr("syncSettings.peerVaultId"),'text','maxlength="36"')}
      ${input('peerToken',tr("syncSettings.peerTokenLeaveBlankToKeepThe"),'password','autocomplete="off" maxlength="64"')}</details>
      <p>${tr("syncSettings.lanSyncUsesPlainHttpUseA")}</p>
      <div class="feature-buttons"><button type="button" data-pair>${tr("syncSettings.showPairingQrCode")}</button><button type="button" data-revoke>${tr("syncSettings.revokeOldPairing")}</button></div>
      <div data-qr="lan" hidden><img alt="${tr("main.pairingQrCode")}" width="180" height="180"><button type="button" data-copy="lan">${tr("main.copyPairingCode")}</button></div></section>
      <section class="lg-group" data-mode-fields="remote"><h4>${tr("syncSettings.bringYourOwnGitRepository")}</h4>
      ${input('remoteUrl',tr("syncSettings.httpsRepositoryUrl"),'url')}${input('branch',tr("syncSettings.remoteBranch"),'text','maxlength="120" required')}
      ${input('remoteUser',tr("syncSettings.httpsUsernameOptional"),'text','maxlength="128"')}
      ${input('pat',tr("syncSettings.personalAccessTokenLeaveBlankToKeep"),'password','autocomplete="off" maxlength="2048"')}
      <button type="button" data-forget>${tr("syncSettings.clearToken")}</button>
      <div class="feature-buttons"><button type="button" data-remote-pair>${tr("syncSettings.generateSetupQrCode")}</button></div>
        <div data-qr="remote" hidden><p class="sync-mode-help">${tr("syncSettings.scanThisCodeYourselfItGrantsAccess")}</p>
          <p data-pair-expiry></p><img alt="${tr("syncSettings.remoteSetupQrCode")}" width="180" height="180"><button type="button" data-copy="remote">${tr("syncSettings.copyOneTimePairingCode")}</button></div></section>
      <details data-conflicts hidden><summary>${tr("syncSettings.pendingConflicts")}</summary><div></div>
        <button type="button" data-archive-conflicts>${tr("syncSettings.archiveAndCleanUp")}</button>
      </details>
      <details><summary>${tr("syncSettings.recentSyncActivity")}</summary><ul data-log></ul></details>
    </div><div class="lg-footer"><p role="status">${tr("syncSettings.loadingSyncStatus")}</p>
      <div class="feature-buttons"><button type="button" data-test>${tr("syncSettings.testConnection")}</button><button type="button" data-sync>${tr("syncSettings.syncNow")}</button><button class="primary" type="submit">${tr("syncSettings.saveSyncSettings")}</button></div>
    </div></form>`;
  const form=panel.querySelector('.sync-fields'),fields=form.elements,status=panel.querySelector('[role=status]');
  const conflicts=panel.querySelector('[data-conflicts]'),pairings={};
  const modeHelp=panel.querySelector('[data-mode-help]');
  let current,busy=false,forget=false,message='',wifiOverride,expiryTimer;

  function showMode(){
    modeHelp.textContent=fields.mode.value==='lan'?
      tr("syncSettings.syncDirectlyWhenYourPhoneAndPc"):
      tr("syncSettings.syncAcrossNetworksUsingYourOwnPrivate");
    for(const section of panel.querySelectorAll('[data-mode-fields]')) {
      const inactive=section.dataset.modeFields!==fields.mode.value;
      section.hidden=inactive;
      for(const control of section.querySelectorAll('input,button,select'))control.disabled=inactive;
    }
  }
  function update(state,fill=false) {
    current=state;
    if(fill) {
      wifiOverride=state.settings.wifiOnly;
      for(const [key,value] of Object.entries(state.settings))if(fields[key]) {
        if(fields[key].type==='checkbox')fields[key].checked=key==='wifiOnly'?wifiOnly(state.settings):Boolean(value);
        else fields[key].value=value;
      }
    }
    const display=message||state.notice||(state.status==='error'?state.logs[0]?.message:'')||'';
    const peer=state.settings.mode==='lan'?state.settings.peerName:'';
    status.textContent=[syncLabel(state),display,peer&&!display.includes(peer)?peer:'',
      state.canEncrypt?'':tr("syncSettings.systemCredentialStorageIsUnavailableTheToken")].filter(Boolean).join(' · ');
    panel.querySelector('[data-log]').innerHTML=state.logs.map(row=>{
      const detail=typeof row.pull==='number'?` ${tr("syncSettings.fetchedFilesPushedFilesMs",{arg1:row.pull,arg2:row.push,arg3:Math.round(row.duration??0)})}`:'';
      const mode=row.mode==='remote'?tr("syncSettings.remoteGit2"):row.mode==='lan'?tr("syncUrl.lan"):'';
      const archives=[...new Set(row.archives||[])].map(path=>'<button type="button" data-backup="'+escape(path)+'">'+
        escape(path.split(/[\\/]/).at(-1)+tr("syncSettings.versionHistory"))+'</button>').join(' ');
      return '<li>'+escape([new Date(row.time).toLocaleTimeString(getLocale()),mode,syncMessage(row)+detail,row.timings&&phaseTimes(row.timings)]
        .filter(Boolean).join(' · '))+(row.backup?' <button type="button" data-backup="'+escape(row.backup)+`">${tr("main.versionHistory")}</button>`:'')+
        (archives?' '+archives:'')+'</li>';
    }).join('');
    conflicts.hidden=!state.conflicts.length;
    conflicts.querySelector(mobile?'h4':'summary').textContent=(mobile?tr("syncSettings.conflicts"):tr("syncSettings.pendingConflicts"))+' ('+state.conflicts.length+')';
    conflicts.querySelector('div').innerHTML=state.conflicts.map((row,i)=>'<div class="sync-conflict">'+
      '<span>'+escape((row.copy||row.path).split(/[\\/]/).at(-1))+'</span><button type="button" data-compare="'+i+`">${tr("main.viewDiff")}</button></div>`).join('');
    showMode();
    conflicts.querySelector('[data-archive-conflicts]').hidden=!state.conflicts.some(row=>row.copy);
  }
  const inactive=field=>field.disabled;
  function data() {
    const options={...current.settings};
    for(const key of Object.keys(options))if(fields[key]&&!inactive(fields[key])) {
      const field=fields[key];options[key]=field.type==='checkbox'?field.checked:field.type==='number'?Number(field.value):field.value.trim();
    }
    options.wifiOnly=wifiOverride??null;
    for(const key of ['pat','peerToken','pairing'])if(!inactive(fields[key])&&fields[key].value.trim()&&(key!=='pairing'||fields.mode.value==='lan'))options[key]=fields[key].value.trim();
    if(forget)options.pat='';
    return options;
  }
  async function commit(overrides){
    if(mobile)form.querySelector('.lg-details').open ||= Boolean(form.querySelector('.lg-details :invalid'));
    if(!form.reportValidity())return false;
    const options={...data(),...overrides};
    update(await sync.configure(options),true);
    fields.pat.value=fields.peerToken.value=fields.pairing.value='';forget=false;
    return true;
  }
  function perform(callback) {
    return async event=>{
      event?.preventDefault();if(busy||!current)return;
      busy=true;
      try{await callback(event);}
      catch(error){if(!signal.aborted){message=errorMessage(error);update(current);fail(error);}}
      finally{busy=false;}
    };
  }
  function displayPair(mode,value) {
    pairings[mode]=value;
    const target=panel.querySelector('[data-qr="'+mode+'"]');
    if(!target)return;
    target.hidden=!value;
    const image=target.querySelector('img');
    if(value)image.src=value.image;
    else image.removeAttribute('src');
    if(mode==='remote') {
      clearInterval(expiryTimer);
      if(!value)return;
      const expiry=target.querySelector('[data-pair-expiry]');
      const tick=()=>{
        const seconds=Math.max(0,Math.ceil((value.expires-Date.now())/1000));
        if(seconds)expiry.textContent=seconds+` ${tr("syncSettings.secondsLeft")}`;
        else {displayPair('remote',null);message=tr("syncSettings.theSetupQrCodeExpired");update(current);}
      };
      tick();expiryTimer=setInterval(tick,1000);
    }
  }
  for(const field of [fields.enabled,fields.listen,fields.mode].filter(Boolean))field.addEventListener('change',()=>{
    if(fields.mode.value!=='lan'||!fields.enabled.checked||!fields.listen?.checked)displayPair('lan',null);
    if(field===fields.enabled)message=tr(field.checked?"syncSettings.savingEnableGit":"syncSettings.savingDisableGit");
    else if(field===fields.listen)message=tr(field.checked?"syncSettings.savingAllowLan":"syncSettings.savingPreventLan");
    else {
      fields.wifiOnly.checked=wifiOnly({wifiOnly:wifiOverride,mode:fields.mode.value});
      message=tr("syncSettings.appliesAfterSaving");
    }
    update(current);
  });
  fields.wifiOnly.addEventListener('change',()=>{wifiOverride=fields.wifiOnly.checked;});
  form.addEventListener('submit',perform(async()=>{
    const packet=mobile&&fields.pairing.value.trim();
    if(packet){await importPacket(packet);return;}
    if(await commit()){message=tr("main.settingsSaved2");update(current);}
  }));
  const run=(selector,callback)=>panel.querySelector(selector)?.addEventListener('click',perform(callback));
  run('[data-test]',async()=>{if(await commit()){const response=await sync.test();message=errorMessage(response.message);update(current);}});
  run('[data-sync]',async()=>{if(await commit()){message='';update(await sync.run());}});
  run('[data-archive-conflicts]',async()=>{
    const state=await sync.archiveConflicts();
    message=state.logs[0]?.message||tr("syncSettings.legacyConflictCopiesArchived");
    update(state);
    notify(message);
  });
  run('[data-pair]',async()=>{
    if(!await commit({enabled:true,listen:true}))return;
    message=tr("syncSettings.lanSyncIsOnGeneratingAPairing");update(current);
    const value=await sync.pair();
    displayPair('lan',value);message=`${tr("syncSettings.lanSharingIsOn")} `+value.url;update(current);
  });
  run('[data-revoke]',async()=>{displayPair('lan',await sync.revoke());message=tr("syncSettings.previousTokenRevoked");update(current);});
  run('[data-remote-pair]',async()=>{
    if(!await commit({enabled:true}))return;
    displayPair('remote',await sync.remotePair());message='';update(current);
  });
  for(const button of panel.querySelectorAll('[data-copy]'))button.addEventListener('click',perform(async()=>{
    const value=pairings[button.dataset.copy];
    if(value){await copy(value.packet);message=tr("syncSettings.pairingCodeCopied");update(current);}
  }));
  run('[data-forget]',async()=>{fields.pat.value='';forget=true;message=tr("syncSettings.clearTheTokenOnSave");update(current);});
  async function importPacket(packet,scanned=false) {
    if(!packet)throw Error(tr("syncSettings.scanOrPasteAPairingCodeFirst"));
    if(packet.startsWith('calcite-remote:')){
      update(await sync.importRemote(packet),true);
      fields.pairing.value=fields.pat.value=fields.peerToken.value='';forget=false;
      message=tr("syncSettings.remoteSettingsImported");update(current);
      if(scanned)notify(message);
      const response=await sync.test();
      if(!response.ok){message=response.message;update(current);return;}
      update(await sync.run());
    }else{
      fields.mode.value='lan';showMode();
      fields.pairing.value=packet;
      if(await commit({enabled:true})){
        message=`${tr("gitSync.connectedTo")} `+(current.settings.peerName||tr("capacitorLocalGit.desktop"))+tr("syncSettings.pairingSaved");update(current);
        if(scanned)notify(message);
        update(await sync.run());
      }
    }
  }
  run('[data-connect]',()=>importPacket(fields.pairing.value.trim()));
  const file=panel.querySelector('[data-scan-file]');
  panel.querySelector('[data-scan]')?.addEventListener('click',()=>file.click());
  file?.addEventListener('change',perform(async()=>{
    const image=file.files[0];file.value='';
    if(!image)return;
    let packet;
    try{packet=await decodePairing(image);}
    catch{throw Error(tr("syncSettings.invalidPairingQrCodeTryAgainWith"));}
    await importPacket(packet,true);
  }));
  conflicts.querySelector('[data-show-conflicts]')?.addEventListener('click',event=>{
    const list=conflicts.querySelector('#mobile-sync-conflict-list');
    list.hidden=!list.hidden;
    event.currentTarget.setAttribute('aria-expanded',String(!list.hidden));
  });
  conflicts.addEventListener('click',event=>{
    const button=event.target.closest('[data-compare]');
    if(!button)return;
    const row=current.conflicts[Number(button.dataset.compare)];
    if(row)compare(row).catch(fail);
  });
  panel.querySelector('[data-log]').addEventListener('click',event=>{
    const button=event.target.closest('[data-backup]');
    if(button)history(button.dataset.backup).catch(fail);
  });
  const state=await sync.status();
  if(signal.aborted)return;
  update(state,true);
  form.inert=false;
  const unsubscribe=subscribe(next=>update(next));
  signal.addEventListener('abort',()=>{
    unsubscribe?.();
    clearInterval(expiryTimer);
    if(pairings.remote)sync.cancelRemotePair?.().catch(()=>{});
  },{once:true});
}
