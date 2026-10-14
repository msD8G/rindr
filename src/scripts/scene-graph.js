// Scene graph: model (assemblies/parts), lights, environment (HDRI) and camera.
//  - Every entry can be selected (click on the name), mouse-over reports "hover".
//  - Multi-selection (model parts): Shift+click adds/removes (toggleSelect), additionally
//    selectObjects() (e.g. all meshes of a material) -> entry kind 'selection'.
//  - Visibility: switching off hides the entry including its children, switching on shows it
//    again including its children (and its ancestors too, siblings stay off).
//    Partially visible ("–"): a click switches everything below on.
//  - Children are only rendered when expanded (large models: tens of thousands of nodes).
//  - Surface groups: solids with several face colours (one mesh per colour) get a sub-entry per
//    mesh (kind 'surface') – individually selectable, hideable and a target for materials.
//    A click into the 3D view still finds the part (entryForObject), sub-surfaces only on request.
//
// Entry: { key, name, kind, object?, children, parts?, toggle?: { get(), set(v) } }
//   kind: 'model' | 'node' | 'surface' | 'light' | 'environment' | 'camera' | 'folder'
//   Without "toggle", object.visible is switched; entries with neither have no checkbox.
import { t } from './i18n.js';

// kinds with their own properties panel (arrow on the right of the row)
const SETTINGS_KINDS = new Set(['environment', 'light', 'camera', 'slicer', 'view']);
const CHEVRON = '<svg viewBox="0 0 16 16" class="size-3 fill-current"><path d="M6 4l4 4-4 4z"/></svg>';
const ICONS = {
    light: '<svg viewBox="0 0 16 16" class="size-3 fill-current text-amber-300"><circle cx="8" cy="7" r="4"/><rect x="6" y="12" width="4" height="2"/></svg>',
    environment: '<svg viewBox="0 0 16 16" class="size-3 fill-none stroke-current text-sky-300" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-3 3-3 9 0 12M8 2c3 3 3 9 0 12"/></svg>',
    camera: '<svg viewBox="0 0 16 16" class="size-3 fill-current text-white/60"><rect x="1" y="5" width="10" height="7" rx="1"/><path d="M11 7l4-2v7l-4-2z"/></svg>',
    slicer: '<svg viewBox="0 0 16 16" class="size-3 fill-none stroke-current text-orange-300" stroke-width="1.5"><path d="M3 13L13 3M2 6h5v8H2z" /></svg>',
    view: '<svg viewBox="0 0 16 16" class="size-3 fill-current text-sky-300"><rect x="1" y="5" width="10" height="7" rx="1"/><path d="M11 7l4-2v7l-4-2z"/></svg>',
    morphs: '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/><circle cx="5" cy="4" r="1.4" fill="currentColor"/><circle cx="10" cy="8" r="1.4" fill="currentColor"/><circle cx="7" cy="12" r="1.4" fill="currentColor"/></svg>',
    missing: '<svg viewBox="0 0 16 16" class="size-3 fill-current text-amber-300"><path d="M8 1.5 15 14H1z"/><rect x="7.3" y="5.5" width="1.4" height="4.5" fill="#000"/><rect x="7.3" y="11" width="1.4" height="1.4" fill="#000"/></svg>',
    model: '<svg viewBox="0 0 16 16" class="size-3 fill-none stroke-current text-white/60" stroke-width="1.5"><path d="M8 1l6 3.5v7L8 15l-6-3.5v-7z M8 8v7 M8 8l6-3.5 M8 8L2 4.5"/></svg>',
};

