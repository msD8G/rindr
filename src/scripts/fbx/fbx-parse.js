// Lean reader for binary FBX (own implementation after the public format description: node records with typed
// properties, zlib-compressed arrays). Used for static FBX files instead of three.js' FBXLoader, which expands
// every polygon corner into plain JS arrays – a 650 MB CAD export needed > 4 GB of JS heap and crashed the tab
// (Chrome: all JS heaps of a tab share one 4 GB area, typed array data does not count).
//
// Here: the node tree is read once (array properties only as descriptors), arrays are inflated one geometry at a
// time straight into typed arrays; corners with the same control point, UV and normal are merged (welded), polygons
// triangulated as fans, triangles split by material into compact buffers. Geometric transforms of the model are
// baked in. Positions stay in file units (the importer scales to mm).
//
// Pure functions – runs in a worker (fbx-worker.js) and in Node (tests). inflate(bytes) → Promise<Uint8Array> is
// passed in (DecompressionStream in the browser, zlib in Node).

const MAGIC = 'Kaydara FBX Binary  \0';

/** Is this a binary FBX? (ASCII FBX goes to three.js' loader) */
export function isBinaryFbx(buffer) {
    if (buffer.byteLength < 27) return false;
    const head = new Uint8Array(buffer, 0, 21);
    for (let i = 0; i < 21; i++) if (head[i] !== MAGIC.charCodeAt(i)) return false;
    return true;
}

// --- node tree ---

/** Node tree of a binary FBX: { name, props, children }; array properties are { array: type, len, enc, off, clen } */
export function readTree(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const version = view.getUint32(23, true);
    const wide = version >= 7500;   // 64-bit record offsets
    const latin1 = new TextDecoder('latin1'), utf8 = new TextDecoder();
    const u64 = o => Number(view.getBigUint64(o, true));

    const readNode = (off, nodes) => {
        const end = wide ? u64(off) : view.getUint32(off, true);
        const numProps = wide ? u64(off + 8) : view.getUint32(off + 4, true);
        const propLen = wide ? u64(off + 16) : view.getUint32(off + 8, true);
        let p = off + (wide ? 24 : 12);
        const nameLen = bytes[p++];
        if (end === 0) return 0;   // null record: end of the list
        const name = latin1.decode(bytes.subarray(p, p + nameLen));
        p += nameLen;
        const propStart = p;
        const props = new Array(numProps);
        for (let i = 0; i < numProps; i++) {
            const t = String.fromCharCode(bytes[p++]);
            switch (t) {
                case 'Y': props[i] = view.getInt16(p, true); p += 2; break;
                case 'C': props[i] = bytes[p] !== 0; p += 1; break;
                case 'I': props[i] = view.getInt32(p, true); p += 4; break;
                case 'F': props[i] = view.getFloat32(p, true); p += 4; break;
                case 'D': props[i] = view.getFloat64(p, true); p += 8; break;
                case 'L': props[i] = view.getBigInt64(p, true); p += 8; break;
                case 'S': { const len = view.getUint32(p, true); props[i] = utf8.decode(bytes.subarray(p + 4, p + 4 + len)); p += 4 + len; break; }
                case 'R': { const len = view.getUint32(p, true); props[i] = { raw: true, off: p + 4, len }; p += 4 + len; break; }
                case 'f': case 'd': case 'l': case 'i': case 'b': {
                    const len = view.getUint32(p, true), enc = view.getUint32(p + 4, true), clen = view.getUint32(p + 8, true);
                    props[i] = { array: t, len, enc, off: p + 12, clen };
                    p += 12 + clen;
                    break;
                }
                default: throw new Error(`FBX: unknown property type ${t}`);
            }
        }
        const node = { name, props, children: [] };
        nodes.push(node);
        p = propStart + propLen;
        const nullLen = wide ? 25 : 13;
        while (p < end - nullLen + 1 && p < end) {
            const next = readNode(p, node.children);
            if (!next) { p += nullLen; break; }
            p = next;
        }
        return end;
    };

    const root = [];
    let off = 27;
    while (off < buffer.byteLength - 160) {
        const next = readNode(off, root);
        if (!next) break;
        off = next;
    }
    return { version, nodes: root };
}

