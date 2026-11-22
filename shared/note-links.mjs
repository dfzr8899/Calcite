import {fromMarkdown} from 'mdast-util-from-markdown';
import {splitFrontmatter} from './note-metadata.mjs';

export const markdown=/\.(?:md|markdown|mdown)$/i;
const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
export const splitLink = value => {
  const index = value.indexOf('#');
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index)];
};

const references = /(?<![\\])\[\[([^\]\r\n]+)\]\]|(?<![\\])\]\([ \t]*(?:<([^>\r\n]+)>|((?:\\.|\([^()\r\n]*\)|[^\s()])+))(?=[ \t)]|$)|^ {0,3}\[(?!\^)[^\]\r\n]+\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))/gm;

/** @typedef {{from: number, to: number, alias?: string, embedded?: boolean, label?: string}} ReferenceSpan */
/** @typedef {{target?: string, heading?: string, ambiguous?: string[]}} LinkResolution */

export function markdownNodes(text,visitor,offset=0) {
  function visit(node){
    const {start,end}=node.position;
    if(visitor(node,start.offset+offset,end.offset+offset)!==false)
      for(const child of node.children||[])visit(child);
  }
  visit(fromMarkdown(text));
}

/**
 * @param {string} text
 * @param {(destination: string, wiki: boolean, position: number, details: ReferenceSpan) => string} map
 * @param {{prefix: string, body: string}} [parsed]
 */
export function mapLinks(text, map, parsed=splitFrontmatter(text)) {
  const {prefix,body}=parsed;
  const opaque=[],markdownLinks=[];
  markdownNodes(body,(node,from,to)=>{
    if(['code','inlineCode','html'].includes(node.type)){
      opaque.push({from,to});
      return false;
    }
    if(['link','image','definition'].includes(node.type))markdownLinks.push({from,to});
  },prefix.length);
  let position=0;
  function segment(value, start) {
    return value.replace(references, (full, wiki, angle, bare, referenceAngle, referenceBare, index) => {
      const at=start+index;
      if (wiki !== undefined) {
        const alias = wiki.indexOf('|');
        const dest = alias < 0 ? wiki : wiki.slice(0, alias);
        const embedded=text[at-1]==='!'&&text[at-2]!=='\\';
        return '[[' + map(dest, true, at,{alias:alias<0?'':wiki.slice(alias+1),embedded,label:wiki,
          from:at+2,to:at+2+dest.length}) +
          (alias < 0 ? '' : wiki.slice(alias)) + ']]';
      }
      const dest = angle ?? bare ?? referenceAngle ?? referenceBare;
      const offset = full.lastIndexOf(dest);
      while(markdownLinks[position]?.to<=at+offset)position++;
      if(!markdownLinks[position]||markdownLinks[position].from>at+offset)return full;
      return full.slice(0, offset) + map(dest, false, at,{from:at+offset,to:at+offset+dest.length}) +
        full.slice(offset + dest.length);
    });
  }
  let index=prefix.length,result=prefix;
  for(const {from,to} of opaque){
    result+=segment(text.slice(index,from),index)+text.slice(from,to);
    index=to;
  }
  return result + segment(text.slice(index), index);
}

const suffixes=value=>{
  const parts=value.split('/');
  return parts.map((_,i)=>parts.slice(i).join('/')).reverse();
};
export const encodeWiki = value => value.replace(/[#%\[\]|^]/g,encodeURIComponent);
const wikiNames=value=>[...suffixes(value.replace(markdown,'')),...suffixes(value)];
export function wikiIdentifiers(paths,relative,key) {
  const counts=new Map();
  const names=paths.map(path=>{
    const variants=wikiNames(relative(path));
    for(const name of variants)counts.set(key(name),(counts.get(key(name))||0)+1);
    return variants;
  });
  return new Map(paths.map((path,i)=>[path,encodeWiki(names[i].find(name=>counts.get(key(name))===1)||'/'+relative(path))]));
}
export const headingSlug=value=>value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s+/g,'-');
export const headingMatches=(text,fragment)=>{
  const decoded=decode(fragment);
  return text===decoded||headingSlug(text)===headingSlug(decoded);
};
export function headingIdentifiers(rows) {
  const counts=new Map();
  const used=new Set();
  return rows.map(row=>{
    const base=headingSlug(row.text);
    let count=counts.get(base)||0;
    let slug=count?base+'-'+count:base;
    while(used.has(slug))slug=base+'-'+(++count);
    counts.set(base,count+1);
    used.add(slug);
    return {...row,slug,fragment:count?slug:row.text};
  });
}
export function headingIndex(rows,fragment){
  const decoded=decode(fragment);
  const identifiers=rows.every(row=>row.slug!==undefined)?rows:headingIdentifiers(rows);
  const direct=identifiers.findIndex(row=>row.fragment===decoded);
  if(direct>=0)return direct;
  const slug=headingSlug(decoded);
  return identifiers.findIndex(row=>row.slug===slug);
}

export function linkDirectory(root, path, key, notes=[]) {
  const byPath = new Map();
  const byName = new Map();
  const relative=note=>path.relative(root,note).split(path.sep).join('/');
  const namesFor=note=>wikiNames(relative(note));
  function update(note, present) {
    const file=key(note);
    if(present)byPath.set(file,note);
    else byPath.delete(file);
    for(const suffix of namesFor(note)){
      const name=key(suffix);
      if(present){
        if(!byName.has(name))byName.set(name,new Set());
        byName.get(name).add(file);
        continue;
      }
      const names=byName.get(name);
      names?.delete(file);
      if (!names?.size) byName.delete(name);
    }
  }
  for(const note of notes) update(note,true);
  const candidates = target=>markdown.test(target)?[target]:['.md','.markdown','.mdown'].map(ext=>target+ext);
  const pathKey = value=>'p:'+key(value);
  const nameKey = value=>'n:'+key(value);
  /**
   * @param {string} source
   * @param {string} destination
   * @param {boolean} wiki
   * @param {(dependency: string) => void} [track]
   * @returns {LinkResolution}
   */
  function resolve(source, destination, wiki, track=()=>{}) {
    const [raw, heading] = splitLink(destination);
    if (!raw) return { target: source, heading };
    const name = decode(raw).replace(/\\([()])/g, '$1');
    if (/^[\w+-]+:|^\/\//.test(name)) return {};
    const local = path.resolve(path.dirname(source), name);
    if (!wiki) {
      const target=name.startsWith('/') ? path.resolve(root,'.'+name) : local;
      track(pathKey(target));
      return {target,heading};
    }
    const fromRoot = path.resolve(root, '.' + (name.startsWith('/') ? name : '/' + name));
    if(!/^(?:\.{1,2}(?:[\\/]|$)|\/)/.test(name)){
      const id=name.replaceAll('\\','/');
      track(nameKey(id));
      const matches=[...(byName.get(key(id))||[])].map(file=>byPath.get(file));
      return matches.length===1?{target:matches[0],heading}:{heading,...(matches.length?{ambiguous:matches}:{})};
    }
    const possible = name.startsWith('/') ? candidates(fromRoot) : candidates(local);
    for(const item of possible) track(pathKey(item));
    const target=possible.map(item=>byPath.get(key(item))).find(Boolean);
    return { target, heading };
  }
  function identifier(note){
    for(const suffix of namesFor(note)){
      const group=byName.get(key(suffix));
      if(group?.size===1&&group.has(key(note)))return encodeWiki(suffix);
    }
    return '/'+encodeWiki(relative(note));
  }
  return {resolve,update,identifier,relative,dependencies:note=>[pathKey(note),...namesFor(note).map(nameKey)]};
}

