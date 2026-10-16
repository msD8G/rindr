// Import of mesh formats (glTF/GLB, FBX) via the three.js loaders.
// The loaded object is converted into the same structure as the STEP import:
//   nodes      – object tree ({ name, parent }, children after parents)
//   geometries – own buffers per geometry (positions/normals/uvs/index), BVH + tangents in the worker pool
//   meshes     – instances with absolute matrix, node and material
// Units are converted to mm (like STEP): glTF is in metres, FBX in cm × UnitScaleFactor.
// Materials become separate entries (source 'import') in the MaterialManager, textures are kept.
import * as THREE from 'three/webgpu';
import { boxUVs, buildGeometryBVHs, orientTrianglesIsolated, UV_TILE } from './step-importer.js';
import { isBinaryFbx } from './fbx/fbx-parse.js';
import { IMPORT } from './config.js';
import { t } from './i18n.js';
import { debugLog } from './log.js';

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
 * @param {{ renderer, materialManager, onStatus?, bvh?: boolean, checkSize?: (info) => Promise<boolean> }} options
 *   checkSize({ name, triangles }): asked once the triangle count is known, before the BVHs and the GPU upload
 *   (the memory-heavy part) – false = cancel (AbortError)
 */
export async function importMeshFile(source, { renderer, materialManager, onStatus = () => {}, bvh = false, checkSize = null }) {
    const t0 = performance.now();
    const ext = extOf(source.name);
    if (ext === 'ifc' || ext === 'ifczip') return (await import('./ifc/ifc-importer.js')).importIfc(source, { materialManager, onStatus, bvh });
    onStatus(t('import.mesh.reading', { name: source.name }));
    let result, missing;
    // binary FBX: own lean reader in a worker (typed arrays only – three.js' FBXLoader needs several times the
    // file size in JS heap, a large CAD export crashed the tab); animated/skinned files below
    // IMPORT.fbxLoaderMaxBytes still go to FBXLoader (it reads animation, skinning, blend shapes)
    let buffer = null;
    if (ext === 'fbx') {
        buffer = await source.main.arrayBuffer();
        // ?fbxLoader (testing): always three.js' FBXLoader – comparison with the lean reader
        if (isBinaryFbx(buffer) && !new URLSearchParams(globalThis.location?.search || '').has('fbxLoader')) {
            // ?fbxLean (testing): the lean reader also for animated files
            const fallback = buffer.byteLength <= IMPORT.fbxLoaderMaxBytes && !new URLSearchParams(globalThis.location?.search || '').has('fbxLean');
            const lean = await readFbxLean(buffer, { fallback, onStatus });
            if (lean.buffer) buffer = lean.buffer;   // animated, small enough: three.js' loader
            else {
                buffer = null;
                ({ result, missing } = await convertLeanFbx(lean, source, materialManager));
                if (lean.scene.hasAnimation || lean.scene.hasDeformers) result.warnings = ['fbxStatic'];
            }
        }
    }
    if (!result) {
        const loaded = await load(source, ext, renderer, onStatus, buffer);
        missing = loaded.missing;
        const { object, scale } = loaded;
        onStatus(t('import.mesh.buildingGeometries'));
        result = convert(object, scale, materialManager, source.name);
        // animated file: keep the source object as a "puppet" (animation.js drives it and copies every frame)
        const clips = (object.animations || []).filter(c => c.duration > 0 && c.tracks.length);
        // also without clips when there are morph targets (blend shapes): sliders in the properties panel
        result.animation = clips.length || result.links.some(l => hasMorphs(l.mesh)) ? { root: object, clips, scale, links: result.links } : null;
        delete result.links;
    }
    if (missing.size) console.warn('[Import] Files not found:', [...missing]);
    if (!result.meshes.length) throw new Error(t('import.mesh.noFaces'));
    if (checkSize) {
        let triangles = 0;
        for (const g of result.geometries) triangles += g.index.length / 3;
        if (!await checkSize({ name: source.name, triangles })) throw new DOMException('Import cancelled', 'AbortError');
    }
    const t1 = performance.now();
    if (bvh) await buildGeometryBVHs(result.geometries, onStatus);
    let triangles = 0;
    for (const g of result.geometries) triangles += g.index.length / 3;
    result.stats = {
        format: ext, geometries: result.geometries.length, meshes: result.meshes.length, triangles,
        missingFiles: [...missing], loadMs: Math.round(t1 - t0), bvhMs: Math.round(performance.now() - t1),
    };
    result.missing = [...missing];
    debugLog('[Import]', result.stats);
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

// Loading manager that resolves the files a model references (textures, .bin) against the supplied files or the
// model's URL; missing = references that could not be resolved, idle() = all started loads done.
function createResolver(source) {
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
        // loaded via URL (?model=): relative to the model file – missing only if that fails (onError). Absolute local
        // paths of the authoring machine (N:\…, file:, \\server\…) → the file name next to the model (the browser
        // refuses local files: "Not allowed to load local resource")
        if (source.baseUrl) {
            const local = /^([a-z]:[\\/]|file:|\\\\|\/\/)/i.test(url);   // also //server/… (UNC with slashes)
            const href = new URL(local ? encodeURIComponent(url.split(/[\\/]/).pop()) : url, new URL(source.baseUrl, location.href)).href;
            fromServer.set(href, url);
            return href;
        }
        missing.add(url);
        return 'data:,';   // dropped files: never fetch anything from the server
    });
    manager.onError = href => { if (fromServer.has(href)) missing.add(fromServer.get(href)); };
    // Wait until all textures are loaded (FBX returns the object before that)
    let started = false;
    const loaded = new Promise(resolve => {
        manager.onStart = () => { started = true; };
        manager.onLoad = resolve;
    });
    return {
        manager, missing, byPath, byName,
        idle: () => (started ? loaded : Promise.resolve()),
        // images are decoded by then; release the blob URLs
        release: () => setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 1000),
    };
}