const child = (node, name) => node?.children.find(c => c.name === name);
const children = (node, name) => node?.children.filter(c => c.name === name) ?? [];
const id = v => (typeof v === 'bigint' ? v.toString() : String(v));
// names are stored as "Name\0\1Class"
const cleanName = s => (typeof s === 'string' ? s.split('\0')[0] : '');

/** Properties70 → { name: { type, value } } (value: number, array of numbers or string) */
function properties70(node) {
    const out = {};
    for (const p of children(child(node, 'Properties70'), 'P')) {
        const [name, type, , , ...values] = p.props;
        const v = values.map(x => (typeof x === 'bigint' ? Number(x) : x));
        out[name] = { type, value: v.length === 1 ? v[0] : v };
    }
    return out;
}

const TYPED = { f: Float32Array, d: Float64Array, l: BigInt64Array, i: Int32Array, b: Uint8Array };
const SIZE = { f: 4, d: 8, l: 8, i: 4, b: 1 };

/** Typed array of an array property (inflated if compressed); copies uncompressed data (alignment) */
async function arrayOf(buffer, desc, inflate) {
    if (!desc?.array) return null;
    const T = TYPED[desc.array];
    const bytes = desc.enc === 1 ? await inflate(new Uint8Array(buffer, desc.off, desc.clen)) : new Uint8Array(buffer.slice(desc.off, desc.off + desc.clen));
    if (bytes.byteLength !== desc.len * SIZE[desc.array]) throw new Error('FBX: array size mismatch');
    return bytes.byteOffset % SIZE[desc.array] === 0 ? new T(bytes.buffer, bytes.byteOffset, desc.len) : new T(bytes.slice().buffer);
}

// --- scene description ---

/**
 * Scene description without geometry data: models (tree + transform properties), materials, textures, which
 * geometry belongs to which model, global settings. Also tells whether the file has animation or deformers
 * (skinning, blend shapes) – the lean path does not read them.
 */
