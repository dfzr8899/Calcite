const path = require('node:path');

const MiB=1024*1024;
const MAX_NOTE=16*MiB, MAX_HTML=48*MiB, MAX_CANVAS=5*MiB;
const markdown=/\.(?:md|markdown|mdown)$/i;
const documentType=/(?:\.md|\.markdown|\.mdown|\.canvas)$/i;
const string=(limit, min=0)=>value=>typeof value==='string'&&value.length>=min&&value.length<=limit&&Buffer.byteLength(value)<=limit;
const name=string(1024,1), filePath=value=>string(32768,1)(value)&&!value.includes('\0')&&path.isAbsolute(value)&&
  (process.platform!=='win32'||!value.slice(path.parse(value).root.length).includes(':'));
const notePath=value=>filePath(value)&&markdown.test(value);
const docPath=value=>filePath(value)&&documentType.test(value);
const noteText=string(MAX_NOTE), html=string(MAX_HTML,1);
const bool=value=>typeof value==='boolean', number=value=>Number.isFinite(value)&&value>=0;
const optional=validate=>value=>value===undefined||validate(value);
const nullable=validate=>optional(value=>value===null||validate(value));
const oneOf=(...values)=>value=>values.includes(value);
const list=(validate,limit)=>value=>Array.isArray(value)&&value.length<=limit&&value.every(validate);
const shape=fields=>value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).every(key=>Object.hasOwn(fields,key))&&Object.entries(fields).every(([key,validate])=>validate(value[key]));
const json=(limit,validate)=>value=>{
  if (!validate(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value))<=limit; } catch { return false; }
};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const mode=oneOf('live','source','read');
const fileSnapshot=optional(shape({mtimeMs:number,size:number,hash:value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)}));
const tab=shape({id:name,path:nullable(docPath),name,text:noteText,saved:noteText,mtime:nullable(number),pinned:optional(bool),
  deleted:optional(bool),holdAutoSave:optional(bool),snapshot:fileSnapshot,
  viewMode:optional(mode),scrollByMode:optional(shape({live:optional(number),source:optional(number),read:optional(number)}))});
const draft=shape({path:docPath,text:noteText,saved:optional(noteText),mtime:optional(number)});
const drafts=json(64*MiB,list(draft,512));
const range=(min,max)=>value=>number(value)&&value>=min&&value<=max;
const pdfOptions=shape({paper:optional(oneOf('A4','A5','B5','Letter')),horizontal:optional(range(0,2.6)),vertical:optional(range(0,2.6)),
  header:optional(string(512)),footer:optional(string(512)),pageNumbers:optional(bool),chapters:optional(bool),title:optional(name),
  landscape:optional(bool),scale:optional(range(50,200)),theme:optional(oneOf('modern','academic','github','dark')),
  fontSize:optional(range(12,18)),lineHeight:optional(range(1.4,2)),wrapCode:optional(bool),keepBlocks:optional(bool),
  toc:optional(bool),includeProperties:optional(bool),outline:optional(bool),numberEquations:optional(bool),hideFirst:optional(bool),
  headerLeft:optional(string(640)),headerCenter:optional(string(640)),headerRight:optional(string(640)),
  footerLeft:optional(string(640)),footerCenter:optional(string(640)),footerRight:optional(string(640)),printCSS:optional(string(64000)),
  pngScale:optional(oneOf(1,2,3)),pngWidth:optional(oneOf(480,760,1000)),pngPadding:optional(range(0,96)),pngTheme:optional(oneOf('light','dark'))});
const session=json(128*MiB,shape({tabs:list(tab,512),activeId:string(1024),mode,autoSave:bool,
  treeSort:optional(oneOf('name','modified','created')),treeDescending:optional(bool),closedFiles:optional(list(docPath,30)),
  workspaces:optional(json(2*MiB,record)),light:optional(bool),sidebarHidden:optional(bool),outlineHidden:optional(bool)}));
const edit=shape({type:oneOf('note','folder','trash','move','rename'),drafts:optional(drafts),path:optional(filePath),
  parent:optional(filePath),name:optional(name),text:optional(string(2*MiB)),openExisting:optional(bool),createParents:optional(bool)});
const upload=shape({note:notePath,strategy:oneOf('workspace','note'),directory:string(2048,1),mime:name,
  bytes:value=>value instanceof Uint8Array&&value.byteLength>0&&value.byteLength<=32*MiB});
const imageURL=value=>string(98304,1)(value)&&value.startsWith('note-image://local/');
const exportData=(...formats)=>shape({html,format:oneOf(...formats),name});
const board=json(MAX_CANVAS,shape({nodes:list(record,1200),edges:list(record,10000)}));
const syncOptions=shape({enabled:bool,conflictStrategy:optional(oneOf('lww-history','conflict-copy')),mode:oneOf('lan','remote'),auto:bool,listen:bool,
  port:value=>Number.isInteger(value)&&value>=0&&value<=65535,remoteUrl:string(4096),remoteUser:string(128),branch:string(120,1),
  name:string(128,1),email:string(256,1),deviceName:string(240,1),peerUrl:string(4096),peerVaultId:string(36),
  wifiOnly:nullable(bool),peerName:optional(string(240)),endpoints:optional(list(string(4096),12)),
  pat:optional(string(2048)),peerToken:optional(string(64)),pairing:optional(string(8192))});

