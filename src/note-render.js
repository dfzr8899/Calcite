import {t as tr} from "../shared/i18n/index.mjs";
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import {fromMarkdown} from 'mdast-util-from-markdown';
import { styleCallouts } from './notes.js';
import {mathOptions} from './math-options.js';
import {randomId} from './random-id.js';

const escape = value => String(value).replace(/[&<>"']/g, character =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const blockMarker = /(?:[ \t]+|^)[\^]([\w-]+)[ \t]*(?=\r?$)/gm;

function protectCode(text,replace) {
  let cursor=0,result='';
  function visit(node){
    if(node.type==='code'||node.type==='inlineCode'){
      const {start,end}=node.position;
      result+=text.slice(cursor,start.offset)+replace(text.slice(start.offset,end.offset));
      cursor=end.offset;
    }else for(const child of node.children||[])visit(child);
  }
  visit(fromMarkdown(text));
  return result+text.slice(cursor);
}

export function renderNote(text, { numberEquations = false, macros, externalPreview = false } = {}) {
  const prefix = 'note-' + randomId();
  const renderToken = 'RENDERTOKEN'+prefix+'-';
  const codeToken = 'CODETOKEN'+prefix+'-';
  const renderPattern = new RegExp(renderToken+'(\\d+)END','g');
  const codePattern = new RegExp(codeToken+'(\\d+)END','g');
  const snippets = [];
  const store = html => renderToken+(snippets.push(html)-1)+'END';
  const codes = [];
  text=protectCode(text,code=>codeToken+(codes.push(code)-1)+'END');
  text = text.replace(/^ {0,3}<!--\s*pagebreak\s*-->[ \t]*(?=\r?$)/gim,()=>
    '\n'+store(`<hr class="note-pagebreak" aria-label="${tr("noteRender.pageBreak")}">`)+'\n');
  const labels = new Map();
  let equation = 0;
  text.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => {
    const label = body.match(/\\label\{([^{}]+)\}/)?.[1];
    if (numberEquations || label) equation++;
    if (label) labels.set(label, body.match(/\\tag\{([^{}]+)\}/)?.[1] || String(equation));
    return _;
  });
  const references = value => value.replace(/\\(eqref|ref)\{([^{}]+)\}/g,
    (_, type, label) => '\\text{'+(type==='eqref'?'(':'')+(labels.get(label)||'??').replace(/[{}\\]/g,'')+(type==='eqref'?')':'')+'}');
  function renderMath(source, countEquations=true) {
    return source.replace(/\$\$([\s\S]+?)\$\$|(?<![\\\w])\$([^\n$]+?)\$/g, (_, block, inline) => {
      let value = references(block ?? inline);
      if (block) {
        const hasLabel = /\\label\{[^{}]+\}/.test(value);
        value = value.replace(/\\label\{[^{}]+\}/g,'');
        if (countEquations && (numberEquations || hasLabel)) {
          equation++;
          if (!/\\tag\*?\{/.test(value)) value += '\\tag{'+equation+'}';
        }
      }
      return store(katex.renderToString(value,{...mathOptions(macros),displayMode:!!block}));
    });
  }
  equation = 0;
  text = renderMath(text, true);
  const definitions = new Map();
  text = text.replace(/^ {0,3}\[\^([^\]\n]+)\]:[ \t]*([^\n]*(?:\n(?: {4}|\t)[^\n]*)*)/gm, (_, label, body) => {
    definitions.set(label.trim().toLowerCase(), body.replace(/\n(?: {4}|\t)/g,'\n'));
    return '';
  });
  const used = new Map();
  text = text.replace(/(?<![\\])\[\^([^\]\n]+)\]/g, (raw,label) => {
    const key = label.trim().toLowerCase();
    if (!definitions.has(key)) return raw;
    if (!used.has(key)) used.set(key, {index:used.size+1,count:0});
    const note = used.get(key);
    const id = prefix+'-fn-'+note.index;
    note.count++;
    return store('<sup><a data-local-anchor href="#'+id+'" id="'+id+'-ref-'+note.count+'">'+note.index+'</a></sup>');
  });
  const decodeCodes = value => value.replace(codePattern, (_, index) => codes[index]);
  const wiki = value => value.replace(/(?<!\\)(!?)\[\[([^\]\r\n]+)\]\]/g,(_,embed,target)=>{
    const [destination,label] = target.split('|');
    return store(embed
      ? '<span class="note-embed" data-embed="'+escape(destination)+'">!['+'['+escape(target)+']'+']</span>'
      : '<a href="calcite-wiki://'+encodeURIComponent(destination)+'" data-wiki="'+escape(destination)+'" class="wiki-link">'+escape(label || destination)+'</a>');
  });
  function parse(value) {
    const content = document.createElement('div');
    content.innerHTML = DOMPurify.sanitize(marked.parse(decodeCodes(value),{gfm:true,breaks:false}),{
      FORBID_TAGS:externalPreview?['iframe','frame','style','link','form','button','textarea','select','use','image','feImage']:['iframe','frame','style','link','object','embed','form','base','meta'],
      ...(externalPreview?{ALLOW_DATA_ATTR:false,FORBID_ATTR:['src','srcset','style','background','poster','ping','action','formaction','autofocus']}:{}),
      ALLOWED_URI_REGEXP:/^(?:https?:|mailto:|tel:|calcite-wiki:\/\/|note-image:\/\/local\/|[^a-z]|[a-z+.-]+(?:[^a-z+.:\-]|$))/i
    });
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement.closest('pre,code')) texts.push(walker.currentNode);
    }
    for (const node of texts) {
      const value = node.textContent;
      const pieces = [];
      let start = 0;
      for (const match of value.matchAll(renderPattern)) {
        if (!snippets[match[1]]) continue;
        const fragment = document.createElement('template');
        fragment.innerHTML = snippets[match[1]];
        pieces.push(value.slice(start,match.index),fragment.content);
        start = match.index+match[0].length;
      }
      if (start) node.replaceWith(...pieces,value.slice(start));
    }
    return content.innerHTML;
  }
  text = wiki(text).replace(/^ {0,3}\[toc\][ \t]*$/gim, () => store(`<nav class="note-toc" aria-label="${tr("noteRender.tableOfContents")}"></nav>`));
  text = text.replace(blockMarker, (_, id) => store('<span class="block-marker" data-block-id="'+escape(id)+'"></span>'));
  const container = document.createElement('div');
  container.innerHTML = parse(text);
  for(const checkbox of container.querySelectorAll('li > input[type="checkbox"],li > p > input[type="checkbox"]'))
    checkbox.closest('li').classList.add('task-list-item');
  for(const rule of container.querySelectorAll('.note-pagebreak')) {
    if (rule.parentElement.tagName==='P'&&rule.parentElement.children.length===1) rule.parentElement.replaceWith(rule);
  }
  for (const marker of container.querySelectorAll('.block-marker')) {
    const parent = marker.parentElement;
    const target = parent.tagName==='P' && !parent.textContent.trim() && parent.children.length===1
      ? parent.previousElementSibling : parent;
    if (target) target.dataset.blockId = marker.dataset.blockId;
    if (target && target!==parent) parent.remove();
    else marker.remove();
  }
  const headings = [...container.children].filter(element=>/^H[1-6]$/.test(element.tagName));
  headings.forEach((heading,index)=>{ if (!heading.id) heading.id = prefix+'-heading-'+index; });
  const slugs=new Map(), counts=new Map();
  for (const heading of headings) {
    const slug=heading.textContent.toLocaleLowerCase().replace(/[^\p{L}\p{N}_ -]/gu,'').replace(/\s/g,'-');
    const previous=counts.get(slug)||0;counts.set(slug,previous+1);
    slugs.set(slug+(previous?'-'+previous:''),heading.id);
  }
  for (const link of container.querySelectorAll('a[href^="#"]')) {
    const id=slugs.get(link.getAttribute('href').slice(1));
    if(id){link.setAttribute('href','#'+id);link.dataset.localAnchor='';}
  }
  for (const toc of container.querySelectorAll('.note-toc')) {
    const nav = toc.parentElement.tagName==='P' && toc.parentElement.children.length===1 ? toc.parentElement : toc;
    if (nav!==toc) nav.replaceWith(toc);
    toc.innerHTML = `<strong>${tr("exportCenter.contents")}</strong><ul>`+headings.map(heading=>
      '<li style="margin-left:'+((Number(heading.tagName[1])-1)*14)+'px"><a data-local-anchor href="#'+escape(heading.id)+'">'+escape(heading.textContent)+'</a></li>').join('')+'</ul>';
  }
  if (used.size) {
    const list = document.createElement('section');
    list.className = 'note-footnotes';
    list.setAttribute('aria-label',tr("noteRender.footnotes"));
    list.innerHTML = '<hr><ol>'+[...used].map(([key,{index,count}]) => {
      const id = prefix+'-fn-'+index;
      const backlinks = Array.from({length:count},(_,i)=>'<a data-local-anchor href="#'+id+'-ref-'+(i+1)+`" aria-label="${tr("noteRender.returnToReference")} `+(i+1)+'">↩</a>').join(' ');
      const protectedFootnote = protectCode(definitions.get(key),code=>codeToken+(codes.push(code)-1)+'END');
      return '<li id="'+id+'">'+parse(wiki(renderMath(protectedFootnote,false)))+' '+backlinks+'</li>';
    }).join('')+'</ol>';
    container.append(list);
  }
  styleCallouts(container);
  return container.innerHTML;
}

export function wrapReadingTables(container) {
  for(const table of container.querySelectorAll('table')){
    const wrap=document.createElement('div');
    wrap.className='table-wrap';
    wrap.tabIndex=0;
    wrap.setAttribute('role','region');
    wrap.setAttribute('aria-label',tr("noteRender.scrollTableHorizontally"));
    table.before(wrap);
    wrap.append(table);
  }
}
