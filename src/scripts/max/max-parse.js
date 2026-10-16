// Reader for MAX scene files (.max) – own implementation from analysing files (no public format
// description; no foreign code used). What a .max file is:
//   - a Compound File (OLE structured storage, like old Office files): a FAT of sectors holding named streams
//   - the stream "Scene": a tree of chunks (u16 id, u32 length incl. header, top bit = container; length 0 → u64
//     length follows, top bit = container). Its root holds one chunk per scene object (nodes, objects, controllers,
//     materials, maps, parameter blocks …); the chunk id is an index into "ClassDirectory3" (class id, super class
//     id, name), objects refer to each other by their position in that list (chunk 0x2034: slot order,
//     0x2035: count + (slot, index) pairs)
//   - "Config": scene settings (0x2090: system unit), "FileAssetMetaData3": external files (GUID → path)
// Read here: nodes (name, parent, transform from Position/Rotation/Scale controllers, object offset, wire colour),
// Editable Mesh / Editable Poly (vertices, faces, smoothing groups, material IDs, UV channel 1), materials
// (Physical Material parameters, Multi/Sub-Object, the 24×24 preview swatch of any other material as colour) and
// bitmap file names. Modifiers are not evaluated: objects whose stack changes the geometry (Shell, Extrude,
// TurboSmooth …) are left out and reported; Smooth / UVW Map are harmless and skipped.
//
// Modifier stacks that max-modifiers.js can evaluate (Extrude on splines, Shell) are rebuilt from their parameters.
//
// Pure functions – runs in a worker (max-worker.js) and in Node (tests). Positions stay in file units (the importer
// scales to mm), Z up.

import { creaseCornerNormals } from '../crease-normals.js';
import { readShape, extrude, shell, primitive, polyToRaw, gizmoSpace, bend, ffd, noise, moveVertices, turboSmooth, capHoles, sweepSplines } from './max-modifiers.js';

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Is this a compound file (all .max files are)? */
export function isCompoundFile(buffer) {
    if (buffer.byteLength < 512) return false;
    const b = new Uint8Array(buffer, 0, 8);
    return CFB_MAGIC.every((v, i) => b[i] === v);
}

// --- compound file ---

const END = 0xfffffffa;   // ≥: free / end of chain / FAT / DIFAT sector markers

/** Streams of a compound file: stream(name) → Uint8Array (a view into the file when its sectors are in order) */
export function openCompound(buffer) {
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const shift = dv.getUint16(30, true), sectorSize = 1 << shift, miniSize = 1 << dv.getUint16(32, true);
    const fatCount = dv.getUint32(44, true), dirStart = dv.getUint32(48, true), miniCutoff = dv.getUint32(56, true);
    const miniFatStart = dv.getUint32(60, true), miniFatCount = dv.getUint32(64, true);
    let difat = dv.getUint32(68, true);
    const offset = s => (s + 1) * sectorSize;
    // FAT: sector numbers from the header (109) and the DIFAT chain
    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) fatSectors.push(dv.getUint32(76 + i * 4, true));
    for (let guard = 0; difat < END && fatSectors.length < fatCount && guard < 1e6; guard++) {
        const o = offset(difat);
        for (let i = 0; i < sectorSize / 4 - 1 && fatSectors.length < fatCount; i++) fatSectors.push(dv.getUint32(o + i * 4, true));
        difat = dv.getUint32(o + sectorSize - 4, true);
    }
    const perSector = sectorSize / 4;
    const fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((s, i) => { const o = offset(s); for (let j = 0; j < perSector; j++) fat[i * perSector + j] = dv.getUint32(o + j * 4, true); });
    const chain = (start, table, limit) => {
        const out = [];
        for (let s = start; s < END; s = table[s]) {
            if (s >= table.length || out.length > limit) throw new Error('MAX: broken sector chain');
            out.push(s);
        }
        return out;
    };
    const maxSectors = Math.ceil(buffer.byteLength / sectorSize) + 1;
    // bytes of a chain: a view when the sectors follow each other (large Scene streams – no copy), else a copy
    const readChain = (start, size) => {
        const sectors = chain(start, fat, maxSectors);
        const n = Math.min(size, sectors.length * sectorSize);
        let inOrder = true;
        for (let i = 1; i < sectors.length && inOrder; i++) inOrder = sectors[i] === sectors[i - 1] + 1;
        if (inOrder && sectors.length) return bytes.subarray(offset(sectors[0]), offset(sectors[0]) + n);
        const out = new Uint8Array(n);
        sectors.forEach((s, i) => { const len = Math.min(sectorSize, n - i * sectorSize); if (len > 0) out.set(bytes.subarray(offset(s), offset(s) + len), i * sectorSize); });
        return out;
    };
    const dir = readChain(dirStart, Infinity);
    const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const entries = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
        const nameLen = ddv.getUint16(o + 64, true);
        let name = '';
        for (let i = 0; i + 2 < nameLen; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
        // stream size: 64-bit field, version 3 files use only the low half
        entries.push({ name, type: dir[o + 66], start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) + (shift > 9 ? ddv.getUint32(o + 124, true) * 2 ** 32 : 0) });
    }
    const root = entries[0];
    let mini = null, miniFat = null;
    const miniStream = () => {
        if (mini) return;
        mini = readChain(root.start, root.size);
        const raw = miniFatCount ? readChain(miniFatStart, miniFatCount * sectorSize) : new Uint8Array(0);
        const mdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        miniFat = new Uint32Array(raw.length / 4);
        for (let i = 0; i < miniFat.length; i++) miniFat[i] = mdv.getUint32(i * 4, true);
    };
    const stream = name => {
        // names may carry a leading control character (\x05SummaryInformation)
        const e = entries.find(x => x.type === 2 && x.name.replace(/^[\x00-\x1f]/, '') === name);
        if (!e) return null;
        if (e.size >= miniCutoff) return readChain(e.start, e.size);
        miniStream();
        const sectors = chain(e.start, miniFat, mini.length / miniSize + 1);
        const out = new Uint8Array(e.size);
        sectors.forEach((s, i) => { const len = Math.min(miniSize, e.size - i * miniSize); if (len > 0) out.set(mini.subarray(s * miniSize, s * miniSize + len), i * miniSize); });
        return out;
    };
    return { stream, names: entries.filter(e => e.type === 2).map(e => e.name) };
}

// --- chunks ---

