// Material registry: all materials of the scene with their own ID.
//  - Dummy materials from the STEP colors (source 'step')
//  - Materials from glTF/FBX (source 'import', with textures in def.render – not in the JSON)
//  - Instances from the library (source 'library', libraryId) and custom ones (source 'custom')
//  - Assignment to objects (groups/meshes), JSON export/import
// Every material is a RindrMaterial (toon.js: MeshPhysicalNodeMaterial + optional toon lighting, TSL); the path
// tracer reads the same physical parameters. Style params: toon (raster light steps), flat (plain base colour), contour (lines, contour.js).
import * as THREE from 'three/webgpu';
import { uniform, screenCoordinate, fract, dot, vec2 } from 'three/tsl';
import { MATERIAL_PRESETS, presetName } from './material-presets.js';
import { createImportGraph, IMPORT_SLOTS } from './material-graph.js';
import { t } from './i18n.js';
import { RindrMaterial } from './toon.js';

// Parameter description (also for the editor panel). Labels: materials.params.<key>,
// group labels: materials.paramGroups.<group> (group = id, also used for the collapse state)
export const PARAMS = [
    { key: 'color', type: 'color', default: '#808080', group: 'base' },
    { key: 'metalness', type: 'number', min: 0, max: 1, default: 0, group: 'base' },
    { key: 'roughness', type: 'number', min: 0, max: 1, default: 0.5, group: 'base' },
    { key: 'specularIntensity', type: 'number', min: 0, max: 1, default: 1, group: 'base' },
    { key: 'clearcoat', type: 'number', min: 0, max: 1, default: 0, group: 'clearcoat' },
    { key: 'clearcoatRoughness', type: 'number', min: 0, max: 1, default: 0, group: 'clearcoat' },
    { key: 'transmission', type: 'number', min: 0, max: 1, default: 0, group: 'glass' },
    { key: 'ior', type: 'number', min: 1, max: 2.5, default: 1.5, group: 'glass' },
    { key: 'thickness', type: 'number', min: 0, max: 50, default: 0, group: 'glass' },
    { key: 'attenuationColor', type: 'color', default: '#ffffff', group: 'glass' },
    { key: 'attenuationDistance', type: 'number', min: 0.1, max: 100, default: 100, group: 'glass' },
    { key: 'sheen', type: 'number', min: 0, max: 1, default: 0, group: 'sheen' },
    { key: 'sheenColor', type: 'color', default: '#ffffff', group: 'sheen' },
    { key: 'sheenRoughness', type: 'number', min: 0, max: 1, default: 1, group: 'sheen' },
    { key: 'iridescence', type: 'number', min: 0, max: 1, default: 0, group: 'effects' },
    { key: 'emissive', type: 'color', default: '#000000', group: 'effects' },
    { key: 'emissiveIntensity', type: 'number', min: 0, max: 20, default: 1, group: 'effects' },
    { key: 'opacity', type: 'number', min: 0, max: 1, default: 1, group: 'effects' },
    // subsurface scattering (toon.js: random walk in the path tracer, approximation in the raster view);
    // radius = mean free path in scene units (mm for CAD models)
    { key: 'subsurface', type: 'number', min: 0, max: 1, default: 0, group: 'subsurface' },
    { key: 'subsurfaceColor', type: 'color', default: '#ffffff', group: 'subsurface' },
    { key: 'subsurfaceRadius', type: 'number', min: 0.05, max: 50, default: 2, group: 'subsurface' },
    // glowing marble veins inside the object (marble.js, raster + path tracer); scale = scene units per pattern unit
    { key: 'marble', type: 'number', min: 0, max: 5, default: 0, group: 'marble' },
    { key: 'marbleColor', type: 'color', default: '#33ff73', group: 'marble' },
    { key: 'marbleScale', type: 'number', min: 0.5, max: 200, default: 10, group: 'marble' },
    // style: toon shading / flat colour (raster; matte in the path tracer) and contour lines (contour.js, all view modes)
    { key: 'toon', type: 'number', min: 0, max: 1, default: 0, group: 'style' },
    { key: 'flat', type: 'number', min: 0, max: 1, default: 0, group: 'style' },
    { key: 'contour', type: 'number', min: 0, max: 1, default: 0, group: 'style' },
    { key: 'contourColor', type: 'color', default: '#000000', group: 'style' },
    { key: 'contourWidth', type: 'number', min: 0.5, max: 6, default: 1.5, group: 'style' },
];
const PARAM_BY_KEY = Object.fromEntries(PARAMS.map(p => [p.key, p]));