async function load(source, ext, renderer, onStatus = () => {}, preloaded = null) {
    const { manager, missing, byPath, byName, idle, release } = createResolver(source);
    try {
        const { GLTFLoader, FBXLoader, DRACOLoader, KTX2Loader, MeshoptDecoder, STLLoader, PLYLoader } = await loadLibs();
        const buffer = preloaded ?? await source.main.arrayBuffer();
        // dropped .gltf: check the external buffers first (GLTFLoader would fail with an unclear error)
        if (ext === 'gltf' && !source.baseUrl) checkGltfFiles(buffer, byPath, byName);
        let object, scale;
        if (ext === 'stl') {
            // STL: one triangle soup, no units (by convention mm), no materials, no up axis (guessed:
            // meshUpAxis). The facet normals would look faceted: dropped, computeNormals smooths across
            // shared positions with a 30° crease angle (like FBX/glTF without normals)
            const geometry = new STLLoader().parse(normalizeStl(buffer));
            geometry.deleteAttribute('normal');
            if (dropBrokenTriangles(geometry) === 0) throw new Error(t('import.mesh.noFaces'));
            // panels facing inwards (open sheets with the wrong side, inside-out bodies): mesh-orient.js
            const pos = geometry.getAttribute('position');
            if (pos.count >= 3) {
                onStatus(t('import.mesh.orienting'));
                const r = await orientTrianglesIsolated(pos.array);
                geometry.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
                debugLog('[STL] orientation:', r.stats);
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
        await idle();
        return { object, scale, missing };
    } finally {
        release();
    }
}

/**
 * Makes an STL safe for STLLoader, whose format check only compares the face count at byte 80 with the
 * file length and otherwise looks for "solid" in the first 5 bytes. Files that miss both (ASCII with
 * leading blank lines or without "solid", binary with a wrong face count or trailing bytes) were read
 * as binary with a garbage count → "Invalid typed array length".
 * ASCII → string starting with "solid"; binary with a wrong count → copy with the count the file
 * length allows (the original buffer stays untouched, it may be kept as a scene asset).
 */
export function normalizeStl(buffer) {
    const len = buffer.byteLength;
    if (len >= 84 && 84 + new DataView(buffer).getUint32(80, true) * 50 === len) return buffer;
    // ASCII: "facet"/"vertex" keywords near the start and only text bytes there
    const head = new Uint8Array(buffer, 0, Math.min(len, 1024));
    const text = !head.some(b => b === 0 || (b < 9) || (b > 13 && b < 32));
    if (text) {
        // text without STL keywords (e.g. an HTML page saved as .stl): would only yield garbage triangles
        if (!/^\uFEFF?\s*solid|\bfacet\s+normal\b|\bvertex\s+[-+.\d]/i.test(new TextDecoder().decode(head))) throw new Error(t('import.mesh.notStl'));
        let str = new TextDecoder().decode(buffer).replace(/^\uFEFF?\s*/, '');
        if (!/^solid/i.test(str)) str = 'solid\n' + str;
        if (!/endsolid/i.test(str)) str += '\nendsolid\n';   // STLLoader only reads solid … endsolid blocks
        return str;
    }
    if (len < 84) throw new Error('STL file too short');
    const faces = Math.floor((len - 84) / 50);
    console.warn(`[STL] header face count ${new DataView(buffer).getUint32(80, true)} does not match the file length – reading ${faces} faces`);
    const fixed = buffer.slice(0, 84 + faces * 50);
    new DataView(fixed).setUint32(80, faces, true);
    return fixed;
}

/** Removes triangles with non-finite coordinates (NaN/Infinity from damaged files would break the bounds). Returns the triangle count. */
function dropBrokenTriangles(geometry) {
    const src = geometry.getAttribute('position').array;
    let n = 0;
    const out = new Float32Array(src.length);
    for (let i = 0; i + 9 <= src.length; i += 9) {
        let ok = true;
        for (let k = 0; k < 9; k++) if (!Number.isFinite(src[i + k])) { ok = false; break; }
        if (ok) out.set(src.subarray(i, i + 9), n++ * 9);
    }
    if (n * 9 !== src.length) {
        console.warn(`[STL] dropped ${src.length / 9 - n} triangles with invalid coordinates`);
        geometry.setAttribute('position', new THREE.BufferAttribute(out.slice(0, n * 9), 3));
    }
    return n;
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
    debugLog(`[Import] up axis ${up.toUpperCase()} (${reason})`);
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
    let instance = 0;
    const materialId = materialIdFactory(materialManager, scale, fileName);

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

// Source material → id of an import material in the MaterialManager (once per source material)
function materialIdFactory(materialManager, scale, fileName) {
    const materialIds = new Map();     // source material -> material id
    let unnamed = 0;
    return src => {
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
}

// --- lean FBX (fbx/fbx-parse.js in a worker) ---

/**
 * Read a binary FBX in a worker. Resolves { scene, geometries } – or { buffer } (the file handed back) when it is
 * animated / has deformers and `fallback` allows three.js' loader for it.
 */
function readFbxLean(buffer, { fallback, onStatus }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./fbx/fbx-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') { onStatus(t('import.mesh.buildingGeometries'), data.done / data.total); return; }
            worker.terminate();
            if (data.type === 'error') reject(new Error(data.message));
            else if (data.type === 'fallback') resolve({ buffer: data.buffer });
            else resolve({ scene: data.scene, geometries: data.geometries });
        };
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'FBX worker failed')); };
        worker.postMessage({ buffer, fallback }, [buffer]);
    });
}

