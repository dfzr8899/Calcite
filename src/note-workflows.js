import {t as tr} from "../shared/i18n/index.mjs";
import { load, JSON_SCHEMA } from 'js-yaml';
import { properties, splitFrontmatter, writeProperties } from './note-metadata.js';
import {settingToggle} from './mobile-ui.js';
import {dailyNoteName,expandNoteTemplate} from '../shared/pkm-workflows.mjs';

export function createNoteWorkflows({platform,ask,escape,getRoot,files,relative,read,active,applyText,insert,open,refresh,updateNote,settings,toast}) {
  const options = rows => rows.map(row=>'<option value="'+escape(row.path)+'">'+escape(relative(row.path))+'</option>').join('');
  const requireRoot = () => {
    const root = getRoot();
    if (!root) throw Error(tr("noteWorkflows.openAWorkspaceFolderFirst"));
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
    if (!tab) throw Error(tr("noteWorkflows.openANoteFirst"));
    const available = templateFiles();
    if (!available.length) throw Error(tr("noteWorkflows.noMarkdownTemplatesFoundCheckYourTemplate"));
    const form=await ask(tr("main.insertTemplate"),`<label>${tr("noteWorkflows.markdownTemplate")}<select name="path" required>`+options(available)+'</select></label>',tr("main.insert"));
    if (!form || active()!==tab) return;
    const template=splitFrontmatter(expandTemplate(await read(form.get('path')),tab.name.replace(/\.[^.]+$/,''),new Date()));
    if (active()!==tab) return;
    let current=splitFrontmatter(tab.text);
    const templateData=properties(template.yaml);
    const currentData=properties(current.yaml);
    if (!templateData || !currentData) throw Error(tr("noteWorkflows.fixInvalidYamlInTheTemplateOr"));
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
    if (getRoot()!==root) throw Error(tr("noteWorkflows.theWorkspaceChangedReopenTheDailyNote"));
    const result=await platform.workspace.edit({type:'note',parent:folderPath,name,text,openExisting:true,createParents:true});
    await refresh(result.tree,result.path.replace(/[\\/][^\\/]+$/,''));
    await open(result.path);
  }
  async function random() {
    requireRoot();
    const candidates=files().filter(row=>/\.(?:md|markdown|mdown)$/i.test(row.path));
    const alternatives=candidates.filter(row=>row.path!==active()?.path);
    const pool=alternatives.length?alternatives:candidates;
    if(!pool.length)return toast(tr("noteWorkflows.thereAreNoNotesToOpenIn"));
    return open(pool[Math.floor(Math.random()*pool.length)].path);
  }
  const types=()=>[['text',tr("editorTools.text")],['number',tr("noteWorkflows.number")],['boolean',tr("noteWorkflows.checkbox")],['list',tr("noteWorkflows.listOneItemPerLine")],['date',tr("noteWorkflows.date")],['yaml',tr("noteWorkflows.yamlValue")]];
  async function editProperty(path,initialKey) {
    const initialTab=path ? null : active();
    if (!path && !initialTab) throw Error(tr("noteWorkflows.openANoteFirst2"));
    const text=path ? await read(path) : initialTab.text;
    const {yaml}=splitFrontmatter(text);
    const data=properties(yaml);
    if (!data) throw Error(tr("noteMetadata.fixTheInvalidYamlPropertiesInSource"));
    const key=initialKey||'';
    const original=data[key];
    const type=typeof original==='number'?'number':typeof original==='boolean'?'boolean':
      Array.isArray(original)&&original.every(item=>typeof item==='string')?'list':
      original===undefined||typeof original==='string'?'text':'yaml';
    const value=type==='list'?original.join('\n'):type==='yaml'?JSON.stringify(original,null,2):String(original??'');
    const form=await ask(tr("main.editNoteProperties"),
      `<label>${tr("noteWorkflows.propertyName")}<input name="key" list="property-names" required value="`+escape(key)+'" autofocus></label>'+
      '<datalist id="property-names">'+Object.keys(data).map(item=>'<option value="'+escape(item)+'">').join('')+'</datalist>'+
      `<label>${tr("noteWorkflows.type")}<select name="type">`+types().map(([item,label])=>'<option value="'+item+'" '+(type===item?'selected':'')+'>'+label+'</option>').join('')+'</select></label>'+
      `<label>${tr("noteWorkflows.propertyValue")}<textarea name="value" rows="4">`+escape(value)+'</textarea></label>'+
      settingToggle('remove',tr("noteWorkflows.deleteThisProperty")),tr("noteWorkflows.saveProperty"));
    if (!form) return;
    const target=String(form.get('key')).trim();
    if (!target) throw Error(tr("noteWorkflows.enterAPropertyName"));
    const raw=String(form.get('value'));
    const selected=form.get('type');
    if (form.has('remove')) delete data[target];
    else {
      let result=raw;
      if (selected==='number') {
        result=Number(raw);
        if (!raw.trim() || !Number.isFinite(result)) throw Error(tr("noteWorkflows.enterAValidNumber"));
      } else if (selected==='boolean') {
        if (!/^(true|false)$/i.test(raw.trim())) throw Error(tr("noteWorkflows.enterTrueOrFalseForACheckbox"));
        result=raw.trim().toLowerCase()==='true';
      } else if (selected==='list') result=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      else if (selected==='date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)||new Date(raw+'T00:00:00Z').toJSON()?.slice(0,10)!==raw) throw Error(tr("noteWorkflows.useYyyyMmDdForDates"));
      } else if (selected==='yaml') result=load(raw,{schema:JSON_SCHEMA})??null;
      Object.defineProperty(data,target,{value:result,writable:true,enumerable:true,configurable:true});
    }
    const next=writeProperties(text,data);
    if (path) await updateNote(path,text,next);
    else {
      if (active()!==initialTab || initialTab.text!==text) throw Error(tr("noteWorkflows.theNoteChangedEditThePropertyAgain"));
      applyText(next);
    }
    toast(tr("noteWorkflows.notePropertiesUpdated"));
  }
  return { insertTemplate, daily, random, editProperty };
}
