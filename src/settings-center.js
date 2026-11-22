import {errorMessage} from './error-message.js';
import {isMobileUI,showDialog} from './mobile-ui.js';

const sections = [
  ['writing','写作与公式','pen-line'],
  ['shortcuts','快捷键','keyboard'],
  ['sync','同步与配对','refresh-cw'],
  ['attachments','附件管家','paperclip'],
  ['appearance','外观','sun-moon']
];
const mobileLabels={writing:'写作',sync:'同步',attachments:'附件'};

export function createSettingsCenter({icon,glyphs,mount,fail}) {
  let state;
  function open(key='writing') {
    const horizontal=isMobileUI();
    if(horizontal&&key==='shortcuts')key='writing';
    if (state?.dialog.open) {
      state.select(key,true);
      return;
    }
    const dialog = document.createElement('dialog');
    const pages=horizontal?sections.filter(([id])=>mobileLabels[id]):sections;
    dialog.className = 'feature-dialog settings-center';
    dialog.setAttribute('aria-labelledby','settings-title');
    dialog.innerHTML = `<header class="settings-header"><h2 id="settings-title">设置中心</h2>
      <form method="dialog"><button type="submit" aria-label="关闭设置中心" title="关闭设置中心">${icon('x')}</button></form></header>
      <div class="settings-layout"><nav role="tablist" aria-label="设置分类" aria-orientation="vertical">
      ${pages.map(([id,label,glyph])=>`<button type="button" id="settings-tab-${id}" role="tab" aria-controls="settings-${id}" data-section="${id}">${icon(glyph)}<span>${horizontal?mobileLabels[id]:label}</span></button>`).join('')}
      </nav><div class="settings-pages">
      ${pages.map(([id,label])=>`<section class="settings-page" id="settings-${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" tabindex="0" hidden>${horizontal?'':`<h3>${label}</h3>`}<div class="settings-content"></div></section>`).join('')}
      </div></div>`;
    const tabs = [...dialog.querySelectorAll('[role=tab]')];
    const mounted = new Set();
    const controller = new AbortController();
    function select(id, focus=false) {
      for (const tab of tabs) {
        const selected = tab.dataset.section===id;
        tab.setAttribute('aria-selected',selected);
        tab.tabIndex = selected ? 0 : -1;
        dialog.querySelector('#'+tab.getAttribute('aria-controls')).hidden = !selected;
        if (selected && focus) tab.focus({preventScroll:true});
      }
      if (mounted.has(id)) return;
      mounted.add(id);
      const content = dialog.querySelector('#settings-'+id+' .settings-content');
      Promise.resolve().then(()=>mount[id](content,{
        mobile:horizontal,signal:controller.signal,close:()=>dialog.close()
      })).catch(error=>{
        if (controller.signal.aborted) return;
        const status = document.createElement('p');
        status.setAttribute('role','status');
        status.textContent = errorMessage(error);
        content.replaceChildren(status);
        fail(error);
      });
    }
    const nav=dialog.querySelector('nav');
    nav.setAttribute('aria-orientation',horizontal?'horizontal':'vertical');
    nav.addEventListener('click',event=>{
      const id = event.target.closest('[data-section]')?.dataset.section;
      if (id) select(id);
    });
    nav.addEventListener('keydown',event=>{
      const [back,forward]=horizontal?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];
      if (![back,forward,'Home','End'].includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(event.target);
      const next = event.key==='Home'?0:event.key==='End'?tabs.length-1:
        (current+tabs.length+(event.key===forward?1:-1))%tabs.length;
      select(tabs[next].dataset.section,true);
    });
    dialog.addEventListener('close',()=>{
      controller.abort();
      if (state?.dialog===dialog) state = undefined;
      dialog.remove();
    },{once:true});
    state = {dialog,select};
    document.body.append(dialog);
    glyphs();
    select(key);
    showDialog(dialog);
    tabs.find(tab=>tab.dataset.section===key)?.focus({preventScroll:true});
  }
  return {open};
}
