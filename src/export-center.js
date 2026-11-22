import {showDialog,settingToggle} from './mobile-ui.js';
export const exportDefaults={paper:'A4',landscape:false,vertical:.5,horizontal:.55,scale:100,theme:'modern',fontSize:16,
  lineHeight:1.75,wrapCode:true,keepBlocks:true,toc:false,includeProperties:true,chapters:false,outline:true,
  numberEquations:false,hideFirst:false,headerLeft:'',headerCenter:'',headerRight:'',footerLeft:'',footerCenter:'',footerRight:'',
  printCSS:'',pngScale:1,pngWidth:760,pngPadding:32,pngTheme:'light'};
export const paperInches={A4:[8.27,11.69],A5:[5.83,8.27],B5:[6.93,9.84],Letter:[8.5,11]};
const themes={
  modern:['#fff','#1d2330','#f1f4f8','#c9d3e2','#264b98','system-ui, sans-serif'],
  academic:['#fff','#181818','#f6f4ef','#cbc5b8','#283b60','Georgia, "Noto Serif SC", SimSun, serif'],
  github:['#fff','#24292f','#f6f8fa','#d0d7de','#0969da','system-ui, sans-serif'],
  dark:['#171a23','#e5e9f3','#232938','#404b60','#a8baff','system-ui, sans-serif']
};
const htmlSafe=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cssSafe=value=>String(value||'').replaceAll('<','\\3c ');

export function exportStyle(options,format) {
  const o={...exportDefaults,...options};
  const colors=themes[format==='png'?(o.pngTheme==='dark'?'dark':o.theme==='dark'?'modern':o.theme):o.theme]||themes.modern;
  const [bg,text,fill,border,accent,font]=colors;
  const protectedBlocks=o.keepBlocks?'pre,table,.katex-display,.note-callout{break-inside:avoid}h1,h2,h3,h4,h5,h6{break-after:avoid}':'';
  return `*{box-sizing:border-box}html,body{margin:0;color:${text};background:${bg};font:${o.fontSize}px/${o.lineHeight} ${font}}
  main{max-width:${format==='png'?o.pngWidth:900}px;margin:auto;padding:${format==='png'?o.pngPadding:28}px}
  h1,h2,h3,h4,h5,h6{line-height:1.3}h1:first-child{margin-top:0}p{overflow-wrap:anywhere}
  pre{white-space:${o.wrapCode?'pre-wrap;overflow-wrap:anywhere':'pre;overflow:auto'};background:${fill};padding:12px;border-radius:6px}
  code{font-family:Consolas,monospace}a{color:${accent}}img,svg{max-width:100%;height:auto}
  table{border-collapse:collapse;max-width:100%}td,th{border:1px solid ${border};padding:8px 12px}th{background:${fill};text-align:left}
  blockquote,.note-callout,.note-properties{margin:1em 0;padding:10px 14px;background:${fill};border-left:3px solid ${accent}}
  .note-pagebreak{border:0;border-top:1px dashed ${border};margin:24px 0}.note-toc ul{padding-left:24px}
  ${protectedBlocks} @media print{main{max-width:none;padding:0}.note-pagebreak{break-after:page;border:0;margin:0;height:0}
  ${o.chapters?'h1~h1{break-before:page}':''}${cssSafe(o.printCSS)}}`;
}

export function organizeExport(div,options) {
  if(!options.includeProperties) div.querySelectorAll('.note-properties').forEach(node=>node.remove());
  if(!options.toc)return;
  const nav=document.createElement('nav');nav.className='note-toc';nav.setAttribute('aria-label','导出目录');
  const title=document.createElement('strong');title.textContent='目录';
  const list=document.createElement('ul');
  for(const [i,heading] of [...div.querySelectorAll('h1,h2,h3,h4,h5,h6')].entries()) {
    heading.id||='export-heading-'+i;
    const row=document.createElement('li'),link=document.createElement('a');
    link.href='#'+heading.id;link.textContent=heading.textContent;
    row.style.marginLeft=(Number(heading.tagName.slice(1))-1)*12+'px';row.append(link);list.append(row);
  }
  if(list.children.length){nav.append(title,list);div.prepend(nav);}
}

export function htmlDocument(title,body,css,remote=false) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:'+ (remote?' https: http:':'') +
    '; font-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'+
    '<title>'+htmlSafe(title)+'</title><style>'+css+'</style><body>'+body+'</body></html>';
}

function previewPages(body,options) {
  const template=document.createElement('template');template.innerHTML=body;
  const groups=[[]];
  let headings=0;
  for(const item of template.content.children) {
    if(item.classList.contains('note-pagebreak')) {groups.push([]);continue;}
    if (options.chapters&&item.tagName==='H1'&&headings++) groups.push([]);
    groups.at(-1).push(item.outerHTML);
  }
  const [width,height]=paperInches[options.paper]||paperInches.A4;
  const pageWidth=options.landscape?height:width,pageHeight=options.landscape?width:height;
  const style=`html{background:transparent}body{background:transparent}.preview-sheet{width:${pageWidth*96}px;min-height:${pageHeight*96}px;
  margin:10px auto 18px;background:var(--sheet);padding:${options.vertical*96}px ${options.horizontal*96}px;box-shadow:0 4px 14px #131a2933;
  zoom:var(--preview-zoom, .53)} .preview-sheet>main{padding:0;max-width:none;margin:0;zoom:${options.scale/100}}`;
  return {body:groups.map(nodes=>'<section class="preview-sheet"><main>'+nodes.join('')+'</main></section>').join(''),style,
    contentHeight:Math.max(80,(pageHeight-options.vertical*2)*96/(options.scale/100))};
}