export function describeScene(tree) {
    const top = name => tree.nodes.find(n => n.name === name);
    const objects = top('Objects');
    const settings = properties70(top('GlobalSettings'));
    const byId = new Map();
    for (const o of objects?.children ?? []) byId.set(id(o.props[0]), o);

    // connections: child → parents (in file order), parent → children with relationship
    const parentsOf = new Map(), childrenOf = new Map();
    for (const c of children(top('Connections'), 'C')) {
        const [kind, from, to, rel] = c.props;
        const f = id(from), t = id(to);
        if (!parentsOf.has(f)) parentsOf.set(f, []);
        parentsOf.get(f).push(t);
        if (!childrenOf.has(t)) childrenOf.set(t, []);
        childrenOf.get(t).push({ id: f, kind, rel: rel ?? null });
    }

    const models = [], modelIndex = new Map();
    for (const [oid, o] of byId) {
        if (o.name !== 'Model') continue;
        const type = o.props[2];
        if (type === 'Camera' || type === 'Light' || type === 'CameraSwitcher') continue;
        modelIndex.set(oid, models.length);
        const p = properties70(o);
        const vec = (k, d) => (Array.isArray(p[k]?.value) ? p[k].value.slice(0, 3) : d);
        models.push({
            id: oid, name: cleanName(o.props[1]) || '', parent: -1, geometries: [], materials: [],
            transform: {
                translation: vec('Lcl Translation', null), rotation: vec('Lcl Rotation', null), scale: vec('Lcl Scaling', null),
                preRotation: vec('PreRotation', null), postRotation: vec('PostRotation', null),
                rotationOffset: vec('RotationOffset', null), rotationPivot: vec('RotationPivot', null),
                scalingOffset: vec('ScalingOffset', null), scalingPivot: vec('ScalingPivot', null),
                rotationOrder: p.RotationOrder ? Number(p.RotationOrder.value) : 0,
            },
            geometric: {
                translation: vec('GeometricTranslation', null), rotation: vec('GeometricRotation', null), scale: vec('GeometricScaling', null),
            },
            visible: p.Visibility ? Number(p.Visibility.value) !== 0 : true,
        });
    }

    const materials = [], materialIndex = new Map();
    const textures = [], textureIndex = new Map();
    const textureOf = tid => {
        if (textureIndex.has(tid)) return textureIndex.get(tid);
        const t = byId.get(tid);
        if (!t || t.name !== 'Texture') return -1;
        const file = child(t, 'RelativeFilename')?.props[0] || child(t, 'FileName')?.props[0] || '';
        const video = (childrenOf.get(tid) || []).map(c => byId.get(c.id)).find(v => v?.name === 'Video');
        const content = child(video, 'Content')?.props[0];
        const tp = properties70(t);
        const index = textures.length;
        textures.push({
            name: cleanName(t.props[1]), file,
            content: content?.raw && content.len > 0 ? { off: content.off, len: content.len } : null,
            uvTranslation: Array.isArray(tp.Translation?.value) ? tp.Translation.value.slice(0, 2) : null,
            uvScaling: Array.isArray(tp.Scaling?.value) ? tp.Scaling.value.slice(0, 2) : null,
            wrapU: tp.WrapModeU ? Number(tp.WrapModeU.value) : 0, wrapV: tp.WrapModeV ? Number(tp.WrapModeV.value) : 0,
        });
        textureIndex.set(tid, index);
        return index;
    };
    const materialOf = mid => {
        if (materialIndex.has(mid)) return materialIndex.get(mid);
        const m = byId.get(mid);
        const p = properties70(m);
        const maps = {};
        for (const c of childrenOf.get(mid) || []) {
            if (c.kind !== 'OP' || !c.rel) continue;
            const ti = textureOf(c.id);
            if (ti >= 0) maps[c.rel] = ti;
        }
        const index = materials.length;
        materials.push({ name: cleanName(m.props[1]), shading: String(child(m, 'ShadingModel')?.props[0] ?? 'phong').toLowerCase(), props: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.value])), maps });
        materialIndex.set(mid, index);
        return index;
    };

    const geometryIds = [];
    for (const [mid, mi] of modelIndex) {
        const m = models[mi];
        for (const pid of parentsOf.get(mid) || []) {
            if (modelIndex.has(pid)) { m.parent = modelIndex.get(pid); break; }
        }
        for (const c of childrenOf.get(mid) || []) {
            const o = byId.get(c.id);
            if (!o || c.kind !== 'OO') continue;
            if (o.name === 'Geometry' && o.props[2] === 'Mesh') {
                let gi = geometryIds.indexOf(c.id);
                if (gi < 0) { gi = geometryIds.length; geometryIds.push(c.id); }
                m.geometries.push(gi);
            } else if (o.name === 'Material') m.materials.push(materialOf(c.id));
        }
    }
    // parents first (the importer builds the tree in this order)
    const order = [], seen = new Uint8Array(models.length);
    const visit = i => {
        if (seen[i]) return;
        seen[i] = 1;
        if (models[i].parent >= 0) visit(models[i].parent);
        order.push(i);
    };
    models.forEach((_, i) => visit(i));
    const remap = new Int32Array(models.length);
    order.forEach((i, k) => { remap[i] = k; });
    const sorted = order.map(i => ({ ...models[i], parent: models[i].parent >= 0 ? remap[models[i].parent] : -1 }));

    let hasAnimation = false, hasDeformers = false;
    for (const o of byId.values()) {
        if (o.name === 'Deformer' && (o.props[2] === 'Skin' || o.props[2] === 'BlendShape')) hasDeformers = true;
        if (o.name === 'AnimationCurve') hasAnimation = true;
    }
    return {
        models: sorted, materials, textures, geometryIds,
        geometryNodes: geometryIds.map(g => byId.get(g)),
        upAxis: settings.UpAxis ? Number(settings.UpAxis.value) : 1,
        upAxisSign: settings.UpAxisSign ? Number(settings.UpAxisSign.value) : 1,
        unitScaleFactor: settings.UnitScaleFactor ? Number(settings.UnitScaleFactor.value) : 1,
        hasAnimation, hasDeformers,
    };
}

// --- geometry ---

// small matrix helpers (column-major 4×4 like three.js) for the geometric transform
const deg = Math.PI / 180;
function rotationZYX([x, y, z]) {   // FBX default order eXYZ = intrinsic Z·Y·X
    const cx = Math.cos(x * deg), sx = Math.sin(x * deg), cy = Math.cos(y * deg), sy = Math.sin(y * deg), cz = Math.cos(z * deg), sz = Math.sin(z * deg);
    // R = Rz · Ry · Rx (rows)
    return [
        cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
        sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
        -sy, cy * sx, cy * cx,
    ];
}