/** Chunk lists of one stream; children are parsed on demand (meshes hold hundreds of thousands of sub-chunks) */
class Chunks {
    constructor(bytes) {
        this.b = bytes;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    /** Chunks between start and end, or null when the bytes are no valid chunk list */
    list(start = 0, end = this.b.length) {
        const out = [];
        const dv = this.dv;
        let o = start;
        while (o + 6 <= end) {
            const id = dv.getUint16(o, true);
            let len = dv.getUint32(o + 2, true), head = 6, container;
            if (len === 0) {
                if (o + 14 > end) return null;
                const lo = dv.getUint32(o + 6, true), hi = dv.getUint32(o + 10, true);
                container = (hi & 0x80000000) !== 0;
                len = (hi & 0x7fffffff) * 2 ** 32 + lo;
                head = 14;
            } else {
                container = (len & 0x80000000) !== 0;
                len &= 0x7fffffff;
            }
            if (len < head || o + len > end) return null;
            out.push({ id, start: o + head, end: o + len, container });
            o += len;
        }
        return o === end ? out : null;
    }
    children(c) {
        if (!c?.container) return [];
        return (c.kids ??= this.list(c.start, c.end) || []);
    }
    child(c, id) {
        return this.children(c).find(k => k.id === id) || null;
    }
    size(c) { return c ? c.end - c.start : 0; }
    u32(c, k = 0) { return this.dv.getUint32(c.start + k * 4, true); }
    i32(c, k = 0) { return this.dv.getInt32(c.start + k * 4, true); }
    f32(c, k = 0) { return this.dv.getFloat32(c.start + k * 4, true); }
    floats(c, n, from = 0) { const a = []; for (let i = 0; i < n; i++) a.push(this.dv.getFloat32(c.start + from + i * 4, true)); return a; }
    /** UTF-16 text of a leaf chunk (without trailing zeros) */
    text(c) {
        if (!c) return '';
        let s = '';
        for (let o = c.start; o + 1 < c.end; o += 2) {
            const ch = this.dv.getUint16(o, true);
            if (!ch) break;
            s += String.fromCharCode(ch);
        }
        return s;
    }
}

// --- class ids (stable across languages; the names in the file are localised). A class id is unique only
// together with its super class (Node, Scanline Renderer and Grid Reference all have 1:0) ---

const cid = (superId, a, b = 0) => `${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}/${superId.toString(16)}`;
const CLASS = {
    node: cid(0x1, 0x1), editableMesh: cid(0x10, 0xe44f10b3), triMesh: cid(0x10, 0x9), editablePoly: cid(0x10, 0x1bf8338d, 0x192f6098),
    prs: cid(0x9008, 0x2005), lookAt: cid(0x9008, 0x2006), positionXYZ: cid(0x900b, 0x118f7e02, 0xffee238a), eulerXYZ: cid(0x900c, 0x2012),
    positionList: cid(0x900b, 0x4b4b1002), rotationList: cid(0x900c, 0x4b4b1003), scaleList: cid(0x900d, 0x4b4b1004),
    physical: cid(0xc00, 0x3d6b1cec, 0xdeadc001), multiSub: cid(0xc00, 0x200), bitmap: cid(0xc10, 0x240),
    smooth: cid(0x810, 0xf8613), uvwMap: cid(0x810, 0xf72b1), text: cid(0x40, 0x1993),
    extrude: cid(0x810, 0xa0), shell: cid(0x810, 0x3b9b1a16, 0x6d84e8d0), bend: cid(0x810, 0x10), ffd4: cid(0x810, 0x21325596, 0x2cd10bd8),
    turboSmooth: cid(0x810, 0xd727b3e, 0x491d29a7), noise: cid(0x810, 0xf997b124), editPoly: cid(0x810, 0x79aa6e1d, 0x71a075b7), optimize: cid(0x810, 0xc4d31),
};
// primitives rebuilt from their parameters (max-modifiers.js)
const PRIMITIVES = new Map([
    [cid(0x10, 0x10), 'box'], [cid(0x10, 0x11), 'sphere'], [cid(0x10, 0x12), 'cylinder'], [cid(0x10, 0x20), 'torus'],
    [cid(0x10, 0xa86c23dd), 'cone'], [cid(0x10, 0, 0x7f9e), 'geosphere'], [cid(0x10, 0x76bf318a, 0x4bf37b10), 'pyramid'],
]);
const DERIVED = 0x2032;   // derived object (modifier stack) – not in the class directory
const GEOMETRY = new Set([CLASS.editableMesh, CLASS.triMesh, CLASS.editablePoly]);
// smoothing / UVs only, or fewer faces of the same shape (Optimize)
const HARMLESS_MODIFIERS = new Set([CLASS.smooth, CLASS.uvwMap, CLASS.optimize]);
// not seen in a test file yet (class id unknown) – recognised by their English names: same shape with finer faces
// (Subdivide; Tessellate rounds slightly when its tension is set → approximated), Cap Holes rebuilt
const BY_NAME = { Subdivide: { type: 'none' }, Tessellate: { type: 'none', approx: true }, 'Cap Holes': { type: 'capholes' }, 'Unwrap UVW': { type: 'none' }, 'UVW Xform': { type: 'none' } };
// geometry classes that render nothing of their own: camera/light targets, V-Ray's infinite plane (our ground)
const NOT_RENDERED = new Set([cid(0x10, 0x1020), cid(0x10, 0x628140f6, 0x3bdb0e0c)]);
const SUPER = { geometry: 0x10, shape: 0x40, helper: 0x50, light: 0x30, camera: 0x20, modifier: 0x810 };

// system unit (Config 0x2090) → mm
const UNIT_MM = [25.4, 304.8, 1609344, 1, 10, 1000, 1e6];   // inches, feet, miles, mm, cm, m, km

/**
 * Scene description of a .max file (everything except the mesh data).
 * @param {ArrayBuffer} buffer
 * @param {(bytes: Uint8Array) => Promise<Uint8Array>} gunzip for files saved with "Compress on save"
 */
export async function describeMax(buffer, gunzip) {
    const cfb = openCompound(buffer);
    const read = async name => {
        const s = cfb.stream(name);
        if (s && s.length > 2 && s[0] === 0x1f && s[1] === 0x8b) return gunzip(s);   // compressed scene
        return s;
    };
    const sceneBytes = await read('Scene');
    if (!sceneBytes) throw new Error('MAX: no scene in the file');
    const classBytes = await read('ClassDirectory3') || await read('ClassDirectory2') || await read('ClassDirectory');
    if (!classBytes) throw new Error('MAX: no class directory');

    // class directory: index → { id, superId, name }
    const cc = new Chunks(classBytes);
    const classes = (cc.list() || []).map(e => {
        const h = cc.child(e, 0x2060), n = cc.child(e, 0x2042);
        return h ? { id: cid(cc.u32(h, 3), cc.u32(h, 1), cc.u32(h, 2)), superId: cc.u32(h, 3), name: cc.text(n) } : { id: '', superId: 0, name: '' };
    });
    // unit
    let unitMm = UNIT_MM[0];
    const config = await read('Config');
    if (config) {
        const k = new Chunks(config);
        const u = (k.list() || []).find(c => c.id === 0x2090 && !c.container && k.size(c) >= 4);
        if (u) unitMm = UNIT_MM[k.u32(u)] ?? unitMm;
    }
    // external files: GUID → path (Bitmap textures)
    const assets = new Map();
    const assetBytes = await read('FileAssetMetaData3');
    if (assetBytes) {
        const dv = new DataView(assetBytes.buffer, assetBytes.byteOffset, assetBytes.byteLength);
        let o = 0;
        const str = () => {
            const n = dv.getUint32(o, true);
            let s = '';
            for (let i = 0; i < n; i++) { const ch = dv.getUint16(o + 4 + i * 2, true); if (ch) s += String.fromCharCode(ch); }
            o += 4 + n * 2 + 2;
            return s;
        };
        try {
            while (o + 20 <= assetBytes.length) {
                const guid = hex(assetBytes.subarray(o, o + 16));
                o += 16;
                str();                // type ("Bitmap", "RenderOutput" …)
                const path = str();
                str();                // second path (resolved)
                assets.set(guid, path);
            }
        } catch { /* layout of another version: textures stay unnamed */ }
    }

    const sc = new Chunks(sceneBytes);
    const top = sc.list();
    if (!top?.length || !top[0].container) throw new Error('MAX: unknown scene layout');
    const objects = sc.children(top[0]);
    const classOf = i => (objects[i] ? classes[objects[i].id] ?? null : null);
    const idOf = i => classOf(i)?.id ?? '';
    const refsCache = new Map();
    // references of an object: Map slot → object index
    const refs = i => {
        if (refsCache.has(i)) return refsCache.get(i);
        const out = new Map();
        const c = objects[i];
        const r = c && sc.children(c).find(k => k.id === 0x2034 || k.id === 0x2035);
        if (r) {
            const n = sc.size(r) / 4;
            if (r.id === 0x2034) for (let k = 0; k < n; k++) { const x = sc.i32(r, k); if (x >= 0) out.set(k, x); }
            else for (let k = 1; k + 1 < n; k += 2) { const x = sc.i32(r, k + 1); if (x >= 0) out.set(sc.i32(r, k), x); }
        }
        refsCache.set(i, out);
        return out;
    };
    const ref = (i, slot) => refs(i).get(slot) ?? -1;
    // left out: modifiers / object classes by name (counted per scene node), unknown transform controllers
    const unsupported = { modifiers: new Map(), objects: new Map(), controllers: new Map(), approx: new Map(), nodes: 0 };
    const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);

