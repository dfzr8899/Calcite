import {getLocale, t as tr} from "../shared/i18n/index.mjs";
import {isMobileUI,showDialog,settingToggle} from './mobile-ui.js';
import { createIcons, Search, X, Minus, Plus, Scan, SlidersHorizontal, Layers, ChevronDown } from 'lucide';
import { createGraphCanvas } from './graph-canvas.js';
import GraphWorker from './graph-layout.worker.js?worker&inline';
import './graph.css';

const icons={Search,X,Minus,Plus,Scan,SlidersHorizontal,Layers,ChevronDown};
const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
const control=(name,label,symbol)=>`<button type="button" data-graph="${name}" aria-label="${label}" title="${label}">${icon(symbol)}</button>`;

function graphModel(data,selected,relative,caseInsensitive) {
  const key=path=>caseInsensitive?path.replaceAll('\\','/').toLowerCase():path;
  const paths=new Map();
  const groups=new Map();
  const entries=data.nodes.map(path=>{
    const file=relative(path).replaceAll('\\','/');
    return {path,file,parts:file.split('/')};
  });
  const nested=entries.filter(({parts})=>parts.length>1);
  let layer=0;
  while (nested.length&&nested.every(({parts})=>parts.length>layer+1&&parts[layer]===nested[0].parts[layer])) layer++;
  if (!nested.some(({parts})=>parts.length>layer+1)) layer=0;
  for (const {path,file,parts} of entries) {
    const directory=parts.length>layer+1?parts[layer]:'';
    if (!groups.has(directory)) groups.set(directory,{name:directory||tr("graphView.root"),id:groups.size,count:0,color:5});
    const group=groups.get(directory);
    group.count++;
    paths.set(key(path),{path,file,group,id:paths.size,degree:0,opacity:1,neighbors:new Set(),
      name:parts.at(-1).replace(/\.(?:md|markdown|mdown)$/i,'')});
  }
  const namedGroups=[...groups].filter(([name])=>name).sort(([a],[b])=>a.localeCompare(b,getLocale(),{numeric:true}));
  namedGroups.forEach(([,group],index)=>{group.color=index%6;});
  const nodes=[...paths.values()];
  const current=selected?paths.get(key(selected)):undefined;
  const edges=[];
  for (const {from,to} of data.edges) {
    const source=paths.get(key(from)),target=paths.get(key(to));
    if (!source || !target || source===target) continue;
    source.degree++;
    target.degree++;
    if (source.neighbors.has(target.id)) continue;
    source.neighbors.add(target.id);
    target.neighbors.add(source.id);
    edges.push({source,target,accent:0});
  }
  const top=[...nodes].sort((a,b)=>b.degree-a.degree).slice(0,Math.ceil(nodes.length*.15));
  const hubs=new Set(top.filter(node=>node.degree));
  const maxDegree=top[0]?.degree||1;
  for (const node of nodes) {
    node.color=node.group.color;
    node.hub=hubs.has(node)||/^(?:index|readme|索引|目录)$|^00[-_\s]/i.test(node.name);
    node.radius=4+9*(node.degree/maxDegree)**1.75;
  }
  return {nodes,edges,current,groups:[...namedGroups.map(([,group])=>group),...(groups.has('')?[groups.get('')]:[])]};
}

