import {t as tr} from "./i18n/index.mjs";
import { load, dump, JSON_SCHEMA } from 'js-yaml';
export const splitFrontmatter = text => {
  const match = text.match(/^(\uFEFF?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$))/m);
  return match?.index === 0
    ? { prefix: match[1], yaml: match[2], body: text.slice(match[1].length) }
    : { prefix: '', yaml: '', body: text };
};

export function properties(yaml) {
  try {
    const result = load(yaml,{schema:JSON_SCHEMA});
    return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  } catch { return null; }
}

const tagPattern = /(?<![\p{L}\p{N}_/#\\])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)(?![\p{L}\p{N}_/-])/gu;
/** @param {{tokens?: import('marked').Token[], values?: Record<string, unknown>}} [metadata] */
export function noteTags(text, marked, metadata={}) {
  const {tokens,values}=metadata;
  const {yaml,body} = splitFrontmatter(text);
  const valuesTags = (values??properties(yaml))?.tags;
  const tags = new Set((Array.isArray(valuesTags) ? valuesTags : typeof valuesTags === 'string' ? valuesTags.split(/[,\s]+/) : [])
    .map(tag => String(tag).replace(/^#/,'')).filter(Boolean));
  marked.walkTokens(tokens??marked.lexer(body),token => {
    if (token.type !== 'text' || token.tokens) return;
    for (const match of token.raw.matchAll(tagPattern)) if (/\p{L}|_/u.test(match[1])) tags.add(match[1]);
  });
  return tags;
}


export function writeProperties(text, data) {
  const { prefix, yaml, body } = splitFrontmatter(text);
  const newline = /\r\n/.test(prefix || text) ? '\r\n' : '\n';
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  const value = bom && !prefix ? body.slice(1) : body;
  const serialize = value => dump(value,{schema:JSON_SCHEMA,lineWidth:-1,noRefs:true}).replaceAll('\n',newline);
  const wrap = content => bom + '---' + newline + content + '---' + newline + value;
  if (!prefix) return Object.keys(data).length ? wrap(serialize(data)) : text;
  const before=properties(yaml);
  if (!before) throw Error(tr("noteMetadata.fixTheInvalidYamlPropertiesInSource"));
  const keys = new Set([...Object.keys(before),...Object.keys(data)]);
  const equal = (a,b) => JSON.stringify(a)===JSON.stringify(b);
  const changed = [...keys].filter(key=>!equal(before[key],data[key])||Object.hasOwn(before,key)!==Object.hasOwn(data,key));
  if (!changed.length) return text;
  const starts = [...yaml.matchAll(/^(?:"(?:[^"\\]|\\.)+"|'(?:[^']|'')+'|[^\s#?:][^:\r\n]*):(?=[ \t]|\r?$)/gm)]
    .map(match=>({start:match.index,key:Object.keys(properties(match[0]+' null')||{})[0]}));
  const patches = [];
  for (const key of changed) {
    const index = starts.findIndex(row=>row.key===key);
    if (index<0 && Object.hasOwn(before,key)) {
      throw Error(tr("noteMetadata.thisPropertyUsesComplexYamlEditIt"));
    }
    const start = index<0?yaml.length:starts[index].start;
    const end = index<0?yaml.length:starts[index+1]?.start??yaml.length;
    const comments=yaml.slice(start,end).split(/\r?\n/).filter(line=>line.startsWith('#')).map(line=>line+newline).join('');
    const next = Object.hasOwn(data,key) ? serialize({[key]:data[key]}) : '';
    patches.push({start,end,value:next+comments});
  }
  let nextYaml=yaml;
  for (const patch of patches.sort((a,b)=>b.start-a.start))
    nextYaml=nextYaml.slice(0,patch.start)+patch.value+nextYaml.slice(patch.end);
  const parsed=properties(nextYaml);
  if (!parsed || [...keys].some(key=>Object.hasOwn(parsed,key)!==Object.hasOwn(data,key)||!equal(parsed[key],data[key]))) {
    throw Error(tr("noteMetadata.thisChangeAffectsOtherYamlPropertiesEdit"));
  }
  return nextYaml.trim() ? wrap(nextYaml) : bom + value;
}
