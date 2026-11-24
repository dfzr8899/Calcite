import {t as tr} from "../shared/i18n/index.mjs";
import {errorMessage} from './error-message.js';
import {decodePairing,validatePairing} from './sync-settings.js';

export const vaultStatusLabels=()=>({local:tr("mobileShell.localOnly"),pending:tr("mobileVaultManager.pending"),synced:tr("mobileVaultManager.synced"),error:tr("mobileVaultManager.syncError")});

export function showVaultManager({shell,workspace,sync,current,change,ask,escape,toast,icon,glyphs}) {
  const nameField=name=>`<label>${tr("mobileVaultManager.vaultName")}<input name="name" maxlength="100" required value="`+escape(name)+'"></label>';
  function open() {
    shell.panel(tr("mobileVaultManager.manageVaults"),'vaults',(content,close)=>{
      content.innerHTML=`<div class="mobile-vault-list" aria-label="${tr("mobileVaultManager.localVaults")}"></div>`+
        `<p role="status">${tr("mobileVaultManager.loadingVaults")}</p><div class="mobile-card-actions">`+
        '<button type="button" class="mobile-primary" data-create>'+icon('plus')+`${tr("mobileVaultManager.newEmptyVault")}</button>`+
        '<button type="button" data-pair>'+icon('qr-code')+`${tr("mobileVaultManager.createByPairing")}</button></div>`;
      const list=content.querySelector('.mobile-vault-list'),status=content.querySelector('[role="status"]');
      const buttons=content.querySelector('.mobile-card-actions');
      const run=operation=>async()=>{
        if(content.inert)return;
        status.hidden=true;
        content.inert=true;
        try{await operation();}
        catch(error){status.textContent=errorMessage(error);status.hidden=false;}
        finally{content.inert=false;}
      };
      buttons.querySelector('[data-create]').onclick=run(async()=>{
        const form=await ask(tr("mobileVaultManager.newEmptyVault"),nameField(''));
        if(form&&await change(retained=>workspace.createVault(form.get('name'),retained)))close();
      });
      buttons.querySelector('[data-pair]').onclick=()=>pair();
      workspace.vaults().then(vaults=>{
        if(!content.isConnected)return;
        status.hidden=true;
        for(const {name,path,count,status:syncStatus} of vaults) {
          const active=path===current(),card=document.createElement('article');
          card.className='mobile-vault-card';
          card.setAttribute('aria-label',name);
          if(active)card.dataset.current='';
          card.innerHTML='<button type="button" class="mobile-vault-select" '+(active?'aria-current="true" aria-disabled="true"': `aria-label="${tr("mobileVaultManager.switchTo")} `+escape(name)+'"')+'>'+
            icon(active?'check':'folder-closed')+'<span><strong>'+escape(name)+'</strong><small>'+count+` ${tr("mobileVaultManager.notes")} <span aria-hidden="true">·</span> `+
            '<span data-vault-status>'+vaultStatusLabels()[syncStatus]+'</span></small></span>'+
            (active?`<span class="mobile-current">${tr("mobileVaultManager.current")}</span>`:icon('chevron-right'))+'</button>'+
            `<div class="mobile-vault-card-tools"><button type="button" data-rename>${tr("documentMenu.rename")}</button>`+
            `<button type="button" class="menu-danger" data-delete>${tr("mobileVaultManager.delete")}</button></div>`;
          if(!active)card.querySelector('.mobile-vault-select').onclick=run(async()=>{
            if(await change(retained=>workspace.switchVault(path,retained)))close();
          });
          card.querySelector('[data-rename]').onclick=run(async()=>{
            const form=await ask(tr("mobileVaultManager.renameVault"),nameField(name));
            if(form&&await change(retained=>workspace.renameVault(path,form.get('name'),retained)))open();
          });
          card.querySelector('[data-delete]').onclick=run(async()=>{
            const form=await ask(tr("mobileVaultManager.deleteVault"),'', tr("mobileVaultManager.confirmDelete"),
              tr("mobileVaultManager.delete2")+name+tr("mobileVaultManager.andItsLocalNotesVersionsAndPairing"));
            if(form&&await change(retained=>workspace.deleteVault(path,retained)))open();
          });
          list.append(card);
        }
        glyphs();
      }).catch(error=>{status.textContent=errorMessage(error);status.hidden=false;});
    });
  }

  function pair() {
    shell.panel(tr("mobileVaultManager.createAPairedVault"),'vault-pair',(content,close)=>{
      content.innerHTML='<form class="mobile-vault-pair">'+nameField('')+
        `<label>${tr("mobileVaultManager.pairingCode")}<input name="pairing" type="password" autocomplete="off" maxlength="8192" required></label>`+
        '<input type="file" accept="image/*" capture="environment" hidden>'+
        '<button type="button" data-scan>'+icon('qr-code')+`${tr("mobileVaultManager.scanPairingQrCode")}</button>`+
        '<p role="status" hidden></p><div class="mobile-card-actions">'+
        `<button class="mobile-primary" type="submit">${tr("mobileVaultManager.createAndSync")}</button></div></form>`;
      const form=content.querySelector('form'),fields=form.elements,status=form.querySelector('[role="status"]');
      const file=form.querySelector('input[type=file]'),submit=form.querySelector('[type=submit]');
      let created='',paired=false,busy=false;
      const feedback=message=>{status.textContent=message;status.hidden=false;};
      form.querySelector('[data-scan]').onclick=()=>file.click();
      file.onchange=async()=>{
        const image=file.files[0];file.value='';
        if(!image)return;
        submit.disabled=true;
        try{
          fields.pairing.value=await decodePairing(image);
          feedback(tr("mobileVaultManager.pairingQrCodeRead"));
        }catch{feedback(tr("mobileVaultManager.invalidPairingQrCodeScanAgainOr"));}
        finally{submit.disabled=false;}
      };
      form.onsubmit=async event=>{
        event.preventDefault();
        if(busy||submit.disabled)return;
        const name=fields.name.value,packet=fields.pairing.value.trim();
        busy=true;form.inert=true;
        feedback(tr("mobileVaultManager.pairingAndSyncing"));
        try{
          if(!paired)validatePairing(packet);
          if(!created) {
            const result=await change(retained=>workspace.createVault(name,retained));
            if(!result)return;
            created=result.root;
            fields.name.disabled=true;
          }
          if(current()!==created)throw Error(tr("mobileVaultManager.switchBackToTheNewVaultBefore"));
          if(!paired) {
            if(packet.startsWith('calcite-remote:'))await sync.importRemote(packet);
            else await sync.configure({enabled:true,mode:'lan',pairing:packet});
            paired=true;
            fields.pairing.value='';
            fields.pairing.disabled=true;
            form.querySelector('[data-scan]').disabled=true;
          }
          if(current()!==created)throw Error(tr("mobileVaultManager.switchBackToTheNewVaultBefore"));
          await sync.run();
          if(content.isConnected)close();
          toast(tr("mobileVaultManager.vaultPairedAndSynced"));
        }catch(error){
          feedback((created?tr("mobileVaultManager.theVaultWasCreatedOnThisDevice"):'')+errorMessage(error));
          submit.textContent=paired?tr("mobileVaultManager.retrySync"):tr("mobileVaultManager.retryPairing");
          if(!created)submit.textContent=tr("mobileVaultManager.createAndSync");
        }finally{busy=false;form.inert=false;}
      };
    },open);
  }
  open();
}
