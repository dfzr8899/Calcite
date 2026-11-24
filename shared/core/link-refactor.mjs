import {t as tr} from "../i18n/index.mjs";
import {encodeWiki,headingSlug,linkDirectory,mapLinks,markdown,markdownNodes,splitLink} from '../note-links.mjs';
import {splitFrontmatter} from '../note-metadata.mjs';
import {normalizeLineEndings} from '../text-files.mjs';

/** @import {PathOperations} from './types.mjs' */
/** @import {VaultIndex} from './vault-index.mjs' */
/** @typedef {ReturnType<typeof linkDirectory>} LinkDirectory */
/** @typedef {{path: string, text: string, saved?: string}} Draft */
/** @typedef {{path: string, heading?: string, slug?: string, title?: string}} ReferenceTarget */

const slash=value=>value.replaceAll('\\','/');
const encodePath=value=>slash(value).split('/').map(part=>encodeURIComponent(part)
  .replaceAll('(','%28').replaceAll(')','%29')).join('/');

/**
 * @param {string} text
 * @param {string} source
 * @param {(file: string) => string} move
 * @param {LinkDirectory} before
 * @param {LinkDirectory} after
 * @param {PathOperations} path
 * @param {(file: string) => string} key
 */
export function rewriteLinks(text, source, move, before, after, path, key) {
  const newSource=move(source);
  let count=0;
  const next=mapLinks(text,(dest,wiki)=>{
    const {target,heading}=before.resolve(source,dest,wiki);
    if(!target||dest.startsWith('#'))return dest;
    const moved=move(target);
    const existing=after.resolve(newSource,dest,wiki).target;
    if(existing&&key(existing)===key(moved)&&
      !(moved!==target&&key(moved)===key(target)))return dest;
    if(!wiki&&moved===target&&newSource===source)return dest;
    const original=splitLink(dest)[0];
    const relative=slash(path.relative(path.dirname(newSource),moved));
    let replacement;
    if(wiki){
      if(original.startsWith('/'))replacement='/'+encodeWiki(markdown.test(original)?after.relative(moved):after.relative(moved).replace(markdown,''));
      else if(/^\.\.?[\\/]/.test(original)){
        const local=markdown.test(original)?relative:relative.replace(markdown,'');
        replacement=encodeWiki(local.startsWith('../')?local:'./'+local);
      }else replacement=after.identifier(moved);
    }else{
      const prefix=original.startsWith('./')&&!relative.startsWith('../')?'./':'';
      replacement=prefix+encodePath(relative);
    }
    replacement+=heading;
    if(replacement!==dest)count++;
    return replacement;
  });
  return {text:next,count};
}

/**
 * @param {VaultIndex} index
 * @param {string} from
 * @param {string} to
 * @param {Draft[]} drafts
 * @param {(path: string) => Promise<{text: string, mtime: number}>} read
 */
