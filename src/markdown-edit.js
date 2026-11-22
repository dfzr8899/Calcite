import {splitFrontmatter} from './note-metadata.js';

export function displayWidth(text) {
  let width=0;
  for (const char of text) {
    const code=char.codePointAt(0);
    if (/\p{Mark}|\p{Cf}/u.test(char)) continue;
    width+=/\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Extended_Pictographic}/u.test(char)||
      code>=0xff01&&code<=0xff60||code>=0x3000&&code<=0x303f?2:1;
  }
  return width;
}

function editable(text, transform) {
  const {prefix,body}=splitFrontmatter(text);
  const eol=/\r\n/.test(text)?'\r\n':'\n';
  const lines=body.split(/\r?\n/), safe=[];
  let fence, html=false;
  for (const line of lines) {
    const mark=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    safe.push(!fence&&!mark&&!html&&!/^ {4}|^\t/.test(line));
    if (mark) {
      if (!fence) fence=mark[1];
      else if(mark[1].startsWith(fence)&&!mark[2].trim()) fence=null;
    }
    if (!fence&&line.includes('<!--')&&!line.includes('-->')) html=true;
    if (line.includes('-->')) html=false;
  }
  transform(lines,safe,prefix.split(/\r?\n/).length-1);
  return prefix+lines.join(eol);
}

