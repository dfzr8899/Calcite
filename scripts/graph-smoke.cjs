const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');

async function fixture(vault) {
  await fs.mkdir(vault);
  const groups=['01基础算法','02动态规划','03数据结构','04图论','05字符串','06数学'];
  const name=(group,n)=>`${group.slice(0,2)}-${n===0?'入口':`知识点 ${String(n).padStart(2,'0')}`}`;
  for (const group of groups) {
    const folder=path.join(vault,'算法',group);
    await fs.mkdir(folder,{recursive:true});
    await Promise.all(Array.from({length:24},(_,n)=>{
      const links=n===23?[n-1]:n>=6&&n%6===0?[n+1,n-1,n+3]:[n+1];
      return fs.writeFile(path.join(folder,name(group,n)+'.md'),`# ${name(group,n)}\n\n${links.map(index=>`[[${name(group,index)}]]`).join(' ')}`);
    }));
  }
  const indexLinks=[...groups.map(group=>name(group,0)),...groups.slice(0,4).flatMap(group=>[8,16].map(n=>name(group,n)))];
  await fs.writeFile(path.join(vault,'全库索引.md'),`# 全库索引\n\n${indexLinks.map(title=>`[[${title}]]`).join(' ')}`);
  await fs.writeFile(path.join(vault,'孤立笔记一.md'),'# 孤立笔记一');
  await fs.writeFile(path.join(vault,'孤立笔记二.md'),'# 孤立笔记二');
}