export class SceneGraph {
    /**
     * @param {HTMLElement} root  container with [data-tree-list], [data-tree-count]
     * @param {object} handlers
     *   onVisibility(entries)  visibility changed (affected entries)
     *   onSelect(entry|null)   selection changed
     *   onHover(entry|null)    mouse-over changed
     *   onActivate(entry)      double click on an entry
     *   onVisibilityEdit(before, after)  visibility changed by the user (Map key -> visible; undo)
     */
    constructor(root, { onVisibility, onSelect, onHover, onActivate, onVisibilityEdit, onWarn } = {}) {
        this.root = root;
        this.list = root.querySelector('[data-tree-list]');
        this.countEl = root.querySelector('[data-tree-count]');
        this.onVisibility = onVisibility || (() => {});
        this.onSelect = onSelect || (() => {});
        this.onWarn = onWarn || (() => {});   // click on ⚠ (missing files)
        this.onHover = onHover || (() => {});
        this.onActivate = onActivate || (() => {});
        this.onVisibilityEdit = onVisibilityEdit || (() => {});
        this._lastClick = { entry: null, time: 0 };
        this.tree = [];
        this.byKey = new Map();
        this.byObject = new Map();
        this.bySurface = new Map();   // mesh -> sub-surface entry
        this.expanded = new Set();
        this.hiddenModel = new Set();   // hidden model nodes/sub-surfaces (survive re-tessellation)
        this.deleted = new Set();       // deleted nodes/sub-surfaces (Del): invisible and not in the tree
        this.modelKey = null;
        this.selected = null;
        this.marked = new Set();   // rows of a multi-selection (selectMeshes)
        this.hovered = null;

        this.list.addEventListener('click', e => this._onClick(e));
        this.list.addEventListener('mouseover', e => this._setHover(this._entryAt(e.target)));
        this.list.addEventListener('mouseleave', () => this._setHover(null));
    }

    /**
     * Set the content.
     * @param {object[]} sceneEntries  lights/environment/camera (finished entries)
     * @param {object|null} model       { name, importNodes, groups, partCounts, root }
     */
    /**
     * @param {object[]} sceneEntries  environment, lights, camera, section
     * @param {object|null} model  main model ({ name, importNodes, groups, partCounts, root })
     * @param {object[]} extras  additionally loaded models (same shape + id) – keys prefixed with 'x<id>:'
     */
    setContent(sceneEntries, model, extras = [], missing = []) {
        const entries = [];
        if (model) entries.push(this._buildModel(model));
        for (const x of extras) entries.push(this._buildModel(x, `x${x.id}:`));
        // models of an opened scene whose files are missing: placeholders (click → asset window)
        missing.forEach((name, i) => entries.push({ key: 'missing-' + i, kind: 'missing', name, index: i, children: [] }));
        entries.push(...sceneEntries);
        this.tree = entries;
        this.byKey.clear();
        this.byObject.clear();
        this.bySurface.clear();
        const index = (e, parent, depth) => {
            e.parent = parent;
            e.depth = depth;
            e.children ||= [];
            this.byKey.set(e.key, e);
            if (e.kind === 'surface') this.bySurface.set(e.object, e);
            else if (e.object) this.byObject.set(e.object, e);
            e.children.forEach(c => index(c, e, depth + 1));
        };
        entries.forEach(e => index(e, null, 0));
        if (this.expanded.size === 0) entries.forEach(e => this.expanded.add(e.key));
        // keep the selection if the entry still exists
        if (this.selected) this.selected = this.byKey.get(this.selected.key) || null;
        this.marked.clear();
        if (this.hovered) this.hovered = null;
        const parts = entries.filter(e => e.kind === 'model').reduce((sum, e) => sum + e.parts, 0);
        this.countEl.textContent = model || extras.length ? t('sceneGraph.solids', { count: parts }) : '';
        this.root.hidden = false;
        this.render();
        this.onSelect(this.selected);   // objects may be new (e.g. after re-tessellation)
        this.onHover(null);
    }

