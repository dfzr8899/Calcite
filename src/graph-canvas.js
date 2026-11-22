const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const cellSize = 48;
const labelFont = '11px';

// A screen-space grid keeps label placement proportional to what is on screen.
function labelGrid(blocked) {
  const cells = new Map();
  function visit(box,callback) {
    for (let x=Math.floor(box.left/cellSize);x<=Math.floor(box.right/cellSize);x++) {
      for (let y=Math.floor(box.top/cellSize);y<=Math.floor(box.bottom/cellSize);y++) {
        if (callback(x*65536+y)) return true;
      }
    }
    return false;
  }
  function add(box) {
    visit(box,key=>{
      if (!cells.has(key)) cells.set(key,[]);
      cells.get(key).push(box);
    });
  }
  for (const box of blocked) add(box);
  return {add, intersects:box=>visit(box,key=>cells.get(key)?.some(other=>
    box.left<other.right && box.right>other.left && box.top<other.bottom && box.bottom>other.top))};
}

export function createGraphCanvas(canvas,{current,occlusions,onOpen,onFocus}) {
  const ctx = canvas.getContext('2d');
  const stop = new AbortController();
  const {signal} = stop;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const widths = new Map();
  const batches = Array.from({length:9},()=>[]);
  const highlights = Array.from({length:9},()=>[]);
  const view = {x:0,y:0,scale:1,fitScale:1,automatic:true};
  let nodes=[],edges=[],labelOrder=[],matches,hover,keyboard,drag,frame=0,lastFrame=0;
  let width=0,height=0,ratio=0,colors,font,occupied=[];

  function themeChanged() {
    const style = getComputedStyle(canvas);
    const token = name=>style.getPropertyValue(`--graph-${name}`).trim();
    colors = {edge:token('edge'),accent:token('accent'),label:token('label'),halo:token('label-halo'),
      clusters:Array.from({length:6},(_,index)=>token(`cluster-${index}`))};
    font = style.fontFamily;
    widths.clear();
    invalidate();
  }

  function invalidate() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  const dotScale=()=>clamp(Math.sqrt(view.scale/view.fitScale),.72,1.65);

  function canvasSpace() {
    const top = Math.max(0,...occupied.filter(box=>!box.popover&&box.top<height/2).map(box=>box.bottom));
    const bottom = Math.min(height,...occupied.filter(box=>!box.popover&&box.top>=height/2).map(box=>box.top));
    return bottom-top>=height*.4 ? {top,bottom} : {top:0,bottom:height};
  }

  function fit() {
    if (nodes.length && width && height) {
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for (const {x,y} of nodes) {
        minX=Math.min(minX,x); maxX=Math.max(maxX,x);
        minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      }
      const {top,bottom}=canvasSpace();
      const scale=Math.min((width*.8-28)/Math.max(1,maxX-minX),((bottom-top)*.8-28)/Math.max(1,maxY-minY),2);
      view.scale=view.fitScale=Math.max(.005,scale);
      view.x=width/2-(minX+maxX)/2*view.scale;
      view.y=(top+bottom)/2-(minY+maxY)/2*view.scale;
    }
    view.automatic=true;
    invalidate();
  }

  function resize() {
    const rect=canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    occupied=occlusions().filter(element=>element.offsetWidth).map(element=>{
      const bounds=element.getBoundingClientRect();
      return {left:bounds.left-rect.left-5,right:bounds.right-rect.left+5,
        top:bounds.top-rect.top-5,bottom:bounds.bottom-rect.top+5,popover:element.hasAttribute('data-graph-popover')};
    });
    view.x+=(rect.width-width)/2;
    view.y+=(rect.height-height)/2;
    width=rect.width; height=rect.height;
    const dpr=Math.min(devicePixelRatio||1,2.5);
    const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);
    if (ratio!==dpr || canvas.width!==pixelWidth || canvas.height!==pixelHeight) {
      ratio=dpr;
      canvas.width=pixelWidth;
      canvas.height=pixelHeight;
    }
    if (view.automatic) fit();
    else invalidate();
  }

  function zoom(factor,at) {
    const {top,bottom}=canvasSpace();
    const {x,y}=at||{x:width/2,y:(top+bottom)/2};
    const next=clamp(view.scale*factor,view.fitScale*.24,view.fitScale*12);
    view.x=x-(x-view.x)*next/view.scale;
    view.y=y-(y-view.y)*next/view.scale;
    view.scale=next;
    view.automatic=false;
    invalidate();
  }

  function setView(nextNodes,nextEdges) {
    nodes=nextNodes;
    edges=nextEdges;
    labelOrder=[...nodes].sort((a,b)=>Number(b===current)-Number(a===current)||b.degree-a.degree);
    hover=keyboard=null;
    onFocus(null);
    fit();
  }

  function screen(node) {
    return {x:node.x*view.scale+view.x,y:node.y*view.scale+view.y};
  }

  function hit({x,y}) {
    let closest=null, distance=Infinity;
    const scale=dotScale();
    for (const node of nodes) {
      const point=screen(node);
      const squared=(point.x-x)**2+(point.y-y)**2;
      if (squared<distance && squared<Math.max(8,node.radius*scale+3)**2) {
        closest=node; distance=squared;
      }
    }
    return closest;
  }

  function stroke(edgesToDraw,color,alpha,lineWidth) {
    if (!edgesToDraw.length || !alpha) return;
    ctx.strokeStyle=color;
    ctx.lineWidth=lineWidth;
    ctx.globalAlpha=alpha;
    ctx.beginPath();
    for (const {source:a,target:b} of edgesToDraw) {
      const x1=a.screenX,y1=a.screenY,x2=b.screenX,y2=b.screenY;
      if ((x1<0&&x2<0)||(x1>width&&x2>width)||(y1<0&&y2<0)||(y1>height&&y2>height)) continue;
      ctx.moveTo(x1,y1);
      ctx.lineTo(x2,y2);
    }
    ctx.stroke();
  }

  function label(node,focused) {
    const key=(focused?'full:':'')+node.name;
    const maxWidth=focused?Math.max(60,width-28):Math.min(180,width*.30);
    let entry=widths.get(key);
    if (entry?.maxWidth===maxWidth) return entry;
    let lines=[node.name];
    if (ctx.measureText(node.name).width>maxWidth) {
      const chars=Array.from(node.name);
      if (focused) {
        lines=[];
        let line='';
        for (const char of chars) {
          if (line && ctx.measureText(line+char).width>maxWidth) { lines.push(line); line=''; }
          line+=char;
        }
        if (line) lines.push(line);
      } else {
        let left=0,right=chars.length;
        while (left<right) {
          const middle=Math.ceil((left+right)/2);
          if (ctx.measureText(chars.slice(0,middle).join('')+'…').width<=maxWidth) left=middle;
          else right=middle-1;
        }
        lines=[chars.slice(0,left).join('')+'…'];
      }
    }
    entry={lines,maxWidth,wide:Math.max(...lines.map(line=>ctx.measureText(line).width))};
    widths.set(key,entry);
    return entry;
  }

  function drawLabels(focus,visible) {
    const scale=view.scale/view.fitScale;
    const grid=labelGrid(occupied);
    const lineHeight=14;
    ctx.textBaseline='top';
    ctx.textAlign='center';
    ctx.lineJoin='round';
    ctx.lineWidth=2.5;
    ctx.strokeStyle=colors.halo;
    ctx.fillStyle=colors.label;
    function draw(node,alpha,focused=false,preferred=false) {
      ctx.font=`${focused?'600':'400'} ${focused?'12px':labelFont} ${font}`;
      const {lines,wide}=label(node,focused);
      const w=wide/2+4;
      let x=clamp(node.screenX,w+4,width-w-4);
      const below=node.screenY+node.screenRadius+6;
      const textHeight=lines.length*lineHeight;
      let y=below;
      let box={left:x-w,right:x+w,top:y-3,bottom:y+textHeight+2};
      const obstructed=()=>box.bottom>height-5||box.top<5||grid.intersects(box);
      if ((focused||preferred) && obstructed()) {
        const above=clamp(node.screenY-node.screenRadius-textHeight-6,7,height-textHeight-6);
        for (const point of [{x,y:above},{x:x-w-node.screenRadius-5,y:node.screenY-7},
          {x:x+w+node.screenRadius+5,y:node.screenY-7}]) {
          x=clamp(point.x,w+4,width-w-4);
          y=point.y;
          box={left:x-w,right:x+w,top:y-3,bottom:y+textHeight+2};
          if (!obstructed()) break;
        }
      }
      if (!focused && obstructed()) return;
      if (focused && obstructed()) {
        x=width/2;
        y=Math.max(8,canvasSpace().top+4);
        box={left:x-w,right:x+w,top:y-3,bottom:y+textHeight+2};
      }
      grid.add(box);
      ctx.globalAlpha=alpha;
      for (const [index,line] of lines.entries()) {
        ctx.strokeText(line,x,y+index*lineHeight);
        ctx.fillText(line,x,y+index*lineHeight);
      }
    }
    if (focus?.onScreen) draw(focus,1,true);
    for (const node of visible) {
      const r=node.screenRadius;
      grid.add({left:node.screenX-r-1,right:node.screenX+r+1,top:node.screenY-r-1,bottom:node.screenY+r+1});
    }
    for (const node of labelOrder) {
      if (node===focus || !node.onScreen || node.opacity<.31) continue;
      const preferred=node===current || matches?.has(node.id);
      const priority=preferred || (focus && focus.neighbors.has(node.id)) || node.hub;
      const lod=priority ? 1 : clamp((scale-(node.degree>1?1.15:1.7))/.55,0,1);
      if (lod>.06) draw(node,Math.min(lod,node.opacity),false,preferred);
    }
  }

  function paint(time) {
    frame=0;
    const ease=reduceMotion.matches?1:1-Math.exp(-Math.min(64,time-lastFrame||16)/46);
    lastFrame=time;
    if (!ratio) return;
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.clearRect(0,0,width,height);
    const focus=hover||keyboard;
    const scale=dotScale();
    let changing=false;
    const visible=[];
    for (const node of nodes) {
      const {x,y}=screen(node);
      const r=node.radius*scale;
      node.screenX=x; node.screenY=y; node.screenRadius=r;
      node.onScreen=x>=0&&x<=width&&y>=0&&y<=height;
      if (x>-r&&y>-r&&x<width+r&&y<height+r) visible.push(node);
      const highlighted=focus ? node===focus||focus.neighbors.has(node.id) : !matches||matches.has(node.id);
      const target=highlighted ? 1 : !focus&&node===current ? .42 : .12;
      node.opacity+=(target-node.opacity)*ease;
      if (Math.abs(node.opacity-target)>.004) changing=true;
      else node.opacity=target;
    }
    for (const batch of batches) batch.length=0;
    for (const batch of highlights) batch.length=0;
    for (const edge of edges) {
      const active=focus && (edge.source===focus||edge.target===focus);
      const target=active?1:0;
      edge.accent+=(target-edge.accent)*ease;
      if(Math.abs(edge.accent-target)>.004) changing=true;
      else edge.accent=target;
      const strength=Math.min(edge.source.opacity,edge.target.opacity);
      batches[Math.round(strength*8)].push(edge);
      if (edge.accent>.06) highlights[Math.round(edge.accent*8)].push(edge);
    }
    batches.forEach((batch,index)=>stroke(batch,colors.edge,index/8,.9));
    highlights.forEach((batch,index)=>stroke(batch,colors.accent,.65*index/8,1.15));
    for (const node of visible) {
      const focused=node===focus;
      const r=node.screenRadius;
      ctx.fillStyle=colors.clusters[node.color];
      if (focused || node===current || node.hub&&node.opacity>.8) {
        ctx.globalAlpha=(focused ? .25 : node===current ? .21 : .11)*node.opacity;
        ctx.beginPath(); ctx.arc(node.screenX,node.screenY,r+(focused?6:4),0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha=node.opacity;
      ctx.beginPath(); ctx.arc(node.screenX,node.screenY,r,0,Math.PI*2); ctx.fill();
      if (focused || node===current) {
        ctx.strokeStyle=colors.accent;
        ctx.lineWidth=1;
        ctx.stroke();
      }
    }
    drawLabels(focus,visible);
    ctx.globalAlpha=1;
    if (changing) invalidate();
  }

  const position = event => {
    const bounds=canvas.getBoundingClientRect();
    return {x:event.clientX-bounds.left,y:event.clientY-bounds.top};
  };
  function pointAt(node) {
    if (node===hover) return;
    hover=node;
    canvas.dataset.pointing=node?'node':'empty';
    invalidate();
  }
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    const step=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?height:1);
    zoom(Math.exp(-clamp(step,-300,300)*.002),position(event));
    pointAt(hit(position(event)));
  },{passive:false,signal});
  const fingers=new Map();
  let touchMoved=false,lastTap;
  const center=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  canvas.addEventListener('pointerdown',event=>{
    if(event.pointerType!=='touch')return;
    event.preventDefault();
    if(!fingers.size)touchMoved=false;
    if(fingers.size)touchMoved=true;
    const point=position(event);
    fingers.set(event.pointerId,{...point,start:point});
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(!fingers.has(event.pointerId))return;
    const previous=fingers.get(event.pointerId),point=position(event);
    const other=[...fingers].find(([id])=>id!==event.pointerId)?.[1];
    fingers.set(event.pointerId,{...point,start:previous.start});
    if(other) {
      const before=center(previous,other),after=center(point,other),previousDistance=distance(previous,other);
      if(previousDistance>0)zoom(distance(point,other)/previousDistance,before);
      view.x+=after.x-before.x;view.y+=after.y-before.y;
      touchMoved=true;
    } else {
      if(!touchMoved&&distance(point,previous.start)<6)return;
      const from=touchMoved?previous:previous.start;
      view.x+=point.x-from.x; view.y+=point.y-from.y;
      view.automatic=false;
      touchMoved=true;
    }
    canvas.dataset.dragging='';
    invalidate();
  },{signal});
  function endTouch(event) {
    if(!fingers.delete(event.pointerId)||fingers.size)return;
    delete canvas.dataset.dragging;
    if(event.type!=='pointerup'||touchMoved){lastTap=null;return;}
    const point=position(event), node=hit(point),now=performance.now();
    if(node&&lastTap?.node===node&&now-lastTap.time<380) {
      lastTap=null;onOpen(node);
    } else {
      keyboard=null;
      pointAt(node);
      onFocus(node);
      lastTap=node?{node,time:now}:null;
    }
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,endTouch,{signal});
  canvas.addEventListener('pointerdown',event=>{
    if (event.pointerType==='touch'||!event.isPrimary || event.button!==0) return;
    event.preventDefault();
    const p=position(event);
    const node=hit(p);
    canvas.focus({preventScroll:true});
    canvas.setPointerCapture(event.pointerId);
    drag={id:event.pointerId,p,node,x:node?.x??view.x,y:node?.y??view.y,moved:false};
    keyboard=null;
    onFocus(null);
    pointAt(node);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if (event.pointerType==='touch'||!event.isPrimary) return;
    const p=position(event);
    if (!drag) { pointAt(hit(p)); return; }
    const dx=p.x-drag.p.x,dy=p.y-drag.p.y;
    if (!drag.moved && Math.hypot(dx,dy)<4) return;
    drag.moved=true;
    canvas.dataset.dragging='';
    view.automatic=false;
    if (drag.node) {
      drag.node.x=drag.x+dx/view.scale;
      drag.node.y=drag.y+dy/view.scale;
    } else {
      view.x=drag.x+dx;
      view.y=drag.y+dy;
    }
    invalidate();
  },{signal});
  const finish = event => {
    if (drag?.id!==event.pointerId) return;
    const node=drag.node;
    const open=event.type==='pointerup'&&!drag.moved&&node&&hit(position(event))===node;
    drag=undefined;
    delete canvas.dataset.dragging;
    if (open) onOpen(node);
    else pointAt(event.type==='pointerup'?hit(position(event)):null);
  };
  for (const name of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(name,finish,{signal});
  canvas.addEventListener('pointerleave',event=>{ if (event.pointerType!=='touch'&&!drag) pointAt(null); },{signal});
  canvas.addEventListener('blur',()=>{ keyboard=null; onFocus(null); invalidate(); },{signal});
  canvas.addEventListener('keydown',event=>{
    const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if (direction) {
      event.preventDefault();
      if (!keyboard) keyboard=nodes.includes(current)?current:labelOrder[0];
      else {
        const from=keyboard;
        let closest=Infinity;
        for (const node of nodes) {
          const dx=node.x-from.x,dy=node.y-from.y;
          const ahead=dx*direction[0]+dy*direction[1];
          if (ahead<=0) continue;
          const distance=(dx*dx+dy*dy)/ahead;
          if (distance<closest) { closest=distance; keyboard=node; }
        }
      }
      if (!keyboard) return;
      pointAt(null);
      const {x,y}=screen(keyboard);
      const {top,bottom}=canvasSpace();
      if (x<28||x>width-28||y<top+18||y>bottom-20) {
        view.x+=width/2-x; view.y+=(top+bottom)/2-y;
        view.automatic=false;
      }
      onFocus(keyboard);
      invalidate();
    } else if (event.key==='Enter' && (keyboard||hover)) {
      event.preventDefault(); onOpen(keyboard||hover);
    } else if (event.key==='+'||event.key==='='||event.key==='-') {
      event.preventDefault(); zoom(event.key==='-'?1/1.25:1.25);
    } else if (event.key==='0') {
      event.preventDefault(); fit();
    }
  },{signal});

  const size = new ResizeObserver(resize);
  const theme = new MutationObserver(themeChanged);
  size.observe(canvas);
  theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-glass','data-window-material']});
  window.addEventListener('resize',resize,{signal});
  themeChanged();
  resize();
  return {fit,zoom,resize,setView,setMatches(value){ matches=value; invalidate(); },
    destroy(){ stop.abort(); size.disconnect(); theme.disconnect(); cancelAnimationFrame(frame); }};
}