async function run() {
  const testDir=path.join(root,'.test-data');
  await fs.mkdir(testDir,{recursive:true});
  const profile=await fs.mkdtemp(path.join(testDir,'graph-'));
  const vault=path.join(profile,'图谱库');
  await fixture(vault);
  await fs.writeFile(path.join(profile,'workspace.json'),JSON.stringify({root:vault}));
  const env={...process.env,CALCITE_TEST:'1',CALCITE_DATA_DIR:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.argv[2];
  const app=await electron.launch({env,...(executablePath?{executablePath}:{args:[root]})});
  try {
    const visible=Boolean(process.env.CALCITE_GRAPH_VISIBLE);
    const page=await app.firstWindow();
    await app.evaluate(({BrowserWindow},visible)=>{
      const win=BrowserWindow.getAllWindows()[0];
      win.webContents.setBackgroundThrottling(false);
      if (visible) win.showInactive();
    },visible);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#app:not([inert])').waitFor();
    await page.evaluate(()=>{
      window.completedGraphLayouts=0;
      window.Worker=class extends Worker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message',({data})=>{
            if (data instanceof Float32Array && data.length===294) window.completedGraphLayouts++;
          });
        }
      };
      const proto=CanvasRenderingContext2D.prototype;
      const originals={};
      for (const [method,record] of Object.entries({
        clearRect(){window.graphFrame={dots:[],labels:[],lines:0,accent:0};},
        arc(x,y,r){window.graphFrame.dots.push({x,y,r,opacity:this.globalAlpha,color:this.fillStyle});},
        lineTo(){window.graphFrame.lines++; if (!this.strokeStyle.startsWith('rgba')) window.graphFrame.accent++;},
        fillText(text,x,y){window.graphFrame.labels.push({text,x,y,width:this.measureText(text).width});}
      })) {
        const original=proto[method];
        originals[method]=original;
        proto[method]=function(...args){
          if (this.canvas.classList.contains('graph-board')) record.apply(this,args);
          return original.apply(this,args);
        };
      }
      window.restoreGraphProbe=()=>Object.assign(proto,originals);
    });
    const themeButton=page.getByRole('button',{name:'主题与材质'});
    const theme=async(name)=>{
      await themeButton.click();
      await page.locator('#appearance-panel').getByRole('button',{name,exact:true}).click();
      await page.keyboard.press('Escape');
    };
    await theme('暗色');
    await page.locator('.file-row').getByText('全库索引.md',{exact:true}).click();
    const openGraph=()=>page.getByRole('button',{name:'全库图谱',exact:true}).click();
    await openGraph();
    const graph=page.locator('.graph-dialog[open]');
    const board=graph.locator('canvas');
    const count=graph.locator('.graph-count');
    const search=graph.getByRole('searchbox',{name:'筛选图谱'});
    const snapshot=()=>page.evaluate(()=>window.graphFrame);
    const screenshot=name=>process.env.CALCITE_GRAPH_PREVIEW && page.screenshot({
      path:path.join(process.env.CALCITE_GRAPH_PREVIEW,name),animations:'disabled'});
    const frameReady=()=>page.waitForFunction(()=>window.graphFrame?.dots.filter(dot=>dot.opacity===1).length===147);
    await count.getByText('147 篇笔记',{exact:true}).waitFor();
    await frameReady();
    assert.equal(await page.evaluate(()=>window.completedGraphLayouts),1);
    const bounds=await board.boundingBox();
    assert(await board.evaluate(el=>Math.abs(el.width/el.clientWidth-Math.min(2.5,devicePixelRatio))<.02));
    const overview=await snapshot();
    await screenshot('graph-dark.png');
    assert(overview.lines>=130);
    assert(overview.labels.some(label=>label.text==='全库索引')&&overview.labels.length>=3&&overview.labels.length<=24,
      `Initial labels: ${overview.labels.map(label=>label.text).join(', ')}`);
    assert.equal(new Set(overview.dots.filter(dot=>dot.opacity===1).map(dot=>dot.color)).size,6);
    for (const {x,y,r} of overview.dots) {
      assert(x-r>=bounds.width*.08 && x+r<=bounds.width*.92);
      assert(y-r>=bounds.height*.09 && y+r<=bounds.height*.91);
    }

    await graph.getByRole('button',{name:'局部',exact:true}).click();
    await count.getByText('15 篇笔记',{exact:true}).waitFor();
    await graph.getByRole('button',{name:'2 跳',exact:true}).click();
    await count.getByText('37 篇笔记',{exact:true}).waitFor();
    await graph.getByRole('button',{name:'全库',exact:true}).click();
    await graph.getByText('目录分组',{exact:true}).click();
    const math=graph.getByRole('button',{name:/06数学/});
    await math.click();
    await count.getByText('24 / 147 篇笔记',{exact:true}).waitFor();
    await math.click();
    await graph.getByText('目录分组',{exact:true}).click();
    await graph.getByLabel('显示设置',{exact:true}).click();
    await graph.getByLabel('显示孤立节点').uncheck();
    await count.getByText('145 篇笔记',{exact:true}).waitFor();
    await graph.getByLabel('显示孤立节点').check();
    await graph.getByRole('button',{name:'舒展',exact:true}).click();
    await graph.getByLabel('显示设置',{exact:true}).click();
    await page.waitForFunction(()=>window.completedGraphLayouts===2);
    await graph.locator('.graph-message').waitFor({state:'hidden'});

    await search.fill('06-入口');
    await count.getByText('1 / 147 篇笔记',{exact:true}).waitFor();
    await page.waitForFunction(()=>window.graphFrame?.dots.some(dot=>dot.opacity===.12)
      && window.graphFrame?.dots.filter(dot=>dot.opacity===1).length===1);
    const selected=() => snapshot().then(frame=>frame.dots.find(dot=>dot.opacity===1));
    const hit=await selected();
    const moveTo=point=>page.mouse.move(bounds.x+point.x,bounds.y+point.y);
    await moveTo(hit);
    await page.waitForFunction(()=>window.graphFrame.accent>0 && window.graphFrame.labels.some(label=>label.text==='06-入口'));
    await page.mouse.wheel(0,-200);
    await page.waitForFunction(r=>window.graphFrame?.dots.some(dot=>dot.opacity===1&&dot.r>r+.25),hit.r);
    assert((await snapshot()).dots.some(dot=>dot.opacity===1&&Math.hypot(dot.x-hit.x,dot.y-hit.y)<1));
    await page.mouse.down();
    await moveTo({x:hit.x+31,y:hit.y+18});
    await page.mouse.up();
    await page.waitForFunction(({x,y})=>window.graphFrame?.dots.some(dot=>dot.opacity===1&&Math.hypot(dot.x-x-31,dot.y-y-18)<1),hit);
    assert(await graph.isVisible());
    await moveTo({x:bounds.width-22,y:bounds.height/2});
    await page.waitForFunction(()=>window.graphFrame.accent===0);
    const moved=await selected();
    await page.mouse.down();
    await moveTo({x:bounds.width-22-45,y:bounds.height/2+36});
    await page.mouse.up();
    await page.waitForFunction(({x,y})=>window.graphFrame?.dots.some(dot=>dot.opacity===1&&Math.hypot(dot.x-x+45,dot.y-y-36)<1),moved);
    await graph.getByRole('button',{name:'适应画布',exact:true}).click();
    await page.waitForFunction(r=>window.graphFrame?.accent===0
      && window.graphFrame.dots.some(dot=>dot.opacity===1&&Math.abs(dot.r-r)<.1)
      && window.graphFrame.labels.some(label=>label.text==='06-入口'),hit.r);
    const target=await selected();
    await moveTo(target);
    await page.waitForFunction(()=>document.querySelector('.graph-board')?.dataset.pointing==='node');
    await page.mouse.click(bounds.x+target.x,bounds.y+target.y);
    await graph.waitFor({state:'hidden'});
    await page.locator('.tab.active').getByText('06-入口.md',{exact:true}).waitFor();

    await theme('亮色');
    await openGraph();
    await frameReady();
    const light=await snapshot();
    assert.notEqual(light.dots.find(dot=>dot.opacity===1).color,overview.dots.find(dot=>dot.opacity===1).color);
    await page.evaluate(()=>window.calciteAppearance.set('theme','dark'));
    await page.waitForFunction(color=>window.graphFrame.dots.find(dot=>dot.opacity===1)?.color===color,
      overview.dots.find(dot=>dot.opacity===1).color);
    await page.evaluate(()=>window.calciteAppearance.set('theme','light'));
    await page.waitForFunction(color=>window.graphFrame.dots.find(dot=>dot.opacity===1)?.color===color,
      light.dots.find(dot=>dot.opacity===1).color);
    await screenshot('graph-light.png');
    for (let i=0;i<4;i++) await graph.getByRole('button',{name:'放大',exact:true}).click();
    await page.waitForFunction(n=>window.graphFrame?.labels.length>n,light.labels.length);
    const zoomed=(await snapshot()).labels;
    for (const [i,a] of zoomed.entries()) {
      for (const b of zoomed.slice(i+1)) assert(Math.abs(a.y-b.y)>=14 || Math.abs(a.x-b.x)>=(a.width+b.width)/2);
    }
    await graph.getByRole('button',{name:'局部',exact:true}).click();
    await graph.getByRole('button',{name:'2 跳',exact:true}).click();
    await count.getByText('4 篇笔记',{exact:true}).waitFor();
    await graph.getByLabel('显示设置',{exact:true}).click();
    await graph.getByLabel('局部图谱忽略高度数枢纽').uncheck();
    await count.getByText('17 篇笔记',{exact:true}).waitFor();
    await graph.getByLabel('显示设置',{exact:true}).click();
    await graph.getByRole('button',{name:'全库',exact:true}).click();
    if (visible) {
      await page.evaluate(()=>window.restoreGraphProbe());
      const measure=zoom=>board.evaluate((el,zoom)=>new Promise(resolve=>{
        const times=[];
        const rect=el.getBoundingClientRect();
        function step(time) {
          times.push(time);
          if (zoom) el.dispatchEvent(new WheelEvent('wheel',{deltaY:times.length%2?15:-15,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2,cancelable:true}));
          if (times.length<72) requestAnimationFrame(step);
          else {
            const intervals=times.slice(1).map((value,index)=>value-times[index]).sort((a,b)=>a-b);
            resolve([.5,.95].map(rate=>intervals[Math.floor(intervals.length*rate)].toFixed(1)).join(' / '));
          }
        }
        requestAnimationFrame(step);
      }),zoom);
      console.log(`147 nodes, visible-window frame interval median / p95: idle ${await measure(false)} ms, zoom ${await measure(true)} ms.`);
    }
    await page.keyboard.press('Escape');
    await graph.waitFor({state:'hidden'});
    assert.deepEqual(errors,[]);
    console.log('Graph smoke passed. HiDPI, fit, LOD, scopes, directory filters, isolates, spotlight, zoom, drag, pan, open, themes and Escape verified.');
  } finally {
    await app.evaluate(({app})=>app.exit()).catch(()=>{});
  }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
