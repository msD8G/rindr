// Material panel: scene materials + library, parameter editor, drag & drop, JSON.
//  - Scene: all used/created materials; materials of the current selection are marked
//  - Library: presets by category; double-click takes one over into the scene
//  - Every row is draggable (dataTransfer MATERIAL_MIME = { id } or { libraryId })
//  - Both lists as rows or tiles (toggle top right, remembered per browser)
//  - Previews: rendered spheres (material-thumbs.js, hooks.thumbs) with a spinner per material while its image is
//    made; reload button top right makes all anew (current environment); CSS sphere if rendering failed
import { messageDialog } from './dialog.js';
import { PARAMS, buildMaterial } from './material-manager.js';
import { thumbKey } from './material-thumbs.js';
import { MATERIALS } from './config.js';
import { MATERIAL_PRESETS, PRESET_CATEGORIES, presetName, presetCategoryLabel } from './material-presets.js';
import { t, has } from './i18n.js';
import { colorField } from './ui-controls.js';

export const MATERIAL_MIME = 'application/x-step-viewer-material';

// Display name of a texture map key (materials.maps.<key>, unknown keys as they are)
export const mapLabel = key => (has(`materials.maps.${key}`) ? t(`materials.maps.${key}`) : key);


const BTN = 'rounded px-2 py-0.5 text-white/80 hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent';
const TAB = 'rounded px-2 py-0.5';
const LIST = 'max-h-[30vh] min-h-0 overflow-auto px-1 pb-1 select-none';
const VIEW_KEY = 'rindr.materials.view';
const VIEW_ICONS = {
    list: '<svg viewBox="0 0 16 16" class="size-3.5 fill-current"><rect x="1" y="2.5" width="3" height="3" rx="1.5"/><rect x="6" y="3.25" width="9" height="1.5" rx=".75"/><rect x="1" y="6.5" width="3" height="3" rx="1.5"/><rect x="6" y="7.25" width="9" height="1.5" rx=".75"/><rect x="1" y="10.5" width="3" height="3" rx="1.5"/><rect x="6" y="11.25" width="9" height="1.5" rx=".75"/></svg>',
    grid: '<svg viewBox="0 0 16 16" class="size-3.5 fill-current"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>',
};
const ICON_RELOAD = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 8.6A5.2 5.2 0 1 1 11.6 4"/><path d="M12.4 1.6v3h-3"/></svg>';
const ICON_CHECKER = '<svg viewBox="0 0 16 16" class="size-3.5 fill-current"><path d="M2 2h4v4H2zM10 2h4v4h-4zM6 6h4v4H6zM2 10h4v4H2zM10 10h4v4h-4z"/><rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const INPUT = 'w-14 flex-none rounded bg-white/10 px-1.5 py-0.5 text-right tabular-nums text-white outline-none focus:bg-white/20';