    // Model tree from the import nodes: omit empty branches, collapse chains of equally named nodes
    // without their own solids (e.g. product -> representation -> representation)
    _buildModel({ name, importNodes, groups, partCounts, root, id }, prefix = '') {
        const key = importNodes.map(n => n.parent + ':' + n.name).join('|');
        // the main model resets hidden/expanded state when its structure changes (new model)
        if (!prefix && key !== this.modelKey) {
            this.hiddenModel.clear();
            this.deleted.clear();
            this.expanded.clear();
            this.modelKey = key;
        }
        const kids = importNodes.map(() => []);
        const roots = [];
        importNodes.forEach((n, i) => (n.parent >= 0 ? kids[n.parent] : roots).push(i));
        const total = new Array(importNodes.length).fill(0);
        for (let i = importNodes.length - 1; i >= 0; i--) {   // children have larger indices
            total[i] += partCounts[i] || 0;
            const p = importNodes[i].parent;
            if (p >= 0) total[p] += total[i];
        }
        const build = i => {
            while (!partCounts[i] && kids[i].filter(k => total[k] > 0).length === 1) {
                const only = kids[i].find(k => total[k] > 0);
                if (importNodes[only].name !== importNodes[i].name && importNodes[i].name) break;
                i = only;
            }
            // deleted (Del): invisible, not in the tree
            if (this.deleted.has(prefix + 'n' + i)) {
                groups[i].visible = false;
                return null;
            }
            const nodes = kids[i].filter(k => total[k] > 0).map(build).filter(Boolean);
            const entry = {
                key: prefix + 'n' + i,
                extra: id,   // additionally loaded model (undefined = main model)
                name: importNodes[i].name || t('sceneGraph.unnamed'),
                kind: 'node',
                object: groups[i],
                parts: (partCounts[i] || 0) + nodes.reduce((s, c) => s + c.parts, 0),
                children: [...nodes, ...this._surfaces(groups[i])],
            };
            groups[i].visible = !this.hiddenModel.has(entry.key);
            return entry.parts > 0 || entry.children.length ? entry : (groups[i].visible = false, null);
        };
        const children = roots.filter(r => total[r] > 0).map(build).filter(Boolean);
        const parts = children.reduce((s, c) => s + c.parts, 0);
        if (!prefix) this.modelParts = parts;
        root.visible = !this.hiddenModel.has(prefix + 'model');
        return { key: prefix + 'model', name: name || t('sceneGraph.model'), kind: 'model', object: root, parts, children, extra: id, warn: arguments[0].warn, morphs: arguments[0].morphs };
    }

    // Sub-surfaces of the solids of a part group: only solids (instances) with several meshes.
    // Name "surface group n" per solid (with several solids prefixed by the solid name), material next to it.
    _surfaces(group) {
        const byInstance = new Map();
        for (const c of group.children) {
            if (!c.isMesh) continue;
            const k = c.userData.instance ?? c.uuid;
            if (!byInstance.has(k)) byInstance.set(k, []);
            byInstance.get(k).push(c);
        }
        const several = byInstance.size > 1;
        const out = [];
        for (const meshes of byInstance.values()) {
            if (meshes.length < 2) continue;
            for (const [n, mesh] of meshes.entries()) {
                const key = 's' + (mesh.userData.key ?? mesh.uuid);
                if (this.deleted.has(key)) { mesh.visible = false; continue; }
                mesh.visible = !this.hiddenModel.has(key);
                out.push({
                    key,
                    kind: 'surface',
                    object: mesh,
                    name: several && mesh.name ? t('sceneGraph.surfaceGroupOf', { solid: mesh.name, n: n + 1 }) : t('sceneGraph.surfaceGroup', { n: n + 1 }),
                    children: [],
                });
            }
        }
        return out;
    }

    // --- Visibility ---

    isVisible(entry) {
        if (entry.toggle) return entry.toggle.get();
        return entry.object ? entry.object.visible : true;
    }

    _hasToggle(entry) {
        return !!(entry.toggle || (entry.object && entry.kind !== 'camera'));
    }

    _setOwnVisible(entry, visible) {
        if (entry.toggle) entry.toggle.set(visible);
        else if (entry.object) entry.object.visible = visible;
        if (entry.kind === 'node' || entry.kind === 'model' || entry.kind === 'surface') {
            if (visible) this.hiddenModel.delete(entry.key); else this.hiddenModel.add(entry.key);
        }
    }

    /** Set the visibility of one entry or several (multi-selection, one undo step) */
    setVisible(entry, visible) {
        const entries = Array.isArray(entry) ? entry : [entry];
        const changed = [];
        const before = new Map();
        const set = (e, v) => {
            if (!before.has(e.key)) before.set(e.key, this.isVisible(e));
            this._setOwnVisible(e, v);
            changed.push(e);
        };
        const apply = e => {
            if (this._hasToggle(e)) set(e, visible);
            e.children.forEach(apply);
        };
        entries.forEach(apply);
        if (visible) {
            for (const e of entries) {
                for (let p = e.parent; p; p = p.parent) {
                    if (this._hasToggle(p) && !this.isVisible(p)) set(p, true);
                }
            }
        }
        this.render();
        this.onVisibility(changed);
        // only remember entries that actually changed
        for (const [key, v] of before) if (v === visible) before.delete(key);
        if (before.size) this.onVisibilityEdit(before, new Map([...before.keys()].map(k => [k, visible])));
    }

