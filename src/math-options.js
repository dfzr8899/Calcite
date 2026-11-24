import {t as tr} from "../shared/i18n/index.mjs";
import katex from 'katex';
import {Plugin} from '@milkdown/kit/prose/state';

export function parseMacros(input) {
  if (!input.trim()) return {};
  const macros=input.trimStart().startsWith('{')?JSON.parse(input):Object.fromEntries(input.split(/\r?\n/).filter(row=>row.trim()).map(row=>{
    const at=row.indexOf('=');
    if(at<1)throw Error(tr("mathOptions.useMacroExpansionOrAJsonObject"));
    return [row.slice(0,at).trim(),row.slice(at+1).trim()];
  }));
  if (!macros||typeof macros!=='object'||Array.isArray(macros)||Object.entries(macros).length>100||
      Object.entries(macros).some(([key,value])=>!/^\\[A-Za-z@]+$/.test(key)||typeof value!=='string'||!value||value.length>2048)) {
    throw Error(tr("mathOptions.useABackslashCommandNameAndA"));
  }
  return macros;
}

export const mathOptions=(macros={})=>({trust:false,throwOnError:false,maxExpand:500,macros:{...macros}});
export function inlineMathView(getMacros) {
  return new Plugin({props:{nodeViews:{math_inline(node){
    const dom=document.createElement('span');
    dom.dataset.type='math_inline';
    const paint=()=>katex.render(dom.dataset.value,dom,mathOptions(getMacros()));
    dom.dataset.value=node.attrs.value;
    paint();
    return {dom,ignoreMutation:()=>true,update(next){
      if(next.type!==node.type)return false;
      if(dom.dataset.value!==next.attrs.value) {dom.dataset.value=next.attrs.value;paint();}
      return true;
    }};
  }}}});
}
export function refreshLiveMath(view,macros) {
  view.state.doc.descendants((node,pos)=>{
    if(node.type.name==='math_inline') {
      const dom=view.nodeDOM(pos);
      if(dom instanceof HTMLElement)katex.render(node.attrs.value,dom,mathOptions(macros));
    } else if(node.type.name==='code_block'&&node.attrs.language?.toLowerCase()==='latex') {
      const preview=view.nodeDOM(pos)?.querySelector('.preview');
      if(preview)katex.render(node.textContent,preview,{...mathOptions(macros),displayMode:true});
    }
  });
}
