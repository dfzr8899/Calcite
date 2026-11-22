import { Crepe } from '@milkdown/crepe';
import { replaceAll, $prose } from '@milkdown/kit/utils';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import katexCSS from 'katex/dist/katex.min.css?raw';
import '@milkdown/crepe/theme/common/style.css';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import {indentMore,indentLess,undo,redo} from '@codemirror/commands';
import {getCM,vim} from '@replit/codemirror-vim';
import {formatTables,insertToc,numberHeadings,renumberList,toggleTasks} from './markdown-edit.js';
import {defaultShortcuts,eventShortcut,keycaps,mountShortcuts} from './shortcuts.js';
import {inlineMathView,mathOptions,parseMacros,refreshLiveMath} from './math-options.js';
import {exportDefaults,exportStyle,htmlDocument,inlineRichStyles,organizeExport,showExportCenter} from './export-center.js';
import {mountAttachments} from './attachments.js';
import {documentMenu,pathMenu} from './document-menu.js';
import {createFloatingMenu,contextMenu} from './floating-menu.js';
import {createSettingsCenter} from './settings-center.js';
import {errorMessage} from './error-message.js';
import {syncLabel,mountSyncSettings} from './sync-settings.js';
import {localTimestamp} from '../shared/local-time.mjs';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneMonokai, sourceMarkers } from './editor-theme.js';
import { openSearchPanel } from '@codemirror/search';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { createIcons, icons } from 'lucide';
import './style.css';
import './refinements.css';
import './features.css';
import './workspace-features.css';
import './appearance.css';
import './mobile.css';
import {createMobileShell} from './mobile-shell.js';
import {activeMobileDialog,settingToggle,settingsGroup,showDialog} from './mobile-ui.js';
import {showVaultManager,vaultStatusLabels} from './mobile-vault-manager.js';
import {configured} from '../shared/core/sync-config.mjs';
import {enterEmbed} from '../shared/core/transclusion.mjs';
import {normalizeLineEndings} from '../shared/text-files.mjs';
import {headingIndex,headingMatches,mapLinks,markdown as markdownPath} from '../shared/note-links.mjs';
import {replaceReference,splitReferenceBlock,updateReferenceDefinitions} from '../shared/core/link-refactor.mjs';
import {dailyNoteName,relativeNotePath,tagTree} from '../shared/pkm-workflows.mjs';
import {randomId as uid} from './random-id.js';
import { installOutline, installLinkCompletion, noteHeadings, sourceOutlineFolds } from './navigation.js';
import { defaults, splitFrontmatter, propertiesCard, styleCallouts, liveNotesPlugin, liveWikiStatus, noteTags, noteExtension, diffView, pagebreakNode, remarkPagebreak } from './notes.js';
import { installEditorTools } from './editor-tools.js';
import { createWorkspaceUI } from './workspace-ui.js';
import { renderNote } from './note-render.js';
import { createNoteWorkflows } from './note-workflows.js';
import { createWorkspaceViews } from './workspace-views.js';
import { platform } from './platform/index.js';
import {updateTree,containsPath} from './vault-changes.js';
import {tabSnapshot,restoreWorkspaceSession} from './workspace-session.js';
import {createVaultSearch} from './vault-search.js';

const $ = s => document.querySelector(s);
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const base = p => p?.split(/[\\/]/).pop() || '未命名.md';
const icon = name => `<i data-lucide="${name}"></i>`;
const desktop = platform.type==='electron';
const nativeMobile=platform.type==='capacitor';
const persisted=desktop||nativeMobile;
const mac=platform.os==='darwin'||(!desktop&&/Mac/.test(navigator.platform));
const vimConfig=new Compartment();
const appearance = window.calciteAppearance;
appearance.attach(platform.window,platform.events);
const uiRoot = document.documentElement;
const mathFonts=import.meta.glob('../node_modules/katex/dist/fonts/*.woff2',{eager:true,query:'?inline',import:'default'});
const welcome = `# 给思考，一个安静的地方\n\n欢迎来到你的 **Calcite**。在这里，把零散的灵感写成清晰的笔记。\n\n> 本地文件，自由书写。让页面安静下来，专注于内容本身。\n\n## 从这里开始\n\n- 点击左下角 **打开文件夹**，管理你的 Markdown 知识库。\n- 使用 **Ctrl + O** 打开文档，**Ctrl + S** 保存。\n- 在右下角切换 **即时编辑 / 源码 / 阅读**。\n- 输入「/」插入标题、表格、引用和代码块。\n- 使用 **Ctrl + K** 快速打开文件或执行命令。\n\n## 为知识建立连接\n\n使用 [[使用指南]] 连接笔记。阅读模式下点击链接即可跳转；右侧会显示当前文档的大纲和反向链接。\n\n### 计划与清单\n\n- [x] 找到喜欢的写作环境\n- [ ] 写下今天的第一个想法\n- [ ] 让知识彼此连接\n\n### 清晰地表达\n\n| 模式 | 适合做什么 |\n| --- | --- |\n| 即时编辑 | 流畅写作，所见即所得 |\n| 源码 | 精确编辑 Markdown，查找替换 |\n| 阅读 | 公式、图表与完整排版 |\n\n### 公式与代码\n\n$$\nE = mc^2\n$$\n\n\`\`\`cpp\n#include <iostream>\nint main() {\n    std::cout << "Hello, ideas!" << std::endl;\n}\n\`\`\`\n\n---\n\n慢慢写，好的想法值得留下。\n`;

let tabs=[], activeId='', root='', files=[], mode='live', pane='files', autoSave=true, syncing=false, crepe, source, sessionTimer, saveTimers=new Map(), searchSerial=0, renderSerial=0, initialized=false;
const vaultSearch=createVaultSearch(platform.index.searchSnapshot);
const openingFiles = new Map();
let documentRequest = 0, backlinkRequest = 0, backlinkContext;
const fileKey = p => platform.os === 'win32' ? p.replaceAll('/','\\').toLowerCase() : p;
const current=()=>tabs.find(t=>t.id===activeId);
let preferences={...defaults}, editorTools, workspaceUI, workspaceBusy=false, tagRequest=0;
let healthRequest=0, selectedTag='', updatePkmNote;
const liveView=()=>crepe.editor.action(ctx=>ctx.get(editorViewCtx));
let expanded=new Set(), liveDoc=null, sourceExtensions=[], outlineUI, linkCompletion;
let closedFiles = [], workspaces = {}, workspaceFeatures, noteWorkflows;
let treeSort = 'name', treeDescending = false;
let loadingTree = false;
let initialTreeChanges=[];
let workspaceSettled;
let mobileShell;
const mobileLayout=()=>nativeMobile||uiRoot.dataset.platform==='mobile';
const mobileEditMode=()=>preferences.mobileLiveEditing?'live':'source';
const supportedMode=mode=>mobileLayout()&&mode==='live'?mobileEditMode():mode;
const relativePath = path => {
  const normalized = path.replaceAll('\\','/');
  const prefix = root.replaceAll('\\','/').replace(/\/$/,'')+'/';
  return root && normalized.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? normalized.slice(prefix.length) : normalized;
};
const sortedTree = rows => [...rows].sort((a,b) =>
  Number(!!b.children)-Number(!!a.children) ||
  (treeDescending?-1:1)*((treeSort==='name'?0:(a[treeSort]||0)-(b[treeSort]||0)) ||
    a.name.localeCompare(b.name,'zh-CN',{numeric:true})));
