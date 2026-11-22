import { marked } from 'marked';
import { noteTags } from './note-metadata.js';

const cache=new Map();
self.onmessage = ({data:{query,regex,caseSensitive,update,drafts}}) => {
  try {
    if (update.full) cache.clear();
    for (const id of update.removed) cache.delete(id);
    for (const note of update.notes) cache.set(note.id,note);
    const overlay=new Map(drafts.map(draft=>[draft.id,draft.text]));
    const flags = caseSensitive ? 'u' : 'iu';
    const normalized = value => caseSensitive ? value : value.toLocaleLowerCase();
    const filters = [];
    let content = query.replace(/(?:^|\s)(path|file|tag):(?:"([^"]+)"|(\S+))/gi, (_, type, quoted, bare) => {
      filters.push([type.toLowerCase(), normalized(quoted || bare)]);
      return ' ';
    }).trim();
    const expression = regex && content ? new RegExp(content,flags) : null;
    const phrases = regex ? [] : [...content.matchAll(/-?(?:"[^"]+"|\S+)/g)].map(([term])=>{
      const negative = term.startsWith('-');
      return [normalized((negative ? term.slice(1) : term).replace(/^"|"$/g,'')),negative];
    }).filter(([term])=>term);
    const found = [];
    let total = 0;
    for (const [id,cached] of cache) {
      const note=overlay.has(id)?{...cached,text:overlay.get(id),tags:undefined}:cached;
      const path = normalized(note.relative);
      const file = path.split('/').at(-1);
      let tags;
      const matches = filters.every(([type, value]) => {
        if (type === 'path') return path.includes(value);
        if (type === 'file') return file.includes(value);
        tags ??= (note.tags||[...noteTags(note.text,marked)]).map(normalized);
        const tag = value.replace(/^#/,'');
        return tags.some(item=>item === tag || item.startsWith(tag+'/'));
      });
      if (!matches) continue;
      const body = normalized(note.text);
      if (!phrases.every(([term,negative])=>body.includes(term) !== negative)) continue;
      const hits = [];
      const positives = phrases.filter(([,negative])=>!negative).map(([term])=>term);
      if (!expression && !positives.length) hits.push({line:0,text:''});
      else {
        const lines = note.text.split(/\r?\n/);
        for (let index = 0; index < lines.length && hits.length < 20 && total+hits.length < 250; index++) {
          const line = lines[index];
          if (expression ? expression.test(line) : positives.some(term=>normalized(line).includes(term))) {
            hits.push({line:index+1,text:line.trim().slice(0,220)});
          }
        }
      }
      if (hits.length) found.push({path:note.path,relative:note.relative,hits});
      total += hits.length;
      if (total >= 250) break;
    }
    self.postMessage({found,total});
  } catch (error) {
    self.postMessage({error:error.message});
  }
};