export class MaterialPanel {
    /**
     * @param {HTMLElement} root
     * @param {import('./material-manager.js').MaterialManager} manager
     * @param {object} hooks  { getSelectionObject(), onAssignToSelection(id), onOpenNodeEditor(id), thumbs }
     */
    constructor(root, manager, hooks = {}) {
        this.root = root;
        this.manager = manager;
        this.hooks = hooks;
        this.tab = 'scene';
        this.current = null;        // material opened in the editor (ID)
        this.selectionIds = [];     // materials of the selection
        this.openGroups = new Set(['base']);
        this.thumbs = hooks.thumbs || null;   // MaterialThumbs
        this.lastThumb = new Map();           // material ID -> key of its last image (shown while the edited one renders)
        this.view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } })();

        root.innerHTML = `
            <div class="flex items-center justify-between gap-2 px-3 py-2">
                <span class="font-medium">${t('materials.panel.title')}</span>
                <span class="flex gap-1">
                    <button data-act="merge" class="${BTN}" title="${t('materials.panel.mergeTitle')}" hidden>${t('materials.panel.merge')}</button>
                    ${MATERIALS.importExport ? `<button data-act="import" class="${BTN}" title="${t('materials.panel.importTitle')}">${t('materials.panel.import')}</button>
                    <button data-act="export" class="${BTN}" title="${t('materials.panel.exportTitle')}">${t('materials.panel.export')}</button>` : ''}
                    ${hooks.thumbs ? `<span class="mr-2 flex gap-0.5 p-0.5">
                        <button data-act="checker" class="rounded p-1" title="${t('materials.panel.checker')}">${ICON_CHECKER}</button>
                        <button data-act="reload-thumbs" class="rounded p-1 text-white/60 hover:bg-white/15 hover:text-white" title="${t('materials.panel.reloadThumbs')}">${ICON_RELOAD}</button>
                    </span>` : ''}
                    <span class="flex rounded bg-white/10 p-0.5">
                        <button data-view="list" class="rounded p-1" title="${t('materials.panel.viewList')}">${VIEW_ICONS.list}</button>
                        <button data-view="grid" class="rounded p-1" title="${t('materials.panel.viewGrid')}">${VIEW_ICONS.grid}</button>
                    </span>
                </span>
            </div>
            <div class="flex gap-1 px-3 pb-1.5">
                <button data-tab="scene" class="${TAB}">${t('materials.panel.tabs.scene')}</button>
                <button data-tab="library" class="${TAB}">${t('materials.panel.tabs.library')}</button>
                ${MATERIALS.editing ? `<button data-act="new" class="${BTN} ml-auto" title="${t('materials.panel.newTitle')}">${t('materials.panel.new')}</button>` : ''}
            </div>
            <div data-list class="${LIST}"></div>
            <div data-editor class="border-t border-white/10 px-3 py-2" hidden></div>
            <input data-file type="file" accept="application/json,.json" hidden>
        `;
        this.list = root.querySelector('[data-list]');
        this.editor = root.querySelector('[data-editor]');
        this.file = root.querySelector('[data-file]');

        root.addEventListener('click', e => this._onClick(e));
        this.list.addEventListener('dblclick', e => {
            const row = e.target.closest('[data-library]');
            if (row) this.open(this.manager.fromLibrary(row.dataset.library).def.id, 'scene');
        });
        this.list.addEventListener('dragstart', e => {
            const row = e.target.closest('[data-drag]');
            if (!row) return;
            e.dataTransfer.setData(MATERIAL_MIME, row.dataset.drag);
            e.dataTransfer.effectAllowed = 'copy';
        });
        this.file.addEventListener('change', () => this._import());
        manager.addEventListener('change', () => this.render());
        manager.addEventListener('update', () => this.render({ keepEditor: true }));
        this.thumbs?.addEventListener('ready', e => this._onThumb(e.detail));
        this.thumbs?.addEventListener('reload', () => this.render({ keepEditor: true }));
        this.render();
    }

    /** Selection in the scene graph changed */
    setSelection(object) {
        this.selectionIds = object ? this.manager.materialsOf(object) : [];
        if (this.selectionIds.length && this.tab === 'scene') this.current = this.selectionIds[0];
        this.render();
    }

    /** After undo/redo: determine the selection's materials anew, the opened material stays */
    refresh(object) {
        this.selectionIds = object ? this.manager.materialsOf(object) : [];
        if (this.current && !this.manager.get(this.current)) this.current = null;
        this.render();
    }

    open(id, tab = this.tab) {
        this.current = id;
        this.tab = tab;
        this.render();
    }

    render({ keepEditor = false } = {}) {
        this.root.querySelectorAll('[data-tab]').forEach(b => {
            b.className = TAB + (b.dataset.tab === this.tab ? ' bg-sky-500/40 text-white' : ' text-white/70 hover:bg-white/15');
        });
        const checker = this.root.querySelector('[data-act="checker"]');
        if (checker) checker.className = 'rounded p-1' + (this.thumbs.checker ? ' bg-sky-500/40 text-white' : ' text-white/60 hover:bg-white/15 hover:text-white');
        this.root.querySelectorAll('[data-view]').forEach(b => {
            b.className = 'rounded p-1' + (b.dataset.view === this.view ? ' bg-sky-500/40 text-white' : ' text-white/60 hover:bg-white/15');
        });
        this.list.className = LIST + (this.view === 'grid' ? ' grid grid-cols-4 content-start gap-1' : '');
        if (this.tab === 'scene') this._renderScene(); else this._renderLibrary();
        if (!keepEditor || !this.editor.contains(document.activeElement)) this._renderEditor();
    }

    // --- Lists ---

    _renderScene() {
        const frag = document.createDocumentFragment();
        const entries = this.manager.list;
        if (!entries.length) frag.append(el('div', 'px-2 py-1 text-white/40', t('materials.panel.empty')));
        // materials of the selection first
        const sel = new Set(this.selectionIds);
        const counts = this.manager.usageCounts();
        entries.sort((a, b) => (sel.has(b.def.id) - sel.has(a.def.id)) || a.def.name.localeCompare(b.def.name));
        for (const entry of entries) {
            const { def } = entry;
            const row = this._row(def.name, def.params, JSON.stringify({ id: def.id }), this._sceneThumb(entry));
            row.dataset.id = def.id;
            if (def.id === this.current) row.classList.add('bg-sky-500/30');
            else row.classList.add('hover:bg-white/10');
            const usage = counts.get(def.id) || 0;
            if (this.view === 'grid') {
                // tile: selection as a ring around the swatch, usage count as a badge
                if (sel.has(def.id)) {
                    row.firstChild.classList.replace('ring-white/20', 'ring-amber-300');
                    row.firstChild.classList.remove('ring-1');
                    row.firstChild.classList.add('ring-2');
                    row.title = t('materials.panel.selectionBadge');
                }
                // usage count as a badge on the preview's corner (plain grey text got lost on the images)
                if (usage) row.firstChild.append(el('span', 'absolute -top-1.5 -right-1.5 h-4 min-w-4 rounded-full bg-sky-500 px-1 text-center text-[10px] leading-4 font-medium tabular-nums text-white shadow ring-1 ring-black/40', String(usage)));
            } else {
                if (sel.has(def.id)) row.append(el('span', 'shrink-0 rounded bg-amber-400/20 px-1 text-[10px] text-amber-200', t('materials.panel.selectionBadge')));
                row.append(el('span', 'w-6 shrink-0 text-right tabular-nums text-white/40', usage ? String(usage) : ''));
            }
            if (def.source === 'step') row.title = t('materials.panel.stepPlaceholderHint');
            if (def.source === 'import') row.title = t('materials.panel.importedHint');
            frag.append(row);
        }
        this.list.replaceChildren(frag);
        this.root.querySelector('[data-act="merge"]').hidden = !this.manager.hasNameTwins();
    }

    _renderLibrary() {
        this.root.querySelector('[data-act="merge"]').hidden = true;
        const frag = document.createDocumentFragment();
        for (const cat of PRESET_CATEGORIES) {
            frag.append(el('div', 'col-span-full px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-white/40', presetCategoryLabel(cat)));
            for (const p of MATERIAL_PRESETS.filter(p => p.category === cat)) {
                const row = this._row(presetName(p.libraryId), p.params, JSON.stringify({ libraryId: p.libraryId }), this._libraryThumb(p));
                row.dataset.library = p.libraryId;
                row.classList.add('hover:bg-white/10');
                row.title = t('materials.panel.libraryHint');
                frag.append(row);
            }
        }
        this.list.replaceChildren(frag);
    }

    // --- Previews ---

    // library preset: stored per browser; an unmodified scene copy shares its image
    _libraryThumb(preset) {
        return {
            key: thumbKey({ params: preset.params }), group: `lib:${preset.libraryId}`, persist: true, dispose: true,
            material: () => buildMaterial(preset.params),
        };
    }

    // scene material: the instance in the scene (node graph, textures); memory only, key unique to the material
    _sceneThumb(entry) {
        const { def } = entry;
        const preset = def.libraryId && !def.modified && MATERIAL_PRESETS.find(p => p.libraryId === def.libraryId);
        if (preset) return { ...this._libraryThumb(preset), group: def.id, dispose: false, material: () => entry.material };
        return {
            key: thumbKey({ id: def.id, params: def.params, graph: def.graph, maps: Object.keys(def.render?.maps || {}) }),
            group: def.id, persist: false, material: () => entry.material, previous: this.thumbs?.url(this.lastThumb.get(def.id)),
        };
    }

    // swatch of a material: rendered image when there; while it is made a spinner over the previous image (reload) or
    // an empty tile (new); editing keeps the material's last image without a spinner; failed: the CSS sphere.
    // animate (an image just arrived): the new image fades in over the old one, the spinner fades out
    _paint(sw, thumb, params, animate = false) {
        if (!this.thumbs || !thumb) { sw.style.background = swatch(params); sw.classList.add('ring-1'); return; }
        const { key, group } = thumb;
        if (!this.thumbs.has(key)) this.thumbs.request(key, group, thumb.material, thumb);
        const fresh = this.thumbs.has(key), url = this.thumbs.url(key);
        const image = url ?? (fresh ? null : thumb.previous ?? null);
        const busy = !fresh && (!!url || !thumb.previous);
        if (fresh && url && !group.startsWith('lib:')) this.lastThumb.set(group, key);
        const background = image ? `url(${image}) center/cover no-repeat` : fresh ? swatch(params) : '';
        if (animate && background && sw.dataset.bg !== background) fadeIn(sw, background);
        else { finishFades(sw); sw.style.background = background; }
        sw.dataset.bg = background;
        sw.classList.toggle('bg-white/5', !image && !fresh);
        if (!sw.classList.contains('ring-2')) sw.classList.toggle('ring-1', !image);
        const spinner = sw.querySelector('[data-spin]:not([data-leaving])');
        if (busy && !spinner) {
            const size = this.view === 'grid' ? 'size-5' : 'size-3';
            const spin = el('span', `absolute inset-0 m-auto ${size} animate-spin rounded-full border-2 border-white/20 border-t-sky-400 transition-opacity duration-300`);
            spin.dataset.spin = '';
            sw.append(spin);
        } else if (!busy && spinner) {
            if (animate) fadeOut(spinner); else spinner.remove();
        }
    }

    _onThumb({ key }) {
        for (const sw of this.list.querySelectorAll(`[data-thumb="${key}"]`)) {
            const group = sw.dataset.group;
            if (!this.thumbs.url(key) && !group.startsWith('lib:')) this.lastThumb.delete(group);
            this._paint(sw, { key, group }, JSON.parse(sw.dataset.params), true);
        }
    }

    _row(name, params, dragData, thumb) {
        const grid = this.view === 'grid';
        const row = el('div', grid
            ? 'relative flex cursor-grab flex-col items-center gap-1 rounded px-1 pt-1.5 pb-1'
            : 'flex cursor-grab items-center gap-2 rounded px-2 py-0.5');
        row.draggable = true;
        row.dataset.drag = dragData;
        const sw = el('span', (grid ? 'size-14 rounded-md' : 'size-5 rounded-sm') + ' relative shrink-0 ring-white/20');
        this._paint(sw, thumb, params);
        if (thumb) {
            sw.dataset.thumb = thumb.key;
            sw.dataset.group = thumb.group;
            sw.dataset.params = JSON.stringify(params);
        }
        const label = el('span', grid ? 'line-clamp-2 w-full text-center text-[10px] leading-tight break-words' : 'min-w-0 flex-1 truncate', name);
        if (grid) label.title = name;
        row.append(sw, label);
        return row;
    }

    // --- Editor ---

    _renderEditor() {
        const entry = this.tab === 'scene' && this.current ? this.manager.get(this.current) : null;
        if (!entry) { this.editor.hidden = true; this.editor.replaceChildren(); return; }
        const { def } = entry;
        this.editor.hidden = false;
        const frag = document.createDocumentFragment();

        const editing = MATERIALS.editing;   // config.js: editing hidden for now
        if (editing) {
            const name = el('input', 'mb-1.5 w-full rounded bg-white/10 px-1.5 py-0.5 text-white outline-none focus:bg-white/20');
            name.value = def.name;
            name.onchange = () => this.manager.rename(def.id, name.value.trim() || def.name);
            frag.append(name);
        } else frag.append(el('div', 'mb-1.5 truncate font-medium', def.name));

        const info = el('div', 'mb-1.5 flex flex-wrap items-center gap-1');
        info.append(el('span', 'text-white/40', t('materials.panel.id', { id: def.id })));
        const assign = el('button', BTN + ' ml-auto', t('materials.panel.assignSelection'));
        assign.dataset.act = 'assign';
        assign.disabled = !this.hooks.getSelectionObject?.();
        const users = el('button', BTN, t('materials.panel.selectObjects'));
        users.dataset.act = 'select-users';
        users.disabled = this.manager.usage(def.id) === 0;
        users.title = t('materials.panel.selectObjectsTitle');
        info.append(users);
        const nodes = el('button', BTN, t('materials.panel.nodes'));
        nodes.dataset.act = 'nodes';
        const dup = el('button', BTN, t('materials.panel.duplicate'));
        dup.dataset.act = 'duplicate';
        const del = el('button', BTN, t('materials.panel.delete'));
        del.dataset.act = 'delete';
        del.disabled = this.manager.usage(def.id) > 0;
        del.title = del.disabled ? t('materials.panel.deleteInUse') : t('materials.panel.deleteTitle');
        info.append(assign, ...(editing ? [nodes, dup] : []), del);
        frag.append(info);
        if (!editing) { this.editor.replaceChildren(frag); return; }

        const maps = Object.keys(def.render?.maps || {});
        if (maps.length) {
            const names = maps.map(mapLabel).join(', ');
            frag.append(el('div', 'mb-1 text-white/50', t('materials.panel.importedTextures', { names })));
        }

        if (def.graph?.nodes?.length) {
            frag.append(el('div', 'mb-1 text-white/50', t('materials.panel.graphControlled')));
        }

        let group = null, box = null;
        for (const p of PARAMS) {
            if (p.group !== group) {
                group = p.group;
                const open = this.openGroups.has(group);
                const head = el('button', 'mt-1 flex w-full items-center gap-1 text-left text-white/60 hover:text-white');
                head.innerHTML = `<svg viewBox="0 0 16 16" class="size-3 fill-current ${open ? 'rotate-90' : ''}"><path d="M6 4l4 4-4 4z"/></svg>`;
                head.append(t(`materials.paramGroups.${group}`));
                head.dataset.group = group;
                frag.append(head);
                box = el('div', open ? 'mt-0.5' : 'hidden');
                frag.append(box);
            }
            box.append(this._paramRow(def, p));
        }
        this.editor.replaceChildren(frag);
    }

    _paramRow(def, p) {
        const row = el('div', 'mb-1 grid grid-cols-[5.5rem_1fr] items-center gap-1.5');
        const ctl = el('div', 'flex min-w-0 items-center gap-1');
        const value = def.params[p.key] ?? p.default;
        const set = v => this.manager.setParams(def.id, { [p.key]: v });
        if (p.type === 'color') {
            ctl.append(colorField(value, { onInput: set }));
        } else {
            const step = (p.max - p.min) / 100;
            const r = el('input', 'min-w-0 flex-1 accent-sky-400');
            r.type = 'range';
            Object.assign(r, { min: p.min, max: p.max, step, value });
            const n = el('input', INPUT);
            n.type = 'number';
            Object.assign(n, { min: p.min, max: p.max, step, value: round(value) });
            r.oninput = () => { n.value = round(Number(r.value)); set(Number(r.value)); };
            n.onchange = () => { r.value = n.value; set(Number(n.value)); };
            ctl.append(r, n);
        }
        row.append(el('span', 'truncate text-white/60', t(`materials.params.${p.key}`)), ctl);
        return row;
    }

    // --- Actions ---

    _onClick(e) {
        const view = e.target.closest('[data-view]');
        if (view) {
            this.view = view.dataset.view;
            try { localStorage.setItem(VIEW_KEY, this.view); } catch { /* storage blocked */ }
            this.render({ keepEditor: true });
            return;
        }
        const tab = e.target.closest('[data-tab]');
        if (tab) { this.tab = tab.dataset.tab; this.render(); return; }
        const group = e.target.closest('[data-group]');
        if (group) {
            const g = group.dataset.group;
            if (this.openGroups.has(g)) this.openGroups.delete(g); else this.openGroups.add(g);
            this._renderEditor();
            return;
        }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'export' && MATERIALS.importExport) return this._export();
        if (act === 'import' && MATERIALS.importExport) return this.file.click();
        if (act === 'new' && MATERIALS.editing) {
            const entry = this.manager.create({ name: t('materials.defaultNames.new'), params: { color: '#b0b0b0', roughness: 0.4 } });
            return this.open(entry.def.id, 'scene');
        }
        if (act === 'reload-thumbs') return this.thumbs?.reload();
        if (act === 'checker') return this.thumbs?.setChecker(!this.thumbs.checker);
        if (act === 'merge') return this.hooks.onMergeDuplicates?.();
        if (act === 'assign' && this.current) return this.hooks.onAssignToSelection?.(this.current);
        if (act === 'nodes' && this.current && MATERIALS.editing) return this.hooks.onOpenNodeEditor?.(this.current);
        if (act === 'select-users' && this.current) return this.hooks.onSelectUsers?.(this.current);
        if (act === 'duplicate' && this.current) return this.open(this.manager.duplicate(this.current).def.id, 'scene');
        if (act === 'delete' && this.current) {
            if (this.manager.remove(this.current)) { this.current = null; this.render(); }
            return;
        }
        const row = e.target.closest('[data-id]');
        if (row && this.tab === 'scene') this.open(row.dataset.id);
    }

    _export() {
        const json = JSON.stringify(this.manager.toJSON(), null, 2);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        a.download = t('materials.panel.exportFileName');
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    async _import() {
        const file = this.file.files[0];
        this.file.value = '';
        if (!file) return;
        try {
            const entries = this.manager.fromJSON(JSON.parse(await file.text()));
            if (entries[0]) this.open(entries[0].def.id, 'scene');
        } catch (err) {
            messageDialog({ title: t('materials.panel.importErrorTitle'), message: t('materials.panel.importFailed', { message: err.message }) });
        }
    }
}

