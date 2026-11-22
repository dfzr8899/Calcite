import { markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, MatchDecorator, ViewPlugin } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const chrome = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--editor-bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    color: 'var(--muted)',
    backgroundColor: 'var(--editor-bg)',
    borderRight: '1px solid var(--separator)'
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-soft)' },
  '.cm-activeLineGutter': { color: 'var(--heading)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--selection)'
  },
  '.cm-selectionMatch, .cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--yellow) 35%, var(--editor-bg))',
    outline: 'none'
  },
  '.cm-searchMatch.cm-searchMatch-selected': { color: 'var(--on-accent)', backgroundColor: 'var(--yellow)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--selection)', outline: '1px solid var(--accent)' },
  '.cm-nonmatchingBracket': { outline: '1px solid var(--pink)' },
  '.cm-panels, .cm-tooltip': { color: 'var(--text)', backgroundColor: 'var(--sidebar-bg)', borderColor: 'var(--border)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { color: 'var(--heading)', backgroundColor: 'var(--row-bg)' },
  '.cm-textfield, .cm-button, .cm-foldPlaceholder': {
    color: 'var(--text)', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)'
  },
  '.cm-button:hover': { background: 'var(--row-bg)' },
  '.cm-textfield:focus-visible, .cm-button:focus-visible': { outline: '1px solid var(--accent)', outlineOffset: '-1px' }
});

const syntax = HighlightStyle.define([
  { tag: [tags.comment, tags.quote], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.tagName, tags.deleted, tags.monospace], color: 'var(--pink)' },
  { tag: [tags.string, tags.regexp], color: 'var(--yellow)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.inserted], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.variableName)], color: 'var(--purple)' },
  { tag: [tags.typeName, tags.className, tags.attributeName, tags.url, tags.link], color: 'var(--link)' },
  { tag: [tags.heading, tags.strong], color: 'var(--heading)', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.invalid, color: 'var(--pink)', textDecoration: 'underline' }
]);

export const oneMonokai = [chrome, syntaxHighlighting(syntax)];

const markerClass = 'cm-markdown-marker';
const wikiBracket = Decoration.mark({class:markerClass});
const wikiBrackets = new MatchDecorator({
  regexp: /(?<!\\)\[\[[^\]\r\n]+\]\]/g,
  decorate(add,from,to,_match,view) {
    for (let node = syntaxTree(view.state).resolveInner(from+1,1); node; node = node.parent) {
      if (['InlineCode','FencedCode','CodeBlock','HTMLBlock','CommentBlock'].includes(node.name)) return;
    }
    add(from,from+2,wikiBracket);
    add(to-2,to,wikiBracket);
  }
});

export const sourceMarkers = [
  syntaxHighlighting(HighlightStyle.define([
    {tag:tags.processingInstruction,class:markerClass}
  ],{scope:markdownLanguage})),
  ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = wikiBrackets.createDeco(view); }
    update(update) {
      this.decorations = syntaxTree(update.startState)!==syntaxTree(update.state)
        ? wikiBrackets.createDeco(update.view) : wikiBrackets.updateDeco(update,this.decorations);
    }
  },{decorations:plugin=>plugin.decorations})
];
