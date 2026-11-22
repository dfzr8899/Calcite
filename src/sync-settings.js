import {errorMessage} from './error-message.js';
import {settingsGroup,settingToggle} from './mobile-ui.js';
import {peerTokenPattern,readPacket,vaultIdPattern,wifiOnly} from '../shared/core/sync-config.mjs';
import {syncUrl} from '../shared/sync-url.mjs';
const remotePhaseLabels={check:'检查远端',fetch:'拉取',merge:'合并写盘',push:'推送'};
const phaseTimes=timings=>Object.entries(remotePhaseLabels).map(([phase,label])=>label+' '+Math.round(timings[phase]||0)+' ms').join(' · ');

export const syncLabels={off:'未开启',pending:'待同步',working:'同步中…',synced:'已同步',offline:'离线待同步',conflict:'发现冲突',error:'同步异常'};
export function syncLabel(state) {
  if(state.status==='working'&&state.progress) {
    const {phase,done,total,timings}=state.progress;
    const phases={snapshot:'正在提交本地版本…',connect:'正在连接对端…',negotiate:'正在协商 Git 对象…',
      pull:'正在拉取对象',push:'正在推送对象',write:'正在写入工作区文件',index:'正在更新索引…'};
    if(timings){
      const completed=Object.keys(timings).map(key=>remotePhaseLabels[key]+' '+Math.round(timings[key])+' ms');
      return [...completed,remotePhaseLabels[phase]?remotePhaseLabels[phase]+'中…':phases[phase]].filter(Boolean).join(' · ')+
        (total?' '+done+'/'+total:'');
    }
    if(phases[phase])return phases[phase]+(total?' '+done+'/'+total:'');
  }
  if(state.status==='synced'&&state.logs?.[0]?.message==='已是最新。')return '已是最新';
  const count=state.status==='conflict'?state.conflicts?.length:state.pendingCount;
  const numbered=['offline','pending','conflict'].includes(state.status);
  return (syncLabels[state.status]||syncLabels.off)+(numbered&&count?' ('+count+')':'');
}
const input=(key,label,type='text',extra='')=>`<label>${label}<input name="${key}" type="${type}" ${extra}></label>`;
const toggle=settingToggle;