    /** Set the visibility of individual entries (undo), states: Map key -> visible */
    applyVisibility(states) {
        const changed = [];
        for (const [key, v] of states) {
            const e = this.byKey.get(key);
            if (!e || !this._hasToggle(e)) continue;
            this._setOwnVisible(e, v);
            changed.push(e);
        }
        this.render();
        if (changed.length) this.onVisibility(changed);
    }

    /** Set hidden model nodes (scene state), keys as in hiddenModel ('model', 'n<i>', 's<mesh key>') */
    setHiddenModel(keys) {
        this.hiddenModel = new Set(keys);
        const changed = [];
        for (const [key, e] of this.byKey) {
            if ((e.kind !== 'node' && e.kind !== 'model' && e.kind !== 'surface') || !e.object) continue;
            e.object.visible = !this.hiddenModel.has(key);
            changed.push(e);
        }
        this.render();
        this.onVisibility(changed);
    }

    // State of a checkbox: 'on' | 'off' | 'mixed'
    _state(entry, cache) {
        if (cache.has(entry)) return cache.get(entry);
        let state = this.isVisible(entry) ? 'on' : 'off';
        if (state === 'on' && entry.children.some(c => this._hasToggle(c) && this._state(c, cache) !== 'on')) state = 'mixed';
        cache.set(entry, state);
        return state;
    }

    // --- Selection ---

    /** Entry for a scene object (mesh -> nearest ancestor with an entry); surfaces: prefer the sub-surface */
    entryForObject(object, { surfaces = false } = {}) {
        if (surfaces && this.bySurface.has(object)) return this.bySurface.get(object);
        for (let o = object; o; o = o.parent) {
            const e = this.byObject.get(o);
            if (e) return e;
        }
        return null;
    }

    select(entry, { reveal = true } = {}) {
        if (entry === this.selected) return;
        this.selected = entry;
        if (entry?.kind !== 'selection') this.marked.clear();
        if (entry && reveal) {
            for (let p = entry.parent; p; p = p.parent) this.expanded.add(p.key);
        }
        this.render();
        if (entry && reveal) {
            this.list.querySelector(`[data-key="${entry.key}"]`)?.scrollIntoView({ block: 'nearest' });
        }
        this.onSelect(entry);
    }

