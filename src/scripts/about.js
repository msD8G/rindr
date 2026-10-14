// "About" page of the settings menu: name, description, author, version, a little credit line and the
// open-source projects RINDR is built on (with link and licence). Author data: ABOUT in config.js,
// version from package.json. Purpose texts come from the language files (about.libs.<id>).
import { version } from '../../package.json';
import { ABOUT } from './config.js';
import { t } from './i18n.js';
import logoUrl from '../assets/rindr.svg?url';

// runtime: shipped to the browser (npm packages and libraries bundled by three.js / in public/)
const RUNTIME = [
    { id: 'three', name: 'three.js', license: 'MIT', url: 'https://threejs.org' },
    { id: 'pathtracer', name: 'three-gpu-pathtracer', license: 'MIT', url: 'https://github.com/gkjohnson/three-gpu-pathtracer' },
    { id: 'bvh', name: 'three-mesh-bvh', license: 'MIT', url: 'https://github.com/gkjohnson/three-mesh-bvh' },
    { id: 'oidn', name: 'Intel Open Image Denoise', license: 'Apache-2.0', url: 'https://github.com/RenderKit/oidn' },
    { id: 'oidnWeb', name: 'oidn-web', license: 'MIT', url: 'https://github.com/pissang/oidn-web' },
    { id: 'upscaler', name: '@pmndrs/upscaler', license: 'MIT', url: 'https://github.com/pmndrs/upscaler' },
    { id: 'earcut', name: 'earcut', license: 'ISC', url: 'https://github.com/mapbox/earcut' },
    { id: 'cdt2d', name: 'cdt2d', license: 'MIT', url: 'https://github.com/mikolalysenko/cdt2d' },
    { id: 'polygonClipping', name: 'polygon-clipping', license: 'MIT', url: 'https://github.com/mfogel/polygon-clipping' },
    { id: 'robustPredicates', name: 'robust-predicates', license: 'Unlicense', url: 'https://github.com/mourner/robust-predicates' },
    { id: 'robustGeometry', name: 'robust-orientation, robust-in-sphere, binary-search-bounds', license: 'MIT', url: 'https://github.com/mikolalysenko' },
    { id: 'splaytree', name: 'splaytree', license: 'MIT', url: 'https://github.com/w8r/splay-tree' },
    { id: 'float16', name: '@petamoriken/float16', license: 'MIT', url: 'https://github.com/petamoriken/float16' },
    { id: 'draco', name: 'Draco', license: 'Apache-2.0', url: 'https://github.com/google/draco' },
    { id: 'basis', name: 'Basis Universal', license: 'Apache-2.0', url: 'https://github.com/BinomialLLC/basis_universal' },
    { id: 'ktxParse', name: 'ktx-parse, zstddec', license: 'MIT', url: 'https://github.com/donmccurdy/KTX-Parse' },
    { id: 'meshopt', name: 'meshoptimizer', license: 'MIT', url: 'https://github.com/zeux/meshoptimizer' },
    { id: 'fflate', name: 'fflate', license: 'MIT', url: 'https://github.com/101arrowz/fflate' },
    { id: 'webIfc', name: 'web-ifc', license: 'MPL-2.0', url: 'https://github.com/ThatOpen/engine_web-ifc' },
];
// assets: HDRI environment maps (public/hdr)
const ASSETS = [
    { id: 'openHdri', name: 'Open HDRI', license: 'CC0', url: 'https://openhdri.org/' },
];
// build tools
const BUILD = [
    { id: 'astro', name: 'Astro', license: 'MIT', url: 'https://astro.build' },
    { id: 'vite', name: 'Vite', license: 'MIT', url: 'https://vite.dev' },
    { id: 'tailwind', name: 'Tailwind CSS', license: 'MIT', url: 'https://tailwindcss.com' },
];

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
    root.append(facts, el('div', 'text-white/60', t('about.madeWith')));

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
