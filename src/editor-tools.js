import {pastedURL,tableAtLine,tableStartLines} from './markdown-edit.js';
import {compressPastedImage} from './attachments.js';

import { DOMParser as PMParser, Slice } from '@milkdown/kit/prose/model';
import { AllSelection, Selection, TextSelection } from '@milkdown/kit/prose/state';
import { parserCtx, serializerCtx } from '@milkdown/kit/core';
import { matchingRanges, splitFrontmatter } from './notes.js';

const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const picture = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const types = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp'};
const blobURL = blob => new Promise((resolve,reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

export function installEditorTools({$,platform,crepe,liveView,source,active,getMode,settings,save,fail,toast,sanitize,applyText,flush,openSourceSearch}) {
  const section = $('.editor-section');
  const live = $('#live-scroll'), reading = $('#reading'), sourceEl = $('#source-editor');
  const bar = document.createElement('form');
  bar.id = 'document-find';
  bar.className = 'document-find';
  bar.hidden = true;
  bar.innerHTML = '<input type="search" name="query" aria-label="查找" placeholder="查找"><span class="find-count" aria-live="polite"></span><button type="button" data-find="previous" title="上一处">↑</button><button type="submit" title="下一处">↓</button><input name="replacement" aria-label="替换为" placeholder="替换为"><button type="button" data-find="replace">替换</button><button type="button" data-find="all">全部替换</button><button type="button" data-find="close" aria-label="关闭查找">×</button>';
  section.insertBefore(bar,live);
  let ranges = [], selected = 0;
  let searchFrame, focusFrame, lastCaret;
  const query = bar.elements.query;
  const count = bar.querySelector('.find-count');
  function highlight(scroll = false) {
    cancelAnimationFrame(searchFrame);
    const registry=globalThis.CSS?.highlights;
    registry?.delete('note-find');
    registry?.delete('note-find-active');
    if (bar.hidden || getMode()==='source') return;
    ranges = matchingRanges(getMode()==='live'?live:reading,query.value);
    selected = ranges.length ? (selected%ranges.length+ranges.length)%ranges.length : 0;
    count.textContent = ranges.length ? (selected+1)+' / '+ranges.length : '0 / 0';
    if(registry){
      const highlights=new Highlight();
      for(const range of ranges)highlights.add(range);
      registry.set('note-find',highlights);
    }
    if (ranges.length) {
      if(registry)registry.set('note-find-active',new Highlight(ranges[selected]));
      if (scroll) ranges[selected].startContainer.parentElement.scrollIntoView({block:'center'});
    }
  }
  const update = () => { cancelAnimationFrame(searchFrame); searchFrame=requestAnimationFrame(()=>highlight()); };
  const contentObserver=new MutationObserver(()=>{
    if(!bar.hidden&&getMode()!=='source')update();
  });
  for(const editor of [reading,live])contentObserver.observe(editor,{childList:true,characterData:true,subtree:true});
  function close() {
    bar.hidden=true;
    highlight();
    if (getMode()==='live') liveView().focus();
  }
  function find() {
    if (!active()) return;
    if (getMode()==='source') { close(); openSourceSearch(); return; }
    bar.hidden=false;
    query.focus();
    query.select();
    highlight(true);
  }
  function replace(all) {
    if (!ranges.length || !active()) return;
    const value = bar.elements.replacement.value;
    if (getMode()==='read') {
      const text=active().text;
      const expression=new RegExp(literal(query.value),'giu');
      const matches=[...text.matchAll(expression)];
      if (matches.length === ranges.length && !/[\\`*_[\]<>#|\r\n]/.test(value)) {
        let i=0;
        applyText(text.replace(expression,match=>all || i++===selected?value:match));
      } else {
        const view=liveView(), operations=[];
        view.state.doc.descendants((node,pos)=>{
          if(!node.isTextblock)return true;
          let offset=0, text='', positions=[];
          node.forEach(child=>{
            if(child.isText){
              for(let i=0;i<child.text.length;i++)positions.push(pos+1+offset+i);
              text+=child.text;
            }else{positions.push(pos+1+offset);text+='\ufffc';}
            offset+=child.nodeSize;
          });
          for(const match of text.matchAll(expression)){
            operations.push([positions[match.index],positions[match.index+match[0].length-1]+1]);
          }
          return false;
        });
        if(operations.length!==ranges.length){toast('此处包含渲染后的内容，请在源码中修改。');return;}
        const tr=view.state.tr;
        (all?operations:[operations[selected]]).reverse().forEach(([from,to])=>tr.insertText(value,from,to));
        const serialized=crepe.editor.action(ctx=>ctx.get(serializerCtx)(tr.doc));
        applyText(splitFrontmatter(text).prefix+serialized);
      }
    } else {
      const view=liveView();
      const operations=(all?ranges:[ranges[selected]]).flatMap(range=>{
        if (!view.dom.contains(range.startContainer) || !view.dom.contains(range.endContainer)) return [];
        return [[view.posAtDOM(range.startContainer,range.startOffset,1),view.posAtDOM(range.endContainer,range.endOffset,-1)]];
      });
      if (!operations.length) { toast('请在源码模式编辑 YAML 属性。'); return; }
      const transaction=view.state.tr;
      operations.sort((a,b)=>b[0]-a[0]).forEach(([from,to])=>transaction.insertText(value,from,to));
      view.dispatch(transaction);
      flush();
    }
    update();
  }
  bar.addEventListener('input',event=>{if(event.target===query){selected=0;highlight(true);}});
  bar.addEventListener('submit',event=>{event.preventDefault();selected++;highlight(true);});
  bar.addEventListener('keydown',event=>{
    if (event.key==='Escape') {event.stopPropagation();close();}
    if (event.key==='Enter' && event.shiftKey) {event.preventDefault();selected--;highlight(true);}
  });
  bar.addEventListener('click',event=>{
    switch(event.target.dataset.find) {
      case 'previous': selected--;highlight(true);break;
      case 'replace': replace(false);break;
      case 'all': replace(true);break;
      case 'close': close();break;
    }
  });

  function updateFocus() {
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(()=>{
      const mode=getMode(), options=settings();
      let element, scroll, caret, position;
      if (mode==='source' && source.hasFocus) {
        position=source.state.selection.main.head;
        scroll=source.scrollDOM;
        const found=source.domAtPos(position);
        const dom=found.node.nodeType===1?found.node:found.node.parentElement;
        element=dom.closest('.cm-line');
        caret=source.coordsAtPos(position);
      } else if (mode==='live' && liveView().hasFocus()) {
        const view=liveView();
        position=view.state.selection.head;
        scroll=live;
        const found=view.domAtPos(position).node;
        const dom=found.nodeType===1?found:found.parentElement;
        element=dom.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote');
        caret=view.coordsAtPos(position);
      }
      const previous=section.querySelector('.writing-current');
      if (previous!==element) {previous?.classList.remove('writing-current');element?.classList.add('writing-current');}
      section.classList.toggle('paragraph-focus',!!element&&options.paragraphFocus);
      section.classList.toggle('typewriter-mode',options.typewriter);
      const signature = mode+':'+active()?.id+':'+position+':'+active()?.text.length+':'+options.typewriter;
      if (caret && options.typewriter && lastCaret!==signature) {
        const rect=scroll.getBoundingClientRect();
        scroll.scrollTop += (caret.top+caret.bottom)/2-(rect.top+rect.height/2);
      }
      lastCaret=signature;
    });
  }
  document.addEventListener('selectionchange',updateFocus);
  section.addEventListener('focusin',updateFocus);
  section.addEventListener('focusout',updateFocus);
  section.addEventListener('keyup',updateFocus);
  section.addEventListener('input',()=>{update();updateFocus();});

  function toMarkdown(html) {
    const body=document.createElement('div');
    body.innerHTML=sanitize(html,{FORBID_TAGS:['style','script','iframe','object','svg'],FORBID_ATTR:['style','class','id']});
    return crepe.editor.action(ctx=>{
      const state=liveView().state;
      const doc=PMParser.fromSchema(state.schema).parse(body);
      return ctx.get(serializerCtx)(doc);
    });
  }

  async function upload(file, tab=active()) {
    if (!tab) throw Error('请先打开或新建文档。');
    if (!tab.path && !await save(tab)) throw Error('请先保存文档，再添加附件。');
    const options=settings();
    if(!file.type&&types[file.name.split('.').pop().toLowerCase()]){
      file=new File([file],file.name,{type:types[file.name.split('.').pop().toLowerCase()]});
    }
    file=await compressPastedImage(file,options);
    return platform.fs.attachment({
      note:tab.path,strategy:options.attachmentStrategy,
      directory:options.attachmentStrategy==='workspace'?options.workspaceAttachments:options.noteAttachments,
      mime:file.type || types[file.name.split('.').pop().toLowerCase()],bytes:new Uint8Array(await file.arrayBuffer())
    });
  }
  function insert(markdown,target,block=false) {
    if (target.mode==='source') {
      source.dispatch({changes:{from:target.from,to:target.to,insert:markdown},selection:{anchor:target.from+markdown.length}});
      source.focus();
    } else {
      const view=liveView();
      const doc=crepe.editor.action(ctx=>ctx.get(parserCtx)(markdown));
      if (!doc?.content.size) return;
      let tr=view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(target.from),view.state.doc.resolve(target.to)));
      tr=tr.replaceSelection(block?new Slice(doc.content,0,0):Slice.maxOpen(doc.content));
      view.dispatch(tr.scrollIntoView());
      view.focus();
      flush();
    }
  }
  function insertionTarget() {
    const mode=getMode(),view=mode==='source'?source:liveView();
    const selected=mode==='source'?view.state.selection.main:view.state.selection;
    return {tab:active(),mode,view,doc:view.state.doc,from:selected.from,to:selected.to};
  }
  function assertInsertion(target) {
    if(!target.tab||active()!==target.tab||getMode()!==target.mode||target.view.state.doc!==target.doc)
      throw Error('文档已切换或修改，请重新插入。');
  }
  const imageLink=(file,url)=>'!['+file.name.replace(/[\[\]\r\n]/g,'')+']('+url+')';
  async function insertImage(file,target=insertionTarget()) {
    assertInsertion(target);
    const url=await upload(file,target.tab);
    assertInsertion(target);
    insert(imageLink(file,url),target);
  }
  async function pasteClipboard(plain=false,target=insertionTarget()) {
    assertInsertion(target);
    if(platform.clipboard.paste)return platform.clipboard.paste(plain);
    if(!plain){
      const image=await platform.clipboard.readImage?.();
      if(image)return insertImage(image,target);
    }
    const text=await (platform.clipboard.readText?.()??navigator.clipboard.readText());
    assertInsertion(target);
    if(text)insert(text,target);
  }
  function pasteOrDrop(event) {
    const mode=getMode(), tab=active();
    if (!tab || mode==='read') return;
    const editor=mode==='source'?sourceEl:live;
    if (!editor.contains(event.target) || event.target.closest('input,textarea')) return;
    const data=event.clipboardData||event.dataTransfer;
    if(!data)return;
    const images=[...data.files].filter(file=>file.type.startsWith('image/')||picture.test(file.name));
    const html=event.type==='paste' ? data.getData('text/html') : '';
    const text=data.getData('text/plain');
    if(event.type==='paste'&&platform.clipboard.readImage&&!images.length&&!html&&(!text||/^content:\/\//i.test(text))){
      event.preventDefault();
      event.stopImmediatePropagation();
      pasteClipboard().catch(fail);
      return;
    }
    const view=mode==='source'?source:liveView();
    const state=view.state;
    const selected=mode==='source'?state.selection.main:state.selection;
    const url=event.type==='paste'&&images.length===0&&selected.from!==selected.to?pastedURL(data.getData('text/plain')):null;
    if (!images.length&&!html&&!url) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (url) {
      const text=mode==='source'?state.sliceDoc(selected.from,selected.to):state.doc.textBetween(selected.from,selected.to,' ');
      insert('['+text.replace(/[\\\[\]]/g,'\\$&')+'](<'+url.replaceAll('<','%3C').replaceAll('>','%3E')+'>)',{mode,from:selected.from,to:selected.to});
      return;
    }
    let from=selected.from,to=selected.to;
    if (event.type==='drop') {
      const coords={x:event.clientX,y:event.clientY};
      const pos=mode==='source'?view.posAtCoords(coords):view.posAtCoords({left:coords.x,top:coords.y})?.pos;
      if (pos!=null) from=to=pos;
    }
    (async()=>{
      let markdown=html?toMarkdown(html):'';
      if (images.length) {
        const links=[];
        for (const file of images) {
          const url=await upload(file,tab);
          links.push(imageLink(file,url));
        }
        let i=0;
        if (markdown) markdown=markdown.replace(/!\[([^\]]*)\]\((?:<[^>]+>|[^)\n]+)\)/g,(match,label)=>i<links.length?'!['+label+']('+links[i++].split('](')[1]:match);
        markdown=[markdown,...links.slice(i)].filter(Boolean).join('\n\n');
      }
      if (!markdown) return;
      if (active()!==tab || getMode()!==mode || view.state.doc!==state.doc) throw Error('文档已切换或修改，请重新粘贴或拖放。');
      insert(markdown,{mode,from,to});
    })().catch(fail);
  }
  for (const type of ['paste','drop']) section.addEventListener(type,pasteOrDrop,true);
  section.addEventListener('dragover',event=>{
    if (getMode()!=='read' && event.dataTransfer.types.includes('Files') && event.target.closest('#source-editor,#live-editor')) event.preventDefault();
  },true);

  function onModeChange() {
    if (getMode()==='source' && !bar.hidden) close();
    update();
    updateFocus();
  }
  function insertTemplate(markdown) {
    const mode=getMode(), tab=active();
    if (!tab) return;
    const {prefix}=splitFrontmatter(tab.text);
    if (mode==='read') {
      applyText(tab.text.replace(/\s*$/,'')+'\n\n'+markdown);
      return;
    }
    const range=mode==='source'?source.state.selection.main:liveView().state.selection;
    const boundary=mode==='source'?prefix.length:0;
    insert(mode==='source'?'\n\n'+markdown.trim()+'\n\n':markdown,
      {mode,from:Math.max(boundary,range.from),to:Math.max(boundary,range.to)});
  }
  function wrap(marker) {
    const mode=getMode();
    if(mode==='read')return;
    const state=(mode==='source'?source:liveView()).state;
    const {from,to}=mode==='source'?state.selection.main:state.selection;
    if(from===to)return;
    const value=mode==='source'?state.sliceDoc(from,to):state.doc.textBetween(from,to,'\n');
    insert(value.startsWith(marker)&&value.endsWith(marker)?value.slice(marker.length,-marker.length):marker+value+marker,{mode,from,to});
  }

  function sourceLink(line,column) {
    const links=/\[\[([^\]\n]+)\]\]|\[[^\]\n]*\]\((<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\)|https?:\/\/[^\s<>()\]]+/gi;
    for(const match of line.matchAll(links)) {
      if(column<match.index||column>=match.index+match[0].length) continue;
      if(match[1])return {href:match[1].split('|')[0],wiki:true};
      return {href:match[2]?.replace(/^<|>$/g,'')||match[0]};
    }
  }
  function contextAt(event) {
    const mode=getMode(), tab=active();
    if(!tab||mode==='read')return;
    const isSource=mode==='source',view=isSource?source:liveView();
    const {state}=view;
    const selected=isSource?state.selection.main:state.selection;
    const pos=event.clientX||event.clientY ? (isSource?view.posAtCoords({x:event.clientX,y:event.clientY}):
      view.posAtCoords({left:event.clientX,top:event.clientY})?.pos) : selected.head;
    const inSelection=pos==null||pos>=selected.from&&pos<=selected.to;
    const from=inSelection?selected.from:pos,to=inSelection?selected.to:pos;
    const range={mode,from,to};
    const text=isSource?state.sliceDoc(from,to):state.doc.textBetween(from,to,'\n');
    function applySelection() {
      if(active()!==tab||getMode()!==mode||view.state.doc!==state.doc)
        throw Error('文档已切换或修改，请重新打开菜单。');
      if(isSource)view.dispatch({selection:inSelection?state.selection:{anchor:from,head:to}});
      else view.dispatch(view.state.tr.setSelection(inSelection?selected:
        Selection.near(view.state.doc.resolve(from))));
      view.focus();
    }
    async function cut() {
      await platform.clipboard.writeText(text);
      applySelection();
      if(isSource) source.dispatch({changes:{from,to},selection:{anchor:from},userEvent:'delete.cut',scrollIntoView:true});
      else {view.dispatch(view.state.tr.deleteSelection().scrollIntoView());flush();}
    }
    function selectAll() {
      applySelection();
      if(isSource)source.dispatch({selection:{anchor:0,head:source.state.doc.length}});
      else view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    }
    async function paste(plain) {
      applySelection();
      return pasteClipboard(plain,insertionTarget());
    }
    const line=isSource?state.doc.lineAt(pos??selected.head):null;
    const table=event.target.closest('table');
    const tableLine=isSource?
      (tableAtLine(tab.text,line.number-1)?line.number-1:undefined):
      (table?tableStartLines(tab.text)[[...view.dom.querySelectorAll('table')].indexOf(table)]:undefined);
    return {
      selected:from!==to, text, tableLine,
      link:line&&sourceLink(line.text,(pos??selected.head)-line.from),
      focus:applySelection, cut, paste, selectAll,
      insert(markdown) {applySelection();insert(markdown,range,true);},
      format(open,close=open,placeholder='文本') {
        applySelection();
        const value=text||placeholder;
        insert(open+value+close,range);
      }
    };
  }
  return {find,update,updateFocus,onModeChange,upload,blobURL,insertTemplate,wrap,contextAt,insertionTarget,insertImage,pasteClipboard};
}

