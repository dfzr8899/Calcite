import {t as tr} from "../shared/i18n/index.mjs";

import { properties } from './note-metadata.js';
export { splitFrontmatter, noteTags } from './note-metadata.js';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { EditorState } from '@codemirror/state';
import { EditorView, Decoration as CMDecoration } from '@codemirror/view';
import { oneMonokai } from './editor-theme.js';
import {$nodeSchema,$remark} from '@milkdown/kit/utils';

export const pagebreakNode=$nodeSchema('calcitePagebreak',()=>({
  group:'block',
  atom:true,
  toDOM:()=>['hr',{class:'note-pagebreak','aria-label':tr("noteRender.pageBreak")}],
  parseDOM:[{tag:'hr.note-pagebreak'}],
  parseMarkdown:{
    match:node=>node.type==='calcitePagebreak',
    runner:(state,node,type)=>state.addNode(type)
  },
  toMarkdown:{
    match:node=>node.type.name==='calcitePagebreak',
    runner:state=>state.addNode('html',undefined,'<!-- pagebreak -->')
  }
}));

export const remarkPagebreak=$remark('calcitePagebreak',()=>()=>tree=>{
  function visit(parent) {
    for(const node of parent.children||[]) {
      const content=node.type==='paragraph'&&node.children?.length===1?node.children[0]:node;
      if(content.type==='html'&&/^<!--\s*pagebreak\s*-->$/i.test(content.value?.trim())) {
        node.type='calcitePagebreak';
        delete node.children;
        delete node.value;
      } else visit(node);
    }
  }
  visit(tree);
});

export const noteExtension = /\.(md|markdown|mdown)$/i;
export const defaults = {
  attachmentStrategy: 'workspace',
  workspaceAttachments: 'assets',
  noteAttachments: './${filename}.assets',
  newNoteDirectory: '',
  templateDirectory: tr("notes.template"),
  dailyDirectory: 'Daily',
  dailyFilePattern: 'YYYY-MM-DD',
  dailyTemplate: '',
  historyLimit: 20,
  webpCompression: false,
  webpWidth: 1920,
  webpQuality: .82,
  typewriter: false,
  paragraphFocus: false
};
export function propertiesCard(yaml) {
  const card = document.createElement('section');
  card.className = 'note-properties';
  const title = document.createElement('strong');
  title.textContent = tr("notes.properties");
  card.append(title);
  const values = properties(yaml);
  if (!values) {
    const error = document.createElement('pre');
    error.textContent = yaml;
    card.append(error);
    return card;
  }
  const rows = document.createElement('dl');
  for (const [key,value] of Object.entries(values)) {
    const label = document.createElement('dt'), content = document.createElement('dd');
    label.textContent = key;
    if (Array.isArray(value)) {
      for (const item of value) {
        const chip = document.createElement('span');
        chip.className = 'property-chip';
        chip.textContent = String(item);
        content.append(chip);
      }
    } else content.textContent = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    rows.append(label,content);
  }
  card.append(rows);
  return card;
}

const calloutLabels = () => ({
  note:['✎',tr("notes.note")], info:['ⓘ',tr("notes.info")], tip:['◆',tr("notes.tip")], warning:['⚠',tr("notes.warning")],
  caution:['⚠',tr("notes.caution")], danger:['⛔',tr("notes.danger")], important:['!',tr("notes.important")], example:['◇',tr("notes.example")],
  question:['?',tr("notes.question")], quote:['❝',tr("notes.quote")], abstract:['≡',tr("notes.summary")], todo:['□',tr("notes.task")],
  success:['✓',tr("notes.success")], failure:['×',tr("notes.failure")], bug:['⚑',tr("notes.bug")]
});
const calloutMarker = /^\[!([\w-]+)\]([+-])?[ \t]*([^\r\n]*)/i;
function calloutData(text) {
  const match = calloutMarker.exec(text);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const labels = calloutLabels();
  const [icon,label] = labels[type] || labels.note;
  return { type, icon, title:match[3].trim() || label, fold:match[2], marker:match[0] };
}
export function styleCallouts(container) {
  for (const block of container.querySelectorAll('blockquote')) {
    const line = block.firstElementChild;
    const callout = line?.tagName === 'P' && calloutData(line.textContent);
    if (!callout) continue;
    const title = document.createElement(callout.fold ? 'summary' : 'header');
    title.className = 'callout-title';
    title.textContent = callout.icon + ' ' + callout.title;
    const walker = document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
    let remaining = callout.marker.length;
    while (remaining > 0 && walker.nextNode()) {
      const node = walker.currentNode;
      const cut = Math.min(remaining,node.length);
      node.deleteData(0,cut);
      remaining -= cut;
    }
    if (line.firstChild?.nodeName === 'BR') line.firstChild.remove();
    if (!line.textContent.trim() && !line.querySelector('img')) line.remove();
    const box = document.createElement(callout.fold ? 'details' : 'aside');
    box.className = 'note-callout';
    box.dataset.callout = callout.type;
    if (callout.fold) box.open = callout.fold === '+';
    box.append(title,...block.childNodes);
    block.replaceWith(box);
  }
}

