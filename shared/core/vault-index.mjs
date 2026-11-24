import {getLocale} from '../i18n/index.mjs';
import {marked} from 'marked';
import {noteTags,properties,splitFrontmatter} from '../note-metadata.mjs';
import {headingIdentifiers,headingIndex,linkDirectory,mapLinks,markdown,splitLink} from '../note-links.mjs';
import {imageExtension} from '../markdown-images.mjs';

/** @import {IndexEntry, IndexedReference, PathOperations, WikilinkRef} from './types.mjs' */
/** @typedef {{row: {path: string, modified: number}, size: number, signature: string}} IndexFile */
/** @typedef {{item: IndexFile, text?: string, hash?: string, cached?: IndexEntry, truncated?: boolean}} IndexData */
/** @typedef {{file: string, item?: IndexFile, data?: IndexData}} IndexUpdate */
/** @typedef {{path: string, text: string}} Draft */
/** @typedef {{generation: string, revision: number}} SearchCursor */
/**
 * @typedef {object} IndexOptions
 * @property {PathOperations} path
 * @property {(path: string) => string} key
 * @property {(parent: string, file: string) => boolean} within
 * @property {string} generation
 * @property {AbortSignal} [signal]
 * @property {(path: string, item?: IndexFile) => Promise<IndexData|null|undefined>} read
 * @property {() => Promise<string>} [readCache]
 * @property {(text: string) => Promise<void>} [writeCache]
 * @property {number} [searchLimit]
 */

export const SEARCH_LIMIT=2*1024*1024;
export const CACHE_LIMIT=32*1024*1024;
export const CACHE_DIRECTORY='.calcite';
export const CACHE_FILE='index-v1.json';
const cacheVersion=2;
const labelFor=text=>text.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*_`]/g,'');

/** @param {{mtimeMs: number, size: number}} stat */
export const fileSignature=({mtimeMs,size})=>mtimeMs+':'+size;

export function noteHeadings(text,tokens=marked.lexer(text)) {
  let cursor=0,line=1;
  const rows=[];
  for(const token of tokens){
    const at=text.indexOf(token.raw,cursor);
    if(at<0)continue;
    line+=(text.slice(cursor,at).match(/\n/g)||[]).length;
    if(token.type==='heading')rows.push({level:token.depth,text:labelFor(token.text),line});
    line+=(token.raw.match(/\n/g)||[]).length;
    cursor=at+token.raw.length;
  }
  return rows;
}

/** @param {string|null} text */
function searchData(text) {
  const lines=text?.split('\n')??null;
  /** @type {[number, string][]} */
  const mentions=[];
  if(lines) {
    let fence='';
    for(const [i,raw] of lines.entries()){
      const marker=raw.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if(marker&&!fence){fence=marker;continue;}
      if(fence&&marker?.startsWith(fence)){fence='';continue;}
      if(fence)continue;
      const plain=raw.replace(/`[^`]*`|\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]*\)/g,'').toLocaleLowerCase();
      if(plain)mentions.push([i+1,plain]);
    }
  }
  return {lines,mentions};
}

/**
 * @param {string} path
 * @param {string} relative
 * @param {string} source
 * @param {{row: {modified: number}, size: number}} item
 * @returns {IndexEntry}
 */
