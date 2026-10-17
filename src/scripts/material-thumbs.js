// Material thumbnails: every material rendered on a sphere with the real renderer (raster, same TSL material as in
// the scene) under the scene's current environment (HDRI, intensity, rotation) + a key light, tone-mapped and cut
// on the CPU. In front of a red/green/blue checkerboard (wish of the user, toggle in the panel, remembered per
// browser): transparency and refraction (IOR) show right in the preview – a real backdrop in the scene, so glass
// bends it. Switched off: a dark plain backdrop, the sphere cut out round. Rendered when first needed; reload() makes all of
// them anew (after switching the HDRI).
// Small footprint on the user's device (wish of the user): only the library presets are stored (IndexedDB, a fixed
// set of ~30 images à a few KB, key = hash of the description + THUMB_VERSION, other versions are deleted); edited,
// STEP and imported materials live in memory only, the previous image of a material is released when its new one
// is ready.
//  - one thumbnail per animation frame, the main loop keeps running; the renderer state is restored right away
//  - newest request per group wins (dragging a slider never queues stale images)
//  - reload: the old images stay shown ("stale") until their new ones are there; a render still running for the
//    previous generation is thrown away
//  - the same ACES fit + sRGB as the environment preview; contour styles get their outline as a ring
//  - square image with the checkerboard (the panel rounds the corners), round without
import * as THREE from 'three/webgpu';
import { compileAsync } from './shader-compile.js';

export const THUMB_SIZE = 96;               // output pixels (tile sphere 44 CSS px, sharp up to 2× HiDPI)
const RENDER_SIZE = THUMB_SIZE * 2;         // rendered at twice the size, box-filtered down (anti-aliasing)
const THUMB_VERSION = 13;                   // raise when the look changes (old images are not used any more)
const RADIUS = 25;                          // scene units (mm for CAD) – subsurface radius, marble scale etc. fit
const FOV = 30;
const FILL = 0.8;                           // sphere diameter / image size (the checkerboard shows around it)
const THICKNESS = 0.4 * RADIUS;             // transmission thickness on the sphere (see _render)
const CHECKER_CELLS = 10;                   // cells across the image
const CHECKER_BEHIND = 6;                   // backdrop distance behind the sphere's centre (radii) – beyond the ball lens's focus
                                            // (~1.5 radii): upside down and squeezed; at 1.2 a magnifier (four cells)
const EXPOSURE = 1.0;
const DB_NAME = 'rindr-thumbs';
const CHECKER_KEY = 'rindr.materials.checker';
const DB_LIMIT = 64;                        // stored images (presets only); the oldest are removed beyond that