function paginatePreview(document,height) {
  for(const section of [...document.querySelectorAll('.preview-sheet')]) {
    let active=section,main=active.firstElementChild;
    const items=[...main.children];
    main.replaceChildren();
    for(const item of items) {
      main.append(item);
      if(main.scrollHeight<=height+2||main.children.length===1)continue;
      const next=document.createElement('section');next.className='preview-sheet';
      const content=document.createElement('main');next.append(content);
      active.after(next);active=next;main=content;main.append(item);
    }
  }
}

const field=(name,label,control)=>`<label>${label}${control.replace('NAME',name)}</label>`;
const options=(name,label,rows)=>field(name,label,'<select name="NAME">'+rows.map(([value,title])=>`<option value="${value}">${title}</option>`).join('')+'</select>');
const input=(name,label,min,max,step='1')=>field(name,label,`<input type="number" name="NAME" min="${min}" max="${max}" step="${step}" required>`);
const check=settingToggle;

export function showExportCenter({initial,formats=['pdf','html','png'],preferences,selection,render,save,fail}) {
  const group=(label,attrs='')=>`<section class="lg-group" ${attrs}><h4>${label}</h4>`;
  const endGroup='</section>';
  const dialog=document.createElement('dialog');dialog.className='feature-dialog export-center';
  dialog.innerHTML=`<header><h2>导出中心</h2><form method="dialog"><button aria-label="关闭导出中心">×</button></form></header>
  <div class="mobile-export-tabs" role="tablist" aria-label="导出中心视图">
    <button type="button" role="tab" aria-selected="true" data-panel="parameters">参数设置</button>
    <button type="button" role="tab" aria-selected="false" data-panel="preview">实时预览</button>
  </div><div class="export-layout"><form class="export-parameters">
  ${options('format','格式',[['pdf','PDF'],['html','独立 HTML'],['png','PNG 长图']].filter(([format])=>formats.includes(format)))}
  ${options('scope','内容',[['all','全文'],...(selection?[['selection','当前选区']]:[])])}
  ${group('纸张','data-print')}
  ${options('paper','尺寸',Object.keys(paperInches).map(key=>[key,key]))}
  ${options('direction','方向',[['portrait','纵向'],['landscape','横向']])}
  ${options('preset','边距',[['custom','自定义'],['narrow','窄'],['normal','适中'],['wide','宽']])}
  ${options('unit','边距单位',[['in','in'],['mm','mm']])}
  <div class="export-fields">${input('vertical','上下边距',0,65,'.01')}${input('horizontal','左右边距',0,65,'.01')}</div>
  ${input('scale','缩放 %',50,200)}${endGroup}
  ${group('长图','data-image')}${options('pngScale','清晰度',[[1,'1×'],[2,'2×'],[3,'3×']])}
  ${options('pngWidth','画布宽度',[[480,'手机竖屏 480px'],[760,'阅读卡片 760px'],[1000,'桌面宽幅 1000px']])}
  ${input('pngPadding','外圈边距 px',0,96)}${options('pngTheme','纸面',[['light','亮色纸面'],['dark','暗色卡片']])}${endGroup}
  ${group('排版')}${options('theme','打印主题',[['modern','现代无衬线'],['academic','学术论文衬线'],['github','GitHub 风格'],['dark','跟随当前暗色']])}
  <div class="export-fields">${input('fontSize','字号 px',12,18)}${input('lineHeight','行高',1.4,2,'.05')}</div>
  ${check('wrapCode','长代码块自动换行')}${check('keepBlocks','尽量避免跨页拆分')}${check('toc','文首插入目录')}
  ${check('includeProperties','包含 YAML 属性')}${check('chapters','按一级标题分页')}
  ${check('outline','生成 PDF 书签大纲')}${check('numberEquations','自动编号块级公式')}${endGroup}
  <details data-print><summary>页眉与页脚</summary>
  ${['header','footer'].flatMap((key,i)=>['Left','Center','Right'].map((position,n)=>field(key+position,(i?'页脚':'页眉')+['左','中','右'][n],'<input name="NAME" maxlength="160" placeholder="{{title}} {{date}} {{page}} {{total}}">'))).join('')}
  ${check('hideFirst','首页隐藏页眉页脚')}</details>
  <details data-print><summary>自定义打印 CSS</summary><textarea name="printCSS" rows="5" maxlength="16000" aria-label="自定义打印 CSS"></textarea></details>
  <div class="lg-footer"><p role="status"></p><button type="submit" class="primary">保存导出</button></div></form>
  <div class="export-preview"><iframe sandbox="allow-same-origin" title="导出排版预览"></iframe></div></div>`;
  const form=dialog.querySelector('.export-parameters'),frame=dialog.querySelector('iframe'),status=form.querySelector('[role=status]');
  const values={...exportDefaults,...preferences}, fields=form.elements;
  for(const [key,value] of Object.entries(values)) if(fields[key]) {
    if(fields[key].type==='checkbox')fields[key].checked=Boolean(value);else fields[key].value=value;
  }
  fields.format.value=formats.includes(initial)?initial:formats[0];fields.direction.value=values.landscape?'landscape':'portrait';
  for(const tab of dialog.querySelectorAll('.mobile-export-tabs button'))tab.addEventListener('click',()=>{
    dialog.dataset.mobilePanel=tab.dataset.panel;
    for(const button of tab.parentElement.children)button.setAttribute('aria-selected',button===tab);
  });
  let unit='in',timer,ticket=0;
  function read() {
    const outcome={...values};
    for(const [key,defaultValue] of Object.entries(exportDefaults)) if(fields[key]) {
      outcome[key]=typeof defaultValue==='boolean'?fields[key].checked:typeof defaultValue==='number'?Number(fields[key].value):fields[key].value;
    }
    for(const key of ['vertical','horizontal'])outcome[key]/=unit==='mm'?25.4:1;
    outcome.landscape=fields.direction.value==='landscape';
    return outcome;
  }
  function update() {
    const t=++ticket;clearTimeout(timer);
    const format=fields.format.value;
    for(const node of dialog.querySelectorAll('[data-print],[data-image]'))node.hidden=node.hasAttribute('data-print')?format!=='pdf':format!=='png';
    timer=setTimeout(async()=>{
      if(!form.checkValidity())return;
      try {
        const settings=read(), result=await render(settings,fields.scope.value==='selection');
        if(t!==ticket||!dialog.open)return;
        const preview=format==='pdf'?previewPages(result.body,settings):{body:'<main>'+result.body+'</main>',style:''};
        const paper=themes[settings.theme]?.[0]||themes.modern[0];
        frame.onload=format==='pdf'?async()=>{
          const doc=frame.contentDocument;if(!doc)return;
          await doc.fonts.ready;
          await Promise.all([...doc.images].map(image=>image.decode().catch(()=>{})));
          if(t===ticket&&frame.contentDocument===doc)paginatePreview(doc,preview.contentHeight);
        }:null;
        frame.srcdoc=htmlDocument(result.title,preview.body,result.mathCSS+exportStyle(settings,format)+
          ':root{--sheet:'+paper+'}'+preview.style+cssSafe(settings.printCSS));
        status.textContent=format==='pdf'?'预览按内容块估算分页。最终分页由打印引擎计算。':'';
      }catch(error){if(t===ticket)status.textContent=errorMessage(error);}
    },130);
  }
  form.addEventListener('input',event=>{
    if(event.target===fields.unit) {
      const next=fields.unit.value,factor=next==='mm'?25.4:1/25.4;
      if(next!==unit)for(const key of ['vertical','horizontal'])fields[key].value=(Number(fields[key].value)*factor).toFixed(2);
      unit=next;
    }
    if(event.target===fields.preset&&fields.preset.value!=='custom'){
      const value={narrow:.3,normal:.55,wide:.85}[fields.preset.value]*(unit==='mm'?25.4:1);
      for(const key of ['vertical','horizontal'])fields[key].value=value.toFixed(2);
    }
    if(event.target===fields.vertical||event.target===fields.horizontal)fields.preset.value='custom';
    update();
  });
  form.addEventListener('submit',event=>{
    event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
    Promise.resolve(save(fields.format.value,read(),fields.scope.value==='selection')).then(done=>{if(done)dialog.close();}).catch(fail)
      .finally(()=>{button.disabled=false;});
  });
  dialog.addEventListener('close',()=>{clearTimeout(timer);ticket++;dialog.remove();},{once:true});
  document.body.append(dialog);showDialog(dialog);update();
}

export function inlineRichStyles(div) {
  const styles={main:'font-family:Segoe UI,sans-serif;color:#1d2330',pre:'background:#edf1f7;padding:12px;white-space:pre-wrap',
    code:'font-family:Consolas,monospace',table:'border-collapse:collapse',td:'border:1px solid #c9d3e2;padding:8px',
    th:'background:#edf1f7;border:1px solid #c9d3e2;padding:8px',blockquote:'border-left:3px solid #264b98;padding:8px 12px',
    '.note-callout':'background:#edf1f7;border-left:3px solid #264b98;padding:8px 12px',
    '.katex-mathml':'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)',
    '.hljs-keyword,.hljs-title':'color:#694bc0;font-weight:600','.hljs-string':'color:#176a49','.hljs-comment':'color:#52667c'};
  for(const [query,style] of Object.entries(styles))for(const element of div.querySelectorAll(query))
    element.style.cssText+=';'+style;
  return div.innerHTML;
}
import {errorMessage} from './error-message.js';