export function parseNote(path,relative,source,item,searchable=true) {
  const text=source.replace(/\r\n?/g,'\n');
  const {body,yaml,prefix}=splitFrontmatter(text);
  const frontmatter=properties(yaml)||{};
  /** @type {IndexedReference[]} */
  const links=[];
  /** @type {WikilinkRef[]} */
  const wikilinks=[];
  const tasks=[];
  let headings=[],tags=[];
  const offset=(prefix.match(/\n/g)||[]).length;
  try {
    const tokens=marked.lexer(body);
    headings=noteHeadings(body,tokens).map(row=>({...row,line:row.line+offset}));
    tags=[...noteTags(text,marked,{tokens,values:frontmatter})];
    marked.walkTokens(tokens,token=>{
      if(token.type==='list_item'&&token.task)tasks.push({
        text:token.text.split('\n')[0].trim(),checked:Boolean(token.checked)
      });
    });
  }catch { /* Retain links and full-text search if the Markdown lexer rejects a note. */ }
  const lines=body.split('\n');
  let line=0,newline=body.indexOf('\n'),startOfLine=0;
  mapLinks(text,(dest,wiki,at,details)=>{
    at-=prefix.length;
    while(newline>=0&&newline<at){
      line++;
      startOfLine=newline+1;
      newline=body.indexOf('\n',startOfLine);
    }
    const raw=lines[line],leading=raw.length-raw.trimStart().length;
    const start=details.from-prefix.length-startOfLine-leading;
    const clipStart=Math.max(0,start-100);
    const display=raw.trim().slice(clipStart,clipStart+240);
    function contextLines(direction){
      const pieces=[];
      let length=0;
      for(let i=line+direction;lines[i]?.trim()&&length<80;i+=direction){
        const piece=lines[i].trim();
        pieces.push(direction<0?piece.slice(-(80-length)):piece.slice(0,80-length));
        length+=pieces.at(-1).length+1;
      }
      return (direction<0?pieces.reverse():pieces).join('\n');
    }
    const previous=contextLines(-1),following=contextLines(1);
    const context=[previous,display,following].filter(Boolean).join('\n');
    const mark=start-clipStart+(previous?previous.length+1:0);
    links.push({dest,wiki,line:line+offset+1,text:context,from:details.from,embedded:details.embedded,
      mark:mark>=0&&start-clipStart<display.length?[mark,Math.min(mark+dest.length,(previous?previous.length+1:0)+display.length)]:null});
    if(wiki){
      const fragment=dest.indexOf('#');
      wikilinks.push({target:fragment<0?dest:dest.slice(0,fragment),heading:fragment<0?'':dest.slice(fragment+1),
        alias:details.alias,embedded:details.embedded,line:line+offset+1});
    }
    return dest;
  },{body,prefix});
  const title=typeof frontmatter.title==='string'&&frontmatter.title.trim()?frontmatter.title:
    headings[0]?.text||relative.split('/').at(-1).replace(markdown,'');
  const bodyText=searchable?text:null;
  return {path,relative,mtime:item.row.modified,size:item.size,title,headings,tags,frontmatter,values:frontmatter,
    links,wikilinks,tasks,text:bodyText,...searchData(bodyText)};
}

export class VaultIndex {
  /** @param {string} root @param {IndexOptions} options */
  constructor(root,{path,key,within,generation,signal,read,readCache,writeCache,searchLimit=SEARCH_LIMIT}) {
    this.path=path;
    this.key=key;
    this.within=within;
    this.read=read;
    this.readCache=readCache;
    this.writeCache=writeCache;
    this.searchLimit=searchLimit;
    /** @type {Map<string, IndexUpdate>} */
    this.pending=new Map();
    /** @type {Map<string, IndexFile>} */
    this.items=new Map();
    /** @type {Map<string, IndexEntry>} */
    this.cached=new Map();
    this.refreshing=null;
    this.cacheLoaded=false;
    this.savedRevision=0;
    this.root=root;
    this.signal=signal;
    /** @type {Map<string, IndexEntry>} */
    this.notes=new Map();
    /** @type {Map<string, IndexEntry>} */
    this.drafts=new Map();
    this.directory=linkDirectory(root,path,key);
    /** @type {Map<string, Set<string>>} */
    this.reverse=new Map();
    /** @type {Map<string, Set<string>>} */
    this.dependents=new Map();
    this.generation=generation;
    this.revision=0;
    /** @type {Map<string, {revision: number, path: string}>} */
    this.journal=new Map();
    this.resetBefore=0;
  }

  relative(file) {
    return this.path.relative(this.root,file).split(this.path.sep).join('/');
  }

  resolve(source,destination,wiki){
    return this.directory.resolve(source,destination,wiki);
  }