// The system photo/file picker supplies an image; pairing does not start a live camera stream.
export function validatePairing(text) {
  if(!/^calcite-(?:sync|remote):/.test(text))throw Error('配对串无效。');
  const prefix=text.slice(0,text.indexOf(':')+1),packet=readPacket(text,prefix);
  if(!packet||(prefix==='calcite-sync:'?
    !vaultIdPattern.test(packet.vaultId)||!peerTokenPattern.test(packet.token)||typeof packet.url!=='string':
    !Array.isArray(packet.urls)||!packet.urls.length||!peerTokenPattern.test(packet.cap)||typeof packet.key!=='string'||!Number.isFinite(packet.expires)))throw Error('配对串无效。');
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
  const switches=settingToggle('enabled','启用 Vault Git 同步')+
    settingToggle('auto','启用离线自动同步')+
    settingToggle('wifiOnly','仅通过 Wi-Fi 或有线网络自动同步',{detail:'使用手机个人热点连接电脑时请关闭'});
  const pairing=`<label>连接方式<select name="mode"><option value="lan">局域网直连</option><option value="remote">自定义远程 Git</option></select></label>
    <p class="sync-mode-help" data-mode-help></p>
    <button class="sync-mobile-action primary" type="button" data-scan>拍摄并扫描配对二维码</button>
    <input type="file" accept="image/*" capture="environment" data-scan-file hidden>
    <label>配对串<input name="pairing" type="password" placeholder="粘贴局域网或远程 Git 配对串" autocomplete="off" maxlength="8192"></label>
    <button class="sync-mobile-action" type="button" data-connect>粘贴配对串并连接</button>`;
  const advanced=`<details class="lg-group lg-details"><summary>手动高级设置</summary>
    <div class="lg-detail-content">
      <div class="sync-grid">${input('name','提交者名称','text','maxlength="100" required')}${input('email','提交者邮箱','email','maxlength="200" required')}</div>
      <div data-mode-fields="lan">
        ${input('peerUrl','直连 URL（支持 IPv4、IPv6 与组网地址）','url')}
        ${input('peerVaultId','对端 Vault ID','text','maxlength="36"')}
        ${input('peerToken','对端 Token（留空保留已配置值）','password','autocomplete="off" maxlength="64"')}
      </div>
      <div data-mode-fields="remote" hidden>
        ${input('remoteUrl','HTTPS 仓库 URL','url')}${input('branch','远程分支','text','maxlength="120" required')}
        ${input('remoteUser','HTTPS 用户名（可留空）','text','maxlength="128"')}
        ${input('pat','Personal Access Token（留空保留已配置值）','password','autocomplete="off" maxlength="2048"')}
        <button type="button" data-forget>清除 Token</button>
      </div>
    </div></details>`;
  return `<form class="sync-fields lg-settings-form" novalidate inert>
    <div class="lg-settings-scroll">
      <section class="lg-conflicts" data-conflicts hidden><h4></h4>
        <button type="button" class="primary" data-show-conflicts aria-controls="mobile-sync-conflict-list" aria-expanded="false">立即处理冲突</button>
        <div id="mobile-sync-conflict-list" hidden></div>
        <button type="button" data-archive-conflicts>一键归档清理</button>
      </section>
      ${settingsGroup('同步开关',switches)}${settingsGroup('连接与快速配对',pairing)}
      ${advanced}
      <details class="lg-group lg-details"><summary>最近同步日志</summary><ul data-log></ul></details>
    </div><div class="lg-footer"><p role="status">正在读取同步状态…</p>
      <div class="feature-buttons lg-sync-actions">
        <button type="button" data-test>测试连接</button><button class="primary" type="button" data-sync>立即同步</button>
        <button type="submit">保存同步设置</button>
      </div>
    </div>
  </form>`;
}

