export function tagTree(notes) {
  const roots=new Map();
  for(const {path,tags} of notes)for(const tag of tags||[]){
    let children=roots,parts=[];
    for(const label of tag.split('/').filter(Boolean)){
      parts=[...parts,label];
      const key=label.toLocaleLowerCase();
      if(!children.has(key))children.set(key,{label,tag:parts.join('/'),paths:new Set(),children:new Map()});
      const node=children.get(key);
      node.paths.add(path);
      children=node.children;
    }
  }
  const flatten=map=>[...map.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'))
    .map(node=>({...node,paths:[...node.paths],children:flatten(node.children)}));
  return flatten(roots);
}

const pad=value=>String(value).padStart(2,'0');
export function noteDateParts(date) {
  const YYYY=String(date.getFullYear()),MM=pad(date.getMonth()+1),DD=pad(date.getDate());
  return {YYYY,MM,DD,date:YYYY+'-'+MM+'-'+DD,time:pad(date.getHours())+':'+pad(date.getMinutes()),
    weekday:new Intl.DateTimeFormat('zh-CN',{weekday:'long'}).format(date)};
}

export function expandNoteTemplate(text,{title,vault,date}) {
  const values={title,vault,...noteDateParts(date)};
  return text.replace(/\{\{\s*(title|vault|date|time|weekday)\s*\}\}/g,(_,key)=>values[key]);
}

export function dailyNoteName(pattern,date) {
  const values=noteDateParts(date);
  const name=String(pattern||'YYYY-MM-DD').trim().replace(/YYYY|MM|DD/g,token=>values[token]).replace(/\.md$/i,'');
  if(!name||name.length>96||/^[.]|[. ]$|[\\/:*?"<>|\x00-\x1f]/.test(name))
    throw Error('每日笔记文件名格式无效。');
  return name;
}

export function relativeNotePath(source,target,key=value=>value) {
  const from=source.replaceAll('\\','/').split('/').slice(0,-1);
  const to=target.replaceAll('\\','/').split('/');
  let same=0;
  while(same<from.length&&same<to.length&&key(from[same])===key(to[same]))same++;
  return [...Array(from.length-same).fill('..'),...to.slice(same)].join('/');
}
