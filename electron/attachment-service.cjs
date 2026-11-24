const {t:tr}=require("../shared/i18n/index.mjs");
const path=require('node:path');
const fs=require('node:fs/promises');
const {imageExtension,markdownImages,localReference,outsideCode}=require('../shared/markdown-images.mjs');
const {within,key}=require('./workspace.cjs');

const ignored=new Set(['node_modules','dist','release']);

async function catalog(root) {
  const pictures=[],notes=[],canvases=[];
  async function walk(dir) {
    if(path.relative(dir,await fs.realpath(dir)))return;
    for(const item of await fs.readdir(dir,{withFileTypes:true})) {
      if(item.name.startsWith('.')||ignored.has(item.name.toLowerCase())||item.isSymbolicLink())continue;
      const file=path.join(dir,item.name);
      if(item.isDirectory())await walk(file);
      else if(item.isFile()) {
        if(imageExtension.test(file))pictures.push(file);
        else if(/\.canvas$/i.test(file))canvases.push(file);
        else if(/\.(?:md|markdown|mdown)$/i.test(file))notes.push(file);
      }
    }
  }
  await walk(root);
  return {pictures,notes,canvases};
}

function referenceCandidates(destination,note,root,wiki) {
  const relative=localReference(destination);
  if(!relative)return [];
  const base=relative.startsWith('/')?(root?path.resolve(root,'.'+relative):null):path.resolve(path.dirname(note),relative);
  if(!base)return [];
  return [...new Set([base,...(root&&wiki&&!relative.startsWith('.')&&!relative.startsWith('/')?[path.resolve(root,relative)]:[])])];
}

function rewriteImages(text,replacements) {
  if(!replacements.size)return text;
  const pattern=new RegExp([...replacements.keys()].sort((a,b)=>b.length-a.length).map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
  return outsideCode(text,value=>value.replace(pattern,raw=>replacements.get(raw)));
}

async function orphanPictures(root,{index,drafts=[],verify=false}={}) {
  const {pictures,notes,canvases}=await catalog(root);
  const selected=new Map(drafts.map(row=>[key(row.path),row.text]));
  const remaining=new Map(pictures.map(file=>[key(file),file]));
  const byName=new Map();
  for(const file of pictures) {
    const name=key(path.basename(file));
    if(!byName.has(name))byName.set(name,[]);
    byName.get(name).push(file);
  }
  function mark(destination,file,wiki=false) {
    const paths=referenceCandidates(destination,file,root,wiki);
    for(const entry of paths) remaining.delete(key(entry));
    if(wiki) {
      const local=localReference(destination);
      if(local&&!local.includes('/'))for(const match of byName.get(key(local))||[])remaining.delete(key(match));
    }
  }
  function markMarkdown(text,file) {
    for(const ref of markdownImages(text))mark(ref.destination,file,ref.wiki);
    // Keep assets explicitly mentioned by name in HTML srcset, properties or inline code
    // even when the reference syntax is not one we know how to rewrite.
    for(const hit of text.matchAll(/[^\s<>"'`|()[\]{}]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?=$|[\s<>"'#?`|()[\]{}])/gi)) {
      const local=localReference(hit[0]);
      if(local)for(const candidate of byName.get(key(path.basename(local)))||[])remaining.delete(key(candidate));
    }
  }
  async function load(file,maximum) {
    if(path.relative(await fs.realpath(file),file))throw Error(tr("attachmentService.theFileMovedScanAttachmentsAgain"));
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum) throw Error(tr("attachmentService.someFilesCouldNotBeScannedSo"));
    const cached=index?.notes.get(key(file));
    const text=!verify&&cached?.mtime===stat.mtimeMs&&cached.text!==null?cached.text:await fs.readFile(file,'utf8');
    return [text,selected.get(key(file))];
  }
  for(const file of notes) {
    const [text,draft]=await load(file,16*1024*1024);
    markMarkdown(text,file);
    if(draft!=null&&draft!==text)markMarkdown(draft,file);
  }
  for(const file of canvases) {
    const [text]=await load(file,5*1024*1024);
    let nodes;
    try{nodes=JSON.parse(text).nodes;}catch{throw Error(tr("attachmentService.aCanvasCouldNotBeParsedSo"));}
    if(!Array.isArray(nodes))continue;
    for(const node of nodes) {
      if(node?.type==='file'&&typeof node.file==='string')mark('/'+node.file.replace(/^\//,''),file,true);
      if(typeof node?.background==='string')mark('/'+node.background.replace(/^\//,''),file,true);
      if(node?.type==='text'&&typeof node.text==='string')markMarkdown(node.text,file);
    }
  }
  const result=[];
  for(const file of remaining.values()) {
    const stat=await fs.lstat(file);
    if(stat.isFile()&&!stat.isSymbolicLink())result.push({path:file,relative:path.relative(root,file).replaceAll('\\','/'),
      size:stat.size,mtime:stat.mtimeMs,preview:'note-image://local/'+encodeURIComponent(file)});
  }
  return result.sort((a,b)=>b.size-a.size);
}

async function portableMarkdown({note,text,root,readImage}) {
  const refs=markdownImages(text);
  const entries=new Map(), replacements=new Map(), handles=new Map();
  let size=Buffer.byteLength(text);
  let vaultPictures;
  for(const ref of refs) {
    const candidates=referenceCandidates(ref.destination,note,root,ref.wiki);
    if(ref.wiki&&root&&within(root,note)&&!/[\\/]/.test(ref.destination)) {
      vaultPictures??=(await catalog(root)).pictures;
      const matches=vaultPictures.filter(file=>key(path.basename(file))===key(ref.destination));
      if(matches.length===1)candidates.push(matches[0]);
    }
    let name;
    for(const file of candidates) {
      name=handles.get(key(file));
      if(name)break;
      const image=await readImage(file).catch(()=>null);
      if(!image)continue;
      size+=image.bytes.length;
      if(size>96*1024*1024)throw Error(tr("attachmentService.theBundleExceeds96MibExportIt"));
      name='assets/'+String(entries.size+1).padStart(3,'0')+'-'+path.basename(file).replace(/[<>:"|?*\x00-\x1f]/g,'_');
      handles.set(key(file),name);entries.set(name,image.bytes);break;
    }
    if(name)replacements.set(ref.raw,'!['+String(ref.alt||'').replace(/[\[\]\\]/g,'\\$&')+']('+name.split('/').map(encodeURIComponent).join('/')+')');
  }
  return {entries,text:rewriteImages(text,replacements)};
}

module.exports={orphanPictures,portableMarkdown,imageExtension};
