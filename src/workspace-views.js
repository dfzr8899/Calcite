import {settingToggle,showDialog} from './mobile-ui.js';
import { splitFrontmatter } from './note-metadata.js';
import { noteHeadings } from './navigation.js';
import { createCanvasView } from './canvas-view.js';
import { showGraph } from './graph-view.js';

export function createWorkspaceViews({$,platform,ask,escape,base,relative,root,files,tabs,active,render,diagrams,open,openHeading,headingMatches,editProperty,changeTab,saveTab,remember,config,toast,fail}) {
  const overlay=document.createElement('dialog');
  overlay.className='feature-dialog workspace-view';
  document.body.append(overlay);
  let graphPanel, graphRequest=0;
  const run = callback => (...args) => Promise.resolve().then(()=>callback(...args)).catch(fail);
  const drafts = () => tabs().filter(tab=>tab.path&&tab.dirty&&!tab.deleted).map(({path,text})=>({path,text}));
  const requireRoot = () => { if(!root())throw Error('请先打开工作区。'); };
  function dialog(title, markup) {
    graphRequest++;
    if (graphPanel?.open) graphPanel.close();
    if (overlay.open) overlay.close();
    overlay.innerHTML='<header class="workspace-view-heading"><h2>'+escape(title)+'</h2><form method="dialog"><button aria-label="关闭" title="关闭">×</button></form></header>'+markup;
    showDialog(overlay);
    return overlay;
  }
  const bookmarkPath = path => path?.replaceAll('\\','/').toLocaleLowerCase();
  async function addBookmark(path,heading='') {
    requireRoot();
    const item = {path,heading};
    if (config().bookmarks.some(row=>bookmarkPath(row.path)===bookmarkPath(path)&&row.heading===heading)) {
      toast('已收藏此位置');
      return;
    }
    config().bookmarks.push(item);
    remember();
    toast('已添加书签');
  }
  async function bookmarkHeading() {
    const tab=active();
    if (!tab?.path) throw Error('请先保存当前笔记。');
    const headings=noteHeadings(splitFrontmatter(tab.text).body);
    const form=await ask('收藏笔记或标题','<label>位置<select name="heading"><option value="">整篇笔记</option>'+
      headings.map(({text})=>'<option value="'+escape(text)+'">'+escape(text)+'</option>').join('')+'</select></label>','添加书签');
    if(form)await addBookmark(tab.path,String(form.get('heading')));
  }
  function bookmarks() {
    requireRoot();
    const items=config().bookmarks;
    const panel=dialog('书签','<div class="bookmark-list">'+(items.length?items.map((item,i)=>
      '<div><button data-bookmark="'+i+'" title="'+escape(relative(item.path))+'">'+escape(base(item.path))+
      (item.heading?' · '+escape(item.heading):'')+'</button><button data-remove="'+i+'" aria-label="删除书签" title="删除书签">×</button></div>').join(''):
      '<p class="side-empty">在标签页右键收藏笔记，或从命令面板收藏具体标题。</p>')+'</div>');
    panel.querySelector('.bookmark-list').addEventListener('click',run(async event=>{
      const button=event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-remove')) {
        items.splice(Number(button.dataset.remove),1);remember();bookmarks();return;
      }
      const item=items[Number(button.dataset.bookmark)];
      if (!item) return;
      overlay.close();
      await openHeading(item.path,item.heading);
    }));
  }

  async function graph(local=false) {
    requireRoot();
    const selected=active()?.path;
    if (local && !selected) throw Error('请先打开一篇已保存的笔记。');
    const workspace=root();
    const request=++graphRequest;
    const data=await platform.index.graph(drafts());
    if (root()!==workspace || request!==graphRequest) return;
    if (graphPanel?.open) graphPanel.close();
    const panel=showGraph(data,{selected,relative,caseInsensitive:platform.os==='win32',local,open,fail});
    graphPanel=panel;
    panel.addEventListener('close',()=>{if (graphPanel===panel) graphPanel=null;},{once:true});
  }

  async function bases(saved) {
    requireRoot();
    const workspace=root();
    const notes=await platform.index.notes('metadata',drafts());
    if(root()!==workspace)return;
    const keys=[...new Set(notes.flatMap(note=>Object.keys(note.values)))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
    const options=keys.map(key=>'<option value="'+escape(key)+'">'+escape(key)+'</option>').join('');
    const panel=dialog('属性视图 · Bases',
      '<div class="workspace-view-tools"><label>已保存视图 <select name="view"><option value="">临时视图</option>'+
      config().bases.map((view,index)=>'<option value="'+index+'">'+escape(view.name)+'</option>').join('')+
      '</select></label><button data-view-action="save">保存视图</button><button data-view-action="delete">删除视图</button>'+
      '<label>属性 <select name="property"><option value="">文件名</option>'+options+'</select></label>'+
      '<input name="filter" placeholder="筛选文件名或属性值" aria-label="筛选属性视图">'+
      '<label>排序 <select name="sort"><option value="">文件名</option>'+options+'</select></label>'+
      settingToggle('descending','降序')+
      '<label>布局 <select name="layout"><option value="table">表格</option><option value="cards">卡片</option></select></label>'+
      '</div><div class="bases-results"></div>');
    const field=name=>panel.querySelector('[name='+name+']');
    if(saved) {
      for(const key of ['property','filter','sort','layout'])field(key).value=saved[key]||'';
      if(!field('layout').value)field('layout').value='table';
      field('descending').checked=!!saved.descending;
      const index=config().bases.indexOf(saved);
      if(index>=0)field('view').value=String(index);
    }
    const state=()=>({
      property:field('property').value,filter:field('filter').value,sort:field('sort').value,
      descending:field('descending').checked,layout:field('layout').value
    });
    const valueText=value=>value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
    const output=panel.querySelector('.bases-results');
    function draw(){
      const {property,filter,sort,descending,layout}=state();
      const needle=filter.toLocaleLowerCase();
      const value=note=>property?valueText(note.values[property]):relative(note.path);
      const ordered=notes.filter(note=>value(note).toLocaleLowerCase().includes(needle)).sort((a,b)=>{
        const left=sort?a.values[sort]:base(a.path), right=sort?b.values[sort]:base(b.path);
        const comparison=typeof left==='number'&&typeof right==='number'?left-right:valueText(left).localeCompare(valueText(right),'zh-CN',{numeric:true});
        return (descending?-1:1)*comparison;
      });
      const cell=note=>'<button data-open-note="'+escape(note.path)+'" title="'+escape(relative(note.path))+'">'+escape(base(note.path))+'</button>';
      const edit=note=>'<button data-edit-note="'+escape(note.path)+'" title="编辑属性">编辑</button>';
      const columns=property?[property]:keys.slice(0,5);
      const grid=layout==='cards'?'<div class="base-cards">'+ordered.map(note=>'<article>'+cell(note)+'<dl>'+
        columns.map(key=>'<dt>'+escape(key)+'</dt><dd>'+escape(valueText(note.values[key]))+'</dd>').join('')+'</dl>'+edit(note)+'</article>').join('')+'</div>':
        '<table><thead><tr><th>笔记</th>'+columns.map(key=>'<th>'+escape(key)+'</th>').join('')+'<th>属性</th></tr></thead><tbody>'+
        ordered.map(note=>'<tr><td>'+cell(note)+'</td>'+columns.map(key=>'<td>'+escape(valueText(note.values[key]))+'</td>').join('')+'<td>'+edit(note)+'</td></tr>').join('')+'</tbody></table>';
      output.innerHTML=ordered.length?grid:'<p class="side-empty">没有匹配的笔记。</p>';
      panel.querySelector('[data-view-action=delete]').disabled=field('view').value==='';
    }
    panel.querySelector('.workspace-view-tools').addEventListener('input',draw);
    field('view').addEventListener('change',run(()=>{
      const index=field('view').value;
      return bases(index===''?undefined:config().bases[Number(index)]);
    }));
    panel.querySelector('[data-view-action=save]').addEventListener('click',run(async()=>{
      const existing=field('view').value===''?undefined:config().bases[Number(field('view').value)];
      const form=await ask('保存属性视图','<label>名称<input name="name" required value="'+escape(existing?.name||'')+'"></label>','保存');
      const name=String(form?.get('name')||'').trim();
      if(!name)return;
      const view={...state(),name};
      const index=config().bases.findIndex(item=>item.name===name);
      if(index<0)config().bases.push(view);else config().bases[index]=view;
      remember();await bases(view);
    }));
    panel.querySelector('[data-view-action=delete]').addEventListener('click',run(async()=>{
      if(field('view').value==='')return;
      config().bases.splice(Number(field('view').value),1);remember();await bases();
    }));
    output.addEventListener('click',run(async event=>{
      const button=event.target.closest('button');
      if(button?.dataset.openNote){overlay.close();await open(button.dataset.openNote);}
      if(button?.dataset.editNote){const options=state();await editProperty(button.dataset.editNote,options.property);await bases(options);}
    }));
    draw();
  }

  const split=$('#split-pane');
  const splitSelect=split.querySelector('select');
  const splitMode=split.querySelector('[data-split-mode]');
  const splitSource=split.querySelector('textarea');
  const splitRead=split.querySelector('article');
  const splitDivider=$('#split-divider');
  let target, targetHeading, revision=0;
  const splitScroll = new Map();
  function captureSplit() {
    if(!target)return;
    splitScroll.set(target.id,{reading:splitRead.scrollTop,source:splitSource.scrollTop});
  }
  function closeSplit(){captureSplit();split.hidden=true;splitDivider.hidden=true;target=targetHeading=undefined;revision++;}
  async function renderSplit(){
    if (!target || split.hidden) return;
    const serial=++revision;
    const text=target.text;
    const scroll=splitScroll.get(target.id);
    const editing=splitMode.value==='source';
    splitSource.hidden=!editing;
    splitRead.hidden=editing;
    splitSource.readOnly=target===active();
    split.querySelector('[data-split-save]').disabled=target===active();
    split.querySelector('[data-split-status]').textContent=editing&&splitSource.readOnly?'请在左侧编辑当前笔记':'';
    if(editing) {
      if(splitSource.value!==text)splitSource.value=text;
      if(scroll)splitSource.scrollTop=scroll.source;
      return;
    }
    const content=document.createElement('div');
    await render(content,text,target.path);
    if(serial!==revision)return;
    splitRead.replaceChildren(content);
    if(scroll)splitRead.scrollTop=scroll.reading;
    if(targetHeading) {
      const heading=[...content.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .find(node=>headingMatches(node.textContent,targetHeading));
      if(heading)splitRead.scrollTop+=heading.getBoundingClientRect().top-splitRead.getBoundingClientRect().top;
      targetHeading=undefined;
    }
    await diagrams(content);
  }
  function refreshSplit(){
    if(split.hidden)return;
    if(!tabs().includes(target))return closeSplit();
    captureSplit();
    splitSelect.replaceChildren(...tabs().map(tab=>new Option(tab.name,tab.id,false,tab===target)));
    run(renderSplit)();
  }
  function openSplit(tab=active(),{heading,reading}={}){
    if(!tab)throw Error('请先打开笔记。');
    captureSplit();
    target=tab;targetHeading=heading;split.hidden=false;splitDivider.hidden=false;
    if(reading!==undefined)splitMode.value=reading?'read':'source';
    splitSelect.replaceChildren(...tabs().map(note=>new Option(note.name,note.id,false,note===target)));
    run(renderSplit)();
  }
  splitSelect.addEventListener('change',()=>openSplit(tabs().find(tab=>tab.id===splitSelect.value)));
  splitMode.addEventListener('change',()=>{captureSplit();run(renderSplit)();});
  splitSource.addEventListener('input',()=>{if(target&&target!==active())changeTab(target,splitSource.value);});
  splitSource.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&target!==active()){
      event.preventDefault();event.stopPropagation();run(()=>saveTab(target))();
    }
  });
  split.querySelector('[data-split-close]').addEventListener('click',closeSplit);
  split.querySelector('[data-split-save]').addEventListener('click',run(()=>saveTab(target)));
  splitDivider.addEventListener('pointerdown',event=>{
    splitDivider.setPointerCapture(event.pointerId);
    const start=event.clientX, width=split.getBoundingClientRect().width;
    const resize=move=>{split.style.flexBasis=Math.max(210,Math.min(innerWidth*.6,width+start-move.clientX))+'px';};
    splitDivider.addEventListener('pointermove',resize);
    splitDivider.addEventListener('lostpointercapture',()=>splitDivider.removeEventListener('pointermove',resize),{once:true});
  });

  return {addBookmark,bookmarkHeading,bookmarks,graph,bases,openSplit,refreshSplit,closeSplit,
    focusedTab:()=>document.activeElement===splitSource&&!splitSource.readOnly?target:null,
    beforeQuit:()=>overlay.confirmClose?.()??true,
    canvas:createCanvasView({platform,dialog,ask,escape,root,files,relative,open,toast,fail})};
}