export async function planLinkRefactor(index,from,to,drafts,read) {
  const {path,key,within,root}=index;
  const move=file=>within(from,file)?to+file.slice(from.length):file;
  const after=linkDirectory(root,path,key,index.paths().map(move));
  const rewrite=(text,file)=>{
    const {prefix,body}=splitFrontmatter(text);
    const {suffix}=splitReferenceBlock(body);
    const result=rewriteLinks(text,file,move,index.directory,after,path,key);
    if(!suffix)return result;
    // Generated definitions mirror their wiki labels. Update those label spans
    // in place just as we update definition destinations in ordinary Markdown.
    const offset=result.text.indexOf(startMarker,prefix.length);
    const block=splitReferenceBlock(splitFrontmatter(result.text).body).suffix;
    if(!block||result.text.slice(offset,offset+block.length)!==block)return result;
    const labels=[];
    markdownNodes(block,(node,start,end)=>{
      if(node.type!=='definition')return;
      const label=/^ {0,3}\[([^\]\r\n]+)\]:/.exec(block.slice(start,end))?.[1];
      if(!label)return;
      const next=rewriteLinks('[['+label+']]',file,move,index.directory,after,path,key).text.slice(2,-2);
      if(next!==label){
        const at=offset+start+block.slice(start,end).indexOf('[')+1;
        labels.push({at,end:at+label.length,next});
      }
    });
    for(const span of labels.reverse())result.text=result.text.slice(0,span.at)+span.next+result.text.slice(span.end);
    result.count+=labels.length;
    return result;
  };
  const draftByPath=new Map(drafts.map(draft=>[key(draft.path),draft]));
  const changes=[];
  let references=0,notes=0;
  for(const file of index.affectedByMove(move,after.resolve,drafts)){
    const {text,mtime}=await read(file);
    const dest=move(file);
    const result=rewrite(text,file);
    const draft=draftByPath.get(key(file));
    const edited=draft?rewrite(draft.text,file):null;
    if(result.text===text&&dest===file&&(!edited||edited.text===draft.text))continue;
    if(draft?.saved!==undefined&&normalizeLineEndings(file,draft.saved)!==normalizeLineEndings(file,text))
      throw Error(tr("linkRefactor.thisNoteChangedElsewhereResolveTheConflict")+path.basename(file));
    const count=Math.max(result.count,edited?.count||0);
    if(count){references+=count;notes++;}
    changes.push({from:file,path:dest,previous:text,saved:result.text,
      mtime,count:result.count,draft:edited?.text});
  }
  return {move,changes,refactor:{notes,references}};
}

/**
 * @param {string} text
 * @param {string} root
 * @param {(file: string) => string} move
 * @param {PathOperations} path
 * @param {(parent: string, file: string) => boolean} within
 */
export function rewriteCanvasLinks(text,root,move,path,within) {
  const board=JSON.parse(text.replace(/^\uFEFF/,''));
  if(!Array.isArray(board?.nodes))return null;
  let count=0;
  for(const node of board.nodes){
    if(node?.type!=='file'||typeof node.file!=='string')continue;
    const normalized=node.file.replaceAll('\\','/').replace(/^\/+/,'');
    if(!normalized)continue;
    const resolved=path.resolve(root,normalized);
    if(!within(root,resolved)||resolved===root)continue;
    const next=move(resolved);
    if(next!==resolved){
      node.file=slash(path.relative(root,next));
      count++;
    }
  }
  if(!count)return {text,count:0};
  const bom=text.startsWith('\uFEFF')?'\uFEFF':'';
  const newline=text.includes('\r\n')?'\r\n':'\n';
  const saved=bom+(JSON.stringify(board,null,2)+'\n').replaceAll('\n',newline);
  return {text:saved,count};
}

/**
 * @param {VaultIndex} index
 * @param {(file: string) => string} move
 * @param {string[]} canvases
 * @param {Draft[]} drafts
 * @param {(path: string) => Promise<{text: string, mtime: number}|null>} read
 */
export async function planCanvasLinkRefactor(index,move,canvases,drafts,read) {
  const {path,key,within,root}=index;
  const draftByPath=new Map(drafts.map(draft=>[key(draft.path),draft]));
  const changes=[];
  let references=0,notes=0;
  for(const file of canvases){
    let disk;
    try{disk=await read(file);}
    catch{continue;}
    if(!disk)continue;
    const {text,mtime}=disk;
    let result;
    try{result=rewriteCanvasLinks(text,root,move,path,within);}
    catch{continue;}
    if(!result)continue;
    const dest=move(file);
    const draft=draftByPath.get(key(file));
    let edited=null;
    if(draft){
      try{edited=rewriteCanvasLinks(draft.text,root,move,path,within);}
      catch{edited=null;}
    }
    if(result.text===text&&dest===file&&(!edited||edited.text===draft.text))continue;
    if(draft?.saved!==undefined&&normalizeLineEndings(file,draft.saved)!==normalizeLineEndings(file,text))
      throw Error(tr("linkRefactor.thisNoteChangedElsewhereResolveTheConflict")+path.basename(file));
    const count=Math.max(result.count,edited?.count||0);
    if(count){references+=count;notes++;}
    changes.push({from:file,path:dest,previous:text,saved:result.text,
      mtime,count:result.count,draft:edited?.text});
  }
  return {changes,refactor:{notes,references}};
}

