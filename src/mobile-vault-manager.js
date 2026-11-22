import {errorMessage} from './error-message.js';
import {decodePairing,validatePairing} from './sync-settings.js';

export const vaultStatusLabels={local:'仅本地',pending:'待同步',synced:'已同步',error:'同步异常'};

export function showVaultManager({shell,workspace,sync,current,change,ask,escape,toast,icon,glyphs}) {
  const nameField=name=>'<label>知识库名称<input name="name" maxlength="100" required value="'+escape(name)+'"></label>';
  function open() {
    shell.panel('知识库管理','vaults',(content,close)=>{
      content.innerHTML='<div class="mobile-vault-list" aria-label="本机知识库"></div>'+
        '<p role="status">正在读取知识库…</p><div class="mobile-card-actions">'+
        '<button type="button" class="mobile-primary" data-create>'+icon('plus')+'新建空白知识库</button>'+
        '<button type="button" data-pair>'+icon('qr-code')+'配对新建</button></div>';
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
        const form=await ask('新建空白知识库',nameField(''));
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
          card.innerHTML='<button type="button" class="mobile-vault-select" '+(active?'aria-current="true" aria-disabled="true"': 'aria-label="切换到 '+escape(name)+'"')+'>'+
            icon(active?'check':'folder-closed')+'<span><strong>'+escape(name)+'</strong><small>'+count+' 篇文档 <span aria-hidden="true">·</span> '+
            '<span data-vault-status>'+vaultStatusLabels[syncStatus]+'</span></small></span>'+
            (active?'<span class="mobile-current">当前</span>':icon('chevron-right'))+'</button>'+
            '<div class="mobile-vault-card-tools"><button type="button" data-rename>重命名</button>'+
            '<button type="button" class="menu-danger" data-delete>删除</button></div>';
          if(!active)card.querySelector('.mobile-vault-select').onclick=run(async()=>{
            if(await change(retained=>workspace.switchVault(path,retained)))close();
          });
          card.querySelector('[data-rename]').onclick=run(async()=>{
            const form=await ask('重命名知识库',nameField(name));
            if(form&&await change(retained=>workspace.renameVault(path,form.get('name'),retained)))open();
          });
          card.querySelector('[data-delete]').onclick=run(async()=>{
            const form=await ask('删除知识库','', '确认删除',
              '将删除手机上的「'+name+'」及其本地笔记、版本和配对设置。电脑或远端的副本将保留。');
            if(form&&await change(retained=>workspace.deleteVault(path,retained)))open();
          });
          list.append(card);
        }
        glyphs();
      }).catch(error=>{status.textContent=errorMessage(error);status.hidden=false;});
    });
  }

  function pair() {
    shell.panel('配对新建知识库','vault-pair',(content,close)=>{
      content.innerHTML='<form class="mobile-vault-pair">'+nameField('')+
        '<label>配对串<input name="pairing" type="password" autocomplete="off" maxlength="8192" required></label>'+
        '<input type="file" accept="image/*" capture="environment" hidden>'+
        '<button type="button" data-scan>'+icon('qr-code')+'拍摄并扫描配对二维码</button>'+
        '<p role="status" hidden></p><div class="mobile-card-actions">'+
        '<button class="mobile-primary" type="submit">新建并同步</button></div></form>';
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
          feedback('已读取配对二维码。');
        }catch{feedback('未识别到有效配对二维码，请重新拍摄或粘贴配对串。');}
        finally{submit.disabled=false;}
      };
      form.onsubmit=async event=>{
        event.preventDefault();
        if(busy||submit.disabled)return;
        const name=fields.name.value,packet=fields.pairing.value.trim();
        busy=true;form.inert=true;
        feedback('正在配对并同步…');
        try{
          if(!paired)validatePairing(packet);
          if(!created) {
            const result=await change(retained=>workspace.createVault(name,retained));
            if(!result)return;
            created=result.root;
            fields.name.disabled=true;
          }
          if(current()!==created)throw Error('请切回新建的知识库后再同步。');
          if(!paired) {
            if(packet.startsWith('calcite-remote:'))await sync.importRemote(packet);
            else await sync.configure({enabled:true,mode:'lan',pairing:packet});
            paired=true;
            fields.pairing.value='';
            fields.pairing.disabled=true;
            form.querySelector('[data-scan]').disabled=true;
          }
          if(current()!==created)throw Error('请切回新建的知识库后再同步。');
          await sync.run();
          if(content.isConnected)close();
          toast('知识库已配对并同步');
        }catch(error){
          feedback((created?'知识库已建在本机。':'')+errorMessage(error));
          submit.textContent=paired?'重试同步':'重试配对';
          if(!created)submit.textContent='新建并同步';
        }finally{busy=false;form.inert=false;}
      };
    },open);
  }
  open();
}