    // --- controllers ---
    // value of a float controller (Bezier/linear float: 0x7127 > 0x2501, or 0x2501 directly)
    const valueChunk = (i, id) => {
        const c = objects[i];
        if (!c) return null;
        const keys = sc.child(c, 0x7127);
        return (keys && sc.child(keys, id)) || sc.child(c, id);
    };
    const floatValue = i => { const v = valueChunk(i, 0x2501); return v && sc.size(v) >= 4 ? sc.f32(v) : 0; };
    const position = i => {
        if (i < 0) return [0, 0, 0];
        const id = idOf(i);
        if (id === CLASS.positionXYZ) return [0, 1, 2].map(k => floatValue(ref(i, k)));
        if (id === CLASS.positionList) {   // sum of the list's controllers (weights ignored)
            const p = [0, 0, 0];
            for (const [, x] of refs(i)) { if (classOf(x)?.superId !== 0x900b) continue; const q = position(x); p[0] += q[0]; p[1] += q[1]; p[2] += q[2]; }
            return p;
        }
        const v = valueChunk(i, 0x2503);   // Bezier / linear / TCB position: point3
        if (v && sc.size(v) >= 12) return sc.floats(v, 3);
        if (reportControllers) count(unsupported.controllers, classOf(i)?.name || '?');
        return [0, 0, 0];
    };
    // rotation: { euler: [x, y, z] (radians), order } or { quat: [x, y, z, w] (standard sense) }
    const rotation = i => {
        if (i < 0) return { quat: [0, 0, 0, 1] };
        const id = idOf(i);
        if (id === CLASS.eulerXYZ) {
            const o = sc.child(objects[i], 0x1003);
            return { euler: [0, 1, 2].map(k => floatValue(ref(i, k))), order: o && sc.size(o) >= 4 ? sc.u32(o) : 0 };
        }
        if (id === CLASS.rotationList) return { list: [...refs(i).values()].filter(x => classOf(x)?.superId === 0x900c).map(rotation) };
        const v = valueChunk(i, 0x2504);   // Bezier / linear / TCB rotation: quaternion (MAX: opposite angle sense)
        if (v && sc.size(v) >= 16) { const [x, y, z, w] = sc.floats(v, 4); return { quat: [-x, -y, -z, w] }; }
        if (reportControllers) count(unsupported.controllers, classOf(i)?.name || '?');
        return { quat: [0, 0, 0, 1] };
    };
    // scale: [x, y, z] + axis quaternion
    const scale = i => {
        if (i < 0) return { scale: [1, 1, 1], axis: [0, 0, 0, 1] };
        if (idOf(i) === CLASS.scaleList) {
            const s = [1, 1, 1];
            for (const [, x] of refs(i)) { if (classOf(x)?.superId !== 0x900d) continue; const q = scale(x).scale; s[0] *= q[0]; s[1] *= q[1]; s[2] *= q[2]; }
            return { scale: s, axis: [0, 0, 0, 1] };
        }
        const v = valueChunk(i, 0x2505);
        if (v && sc.size(v) >= 28) { const f = sc.floats(v, 7); return { scale: f.slice(0, 3), axis: [-f[3], -f[4], -f[5], f[6]] }; }
        return { scale: [1, 1, 1], axis: [0, 0, 0, 1] };
    };
    let reportControllers = true;   // only for nodes that are shown (lights, cameras … do not matter)
    const transform = (i, report) => {
        reportControllers = report;
        try { return transformOf(i); } finally { reportControllers = true; }
    };
    const transformOf = i => {
        const id = idOf(i);
        if (id === CLASS.prs) { const s = scale(ref(i, 2)); return { position: position(ref(i, 0)), rotation: rotation(ref(i, 1)), scale: s.scale, scaleAxis: s.axis }; }
        if (i >= 0 && id !== CLASS.lookAt && reportControllers) count(unsupported.controllers, classOf(i)?.name || '?');
        return { position: [0, 0, 0], rotation: { quat: [0, 0, 0, 1] }, scale: [1, 1, 1], scaleAxis: [0, 0, 0, 1] };
    };