const validators={
  'window:language':[oneOf('auto','zh-CN','en-US')],
  'window:set-appearance':[shape({theme:oneOf('system','dark','light'),glass:oneOf('liquid','mica','solid'),reduceTransparency:bool})],
  'window-control':[oneOf('minimize','maximize','close')],
  'renderer-ready':[], bootstrap:[], tree:[], discard:[], quit:[], 'canvas-files':[],
  folder:[optional(list(docPath,512))], 'close-vault':[optional(list(docPath,512))], open:[optional(docPath)], 'release-file':[docPath],
  'recent-vaults':[], 'switch-vault':[filePath,optional(list(docPath,512))],
  read:[docPath,optional(bool)], save:[shape({path:nullable(docPath),text:noteText,saved:optional(noteText),mtime:nullable(number),
    snapshot:fileSnapshot,resolution:optional(oneOf('reload','overwrite')),
    saveAs:optional(bool),name:optional(name)})],
  session:[session], search:[string(4096)], external:[string(8192,1)], reveal:[filePath,optional(bool)], 'reveal-image':[filePath],
  'clipboard-write-text':[noteText], 'clipboard-paste':[bool], pdf:[html,optional(pdfOptions)],
  'workspace-edit':[value=>edit(value)&&(['note','folder'].includes(value.type)?!!value.parent&&!!value.name:
    !!value.path&&(value.type!=='move'||!!value.parent)&&(value.type!=='rename'||!!value.name))],
  'activity:list':[], 'activity:empty':[], 'activity:undo':[string(36,36),optional(string(64,64))],
  'note-target':[shape({source:nullable(docPath),destination:string(32768),wiki:bool})],
  'workspace-links':[shape({source:nullable(docPath),destinations:list(string(32768),256),headings:optional(bool)})],
  'workspace-health':[optional(drafts)],
  backlinks:[notePath,drafts], 'workspace-notes':[optional(oneOf('search','metadata')),optional(drafts)], 'workspace-graph':[optional(drafts)],
  'search-index':[optional(shape({generation:string(36,1),revision:value=>Number.isSafeInteger(value)&&value>=0}))],
  features:[shape({attachmentStrategy:optional(oneOf('workspace','note')),workspaceAttachments:optional(string(2048)),
    noteAttachments:optional(string(2048)),newNoteDirectory:optional(string(2048)),templateDirectory:optional(string(2048)),
    dailyDirectory:optional(string(2048)),dailyFilePattern:optional(string(120)),dailyTemplate:optional(string(32768)),historyLimit:optional(number),
    typewriter:optional(bool),paragraphFocus:optional(bool),pdf:optional(pdfOptions),numberEquations:optional(bool),
    webpCompression:optional(bool),webpWidth:optional(range(256,3840)),webpQuality:optional(range(.1,1)),
    exportOptions:optional(pdfOptions),vim:optional(bool),macros:optional(json(32768,value=>record(value)&&Object.entries(value).length<=100&&
      Object.entries(value).every(([key,definition])=>/^\\[A-Za-z@]+$/.test(key)&&string(2048,1)(definition)))),
    shortcuts:optional(json(16384,value=>record(value)&&Object.keys(value).length<=80&&Object.entries(value).every(([id,key])=>
      /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(id)&&/^(?:(?:Mod|Ctrl|Meta|Alt|Shift)\+)*(?:[A-Z0-9]|Tab|F(?:[1-9]|1[0-2]))$/.test(key))))})],
  history:[filePath,optional(string(128,1))], attachment:[upload], 'export-image':[imageURL],
  'attachments:scan':[optional(drafts)], 'attachments:trash':[shape({paths:list(filePath,1024),drafts:optional(drafts)})],
  'sync:configure':[syncOptions], 'sync:status':[], 'sync:run':[], 'sync:test':[], 'sync:pair':[], 'sync:revoke':[],
  'sync:clear-conflict':[filePath],
  'sync:remote-pair':[], 'sync:cancel-remote-pair':[], 'sync:network':[bool], 'sync:resolve':[filePath,oneOf('keep','apply','archive')],
  'sync:conflict-files':[filePath], 'sync:archive-conflicts':[], 'sync:restore-version':[filePath,string(128,1)],
  'export-document':[shape({html,format:oneOf('html','png'),name,width:optional(oneOf(480,760,1000)),scale:optional(oneOf(1,2,3))})],
  'export-rich':[shape({html,text:noteText})], 'export-markdown':[shape({note:notePath,text:noteText,format:oneOf('folder','zip')})],
  'pandoc-export':[exportData('docx','epub')],
  'canvas-read':[name], 'canvas-save':[shape({name,board,version:optional(value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value))})]
};

function validArguments(channel,args) {
  const rules=validators[channel];
  return !!rules&&args.length<=rules.length&&rules.every((validate,index)=>validate(args[index]));
}

module.exports={validArguments,documentType,markdown,MAX_NOTE,MAX_CANVAS};