/** @param {string} text @param {{from: number, destination: string}} reference @param {string} identifier */
export function replaceReference(text,reference,identifier) {
  let replaced=false;
  const next=mapLinks(text,(destination,wiki,at,span)=>{
    if(wiki&&span.from===reference.from&&destination===reference.destination){
      replaced=true;
      return identifier+splitLink(destination)[1];
    }
    return destination;
  });
  if(!replaced)throw Error(tr("linkRefactor.thisLinkChangedRefreshTheVaultCheck"));
  return next;
}

const startMarker='<!-- calcite:refs:start -->';
const endMarker='<!-- calcite:refs:end -->';
const labelKey=value=>value.trim().replace(/\s+/g,' ').toLocaleLowerCase();
export function splitReferenceBlock(body) {
  if(!body.includes(startMarker)||!body.includes(endMarker))return {body,suffix:''};
  const start=[],end=[];
  markdownNodes(body,(node,from,to)=>{
    if(node.type!=='html')return;
    const html=body.slice(from,to).trim();
    if(html===startMarker)start.push(from);
    if(html===endMarker)end.push(to);
  });
  if(start.length!==1||end.length!==1||start[0]>=end[0])return {body,suffix:''};
  const content=body.slice(start[0]+startMarker.length,end[0]-endMarker.length);
  let valid=true;
  markdownNodes(content,node=>{if(!['root','definition'].includes(node.type))valid=false;});
  if(!valid)return {body,suffix:''};
  return {body:body.slice(0,start[0])+body.slice(end[0]).replace(/^\r?\n/,''),suffix:body.slice(start[0],end[0])};
}
/**
 * @param {string} text
 * @param {(destinations: string[]) => (ReferenceTarget|null)[]|Promise<(ReferenceTarget|null)[]>} resolve
 * @param {(path: string) => string} relativePath
 */
export async function updateReferenceDefinitions(text,resolve,relativePath) {
  const {body,prefix}=splitFrontmatter(text);
  const source=prefix+splitReferenceBlock(body).body;
  const manuallyDefined=new Set();
  const offset=splitFrontmatter(source).prefix.length;
  markdownNodes(source.slice(offset),node=>{
    if(node.type==='definition')manuallyDefined.add(labelKey(node.label));
  });
  const candidates=new Map();
  mapLinks(source,(destination,wiki,at,span)=>{
    if(wiki&&!manuallyDefined.has(labelKey(span.label)))candidates.set(labelKey(span.label),{destination,label:span.label});
    return destination;
  });
  const links=[...candidates.values()];
  const targets=await resolve(links.map(link=>link.destination));
  const definitions=links.flatMap(({label},index)=>{
    const target=targets[index];
    if(!target?.path)return [];
    const {heading}=target;
    let link=encodePath(relativePath(target.path));
    if(!link.startsWith('../'))link='./'+link;
    if(heading)link+='#'+encodeURIComponent(target.slug||headingSlug(heading));
    const title=String(target.title||'').replace(/[\r\n\t]/g,' ').replace(/[\\"]/g,'\\$&');
    return ['['+label+']: '+link+(title?' "'+title+'"':'')];
  });
  const newline=text.includes('\r\n')?'\r\n':'\n';
  const result=definitions.length?source.trimEnd()+newline+newline+[startMarker,...definitions,endMarker,''].join(newline):source;
  return {text:result,count:definitions.length};
}