export async function mountSyncSettings(panel,{mobile=false,sync,subscribe,copy,compare,history,escape,fail,notify=()=>{},signal}) {
  panel.innerHTML=mobile?mobileSyncForm():`<form class="sync-fields lg-settings-form" inert><div class="lg-settings-scroll">
      ${settingsGroup('同步开关',toggle('enabled','启用 Vault Git 同步')+toggle('auto','启用离线自动同步')+
        toggle('wifiOnly','仅在 Wi-Fi 或有线网络下自动同步',{detail:'使用手机个人热点时请关闭'}))}
      <label>模式<select name="mode"><option value="lan">局域网直连</option><option value="remote">自定义远程 Git</option></select></label>
      <p class="sync-mode-help" data-mode-help></p>
      <div class="sync-grid">${input('name','提交者名称','text','maxlength="100" required')}${input('email','提交者邮箱','email','maxlength="200" required')}</div>
      <section class="lg-group" data-mode-fields="lan"><h4>局域网</h4>
      ${toggle('listen','允许对端连接本机')+
        `<div class="sync-grid">${input('deviceName','设备名称','text','maxlength="80" required')}${input('port','监听端口（0 自动选择）','number','min="0" max="65535"')}</div>`}
      ${input('pairing','粘贴对端配对串','password','autocomplete="off" maxlength="8192"')}
      <details><summary>手动设置直连地址</summary>
      ${input('peerUrl','直连 URL（支持 IPv4、IPv6 与组网地址）','url')}${input('peerVaultId','对端 Vault ID','text','maxlength="36"')}
      ${input('peerToken','对端 Token（留空保留已配置值）','password','autocomplete="off" maxlength="64"')}</details>
      <p>局域网直连采用明文 HTTP，仅建议用于受信任的家庭 Wi-Fi、个人热点或 Tailscale 加密组网。公共或校园网络请优先使用自定义远程 Git（HTTPS）。配对串含访问权限，请私下发送。</p>
      <div class="feature-buttons"><button type="button" data-pair>显示配对二维码</button><button type="button" data-revoke>吊销旧配对</button></div>
      <div data-qr="lan" hidden><img alt="配对二维码" width="180" height="180"><button type="button" data-copy="lan">复制配对串</button></div></section>
      <section class="lg-group" data-mode-fields="remote"><h4>远程 Git · BYOS</h4>
      ${input('remoteUrl','HTTPS 仓库 URL','url')}${input('branch','远程分支','text','maxlength="120" required')}
      ${input('remoteUser','HTTPS 用户名（可留空）','text','maxlength="128"')}
      ${input('pat','Personal Access Token（留空保留已配置值）','password','autocomplete="off" maxlength="2048"')}
      <button type="button" data-forget>清除 Token</button>
      <div class="feature-buttons"><button type="button" data-remote-pair>生成配置同步二维码</button></div>
        <div data-qr="remote" hidden><p class="sync-mode-help">仅限本人扫码。此二维码可领取访问凭据，请勿截图或转发。</p>
          <p data-pair-expiry></p><img alt="远程配置二维码" width="180" height="180"><button type="button" data-copy="remote">复制一次性配对串</button></div></section>
      <details data-conflicts hidden><summary>待处理冲突</summary><div></div>
        <button type="button" data-archive-conflicts>一键归档清理</button>
      </details>
      <details><summary>最近同步日志</summary><ul data-log></ul></details>
    </div><div class="lg-footer"><p role="status">正在读取同步状态…</p>
      <div class="feature-buttons"><button type="button" data-test>测试连接</button><button type="button" data-sync>立即手动同步</button><button class="primary" type="submit">保存同步设置</button></div>
    </div></form>`;
  const form=panel.querySelector('.sync-fields'),fields=form.elements,status=panel.querySelector('[role=status]');
  const conflicts=panel.querySelector('[data-conflicts]'),pairings={};
  const modeHelp=panel.querySelector('[data-mode-help]');
  let current,busy=false,forget=false,message='',wifiOverride,expiryTimer;

  function showMode(){
    modeHelp.textContent=fields.mode.value==='lan'?
      '适合手机与电脑连同一 Wi-Fi 或手机热点，零云端本地直连。':
      '绑定自己的 GitHub / Gitee 私有仓库，手机流量与校园网可跨网异步同步。';
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
      state.canEncrypt?'':'系统密钥不可用，Token 仅在本次会话中保留。'].filter(Boolean).join(' · ');
    panel.querySelector('[data-log]').innerHTML=state.logs.map(row=>{
      const detail=typeof row.pull==='number'?` · 拉取 ${row.pull} 个文件 · 推送 ${row.push} 个文件 · ${Math.round(row.duration??0)} ms`:'';
      const mode=row.mode==='remote'?'远程 Git':row.mode==='lan'?'局域网':'';
      const archives=[...new Set(row.archives||[])].map(path=>'<button type="button" data-backup="'+escape(path)+'">'+
        escape(path.split(/[\\/]/).at(-1)+'的版本历史')+'</button>').join(' ');
      return '<li>'+escape([new Date(row.time).toLocaleTimeString(),mode,errorMessage(row.message)+detail,row.timings&&phaseTimes(row.timings)]
        .filter(Boolean).join(' · '))+(row.backup?' <button type="button" data-backup="'+escape(row.backup)+'">版本历史</button>':'')+
        (archives?' '+archives:'')+'</li>';
    }).join('');
    conflicts.hidden=!state.conflicts.length;
    conflicts.querySelector(mobile?'h4':'summary').textContent=(mobile?'发现冲突':'待处理冲突')+' ('+state.conflicts.length+')';
    conflicts.querySelector('div').innerHTML=state.conflicts.map((row,i)=>'<div class="sync-conflict">'+
      '<span>'+escape((row.copy||row.path).split(/[\\/]/).at(-1))+'</span><button type="button" data-compare="'+i+'">查看差异</button></div>').join('');
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
        if(seconds)expiry.textContent=seconds+' 秒内有效';
        else {displayPair('remote',null);message='配置二维码已过期。';update(current);}
      };
      tick();expiryTimer=setInterval(tick,1000);
    }
  }
  for(const field of [fields.enabled,fields.listen,fields.mode].filter(Boolean))field.addEventListener('change',()=>{
    if(fields.mode.value!=='lan'||!fields.enabled.checked||!fields.listen?.checked)displayPair('lan',null);
    if(field===fields.enabled)message='保存后将'+(field.checked?'开启':'关闭')+' Vault Git 同步。';
    else if(field===fields.listen)message='保存后将'+(field.checked?'允许':'停止')+'对端连接本机。';
    else {
      fields.wifiOnly.checked=wifiOnly({wifiOnly:wifiOverride,mode:fields.mode.value});
      message='保存后生效。';
    }
    update(current);
  });
  fields.wifiOnly.addEventListener('change',()=>{wifiOverride=fields.wifiOnly.checked;});
  form.addEventListener('submit',perform(async()=>{
    const packet=mobile&&fields.pairing.value.trim();
    if(packet){await importPacket(packet);return;}
    if(await commit()){message='设置已保存';update(current);}
  }));
  const run=(selector,callback)=>panel.querySelector(selector)?.addEventListener('click',perform(callback));
  run('[data-test]',async()=>{if(await commit()){const response=await sync.test();message=errorMessage(response.message);update(current);}});
  run('[data-sync]',async()=>{if(await commit()){message='';update(await sync.run());}});
  run('[data-archive-conflicts]',async()=>{
    const state=await sync.archiveConflicts();
    message=state.logs[0]?.message||'已归档历史冲突副本。';
    update(state);
    notify(message);
  });
  run('[data-pair]',async()=>{
    if(!await commit({enabled:true,listen:true}))return;
    message='已开启同步与局域网共享，正在生成配对二维码…';update(current);
    const value=await sync.pair();
    displayPair('lan',value);message='已开启局域网共享 · '+value.url;update(current);
  });
  run('[data-revoke]',async()=>{displayPair('lan',await sync.revoke());message='旧 Token 已失效';update(current);});
  run('[data-remote-pair]',async()=>{
    if(!await commit({enabled:true}))return;
    displayPair('remote',await sync.remotePair());message='';update(current);
  });
  for(const button of panel.querySelectorAll('[data-copy]'))button.addEventListener('click',perform(async()=>{
    const value=pairings[button.dataset.copy];
    if(value){await copy(value.packet);message='配对串已复制';update(current);}
  }));
  run('[data-forget]',async()=>{fields.pat.value='';forget=true;message='保存后清除 Token';update(current);});
  async function importPacket(packet,scanned=false) {
    if(!packet)throw Error('请先扫描或粘贴配对串。');
    if(packet.startsWith('calcite-remote:')){
      update(await sync.importRemote(packet),true);
      fields.pairing.value=fields.pat.value=fields.peerToken.value='';forget=false;
      message='远程配置已导入。';update(current);
      if(scanned)notify(message);
      const response=await sync.test();
      if(!response.ok){message=response.message;update(current);return;}
      update(await sync.run());
    }else{
      fields.mode.value='lan';showMode();
      fields.pairing.value=packet;
      if(await commit({enabled:true})){
        message='已连接 '+(current.settings.peerName||'桌面端')+'，配对已保存。';update(current);
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
    catch{throw Error('未识别到有效配对二维码，请避开电脑屏幕反光重试，或直接复制粘贴配对串。');}
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