    /**
     * Multi-selection of model objects (groups of parts or individual meshes, e.g. all with a
     * material). The selection is a dedicated entry (kind 'selection') whose object only
     * traverses these objects (traverse; members, meshes) – assigning, highlighting and framing
     * thus act exactly on them; the corresponding rows are marked.
     * A single part is selected normally.
     */
    selectObjects(objects, name) {
        // omit duplicates and objects contained in others
        objects = [...new Set(objects)];
        objects = objects.filter(o => !objects.some(other => other !== o && isAncestor(other, o)));
        if (!objects.length) return this.select(null);
        const own = o => { const e = this.entryForObject(o, { surfaces: true }); return e?.object === o ? e : null; };
        if (objects.length === 1 && own(objects[0])) return this.select(own(objects[0]), { reveal: false });
        const meshes = [];
        objects.forEach(o => o.traverse(c => { if (c.isMesh) meshes.push(c); }));
        const rows = new Set(objects.map(o => this.entryForObject(o, { surfaces: true })).filter(Boolean));
        const object = {
            isMeshSet: true,
            members: objects,
            meshes,
            traverse: fn => objects.forEach(o => o.traverse(fn)),
        };
        const entry = { key: 'selection', kind: 'selection', name: name || t('sceneGraph.selectionParts', { count: rows.size }), object, parts: rows.size, children: [] };
        this.selected = null;
        this.marked = rows;
        for (const row of rows) for (let p = row.parent; p; p = p.parent) this.expanded.add(p.key);
        this.select(entry, { reveal: false });
        const first = this.tree.length && [...rows][0];
        if (first) this.list.querySelector(`[data-key="${first.key}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    /** Ctrl+A: all visible parts (leaf entries or entries with their own meshes) */
    selectAllParts() {
        const shown = o => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
        const objects = [];
        for (const e of this.byKey.values()) {
            if (e.kind !== 'node' || !e.object || !shown(e.object)) continue;
            if (!e.children.length || e.object.children.some(c => c.isMesh)) objects.push(e.object);
        }
        this.selectObjects(objects, t('sceneGraph.allParts', { count: objects.length }));
    }

    selectMeshes(meshes, name) {
        this.selectObjects(meshes, name);
    }

    /** Shift+click: add a model entry to the selection or remove it */
    toggleSelect(entry) {
        const isPart = e => e && (e.kind === 'node' || e.kind === 'model' || e.kind === 'surface');
        const cur = this.selected;
        // saved camera views: own multi-selection (kind 'views', e.g. to delete several)
        if (entry?.kind === 'view') {
            const views = cur?.kind === 'views' ? [...cur.entries] : cur?.kind === 'view' ? [cur] : [];
            const next = views.includes(entry) ? views.filter(v => v !== entry) : [...views, entry];
            if (next.length <= 1) return this.select(next[0] || null, { reveal: false });
            const sel = { kind: 'views', key: 'views', entries: next, children: [], name: t('sceneGraph.views', { count: next.length }) };
            this.selected = sel;
            this.marked = new Set(next);
            this.render();
            this.onSelect(sel);
            return;
        }
        if (!isPart(entry) || !(isPart(cur) || cur?.kind === 'selection')) return this.select(entry, { reveal: false });
        let members = cur.kind === 'selection' ? [...cur.object.members] : [cur.object];
        const obj = entry.object;
        if (members.includes(obj)) members = members.filter(m => m !== obj);
        else if (members.some(m => isAncestor(m, obj))) return;   // already inside a selected assembly
        else members = members.filter(m => !isAncestor(obj, m)).concat(obj);
        this.selectObjects(members);
    }

    /** Does the entry (or a parent group) belong to the current multi-selection? */
    inSelection(entry) {
        const sel = this.selected;
        if (sel?.kind !== 'selection' || !entry) return false;
        return this.marked.has(entry) || sel.object.members.some(m => isAncestor(m, entry.object));
    }

    _setHover(entry) {
        if (entry === this.hovered) return;
        this.hovered = entry;
        this.onHover(entry);
    }

    entryAt(el) {
        return this._entryAt(el);
    }

    _entryAt(el) {
        const row = el?.closest?.('[data-key]');
        return row ? this.byKey.get(row.dataset.key) || null : null;
    }

    // --- Rendering ---

    render() {
        const cache = new Map();
        const frag = document.createDocumentFragment();
        const add = entry => {
            frag.appendChild(this._row(entry, cache));
            if (this.expanded.has(entry.key)) entry.children.forEach(add);
        };
        this.tree.forEach(add);
        const scroll = this.list.scrollTop;
        this.list.replaceChildren(frag);
        this.list.scrollTop = scroll;
    }

    _row(entry, cache) {
        const state = this._hasToggle(entry) ? this._state(entry, cache) : 'on';
        const row = document.createElement('div');
        row.className = 'flex items-center gap-1 rounded py-0.5 pr-2 '
            + (entry === this.selected || this.marked.has(entry) ? 'bg-sky-500/30' : 'hover:bg-white/10');
        row.style.paddingLeft = `${entry.depth * 12 + 4}px`;
        row.dataset.key = entry.key;
        row.dataset.state = state;

        const exp = document.createElement('button');
        exp.dataset.action = 'expand';
        exp.className = 'flex size-4 shrink-0 items-center justify-center text-white/50 hover:text-white';
        if (entry.children.length) {
            exp.innerHTML = CHEVRON;
            if (this.expanded.has(entry.key)) exp.firstChild.classList.add('rotate-90');
        } else exp.disabled = true;
        row.append(exp);

        if (this._hasToggle(entry)) {
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.dataset.action = 'visible';
            box.className = 'size-3.5 shrink-0 cursor-pointer accent-sky-400';
            box.checked = state !== 'off';
            box.indeterminate = state === 'mixed';
            box.title = t('sceneGraph.visible');
            row.append(box);
        }
        // entries without a visibility checkbox (camera, saved views): no placeholder – icon and name
        // move left, flush with the checkboxes of the other rows

        if (ICONS[entry.kind]) {
            const icon = document.createElement('span');
            icon.className = 'flex shrink-0 items-center';
            icon.innerHTML = ICONS[entry.kind];
            row.append(icon);
        }

        if (entry.kind === 'surface') {
            const swatch = document.createElement('span');
            swatch.className = 'size-2.5 shrink-0 rounded-full ring-1 ring-white/20';
            swatch.style.background = '#' + (entry.object.material.color?.getHexString() ?? '808080');
            row.append(swatch);
        }

        const label = document.createElement('span');
        label.dataset.action = 'select';
        label.className = 'min-w-0 flex-1 cursor-pointer truncate' + (state === 'off' || entry.kind === 'missing' ? ' text-white/40' : '');
        label.textContent = entry.name;
        label.title = entry.kind === 'missing' ? t('sceneGraph.missingModel', { name: entry.name }) : entry.name;
        row.append(label);
        // model with morph targets (blend shapes): sliders in its properties
        if (entry.morphs) {
            const m = document.createElement('span');
            m.className = 'shrink-0 text-violet-300';
            m.innerHTML = ICONS.morphs;
            m.title = t('sceneGraph.morphTargets', { count: entry.morphs });
            row.append(m);
        }
        // model with missing textures / missing model file: warning sign (details in the asset window)
        if (entry.warn || entry.kind === 'missing') {
            const warn = document.createElement('span');
            warn.dataset.action = 'warn';
            warn.className = 'shrink-0 cursor-pointer text-amber-300';
            warn.textContent = '⚠';
            warn.title = entry.kind === 'missing' ? t('sceneGraph.missingModel', { name: entry.name }) : t('sceneGraph.missingTextures', { count: entry.warn });
            row.append(warn);
        }

        if (entry.kind === 'surface') {
            const mat = document.createElement('span');
            mat.className = 'max-w-[45%] shrink-0 truncate text-white/40';
            mat.textContent = entry.object.material.name || '';
            mat.title = t('sceneGraph.materialTitle', { name: mat.textContent });
            row.append(mat);
        }

        // entries with their own settings (environment, lights, camera, section): small arrow on the right,
        // so it is clear there is more than the checkbox – a click opens the properties like the name
        if (SETTINGS_KINDS.has(entry.kind)) {
            const more = document.createElement('span');
            more.dataset.action = 'select';
            more.className = 'flex size-4 shrink-0 cursor-pointer items-center justify-center text-white/40 hover:text-white';
            more.innerHTML = CHEVRON;
            more.title = t('sceneGraph.settings');
            row.append(more);
        }

        if (entry.parts && entry.children.length) {
            const count = document.createElement('span');
            count.className = 'shrink-0 tabular-nums text-white/40';
            count.textContent = entry.parts;
            count.title = t('sceneGraph.solids', { count: entry.parts });
            row.append(count);
        }
        return row;
    }

    _onClick(e) {
        const target = e.target.closest('[data-action]');
        const action = target?.dataset.action;
        const entry = this._entryAt(target);
        if (!action || !entry) return;
        if (action === 'visible') {
            // partially visible -> all on, otherwise toggle; the checkbox of a marked row of the
            // multi-selection switches all marked rows the same way
            const visible = target.closest('[data-key]').dataset.state !== 'on';
            this.setVisible(this.marked.has(entry) ? [...this.marked] : entry, visible);
        } else if (action === 'warn') {
            this.onWarn(entry);
        } else if (action === 'expand' && entry.children.length) {
            if (this.expanded.has(entry.key)) this.expanded.delete(entry.key);
            else this.expanded.add(entry.key);
            this.render();
        } else if (action === 'select') {
            // detect double clicks ourselves: the first click rebuilds the rows, a native
            // dblclick would no longer reach the row
            const now = performance.now();
            const isDouble = this._lastClick.entry === entry && now - this._lastClick.time < 400;
            this._lastClick = { entry: isDouble ? null : entry, time: now };
            if (isDouble) {
                this.select(entry, { reveal: false });
                this.onActivate(entry);
            } else if (e.shiftKey) {
                this.toggleSelect(entry);
            } else {
                this.select(entry === this.selected ? null : entry, { reveal: false });
            }
        }
    }
}

// a is b or an ancestor of b
function isAncestor(a, b) {
    for (let o = b; o; o = o.parent) if (o === a) return true;
    return false;
}
