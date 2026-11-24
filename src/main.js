import {getLocale, t as tr} from "../shared/i18n/index.mjs";
import {mountLocalizedMarkup, onLocaleChange} from "./localization.js";
import { Crepe } from '@milkdown/crepe';
import {blockLabels, editorPhrases, toolbarLabels} from './editor-language.js';
import { replaceAll, $prose } from '@milkdown/kit/utils';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import '@milkdown/crepe/theme/common/style.css';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import {indentMore,indentLess,undo,redo} from '@codemirror/commands';
import {formatTables,insertToc,numberHeadings,renumberList,toggleTasks} from './markdown-edit.js';
import {defaultShortcuts,eventShortcut,keycaps,mountShortcuts} from './shortcuts.js';
import {inlineMathView,mathOptions,parseMacros,refreshLiveMath} from './math-options.js';
import {exportDefaults} from './export-defaults.js';
import {documentMenu,pathMenu} from './document-menu.js';
import {createFloatingMenu,contextMenu} from './floating-menu.js';
import {createSettingsCenter} from './settings-center.js';
import {errorMessage} from './error-message.js';
import {syncLabel,syncMessage} from './sync-status.js';
import {localTimestamp} from '../shared/local-time.mjs';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneMonokai, sourceMarkers } from './editor-theme.js';
import { openSearchPanel } from '@codemirror/search';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { createIcons } from 'lucide';
import { appIcons as icons } from './icons.js';
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
import {encodeWiki,headingIndex,headingMatches,mapLinks,markdown as markdownPath} from '../shared/note-links.mjs';
import {replaceReference,splitReferenceBlock,updateReferenceDefinitions} from '../shared/core/link-refactor.mjs';
import {sameSnapshot} from '../shared/core/file-snapshot.mjs';
import {dailyNoteName,relativeNotePath,tagTree} from '../shared/pkm-workflows.mjs';
import {randomId as uid} from './random-id.js';
import { installOutline, installLinkCompletion, noteHeadings, sourceOutlineFolds } from './navigation.js';
import { defaults, splitFrontmatter, propertiesCard, styleCallouts, liveNotesPlugin, liveWikiStatus, noteTags, noteExtension, diffView, sideBySideDiff, pagebreakNode, remarkPagebreak } from './notes.js';
import { installEditorTools } from './editor-tools.js';
import { createWorkspaceUI } from './workspace-ui.js';
import {renderNote,wrapReadingTables} from './note-render.js';
import {createActivityView} from './activity-view.js';
import {showExternalMarkdown} from './mobile-external-preview.js';
import { createNoteWorkflows } from './note-workflows.js';
import { createWorkspaceViews } from './workspace-views.js';
import { platform } from './platform/index.js';
import {updateTree,containsPath} from './vault-changes.js';
import {tabSnapshot,restoreWorkspaceSession} from './workspace-session.js';
import {createVaultSearch} from './vault-search.js';