    // --- materials ---
    const materials = [], materialOf = new Map(), textures = [], textureOf = new Map();
    // parameter block 2: id → { type, at (byte offset of the value), chunk }, plus the reference slot of map params
    const paramBlock = i => {
        const params = new Map();
        const c = objects[i];
        if (!c) return params;
        let slot = 0;
        for (const k of sc.children(c)) {
            if (k.id !== 0x100e || k.container || sc.size(k) < 15) continue;
            const id = sc.dv.getUint16(k.start, true), type = sc.dv.getUint32(k.start + 2, true);
            const p = { type, at: k.start + 15, end: k.end };
            if (type === 15 || type === 14) p.slot = slot++;   // texmap / material: references in parameter order
            params.set(id, p);
        }
        return params;
    };
    // parameter block (version 1, older modifiers such as Extrude): index → number (0x0002 { 0x0003 index, 0x0100 float | 0x0101 int })
    const paramBlock1 = i => {
        const out = new Map();
        const c = objects[i];
        if (!c) return out;
        for (const k of sc.children(c)) {
            if (k.id !== 0x0002 || !k.container) continue;
            const idx = sc.child(k, 0x0003), f = sc.child(k, 0x0100), n = sc.child(k, 0x0101), v = sc.child(k, 0x0103);
            if (!idx) continue;
            if (f && sc.size(f) >= 4) out.set(sc.u32(idx), sc.f32(f));
            else if (n && sc.size(n) >= 4) out.set(sc.u32(idx), sc.i32(n));
            else if (v && sc.size(v) >= 12) out.set(sc.u32(idx), sc.floats(v, 3));   // point3
        }
        return out;
    };
    const pFloat = (P, id, d) => { const p = P.get(id); return p && p.end - p.at >= 4 && p.type !== 23 ? sc.dv.getFloat32(p.at, true) : d; };
    const pInt = (P, id, d) => { const p = P.get(id); return p && p.end - p.at >= 4 ? sc.dv.getInt32(p.at, true) : d; };
    const pColor = (P, id) => { const p = P.get(id); return p && p.type === 23 && p.end - p.at >= 12 ? [0, 1, 2].map(k => sc.dv.getFloat32(p.at + k * 4, true)) : null; };
    // texture of a map (Bitmap: file name via the asset GUID); other maps → null
    const texture = i => {
        if (i < 0 || idOf(i) !== CLASS.bitmap) return -1;
        if (textureOf.has(i)) return textureOf.get(i);
        let file = '';
        // GUID somewhere in the Bitmap's parameter block (0x1260 > 0x0002, 16 bytes)
        const find = c => {
            for (const k of sc.children(c)) {
                if (k.id === 0x1260 && k.container) { const g = sc.child(k, 0x0002); if (g && sc.size(g) === 16) return hex(sc.b.subarray(g.start, g.end)); }
                if (k.container) { const r = find(k); if (r) return r; }
            }
            return null;
        };
        for (const [, x] of refs(i)) {
            const guid = objects[x]?.container ? find(objects[x]) : null;
            if (guid && assets.has(guid)) { file = assets.get(guid); break; }
        }
        const t = file ? textures.push({ file }) - 1 : -1;
        textureOf.set(i, t);
        return t;
    };
    // preview swatch of a material (MtlBase 0x0100 > 0x4200: size × size pixels, BGR like Windows bitmaps) → average
    // of the centre (sRGB 0–1)
    const swatch = c => {
        const base = sc.child(c, 0x0100) || sc.child(c, 0x4000);
        const img = base && sc.child(base, 0x4200), sz = base && sc.child(base, 0x4210);
        const n = sz ? sc.u32(sz) : 24;
        if (!img || sc.size(img) < n * n * 3) return null;
        const sum = [0, 0, 0];
        let k = 0;
        for (let y = Math.floor(n * 0.3); y < Math.ceil(n * 0.6); y++) for (let x = Math.floor(n * 0.3); x < Math.ceil(n * 0.6); x++, k++)
            for (let ch = 0; ch < 3; ch++) sum[ch] += sc.b[img.start + (y * n + x) * 3 + ch];
        return k ? [sum[2], sum[1], sum[0]].map(v => v / k / 255) : null;
    };
    const materialName = c => { const base = sc.child(c, 0x0100) || sc.child(c, 0x4000); return base ? sc.text(sc.child(base, 0x4001)) : ''; };
    const material = i => {
        if (i < 0 || !objects[i]) return -1;
        if (materialOf.has(i)) return materialOf.get(i);
        const c = objects[i], id = idOf(i);
        const m = { name: materialName(c), kind: 'other', color: null, sub: null };
        const index = materials.push(m) - 1;
        materialOf.set(i, index);
        if (id === CLASS.multiSub) {
            m.kind = 'multi';
            const slots = [...refs(i)].filter(([s, x]) => s > 0 && classOf(x)?.superId === 0xc00).sort((a, b) => a[0] - b[0]);
            m.sub = slots.map(([, x]) => material(x));
        } else if (id === CLASS.physical) {
            // Physical Material parameter ids (order of its parameter block)
            const pb = ref(i, 0), P = paramBlock(pb);
            m.kind = 'physical';
            m.color = pColor(P, 0x02);
            m.baseWeight = pFloat(P, 0x01, 1);
            m.roughness = pFloat(P, 0x04, 0);
            m.roughnessInverted = pInt(P, 0x05, 0) !== 0;
            m.metalness = pFloat(P, 0x06, 0);
            m.transparency = pFloat(P, 0x1e, 0);
            m.transColor = pColor(P, 0x1f);
            m.ior = pFloat(P, 0x21, 1.52);
            m.emission = pFloat(P, 0x32, 0);
            m.emitColor = pColor(P, 0x33);
            m.coating = pFloat(P, 0x3c, 0);
            m.coatRoughness = pFloat(P, 0x3e, 0);
            const map = pid => { const p = P.get(pid); return p?.slot != null ? texture(ref(pb, p.slot)) : -1; };
            m.map = map(0x65);
            m.roughnessMap = map(0x68);
            m.bumpMap = map(0x82);
            m.cutoutMap = map(0x85);
        }
        m.preview = swatch(c);   // colour of MAX' material preview (shows the look with its maps)
        if (!m.color) m.color = m.preview;   // other materials (Standard, V-Ray …)
        return index;
    };