  inspect(source,destination,wiki=true,includeHeadings=false) {
    const [raw]=splitLink(destination);
    if(/^[\w+-]+:|^\/\//.test(raw))return {status:'external'};
    const {target,heading,ambiguous}=this.resolve(source,destination,wiki);
    if(ambiguous)return {status:'ambiguous',candidates:ambiguous.map(path=>({
      path,identifier:this.directory.identifier(path),label:this.relative(path)
    })).sort((a,b)=>a.label.localeCompare(b.label,getLocale()))};
    const note=target&&this.notes.get(this.key(target));
    if(!note)return {status:wiki&&raw?'placeholder':'broken'};
    const fragment=heading?.slice(1)||'';
    const rows=fragment||includeHeadings?headingIdentifiers(note.headings):[];
    const position=fragment&&!fragment.startsWith('^')?headingIndex(rows,fragment):-1;
    const status=fragment&&!fragment.startsWith('^')&&position<0?'broken-heading':'ok';
    return {status,path:note.path,title:note.title,heading:fragment,slug:rows[position]?.slug,
      ...(includeHeadings?{headings:rows}:{})};
  }

  health(drafts=[]) {
    const {nodes,edges}=this.graph(drafts);
    const connected=new Set(edges.flatMap(({from,to})=>[from,to]));
    const changed=this.overlay(drafts);
    const issues=[];
    for(const [id,stored] of this.notes){
      const note=changed.get(id)||stored;
      for(const link of note.links){
        const [dest]=splitLink(link.dest);
        if(link.embedded&&imageExtension.test(dest)||!link.wiki&&dest&&!markdown.test(dest))continue;
        const detail=this.inspect(note.path,link.dest,link.wiki);
        if(!['ok','external'].includes(detail.status))issues.push({...detail,source:note.path,line:link.line,
          text:link.text,marks:link.mark?[link.mark]:[],destination:link.dest,from:link.from,wiki:link.wiki});
      }
    }
    return {orphans:nodes.filter(file=>!connected.has(file)),issues};
  }

  /** @param {string} file @param {IndexFile} [item] @param {IndexData} [data] */
  observe(file,item,data) {
    if(!markdown.test(file))return;
    const id=this.key(file);
    const previous=this.items.get(id);
    if(item){
      this.items.set(id,item);
      if(!data&&previous?.row.path===file&&previous.signature===item.signature)return;
    }else{
      if(!previous&&!this.notes.has(id))return;
      this.items.delete(id);
    }
    this.pending.set(id,{file,item,data});
  }

  async restoreCache() {
    this.cacheLoaded=true;
    if(!this.readCache)return;
    try{
      const data=JSON.parse(await this.readCache());
      if(data.version!==cacheVersion||!Array.isArray(data.notes))return;
      for(const note of data.notes){
        if(typeof note?.relative!=='string'||typeof note.text!=='string'||!Array.isArray(note.headings)||
          !Array.isArray(note.links)||!Array.isArray(note.tags)||!Array.isArray(note.wikilinks)||!Array.isArray(note.tasks))continue;
        this.cached.set(note.relative,note);
      }
    }catch { /* An absent or damaged cache is rebuilt from the workspace. */ }
  }

  async refresh() {
    if(this.refreshing)return this.refreshing;
    this.refreshing=this.refreshPending().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }

  async refreshPending() {
    if(!this.cacheLoaded)await this.restoreCache();
    while(this.pending.size&&!this.signal?.aborted){
      const batch=[];
      for(const [id,update] of this.pending){
        this.pending.delete(id);
        batch.push({id,...update});
        if(batch.length===24)break;
      }
      const actions=await Promise.all(batch.map(async({id,file,item,data})=>{
        if(!item||data)return {id,file,data};
        const cached=this.cached.get(this.relative(file));
        if(cached&&cached.mtime===item.row.modified&&cached.size===item.size&&cached.signature===item.signature){
          return {id,file,data:{item,hash:cached.hash,cached:{...cached,path:file,values:cached.frontmatter,...searchData(cached.text)}}};
        }
        return {id,file,data:await this.read(file,item)};
      })).catch(error=>{
        for(const update of batch)if(!this.pending.has(update.id))this.pending.set(update.id,update);
        throw error;
      });
      if(this.signal?.aborted)return;
      this.apply(actions.filter(({id})=>!this.pending.has(id)));
    }
    this.cached.clear();
    if(this.writeCache&&!this.signal?.aborted&&this.savedRevision!==this.revision&&!this.cacheTimer){
      this.cacheTimer=setTimeout(()=>this.flushCache(),1200);
      this.cacheTimer.unref?.();
    }
  }

  flushCache() {
    clearTimeout(this.cacheTimer);
    this.cacheTimer=undefined;
    if(!this.writeCache||this.signal?.aborted||this.savedRevision===this.revision)return this.saving;
    const revision=this.revision;
    this.savedRevision=revision;
    const save=async()=>{
      if(this.signal?.aborted||revision!==this.savedRevision)return;
      const notes=[];
      let size=0;
      for(const note of this.notes.values()){
        if(note.text==null)continue;
        const {path,targets,dependencies,lines,mentions,values,...cacheEntry}=note;
        try{
          const json=JSON.stringify(cacheEntry);
          size+=new TextEncoder().encode(json).length+1;
          if(size>CACHE_LIMIT-100)break;
          notes.push(json);
        }catch { /* Cyclic YAML aliases remain readable in memory. */ }
      }
      await this.writeCache('{"version":'+cacheVersion+',"notes":['+notes.join(',')+']}');
    };
    this.saving=Promise.resolve(this.saving).then(save).catch(()=>{
      if(this.savedRevision===revision)this.savedRevision=-1;
    });
    return this.saving;
  }

  paths() {return [...this.notes.values()].map(note=>note.path);}
  pathsWithin(dir) {return this.paths().filter(file=>this.within(dir,file));}

  /** @param {(file: string) => string} move @param {typeof this.directory.resolve} resolveAfter @param {Draft[]} drafts */
  affectedByMove(move,resolveAfter,drafts) {
    const open=new Set(drafts.map(draft=>this.key(draft.path)));
    return [...this.notes.values()].filter(note=>{
      const next=move(note.path);
      if (next!==note.path||open.has(this.key(note.path))) return true;
      return note.links.some(({dest,wiki})=>{
        const {target}=this.directory.resolve(note.path,dest,wiki);
        if (!target || (target===note.path&&dest.startsWith('#'))) return false;
        const future=resolveAfter(next,dest,wiki).target;
        return move(target)!==target || !future || this.key(future)!==this.key(target);
      });
    }).map(note=>note.path);
  }

  /** @param {IndexEntry} note */
  detach(note) {
    const source=this.key(note.path);
    for (const [map,values] of /** @type {const} */ ([[this.reverse,note.targets.keys()],[this.dependents,note.dependencies]])) {
      for (const id of values) {
        const set=map.get(id);
        set?.delete(source);
        if (!set?.size) map.delete(id);
      }
    }
  }

  /** @param {IndexEntry} note */
  connect(note) {
    const source=this.key(note.path);
    /** @type {Set<string>} */
    const dependencies=new Set();
    const targets=this.targets(note,id=>dependencies.add(id));
    Object.assign(note,{targets,dependencies});
    for (const [map,values] of /** @type {const} */ ([[this.reverse,targets.keys()],[this.dependents,dependencies]])) {
      for (const id of values) {
        if (!map.has(id)) map.set(id,new Set());
        map.get(id).add(source);
      }
    }
  }

  /** @param {IndexEntry} note @param {(dependency: string) => void} [track] */
  targets(note,track) {
    /** @type {Map<string, IndexedReference[]>} */
    const targets=new Map();
    for (const link of note.links) {
      const {target}=this.directory.resolve(note.path,link.dest,link.wiki,track);
      if (!target) continue;
      const id=this.key(target);
      if (id===this.key(note.path)||!this.notes.has(id)) continue;
      if (!targets.has(id)) targets.set(id,[]);
      targets.get(id).push(link);
    }
    return targets;
  }

  /** @param {Pick<IndexUpdate, 'file'|'data'>[]} actions */
  apply(actions) {
    const affected=new Set();
    for (const {file,data} of actions) {
      const id=this.key(file);
      const before=this.notes.get(id);
      if (before && data && before.hash && before.hash===data.hash && before.mtime===data.item.row.modified && before.path===file) continue;
      if (!before&&!data) continue;
      if (!before||!data||before.path!==file) {
        for (const dep of this.directory.dependencies(file)) {
          for (const source of this.dependents.get(dep)||[]) affected.add(source);
        }
        this.directory.update(file,Boolean(data));
      }
      if (before) this.detach(before);
      this.drafts.delete(id);
      if (data) {
        const note=data.cached??parseNote(file,this.relative(file),data.text,data.item, data.item.size<=this.searchLimit);
        this.notes.set(id,{...note,hash:data.hash,signature:data.item.signature});
      } else this.notes.delete(id);
      affected.add(id);
      this.journal.delete(id);
      this.journal.set(id,{revision:++this.revision,path:file});
      if (this.journal.size>4096) {
        const oldest=this.journal.keys().next().value;
        this.resetBefore=this.journal.get(oldest).revision;
        this.journal.delete(oldest);
      }
    }
    for (const id of affected) {
      const note=this.notes.get(id);
      if (note?.targets) this.detach(note);
      if (note) this.connect(note);
    }
  }

  /** @param {Draft[]} [drafts] */
  overlay(drafts=[]) {
    /** @type {Map<string, IndexEntry>} */
    const changed=new Map();
    for (const draft of drafts) {
      const id=this.key(draft.path);
      const stored=this.notes.get(id);
      if (!stored||stored.text===draft.text) continue;
      let note=this.drafts.get(id);
      if(note?.text!==draft.text){
        note=parseNote(stored.path,stored.relative,draft.text,{row:{modified:stored.mtime},size:stored.size},true);
        this.drafts.set(id,note);
      }
      changed.set(id,{...note,targets:this.targets(note)});
    }
    for(const id of this.drafts.keys())if(!changed.has(id))this.drafts.delete(id);
    return changed;
  }

  graph(drafts) {
    const changed=this.overlay(drafts);
    const nodes=[],edges=[];
    for (const [id,stored] of this.notes) {
      nodes.push(stored.path);
      for (const target of (changed.get(id)||stored).targets.keys()) edges.push({from:stored.path,to:this.notes.get(target).path});
    }
    return {nodes,edges};
  }

  backlinks(target,drafts) {
    const targetId=this.key(target), name=this.path.basename(target).replace(markdown,'').toLocaleLowerCase();
    const han=/[\p{Script=Han}]/u.test(name);
    const standalone=!this.notes.has(targetId);
    const linkedSources=this.reverse.get(targetId);
    const changed=this.overlay(drafts);
    const result=[];
    for (const [id,stored] of this.notes) {
      if (id===targetId) continue;
      const note=changed.get(id)||stored;
      const linked=new Map(), unlinked=[];
      const matches=standalone?note.links.filter(link=>{
        const found=this.directory.resolve(note.path,link.dest,link.wiki).target;
        return found&&this.key(found)===targetId;
      }):(changed.has(id)||linkedSources?.has(id))?note.targets.get(targetId)||[]:[];
      for (const link of matches) {
        if (!linked.has(link.line)&&linked.size<8) linked.set(link.line,{line:link.line,text:link.text,marks:[]});
        if (link.mark) linked.get(link.line)?.marks.push(link.mark);
      }
      for (const [line,plain] of note.mentions) {
        if (linked.has(line)||!plain.includes(name)) continue;
        if (han||plain.split(/[^\p{L}\p{N}_ -]+/u).some(part=>(' '+part+' ').includes(' '+name+' '))) {
          unlinked.push({line,text:note.lines[line-1].trim().slice(0,220)});
          if (unlinked.length===5) break;
        }
      }
      if (linked.size||unlinked.length) result.push({path:note.path,name:this.path.basename(note.path),linked:[...linked.values()],unlinked});
    }
    return result;
  }

  /** @param {SearchCursor} [cursor] */
  searchSnapshot(cursor) {
    const full=cursor?.generation!==this.generation||cursor.revision<this.resetBefore||cursor.revision>this.revision;
    const rows=full ? this.notes.keys() : [...this.journal].filter(([,update])=>update.revision>cursor.revision).map(([id])=>id);
    const notes=[],removed=[];
    for (const id of rows) {
      const note=this.notes.get(id);
      if (note?.text!=null) notes.push({id,path:note.path,relative:note.relative,text:note.text,tags:note.tags});
      else if (!full) removed.push(id);
    }
    return {cursor:{generation:this.generation,revision:this.revision},full,notes,removed};
  }

  async workspaceNotes(scope,drafts=[]) {
    const changed=this.overlay(drafts);
    const result=[];
    for (const [id,stored] of this.notes) {
      if (this.signal?.aborted) return [];
      const note=changed.get(id)||stored;
      if (scope==='metadata') {
        const {path,relative,mtime,size,title,headings,tags,frontmatter,values,wikilinks,tasks}=note;
        result.push({path,relative,mtime,size,title,headings,tags,frontmatter,values,wikilinks,tasks});
      } else if (note.text!=null&&(scope!=='search'||stored.text!=null)) result.push({path:note.path,text:note.text});
      else if (scope!=='search') {
        const current=await this.read(note.path);
        if (current&&!current.truncated) result.push({path:note.path,text:current.text});
      }
    }
    return result;
  }

  search(query) {
    const needle=query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const results=[];
    for (const note of this.notes.values()) {
      for (let i=0;note.lines&&i<note.lines.length;i++) {
        if (!note.lines[i].toLocaleLowerCase().includes(needle)) continue;
        results.push({path:note.path,name:this.path.basename(note.path),line:i+1,text:note.lines[i].trim().slice(0,180)});
        if (results.length>=100) return results;
      }
    }
    return results;
  }
}

