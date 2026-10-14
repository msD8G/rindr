// Import of mesh formats (glTF/GLB, FBX) via the three.js loaders.
// The loaded object is converted into the same structure as the STEP import:
//   nodes      – object tree ({ name, parent }, children after parents)
//   geometries – own buffers per geometry (positions/normals/uvs/index), BVH + tangents in the worker pool
//   meshes     – instances with absolute matrix, node and material
// Units are converted to mm (like STEP): glTF is in metres, FBX in cm × UnitScaleFactor.
// Materials become separate entries (source 'import') in the MaterialManager, textures are kept.
import * as THREE from 'three/webgpu';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxUVs, buildGeometryBVHs, orientTrianglesIsolated, UV_TILE } from './step-importer.js';
import { t } from './i18n.js';

// IFC (BIM) goes the same way but has its own importer (ifc/ifc-importer.js, web-ifc – loaded on demand)
export const MESH_EXTENSIONS = ['glb', 'gltf', 'fbx', 'stl', 'ifc', 'ifczip'];

// The loaders are loaded only with the first glTF/FBX (~170 KB that a STEP-only session never needs).
// Draco/Basis decoders: three.js references them itself (new URL(…, import.meta.url)) – Vite ships them
// with hashed names in _astro/; the old copy in public/decoders is gone.
let libs = null;
const loadLibs = () => (libs ??= Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/FBXLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
    import('three/addons/loaders/KTX2Loader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
    import('three/addons/loaders/STLLoader.js'),
    import('three/addons/loaders/PLYLoader.js'),
]).then(([gltf, fbx, draco, ktx2, meshopt, stl, ply]) => ({
    GLTFLoader: gltf.GLTFLoader, FBXLoader: fbx.FBXLoader, DRACOLoader: draco.DRACOLoader,
    KTX2Loader: ktx2.KTX2Loader, MeshoptDecoder: meshopt.MeshoptDecoder, STLLoader: stl.STLLoader, PLYLoader: ply.PLYLoader,
})));
let dracoLoader = null;
let ktx2Loader = null;

// Map slots taken over from the source material
const MAP_KEYS = [
    'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap',
    'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'transmissionMap', 'thicknessMap',
    'sheenColorMap', 'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap', 'iridescenceMap',
];
export { MAP_KEYS as IMPORT_MAP_KEYS };

const extOf = name => name.split('.').pop().toLowerCase();
const baseName = path => path.split(/[\\/]/).pop().toLowerCase();

/**
 * @param {{ name: string, main: Blob, files: {path: string, file: Blob}[], baseUrl?: string }} source
 *   main = main file, files = all supplied files (textures, .bin), baseUrl = fallback for relative paths
 * @param {{ renderer, materialManager, onStatus?, bvh?: boolean }} options
 */
export async function importMeshFile(source, { renderer, materialManager, onStatus = () => {}, bvh = false }) {
    const t0 = performance.now();
    const ext = extOf(source.name);
    if (ext === 'ifc' || ext === 'ifczip') return (await import('./ifc/ifc-importer.js')).importIfc(source, { materialManager, onStatus, bvh });
    onStatus(t('import.mesh.reading', { name: source.name }));
    const { object, scale, missing } = await load(source, ext, renderer, onStatus);
    if (missing.size) console.warn('[Import] Files not found:', [...missing]);
    onStatus(t('import.mesh.buildingGeometries'));
    const result = convert(object, scale, materialManager, source.name);
    if (!result.meshes.length) throw new Error(t('import.mesh.noFaces'));
    // animated file: keep the source object as a "puppet" (animation.js drives it and copies every frame)
    const clips = (object.animations || []).filter(c => c.duration > 0 && c.tracks.length);
    // also without clips when there are morph targets (blend shapes): sliders in the properties panel
    result.animation = clips.length || result.links.some(l => hasMorphs(l.mesh)) ? { root: object, clips, scale, links: result.links } : null;
    delete result.links;
    const t1 = performance.now();
    if (bvh) await buildGeometryBVHs(result.geometries, onStatus);
    let triangles = 0;
    for (const g of result.geometries) triangles += g.index.length / 3;
    result.stats = {
        format: ext, geometries: result.geometries.length, meshes: result.meshes.length, triangles,
        missingFiles: [...missing], loadMs: Math.round(t1 - t0), bvhMs: Math.round(performance.now() - t1),
    };
    result.missing = [...missing];
    console.info('[Import]', result.stats);
    return result;
}

