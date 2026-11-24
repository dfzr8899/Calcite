import {EditorState} from '@codemirror/state';
import {t} from '../shared/i18n/index.mjs';

const sourcePhrases = {
  'Go to line':'line', go:'go', 'replaced match on line $':'replacedLine', 'replaced $ matches':'replacedCount',
  Find:'find', Replace:'replaceField', next:'next', previous:'previous', all:'all', 'match case':'case',
  regexp:'regex', 'by word':'word', replace:'replace', 'replace all':'replaceAll', close:'close',
  'current match':'match', 'on line':'onLine', 'Control character':'control'
};

export function editorPhrases() {
  return EditorState.phrases.of(Object.fromEntries(
    Object.entries(sourcePhrases).map(([phrase,key])=>[phrase,t('editor.'+key)])
  ));
}

function label(key, params) {
  return {get label(){return t(key,params);}};
}

export const blockLabels = {
  textGroup:{
    get label(){return t('editorTools.text');},
    text:label('editorTools.text'),
    h1:label('editor.heading',{level:1}),h2:label('editor.heading',{level:2}),h3:label('editor.heading',{level:3}),
    h4:label('editor.heading',{level:4}),h5:label('editor.heading',{level:5}),h6:label('editor.heading',{level:6}),
    quote:label('notes.quote'),divider:label('editor.divider')
  },
  listGroup:{
    get label(){return t('editor.list');},
    bulletList:label('editor.bullets'),orderedList:label('editor.numbered'),taskList:label('editor.tasks')
  },
  advancedGroup:{
    get label(){return t('editor.advanced');},
    image:label('editor.image'),codeBlock:label('main.codeBlock'),table:label('main.table'),math:label('main.math')
  }
};

export const toolbarLabels = {
  get boldLabel(){return t('main.bold');},
  get italicLabel(){return t('main.italic');},
  get codeLabel(){return t('main.inlineCode');},
  get linkLabel(){return t('editor.link');},
  get strikethroughLabel(){return t('main.strikethrough');},
  get latexLabel(){return t('main.inlineMath');}
};
