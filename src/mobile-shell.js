import {activeMobileDialog,showDialog} from './mobile-ui.js';

const syntax=[
  ['heading','# 标题'],['bold','**粗体**'],['todo','- [ ] 待办'],['wiki','[[双链]]'],
  ['math','$公式$'],['code','\u0060代码\u0060'],['table','表格'],['indent','缩进'],['outdent','反缩进'],
  ['undo','撤销'],['redo','重做'],['paste','粘贴'],['image','插入图片'],['dismiss','收起键盘']
];

export function createMobileShell({native,icon,glyphs,run,tabs,active,workspace,mode,editMode,activate,keyboard,changed,hint,fail}) {
  const selector=document.querySelector.bind(document);
  const root=document.documentElement,media=matchMedia('(max-width: 768px)');
  const nav=document.createElement('nav');
  nav.className='mobile-nav';nav.setAttribute('aria-label','手机端导航');
  nav.innerHTML=
    '<button type="button" data-mobile-drawer="left" aria-controls="left-sidebar" aria-expanded="false" aria-label="打开文件抽屉">'+icon('panel-left')+'</button>'+
    '<div class="mobile-document"><button type="button" class="mobile-title" aria-label="打开与最近笔记" aria-haspopup="dialog"></button>'+
    '<button type="button" data-mobile-sync aria-haspopup="dialog" aria-label="打开同步状态"><span class="mobile-sync-dot"></span><small>仅本地</small></button></div>'+
    '<div class="mobile-document-actions"><button type="button" data-mobile-mode></button>'+
    '<button type="button" data-mobile-more aria-haspopup="dialog" aria-label="更多文档操作">'+icon('ellipsis')+'</button></div>';
  const sidebar=selector('.sidebar');
  const sideTop=document.createElement('div');
  sideTop.className='mobile-side-top';
  sideTop.innerHTML=
    '<div class="mobile-side-header"><button type="button" class="mobile-vault-trigger" data-action="folder"'+
    (native?' aria-haspopup="dialog"':'')+'><span class="mobile-sync-dot"></span><strong></strong>'+icon('chevron-down')+'</button>'+
    '<button type="button" data-action="settings" aria-label="设置中心">'+icon('settings')+'</button></div>'+
    '<nav class="mobile-side-tabs" aria-label="知识库导航">'+
    [['files','文件','folder-closed'],['search','搜索','search'],['tags','标签','tags'],['graph','图谱','network']]
      .map(([id,label,glyph])=>'<button type="button" '+(id==='graph'?'data-mobile-graph aria-haspopup="dialog"':'data-pane="'+id+'"')+
        '>'+icon(glyph)+'<span>'+label+'</span></button>').join('')+'</nav>';
  const fileActions=document.createElement('div');
  fileActions.className='mobile-file-actions';
  fileActions.innerHTML='<button type="button" class="mobile-primary" data-action="mobile-new-note">'+icon('plus')+'新建笔记</button>'+
    '<button type="button" data-action="mobile-new-folder" aria-label="新建文件夹" title="新建文件夹">'+icon('folder-plus')+'</button>';
  const drawers=document.createElement('div');
  drawers.id='mobile-drawers';drawers.hidden=true;
  const overlay=document.createElement('button');
  overlay.type='button';overlay.className='mobile-shade';overlay.setAttribute('aria-label','关闭抽屉');
  drawers.append(overlay);
  const positions=['.sidebar','.outline-panel'].map(name=>{
    const node=selector(name),anchor=document.createComment(name);
    node.before(anchor);
    return {node,anchor};
  });
  const sheet=document.createElement('dialog');
  sheet.className='feature-dialog mobile-sheet';
  sheet.setAttribute('aria-labelledby','mobile-sheet-title');
  const toolbar=document.createElement('div');
  toolbar.className='mobile-keyboard';toolbar.hidden=true;
  toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','Markdown 快捷键');
  toolbar.innerHTML=syntax.map(([id,label])=>'<button type="button" data-key="'+id+'">'+label+'</button>').join('');
  document.body.append(drawers,sheet,toolbar);
  let enabled=false,drawer='',gesture,longPress,suppressed,peak=innerHeight;
  let updateSyncCard,returnPage;
  const pages=[];
  const state=()=>Boolean(enabled);
  function update() {
    nav.querySelector('.mobile-title').textContent=active()?.name||'Calcite';
    const {name,available}=workspace();
    sideTop.querySelector('.mobile-vault-trigger strong').textContent=name;
    fileActions.querySelector('[data-action="mobile-new-folder"]').disabled=!available;
    sideTop.querySelector('[data-mobile-graph]').disabled=!available;
    const toggle=nav.querySelector('[data-mobile-mode]');
    toggle.disabled=!active();
    toggle.textContent=mode()==='read'?'编辑':'阅读';
    toggle.setAttribute('aria-label',mode()==='read'?'切换到编辑':'切换到阅读');
  }
  function viewport() {
    const vv=window.visualViewport;
    const editing=!!document.activeElement?.closest('#source-editor,#live-editor');
    const keyboardOpen=enabled&&vv&&innerHeight-vv.height>100;
    if(keyboardOpen)root.style.setProperty('--lg-available-height',vv.height+'px');
    else root.style.removeProperty('--lg-available-height');
    if(!editing)peak=Math.max(innerHeight,vv?.height||0);
    const keyboardBottom=Math.max(0,innerHeight-(vv?.height||innerHeight)-(vv?.offsetTop||0));
    toolbar.hidden=!enabled||!editing||mode()==='read'||peak-(vv?.height||innerHeight)<100;
    toolbar.style.bottom=keyboardBottom+'px';
    root.classList.toggle('soft-keyboard',!toolbar.hidden);
  }
  function closeDrawer() {
    if(drawer) {
      nav.querySelector('[data-mobile-drawer]').setAttribute('aria-expanded','false');
      if(drawers.contains(document.activeElement))nav.querySelector('[data-mobile-drawer]').focus({preventScroll:true});
    }
    drawer='';delete drawers.dataset.open;
    overlay.inert=true;
    positions.forEach(({node})=>{node.inert=enabled;});
  }
  function openDrawer(side) {
    if(!enabled||activeMobileDialog()&&activeMobileDialog()!==sheet)return;
    if(drawer===side){closeDrawer();return;}
    if(sheet.open)sheet.close();
    drawer=side;drawers.dataset.open=side;overlay.inert=false;
    positions.forEach(({node},index)=>{node.inert=(index===0?'left':'right')!==side;});
    nav.querySelector('[data-mobile-drawer]').setAttribute('aria-expanded',String(side==='left'));
    const panel=positions[side==='left'?0:1].node;
    panel.querySelector(side==='left'?'.mobile-vault-trigger':'#outline-tab').focus({preventScroll:true});
  }
  function apply() {
    const next=native||media.matches;
    if(enabled===next){update();return;}
    enabled=next;
    if(next){
      root.dataset.platform='mobile';
      selector('.titlebar').append(nav);
      sidebar.prepend(sideTop);
      sidebar.append(fileActions);
      glyphs();
    }else{
      delete root.dataset.platform;
      nav.remove();sideTop.remove();fileActions.remove();
    }
    drawers.hidden=!next;
    for(const {node,anchor} of positions) {
      if(next)drawers.append(node);
      else anchor.after(node);
    }
    if(!next&&sheet.open)sheet.close();
    closeDrawer();update();viewport();changed(next);
  }
  function panel(label,kind,render,back) {
    if(!enabled)return;
    closeDrawer();
    updateSyncCard=undefined;
    returnPage=back;
    sheet.dataset.kind=kind;
    sheet.innerHTML='<header><button type="button" data-sheet-back aria-label="返回"'+(back?'':' hidden')+'>'+icon('chevron-left')+'<span>返回</span></button>'+
      '<h2 id="mobile-sheet-title"></h2><button type="button" data-sheet-close aria-label="关闭操作表单">'+icon('x')+'</button></header><div class="mobile-sheet-content"></div>';
    sheet.querySelector('h2').textContent=label;
    sheet.querySelector('[data-sheet-close]').onclick=()=>sheet.close();
    sheet.querySelector('[data-sheet-back]').onclick=back;
    render(sheet.querySelector('.mobile-sheet-content'),()=>sheet.close());
    glyphs();
    if(!sheet.open)showDialog(sheet);
    else sheet.querySelector(back?'[data-sheet-back]':'[data-sheet-close]').focus({preventScroll:true});
  }
  function show(label,groups) {
    pages.splice(0,pages.length,{label,groups});
    renderPage();
  }
  function goBack() {
    if(pages.length<=1||sheet.dataset.kind!=='actions')return false;
    pages.pop();
    renderPage();
    return true;
  }
  function renderPage() {
    const {label,groups}=pages.at(-1);
    panel(label,'actions',(content,close)=>{
      for(const group of groups) {
        if(!group.items.length)continue;
        const region=document.createElement('section');
        region.className='lg-menu-group';
        if(group.style)region.dataset.layout=group.style;
        if(group.label)region.setAttribute('aria-label',group.label);
        for(const item of group.items) {
          const button=document.createElement('button'),text=document.createElement('span');
          button.type='button';button.disabled=!!item.disabled;
          if(item.id)button.dataset.mobileCommand=item.id;
          text.textContent=item.label;
          button.innerHTML=icon(item.icon||'file-text');
          button.append(text);
          if(group.style!=='tiles'&&(item.items||group.style==='rows'))button.insertAdjacentHTML('beforeend',icon('chevron-right'));
          button.onclick=()=>{
            if(item.items){
              pages.push({label:item.label,groups:[{items:item.items,style:'rows'}]});
              renderPage();
            }else{
              close();
              Promise.resolve().then(item.run).catch(fail);
            }
          };
          if(item.danger)button.classList.add('menu-danger');
          region.append(button);
        }
        content.append(region);
      }
    },pages.length>1?goBack:null);
  }
  function showSync(value,{runSync,settings,conflicts}) {
    let running=false;
    panel('同步状态','sync',(content,close)=>{
      content.innerHTML='<p class="mobile-sync-summary" role="status"></p><dl>'+
        '<div><dt>最后同步</dt><dd data-last-sync></dd></div><div><dt>待同步版本</dt><dd data-pending></dd></div></dl>'+
        '<progress aria-label="同步进度" hidden></progress><p class="mobile-sync-feedback" role="alert" hidden></p><div class="mobile-card-actions">'+
        '<button type="button" class="mobile-primary">立即同步</button><button type="button" data-sync-settings>同步设置</button>'+
        '</div><button type="button" data-mobile-conflicts hidden>查看同步冲突</button>';
      const button=content.querySelector('.mobile-primary');
      const feedback=content.querySelector('.mobile-sync-feedback');
      const conflictButton=content.querySelector('[data-mobile-conflicts]');
      updateSyncCard=next=>{
        value=next;
        content.querySelector('[role="status"]').textContent=next.detail||next.label;
        content.querySelector('[data-last-sync]').textContent=next.lastSyncedAt?
          new Date(next.lastSyncedAt).toLocaleString():'暂无记录';
        content.querySelector('[data-pending]').textContent=next.connected?String(next.pendingCount??0):'0';
        const meter=content.querySelector('progress');
        meter.hidden=next.status!=='working';
        if(next.progress?.total){
          meter.max=next.progress.total;
          meter.value=next.progress.done||0;
        }else meter.removeAttribute('value');
        button.disabled=running||!next.connected||next.status==='working';
        conflictButton.hidden=!next.conflicts?.length;
      };
      updateSyncCard(value);
      button.onclick=async()=>{
        running=true;feedback.hidden=true;updateSyncCard(value);
        try{await runSync();}
        catch(error){feedback.textContent=error.message;feedback.hidden=false;}
        finally{
          running=false;
          if(content.isConnected&&sheet.open)updateSyncCard?.(value);
        }
      };
      content.querySelector('[data-sync-settings]').onclick=()=>{close();settings();};
      conflictButton.onclick=()=>{close();conflicts();};
    });
  }
  function showRecent() {
    const list=tabs().slice().reverse();
    show('打开与最近笔记',[{items:[
      {label:'新建笔记',run:()=>run('new')},
      ...list.map(tab=>({label:tab.name,run:()=>activate(tab.id)}))
    ]}]);
    const rows=[...sheet.querySelectorAll('.mobile-sheet-content button')].slice(1);
    rows.forEach((node,index)=>{node.dataset.mobileTab=list[index].id;});
  }
  function context(target,x,y) {
    const tab=target.closest('[data-mobile-tab]')?.dataset.mobileTab;
    if(tab) {
      const original=[...document.querySelectorAll('#tabs [data-tab]')].find(node=>node.dataset.tab===tab);
      target=original||target;
    }
    target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y}));
  }
  function cancelLongPress() {clearTimeout(longPress?.timer);longPress=undefined;}
  document.addEventListener('touchstart',event=>{
    if(!enabled||drawer||activeMobileDialog()||event.touches.length!==1)return;
    if(event.target.closest('.table-wrap,.milkdown-table-block,pre,.mermaid'))return;
    const {clientX:x,clientY:y,identifier:id}=event.touches[0];
    if(x<=22||x>=innerWidth-22)gesture={x,y,id};
  },{capture:true,passive:true});
  document.addEventListener('touchmove',event=>{
    if(!gesture)return;
    const point=[...event.changedTouches].find(point=>point.identifier===gesture.id);
    if(!point)return;
    const dx=point.clientX-gesture.x,dy=point.clientY-gesture.y;
    if(Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.4) {
      if(event.cancelable)event.preventDefault();
    } else if(Math.abs(dy)>18)gesture=undefined;
  },{capture:true,passive:false});
  document.addEventListener('touchend',event=>{
    if(!gesture)return;
    const point=[...event.changedTouches].find(point=>point.identifier===gesture.id);
    if(!point)return;
    const dx=point.clientX-gesture.x,dy=point.clientY-gesture.y;
    if(Math.abs(dx)>54&&Math.abs(dx)>Math.abs(dy)*1.4) {
      if(event.cancelable)event.preventDefault();
      if(gesture.x<=22&&dx>0)openDrawer('left');
      else if(gesture.x>=innerWidth-22&&dx<0)openDrawer('right');
    }
    gesture=undefined;
  },{capture:true,passive:false});
  document.addEventListener('touchcancel',()=>{gesture=undefined;},{capture:true,passive:true});
  document.addEventListener('pointerdown',event=>{
    if(!enabled||event.pointerType==='mouse')return;
    const {clientX:x,clientY:y,pointerId:id}=event;
    const target=event.target.closest('[data-file],[data-folder],.outline-row,[data-mobile-tab],[data-action="mobile-new-folder"]');
    if(!target||!event.isPrimary)return;
    cancelLongPress();
    longPress={x,y,id,timer:setTimeout(()=>{
      suppressed={target,x,y,until:performance.now()+900};
      longPress=undefined;
      if(target.dataset.action==='mobile-new-folder')hint(target.title);
      else context(target,x,y);
    },450)};
  },true);
  document.addEventListener('pointermove',event=>{
    if(longPress?.id===event.pointerId&&Math.hypot(event.clientX-longPress.x,event.clientY-longPress.y)>9)cancelLongPress();
  },true);
  for(const type of ['pointerup','pointercancel'])document.addEventListener(type,event=>{
    if(longPress?.id===event.pointerId)cancelLongPress();
  },true);
  document.addEventListener('contextmenu',event=>{
    if(enabled&&event.target.closest('[data-mobile-tab]')){
      event.preventDefault();context(event.target,event.clientX,event.clientY);
    }
  });
  document.addEventListener('click',event=>{
    if(!enabled)return;
    if(suppressed&&performance.now()<suppressed.until&&
      (suppressed.target.contains(event.target)||Math.hypot(event.clientX-suppressed.x,event.clientY-suppressed.y)<18)){
      event.preventDefault();event.stopImmediatePropagation();suppressed=undefined;return;
    }
    if(drawers.contains(event.target)&&event.target.closest('[data-file],[data-heading]'))closeDrawer();
  },true);
  nav.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button)return;
    const side=button.dataset.mobileDrawer;
    if(side)openDrawer(side);
    else if(button.hasAttribute('data-mobile-sync'))Promise.resolve(run('mobile-sync')).catch(fail);
    else if(button.hasAttribute('data-mobile-mode'))Promise.resolve(run(mode()==='read'?editMode():'read')).catch(fail);
    else if(button.hasAttribute('data-mobile-more'))Promise.resolve(run('more')).catch(fail);
    else if(button.classList.contains('mobile-title'))showRecent();
  });
  sideTop.querySelector('[data-mobile-graph]').onclick=()=>{
    Promise.resolve(run('graph')).catch(fail);
  };
  overlay.onclick=closeDrawer;
  sheet.addEventListener('click',event=>{if(event.target===sheet)sheet.close();});
  sheet.addEventListener('cancel',event=>{
    if(returnPage){event.preventDefault();returnPage();}
  });
  sheet.addEventListener('close',()=>{if(!sheet.open)updateSyncCard=undefined;});
  toolbar.addEventListener('pointerdown',event=>event.preventDefault());
  toolbar.addEventListener('click',event=>{
    const key=event.target.closest('[data-key]')?.dataset.key;
    if(key)Promise.resolve(keyboard(key)).catch(fail);
  });
  window.visualViewport?.addEventListener('resize',viewport);
  window.visualViewport?.addEventListener('scroll',viewport);
  document.addEventListener('focusin',viewport);
  document.addEventListener('focusout',()=>requestAnimationFrame(viewport));
  media.addEventListener('change',apply);
  apply();
  return {state,show,panel,showSync,showRecent,update,openDrawer,closeDrawer,viewport,back(){
    if(sheet.open){if(returnPage)returnPage();else sheet.close();return true;}
    if(drawer){closeDrawer();return true;}
    return false;
  },sync(value){
    const button=nav.querySelector('[data-mobile-sync]');
    for(const dot of [button.querySelector('span'),sideTop.querySelector('.mobile-sync-dot')])dot.dataset.state=value.status;
    button.querySelector('small').textContent=value.label;
    button.title=value.label;
    button.setAttribute('aria-label','打开同步状态');
    const activeStatus=sheet.querySelector('[data-current] [data-vault-status]');
    if(activeStatus)activeStatus.textContent=value.summaryLabel;
    updateSyncCard?.(value);
  }};
}