/**
 * A glTF needs files that were not supplied (its .bin buffers – without them there is no geometry).
 * files: all missing external files of the glTF ({ uri, kind: 'buffer'|'image' }), images included,
 * so the user can hand everything in at once.
 */
export class MissingFilesError extends Error {
    constructor(files) {
        super('Missing files: ' + files.map(f => f.uri).join(', '));
        this.name = 'MissingFilesError';
        this.files = files;
    }
}

// --- Loading ---

async function load(source, ext, renderer, onStatus = () => {}) {
    // Resolve supplied files by relative path or file name (FBX often contains absolute Windows paths)
    const byPath = new Map(), byName = new Map();
    for (const { path, file } of source.files) {
        byPath.set(path.toLowerCase().replace(/^\.?\//, ''), file);
        byName.set(baseName(path), file);
    }
    const urls = [];
    const missing = new Set();
    const fromServer = new Map();   // resolved URL -> path in the file
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
        if (/^(data|blob):/.test(url)) return url;
        let rel = url;
        try { rel = decodeURIComponent(url); } catch { /* unchanged */ }
        rel = rel.replace(/^\.?\//, '').toLowerCase();
        const file = byPath.get(rel) || byName.get(baseName(rel));
        if (file) {
            const u = URL.createObjectURL(file);
            urls.push(u);
            return u;
        }
        // loaded via URL (?model=): relative to the model file – missing only if that fails (onError)
        if (source.baseUrl) {
            const href = new URL(url, new URL(source.baseUrl, location.href)).href;
            fromServer.set(href, url);
            return href;
        }
        missing.add(url);
        return 'data:,';   // dropped files: never fetch anything from the server
    });
    manager.onError = href => { if (fromServer.has(href)) missing.add(fromServer.get(href)); };
    // Wait until all textures are loaded (FBX returns the object before that)
    let started = false;
    const idle = new Promise(resolve => {
        manager.onStart = () => { started = true; };
        manager.onLoad = resolve;
    });

    try {
        const { GLTFLoader, FBXLoader, DRACOLoader, KTX2Loader, MeshoptDecoder, STLLoader, PLYLoader } = await loadLibs();
        const buffer = await source.main.arrayBuffer();
        // dropped .gltf: check the external buffers first (GLTFLoader would fail with an unclear error)
        if (ext === 'gltf' && !source.baseUrl) checkGltfFiles(buffer, byPath, byName);
        let object, scale;
        if (ext === 'stl') {
            // STL: one triangle soup, no units (by convention mm), no materials, no up axis (guessed:
            // meshUpAxis). The facet normals would look faceted: dropped, computeNormals smooths across
            // shared positions with a 60° crease angle (like FBX/glTF without normals)
            const geometry = new STLLoader().parse(buffer);
            geometry.deleteAttribute('normal');
            // panels facing inwards (open sheets with the wrong side, inside-out bodies): mesh-orient.js
            const pos = geometry.getAttribute('position');
            if (pos.count >= 3) {
                onStatus(t('import.mesh.orienting'));
                const r = await orientTrianglesIsolated(pos.array);
                geometry.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
                console.info('[STL] orientation:', r.stats);
            }
            const mesh = new THREE.Mesh(geometry, DEFAULT_MATERIAL);
            mesh.name = source.name.replace(/\.[^.]+$/, '');
            if (meshUpAxis(geometry, new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength)))) === 'z') mesh.rotation.x = -Math.PI / 2;
            object = new THREE.Group();
            object.add(mesh);
            scale = 1;
        } else if (ext === 'ply') {
            // PLY mesh (scanner/photogrammetry; Gaussian splat PLYs go to splat/ instead): like STL – mm, no
            // materials (vertex colours ignored), Z up → Y up; normals from the file if present
            const geometry = new PLYLoader().parse(buffer);
            if (!geometry.index) throw new Error(t('import.mesh.noFaces'));   // point cloud without faces
            const mesh = new THREE.Mesh(geometry, DEFAULT_MATERIAL);
            mesh.name = source.name.replace(/\.[^.]+$/, '');
            if (meshUpAxis(geometry, '') === 'z') mesh.rotation.x = -Math.PI / 2;
            object = new THREE.Group();
            object.add(mesh);
            scale = 1;
        } else if (ext === 'fbx') {
            const loader = new FBXLoader(manager);
            object = loader.parse(buffer, '');
            // FBX: unit cm × UnitScaleFactor (1 = cm, 100 = m, 0.1 = mm, 2.54 = inch)
            scale = 10 * (object.userData.unitScaleFactor || 1);
        } else {
            const loader = new GLTFLoader(manager);
            dracoLoader ??= new DRACOLoader();
            loader.setDRACOLoader(dracoLoader);
            ktx2Loader ??= new KTX2Loader().detectSupport(renderer);
            loader.setKTX2Loader(ktx2Loader);
            loader.setMeshoptDecoder(MeshoptDecoder);
            const gltf = await loader.parseAsync(ext === 'gltf' ? new TextDecoder().decode(buffer) : buffer, '');
            object = gltf.scene || gltf.scenes?.[0];
            if (!object) throw new Error(t('import.mesh.gltfNoScene'));
            object.animations = gltf.animations || [];   // FBXLoader puts them on the object itself
            await collectUnlit(gltf, object);
            scale = 1000;   // m -> mm
        }
        if (started) await idle;
        return { object, scale, missing };
    } finally {
        // images are decoded by then; release the blob URLs
        setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 1000);
    }
}