/** Short hash of a material description (part of the image key) */
export function thumbKey(description) {
    const str = JSON.stringify(description);
    let h1 = 0xdeadbeef ^ THUMB_VERSION, h2 = 0x41c6ce57 ^ THUMB_VERSION;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `v${THUMB_VERSION}-${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

export class MaterialThumbs extends EventTarget {
    /**
     * Events: 'ready' (detail: { key, url } – url null if rendering failed), 'reload' (all images are stale)
     * @param {THREE.WebGPURenderer} renderer
     * @param {() => { texture: THREE.Texture, intensity: number, rotation: number }} getEnvironment  current one
     */
    constructor(renderer, getEnvironment) {
        super();
        this.renderer = renderer;
        this.getEnvironment = getEnvironment;
        this.urls = new Map();      // key -> object URL | null (failed)
        this.stale = new Set();     // keys whose image is from before reload() (shown until the new one is there)
        this.generation = 0;
        this.checker = (() => { try { return localStorage.getItem(CHECKER_KEY) !== '0'; } catch { return true; } })();
        this.jobs = new Map();      // group -> { key, material, persist, dispose }
        this.shown = new Map();     // group -> key of its last memory-only image (released when replaced)
        this.pending = new Set();   // keys requested and not ready yet
        this._running = false;
        this._setup = null;
        this._db = openDb();
    }

    /** Image of `key` if there is one (null: not ready or failed – see has()); may be stale */
    url(key) {
        return this.urls.get(key) ?? null;
    }

    /** a current image (or a failed attempt) exists – nothing to wait for */
    has(key) {
        return this.urls.has(key) && !this.stale.has(key);
    }

    /** being made (requested, not ready) */
    isPending(key) {
        return this.pending.has(key);
    }

    /** make all images anew with the current environment (the stored ones too) */
    /** checkerboard behind the spheres on/off: all images anew (stored ones replaced, no second set kept) */
    setChecker(on) {
        if (this.checker === on) return;
        this.checker = on;
        try { localStorage.setItem(CHECKER_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
        this.reload();
    }

    reload() {
        this.generation++;
        for (const key of this.urls.keys()) this.stale.add(key);
        this.jobs.clear();
        this.pending.clear();
        this._db.then(db => db && dbClear(db));
        this.dispatchEvent(new CustomEvent('reload'));
    }

    /**
     * Ask for the image of `key`.
     * @param {string} group  newest request per group wins (material ID, library ID)
     * @param {() => THREE.Material} material  the material to render (called only if the image is not stored)
     * @param {object} [opts]  persist: keep in IndexedDB (library presets only); dispose: dispose the material
     *                         afterwards (own instance). Memory-only keys must be unique to their group.
     */
    request(key, group, material, { persist = false, dispose = false } = {}) {
        if (this.has(key)) { this._release(group, { key, persist }); return; }
        if (this.pending.has(key) && !this.jobs.has(group)) return;   // being rendered
        const old = this.jobs.get(group);
        if (old?.key === key) return;
        if (old) this.pending.delete(old.key);
        this.jobs.set(group, { key, material, persist, dispose });
        this.pending.add(key);
        this._run();
    }

    async _run() {
        if (this._running) return;
        this._running = true;
        try {
            while (this.jobs.size) {
                const [group, job] = this.jobs.entries().next().value;
                this.jobs.delete(group);
                const generation = this.generation;
                let url = await this._stored(job);
                if (url === undefined) {
                    await new Promise(requestAnimationFrame);   // one render per frame
                    url = await this._render(job, generation).catch(err => { console.warn('Material thumbnail failed:', err); return null; });
                }
                if (generation !== this.generation) {
                    // reloaded meanwhile: made with the old environment
                    if (url) URL.revokeObjectURL(url);
                    continue;
                }
                const old = this.urls.get(job.key);
                if (old && old !== url) URL.revokeObjectURL(old);
                this.urls.set(job.key, url);
                this.stale.delete(job.key);
                this.pending.delete(job.key);
                this._release(group, job);
                this.dispatchEvent(new CustomEvent('ready', { detail: { key: job.key, url } }));
            }
        } finally {
            this._running = false;
            this._setup?.mesh.dispatchEvent({ type: 'dispose' });   // drop the render objects of the materials shown
        }
    }

    // memory-only images: the group's previous one is not needed any more
    _release(group, job) {
        const old = this.shown.get(group);
        if (old && old !== job.key) {
            const url = this.urls.get(old);
            if (url) URL.revokeObjectURL(url);
            this.urls.delete(old);
            this.stale.delete(old);
        }
        if (job.persist) this.shown.delete(group); else this.shown.set(group, job.key);
    }

    // stored image (object URL) or undefined
    async _stored(job) {
        if (!job.persist) return undefined;
        const db = await this._db;
        const blob = db && await dbGet(db, job.key);
        return blob ? URL.createObjectURL(blob) : undefined;
    }

    async _render(job, generation) {
        const s = this._setup ??= this._createSetup();
        const material = job.material();
        try {
            const r = this.renderer;
            s.mesh.material = material;
            const env = this.getEnvironment();
            s.scene.environment = env.texture;
            s.scene.environmentIntensity = env.intensity;
            s.scene.environmentRotation.y = env.rotation;
            // glass in front of the checkerboard: refraction traced exactly (see traceRefraction) – the raster renders
            // in front of a black and a white wall give everything else (reflections, gloss, tint, how much passes)
            const traced = this.checker && material.transmission > 0;
            const walls = traced ? [s.black, s.white] : [this.checker ? s.checker : s.plain];
            // compile for the thumbnail target, then render – the renderer state is restored before the main loop
            // sees it (shader-compile.js: node builds read the state of the call)
            const saved = save(r);
            prepare(r, s.target);
            const compiled = compileAsync(r, s.scene, s.camera);
            restore(r, saved);
            await compiled;
            const images = [];
            for (const wall of walls) {
                s.backdrop.material = wall;
                images.push(await this._renderOnce(s, material));
            }
            const bottomUp = !!r.backend.isWebGLBackend;
            const rgb = traced
                ? composeRefraction(linear(images[0], bottomUp), linear(images[1], bottomUp), material)
                : linear(images[0], bottomUp);
            const canvas = toCanvas(rgb, material.userData.contour, !this.checker);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
            if (!blob) return null;
            if (job.persist && generation === this.generation) this._db.then(db => db && dbPut(db, job.key, blob));
            return URL.createObjectURL(blob);
        } finally {
            if (job.dispose) material.dispose();
        }
    }

    // one render into the target, read back. Raster transmission only shifts by the thickness (a screen-space
    // offset): set to 0.4 radius for the render – absorption over a readable distance (the presets' few mm hardly
    // tinted, the diameter turned tinted glass black). Only around the synchronous render: the scene's own material
    // must not show it in the viewport (a uniform, no recompile)
    async _renderOnce(s, material) {
        const r = this.renderer, saved = save(r), thickness = material.thickness;
        prepare(r, s.target);
        if (material.transmission > 0) material.thickness = THICKNESS;
        try {
            r.render(s.scene, s.camera);
        } finally {
            material.thickness = thickness;
            restore(r, saved);
        }
        return r.readRenderTargetPixelsAsync(s.target, 0, 0, RENDER_SIZE, RENDER_SIZE);
    }

    _createSetup() {
        const scene = new THREE.Scene();
        const backdrop = new THREE.Mesh(backdropGeometry());
        backdrop.position.z = -CHECKER_BEHIND * RADIUS;
        scene.add(backdrop);
        const checker = new THREE.MeshBasicNodeMaterial({ map: checkerTexture() });
        const plain = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.02, 0.02, 0.02) });
        const black = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
        const white = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(-1, 1.4, 1.2);
        scene.add(key);
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 96, 64));
        mesh.rotation.y = -0.6;               // marble/procedural patterns: not the seam towards the camera
        scene.add(mesh);
        const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1000);
        camera.position.set(0, 0, cameraDistance());
        const target = new THREE.RenderTarget(RENDER_SIZE, RENDER_SIZE, { type: THREE.HalfFloatType, depthBuffer: true });
        return { scene, mesh, camera, target, backdrop, checker, plain, black, white };
    }
}

// checkerboard: pure red, green, blue at full brightness, unlit (user: "RGB als solches"; before: pastel cells of
// every hue 6 across → too loud; muted RGB on dark grey → user wanted plain RGB). The HDRI as background made clear
// glass look like white plastic – too bright and plain to see the bending.
function checkerTexture() {
    const n = CHECKER_CELLS, data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) data[(y * n + x) * 4 + (x + 2 * y) % 3] = 255;   // neighbours always differ
    }
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const texture = new THREE.DataTexture(data, n, n);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
}

// plane filling the view behind the sphere
function backdropGeometry() {
    const distance = cameraDistance() + CHECKER_BEHIND * RADIUS;
    const size = 2 * Math.tan(FOV / 2 * Math.PI / 180) * distance;
    return new THREE.PlaneGeometry(size, size);
}

// camera distance at which the sphere covers FILL of the image
function cameraDistance() {
    const tanHalf = Math.tan(FOV / 2 * Math.PI / 180);
    return RADIUS / Math.sin(Math.atan(FILL * tanHalf));
}

const save = r => ({ target: r.getRenderTarget(), mrt: r.getMRT(), toneMapping: r.toneMapping, outputColorSpace: r.outputColorSpace });
function prepare(r, target) {
    r.setRenderTarget(target);
    r.setMRT(null);
    r.toneMapping = THREE.NoToneMapping;          // linear values, tone-mapped on the CPU
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
}
function restore(r, s) {
    r.setRenderTarget(s.target);
    r.setMRT(s.mrt);
    r.toneMapping = s.toneMapping;
    r.outputColorSpace = s.outputColorSpace;
}

// read-back RGBA (half float) → linear RGB, rows top → bottom
function linear(pixels, bottomUp) {
    const value = pixels instanceof Uint16Array ? v => THREE.DataUtils.fromHalfFloat(v) : v => v;
    const n = RENDER_SIZE, rgb = new Float32Array(n * n * 3);
    for (let y = 0; y < n; y++) {
        const row = bottomUp ? n - 1 - y : y;
        for (let x = 0; x < n; x++) {
            const i = (row * n + x) * 4, o = (y * n + x) * 3;
            rgb[o] = value(pixels[i]); rgb[o + 1] = value(pixels[i + 1]); rgb[o + 2] = value(pixels[i + 2]);
        }
    }
    return rgb;
}

// Glass: the raster's transmission is a screen-space shift (front face only) – a sphere showed the checkerboard
// barely moved, not upside down and squeezed like real glass. Sphere and wall are known shapes, so the light that
// passes is traced exactly per pixel: camera ray → refract into the sphere (the material's IOR) → back face (total
// internal reflection: bounce on) → refract out → the wall's cell. Renders in front of a black and a white wall
// give the rest: black = reflections, gloss, emission; white − black = how much of the wall comes through per
// pixel and channel (Fresnel, tint, absorption, transmission < 1). Result = black + (white − black) × traced cell.
// 8 rays per pixel (sub-pixel offsets – the squeezed cells at the rim flickered with one); rough glass: the
// outgoing direction jittered too (spread roughness² / 4 rad – the full roughness² blurred frosted glass to grey).
function composeRefraction(black, white, material) {
    const n = RENDER_SIZE, out = new Float32Array(black.length);
    const ior = Math.max(material.ior || 1.5, 1.0001);
    const spread = (material.roughness || 0) ** 2 / 4;
    const samples = JITTER.length;
    const tanHalf = Math.tan(FOV / 2 * Math.PI / 180), dist = cameraDistance();
    const wallZ = -CHECKER_BEHIND * RADIUS, wallSize = 2 * tanHalf * (dist - wallZ);
    const cell = [0, 0, 0];
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            cell[0] = cell[1] = cell[2] = 0;
            for (let k = 0; k < samples; k++) {
                const [sx, sy] = JITTER[k];
                const dx = ((x + 0.5 + 0.5 * sx) / n * 2 - 1) * tanHalf, dy = (1 - (y + 0.5 + 0.5 * sy) / n * 2) * tanHalf;
                const len = Math.hypot(dx, dy, 1);
                const jitter = spread > 1e-5 ? JITTER[(k * 3 + 1) % samples] : null;
                traceRefraction(0, 0, dist, dx / len, dy / len, -1 / len, ior, spread, jitter, wallZ, wallSize, cell);
            }
            const o = (y * n + x) * 3;
            for (let ch = 0; ch < 3; ch++) {
                const passed = Math.max(white[o + ch] - black[o + ch], 0);
                out[o + ch] = black[o + ch] + passed * cell[ch] / samples;
            }
        }
    }
    return out;
}

// 8 points on a disc (golden angle): sub-pixel offsets and the rough glass jitter
const JITTER = Array.from({ length: 8 }, (_, k) => {
    const r = Math.sqrt((k + 0.5) / 8), a = k * 2.39996323;
    return [r * Math.cos(a), r * Math.sin(a)];
});

// one ray from (ox, oy, oz) along unit (dx, dy, dz) through the sphere (centre 0, RADIUS) to the wall: adds the
// wall's linear colour to `cell` (nothing when it misses the wall or stays trapped inside)
function traceRefraction(ox, oy, oz, dx, dy, dz, ior, spread, jitter, wallZ, wallSize, cell) {
    // sphere hit: |o + t d|² = R²
    const b = ox * dx + oy * dy + oz * dz, c = ox * ox + oy * oy + oz * oz - RADIUS * RADIUS, disc = b * b - c;
    if (disc > 0 && -b - Math.sqrt(disc) > 0) {
        const t = -b - Math.sqrt(disc);
        let px = ox + t * dx, py = oy + t * dy, pz = oz + t * dz;
        // into the glass: normal outwards, eta = 1 / ior (entering never reflects totally)
        let d = refract(dx, dy, dz, px / RADIUS, py / RADIUS, pz / RADIUS, 1 / ior);
        let out = null;
        for (let bounce = 0; bounce < 4 && !out; bounce++) {
            // back face: from a point on the sphere, the other hit is at t = −2 p·d
            const t2 = -2 * (px * d[0] + py * d[1] + pz * d[2]);
            px += t2 * d[0]; py += t2 * d[1]; pz += t2 * d[2];
            const nx = -px / RADIUS, ny = -py / RADIUS, nz = -pz / RADIUS;   // facing the ray (inwards)
            out = refract(d[0], d[1], d[2], nx, ny, nz, ior);
            if (!out) {
                const k = 2 * (d[0] * nx + d[1] * ny + d[2] * nz);
                d = [d[0] - k * nx, d[1] - k * ny, d[2] - k * nz];
            }
        }
        if (!out) return;
        [ox, oy, oz, dx, dy, dz] = [px, py, pz, ...out];
        if (jitter) {
            // frosted: tilt the outgoing direction (small angles: add sideways, renormalise)
            dx += jitter[0] * spread; dy += jitter[1] * spread;
            const l = Math.hypot(dx, dy, dz);
            dx /= l; dy /= l; dz /= l;
        }
    }
    if (dz >= -1e-6) return;   // away from the wall
    const t = (wallZ - oz) / dz;
    const u = (ox + t * dx) / wallSize + 0.5, v = (oy + t * dy) / wallSize + 0.5;
    // the checkerboard's cells (checkerTexture: row 0 at the bottom), repeated beyond the wall's edge
    const cx = Math.floor(u * CHECKER_CELLS), cy = Math.floor(v * CHECKER_CELLS);
    cell[(((cx + 2 * cy) % 3) + 3) % 3] += 1;
}

// GLSL refract with N facing against I; null on total internal reflection
function refract(ix, iy, iz, nx, ny, nz, eta) {
    const cosi = -(ix * nx + iy * ny + iz * nz);
    const k = 1 - eta * eta * (1 - cosi * cosi);
    if (k < 0) return null;
    const f = eta * cosi - Math.sqrt(k);
    return [eta * ix + f * nx, eta * iy + f * ny, eta * iz + f * nz];
}

// linear RGB (RENDER_SIZE²) → 2 × 2 box filter, ACES fit + sRGB, optionally cut out round (+ contour ring)
function toCanvas(rgb, contour, round) {
    const n = THUMB_SIZE, canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext('2d'), out = ctx.createImageData(n, n);
    const radius = FILL * n / 2, c = n / 2;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const o = (y * n + x) * 4;
            const cover = round ? Math.min(Math.max(radius - Math.hypot(x + 0.5 - c, y + 0.5 - c) + 0.5, 0), 1) : 1;
            if (cover <= 0) continue;
            for (let ch = 0; ch < 3; ch++) {
                let sum = 0;
                for (let sy = 0; sy < 2; sy++) {
                    for (let sx = 0; sx < 2; sx++) sum += rgb[((2 * y + sy) * RENDER_SIZE + 2 * x + sx) * 3 + ch];
                }
                out.data[o + ch] = toneMap(sum / 4 * EXPOSURE);
            }
            out.data[o + 3] = cover * 255;
        }
    }
    ctx.putImageData(out, 0, 0);
    if (contour) {
        // outline styles: the screen-space contour as a ring (width in CSS px at the tile size)
        const w = Math.max(1, (contour.width || 2) * n / 48);
        ctx.strokeStyle = contour.color || '#000000';
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.arc(c, c, radius - w / 2, 0, Math.PI * 2);
        ctx.stroke();
    }
    return canvas;
}

function toneMap(x) {
    const v = Math.max(x, 0);
    const a = Math.max(0, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14));
    return Math.min(1, a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055) * 255;
}

// --- IndexedDB: key -> { blob, time } ---

function openDb() {
    return new Promise(resolve => {
        try {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore('thumbs');
            req.onsuccess = () => { prune(req.result); resolve(req.result); };
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch {
            resolve(null);   // storage blocked (private mode etc.): memory only
        }
    });
}

function dbGet(db, key) {
    return new Promise(resolve => {
        try {
            const req = db.transaction('thumbs').objectStore('thumbs').get(key);
            req.onsuccess = () => resolve(req.result?.blob ?? null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

function dbClear(db) {
    try {
        db.transaction('thumbs', 'readwrite').objectStore('thumbs').clear();
    } catch { /* ignore */ }
}

function dbPut(db, key, blob) {
    try {
        db.transaction('thumbs', 'readwrite').objectStore('thumbs').put({ blob, time: Date.now() }, key);
    } catch { /* storage full or blocked: memory only */ }
}

// images of other versions go, of the rest the newest DB_LIMIT stay
function prune(db) {
    try {
        const entries = [];
        const store = db.transaction('thumbs', 'readwrite').objectStore('thumbs');
        const req = store.openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                if (String(cursor.key).startsWith(`v${THUMB_VERSION}-`)) entries.push([cursor.key, cursor.value.time]);
                else cursor.delete();
                cursor.continue();
                return;
            }
            if (entries.length <= DB_LIMIT) return;
            entries.sort((a, b) => a[1] - b[1]);
            for (const [key] of entries.slice(0, entries.length - DB_LIMIT)) store.delete(key);
        };
    } catch { /* ignore */ }
}