// FBX RotationOrder (extrinsic eXYZ …) → three.js (intrinsic) Euler order
const FBX_EULER = ['ZYX', 'YZX', 'XZY', 'ZXY', 'YXZ', 'XYZ'];

// Local matrix of an FBX model (FBX SDK: T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹)
function fbxLocalMatrix(tr) {
    const m = new THREE.Matrix4(), tmp = new THREE.Matrix4();
    const trans = v => new THREE.Matrix4().makeTranslation(v?.[0] || 0, v?.[1] || 0, v?.[2] || 0);
    const rot = (v, order) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(v || [0, 0, 0]).map(THREE.MathUtils.degToRad), order));
    const pre = rot(tr.preRotation, 'ZYX'), r = rot(tr.rotation, FBX_EULER[tr.rotationOrder] || 'ZYX'), post = rot(tr.postRotation, 'ZYX').invert();
    const rp = trans(tr.rotationPivot), sp = trans(tr.scalingPivot);
    const s = tr.scale ? new THREE.Matrix4().makeScale(...tr.scale) : new THREE.Matrix4();
    m.copy(trans(tr.translation)).multiply(trans(tr.rotationOffset)).multiply(rp).multiply(pre).multiply(r).multiply(post)
        .multiply(tmp.copy(rp).invert()).multiply(trans(tr.scalingOffset)).multiply(sp).multiply(s).multiply(tmp.copy(sp).invert());
    return m;
}