/**
 * Up axis of a mesh without metadata (STL/PLY): 'z' (CAD/3D printing, scanners – turned to Y up) or 'y'.
 * SolidWorks exports Y up (header). Otherwise the bounding box: a model lies on its floor → the axis whose
 * minimum is ~0 while the other's is not; a model centred around 0 on an axis has that axis horizontal
 * (cars, CAD assemblies: centred sideways). Undecided → Z (most STLs). Override: ?upAxis=y|z.
 * Example car STL: y 0 … 1257, z −1010 … 1010 → Y (lay on its side with the old fixed Z).
 */
function meshUpAxis(geometry, header) {
    const forced = new URLSearchParams(globalThis.location?.search || '').get('upAxis');
    let up = 'z', reason = 'default';
    if (forced === 'y' || forced === 'z') { up = forced; reason = '?upAxis'; }
    else if (/solid\s*works/i.test(header)) { up = 'y'; reason = 'SolidWorks'; }
    else {
        geometry.computeBoundingBox();
        const { min, max } = geometry.boundingBox;
        const ext = { y: max.y - min.y, z: max.z - min.z };
        const onFloor = a => ext[a] > 0 && Math.abs(min[a]) <= 0.02 * ext[a];
        const centred = a => ext[a] > 0 && Math.abs(min[a] + max[a]) <= 0.02 * ext[a];
        if (onFloor('z') !== onFloor('y')) { up = onFloor('z') ? 'z' : 'y'; reason = 'floor'; }
        else if (centred('z') !== centred('y')) { up = centred('z') ? 'y' : 'z'; reason = 'centred'; }
    }
    console.info(`[Import] up axis ${up.toUpperCase()} (${reason})`);
    return up;
}

