import {encodeWiki,headingIdentifiers,headingIndex,headingSlug,linkDirectory,mapLinks,markdown,markdownNodes,splitLink} from '../note-links.mjs';
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
  const movedNotes=new Map(index.paths().map(file=>[key(move(file)),file]));
  const after=linkDirectory(root,path,key,[...movedNotes.values()].map(move));
  const rewrite=async(text,file)=>{
    const {prefix,body}=splitFrontmatter(text);
    const block=splitReferenceBlock(body);
    const result=rewriteLinks(prefix+block.body,file,move,index.directory,after,path,key);
    if(!block.suffix)return result;
    const source=move(file);
    const generated=await updateReferenceDefinitions(result.text,links=>links.map(destination=>{
      const {target,heading}=after.resolve(source,destination,true);
      if(!target)return null;
      const note=index.notes.get(key(movedNotes.get(key(target))||target));
      if(!note)return null;
      const fragment=heading.slice(1);
      const headings=headingIdentifiers(note.headings);
      const row=fragment?headings[headingIndex(headings,fragment)]:null;
      return !fragment||row?{path:target,heading:fragment,slug:row?.slug,title:note.title}:null;
    }),target=>path.relative(path.dirname(source),target));
    return {text:generated.text,count:result.count};
  };
  const draftByPath=new Map(drafts.map(draft=>[key(draft.path),draft]));
  const changes=[];
  let references=0,notes=0;
  for(const file of index.affectedByMove(move,after.resolve,drafts)){
    const {text,mtime}=await read(file);
    const dest=move(file);
    const result=await rewrite(text,file);
    const draft=draftByPath.get(key(file));
    const edited=draft?await rewrite(draft.text,file):null;
    if(result.text===text&&dest===file&&(!edited||edited.text===draft.text))continue;
    if(draft?.saved!==undefined&&normalizeLineEndings(file,draft.saved)!==normalizeLineEndings(file,text))
      throw Error('笔记已在别处修改，请先处理冲突：'+path.basename(file));
    const count=Math.max(result.count,edited?.count||0);
    if(count){references+=count;notes++;}
    changes.push({from:file,path:dest,previous:text,saved:result.text!==text?normalizeLineEndings(dest,result.text):text,
      mtime,draft:edited?.text});
  }
  return {move,changes,refactor:{notes,references}};
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
  if(!replaced)throw Error('这处引用已变化，请刷新体检后重试。');
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
