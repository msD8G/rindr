// Applies the node graph of a material (hook MaterialManager.onApply):
//  - constant inputs -> material parameters (immediately)
//  - texture inputs -> baked maps (asynchronously, then onBaked -> update the path tracer)
//  - import texture directly at the matching input -> original texture as map (parameter = factor)
// If an imported material has a graph, the graph alone decides about the maps of these slots:
// unconnected inputs have no map (applyRender does not set them then).
import * as THREE from 'three/webgpu';
import { evaluateGraph, GraphBaker, loadImageTexture } from './material-graph.js';
import { PARAMS } from './material-manager.js';

const defaultParams = () => Object.fromEntries(PARAMS.map(p => [p.key, p.default]));

// input -> material property (value) / map / value when a map is set / sRGB map
const SLOTS = {
    color: { prop: 'color', map: 'map', unit: '#ffffff', srgb: true },
    metalness: { prop: 'metalness', map: 'metalnessMap', unit: 1 },
    roughness: { prop: 'roughness', map: 'roughnessMap', unit: 1 },
    clearcoat: { prop: 'clearcoat', map: 'clearcoatMap', unit: 1 },
    clearcoatRoughness: { prop: 'clearcoatRoughness', map: 'clearcoatRoughnessMap', unit: 1 },
    transmission: { prop: 'transmission', map: 'transmissionMap', unit: 1 },
    sheen: { prop: 'sheen', map: 'sheenColorMap', unit: 1 },
    emissive: { prop: 'emissive', map: 'emissiveMap', unit: '#ffffff', srgb: true },
    ao: { map: 'aoMap' },
    normal: { map: 'normalMap' },
    height: { map: 'normalMap' },   // after 'normal': relief takes precedence
};

export class GraphApplier {
    constructor(renderer, { onBaked } = {}) {
        this.baker = new GraphBaker(renderer);
        this.onBaked = onBaked || (() => {});
        this.images = new Map();     // Data-URL -> Promise<Texture>
        this.queue = Promise.resolve();
        this.pending = new Map();    // material ID -> timer
    }

    /** Synchronous part; schedules the baking */
    apply(entry) {
        const { material, def } = entry;
        const graph = def.graph;
        const maps = material.userData.graphMaps ||= {};
        if (!graph?.nodes?.length) {
            this._clearMaps(material, Object.keys(maps));
            return;
        }
        // images not loaded yet count as constant grey for now -> load, then evaluate again
        if (graph.nodes.some(n => n.type === 'image' && n.params?.image && !this.images.get(n.params.image)?.loaded)) {
            this._imageTextures(graph)
                .then(() => { if (entry.def.graph === graph) this.apply(entry); })
                .catch(err => console.error('[Material graph] Image could not be loaded:', err));
        }
        let result;
        try {
            result = evaluateGraph(graph, this._imageTexturesSync(graph), def.render?.maps);
        } catch (err) {
            console.warn('[Material graph]', err.message);
            return;
        }
        const textured = [];
        const params = { ...defaultParams(), ...def.params };
        const assigned = new Set();   // map properties occupied by an input (normalMap: normal/height)
        for (const [key, slot] of Object.entries(SLOTS)) {
            const r = result[key];
            if (!r || r.kind !== 'tsl') this._clearMaps(material, [key], null);
            if (!r) {
                if (!assigned.has(slot.map)) setMap(material, slot.map, null);
                continue;
            }
            assigned.add(slot.map);
            if (r.kind === 'const') {
                setMap(material, slot.map, null);
                if (slot.prop) setProp(material, slot.prop, r.value);
            } else if (r.kind === 'map') {
                material[slot.map] = r.texture;
                if (slot.prop) setProp(material, slot.prop, params[slot.prop]);   // parameter as factor
            } else {
                if (slot.prop) setProp(material, slot.prop, slot.unit);
                if (maps[key]) material[slot.map] = maps[key];   // until (re)baked: previous texture
                textured.push(key);
            }
        }
        if (result.height?.kind === 'tsl') material.normalScale.setScalar(1);
        material.needsUpdate = true;
        if (textured.length) this._schedule(entry);
    }