function checkGltfFiles(buffer, byPath, byName) {
    let json;
    try { json = JSON.parse(new TextDecoder().decode(buffer)); } catch { return; }   // the loader reports it
    const external = uri => typeof uri === 'string' && !/^(data|blob):/.test(uri);
    const found = uri => {
        let rel = uri;
        try { rel = decodeURIComponent(uri); } catch { /* unchanged */ }
        rel = rel.replace(/^\.?\//, '').toLowerCase();
        return byPath.has(rel) || byName.has(baseName(rel));
    };
    const buffers = (json.buffers || []).filter(b => external(b.uri) && !found(b.uri)).map(b => ({ uri: b.uri, kind: 'buffer' }));
    if (!buffers.length) return;
    const images = (json.images || []).filter(i => external(i.uri) && !found(i.uri)).map(i => ({ uri: i.uri, kind: 'image' }));
    throw new MissingFilesError([...buffers, ...images]);
}

// --- Conversion ---

function convert(object, scale, materialManager, fileName = '') {
    // Apply the scale only to the final matrices – skinning computes in the space of the bind matrices
    object.updateMatrixWorld(true);
    const toMm = new THREE.Matrix4().makeScale(scale, scale, scale);

    const nodes = [];
    const geometries = [];
    const meshes = [];
    const links = [];   // per mesh entry: source mesh + instance (animation)
    const geometryCache = new Map();   // geometry.uuid:group -> index in geometries
    const materialIds = new Map();     // source material -> material id
    let instance = 0;
    let unnamed = 0;

    const materialId = src => {
        if (!src) src = DEFAULT_MATERIAL;
        let id = materialIds.get(src);
        if (!id) {
            const def = convertMaterial(src, scale);
            if (src === DEFAULT_MATERIAL) def.name = t('import.mesh.defaultMaterial');
            if (!def.name) def.name = t('import.mesh.unnamedMaterial', { number: ++unnamed });
            // origin: file + order in the file – stable, so scene states find the material again; with the file
            // name, materials of different models no longer collide (previously all were import:0, import:1 …)
            id = materialManager.create({ ...def, source: 'import', origin: `import:${fileName}:${materialIds.size}` }, { silent: true }).def.id;
            materialIds.set(src, id);
        }
        return id;
    };

    const visit = (o, parent) => {
        if (!o.visible || o.isLight || o.isCamera) return;
        const node = nodes.length;
        nodes.push({ name: o.name || (o.isMesh ? t('import.mesh.unnamedMesh') : ''), parent });
        if (o.isMesh && !o.isBatchedMesh && o.geometry?.getAttribute('position')) addMesh(o, node);
        for (const c of o.children) visit(c, node);
    };

    const addMesh = (mesh, node) => {
        const geometry = mesh.geometry;
        const multi = Array.isArray(mesh.material);
        // groups with the same material → one mesh of ours (FBX often has thousands of groups for a few
        // materials – one mesh each made loading and drawing slow). key = first group (stable for scene states)
        const buckets = new Map();
        if (multi && geometry.groups.length) {
            geometry.groups.forEach((g, i) => {
                const mi = g.materialIndex ?? 0;
                if (!buckets.has(mi)) buckets.set(mi, { key: i, materialIndex: mi, ranges: [] });
                buckets.get(mi).ranges.push(g);
            });
        } else buckets.set(0, { key: 'all', materialIndex: 0, ranges: [{ start: 0, count: Infinity }] });
        const list = [...buckets.values()];
        // Skinning/morph targets: bake the current pose into a separate geometry (morph targets always –
        // their sliders deform it later)
        const posed = mesh.isSkinnedMesh || hasMorphs(mesh) || mesh.morphTargetInfluences?.some(v => v !== 0);
        const worldScale = mesh.matrixWorld.getMaxScaleOnAxis() * scale;
        const instances = mesh.isInstancedMesh ? mesh.count : 1;
        const im = new THREE.Matrix4(), m = new THREE.Matrix4();
        let gis = posed ? undefined : geometryCache.get(geometry.uuid);
        if (!gis) {
            gis = extractGeometries(mesh, list, posed, worldScale).map(g => {
                if (!g) return -1;
                const gi = geometries.length;
                geometries.push({ ...g, name: mesh.name });
                if (posed) posedSource.set(gi, g.sourceVertex);
                return gi;
            });
            if (!posed) geometryCache.set(geometry.uuid, gis);
        }
        list.forEach((bucket, j) => {
            const gi = gis[j];
            if (gi < 0) return;
            const mat = materialId(multi ? mesh.material[bucket.materialIndex] : mesh.material);
            for (let k = 0; k < instances; k++) {
                m.multiplyMatrices(toMm, mesh.matrixWorld);
                if (mesh.isInstancedMesh) m.multiply((mesh.getMatrixAt(k, im), im));
                links.push({ mesh, instance: mesh.isInstancedMesh ? k : -1, posed, geometry: gi, sourceVertex: posed ? posedSource.get(gi) : null,
                    materialIndex: multi ? bucket.materialIndex : -1 });
                meshes.push({ geometry: gi, matrix: m.toArray(), materialId: mat, name: mesh.name, node, instance: instance + k, key: `${instance + k}/${bucket.key}` });
            }
        });
        instance += instances;
    };

    const posedSource = new Map();   // posed geometry -> our vertex → source vertex
    visit(object, -1);
    for (const g of geometries) delete g.sourceVertex;   // not to the BVH worker
    return { nodes, geometries, meshes, links };
}

const hasMorphs = mesh => !!mesh.geometry?.morphAttributes?.position?.length && !!mesh.morphTargetDictionary;

const DEFAULT_MATERIAL = new THREE.MeshStandardMaterial({ name: 'Standard', color: 0xb0b0b0, roughness: 0.5 });

// Own compact buffers per material bucket of a mesh (its groups with that material): only used vertices,
// index always Uint32. One pass over the index for all buckets, every source vertex computed once (posed:
// skinning/morphs once per vertex – previously per group over all vertices, i.e. groups × vertices).
function extractGeometries(mesh, buckets, posed, worldScale) {
    const geometry = mesh.geometry;
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const src = geometry.index ? geometry.index.array : null;
    const total = src ? src.length : pos.count;
    const nb = buckets.length;

    // 1. distribute the corners: local vertex number per (vertex, bucket); a vertex used by two buckets
    //    (rare) gets its second number from a map
    const owner = new Int32Array(pos.count).fill(-1), local = new Int32Array(pos.count);
    const extra = new Map();
    const out = buckets.map(b => {
        let corners = 0;
        const ranges = b.ranges.map(r => {
            const start = Math.max(0, r.start), end = Math.min(total, start + r.count);
            const count = Math.max(0, end - start - ((end - start) % 3));
            corners += count;
            return [start, count];
        });
        return { ranges, index: new Uint32Array(corners), order: [], nv: 0 };
    });
    for (let b = 0; b < nb; b++) {
        const o = out[b];
        let w = 0;
        for (const [start, count] of o.ranges) {
            for (let i = start; i < start + count; i++) {
                const v = src ? src[i] : i;
                let l;
                if (owner[v] === b) l = local[v];
                else if (owner[v] < 0) { owner[v] = b; l = local[v] = o.nv++; o.order.push(v); }
                else {
                    const k = v * nb + b;
                    l = extra.get(k);
                    if (l === undefined) { l = o.nv++; extra.set(k, l); o.order.push(v); }
                }
                o.index[w++] = l;
            }
        }
    }

    // 2. vertex data once per used source vertex: skinning/morphs only if the pose differs from the file
    //    (a character in its bind pose without active morphs is taken as it is)
    const transform = posed && (mesh.morphTargetInfluences?.some(v => v !== 0) || (mesh.isSkinnedMesh && !inBindPose(mesh)));
    let P = null, N = null;
    if (transform) {
        P = new Float32Array(pos.count * 3);
        N = nor ? new Float32Array(pos.count * 3) : null;
        const p = new THREE.Vector3(), n = new THREE.Vector3(), base = new THREE.Vector3(), tip = new THREE.Vector3();
        const done = new Uint8Array(pos.count);
        for (const o of out) for (const v of o.order) {
            if (done[v]) continue;
            done[v] = 1;
            mesh.getVertexPosition(v, p);
            P[v * 3] = p.x; P[v * 3 + 1] = p.y; P[v * 3 + 2] = p.z;
            if (N) {
                n.fromBufferAttribute(nor, v);
                if (mesh.isSkinnedMesh) {
                    // bone transforms are affine: T(base + n) − T(base) = linear part · n
                    base.fromBufferAttribute(pos, v);
                    tip.copy(base).add(n);
                    mesh.applyBoneTransform(v, base);
                    mesh.applyBoneTransform(v, tip);
                    n.subVectors(tip, base).normalize();
                }
                N[v * 3] = n.x; N[v * 3 + 1] = n.y; N[v * 3 + 2] = n.z;
            }
        }
    }

    // 3. per bucket: copy into compact buffers
    return out.map(o => {
        if (!o.index.length) return null;
        const nv = o.nv;
        const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), uvs = uv ? new Float32Array(nv * 2) : null;
        for (let l = 0; l < nv; l++) {
            const v = o.order[l];
            if (P) { positions[l * 3] = P[v * 3]; positions[l * 3 + 1] = P[v * 3 + 1]; positions[l * 3 + 2] = P[v * 3 + 2]; }
            else { positions[l * 3] = pos.getX(v); positions[l * 3 + 1] = pos.getY(v); positions[l * 3 + 2] = pos.getZ(v); }
            if (nor) {
                if (N) { normals[l * 3] = N[v * 3]; normals[l * 3 + 1] = N[v * 3 + 1]; normals[l * 3 + 2] = N[v * 3 + 2]; }
                else { normals[l * 3] = nor.getX(v); normals[l * 3 + 1] = nor.getY(v); normals[l * 3 + 2] = nor.getZ(v); }
            }
            if (uvs) { uvs[l * 2] = uv.getX(v); uvs[l * 2 + 1] = uv.getY(v); }
        }
        if (!nor) computeNormals(positions, o.index, normals);
        // our vertex → source vertex (animation/morphs re-deform from the source)
        const sourceVertex = posed ? Int32Array.from(o.order) : null;
        // without UVs: box projection like STEP (UV_TILE in mm, geometry in source units)
        return { positions, normals, index: o.index, uvs: uvs || boxUVs(positions, normals, UV_TILE / Math.max(worldScale, 1e-12)), sourceVertex };
    });
}

