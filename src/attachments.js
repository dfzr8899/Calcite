import {t as tr} from "../shared/i18n/index.mjs";
export async function compressPastedImage(file,{webpCompression,webpWidth=1920,webpQuality=.82}) {
  const type=file.type;
  if(!webpCompression||!/^image\/(?:png|jpeg|bmp)$/i.test(type))return file;
  if(type==='image/png') {
    const header=new Uint8Array(await file.slice(0,Math.min(file.size,262144)).arrayBuffer());
    const chunks=new DataView(header.buffer);
    for(let i=8;i+12<=header.length;) {
      const name=String.fromCharCode(...header.subarray(i+4,i+8));
      if(name==='acTL')return file;
      if(name==='IDAT')break;
      i+=chunks.getUint32(i)+12;
    }
  }
  let bitmap;
  try {
    bitmap=await createImageBitmap(file);
    if(bitmap.width<=webpWidth&&file.size<512*1024)return file;
    const canvas=document.createElement('canvas'),ratio=Math.min(1,webpWidth/bitmap.width);
    canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
    if(canvas.width*canvas.height>32000000)return file;
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',webpQuality));
    if(!blob||blob.type!=='image/webp'||ratio===1&&blob.size>=file.size)return file;
    return new File([blob],file.name.replace(/\.[^.]+$/,'')+'.webp',{type:blob.type});
  } catch {return file;}
  finally{bitmap?.close();}
}

import {errorMessage} from './error-message.js';

const bytes=value=>value>=1024*1024?(value/(1024*1024)).toFixed(1)+' MiB':Math.ceil(value/1024)+' KiB';
export function mountAttachments(panel,{mobile,icon,glyphs,scan,trash,confirm,escape,fail}) {
  const statusLine=`<p role="status">${tr("attachments.scanningWorkspaceImages")}</p><div class="attachment-list"></div>`;
  const select=`<button type="button" data-select>${tr("main.selectAll")}</button>`;
  const rescan=`<button type="button" data-refresh>${tr("attachments.scanAgain")}</button>`;
  const remove=`<button type="button" data-trash disabled>${tr("attachments.moveToTrash")}</button>`;
  panel.innerHTML=mobile?'<div class="lg-attachments"><div class="lg-settings-scroll">'+statusLine+'</div>'+
    '<div class="lg-footer"><div class="feature-buttons">'+rescan+select+remove+'</div></div></div>':
    statusLine+'<div class="feature-buttons">'+select+rescan+remove+'</div>';
  const list=panel.querySelector('.attachment-list'),status=panel.querySelector('[role=status]'),button=panel.querySelector('[data-trash]');
  let rows=[],busy=false;
  const selectAll=panel.querySelector('[data-select]'),rescanButton=panel.querySelector('[data-refresh]');
  function update(){
    button.disabled=busy||!list.querySelector(':checked');
    if(mobile){
      selectAll.disabled=busy||!rows.length||list.querySelectorAll(':checked').length===rows.length;
      rescanButton.disabled=busy;
      list.inert=busy;
    }
  }
  async function refresh() {
    busy=true;update();status.classList.remove('lg-visually-hidden');status.textContent=tr("attachments.scanningWorkspaceImages");
    try {
      rows=await scan();
      status.textContent=rows.length?tr("attachments.unusedImagesCanBeFreed",{arg1:rows.length,arg2:bytes(rows.reduce((sum,row)=>sum+row.size,0))}):tr("attachments.noUnusedImagesFound");
      status.classList.toggle('lg-visually-hidden',mobile&&!rows.length);
      list.innerHTML=mobile&&!rows.length?
        '<div class="lg-empty">'+icon('images')+`<strong>${tr("attachments.noUnusedAttachments")}</strong><p>${tr("attachments.allImagesInTheWorkspaceAreIn")}</p></div>`:
        rows.map((row,index)=>'<label class="attachment-row">'+
        '<img loading="lazy" alt="" src="'+escape(row.preview)+'"><span>'+escape(row.relative)+'<small>'+escape(bytes(row.size)+' · '+new Date(row.mtime).toLocaleString('zh-CN'))+'</small></span>'+
        `<input class="lg-switch" role="switch" type="checkbox" aria-label="${tr("attachments.selectAttachments")} `+escape(row.relative)+'" value="'+index+'"></label>').join('');
      if(mobile)glyphs();
    }catch(error){rows=[];list.replaceChildren();status.classList.remove('lg-visually-hidden');status.textContent=errorMessage(error);}
    finally{busy=false;update();}
  }
  list.addEventListener('change',update);
  panel.querySelector('[data-select]').addEventListener('click',()=>{for(const input of list.querySelectorAll('input'))input.checked=true;update();});
  panel.querySelector('[data-refresh]').addEventListener('click',refresh);
  button.addEventListener('click',async()=>{
    const paths=[...list.querySelectorAll(':checked')].map(input=>rows[Number(input.value)].path);
    try{
      if(!paths.length||!await confirm(paths.length))return;
      busy=true;update();await trash(paths);await refresh();
    }catch(error){fail(error);status.textContent=errorMessage(error);}
    finally{busy=false;update();}
  });
  refresh();
}
