import {marked} from 'marked';
import {t as tr} from './i18n/index.mjs';

const imageExtension=/\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const opaque=/(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[ \t]*(?=\r?$)|(?![\s\S])))|(`+)[^\n]*?\3(?!`)|<!--[^]*?(?:-->|$)/gm;

function outsideCode(text,rewrite) {
  let result='',start=0;
  for (const match of text.matchAll(opaque)) {
    result+=rewrite(text.slice(start,match.index))+match[0];start=match.index+match[0].length;
  }
  return result+rewrite(text.slice(start));
}

function markdownImages(text) {
  const found=new Map();
  const add=(raw,destination,alt,wiki=false)=>{if (raw&&destination) found.set(raw,{raw,destination,alt,wiki});};
  const tokens=marked.lexer(text);
  marked.walkTokens(tokens,token=>{
    if(token.type==='image')add(token.raw,token.href,token.text);
    if(token.type==='html')for(const tag of token.raw.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi)) {
      add(tag[0],tag[1]||tag[2]||tag[3],tr('common.image'));
    }
  });
  outsideCode(text,value=>{
    for(const match of value.matchAll(/(?<!\\)!\[\[([^\]\n]+)\]\]/g)) {
      const [destination,alt]=match[1].split('|');
      if(imageExtension.test(destination.split('#')[0]))add(match[0],destination,alt,true);
    }
    return value;
  });
  return [...found.values()];
}

function localReference(destination) {
  const raw=destination.trim().split(/[?#]/,1)[0].replace(/\\([()])/g,'$1');
  if(!raw||/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(raw))return null;
  try {
    const decoded=decodeURIComponent(raw).replaceAll('\\','/');
    if(/[\x00-\x1f]/.test(decoded)||/^[A-Za-z]:|^\/\//.test(decoded))return null;
    return decoded;
  }catch{return null;}
}

export {imageExtension,markdownImages,localReference,outsideCode};