function cells(line) {
  const out=[];
  let start=0,ticks=0;
  for(let i=0;i<line.length;i++) {
    if(line[i]==='\\') {i++;continue;}
    if(line[i]==='`') {
      const end=i+line.slice(i).match(/^`+/)[0].length;
      if (!ticks) ticks=end-i;
      else if (end-i===ticks) ticks=0;
      i=end-1;
    } else if (line[i]==='|'&&!ticks) {out.push(line.slice(start,i).trim());start=i+1;}
  }
  if (!out.length) return null;
  out.push(line.slice(start).trim());
  if (!out[0]) out.shift();
  if (!out.at(-1)) out.pop();
  return out.length?out:null;
}

function visitTables(text,visit) {
  return editable(text,(lines,safe,offset)=>{
    for(let at=0;at<lines.length-1;at++) {
      if (!safe[at]||!safe[at+1]) continue;
      const header=cells(lines[at]), align=cells(lines[at+1]);
      if (!header||header.length!==align?.length||!align.every(cell=>/^:?-{3,}:?$/.test(cell))) continue;
      const rows=[header];
      let end=at+2;
      while(safe[end]) {
        const row=cells(lines[end]);
        if(!row||row.length!==header.length) break;
        rows.push(row);end++;
      }
      visit({lines,rows,header,align,at,end,offset});
      at=end-1;
    }
  });
}

export function tableAtLine(text,line) {
  let found=false;
  visitTables(text,({at,end,offset})=>{if (line>=at+offset&&line<end+offset) found=true;});
  return found;
}

export function tableStartLines(text) {
  const lines=[];
  visitTables(text,({at,offset})=>lines.push(at+offset));
  return lines;
}

export function formatTables(text,line) {
  return visitTables(text,({lines,rows,header,align,at,end,offset})=>{
      if (line==null||line>=at+offset&&line<end+offset) {
        const widths=header.map((_,i)=>rows.reduce((width,row)=>Math.max(width,displayWidth(row[i])),
          3+Number(align[i].startsWith(':'))+Number(align[i].endsWith(':'))));
        const row=values=>'| '+values.join(' | ')+' |';
        const format=values=>row(values.map((value,i)=>value+' '.repeat(widths[i]-displayWidth(value))));
        lines[at]=format(header);
        lines[at+1]=row(align.map((value,i)=>{
          const left=value.startsWith(':')?':':'',right=value.endsWith(':')?':':'';
          return left+'-'.repeat(widths[i]-left.length-right.length)+right;
        }));
        for(let i=1;i<rows.length;i++) lines[at+1+i]=format(rows[i]);
      }
  });
}

const numbered=/^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/;
export function renumberList(text,line) {
  return editable(text,(lines,safe,offset)=>{
    const at=line-offset;
    const item=lines[at]?.match(numbered);
    if (!item) return;
    const indent=item[1], marker=item[3];
    const matching=i=>{const match=lines[i]?.match(numbered);return match?.[1]===indent&&match[3]===marker?match:null;};
    const nested=i=>Boolean(lines[i]?.startsWith(indent+' ')||lines[i]?.startsWith(indent+'\t'));
    let start=at;
    while(start>0&&(matching(start-1)||nested(start-1))) start--;
    let next=1;
    for(let i=start;i<lines.length;i++) {
      const match=matching(i);
      if (match) {if(!safe[i]&&!indent) break;lines[i]=indent+next+++marker+match[4]+match[5];}
      else if (!nested(i)) break;
    }
  });
}

const headerPattern=/^( {0,3})(#{1,6})([ \t]+)(.*)$/;
const withoutNumber=value=>value.replace(/^\d+(?:\.\d+)*(?:\.)?[ \t]+/,'');
export function numberHeadings(text,{clear=false,skipH1=true}={}) {
  return editable(text,(lines,safe)=>{
    const counts=Array(6).fill(0);
    const levels=lines.flatMap((line,i)=>safe[i]&&headerPattern.test(line)?[line.match(headerPattern)[2].length]:[]);
    const base=Math.min(...levels.filter(level=>!skipH1||level!==1));
    for(const [i,line] of lines.entries()) {
      const heading=safe[i]&&line.match(headerPattern);
      if(!heading) continue;
      const [,indent,marks,gap,label]=heading;
      const value=withoutNumber(label);
      if(clear||skipH1&&marks.length===1) {lines[i]=indent+marks+gap+value;continue;}
      const index=marks.length-base;
      counts[index]++;
      counts.fill(0,index+1);
      lines[i]=indent+marks+gap+counts.slice(0,index+1).map(count=>count||1).join('.')+(index===0?'. ':' ')+value;
    }
  });
}

export function insertToc(text) {
  return editable(text,(lines,safe)=>{
    const start=lines.findIndex((line,i)=>safe[i]&&line.trim()==='<!-- TOC -->');
    const end=start<0?-1:lines.findIndex((line,i)=>i>start&&safe[i]&&line.trim()==='<!-- /TOC -->');
    const identifiers=new Map(), headings=[];
    for(const [i,line] of lines.entries()) {
      const item=safe[i]&&line.match(headerPattern);
      if(!item||start>=0&&end>=0&&i>start&&i<end) continue;
      const label=item[4].replace(/[ \t]+#+[ \t]*$/,'').trim();
      const slug=label.toLocaleLowerCase().replace(/[^\p{L}\p{N}_ -]/gu,'').replace(/\s/g,'-');
      const previous=identifiers.get(slug)||0;
      identifiers.set(slug,previous+1);
      headings.push({level:item[2].length,label,slug:slug+(previous?'-'+previous:'')});
    }
    const base=Math.min(...headings.map(row=>row.level));
    const toc=['<!-- TOC -->',...headings.map(row=>'  '.repeat(row.level-base)+'- ['+
      row.label.replace(/[\[\]\\]/g,'\\$&')+'](#'+row.slug+')'),'<!-- /TOC -->'];
    if (start>=0&&end>start) lines.splice(start,end-start+1,...toc);
    else if (start<0) lines.unshift(...toc,'');
  });
}

export function toggleTasks(line) {
  return line.replace(/^([ \t]*(?:>\s*)?(?:[-+*]|\d+[.)])[ \t]+)\[([ xX])\]/gm,
    (_,prefix,value)=>prefix+(value===' '?'[x]':'[ ]'));
}

export function pastedURL(text) {
  const candidate=text.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(candidate)) return null;
  try { const url=new URL(candidate); return url.username||url.password?null:url.href; } catch {return null;}
}