const workspaceState = () => workspaces[root] ??= {bookmarks:[],bases:[]};
const flat=(rows=files)=>rows.flatMap(r=>r.children?flat(r.children):[r]);
const iconButton = (attr,label,glyph) => `<button type="button" ${attr} title="${label}" aria-label="${label}">${icon(glyph)}</button>`;
const appearanceOptions = ()=>`<div class="appearance-choices" role="group" aria-label="晶曜工作台">
  <button type="button" data-appearance-theme="dark">暗色</button>
  <button type="button" data-appearance-theme="light">亮色</button>
</div>`;
document.querySelector('#app').innerHTML=`
<header class="titlebar">
  ${iconButton('class="sidebar-toggle" data-action="sidebar" aria-controls="left-sidebar" aria-expanded="true"','切换左侧栏（Ctrl+B）','panel-left')}
  <div class="tabs" id="tabs" aria-label="打开的文档"></div>
  ${iconButton('class="add-tab" data-action="new"','新建文档（Ctrl+N）','plus')}
  <div class="title-drag-space" aria-hidden="true"></div>
  <div class="title-actions">
    ${iconButton('id="export-quick" data-action="exportCenter" disabled','打开导出中心','file-down')}
    ${iconButton('id="split-quick" data-action="split" disabled','在右侧分栏打开','columns-2')}
    ${iconButton('id="document-star" data-action="toggleBookmark" aria-pressed="false" disabled','收藏当前文档','star')}
    ${iconButton('id="appearance-toggle" popovertarget="appearance-panel"','主题与材质','sun-moon')}
    ${iconButton('data-action="more" aria-haspopup="menu" aria-controls="more-menu" aria-expanded="false"','更多文档操作','ellipsis')}
    <div class="window-controls" role="group" aria-label="窗口控制" ${desktop?'':'hidden'}>
      <button type="button" data-window-control="minimize" title="最小化" aria-label="最小化">${icon('minus')}</button>
      <button type="button" data-window-control="maximize" title="最大化" aria-label="最大化"><span aria-hidden="true">${icon('square')}</span><span aria-hidden="true" hidden>${icon('copy')}</span></button>
      <button type="button" data-window-control="close" title="关闭窗口" aria-label="关闭窗口">${icon('x')}</button>
    </div>
  </div>
</header>
<main class="workspace">
<aside class="sidebar" id="left-sidebar" aria-label="工作区侧栏">
  <div class="vault-bar"><details class="workspace-picker">
    <summary title="切换知识库" aria-controls="workspace-menu">${icon('folder-open')}<b id="workspace-name">本地工作区</b>${icon('chevrons-up-down')}</summary>
  </details>${iconButton('id="settings-toggle" data-action="settings" aria-haspopup="dialog"','设置中心','settings')}</div>
  <nav class="side-tools" aria-label="工作区工具">
    ${iconButton('data-pane="files"','文件','folder-closed')}
    ${iconButton('class="command-hint" data-action="palette"','搜索文件和命令（Ctrl+K）','search')}
    ${iconButton('data-pane="search"','全文搜索（Ctrl+Shift+F）','text-search')}
    ${iconButton('data-action="graph"','全库图谱','network')}
    ${iconButton('data-pane="links"','当前文档的链接','link-2')}
    ${iconButton('data-pane="tags"','标签索引','tags')}
    ${iconButton('data-action="bookmarks"','书签','bookmark')}
  </nav>
  <div class="side-heading">
    <span id="pane-title" hidden></span>
    <div class="side-heading-actions side-note-actions" aria-label="知识库操作">
      ${iconButton('data-pane="health"','知识库体检','heart-pulse')}
      ${iconButton('data-action="daily"','打开今日笔记','calendar-days')}
      ${iconButton('data-action="random"','随机打开笔记','shuffle')}
    </div>
    <div class="side-heading-actions side-file-actions" role="toolbar" aria-label="文件操作">
      <button id="file-sort" type="button" title="文件排序" aria-label="文件排序" disabled>${icon('arrow-down-up')}</button>
      ${iconButton('data-action="refresh"','刷新文件列表','refresh-cw')}
      ${iconButton('data-action="new"','新建文档（Ctrl+N）','file-plus-2')}
      <button type="button" id="new-folder" title="新建文件夹" aria-label="新建文件夹" disabled>${icon('folder-plus')}</button>
    </div>
  </div>
  <div id="side-content"></div>
    <div class="workspace-menu" id="workspace-menu" popover="manual" aria-label="知识库">
      <p id="workspace-path" hidden></p>
      <div id="recent-vaults"></div>
      <button data-action="folder">${icon('folder-open')} ${nativeMobile?'管理本地 Vault':'打开工作区文件夹…'}</button>
      <button data-action="close-vault" hidden>${icon('folder-closed')} 关闭工作区文件夹</button>
      <button data-action="theme">${icon('sun-moon')} 切换明暗主题</button>
      <button data-action="help">${icon('keyboard')} 使用指南与快捷键</button>
    </div>
</aside>
<section class="editor-section">
  <aside id="external-change" class="external-change" aria-label="文件变更提示" hidden></aside>
  <aside id="sync-conflict-banner" class="external-change" hidden><span role="status">同步已保留冲突副本。</span><button type="button" data-sync-conflict>查看同步冲突</button></aside>
  <div class="paper-material" aria-hidden="true"></div>
  <nav class="breadcrumb" aria-label="当前文档路径">
    <div class="breadcrumb-path"><span id="breadcrumb-root"></span>${icon('chevron-right')}<button type="button" id="document-name" aria-current="page" data-breadcrumb-file></button></div>
  </nav>
  <div class="document-scroll" id="live-scroll"><div id="live-properties"></div><div id="live-editor"></div></div>
  <div id="source-editor" hidden></div>
  <article id="reading" class="document-scroll prose" hidden></article>
  <div id="empty" hidden><button data-action="new">新建文档 <kbd>Ctrl N</kbd></button><button data-action="open">打开文档 <kbd>Ctrl O</kbd></button>
    <button class="mobile-empty" data-action="mobile-new-note">新建笔记</button></div>
</section>
<div id="split-divider" hidden aria-hidden="true"></div>
<aside id="split-pane" hidden>
  <div class="paper-material" aria-hidden="true"></div>
  <div class="split-toolbar">
    <select aria-label="右侧笔记"></select>
    <select data-split-mode aria-label="右侧显示模式"><option value="read">阅读</option><option value="source">源码</option></select>
    <button type="button" data-split-save title="保存右侧笔记" aria-label="保存右侧笔记">${icon('save')}</button>
    <button type="button" data-split-close title="关闭分栏" aria-label="关闭分栏">${icon('x')}</button>
  </div>
  <span data-split-status></span><textarea hidden aria-label="右侧 Markdown 源码"></textarea><article class="prose"></article>
</aside>
<aside class="outline-panel" id="right-sidebar" aria-label="大纲和反链">
  <div class="inspector-header">
    <div class="inspector-tabs segmented-control" role="tablist" aria-label="右侧栏内容">
      <button type="button" role="tab" id="outline-tab" aria-controls="outline-view" aria-selected="true">大纲</button>
      <button type="button" role="tab" id="backlinks-tab" aria-controls="backlinks-view" aria-selected="false" tabindex="-1">反链 <span class="link-count">(<span id="backlink-count">0</span>)</span></button>
    </div>
    ${iconButton('data-action="outline" aria-controls="right-sidebar" aria-expanded="true"','收起右侧栏','panel-right-close')}
  </div>
  <div class="inspector-view" id="outline-view" role="tabpanel" aria-labelledby="outline-tab">
    <div class="outline-search">${icon('search')}<input id="outline-filter" type="search" placeholder="筛选标题" aria-label="筛选标题"></div><div id="outline"></div>
  </div>
  <div class="inspector-view" id="backlinks-view" role="tabpanel" aria-labelledby="backlinks-tab" hidden><div id="backlinks"></div></div>
</aside></main>
<footer>
  <div class="save-status"><span class="status-dot"></span><span id="save-state">准备就绪</span><button type="button" id="auto-save" data-action="autosave" aria-pressed="true" ${desktop?'':'hidden'}>自动保存：开</button></div>
  <div class="document-status">
    <div class="document-metrics"><span id="vim-mode" role="status" hidden>NORMAL</span><span id="word-count">0 字</span><span id="read-time">1 分钟阅读</span></div>
    <div class="mode-switch segmented-control" role="group" aria-label="文档模式">
      <button data-mode="live" title="即时编辑">即时编辑</button>
      <button data-mode="source" title="源码">源码</button>
      <button data-mode="read" title="阅读">阅读</button>
    </div>
    <div class="status-tools">
      <button type="button" id="sync-status" aria-controls="sync-popover" aria-haspopup="dialog" ${desktop?'':'hidden'}>未开启</button>
      ${iconButton('data-action="focus" aria-pressed="false"','专注模式（F8）','scan')}
      ${iconButton('data-action="outline" aria-controls="right-sidebar" aria-expanded="true"','切换右侧栏','panel-right')}
    </div>
  </div>
</footer>
<section id="sync-popover" class="sync-popover" role="dialog" aria-label="同步状态" popover>
  <p role="status"></p><progress aria-label="同步进度" hidden></progress>
  <div class="feature-buttons"><button type="button" data-sync-now>立即同步</button>
    <button type="button" data-sync-qr>配对二维码</button><button type="button" data-action="sync">同步设置</button></div>
  <figure hidden><img alt="配对二维码" width="176" height="176"><button type="button" data-copy-pair>复制配对串</button></figure>
</section>
<section id="appearance-panel" popover aria-label="主题与材质">
  ${appearanceOptions()}
</section>
<div id="toast" role="status"></div>
<div class="modal-shade" id="palette" hidden><div class="palette" role="dialog" aria-label="搜索文档或命令"><div class="palette-input">${icon('search')}<input id="command-input" aria-label="搜索文件或命令" placeholder="搜索文件，或输入 > 执行命令" autocomplete="off"><kbd>Esc</kbd></div><div id="command-results"></div><div class="palette-footer">↑ ↓ 选择　Enter 打开</div></div></div>`;
function glyphs(){createIcons({icons,attrs:{'stroke-width':1.65}});}
glyphs();
const appearancePanel = $('#appearance-panel');
const workspaceMenu=$('.workspace-menu');
const syncPopover=$('#sync-popover');
document.body.append(appearancePanel,workspaceMenu,syncPopover,$('#palette'));
async function refreshRecentVaults() {
  if(!platform.workspace.recentVaults)return;
  const rows=await platform.workspace.recentVaults();
  const buttons=rows.map(({path,name})=>{
    const button=document.createElement('button');
    button.type='button';
    button.textContent=name;
    button.title=path;
    if(fileKey(path)===fileKey(root))button.setAttribute('aria-current','true');
    button.onclick=()=>{
      $('.workspace-picker').open=false;
      if(fileKey(path)!==fileKey(root))changeWorkspace(retained=>platform.workspace.switchVault(path,retained)).catch(fail);
    };
    return button;
  });
  $('#recent-vaults').replaceChildren(...buttons);
}
function positionAppearancePanel() {
  if(mobileLayout()){
    appearancePanel.style.top='calc(var(--safe-top) + 56px)';
    appearancePanel.style.right='8px';
    return;
  }
  const anchor = $('#appearance-toggle').getBoundingClientRect();
  appearancePanel.style.top = `${anchor.bottom+8}px`;
  appearancePanel.style.right = `${Math.max(8,innerWidth-anchor.right)}px`;
}
function syncAppearanceControls() {
  for (const control of document.querySelectorAll('[data-appearance-theme]'))
    control.setAttribute('aria-pressed',String(control.dataset.appearanceTheme===uiRoot.dataset.theme));
}
function mountAppearance(panel) {
  panel.innerHTML=appearanceOptions();
  syncAppearanceControls();
}
appearancePanel.addEventListener('beforetoggle',event=>{
  if (event.newState==='open') {
    floatingMenus.close();
    $('.workspace-picker').open=false;
    linkCompletion?.close();
    syncAppearanceControls();
    positionAppearancePanel();
  }
});
document.addEventListener('click',event=>{
  const theme=event.target.closest('[data-appearance-theme]')?.dataset.appearanceTheme;
  if(theme)appearance.set('theme',theme);
});
window.addEventListener('resize',()=>{if (appearancePanel.matches(':popover-open')) positionAppearancePanel();},{passive:true});
let diagramTheme=uiRoot.dataset.theme;
document.addEventListener('calcite-appearance-change',()=>{
  syncAppearanceControls();
  if (diagramTheme!==uiRoot.dataset.theme) {
    diagramTheme=uiRoot.dataset.theme;
    if (mode==='read') renderRead();
    workspaceFeatures?.refreshSplit();
  }
  session();
});
document.addEventListener('calcite-window-material-change',syncAppearanceControls);
$('.window-controls').addEventListener('click', event => {
  const button = event.target.closest('[data-window-control]');
  if (button) platform.window.control(button.dataset.windowControl).catch(fail);
});
platform.events.windowState(maximized => {
  const button = $('[data-window-control="maximize"]');
  const label = maximized ? '还原窗口' : '最大化';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.firstElementChild.hidden = maximized;
  button.lastElementChild.hidden = !maximized;
});
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('show'),3600);}
function fail(error){toast(errorMessage(error));console.error(error);}
const floatingMenus=createFloatingMenu({fail,onOpen(){
  $('.workspace-picker').open=false;
  if (appearancePanel.matches(':popover-open')) appearancePanel.hidePopover();
  linkCompletion?.close();
}});
$('.workspace-picker').addEventListener('toggle',event=>{
  const picker=event.currentTarget;
  if(!picker.open){
    if(workspaceMenu.matches(':popover-open'))workspaceMenu.hidePopover();
    return;
  }
  floatingMenus.close();
  if (appearancePanel.matches(':popover-open')) appearancePanel.hidePopover();
  linkCompletion?.close();
  const rect=picker.getBoundingClientRect();
  workspaceMenu.style.left=rect.left+'px';
  workspaceMenu.style.top=rect.bottom+6+'px';
  workspaceMenu.showPopover();
  refreshRecentVaults().catch(fail);
});
function session(){if(!initialized)return;clearTimeout(sessionTimer);sessionTimer=setTimeout(()=>persist().catch(fail),450);}
async function persist(){const classes=document.body.classList;await platform.preferences.saveSession({tabs:tabs.map(tabSnapshot),activeId,mode,autoSave,treeSort,treeDescending,closedFiles,workspaces,light:uiRoot.dataset.theme==='light',sidebarHidden:classes.contains('hide-sidebar'),outlineHidden:classes.contains('hide-outline'),...(nativeMobile?{mobileRoot:root}:{})});}
function scheduleSave(tab) {
  clearTimeout(saveTimers.get(tab.id));
  saveTimers.delete(tab.id);
  if (autoSave&&tab.dirty&&tab.path&&!workspaceBusy&&!tab.deleted&&!tab.conflict&&!tab.holdAutoSave) {
    saveTimers.set(tab.id,setTimeout(()=>save(tab,false,true).catch(fail),1000));
  }
}
function updateText(text){if(syncing||!current())return;const t=current();t.text=text;t.dirty=t.text!==t.saved;renderTabs();stats();outline();session();if(mode==='read')renderRead();workspaceFeatures?.refreshSplit();editorTools?.update();scheduleSave(t);}
function liveNote(text){
  const {prefix,body,yaml}=splitFrontmatter(text);
  return {prefix,yaml,...splitReferenceBlock(body)};
}
function composeLive(text,markdown){
  const {prefix,suffix}=liveNote(text);
  return prefix+(suffix?markdown.trimEnd()+'\n\n'+suffix+'\n':markdown);
}
async function mountEditors(){
 crepe=new Crepe({root:$('#live-editor'),defaultValue:'',featureConfigs:{'code-mirror':{theme:oneMonokai},latex:{get katexOptions(){return mathOptions(preferences.macros);}},'placeholder':{text:'写下你的想法，或输入 / 插入内容…'},'image-block':{onUpload:file=>editorTools.upload(file)}}});
 crepe.editor.use($prose(()=>liveNotesPlugin((host,destination)=>{
   const path=current()?.path;
   if(path)embedCard(destination,path,new Set([fileKey(path)]),0,{remaining:48},preferences)
     .then(card=>host.replaceChildren(card)).catch(console.warn);
 })));
 crepe.editor.use(pagebreakNode).use(remarkPagebreak);
 crepe.editor.use($prose(()=>inlineMathView(()=>preferences.macros)));
 crepe.on(listener=>listener.markdownUpdated((ctx,md)=>{const doc=ctx.get(editorViewCtx).state.doc;if(!syncing&&mode==='live'&&doc!==liveDoc){liveDoc=doc;updateText(composeLive(current()?.text||'',md));}}));
 await crepe.create();
 sourceExtensions=[keymap.of([{key:'Enter',run:continueNumberedList}]),basicSetup,markdown({base:markdownLanguage,codeLanguages:languages}),oneMonokai,sourceMarkers,sourceOutlineFolds,EditorView.lineWrapping,EditorView.scrollMargins.of(()=>({top:$('.breadcrumb').offsetHeight})),EditorView.updateListener.of(u=>{if(u.docChanged)updateText(u.state.doc.toString());})];
 source=new EditorView({state:EditorState.create({doc:'',extensions:[vimConfig.of(vimExtensions()),...sourceExtensions]}),parent:$('#source-editor')});
}
function vimExtensions() {
  return preferences.vim&&!mobileLayout()?[vim(),ViewPlugin.fromClass(class {
    constructor(view) {
      this.cm=getCM(view);
      this.updateBadge=({mode})=>{$('#vim-mode').textContent=String(mode||'normal').toUpperCase();};
      this.cm?.on('vim-mode-change',this.updateBadge);
      this.updateBadge({mode:'normal'});
    }
    destroy(){this.cm?.off('vim-mode-change',this.updateBadge);}
  })]:[];
}
function updateVim() {
  $('#vim-mode').hidden=mobileLayout()||mode!=='source'||!preferences.vim;
  source?.dispatch({effects:vimConfig.reconfigure(vimExtensions())});
  for(const tab of tabs) delete tab.sourceState;
}
function continueNumberedList(view) {
  if (preferences.vim&&getCM(view)?.state?.vim?.insertMode===false) return false;
  const range=view.state.selection.main,line=view.state.doc.lineAt(range.from);
  const match=view.state.sliceDoc(line.from,range.from).match(/^([ \t]*)(\d{1,8})([.)])([ \t]+)(\S.*)$/);
  if(!range.empty||!match||!view.state.doc.sliceString(line.from,range.from).trim())return false;
  const insert='\n'+match[1]+(Number(match[2])+1)+match[3]+match[4];
  view.dispatch({changes:{from:range.from,insert},selection:{anchor:range.from+insert.length},scrollIntoView:true});
  return true;
}
function flushLive(){if(crepe&&liveDoc&&mode==='live'){const doc=crepe.editor.action(ctx=>ctx.get(editorViewCtx).state.doc);if(doc!==liveDoc){liveDoc=doc;updateText(composeLive(current()?.text||'',crepe.getMarkdown()));}}}
const activeScroll = () => mode==='source'?source?.scrollDOM:mode==='live'?$('#live-scroll'):$('#reading');
function captureEditors(){const t=current();if(!t)return;t.viewMode=mode;(t.scrollByMode??={})[mode]=activeScroll()?.scrollTop||0;if(mode==='live'&&crepe&&liveDoc){t.liveState=crepe.editor.action(ctx=>ctx.get(editorViewCtx).state);t.liveText=t.text;}if(mode==='source'&&source)t.sourceState=source.state;}
function syncEditors(){
  const tab = current();
  syncing = true;
  try {
    if (mode==='live') {
      try {
        if (tab?.liveState && tab.liveText===tab.text) crepe.editor.action(ctx=>ctx.get(editorViewCtx).updateState(tab.liveState));
        else crepe.editor.action(replaceAll(liveNote(tab?.text||'').body,true));
        const view=liveView();
        if(liveWikiStatus.getState(view.state).path!==tab?.path)
          view.dispatch(view.state.tr.setMeta(liveWikiStatus,{path:tab?.path,links:new Map()}));
        liveDoc = view.state.doc;
      } catch (error) {
        liveDoc = null;
        mode = 'source';
        if (tab) tab.viewMode = mode;
        toast('即时编辑无法渲染此文档，已切换到源码。');
        console.warn(error);
      }
    }
    if (mode==='source') {
      const text = tab?.text||'';
      source.setState(tab?.sourceState?.doc.toString()===text ? tab.sourceState : EditorState.create({doc:text,extensions:[vimConfig.of(vimExtensions()),...sourceExtensions]}));
    }
  } finally {syncing=false;}
  showMode();
}
function renderTabs(){
  const bar = $('#tabs');
  const scrollLeft = bar.scrollLeft;
  const focused = bar.contains(document.activeElement) ? document.activeElement.closest('[data-tab]') : null;
  const focusedSelector = document.activeElement?.matches('[data-close]') ? '[data-close]' : '.tab-label';
  bar.innerHTML = tabs.map(tab=>{
    const selected = tab.id===activeId;
    return `<div class="tab${selected?' active':''}${tab.dirty?' dirty':''}" data-tab="${escape(tab.id)}" ${tab.deleted?'data-deleted':tab.conflict?'data-conflict':''} draggable="true">
      <button type="button" class="tab-label" ${selected?'aria-current="true"':''} title="${escape(tab.path||tab.name)}">${icon(tab.pinned?'pin':'file-text')}<span>${escape(tab.name)}</span></button>
      <span class="tab-unsaved" ${tab.dirty?'aria-label="有未保存的修改"':'hidden'}></span>
      ${tab.deleted?'<span class="tab-file-state">已删除</span>':tab.conflict?'<span class="tab-file-state">外部修改</span>':''}
      <button type="button" data-close="${escape(tab.id)}" aria-label="关闭 ${escape(tab.name)}" title="关闭文档">${icon('x')}</button>
    </div>`;
  }).join('');
  bar.scrollLeft = scrollLeft;
  syncTabEdges(bar);
  if (focused) bar.querySelector(`[data-tab="${CSS.escape(focused.dataset.tab)}"] ${focusedSelector}`)?.focus({preventScroll:true});
  const tab = current();
  renderBreadcrumb(tab);
  renderExternalNotice(tab);
  syncDocumentButtons(tab);
  mobileShell?.update();
  document.title = tab ? `${tab.dirty?'● ':''}${tab.name} — Calcite` : 'Calcite';
  glyphs();
}
function syncTabEdges(bar) {
  // The widths are integers, but at fractional display scaling scrollLeft is not.
  const edgeTolerance = 2;
  bar.toggleAttribute('data-overflow-start',bar.scrollLeft>edgeTolerance);
  bar.toggleAttribute('data-overflow-end',bar.scrollWidth-bar.clientWidth-bar.scrollLeft>edgeTolerance);
}
function revealTab(bar,tab=bar.querySelector('.tab.active')) {
  if (!tab || !bar.clientWidth) return;
  if (tab===bar.firstElementChild) {
    bar.scrollLeft = 0;
  } else {
    const viewport = bar.getBoundingClientRect();
    const bounds = tab.getBoundingClientRect();
    const fade = parseFloat(getComputedStyle(bar).getPropertyValue('--tab-edge-fade'))||0;
    if (bounds.left<viewport.left+fade && bar.scrollLeft>0) bar.scrollLeft += bounds.left-viewport.left-fade;
    else if (bounds.right>viewport.right-fade) bar.scrollLeft += bounds.right-viewport.right+fade;
  }
  syncTabEdges(bar);
}
function renderBreadcrumb(tab) {
  const documentName = $('#document-name');
  documentName.textContent = tab?.name||'未打开文档';
  documentName.title = tab?.path||tab?.name||'';
  documentName.disabled = !tab?.path;
  const container = $('#breadcrumb-root');
  const relative = tab?.path && relativePath(tab.path);
  const parent = relative && relative!==tab.path.replaceAll('\\','/') ? relative.split('/').slice(0,-1) : [];
  if (!root) {
    delete container.dataset.path;
    container.textContent = '个人空间';
    return;
  }
  let folder = root.replaceAll('\\','/');
  if (container.dataset.path===JSON.stringify([folder,...parent])) return;
  container.dataset.path = JSON.stringify([folder,...parent]);
  const folderButton = (label,path)=>`<button type="button" data-breadcrumb-folder="${escape(path)}" title="${escape(path)}">${escape(label)}</button>`;
  const segments = [folderButton(base(root)||root,folder)];
  for (const name of parent) {
    folder = folder.replace(/\/$/,'')+'/'+name;
    segments.push(folderButton(name,folder));
  }
  container.innerHTML = segments.join('<span class="breadcrumb-divider" aria-hidden="true"> / </span>');
}
function stats(){drawSyncConflict();const t=current(),text=t?.text||'';const words=(text.match(/[\u3400-\u9fff]/g)||[]).length+(text.replace(/[\u3400-\u9fff]/g,' ').match(/[\p{L}\p{N}]+/gu)||[]).length;$('#word-count').textContent=`${words.toLocaleString()} 字`;$('#read-time').textContent=`${Math.max(1,Math.ceil(words/400))} 分钟阅读`;$('footer').dataset.saved=Boolean(t?.path&&!t.dirty&&!t.deleted&&!t.conflict);$('#save-state').textContent=!desktop?'浏览器预览':t?.deleted?'磁盘文件已删除':t?.conflict?'有外部修改':t?.holdAutoSave?'已保留草稿 · 待手动保存':t?.dirty?(t.path?'有未保存的修改':'未保存的文档'):(t?.path?'已保存到本地':'本地草稿 · 已恢复保护');$('#auto-save').textContent=`自动保存：${autoSave?'开':'关'}`;$('#auto-save').setAttribute('aria-pressed',autoSave);}
let headingText, headingRows = [];
function headings() {
  const text = current()?.text || '';
  if (text !== headingText) {
    const {prefix,body} = splitFrontmatter(text);
    const offset = (prefix.match(/\n/g) || []).length;
    headingRows = noteHeadings(body).map(row=>({...row,line:row.line+offset}));
    headingText = text;
  }
  return headingRows;
}
function outline() { outlineUI?.render(); }
function revealActiveFile() {
  const openPath = current()?.path;
  if (!openPath) return;
  const selectedPath = fileKey(openPath).replaceAll('\\','/');
  function revealFolders(rows) {
    const folder = rows.find(row=>row.children && selectedPath.startsWith(fileKey(row.path).replaceAll('\\','/')+'/'));
    if (!folder) return;
    expanded.add(folder.path);
    revealFolders(folder.children);
  }
  revealFolders(files);
}
function renderFileTree(rows,depth=0) {
  const selectedPath = current()?.path;
  return sortedTree(rows).map(file=>{
    const path = escape(file.path);
    const name = escape(file.name);
    if (file.children) {
      const open = expanded.has(file.path);
      return `<div class="folder-row" style="--depth:${depth}" tabindex="-1" draggable="true" data-folder="${path}">${icon(open?'chevron-down':'chevron-right')}${icon(open?'folder-open':'folder')}<span title="${name}">${name}</span></div>${open?renderFileTree(file.children,depth+1):''}`;
    }
    const selected = selectedPath && fileKey(selectedPath)===fileKey(file.path);
    return `<button type="button" class="file-row${selected?' selected':''}" ${selected?'aria-current="true"':''} style="--depth:${depth}" draggable="true" data-file="${path}" title="${name}">${icon('file-text')}<span>${name}</span></button>`;
  }).join('');
}
function renderSide(){
 $('.sidebar').dataset.paneView=pane;
 const title=$('#pane-title');
 title.hidden=pane==='files';
 title.textContent={files:'',search:'搜索知识库',links:'笔记链接',tags:'标签索引',health:'知识库体检'}[pane];
 const newFolder = $('#new-folder');
 newFolder.hidden = pane !== 'files';
 newFolder.disabled = !root;
 $('#file-sort').hidden = pane !== 'files';
 $('#file-sort').disabled = !root;
 $('[data-action="refresh"]').hidden = pane !== 'files';
 if (pane !== 'search') stopSearch();
 document.querySelectorAll('[data-pane]').forEach(button=>{
   const selected = button.dataset.pane===pane;
   button.classList.toggle('selected',selected);
   button.setAttribute('aria-pressed',selected);
 });
 if (pane === 'search') {
   const filter=(id,label,checked)=>
     `<button type="button" class="lg-chip" id="${id}" aria-pressed="${Boolean(checked)}">${label}</button>`;
   $('#side-content').innerHTML = `<div class="search-box">${icon('search')}<input id="workspace-search" aria-label="搜索工作区" placeholder="搜索文件内容…" value="${escape(renderSide.query||'')}"></div>
   <div class="search-options">${filter('search-regex','正则',renderSide.regex)}${filter('search-case','区分大小写',renderSide.caseSensitive)}</div>
   <p class="search-description">支持 path:、file:、tag: 和多个关键词</p><div id="search-results"></div>`;
   const input = $('#workspace-search');
   const filters=[$('#search-regex'),$('#search-case')];
   const filterValue=control=>control.getAttribute('aria-pressed')==='true';
   const run = () => {
     stopSearch();
     renderSide.query = input.value;
     [renderSide.regex,renderSide.caseSensitive]=filters.map(filterValue);
     renderSide.timer = setTimeout(() => search(input.value).catch(fail), 45);
   };
   input.addEventListener('input',run);
   for (const control of filters) {
     control.addEventListener('click',()=>{
       control.setAttribute('aria-pressed',String(!filterValue(control)));
       run();
     });
   }
   if (renderSide.query) run();
 }
 else if(pane==='tags'){ renderTags().catch(fail); }
 else if(pane==='health'){ renderHealth().catch(fail); }
 else if(pane==='links'){
   const links=new Set();
   mapLinks(current()?.text||'',(destination,wiki)=>{if(wiki)links.add(destination);return destination;});
   $('#side-content').innerHTML=`<div class="tree-root">${icon('network')} 当前文档的链接</div>`+
     ([...links].map(l=>`<button class="file-row link-note" data-wiki="${escape(l)}">${icon('link')}<span>${escape(l)}</span></button>`).join('')||
     '<p class="side-empty">用 [[笔记名称]] 将想法连接起来。</p>');
 }
 else {
   const listing = loadingTree ? '<p class="side-empty" role="status">正在加载工作区…</p>' :
     files.length ? renderFileTree(files) : '<p class="side-empty">文件夹里还没有 Markdown 文档。</p>';
   $('#side-content').innerHTML = root ? `<div class="tree-root" tabindex="-1">${icon('folder-closed')}<span>${escape(base(root)||root)}</span></div>${listing}` :
     `<div class="no-workspace"><p>打开文件夹以浏览笔记。</p><button class="primary" data-action="folder">${icon('folder-open')}打开文件夹</button><button class="quiet" data-action="open">打开文档…</button></div>`;
 }
 $('#workspace-name').textContent = root?base(root):'本地工作区';
 $('#workspace-path').textContent = root;
 $('#workspace-path').hidden = !root;
 $('[data-action="close-vault"]').hidden = !root;
 mobileShell?.update();
 glyphs();
}
function stopSearch() {
  searchSerial++;
  clearTimeout(renderSide.timer);
  vaultSearch.cancel();
}
async function search(query) {
  const results = $('#search-results');
  if (!results) return;
  if (!query.trim()) { results.replaceChildren(); return; }
  const serial = ++searchSerial;
  results.textContent = '正在搜索…';
  const result=await vaultSearch.query({query,regex:renderSide.regex,caseSensitive:renderSide.caseSensitive,
    drafts:tabs.filter(tab=>tab.path&&tab.dirty&&!tab.deleted).map(tab=>({id:fileKey(tab.path),text:tab.text}))});
  if (!result||serial!==searchSerial) return;
  const {found,total,error}=result;
  if (error) {results.textContent=errorMessage(error);return;}
  results.innerHTML = found.length ? found.map(group=>`<details class="search-group" open><summary title="${escape(group.relative)}">${escape(base(group.relative))} <small>${group.hits.length}</small></summary>`+
    group.hits.map(hit=>`<button class="search-result" data-file="${escape(group.path)}" data-line="${hit.line || ''}"><span>${hit.line?hit.line+' · ':''}${escape(hit.text || group.relative)}</span></button>`).join('')+'</details>').join('')+
    (total>=250?'<p class="side-empty">已显示前 250 条匹配。</p>':'') : '<p class="side-empty">没有找到匹配内容。</p>';
}
function backlinkExcerpt({text,marks=[]}) {
  let cursor = 0;
  let html = '';
  for (const [start,end] of marks) {
    html += escape(text.slice(cursor,start))+'<mark>'+escape(text.slice(start,end))+'</mark>';
    cursor = end;
  }
  return html+escape(text.slice(cursor));
}
async function backlinks(){
 if(!initialized)return;
 const t = current();
 const context = JSON.stringify([root,t?.path]);
 const serial = ++backlinkRequest;
 if (context !== backlinkContext) {
   backlinkContext = context;
   $('#backlink-count').textContent = '0';
   $('#backlinks').innerHTML = t?.path ? '<p class="side-empty" role="status">正在查找反链…</p>' : '';
 }
 let matches;
 try {
   matches = t?.path&&!t.deleted ? await platform.index.backlinks(t.path,tabs.filter(tab=>tab.path&&tab.dirty&&!tab.deleted).map(({path,text})=>({path,text}))) : [];
 } catch (error) {
   if (serial!==backlinkRequest) return;
   $('#backlinks').innerHTML = '<p class="side-empty">无法读取反链。</p>';
   throw error;
 }
 if (serial!==backlinkRequest) return;
 const linked = matches.filter(row=>row.linked.length);
 const mentions = matches.filter(row=>row.unlinked.length);
 $('#backlink-count').textContent=linked.length;
 const group=(rows,key)=>rows.map(row=>`<details class="backlink-group"><summary title="${escape(row.path)}">${escape(row.name)}</summary>
   ${row[key].map(hit=>`<button type="button" class="backlink-context" data-file="${escape(row.path)}" data-line="${hit.line}"><span class="backlink-line">${hit.line}</span><span>${backlinkExcerpt(hit)}</span></button>`).join('')}
   <button type="button" class="backlink" data-file="${escape(row.path)}" aria-label="打开 ${escape(row.name)}">${icon('file-text')}打开文档</button></details>`).join('');
 $('#backlinks').innerHTML=(linked.length?group(linked,'linked'):'<p class="side-empty backlinks-empty">其他笔记引用本文时，会出现在这里。</p>')+
   (mentions.length?'<details class="unlinked-mentions"><summary>未链接提及 · '+mentions.length+'</summary>'+group(mentions,'unlinked')+'</details>':'');
 glyphs();
}
function restoreScroll(tab=current()) {
  const viewMode = mode;
  const top = tab?.scrollByMode?.[viewMode] || 0;
  requestAnimationFrame(()=>{
    if(current()===tab && mode===viewMode) {
      activeScroll()?.scrollTo(0,top);
    }
  });
}
async function activate(id,request=++documentRequest){
  if (request!==documentRequest) {
    renderTabs();
    session();
    return false;
  }
  if (initialized) {
    flushLive();
    captureEditors();
  }
  if (id!==activeId) $('#outline-filter').value = '';
  activeId = id;
 mode = supportedMode(current()?.viewMode||mode);
  syncEditors();
  restoreScroll();
  renderTabs();
  revealTab($('#tabs'));
  stats();
  revealActiveFile();
  renderSide();
  if (pane==='files') $('#side-content [aria-current]')?.scrollIntoView({block:'nearest'});
  backlinks().catch(fail);
  workspaceFeatures?.refreshSplit();
  session();
  return true;
}
async function openFile(p,line){
  const request = ++documentRequest;
  try {
    const tab = await loadDocumentTab(p);
    const activated = await activate(tab.id,request);
    if (activated && request===documentRequest && line) {
      await setMode('source');
      if (request!==documentRequest) return false;
      const target = source.state.doc.line(Math.min(line,source.state.doc.lines));
      source.dispatch({selection:{anchor:target.from},effects:EditorView.scrollIntoView(target.from,{y:'center'})});
      source.focus();
    }
    return activated;
  } catch (error) {
    fail(error);
    return false;
  }
}
const findDocumentTab = file => tabs.find(tab=>tab.path&&fileKey(tab.path)===fileKey(file));
function loadDocumentTab(file) {
  const existing=findDocumentTab(file);
  if(existing)return existing;
  const key=fileKey(file);
  if(!openingFiles.has(key)) {
    openingFiles.set(key,platform.fs.read(file).then(data=>{
      const tab={id:uid(),path:file,name:base(file),text:data.text,saved:data.text,mtime:data.mtime,needsLf:data.needsLf,dirty:false,
        ...(isCanvas(file)?{viewMode:'source'}:{})};
      tabs.push(tab);
      return tab;
    }).finally(()=>openingFiles.delete(key)));
  }
  return openingFiles.get(key);
}
async function splitFile(file,heading) {
  const tab=await loadDocumentTab(file);
  renderTabs();
  openDocumentSplit(tab,heading);
}
const isCanvas = file => /\.canvas$/i.test(file||'');
function openDocumentSplit(tab=current(),heading) {
  if (document.body.classList.contains('focus-mode')) action('focus').catch(fail);
  workspaceFeatures.openSplit(tab,{heading,reading:!isCanvas(tab?.path)});
  session();
}
function newDocument(text='',name='未命名.md'){let n=1;while(tabs.some(t=>t.name===name)){name=`未命名 ${++n}.md`;}const t={id:uid(),path:null,name,text,saved:'',mtime:null,dirty:!!text};tabs.push(t);activate(t.id);}
async function releaseUnusedFile(path) {
  if (path&&!tabs.some(tab=>tab.path&&fileKey(tab.path)===fileKey(path))) await platform.fs.release(path);
}
async function save(t=current(),saveAs=false,silent=false) {
  if (t===current()) flushLive();
  if (!t) return true;
  if (workspaceBusy) throw Error('文件操作进行中，请稍候。');
  if (silent&&(t.deleted||t.conflict||t.holdAutoSave)) return false;
  if (t.deleted) saveAs=true;
  if (t.conflict&&!saveAs) {renderExternalNotice(current());return false;}
  clearTimeout(saveTimers.get(t.id));
  if (t.saving) {
    await t.saving;
    return t.text===t.saved||save(t,saveAs,silent);
  }
  if (!saveAs&&!t.dirty&&t.path&&(silent||!t.needsLf)) return true;
  const draft=t.text,previousPath=t.path;
  const text=normalizeLineEndings(previousPath||t.name,draft);
  t.saving=(async()=>{
    const r=await platform.fs.save({path:previousPath,name:t.name,text,saved:t.saved,mtime:t.mtime,saveAs});
    if (!r) return false;
    if (r.conflict) {
      if (r.mtime===undefined) {t.deleted=true;scheduleSave(t);}
      else flagConflict(t,r);
      renderTabs();stats();session();
      return false;
    }
    delete t.conflict;
    delete t.deleted;
    delete t.holdAutoSave;
    if(t.text===draft)t.text=text;
    t.needsLf=false;
    t.path=r.path;t.name=base(r.path);t.mtime=r.mtime;t.saved=text;t.dirty=t.text!==text;
    await releaseUnusedFile(previousPath);
    renderTabs();stats();await persist();
    if(!previousPath||fileKey(previousPath)!==fileKey(r.path))files=await platform.workspace.tree();
    else {
      const row=flat(files).find(file=>fileKey(file.path)===fileKey(r.path));
      if(row)row.modified=r.mtime;
    }
    renderSide();
    if (!silent) toast('已保存到本地');
    return true;
  })();
  try { return await t.saving; } finally { t.saving=null; }
}
async function closeTab(id) {
  flushLive();
  const tab=tabs.find(item=>item.id===id);
  if (!tab) return;
  if (tab.saving) await tab.saving;
  if (tab.dirty&&!await platform.window.discard()) return;
  const index=tabs.indexOf(tab);
  if (index<0) return;
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  if (tab.saving) await tab.saving;
  if (tab.path) closedFiles=[tab.path,...closedFiles.filter(path=>path!==tab.path)].slice(0,30);
  tabs.splice(index,1);
  await releaseUnusedFile(tab.path);
  workspaceFeatures?.refreshSplit();
  if (activeId===id) {
    activeId='';liveDoc=null;
    await activate(tabs[Math.max(0,index-1)]?.id||'');
  } else renderTabs();
  await persist();
}
function showMode(){
  $('#vim-mode').hidden=mode!=='source'||!preferences.vim;
  linkCompletion?.close();
  const tab = current();
  const meta = splitFrontmatter(tab?.text||'');
  const propertyCard = meta.prefix ? propertiesCard(meta.yaml) : null;
  if (propertyCard) {
    const edit = document.createElement('button');
    edit.dataset.action = 'properties';
    edit.textContent = '编辑属性';
    propertyCard.append(edit);
  }
  $('#live-properties').replaceChildren(...(propertyCard?[propertyCard]:[]));
  $('#empty').hidden = !!tab;
  $('.breadcrumb').hidden = !tab;
  $('#live-scroll').hidden = !tab||mode!=='live';
  $('#source-editor').hidden = !tab||mode!=='source';
  $('#reading').hidden = !tab||mode!=='read';
  for (const button of document.querySelectorAll('[data-mode]')) {
    const selected = button.dataset.mode===mode;
    button.classList.toggle('active',selected);
    button.setAttribute('aria-pressed',selected);
    button.disabled = !tab;
  }
  if (tab&&mode==='read') renderRead();
  if (tab&&mode==='source') source.requestMeasure();
  editorTools?.onModeChange();
  outlineUI?.render();
  mobileShell?.update();
  mobileShell?.viewport();
}
async function setMode(next){next=supportedMode(next);if(mode===next)return;flushLive();captureEditors();mode=next;if(current())current().viewMode=mode;syncEditors();restoreScroll();session();}
let mermaidModule, diagramQueue=Promise.resolve();
const renderMarkdown = text => renderNote(text, preferences);
function sectionNodes(content,fragment) {
  if(!fragment)return [...content.childNodes];
  let decoded;
  try{decoded=decodeURIComponent(fragment);}catch{decoded=fragment;}
  if(decoded.startsWith('^')){
    const block=[...content.querySelectorAll('[data-block-id]')].find(element=>element.dataset.blockId===decoded.slice(1));
    return block?[block]:[];
  }
  const children=[...content.children];
  const labels=children.filter(el=>/^H[1-6]$/.test(el.tagName));
  const heading=labels[headingIndex(labels.map(el=>({text:el.textContent})),fragment)];
  if(!heading)return [];
  const start=children.indexOf(heading);
  const end=children.findIndex((el,i)=>i>start&&/^H[1-6]$/.test(el.tagName)&&el.tagName<=heading.tagName);
  return children.slice(start,end<0?undefined:end);
}
async function lookupWikiStates(destinations,path) {
  const results=new Map();
  for(let i=0;i<destinations.length;i+=256){
    const batch=destinations.slice(i,i+256);
    const values=await platform.index.links({source:path,destinations:batch});
    batch.forEach((value,index)=>results.set(value,values[index]?.status||'ok'));
  }
  return results;
}
async function paintWikiStates(links,path) {
  if(!path||!links.length)return;
  const results=await lookupWikiStates([...new Set(links.map(link=>link.dataset.wiki))],path);
  for(const link of links)link.dataset.linkStatus=results.get(link.dataset.wiki);
}
async function embedCard(destination,path,visited,depth,budget,settings) {
  const card=document.createElement('section');
  card.className='note-embed-content';
  const header=document.createElement('header');
  const label=document.createElement('strong');
  label.textContent=destination;
  const jump=document.createElement('a');
  jump.href='#';
  jump.dataset.wiki=destination;
  if(path)jump.dataset.noteSource=path;
  jump.textContent='打开原稿';
  header.append(label,jump);
  card.append(header);
  const status=message=>{
    const warning=document.createElement('p');
    warning.className='embed-status';
    warning.textContent=message;
    card.append(warning);
    return card;
  };
  if(!path)return status('保存笔记后可预览内嵌内容。');
  if(budget.remaining--<=0||depth>=12)return status('内嵌已达到展开上限。');
  if(/\.(?:png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(destination)){
    const img=document.createElement('img');
    img.alt=destination;
    if(nativeMobile){
      const url=await platform.fs.imageSource(path,destination,true);
      if(!url)return status('找不到内嵌图片。');
      img.addEventListener('error',()=>platform.export.image(url).then(data=>{img.src=data;}).catch(console.warn),{once:true});
      img.src=url;
    }else img.src=localImage(destination,path);
    return img;
  }
  const target=await platform.index.target({source:path,destination,wiki:true});
  if(!target){
    const [detail]=await platform.index.links({source:path,destinations:[destination]});
    return status(detail?.status==='ambiguous'?'内嵌目标有同名笔记，请指定路径。':'内嵌笔记尚未创建。');
  }
  label.textContent=base(target.path)+(target.heading?' · '+target.heading:'');
  const ancestors=enterEmbed(visited,target.path,fileKey);
  if(!ancestors)return status('检测到循环内嵌');
  const text=findDocumentTab(target.path)?.text ?? (await platform.fs.read(target.path)).text;
  const content=document.createElement('div');
  await renderContent(content,text,target.path,ancestors,depth+1,budget,settings,target.heading);
  if(!content.childNodes.length)return status('找不到内嵌章节。');
  card.append(...content.childNodes);
  return card;
}
async function renderContent(container,text,path,visited=new Set(path?[fileKey(path)]:[]),depth=0,budget={remaining:80},settings=preferences,fragment='') {
  const {body,prefix,yaml}=liveNote(text);
  container.innerHTML=renderNote(body,settings);
  if(fragment)container.replaceChildren(...sectionNodes(container,fragment));
  else if(prefix)container.prepend(propertiesCard(yaml));
  if(path)for(const link of container.querySelectorAll('a[href]'))link.dataset.noteSource=path;
  const embeds=[...container.querySelectorAll('[data-embed]')];
  await Promise.all([
    resolveImages(container,path),
    paintWikiStates([...container.querySelectorAll('a[data-wiki]')],path),
    ...embeds.map(async embed=>{
      try {
        const card=await embedCard(embed.dataset.embed,path,visited,depth,budget,settings);
        const parent=embed.parentElement;
        if(parent?.tagName==='P'&&parent.children.length===1&&parent.textContent===embed.textContent&&card.tagName!=='IMG')parent.replaceWith(card);
        else embed.replaceWith(card);
      } catch(error){console.warn(error);}
    })
  ]);
}
async function renderDiagrams(container) {
  const codeBlocks = [];
  container.querySelectorAll('pre code').forEach(el=>{
    if(el.classList.contains('language-mermaid')){
      const div=document.createElement('div');div.className='mermaid';div.textContent=el.textContent;el.parentElement.replaceWith(div);
    } else codeBlocks.push(el);
  });
  const diagrams = container.querySelectorAll('.mermaid:not([data-processed])');
  if (codeBlocks.length) {
    const {default:hljs} = await import('highlight.js');
    for (const el of codeBlocks) { try { hljs.highlightElement(el); } catch {} }
  }
  if (diagrams.length) {
    mermaidModule ??= import('mermaid').then(({default:mermaid})=>mermaid);
    const rendered=diagramQueue.then(async()=>{
      const mermaid=await mermaidModule;
      mermaid.initialize({startOnLoad:false,theme:uiRoot.dataset.theme==='dark'?'dark':'default',
        securityLevel:'strict',fontFamily:'Segoe UI, Microsoft YaHei, sans-serif'});
      await mermaid.run({nodes:diagrams,suppressErrors:true});
    });
    diagramQueue=rendered.catch(()=>{});
    await rendered;
  }
}
async function renderRead() {
  const serial=++renderSerial;
  const tab=current();
  const reading=$('#reading');
  const container=document.createElement('div');
  container.className='reading-content';
  reading.replaceChildren(container);
  const rendered=renderContent(container,tab?.text||'',tab?.path);
  editorTools?.update();
  try {
    await rendered;
    if(serial!==renderSerial)return;
    const properties=container.querySelector(':scope > .note-properties');
    if(properties&&tab){
      const edit=document.createElement('button');
      edit.dataset.action='properties';
      edit.textContent='编辑属性';
      properties.append(edit);
    }
    if(mobileLayout())for(const table of container.querySelectorAll('table')){
      const wrap=document.createElement('div');
      wrap.className='table-wrap';
      wrap.tabIndex=0;
      wrap.setAttribute('role','region');
      wrap.setAttribute('aria-label','横向滚动表格');
      table.before(wrap);
      wrap.append(table);
    }
    await renderDiagrams(container);
  } catch(error) {if(serial===renderSerial)console.warn(error);}
  if(serial===renderSerial){editorTools?.update();outlineUI?.schedule();}
}
function localImage(src,doc=current()?.path) {
  if (/^(https?:|data:|note-image:)/i.test(src)||!doc) return src;
  let decoded;
  try { decoded=decodeURIComponent(src).replaceAll('\\','/'); } catch { return src; }
  const parent=doc.replaceAll('\\','/').replace(/\/[^/]*$/,'');
  const absolute=/^(?:\/|[A-Z]:\/)/i.test(decoded)?decoded:parent+'/'+decoded;
  return 'note-image://local/'+encodeURIComponent(absolute);
}
const pendingImages=new WeakMap();
function resolveImages(el,doc=current()?.path) {
  const updates=[];
  for(const img of el.querySelectorAll('img')) {
    const raw=img.getAttribute('src');
    if(!raw)continue;
    if(!nativeMobile) {
      const url=localImage(raw,doc);
      if(url!==raw) img.src=url;
    } else if(doc&&!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)&&pendingImages.get(img)!==raw) {
      pendingImages.set(img,raw);
      updates.push(platform.fs.imageSource(doc,raw,img.hasAttribute('data-wiki-image')).then(url=>{
        if(!url||img.getAttribute('src')!==raw)return;
        img.addEventListener('error',()=>platform.export.image(url).then(data=>{img.src=data;}).catch(console.warn),{once:true});
        img.src=url;
      }));
    }
  }
  return Promise.all(updates);
}
async function wiki(destination, isWiki=true, sourcePath=current()?.path){
 const request = documentRequest;
 const target=await platform.index.target({source:sourcePath,destination,wiki:isWiki});
 if(request!==documentRequest)return;
 if(!target){
   const [detail]=isWiki?await platform.index.links({source:sourcePath,destinations:[destination]}):[];
   if(request!==documentRequest)return;
   if(detail?.status==='ambiguous'){
     selectSidePane('health');
     if(mobileLayout())mobileShell.openDrawer('left');
     return toast('此链接对应多篇同名笔记，请在体检中指定目标。');
   }
   if(isWiki&&(!detail||detail.status==='placeholder'))return workspaceUI.createMissing(destination,sourcePath);
   return toast('找不到链接目标');
 }
 if(!await openFile(target.path))return;
 if (target.heading?.startsWith('^')) {
   const id=target.heading.slice(1);
   if (mode!=='read') await setMode('read');
   const block=[...$('#reading').querySelectorAll('[data-block-id]')].find(element=>element.dataset.blockId===id);
   if(block)block.scrollIntoView({block:'center'});
   else toast('找不到链接目标段落');
   return;
 }
 if(target.heading){
   const i=headingIndex(headings(),target.heading);
   if(i>=0)jumpHeading(i);
   else toast('找不到链接目标章节');
 }
}
function jumpHeading(i,fromOutline=false) {
  const heading = headings()[i];
  if (!heading) return;
  outlineUI?.reveal(i,fromOutline);
  if (mode === 'source') {
    const line = source.state.doc.line(heading.line);
    source.dispatch({selection:{anchor:line.from},effects:EditorView.scrollIntoView(line.from,{y:'start'})});
  } else {
    const content = mode === 'read' ? $('#reading .reading-content') : $('.milkdown .ProseMirror');
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    [...(content?.children || [])].filter(el=>/^H[1-6]$/.test(el.tagName))[i]?.scrollIntoView({behavior,block:'start'});
  }
  outlineUI?.schedule();
}
const commands=[['new','新建 Markdown 文档','Ctrl N','file-plus-2'],['open','打开文档…','Ctrl O','file-text'],['folder','打开文件夹…','Ctrl Shift O','folder-open'],['save','保存当前文档','Ctrl S','save'],['saveAs','另存为…','Ctrl Shift S','copy'],['pdf','导出 PDF','','file-down'],['html','导出独立 HTML','','file-down'],['png','导出阅读长图 / 选中块','','image'],['history','查看版本历史','','history'],['settings','写作与公式设置','','settings'],['typewriter','切换打字机模式','','align-center'],['paragraph','切换段落聚焦','','scan'],['live','切换到即时编辑','','pen-line'],['source','切换到源码模式','','code-2'],['read','切换到阅读模式','','book-open'],['focus','切换专注模式','F8','scan'],['theme','切换明暗主题','','sun-moon'],['autosave','切换自动保存','','save'],['reveal','在资源管理器中显示','','folder-search'],['help','使用指南与快捷键','','circle-help']];
commands.push(
  ['bookmarks','打开书签','','bookmark'],['bookmarkHeading','收藏当前笔记或标题','','bookmark-plus'],
  ['reopen','重新打开刚关闭的文档','Ctrl Shift T','history'],['split','在右侧分栏打开当前笔记','','columns-2'],
  ['graph','打开全库图谱','','network'],['localGraph','打开局部图谱','','git-fork'],
  ['canvas','打开 Canvas 画布','','panels-top-left'],['bases','打开属性视图（Bases）','','table'],
  ['template','插入笔记模板','','file-text'],['daily','打开今日笔记','','calendar-days'],
  ['random','随机打开笔记','','shuffle'],['vaultHealth','知识库体检','','heart-pulse'],
  ['linkReferences','补全/更新文末标准引用定义','','link-2'],
  ['properties','编辑笔记属性','','list-checks'],['exportSettings','PDF 与公式设置','','settings'],
  ['docx','导出 Word（Pandoc）','','file-down'],['epub','导出 EPUB（Pandoc）','','file-down']
);
commands.push(...[
  ['palette','打开命令面板'],['find','文内查找'],['searchWorkspace','工作区全文搜索'],['sidebar','切换文件侧栏'],
  ['closeTab','关闭当前标签'],['nextTab','下一个标签'],['previousTab','上一个标签'],['shortcuts','快捷键设置'],
  ['vim','源码模式启用或关闭 Vim 键位'],['formatTable','格式化当前 Markdown 表格'],['formatTables','格式化全文 Markdown 表格'],
  ['renumberList','重排当前有序列表序号'],['tasks','切换任务勾选'],['wrapBold','包裹为粗体'],['wrapItalic','包裹为斜体'],
  ['wrapCode','包裹为行内代码'],['wrapStrike','包裹为删除线'],['wrapMath','包裹为行内公式'],['toc','插入或更新目录'],
  ['numberHeadings','添加或更新章节编号（跳过 H1）'],['numberAllHeadings','添加或更新章节编号（含 H1）'],['clearHeadings','清除章节编号'],['exportCenter','打开导出中心'],['copyRich','复制为富文本'],['portableMarkdown','导出便携 Markdown 包']
].map(([id,label])=>[id,label,'','command']));
let commandRows=[],commandIndex=0;
let paletteOrigin;
function palette(){
  floatingMenus.close();
  if (appearancePanel.matches(':popover-open')) appearancePanel.hidePopover();
  if ($('#palette').hidden) {
    paletteOrigin = document.activeElement;
    $('#palette').hidden = false;
    $('#command-input').value = '';
    commandIndex = 0;
    filterCommands();
  }
  $('#command-input').focus();
}
function closePalette(){
  $('#palette').hidden = true;
  if (paletteOrigin?.isConnected) paletteOrigin.focus({preventScroll:true});
  paletteOrigin = undefined;
}
function filterCommands(){const q=$('#command-input').value.toLowerCase().trim();const search=q.replace(/^>/,'').trim();commandRows=[...(!q.startsWith('>')?flat().filter(f=>f.name.toLowerCase().includes(search)).slice(0,12).map(f=>({label:f.name,detail:f.path,icon:'file-text',path:f.path})):[]),...commands.filter(c=>c[1].toLowerCase().includes(search)||c[0].toLowerCase().includes(search)).map(c=>({action:c[0],label:c[1],detail:keycaps(({...defaultShortcuts,...preferences.shortcuts})[c[0]],mac),icon:c[3]}))];commandIndex=Math.min(commandIndex,Math.max(0,commandRows.length-1));$('#command-results').innerHTML=commandRows.map((c,i)=>`<button class="command-row ${i===commandIndex?'chosen':''}" data-command="${i}">${icon(c.icon)}<span>${escape(c.label)}</span><small>${escape(c.path?base(c.detail.replace(/[\\/][^\\/]+$/,'')):c.detail)}</small></button>`).join('')||'<p class="side-empty">没有匹配的文件或命令</p>';glyphs();}
function executeCommand(i){const c=commandRows[i];if(!c)return;closePalette();if(c.path)openFile(c.path);else action(c.action).catch(fail);}
$('#command-input').addEventListener('input',()=>{commandIndex=0;filterCommands();});
$('#command-input').addEventListener('keydown',event=>{
  if (event.isComposing) return;
  if (event.key==='ArrowDown'||event.key==='ArrowUp') {
    event.preventDefault();
    commandIndex = Math.max(0,Math.min(commandRows.length-1,commandIndex+(event.key==='ArrowDown'?1:-1)));
    filterCommands();
    document.querySelector('.command-row.chosen')?.scrollIntoView({block:'nearest'});
  }
  if (event.key==='Enter') {
    event.preventDefault();
    executeCommand(commandIndex);
  }
});

