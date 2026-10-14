// Internationalisation: all user-facing texts come from language files in src/i18n/<lang>.json
// (e.g. de_de.json). Keys are nested objects, addressed with dots: t('sceneGraph.title').
//
// - Interpolation: "{count} parts" + t(key, { count: 3 })
// - Plurals: a value may be an object { one, other } (optionally zero/two/few/many); the form is
//   chosen via Intl.PluralRules from params.count.
// - Fallback chain: current language -> de_de (reference language) -> the key itself (and a
//   console warning in ?debug, so missing keys are easy to spot).
// - Language choice: ?lang=<code> > stored choice (localStorage) > browser language > de_de.
// - Static markup: elements with data-i18n="key" get their textContent, data-i18n-title="key" their
//   title attribute, data-i18n-placeholder their placeholder (applyDom()). data-i18n-html="key" allows
//   simple formatting in the value (<strong>, <b>, <em>, <i>, <br>) – everything else stays text
//   (formatHtml), so language files can never inject markup.
//
// Workers (STEP kernel) do not use this module: their messages are technical (English) and only
// end up in the console or as details behind a translated message.

const FILES = import.meta.glob('../i18n/*.json', { eager: true, import: 'default' });
const DICTS = Object.fromEntries(Object.entries(FILES).map(([path, dict]) => [path.match(/([\w-]+)\.json$/)[1], dict]));

export const DEFAULT_LANGUAGE = 'de_de';
const STORAGE_KEY = 'rindr.lang';
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

/** Available languages: [{ code, name }] (name = the language's own "language.name" entry) */
export const LANGUAGES = Object.keys(DICTS).sort().map(code => ({ code, name: DICTS[code]?.language?.name || code }));

// language code de_de -> BCP 47 locale de-DE (number/date formatting, plural rules)
const toLocale = code => code.replace('_', '-').replace(/-(\w+)$/, (_, r) => '-' + r.toUpperCase());

function pickLanguage() {
    const candidates = [];
    try { candidates.push(new URLSearchParams(location.search).get('lang')); } catch { /* no location */ }
    try { candidates.push(localStorage.getItem(STORAGE_KEY)); } catch { /* storage blocked */ }
    try { candidates.push(...(navigator.languages || [navigator.language])); } catch { /* no navigator */ }
    for (const c of candidates) {
        if (!c) continue;
        const code = c.toLowerCase().replace('-', '_');
        if (DICTS[code]) return code;
        const prefix = Object.keys(DICTS).find(k => k.startsWith(code.split('_')[0] + '_'));
        if (prefix) return prefix;
    }
    return DEFAULT_LANGUAGE;
}

let language = pickLanguage();
let pluralRules = new Intl.PluralRules(toLocale(language));

/** Current language code (e.g. de_de) */
export const getLanguage = () => language;
/** BCP 47 locale of the current language (e.g. de-DE) for toLocaleString & co. */
export const getLocale = () => toLocale(language);

/** Switch language (stored for the next visit); returns false for unknown codes */
export function setLanguage(code) {
    if (!DICTS[code]) return false;
    language = code;
    pluralRules = new Intl.PluralRules(toLocale(code));
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* storage blocked */ }
    applyDom();
    return true;
}

const lookup = (dict, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);
const warned = new Set();

/**
 * Translate a key.
 * @param {string} key  dotted path, e.g. 'properties.position'
 * @param {object} [params]  values for {placeholders}; params.count selects the plural form
 */
export function t(key, params) {
    let value = lookup(DICTS[language], key);
    if (value === undefined && language !== DEFAULT_LANGUAGE) value = lookup(DICTS[DEFAULT_LANGUAGE], key);
    if (value === undefined) {
        if (DEBUG && !warned.has(key)) { warned.add(key); console.warn('[i18n] missing key:', key); }
        return key;
    }
    if (value && typeof value === 'object') {
        const form = params && typeof params.count === 'number' ? pluralRules.select(params.count) : 'other';
        value = value[form] ?? value.other ?? key;
    }
    if (!params || typeof value !== 'string') return value;
    return value.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
}

/** Does a key exist (in the current or the reference language)? */
export const has = key => lookup(DICTS[language], key) !== undefined || lookup(DICTS[DEFAULT_LANGUAGE], key) !== undefined;

const ALLOWED_TAGS = /^<\/?(strong|b|em|i)>$|^<br\s*\/?>$/i;
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Value as HTML with only simple formatting allowed: <strong> <b> <em> <i> (without attributes) and <br>;
 * any other tag or text is escaped. Same function at build time (index.astro) and at runtime.
 */
export function formatHtml(value) {
    return String(value).split(/(<[^>]*>)/).map(part => (ALLOWED_TAGS.test(part) ? part.toLowerCase() : escapeHtml(part))).join('');
}

/** Translate static markup: data-i18n / data-i18n-html / data-i18n-title / data-i18n-placeholder */
export function applyDom(root = typeof document !== 'undefined' ? document : null) {
    if (!root) return;
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = formatHtml(t(el.dataset.i18nHtml));
    for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    if (typeof document !== 'undefined') document.documentElement.lang = getLocale();
}
