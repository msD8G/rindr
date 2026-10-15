// Material panel: scene materials + library, parameter editor, drag & drop, JSON.
//  - Scene: all used/created materials; materials of the current selection are marked
//  - Library: presets by category; double-click takes one over into the scene
//  - Every row is draggable (dataTransfer MATERIAL_MIME = { id } or { libraryId })
import { messageDialog } from './dialog.js';
import { PARAMS } from './material-manager.js';
import { MATERIALS } from './config.js';
import { MATERIAL_PRESETS, PRESET_CATEGORIES, presetName, presetCategoryLabel } from './material-presets.js';
import { t, has } from './i18n.js';
import { colorField } from './ui-controls.js';

export const MATERIAL_MIME = 'application/x-step-viewer-material';

// Display name of a texture map key (materials.maps.<key>, unknown keys as they are)
export const mapLabel = key => (has(`materials.maps.${key}`) ? t(`materials.maps.${key}`) : key);


const BTN = 'rounded px-2 py-0.5 text-white/80 hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent';
const TAB = 'rounded px-2 py-0.5';
const INPUT = 'w-14 flex-none rounded bg-white/10 px-1.5 py-0.5 text-right tabular-nums text-white outline-none focus:bg-white/20';

export class MaterialPanel {
    /**
     * @param {HTMLElement} root
     * @param {import('./material-manager.js').MaterialManager} manager
     * @param {object} hooks  { getSelectionObject(), onAssignToSelection(id), onOpenNodeEditor(id) }
     */
    constructor(root, manager, hooks = {}) {
        this.root = root;
        this.manager = manager;
        this.hooks = hooks;
        this.tab = 'scene';
        this.current = null;        // material opened in the editor (ID)
        this.selectionIds = [];     // materials of the selection
        this.openGroups = new Set(['base']);

        root.innerHTML = `
            <div class="flex items-center justify-between gap-2 px-3 py-2">
                <span class="font-medium">${t('materials.panel.title')}</span>
                <span class="flex gap-1">
                    <button data-act="merge" class="${BTN}" title="${t('materials.panel.mergeTitle')}" hidden>${t('materials.panel.merge')}</button>
                    ${MATERIALS.importExport ? `<button data-act="import" class="${BTN}" title="${t('materials.panel.importTitle')}">${t('materials.panel.import')}</button>
                    <button data-act="export" class="${BTN}" title="${t('materials.panel.exportTitle')}">${t('materials.panel.export')}</button>` : ''}
                </span>
            </div>
            <div class="flex gap-1 px-3 pb-1.5">
                <button data-tab="scene" class="${TAB}">${t('materials.panel.tabs.scene')}</button>
                <button data-tab="library" class="${TAB}">${t('materials.panel.tabs.library')}</button>
                ${MATERIALS.editing ? `<button data-act="new" class="${BTN} ml-auto" title="${t('materials.panel.newTitle')}">${t('materials.panel.new')}</button>` : ''}
            </div>
            <div data-list class="max-h-[30vh] min-h-0 overflow-auto px-1 pb-1 select-none"></div>
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
        for (const { def } of entries) {
            const row = this._row(def.name, def.params, JSON.stringify({ id: def.id }));
            row.dataset.id = def.id;
            if (def.id === this.current) row.classList.add('bg-sky-500/30');
            else row.classList.add('hover:bg-white/10');
            if (sel.has(def.id)) row.append(el('span', 'shrink-0 rounded bg-amber-400/20 px-1 text-[10px] text-amber-200', t('materials.panel.selectionBadge')));
            const usage = counts.get(def.id) || 0;
            row.append(el('span', 'w-6 shrink-0 text-right tabular-nums text-white/40', usage ? String(usage) : ''));
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
            frag.append(el('div', 'px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-white/40', presetCategoryLabel(cat)));
            for (const p of MATERIAL_PRESETS.filter(p => p.category === cat)) {
                const row = this._row(presetName(p.libraryId), p.params, JSON.stringify({ libraryId: p.libraryId }));
                row.dataset.library = p.libraryId;
                row.classList.add('hover:bg-white/10');
                row.title = t('materials.panel.libraryHint');
                frag.append(row);
            }
        }
        this.list.replaceChildren(frag);
    }

    _row(name, params, dragData) {
        const row = el('div', 'flex cursor-grab items-center gap-2 rounded px-2 py-0.5');
        row.draggable = true;
        row.dataset.drag = dragData;
        const sw = el('span', 'size-4 shrink-0 rounded-full ring-1 ring-white/20');
        sw.style.background = swatch(params);
        row.append(sw, el('span', 'min-w-0 flex-1 truncate', name));
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

// CSS preview of a material (hinted sphere)
export function swatch(params) {
    // subsurface: the colour of the scattering shows (toon.js mixes it the same way)
    const c = (params.subsurface ?? 0) > 0.5 ? (params.subsurfaceColor || '#ffffff') : (params.color || '#808080');
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
