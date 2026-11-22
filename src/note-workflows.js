import { load, JSON_SCHEMA } from 'js-yaml';
import { properties, splitFrontmatter, writeProperties } from './note-metadata.js';
import {settingToggle} from './mobile-ui.js';
import {dailyNoteName,expandNoteTemplate} from '../shared/pkm-workflows.mjs';

export function createNoteWorkflows({platform,ask,escape,getRoot,files,relative,read,active,applyText,insert,open,refresh,updateNote,settings,toast}) {
  const options = rows => rows.map(row=>'<option value="'+escape(row.path)+'">'+escape(relative(row.path))+'</option>').join('');
  const requireRoot = () => {
    const root = getRoot();
    if (!root) throw Error('请先打开工作区文件夹。');
    return root;
  };
  function expandTemplate(text,title,date) {
    return expandNoteTemplate(text,{title,date,vault:getRoot().split(/[\\/]/).filter(Boolean).at(-1)||''});
  }
  function templateFiles() {
    const folder = String(settings().templateDirectory || '').trim().replaceAll('\\','/').replace(/^\/|\/$/g,'');
    return folder ? files().filter(row=>relative(row.path).startsWith(folder+'/')) : files();
  }
  async function insertTemplate() {
    requireRoot();
    const tab = active();
    if (!tab) throw Error('请先打开一篇笔记。');
    const available = templateFiles();
    if (!available.length) throw Error('找不到 Markdown 模板，请检查模板目录。');
    const form=await ask('插入模板','<label>Markdown 模板<select name="path" required>'+options(available)+'</select></label>','插入');
    if (!form || active()!==tab) return;
    const template=splitFrontmatter(expandTemplate(await read(form.get('path')),tab.name.replace(/\.[^.]+$/,''),new Date()));
    if (active()!==tab) return;
    let current=splitFrontmatter(tab.text);
    const templateData=properties(template.yaml);
    const currentData=properties(current.yaml);
    if (!templateData || !currentData) throw Error('请先修复模板或当前笔记中无效的 YAML。');
    if (template.body.trim()) insert(template.body);
    current=splitFrontmatter(tab.text);
    if (Object.keys(templateData).some(key=>!Object.hasOwn(currentData,key))) {
      applyText(writeProperties(current.prefix+current.body,{...templateData,...currentData}));
    }
  }
  async function daily() {
    const root=requireRoot();
    const date=new Date();
    const name=dailyNoteName(settings().dailyFilePattern,date);
    const folder=String(settings().dailyDirectory||'Daily').trim().replaceAll('\\','/');
    const folderPath=root.replaceAll('\\','/').replace(/\/$/,'')+'/'+folder;
    const template=templateFiles().find(row=>relative(row.path)===settings().dailyTemplate);
    const text=template?expandTemplate(await read(template.path),name,date):'# '+name+'\n\n';
    if (getRoot()!==root) throw Error('工作区已切换，请重新打开每日笔记。');
    const result=await platform.workspace.edit({type:'note',parent:folderPath,name,text,openExisting:true,createParents:true});
    await refresh(result.tree,result.path.replace(/[\\/][^\\/]+$/,''));
    await open(result.path);
  }
  async function random() {
    requireRoot();
    const candidates=files().filter(row=>/\.(?:md|markdown|mdown)$/i.test(row.path));
    const alternatives=candidates.filter(row=>row.path!==active()?.path);
    const pool=alternatives.length?alternatives:candidates;
    if(!pool.length)return toast('当前知识库没有可打开的笔记。');
    return open(pool[Math.floor(Math.random()*pool.length)].path);
  }
  const types=[['text','文本'],['number','数字'],['boolean','复选框'],['list','列表（每行一项）'],['date','日期'],['yaml','YAML 值']];
  async function editProperty(path,initialKey) {
    const initialTab=path ? null : active();
    if (!path && !initialTab) throw Error('请先打开笔记。');
    const text=path ? await read(path) : initialTab.text;
    const {yaml}=splitFrontmatter(text);
    const data=properties(yaml);
    if (!data) throw Error('请先在源码中修复无效的 YAML 属性。');
    const key=initialKey||'';
    const original=data[key];
    const type=typeof original==='number'?'number':typeof original==='boolean'?'boolean':
      Array.isArray(original)&&original.every(item=>typeof item==='string')?'list':
      original===undefined||typeof original==='string'?'text':'yaml';
    const value=type==='list'?original.join('\n'):type==='yaml'?JSON.stringify(original,null,2):String(original??'');
    const form=await ask('编辑笔记属性',
      '<label>属性名称<input name="key" list="property-names" required value="'+escape(key)+'" autofocus></label>'+
      '<datalist id="property-names">'+Object.keys(data).map(item=>'<option value="'+escape(item)+'">').join('')+'</datalist>'+
      '<label>类型<select name="type">'+types.map(([item,label])=>'<option value="'+item+'" '+(type===item?'selected':'')+'>'+label+'</option>').join('')+'</select></label>'+
      '<label>属性值<textarea name="value" rows="4">'+escape(value)+'</textarea></label>'+
      settingToggle('remove','删除该属性'),'保存属性');
    if (!form) return;
    const target=String(form.get('key')).trim();
    if (!target) throw Error('请输入属性名称。');
    const raw=String(form.get('value'));
    const selected=form.get('type');
    if (form.has('remove')) delete data[target];
    else {
      let result=raw;
      if (selected==='number') {
        result=Number(raw);
        if (!raw.trim() || !Number.isFinite(result)) throw Error('请输入有效数字。');
      } else if (selected==='boolean') {
        if (!/^(true|false)$/i.test(raw.trim())) throw Error('复选框属性请输入 true 或 false。');
        result=raw.trim().toLowerCase()==='true';
      } else if (selected==='list') result=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      else if (selected==='date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)||new Date(raw+'T00:00:00Z').toJSON()?.slice(0,10)!==raw) throw Error('日期请使用 YYYY-MM-DD。');
      } else if (selected==='yaml') result=load(raw,{schema:JSON_SCHEMA})??null;
      Object.defineProperty(data,target,{value:result,writable:true,enumerable:true,configurable:true});
    }
    const next=writeProperties(text,data);
    if (path) await updateNote(path,text,next);
    else {
      if (active()!==initialTab || initialTab.text!==text) throw Error('文档已变化，请重新编辑属性。');
      applyText(next);
    }
    toast('已更新笔记属性');
  }
  return { insertTemplate, daily, random, editProperty };
}