export const liveWikiStatus = new PluginKey('calciteWikiStatus');
export function liveNotesPlugin(renderEmbed) {
  return new Plugin({
    key:liveWikiStatus,
    state:{
      init:()=>({path:undefined,links:new Map()}),
      apply:(transaction,state)=>transaction.getMeta(liveWikiStatus)??state
    },
    props: {
      decorations(state) {
        const decorations = [];
        const {path,links}=liveWikiStatus.getState(state);
        let embedCount=0;
        state.doc.descendants((node,pos) => {
          if (node.type.spec.code) return false;
          if (node.type.name === 'blockquote') {
            const callout = calloutData(node.firstChild?.textContent || '');
            if (callout) {
              const editing = state.selection.from > pos && state.selection.from < pos + node.nodeSize;
              decorations.push(Decoration.node(pos,pos + node.nodeSize,{
                class:'note-callout live-callout',
                'data-callout':callout.type,
                'data-callout-title':callout.icon + ' ' + callout.title
              }));
              const line = node.firstChild;
              if (!editing && line?.isTextblock && line.firstChild?.isText && line.firstChild.text.length >= callout.marker.length) {
                decorations.push(Decoration.inline(pos+2,pos+2+callout.marker.length,{class:'callout-marker'}));
              }
            }
          }
          if (node.isText && !node.marks.some(mark => mark.type.name === 'inlineCode' || mark.type.name === 'link')) {
            for (const match of node.text.matchAll(/(?<!\\)(!?)\[\[([^\]\r\n]+)\]\]/g)) {
              const from = pos + match.index;
              const to=from+match[0].length;
              const [destination,alias]=match[2].split('|');
              const editing=state.selection.from>from&&state.selection.from<to;
              decorations.push(Decoration.inline(from,from+match[0].length,{
                class:'wiki-link live-wiki',
                'data-wiki':destination,
                ...(links.has(destination)?{'data-link-status':links.get(destination)}:{}),
                ...(!editing&&alias&&!match[1]?{'data-wiki-alias':alias}:{}),
                title:tr("notes.hoverToPreviewCtrlClickToOpen")
              }));
              if(match[1]&&renderEmbed&&embedCount++<48)decorations.push(Decoration.widget(to,()=>{
                const host=document.createElement('span');
                host.className='live-embed-slot';
                host.contentEditable='false';
                renderEmbed(host,destination);
                return host;
              },{side:1,ignoreSelection:true,key:'embed:'+path+':'+from+':'+destination}));
            }
          }
        });
        return DecorationSet.create(state.doc,decorations);
      }
    }
  });
}

export function matchingRanges(container, query) {
  const groups = new Map();
  if (!query) return [];
  const walker = document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (parent.closest('script,style,svg,.katex-mathml,[hidden],.callout-marker,[contenteditable=false]')) continue;
    const block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,pre,dt,dd,summary,header') || parent;
    if (!groups.has(block)) groups.set(block,[]);
    groups.get(block).push(node);
  }
  const matches = [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');
  for (const nodes of groups.values()) {
    let length = 0;
    const offsets = nodes.map(node => {const start=length;length+=node.length;return {node,start};});
    for (const match of nodes.map(node => node.data).join('').matchAll(expression)) {
      const start = match.index, end = start + match[0].length;
      const first = offsets.findLast(item => item.start <= start);
      const last = offsets.findLast(item => item.start < end);
      const range = new Range();
      range.setStart(first.node,start-first.start);
      range.setEnd(last.node,end-last.start);
      matches.push(range);
    }
  }
  return matches;
}

function lineDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const rows = [];
  while (a.length && b.length && a[0] === b[0]) {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    for (const text of a.splice(0,prefix)) rows.push({text,kind:'same'});
    b.splice(0,prefix);
  }
  const tail = [];
  while (a.length && b.length && a.at(-1) === b.at(-1)) {
    tail.push({text:a.pop(),kind:'same'});
    b.pop();
  }
  if (a.length*b.length > 1500000) {
    for (const text of a) rows.push({text,kind:'removed'});
    for (const text of b) rows.push({text,kind:'added'});
  } else {
    const width = b.length+1, counts = new Uint32Array((a.length+1)*width);
    for (let i=a.length-1;i>=0;i--) {
      for (let j=b.length-1;j>=0;j--) {
        counts[i*width+j] = a[i] === b[j] ? 1+counts[(i+1)*width+j+1] : Math.max(counts[(i+1)*width+j],counts[i*width+j+1]);
      }
    }
    let i=0,j=0;
    while (i<a.length || j<b.length) {
      if (i<a.length && j<b.length && a[i]===b[j]) {
        rows.push({text:a[i++],kind:'same'}); j++;
      } else if (i<a.length && (j===b.length || counts[(i+1)*width+j]>=counts[i*width+j+1])) rows.push({text:a[i++],kind:'removed'});
      else rows.push({text:b[j++],kind:'added'});
    }
  }
  for (let i=tail.length-1;i>=0;i--) rows.push(tail[i]);
  for (let i=0;i<rows.length-1;i++) {
    const old = rows[i], next = rows[i+1];
    if (old.kind !== 'removed' || next.kind !== 'added') continue;
    let left=0,right=0;
    const max=Math.min(old.text.length,next.text.length);
    while (left<max && old.text[left]===next.text[left]) left++;
    while (right<max-left && old.text.at(-1-right)===next.text.at(-1-right)) right++;
    old.changed=[left,old.text.length-right];
    next.changed=[left,next.text.length-right];
  }
  return rows;
}
export function sideBySideDiff(parent,before,after,labels) {
  const table=document.createElement('table');
  table.className='external-versions';
  const heading=table.createTHead().insertRow();
  for(const label of labels){
    const th=document.createElement('th');
    th.scope='col';
    th.textContent=label;
    heading.append(th);
  }
  const body=table.createTBody();
  const lines=lineDiff(before,after);
  function render(left,right) {
    const row=body.insertRow();
    for(const line of [left,right]){
      const cell=row.insertCell();
      if(!line)continue;
      cell.textContent=line.text;
      if(line.kind!=='same')cell.className='diff-'+line.kind;
    }
  }
  for(let i=0;i<lines.length;){
    if(lines[i].kind==='same'){
      render(lines[i],lines[i]);
      i++;
      continue;
    }
    const removed=[],added=[];
    while(i<lines.length&&lines[i].kind!=='same'){
      (lines[i].kind==='removed'?removed:added).push(lines[i++]);
    }
    for(let n=0;n<Math.max(removed.length,added.length);n++)render(removed[n],added[n]);
  }
  parent.append(table);
}

export function diffView(parent, before, after) {
  const rows = lineDiff(before,after);
  const ranges = [];
  let pos = 0;
  const doc = rows.map(({text,kind,changed}) => {
    const line = (kind==='added' ? '+ ' : kind==='removed' ? '− ' : '  ') + text;
    if (kind !== 'same') ranges.push(CMDecoration.line({class:'diff-'+kind}).range(pos));
    if (changed && changed[0]<changed[1]) ranges.push(CMDecoration.mark({class:'diff-word-'+kind}).range(pos+2+changed[0],pos+2+changed[1]));
    pos += line.length+1;
    return line;
  }).join('\n');
  return new EditorView({
    parent,
    state:EditorState.create({doc,extensions:[oneMonokai,EditorView.lineWrapping,EditorState.readOnly.of(true),EditorView.editable.of(false),EditorView.decorations.of(CMDecoration.set(ranges,true))]})
  });
}

