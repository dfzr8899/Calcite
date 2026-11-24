import {getLocale, languagePreference, resolveLocale, setLocale, setStrictMessages, t} from '../shared/i18n/index.mjs';

const storageKey = 'calcite.language';
const settings = new URLSearchParams(location.search);
let selection = languagePreference(settings.get('language') ?? localStorage.getItem(storageKey));
const systemLanguage = () => settings.get('systemLanguage') || navigator.language;
const listeners = new Set();

setStrictMessages(import.meta.env.DEV || settings.get('languageTest') === '1');
setLocale(resolveLocale(selection, systemLanguage()));
document.documentElement.lang = getLocale();

function refresh() {
  const locale = resolveLocale(selection, systemLanguage());
  if (getLocale() === locale) return;
  setLocale(locale);
  document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

window.addEventListener('languagechange', refresh);

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function chooseLanguage(value, save) {
  const next = languagePreference(value);
  await save?.(next);
  selection = next;
  localStorage.setItem(storageKey, next);
  refresh();
}

export function languagePicker(save) {
  const label = document.createElement('label');
  label.className = 'language-picker';
  const prompt = document.createElement('span');
  prompt.textContent = t('language.label');
  const select = document.createElement('select');
  select.name = 'language';
  for (const option of ['auto', 'zh-CN', 'en-US']) {
    const node = new Option(t('language.' + option), option);
    if (option !== 'auto') node.lang = option;
    select.add(node);
  }
  select.value = selection;
  select.addEventListener('change', async () => {
    select.disabled = true;
    try { await chooseLanguage(select.value, save); }
    catch (error) {
      select.value = selection;
      label.dispatchEvent(new CustomEvent('language-error', {detail:error,bubbles:true}));
    } finally { select.disabled = false; }
  });
  label.append(prompt, select);
  return label;
}

const translatedAttributes = ['aria-label', 'alt', 'placeholder', 'title'];

// Bind only labels from the UI template. The live workspace, its inputs, and
// note content are never walked or replaced during a language change.
export function mountLocalizedMarkup(container, render) {
  const current = getLocale();
  const other = current === 'zh-CN' ? 'en-US' : 'zh-CN';
  const alternate = document.createElement('template');
  try {
    setLocale(other);
    alternate.innerHTML = render();
  } finally {
    setLocale(current);
  }
  container.innerHTML = render();
  const update = [];
  function bind(read, write, original, translated) {
    if (original === translated || translated === null) return;
    let displayed = original;
    update.push(() => {
      if (read() !== displayed) return;
      displayed = getLocale() === current ? original : translated;
      write(displayed);
    });
  }
  function visit(node, template) {
    if (!template || node.nodeType !== template.nodeType) return;
    if (node.nodeType === Node.TEXT_NODE) {
      bind(() => node.data, value => {node.data = value;}, node.data, template.data);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === template.tagName) {
      for (const attribute of translatedAttributes) {
        const original = node.getAttribute(attribute);
        if (original !== null) bind(() => node.getAttribute(attribute), value => node.setAttribute(attribute, value),
          original, template.getAttribute(attribute));
      }
      Array.from(node.childNodes).forEach((child, index) => visit(child, template.childNodes[index]));
    }
  }
  Array.from(container.childNodes).forEach((child, index) => visit(child, alternate.content.childNodes[index]));
  return onLocaleChange(() => update.forEach(apply => apply()));
}
