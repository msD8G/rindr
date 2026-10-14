// IFC import (BIM: .ifc, .ifczip) – web-ifc in ifc-worker.js builds the geometry; converted here into the same
// structure as the other imports (nodes / geometries / meshes, see mesh-importer.js). Units: web-ifc delivers
// metres → mm via the mesh matrices. Materials: one per surface style / IFC material + colour (Revit names the
// styles after the material: "Glas", "StB - Ortbeton" …), transparent ones become glass. The worker stays alive
// for the properties panel (result.bim.properties) until the model is removed (bim.dispose).
import { boxUVs, buildGeometryBVHs, UV_TILE } from '../step-importer.js';
import { readZip } from '../splat/splat-formats.js';
import { t, has } from '../i18n.js';

export const IFC_EXTENSIONS = ['ifc', 'ifczip'];
const MM = 1000;

export async function importIfc(source, { materialManager, onStatus = () => {}, bvh = false }) {
    const t0 = performance.now();
    onStatus(t('import.mesh.reading', { name: source.name }));
    let main = source.main;
    if (!main) {
        const res = await fetch(source.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        main = await res.blob();
    }
    let buffer = await main.arrayBuffer();
    if (source.name.toLowerCase().endsWith('.ifczip')) buffer = await unzipIfc(buffer);

    const bim = new BimWorker();
    let data;
    try {
        onStatus(t('bim.status.building'));
        data = await bim.request({ type: 'open', buffer }, [buffer]);
    } catch (err) {
        bim.dispose();
        throw err;
    }
    const { nodes, geometries, meshes: placed, styles, stats, origin, project } = data;
    if (!placed.length) { bim.dispose(); throw new Error(t('import.mesh.noFaces')); }

    // node names: class groups and unnamed elements get a readable label
    for (const n of nodes) {
        const label = classLabel(n.ifc.type);
        n.name = n.ifc.group ? `${label} (${n.ifc.count})` : n.name || label;
    }
    for (const g of geometries) g.uvs = boxUVs(g.positions, g.normals, UV_TILE / MM);
    const materialIds = styles.map(s => materialManager.create({ ...styleMaterial(s), source: 'import', origin: `import:${source.name}:${s.key}` }, { silent: true }).def.id);
    const meshes = placed.map((m, i) => {
        const e = m.matrix;
        for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) e[c * 4 + r] *= MM;   // metres → mm
        return { geometry: m.geometry, matrix: e, materialId: materialIds[m.style], name: nodes[m.node]?.name, node: m.node ?? -1,
            instance: i, countId: `ifc${m.element}`, key: `${m.element}/${m.part}` };   // own instance per geometry (same geometry repeats within an element)
    });
    const t1 = performance.now();
    if (bvh) await buildGeometryBVHs(geometries, onStatus);
    console.info('[Import] IFC', { ...stats, nodes: nodes.length, geometries: geometries.length, meshes: meshes.length, materials: styles.length,
        loadMs: Math.round(t1 - t0), bvhMs: Math.round(performance.now() - t1) });
    return {
        nodes, geometries, meshes, missing: [],
        stats: { format: 'ifc', geometries: geometries.length, meshes: meshes.length, triangles: stats.triangles, missingFiles: [] },
        bim: { schema: stats.schema, origin, project, fileName: source.name, properties: expressID => bim.request({ type: 'props', expressID }), dispose: () => bim.dispose() },
    };
}

// .ifczip: the first .ifc inside
async function unzipIfc(buffer) {
    const zip = readZip(buffer);
    const name = [...zip.keys()].find(n => n.toLowerCase().endsWith('.ifc'));
    if (!name) throw new Error(t('bim.errors.noIfcInZip'));
    const data = await zip.get(name)();
    return data.buffer.byteLength === data.byteLength ? data.buffer : data.slice().buffer;
}

// readable label of an IFC class ("IFCWALL" → "Wände"); unknown classes: the class name itself
export function classLabel(type) {
    const key = `bim.classes.${type}`;
    return has(key) ? t(key) : type.replace(/^IFC/, 'Ifc');
}

// colour from the file (sRGB) + a guess from the name: glass/transparent → transmissive, metal → metallic
function styleMaterial({ name, color }) {
    const hex = '#' + color.slice(0, 3).map(c => Math.round(Math.min(Math.max(c, 0), 1) * 255).toString(16).padStart(2, '0')).join('');
    const n = (name || '').toLowerCase();
    const params = { color: hex, metalness: 0, roughness: 0.6, opacity: 1 };
    if (color[3] < 0.95 || /glas|glass|verglas/.test(n)) Object.assign(params, { roughness: 0.02, transmission: 1, ior: 1.5, thickness: 6 });
    else if (/metall|metal|stahl|steel|alu|chrom|verzink|zink|kupfer|copper|messing|edelstahl/.test(n)) Object.assign(params, { metalness: 1, roughness: /chrom/.test(n) ? 0.08 : 0.35 });
    return { name: name || t('bim.material.color', { color: hex.toUpperCase() }), params };
}

// worker with request/response by id
class BimWorker {
    constructor() {
        this.worker = new Worker(new URL('./ifc-worker.js', import.meta.url), { type: 'module' });
        this.pending = new Map();
        this.seq = 0;
        this.worker.onmessage = ({ data }) => {
            const p = this.pending.get(data.id);
            if (!p) return;
            this.pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error));
            else p.resolve(data.result);
        };
        this.worker.onerror = e => {
            const err = new Error(e.message || 'IFC worker failed');
            for (const p of this.pending.values()) p.reject(err);
            this.pending.clear();
        };
    }
    request(msg, transfer = []) {
        if (!this.worker) return Promise.reject(new Error('IFC worker disposed'));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...msg, id }, transfer);
        });
    }
    dispose() {
        this.worker?.terminate();
        this.worker = null;
        const err = new DOMException('IFC model closed', 'AbortError');
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
    }
}