/**
 * Welded, triangulated geometry of one Geometry node, split by material index:
 * [{ material, positions: Float32Array, normals: Float32Array|null, uvs: Float32Array|null, index: Uint32Array }]
 * geometric: { translation, rotation, scale } of the model (baked in) or null.
 */
export async function buildGeometry(buffer, node, inflate, geometric = null) {
    const vertices = await arrayOf(buffer, child(node, 'Vertices')?.props[0], inflate);
    const polys = await arrayOf(buffer, child(node, 'PolygonVertexIndex')?.props[0], inflate);
    if (!vertices || !polys || !polys.length) return [];
    const nv = vertices.length / 3, nc = polys.length;

    // layer elements: first normal / UV / material layer
    const layer = async (name, data, indexName) => {
        const el = child(node, name);
        if (!el) return null;
        const mapping = String(child(el, 'MappingInformationType')?.props[0] ?? '');
        const reference = String(child(el, 'ReferenceInformationType')?.props[0] ?? '');
        const values = await arrayOf(buffer, child(el, data)?.props[0], inflate);
        const indices = reference === 'IndexToDirect' || reference === 'Index' ? await arrayOf(buffer, child(el, indexName)?.props[0], inflate) : null;
        return values ? { mapping, values, indices } : null;
    };
    const normalLayer = await layer('LayerElementNormal', 'Normals', 'NormalsIndex');
    const uvLayer = await layer('LayerElementUV', 'UV', 'UVIndex');
    const materialLayer = await layer('LayerElementMaterial', 'Materials', null);

    // per corner: control point, polygon number
    // value index of a layer element for corner c (polygon p, control point v); -1 = none
    const element = (L, c, p, v) => {
        if (!L) return -1;
        let i;
        switch (L.mapping) {
            case 'ByPolygonVertex': i = c; break;
            case 'ByVertice': case 'ByVertex': case 'ByControlPoint': i = v; break;
            case 'ByPolygon': i = p; break;
            case 'AllSame': i = 0; break;
            default: return -1;
        }
        return L.indices ? (i < L.indices.length ? L.indices[i] : -1) : i;
    };

    // geometric transform (applied to positions; normals with the inverse scale)
    let R = null, S = [1, 1, 1], T = [0, 0, 0];
    if (geometric && (geometric.translation || geometric.rotation || geometric.scale)) {
        R = geometric.rotation ? rotationZYX(geometric.rotation) : null;
        S = geometric.scale || S;
        T = geometric.translation || T;
    }
    const transformed = !!(R || S[0] !== 1 || S[1] !== 1 || S[2] !== 1 || T[0] || T[1] || T[2]);

    // 1. weld: per control point a chain of output vertices (same UV value index and same normal → reuse)
    let cap = Math.max(16, Math.ceil(nv * 1.25));
    let P = new Float32Array(cap * 3), N = normalLayer ? new Float32Array(cap * 3) : null, U = uvLayer ? new Float32Array(cap * 2) : null;
    let UVI = new Int32Array(cap), next = new Int32Array(cap);
    const head = new Int32Array(nv).fill(-1);
    let count = 0;
    const grow = () => {
        cap *= 2;
        const g = (a, k) => { const b = new a.constructor(cap * k); b.set(a); return b; };
        P = g(P, 3); if (N) N = g(N, 3); if (U) U = g(U, 2); UVI = g(UVI, 1); next = g(next, 1);
    };
    const nvals = normalLayer?.values, uvals = uvLayer?.values;
    const cornerVertex = new Uint32Array(nc);   // output vertex per corner (for the triangulation)
    let p = 0;
    for (let c = 0; c < nc; c++) {
        let v = polys[c];
        const last = v < 0;
        if (last) v = ~v;
        if (v < 0 || v >= nv) throw new Error('FBX: invalid polygon index');
        const ni = element(normalLayer, c, p, v), ui = element(uvLayer, c, p, v);
        let nx = 0, ny = 0, nz = 0;
        if (nvals && ni >= 0) { nx = nvals[ni * 3]; ny = nvals[ni * 3 + 1]; nz = nvals[ni * 3 + 2]; }
        let found = -1;
        for (let k = head[v]; k >= 0; k = next[k]) {
            if (UVI[k] !== ui) continue;
            if (N && (Math.abs(N[k * 3] - nx) > 1e-4 || Math.abs(N[k * 3 + 1] - ny) > 1e-4 || Math.abs(N[k * 3 + 2] - nz) > 1e-4)) continue;
            found = k;
            break;
        }
        if (found < 0) {
            if (count >= cap) grow();
            found = count++;
            P[found * 3] = vertices[v * 3]; P[found * 3 + 1] = vertices[v * 3 + 1]; P[found * 3 + 2] = vertices[v * 3 + 2];
            if (N) { N[found * 3] = nx; N[found * 3 + 1] = ny; N[found * 3 + 2] = nz; }
            if (U) {
                if (ui >= 0) { U[found * 2] = uvals[ui * 2]; U[found * 2 + 1] = uvals[ui * 2 + 1]; }
                else { U[found * 2] = 0; U[found * 2 + 1] = 0; }
            }
            UVI[found] = ui;
            next[found] = head[v];
            head[v] = found;
        }
        cornerVertex[c] = found;
        if (last) p++;
    }

    // 2. triangles per material (fan triangulation of each polygon)
    const polygonMaterial = q => {
        if (!materialLayer) return 0;
        const m = materialLayer.mapping === 'AllSame' ? materialLayer.values[0] : materialLayer.values[q];
        return m === undefined || m < 0 ? 0 : m;
    };
    const triCount = new Map();
    let start = 0, q = 0;
    for (let c = 0; c < nc; c++) {
        if (polys[c] >= 0) continue;
        const n = c - start + 1;
        if (n >= 3) { const m = polygonMaterial(q); triCount.set(m, (triCount.get(m) || 0) + n - 2); }
        start = c + 1;
        q++;
    }
    const buckets = new Map();
    for (const [m, n] of triCount) buckets.set(m, { index: new Uint32Array(n * 3), w: 0 });
    start = 0; q = 0;
    for (let c = 0; c < nc; c++) {
        if (polys[c] >= 0) continue;
        const n = c - start + 1;
        if (n >= 3) {
            const b = buckets.get(polygonMaterial(q));
            const a0 = cornerVertex[start];
            for (let k = 1; k < n - 1; k++) {
                b.index[b.w++] = a0;
                b.index[b.w++] = cornerVertex[start + k];
                b.index[b.w++] = cornerVertex[start + k + 1];
            }
        }
        start = c + 1;
        q++;
    }

    // 3. compact buffers per material (only the vertices it uses), geometric transform baked in
    const local = new Int32Array(count);
    const out = [];
    for (const [material, b] of buckets) {
        local.fill(-1);
        let n = 0;
        for (let i = 0; i < b.index.length; i++) {
            const v = b.index[i];
            if (local[v] < 0) local[v] = n++;
            b.index[i] = local[v];
        }
        const positions = new Float32Array(n * 3), normals = N ? new Float32Array(n * 3) : null, uvs = U ? new Float32Array(n * 2) : null;
        for (let v = 0; v < count; v++) {
            const l = local[v];
            if (l < 0) continue;
            let x = P[v * 3] * S[0], y = P[v * 3 + 1] * S[1], z = P[v * 3 + 2] * S[2];
            if (R) [x, y, z] = [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
            positions[l * 3] = x + T[0]; positions[l * 3 + 1] = y + T[1]; positions[l * 3 + 2] = z + T[2];
            if (normals) {
                let a = N[v * 3] / S[0], bb = N[v * 3 + 1] / S[1], cc = N[v * 3 + 2] / S[2];
                if (R) [a, bb, cc] = [R[0] * a + R[1] * bb + R[2] * cc, R[3] * a + R[4] * bb + R[5] * cc, R[6] * a + R[7] * bb + R[8] * cc];
                const len = Math.hypot(a, bb, cc) || 1;
                normals[l * 3] = a / len; normals[l * 3 + 1] = bb / len; normals[l * 3 + 2] = cc / len;
            }
            if (uvs) { uvs[l * 2] = U[v * 2]; uvs[l * 2 + 1] = U[v * 2 + 1]; }
        }
        // a negative determinant of the geometric scale flips the winding
        if (transformed && S[0] * S[1] * S[2] < 0) {
            for (let i = 0; i < b.index.length; i += 3) { const t = b.index[i + 1]; b.index[i + 1] = b.index[i + 2]; b.index[i + 2] = t; }
        }
        out.push({ material, positions, normals, uvs, index: b.index });
    }
    return out;
}
