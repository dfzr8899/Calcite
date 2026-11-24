import {t as tr} from "../shared/i18n/index.mjs";
import {noteHeadings as indexedHeadings} from '../shared/core/vault-index.mjs';
import {encodeWiki,headingIdentifiers,wikiIdentifiers} from '../shared/note-links.mjs';
import {syntaxTree} from '@codemirror/language';
import {RangeSet,StateEffect,StateField} from '@codemirror/state';
import {Decoration,EditorView} from '@codemirror/view';

const replaceOutlineFolds=StateEffect.define();
export const sourceOutlineFolds=StateField.define({
  create:()=>Decoration.none,
  update(value,transaction) {
    return transaction.effects.find(effect=>effect.is(replaceOutlineFolds))?.value??value.map(transaction.changes);
  },
  provide:field=>[EditorView.decorations.from(field),EditorView.atomicRanges.of(view=>view.state.field(field))]
});

export function noteHeadings(text) {
  return indexedHeadings(text.replace(/\r\n?/g,'\n'));
}

export function installOutline({ $, escape, headings, active, mode, source }) {
  const panel = $('#outline');
  const filter = $('#outline-filter');
  let frame, selected = -1;
  let preview;
  const scroller = () => mode() === 'source' ? source().scrollDOM : mode() === 'live' ? $('#live-scroll') : $('#reading');
  const content = () => mode() === 'live' ? $('.milkdown .ProseMirror') : $('#reading .reading-content');
  const selector = 'h1,h2,h3,h4,h5,h6';
  const folded = () => active() && (active().foldedSections ??= new Set());
  const sectionKey = (heading, index) => heading.text + '\0' + index;
  const query = () => filter.value.trim().toLocaleLowerCase();
  function isHidden(rows, exceptions) {
    const sections = folded();
    let depth = 7;
    return rows.map((row,index)=>{
      if (row.level <= depth) depth = 7;
      const hidden = depth < 7;
      const key = sectionKey(row,index);
      if (!hidden && sections?.has(key) && !exceptions?.has(key)) depth = row.level;
      return hidden;
    });
  }
  function ancestors(rows,index) {
    const keys = new Set();
    let level = rows[index].level;
    for (let i=index-1;i>=0;i--) {
      if (rows[i].level >= level) continue;
      keys.add(sectionKey(rows[i],i));
      level = rows[i].level;
    }
    return keys;
  }
  function update() {
    const rows = headings();
    const sections=folded();
    const exceptions=preview?.tab===active()&&query()?preview.ancestors:undefined;
    const parent = content();
    const scroll = scroller();
    const top = scroll.getBoundingClientRect().top + 48;
    let current = rows.length ? 0 : -1;
    if (mode() === 'source') {
      const view=source(),doc=view.state.doc,hidden=isHidden(rows,exceptions);
      const ranges=[];
      for(let i=0;i<rows.length;i++) {
        const row=rows[i],key=sectionKey(row,i);
        if(hidden[i]||!sections?.has(key)||exceptions?.has(key))continue;
        let end=i+1;
        while(rows[end]?.level>row.level)end++;
        const from=doc.line(Math.min(row.line,doc.lines)).to;
        const to=doc.line(Math.min(rows[end]?rows[end].line-1:doc.lines,doc.lines)).to;
        if(to>from)ranges.push(Decoration.replace({block:true}).range(from,to));
      }
      const next=Decoration.set(ranges);
      if(!RangeSet.eq([view.state.field(sourceOutlineFolds)],[next]))
        view.dispatch({effects:replaceOutlineFolds.of(next)});
      const block = view.lineBlockAtHeight(scroll.scrollTop + 44);
      const line = doc.lineAt(block.from).number;
      rows.forEach((row, index) => { if (!hidden[index]&&row.line <= line) current = index; });
    } else if (parent) {
      let index = 0;
      let depth = 7;
      for (const element of parent.children) {
        if (element.matches(selector)) {
          const level = Number(element.tagName[1]);
          if (level <= depth) depth = 7;
          const hidden = depth < 7;
          element.toggleAttribute('data-section-hidden', hidden);
          if (!hidden && element.getBoundingClientRect().top <= top) current = index;
          if (!hidden && rows[index]) {
            const key = sectionKey(rows[index],index);
            if (sections?.has(key) && !exceptions?.has(key)) depth = level;
          }
          index++;
        } else {
          element.toggleAttribute('data-section-hidden', depth < 7);
        }
      }
    }
    selected = current;
    panel.querySelectorAll('[data-heading]').forEach(button => {
      const active = Number(button.dataset.heading) === selected;
      button.classList.toggle('current',active);
      if (active) button.setAttribute('aria-current','location');
      else button.removeAttribute('aria-current');
    });
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  }
  function render() {
    const term = query();
    const rows = headings();
    const hidden = isHidden(rows);
    panel.innerHTML = rows.map((heading,index) => {
      const {level,text} = heading;
      if (term ? !text.toLocaleLowerCase().includes(term) : hidden[index]) return '';
      const closed = folded()?.has(sectionKey(heading, index));
      return '<div class="outline-row" data-level="'+level+'" style="--level:'+level+'">' +
        '<button type="button" class="outline-fold" data-fold-heading="'+index+`" title="${tr("navigation.foldOrUnfoldSection")}" aria-label="${tr("navigation.foldOrUnfold")} `+escape(text)+'" aria-expanded="'+!closed+'"></button>' +
        '<button class="outline-item '+(index===selected?'current':'')+'" data-heading="'+index+'" title="'+escape(text)+'"><span>'+escape(text)+'</span></button></div>';
    }).join('') || '<p class="side-empty">'+(term?tr("navigation.noMatchingHeadings"):tr("navigation.addAHeadingToSeeTheOutline"))+'</p>';
    schedule();
  }
  function toggle(index) {
    const row = headings()[index];
    const sections = folded();
    if (!row || !sections) return;
    const key = sectionKey(row, index);
    if (!sections.delete(key)) sections.add(key);
    preview = undefined;
    render();
  }
  function foldAll(close) {
    const sections=folded();
    if (!sections) return;
    sections.clear();
    if (close) {
      const rows=headings();
      rows.forEach((row,index)=>{
        if (rows[index+1]?.level>row.level) sections.add(sectionKey(row,index));
      });
    }
    preview=undefined;
    render();
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-fold-heading]');
    if (!button) return;
    const index = Number(button.dataset.foldHeading);
    toggle(index);
    panel.querySelector('[data-fold-heading="'+index+'"]')?.focus();
  });
  filter.addEventListener('input',()=>{preview=undefined;render();});
  for (const scroll of [$('#live-scroll'), $('#reading'), source().scrollDOM])
    scroll.addEventListener('scroll', schedule, { passive: true });
  return {
    render,
    schedule,
    toggle,
    foldAll,
    isFolded(index) {
      const row=headings()[index];
      return Boolean(row && folded()?.has(sectionKey(row,index)));
    },
    reveal(index, fromOutline=false) {
      const rows = headings();
      if (!rows[index]) return;
      const keys = ancestors(rows,index);
      if (fromOutline && query()) preview = {tab:active(),ancestors:keys};
      else for (const key of keys) folded()?.delete(key);
      update();
      render();
    }
  };
}