    // --- objects: base object behind modifier stacks ---
    const geometries = [], geometryOf = new Map();   // object → { g, skip: [modifier/class names] }
    // mods: top first, each with its context in the derived object (0x2500: 0x2510 TM, 0x2511 box, 0x2512 local data)
    const baseObject = i => {
        const mods = [];
        for (let guard = 0; objects[i]?.id === DERIVED && guard < 64; guard++) {
            let next = -1;
            const contexts = sc.children(objects[i]).filter(k => k.id === 0x2500);
            let m = 0;
            for (const [, x] of [...refs(i)].sort((a, b) => a[0] - b[0])) {
                const k = classOf(x);
                if (objects[x]?.id === DERIVED || (k && (k.superId === SUPER.geometry || k.superId === SUPER.shape))) next = x;
                else if (k?.superId === SUPER.modifier) mods.push({ x, ctx: context(contexts[m++]) });
            }
            if (next < 0) break;
            i = next;
        }
        return { base: i, mods };
    };
    const context = c => {
        if (!c) return { tm: null, box: null, local: null };
        const t = sc.child(c, 0x2510), b = sc.child(c, 0x2511);
        return { tm: t && sc.size(t) >= 48 ? sc.floats(t, 12) : null, box: b && sc.size(b) >= 24 ? sc.floats(b, 6) : null, local: sc.child(c, 0x2512) };
    };
    // evaluable modifier → { type, name, params } (max-modifiers.js), else null
    const modifier = (x, ctx = {}) => {
        const id = idOf(x), name = classOf(x)?.name || '?';
        // gizmo of deformers: slot 0 gizmo transform, slot 1 centre (Bend, Noise); FFD: slot 0 lattice transform
        const gizmo = () => gizmoSpace(ctx.tm, idOf(ref(x, 1)) === CLASS.positionXYZ ? position(ref(x, 1)) : [0, 0, 0], ref(x, 0) >= 0 ? transformOf(ref(x, 0)) : null);
        if (id === CLASS.bend) {
            const P = paramBlock(ref(x, 2));   // 0 angle (degrees), 1 direction, 2 axis, 3 limit
            return { type: 'bend', name, angle: pFloat(P, 0, 0), direction: pFloat(P, 1, 0), axis: pInt(P, 2, 2), box: ctx.box, space: gizmo(), approx: pInt(P, 3, 0) !== 0 };
        }
        if (id === CLASS.ffd4) {
            const c = objects[x], base = sc.child(c, 0x0200), off = sc.child(c, 0x0400);
            if (!base || sc.size(base) !== 64 * 12) return null;
            return { type: 'ffd', name, dim: 4, base: sc.floats(base, 192), offsets: off && sc.size(off) === 64 * 12 ? sc.floats(off, 192) : null, box: ctx.box, space: gizmo() };
        }
        if (BY_NAME[name]) return { ...BY_NAME[name], name };
        if (id === CLASS.turboSmooth) return { type: 'turbosmooth', name, iterations: pInt(paramBlock(ref(x, 0)), 0, 1) };
        if (id === CLASS.noise) {
            const P = paramBlock1(ref(x, 2));   // 0 seed, 1 scale, 2 fractal, 3 roughness, 4 iterations, 8 strength (point3)
            const st = P.get(8);
            return { type: 'noise', name, seed: P.get(0) ?? 0, scale: P.get(1) ?? 100, fractal: !!P.get(2), roughness: P.get(3) ?? 0, iterations: P.get(4) ?? 6,
                strength: Array.isArray(st) ? st : [0, 0, 0], space: gizmo(), approx: true };   // MAX' noise function differs
        }
        if (id === CLASS.editPoly) {
            // recorded steps (local data): 0x0230 operation, 0x0238 { 0x12c4 delta per vertex } – only moves (53) rebuilt
            const steps = [];
            let op = -1;
            for (const k of sc.children(ctx.local)) {
                if (k.id === 0x0230 && sc.size(k) >= 4) op = sc.u32(k);
                else if (k.id === 0x0238) {
                    if (op !== 53) return null;
                    const d = sc.child(k, 0x12c4);
                    if (!d) return null;
                    steps.push(Float32Array.from(sc.floats(d, sc.size(d) / 4)));
                    op = -1;
                }
            }
            if (op !== -1) return null;   // an operation without vertex data
            return { type: 'move', name, steps };
        }
        if (id === CLASS.extrude) {
            // parameter block 1: 0 amount, 1 segments, 2 cap start, 3 cap end
            const P = paramBlock1(ref(x, 0));
            return { type: 'extrude', name, amount: P.get(0) ?? 0, segments: P.get(1) ?? 1, capStart: (P.get(2) ?? 1) !== 0, capEnd: (P.get(3) ?? 1) !== 0 };
        }
        if (id === CLASS.shell) {
            // parameter block 2: 0 inner amount, 1 outer amount
            const P = paramBlock(ref(x, 0));
            return { type: 'shell', name, inner: pFloat(P, 0, 0), outer: pFloat(P, 1, 0) };
        }
        return null;
    };
    // primitive parameters (parameter block 2 in slot 0); null when an option changes the shape in a way we do not rebuild
    const primitiveParams = (i, kind) => {
        const P = paramBlock(ref(i, 0)), f = (id, d = 0) => pFloat(P, id, d), n = (id, d = 0) => pInt(P, id, d);
        switch (kind) {
            case 'sphere': return f(3) > 1e-4 || n(7) ? null : { kind, radius: f(0), segments: n(1, 32), smooth: n(2, 1) !== 0 };
            case 'geosphere': return n(3) ? null : { kind, radius: f(0), segments: n(1, 4), type: n(2, 2), smooth: n(4, 1) !== 0, baseToPivot: n(5) !== 0 };
            case 'cylinder': return n(6) ? null : { kind, radius: f(0), height: f(1), heightSegments: n(2, 1), capSegments: n(3, 1), sides: n(4, 18), smooth: n(5, 1) !== 0 };
            case 'cone': return n(7) ? null : { kind, r1: f(0), r2: f(1), height: f(2), heightSegments: n(3, 1), capSegments: n(4, 1), sides: n(5, 24), smooth: n(6, 1) !== 0 };
            case 'torus': return n(7) ? null : { kind, r1: f(0), r2: f(1), rotation: f(2), twist: f(3), segments: n(4, 24), sides: n(5, 12), smooth: n(6, 2) !== 0 };
            case 'pyramid': return { kind, width: f(0), depth: f(1), height: f(2) };
            case 'box': return { kind, length: f(0), width: f(1), height: f(2) };
            default: return null;
        }
    };
    // render thickness of a shape (parameter block 1 in slot 0): 6 enabled in renderer, 0 thickness, 1 sides,
    // 2 angle, 15 rectangular, 12 length, 13 width, 14 angle; null when not rendered
    const shapeRender = i => {
        const P = paramBlock1(ref(i, 0));
        if (!P.get(6) || !(P.get(0) > 0 || P.get(15))) return null;
        return P.get(15) ? { rect: { length: P.get(12) ?? 2, width: P.get(13) ?? 6, angle: P.get(14) ?? 0 } } : { thickness: P.get(0), sides: P.get(1) ?? 12, angle: P.get(2) ?? 0 };
    };
    // Text: slot 1 size, kerning (parameter block 1); slot 2: 1 alignment
    const textParams = i => {
        const a = paramBlock1(ref(i, 1)), b = paramBlock1(ref(i, 2));
        return { size: a.get(0) ?? 100, kerning: a.get(1) ?? 0, align: b.get(1) ?? 1 };
    };
    const geometry = i => {
        if (!geometryOf.has(i)) {
            const { base, mods } = baseObject(i);
            const k = classOf(base);
            // modifiers bottom → top; harmless ones dropped, evaluable ones with their parameters
            const stack = [], bad = [];
            for (const { x, ctx } of [...mods].reverse()) {
                const id = idOf(x);
                if (HARMLESS_MODIFIERS.has(id)) continue;
                const op = modifier(x, ctx);
                if (op) stack.push(op); else bad.push(classOf(x)?.name || '?');
            }
            const isShape = k?.superId === SUPER.shape;
            const text = isShape && k.id === CLASS.text ? textParams(base) : null;
            const render = isShape ? shapeRender(base) : null;
            const mesh = GEOMETRY.has(k?.id);
            const prim = PRIMITIVES.has(k?.id) ? primitiveParams(base, PRIMITIVES.get(k.id)) : null;
            let g = -1, skip = null;
            const approx = stack.filter(o => o.approx).map(o => o.name);
            if (bad.length) skip = { modifiers: [...new Set(bad)] };   // the stack changes the geometry in a way we cannot rebuild
            else if (prim && !stack.some(o => o.type === 'extrude')) g = geometries.push({ object: base, primitive: prim, stack, approx }) - 1;
            else if (PRIMITIVES.has(k?.id)) skip = { object: k.name || '?' };   // options we do not rebuild (hemisphere, slice)
            else if (isShape) {
                // a spline renders through Extrude (first in the stack) or its render thickness ("Enable in Renderer");
                // otherwise nothing (as in MAX)
                const extruded = stack[0]?.type === 'extrude';
                if ((extruded || render) && !stack.slice(extruded ? 1 : 0).some(o => o.type === 'extrude')) {
                    if (readShape(sc, objects[base], text)) g = geometries.push({ object: base, shape: true, text, render: extruded ? null : render, stack, approx }) - 1;
                    else skip = { object: k.name || '?' };   // primitive shapes (Circle, Rectangle …): parameters only
                }
            } else if (mesh && !stack.some(o => o.type === 'extrude')) {
                g = geometries.push({ object: base, poly: k.id === CLASS.editablePoly, stack, approx }) - 1;
            } else if (mesh) skip = { modifiers: stack.map(o => o.name) };
            else if (k?.superId === SUPER.geometry && !NOT_RENDERED.has(k.id)) skip = { object: k.name || '?' };   // primitives, proxies …
            geometryOf.set(i, { g, skip });
        }
        const { g, skip } = geometryOf.get(i);
        if (g >= 0) for (const a of new Set(geometries[g].approx || [])) count(unsupported.approx, a);
        if (skip) {
            unsupported.nodes++;
            for (const m of skip.modifiers || []) count(unsupported.modifiers, m);
            if (skip.object) count(unsupported.objects, skip.object);
        }
        return g;
    };