/** Lean FBX result → { nodes, geometries, meshes } like convert(); materials as three.js Phong/Lambert like FBXLoader */
async function convertLeanFbx({ scene, geometries: parts }, source, materialManager) {
    const scale = 10 * (scene.unitScaleFactor || 1);   // cm × UnitScaleFactor → mm
    const toMm = new THREE.Matrix4().makeScale(scale, scale, scale);
    const { manager, missing, idle, release } = createResolver(source);
    const embedded = [];
    try {
        // textures: embedded ones from their bytes, the others by file name (supplied files / next to the model)
        const loader = new THREE.TextureLoader(manager);
        const textures = scene.textures.map(tx => {
            let url = tx.file.replace(/\\/g, '/');
            if (tx.content) { url = URL.createObjectURL(new Blob([tx.content])); embedded.push(url); }
            if (!url) return null;
            const texture = loader.load(url);
            texture.name = tx.name;
            texture.wrapS = tx.wrapU === 1 ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
            texture.wrapT = tx.wrapV === 1 ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
            if (tx.uvScaling) texture.repeat.set(tx.uvScaling[0], tx.uvScaling[1]);
            if (tx.uvTranslation) texture.offset.set(tx.uvTranslation[0], tx.uvTranslation[1]);
            return texture;
        });
        const srgb = v => (Array.isArray(v) ? THREE.ColorManagement.colorSpaceToWorking(new THREE.Color().fromArray(v), THREE.SRGBColorSpace) : undefined);
        const SLOTS = { DiffuseColor: 'map', 'Maya|TEX_color_map': 'map', Bump: 'bumpMap', NormalMap: 'normalMap', 'Maya|TEX_normal_map': 'normalMap',
            EmissiveColor: 'emissiveMap', TransparentColor: 'alphaMap', TransparencyFactor: 'alphaMap', 'Maya|TEX_ao_map': 'aoMap' };
        const materials = scene.materials.map(m => {
            const p = m.props;
            const params = {};
            const color = srgb(p.Diffuse) || srgb(p.DiffuseColor);
            if (color) params.color = color;
            const emissive = srgb(p.Emissive) || srgb(p.EmissiveColor);
            if (emissive) params.emissive = emissive;
            if (p.EmissiveFactor !== undefined) params.emissiveIntensity = Number(p.EmissiveFactor);
            // transparency like FBXLoader / Blender: 1 − TransparencyFactor, else Opacity, else opaque
            let opacity = 1 - (p.TransparencyFactor !== undefined ? Number(p.TransparencyFactor) : 0);
            if (opacity === 1 || opacity === 0) opacity = p.Opacity !== undefined ? Number(p.Opacity) : 1;
            params.opacity = opacity;
            if (opacity < 1) params.transparent = true;
            if (p.Shininess !== undefined) params.shininess = Number(p.Shininess);
            if (p.BumpFactor !== undefined) params.bumpScale = Number(p.BumpFactor);
            for (const [rel, ti] of Object.entries(m.maps)) {
                const slot = SLOTS[rel], tex = textures[ti];
                if (!slot || !tex) continue;
                if (slot === 'map' || slot === 'emissiveMap') tex.colorSpace = THREE.SRGBColorSpace;
                params[slot] = tex;
            }
            const material = m.shading === 'lambert' ? new THREE.MeshLambertMaterial(params) : new THREE.MeshPhongMaterial(params);
            material.name = m.name;
            return material;
        });
        await idle();

        const materialId = materialIdFactory(materialManager, scale, source.name);
        // nodes: one root for several top-level models (like FBXLoader's scene group), parents before children
        const top = scene.models.filter(m => m.parent < 0).length;
        const nodes = [];
        const base = top > 1 ? (nodes.push({ name: '', parent: -1 }), 1) : 0;
        const up = new THREE.Matrix4();
        if (scene.upAxis === 2) up.makeRotationX(-Math.PI / 2);   // Z up → Y up (as FBXLoader)
        const world = [], visible = [];
        const geometries = [], meshes = [];
        const cache = new Map();   // lean geometry → our geometry indices (models sharing a geometry = instances)
        let instance = 0;
        scene.models.forEach((m, i) => {
            const parentWorld = m.parent >= 0 ? world[m.parent] : up;
            world[i] = new THREE.Matrix4().multiplyMatrices(parentWorld, fbxLocalMatrix(m.transform));
            visible[i] = m.visible && (m.parent < 0 || visible[m.parent]);
            nodes.push({ name: m.name, parent: m.parent >= 0 ? base + m.parent : (base ? 0 : -1) });
            if (!visible[i]) return;
            const node = base + i;
            for (const lg of m.geometries) {
                let gis = cache.get(lg);
                if (!gis) {
                    const worldScale = world[i].getMaxScaleOnAxis() * scale;
                    gis = (parts[lg] || []).map(part => {
                        let normals = part.normals;
                        if (!normals) computeNormals(part.positions, part.index, normals = new Float32Array(part.positions.length));
                        const uvs = part.uvs || boxUVs(part.positions, normals, UV_TILE / Math.max(worldScale, 1e-12));
                        geometries.push({ positions: part.positions, normals, index: part.index, uvs, name: m.name });
                        return { gi: geometries.length - 1, material: part.material };
                    });
                    cache.set(lg, gis);
                }
                const matrix = new THREE.Matrix4().multiplyMatrices(toMm, world[i]).toArray();
                for (const { gi, material } of gis) {
                    const src = m.materials.length ? materials[m.materials[material] ?? m.materials[0]] : null;
                    meshes.push({ geometry: gi, matrix, materialId: materialId(src), name: m.name, node, instance, key: `${instance}/${material}` });
                }
                instance++;
            }
        });
        return { result: { nodes, geometries, meshes, animation: null }, missing };
    } finally {
        release();
        setTimeout(() => embedded.forEach(u => URL.revokeObjectURL(u)), 1000);
    }
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
// shared), edges sharper than 30° stay hard – otherwise every triangle was flat (faceted).
// Each face counts with its corner angle (Thürmer/Wüthrich), so the result does not depend on the
// triangulation: three's toCreasedNormals averaged unweighted – fans of long thin triangles on flat CAD
// faces (typical STL) pulled the vertex normals askew → distorted shading.
const CREASE_DOT = Math.cos(Math.PI / 6);   // 30° like Blender: 60° also smoothed flat faces into neighbouring chamfers (shading gradient)
function computeNormals(positions, index, normals) {
    const nf = index.length / 3, nv = positions.length / 3;
    // 1. face normals (unit) and corner angles
    const fn = new Float64Array(nf * 3), angle = new Float64Array(index.length);
    const len = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
    const cornerAngle = (ux, uy, uz, wx, wy, wz) => {
        const d = len(ux, uy, uz) * len(wx, wy, wz);
        return d > 0 ? Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy + uz * wz) / d))) : 0;
    };
    for (let f = 0; f < nf; f++) {
        const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, c = index[f * 3 + 2] * 3;
        const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
        const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
        const bcx = positions[c] - positions[b], bcy = positions[c + 1] - positions[b + 1], bcz = positions[c + 2] - positions[b + 2];
        const x = aby * acz - abz * acy, y = abz * acx - abx * acz, z = abx * acy - aby * acx;
        const l = len(x, y, z);
        if (l > 0) { fn[f * 3] = x / l; fn[f * 3 + 1] = y / l; fn[f * 3 + 2] = z / l; }   // degenerate: zero, no weight
        angle[f * 3] = cornerAngle(abx, aby, abz, acx, acy, acz);
        angle[f * 3 + 1] = cornerAngle(-abx, -aby, -abz, bcx, bcy, bcz);
        angle[f * 3 + 2] = Math.max(0, Math.PI - angle[f * 3] - angle[f * 3 + 1]);
    }
    // 2. weld vertices at the same position (grid relative to the model size, unit independent)
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < positions.length; i++) { const v = positions[i]; if (v < min) min = v; if (v > max) max = v; }
    const inv = 1 / Math.max((max - min) * 1e-7, 1e-12);
    const weld = new Int32Array(nv), q = new Int32Array(nv * 3);
    let size = 1;
    while (size < nv * 2) size <<= 1;
    const table = new Int32Array(size);   // open addressing, slot = welded id + 1, 0 = empty
    let count = 0;
    for (let v = 0; v < nv; v++) {
        const x = Math.round((positions[v * 3] - min) * inv), y = Math.round((positions[v * 3 + 1] - min) * inv), z = Math.round((positions[v * 3 + 2] - min) * inv);
        let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
        for (;;) {
            const e = table[slot];
            if (e === 0) { q[count * 3] = x; q[count * 3 + 1] = y; q[count * 3 + 2] = z; table[slot] = ++count; weld[v] = count - 1; break; }
            if (q[(e - 1) * 3] === x && q[(e - 1) * 3 + 1] === y && q[(e - 1) * 3 + 2] === z) { weld[v] = e - 1; break; }
            slot = (slot + 1) & (size - 1);
        }
    }
    // 3. corners around each welded position (CSR)
    const start = new Int32Array(count + 1);
    for (let i = 0; i < index.length; i++) start[weld[index[i]] + 1]++;
    for (let k = 0; k < count; k++) start[k + 1] += start[k];
    const cursor = start.slice(0, count), around = new Int32Array(index.length);
    for (let i = 0; i < index.length; i++) around[cursor[weld[index[i]]]++] = i;
    // 4. per corner: angle-weighted sum of the faces around it within the crease angle; corners of our
    //    indexed buffer that share a vertex are averaged (vertex = index value)
    normals.fill(0);
    for (let i = 0; i < index.length; i++) {
        const f3 = (i - i % 3);
        const nx = fn[f3], ny = fn[f3 + 1], nz = fn[f3 + 2];
        let sx = 0, sy = 0, sz = 0;
        const id = weld[index[i]];
        for (let k = start[id]; k < start[id + 1]; k++) {
            const c = around[k], o = c - c % 3;
            if (nx * fn[o] + ny * fn[o + 1] + nz * fn[o + 2] > CREASE_DOT) {
                const w = angle[c];
                sx += fn[o] * w; sy += fn[o + 1] * w; sz += fn[o + 2] * w;
            }
        }
        const l = len(sx, sy, sz);
        if (l > 0) { sx /= l; sy /= l; sz /= l; } else { sx = nx; sy = ny; sz = nz; }
        const v = index[i] * 3;
        normals[v] += sx; normals[v + 1] += sy; normals[v + 2] += sz;
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
