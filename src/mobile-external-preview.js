import {errorMessage} from './error-message.js';
import {showDialog} from './mobile-ui.js';
import {wrapReadingTables} from './note-render.js';

export function showExternalMarkdown(file,{render,importNote,exportNote,openLink}) {
  const dialog=document.createElement('dialog');
  dialog.className='feature-dialog external-preview';
  dialog.setAttribute('aria-label','外部临时预览');
  dialog.innerHTML='<header><h2></h2><form method="dialog"><button aria-label="关闭外部预览" autofocus>×</button></form></header>'+
    '<div class="external-preview-actions"><button type="button" class="primary" data-import>导入到当前知识库</button>'+
    '<button type="button" data-export="pdf">导出 PDF</button><button type="button" data-export="png">导出长图</button></div>'+
    '<p role="status" hidden></p><details hidden><summary>大纲</summary><nav aria-label="外部文件大纲"></nav></details>'+
    '<article class="prose external-preview-body"></article>';
  dialog.querySelector('h2').textContent='外部临时预览 · '+file.name;
  const body=dialog.querySelector('article'),outline=dialog.querySelector('details'),nav=outline.querySelector('nav');
  const feedback=dialog.querySelector('[role="status"]');
  const message=text=>{feedback.textContent=text;feedback.hidden=!text;};
  const buttons=[...dialog.querySelector('.external-preview-actions').children];
  let busy=false;
  async function perform(task) {
    if(busy)return;
    busy=true;
    buttons.forEach(button=>button.disabled=true);
    message('');
    try{await task();}
    catch(error){message(errorMessage(error));}
    finally{busy=false;buttons.forEach(button=>button.disabled=false);}
  }
  dialog.querySelector('[data-import]').onclick=()=>perform(async()=>{
    await importNote(file);
    dialog.close();
  });
  for(const button of dialog.querySelectorAll('[data-export]'))
    button.onclick=()=>perform(async()=>{
      const result=await exportNote(button.dataset.export,file);
      if(result)message(result==='print'?'已打开系统打印，请选择「另存为 PDF」。':'长图已导出。');
    });
  dialog.addEventListener('click',event=>{
    event.stopPropagation();
    const link=event.target.closest('a');
    if(!link)return;
    event.preventDefault();
    const href=link.getAttribute('href')||'';
    if(href.startsWith('#')) {
      [...body.querySelectorAll('[id]')].find(node=>node.id===href.slice(1))?.scrollIntoView({block:'start'});
    }else if(/^https?:\/\//i.test(href))openLink(href).catch(error=>message(errorMessage(error)));
  });
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  showDialog(dialog);
  Promise.resolve().then(()=>render(body,file.text)).then(()=>{
    if(!dialog.open)return;
    wrapReadingTables(body);
    for(const heading of body.querySelectorAll('h1,h2,h3,h4,h5,h6')){
      const button=document.createElement('button');
      button.type='button';
      button.textContent=heading.textContent;
      button.style.paddingInlineStart=(Number(heading.tagName[1])-1)*12+'px';
      button.addEventListener('click',()=>{outline.open=false;heading.scrollIntoView({block:'start'});});
      nav.append(button);
    }
    outline.hidden=!nav.childElementCount;
  }).catch(error=>message(errorMessage(error)));
  return {dialog,message};
}
