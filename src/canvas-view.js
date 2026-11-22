import {randomId} from './random-id.js';

export function createCanvasView({platform,dialog,ask,escape,root,files,relative,open,toast,fail}) {
  return async function showCanvas() {
    const workspace=root();
    if(!workspace)throw Error('请先打开工作区。');
    const names=await platform.workspace.listCanvases();
    if(root()!==workspace)return;
    const panel=dialog('Canvas 画布',
      '<div class="workspace-view-tools"><label>画布 <select name="board"><option value="">新画布</option>'+
      names.map(name=>'<option value="'+escape(name)+'">'+escape(name)+'</option>').join('')+'</select></label>'+
      '<button data-canvas-action="save">保存</button><button data-canvas-action="text">文字卡片</button>'+
      '<button data-canvas-action="file">笔记卡片</button><button data-canvas-action="edit">编辑卡片</button>'+
      '<button data-canvas-action="connect">连接卡片</button><button data-canvas-action="delete">删除卡片</button>'+
      '<span class="canvas-status" role="status"></span></div>'+
      '<div class="canvas-scroll"><div class="canvas-space"><canvas aria-hidden="true"></canvas></div></div>');
    const boardSelect=panel.querySelector('[name=board]');
    const area=panel.querySelector('.canvas-space');
    const canvas=area.querySelector('canvas');
    const viewport=area.parentElement;
    const status=panel.querySelector('[role=status]');
    const connection=panel.querySelector('[data-canvas-action=connect]');
    const editor=panel.querySelector('.workspace-view-tools');
    let board={nodes:[],edges:[]}, name='', version, dirty=false, selected, from, busy=false, drag;
    let offset={x:0,y:0};
    const id=()=>randomId().replaceAll('-','').slice(0,16);
    const num=(value,fallback=0)=>typeof value==='number'&&Number.isFinite(value)?Math.max(-100000,Math.min(100000,value)):fallback;
    const box=node=>({x:num(node.x),y:num(node.y),w:Math.max(80,Math.min(1800,num(node.width,230))),h:Math.max(50,Math.min(1400,num(node.height,124)))});
    const nodeFor=id=>board.nodes.find(node=>node.id===id);
    const guard=callback=>async (...args)=>{
      if(busy)return;
      busy=true;
      try { if(root()!==workspace)throw Error('工作区已切换，请重新打开画布。');await callback(...args); }
      catch(error){fail(error);}
      finally{busy=false;}
    };
    function mark(){dirty=true;status.textContent='有未保存的修改';}
    async function save(){
      let filename=name;
      if(!name){
        const form=await ask('保存画布','<label>名称<input name="name" required autofocus></label>','保存');
        if(!form)return false;
        filename=String(form.get('name')).trim();
      }
      const result=await platform.workspace.saveCanvas({name:filename,board,version});
      name=result.name;version=result.version;dirty=false;
      if(![...boardSelect.options].some(option=>option.value===name))boardSelect.add(new Option(name,name));
      boardSelect.value=name;
      status.textContent='已保存';
      return true;
    }
    async function allowChange(){
      if(!dirty)return true;
      const form=await ask('画布有未保存的修改',
        '<label>处理方式<select name="action"><option value="save">保存画布</option><option value="discard">丢弃修改</option></select></label>','继续');
      if(!form)return false;
      return form.get('action')==='discard'||await save();
    }
    function anchor(bounds, side, end){
      if(side==='top')return [bounds.x+bounds.w/2,bounds.y];
      if(side==='bottom')return [bounds.x+bounds.w/2,bounds.y+bounds.h];
      if(side==='left'||(!side&&end))return [bounds.x,bounds.y+bounds.h/2];
      return [bounds.x+bounds.w,bounds.y+bounds.h/2];
    }
    function drawEdges(){
      const ctx=canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      const styles=getComputedStyle(panel);
      const accent=styles.getPropertyValue('--accent');
      ctx.strokeStyle=accent;
      ctx.fillStyle=accent;
      ctx.lineWidth=1.5;
      ctx.font='12px Segoe UI, Microsoft YaHei, sans-serif';
      for(const edge of board.edges){
        const left=nodeFor(edge.fromNode),right=nodeFor(edge.toNode);
        if(!left||!right)continue;
        const [x,y]=anchor(box(left),edge.fromSide,false);
        const [a,b]=anchor(box(right),edge.toSide,true);
        const x0=(x+offset.x)*canvas.width/area.clientWidth,y0=(y+offset.y)*canvas.height/area.clientHeight;
        const x1=(a+offset.x)*canvas.width/area.clientWidth,y1=(b+offset.y)*canvas.height/area.clientHeight;
        const angle=Math.atan2(y1-y0,x1-x0);
        ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x1,y1);
        ctx.lineTo(x1-8*Math.cos(angle-.4),y1-8*Math.sin(angle-.4));
        ctx.lineTo(x1-8*Math.cos(angle+.4),y1-8*Math.sin(angle+.4));ctx.closePath();ctx.fill();
        if(edge.label)ctx.fillText(String(edge.label),(x0+x1)/2+4,(y0+y1)/2-5);
      }
    }
    function position(element,node){
      const {x,y,w,h}=box(node);
      Object.assign(element.style,{left:x+offset.x+'px',top:y+offset.y+'px',width:w+'px',height:h+'px'});
    }
    function paint(){
      const boxes=board.nodes.map(box);
      offset={x:Math.max(30,...boxes.map(box=>30-box.x)),y:Math.max(30,...boxes.map(box=>30-box.y))};
      const width=Math.max(viewport.clientWidth,900,...boxes.map(box=>box.x+box.w+offset.x+100));
      const height=Math.max(viewport.clientHeight,570,...boxes.map(box=>box.y+box.h+offset.y+100));
      area.style.width=width+'px';area.style.height=height+'px';
      canvas.width=Math.min(4096,width);canvas.height=Math.min(4096,height);
      area.querySelectorAll('[data-card]').forEach(element=>element.remove());
      for(const node of board.nodes){
        const element=document.createElement('button');
        element.type='button';
        element.className='canvas-card';
        element.classList.toggle('selected',node.id===selected);
        element.classList.toggle('canvas-group',node.type==='group');
        element.dataset.card=node.id;
        const title=document.createElement('strong');
        title.textContent=node.type==='file'?String(node.file||'笔记'):node.type==='group'?String(node.label||'分组'):node.type==='link'?'网页':'文字卡片';
        const body=document.createElement('span');
        body.textContent=String(node.text||node.url||node.subpath||'');
        element.append(title,body);
        position(element,node);
        area.append(element);
      }
      connection.textContent=from?'选择连接终点':'连接卡片';
      drawEdges();
    }
    boardSelect.addEventListener('change',guard(async()=>{
      const next=boardSelect.value;
      if(!await allowChange()){boardSelect.value=version?name:'';return;}
      let loaded={nodes:[],edges:[]};
      let nextVersion;
      if(next){
        const result=await platform.workspace.readCanvas(next);
        loaded=JSON.parse(result.text);
        if(!Array.isArray(loaded.nodes)||!Array.isArray(loaded.edges)||loaded.nodes.length>1200||
          loaded.nodes.some(node=>!node||typeof node.id!=='string')||loaded.edges.some(edge=>!edge||typeof edge.id!=='string')) throw Error('画布格式不正确或卡片过多。');
        nextVersion=result.version;
      }
      board=loaded;name=next;version=nextVersion;dirty=false;selected=from=undefined;
      boardSelect.value=next;status.textContent='';paint();
    }));
    async function editCard(node){
      if(node.type==='file'){
        const options=files().map(file=>'<option value="'+escape(relative(file.path))+'" '+(relative(file.path)===node.file?'selected':'')+'>'+escape(relative(file.path))+'</option>');
        if(!options.length)throw Error('工作区中还没有 Markdown 笔记。');
        const form=await ask('笔记卡片','<label>笔记<select name="file" required>'+options.join('')+'</select></label>','确定');
        if(!form)return false;
        node.file=String(form.get('file'));
      } else {
        const field=node.type==='group'?'label':node.type==='link'?'url':'text';
        const form=await ask('编辑卡片','<label>内容<textarea rows="6" name="value" autofocus>'+escape(node[field]||'')+'</textarea></label>','确定');
        if(!form)return false;
        node[field]=String(form.get('value'));
      }
      return true;
    }
    editor.addEventListener('click',guard(async event=>{
      const action=event.target.closest('[data-canvas-action]')?.dataset.canvasAction;
      if(!action)return;
      if(action==='save'){await save();return;}
      if(action==='text'||action==='file'){
        const index=board.nodes.length;
        const node={id:id(),type:action,x:viewport.scrollLeft+70-offset.x+(index%3)*255,
          y:viewport.scrollTop+65-offset.y+(Math.floor(index/3)%4)*148,width:235,height:128};
        if(!await editCard(node))return;
        board.nodes.push(node);selected=node.id;
      } else {
        const node=nodeFor(selected);
        if(!node){toast('请先选择一张卡片');return;}
        if(action==='edit'&&!await editCard(node))return;
        if(action==='connect'){from=from?undefined:selected;paint();return;}
        if(action==='delete'){
          board.nodes=board.nodes.filter(card=>card!==node);
          board.edges=board.edges.filter(edge=>edge.fromNode!==node.id&&edge.toNode!==node.id);
          selected=from=undefined;
        }
      }
      mark();paint();
    }));
    area.addEventListener('click',event=>{
      const card=event.target.closest('[data-card]');
      if(!card)return;
      selected=card.dataset.card;
      if(from&&from!==selected){
        if(!board.edges.some(edge=>edge.fromNode===from&&edge.toNode===selected))
          board.edges.push({id:id(),fromNode:from,fromSide:'right',toNode:selected,toSide:'left'});
        from=undefined;mark();
      }
      area.querySelectorAll('[data-card]').forEach(node=>node.classList.toggle('selected',node.dataset.card===selected));
      connection.textContent=from?'选择连接终点':'连接卡片';
      drawEdges();
    });
    area.addEventListener('dblclick',guard(async event=>{
      const node=nodeFor(event.target.closest('[data-card]')?.dataset.card);
      if(!node)return;
      if(node.type==='file'){
        const file=files().find(file=>relative(file.path)===node.file);
        if(!file)throw Error('找不到画布中的笔记。');
        if(await allowChange()){panel.close();await open(file.path);}
      } else if(await editCard(node)){mark();paint();}
    }));
    area.addEventListener('pointerdown',event=>{
      const card=event.target.closest('[data-card]');
      const node=nodeFor(card?.dataset.card);
      if(!node||event.button!==0)return;
      const origin=box(node);
      drag={card,node,origin,x:event.clientX,y:event.clientY,changed:false};
      card.setPointerCapture(event.pointerId);
    });
    area.addEventListener('pointermove',event=>{
      if(!drag)return;
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      if(!drag.changed&&Math.abs(dx)+Math.abs(dy)<5)return;
      drag.changed=true;
      drag.node.x=drag.origin.x+dx;drag.node.y=drag.origin.y+dy;
      position(drag.card,drag.node);drawEdges();
    });
    const end=()=>{if(drag?.changed){mark();paint();}drag=undefined;};
    area.addEventListener('pointerup',end);
    area.addEventListener('pointercancel',end);
    const heading=panel.querySelector('.workspace-view-heading form');
    const onCancel=guard(async()=>{if(await allowChange())panel.close();});
    heading.addEventListener('submit',event=>{event.preventDefault();onCancel();});
    const cancel=event=>{event.preventDefault();onCancel();};
    panel.confirmClose=async()=>{
      if(busy)return false;
      return allowChange();
    };
    panel.addEventListener('cancel',cancel);
    panel.addEventListener('close',()=>{
      delete panel.confirmClose;
      panel.removeEventListener('cancel',cancel);
    },{once:true});
    paint();
  };
}