const $ = s => document.querySelector(s);
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const base = p => p?.split(/[\\/]/).pop() || tr('main.untitledName');
const icon = name => `<i data-lucide="${name}"></i>`;
const desktop = platform.type==='electron';
const nativeMobile=platform.type==='capacitor';
const persisted=desktop||nativeMobile;
const mac=platform.os==='darwin'||(!desktop&&/Mac/.test(navigator.platform));
const vimConfig=new Compartment();
const editorLanguage=new Compartment();
const appearance = window.calciteAppearance;
appearance.attach(platform.window,platform.events);
const uiRoot = document.documentElement;
const mathFonts=import.meta.glob('../node_modules/katex/dist/fonts/*.woff2',{query:'?inline',import:'default'});
let vimModule,exportCenterModule;
const loadVim=()=>vimModule?Promise.resolve(vimModule):import('@replit/codemirror-vim').then(mod=>(vimModule=mod));
const loadExportCenter=()=>exportCenterModule?Promise.resolve(exportCenterModule):import('./export-center.js').then(mod=>(exportCenterModule=mod));
const welcome = () => `${tr("main.aPlaceForYourNotes")}

${tr("main.welcomeToCalciteStartANoteOr")}

> ${tr("main.yourNotesAreSavedAsLocalFiles")}

${tr("main.startHere")}

${tr("main.selectOpenFolderToOpenYourMarkdown")}
${tr("main.pressCtrlOToOpenANote")}
${tr("main.switchBetweenLiveSourceAndReadAt")}
${tr("main.typeToInsertHeadingsTablesQuotesOr")}
${tr("main.pressCtrlKToOpenFilesOr")}

${tr("main.connectYourNotes")}

${tr("main.useUserGuideToLinkNotesFollow")}

${tr("main.plansAndTasks")}

${tr("main.xSetUpAWorkspace")}
${tr("main.writeYourFirstNote")}
${tr("main.linkTwoNotes")}

${tr("main.chooseAnEditorView")}

${tr("main.modeUseItTo")}
| --- | --- |
${tr("main.liveWriteWithInlineFormatting")}
${tr("main.sourceEditAndSearchRawMarkdown")}
${tr("main.readReadFormulasDiagramsAndFormattedNotes")}

${tr("main.mathAndCode")}

$$
E = mc^2
$$

\`\`\`cpp
#include <iostream>
int main() {
    std::cout << "Hello, ideas!" << std::endl;
}
\`\`\`

---

${tr("main.addYourOwnNotesWhenYouRe")}
`;

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
let mobileShell,activityView;
const mobileLayout=()=>nativeMobile||uiRoot.dataset.platform==='mobile';
const mobileEditMode=()=>preferences.mobileLiveEditing?'live':'source';
const supportedMode=mode=>mobileLayout()&&mode==='live'?mobileEditMode():mode;
const relativePath = path => {
  const normalized = path.replaceAll('\\','/');
  const prefix = root.replaceAll('\\','/').replace(/\/$/,'')+'/';
  return root && normalized.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? normalized.slice(prefix.length) : normalized;
};
const sortedTree = rows => {
  const locale=getLocale();
  return [...rows].sort((a,b) =>
    Number(!!b.children)-Number(!!a.children) ||
    (treeDescending?-1:1)*((treeSort==='name'?0:(a[treeSort]||0)-(b[treeSort]||0)) ||
      a.name.localeCompare(b.name,locale,{numeric:true})));
};
const workspaceState = () => workspaces[root] ??= {bookmarks:[],bases:[]};
const flat=(rows=files)=>rows.flatMap(r=>r.children?flat(r.children):[r]);
const iconButton = (attr,label,glyph) => `<button type="button" ${attr} title="${label}" aria-label="${label}">${icon(glyph)}</button>`;
const appearanceOptions = ()=>`<div class="appearance-choices" role="group" aria-label="${tr("main.appearance")}">
  <button type="button" data-appearance-theme="dark">${tr("main.dark")}</button>
  <button type="button" data-appearance-theme="light">${tr("main.light")}</button>
</div>`;
mountLocalizedMarkup($('#app'),()=>`
<header class="titlebar">
  ${iconButton('class="sidebar-toggle" data-action="sidebar" aria-controls="left-sidebar" aria-expanded="true"',tr("main.toggleLeftSidebarCtrlB"),'panel-left')}
  <div class="tabs" id="tabs" aria-label="${tr("main.openNotes")}"></div>
  ${iconButton('class="add-tab" data-action="new"',tr("main.newNoteCtrlN"),'plus')}
  <div class="title-drag-space" aria-hidden="true"></div>
  <div class="title-actions">
    ${iconButton('id="export-quick" data-action="exportCenter" disabled',tr("main.openExportCenter"),'file-down')}
    ${iconButton('id="split-quick" data-action="split" disabled',tr("main.openInRightSplit"),'columns-2')}
    ${iconButton('id="document-star" data-action="toggleBookmark" aria-pressed="false" disabled',tr("main.bookmarkCurrentNote"),'star')}
    ${iconButton('id="appearance-toggle" popovertarget="appearance-panel"',tr("main.themeMaterial"),'sun-moon')}
    ${iconButton('data-action="more" aria-haspopup="menu" aria-controls="more-menu" aria-expanded="false"',tr("main.moreNoteActions"),'ellipsis')}
    <div class="window-controls" role="group" aria-label="${tr("main.windowControls")}" ${desktop?'':'hidden'}>
      <button type="button" data-window-control="minimize" title="${tr("main.minimize")}" aria-label="${tr("main.minimize")}">${icon('minus')}</button>
      <button type="button" data-window-control="maximize" title="${tr("main.maximize")}" aria-label="${tr("main.maximize")}"><span aria-hidden="true">${icon('square')}</span><span aria-hidden="true" hidden>${icon('copy')}</span></button>
      <button type="button" data-window-control="close" title="${tr("main.closeWindow")}" aria-label="${tr("main.closeWindow")}">${icon('x')}</button>
    </div>
  </div>
</header>
<main class="workspace">
<aside class="sidebar" id="left-sidebar" aria-label="${tr("main.workspaceSidebar")}">
  <div class="vault-bar"><details class="workspace-picker">
    <summary title="${tr("main.switchVault")}" aria-controls="workspace-menu">${icon('folder-open')}<b id="workspace-name">${tr("main.localWorkspace")}</b>${icon('chevrons-up-down')}</summary>
  </details>${iconButton('id="settings-toggle" data-action="settings" aria-haspopup="dialog"',tr("main.settings"),'settings')}</div>
  <nav class="side-tools" aria-label="${tr("main.workspaceTools")}">
    ${iconButton('data-pane="files"',tr("main.files"),'folder-closed')}
    ${iconButton('class="command-hint" data-action="palette"',tr("main.searchFilesAndCommandsCtrlK"),'search')}
    ${iconButton('data-pane="search"',tr("main.fullTextSearchCtrlShiftF"),'text-search')}
    ${iconButton('data-action="graph"',tr("main.vaultGraph"),'network')}
    ${iconButton('data-pane="links"',tr("main.currentNoteLinks"),'link-2')}
    ${iconButton('data-pane="tags"',tr("main.tagIndex"),'tags')}
    ${iconButton('data-action="bookmarks"',tr("main.bookmark"),'bookmark')}
    ${iconButton('data-action="activity"',tr("activity.title"),'history')}
  </nav>
  <div class="side-heading">
    <span id="pane-title" hidden></span>
    <div class="side-heading-actions side-note-actions" aria-label="${tr("main.vaultActions")}">
      ${iconButton('data-pane="health"',tr("main.vaultCheck"),'heart-pulse')}
      ${iconButton('data-action="daily"',tr("main.openDailyNote"),'calendar-days')}
      ${iconButton('data-action="random"',tr("main.openRandomNote"),'shuffle')}
    </div>
    <div class="side-heading-actions side-file-actions" role="toolbar" aria-label="${tr("main.fileActions")}">
      <button id="file-sort" type="button" title="${tr("main.sortFiles")}" aria-label="${tr("main.sortFiles")}" disabled>${icon('arrow-down-up')}</button>
      ${iconButton('data-action="refresh"',tr("main.refreshFiles"),'refresh-cw')}
      ${iconButton('data-action="new"',tr("main.newNoteCtrlN"),'file-plus-2')}
      <button type="button" id="new-folder" title="${tr("main.newFolder")}" aria-label="${tr("main.newFolder")}" disabled>${icon('folder-plus')}</button>
    </div>
  </div>
  <div id="side-content"></div>
    <div class="workspace-menu" id="workspace-menu" popover="manual" aria-label="${tr("main.vault")}">
      <p id="workspace-path" hidden></p>
      <div id="recent-vaults"></div>
      <button data-action="folder">${icon('folder-open')} ${nativeMobile?tr("main.manageLocalVaults"):tr("main.openWorkspaceFolder")}</button>
      <button data-action="close-vault" hidden>${icon('folder-closed')} ${tr("main.closeWorkspaceFolder")}</button>
      <button data-action="theme">${icon('sun-moon')} ${tr("main.toggleLightAndDark")}</button>
      <button data-action="help">${icon('keyboard')} ${tr("main.guideShortcuts")}</button>
    </div>
</aside>
<section class="editor-section">
  <aside id="external-change" class="external-change" aria-label="${tr("main.externalFileChanges")}" hidden></aside>
  <aside id="sync-conflict-banner" class="external-change" hidden><span role="status">${tr("main.syncKeptAConflictCopy")}</span><button type="button" data-sync-conflict>${tr("main.viewSyncConflicts")}</button></aside>
  <div class="paper-material" aria-hidden="true"></div>
  <nav class="breadcrumb" aria-label="${tr("main.currentNotePath")}">
    <div class="breadcrumb-path"><span id="breadcrumb-root"></span>${icon('chevron-right')}<button type="button" id="document-name" aria-current="page" data-breadcrumb-file></button></div>
  </nav>
  <div class="document-scroll" id="live-scroll"><div id="live-properties"></div><div id="live-editor"></div></div>
  <div id="source-editor" hidden></div>
  <article id="reading" class="document-scroll prose" hidden></article>
  <div id="empty" hidden><button data-action="new">${tr("main.newNote")} <kbd>Ctrl N</kbd></button><button data-action="open">${tr("main.openNote2")} <kbd>Ctrl O</kbd></button>
    <button class="mobile-empty" data-action="mobile-new-note">${tr("main.newNote2")}</button></div>
</section>
<div id="split-divider" hidden aria-hidden="true"></div>
<aside id="split-pane" hidden>
  <div class="paper-material" aria-hidden="true"></div>
  <div class="split-toolbar">
    <select aria-label="${tr("main.rightNote")}"></select>
    <select data-split-mode aria-label="${tr("main.rightViewMode")}"><option value="read">${tr("main.read")}</option><option value="source">${tr("main.source")}</option></select>
    <button type="button" data-split-save title="${tr("main.saveRightNote")}" aria-label="${tr("main.saveRightNote")}">${icon('save')}</button>
    <button type="button" data-split-close title="${tr("main.closeSplit")}" aria-label="${tr("main.closeSplit")}">${icon('x')}</button>
  </div>
  <span data-split-status></span><textarea hidden aria-label="${tr("main.rightMarkdownSource")}"></textarea><article class="prose"></article>
</aside>
<aside class="outline-panel" id="right-sidebar" aria-label="${tr("main.outlineBacklinks")}">
  <div class="inspector-header">
    <div class="inspector-tabs segmented-control" role="tablist" aria-label="${tr("main.rightSidebarContent")}">
      <button type="button" role="tab" id="outline-tab" aria-controls="outline-view" aria-selected="true">${tr("main.outline")}</button>
      <button type="button" role="tab" id="backlinks-tab" aria-controls="backlinks-view" aria-selected="false" tabindex="-1">${tr("main.backlinks")} <span class="link-count">(<span id="backlink-count">0</span>)</span></button>
    </div>
    ${iconButton('data-action="outline" data-desktop-inspector-toggle aria-controls="right-sidebar" aria-expanded="true"',tr("main.collapseRightSidebar"),'panel-right-close')}
  </div>
  <div class="inspector-view" id="outline-view" role="tabpanel" aria-labelledby="outline-tab">
    <div class="outline-search">${icon('search')}<input id="outline-filter" type="search" placeholder="${tr("main.filterHeadings")}" aria-label="${tr("main.filterHeadings")}"></div><div id="outline"></div>
  </div>
  <div class="inspector-view" id="backlinks-view" role="tabpanel" aria-labelledby="backlinks-tab" hidden><div id="backlinks"></div></div>
</aside></main>
<footer>
  <div class="save-status"><span class="status-dot"></span><span id="save-state">${tr("main.ready")}</span><button type="button" id="auto-save" data-action="autosave" aria-pressed="true" ${desktop?'':'hidden'}>${tr("main.autoSaveOn")}</button></div>
  <div class="document-status">
    <div class="document-metrics"><span id="vim-mode" role="status" hidden>NORMAL</span><span id="word-count">${tr("main.0Characters")}</span><span id="read-time">${tr("main.1MinRead")}</span></div>
    <div class="mode-switch segmented-control" role="group" aria-label="${tr("main.noteMode")}">
      <button data-mode="live" title="${tr("main.live")}">${tr("main.live")}</button>
      <button data-mode="source" title="${tr("main.source")}">${tr("main.source")}</button>
      <button data-mode="read" title="${tr("main.read")}">${tr("main.read")}</button>
    </div>
    <div class="status-tools">
      <button type="button" id="sync-status" aria-controls="sync-popover" aria-haspopup="dialog" ${desktop?'':'hidden'}>${tr("main.off")}</button>
      ${iconButton('data-action="focus" aria-pressed="false"',tr("main.focusModeF8"),'scan')}
      ${iconButton('data-action="outline" aria-controls="right-sidebar" aria-expanded="true"',tr("main.toggleRightSidebar"),'panel-right')}
    </div>
  </div>
</footer>
<section id="sync-popover" class="sync-popover" role="dialog" aria-label="${tr("main.syncStatus")}" popover>
  <p role="status"></p><progress aria-label="${tr("main.syncProgress")}" hidden></progress>
  <div class="feature-buttons"><button type="button" data-sync-now>${tr("main.syncNow")}</button>
    <button type="button" data-sync-qr>${tr("main.pairingQrCode")}</button><button type="button" data-action="sync">${tr("main.syncSettings")}</button></div>
  <figure hidden><img alt="${tr("main.pairingQrCode")}" width="176" height="176"><button type="button" data-copy-pair>${tr("main.copyPairingCode")}</button></figure>
</section>
<section id="appearance-panel" popover aria-label="${tr("main.themeMaterial")}">
  ${appearanceOptions()}
</section>
<div id="toast" role="status"></div>
<div class="modal-shade" id="palette" hidden><div class="palette" role="dialog" aria-label="${tr("main.findNotesOrCommands")}"><div class="palette-input">${icon('search')}<input id="command-input" aria-label="${tr("main.findFilesOrCommands")}" placeholder="${tr("main.findFilesOrType")} > ${tr("main.forCommands")}" autocomplete="off"><kbd>Esc</kbd></div><div id="command-results"></div><div class="palette-footer">${tr("main.selectEnterOpen")}</div></div></div>`);
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
  const label = maximized ? tr("main.restoreWindow") : tr("main.maximize");
  button.title = label;
  button.setAttribute('aria-label', label);
  button.firstElementChild.hidden = maximized;
  button.lastElementChild.hidden = !maximized;
});
function toast(message,actions=[]) {
  const node=$('#toast');
  node.textContent=message;
  for(const action of Array.isArray(actions)?actions:[]){
    const button=document.createElement('button');
    button.type='button';
    button.textContent=action.label;
    button.onclick=()=>Promise.resolve().then(action.run).catch(fail);
    node.append(button);
  }
  node.classList.add('show');
  node.classList.toggle('has-actions',node.querySelector('button')!==null);
  node.inert=false;
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>{node.classList.remove('show');node.inert=true;},node.classList.contains('has-actions')?9500:3600);
}
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
 crepe=new Crepe({root:$('#live-editor'),defaultValue:'',featureConfigs:{'code-mirror':{theme:oneMonokai},
   latex:{get katexOptions(){return mathOptions(preferences.macros);}},
   'block-edit':blockLabels,toolbar:toolbarLabels,'link-tooltip':{get inputPlaceholder(){return tr('editor.placeholderUrl');}},
   placeholder:{text:tr("main.writeSomethingOrTypeToInsert")},'image-block':{onUpload:file=>editorTools.upload(file)}}});
 crepe.editor.use($prose(()=>liveNotesPlugin((host,destination)=>{
   const path=current()?.path;
   if(path)embedCard(destination,path,new Set([fileKey(path)]),0,{remaining:48},preferences)
     .then(card=>host.replaceChildren(card)).catch(console.warn);
 })));
 crepe.editor.use(pagebreakNode).use(remarkPagebreak);
 crepe.editor.use($prose(()=>inlineMathView(()=>preferences.macros)));
 crepe.on(listener=>listener.markdownUpdated((ctx,md)=>{const doc=ctx.get(editorViewCtx).state.doc;if(!syncing&&mode==='live'&&doc!==liveDoc){liveDoc=doc;updateText(composeLive(current()?.text||'',md));}}));
 await crepe.create();
 if(preferences.vim&&!mobileLayout())await loadVim();
 sourceExtensions=[keymap.of([{key:'Enter',run:continueNumberedList}]),basicSetup,markdown({base:markdownLanguage,codeLanguages:languages}),oneMonokai,sourceMarkers,sourceOutlineFolds,EditorView.lineWrapping,EditorView.scrollMargins.of(()=>({top:$('.breadcrumb').offsetHeight})),EditorView.updateListener.of(u=>{if(u.docChanged)updateText(u.state.doc.toString());})];
 source=new EditorView({state:sourceEditorState(''),parent:$('#source-editor')});
}
function sourceEditorState(doc){
  return EditorState.create({doc,extensions:[vimConfig.of(vimExtensions()),editorLanguage.of(editorPhrases()),...sourceExtensions]});
}
function relocalizeEditors(){
  const effects=editorLanguage.reconfigure(editorPhrases());
  for(const tab of tabs)if(tab.sourceState)tab.sourceState=tab.sourceState.update({effects}).state;
  source?.dispatch({effects});
  if(crepe){
    crepe.editor.action(ctx=>ctx.update('placeholderConfigCtx',config=>({...config,text:tr("main.writeSomethingOrTypeToInsert")})));
    const view=liveView();
    view.dispatch(view.state.tr);
  }
}
function vimExtensions() {
  return preferences.vim&&!mobileLayout()&&vimModule?[vimModule.vim(),ViewPlugin.fromClass(class {
    constructor(view) {
      this.cm=vimModule.getCM(view);
      this.updateBadge=({mode})=>{$('#vim-mode').textContent=String(mode||'normal').toUpperCase();};
      this.cm?.on('vim-mode-change',this.updateBadge);
      this.updateBadge({mode:'normal'});
    }
    destroy(){this.cm?.off('vim-mode-change',this.updateBadge);}
  })]:[];
}
async function updateVim() {
  const active=Boolean(preferences.vim&&!mobileLayout());
  if(active&&!vimModule){
    await loadVim();
    if(!preferences.vim||mobileLayout())return;
  }
  source?.dispatch({effects:vimConfig.reconfigure(vimExtensions())});
  for(const tab of tabs) delete tab.sourceState;
  $('#vim-mode').hidden=!active||mode!=='source';
}
function continueNumberedList(view) {
  if (preferences.vim&&vimModule?.getCM(view)?.state?.vim?.insertMode===false) return false;
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
        toast(tr("main.liveEditingCouldNotRenderThisNote"));
        console.warn(error);
      }
    }
    if (mode==='source') {
      const text = tab?.text||'';
      source.setState(tab?.sourceState?.doc.toString()===text ? tab.sourceState : sourceEditorState(text));
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
      <span class="tab-unsaved" ${tab.dirty?`aria-label="${tr("canvasView.unsavedChanges")}"`:'hidden'}></span>
      ${tab.deleted?`<span class="tab-file-state">${tr("main.deleted")}</span>`:tab.conflict?`<span class="tab-file-state">${tr("main.externalChange")}</span>`:''}
      <button type="button" data-close="${escape(tab.id)}" aria-label="${tr("main.close")} ${escape(tab.name)}" title="${tr("main.closeNote")}">${icon('x')}</button>
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
  documentName.textContent = tab?.name||tr("main.noNoteOpen");
  documentName.title = tab?.path||tab?.name||'';
  documentName.disabled = !tab?.path;
  const container = $('#breadcrumb-root');
  const relative = tab?.path && relativePath(tab.path);
  const parent = relative && relative!==tab.path.replaceAll('\\','/') ? relative.split('/').slice(0,-1) : [];
  if (!root) {
    delete container.dataset.path;
    container.textContent = tr("main.personalSpace");
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
function stats(){drawSyncConflict();const t=current(),text=t?.text||'';const words=(text.match(/[\u3400-\u9fff]/g)||[]).length+(text.replace(/[\u3400-\u9fff]/g,' ').match(/[\p{L}\p{N}]+/gu)||[]).length;$('#word-count').textContent=tr("main.characters",{arg1:words.toLocaleString()});$('#read-time').textContent=tr("main.minRead",{arg1:Math.max(1,Math.ceil(words/400))});$('footer').dataset.saved=Boolean(t?.path&&!t.dirty&&!t.deleted&&!t.conflict);$('#save-state').textContent=!desktop?tr("main.browserPreview"):t?.deleted?tr("main.fileDeletedFromDisk"):t?.conflict?tr("main.externalChanges"):t?.holdAutoSave?tr("main.draftKeptSaveManually"):t?.dirty?(t.path?tr("canvasView.unsavedChanges"):tr("main.unsavedNote")):(t?.path?tr("main.savedLocally"):tr("main.localDraftRecovered"));$('#auto-save').textContent=tr("main.autoSave",{arg1:autoSave?tr("main.onShort"):tr("main.offShort")});$('#auto-save').setAttribute('aria-pressed',autoSave);}
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
 title.textContent={files:'',search:tr("main.searchVault"),links:tr("main.noteLinks"),tags:tr("main.tagIndex"),health:tr("main.vaultCheck")}[pane];
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
   $('#side-content').innerHTML = `<div class="search-box">${icon('search')}<input id="workspace-search" aria-label="${tr("main.searchWorkspace")}" placeholder="${tr("main.searchFileContents")}" value="${escape(renderSide.query||'')}"></div>
   <div class="search-options">${filter('search-regex',tr("main.regex"),renderSide.regex)}${filter('search-case',tr("main.caseSensitive"),renderSide.caseSensitive)}</div>
   <p class="search-description">${tr("main.supportsPathFileTagAndMultipleKeywords")}</p><div id="search-results"></div>`;
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
   $('#side-content').innerHTML=`<div class="tree-root">${icon('network')} ${tr("main.currentNoteLinks")}</div>`+
     ([...links].map(l=>`<button class="file-row link-note" data-wiki="${escape(l)}">${icon('link')}<span>${escape(l)}</span></button>`).join('')||
     `<p class="side-empty">${tr("main.linkYourIdeasWithNoteName")}</p>`);
 }
 else {
   const listing = loadingTree ? `<p class="side-empty" role="status">${tr("main.loadingWorkspace")}</p>` :
     files.length ? renderFileTree(files) : `<p class="side-empty">${tr("main.thisFolderHasNoMarkdownNotes")}</p>`;
   $('#side-content').innerHTML = root ? `<div class="tree-root" tabindex="-1">${icon('folder-closed')}<span>${escape(base(root)||root)}</span></div>${listing}` :
     `<div class="no-workspace"><p>${tr("main.openAFolderToBrowseNotes")}</p><button class="primary" data-action="folder">${icon('folder-open')}${tr("main.openFolder2")}</button><button class="quiet" data-action="open">${tr("main.openNote")}</button></div>`;
 }
 $('#workspace-name').textContent = root?base(root):tr("main.localWorkspace");
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
  results.textContent = tr("main.searching");
  const result=await vaultSearch.query({query,regex:renderSide.regex,caseSensitive:renderSide.caseSensitive,
    drafts:tabs.filter(tab=>tab.path&&tab.dirty&&!tab.deleted).map(tab=>({id:fileKey(tab.path),text:tab.text}))});
  if (!result||serial!==searchSerial) return;
  const {found,total,error}=result;
  if (error) {results.textContent=errorMessage(error);return;}
  results.innerHTML = found.length ? found.map(group=>`<details class="search-group" open><summary title="${escape(group.relative)}">${escape(base(group.relative))} <small>${group.hits.length}</small></summary>`+
    group.hits.map(hit=>`<button class="search-result" data-file="${escape(group.path)}" data-line="${hit.line || ''}"><span>${hit.line?hit.line+' · ':''}${escape(hit.text || group.relative)}</span></button>`).join('')+'</details>').join('')+
    (total>=250?`<p class="side-empty">${tr("main.showingTheFirst250Matches")}</p>`:'') : `<p class="side-empty">${tr("main.noMatchesFound")}</p>`;
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
   $('#backlinks').innerHTML = t?.path ? `<p class="side-empty" role="status">${tr("main.findingBacklinks")}</p>` : '';
 }
 let matches;
 try {
   matches = t?.path&&!t.deleted ? await platform.index.backlinks(t.path,tabs.filter(tab=>tab.path&&tab.dirty&&!tab.deleted).map(({path,text})=>({path,text}))) : [];
 } catch (error) {
   if (serial!==backlinkRequest) return;
   $('#backlinks').innerHTML = `<p class="side-empty">${tr("main.couldNotLoadBacklinks")}</p>`;
   throw error;
 }
 if (serial!==backlinkRequest) return;
 const linked = matches.filter(row=>row.linked.length);
 const mentions = matches.filter(row=>row.unlinked.length);
 $('#backlink-count').textContent=linked.length;
 const group=(rows,key)=>rows.map(row=>`<details class="backlink-group"><summary title="${escape(row.path)}">${escape(row.name)}</summary>
   ${row[key].map(hit=>`<button type="button" class="backlink-context" data-file="${escape(row.path)}" data-line="${hit.line}"><span class="backlink-line">${hit.line}</span><span>${backlinkExcerpt(hit)}</span></button>`).join('')}
   <button type="button" class="backlink" data-file="${escape(row.path)}" aria-label="${tr("main.open")} ${escape(row.name)}">${icon('file-text')}${tr("main.openNote2")}</button></details>`).join('');
 $('#backlinks').innerHTML=(linked.length?group(linked,'linked'):`<p class="side-empty backlinks-empty">${tr("main.notesThatLinkHereWillAppearIn")}</p>`)+
   (mentions.length?`<details class="unlinked-mentions"><summary>${tr("main.unlinkedMentions")} `+mentions.length+'</summary>'+group(mentions,'unlinked')+'</details>':'');
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
      const tab={id:uid(),path:file,name:base(file),text:data.text,saved:data.text,mtime:data.mtime,snapshot:data.snapshot,needsLf:data.needsLf,dirty:false,
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
function newDocument(text='',name=tr('main.untitledName'),builtin){let n=1;while(tabs.some(t=>t.name===name)){name=tr('main.numberedUntitledName',{count:++n});}const t={id:uid(),path:null,name,text,saved:builtin?text:'',mtime:null,dirty:!builtin&&!!text,builtin};tabs.push(t);activate(t.id);}
async function releaseUnusedFile(path) {
  if (path&&!tabs.some(tab=>tab.path&&fileKey(tab.path)===fileKey(path))) await platform.fs.release(path);
}
async function save(t=current(),saveAs=false,silent=false,resolution) {
  if (t===current()) flushLive();
  if (!t) return true;
  if (workspaceBusy) throw Error(tr("main.aFileActionIsRunningPleaseWait"));
  if (silent&&(t.deleted||t.conflict||t.holdAutoSave)) return false;
  if (t.deleted) saveAs=true;
  if (t.conflict&&!saveAs&&!resolution) {renderExternalNotice(current());return false;}
  clearTimeout(saveTimers.get(t.id));
  if (t.saving) {
    await t.saving;
    return resolution?false:t.text===t.saved||save(t,saveAs,silent);
  }
  if(!saveAs&&!resolution&&!t.dirty&&t.path){
    const baseline=t.snapshot;
    await checkOpenTabs([t]);
    if(t.deleted||t.conflict)return false;
    if(t.snapshot!==baseline||silent||!t.needsLf)return true;
  }
  const draft=t.text,previousPath=t.path;
  const text=normalizeLineEndings(previousPath||t.name,draft);
  t.saving=(async()=>{
    const expected=resolution?t.conflict:t;
    const r=await platform.fs.save({path:previousPath,name:t.name,text:resolution==='reload'?draft:text,
      saved:resolution?expected.text:t.saved,mtime:expected.mtime,snapshot:expected.snapshot,saveAs,resolution});
    if (!r) return false;
    if (r.conflict) {
      if (r.mtime===undefined) {t.deleted=true;scheduleSave(t);}
      else if(!t.dirty&&!resolution){
        replaceFromDisk(t,r);
        if(t===current()){syncEditors();restoreScroll();}
        toast(tr('dataSafety.reloaded'));
      }else flagConflict(t,r);
      renderTabs();stats();session();
      return false;
    }
    if(r.reloaded){
      if(t===current())flushLive();
      replaceFromDisk(t,r,t.text!==draft);
      if(t===current()){syncEditors();restoreScroll();}
      renderTabs();stats();workspaceFeatures.refreshSplit();await persist();
      toast(tr('dataSafety.reloaded'));
      return true;
    }
    if(r.text!==undefined&&r.text!==text){
      flagConflict(t,r);
      renderTabs();stats();session();
      return false;
    }
    delete t.conflict;
    delete t.deleted;
    delete t.holdAutoSave;
    if(t.text===draft)t.text=text;
    t.needsLf=false;
    t.path=r.path;t.name=base(r.path);t.mtime=r.mtime;t.snapshot=r.snapshot;t.saved=text;t.dirty=t.text!==text;
    scheduleSave(t);
    await releaseUnusedFile(previousPath);
    renderTabs();stats();await persist();
    if(!previousPath||fileKey(previousPath)!==fileKey(r.path))files=await platform.workspace.tree();
    else {
      const row=flat(files).find(file=>fileKey(file.path)===fileKey(r.path));
      if(row)row.modified=r.mtime;
    }
    renderSide();
    if (!silent) toast(tr("main.savedLocally"));
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
  $('#vim-mode').hidden=mobileLayout()||mode!=='source'||!preferences.vim||!vimModule;
  linkCompletion?.close();
  const tab = current();
  const meta = splitFrontmatter(tab?.text||'');
  const propertyCard = meta.prefix ? propertiesCard(meta.yaml) : null;
  if (propertyCard) {
    const edit = document.createElement('button');
    edit.dataset.action = 'properties';
    edit.textContent = tr("main.editProperties");
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
  jump.textContent=tr("main.openOriginal");
  header.append(label,jump);
  card.append(header);
  const status=message=>{
    const warning=document.createElement('p');
    warning.className='embed-status';
    warning.textContent=message;
    card.append(warning);
    return card;
  };
  if(!path)return status(tr("main.saveThisNoteToPreviewEmbeds"));
  if(budget.remaining--<=0||depth>=12)return status(tr("main.embedDepthLimitReached"));
  if(/\.(?:png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(destination)){
    const img=document.createElement('img');
    img.alt=destination;
    if(nativeMobile){
      const url=await platform.fs.imageSource(path,destination,true);
      if(!url)return status(tr("main.embeddedImageNotFound"));
      img.addEventListener('error',()=>platform.export.image(url).then(data=>{img.src=data;}).catch(console.warn),{once:true});
      img.src=url;
    }else img.src=localImage(destination,path);
    return img;
  }
  const target=await platform.index.target({source:path,destination,wiki:true});
  if(!target){
    const [detail]=await platform.index.links({source:path,destinations:[destination]});
    return status(detail?.status==='ambiguous'?tr("main.severalNotesShareThisNameUseA"):tr("main.theEmbeddedNoteHasNotBeenCreated"));
  }
  label.textContent=base(target.path)+(target.heading?' · '+target.heading:'');
  const ancestors=enterEmbed(visited,target.path,fileKey);
  if(!ancestors)return status(tr("main.circularEmbedDetected"));
  const text=findDocumentTab(target.path)?.text ?? (await platform.fs.read(target.path)).text;
  const content=document.createElement('div');
  await renderContent(content,text,target.path,ancestors,depth+1,budget,settings,target.heading);
  if(!content.childNodes.length)return status(tr("main.embeddedHeadingNotFound"));
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
      edit.textContent=tr("main.editProperties");
      properties.append(edit);
    }
    if(mobileLayout())wrapReadingTables(container);
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
     return toast(tr("main.severalNotesMatchThisLinkSelectA"));
   }
   if(isWiki&&(!detail||detail.status==='placeholder'))return workspaceUI.createMissing(destination,sourcePath);
   return toast(tr("main.linkTargetNotFound"));
 }
 if(!await openFile(target.path))return;
 if (target.heading?.startsWith('^')) {
   const id=target.heading.slice(1);
   if (mode!=='read') await setMode('read');
   const block=[...$('#reading').querySelectorAll('[data-block-id]')].find(element=>element.dataset.blockId===id);
   if(block)block.scrollIntoView({block:'center'});
   else toast(tr("main.linkedParagraphNotFound"));
   return;
 }
 if(target.heading){
   const i=headingIndex(headings(),target.heading);
   if(i>=0)jumpHeading(i);
   else toast(tr("main.linkedHeadingNotFound"));
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
function localizedCommands(){
const commands=[['new',tr("main.newMarkdownNote"),'Ctrl N','file-plus-2'],['open',tr("main.openNote"),'Ctrl O','file-text'],['folder',tr("main.openFolder"),'Ctrl Shift O','folder-open'],['save',tr("main.saveCurrentNote"),'Ctrl S','save'],['saveAs',tr("main.saveAs"),'Ctrl Shift S','copy'],['pdf',tr("main.exportPdf2"),'','file-down'],['html',tr("main.exportStandaloneHtml"),'','file-down'],['png',tr("main.exportLongImageOrSelection"),'','image'],['history',tr("main.viewVersionHistory"),'','history'],['activity',tr("activity.title"),'','history'],['settings',tr("main.editorMathSettings"),'','settings'],['typewriter',tr("main.toggleTypewriterMode"),'','align-center'],['paragraph',tr("main.toggleParagraphFocus"),'','scan'],['live',tr("main.switchToLive"),'','pen-line'],['source',tr("main.switchToSource"),'','code-2'],['read',tr("main.switchToRead"),'','book-open'],['focus',tr("main.toggleFocusMode"),'F8','scan'],['theme',tr("main.toggleLightAndDark"),'','sun-moon'],['autosave',tr("main.toggleAutoSave"),'','save'],['reveal',tr("main.showInFileExplorer"),'','folder-search'],['help',tr("main.guideShortcuts"),'','circle-help']];
commands.push(
  ['bookmarks',tr("main.openBookmarks"),'','bookmark'],['bookmarkHeading',tr("main.bookmarkCurrentNoteOrHeading"),'','bookmark-plus'],
  ['reopen',tr("main.reopenClosedNote"),'Ctrl Shift T','history'],['split',tr("main.openCurrentNoteInRightSplit"),'','columns-2'],
  ['graph',tr("main.openVaultGraph"),'','network'],['localGraph',tr("main.openLocalGraph"),'','git-fork'],
  ['canvas',tr("main.openCanvas"),'','panels-top-left'],['bases',tr("main.openPropertiesViewBases"),'','table'],
  ['template',tr("main.insertNoteTemplate"),'','file-text'],['daily',tr("main.openDailyNote"),'','calendar-days'],
  ['random',tr("main.openRandomNote"),'','shuffle'],['vaultHealth',tr("main.vaultCheck"),'','heart-pulse'],
  ['linkReferences',tr("main.updateMarkdownReferenceDefinitions"),'','link-2'],
  ['properties',tr("main.editNoteProperties"),'','list-checks'],['exportSettings',tr("main.pdfMathSettings"),'','settings'],
  ['docx',tr("main.exportWordPandoc"),'','file-down'],['epub',tr("main.exportEpubPandoc"),'','file-down']
);
commands.push(...[
  ['palette',tr("main.openCommandPalette")],['find',tr("main.findInNote")],['searchWorkspace',tr("main.searchWorkspace2")],['sidebar',tr("main.toggleFileSidebar")],
  ['closeTab',tr("main.closeCurrentTab")],['nextTab',tr("main.nextTab")],['previousTab',tr("main.previousTab")],['shortcuts',tr("main.shortcutSettings")],
  ['vim',tr("main.toggleVimKeysInSource")],['formatTable',tr("main.formatCurrentMarkdownTable")],['formatTables',tr("main.formatAllMarkdownTables")],
  ['renumberList',tr("main.renumberOrderedList")],['tasks',tr("main.toggleTask")],['wrapBold',tr("main.makeBold")],['wrapItalic',tr("main.makeItalic")],
  ['wrapCode',tr("main.formatAsInlineCode")],['wrapStrike',tr("main.applyStrikethrough")],['wrapMath',tr("main.formatAsInlineMath")],['toc',tr("main.updateTableOfContents")],
  ['numberHeadings',tr("main.updateSectionNumbersSkipH1")],['numberAllHeadings',tr("main.updateSectionNumbersIncludeH1")],['clearHeadings',tr("main.clearSectionNumbers")],['exportCenter',tr("main.openExportCenter")],['copyRich',tr("main.copyAsRichText")],['portableMarkdown',tr("main.exportPortableMarkdownBundle")]
].map(([id,label])=>[id,label,'','command']));
return commands;
}
let commands=localizedCommands();
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
function filterCommands(){const q=$('#command-input').value.toLowerCase().trim();const search=q.replace(/^>/,'').trim();commandRows=[...(!q.startsWith('>')?flat().filter(f=>f.name.toLowerCase().includes(search)).slice(0,12).map(f=>({label:f.name,detail:f.path,icon:'file-text',path:f.path})):[]),...commands.filter(c=>c[1].toLowerCase().includes(search)||c[0].toLowerCase().includes(search)).map(c=>({action:c[0],label:c[1],detail:keycaps(({...defaultShortcuts,...preferences.shortcuts})[c[0]],mac),icon:c[3]}))];commandIndex=Math.min(commandIndex,Math.max(0,commandRows.length-1));$('#command-results').innerHTML=commandRows.map((c,i)=>`<button class="command-row ${i===commandIndex?'chosen':''}" data-command="${i}">${icon(c.icon)}<span>${escape(c.label)}</span><small>${escape(c.path?base(c.detail.replace(/[\\/][^\\/]+$/,'')):c.detail)}</small></button>`).join('')||`<p class="side-empty">${tr("main.noMatchingFilesOrCommands")}</p>`;glyphs();}
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
  if(!opened.size)side.innerHTML=`<p class="side-empty">${tr("main.loadingTags")}</p>`;
  const notes=new Map((await platform.index.notes('metadata',pendingDrafts())).map(note=>[fileKey(note.path),note]));
  for(const tab of tabs)if(tab.path&&!tab.deleted&&!notes.has(fileKey(tab.path)))
    notes.set(fileKey(tab.path),{path:tab.path,tags:[...noteTags(tab.text,marked)]});
  if(pane!=='tags'||request!==tagRequest)return;
  const tree=tagTree(notes.values());
  const row=({label,tag,paths,children})=>{
    const active=selectedTag===tag;
    const action='<button type="button" class="tag-filter" aria-pressed="'+active+'">'+tr("main.all")+escape(tag)+' · '+paths.length+'</button>';
    const files=active||!children.length?paths.map(path=>
      '<button class="file-row" title="'+escape(path)+'" data-file="'+escape(path)+'">'+escape(base(path))+'</button>').join(''):'';
    return '<details class="tag-group" data-tag="'+escape(tag)+'" '+(opened.has(tag)||active?'open':'')+'>'+
      '<summary>#'+escape(label)+' <small>'+paths.length+'</small></summary>'+action+files+children.map(row).join('')+'</details>';
  };
  side.innerHTML=tree.map(row).join('')||`<p class="side-empty">${tr("main.noTagsInThisWorkspace")}</p>`;
  for(const button of side.querySelectorAll('.tag-filter'))button.onclick=()=>{
    selectedTag=button.closest('[data-tag]').dataset.tag;
    renderTags().catch(fail);
  };
}
async function renderHealth(){
  const request=++healthRequest, side=$('#side-content');
  if(!root){side.innerHTML=`<p class="side-empty">${tr("main.openAVaultToRunVaultCheck")}</p>`;return;}
  const opened=new Map([...side.querySelectorAll('[data-health]')].map(el=>[el.dataset.health,el.open]));
  if(!opened.size)side.innerHTML=`<p class="side-empty" role="status">${tr("main.readingVaultIndex")}</p>`;
  const {orphans,issues}=await platform.index.health(pendingDrafts());
  if(pane!=='health'||request!==healthRequest)return;
  const group=(id,label,entries)=>'<details class="pkm-health" data-health="'+id+'" '+(opened.get(id)??true?'open':'')+
    '><summary>'+label+' <small>'+entries.length+'</small></summary>'+
    (entries.join('')||`<p class="side-empty">${tr("main.none")}</p>`)+'</details>';
  const issueRow=(issue,i)=>{
    const heading=issue.status==='ambiguous'?tr("main.ambiguousLinks"):issue.status==='broken-heading'?tr("main.missingHeadings"):
      issue.status==='broken'?tr("main.brokenLinks"):tr("main.pending");
    const fixes=issue.status==='placeholder'?'<button type="button" data-create-placeholder="'+i+`">${tr("main.newNote2")}</button>`:
      (issue.candidates||[]).map((candidate,j)=>'<button type="button" data-fix-issue="'+i+'" data-candidate="'+j+'">'+
        escape(candidate.identifier)+'</button>').join('');
    return '<article class="health-issue"><button type="button" class="backlink-context" data-file="'+escape(issue.source)+
      '" data-line="'+issue.line+'"><span><strong>'+heading+' · '+escape(issue.destination)+'</strong><small>'+
      escape(relativePath(issue.source))+':'+issue.line+'</small><span>'+backlinkExcerpt(issue)+'</span></span></button>'+
      (fixes?'<div class="health-actions">'+fixes+'</div>':'')+'</article>';
  };
  const groups=[[],[]];
  issues.forEach((issue,i)=>groups[Number(issue.status!=='placeholder')].push(issueRow(issue,i)));
  side.innerHTML=group('orphans',tr("main.orphans"),orphans.map(path=>
    '<button type="button" class="file-row" data-file="'+escape(path)+'" title="'+escape(path)+'">'+escape(relativePath(path))+'</button>'))+
    group('placeholders',tr("main.placeholders"),groups[0])+group('broken',tr("main.brokenAmbiguousLinks"),groups[1]);
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
      toast(`${tr("main.linkUpdatedTo")} `+candidate.label);
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
  if(!tab?.path)return toast(tr("main.saveTheNoteFirst"));
  if(!root)return toast(tr("main.openAWorkspaceFirst"));
  const previous=tab.text;
  const {text,count}=await updateReferenceDefinitions(previous,async destinations=>{
    const targets=[];
    for(let i=0;i<destinations.length;i+=256)targets.push(...await platform.index.links({
      source:tab.path,destinations:destinations.slice(i,i+256)
    }));
    return targets.map(target=>target?.status==='ok'?target:null);
  },path=>relativeNotePath(tab.path,path,fileKey));
  if(current()!==tab||tab.text!==previous)return toast(tr("main.theNoteChangedGenerateTheReferenceDefinitions"));
  if(text!==previous)await updatePkmNote(tab.path,previous,text);
  toast(`${tr("main.added")} `+count+` ${tr("main.referenceDefinitions")}`);
}

function flagConflict(tab,disk,origin) {
  const first=!tab.conflict;
  tab.conflict={...disk,origin};
  scheduleSave(tab);
  if (first&&origin==='sync') {
    const stamp=localTimestamp();
    const path=tab.path.replaceAll('\\','/'),name=base(tab.path);
    const suffix=name.match(/\.[^.]+$/)?.[0]||'.md';
    const copy=name.slice(0,-suffix.length)+' ('+tr("main.syncDraft")+' '+stamp+' '+(Date.now()%1000000)+')'+suffix;
    platform.workspace.edit({type:'note',parent:path.slice(0,path.lastIndexOf('/')),name:copy,text:tab.text})
      .then(async result=>{
        if(!tab.conflict||tab.conflict.origin!=='sync')return;
        tab.conflict.copy=result.path;session();
      }).catch(error=>console.warn(errorMessage(error)));
  }else if(first&&tab===current())toast(tr("main.anotherProgramChangedThisFileViewThe"));
}

function renderExternalNotice(tab) {
  const notice=$('#external-change');
  const state=tab?.deleted?'deleted':tab?.conflict?'conflict':'';
  notice.hidden=!state;
  if (notice.dataset.state===state&&notice.dataset.locale===getLocale()) return;
  notice.dataset.state=state;
  notice.dataset.locale=getLocale();
  if (state==='deleted') notice.innerHTML=`<span role="status">${tr("main.theOriginalFileWasDeletedYouCan")}</span>`+
    `<button data-external-action="save-as">${tr("main.saveAs2")}</button><button data-external-action="close">${tr("main.closeTab")}</button>`;
  else if (state==='conflict') notice.innerHTML='<span role="status">'+(tab.conflict.origin==='sync'?tr("main.aSyncedVersionArrivedYourDraftWas"):tr("main.theFileOnDiskChangedYourDraft"))+'</span>'+
    `<button data-external-action="diff">${tr("main.viewDiff")}</button><button data-external-action="reload">${tr("dataSafety.loadDisk")}</button>`+
    `<button data-external-action="keep">${tr("dataSafety.overwrite")}</button>`;
  else notice.replaceChildren();
}

function replaceFromDisk(tab,disk,keepDraft=false) {
  tab.saved=disk.text;
  tab.mtime=disk.mtime;
  tab.snapshot=disk.snapshot;
  tab.needsLf=disk.needsLf;
  if (!keepDraft) tab.text=disk.text;
  tab.dirty=tab.text!==tab.saved;
  tab.holdAutoSave=keepDraft&&tab.dirty;
  delete tab.deleted;
  delete tab.conflict;
  scheduleSave(tab);
}

async function resolveExternalNotice(action,reviewed) {
  const tab=current();
  if (!tab) return;
  if (action==='diff'&&tab.conflict) return showHistory(tab,tab.conflict);
  if (action==='close') return closeTab(tab.id);
  if (action==='save-as') return save(tab,true);
  if (!tab.conflict) return;
  if(reviewed&&!sameSnapshot(reviewed.snapshot,tab.conflict.snapshot)){
    toast(tr('dataSafety.reviewAgain'));
    return;
  }
  if(!await save(tab,false,false,action==='reload'?'reload':'overwrite'))return;
  if(tab===current()&&mode==='source')source.focus();
  if(tab===current()&&mode==='live')liveView().focus();
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
  await checkOpenTabs(affected,batch.source,batch.root);
}

async function checkOpenTabs(affected=tabs,origin,workspace=root) {
  const snapshots=await Promise.all(affected.filter(tab=>tab.path).map(async tab=>{
    const path=tab.path;
    await tab.saving?.catch(()=>{});
    const baseline=tab.snapshot,mtime=tab.mtime,known=tab.saved;
    const disk=await platform.fs.read(path,true).catch(error=>{console.warn(errorMessage(error));return undefined;});
    return {tab,path,disk,baseline,mtime,known};
  }));
  if(root!==workspace)return;
  flushLive();
  let refresh=false,changed=false,reloaded=false;
  for(const {tab,path,disk,baseline,mtime,known} of snapshots){
    if(disk===undefined||tab.path!==path||!tabs.includes(tab)||tab.saving||
      tab.snapshot!==baseline||tab.mtime!==mtime||tab.saved!==known)continue;
    if(!disk){
      if(tab.deleted)continue;
      tab.deleted=true;
      delete tab.conflict;
      scheduleSave(tab);
    }else{
      const unchanged=baseline?sameSnapshot(baseline,disk.snapshot):disk.mtime===mtime&&disk.text===known;
      if(unchanged&&!tab.deleted&&!tab.conflict&&baseline)continue;
      delete tab.deleted;
      if(!unchanged&&tab.dirty){
        flagConflict(tab,disk,origin);
      }else if(unchanged&&tab.dirty){
        tab.snapshot=disk.snapshot;
        delete tab.conflict;
        scheduleSave(tab);
      }else{
        if(tab===current()&&tab.text!==disk.text){captureEditors();refresh=true;}
        replaceFromDisk(tab,disk);
        reloaded ||= !unchanged;
      }
    }
    changed=true;
  }
  if(refresh){syncEditors();restoreScroll();}
  if(changed){renderTabs();stats();workspaceFeatures.refreshSplit();session();}
  if(reloaded)toast(tr('dataSafety.reloaded'));
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
  const directories=`<label>${tr("main.imageLocation")}<select name="attachmentStrategy">`+select('workspace',tr("main.workspaceRoot"))+select('note',tr("main.noteFolder"))+'</select></label>'+
    field('workspaceAttachments',tr("main.workspaceAttachmentsFolder"))+field('noteAttachments',tr("main.noteAttachmentsFolderSupportsFilename"))+
    field('newNoteDirectory',tr("main.vaultSubfolderForNewLinkedNotesLeave"))+
    field('templateDirectory',tr("main.templatesFolderRelativeToWorkspace"))+
    field('dailyDirectory',tr("main.dailyNotesFolderRelativeToWorkspace"))+
    field('dailyFilePattern',tr("main.dailyNoteFilenameFormatYyyyMmDd"))+
    field('dailyTemplate',tr("main.dailyNoteTemplateRelativeToWorkspaceOptional"));
  const compression=checkbox('webpCompression',tr("main.convertLargePastedImagesToWebp"))+
    `<label>${tr("main.maxWidthPx")}<input name="webpWidth" type="number" min="256" max="3840" required value="`+preferences.webpWidth+'"></label>'+
    `<label>${tr("main.webpQuality")}<input name="webpQuality" type="number" min=".1" max="1" step=".01" required value="`+preferences.webpQuality+'"></label>';
  const editing=`<label>${tr("main.snapshotsPerNote")}<input name="historyLimit" type="number" min="1" max="100" required value="`+preferences.historyLimit+'"></label>'+
    checkbox('typewriter',tr("documentMenu.typewriterMode"))+checkbox('paragraphFocus',tr("documentMenu.paragraphFocus"))+
    (mobile?checkbox('mobileLiveEditing',tr("main.enableLiveEditingExperimental")):checkbox('vim',tr("main.enableVimKeysInSource")));
  const formulas=checkbox('numberEquations',tr("exportCenter.numberDisplayEquations"))+
    `<label>${tr("main.katexMacros")}<textarea name="macroInput" rows="4" maxlength="32000">`+
    escape(Object.entries(preferences.macros||{}).map(([key,value])=>key+' = '+value).join('\n'))+'</textarea></label>';
  const save=`<p role="status"></p><div class="feature-buttons"><button class="primary" type="submit">${tr("main.saveSettings")}</button></div>`;
  panel.innerHTML=mobile?'<form class="lg-settings-form"><div class="lg-settings-scroll">'+
    settingsGroup(tr("main.foldersAttachments"),directories)+settingsGroup(tr("main.imageCompression"),compression)+
    settingsGroup(tr("main.editor"),editing)+settingsGroup(tr("main.mathMacros"),formulas)+
    '</div><div class="lg-footer">'+save+'</div></form>':
    '<form>'+settingsGroup(tr("main.foldersAttachments"),directories)+settingsGroup(tr("main.imageCompression"),compression)+
    settingsGroup(tr("main.editor"),editing)+settingsGroup(tr("main.mathMacros"),formulas)+'<div class="lg-footer">'+save+'</div></form>';
  const fields=panel.querySelector('form'),status=fields.querySelector('[role=status]'),button=fields.querySelector('[type=submit]');
  fields.addEventListener('submit',async event=>{
    event.preventDefault();
    button.disabled=true;
    try {
      await saveWritingSettings(new FormData(fields));
      status.textContent=tr("main.settingsSaved");
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
      throw Error(tr("main.enterAPathRelativeToTheWorkspace"));
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
      throw Error(tr("main.templatesAndDailyNotesRequirePathsInside"));
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
  await updateVim();
  refreshLiveMath(liveView(),preferences.macros);
  if(mode==='read')renderRead();
  workspaceFeatures?.refreshSplit();
  editorTools.updateFocus();
  toast(tr("main.settingsSaved2"));
}

async function showExportSettings() {
  const pdf=preferences.pdf||{};
  const form=await workspaceUI.ask(tr("main.pdfMathSettings"),
    `<label>${tr("exportCenter.paper")}<select name="paper">`+['A4','A5','Letter'].map(paper=>'<option '+(pdf.paper===paper?'selected':'')+'>'+paper+'</option>').join('')+'</select></label>'+
    `<label>${tr("main.topAndBottomMarginsIn")}<input name="vertical" type="number" min=".25" max="2" step=".05" value="`+(pdf.vertical??.5)+'" required></label>'+
    `<label>${tr("main.leftAndRightMarginsIn")}<input name="horizontal" type="number" min=".25" max="2" step=".05" value="`+(pdf.horizontal??.55)+'" required></label>'+
    `<label>${tr("main.headerSupports")}<input name="header" maxlength="160" value="`+escape(pdf.header||'')+'"></label>'+
    `<label>${tr("main.footerSupports")}<input name="footer" maxlength="160" value="`+escape(pdf.footer||'')+'"></label>'+
    settingToggle('pageNumbers',tr("main.showPageNumbers"),{checked:pdf.pageNumbers})+
    settingToggle('chapters',tr("exportCenter.pageBreakBeforeTopLevelHeadings"),{checked:pdf.chapters})+
    settingToggle('numberEquations',tr("exportCenter.numberDisplayEquations"),{checked:preferences.numberEquations}),tr("main.saveSettings"));
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
  toast((action==='typewriter'?tr("documentMenu.typewriterMode"):tr("documentMenu.paragraphFocus"))+(preferences[key]?tr("main.on"):tr("main.off2")));
}

let historyDialog, historyEditor, historySerial=0;
async function showHistory(tab, conflict) {
  if (!tab?.path) { if (!conflict) toast(tr("main.saveTheNoteFirst2")); return; }
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
  historyDialog.innerHTML='<header><h2>'+escape(conflict?.row?tr("main.syncConflict"):conflict?tr("main.externalChangeConflict"):tr("main.versionHistory"))+`</h2><form method="dialog"><button aria-label="${tr("main.closeVersionHistory")}">×</button></form></header>`+
    '<p>'+escape(tab.name)+(conflict&&!conflict.row?'':`　${tr("main.greenMarksTextAddedInTheCurrent")}`)+'</p>'+
    `<div class="history-controls"><select aria-label="${tr("main.compareVersions")}">`+(conflict?`<option value="disk">${tr("main.diskVersion")}</option>`:'')+
    snapshots.map(row=>'<option value="'+escape(row.id)+'">'+escape(new Date(row.time).toLocaleString(getLocale())+
      (row.label?' · '+row.label:row.id==='legacy'?` ${tr("main.earlierBackup")}`:''))+'</option>').join('')+'</select>'+
    `<button type="button" data-version="restore" hidden>${tr("main.restoreThisVersion")}</button><button type="button" data-version="copy" hidden>${tr("main.saveAsNewNote")}</button>`+
    (conflict?.row?`<button data-sync-choice="keep">${tr("main.keepCurrentVersion")}</button><button data-sync-choice="apply">${tr("main.useConflictVersion")}</button>`+
      (markdownPath.test(tab.path)?`<button data-sync-choice="manual">${tr("main.mergeManually")}</button>`:''):conflict?`<button data-conflict="copy">${tr("main.saveAs2")}</button>`:'')+
    '</div><div class="history-diff"></div>';
  const select=historyDialog.querySelector('select');
  const parent=historyDialog.querySelector('.history-diff');
  if(conflict&&!conflict.row){
    const decisions=document.createElement('div');
    decisions.className='feature-buttons';
    decisions.innerHTML=`<button type="button" data-resolution="reload">${tr("dataSafety.loadDisk")}</button><button type="button" data-resolution="keep">${tr("dataSafety.overwrite")}</button>`;
    decisions.addEventListener('click',event=>{
      const choice=event.target.closest('button')?.dataset.resolution;
      if(choice){historyDialog.close();resolveExternalNotice(choice,conflict).catch(fail);}
    });
    historyDialog.append(decisions);
  }
  if(conflict?.row) {
    const versions=document.createElement('details');
    versions.innerHTML=`<summary>${tr("main.viewFullVersion")}</summary><div class="sync-versions"><section><h3>${tr("main.currentVersion")}</h3><pre></pre></section><section><h3>${tr("main.conflictVersion")}</h3><pre></pre></section></div>`;
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
    if(!id){parent.textContent=tr("main.noSnapshotsYet");select.disabled=true;return;}
    const before=id==='disk'?conflict.text:await platform.fs.history(tab.path,id);
    if(serial!==historySerial||version!==viewSerial)return;
    historyEditor?.destroy();
    parent.replaceChildren();
    if(id==='disk'&&!conflict.row)
      sideBySideDiff(parent,before,tab.text,[tr("main.diskVersion"),tr("dataSafety.myDraft")]);
    else historyEditor=diffView(parent,before,tab.text);
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
      if(tab.dirty||tab.conflict)throw Error(tr("main.saveYourDraftOrSaveItAs"));
      const {id,text}=selectedVersion;
      if(id.startsWith('sync-'))await platform.sync.restoreVersion(tab.path,id);
      else {
        const saved=await platform.fs.save({path:tab.path,text,saved:tab.saved,mtime:tab.mtime,snapshot:tab.snapshot});
        if(!saved||saved.conflict)throw Error(tr("main.theFileChangedReopenVersionHistory"));
      }
      if(tabs.includes(tab))await updateTabsFromDisk({root,changes:[{path:tab.path,type:'change'}]});
      historyDialog.close();
      toast(tr("main.versionRestored"));
    }catch(error){fail(error);}
    finally{restore.disabled=false;}
  };
  copyVersion.onclick=async()=>{
    if(!selectedVersion||copyVersion.disabled)return;
    copyVersion.disabled=true;
    try{
      const name=tab.name.replace(/\.(?:md|markdown|mdown)$/i,'')+tr("main.historicalVersionMd");
      const saved=await platform.fs.save({name,text:selectedVersion.text,saveAs:true});
      if(saved?.path){
        historyDialog.close();
        files=await platform.workspace.tree();
        await openFile(saved.path);
        toast(tr("main.savedAsANewNote"));
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
  toast(tr("main.noNotesToReopen"));
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
      const options = [['name',tr("main.nameNaturalOrder")],['modified',tr("main.modified")],['created',tr("main.created")]];
      const form = await workspaceUI.ask(tr("main.sortFiles"),`<label>${tr("main.sortOrder")}<select name="sort">`+
        options.map(([value,label])=>'<option value="'+value+'" '+(treeSort===value?'selected':'')+'>'+label+'</option>').join('')+
        '</select></label>'+(mobileLayout()?settingToggle('descending',tr("main.descending"),{checked:treeDescending}):
          settingToggle('descending',tr("main.descending"),{checked:treeDescending})));
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
  activityView=createActivityView({platform,root:()=>root,escape,ask:(...args)=>workspaceUI.ask(...args),
    toast,fail,openFile,applyUndo:(entry,token)=>lockWorkspace(async()=>{
      flushLive();
      const affected=new Set(entry.files.map(row=>fileKey((row.path||row.from).replaceAll('\\','/'))));
      const currentRoot=root.replaceAll('\\','/').replace(/\/$/,'');
      if(entry.type!=='trash'&&tabs.some(tab=>tab.path&&tab.dirty&&affected.has(fileKey(tab.path.replaceAll('\\','/').slice(currentRoot.length+1)))))
        throw Error(tr('activity.unsavedDraft'));
      const result=await platform.activity.undo(entry.id,token);
      if(!result.activity)return result;
      files=result.tree;
      const changed=new Map(result.affected.filter(row=>row.from).map(row=>[fileKey(row.from),row.path]));
      for(const tab of tabs.filter(tab=>tab.path)){
        const next=changed.get(fileKey(tab.path));
        if(!next)continue;
        const disk=await platform.fs.read(next,true);
        if(!disk)continue;
        if(next!==tab.path)delete tab.liveState;
        tab.path=next;
        tab.name=base(next);
        replaceFromDisk(tab,disk);
      }
      if(result.from&&result.path){
        for(const bookmark of workspaceState().bookmarks)if(containsPath(result.from,bookmark.path,fileKey))
          bookmark.path=result.path+bookmark.path.slice(result.from.length);
      }
      await refreshWorkspaceView();
      return result;
    })});
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
    refresh:refreshWorkspaceView,openFile,flush:flushLive,withLocked:lockWorkspace,toast,fail,
    notifyActivity:activityView.notify,settings:()=>preferences
  });
  const readText=async path=>tabs.find(tab=>tab.path===path)?.text ?? (await platform.fs.read(path)).text;
  const updateNote=updatePkmNote=async (path,previous,text)=>{
    const tab=findDocumentTab(path);
    if(tab){
      if(tab===current())flushLive();
      if(tab.text!==previous)throw Error(tr("main.theNoteChangedRefreshAndTryAgain"));
      if(tab===current())applyEditorText(text);
      else {tab.text=text;tab.dirty=text!==tab.saved;}
      if(!await save(tab))throw Error(tr("main.yourChangesAreInTheDraftResolve"));
      return;
    }
    const disk=await platform.fs.read(path);
    if(disk.text!==previous)throw Error(tr("main.theNoteChangedRefreshAndTryAgain"));
    const result=await platform.fs.save({path,text,saved:disk.text,mtime:disk.mtime,snapshot:disk.snapshot});
    if(!result||result.conflict)throw Error(tr("main.anotherProgramChangedThisNote"));
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
      if(!preview.hasChildNodes())preview.textContent=tr("main.linkedHeadingNotFound");
      for(const anchor of preview.querySelectorAll('a'))anchor.dataset.noteSource=target.path;
      await resolveImages(preview,target.path);
    }else if(isWiki){
      const [detail]=await platform.index.links({source:path,destinations:[destination]});
      preview.textContent=detail?.status==='ambiguous'?tr("main.severalNotesMatchThisNameSelectA"):tr("main.thisNoteHasNotBeenCreated");
    }else return;
    if(serial!==previewSerial)return;
    const label=target?base(target.path):destination;
    if(mobile){
      mobileShell.panel(label,'link-preview',(content,close)=>{
        const open=document.createElement('button');
        open.type='button';
        open.className='primary';
        open.textContent=target?tr("main.openOriginal"):tr("main.viewLink");
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
    await renderContent(div,selection?.markdown??tab.text,tab.path,undefined,undefined,undefined,
      {...preferences,numberEquations:options.numberEquations,externalPreview:tab.externalPreview});
    await renderDiagrams(div);
  }
  for(const element of div.querySelectorAll('[data-section-hidden]')) element.removeAttribute('data-section-hidden');
  for(const link of div.querySelectorAll('a[data-wiki]'))link.replaceWith(...link.childNodes);
  for(const link of div.querySelectorAll('[data-note-source]'))link.removeAttribute('data-note-source');
  await Promise.all([...div.querySelectorAll('img')].map(async img=>{
    if(img.src.startsWith('note-image:')||platform.export.isLocalImage?.(img.src))img.src=await platform.export.image(img.src);
  }));
  const {organizeExport}=await loadExportCenter();
  organizeExport(div,options);
  return div;
}
async function exportMathCSS(div) {
  if(!div.querySelector('.katex'))return '';
  const {default:katexCSS}=await import('katex/dist/katex.min.css?raw');
  const pattern=/url\(fonts\/([^)]+\.woff2)\)\s*format\("woff2"\)(?:\s*,[^;}]+)?/g;
  const needed=[...new Set([...katexCSS.matchAll(pattern)].map(match=>match[1]))];
  const resolved=Object.fromEntries(await Promise.all(needed.map(async font=>{
    const loader=mathFonts['../node_modules/katex/dist/fonts/'+font];
    return [font,loader?await loader():''];
  })));
  return katexCSS.replace(pattern,(_,font)=>resolved[font]?'url('+resolved[font]+') format("woff2")':'');
}
function defaultExportPreferences() {
  return {...exportDefaults,...preferences.pdf,numberEquations:!!preferences.numberEquations,...preferences.exportOptions};
}
async function saveExport(format,tab,settings,selection) {
  toast(`${tr("main.generating")} `+format.toUpperCase()+'…');
  const [{exportStyle,htmlDocument},div]=await Promise.all([loadExportCenter(),prepareExport(tab,settings,selection)]);
  if (['docx','epub'].includes(format)) for(const formula of div.querySelectorAll('.katex')) {
    const math=formula.querySelector('math');
    if(math)formula.replaceWith(math);
  }
  const mathCSS=await exportMathCSS(div);
  const html=htmlDocument(tab.name,'<main>'+div.innerHTML+'</main>',mathCSS+exportStyle(settings,format),format==='html');
  const name=tab.name.replace(noteExtension,'');
  const done=format==='pdf'?await platform.export.pdf(html,{...settings,title:name}):
    ['docx','epub'].includes(format)?await platform.export.pandoc({format,html,name}):
    await platform.export.document({format,html,name,...(format==='png'?{width:settings.pngWidth,scale:settings.pngScale}:{})});
  if(done)toast(done==='print'?tr("main.systemPrintingOpenedSelectSaveAsPdf"):format.toUpperCase()+` ${tr("main.exported")}`);
  return done;
}
async function exportDocument(format) {
  flushLive();
  const tab=current();
  if(!tab)return;
  let selection=format==='png'?selectedExportContent(tab):null;
  if(format==='png') {
    const form=await workspaceUI.ask(tr("main.exportImage"),
      `<label>${tr("canvasView.content")}<select name="scope"><option value="all">${tr("main.entireNoteAsLongImage")}</option>`+
      (selection?`<option value="selected" selected>${tr("main.selectionAsCard")}</option>`:'')+'</select></label>',tr("main.exportPng"));
    if(!form)return;
    if(form.get('scope')==='all')selection=undefined;
  }
  return saveExport(format,tab,defaultExportPreferences(),selection);
}
async function openExportCenter(initial='pdf',tab=current(),includeSelection=tab===current()) {
  flushLive();
  if(!tab)return;
  const selection=includeSelection?selectedExportContent(tab):undefined;
  const {showExportCenter}=await loadExportCenter();
  showExportCenter({initial,formats:platform.export.formats,preferences:defaultExportPreferences(),selection,fail,
    async render(options,selected) {
      const div=await prepareExport(tab,options,selected&&selection);
      return {title:tab.name,body:div.innerHTML,mathCSS:await exportMathCSS(div)};
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
  const [{inlineRichStyles},div]=await Promise.all([loadExportCenter(),prepareExport(tab,defaultExportPreferences(),selection??selectedExportContent(tab))]);
  const plain=div.innerText||div.textContent;
  const rich=await platform.export.rich({html:'<div>'+inlineRichStyles(div)+'</div>',text:plain});
  toast(rich===false?tr("main.plainTextCopied"):tr("main.richTextCopied"));
}

async function exportMarkdownPackage() {
  flushLive();
  const tab=current();
  if(!tab?.path) {toast(tr("main.saveTheNoteBeforeBundlingRelativePath"));return;}
  if(nativeMobile){
    if(await platform.export.markdown({note:tab.path,text:tab.text,format:'zip'}))toast(tr("main.portableMarkdownBundleExported"));
    return;
  }
  const fields=await workspaceUI.ask(tr("main.exportPortableMarkdownBundle"),
    `<label>${tr("main.output")}<select name="format"><option value="zip">${tr("main.zipArchive")}</option><option value="folder">${tr("main.standaloneFolder")}</option></select></label>`,
    tr("main.exportBundle"));
  if(fields&&await platform.export.markdown({note:tab.path,text:tab.text,format:fields.get('format')})) toast(tr("main.portableMarkdownBundleExported"));
}

let quitPending=false;
async function quitWorkspace(){
  if(quitPending)return;
  if(workspaceBusy){toast(tr("main.aFileActionIsRunningPleaseWait2"));return;}
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
        status.textContent = tr("main.opening",{arg1:base(p)});
        await openFile(p);
      }
    } finally {
      status.hidden = true;
    }
  });
  return externalOpenQueue;
}

async function installExternalMarkdown() {
  if(!platform.events.externalFile)return;
  let preview,queue=Promise.resolve();
  function show(file){
    const opened=showExternalMarkdown(file,{
        async render(body,text){
          await renderContent(body,text,null,undefined,undefined,undefined,{...preferences,externalPreview:true});
          await renderDiagrams(body);
        },
        async importNote(file){
          if(!root||workspaceBusy)throw Error(tr("main.theCurrentVaultIsUnavailableTryAgain"));
          await lockWorkspace(async()=>{
            const {path}=await platform.fs.importExternalFile(root,file);
            files=await platform.workspace.tree();
            const tab=await loadDocumentTab(path);
            tab.viewMode=mobileEditMode();
            await activate(tab.id);
          });
        },
        exportNote:(format,{name,text})=>saveExport(format,{name,text,path:null,externalPreview:true},defaultExportPreferences()),
        openLink:url=>platform.window.external(url)
      });
    preview=opened;
    opened.dialog.addEventListener('close',()=>{
      if(preview===opened)preview=null;
      receive();
    },{once:true});
  }
  const receive=()=>{
    queue=queue.then(async()=>{
      while(!preview?.dialog.open){
        const file=await platform.fs.consumeExternalFile();
        if(file.error)toast(file.error);
        else if(file.name&&typeof file.text==='string')show(file);
        else break;
      }
    }).catch(fail);
    return queue;
  };
  await platform.events.externalFile(receive).catch(fail);
  await receive();
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
  floatingMenus.open({id:'more-menu',label:tr("main.moreNoteActions"),trigger:$('[data-action="more"]'),groups});
}

function showMobileDocumentMenu(tab,groups) {
  const items=groups.flatMap(group=>group.items);
  const pick=(id,glyph,label)=>{const item=items.find(item=>item.id===id);return {...item,icon:glyph,label:label||item.label};};
  const command=(label,glyph,run,disabled=false)=>({label,icon:glyph,run,disabled});
  const exportItems=items.find(item=>item.id==='export').items
    .filter(item=>['exportCenter','pdf','png','html','portableMarkdown','copyRich'].includes(item.id)&&
      (item.id!=='pdf'||desktop||platform.export.formats?.includes('pdf')))
    .map(item=>({...item,icon:item.id==='copyRich'?'copy':item.id==='exportCenter'?'settings-2':'file-down'}));
  const views={label:tr("main.viewMode"),icon:'panel-top',disabled:!tab,
    items:[['live',tr("main.live")],['source',tr("main.source")],['read',tr("main.read")]]
      .filter(([id])=>id!=='live'||preferences.mobileLiveEditing)
      .map(([id,label])=>command(label,'file-text',()=>setMode(id)))};
  const format=pick('format','list-ordered');
  mobileShell.show(tr("main.noteActions"),[
    {label:tr("main.quickActions"),style:'tiles',items:[
      command(tr("main.outline2"),'list-tree',()=>mobileShell.openDrawer('right'),!tab),
      command(tr("main.bookmark"),'bookmark',()=>action('bookmarks'),!root),
      {id:'export',label:tr("documentMenu.export"),icon:'share',disabled:!tab,items:exportItems},
      command(tr("main.quickGraph"),'network',()=>action('graph'),!root)
    ]},
    {label:tr("main.currentNote"),style:'rows',items:[
      pick('renameNote','pencil',tr("documentMenu.rename")),command(tr("documentMenu.moveToFolder"),'folder-input',()=>documentFileAction('move'),!canBookmark(tab)),pick('properties','list-checks',tr("main.noteProperties")),
      {...format,disabled:!tab},pick('template','file-plus-2',tr("main.insertTemplate")),pick('history','history',tr("main.versionHistory")),views
    ]},
    {label:tr("main.vault"),style:'rows',items:[
      command(tr("main.vaultCheck"),'heart-pulse',()=>action('vaultHealth'),!root),
      command(tr("main.openDailyNote"),'calendar-days',()=>action('daily'),!root),
      command(tr("main.openRandomNote"),'shuffle',()=>action('random'),!root),
      command(tr("activity.title"),'history',()=>action('activity'),!root)
    ]},
    {label:tr("main.appSettings"),style:'rows',items:[
      command(tr("main.appearance2"),'sun-moon',showMobileAppearance),
      command(tr("main.settings"),'settings',()=>action('settings'))
    ]},
    {label:tr("documentMenu.dangerZone"),style:'danger',items:[pick('trashNote','trash-2',tr("main.deleteCurrentNote"))]}
  ]);
}

function showMobileAppearance() {
  mobileShell.panel(tr("main.appearance"),'appearance',mountAppearance);
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
      return toast(tr("main.fileListRefreshed"));
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
      return toast(tr("main.autoSave",{arg1:autoSave?tr("main.onShort"):tr("main.offShort")}));
    case 'find': return editorTools.find();
    case 'live': case 'source': case 'read': return setMode(a);
    case 'pdf': case 'html': case 'png': return exportDocument(a);
    case 'history': return showHistory(current(),current()?.conflict);
    case 'activity': return activityView.open();
    case 'settings': return settingsCenter.open();
    case 'typewriter': case 'paragraph': return setWritingOption(a);
    case 'reveal': return current()?.path ? platform.fs.reveal(current().path) : toast(tr("main.saveTheNoteFirst"));
    case 'more': return toggleMoreMenu();
    case 'help': {
      const tab = tabs.find(item=>item.builtin==='guide');
      return tab ? activate(tab.id) : newDocument(guide(),tr('main.guideName'),'guide');
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
    if(root)await checkOpenTabs();
    toast((workspace.recovered==='quarantined'?tr('dataSafety.recoverQuarantined'):workspace.recovered?tr('dataSafety.recovered'):workspace.warning)||(workspace.deletedVault?tr("main.vaultDeleted"):old?tr("main.vaultRenamed"):root?`${tr("main.opened")} `+base(root):tr("main.workspaceClosed")));
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
  const label=marked?tr("main.removeBookmarkFromCurrentNote"):tr("main.bookmarkCurrentNote");
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
  bookmarks.splice(index,1);session();syncDocumentButtons();toast(tr("main.bookmarkRemoved"));
}

function documentWiki(file,heading) {
  const relative=encodeWiki(relativePath(file).replace(noteExtension,''));
  return '[['+relative+(heading?'#'+encodeWiki(heading):'')+']]';
}

async function copyDocumentPath(type,file=current()?.path) {
  if(!file)return;
  const text=type==='absolute'?file:type==='relative'?relativePath(file):documentWiki(file);
  await platform.clipboard.writeText(text);toast(tr("main.copied"));
}

async function mountAttachmentSettings(panel,{mobile,signal}) {
  if(!persisted||!root){panel.textContent=tr("main.openAWorkspaceInTheAppBefore");return;}
  const {mountAttachments}=await import('./attachments.js');
  if(signal?.aborted)return;
  const drafts=()=>{flushLive();return tabs.filter(tab=>tab.path&&tab.dirty&&!tab.deleted).map(({path,text})=>({path,text}));};
  mountAttachments(panel,{mobile,icon,glyphs,scan:()=>platform.attachments.scan(drafts()),trash:paths=>platform.attachments.trash({paths,drafts:drafts()}),
    confirm:async count=>Boolean(await workspaceUI.ask(tr("main.cleanUpUnusedImages"),'', tr("attachments.moveToTrash"),`${tr("main.moveTheSelected")} `+count+` ${tr("main.imagesTo")}`+(nativeMobile?` ${tr("main.theVaultSTrashFolder")}`:tr("main.theSystemTrash")))),escape,fail});
}

async function mountWorkspaceSync(panel,lifecycle) {
  if(!persisted||!root){panel.textContent=tr("main.openAWorkspaceBeforeConfiguringSync");return;}
  const {mountSyncSettings}=await import('./sync-settings.js');
  if(lifecycle.signal?.aborted)return;
  const dir=root;
  const sync=nativeMobile?Object.fromEntries(Object.entries(platform.sync).map(([key,call])=>[key,(...args)=>{
    if(dir!==root||lifecycle.signal.aborted)throw Error(tr("main.syncSettingsClosedOpenThemAgainTo"));
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
  if(choice==='apply'&&tab?.dirty)throw Error(tr("main.theDraftHasUnsavedChangesSaveIt"));
  if(choice==='archive'&&row.copy&&(!tab||tab.deleted)){
    const copyTab=findDocumentTab(row.copy);
    if(copyTab?.dirty&&!await save(copyTab))throw Error(tr("main.saveTheManualMergeFirst"));
    if((await platform.sync.conflictFiles(row.copy||row.path)).local.missing)choice='apply';
  }
  if(choice!=='apply'&&tab?.dirty) {
    if(tab.conflict)throw Error(tr("main.yourChangesAreInTheDraftResolve"));
    if(!await save(tab))throw Error(tr("main.saveTheCurrentDraftFirst"));
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
  banner.querySelector('span').textContent=editing?tr("main.saveTheManualMergeBeforeArchivingThe"):tr("main.syncKeptAConflictCopy");
  banner.querySelector('button').textContent=editing?tr("main.markResolved"):tr("main.viewSyncConflicts");
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
  const button=$('#sync-status'),label=syncLabel(value,true);
  button.textContent=label;
  button.title=syncLabel(value);
  button.dataset.state=value.status;
  const backup=value.logs?.find(row=>row.backup);
  if(backup&&backup.time!==lastSyncBackup){
    lastSyncBackup=backup.time;
    toast(syncMessage(backup));
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
  const detail=settings.mode==='lan'&&port?`${tr("main.lanSharingPort")} `+port:'';
  syncPopover.querySelector('[role=status]').textContent=[syncLabel(value),detail,
    status==='pending'&&syncMessage(value.logs[0])].filter(Boolean).join(' · ');
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
    if(quickPair)platform.clipboard.writeText(quickPair.packet).then(()=>toast(tr("main.pairingCodeCopied"))).catch(fail);
  };
}

function mobileSyncValue(value) {
  const connected=Boolean(value?.settings.enabled&&configured(value.settings));
  const status=connected||['error','conflict'].includes(value?.status)?value.status:'local';
  const summary=status==='error'?'error':connected&&status!=='synced'?'pending':status;
  return {...value,connected,status,summary,summaryLabel:vaultStatusLabels()[summary],
    label:status==='local'?vaultStatusLabels().local:syncLabel(value,true),
    detail:status==='error'?syncMessage(value.logs[0]):status==='local'?vaultStatusLabels().local:syncLabel(value)};
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
const settingsCenter=createSettingsCenter({icon,glyphs,fail,saveLanguage, mount:{
  writing:mountWritingSettings,shortcuts:mountShortcutSettings,sync:mountWorkspaceSync,attachments:mountAttachmentSettings,
  appearance:mountAppearance
}});

async function saveLanguage(value) {
  await platform.preferences.saveLanguage?.(value);
}

onLocaleChange(() => {
  commands=localizedCommands();
  settingsCenter.relocalize();
  relocalizeEditors();
  const tab=current();
  if(tab?.builtin&&!tab.dirty&&!tab.path){
    tab.saved=tab.text=tab.builtin==="welcome"?welcome():guide();
    syncEditors();
  }
  renderTabs();
  renderBreadcrumb(tab);
  stats();
  renderSide();
  outline();
  syncDocumentButtons();
  renderExternalNotice(tab);
  if(currentSyncState)syncStatus(currentSyncState);
  if(!$("#palette").hidden)filterCommands();
  if(mode==="read")renderRead();
  platform.preferences.syncNativeLanguage?.(getLocale()).catch(fail);
});

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
    heading:['# ','',''],bold:['**','**',tr("main.bold")],todo:['- [ ] ','',''],
    wiki:['[[',']]',tr("main.noteName")],math:['$','$',tr("main.math")],code:['\u0060','\u0060',tr("main.code")],
    table:[`

${tr("main.column1Column2")}

`,'','']
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
      if(nativeMobile)for(const group of groups)group.items=group.items.filter(item=>![
        tr("main.showInFileExplorer2"),tr("main.openInRightSplit")
      ].includes(item.label));
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
      show(event,'file-menu',tr("main.fileTree"),[group(tr("main.workspace"),[item(tr("main.openWorkspaceFolder"),()=>action('folder'))])]);
      return;
    }
    const row=event.target.closest('.file-row[data-file],.folder-row[data-folder]');
    const file=row?.dataset.file, folder=row?.dataset.folder;
    const target=file||folder||root;
    const newEntry=(type,label)=>item(label,()=>workspaceUI.menuAction(type,target,!file));
    const create=group(tr("main.new"),[newEntry('note',folder?tr("main.newNoteHere"):tr("main.newNote2")),
      newEntry('folder',folder?tr("main.newFolderHere"):tr("main.newFolder"))]);
    const manage=group(tr("main.fileManagement"),[
      item(tr("main.showInFileExplorer2"),()=>reveal(target)),
      item(tr("documentMenu.rename"),()=>workspaceUI.menuAction('rename',target,!file)),
      item(tr("documentMenu.moveToFolder"),()=>workspaceUI.menuAction('move',target,!file)),
      item(nativeMobile?tr("main.moveToVaultTrash"):tr("main.moveToSystemTrash"),()=>workspaceUI.menuAction('trash',target,!file),{danger:true})
    ]);
    if(file) {
      const title=bookmarkIndex(file)>=0?tr("main.removeBookmark"):tr("main.bookmark2");
      show(event,'file-menu',tr("main.noteFile"),[group(tr("canvasView.note"),[
        item(tr("main.openInRightSplit"),()=>splitFile(file)),
        item(title,()=>toggleDocumentBookmark(file)),
        pathMenu(type=>copyDocumentPath(type,file)),
        item(tr("main.openExportCenter"),async()=>{
          const tab=findDocumentTab(file)||{path:file,name:base(file),text:(await platform.fs.read(file)).text};
          openExportCenter('pdf',tab,false);
        })
      ]),create,manage]);
    } else if(folder) {
      const collapse=expanded.has(folder);
      show(event,'file-menu',tr("main.folder"),[create,group(tr("main.folder"),[
        item(collapse?tr("main.collapseSubfolders"):tr("main.expandSubfolders"),()=>{
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
    } else show(event,'file-menu',tr("main.fileTree"),[create,group(tr("main.workspace"),[
      item(tr("main.refreshFileTree"),()=>action('refresh')),item(tr("main.openVaultInFileExplorer"),()=>reveal(root,true))
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
    show(event,'tab-menu',tr("main.noteTabs"),[group(tr("main.closeTab"),[
      item(tr("main.closeCurrentTab"),()=>closeTab(tab.id)),
      item(tr("main.closeOtherTabs"),()=>closeTabs(tabs.filter(other=>other!==tab)),disabled(tabs.length>1)),
      item(tr("main.closeTabsToTheRight"),()=>closeTabs(right),disabled(right.length))
    ]),group(tr("main.note"),[
      item(tr("main.openInRightSplit"),()=>openDocumentSplit(tab)),
      item(tr("documentMenu.copyWikiLink"),()=>copyDocumentPath('wiki',tab.path),disabled(tab.path)),
      item(tr("main.showInFileExplorer2"),()=>reveal(tab.path),disabled(tab.path&&!tab.deleted))
    ]),group(tr("main.tabActions"),[
      item(tab.pinned?tr("main.unpinTab"):tr("main.pinTab"),()=>{tab.pinned=!tab.pinned;renderTabs();session();}),
      item(tr("main.reopenClosedNote"),reopenClosed,disabled(closedFiles.length))
    ])]);
  });

  $('#outline').addEventListener('contextmenu',event=>{
    const node=event.target.closest('.outline-row')?.querySelector('[data-heading]');
    const index=node?Number(node.dataset.heading):-1, row=headings()[index], file=current()?.path;
    const groups=[];
    if(row)groups.push(group(tr("main.heading"),[
      item(tr("main.jumpToHeading"),()=>jumpHeading(index,true)),
      item(outlineUI.isFolded(index)?tr("main.expandSection"):tr("main.collapseSection"),()=>outlineUI.toggle(index)),
      item(tr("main.copyHeadingWikiLink"),()=>copy(documentWiki(file,row.text)),disabled(file)),
      item(tr("main.copyHeadingText"),()=>copy(row.text))
    ]));
    groups.push(group(tr("main.outline"),[item(tr("main.expandAllHeadings"),()=>outlineUI.foldAll(false)),item(tr("main.collapseAllHeadings"),()=>outlineUI.foldAll(true))]));
    show(event,'outline-menu',tr("main.outline"),groups);
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
        const entries=[item(tr("main.openLink"),()=>{
          if(external)return platform.window.external(href);
          if(heading&&!wikiLink)return jumpHeading(headings().findIndex(row=>headingMatches(row.text,href.slice(1))));
          return wiki(href,wikiLink,doc);
        })];
        if(wikiLink)entries.push(item(tr("main.openInRightSplit"),async()=>{
          const target=await platform.index.target({source:doc,destination:href,wiki:true});
          if(!target)throw Error(tr("main.linkTargetNotFoundCreateTheNote"));
          return splitFile(target.path,target.heading);
        }));
        entries.push(item(tr("main.copyLinkAddress"),()=>copy(href)));
        groups.push(group(tr("main.link"),entries));
      }
    }
    if(mode==='read') {
      const image=event.target.closest('#reading img');
      const url=image?.getAttribute('src')||'';
      if(url.startsWith('note-image://local/')) {
        const file=decodeURIComponent(url.slice('note-image://local/'.length));
        groups.push(group(tr("main.localImage"),[
          item(tr("main.showImageInFileExplorer"),()=>platform.fs.revealImage(file)),item(tr("main.copyImagePath"),()=>copy(file))
        ]));
      }
      if(hasReadingSelection) {
        const text=readingRange.toString();
        groups.push(group(tr("main.selection"),[item(tr("main.copy"),()=>copy(text))]));
      }
    } else if(editable) {
      groups.push(group(tr("main.clipboard"),[
        item(tr("main.cut"),editable.cut,disabled(editable.selected)),
        item(tr("main.copy"),()=>copy(editable.text),disabled(editable.selected)),
        item(tr("main.paste"),()=>editable.paste(false)),item(tr("main.pasteAsPlainText"),()=>editable.paste(true)),
        item(tr("main.selectAll"),editable.selectAll)
      ]),group(tr("main.formatInsert"),[
        {id:'format',label:tr("exportCenter.format"),items:[
          [tr("main.bold"),'**'],[tr("main.italic"),'*'],[tr("main.inlineCode"),'`','`',tr("main.code")],[tr("main.strikethrough"),'~~'],
          [tr("main.inlineMath"),'$','$','x'],[tr("main.convertToWikiLink"),'[[',']]',tr("main.noteName")]
        ].map(([label,open,close,placeholder])=>item(label,()=>editable.format(open,close,placeholder)))},
        {id:'insert',label:tr("main.insert"),items:[
          [tr("main.table"),`

${tr("main.column1Column2ContentContent")}

`],
          [tr("main.codeBlock"),`

${tr("main.code2")}

`],[tr("main.mathBlock"),'\n\n$$\nx = 1\n$$\n\n'],
          [tr("main.manualPageBreak"),'\n\n<!-- pagebreak -->\n\n']
        ].map(([label,markdown])=>item(label,()=>editable.insert(markdown))).concat(
          item(tr("main.noteTemplate"),()=>{editable.focus();return action('template');})
        )},
        ...(editable.tableLine===undefined?[]:[item(tr("documentMenu.formatThisTable"),()=>{
          editable.focus();
          return editMarkdown(text=>formatTables(text,editable.tableLine));
        })])
      ]));
    }
    if(selection)groups.push(group(tr("main.shareSelection"),[
      item(tr("main.copyAsRichText"),()=>copyRichText(selection)),
      item(tr("main.exportSelectionAsLongImage"),()=>saveExport('png',tab,defaultExportPreferences(),selection))
    ]));
    if(mode==='read')groups.push(group(tr("main.note"),[
      item(tr("main.switchToLive"),()=>setMode('live')),item(tr("main.switchToSource"),()=>setMode('source')),
      item(tr("main.openExportCenter"),()=>openExportCenter('pdf',tab)),item(tr("main.viewVersionHistory"),()=>action('history'),disabled(tab.path))
    ]));
    show(event,'editor-menu',mode==='read'?tr("main.readContent"):tr("main.editNote"),groups);
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
  await updateVim();
  toast(preferences.vim?tr("main.sourceVimKeysEnabled"):tr("main.sourceVimKeysDisabled"));
}

function editMarkdown(transform,sourceOnly=false) {
  if(!current())return;
  flushLive();
  if(sourceOnly&&mode!=='source') {toast(tr("main.switchToSourceBeforeRunningThisCommand"));return;}
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
const guide=()=>`${tr("main.userGuideEditingAndReadingLiveSupports")}
`;
async function boot(){
  mobileShell=createMobileShell({native:nativeMobile,icon,glyphs,run:action,tabs:()=>tabs,active:current,mode:()=>mode,
    workspace:()=>({name:root?base(root):tr("main.openVault"),available:!!root}),
    editMode:mobileEditMode,activate,keyboard:mobileKeyboard,hint:toast,fail,changed(enabled){
      if(appearancePanel.matches(':popover-open'))appearancePanel.hidePopover();
      floatingMenus.close();
      linkCompletion?.close();
      if(initialized){
        updateVim().catch(fail);
        renderSide();
        if(mode==='read')renderRead();
      }
      if(enabled&&initialized&&mode==='live'&&!preferences.mobileLiveEditing)setMode('source').catch(fail);
    }});
  $('#startup-status').textContent=tr('main.starting');
  const data = await platform.workspace.bootstrap();
  await platform.preferences.syncNativeLanguage?.(getLocale());
  root = data.root;
  preferences = {...defaults,...(nativeMobile?{webpCompression:true}:{}),...data.config.features};
  if (data.initialFiles.length) $('#startup-status').textContent = tr("main.opening",{arg1:base(data.initialFiles[0])});
  await mountEditors();
  installFeatures();
  const savedSession=data.config.session;
  const mobileSession=nativeMobile&&savedSession?.mobileRoot!==root?savedSession?.workspaces?.[root]?.mobileSession:undefined;
  const restored = restoreWorkspaceSession(nativeMobile&&savedSession?{...savedSession,...mobileSession,
    tabs:(mobileSession?.tabs??savedSession.tabs??[]).filter(tab=>tab.path?containsPath(root,tab.path,fileKey):
      (!savedSession.mobileRoot||savedSession.mobileRoot===root||!!mobileSession)&&tab.text!==welcome())
  }:savedSession,nativeMobile);
  if (restored) {
    ({tabs,activeId,mode,autoSave,treeSort,treeDescending,closedFiles,workspaces}=restored);
    document.body.classList.toggle('hide-sidebar',restored.sidebarHidden);
    document.body.classList.toggle('hide-outline',restored.outlineHidden);
  } else if(!nativeMobile) {
    tabs = [{id:uid(),path:null,name:tr('main.welcomeName'),builtin:'welcome',text:welcome(),saved:welcome(),mtime:null,dirty:false}];
    activeId = tabs[0].id;
  }
  new MutationObserver(()=>resolveImages($('#live-editor')).catch(console.warn)).observe($('#live-editor'),{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
  syncPanelButtons();
  if (root) loadInitialTree();
  await activate(activeId);
  await openExternalFiles(data.initialFiles);
  platform.events.action(a=>action(a).catch(fail));
  platform.events.externalChange(enqueueVaultChange);
  platform.events.focus(active=>{
    if(active)externalChanges=externalChanges.catch(fail).then(()=>workspaceSettled).then(()=>checkOpenTabs()).catch(fail);
  });
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
  await installExternalMarkdown();
  if(restored)await checkOpenTabs().catch(fail);
  if(data.config.recovered)toast(tr(data.config.recovered==='quarantined'?'dataSafety.recoverQuarantined':'dataSafety.recovered'));
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
  status.textContent = tr("main.couldNotStart",{arg1:errorMessage(error)});
  status.hidden = false;
  console.error(error);
});