const pendingDrafts=()=>tabs.filter(tab=>tab.path&&tab.dirty&&!tab.deleted).map(({path,text})=>({path,text}));
async function renderTags() {
  const request=++tagRequest;
  const side=$('#side-content');
  const opened=new Set([...side.querySelectorAll('details[data-tag][open]')].map(el=>el.dataset.tag));
  if(!opened.size)side.innerHTML='<p class="side-empty">正在读取标签…</p>';
  const notes=new Map((await platform.index.notes('metadata',pendingDrafts())).map(note=>[fileKey(note.path),note]));
  for(const tab of tabs)if(tab.path&&!tab.deleted&&!notes.has(fileKey(tab.path)))
    notes.set(fileKey(tab.path),{path:tab.path,tags:[...noteTags(tab.text,marked)]});
  if(pane!=='tags'||request!==tagRequest)return;
  const tree=tagTree(notes.values());
  const row=({label,tag,paths,children})=>{
    const active=selectedTag===tag;
    const action='<button type="button" class="tag-filter" aria-pressed="'+active+'">全部 #'+escape(tag)+' · '+paths.length+'</button>';
    const files=active||!children.length?paths.map(path=>
      '<button class="file-row" title="'+escape(path)+'" data-file="'+escape(path)+'">'+escape(base(path))+'</button>').join(''):'';
    return '<details class="tag-group" data-tag="'+escape(tag)+'" '+(opened.has(tag)||active?'open':'')+'>'+
      '<summary>#'+escape(label)+' <small>'+paths.length+'</small></summary>'+action+files+children.map(row).join('')+'</details>';
  };
  side.innerHTML=tree.map(row).join('')||'<p class="side-empty">工作区暂无标签。</p>';
  for(const button of side.querySelectorAll('.tag-filter'))button.onclick=()=>{
    selectedTag=button.closest('[data-tag]').dataset.tag;
    renderTags().catch(fail);
  };
}
async function renderHealth(){
  const request=++healthRequest, side=$('#side-content');
  if(!root){side.innerHTML='<p class="side-empty">打开知识库后可运行体检。</p>';return;}
  const opened=new Map([...side.querySelectorAll('[data-health]')].map(el=>[el.dataset.health,el.open]));
  if(!opened.size)side.innerHTML='<p class="side-empty" role="status">正在读取知识库索引…</p>';
  const {orphans,issues}=await platform.index.health(pendingDrafts());
  if(pane!=='health'||request!==healthRequest)return;
  const group=(id,label,entries)=>'<details class="pkm-health" data-health="'+id+'" '+(opened.get(id)??true?'open':'')+
    '><summary>'+label+' <small>'+entries.length+'</small></summary>'+
    (entries.join('')||'<p class="side-empty">暂无</p>')+'</details>';
  const issueRow=(issue,i)=>{
    const heading=issue.status==='ambiguous'?'歧义链接':issue.status==='broken-heading'?'失效章节':
      issue.status==='broken'?'失效链接':'待创建';
    const fixes=issue.status==='placeholder'?'<button type="button" data-create-placeholder="'+i+'">新建笔记</button>':
      (issue.candidates||[]).map((candidate,j)=>'<button type="button" data-fix-issue="'+i+'" data-candidate="'+j+'">'+
        escape(candidate.identifier)+'</button>').join('');
    return '<article class="health-issue"><button type="button" class="backlink-context" data-file="'+escape(issue.source)+
      '" data-line="'+issue.line+'"><span><strong>'+heading+' · '+escape(issue.destination)+'</strong><small>'+
      escape(relativePath(issue.source))+':'+issue.line+'</small><span>'+backlinkExcerpt(issue)+'</span></span></button>'+
      (fixes?'<div class="health-actions">'+fixes+'</div>':'')+'</article>';
  };
  const groups=[[],[]];
  issues.forEach((issue,i)=>groups[Number(issue.status!=='placeholder')].push(issueRow(issue,i)));
  side.innerHTML=group('orphans','孤立笔记',orphans.map(path=>
    '<button type="button" class="file-row" data-file="'+escape(path)+'" title="'+escape(path)+'">'+escape(relativePath(path))+'</button>'))+
    group('placeholders','待建占位链',groups[0])+group('broken','坏链与歧义链',groups[1]);
  for(const button of side.querySelectorAll('[data-create-placeholder]'))button.onclick=()=>{
    const issue=issues[Number(button.dataset.createPlaceholder)];
    workspaceUI.createMissing(issue.destination,issue.source).catch(fail);
  };
  for(const button of side.querySelectorAll('[data-fix-issue]'))button.onclick=async()=>{
    button.disabled=true;
    try {
      const issue=issues[Number(button.dataset.fixIssue)];
      const candidate=issue.candidates[Number(button.dataset.candidate)];
      flushLive();
      const previous=findDocumentTab(issue.source)?.text ?? (await platform.fs.read(issue.source)).text;
      await updatePkmNote(issue.source,previous,replaceReference(previous,issue,candidate.identifier));
      await renderHealth();
      toast('已将引用指向 '+candidate.label);
    } catch(error){fail(error);}
    finally{button.disabled=false;}
  };
}