// --- Smooth image changes: a layer with the new image fades in over the swatch, then becomes its background ---

const FADE_MS = 300;

function fadeIn(sw, background) {
    finishFades(sw);
    const layer = el('span', 'pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity');
    layer.style.transitionDuration = `${FADE_MS}ms`;
    layer.style.background = background;
    layer.dataset.fade = '';
    sw.prepend(layer);   // below the spinner and the usage badge
    layer.getBoundingClientRect();   // start from opacity 0
    layer.style.opacity = '1';
    layer._done = () => { sw.style.background = background; layer.remove(); };
    layer.addEventListener('transitionend', layer._done, { once: true });
    setTimeout(() => layer.isConnected && layer._done(), FADE_MS + 100);   // no transition event (hidden tab etc.)
}

// a fade still running: jump to its end (a newer image comes)
function finishFades(sw) {
    for (const layer of sw.querySelectorAll('[data-fade]')) layer._done();
}

function fadeOut(node) {
    node.dataset.leaving = '';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), FADE_MS);
}

// CSS preview of a material (hinted sphere)
export function swatch(params) {
    // subsurface: the colour of the scattering shows (toon.js mixes it the same way)
    const c = (params.subsurface ?? 0) > 0.5 ? (params.subsurfaceColor || '#ffffff') : (params.color || '#808080');
    // cloud: soft white puffs (until the rendered preview is there)
    if ((params.cloud ?? 0) > 0) {
        const k = params.cloudColor || '#ffffff';
        return `radial-gradient(circle at 35% 55%, ${k} 0 22%, transparent 34%), radial-gradient(circle at 62% 45%, ${k} 0 26%, transparent 38%), radial-gradient(circle at 50% 66%, ${k}cc 0 30%, transparent 44%)`;
    }
    // glowing marble: dark stone with the vein colour glowing inside
    if ((params.marble ?? 0) > 0) {
        const m = params.marbleColor || '#33ff73';
        return `radial-gradient(circle at 32% 28%, #ffffffaa 0, transparent 22%), radial-gradient(circle at 58% 62%, ${m}cc 0, ${m}40 38%, ${c} 72%)`;
    }
    const metal = params.metalness ?? 0;
    const rough = params.roughness ?? 0.5;
    if ((params.transmission ?? 0) > 0.5) {
        return `radial-gradient(circle at 35% 30%, #ffffffcc 0 12%, transparent 30%), conic-gradient(#ffffff22 25%, #ffffff08 0 50%, #ffffff22 0 75%, #ffffff08 0) 0 0/6px 6px, ${c}33`;
    }
    const hi = rough < 0.3 ? '#ffffff' : '#ffffffaa';
    const edge = metal > 0.5 ? '#000000cc' : '#00000088';
    const spot = Math.round(8 + rough * 30);
    return `radial-gradient(circle at 32% 28%, ${hi} 0, ${c} ${spot}%, ${c} 55%, ${edge} 100%)`;
}

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function round(v) {
    return Math.round(v * 100) / 100;
}