    // --- nodes ---
    const nodes = [], nodeOf = new Map();
    objects.forEach((c, i) => {
        if (idOf(i) !== CLASS.node) return;
        const parentChunk = sc.child(c, 0x0960);
        const offPos = sc.child(c, 0x096a), offRot = sc.child(c, 0x096b), offScale = sc.child(c, 0x096c), wire = sc.child(c, 0x0974);
        const obj = ref(i, 1);
        const kind = classOf(obj)?.superId;
        const g = kind === SUPER.light || kind === SUPER.camera || kind === SUPER.helper ? -1 : (obj >= 0 ? geometry(obj) : -1);
        const node = {
            name: sc.text(sc.child(c, 0x0962)),
            parentObject: parentChunk ? sc.i32(parentChunk) : -1,
            transform: transform(ref(i, 0), g >= 0 || kind === SUPER.helper),   // helpers: parents of shown parts
            offset: {
                position: offPos && sc.size(offPos) >= 12 ? sc.floats(offPos, 3) : [0, 0, 0],
                quat: offRot && sc.size(offRot) >= 16 ? (([x, y, z, w]) => [-x, -y, -z, w])(sc.floats(offRot, 4)) : [0, 0, 0, 1],
                scale: offScale && sc.size(offScale) >= 12 ? sc.floats(offScale, 3) : [1, 1, 1],
                scaleAxis: offScale && sc.size(offScale) >= 28 ? (([x, y, z, w]) => [-x, -y, -z, w])(sc.floats(offScale, 4, 12)) : [0, 0, 0, 1],
            },
            geometry: g,
            material: material(ref(i, 3)),
            wireColor: wire && sc.size(wire) >= 3 ? [sc.b[wire.start], sc.b[wire.start + 1], sc.b[wire.start + 2]].map(v => v / 255) : null,
        };
        nodeOf.set(i, nodes.push(node) - 1);
    });
    // parents: index into nodes (the scene's root node is no Node object → top level)
    for (const n of nodes) { n.parent = nodeOf.get(n.parentObject) ?? -1; delete n.parentObject; }
    // order: parents before children
    const order = [], seen = new Set();
    const visit = k => { if (seen.has(k)) return; seen.add(k); if (nodes[k].parent >= 0) visit(nodes[k].parent); order.push(k); };
    nodes.forEach((_, k) => visit(k));
    const remap = new Map(order.map((k, j) => [k, j]));
    const sorted = order.map(k => ({ ...nodes[k], parent: nodes[k].parent >= 0 ? remap.get(nodes[k].parent) : -1 }));

    const plain = map => [...map].map(([name, n]) => ({ name, count: n }));
    return {
        unitMm, nodes: sorted, materials, textures, geometries,
        unsupported: { nodes: unsupported.nodes, modifiers: plain(unsupported.modifiers), objects: plain(unsupported.objects), controllers: plain(unsupported.controllers), approx: plain(unsupported.approx) },
        chunks: sc, objects,   // for buildMaxGeometry (not transferable – stays in the worker)
    };
}

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

// --- geometry ---

/** Raw faces of an Editable Mesh / Editable Poly: positions, triangles (vertex, uv index, smoothing, material) */
function readFaces(sc, c, poly) {
    const mesh = sc.child(c, 0x08fe);
    if (!mesh) return null;
    const dv = sc.dv;
    let P, tri, tuv = null, sg, mat, uvs = null, normals = null, normalIndex = null, polyList = null;
    if (!poly) {
        const v = sc.child(mesh, 0x0914), f = sc.child(mesh, 0x0912);
        if (!v || !f) return null;
        const nv = sc.u32(v), nf = sc.u32(f);
        if (sc.size(v) < 4 + nv * 12 || sc.size(f) < 4 + nf * 20) throw new Error('MAX: truncated mesh');
        P = new Float32Array(nv * 3);
        for (let i = 0; i < nv * 3; i++) P[i] = dv.getFloat32(v.start + 4 + i * 4, true);
        tri = new Uint32Array(nf * 3); sg = new Uint32Array(nf); mat = new Uint16Array(nf);
        for (let i = 0, o = f.start + 4; i < nf; i++, o += 20) {
            tri[i * 3] = dv.getUint32(o, true); tri[i * 3 + 1] = dv.getUint32(o + 4, true); tri[i * 3 + 2] = dv.getUint32(o + 8, true);
            sg[i] = dv.getUint32(o + 12, true);
            mat[i] = dv.getUint32(o + 16, true) >>> 16;   // flags: edge visibility below, material ID in the upper half
        }
        // UV channel 1: texture vertices + texture faces (same face count)
        const tv = sc.child(mesh, 0x2394), tf = sc.child(mesh, 0x2396);
        if (tv && tf && sc.u32(tf) === nf && sc.size(tf) >= 4 + nf * 12) {
            const nt = sc.u32(tv);
            uvs = new Float32Array(nt * 2);
            for (let i = 0; i < nt; i++) { uvs[i * 2] = dv.getFloat32(tv.start + 4 + i * 12, true); uvs[i * 2 + 1] = dv.getFloat32(tv.start + 8 + i * 12, true); }
            tuv = new Uint32Array(nf * 3);
            for (let i = 0; i < nf * 3; i++) tuv[i] = dv.getUint32(tf.start + 4 + i * 4, true);
        }
        ({ normals, normalIndex } = readNormalSpec(sc, sc.child(mesh, 0x23a0), nf));
    } else {
        const v = sc.child(mesh, 0x0100), f = sc.child(mesh, 0x011a);
        if (!v || !f) return null;
        const nv = sc.u32(v);
        if (sc.size(v) < 4 + nv * 16) throw new Error('MAX: truncated poly');
        P = new Float32Array(nv * 3);
        for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) P[i * 3 + k] = dv.getFloat32(v.start + 8 + i * 16 + k * 4, true);   // flags, x, y, z
        // faces: degree, vertices, u16 flags (1: smoothing group, 8: material ID, 0x10: one more u32, 0x20: diagonals)
        const nf = sc.u32(f);
        const polys = [];
        let o = f.start + 4;
        for (let i = 0; i < nf; i++) {
            const d = dv.getUint32(o, true); o += 4;
            if (d < 3 || o + d * 4 > f.end) throw new Error('MAX: invalid polygon');
            const vs = new Uint32Array(d);
            for (let k = 0; k < d; k++, o += 4) vs[k] = dv.getUint32(o, true);
            const flags = dv.getUint16(o, true); o += 2;
            let s = 0, m = 0, diag = null;
            if (flags & 0x01) { s = dv.getUint32(o, true); o += 4; }
            if (flags & 0x08) { m = dv.getUint16(o, true); o += 2; }
            if (flags & 0x10) o += 4;
            if (flags & 0x20) { diag = new Uint32Array(2 * (d - 3)); for (let k = 0; k < diag.length; k++, o += 4) diag[k] = dv.getUint32(o, true); }
            if (flags & ~0x39) throw new Error(`MAX: unknown polygon flags ${flags.toString(16)}`);
            polys.push({ vs, s, m, diag });
        }
        polyList = polys;
        // UV channel 1: 0x0124 (channel) followed by 0x0128 (vertices) and 0x012b (faces)
        let mapFaces = null;
        const kids = sc.children(mesh);
        for (let k = 0; k + 2 < kids.length; k++) {
            if (kids[k].id !== 0x0124 || sc.i32(kids[k]) !== 1 || kids[k + 1].id !== 0x0128 || kids[k + 2].id !== 0x012b) continue;
            const mv = kids[k + 1], mf = kids[k + 2];
            const n = sc.u32(mv);
            uvs = new Float32Array(n * 2);
            for (let i = 0; i < n; i++) { uvs[i * 2] = dv.getFloat32(mv.start + 4 + i * 12, true); uvs[i * 2 + 1] = dv.getFloat32(mv.start + 8 + i * 12, true); }
            mapFaces = [];
            for (let q = mf.start; q + 4 <= mf.end && mapFaces.length < nf;) {
                const d = dv.getUint32(q, true); q += 4;
                const a = new Uint32Array(d);
                for (let j = 0; j < d; j++, q += 4) a[j] = dv.getUint32(q, true);
                mapFaces.push(a);
            }
            if (mapFaces.length !== nf || mapFaces.some((a, j) => a.length !== polys[j].vs.length)) { uvs = null; mapFaces = null; }
            break;
        }
        // triangulate: MAX's own diagonals, otherwise a fan
        let nt = 0;
        for (const p of polys) nt += p.vs.length - 2;
        tri = new Uint32Array(nt * 3); sg = new Uint32Array(nt); mat = new Uint16Array(nt);
        if (mapFaces) tuv = new Uint32Array(nt * 3);
        let t = 0;
        polys.forEach((p, j) => {
            for (const [a, b, cc] of triangulate(p.vs.length, p.diag)) {
                tri[t * 3] = p.vs[a]; tri[t * 3 + 1] = p.vs[b]; tri[t * 3 + 2] = p.vs[cc];
                if (tuv) { const mfj = mapFaces[j]; tuv[t * 3] = mfj[a]; tuv[t * 3 + 1] = mfj[b]; tuv[t * 3 + 2] = mfj[cc]; }
                sg[t] = p.s; mat[t] = p.m;
                t++;
            }
        });
        if (t < nt) { tri = tri.subarray(0, t * 3); sg = sg.subarray(0, t); mat = mat.subarray(0, t); if (tuv) tuv = tuv.subarray(0, t * 3); }
    }
    const nv = P.length / 3;
    for (let i = 0; i < tri.length; i++) if (tri[i] >= nv) throw new Error('MAX: invalid vertex index');
    if (tuv && uvs) for (let i = 0; i < tuv.length; i++) if (tuv[i] >= uvs.length / 2) { tuv = null; uvs = null; break; }
    return { P, tri, tuv, uvs, sg, mat, normals, normalIndex, polys: poly ? polyList : null };
}