function neighborhood(nodes,current,hops,skipHubs) {
  const visited=new Set([current.id]);
  const hubLimit=Math.max(12,Math.ceil(Math.sqrt(nodes.length)));
  let frontier=[current.id];
  for (let i=0;i<hops && frontier.length;i++) {
    const next=[];
    for (const id of frontier) {
      if (skipHubs&&id!==current.id&&nodes[id].neighbors.size>=hubLimit) continue;
      for (const neighbor of nodes[id].neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier=next;
  }
  return visited;
}

export function showGraph(data,{selected,relative,caseInsensitive,local:initialLocal,open,fail}) {
  const mobile=isMobileUI();
  const model=graphModel(data,selected,relative,caseInsensitive);
  const {nodes,edges,current,groups}=model;
  const panel=document.createElement('dialog');
  panel.className='graph-dialog';
  panel.setAttribute('aria-label',tr("graphView.noteGraph"));
  panel.innerHTML=`
    <canvas class="graph-board" tabindex="0" ${mobile?'autofocus':''} aria-label="${tr("graphView.noteGraphUseArrowKeysToSelect")}"></canvas>
    <div class="graph-top">
      <div class="graph-top-row">
        <label class="graph-glass graph-search">${icon('search')}<input type="search" aria-label="${tr("graphView.filterGraph")}" placeholder="${tr("graphView.filterNotes")}" ${mobile?'':'autofocus'} spellcheck="false"></label>
        <output class="graph-glass graph-count" aria-live="polite"></output>
      </div>
      <div class="graph-top-row">
        <div class="graph-glass graph-segments" role="group" aria-label="${tr("graphView.graphScope")}">
          <button type="button" data-graph="global" aria-pressed="true">${tr("graphView.allNotes")}</button>
          <button type="button" data-graph="local" aria-pressed="false">${tr("graphView.local")}</button>
        </div>
        <div class="graph-glass graph-segments graph-hops" role="group" aria-label="${tr("graphView.localGraphDepth")}" hidden>
          <button type="button" data-hops="1" aria-pressed="true">${tr("graphView.1Hop")}</button>
          <button type="button" data-hops="2" aria-pressed="false">${tr("graphView.2Hops")}</button>
        </div>
      </div>
    </div>
    <form method="dialog" class="graph-close graph-glass">${control('close',tr("graphView.closeGraph"),'x')}</form>
    <div class="graph-message" hidden></div>
    <details class="graph-legend graph-glass">
      <summary>${icon('layers')}${tr("graphView.folderGroups")}${icon('chevron-down')}</summary>
      <div class="graph-legend-list" aria-label="${tr("graphView.highlightByFolder")}" data-graph-popover></div>
    </details>
    <div class="graph-glass graph-navigation" role="group" aria-label="${tr("graphView.graphControls")}">
      ${control('out',tr("main.zoomOut"),'minus')}${control('in',tr("main.zoomIn"),'plus')}${control('fit',tr("graphView.fitToView"),'scan')}
      <details class="graph-settings">
        <summary aria-label="${tr("graphView.displayOptions")}" title="${tr("graphView.displayOptions")}">${icon('sliders-horizontal')}</summary>
        <div class="graph-glass graph-settings-panel" data-graph-popover>
          <span>${tr("graphView.nodeRepulsion")}</span>
          <div class="graph-segments" role="group" aria-label="${tr("graphView.nodeRepulsion")}">
            <button type="button" data-repulsion="0.65" aria-pressed="false">${tr("graphView.compact")}</button>
            <button type="button" data-repulsion="1" aria-pressed="true">${tr("graphView.standard")}</button>
            <button type="button" data-repulsion="1.55" aria-pressed="false">${tr("graphView.spacious")}</button>
          </div>
          ${settingToggle('isolates',tr("graphView.showIsolatedNodes"),{checked:true})}
          ${settingToggle('skipHubs',tr("graphView.ignoreHighlyConnectedHubsInLocalGraph"),{checked:true})}
        </div>
      </details>
    </div>
    <span class="graph-a11y graph-selection" role="status"></span>`;

  const $=selector=>panel.querySelector(selector);
  const search=$('input[type="search"]');
  const localButton=$('[data-graph="local"]');
  const legend=$('.graph-legend-list');
  const settingsPanel=$('.graph-settings-panel');
  const canvas=$('canvas');
  const isolatesInput=$('[name=isolates]');
  const skipHubs=$('[name=skipHubs]');
  const close=$('[data-graph="close"]');
  close.type='submit';
  localButton.disabled=!current;
  if (!current) localButton.title=tr("graphView.openANoteInTheWorkspaceFirst");
  let local=Boolean(initialLocal&&current),hops=1,groupFilter,worker,ready=false;
  let shown=[],matching=[];

  for (const group of groups) {
    const button=document.createElement('button');
    button.type='button';
    button.dataset.group=String(group.id);
    button.setAttribute('aria-pressed','false');
    const swatch=document.createElement('span');
    swatch.className='graph-swatch';
    swatch.style.setProperty('--swatch',`var(--graph-cluster-${group.color})`);
    const name=document.createElement('span');
    name.textContent=group.name;
    const count=document.createElement('span');
    count.className='graph-group-count';
    count.textContent=group.count;
    button.append(swatch,name,count);
    legend.append(button);
  }
  $('.graph-legend').hidden=!groups.length;
  document.body.append(panel);
  createIcons({icons,attrs:{'stroke-width':1.65}});
  showDialog(panel);

  function openNode(node) {
    panel.close();
    Promise.resolve().then(()=>open(node.path)).catch(fail);
  }

  const renderer=createGraphCanvas(canvas,{current,onOpen:openNode,
    onFocus:node=>{$('.graph-selection').textContent=node?node.file:'';},
    occlusions:()=>[$('.graph-top'),$('.graph-close'),$('.graph-legend'),$('.graph-navigation'),legend,settingsPanel]});

  function status() {
    const query=search.value.trim().toLocaleLowerCase();
    const filtered=Boolean(query||groupFilter!==undefined);
    matching=filtered ? shown.filter(node=>(groupFilter===undefined||node.group.id===groupFilter)
      && (!query||node.file.toLocaleLowerCase().includes(query))) : shown;
    renderer.setMatches(filtered?new Set(matching.map(node=>node.id)):null);
    $('.graph-count').textContent=filtered?tr("graphView.notes",{arg1:matching.length,arg2:shown.length}):tr("graphView.notes2",{arg1:shown.length});
    const message=$('.graph-message');
    const text=!ready?tr("graphView.layingOut"):!nodes.length?tr("graphView.noNotesInThisWorkspace"):!shown.length?tr("graphView.noVisibleNodes"):!matching.length?tr("graphView.noMatchingNotes"):'';
    message.hidden=!text;
    message.textContent=text;
  }

  function scope() {
    $('[data-graph="global"]').setAttribute('aria-pressed',String(!local));
    localButton.setAttribute('aria-pressed',String(local));
    $('.graph-hops').hidden=!local;
    const reachable=local?neighborhood(nodes,current,hops,skipHubs.checked):null;
    const isolates=isolatesInput.checked;
    shown=nodes.filter(node=>(!reachable||reachable.has(node.id))&&(isolates||node.degree||(local&&node===current)));
    const ids=new Set(shown.map(node=>node.id));
    if (ready) renderer.setView(shown,edges.filter(({source,target})=>ids.has(source.id)&&ids.has(target.id)));
    renderer.resize();
    status();
  }

  function layout(repulsion) {
    worker?.terminate();
    if (!nodes.length) {ready=true;scope();return;}
    function draw(positions) {
      const aspect=Math.max(1,Math.min(1.55,canvas.clientWidth/Math.max(1,canvas.clientHeight)*.78));
      nodes.forEach((node,index)=>{
        const angle=index*2.3999632297,distance=Math.sqrt(index)*46;
        node.x=(positions?.[index*2]??Math.cos(angle)*distance)*aspect;
        node.y=positions?.[index*2+1]??Math.sin(angle)*distance;
      });
      worker?.terminate();
      worker=undefined;
      ready=true;
      scope();
    }
    try {
      const job=worker=new GraphWorker();
      job.onmessage=event=>{ if (worker===job) draw(event.data); };
      job.onerror=event=>{
        event.preventDefault();
        if (worker===job) draw();
      };
      job.postMessage({nodes:nodes.map(({group,radius})=>({group:group.id,radius})),
        edges:edges.map(({source,target})=>({source:source.id,target:target.id})),groups:groups.length,repulsion});
    } catch { draw(); }
  }

  panel.addEventListener('close',()=>{
    worker?.terminate();
    worker=undefined;
    renderer.destroy();
    panel.remove();
  },{once:true});
  panel.addEventListener('keydown',event=>{
    if (event.key!=='Escape'||event.isComposing) return;
    event.preventDefault();
    panel.close();
  });
  panel.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if (!button) return;
    const {graph,hops:depth,group,repulsion}=button.dataset;
    if (graph==='global'||graph==='local') {local=graph==='local';scope();}
    if (graph==='out'||graph==='in') renderer.zoom(graph==='in'?1.25:1/1.25);
    if (graph==='fit') renderer.fit();
    if (depth) {
      hops=Number(depth);
      for (const item of panel.querySelectorAll('[data-hops]')) item.setAttribute('aria-pressed',String(item===button));
      scope();
    }
    if (group!==undefined) {
      groupFilter=groupFilter===Number(group)?undefined:Number(group);
      for (const item of legend.children) item.setAttribute('aria-pressed',String(Number(item.dataset.group)===groupFilter));
      status();
    }
    if (repulsion) {
      for (const item of panel.querySelectorAll('[data-repulsion]')) item.setAttribute('aria-pressed',String(item===button));
      layout(Number(repulsion));
    }
  });
  search.addEventListener('input',status);
  search.addEventListener('keydown',event=>{
    if (event.key==='Enter' && !event.isComposing && search.value.trim() && matching[0]) {
      event.preventDefault();
      const query=search.value.trim().toLocaleLowerCase();
      openNode(matching.find(node=>node.name.toLocaleLowerCase()===query)||matching[0]);
    }
  });
  isolatesInput.addEventListener('change',scope);
  skipHubs.addEventListener('change',scope);
  for (const disclosure of panel.querySelectorAll('details')) disclosure.addEventListener('toggle',renderer.resize);
  scope();
  layout(1);
  return panel;
}
