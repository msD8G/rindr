// "About" page of the settings menu: name, description, author, version, a little credit line and the
// open-source projects RINDR is built on (with link and licence – list in libraries.js, also used for
// README.md). Author data: ABOUT in config.js, version from package.json. Purpose texts come from the language
// files (about.libs.<id>).
import { version } from '../../package.json';
import { ABOUT } from './config.js';
import { t } from './i18n.js';
import logoUrl from '../assets/rindr.svg?url';
import { RUNTIME, ASSETS, BUILD } from './libraries.js';

const el = (tag, cls = '', text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};
const link = (href, text) => {
    const a = el('a', 'text-sky-400 hover:underline', text);
    a.href = href;
    if (!href.startsWith('mailto:')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
};

export function buildAbout() {
    const root = el('div', 'flex flex-col gap-3');

    const head = el('div');
    // logo next to the name, white like bottom left (filter #logo-white in index.astro)
    const title = el('div', 'flex items-center gap-2');
    const logo = el('img', 'size-7 shrink-0 [filter:url(#logo-white)_drop-shadow(0_1px_2px_rgb(0_0_0/0.45))]');
    logo.src = logoUrl;
    logo.alt = '';
    title.append(logo, el('div', 'text-base font-semibold text-white', 'RINDR'));
    head.append(title, el('div', 'text-white/60', t('about.description')));
    root.append(head);

    const facts = el('div', 'grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1');
    const fact = (label, value) => facts.append(el('span', 'text-white/50', label), typeof value === 'string' ? el('span', '', value) : value);
    fact(t('about.author'), ABOUT.author || '–');
    if (ABOUT.email) fact(t('about.email'), link(`mailto:${ABOUT.email}`, ABOUT.email));
    fact(t('about.version'), version);
    root.append(facts, el('div', 'text-white', t('about.madeWith')));

    const list = (title, items) => {
        const box = el('div', 'flex flex-col gap-1.5');
        box.append(el('div', 'mt-1 border-t border-white/10 pt-3 font-medium text-white/90', title));
        for (const item of items) {
            const row = el('div', 'flex items-baseline gap-2');
            const text = el('div', 'min-w-0 flex-1');
            text.append(link(item.url, item.name), el('div', 'text-white/50', t(`about.libs.${item.id}`)));
            row.append(text, el('span', 'shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60', item.license));
            box.append(row);
        }
        return box;
    };
    root.append(el('div', 'mt-1 border-t border-white/10 pt-3 text-white/70', t('about.openSource')));
    root.append(list(t('about.runtime'), RUNTIME), list(t('about.assets'), ASSETS), list(t('about.build'), BUILD));
    return root;
}