// Explicit normals of an Editable Mesh (0x23a0): 0x0110 normals (count + xyz), 0x0120 face count, then per face
// 0x0124 (face) + 0x0128 { 0x0200: three normal indices, 0x0210: flags }. Read in one pass without chunk objects –
// one entry per face (millions in large files). normalIndex: per corner, 0xffffffff = none (face normal)
function readNormalSpec(sc, spec, nf) {
    if (!spec?.container) return { normals: null, normalIndex: null };
    const dv = sc.dv;
    let normals = null, normalIndex = null, face = -1;
    const head = o => {
        const id = dv.getUint16(o, true);
        let len = dv.getUint32(o + 2, true), h = 6, container;
        if (len === 0) { const lo = dv.getUint32(o + 6, true), hi = dv.getUint32(o + 10, true); container = (hi & 0x80000000) !== 0; len = (hi & 0x7fffffff) * 2 ** 32 + lo; h = 14; }
        else { container = (len & 0x80000000) !== 0; len &= 0x7fffffff; }
        return { id, start: o + h, end: o + len, container };
    };
    for (let o = spec.start; o + 6 <= spec.end;) {
        const c = head(o);
        if (c.end > spec.end || c.end <= o) return { normals: null, normalIndex: null };
        if (c.id === 0x0110 && !c.container) {
            const n = dv.getUint32(c.start, true);
            if (c.end - c.start < 4 + n * 12) return { normals: null, normalIndex: null };
            normals = new Float32Array(n * 3);
            for (let i = 0; i < n * 3; i++) normals[i] = dv.getFloat32(c.start + 4 + i * 4, true);
        } else if (c.id === 0x0120 && !c.container) {
            if (dv.getUint32(c.start, true) !== nf) return { normals: null, normalIndex: null };
            normalIndex = new Uint32Array(nf * 3).fill(0xffffffff);
        } else if (c.id === 0x0124 && !c.container) {
            face = dv.getUint32(c.start, true);
        } else if (c.id === 0x0128 && c.container && normalIndex && face >= 0 && face < nf) {
            for (let q = c.start; q + 6 <= c.end;) {
                const k = head(q);
                if (k.end > c.end || k.end <= q) break;
                if (k.id === 0x0200 && k.end - k.start >= 12)
                    for (let j = 0; j < 3; j++) normalIndex[face * 3 + j] = dv.getUint32(k.start + j * 4, true);
                q = k.end;
            }
        }
        o = c.end;
    }
    if (!normals || !normalIndex) return { normals: null, normalIndex: null };
    const n = normals.length / 3;
    for (let i = 0; i < normalIndex.length; i++) if (normalIndex[i] !== 0xffffffff && normalIndex[i] >= n) normalIndex[i] = 0xffffffff;
    return { normals, normalIndex };
}

// Triangles of a polygon with d corners: the diagonals (corner pairs) split it, the pieces left over as fans
function triangulate(d, diag) {
    if (d === 3) return [[0, 1, 2]];
    let pieces = [Array.from({ length: d }, (_, k) => k)];
    if (diag) for (let k = 0; k + 1 < diag.length; k += 2) {
        const a = diag[k], b = diag[k + 1];
        const i = pieces.findIndex(p => p.length > 3 && p.includes(a) && p.includes(b));
        if (i < 0) continue;
        const p = pieces[i], ia = p.indexOf(a), ib = p.indexOf(b);
        const [x, y] = ia < ib ? [ia, ib] : [ib, ia];
        if (y - x < 2 || (x === 0 && y === p.length - 1)) continue;   // neighbours: no diagonal
        pieces.splice(i, 1, p.slice(x, y + 1), [...p.slice(y), ...p.slice(0, x + 1)]);
    }
    const out = [];
    for (const p of pieces) for (let k = 1; k + 1 < p.length; k++) out.push([p[0], p[k], p[k + 1]]);
    return out;
}

/**
 * Buffers of one geometry, split by material ID: [{ material, positions, normals, uvs, index }].
 * Normals: explicit ones (Editable Mesh, e.g. CAD imports – no smoothing groups then), otherwise from the
 * smoothing groups (a corner averages the faces at its vertex that share a group with its face; no group = flat).
 * Corners with the same vertex, UV and normal welded.
 */