// Fade-in of new parts during import: object.userData.fade (0..1) per object, pixels discarded via
// a noise pattern (interleaved gradient noise) – no transparency, no material copies, shadows fade
// along. Without fade (= 1) every pixel stays. The path tracer ignores the mask.
const FADE = uniform(1).onObjectUpdate(({ object }) => object.userData.fade ?? 1);
export const FADE_MASK = FADE.greaterThan(fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189)));

let idCounter = 0;
const newId = () => `mat-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export class MaterialManager extends EventTarget {
    /** Events: 'change' (list/assignment), 'update' (parameters of a material, detail: { id }) */
    constructor() {
        super();
        this.entries = new Map();   // id -> { def, material }
        this.history = null;        // History (history.js) – changes are recorded there
    }

    get list() {
        return [...this.entries.values()];
    }

    get(id) {
        return this.entries.get(id) || null;
    }

    /** Create a material; def: { id?, name, source, libraryId?, params } */
    create(def, { silent = false } = {}) {
        const full = {
            id: def.id && !this.entries.has(def.id) ? def.id : newId(),
            name: def.name || t('materials.defaultNames.material'),
            source: def.source || 'custom',
            libraryId: def.libraryId || null,
            params: { ...def.params },
            graph: def.graph ? structuredClone(def.graph) : null,
            render: def.render || null,   // { maps, side, alphaTest, transparent, normalScale, ... } (import)
            origin: def.origin || null,   // origin for step/import (STEP color or material index in the file)
            modified: !!def.modified,
        };
        // Import: the file's textures as nodes, so the node editor shows everything
        if (!full.graph && full.source === 'import' && hasGraphMaps(full.render)) full.graph = createImportGraph(full.render.maps);
        const material = new RindrMaterial();
        material.maskNode = FADE_MASK;
        material.name = full.name;
        material.userData.materialId = full.id;
        const entry = { def: full, material };
        this.entries.set(full.id, entry);
        this._apply(entry);
        if (!silent) {
            this._emit('change');
            const saved = { ...full, graph: full.graph && structuredClone(full.graph) };
            this.history?.record({
                label: t('materials.undo.create'),
                undo: () => this._delete(full.id),
                redo: () => this.create(saved),
            });
        }
        return entry;
    }

    /** Dummy material for a STEP color (rgb 0..1) – only once per color */
    forStepColor(rgb) {
        const hex = rgb ? '#' + new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace).getHexString() : '#7a7a7a';
        const origin = rgb ? hex : 'default';
        for (const e of this.entries.values()) {
            if (e.def.source === 'step' && e.def.origin === origin) return e;
        }
        return this.create({
            name: rgb ? t('materials.defaultNames.stepColor', { color: hex.toUpperCase() }) : t('materials.defaultNames.stepDefault'),
            source: 'step',
            origin,
            params: { color: hex, metalness: 0.8, roughness: 0.2 },
        }, { silent: true });
    }

    /** Bring a library preset into the scene (reuse an existing unmodified instance) */
    fromLibrary(libraryId) {
        for (const e of this.entries.values()) {
            if (e.def.libraryId === libraryId && !e.def.modified) return e;
        }
        const preset = MATERIAL_PRESETS.find(p => p.libraryId === libraryId);
        if (!preset) return null;
        return this.create({ name: presetName(libraryId), source: 'library', libraryId, params: preset.params });
    }

    duplicate(id) {
        const src = this.get(id);
        if (!src) return null;
        return this.create({ ...src.def, id: undefined, name: t('materials.defaultNames.copy', { name: src.def.name }), source: 'custom', libraryId: null });
    }

    remove(id) {
        if (this.usage(id) > 0) return false;
        const e = this.get(id);
        if (!e) return false;
        const saved = { ...e.def, graph: e.def.graph && structuredClone(e.def.graph) };
        this._delete(id);
        this.history?.record({
            label: t('materials.undo.delete'),
            undo: () => this.create(saved),
            redo: () => this._delete(id),
        });
        return true;
    }

    /** Change parameters */
    setParams(id, params) {
        const e = this.get(id);
        if (!e) return;
        const before = snapshot(e);
        Object.assign(e.def.params, params);
        e.def.modified = true;
        this._apply(e);
        this._emit('update', { id });
        this._recordEdit(id, t('materials.undo.edit'), before, `params:${id}:${Object.keys(params).join()}`);
    }

    /**
     * Set the node graph (null = no graph)
     * @param {string} [mergeKey]  merge continuous changes of the same value into one undo step
     */
    setGraph(id, graph, mergeKey) {
        const e = this.get(id);
        if (!e) return;
        const before = snapshot(e);
        e.def.graph = graph;
        e.def.modified = true;
        this._apply(e);
        this._emit('update', { id });
        this._recordEdit(id, t('materials.undo.editGraph'), before, mergeKey && `graph:${id}:${mergeKey}`);
    }

    rename(id, name) {
        const e = this.get(id);
        if (!e) return;
        const before = snapshot(e);
        e.def.name = name;
        e.material.name = name;
        this._emit('change');
        this._recordEdit(id, t('materials.undo.rename'), before);
    }

    /** Assign the material to all meshes below object */
    assign(object, id) {
        const e = this.get(id);
        if (!e || !object) return 0;
        let n = 0;
        object.traverse(c => {
            if (c.isMesh && !c.isSplat && c.material !== e.material) {   // Gaussian splats: no material slot
                c.material = e.material;
                n++;
            }
        });
        this._emit('change');
        return n;
    }

    /** IDs of the materials below an object (ordered by frequency) */
    materialsOf(object) {
        const count = new Map();
        object?.traverse(c => {
            const id = c.isMesh && c.material?.userData?.materialId;   // material arrays (animation puppet): skipped
            if (id) count.set(id, (count.get(id) || 0) + 1);
        });
        return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    }

    /** Usage of all materials (number of meshes) in one pass over the scene */
    usageCounts() {
        const counts = new Map();
        this.scene?.traverse(c => {
            const id = c.isMesh && c.material?.userData?.materialId;   // material arrays (animation puppet): skipped
            if (id) counts.set(id, (counts.get(id) || 0) + 1);
        });
        return counts;
    }

    usage(id) {
        return this.usageCounts().get(id) || 0;
    }

    /** Remove unused import materials (e.g. after re-tessellation or a new model) */
    pruneUnused(sources = ['step', 'import']) {
        const counts = this.usageCounts();
        const textures = new Set();
        for (const [id, e] of this.entries) {
            if (sources.includes(e.def.source) && !counts.get(id)) {
                e.material.dispose();
                Object.values(e.def.render?.maps || {}).forEach(t => textures.add(t));
                this.entries.delete(id);
            }
        }
        // Only dispose textures that no remaining material (e.g. a copy) uses
        for (const e of this.entries.values()) Object.values(e.def.render?.maps || {}).forEach(t => textures.delete(t));
        textures.forEach(t => t.dispose());
        this._emit('change');
    }

    /** Are there materials with the same name? (cheap check for the "merge identical" button) */
    hasNameTwins() {
        const names = new Set();
        for (const e of this.entries.values()) {
            if (names.has(e.def.name)) return true;
            names.add(e.def.name);
        }
        return false;
    }

    /**
     * Groups of identical materials: same name, parameters, node graph, render settings and texture content
     * (e.g. the same file loaded twice – every import creates its own materials and textures).
     * @returns {Promise<string[][]>} per group [keeper ID, …duplicate IDs]; keeper = most used
     */
    async findDuplicates() {
        const counts = this.usageCounts();
        const groups = new Map();
        for (const e of this.entries.values()) {
            const { name, params, graph, render } = e.def;
            const maps = {};
            for (const [key, tex] of Object.entries(render?.maps || {}).sort()) maps[key] = await textureFingerprint(tex);
            const { maps: _, ...renderRest } = render || {};
            const sig = stableJson({ name, params, graph: graph || null, render: renderRest, maps });
            if (!groups.has(sig)) groups.set(sig, []);
            groups.get(sig).push(e.def.id);
        }
        return [...groups.values()].filter(g => g.length > 1)
            .map(g => g.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0)));
    }

    // --- JSON ---

    toJSON(ids = [...this.entries.keys()]) {
        return {
            format: 'step-viewer-materials',
            version: 1,
            materials: ids.map(id => this.get(id)).filter(Boolean).map(({ def }) => ({
                id: def.id, name: def.name, source: def.source, libraryId: def.libraryId,
                params: def.params, graph: def.graph || undefined, origin: def.origin || undefined,
                modified: def.modified || undefined,
            })),
        };
    }

    /** Take over materials from JSON; same ID -> gets updated. Returns the entries. */
    fromJSON(json) {
        if (!json || !Array.isArray(json.materials)) throw new Error(t('materials.errors.notMaterialFile'));
        const out = [];
        const changed = [];   // [id, before] (undo)
        const created = [];
        for (const m of json.materials) {
            const existing = m.id && this.get(m.id);
            if (existing) {
                changed.push([existing.def.id, snapshot(existing)]);
                existing.def.name = m.name || existing.def.name;
                existing.def.params = { ...m.params };
                existing.def.graph = m.graph ? structuredClone(m.graph) : null;
                existing.material.name = existing.def.name;
                this._apply(existing);
                out.push(existing);
            } else {
                const entry = this.create({ ...m, source: m.source === 'step' ? 'custom' : (m.source || 'custom') }, { silent: true });
                created.push({ ...entry.def });
                out.push(entry);
            }
        }
        this._emit('change');
        const after = changed.map(([id]) => [id, snapshot(this.get(id))]);
        this.history?.record({
            label: t('materials.undo.import'),
            undo: () => {
                created.forEach(d => this._delete(d.id));
                changed.forEach(([id, s]) => this._restoreSnapshot(id, s));
            },
            redo: () => {
                after.forEach(([id, s]) => this._restoreSnapshot(id, s));
                created.forEach(d => { if (!this.get(d.id)) this.create(d, { silent: true }); });
                this._emit('change');
            },
        });
        return out;
    }

    /**
     * Take over the materials of a scene state. STEP/import materials are matched to the current model
     * via their origin (their IDs are created anew on every import), all others via the ID.
     * @returns {Map<string, string>} stored ID -> current ID
     */
    restore(json) {
        const idMap = new Map();
        const taken = new Set();   // import materials already matched (the same file loaded twice)
        // older scenes: import origins without file name ("import:3") – match any file's material no. 3
        const legacy = o => /^import:\d+$/.test(o || '');
        const sameOrigin = (e, m) => e.def.origin === m.origin || (legacy(m.origin) && e.def.origin?.endsWith(':' + m.origin.slice(7)));
        for (const m of json?.materials || []) {
            let target = null;
            if (m.source === 'step' || m.source === 'import') {
                target = this.list.find(e => e.def.source === m.source && !taken.has(e) && sameOrigin(e, m)) || null;
                if (!target) continue;   // does not belong to the loaded model
                if (m.source === 'import') taken.add(target);
            } else {
                target = this.get(m.id);
                if (target && target.def.source !== m.source) target = null;
            }
            if (target) {
                target.def.name = m.name || target.def.name;
                target.def.params = { ...m.params };
                target.def.graph = m.graph ? structuredClone(m.graph)
                    : target.def.source === 'import' && hasGraphMaps(target.def.render) ? createImportGraph(target.def.render.maps) : null;
                target.def.modified = !!m.modified;
                target.material.name = target.def.name;
                this._apply(target);
            } else {
                target = this.create({ ...m }, { silent: true });
            }
            idMap.set(m.id, target.def.id);
        }
        this._emit('change');
        return idMap;
    }

    // --- internal ---

    // Remove a material for good (also undo of "create"); if it is still in use, it stays
    _delete(id) {
        const e = this.get(id);
        if (!e || this.usage(id) > 0) return;
        e.material.dispose();
        this.entries.delete(id);
        this._emit('change');
    }

    _recordEdit(id, label, before, mergeKey) {
        if (!this.history) return;
        const after = snapshot(this.get(id));
        if (JSON.stringify(before) === JSON.stringify(after)) return;   // e.g. node clicked, not moved
        this.history.record({
            label, mergeKey,
            undo: () => this._restoreSnapshot(id, before),
            redo: () => this._restoreSnapshot(id, after),
        });
    }

    _restoreSnapshot(id, s) {
        const e = this.get(id);
        if (!e) return;
        const renamed = e.def.name !== s.name;
        e.def.name = s.name;
        e.material.name = s.name;
        e.def.params = { ...s.params };
        e.def.graph = s.graph ? structuredClone(s.graph) : null;
        e.def.modified = s.modified;
        this._apply(e);
        this._emit('update', { id, restored: true });
        if (renamed) this._emit('change');
    }

    _apply(entry) {
        const { material, def } = entry;
        const p = { ...defaults(), ...def.params };
        material.color.set(p.color);
        material.metalness = p.metalness;
        material.roughness = p.roughness;
        material.specularIntensity = p.specularIntensity;
        material.clearcoat = p.clearcoat;
        material.clearcoatRoughness = p.clearcoatRoughness;
        material.transmission = p.transmission;
        material.ior = p.ior;
        material.thickness = p.thickness;
        material.attenuationColor.set(p.attenuationColor);
        material.attenuationDistance = p.attenuationDistance;
        material.sheen = p.sheen;
        material.sheenColor.set(p.sheenColor);
        material.sheenRoughness = p.sheenRoughness;
        material.iridescence = p.iridescence;
        material.emissive.set(p.emissive);
        material.emissiveIntensity = p.emissiveIntensity;
        material.opacity = p.opacity;
        material.transparent = p.opacity < 1;
        material.setSubsurface(p.subsurface, p.subsurfaceColor, p.subsurfaceRadius);   // after the physical params
        material.setMarble(p.marble, p.marbleColor, p.marbleScale);
        material.toon = p.toon > 0;
        material.flat = p.flat > 0;
        if (material.flat) {
            // flat: no diffuse response, the colour as emission – the path tracer shows it as it is too (no light
            // steps in HQ), the raster output takes the emission (toon.js)
            material.color.set(0x000000);
            material.emissive.set(p.color);
            material.emissiveIntensity = 1;
        }
        material.userData.contour = p.contour > 0 ? { color: p.contourColor, width: p.contourWidth } : null;
        if (def.render) applyRender(material, def.render, !!def.graph?.nodes?.length);
        material.needsUpdate = true;
        // Hook for the node editor (graph -> TSL/textures)
        this.onApply?.(entry);
    }

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}

// Textures and display properties of imported materials. With a node graph, graph-apply sets the
// maps of the graph inputs (IMPORT_SLOTS) itself – here only the remaining ones (alpha, bump, …).
// Without a graph all of them; when removing baked maps, graph-apply restores the import map from
// userData.importMaps.
function applyRender(material, r, hasGraph) {
    const baked = material.userData.graphMaps || {};
    const bakedSlots = new Set(Object.keys(baked).map(k => GRAPH_MAP_SLOTS[k]));
    for (const [key, tex] of Object.entries(r.maps || {})) {
        if (hasGraph ? !IMPORT_SLOTS[key] : !bakedSlots.has(key)) material[key] = tex;
    }
    material.userData.importMaps = r.maps || {};
    material.side = r.side ?? THREE.FrontSide;
    material.alphaTest = r.alphaTest || 0;
    if (r.transparent) material.transparent = true;
    if (r.normalScale && !baked.height) material.normalScale.fromArray(r.normalScale);
    material.bumpScale = r.bumpScale ?? 1;
    material.aoMapIntensity = r.aoMapIntensity ?? 1;
}
// Graph slot -> map property (like SLOTS in graph-apply.js)
const GRAPH_MAP_SLOTS = {
    color: 'map', metalness: 'metalnessMap', roughness: 'roughnessMap', clearcoat: 'clearcoatMap',
    clearcoatRoughness: 'clearcoatRoughnessMap', transmission: 'transmissionMap', sheen: 'sheenColorMap',
    emissive: 'emissiveMap', normal: 'normalMap', ao: 'aoMap', height: 'normalMap',
};

const hasGraphMaps = render => Object.keys(render?.maps || {}).some(k => IMPORT_SLOTS[k]);

// editable part of a material (undo)
function snapshot(entry) {
    const { def } = entry;
    return { name: def.name, params: { ...def.params }, graph: def.graph ? structuredClone(def.graph) : null, modified: def.modified };
}

function defaults() {
    return Object.fromEntries(PARAMS.map(p => [p.key, p.default]));
}

export { PARAM_BY_KEY };

// JSON with sorted keys (parameter order must not matter)
function stableJson(v) {
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
    return JSON.stringify(v ?? null);
}

// Content of a texture for comparisons: size, sampling settings and a 16×16 thumbnail of the picture (two
// imports of the same file are different objects with the same picture). Cached per texture.
const fingerprints = new WeakMap();
async function textureFingerprint(tex) {
    if (!tex) return null;
    if (fingerprints.has(tex)) return fingerprints.get(tex);
    const img = tex.image;
    const settings = [tex.wrapS, tex.wrapT, ...tex.repeat.toArray(), ...tex.offset.toArray(), tex.rotation, tex.flipY, tex.channel, tex.colorSpace];
    let pixels = '';
    try {
        if (img?.data) {
            // data texture: every n-th value
            const step = Math.max(1, Math.floor(img.data.length / 256));
            for (let i = 0; i < img.data.length; i += step) pixels += img.data[i] + ',';
        } else if (img?.width && img?.height) {
            const canvas = new OffscreenCanvas(16, 16);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, 16, 16);
            pixels = Array.from(ctx.getImageData(0, 0, 16, 16).data).join(',');
        } else if (tex.mipmaps?.[0]?.data) {
            // compressed (KTX2): bytes of the first level
            const d = tex.mipmaps[0].data, step = Math.max(1, Math.floor(d.length / 256));
            for (let i = 0; i < d.length; i += step) pixels += d[i] + ',';
        }
    } catch {
        pixels = tex.uuid;   // unreadable: never equal to another texture
    }
    const fp = `${img?.width || 0}x${img?.height || 0}|${settings.join(',')}|${pixels}`;
    fingerprints.set(tex, fp);
    return fp;
}
