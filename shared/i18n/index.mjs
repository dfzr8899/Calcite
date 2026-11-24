import zhCN from './zh-CN.mjs';
import enUS from './en-US.mjs';

/** @typedef {'zh-CN' | 'en-US'} Locale */
/** @typedef {Locale | 'auto'} LanguagePreference */
/** @typedef {Record<string, string | number | boolean | null | undefined>} MessageParams */

/** @type {Record<Locale, Record<string, string>>} */
const messages = { 'zh-CN': zhCN, 'en-US': enUS };
/** @type {Locale} */
let locale = 'zh-CN';
let strict = false;

/** @param {unknown} rawLang @returns {Locale} */
export function resolveSystemLocale(rawLang) {
  return typeof rawLang === 'string' && /^zh(?:[-_]|$)/i.test(rawLang.trim()) ? 'zh-CN' : 'en-US';
}

/** @param {unknown} value @returns {LanguagePreference} */
export function languagePreference(value) {
  return value === 'zh-CN' || value === 'en-US' ? value : 'auto';
}

/** @param {unknown} value @param {unknown} systemLanguage @returns {Locale} */
export function resolveLocale(value, systemLanguage) {
  const selected = languagePreference(value);
  return selected === 'auto' ? resolveSystemLocale(systemLanguage) : selected;
}

/** @param {Locale} value */
export function setLocale(value) {
  if (!Object.hasOwn(messages, value)) throw new RangeError('Unsupported locale: ' + value);
  locale = value;
}

export function getLocale() {
  return locale;
}

/** @param {boolean} enabled */
export function setStrictMessages(enabled) {
  strict = enabled;
}

/** @param {Locale} language @param {string} key @param {MessageParams} [params] */
export function translate(language, key, params = {}) {
  const dictionary = messages[language];
  const localized = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  if (localized === undefined && strict) throw new Error('Missing message ' + language + '/' + key);
  const fallback = Object.hasOwn(enUS, key) ? enUS[key] : enUS['common.messageUnavailable'];
  return (localized ?? fallback).replace(/\{\{([\w]+)\}\}/g, (placeholder, name) => {
    return Object.hasOwn(params, name) ? String(params[name] ?? '') : placeholder;
  });
}

/** @param {string} key @param {MessageParams} [params] */
export function t(key, params) {
  return translate(locale, key, params);
}

/** @param {string} key @param {MessageParams} [params] */
export function message(key, params) {
  return {key, params};
}

/** @typedef {ReturnType<typeof message>} LocalizedMessage */
/** @param {LocalizedMessage | string | undefined | null} value */
export function renderMessage(value) {
  return value && typeof value === 'object' ? t(value.key, value.params) : (value || '');
}

/** @type {Map<string, string>} */
const diagnosticKeys = new Map(
  Object.entries(zhCN).filter(([,value]) => !value.includes('{{')).map(([key,value]) => [value, key])
);
/** @type {Set<string>} */
const englishDiagnostics = new Set(Object.values(enUS));

/** @param {string} value */
export const knownDiagnostic = value => diagnosticKeys.has(value) || englishDiagnostics.has(value);

/** @param {string} value */
export function translateDiagnostic(value) {
  const key = diagnosticKeys.get(value);
  return key ? t(key) : value;
}