// Skinned mesh in its bind pose? Then skinning returns the file's positions unchanged: per bone
// bindMatrixInverse · boneWorld · boneInverse · bindMatrix = identity (same product as applyBoneTransform)
function inBindPose(mesh) {
    const { bones, boneInverses } = mesh.skeleton;
    const m = new THREE.Matrix4();
    for (let i = 0; i < bones.length; i++) {
        if (!bones[i]) continue;
        m.multiplyMatrices(mesh.bindMatrixInverse, bones[i].matrixWorld).multiply(boneInverses[i]).multiply(mesh.bindMatrix);
        const e = m.elements;
        for (let k = 0; k < 16; k++) {
            const id = k % 5 === 0 ? 1 : 0;
            const tol = k >= 12 && k < 15 ? 1e-4 * (1 + mesh.geometry.boundingSphere?.radius || 1) : 1e-5;
            if (Math.abs(e[k] - id) > tol) return false;
        }
    }
    return true;
}

// Normals for meshes without any: smooth across vertices at the same position (FBX/glTF often have none
// shared), edges sharper than 60° stay hard – otherwise every triangle was flat (faceted)
function computeNormals(positions, index, normals) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const creased = toCreasedNormals(g, Math.PI / 3);   // non-indexed: one vertex per triangle corner
    const n = creased.getAttribute('normal');
    // per corner → per vertex of our indexed buffer (corners sharing a vertex: average)
    normals.fill(0);
    for (let i = 0; i < index.length; i++) {
        const v = index[i] * 3;
        normals[v] += n.getX(i); normals[v + 1] += n.getY(i); normals[v + 2] += n.getZ(i);
    }
    for (let v = 0; v < normals.length; v += 3) {
        const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
        normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l;
    }
}