export function buildMaxGeometry(described, g) {
    const { chunks: sc, objects, geometries } = described;
    const entry = geometries[g];
    let raw;
    if (entry.shape || entry.primitive || entry.stack?.length) raw = evaluateStack(sc, objects, entry);
    else {
        raw = readFaces(sc, objects[entry.object], entry.poly);
        if (raw) raw.cornerN = creaseCornerNormals(raw.P, raw.tri);   // smoothing by angle (30°), not the file's groups
    }
    if (!raw || !raw.tri.length) return [];
    const { P, tri, tuv, uvs, mat } = raw;
    const nv = P.length / 3, nf = tri.length / 3;
    const CN = raw.cornerN || cornerNormals(raw);
    // weld: per vertex a chain of output vertices (same UV index and normal → reuse)
    let cap = Math.max(16, Math.ceil(nv * 1.3));
    let OP = new Float32Array(cap * 3), ON = new Float32Array(cap * 3), OU = uvs ? new Float32Array(cap * 2) : null;
    let UVI = new Int32Array(cap), next = new Int32Array(cap);
    const head = new Int32Array(nv).fill(-1);
    let count = 0;
    const grow = () => {
        cap *= 2;
        const g2 = (a, k) => { const b = new a.constructor(cap * k); b.set(a); return b; };
        OP = g2(OP, 3); ON = g2(ON, 3); if (OU) OU = g2(OU, 2); UVI = g2(UVI, 1); next = g2(next, 1);
    };
    const corner = new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i++) {
        const v = tri[i];
        const nx = CN[i * 3], ny = CN[i * 3 + 1], nz = CN[i * 3 + 2];
        const ui = tuv ? tuv[i] : -1;
        let found = -1;
        for (let k = head[v]; k >= 0; k = next[k]) {
            if (UVI[k] !== ui) continue;
            if (Math.abs(ON[k * 3] - nx) > 1e-4 || Math.abs(ON[k * 3 + 1] - ny) > 1e-4 || Math.abs(ON[k * 3 + 2] - nz) > 1e-4) continue;
            found = k;
            break;
        }
        if (found < 0) {
            if (count >= cap) grow();
            found = count++;
            OP[found * 3] = P[v * 3]; OP[found * 3 + 1] = P[v * 3 + 1]; OP[found * 3 + 2] = P[v * 3 + 2];
            ON[found * 3] = nx; ON[found * 3 + 1] = ny; ON[found * 3 + 2] = nz;
            if (OU) { OU[found * 2] = ui >= 0 ? uvs[ui * 2] : 0; OU[found * 2 + 1] = ui >= 0 ? uvs[ui * 2 + 1] : 0; }
            UVI[found] = ui;
            next[found] = head[v];
            head[v] = found;
        }
        corner[i] = found;
    }
    // triangles per material ID → compact buffers
    const perMat = new Map();
    for (let f = 0; f < nf; f++) perMat.set(mat[f], (perMat.get(mat[f]) || 0) + 1);
    const local = new Int32Array(count);
    const out = [];
    for (const [material, n] of perMat) {
        const index = new Uint32Array(n * 3);
        local.fill(-1);
        let w = 0, nvOut = 0;
        for (let f = 0; f < nf; f++) {
            if (mat[f] !== material) continue;
            for (let k = 0; k < 3; k++) {
                const c = corner[f * 3 + k];
                if (local[c] < 0) local[c] = nvOut++;
                index[w++] = local[c];
            }
        }
        const positions = new Float32Array(nvOut * 3), normals = new Float32Array(nvOut * 3), uvOut = OU ? new Float32Array(nvOut * 2) : null;
        for (let c = 0; c < count; c++) {
            const l = local[c];
            if (l < 0) continue;
            positions.set(OP.subarray(c * 3, c * 3 + 3), l * 3);
            normals.set(ON.subarray(c * 3, c * 3 + 3), l * 3);
            if (uvOut) uvOut.set(OU.subarray(c * 2, c * 2 + 2), l * 2);
        }
        out.push({ material, positions, normals, uvs: uvOut, index });
    }
    return out;
}

// Modifier stack → raw faces. States: polygon mesh { P, faces } (primitives, Editable Poly – TurboSmooth needs
// polygons), triangle mesh { P, tri, N } (Editable Mesh, Extrude, Shell); deformers move points of either.
function evaluateStack(sc, objects, entry) {
    let poly = null, tris = null;
    if (entry.primitive) {
        poly = primitive(entry.primitive.kind, entry.primitive);
        if (entry.primitive.baseToPivot) for (let i = 2; i < poly.P.length; i += 3) poly.P[i] += entry.primitive.radius;
    } else if (!entry.shape) {
        const base = readFaces(sc, objects[entry.object], entry.poly);
        if (!base) return null;
        // meshes from the file: smoothed by angle (30°) at the end, their smoothing groups / normals are not used
        if (base.polys) poly = { P: Array.from(base.P), faces: base.polys.map(p => ({ v: Array.from(p.vs), sg: 0, mat: p.m })), crease: true };
        else tris = { P: base.P, tri: base.tri, N: creaseCornerNormals(base.P, base.tri) };
    }
    const asTris = () => { if (poly) { const r = polyToRaw(poly); tris = { P: r.P, tri: r.tri, N: poly.crease ? creaseCornerNormals(r.P, r.tri) : cornerNormals(r) }; poly = null; } };
    const asPoly = () => {
        if (!tris) return;
        const faces = [];
        for (let t = 0; t < tris.tri.length; t += 3) faces.push({ v: [tris.tri[t], tris.tri[t + 1], tris.tri[t + 2]], sg: 1 });
        poly = { P: Array.from(tris.P), faces };
        tris = null;
    };
    if (entry.render) poly = sweepSplines(readShape(sc, objects[entry.object], entry.text), entry.render);
    for (const op of entry.stack) {
        if (op.type === 'extrude') { tris = extrude(readShape(sc, objects[entry.object], entry.text), op); poly = null; continue; }
        if (op.type === 'shell') { asTris(); if (tris) tris = shell(tris, op); continue; }
        if (op.type === 'turbosmooth') { asPoly(); if (poly) poly = turboSmooth(poly, op.iterations); continue; }   // smooth everywhere (as MAX)
        if (op.type === 'capholes') { if (poly) poly = { ...capHoles(poly), crease: poly.crease }; else if (tris) tris = capHoles(tris); continue; }
        if (op.type === 'none') continue;
        const P = poly ? poly.P : tris?.P;
        if (!P) continue;
        if (op.type === 'bend') bend(P, op);
        else if (op.type === 'ffd') ffd(P, op);
        else if (op.type === 'noise') noise(P, op);
        else if (op.type === 'move') moveVertices(P, op.steps);
        if (tris) tris.N = creaseCornerNormals(tris.P, tris.tri);   // moved points: the stored normals no longer fit
    }
    if (poly) {
        const r = polyToRaw(poly);
        if (poly.crease) r.cornerN = creaseCornerNormals(r.P, r.tri);
        return r;
    }
    if (!tris || !tris.tri.length) return null;
    const nf = tris.tri.length / 3;
    return { P: tris.P instanceof Float32Array ? tris.P : Float32Array.from(tris.P), tri: tris.tri, tuv: null, uvs: null, sg: new Uint32Array(nf), mat: new Uint16Array(nf), cornerN: tris.N };
}

// Normal per corner of raw faces: explicit normal, otherwise the faces at the vertex sharing a smoothing group
// with the corner's face (none: flat)
function cornerNormals({ P, tri, sg, normals: NS, normalIndex: NI }) {
    const nv = P.length / 3, nf = tri.length / 3;
    const CN = new Float32Array(tri.length * 3);
    // face normals (area-weighted)
    const fn = new Float32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
        const a = tri[f * 3] * 3, b = tri[f * 3 + 1] * 3, c = tri[f * 3 + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        fn[f * 3] = uy * vz - uz * vy; fn[f * 3 + 1] = uz * vx - ux * vz; fn[f * 3 + 2] = ux * vy - uy * vx;
    }
    // faces per vertex (CSR)
    const start = new Uint32Array(nv + 1);
    for (let i = 0; i < tri.length; i++) start[tri[i] + 1]++;
    for (let v = 0; v < nv; v++) start[v + 1] += start[v];
    const fill = start.slice(0, nv), faces = new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i++) faces[fill[tri[i]]++] = (i / 3) | 0;

    for (let i = 0; i < tri.length; i++) {
        const v = tri[i], f = (i / 3) | 0, s = sg[f];
        let nx = 0, ny = 0, nz = 0;
        const ni = NI ? NI[i] : 0xffffffff;
        if (ni !== 0xffffffff) { nx = NS[ni * 3]; ny = NS[ni * 3 + 1]; nz = NS[ni * 3 + 2]; }   // explicit normal
        else if (s) {
            for (let k = start[v]; k < start[v + 1]; k++) {
                const h = faces[k];
                if (h === f || (sg[h] & s)) { nx += fn[h * 3]; ny += fn[h * 3 + 1]; nz += fn[h * 3 + 2]; }
            }
        } else { nx = fn[f * 3]; ny = fn[f * 3 + 1]; nz = fn[f * 3 + 2]; }
        const len = Math.hypot(nx, ny, nz) || 1;
        CN[i * 3] = nx / len; CN[i * 3 + 1] = ny / len; CN[i * 3 + 2] = nz / len;
    }
    return CN;
}
