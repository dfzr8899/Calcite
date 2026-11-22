import {zipSync,strToU8} from 'fflate';
import {Directory} from '@capacitor/filesystem';
import {randomId} from '../random-id.js';
import {basename,fromBase64,toBase64} from './capacitor-git-fs.js';
import {markdownImages,outsideCode} from '../../shared/markdown-images.mjs';

const maxImagePixels=16_000_000;
const mimeTypes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp',avif:'image/avif'};
export const imageMime=file=>mimeTypes[basename(file).split('.').at(-1).toLowerCase()];
export const imageData=(file,bytes)=>'data:'+imageMime(file)+';base64,'+toBase64(bytes);
const filename=value=>String(value||'Calcite').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,120);
const serialize=node=>new XMLSerializer().serializeToString(node);
const loadImage=url=>new Promise((resolve,reject)=>{
  const image=new Image();
  image.onload=()=>resolve(image);
  image.onerror=()=>reject(Error('无法生成图片。'));
  image.src=url;
});
const pngBlob=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('无法生成 PNG。')),'image/png'));

async function capturePng(html,width,scale) {
  const parsed=new DOMParser().parseFromString(html,'text/html');
  const content=document.createElement('main');
  content.replaceChildren(...parsed.querySelector('main').childNodes);
  const dock=document.createElement('div');
  dock.className='calcite-mobile-capture';
  dock.style.cssText='position:fixed;left:-10000px;top:0;pointer-events:none;width:'+width+'px';
  const sheet=dock.attachShadow({mode:'open'});
  for(const style of parsed.querySelectorAll('style'))sheet.append(style.cloneNode(true));
  sheet.append(content);
  document.body.append(dock);
  try {
    await Promise.allSettled([...content.querySelectorAll('img')].map(image=>image.decode()));
    await document.fonts?.ready;
    const height=Math.max(64,Math.ceil(content.getBoundingClientRect().height));
    if(width*height*scale**2>maxImagePixels)throw Error('长图超过手机端导出尺寸，请选择较低清晰度或分段导出。');
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><foreignObject width="100%" height="100%">'+
      '<div xmlns="http://www.w3.org/1999/xhtml">'+[...sheet.childNodes].map(serialize).join('')+'</div></foreignObject></svg>';
    const url='data:image/svg+xml;base64,'+toBase64(svg);
    const canvas=document.createElement('canvas');
    canvas.width=width*scale;canvas.height=height*scale;
    const ctx=canvas.getContext('2d',{alpha:false});
    ctx.fillStyle=getComputedStyle(content).backgroundColor;
    if(ctx.fillStyle==='#000000'&&getComputedStyle(content).backgroundColor==='rgba(0, 0, 0, 0)')ctx.fillStyle='#fff';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(await loadImage(url),0,0,canvas.width,canvas.height);
    return new Uint8Array(await (await pngBlob(canvas)).arrayBuffer());
  } finally {dock.remove();}
}

export function createMobileExport({filesystem,share,clipboard,readImage,resolveImage,readFile,nativeCapture,nativePrint}) {
  async function output(name,bytes,title,mime) {
    const path='CalciteExports/'+randomId()+'/'+filename(name);
    const data=toBase64(bytes);
    try{await filesystem.writeFile({path,directory:Directory.Documents,data,recursive:true});}
    catch(error){
      if(!nativePrint)throw error;
      await filesystem.writeFile({path,directory:Directory.Data,data,recursive:true});
    }
    const cache='calcite-share/'+randomId()+'/'+filename(name);
    try {
      const {uri}=await filesystem.writeFile({path:cache,directory:Directory.Cache,data,recursive:true});
      if((await share.canShare()).value)await share.share({title,files:[uri],dialogTitle:'分享或保存 '+mime});
    } catch(error) {
      // The document copy remains available if the share sheet is cancelled or unavailable.
      console.warn('Calcite export share:',error);
    }
    return true;
  }
  return {
    formats:nativePrint?['pdf','html','png']:['html','png'],
    async document({format,html,name,width=760,scale=1}) {
      if(format==='html')return output(name+'.html',strToU8(html),name,'HTML');
      if(format==='png'){
        const bytes=nativeCapture?fromBase64((await nativeCapture({html,width,scale})).data):await capturePng(html,width,scale);
        return output(name+'.png',bytes,name,'PNG');
      }
      throw Error('此格式可在 Calcite 桌面版导出。');
    },
    async pdf(html,{title,paper,landscape}){
      if(!nativePrint)throw Error('当前平台不支持直接打印 PDF。');
      await nativePrint({html,title,paper,landscape});
      return 'print';
    },
    async pandoc(){throw Error('Word 和 EPUB 可在 Calcite 桌面版导出。');},
    async image(url) {const {path,bytes}=await readImage(url);return imageData(path,bytes);},
    async rich({html,text}) {
      if(navigator.clipboard?.write&&globalThis.ClipboardItem) {
        try {
          await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),
            'text/plain':new Blob([text],{type:'text/plain'})})]);
          return true;
        } catch { /* Fall back to the native plain-text clipboard. */ }
      }
      await clipboard.write({string:text});
      return false;
    },
    async markdown({note,text}) {
      const entries=Object.create(null),names=new Map();
      let size=strToU8(text).length;
      for(const ref of markdownImages(text)) {
        const file=await resolveImage(note,ref.destination,ref.wiki);
        if(!file)continue;
        let relative=names.get(file);
        if(!relative) {
          const bytes=await readFile(file);
          size+=bytes.length;
          if(size>48*1024*1024)throw Error('便携包超过手机端 48 MiB 上限，请分开导出。');
          relative='assets/'+(names.size+1)+'-'+filename(basename(file));
          names.set(file,relative);
          entries[relative]=bytes;
        }
        const link='!['+(ref.alt||'图片').replace(/[\\[\]]/g,'\\$&')+']('+relative.split('/').map(encodeURIComponent).join('/')+')';
        text=outsideCode(text,segment=>segment.replaceAll(ref.raw,()=>link));
      }
      entries[filename(basename(note))]=strToU8(text);
      return output(filename(basename(note).replace(/\.[^.]+$/,''))+'-Markdown.zip',zipSync(entries),'便携 Markdown','ZIP');
    }
  };
}