export function installLinkCompletion({ $, active, mode, liveView, source, files, lookup, relative, key, onError }) {
  const popup = document.createElement('div');
  popup.className = 'link-completion feature-menu';
  popup.hidden = true;
  document.body.append(popup);
  let entries = [], selected = 0, serial = 0, timer, context;
  const extension = /\.(?:md|markdown|mdown)$/i;
  let catalogFiles, catalog;
  function close() {
    serial++;
    clearTimeout(timer);
    context = undefined;
    popup.hidden = true;
  }
  function readContext() {
    if (!active() || !['source', 'live'].includes(mode())) return;
    const isSource = mode() === 'source';
    const editor = isSource ? source() : liveView();
    if (!(isSource ? editor.hasFocus : editor.hasFocus()) || (isSource ? !editor.state.selection.main.empty : !editor.state.selection.empty)) return;
    const position = isSource ? editor.state.selection.main.head : editor.state.selection.from;
    const before = isSource
      ? editor.state.doc.sliceString(editor.state.doc.lineAt(position).from, position)
      : editor.state.selection.$from.parent.textBetween(0, editor.state.selection.$from.parentOffset, '\ufffc', '\ufffc');
    if (!isSource && editor.state.selection.$from.parent.type.spec.code) return;
    if(isSource)for(let node=syntaxTree(editor.state).resolveInner(position,-1);node;node=node.parent)
      if(/^(?:FencedCode|CodeBlock|InlineCode)$/.test(node.name))return;
    const match = before.match(/(?<!\\)\[\[([^\][|\r\n]*)$/);
    if (match) return {isSource, editor, position, from:position-match[0].length, query:match[1], tab:active()};
  }
  async function show() {
    const next = readContext();
    if (!next) return close();
    const request = ++serial;
    const [file, fragment] = next.query.split(/#(.*)/s, 2);
    const all = files().filter(item=>extension.test(item.name));
    let options;
    if (fragment !== undefined) {
      const target=file?await lookup(next.tab.path,file):null;
      const rows=!file||target?.path===next.tab.path?headingIdentifiers(noteHeadings(next.tab.text)):target?.headings||[];
      const needle = fragment.toLocaleLowerCase();
      options = rows.filter(row=>row.text.toLocaleLowerCase().includes(needle)||row.slug.includes(needle))
        .map(row=>({label:row.text,detail:row.fragment===row.text?'':row.fragment,value:file+'#'+encodeWiki(row.fragment)}));
    } else {
      const needle = file.replace(/^\//,'').toLocaleLowerCase();
      if(!catalogFiles||catalogFiles.length!==all.length||all.some((item,i)=>item.path!==catalogFiles[i].path)){
        catalogFiles=all;
        catalog=wikiIdentifiers(all.map(item=>item.path),relative,key);
      }
      options = all.map(item=>({label:item.name.replace(extension,''), detail:relative(item.path),
        value:file.startsWith('/')?'/'+encodeWiki(relative(item.path).replace(extension,'')):catalog.get(item.path)}))
        .filter(item=>item.detail.toLocaleLowerCase().includes(needle)||item.value.toLocaleLowerCase().includes(needle))
        .sort((a,b)=>Number(b.label.toLocaleLowerCase().startsWith(needle))-Number(a.label.toLocaleLowerCase().startsWith(needle)));
    }
    if (request !== serial || readContext()?.query !== next.query) return;
    entries = options.slice(0, 12);
    if (!entries.length) return close();
    if (context?.query !== next.query) selected = 0;
    context = next;
    const rect = next.editor.coordsAtPos(next.position);
    if (!rect) return close();
    popup.hidden = false;
    popup.style.left = Math.max(6, Math.min(rect.left, innerWidth - popup.offsetWidth - 6)) + 'px';
    paint();
    popup.style.top = (rect.bottom + popup.offsetHeight + 8 < innerHeight ? rect.bottom + 4 : Math.max(6, rect.top - popup.offsetHeight - 4)) + 'px';
  }
  function paint() {
    popup.replaceChildren(...entries.map((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.classList.toggle('chosen', index === selected);
      button.dataset.index = index;
      button.textContent = entry.label;
      if (entry.detail) {
        const small = document.createElement('small');
        small.textContent = entry.detail;
        button.append(small);
      }
      return button;
    }));
    popup.children[selected]?.scrollIntoView({block:'nearest'});
  }
  function accept(index) {
    const next = readContext();
    if (!next || next.query !== context?.query || next.tab !== context.tab) return close();
    const { editor, position, from } = next;
    const tail = next.isSource ? editor.state.doc.sliceString(position, position+2) : editor.state.selection.$from.parent.textBetween(editor.state.selection.$from.parentOffset, Math.min(editor.state.selection.$from.parentOffset+2,editor.state.selection.$from.parent.content.size));
    const insert = '[['+entries[index].value+']]';
    const to = position + (tail === ']]' ? 2 : 0);
    close();
    if (next.isSource) editor.dispatch({changes:{from,to,insert},selection:{anchor:from+insert.length}});
    else editor.dispatch(editor.state.tr.insertText(insert,from,to));
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => show().catch(error => { close(); onError(error); }), 45);
  }
  for (const target of [$('#live-editor'), $('#source-editor')]) {
    target.addEventListener('input', schedule);
    target.addEventListener('keyup', event => {
      if (!['Escape','Enter','Tab','ArrowUp','ArrowDown'].includes(event.key)) schedule();
    });
    target.addEventListener('keydown', event => {
      if (popup.hidden) return;
      if (!['Escape','Enter','Tab','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') close();
      else if (event.key === 'Enter' || event.key === 'Tab') accept(selected);
      else {
        selected = (selected + entries.length + (event.key === 'ArrowDown' ? 1 : -1)) % entries.length;
        paint();
      }
    }, true);
  }
  popup.addEventListener('mousedown',event=>event.preventDefault());
  popup.addEventListener('click',event=>{const button=event.target.closest('[data-index]');if(button)accept(Number(button.dataset.index));});
  document.addEventListener('pointerdown',event=>{if(!popup.contains(event.target))close();});
  return {close};
}