async function lockWorkspace(work) {
  if (workspaceBusy) return;
  flushLive();
  workspaceBusy = true;
  let settled;
  workspaceSettled=new Promise(resolve=>{settled=resolve;});
  $('.workspace').inert = true;
  const pending = tabs.filter(tab=>tab.saving).map(tab=>tab.saving);
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  try {
    await Promise.allSettled(pending);
    return await work();
  } finally {
    workspaceBusy = false;
    workspaceSettled=undefined;
    settled();
    $('.workspace').inert = false;
    for(const tab of tabs) scheduleSave(tab);
  }
}

async function refreshWorkspaceView() {
  if (!current()) activeId = tabs[0]?.id || '';
  mode = supportedMode(current()?.viewMode||mode);
  syncEditors();
  restoreScroll();
  renderTabs();
  stats();
  revealActiveFile();
  renderSide();
  backlinks().catch(fail);
  await persist();
}

function applyEditorText(text) {
  const tab = current();
  if (!tab || tab.text === text) return;
  updateText(text);
  syncEditors();
}

async function generateReferences(){
  flushLive();
  const tab=current();
  if(!tab?.path)return toast('请先保存文档');
  if(!root)return toast('请先打开工作区');
  const previous=tab.text;
  const {text,count}=await updateReferenceDefinitions(previous,async destinations=>{
    const targets=[];
    for(let i=0;i<destinations.length;i+=256)targets.push(...await platform.index.links({
      source:tab.path,destinations:destinations.slice(i,i+256)
    }));
    return targets.map(target=>target?.status==='ok'?target:null);
  },path=>relativeNotePath(tab.path,path,fileKey));
  if(current()!==tab||tab.text!==previous)return toast('笔记已变化，请重新生成引用定义');
  if(text!==previous)await updatePkmNote(tab.path,previous,text);
  toast('已补全 '+count+' 条标准引用定义');
}

function flagConflict(tab,disk,origin) {
  const first=!tab.conflict;
  tab.conflict={...disk,origin};
  scheduleSave(tab);
  if (first&&origin==='sync') {
    const stamp=localTimestamp();
    const path=tab.path.replaceAll('\\','/'),name=base(tab.path);
    const suffix=name.match(/\.[^.]+$/)?.[0]||'.md';
    const copy=name.slice(0,-suffix.length)+' (同步草稿 '+stamp+' '+(Date.now()%1000000)+')'+suffix;
    platform.workspace.edit({type:'note',parent:path.slice(0,path.lastIndexOf('/')),name:copy,text:tab.text})
      .then(async result=>{
        if(!tab.conflict||tab.conflict.origin!=='sync')return;
        tab.conflict.copy=result.path;session();
      }).catch(error=>console.warn(errorMessage(error)));
  }else if(first&&tab===current())toast('文件已被其他程序修改，请查看差异');
}

function renderExternalNotice(tab) {
  const notice=$('#external-change');
  const state=tab?.deleted?'deleted':tab?.conflict?'conflict':'';
  notice.hidden=!state;
  if (notice.dataset.state===state) return;
  notice.dataset.state=state;
  if (state==='deleted') notice.innerHTML='<span role="status">原文件已从磁盘删除，当前内容仍可另存。</span>'+
    '<button data-external-action="save-as">另存为</button><button data-external-action="close">关闭标签</button>';
  else if (state==='conflict') notice.innerHTML='<span role="status">'+(tab.conflict.origin==='sync'?'同步版本已到达，当前草稿已保留。':'磁盘上的笔记已修改，当前草稿已保留。')+'</span>'+
    '<button data-external-action="diff">查看差异</button><button data-external-action="reload">加载磁盘版本</button>'+
    '<button data-external-action="keep">保留当前草稿</button>';
  else notice.replaceChildren();
}

function replaceFromDisk(tab,disk,keepDraft=false) {
  tab.saved=disk.text;
  tab.mtime=disk.mtime;
  tab.needsLf=disk.needsLf;
  if (!keepDraft) tab.text=disk.text;
  tab.dirty=tab.text!==tab.saved;
  tab.holdAutoSave=keepDraft&&tab.dirty;
  delete tab.deleted;
  delete tab.conflict;
  scheduleSave(tab);
}

async function resolveExternalNotice(action) {
  const tab=current();
  if (!tab) return;
  if (action==='diff'&&tab.conflict) return showHistory(tab,tab.conflict);
  if (action==='close') return closeTab(tab.id);
  if (action==='save-as') return save(tab,true);
  if (!tab.conflict) return;
  const path=tab.path;
  const disk=await platform.fs.read(path);
  if (tab.path!==path||!tabs.includes(tab)) return;
  if (tab===current()) {flushLive();captureEditors();}
  replaceFromDisk(tab,disk,action==='keep');
  if (tab===current()&&action==='reload') {syncEditors();restoreScroll();}
  renderTabs();stats();workspaceFeatures.refreshSplit();session();
  if (tab===current()&&mode==='source') source.focus();
  if (tab===current()&&mode==='live') liveView().focus();
  backlinks().catch(fail);
}

$('#external-change').addEventListener('click',event=>{
  const action=event.target.closest('[data-external-action]')?.dataset.externalAction;
  if (action) resolveExternalNotice(action).catch(fail);
});

async function updateTabsFromDisk(batch) {
  if (root!==batch.root) return;
  await workspaceSettled;
  if (root!==batch.root) return;
  const byPath=new Map(batch.changes.map(change=>[fileKey(change.path),change]));
  const removedDirs=batch.changes.filter(change=>change.type==='unlinkDir');
  const affected=tabs.filter(tab=>tab.path&&(byPath.has(fileKey(tab.path))||removedDirs.some(change=>containsPath(change.path,tab.path,fileKey))));
  const snapshots=await Promise.all(affected.map(async tab=>{
    const path=tab.path, change=byPath.get(fileKey(path));
    await tab.saving?.catch(()=>{});
    if (change?.type==='unlink'||!change) return {tab,path,deleted:true};
    const disk=await platform.fs.read(path).catch(()=>null);
    return {tab,path,disk};
  }));
  if (root!==batch.root) return;
  let refresh=false, changed=false;
  flushLive();
  for (const {tab,path,disk,deleted} of snapshots) {
    if (tab.path!==path||!tabs.includes(tab)) continue;
    if (deleted) {
      tab.deleted=true;
      delete tab.conflict;
      scheduleSave(tab);
    } else if (disk) {
      delete tab.deleted;
      const baseline=disk.text===tab.saved;
      if (!tab.dirty||disk.text===tab.text) {
        if (tab===current()&&tab.text!==disk.text) {captureEditors();refresh=true;}
        replaceFromDisk(tab,disk);
      } else if (baseline) {
        tab.mtime=disk.mtime;
        delete tab.conflict;
        scheduleSave(tab);
      } else flagConflict(tab,disk,batch.source);
    } else continue;
    changed=true;
  }
  if (refresh) {syncEditors();restoreScroll();}
  if (changed) {renderTabs();stats();workspaceFeatures.refreshSplit();session();}
}

let externalChanges=Promise.resolve();
function enqueueVaultChange(batch) {
  externalChanges=externalChanges.catch(fail).then(async()=>{
    if (root!==batch.root) return;
    await workspaceSettled;
    if (root!==batch.root) return;
    if (loadingTree) initialTreeChanges.push(...batch.changes);
    if(batch.tree)files=batch.tree;
    else updateTree(files,root,batch.changes,fileKey);
    if (pane==='files') {
      const side=$('#side-content'), top=side.scrollTop;
      renderSide();
      side.scrollTop=top;
    } else if (pane==='tags') await renderTags();
    else if(pane==='health')await renderHealth();
    else if (pane==='search'&&renderSide.query) search(renderSide.query).catch(fail);
    await updateTabsFromDisk(batch);
    backlinks().catch(fail);
  });
  externalChanges.catch(fail);
}

function mountWritingSettings(panel,{mobile}) {
  const select = (value,label) => '<option value="'+value+'" '+(preferences.attachmentStrategy===value?'selected':'')+'>'+label+'</option>';
  const field = (key,label) => '<label>'+label+'<input name="'+key+'" value="'+escape(preferences[key])+'"></label>';
  const checkbox = (key,label) => settingToggle(key,label,{checked:preferences[key]});
  const directories='<label>图片保存位置<select name="attachmentStrategy">'+select('workspace','工作区根目录')+select('note','文档所在目录')+'</select></label>'+
    field('workspaceAttachments','工作区附件子目录')+field('noteAttachments','文档附件子目录（可用 ${filename}）')+
    field('newNoteDirectory','新建双链笔记的工作区子目录（留空使用当前目录）')+
    field('templateDirectory','模板目录（相对工作区）')+
    field('dailyDirectory','每日笔记目录（相对工作区）')+
    field('dailyFilePattern','每日笔记文件名格式（YYYY、MM、DD）')+
    field('dailyTemplate','每日笔记模板文件路径（相对工作区，可留空）');
  const compression=checkbox('webpCompression','粘贴大图自动转为 WebP')+
    '<label>最大宽度（px）<input name="webpWidth" type="number" min="256" max="3840" required value="'+preferences.webpWidth+'"></label>'+
    '<label>WebP 质量<input name="webpQuality" type="number" min=".1" max="1" step=".01" required value="'+preferences.webpQuality+'"></label>';
  const editing='<label>每篇笔记的快照数<input name="historyLimit" type="number" min="1" max="100" required value="'+preferences.historyLimit+'"></label>'+
    checkbox('typewriter','打字机模式')+checkbox('paragraphFocus','段落聚焦')+
    (mobile?checkbox('mobileLiveEditing','启用即时编辑（实验性）'):checkbox('vim','源码模式启用 Vim 键位'));
  const formulas=checkbox('numberEquations','自动编号块级公式')+
    '<label>KaTeX 宏<textarea name="macroInput" rows="4" maxlength="32000">'+
    escape(Object.entries(preferences.macros||{}).map(([key,value])=>key+' = '+value).join('\n'))+'</textarea></label>';
  const save='<p role="status"></p><div class="feature-buttons"><button class="primary" type="submit">保存设置</button></div>';
  panel.innerHTML=mobile?'<form class="lg-settings-form"><div class="lg-settings-scroll">'+
    settingsGroup('目录与附件',directories)+settingsGroup('图片压缩',compression)+
    settingsGroup('编辑体验',editing)+settingsGroup('公式宏',formulas)+
    '</div><div class="lg-footer">'+save+'</div></form>':
    '<form>'+settingsGroup('目录与附件',directories)+settingsGroup('图片压缩',compression)+
    settingsGroup('编辑体验',editing)+settingsGroup('公式宏',formulas)+'<div class="lg-footer">'+save+'</div></form>';
  const fields=panel.querySelector('form'),status=fields.querySelector('[role=status]'),button=fields.querySelector('[type=submit]');
  fields.addEventListener('submit',async event=>{
    event.preventDefault();
    button.disabled=true;
    try {
      await saveWritingSettings(new FormData(fields));
      status.textContent='设置已保存。';
    } catch(error) {
      status.textContent=errorMessage(error);
      fail(error);
    } finally {button.disabled=false;}
  });
}