    _schedule(entry) {
        const id = entry.def.id;
        clearTimeout(this.pending.get(id));
        this.pending.set(id, setTimeout(() => {
            this.pending.delete(id);
            // bake one after another (one bake target)
            this.queue = this.queue.then(() => this._bake(entry)).catch(err => console.error('[Material graph] Baking failed:', err));
        }, 150));
    }

    async _bake(entry) {
        const { material, def } = entry;
        const graph = def.graph;
        if (!graph) return;
        const images = await this._imageTextures(graph);
        const result = evaluateGraph(graph, images, def.render?.maps);
        const maps = material.userData.graphMaps ||= {};
        const sigs = material.userData.graphSigs ||= {};
        let changed = false;
        for (const [key, slot] of Object.entries(SLOTS)) {
            const r = result[key];
            if (!r || r.kind !== 'tsl') continue;
            const sig = (key === 'height' ? r.sig + '|' + result.reliefStrength : r.sig) + '|' + r.size;
            if (maps[key] && sigs[key] === sig) {
                material[slot.map] = maps[key];   // unchanged -> keep the existing texture
                continue;
            }
            if (entry.def.graph !== graph) return;   // changed in the meantime -> a new run follows
            const tex = key === 'height'
                ? await this.baker.bakeNormal(r.node, result.reliefStrength, r.size)
                : await this.baker.bake(r.node, r.type, { srgb: !!slot.srgb, size: r.size });
            if (entry.def.graph !== graph) { tex.dispose(); return; }   // changed in the meantime
            maps[key]?.dispose();
            maps[key] = tex;
            sigs[key] = sig;
            material[slot.map] = tex;
            if (key === 'sheen') material.sheenColor.set('#ffffff');
            changed = true;
        }
        if (!changed) return;
        material.needsUpdate = true;
        this.onBaked(entry);
    }

    // Dispose baked maps. fallback undefined: put the imported texture (glTF/FBX) back
    // (material without graph), otherwise this value – apply() sets the map itself afterwards anyway.
    _clearMaps(material, keys, fallback) {
        const maps = material.userData.graphMaps || {};
        for (const key of keys) {
            if (!maps[key]) continue;
            if (material[SLOTS[key].map] === maps[key]) {
                setMap(material, SLOTS[key].map, fallback !== undefined ? fallback : material.userData.importMaps?.[SLOTS[key].map] ?? null);
            }
            maps[key].dispose();
            delete maps[key];
            delete material.userData.graphSigs?.[key];
            material.needsUpdate = true;
        }
    }

    // image textures: for the synchronous evaluation only those already loaded
    _imageTexturesSync(graph) {
        const out = new Map();
        for (const n of graph.nodes) {
            if (n.type === 'image' && n.params?.image && this.images.get(n.params.image)?.loaded) {
                out.set(n.id, this.images.get(n.params.image).loaded);
            }
        }
        return out;
    }

    async _imageTextures(graph) {
        const out = new Map();
        for (const n of graph.nodes) {
            const url = n.type === 'image' && n.params?.image;
            if (!url) continue;
            let entry = this.images.get(url);
            if (!entry) {
                entry = { promise: loadImageTexture(url) };
                entry.promise.then(t => { entry.loaded = t; });
                this.images.set(url, entry);
            }
            out.set(n.id, await entry.promise);
        }
        return out;
    }
}

// Workaround three.js r186 (Renderer._getShadowNodes): if a material had a color map, the shared
// shadow material keeps its color node even after the map was removed
// ("if (colorNode !== null)") -> the shadow pass reads map = null -> "reading 'matrix' of null",
// the render loop aborts. Hence never set the color map to null, but to white (× color = color).
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.colorSpace = THREE.SRGBColorSpace;
WHITE.needsUpdate = true;

function setMap(material, key, texture) {
    if (!texture && key === 'map' && material.map) texture = WHITE;
    if (material[key] !== texture) material[key] = texture;
}

function setProp(material, prop, value) {
    const target = material[prop];
    if (target?.isColor) {
        if (value?.isColor) target.copy(value); else target.set(value);
    } else {
        material[prop] = typeof value === 'number' ? value : Number(value);
    }
}
