// Asset window (like the links panel in InDesign): which external files the scene uses and whether they
// are there – models, HDRI, missing textures of imported models. Missing ones can be relinked: per row
// via a file dialog, or by dropping files/folders anywhere while it is open (matched by file name).
// Same style as the other panels; opened via the toolbar or automatically when a scene with missing files
// is opened.
import { t } from './i18n.js';

const ICON_CLOSE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const KIND_ICON = {
    model: '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4"><path d="M8 1l6 3.5v7L8 15l-6-3.5v-7z M8 8v7 M8 8l6-3.5 M8 8L2 4.5"/></svg>',
    hdri: '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-3 3-3 9 0 12M8 2c3 3 3 9 0 12"/></svg>',
    file: '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4"><path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13"/></svg>',
    texture: '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 11l3.5-3.5 3 3 2-2L14 12"/><circle cx="10.5" cy="5.5" r="1"/></svg>',
};
const BUTTON = 'rounded px-2 py-0.5 text-white/80 outline-none transition-colors hover:bg-white/15 hover:text-white';

/**
 * @param {{ rows(): {kind: 'model'|'hdri'|'texture'|'file', name: string, status: 'ok'|'missing', detail?: string}[],
 *           onFiles(files: {path: string, file: File}[]): void }} handlers
 */
export function createAssetsWindow({ rows, onFiles }) {
    const root = document.createElement('div');
    root.className = 'pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-4 text-xs text-white/90';
    root.hidden = true;
    const panel = document.createElement('div');
    panel.className = 'pointer-events-auto flex max-h-[70dvh] w-[min(34rem,100%)] flex-col overflow-hidden rounded-lg bg-black/60 shadow-2xl backdrop-blur-sm transition-colors';
    const head = document.createElement('div');
    head.className = 'flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2';
    const title = document.createElement('span');
    title.className = 'flex-1 font-medium';
    title.textContent = t('assets.title');
    const count = document.createElement('span');
    count.className = 'text-white/50';
    const close = document.createElement('button');
    close.className = 'text-white/50 hover:text-white';
    close.innerHTML = ICON_CLOSE;
    close.title = t('setup.close');
    close.onclick = () => hide();
    head.append(title, count, close);
    const list = document.createElement('div');
    list.className = 'min-h-0 flex-1 overflow-auto p-2';
    const foot = document.createElement('div');
    foot.className = 'flex shrink-0 items-center gap-2 border-t border-white/10 px-3 py-2 text-white/50';
    const hint = document.createElement('span');
    hint.className = 'flex-1';
    hint.textContent = t('assets.dropHint');
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true });
    const folderInput = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
    const pick = document.createElement('button');
    pick.className = BUTTON;
    pick.textContent = t('assets.pickFiles');
    pick.onclick = () => input.click();
    const pickFolder = document.createElement('button');
    pickFolder.className = BUTTON;
    pickFolder.textContent = t('assets.pickFolder');
    pickFolder.onclick = () => folderInput.click();
    const take = inp => () => {
        const files = [...inp.files].map(file => ({ path: file.webkitRelativePath || file.name, file }));
        inp.value = '';
        if (files.length) onFiles(files);
    };
    input.onchange = take(input);
    folderInput.onchange = take(folderInput);
    foot.append(hint, pick, pickFolder, input, folderInput);
    panel.append(head, list, foot);
    root.append(panel);
    document.body.append(root);

    // dropping files: the viewer's global drop handler relinks while the window is open (anywhere in the
    // window, the replace/add plane is not shown then)
    const highlight = on => panel.classList.toggle('bg-sky-900/70', on);
    // a file drag anywhere in the window while open (the viewer then shows no drop plane): highlight as target
    const setDragActive = on => { if (!root.hidden || !on) highlight(on); };

    function render() {
        const items = rows();
        const missing = items.filter(r => r.status === 'missing').length;
        count.textContent = missing ? t('assets.missingCount', { count: missing }) : t('assets.allFound');
        count.className = missing ? 'text-amber-300' : 'text-white/50';
        list.replaceChildren(...(items.length ? items.map(row) : [Object.assign(document.createElement('div'), { className: 'p-2 text-white/50', textContent: t('assets.empty') })]));
    }
    function row(r) {
        const el = document.createElement('div');
        el.className = 'flex items-center gap-2 rounded px-2 py-1 hover:bg-white/5';
        const icon = document.createElement('span');
        icon.className = 'shrink-0 text-white/60';
        icon.innerHTML = KIND_ICON[r.kind] || KIND_ICON.model;
        const name = document.createElement('div');
        name.className = 'min-w-0 flex-1';
        const n = document.createElement('div');
        n.className = 'truncate' + (r.status === 'missing' ? ' text-amber-200' : '');
        n.textContent = r.name;
        n.title = r.name;
        name.append(n);
        if (r.detail) {
            const d = document.createElement('div');
            d.className = 'truncate text-white/40';
            d.textContent = r.detail;
            name.append(d);
        }
        const status = document.createElement('span');
        status.className = 'shrink-0 rounded px-1.5 py-0.5 ' + (r.status === 'missing' ? 'bg-amber-500/25 text-amber-200' : 'bg-emerald-500/20 text-emerald-200');
        status.textContent = r.status === 'missing' ? t('assets.missing') : t('assets.found');
        el.append(icon, name, status);
        if (r.status === 'missing') {
            const relink = document.createElement('button');
            relink.className = BUTTON + ' shrink-0';
            relink.textContent = t('assets.relink');
            relink.title = t('assets.relinkTitle', { name: r.name });
            relink.onclick = () => input.click();
            el.append(relink);
        }
        return el;
    }
    function show() { render(); root.hidden = false; }
    function hide() { root.hidden = true; }
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) { e.stopPropagation(); hide(); } }, true);
    return {
        show, hide, render, setDragActive,
        get isOpen() { return !root.hidden; },
        refresh() { if (!root.hidden) render(); },
    };
}