async function saveWritingSettings(form) {
  const candidate = {...preferences,...Object.fromEntries(form)};
  for (const key of ['workspaceAttachments','noteAttachments','newNoteDirectory']) {
    const folder=candidate[key].trim();
    if (key==='newNoteDirectory'&&!folder) { candidate[key]=''; continue; }
    if (!folder || folder.replace(/^\.[\\/]/,'').split(/[\\/]/).some(part=>!part||/^[.]|[. ]$|[:*?"<>|]/.test(part))) {
      throw Error('请输入相对工作区或文档目录的子目录路径。');
    }
    candidate[key]=folder;
  }
  candidate.historyLimit=Number(candidate.historyLimit);
  candidate.webpCompression=form.has('webpCompression');
  candidate.webpWidth=Number(candidate.webpWidth);
  candidate.webpQuality=Number(candidate.webpQuality);
  for (const key of ['templateDirectory','dailyDirectory','dailyTemplate']) {
    const value=String(candidate[key]||'').trim().replaceAll('\\','/');
    if (value && value.split('/').some(part=>!part||/^[.]|[. ]$|[:*?"<>|]/.test(part))) {
      throw Error('模板和每日笔记设置需要工作区内的相对路径。');
    }
    candidate[key]=value;
  }
  dailyNoteName(candidate.dailyFilePattern,new Date());
  candidate.typewriter=form.has('typewriter');
  candidate.paragraphFocus=form.has('paragraphFocus');
  if(!mobileLayout())candidate.vim=form.has('vim');
  candidate.numberEquations=form.has('numberEquations');
  if(mobileLayout())candidate.mobileLiveEditing=form.has('mobileLiveEditing');
  candidate.macros=parseMacros(candidate.macroInput||'');
  delete candidate.macroInput;
  await platform.preferences.saveFeatures(candidate);
  preferences=candidate;
  if(mobileLayout()&&mode==='live'&&!candidate.mobileLiveEditing)await setMode('source');
  updateVim();
  refreshLiveMath(liveView(),preferences.macros);
  if(mode==='read')renderRead();
  workspaceFeatures?.refreshSplit();
  editorTools.updateFocus();
  toast('设置已保存');
}

async function showExportSettings() {
  const pdf=preferences.pdf||{};
  const form=await workspaceUI.ask('PDF 与公式设置',
    '<label>纸张<select name="paper">'+['A4','A5','Letter'].map(paper=>'<option '+(pdf.paper===paper?'selected':'')+'>'+paper+'</option>').join('')+'</select></label>'+
    '<label>上下边距（英寸）<input name="vertical" type="number" min=".25" max="2" step=".05" value="'+(pdf.vertical??.5)+'" required></label>'+
    '<label>左右边距（英寸）<input name="horizontal" type="number" min=".25" max="2" step=".05" value="'+(pdf.horizontal??.55)+'" required></label>'+
    '<label>页眉（可用 {{title}}）<input name="header" maxlength="160" value="'+escape(pdf.header||'')+'"></label>'+
    '<label>页脚（可用 {{title}}）<input name="footer" maxlength="160" value="'+escape(pdf.footer||'')+'"></label>'+
    settingToggle('pageNumbers','显示页码',{checked:pdf.pageNumbers})+
    settingToggle('chapters','按一级标题分页',{checked:pdf.chapters})+
    settingToggle('numberEquations','自动编号块级公式',{checked:preferences.numberEquations}),'保存设置');
  if(!form)return;
  preferences={...preferences,numberEquations:form.has('numberEquations'),pdf:{
    paper:form.get('paper'),vertical:Number(form.get('vertical')),horizontal:Number(form.get('horizontal')),
    header:form.get('header'),footer:form.get('footer'),pageNumbers:form.has('pageNumbers'),chapters:form.has('chapters')
  }};
  await platform.preferences.saveFeatures(preferences);
  if(mode==='read')await renderRead();
  workspaceFeatures?.refreshSplit();
}
async function setWritingOption(action) {
  const key = action==='typewriter'?'typewriter':'paragraphFocus';
  preferences={...preferences,[key]:!preferences[key]};
  await platform.preferences.saveFeatures(preferences);
  editorTools.updateFocus();
  if(mode==='live')liveView().focus();
  if(mode==='source')source.focus();
  toast((action==='typewriter'?'打字机模式':'段落聚焦')+(preferences[key]?'已开启':'已关闭'));
}

let historyDialog, historyEditor, historySerial=0;
async function showHistory(tab, conflict) {
  if (!tab?.path) { if (!conflict) toast('请先保存笔记'); return; }
  if (tab===current()) flushLive();
  const serial=++historySerial;
  const snapshots=await platform.fs.history(tab.path).catch(error=>{if(conflict)return [];throw error;});
  if (serial!==historySerial) return;
  if (!historyDialog) {
    historyDialog=document.createElement('dialog');
    historyDialog.className='feature-dialog history-dialog';
    historyDialog.addEventListener('close',()=>{
      if(historyDialog.open)return;
      historySerial++;historyEditor?.destroy();historyEditor=null;
    });
    document.body.append(historyDialog);
  }
  historyEditor?.destroy();
  historyEditor=null;
  historyDialog.innerHTML='<header><h2>'+escape(conflict?.row?'同步冲突':conflict?'外部修改冲突':'版本历史')+'</h2><form method="dialog"><button aria-label="关闭版本历史">×</button></form></header>'+
    '<p>'+escape(tab.name)+'　绿色为当前版本增加的内容，红色为选中版本原有的内容。</p>'+
    '<div class="history-controls"><select aria-label="比较版本">'+(conflict?'<option value="disk">磁盘版本</option>':'')+
    snapshots.map(row=>'<option value="'+escape(row.id)+'">'+escape(new Date(row.time).toLocaleString('zh-CN')+
      (row.label?' · '+row.label:row.id==='legacy'?' · 旧备份':''))+'</option>').join('')+'</select>'+
    '<button type="button" data-version="restore" hidden>恢复此版本</button><button type="button" data-version="copy" hidden>另存为新笔记</button>'+
    (conflict?.row?'<button data-sync-choice="keep">保留当前版本</button><button data-sync-choice="apply">采用冲突版本覆盖</button>'+
      (markdownPath.test(tab.path)?'<button data-sync-choice="manual">手动编辑合并</button>':''):conflict?'<button data-conflict="copy">另存为</button>':'')+
    '</div><div class="history-diff"></div>';
  const select=historyDialog.querySelector('select');
  const parent=historyDialog.querySelector('.history-diff');
  if(conflict?.row) {
    const versions=document.createElement('details');
    versions.innerHTML='<summary>查看完整版本</summary><div class="sync-versions"><section><h3>当前版本</h3><pre></pre></section><section><h3>冲突版本</h3><pre></pre></section></div>';
    const [ours,theirs]=versions.querySelectorAll('pre');
    ours.textContent=tab.text;theirs.textContent=conflict.text;
    historyDialog.append(versions);
  }
  let viewSerial=0;
  const restore=historyDialog.querySelector('[data-version="restore"]');
  const copyVersion=historyDialog.querySelector('[data-version="copy"]');
  let selectedVersion;
  async function compare() {
    const version=++viewSerial;
    const id=select.value;
    selectedVersion=null;
    restore.hidden=copyVersion.hidden=true;
    if(!id){parent.textContent='暂无历史快照';select.disabled=true;return;}
    const before=id==='disk'?conflict.text:await platform.fs.history(tab.path,id);
    if(serial!==historySerial||version!==viewSerial)return;
    historyEditor?.destroy();
    historyEditor=diffView(parent,before,tab.text);
    if(id!=='disk'){
      selectedVersion={id,text:before};
      restore.hidden=!id.startsWith('sync-')&&!tabs.includes(tab);
      copyVersion.hidden=false;
    }
  }
  select.addEventListener('change',()=>compare().catch(fail));
  restore.onclick=async()=>{
    if(!selectedVersion||restore.disabled)return;
    restore.disabled=true;
    try{
      if(tab===current())flushLive();
      if(tab.dirty||tab.conflict)throw Error('请先保存或另存当前草稿。');
      const {id,text}=selectedVersion;
      if(id.startsWith('sync-'))await platform.sync.restoreVersion(tab.path,id);
      else {
        const saved=await platform.fs.save({path:tab.path,text,saved:tab.saved,mtime:tab.mtime});
        if(!saved||saved.conflict)throw Error('文件已修改，请重新打开版本历史。');
      }
      if(tabs.includes(tab))await updateTabsFromDisk({root,changes:[{path:tab.path,type:'change'}]});
      historyDialog.close();
      toast('已恢复历史版本');
    }catch(error){fail(error);}
    finally{restore.disabled=false;}
  };
  copyVersion.onclick=async()=>{
    if(!selectedVersion||copyVersion.disabled)return;
    copyVersion.disabled=true;
    try{
      const name=tab.name.replace(/\.(?:md|markdown|mdown)$/i,'')+'（历史版本）.md';
      const saved=await platform.fs.save({name,text:selectedVersion.text,saveAs:true});
      if(saved?.path){
        historyDialog.close();
        files=await platform.workspace.tree();
        await openFile(saved.path);
        toast('已另存为新笔记');
      }
    }catch(error){fail(error);}
    finally{copyVersion.disabled=false;}
  };
  historyDialog.querySelector('[data-conflict="copy"]')?.addEventListener('click',()=>{
    historyDialog.close();
    save(tab,true).catch(fail);
  });
  for(const button of historyDialog.querySelectorAll('[data-sync-choice]'))button.addEventListener('click',()=>{
    const choice=button.dataset.syncChoice;
    if(choice==='manual') {
      manualSyncConflict=conflict.row;
      historyDialog.close();
      if(tabs.includes(tab))activate(tab.id).then(()=>setMode(nativeMobile?'source':'live')).catch(fail);
      else openFile(conflict.row.path).then(opened=>{
        if(!opened&&conflict.row.copy)return openFile(conflict.row.copy);
      }).catch(fail);
      drawSyncConflict();
      return;
    }
    button.disabled=true;
    resolveSyncRow(conflict.row,choice).then(()=>historyDialog.close()).catch(fail).finally(()=>{button.disabled=false;});
  });
  if(!historyDialog.open)showDialog(historyDialog);
  await compare();
}

async function reopenClosed() {
  while (closedFiles.length) {
    const path=closedFiles.shift();
    session();
    try { await platform.fs.read(path); }
    catch {
      if (!root||relativePath(path)===path.replaceAll('\\','/')) return openExternalFiles(await platform.fs.open(path));
      continue;
    }
    return openFile(path);
  }
  toast('没有可重新打开的文档');
}
function installTabActions() {
  const bar=$('#tabs');
  bar.addEventListener('scroll',()=>syncTabEdges(bar),{passive:true});
  bar.addEventListener('focusin',event=>{
    if (event.target.matches(':focus-visible')) revealTab(bar,event.target.closest('.tab'));
  });
  new ResizeObserver(()=>revealTab(bar)).observe(bar);
  let dragged;
  const row=event=>event.target.closest('[data-tab]');
  bar.addEventListener('dragstart',event=>{
    if(!row(event))return;
    dragged=row(event).dataset.tab;
    event.dataTransfer.setData('application/x-calcite-tab',dragged);
    event.dataTransfer.effectAllowed='move';
  });
  bar.addEventListener('dragend',()=>{dragged=undefined;});
  bar.addEventListener('dragover',event=>{if(dragged&&row(event))event.preventDefault();});
  bar.addEventListener('drop',event=>{
    const target=row(event)?.dataset.tab;
    if(!dragged||!target||dragged===target)return;
    event.preventDefault();
    const from=tabs.findIndex(tab=>tab.id===dragged), to=tabs.findIndex(tab=>tab.id===target);
    if(from<0||to<0)return;
    tabs.splice(to,0,tabs.splice(from,1)[0]);
    dragged=undefined;
    renderTabs(); session();
  });

}
let exportSelection;
function installFeatures() {
  installTabActions();
  outlineUI=installOutline({$,escape,headings,active:current,mode:()=>mode,source:()=>source});
  linkCompletion=installLinkCompletion({$,active:current,mode:()=>mode,liveView,source:()=>source,files:flat,
    lookup:async (path,destination)=>(await platform.index.links({source:path,destinations:[destination],headings:true}))[0],
    relative:relativePath,key:fileKey,onError:fail});
  $('#file-sort').addEventListener('click', async () => {
    try {
      const options = [['name','名称（自然数字顺序）'],['modified','最近修改'],['created','创建时间']];
      const form = await workspaceUI.ask('文件排序','<label>排序方式<select name="sort">'+
        options.map(([value,label])=>'<option value="'+value+'" '+(treeSort===value?'selected':'')+'>'+label+'</option>').join('')+
        '</select></label>'+(mobileLayout()?settingToggle('descending','降序',{checked:treeDescending}):
          settingToggle('descending','降序',{checked:treeDescending})));
      if (!form) return;
      treeSort=form.get('sort');
      treeDescending=form.has('descending');
      renderSide();
      session();
    } catch (error) { fail(error); }
  });
  for (const scroller of [$('#live-scroll'),$('#reading'),source.scrollDOM]) {
    scroller.addEventListener('scroll',()=>{
      const tab=current();
      if(tab&&scroller===activeScroll()) {
        (tab.scrollByMode??={})[mode]=scroller.scrollTop;
        session();
      }
    },{passive:true});
  }
  workspaceUI=createWorkspaceUI({
    platform,$,escape,base,active:current,getRoot:()=>root,getTabs:()=>tabs,getTree:()=>files,
    setTree(rows,edit,result){
      files=rows;
      if(edit.path && ['move','rename','trash'].includes(edit.type)) {
        const prefix=edit.path.toLocaleLowerCase();
        workspaceState().bookmarks=workspaceState().bookmarks.flatMap(item=>{
          const path=item.path.toLocaleLowerCase();
          if(path!==prefix&&!path.startsWith(prefix+'\\')&&!path.startsWith(prefix+'/'))return [item];
          return result.path?[{...item,path:result.path+item.path.slice(edit.path.length)}]:[];
        });
      }
      if(edit.type==='move')expanded.add(edit.parent);
      if(edit.type==='note'||edit.type==='folder')expanded.add(edit.parent);
      if(expanded.delete(edit.path)&&result.path)expanded.add(result.path);
    },
    refresh:refreshWorkspaceView,openFile,flush:flushLive,withLocked:lockWorkspace,toast,fail,settings:()=>preferences
  });
  const readText=async path=>tabs.find(tab=>tab.path===path)?.text ?? (await platform.fs.read(path)).text;
  const updateNote=updatePkmNote=async (path,previous,text)=>{
    const tab=findDocumentTab(path);
    if(tab){
      if(tab===current())flushLive();
      if(tab.text!==previous)throw Error('笔记已变化，请刷新后重试。');
      if(tab===current())applyEditorText(text);
      else {tab.text=text;tab.dirty=text!==tab.saved;}
      if(!await save(tab))throw Error('修改仍保留在草稿中，请先解决保存冲突。');
      return;
    }
    const disk=await platform.fs.read(path);
    if(disk.text!==previous)throw Error('笔记已变化，请刷新后重试。');
    const result=await platform.fs.save({path,text,saved:disk.text,mtime:disk.mtime});
    if(!result||result.conflict)throw Error('笔记已被其他程序修改。');
  };
  noteWorkflows=createNoteWorkflows({platform,ask:workspaceUI.ask,escape,getRoot:()=>root,files:flat,relative:relativePath,read:readText,
    active:current,applyText:applyEditorText,insert:markdown=>editorTools.insertTemplate(markdown),open:openFile,updateNote,
    refresh:async (rows,parent)=>{files=rows;expanded.add(parent);renderSide();},settings:()=>preferences,toast});
  workspaceFeatures=createWorkspaceViews({$,platform,ask:workspaceUI.ask,escape,base,relative:relativePath,root:()=>root,headingMatches,
    files:flat,tabs:()=>tabs,active:current,render:renderContent,diagrams:renderDiagrams,
    open:openFile,openHeading:async(path,label)=>{if(await openFile(path)&&label)jumpHeading(headings().findIndex(row=>row.text===label));},
    editProperty:noteWorkflows.editProperty,saveTab:save,remember:()=>{session();syncDocumentButtons();},config:workspaceState,toast,fail,
    changeTab(tab,text){
      tab.text=text;tab.dirty=text!==tab.saved;renderTabs();session();
      scheduleSave(tab);
    }
  });
  editorTools=installEditorTools({
    $,platform,crepe,liveView,source,active:current,getMode:()=>mode,settings:()=>preferences,
    save,fail,toast,sanitize:(...args)=>DOMPurify.sanitize(...args),applyText:applyEditorText,flush:flushLive,
    openSourceSearch:()=>openSearchPanel(source)
  });
  installContextMenus();
  const editors=$('.editor-section');
  const popup=document.createElement('aside');
  popup.className='hover-preview prose';
  popup.hidden=true;
  popup.setAttribute('role','tooltip');
  document.body.append(popup);
  let hovered, timer, previewSerial=0, ctrl=false, touch, suppressClick;
  function dismiss() {
    clearTimeout(timer);
    previewSerial++;
    popup.hidden=true;
  }
  const previewLink=target=>target.closest('#reading a,#live-editor a,#live-editor .live-wiki');
  async function showPreview(link,serial,mobile=false){
    const href=link.getAttribute('href')||'';
    const wikiPrefix='calcite-wiki://';
    const isWiki=Boolean(link.dataset.wiki)||href.startsWith(wikiPrefix);
    const destination=link.dataset.wiki||(isWiki?decodeURIComponent(href.slice(wikiPrefix.length)):href);
    if(!isWiki&&!destination.startsWith('#')&&!noteExtension.test(destination.split('#')[0]))return;
    const path=link.dataset.noteSource||current()?.path;
    const target=await platform.index.target({source:path,destination,wiki:isWiki});
    if(serial!==previewSerial)return;
    const preview=document.createElement('div');
    preview.className='prose';
    if(target){
      const text=findDocumentTab(target.path)?.text ?? (await platform.fs.read(target.path)).text;
      preview.innerHTML=renderMarkdown(liveNote(text).body);
      if(target.heading)preview.replaceChildren(...sectionNodes(preview,target.heading));
      if(!preview.hasChildNodes())preview.textContent='找不到链接目标章节';
      for(const anchor of preview.querySelectorAll('a'))anchor.dataset.noteSource=target.path;
      await resolveImages(preview,target.path);
    }else if(isWiki){
      const [detail]=await platform.index.links({source:path,destinations:[destination]});
      preview.textContent=detail?.status==='ambiguous'?'有多篇同名笔记，请在体检中指定目标。':'笔记尚未创建。';
    }else return;
    if(serial!==previewSerial)return;
    const label=target?base(target.path):destination;
    if(mobile){
      mobileShell.panel(label,'link-preview',(content,close)=>{
        const open=document.createElement('button');
        open.type='button';
        open.className='primary';
        open.textContent=target?'打开原稿':'查看链接';
        open.onclick=()=>{close();wiki(destination,isWiki,path).catch(fail);};
        content.append(preview,open);
      });
      return;
    }
    const heading=document.createElement('strong');
    heading.className='preview-label';
    heading.textContent=label;
    popup.replaceChildren(heading,preview);
    popup.hidden=false;
    const rect=link.getBoundingClientRect();
    popup.style.left=Math.max(8,Math.min(rect.left,innerWidth-popup.offsetWidth-8))+'px';
    const top=$('.titlebar').getBoundingClientRect().bottom+6;
    popup.style.top=Math.max(top,rect.bottom+popup.offsetHeight+14<=innerHeight?rect.bottom+6:rect.top-popup.offsetHeight-6)+'px';
    popup.scrollTop=0;
  }
  function schedule() {
    dismiss();
    const link=hovered;
    if(!link||(!ctrl&&!link.dataset.wiki))return;
    const serial=previewSerial;
    timer=setTimeout(()=>showPreview(link,serial).catch(console.warn),250);
  }
  editors.addEventListener('pointerover',event=>{
    const link=previewLink(event.target);
    if(event.pointerType!=='touch'&&link&&link!==hovered){hovered=link;ctrl=event.ctrlKey||event.metaKey;schedule();}
  });
  editors.addEventListener('pointerout',event=>{
    if(hovered?.contains(event.target)&&!hovered.contains(event.relatedTarget)){
      hovered=null;dismiss();
    }
  });
  editors.addEventListener('pointerdown',event=>{
    const link=previewLink(event.target);
    if(event.pointerType!=='touch'||!link?.dataset.wiki)return;
    dismiss();
    const serial=previewSerial;
    touch={link,id:event.pointerId,x:event.clientX,y:event.clientY};
    timer=setTimeout(()=>{
      suppressClick={link,expires:performance.now()+1200};
      showPreview(link,serial,true).catch(console.warn);
    },500);
  });
  editors.addEventListener('pointermove',event=>{
    if(touch?.id===event.pointerId&&Math.hypot(event.clientX-touch.x,event.clientY-touch.y)>10){
      clearTimeout(timer);touch=null;
    }
  });
  for(const name of ['pointerup','pointercancel'])editors.addEventListener(name,event=>{
    if(touch?.id===event.pointerId){clearTimeout(timer);touch=null;}
  });
  editors.addEventListener('contextmenu',event=>{
    if((touch?.link||(suppressClick?.expires>performance.now()?suppressClick.link:null))?.contains(event.target)){
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },true);
  document.addEventListener('click',event=>{
    if(!suppressClick||performance.now()>=suppressClick.expires)return;
    if(event.pointerType==='touch'||event.sourceCapabilities?.firesTouchEvents||
      suppressClick.link.contains(event.target)||event.target.matches('dialog[data-kind="link-preview"]')){
      suppressClick=undefined;
      event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  const live=$('#live-editor');
  let liveStatusFrame, liveLookup;
  function scheduleLiveStatus(){
    if(liveStatusFrame!==undefined)return;
    liveStatusFrame=requestAnimationFrame(async()=>{
      liveStatusFrame=undefined;
      const tab=current(), path=tab?.path;
      if(mode!=='live'||!path||liveLookup===path)return;
      const view=liveView();
      const destinations=[...new Set([...live.querySelectorAll('.live-wiki:not([data-link-status])')].map(el=>el.dataset.wiki))];
      if(!destinations.length)return;
      liveLookup=path;
      try{
        const results=await lookupWikiStates(destinations,path);
        if(mode!=='live'||current()!==tab||tab.path!==path)return;
        const state=liveWikiStatus.getState(view.state);
        view.dispatch(view.state.tr.setMeta(liveWikiStatus,{path,links:new Map([...state.links,...results])}));
      }catch(error){console.warn(error);}
      finally{if(liveLookup===path)liveLookup=undefined;}
    });
  }
  new MutationObserver(scheduleLiveStatus).observe(live,{childList:true,subtree:true});
  document.addEventListener('pointerdown',event=>{
    suppressClick=undefined;
    if(event.pointerType!=='touch'){hovered=null;dismiss();}
  },true);
  editors.addEventListener('scroll',()=>{if(hovered){hovered=null;dismiss();}},{capture:true,passive:true});
  document.addEventListener('keydown',event=>{
    if((event.key==='Control'||event.key==='Meta')&&!ctrl){ctrl=true;schedule();}
    if(event.key==='Escape')dismiss();
  });
  document.addEventListener('keyup',event=>{
    if(!event.ctrlKey&&!event.metaKey&&ctrl){ctrl=false;if(!hovered?.dataset.wiki)dismiss();}
  });
  window.addEventListener('blur',()=>{ctrl=false;hovered=null;dismiss();});
  document.addEventListener('selectionchange',()=>{
    const selection=window.getSelection();
    if(!selection?.rangeCount||selection.isCollapsed)return;
    const range=selection.getRangeAt(0);
    const reading=$('#reading .reading-content');
    if(mode==='read'&&reading?.contains(range.commonAncestorContainer)){
      const div=document.createElement('div');
      div.append(range.cloneContents());
      exportSelection={id:current()?.id,mode,text:current()?.text,html:div.innerHTML};
    }
  });
  editors.addEventListener('pointerdown',event=>{
    if(event.button===0&&event.target.closest('#reading,#live-editor,#source-editor'))exportSelection=null;
  });
}


function selectedExportContent(tab) {
  if(mode==='source'&&!source.state.selection.main.empty) {
    return {markdown:source.state.sliceDoc(source.state.selection.main.from,source.state.selection.main.to)};
  }
  if(mode==='live'&&!liveView().state.selection.empty) {
    return {markdown:crepe.editor.action(ctx=>{
      const state=liveView().state;
      return ctx.get(serializerCtx)(state.doc.type.create(null,state.selection.content().content));
    })};
  }
  if(mode==='read'&&exportSelection?.id===tab.id&&exportSelection.text===tab.text) return exportSelection;
}

async function prepareExport(tab,options,selection) {
  const div=document.createElement('div');
  if(selection?.html) {
    div.innerHTML=selection.html;
    await resolveImages(div,tab.path);
  } else {
    await renderContent(div,selection?.markdown??tab.text,tab.path,undefined,undefined,undefined,{...preferences,numberEquations:options.numberEquations});
    await renderDiagrams(div);
  }
  for(const element of div.querySelectorAll('[data-section-hidden]')) element.removeAttribute('data-section-hidden');
  for(const link of div.querySelectorAll('a[data-wiki]'))link.replaceWith(...link.childNodes);
  for(const link of div.querySelectorAll('[data-note-source]'))link.removeAttribute('data-note-source');
  await Promise.all([...div.querySelectorAll('img')].map(async img=>{
    if(img.src.startsWith('note-image:')||platform.export.isLocalImage?.(img.src))img.src=await platform.export.image(img.src);
  }));
  organizeExport(div,options);
  return div;
}
function exportMathCSS(div) {
  return div.querySelector('.katex')?katexCSS.replace(/url\(fonts\/([^)]+\.woff2)\)\s*format\("woff2"\)(?:\s*,[^;}]+)?/g,
    (_,font)=>'url('+mathFonts['../node_modules/katex/dist/fonts/'+font]+') format("woff2")'):'';
}
function defaultExportPreferences() {
  return {...exportDefaults,...preferences.pdf,numberEquations:!!preferences.numberEquations,...preferences.exportOptions};
}
async function saveExport(format,tab,settings,selection) {
  toast('正在生成 '+format.toUpperCase()+'…');
  const div=await prepareExport(tab,settings,selection);
  if (['docx','epub'].includes(format)) for(const formula of div.querySelectorAll('.katex')) {
    const math=formula.querySelector('math');
    if(math)formula.replaceWith(math);
  }
  const html=htmlDocument(tab.name,'<main>'+div.innerHTML+'</main>',exportMathCSS(div)+exportStyle(settings,format),format==='html');
  const name=tab.name.replace(noteExtension,'');
  const done=format==='pdf'?await platform.export.pdf(html,{...settings,title:name}):
    ['docx','epub'].includes(format)?await platform.export.pandoc({format,html,name}):
    await platform.export.document({format,html,name,...(format==='png'?{width:settings.pngWidth,scale:settings.pngScale}:{})});
  if(done)toast(done==='print'?'已打开系统打印，请选择「另存为 PDF」。':format.toUpperCase()+' 已导出');
  return done;
}
async function exportDocument(format) {
  flushLive();
  const tab=current();
  if(!tab)return;
  let selection=format==='png'?selectedExportContent(tab):null;
  if(format==='png') {
    const form=await workspaceUI.ask('导出图片',
      '<label>内容<select name="scope"><option value="all">整篇阅读长图</option>'+
      (selection?'<option value="selected" selected>选中内容卡片</option>':'')+'</select></label>','导出 PNG');
    if(!form)return;
    if(form.get('scope')==='all')selection=undefined;
  }
  return saveExport(format,tab,defaultExportPreferences(),selection);
}
function openExportCenter(initial='pdf',tab=current(),includeSelection=tab===current()) {
  flushLive();
  if(!tab)return;
  const selection=includeSelection?selectedExportContent(tab):undefined;
  showExportCenter({initial,formats:platform.export.formats,preferences:defaultExportPreferences(),selection,fail,
    async render(options,selected) {
      const div=await prepareExport(tab,options,selected&&selection);
      return {title:tab.name,body:div.innerHTML,mathCSS:exportMathCSS(div)};
    },
    async save(format,options,selected) {
      const done=await saveExport(format,tab,options,selected&&selection);
      if(done) {
        const next={...preferences,exportOptions:options};
        await platform.preferences.saveFeatures(next);
        preferences=next;
      }
      return done;
    }});
}
async function copyRichText(selection) {
  flushLive();
  const tab=current();
  if(!tab)return;
  const div=await prepareExport(tab,defaultExportPreferences(),selection??selectedExportContent(tab));
  const plain=div.innerText||div.textContent;
  const rich=await platform.export.rich({html:'<div>'+inlineRichStyles(div)+'</div>',text:plain});
  toast(rich===false?'已复制纯文本':'富文本已复制');
}

async function exportMarkdownPackage() {
  flushLive();
  const tab=current();
  if(!tab?.path) {toast('请先保存笔记，再打包相对路径附件。');return;}
  if(nativeMobile){
    if(await platform.export.markdown({note:tab.path,text:tab.text,format:'zip'}))toast('Markdown 便携包已导出');
    return;
  }
  const fields=await workspaceUI.ask('导出便携 Markdown 包',
    '<label>输出<select name="format"><option value="zip">ZIP 压缩包</option><option value="folder">独立文件夹</option></select></label>',
    '导出便携包');
  if(fields&&await platform.export.markdown({note:tab.path,text:tab.text,format:fields.get('format')})) toast('Markdown 便携包已导出');
}

let quitPending=false;
async function quitWorkspace(){
  if(quitPending)return;
  if(workspaceBusy){toast('文件操作进行中，请稍候');return;}
  quitPending=true;
  try {
    if(!await workspaceFeatures.beforeQuit())return;
    flushLive();
    captureEditors();
    for(const tab of tabs){
      clearTimeout(saveTimers.get(tab.id));
      if(tab.saving)await tab.saving;
    }
    await persist();
    await platform.window.quit();
  } finally {quitPending=false;}
}

let externalOpenQueue = Promise.resolve();
function openExternalFiles(paths) {
  if (!paths.length) return externalOpenQueue;
  externalOpenQueue = externalOpenQueue.catch(fail).then(async()=>{
    const status = $('#startup-status');
    try {
      status.hidden = false;
      for (const p of paths) {
        status.textContent = `正在打开 ${base(p)}…`;
        await openFile(p);
      }
    } finally {
      status.hidden = true;
    }
  });
  return externalOpenQueue;
}


function toggleMoreMenu() {
  if (floatingMenus.isOpen('more-menu')) return floatingMenus.close(true);
  const tab=current();
  const groups=documentMenu({
    run:action, label:id=>commands.find(row=>row[0]===id)?.[1]||id,
    keycaps:id=>keycaps(({...defaultShortcuts,...preferences.shortcuts})[id],mac),
    copy:copyDocumentPath,
    enabled:id=>{
      if (['renameNote','moveNote','trashNote'].includes(id)) return canBookmark(tab);
      if (['relativePath','reveal','history','portableMarkdown','linkReferences'].includes(id)) return !!tab?.path;
      if (['daily','random','vaultHealth'].includes(id)) return !!root;
      return !!tab;
    }
  });
  if(mobileLayout()){
    return showMobileDocumentMenu(tab,groups);
  }
  floatingMenus.open({id:'more-menu',label:'更多文档操作',trigger:$('[data-action="more"]'),groups});
}

function showMobileDocumentMenu(tab,groups) {
  const items=groups.flatMap(group=>group.items);
  const pick=(id,glyph,label)=>{const item=items.find(item=>item.id===id);return {...item,icon:glyph,label:label||item.label};};
  const command=(label,glyph,run,disabled=false)=>({label,icon:glyph,run,disabled});
  const exportItems=items.find(item=>item.id==='export').items
    .filter(item=>['exportCenter','pdf','png','html','portableMarkdown','copyRich'].includes(item.id)&&
      (item.id!=='pdf'||desktop||platform.export.formats?.includes('pdf')))
    .map(item=>({...item,icon:item.id==='copyRich'?'copy':item.id==='exportCenter'?'settings-2':'file-down'}));
  const views={label:'视图切换',icon:'panel-top',disabled:!tab,
    items:[['live','即时编辑'],['source','源码'],['read','阅读']]
      .filter(([id])=>id!=='live'||preferences.mobileLiveEditing)
      .map(([id,label])=>command(label,'file-text',()=>setMode(id)))};
  const format=pick('format','list-ordered');
  mobileShell.show('文档操作',[
    {label:'快捷操作',style:'tiles',items:[
      command('大纲与反链','list-tree',()=>mobileShell.openDrawer('right'),!tab),
      command('书签','bookmark',()=>action('bookmarks'),!root),
      {id:'export',label:'导出',icon:'share',disabled:!tab,items:exportItems},
      command('全库图谱','network',()=>action('graph'),!root)
    ]},
    {label:'当前笔记',style:'rows',items:[
      pick('renameNote','pencil','重命名'),command('移动到文件夹…','folder-input',()=>documentFileAction('move'),!canBookmark(tab)),pick('properties','list-checks','笔记属性'),
      {...format,disabled:!tab},pick('template','file-plus-2','插入模板'),pick('history','history','版本历史'),views
    ]},
    {label:'知识库',style:'rows',items:[
      command('知识库体检','heart-pulse',()=>action('vaultHealth'),!root),
      command('打开今日笔记','calendar-days',()=>action('daily'),!root),
      command('随机打开笔记','shuffle',()=>action('random'),!root)
    ]},
    {label:'应用设置',style:'rows',items:[
      command('外观','sun-moon',showMobileAppearance),
      command('设置中心','settings',()=>action('settings'))
    ]},
    {label:'危险操作',style:'danger',items:[pick('trashNote','trash-2','删除当前笔记')]}
  ]);
}

function showMobileAppearance() {
  mobileShell.panel('晶曜工作台','appearance',mountAppearance);
}

function syncPanelButtons() {
  const classes = document.body.classList;
  const focused = classes.contains('focus-mode');
  $('[data-action="sidebar"]').setAttribute('aria-expanded',!focused&&!classes.contains('hide-sidebar'));
  for (const button of document.querySelectorAll('[data-action="outline"]')) {
    button.setAttribute('aria-expanded',!focused&&!classes.contains('hide-outline'));
  }
  $('[data-action="focus"]').setAttribute('aria-pressed',focused);
  source?.requestMeasure();
}

function togglePanel(name) {
  const classes = document.body.classList;
  const hidden = 'hide-'+name;
  if (classes.contains('focus-mode')) {
    classes.remove('focus-mode');
    classes.remove(hidden);
  } else classes.toggle(hidden);
  syncPanelButtons();
  session();
}

function selectSidePane(next) {
  pane = next;
  document.body.classList.remove('hide-sidebar','focus-mode');
  syncPanelButtons();
  revealActiveFile();
  renderSide();
  if (pane==='search'&&!mobileLayout()) $('#workspace-search').focus();
  session();
}

function revealBreadcrumb(path,isFile=false) {
  if (!path) return;
  if (isFile && (!root || relativePath(path)===path.replaceAll('\\','/'))) return platform.fs.reveal(path);
  selectSidePane('files');
  const side = $('#side-content');
  const key = fileKey(path);
  const row = !isFile&&key===fileKey(root) ? side.querySelector('.tree-root') :
    [...side.querySelectorAll(isFile?'[data-file]':'[data-folder]')].find(node=>fileKey(isFile?node.dataset.file:node.dataset.folder)===key);
  row?.scrollIntoView({block:'nearest'});
  row?.focus({preventScroll:true});
}

const inspectorTabs = [...document.querySelectorAll('.inspector-tabs [role="tab"]')];
function selectInspector(target) {
  for (const tab of inspectorTabs) {
    const selected = tab===target;
    tab.setAttribute('aria-selected',selected);
    tab.tabIndex = selected?0:-1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
  if(target.id==='backlinks-tab')backlinks().catch(fail);
}
$('.inspector-tabs').addEventListener('click',event=>{
  const tab = event.target.closest('[role="tab"]');
  if (tab) selectInspector(tab);
});
$('.inspector-tabs').addEventListener('keydown',event=>{
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const target = inspectorTabs[event.key==='Home'?0:event.key==='End'?1:1-inspectorTabs.indexOf(event.target)];
  if (!target) return;
  selectInspector(target);
  target.focus();
});

async function action(a){
  const added = {
    bookmarks:()=>workspaceFeatures.bookmarks(),bookmarkHeading:()=>workspaceFeatures.bookmarkHeading(),
    reopen:reopenClosed,split:()=>openDocumentSplit(),graph:()=>workspaceFeatures.graph(),
    localGraph:()=>workspaceFeatures.graph(true),canvas:()=>workspaceFeatures.canvas(),bases:()=>workspaceFeatures.bases(),
    template:()=>{flushLive();return noteWorkflows.insertTemplate();},daily:()=>noteWorkflows.daily(),
    random:()=>noteWorkflows.random(),linkReferences:generateReferences,
    vaultHealth:()=>{selectSidePane('health');if(mobileLayout())mobileShell.openDrawer('left');},
    properties:()=>{flushLive();return noteWorkflows.editProperty();},exportSettings:showExportSettings,
    docx:()=>exportDocument('docx'),epub:()=>exportDocument('epub'),exportCenter:()=>openExportCenter(),copyRich:copyRichText,portableMarkdown:exportMarkdownPackage,palette,find:()=>editorTools.find(),
    searchWorkspace:()=>selectSidePane('search'),closeTab:()=>current()&&closeTab(current().id),
    nextTab:()=>cycleTab(1),previousTab:()=>cycleTab(-1),vim:toggleVim,shortcuts:()=>settingsCenter.open('shortcuts'),
    renameNote:()=>documentFileAction('rename'),trashNote:()=>documentFileAction('trash'),toggleBookmark:toggleDocumentBookmark,
    moveNote:()=>documentFileAction('move'),
    relativePath:()=>copyDocumentPath('relative'),absolutePath:()=>copyDocumentPath('absolute'),copyWiki:()=>copyDocumentPath('wiki'),
    attachments:()=>settingsCenter.open('attachments'),sync:()=>{
      if(syncPopover.matches(':popover-open'))syncPopover.hidePopover();
      return settingsCenter.open('sync');
    },
    wrapBold:()=>editorTools.wrap('**'),wrapItalic:()=>editorTools.wrap('*'),wrapCode:()=>editorTools.wrap('`'),
    wrapStrike:()=>editorTools.wrap('~~'),wrapMath:()=>editorTools.wrap('$'),
    formatTable:()=>editMarkdown((text,line)=>formatTables(text,line),true),formatTables:()=>editMarkdown(text=>formatTables(text)),
    renumberList:()=>editMarkdown(renumberList,true),tasks:()=>editMarkdownTasks(),toc:()=>editMarkdown(insertToc),
    numberHeadings:()=>editMarkdown(numberHeadings),numberAllHeadings:()=>editMarkdown(text=>numberHeadings(text,{skipH1:false})),
    clearHeadings:()=>editMarkdown(text=>numberHeadings(text,{clear:true}))
  };
  if (typeof a==='string'&&Object.hasOwn(added,a)) return added[a]();
  if (a?.type==='open-files') return openExternalFiles(a.paths);
  switch (a) {
    case 'new': return newDocument();
    case 'mobile-new-note':
      if(!root){mobileShell.closeDrawer();return newDocument();}
      if(await workspaceUI.menuAction('note',root,true))mobileShell.closeDrawer();
      return;
    case 'mobile-new-folder': return root&&workspaceUI.menuAction('folder',root,true);
    case 'mobile-sync': return showMobileSync();
    case 'open': return openExternalFiles(await platform.fs.open());
    case 'folder': return nativeMobile?manageMobileVaults():changeWorkspace(platform.workspace.folder);
    case 'close-vault': return changeWorkspace(platform.workspace.close);
    case 'refresh':
      files = await platform.workspace.tree();
      loadingTree = false;
      revealActiveFile();
      renderSide();
      backlinks().catch(fail);
      return toast('文件列表已刷新');
    case 'save': return save(workspaceFeatures.focusedTab()||current());
    case 'saveAs': return save(current(),true);
    case 'palette': return palette();
    case 'sidebar': return togglePanel('sidebar');
    case 'outline': return mobileLayout()?mobileShell.closeDrawer():togglePanel('outline');
    case 'focus':
      if (document.body.classList.toggle('focus-mode')) {
        const disappearing = document.activeElement?.closest('.sidebar, .outline-panel, .tabs, .add-tab, #split-pane');
        if (disappearing || document.activeElement===document.body) $('[data-action="focus"]').focus({preventScroll:true});
      }
      return syncPanelButtons();
    case 'theme':
      return appearance.set('theme',uiRoot.dataset.theme==='light'?'dark':'light');
    case 'autosave':
      autoSave = !autoSave;
      for (const tab of tabs) scheduleSave(tab);
      stats();
      session();
      return toast('自动保存已'+(autoSave?'开启':'关闭'));
    case 'find': return editorTools.find();
    case 'live': case 'source': case 'read': return setMode(a);
    case 'pdf': case 'html': case 'png': return exportDocument(a);
    case 'history': return showHistory(current(),current()?.conflict);
    case 'settings': return settingsCenter.open();
    case 'typewriter': case 'paragraph': return setWritingOption(a);
    case 'reveal': return current()?.path ? platform.fs.reveal(current().path) : toast('请先保存文档');
    case 'more': return toggleMoreMenu();
    case 'help': {
      const tab = tabs.find(item=>item.name==='使用指南.md');
      return tab ? activate(tab.id) : newDocument(guide,'使用指南.md');
    }
    case 'quit': return quitWorkspace();
  }
}

function changeWorkspace(choose) {
  return lockWorkspace(async()=>{
    if(nativeMobile)await Promise.allSettled(openingFiles.values());
    const workspace=await choose(tabs.filter(tab=>tab.path).map(tab=>tab.path));
    if(!workspace)return;
    flushLive();
    const previous=root;
    root=workspace.root;
    vaultSearch.reset();
    initialTreeChanges=[];
    files=workspace.tree;
    loadingTree=false;
    expanded=new Set();
    workspaceFeatures.closeSplit();
    const retained=new Set(workspace.retained.map(fileKey));
    const old=workspace.renamedFrom;
    if(old&&workspaces[old]) {
      const destination=workspace.renamedTo??root;
      const state=workspaces[destination]=workspaces[old];
      delete workspaces[old];
      const rename=row=>({...row,path:row.path?.startsWith(old+'/')?destination+row.path.slice(old.length):row.path});
      state.bookmarks=state.bookmarks.map(rename);
      if(state.mobileSession)state.mobileSession.tabs=state.mobileSession.tabs.map(rename);
    }
    if(workspace.deletedVault)delete workspaces[workspace.deletedVault];
    if(nativeMobile&&root!==previous&&!old) {
      if(previous&&workspace.deletedVault!==previous) {
        workspaces[previous]??={bookmarks:[],bases:[]};
        workspaces[previous].mobileSession={tabs:tabs.map(tabSnapshot),activeId,mode};
      }
      const restored=restoreWorkspaceSession(workspaceState().mobileSession);
      tabs=restored?.tabs??[];
      activeId=restored?.activeId??'';
      if(restored)mode=restored.mode;
      delete workspaceState().mobileSession;
    }else tabs=tabs.flatMap(tab=>{
      if(!tab.path)return [tab];
      if(retained.has(fileKey(tab.path))){
        if(old&&tab.path.startsWith(old+'/'))tab.path=(workspace.renamedTo??root)+tab.path.slice(old.length);
        return [tab];
      }
      clearTimeout(saveTimers.get(tab.id));
      saveTimers.delete(tab.id);
      return tab.dirty||tab.deleted?[{...tab,path:null,mtime:null,saved:'',dirty:true,conflict:null,deleted:false,holdAutoSave:false}]:[];
    });
    selectSidePane('files');
    await refreshWorkspaceView();
    if(nativeMobile&&workspace.initialFiles?.length&&!tabs.some(tab=>tab.path))await openExternalFiles(workspace.initialFiles);
    if(nativeMobile)syncStatus(await platform.sync.status());
    toast(workspace.warning||(workspace.deletedVault?'已删除知识库':old?'已重命名知识库':root?'已打开 '+base(root):'已关闭工作区'));
    return workspace;
  });
}

function manageMobileVaults() {
  return showVaultManager({shell:mobileShell,workspace:platform.workspace,sync:platform.sync,current:()=>root,
    change:changeWorkspace,ask:workspaceUI.ask,escape,toast,icon,glyphs});
}

function cycleTab(step) {
  if(tabs.length<2)return;
  const index=tabs.indexOf(current());
  return activate(tabs[(index+step+tabs.length)%tabs.length].id);
}

function documentFileAction(type) {
  const tab=current();
  if(root&&tab?.path&&containsPath(root,tab.path,fileKey)&&!tab.deleted) return workspaceUI.menuAction(type,tab.path,false);
}

const canBookmark=tab=>Boolean(root&&tab?.path&&!tab.deleted&&containsPath(root,tab.path,fileKey));
const bookmarkIndex=file=>workspaceState().bookmarks.findIndex(row=>fileKey(row.path)===fileKey(file)&&!row.heading);
function syncDocumentButtons(tab=current()) {
  $('#export-quick').disabled=$('#split-quick').disabled=!tab;
  const star=$('#document-star'), enabled=canBookmark(tab);
  const marked=enabled&&bookmarkIndex(tab.path)>=0;
  const label=marked?'取消收藏当前文档':'收藏当前文档';
  star.disabled=!enabled;
  star.setAttribute('aria-pressed',marked);
  star.setAttribute('aria-label',label);
  star.title=label;
}
function toggleDocumentBookmark(file=current()?.path) {
  if(!file||!root||!containsPath(root,file,fileKey))return;
  const bookmarks=workspaceState().bookmarks;
  const index=bookmarkIndex(file);
  if(index<0)return workspaceFeatures.addBookmark(file);
  bookmarks.splice(index,1);session();syncDocumentButtons();toast('已取消收藏');
}

function documentWiki(file,heading) {
  const relative=relativePath(file).replace(noteExtension,'').replace(/[\[\]#|]/g,encodeURIComponent);
  return '[['+relative+(heading?'#'+heading.replace(/[\[\]#|]/g,encodeURIComponent):'')+']]';
}

async function copyDocumentPath(type,file=current()?.path) {
  if(!file)return;
  const text=type==='absolute'?file:type==='relative'?relativePath(file):documentWiki(file);
  await platform.clipboard.writeText(text);toast('已复制');
}

function mountAttachmentSettings(panel,{mobile}) {
  if(!persisted||!root){panel.textContent='请在应用中打开工作区后扫描附件。';return;}
  const drafts=()=>{flushLive();return tabs.filter(tab=>tab.path&&tab.dirty&&!tab.deleted).map(({path,text})=>({path,text}));};
  mountAttachments(panel,{mobile,icon,glyphs,scan:()=>platform.attachments.scan(drafts()),trash:paths=>platform.attachments.trash({paths,drafts:drafts()}),
    confirm:async count=>Boolean(await workspaceUI.ask('清理孤立图片','', '移入回收站','将选中的 '+count+' 张图片移入'+(nativeMobile?' Vault 内的 .trash。':'系统回收站。'))),escape,fail});
}

function mountWorkspaceSync(panel,lifecycle) {
  if(!persisted||!root){panel.textContent='请打开工作区后配置同步。';return;}
  const dir=root;
  const sync=nativeMobile?Object.fromEntries(Object.entries(platform.sync).map(([key,call])=>[key,(...args)=>{
    if(dir!==root||lifecycle.signal.aborted)throw Error('同步设置已关闭，请重新打开后再操作。');
    return call(...args);
  }])):platform.sync;
  return mountSyncSettings(panel,{...lifecycle,sync,subscribe:platform.events.sync,
    copy:platform.clipboard.writeText,escape,fail,notify:toast,compare:showSyncConflict,history:showSyncHistory});
}

let currentSyncState,manualSyncConflict,lastSyncBackup;
async function showSyncConflict(row) {
  if(!row.path||!containsPath(root,row.path,fileKey))return;
  const workspace=root;
  const {local,incoming}=await platform.sync.conflictFiles(row.copy||row.path);
  if(workspace!==root)return;
  const tab=findDocumentTab(row.path)||{path:row.path,name:base(row.path),text:local.text};
  await showHistory(tab,{text:incoming.text,row});
}
async function showSyncHistory(path) {
  const workspace=root;
  const tab=findDocumentTab(path);
  const disk=tab?null:await platform.fs.history(path,'current');
  if(workspace===root)await showHistory(tab||{path,name:base(path),text:disk});
}
async function resolveSyncRow(row,choice) {
  const tab=findDocumentTab(row.path);
  if(tab===current())flushLive();
  if(choice==='apply'&&tab?.dirty)throw Error('当前草稿有未保存的修改，请先保存或另存草稿。');
  if(choice==='archive'&&row.copy&&(!tab||tab.deleted)){
    const copyTab=findDocumentTab(row.copy);
    if(copyTab?.dirty&&!await save(copyTab))throw Error('请先保存手动合并结果。');
    if((await platform.sync.conflictFiles(row.copy||row.path)).local.missing)choice='apply';
  }
  if(choice!=='apply'&&tab?.dirty) {
    if(tab.conflict) {
      const latest=await platform.fs.read(tab.path);
      replaceFromDisk(tab,latest,true);
    }
    if(!await save(tab))throw Error('请先保存当前草稿。');
  }
  const result=await platform.sync.resolve(row.copy||row.path,choice);
  manualSyncConflict=null;
  syncStatus(result);
}
function drawSyncConflict() {
  const banner=$('#sync-conflict-banner'),tab=current();
  const row=tab?.path&&currentSyncState?.conflicts?.find(item=>fileKey(item.path)===fileKey(tab.path));
  const editing=manualSyncConflict&&tab?.path&&
    (fileKey(manualSyncConflict.path)===fileKey(tab.path)||manualSyncConflict.copy&&fileKey(manualSyncConflict.copy)===fileKey(tab.path));
  banner.hidden=!currentSyncState?.settings?.enabled||!row&&!editing;
  banner.querySelector('span').textContent=editing?'保存手动合并结果后，可归档冲突副本。':'同步已保留冲突副本。';
  banner.querySelector('button').textContent=editing?'标记已解决':'查看同步冲突';
}
$('#sync-conflict-banner').addEventListener('click',async event=>{
  if(!event.target.closest('button'))return;
  const tab=current();
  try {
    if(manualSyncConflict&&tab?.path&&
      (fileKey(manualSyncConflict.path)===fileKey(tab.path)||manualSyncConflict.copy&&fileKey(manualSyncConflict.copy)===fileKey(tab.path))){
      await resolveSyncRow(manualSyncConflict,'archive');
      return;
    }
    const row=tab?.path&&currentSyncState?.conflicts?.find(item=>fileKey(item.path)===fileKey(tab.path));
    if(row)await showSyncConflict(row);
  }catch(error){fail(error);}
});
function syncStatus(value) {
  currentSyncState=value;
  const button=$('#sync-status'),label=syncLabel(value);
  button.textContent=label;
  button.dataset.state=value.status;
  const backup=value.logs?.find(row=>row.backup);
  if(backup&&backup.time!==lastSyncBackup){
    lastSyncBackup=backup.time;
    toast(backup.message);
  }
  if(syncPopover.matches(':popover-open'))drawDesktopSync();
  mobileShell?.sync(mobileSyncValue(value));
  drawSyncConflict();
}

let quickPair;
function drawDesktopSync() {
  const value=currentSyncState;
  if(!value)return;
  const {settings,status,progress,port}=value;
  const detail=settings.mode==='lan'&&port?'局域网共享 · 端口 '+port:'';
  syncPopover.querySelector('[role=status]').textContent=[syncLabel(value),detail,
    status==='pending'&&value.logs[0]?.message].filter(Boolean).join(' · ');
  const meter=syncPopover.querySelector('progress');
  meter.hidden=status!=='working';
  if(progress?.total) {
    meter.max=progress.total;
    meter.value=progress.done||0;
  }else meter.removeAttribute('value');
  syncPopover.querySelector('[data-sync-now]').disabled=!settings.enabled||status==='working';
  const qr=syncPopover.querySelector('[data-sync-qr]');
  qr.hidden=settings.mode!=='lan'||!root;
  qr.disabled=status==='working';
}
if(desktop) {
  $('#sync-status').onclick=()=>{
    if(syncPopover.matches(':popover-open'))return syncPopover.hidePopover();
    $('.workspace-picker').open=false;
    floatingMenus.close();
    const rect=$('#sync-status').getBoundingClientRect();
    syncPopover.style.right=Math.max(8,innerWidth-rect.right)+'px';
    syncPopover.style.bottom=innerHeight-rect.top+8+'px';
    syncPopover.showPopover();
    drawDesktopSync();
  };
  syncPopover.addEventListener('toggle',()=>{
    if(syncPopover.matches(':popover-open'))return;
    quickPair=undefined;
    syncPopover.querySelector('figure').hidden=true;
    syncPopover.querySelector('img').removeAttribute('src');
  });
  syncPopover.querySelector('[data-sync-now]').onclick=()=>platform.sync.run().then(syncStatus).catch(fail);
  syncPopover.querySelector('[data-sync-qr]').onclick=async()=>{
    try{
      const dir=root;
      const state=await platform.sync.status();
      if(!state.port)await platform.sync.configure({enabled:true,mode:'lan',listen:true});
      const pair=await platform.sync.pair();
      if(dir!==root||!syncPopover.matches(':popover-open'))return;
      quickPair=pair;
      syncPopover.querySelector('img').src=pair.image;
      syncPopover.querySelector('figure').hidden=false;
    }catch(error){fail(error);}
  };
  syncPopover.querySelector('[data-copy-pair]').onclick=()=>{
    if(quickPair)platform.clipboard.writeText(quickPair.packet).then(()=>toast('已复制配对串')).catch(fail);
  };
}

function mobileSyncValue(value) {
  const connected=Boolean(value?.settings.enabled&&configured(value.settings));
  const status=connected||['error','conflict'].includes(value?.status)?value.status:'local';
  const summary=status==='error'?'error':connected&&status!=='synced'?'pending':status;
  return {...value,connected,status,summary,summaryLabel:vaultStatusLabels[summary],
    label:status==='local'?vaultStatusLabels.local:syncLabel(value),
    detail:status==='error'?value.logs[0]?.message:status==='local'?vaultStatusLabels.local:syncLabel(value)};
}

function showMobileSync() {
  const rows=currentSyncState?.conflicts;
  if(rows?.length) {
    const row=rows.find(item=>current()?.path&&fileKey(item.path)===fileKey(current().path))||rows[0];
    return showSyncConflict(row);
  }
  mobileShell.showSync(mobileSyncValue(currentSyncState),{
    async runSync(){await platform.sync.run();syncStatus(await platform.sync.status());},
    settings:()=>settingsCenter.open('sync'),
    conflicts:()=>showSyncConflict(currentSyncState.conflicts[0]).catch(fail)
  });
}

function mountShortcutSettings(panel) {
  mountShortcuts(panel,{commands,bindings:preferences.shortcuts,mac,escape,fail,async save(shortcuts){
    const next={...preferences,shortcuts};
    await platform.preferences.saveFeatures(next);
    preferences=next;
  }});
}
const settingsCenter=createSettingsCenter({icon,glyphs,fail,mount:{
  writing:mountWritingSettings,shortcuts:mountShortcutSettings,sync:mountWorkspaceSync,attachments:mountAttachmentSettings,
  appearance:mountAppearance
}});

function mobileKeyboard(key) {
  if(key==='dismiss'){document.activeElement?.blur();return;}
  if(!current()||mode==='read')return;
  if(mode==='source'&&source.composing||mode==='live'&&liveView().composing)return;
  if(key==='paste')return editorTools.pasteClipboard();
  if(key==='image'){
    const target=editorTools.insertionTarget(),picker=document.createElement('input');
    picker.type='file';picker.accept='image/*';picker.hidden=true;document.body.append(picker);
    picker.addEventListener('cancel',()=>picker.remove(),{once:true});
    picker.addEventListener('change',async()=>{
      const file=picker.files[0];picker.remove();
      if(file)await editorTools.insertImage(file,target).catch(fail);
    },{once:true});
    picker.click();
    return;
  }
  const pairs={
    heading:['# ','',''],bold:['**','**','粗体'],todo:['- [ ] ','',''],
    wiki:['[[',']]','笔记名'],math:['$','$','公式'],code:['\u0060','\u0060','代码'],
    table:['\n\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n\n','','']
  };
  if(mode==='live'){
    if(pairs[key])editorTools.insertTemplate(pairs[key].join(''));
    return;
  }
  const commands={indent:indentMore,outdent:indentLess,undo,redo};
  if(commands[key]){commands[key](source);source.focus();return;}
  if(!pairs[key])return;
  const [open,close,placeholder]=pairs[key];
  const selection=source.state.selection.main;
  const value=source.state.sliceDoc(selection.from,selection.to)||placeholder;
  const line=source.state.doc.lineAt(selection.from);
  const prefix=['heading','todo'].includes(key)&&selection.from!==line.from?'\n':'';
  const insert=prefix+open+value+close,anchor=selection.from+prefix.length+open.length;
  source.dispatch({changes:{from:selection.from,to:selection.to,insert},
    selection:{anchor:value?anchor:anchor+close.length,head:anchor+value.length},scrollIntoView:true,userEvent:'input'});
  source.focus();
}

function installContextMenus() {
  const item=(label,run,options)=>({label,run,...options});
  const group=(label,items)=>({label,items});
  const show=(event,id,label,groups)=>{
    if(mobileLayout()){
      event.preventDefault();
      if(nativeMobile)for(const group of groups)group.items=group.items.filter(item=>!/^在系统资源管理器|^在右侧分栏打开/.test(item.label));
      return mobileShell.show(label,groups);
    }
    return contextMenu(floatingMenus,event,id,label,groups.filter(group=>group.items.length));
  };
  const copy=text=>platform.clipboard.writeText(text);
  const reveal=(file,open=false)=>platform.fs.reveal(file,open);
  const disabled=value=>({disabled:!value});

  $('#side-content').addEventListener('contextmenu',event=>{
    if(pane!=='files')return;
    if(!root){
      show(event,'file-menu','文件树',[group('工作区',[item('打开工作区文件夹…',()=>action('folder'))])]);
      return;
    }
    const row=event.target.closest('.file-row[data-file],.folder-row[data-folder]');
    const file=row?.dataset.file, folder=row?.dataset.folder;
    const target=file||folder||root;
    const newEntry=(type,label)=>item(label,()=>workspaceUI.menuAction(type,target,!file));
    const create=group('新建',[newEntry('note',folder?'在此新建笔记':'新建笔记'),
      newEntry('folder',folder?'在此新建文件夹':'新建文件夹')]);
    const manage=group('文件管理',[
      item('在系统资源管理器中显示',()=>reveal(target)),
      item('重命名',()=>workspaceUI.menuAction('rename',target,!file)),
      item('移动到文件夹…',()=>workspaceUI.menuAction('move',target,!file)),
      item(nativeMobile?'移入 Vault 回收站':'移入系统回收站',()=>workspaceUI.menuAction('trash',target,!file),{danger:true})
    ]);
    if(file) {
      const title=bookmarkIndex(file)>=0?'取消收藏':'收藏';
      show(event,'file-menu','笔记文件',[group('笔记',[
        item('在右侧分栏打开',()=>splitFile(file)),
        item(title,()=>toggleDocumentBookmark(file)),
        pathMenu(type=>copyDocumentPath(type,file)),
        item('打开导出中心',async()=>{
          const tab=findDocumentTab(file)||{path:file,name:base(file),text:(await platform.fs.read(file)).text};
          openExportCenter('pdf',tab,false);
        })
      ]),create,manage]);
    } else if(folder) {
      const collapse=expanded.has(folder);
      show(event,'file-menu','文件夹',[create,group('文件夹',[
        item(collapse?'折叠子文件夹':'展开子文件夹',()=>{
          const stack=[...files];
          while(stack.length) {
            const entry=stack.pop();
            if(!entry.children)continue;
            if(containsPath(folder,entry.path,fileKey)) {
              if(collapse) expanded.delete(entry.path); else expanded.add(entry.path);
            }
            stack.push(...entry.children);
          }
          renderSide();
        })
      ]),manage]);
    } else show(event,'file-menu','文件树',[create,group('工作区',[
      item('刷新文件树',()=>action('refresh')),item('在系统资源管理器中打开 Vault',()=>reveal(root,true))
    ])]);
  });

  $('#tabs').addEventListener('contextmenu',event=>{
    const tab=tabs.find(tab=>tab.id===event.target.closest('[data-tab]')?.dataset.tab);
    if(!tab)return;
    const right=tabs.slice(tabs.indexOf(tab)+1);
    async function closeTabs(list) {
      for(const target of [...list].reverse()) {
        await closeTab(target.id);
        if(tabs.includes(target))break;
      }
    }
    show(event,'tab-menu','文档标签页',[group('关闭标签',[
      item('关闭当前标签',()=>closeTab(tab.id)),
      item('关闭其他标签',()=>closeTabs(tabs.filter(other=>other!==tab)),disabled(tabs.length>1)),
      item('关闭右侧标签',()=>closeTabs(right),disabled(right.length))
    ]),group('文档',[
      item('在右侧分栏打开',()=>openDocumentSplit(tab)),
      item('复制双链',()=>copyDocumentPath('wiki',tab.path),disabled(tab.path)),
      item('在系统资源管理器中显示',()=>reveal(tab.path),disabled(tab.path&&!tab.deleted))
    ]),group('标签操作',[
      item(tab.pinned?'取消固定':'固定标签',()=>{tab.pinned=!tab.pinned;renderTabs();session();}),
      item('重新打开刚关闭的文档',reopenClosed,disabled(closedFiles.length))
    ])]);
  });

  $('#outline').addEventListener('contextmenu',event=>{
    const node=event.target.closest('.outline-row')?.querySelector('[data-heading]');
    const index=node?Number(node.dataset.heading):-1, row=headings()[index], file=current()?.path;
    const groups=[];
    if(row)groups.push(group('标题',[
      item('跳转到此标题',()=>jumpHeading(index,true)),
      item(outlineUI.isFolded(index)?'展开此章节':'折叠此章节',()=>outlineUI.toggle(index)),
      item('复制标题双链',()=>copy(documentWiki(file,row.text)),disabled(file)),
      item('复制标题文本',()=>copy(row.text))
    ]));
    groups.push(group('大纲',[item('展开全部大纲',()=>outlineUI.foldAll(false)),item('折叠全部大纲',()=>outlineUI.foldAll(true))]));
    show(event,'outline-menu','大纲',groups);
  });

  $('.editor-section').addEventListener('contextmenu',event=>{
    if(event.target.closest('input,textarea,select,.document-find,.external-change'))return;
    flushLive();
    const tab=current();
    if(!tab)return;
    const editable=editorTools.contextAt(event);
    const readingRange=mode==='read'?getSelection():null;
    const hasReadingSelection=readingRange?.rangeCount&&!readingRange.isCollapsed&&
      $('#reading').contains(readingRange.getRangeAt(0).commonAncestorContainer);
    let selection;
    if(hasReadingSelection) {
      const fragment=document.createElement('div');
      fragment.append(readingRange.getRangeAt(0).cloneContents());
      selection={html:fragment.innerHTML};
    } else if(editable?.selected) selection=selectedExportContent(tab);

    const groups=[];
    const anchor=event.target.closest('a[href],[data-wiki]');
    const domHref=anchor?.dataset.wiki||anchor?.getAttribute('href');
    const link=domHref?{href:domHref,wiki:anchor.hasAttribute('data-wiki'),element:anchor}:editable?.link;
    if(link) {
      const doc=link.element?.dataset.noteSource||tab.path;
      const wikiLink=link.wiki||link.href.startsWith('calcite-wiki://');
      const href=link.href.startsWith('calcite-wiki://')?decodeURIComponent(link.href.slice(15)):link.href;
      const note=wikiLink||noteExtension.test(href.split('#')[0]);
      const external=/^https?:\/\//i.test(href);
      const heading=href.startsWith('#');
      if(note||external||heading) {
        const entries=[item('打开链接',()=>{
          if(external)return platform.window.external(href);
          if(heading&&!wikiLink)return jumpHeading(headings().findIndex(row=>headingMatches(row.text,href.slice(1))));
          return wiki(href,wikiLink,doc);
        })];
        if(wikiLink)entries.push(item('在右侧分栏打开',async()=>{
          const target=await platform.index.target({source:doc,destination:href,wiki:true});
          if(!target)throw Error('找不到链接目标，请先创建这篇笔记。');
          return splitFile(target.path,target.heading);
        }));
        entries.push(item('复制链接地址',()=>copy(href)));
        groups.push(group('链接',entries));
      }
    }
    if(mode==='read') {
      const image=event.target.closest('#reading img');
      const url=image?.getAttribute('src')||'';
      if(url.startsWith('note-image://local/')) {
        const file=decodeURIComponent(url.slice('note-image://local/'.length));
        groups.push(group('本地图片',[
          item('在系统资源管理器中显示图片',()=>platform.fs.revealImage(file)),item('复制图片路径',()=>copy(file))
        ]));
      }
      if(hasReadingSelection) {
        const text=readingRange.toString();
        groups.push(group('选区',[item('复制',()=>copy(text))]));
      }
    } else if(editable) {
      groups.push(group('剪贴板',[
        item('剪切',editable.cut,disabled(editable.selected)),
        item('复制',()=>copy(editable.text),disabled(editable.selected)),
        item('粘贴',()=>editable.paste(false)),item('粘贴为纯文本',()=>editable.paste(true)),
        item('全选',editable.selectAll)
      ]),group('排版与插入',[
        {id:'format',label:'格式',items:[
          ['粗体','**'],['斜体','*'],['行内代码','`','`','代码'],['删除线','~~'],
          ['行内公式','$','$','x'],['转为双链','[[',']]','笔记名']
        ].map(([label,open,close,placeholder])=>item(label,()=>editable.format(open,close,placeholder)))},
        {id:'insert',label:'插入',items:[
          ['表格','\n\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n\n'],
          ['代码块','\n\n```\n代码\n```\n\n'],['公式块','\n\n$$\nx = 1\n$$\n\n'],
          ['手动分页符','\n\n<!-- pagebreak -->\n\n']
        ].map(([label,markdown])=>item(label,()=>editable.insert(markdown))).concat(
          item('笔记模板',()=>{editable.focus();return action('template');})
        )},
        ...(editable.tableLine===undefined?[]:[item('格式化当前表格',()=>{
          editable.focus();
          return editMarkdown(text=>formatTables(text,editable.tableLine));
        })])
      ]));
    }
    if(selection)groups.push(group('分享选区',[
      item('复制为富文本',()=>copyRichText(selection)),
      item('导出选中块为长图',()=>saveExport('png',tab,defaultExportPreferences(),selection))
    ]));
    if(mode==='read')groups.push(group('文档',[
      item('切换到即时编辑',()=>setMode('live')),item('切换到源码模式',()=>setMode('source')),
      item('打开导出中心',()=>openExportCenter('pdf',tab)),item('查看版本历史',()=>action('history'),disabled(tab.path))
    ]));
    show(event,'editor-menu',mode==='read'?'阅读内容':'编辑文档',groups);
  });
  document.addEventListener('contextmenu',event=>{
    if(!event.target.closest('input,textarea,[contenteditable]'))event.preventDefault();
  });
}

async function toggleVim() {
  if(mobileLayout())return;
  const next={...preferences,vim:!preferences.vim};
  await platform.preferences.saveFeatures(next);
  preferences=next;
  updateVim();
  toast(preferences.vim?'源码 Vim 已开启':'源码 Vim 已关闭');
}

function editMarkdown(transform,sourceOnly=false) {
  if(!current())return;
  flushLive();
  if(sourceOnly&&mode!=='source') {toast('请切换到源码模式，再对当前行运行此命令。');return;}
  const tab=current(), line=mode==='source'?source.state.doc.lineAt(source.state.selection.main.head):null;
  const text=transform(tab.text,line?line.number-1:undefined);
  if(text===tab.text)return;
  if(mode!=='source') {applyEditorText(text);return;}
  const row=text.split('\n').slice(0,line.number-1).join('\n');
  const anchor=Math.min(text.length,(row.length?row.length+1:0)+source.state.selection.main.head-line.from);
  source.dispatch({changes:{from:0,to:source.state.doc.length,insert:text},selection:{anchor}});
}

function editMarkdownTasks() {
  if(mode==='source') {
    const {doc,selection}=source.state,{from,to}=selection.main;
    const first=doc.lineAt(from),last=doc.lineAt(to===from?to:to-1);
    const original=doc.sliceString(first.from,last.to), insert=toggleTasks(original);
    if(original!==insert)source.dispatch({changes:{from:first.from,to:last.to,insert},selection:{anchor:from,head:to}});
    return;
  }
  if(mode!=='live')return;
  const view=liveView(),{tr,selection}=view.state;
  const toggle=(node,pos)=>{if(typeof node.attrs.checked==='boolean')tr.setNodeAttribute(pos,'checked',!node.attrs.checked);};
  if(selection.empty) {
    for(let depth=selection.$from.depth;depth>0;depth--) {
      const node=selection.$from.node(depth);
      if(typeof node.attrs.checked==='boolean'){toggle(node,selection.$from.before(depth));break;}
    }
  } else view.state.doc.nodesBetween(selection.from,selection.to,toggle);
  if(tr.docChanged)view.dispatch(tr);
}

async function handleAppClick(event) {
  const target = event.target;
  const button = target.closest('[data-action]');
  const vault = $('.workspace-picker');
  if (vault.open && (!vault.contains(target) || button?.closest('.workspace-menu'))) vault.open = false;
  if (target===$('#palette')) return closePalette();
  const crumb = target.closest('[data-breadcrumb-folder], [data-breadcrumb-file]');
  if (crumb) return crumb.hasAttribute('data-breadcrumb-file') ? revealBreadcrumb(current()?.path,true) : revealBreadcrumb(crumb.dataset.breadcrumbFolder);

  const close = target.closest('[data-close]');
  if (close) return closeTab(close.dataset.close);
  const tab = target.closest('[data-tab]');
  if (tab) return activate(tab.dataset.tab);
  if (button) {
    if (!mobileLayout()&&button.closest('.inspector-header') && button.dataset.action==='outline') {
      $('footer [data-action="outline"]').focus({preventScroll:true});
    }
    return action(button.dataset.action);
  }
  const side = target.closest('[data-pane]');
  if (side) return selectSidePane(side.dataset.pane);
  const view = target.closest('[data-mode]');
  if (view) return setMode(view.dataset.mode);
  const file = target.closest('[data-file]');
  if (file) return openFile(file.dataset.file,Number(file.dataset.line)||0);
  const folder = target.closest('[data-folder]');
  if (folder) {
    const path = folder.dataset.folder;
    if (!expanded.delete(path)) expanded.add(path);
    return renderSide();
  }
  const heading = target.closest('[data-heading]');
  if (heading) return jumpHeading(Number(heading.dataset.heading),true);
  const command = target.closest('[data-command]');
  if (command) return executeCommand(Number(command.dataset.command));
  const note = target.closest('[data-wiki]');
  if (note) {
    event.preventDefault();
    if (note.classList.contains('live-wiki')&&!event.ctrlKey&&!event.metaKey) return;
    return wiki(note.dataset.wiki,true,note.dataset.noteSource||current()?.path);
  }
  const link = target.closest('a');
  if (!link || (link.closest('#live-editor')&&!event.ctrlKey&&!event.metaKey)) return;
  event.preventDefault();
  const href = link.getAttribute('href')||'';
  if (href.startsWith('calcite-wiki://')) return wiki(decodeURIComponent(href.split('calcite-wiki://')[1]));
  if (link.hasAttribute('data-local-anchor')) {
    const anchor = document.getElementById(href.slice(1));
    const parent = anchor?.parentElement;
    const index = parent?.matches('.reading-content') ? [...parent.children].filter(el=>/^H[1-6]$/.test(el.tagName)).indexOf(anchor) : -1;
    if (index>=0) outlineUI?.reveal(index);
    return anchor?.scrollIntoView({block:'start'});
  }
  if (/^https?:/i.test(href)) return platform.window.external(href);
  if (href.startsWith('#')) {
    const index = headings().findIndex(row=>headingMatches(row.text,href.slice(1)));
    if (index>=0) jumpHeading(index);
  } else if (noteExtension.test(href.split('#')[0])) {
    return wiki(href,false,link.dataset.noteSource||current()?.path);
  }
}
document.addEventListener('click',event=>handleAppClick(event).catch(fail));
const scrolling = new WeakMap();
document.addEventListener('scroll',event=>{
  const element = event.target===document ? document.scrollingElement : event.target;
  if (!(element instanceof HTMLElement)) return;
  if (!scrolling.has(element)) element.setAttribute('data-scrolling','');
  clearTimeout(scrolling.get(element));
  scrolling.set(element,setTimeout(()=>{
    element.removeAttribute('data-scrolling');
    scrolling.delete(element);
  },650));
},{capture:true,passive:true});
document.addEventListener('keydown',event=>{
  if (event.isComposing || event.key!=='Escape' || document.querySelector('dialog[open]')) return;
  if (appearancePanel.matches(':popover-open')) return;
  if (!$('#palette').hidden) return closePalette();
  const vault = $('.workspace-picker');
  if (vault.open) {
    vault.open = false;
    return vault.querySelector('summary').focus();
  }
  if (document.body.classList.contains('focus-mode')) action('focus').catch(fail);
},true);
document.addEventListener('keydown',event=>{
  if (event.defaultPrevented||event.repeat||event.target.closest?.('dialog[open]')) return;
  const key=eventShortcut(event,mac);
  if (!key) return;
  const command=Object.entries({...defaultShortcuts,...preferences.shortcuts}).find(([,binding])=>binding===key)?.[0];
  if (!command) return;
  event.preventDefault();
  event.stopPropagation();
  Promise.resolve(action(command)).catch(fail);
},true);
const guide=`# 使用指南\n\n## 编辑与阅读\n\n**即时编辑**支持标题、列表、任务清单、引用、表格、代码块、行内公式和块级公式。输入 / 打开插入菜单，选中文字显示格式工具栏。\n\n**源码模式**使用 CodeMirror，支持语法高亮、撤销重做、括号匹配、查找替换。Ctrl+F 打开查找，面板中的替换按钮可展开替换输入框。\n\n**阅读模式**支持 GFM 表格、KaTeX 数学公式、代码高亮和 Mermaid 图表。即时编辑与阅读模式中的本地图片支持相对路径；在源码或即时编辑模式粘贴、拖放图片时，附件按设置落盘。\n\n## 文件与知识库\n\n打开文件夹后，左侧显示 Markdown 文件树。全文搜索支持工作区内的内容搜索，结果最多 250 条；点击结果会定位源码行。隐藏文件、符号链接、node_modules、dist、release 不参与索引。\n\n使用 [[文档名]]、[[文档名|显示名称]]、[[文档名#标题]] 连接笔记。阅读模式中可点击跳转，右侧显示大纲和反向链接。点击未创建的双链可以创建笔记。Ctrl 悬停预览，即时编辑中 Ctrl 点击打开。\n\n在文件树中右键新建、改名或移入回收站。拖动文件或文件夹可移动，改名和移动会自动更新工作区引用。\n\n## 保存与恢复\n\n- Ctrl+S 保存，新文件会弹出保存位置选择框。\n- 已有文件默认在停止输入约 1 秒后自动保存，可在底栏关闭。\n- 草稿和打开的标签页会保存在应用数据目录，重启后恢复。\n- 每次内容覆盖前保留版本快照，可在版本历史中查看差异。\n- 如果文件被其他程序修改，应用停止覆盖并展示磁盘版本与当前草稿的差异。\n- 退出会保留当前会话和未保存草稿。关闭单个有修改的标签页时会询问是否丢弃。\n\n在 Ctrl+K 命令面板输入“图谱”“Canvas”“属性视图”“今日笔记”或“模板”可打开对应功能。Canvas 保存在工作区根目录的 .canvas 文件；属性视图使用 Markdown 的 YAML 数据。数学和图表在本地渲染，远程图片需要网络。\n\n## 快捷键\n\n| 快捷键 | 功能 |\n| --- | --- |\n| Ctrl+N | 新建 |\n| Ctrl+O | 打开文件 |\n| Ctrl+Shift+O | 打开文件夹 |\n| Ctrl+S | 保存 |\n| Ctrl+Shift+S | 另存为 |\n| Ctrl+K | 文件和命令面板 |\n| Ctrl+F | 文内查找替换 |\n| Ctrl+Shift+F | 工作区全文搜索 |\n| Ctrl+B | 切换侧栏 |\n| Ctrl+W | 关闭当前标签 |\n| F8 | 专注模式 |\n| F11 | 全屏 |\n\n## 图表例子\n\n\`\`\`mermaid\nflowchart LR\n    A[阅读] --> B[思考]\n    B --> C[写作]\n    C --> A\n\`\`\`\n`;
async function boot(){
  mobileShell=createMobileShell({native:nativeMobile,icon,glyphs,run:action,tabs:()=>tabs,active:current,mode:()=>mode,
    workspace:()=>({name:root?base(root):'打开知识库',available:!!root}),
    editMode:mobileEditMode,activate,keyboard:mobileKeyboard,hint:toast,fail,changed(enabled){
      if(appearancePanel.matches(':popover-open'))appearancePanel.hidePopover();
      floatingMenus.close();
      linkCompletion?.close();
      if(initialized){
        updateVim();
        renderSide();
        if(mode==='read')renderRead();
      }
      if(enabled&&initialized&&mode==='live'&&!preferences.mobileLiveEditing)setMode('source').catch(fail);
    }});
  const data = await platform.workspace.bootstrap();
  root = data.root;
  preferences = {...defaults,...(nativeMobile?{webpCompression:true}:{}),...data.config.features};
  if (data.initialFiles.length) $('#startup-status').textContent = `正在打开 ${base(data.initialFiles[0])}…`;
  await mountEditors();
  installFeatures();
  const savedSession=data.config.session;
  const mobileSession=nativeMobile&&savedSession?.mobileRoot!==root?savedSession?.workspaces?.[root]?.mobileSession:undefined;
  const restored = restoreWorkspaceSession(nativeMobile&&savedSession?{...savedSession,...mobileSession,
    tabs:(mobileSession?.tabs??savedSession.tabs??[]).filter(tab=>tab.path?containsPath(root,tab.path,fileKey):
      (!savedSession.mobileRoot||savedSession.mobileRoot===root||!!mobileSession)&&tab.text!==welcome)
  }:savedSession,nativeMobile);
  if (restored) {
    ({tabs,activeId,mode,autoSave,treeSort,treeDescending,closedFiles,workspaces}=restored);
    document.body.classList.toggle('hide-sidebar',restored.sidebarHidden);
    document.body.classList.toggle('hide-outline',restored.outlineHidden);
  } else if(!nativeMobile) {
    tabs = [{id:uid(),path:null,name:'开始写作.md',text:welcome,saved:welcome,mtime:null,dirty:false}];
    activeId = tabs[0].id;
  }
  new MutationObserver(()=>resolveImages($('#live-editor')).catch(console.warn)).observe($('#live-editor'),{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
  syncPanelButtons();
  if (root) loadInitialTree();
  await activate(activeId);
  await openExternalFiles(data.initialFiles);
  platform.events.action(a=>action(a).catch(fail));
  platform.events.externalChange(enqueueVaultChange);
  platform.events.sync(syncStatus);
  if(platform.sync.network) {
    const network=()=>platform.sync.network(navigator.onLine).catch(fail);
    window.addEventListener("online",network);
    window.addEventListener("offline",network);
    await network();
  }
  const arriving = await platform.window.ready();
  platform.events.back?.(()=>{
    const dialog=activeMobileDialog();
    if(dialog&&!dialog.matches('.mobile-sheet'))dialog.close();
    else if(!mobileShell.back())action('quit').catch(fail);
  });
  if(persisted)platform.sync.status().then(syncStatus).catch(fail);
  initialized = true;
  $('#app').inert = false;
  $('#startup-status').hidden = true;
  await openExternalFiles(arriving);
  if (root&&restored) updateTabsFromDisk({root,changes:restored.tabs.filter(tab=>tab.path&&containsPath(root,tab.path,fileKey))
    .map(tab=>({path:tab.path,type:'change'}))}).catch(fail);
  session();
}

function loadInitialTree() {
  const initialRoot = root;
  const initialRows = files;
  loadingTree = true;
  initialTreeChanges=[];
  platform.workspace.tree().then(rows=>{
    if (root !== initialRoot || files !== initialRows) return;
    files = rows;
    updateTree(files,root,initialTreeChanges,fileKey);
    initialTreeChanges=[];
    loadingTree = false;
    revealActiveFile();
    if (pane === 'files') renderSide();
  }).catch(error=>{
    if (root !== initialRoot || files !== initialRows) return;
    loadingTree = false;
    if (pane === 'files') renderSide();
    fail(error);
  });
}

boot().catch(error=>{
  const status = $('#startup-status');
  status.textContent = `启动失败：${errorMessage(error)}`;
  status.hidden = false;
  console.error(error);
});