// glTF KHR_materials_unlit (typical for Sketchfab exports with baked lighting): GLTFLoader creates a
// MeshBasicMaterial and drops the emissive texture – often the base colour is black and the picture is
// only in the emissive texture. Remember emissive texture/colour/strength from the JSON for convertMaterial.
async function collectUnlit(gltf, object) {
    const { parser } = gltf;
    const seen = new Set();
    const materials = [];
    object.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) if (m?.isMeshBasicMaterial && !seen.has(m)) { seen.add(m); materials.push(m); } });
    for (const m of materials) {
        const index = parser.associations.get(m)?.materials;
        const def = index != null ? parser.json.materials?.[index] : null;
        if (!def) continue;
        const factor = def.emissiveFactor || [0, 0, 0];
        const strength = def.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
        let map = null;
        if (def.emissiveTexture) {
            // null if the image is missing (dropped .gltf without its textures)
            map = await parser.getDependency('texture', def.emissiveTexture.index).catch(() => null);
            if (map) {
                map = map.clone();
                map.colorSpace = THREE.SRGBColorSpace;
                map.needsUpdate = true;
            }
        }
        m.userData.unlit = { map, color: new THREE.Color().fromArray(factor), strength };
    }
}

// Source material (Standard/Physical from glTF, Phong/Lambert from FBX) -> parameters + textures
function convertMaterial(m, scale) {
    const hex = c => '#' + c.getHexString();
    const params = { color: m.color ? hex(m.color) : '#ffffff' };
    if (m.isMeshStandardMaterial) {
        params.metalness = m.metalness;
        params.roughness = m.roughness;
    } else if (m.isMeshPhongMaterial) {
        params.metalness = 0;
        params.roughness = Math.min(1, Math.sqrt(2 / (m.shininess + 2)));   // Blinn-Phong exponent -> roughness
    } else {
        params.metalness = 0;
        params.roughness = 1;
    }
    if (m.emissive) {
        params.emissive = hex(m.emissive);
        params.emissiveIntensity = m.emissiveIntensity ?? 1;
    }
    params.opacity = m.opacity ?? 1;
    if (m.isMeshPhysicalMaterial) {
        Object.assign(params, {
            specularIntensity: m.specularIntensity,
            clearcoat: m.clearcoat, clearcoatRoughness: m.clearcoatRoughness,
            transmission: m.transmission, ior: m.ior, thickness: m.thickness * scale,
            attenuationColor: hex(m.attenuationColor),
            attenuationDistance: Number.isFinite(m.attenuationDistance) ? m.attenuationDistance * scale : 100,
            sheen: m.sheen, sheenColor: hex(m.sheenColor), sheenRoughness: m.sheenRoughness,
            iridescence: m.iridescence,
        });
    }
    const maps = {};
    // only textures with a loaded image (missing files yield image = null -> path tracer crashes)
    for (const key of MAP_KEYS) if (m[key]?.isTexture && hasImage(m[key])) maps[key] = m[key];
    // unlit (glTF): shows its picture without lighting → black, non-reflective surface that emits the picture
    // (emissive texture/colour, otherwise base colour texture/colour)
    if (m.isMeshBasicMaterial) {
        const u = m.userData.unlit;
        const emissiveMap = (u?.map && hasImage(u.map) && u.map) || maps.map || null;
        const emissive = u && (u.map || u.color.getHex()) ? u.color : m.color;
        Object.assign(params, { color: '#000000', metalness: 0, roughness: 1, specularIntensity: 0,
            emissive: hex(u?.map && !u.color.getHex() ? new THREE.Color(1, 1, 1) : emissive), emissiveIntensity: u?.strength ?? 1 });
        delete maps.map;
        if (emissiveMap) maps.emissiveMap = emissiveMap;
    }
    // Phong specular maps have no counterpart; bump maps stay bump maps
    const render = {
        maps,
        side: m.side,
        alphaTest: m.alphaTest || 0,
        transparent: !!m.transparent,
        normalScale: m.normalScale ? m.normalScale.toArray() : null,
        bumpScale: m.bumpScale ?? 1,
        aoMapIntensity: m.aoMapIntensity ?? 1,
    };
    return { name: m.name, params, render };
}

function hasImage(texture) {
    const img = texture.image;
    return !!img && (img.data || img.width > 0 || img.naturalWidth > 0 || img.mipmaps?.length > 0 || texture.isCompressedTexture);
}
