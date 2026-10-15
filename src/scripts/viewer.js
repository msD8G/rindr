import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ViewCube } from './view-cube.js';
import { ContourPass } from './contour.js';
import { HdriEditor } from './hdri/hdri-editor.js';
import { HdriRenderService } from './hdri/hdri-service.js';
import { studioPreset, cloneHdri } from './hdri/hdri-model.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { TESS_PRESETS, normalizeQuality, abortStepImport, buildBVHIsolated, fetchStepFile, readStepFile, releaseStepFile, tessellateStep, ImportLimitError } from './step-importer.js';
import { IMPORT, KI, SPLATS, RASTER, SCENE } from './config.js';
import { importMeshFile, MissingFilesError, MESH_EXTENSIONS } from './mesh-importer.js';
import { MaterialManager, FADE_MASK } from './material-manager.js';
import { MaterialPanel, MATERIAL_MIME } from './material-panel.js';
import { GraphApplier } from './graph-apply.js';
import { NodeEditor } from './node-editor.js';
import { createStudioEnvironment, loadHdri, listHdris, VignetteBackground } from './environment.js';
import { PathTracingView } from './pathtracer.js';
import { runBenchmark, showBenchmarkResult } from './benchmark.js';
import { SceneGraph } from './scene-graph.js';
import { Highlighter } from './highlight.js';
import { ObjectTransformer, applyTransform, ensureTransform, restoreTransform, captureTransform } from './transform.js';
import { History } from './history.js';
import { DepthOfField } from './dof.js';
import { LensEffects } from './lens-effects.js';
import { DebugStats } from './debug-stats.js';
import { t, applyDom, getLocale } from './i18n.js';
import { QuadMenu } from './quad-menu.js';
import { Exploder } from './explode.js';
import { KiRender, describeMaterial } from './ki-render.js';
import { kiSettings } from './ki-gemini.js';
import { PhysicalCamera } from 'three-gpu-pathtracer/src/objects/PhysicalCamera.js';
import { captureState, applyState, matchesModel, sceneModels, SCENE_FORMAT } from './scene-state.js';
import { createAssetsWindow } from './assets.js';
import { createImageExport } from './image-export.js';
import { encodePng } from './png-encode.js';
import { setFisheye, RasterFisheye, patchRaycaster, viewAngle, setViewAngle, fisheyeEnabled, fisheyeProject } from './fisheye.js';
import { PropertiesPanel } from './properties.js';
import { Slicer, isClosedGeometry } from './slicer.js';
import { RenderBatcher, BATCH_LAYER } from './render-batcher.js';
import { GroundProjection } from './ground.js';
import { GROUND_SURFACE } from './ground-reflection.js';
import { BackgroundDome } from './background-dome.js';
import { ContactShadow } from './contact-shadow.js';
import { ModelAnimation, createPlaybar } from './animation.js';
import { confirmDialog, dialogOpen } from './dialog.js';   // patches the path tracer's background lookup – import before it is created
import { ViewModeBar } from './view-mode.js';
import { SetupMenu } from './setup-menu.js';
import { buildAbout } from './about.js';
import { SplatMesh } from './splat/splat-mesh.js';
import { loadSplats, isSplatSource, SPLAT_EXTENSIONS } from './splat/splat-loader.js';
import { analyzeSplatScene } from './splat/splat-camera.js';
import { debugLog } from './log.js';

// Workaround three.js r186 (cf. mrdoob/three.js#34608, fix announced for r187):
// ViewportTextureNode creates its own framebuffer texture per render target via clone()
// (glass/transmission). But clone() shares the image object with the original – if e.g. the
// OIDN denoiser renders its helper buffers at a lower resolution, this also "shrinks" the canvas
// texture. It is then recreated in the middle of the render pass and every further frame uses
// the destroyed texture ("Destroyed texture used in a submit"). Clones get their own image here.
{
    const clone = THREE.FramebufferTexture.prototype.clone;
    THREE.FramebufferTexture.prototype.clone = function () {
        const copy = clone.call(this);
        copy.source = new THREE.TextureSource({ width: this.image.width, height: this.image.height });
        return copy;
    };
}

// static page texts (data-i18n in index.astro) in the current language
applyDom();

// Model: ?model=<file name from public/models> in the URL, otherwise empty scene (open a file via drag & drop)
const MODEL_FILE = new URLSearchParams(location.search).get('model');
// sub folders allowed (e.g. ?model=folder/scene.gltf – .bin/textures are resolved relative to it)
const MODEL_URL = `${import.meta.env.BASE_URL}models/${(MODEL_FILE || '').split('/').map(encodeURIComponent).join('/')}`;
// OIDN weights (Apache 2.0, from RenderKit/oidn-weights)
const DENOISE_WEIGHTS_URL = `${import.meta.env.BASE_URL}oidn/rt_hdr_alb_nrm.tza`;

const loadingEl = document.getElementById('loading');
function showStatus(text) {
    loadingEl.textContent = text;
    loadingEl.style.opacity = '1';
}
// Empty scene: headline "drop a file into the window" + the supported formats below it
function showDropHint() {
    const title = document.createElement('div');
    title.textContent = t('status.dropHint');
    const formats = document.createElement('div');
    formats.className = 'mt-1 text-sm text-white/60';
    formats.textContent = t('status.dropFormats');
    loadingEl.replaceChildren(title, formats);
    loadingEl.style.opacity = '1';
}
function hideStatus() {
    loadingEl.style.opacity = '0';
}
// short message, disappears by itself (unless it has been replaced in the meantime)
let flashTimer = 0;
function flashStatus(text, ms = 1500) {
    showStatus(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (loadingEl.textContent === text) hideStatus(); }, ms);
}

// Undo/redo (Ctrl+Z / Ctrl+Y), at most 50 steps
const history = new History({ limit: 50 });
// Loading progress (bottom): phase + bar; fraction undefined = indeterminate
const progressEl = document.getElementById('progress');
const progressLabel = progressEl.querySelector('[data-label]');
const progressBar = progressEl.querySelector('[data-bar]');
function showProgress(text, fraction) {
    optimizeWait = null;   // another task takes over the display
    progressEl.hidden = false;
    progressLabel.textContent = text;
    const known = Number.isFinite(fraction);
    progressBar.style.width = known ? `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%` : '100%';
    progressBar.classList.toggle('animate-pulse', !known);
    progressBar.classList.toggle('opacity-50', !known);
}
function hideProgress() {
    optimizeWait = null;
    progressEl.hidden = true;
}
// After loading: the raster view still groups the meshes (render-batcher.js, after the fade-in + 500 ms, then
// compiles shaders) – "Optimizing display…" stays in the progress display until that is done (render loop)
let optimizeWait = null;
function finishProgress() {
    if (!batcher.enabled || viewMode === 'hq') { hideProgress(); return; }
    showProgress(t('status.optimizing'));
    optimizeWait = { rebuilds: batcher.stats.rebuilds, frames: 0, until: performance.now() + 10_000 };
}
function checkOptimizeWait() {
    const w = optimizeWait;
    if (!w) return;
    w.frames++;
    const done = batcher.stats.rebuilds > w.rebuilds
        // nothing to group (fade-in over, meshes compared this frame, no change pending)
        || (w.frames > 2 && !fading.size && batcher.synced && !batcher.pending)
        || performance.now() > w.until || viewMode === 'hq' || !batcher.enabled;
    if (done) hideProgress();
}
// Lets the browser paint the progress display before a long synchronous step
const afterPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));

// --- Scene, camera, renderer ---
const scene = new THREE.Scene();

// PhysicalCamera (PerspectiveCamera + aperture/focus plane) for depth of field in the path tracer
const camera = new PhysicalCamera(45, window.innerWidth / window.innerHeight, 0.01, 1000);
const dof = new DepthOfField(camera);
// camera position is computed automatically after loading

// WebGPU renderer (falls back to WebGL2 without WebGPU – then without path tracing).
// Without an explicit request the device only gets the WebGPU default limits (128 MB per storage
// buffer) – for fine tessellations the path tracer's geometry buffers are larger. So request the
// limits the hardware actually supports.
const GPU_OPTIONS = { powerPreference: 'high-performance' };
const adapter = await navigator.gpu?.requestAdapter(GPU_OPTIONS).catch(() => null);
const requiredLimits = adapter ? {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
} : undefined;
// stencil: closed cut surfaces of the section plane (slicer.js)
const renderer = new THREE.WebGPURenderer({ antialias: true, stencil: true, ...GPU_OPTIONS, requiredLimits });
try {
    await renderer.init();
} catch (err) {
    // neither WebGPU nor WebGL2 (e.g. no GPU and no software renderer in the browser): say so instead of a blank page
    console.error(err);
    showStatus(t('status.noRenderer'));
    throw err;
}
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
// tone mapping curves selectable in the camera panel ("Image"); key = stored value
const TONE_MAPPINGS = {
    aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping,
    reinhard: THREE.ReinhardToneMapping, cineon: THREE.CineonToneMapping, none: THREE.NoToneMapping,
};
const toneMappingKey = () => Object.keys(TONE_MAPPINGS).find(k => TONE_MAPPINGS[k] === renderer.toneMapping) || 'aces';
// Bloom / chromatic aberration (camera panel): the image then goes through an HDR target
const lens = new LensEffects(renderer);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap does not exist under WebGPU
document.getElementById('viewport').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;

// Environment shared by rasterizer and path tracer
scene.environment = createStudioEnvironment();
scene.environmentIntensity = 0.8;

// --- Lighting (in one group -> can be toggled together in the Scene Graph) ---
const lightsGroup = new THREE.Group();
lightsGroup.name = t('sceneEntries.lights');
scene.add(lightsGroup);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
ambientLight.name = t('sceneEntries.ambientLight');
lightsGroup.add(ambientLight);

const dirLight1 = new THREE.DirectionalLight(0xffeebb, 3.0);
dirLight1.position.set(5, 10, 7);
dirLight1.castShadow = true;
dirLight1.shadow.mapSize.width = 2048;
dirLight1.shadow.mapSize.height = 2048;
dirLight1.shadow.bias = -0.0005;
dirLight1.name = t('sceneEntries.mainLight');
lightsGroup.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0xaaccff, 1.5);
dirLight2.position.set(-8, 5, -5);
dirLight2.castShadow = true;
dirLight2.shadow.mapSize.width = 2048;
dirLight2.shadow.mapSize.height = 2048;
dirLight2.shadow.bias = -0.0005;
dirLight2.name = t('sceneEntries.fillLight');
lightsGroup.add(dirLight2);

// --- Section plane: the model hangs in its ClippingGroup ---
const slicer = new Slicer();
scene.add(slicer.group, slicer.object);

// Raster: meshes with the same geometry + material drawn as one InstancedMesh (render-batcher.js) – the
// individual meshes stay for everything else; picking raycasters therefore also test BATCH_LAYER
const batcher = new RenderBatcher({
    renderer, scene, parent: slicer.group,
    roots: () => [rootGroup, ...extraModels.map(x => x.root)],
});
const batchingParam = new URLSearchParams(location.search).get('batching');
batcher.setEnabled(batchingParam !== null ? batchingParam !== '0' : RASTER.batching);
slicer.capBatches = () => batcher.meshes;

// Light shadow maps only when something changed (two passes over the whole model, large assembly: ~16 ms CPU per
// frame). The lights stand still relative to the scene – orbiting the camera changes nothing. Redrawn when:
// the batcher's per-frame comparison reports a change (matrix, shown/hidden, geometry, material, new/removed
// mesh, skinning/morphs), a light or its shadow camera/the section plane changed (shadowInputs), a material
// was edited, parts are fading in. Without the batcher (?batching=0): every frame as before.
let shadowInputs = '';
let shadowsOn = true;   // false in Basic (setViewMode) – own flag: material events can fire before viewMode exists
const shadowsWanted = () => shadowsOn;
function markShadowsDirty() {
    lens.volume.markDirty();   // volumetric light shafts: sun depth map (also in Basic)
    if (!shadowsWanted()) return;
    for (const light of [dirLight1, dirLight2]) light.shadow.needsUpdate = true;
}
batcher.onChange = markShadowsDirty;
function updateShadowMaps() {
    const live = !batcher.enabled && shadowsWanted();
    for (const light of [dirLight1, dirLight2]) light.shadow.autoUpdate = live;
    if (live || !shadowsWanted()) return;
    const sig = [dirLight1, dirLight2].map(l => {
        const c = l.shadow.camera;
        return [l.visible, l.castShadow, ...l.position.toArray(), ...l.quaternion.toArray(), ...l.target.position.toArray(),
            c.left, c.right, c.top, c.bottom, c.near, c.far, l.shadow.mapSize.x, l.shadow.mapSize.y, l.shadow.bias, l.shadow.normalBias, l.shadow.radius].join();
    }).join('|') + `|${lightsGroup.visible}|${slicer.group.enabled}|${slicer.plane.normal.toArray()}|${slicer.plane.constant}`;
    if (sig !== shadowInputs || fading.size) { shadowInputs = sig; markShadowsDirty(); }
}

// Directional lights: keep the direction, adapt distance and shadow camera to the model size
// (the default shadow camera of ±5 units would be far too small for models in mm)
const LIGHT_DIRECTIONS = new Map();
function fitShadows(size, center = new THREE.Vector3()) {
    for (const light of lightsGroup.children) {
        if (!light.isDirectionalLight) continue;
        if (!LIGHT_DIRECTIONS.has(light)) LIGHT_DIRECTIONS.set(light, light.position.clone().normalize());
        light.position.copy(LIGHT_DIRECTIONS.get(light)).multiplyScalar(size * 2).add(center);
        light.target.position.copy(center);
        light.target.updateMatrixWorld();
        const cam = light.shadow.camera;
        const extent = size * 1.5;   // model + shadow cast onto the ground
        cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
        cam.near = size * 0.01;
        cam.far = size * 5;
        cam.updateProjectionMatrix();
        light.shadow.bias = -0.0005;
        light.shadow.normalBias = size * 0.002;
        light.updateMatrixWorld();
    }
}

// --- Pathtracing (three-gpu-pathtracer, WebGPU) ---
const pathTracing = new PathTracingView(renderer, { denoiseWeightsUrl: DENOISE_WEIGHTS_URL });
// shaders of the denoiser's albedo/normal pass are compiled in advance – through the batches like the raster view
pathTracing.compileScene = (s, c) => batcher.compileAsync(s, c);
pathTracing.compileKey = () => batcher.generation;
// path tracer modules: not in the start bundle – loaded when the browser is idle after the start, so
// switching to HQ later does not wait for the download (setScene() waits for it if HQ comes earlier)
(window.requestIdleCallback || (fn => setTimeout(fn, 1500)))(() => {
    pathTracing.load().catch(err => console.warn('[Pathtracer] preload failed:', err));
    pathTracing.prepareEnvironment(scene.environment);   // importance-sampling table in a worker
}, { timeout: 4000 });

// GPU errors (e.g. model too large for the buffer limits): switch path tracing off instead of
// flooding the console with follow-up errors. Print each message only once.
const loggedGpuErrors = new Set();
renderer.onError = info => {
    if (!info.message?.includes('due to a previous error') && !loggedGpuErrors.has(info.message)) {
        loggedGpuErrors.add(info.message);
        console.error(`WebGPU ${info.type}: ${info.message}`);
    }
    // only buffer/memory errors concern the path tracer (model too large)
    if (pathTracing.ready && /buffer|binding size|out of memory/i.test(info.message || '')) pathTracing.fail(info.message);
};
// During movement (mouse pressed, zoom) rasterizer, afterwards path tracing again
controls.addEventListener('start', () => pathTracing.beginInteraction());
controls.addEventListener('end', () => pathTracing.endInteraction());
controls.addEventListener('change', () => pathTracing.updateCamera());
if (!pathTracing.supported) console.warn('WebGPU not available – path tracing disabled.');

// --- Environment: HDRI as light, optionally as background and as ground projection with shadows ---
const studioTexture = scene.environment;
const vignette = new VignetteBackground();   // default background when the HDRI is not shown
scene.background = vignette.texture;
vignette.update(camera, scene);
pathTracing.backgroundFollowsCamera = true;
const ground = new GroundProjection();
ground.setEnvironment(studioTexture);
const dome = new BackgroundDome();   // HDRI background as a finite dome (perspective when zooming)
// Contact shadow under the model in the raster preview (with "ground shadow"); recomputed when parts move
// or change visibility (updateTransforms), continuously while editing (gizmo, explode) or loading
const contactShadow = new ContactShadow();
let contactLive = false;
{
    const { updateTransforms, pauseForEdit, resumeAfterEdit } = pathTracing;
    pathTracing.updateTransforms = function (...a) { contactShadow.markDirty(); return updateTransforms.apply(this, a); };
    pathTracing.pauseForEdit = function (...a) { contactLive = true; return pauseForEdit.apply(this, a); };
    pathTracing.resumeAfterEdit = function (...a) { contactLive = false; contactShadow.markDirty(); return resumeAfterEdit.apply(this, a); };
}
scene.add(ground.mesh);
slicer.capExclude.push(ground.mesh);
// closed cut surfaces only for closed bodies: STEP solids (not surface models), other meshes checked
slicer.capRoot = () => rootGroup;
slicer.isClosed = mesh => {
    if (mesh.userData.closedSolid !== undefined) return mesh.userData.closedSolid;   // additional STEP model
    const inst = model?.type === 'step' && currentPlan ? currentPlan.instances[mesh.userData.instance] : null;
    if (inst) return !currentPlan.solids[inst.solid]?.surface;
    return isClosedGeometry(mesh.geometry);
};
// Prebuild BVH + tangents of the ground disc (~98,000 triangles) in a worker – otherwise the path tracer
// builds them synchronously on the main thread at the first HQ (~300 ms, even if the ground is hidden)
if (pathTracing.supported) {
    const src = ground.mesh.geometry;
    const g = {
        positions: src.getAttribute('position').array.slice(), normals: src.getAttribute('normal').array.slice(),
        uvs: src.getAttribute('uv').array.slice(), index: Uint32Array.from(src.index.array),
    };
    buildBVHIsolated(g).then(() => {
        ground.mesh.geometry = makeGeometry(g);
        src.dispose();
    }).catch(err => console.warn('[Ground] BVH in worker failed:', err));
}
// Preview of the environment for the environment panel. Per texture once a linear RGB copy (up to 1024 × 512,
// box-filtered from the half float data – point samples looked blocky, cached); per draw bilinear into the canvas
// at device pixels, × exposure (intensity × light boost), shifted by the rotation (world azimuth a shows texture
// azimuth a + rotation – three.js looks up rotationᵀ · direction), ACES + sRGB like the HDRI editor's canvas →
// a few ms, live while dragging the sliders.
const envPreviewBase = new WeakMap();
function previewBase(tex) {
    const img = tex?.image;
    if (!img?.data || !img.width) return null;
    let base = envPreviewBase.get(tex);
    if (base) return base;
    const { data, width, height } = img;
    const W = Math.min(1024, width), H = Math.max(1, W >> 1);
    const ch = Math.round(data.length / (width * height));
    const value = data instanceof Uint16Array ? i => THREE.DataUtils.fromHalfFloat(data[i]) : i => data[i];
    const rgb = new Float32Array(W * H * 3);
    const fx = width / W, fy = height / H;
    for (let y = 0; y < H; y++) {
        // canvas row 0 = top, texture row 0 = bottom
        const y0 = Math.floor((H - 1 - y) * fy), y1 = Math.max(y0 + 1, Math.floor((H - y) * fy));
        for (let x = 0; x < W; x++) {
            const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
            let r = 0, g = 0, b = 0, n = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const i = (sy * width + sx) * ch;
                    r += value(i); g += value(i + 1); b += value(i + 2); n++;
                }
            }
            const o = (y * W + x) * 3;
            rgb[o] = r / n; rgb[o + 1] = g / n; rgb[o + 2] = b / n;
        }
    }
    base = { W, H, rgb };
    envPreviewBase.set(tex, base);
    return base;
}
// tone mapping (ACES fit + sRGB, 0…255 as float) indexed by √(x / 64): fine steps in the darks – a linear 4096-step
// table spanned several 8-bit levels per step there (gradients showed bands)
const PREVIEW_LUT_SIZE = 16384;
const PREVIEW_LUT = (() => {
    const lut = new Float32Array(PREVIEW_LUT_SIZE);
    for (let i = 0; i < PREVIEW_LUT_SIZE; i++) {
        const q = i / (PREVIEW_LUT_SIZE - 1), x = 64 * q * q;
        const a = Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
        lut[i] = Math.min(1, a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055) * 255;
    }
    return lut;
})();
// 4 × 4 ordered dither (−0.5…0.5 of an 8-bit step): no visible steps left in soft gradients
const DITHER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16 - 0.5);
const toneMapped = (v, dither) => {
    const i = Math.min(PREVIEW_LUT_SIZE - 1, (Math.sqrt(Math.max(v, 0) / 64) * (PREVIEW_LUT_SIZE - 1)) | 0);
    return PREVIEW_LUT[i] + dither;
};
function drawEnvironmentPreview(canvas, tex, exposure, rotation) {
    const base = previewBase(tex);
    if (!base) return;
    // canvas in device pixels of its CSS size (sharp on HiDPI)
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(w / 2));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d'), out = ctx.createImageData(w, h);
    const { W, H, rgb } = base;
    const shift = rotation / (2 * Math.PI) * W;
    const px = [0, 0, 0];
    for (let y = 0; y < h; y++) {
        // bilinear: rows clamped, columns wrap around (equirect)
        const fy = Math.min(Math.max((y + 0.5) / h * H - 0.5, 0), H - 1), y0 = Math.floor(fy), y1 = Math.min(y0 + 1, H - 1), ty = fy - y0;
        for (let x = 0; x < w; x++) {
            let fx = ((x + 0.5) / w * W - 0.5 + shift) % W;
            if (fx < 0) fx += W;
            const x0 = Math.floor(fx), x1 = (x0 + 1) % W, tx = fx - x0;
            const a = (y0 * W + x0) * 3, b = (y0 * W + x1) * 3, c = (y1 * W + x0) * 3, d = (y1 * W + x1) * 3;
            for (let ch = 0; ch < 3; ch++) {
                px[ch] = (rgb[a + ch] * (1 - tx) + rgb[b + ch] * tx) * (1 - ty) + (rgb[c + ch] * (1 - tx) + rgb[d + ch] * tx) * ty;
            }
            const o = (y * w + x) * 4, dither = DITHER[(y & 3) * 4 + (x & 3)];
            out.data[o] = toneMapped(px[0] * exposure, dither);   // Uint8ClampedArray rounds + clamps
            out.data[o + 1] = toneMapped(px[1] * exposure, dither);
            out.data[o + 2] = toneMapped(px[2] * exposure, dither);
            out.data[o + 3] = 255;
        }
    }
    ctx.putImageData(out, 0, 0);
}

// HDRI editor (hdri/, docs/hdri-editor.md): own procedural HDRIs, rendered in a worker
const CUSTOM_HDRI = 'editor:';
const hdriService = new HdriRenderService();
const environment = {
    on: true,
    background: false,
    ground: false,
    // ground shadow disc – "size"/"softness" in the panel
    groundRadius: 3,     // soft edge of the ground shadow: ends at this distance from the centre (× model size)
    groundSoftness: 0.6, // share of the radius used for the transition (0 = hard edge)
    // ground reflection + bad weather (ground-reflection.js, path tracer only) – on the same disc, also without the shadow
    reflection: false,
    reflectionStrength: 0.5,
    reflectionBlur: 0.2,
    wet: false,          // bad weather: procedural puddles
    puddles: 0.4,        // share of the ground covered by puddles
    puddleSize: 0.5,     // puddle pattern size (× model size)
    dome: true,          // "flatten ground": HDRI background as a dome with flat floor instead of infinitely far away
    intensity: 0.8,      // brightness of the HDRI (visible background and base of the light)
    lightBoost: 1,       // extra light energy on the model – the visible background stays as it is
    domeShift: 0,        // "HDRI height": HDRI pushed up (share of 90°) – sphere and projected floor
    groundHeight: 1,     // "floor height": projection point above the ground (× model size) – floor distortion
    domeRadius: 10,      // "sphere size": radius of the background sphere (× model size) – parallax when zooming
    domeBlend: 0.3,      // "transition": rounding of the edge between floor and sphere (share of the radius)
    modelSize: 1,        // size of the whole scene (all models) – floor, dome, ground shadow scale with it
    groundY: 0,
    centerX: 0,          // middle of the scene's footprint (several models side by side)
    centerZ: 0,
    texture: studioTexture,
    hdris: listHdris(),  // files in public/hdr
    hdri: '',            // '' = procedural studio, 'editor:<id>' = own HDRI of the HDRI editor
    custom: new Map(),   // HDRI editor (hdri/): id -> description (hdri-model.js), rendered in a worker
    /** display name of an own HDRI ('editor:<id>'), otherwise null */
    customName(name) {
        return name?.startsWith(CUSTOM_HDRI) ? this.custom.get(name.slice(CUSTOM_HDRI.length))?.name ?? null : null;
    },
    /** HDRI editor while editing: show `texture` (the name stays) */
    useTexture(texture) {
        const previous = this.texture;
        this.texture = texture;
        ground.setEnvironment(texture);
        this.apply();
        if (previous !== studioTexture && previous !== texture) previous.dispose();
    },
    /** draw the current HDRI into `canvas` (environment panel): × intensity × light boost, turned like the light */
    drawPreview(canvas) {
        drawEnvironmentPreview(canvas, this.texture, this.intensity * this.lightBoost, scene.environmentRotation.y);
    },
    _loadId: 0,
    /**
     * Choose an HDRI ('' = studio). Loads in a worker; when switching quickly the last choice wins.
     * @param {string} name
     * @param {(p: object) => void} [onProgress]
     */
    hdriUrls: {},   // HDRIs loaded from files (asset window): name -> blob URL
    /** HDRI from a file (asset window, relink): becomes selectable under its name */
    selectFile(file, onProgress) {
        this.hdriUrls[file.name] ??= URL.createObjectURL(file);
        if (!this.hdris.includes(file.name)) this.hdris.push(file.name);
        return this.select(file.name, onProgress);
    },
    // Progress (loading, decoding, rendering an own HDRI) in the status monitor bottom left – not in the panel;
    // hidden afterwards unless a model is loading (that one owns the display then)
    async select(name, onProgress) {
        const id = ++this._loadId;
        this.hdri = name;
        let texture = studioTexture;
        const progress = p => {
            onProgress?.(p);
            if (id === this._loadId) showProgress(t(p.decoding ? 'status.decodingHdri' : 'status.loadingHdri'), p.total ? p.loaded / p.total : undefined);
        };
        try {
            if (name?.startsWith(CUSTOM_HDRI)) {
                // own HDRI: rendered from its description in the worker
                const doc = this.custom.get(name.slice(CUSTOM_HDRI.length));
                if (!doc) throw new Error(t('hdriEditor.missing'));
                showProgress(t('status.renderingHdri'));
                texture = await hdriService.texture(doc);
                if (id === this._loadId) await pathTracing.prepareEnvironment(texture);
                if (id !== this._loadId) { texture.dispose(); return false; }
            } else if (name) {
                // relinked HDRI (asset window): blob URL of the dropped file, otherwise public/hdr
                progress({});
                texture = await loadHdri(this.hdriUrls[name] || `${import.meta.env.BASE_URL}hdr/${encodeURIComponent(name)}`, progress);
                // path tracer's importance-sampling table in a worker first: raster and HQ switch together
                if (id === this._loadId) await pathTracing.prepareEnvironment(texture);
                if (id !== this._loadId) { texture.dispose(); return false; }
            }
        } finally {
            if (id === this._loadId && !loading) hideProgress();
        }
        const previous = this.texture;
        this.texture = texture;
        ground.setEnvironment(texture);
        this.apply();
        if (previous !== studioTexture && previous !== texture) previous.dispose();
        return true;
    },
    // Transfer state to scene + path tracer. params: only intensity/rotation changed (fast)
    matte: null,         // image export: plain background colour instead of HDRI/vignette (light unchanged)
    apply({ geometry = false, params = false } = {}) {
        this.onChange?.();   // preview in the environment panel (texture, intensity, light boost, rotation)
        scene.environment = this.on ? this.texture : null;
        const showHdri = this.on && this.background && !this.matte;
        scene.background = this.matte || (showHdri ? this.texture : vignette.texture);
        // light = intensity × boost, the visible HDRI only intensity
        scene.environmentIntensity = this.intensity * this.lightBoost;
        scene.backgroundIntensity = showHdri ? this.intensity : 1;
        if (showHdri) scene.backgroundRotation.copy(scene.environmentRotation);
        else if (!this.matte) vignette.update(camera, scene);
        pathTracing.backgroundFollowsCamera = !showHdri && !this.matte;
        contactShadow.markDirty();
        const groundWas = ground.enabled;
        ground.enabled = this.on && (this.ground || this.reflection || this.wet);
        ground.shadow = this.ground;
        GROUND_SURFACE.params.value.set(this.reflection ? this.reflectionStrength : 0, this.reflectionBlur, this.wet ? 1 : 0, this.puddles);
        GROUND_SURFACE.params2.value.set(Math.max(this.puddleSize * this.modelSize, 1e-6), this.centerX, this.centerZ, showHdri ? 1 : 0);
        // ground disc: ring spacing relative to the model size (pure tessellation, no projection any more)
        const fadeEnd = this.groundRadius * this.modelSize;
        GROUND_SURFACE.params3.value.set(fadeEnd * (1 - this.groundSoftness), fadeEnd, 0, 0);   // reflection/puddles edge
        ground.place(this.groundY, this.modelSize, fadeEnd * (1 - this.groundSoftness), fadeEnd, this.centerX, this.centerZ);
        // one surface (flat floor → rounded edge → sphere) seen from the projection point above the ground centre
        const floorHeight = this.groundHeight * this.modelSize;
        dome.set(scene, {
            enabled: showHdri && this.dome && !this.matte, texture: this.texture, center: new THREE.Vector3(this.centerX, this.groundY + floorHeight, this.centerZ),
            radius: this.domeRadius * this.modelSize, floor: floorHeight,
            blend: this.domeBlend, shift: this.domeShift,
        });
        dome.update(camera);
        ground.update(scene);
        if (params) pathTracing.updateEnvironmentParams(); else pathTracing.updateEnvironment();
        pathTracing.updateMaterials();
        // ground pattern rotates with the HDRI -> update the ground disc's placement in the path tracer
        if (geometry || groundWas !== ground.enabled || (params && ground.enabled)) pathTracing.updateTransforms();
    },
};

// HDRI via URL: ?hdr=<file from public/hdr>
const HDR_PARAM = new URLSearchParams(location.search).get('hdr');
if (HDR_PARAM) environment.select(HDR_PARAM).catch(e => console.error(`HDRI ${HDR_PARAM}: ${e.message}`));

// --- Scene Graph ---
const sceneEntries = [
    {
        key: 'environment', get name() { return t('sceneEntries.environment'); }, kind: 'environment',
        toggle: {
            get: () => environment.on,
            set: v => { environment.on = v; environment.apply(); },
        },
    },
    {
        key: 'lights', get name() { return t('sceneEntries.lights'); }, kind: 'folder', object: lightsGroup,
        children: lightsGroup.children.map((light, i) => ({ key: 'light-' + i, name: light.name, kind: 'light', object: light })),
    },
    {
        key: 'camera', get name() { return t('sceneEntries.camera'); }, kind: 'camera', object: camera,
        get children() { return cameraViews.map(viewEntry); },   // saved views
    },
    {
        key: 'slicer', get name() { return t('sceneEntries.slicer'); }, kind: 'slicer', object: slicer.object,
        toggle: {
            get: () => slicer.enabled,
            set: v => { slicer.enabled = v; pathTracing.setSuspended(v); updateSlicerHelper(); },
        },
    },
];
// show the plane outline only while it is selected
const updateSlicerHelper = () => { slicer.helper.visible = selection?.kind === 'slicer'; };

const highlighter = new Highlighter(renderer, scene, camera);
// contour lines of toon/outline materials (contour.js) – over raster and path-traced image, part of exports
const contours = new ContourPass(renderer, scene, camera, {
    roots: () => [rootGroup, ...extraModels.map(x => x.root)],
    hide: () => [ground.mesh],
    depthScale: () => camera.position.distanceTo(controls.target),
});
// fisheye in the raster views (cube map like drei); picking and gizmo get fisheye rays
const rasterFisheye = new RasterFisheye();
highlighter.fisheye = rasterFisheye;

// Move/rotate objects (gizmo in its own overlay scene) + properties panel
const transformer = new ObjectTransformer(camera, renderer.domElement);
patchRaycaster(transformer.controls.getRaycaster());
transformer.addEventListener('dragstart', () => { controls.enabled = false; pathTracing.pauseForEdit(); });
let fieldDragging = false;   // a number field of the panel is being dragged (properties.js draggable)
transformer.addEventListener('dragend', e => { controls.enabled = true; pathTracing.resumeAfterEdit(e.detail.kind); });
transformer.overlayScene.add(slicer.helper);
transformer.addEventListener('change', e => {
    if (e.detail.kind === 'slicer') { slicer.update(); return; }   // also live while dragging
    if (transformer.controls.dragging || fieldDragging) return;   // while dragging (gizmo or number field), update only at the end
    if (e.detail.kind === 'light') pathTracing.updateLights();
    else pathTracing.updateTransforms();
});
// completed move/rotation (gizmo or panel) -> undo
transformer.addEventListener('edit', e => {
    const { object, kind, before, after } = e.detail;
    const resolve = objectResolver(object, kind);
    const set = state => {
        const o = resolve();
        if (!o) return;
        restoreTransform(o, kind, state);
        if (kind === 'slicer') slicer.update();
        else if (kind === 'light') { pathTracing.updateLights(); if (ground.enabled) environment.apply({ params: true }); }
        else pathTracing.updateTransforms();
    };
    history.record({ label: t(kind === 'light' ? 'viewer.undo.moveLight' : kind === 'selection' ? 'viewer.undo.transformSelection' : 'viewer.undo.transform'), undo: () => set(before), redo: () => set(after) });
});
// Gizmo target: multi-selection only of whole parts (not a material selection of single face groups)
// hidden (itself or a parent group) -> not editable, no gizmo
const shownInScene = o => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
const isHiddenEntry = e => (!e ? false
    : e.kind === 'selection' ? !e.object.members.every(shownInScene)
    : e.kind === 'node' || e.kind === 'model' || e.kind === 'light' ? !shownInScene(e.object)
    : false);
// Gaussian splats: no gizmo on the cloud – it was in the way of double clicking into the scene (position
// fields in the panel stay)
const gizmoTarget = entry => (isHiddenEntry(entry) ? null
    : ['model', 'node', 'selection'].includes(entry?.kind) && splatMesh ? null
    : entry?.kind === 'selection'
    ? (entry.object.members.every(m => !m.isMesh) ? entry.object : null)
    : entry?.kind === 'surface' ? null   // a sub-surface belongs to the solid, cannot be moved on its own
    : entry?.object ?? null);

// Find the object again for undo: model nodes are replaced on re-tessellation (same order)
// Undo target of a gizmo edit. Main model: by node index (its groups are rebuilt on re-tessellation);
// additional models are never rebuilt → the object itself (previously their root/parts resolved to the
// main model – undo moved the wrong model).
function objectResolver(object, kind) {
    const resolveOne = o => {
        if (o === rootGroup) return () => rootGroup;
        const i = currentNodeGroups.indexOf(o);
        return i >= 0 ? () => currentNodeGroups[i] : () => o;
    };
    if (kind === 'selection') {
        const members = object.members.map(resolveOne);
        return () => ({ members: members.map(r => r()).filter(Boolean) });
    }
    if (kind === 'model' || kind === 'node') return resolveOne(object);
    return () => object;
}
const properties = new PropertiesPanel(document.getElementById('properties'), {
    transformer, scene, camera, slicer,
    splats: () => !!splatMesh,
    // IFC element: its properties from the web-ifc worker of the owning model (cached per element)
    bim: entry => {
        const ifc = entry.object?.userData?.ifc;
        if (!ifc?.id) return null;
        let root = entry.object;
        while (root && !root.userData.modelRoot) root = root.parent;
        const bim = root?.userData.bim;
        if (!bim) return null;
        bim.cache ??= new Map();
        bim.openSections ??= new Set();
        return { openSections: bim.openSections, load: () => { if (!bim.cache.has(ifc.id)) bim.cache.set(ifc.id, bim.properties(ifc.id).catch(err => { bim.cache.delete(ifc.id); throw err; })); return bim.cache.get(ifc.id); } };
    },
    onSlicerChange: () => {},
    environment,
    onLightChange: () => { pathTracing.updateLights(); if (ground.enabled) environment.apply({ params: true }); pathTracing.updateCamera(); },
    onEnvironmentChange: opts => { environment.apply(opts); if (opts?.params) pathTracing.updateCamera(); },
    // slider being dragged (environment, light): reduced path tracing like when orbiting the camera
    onSliderDrag: active => (active ? pathTracing.beginInteraction() : pathTracing.endInteraction()),
    // dragging a number field: transforms like the gizmo (raster preview, path tracing scene once at the end),
    // camera fields like orbiting (reduced path tracing)
    onFieldDrag: (key, active) => {
        if (key === 'cp' || key === 'cr') { if (active) pathTracing.beginInteraction(); else pathTracing.endInteraction(); return; }
        fieldDragging = active;
        if (active) { transformer.beginFieldEdit(); pathTracing.pauseForEdit(); }
        else { transformer.endFieldEdit(); pathTracing.resumeAfterEdit(transformer.kind); }
    },
    sceneSize: () => environment.modelSize || 1000,
    onCameraChange: () => pathTracing.updateCamera(),
    get cameraViews() { return cameraViewApi; },   // defined further down
    get morphs() { return morphApi; },   // defined further down
    get hdriEditor() { return hdriApi; },   // defined further down
    onHdriError: (name, err) => { console.error(`HDRI ${name}: ${err.message}`); flashStatus(t('sceneState.hdriError', { name: environment.customName(name) ?? name, message: err.message }), 6000); },
    missingModels: { relink: () => assetsWindow.show(), remove: entry => removeMissingModel(entry) },
    // camera position/rotation from the panel (orbit camera: the target moves along)
    setCameraPose: ({ position, rotation }) => {
        cancelFlight();
        streamFit.active = false;
        if (position) {
            const shift = new THREE.Vector3().fromArray(position).sub(camera.position);
            camera.position.add(shift);
            controls.target.add(shift);
        }
        if (rotation) {
            const distance = camera.position.distanceTo(controls.target);
            const euler = new THREE.Euler(...rotation.slice(0, 2).map(THREE.MathUtils.degToRad), 0, 'YXZ');
            const forward = new THREE.Vector3(0, 0, -1).applyEuler(euler);
            controls.target.copy(camera.position).addScaledVector(forward, distance);
            if (rotation[2] !== undefined) setCameraRoll(rotation[2]);
        }
        controls.update();
        pathTracing.updateCamera();
        properties.refreshCamera();
    },
    record: step => history.record(step),
    dof,
    get exploder() { return exploder; },
    isHidden: entry => isHiddenEntry(entry),
    // dragging the explode slider: raster preview, update the path tracing scene once on release
    onExplodeDrag: active => { explodeDragging = active; if (active) pathTracing.pauseForEdit(); else pathTracing.resumeAfterEdit('node'); },
    onDofChange: () => { dof.apply(); pathTracing.updateCamera(); },
    lens,   // bloom, chromatic aberration (post-processing only, path tracing continues)
    // image look: exposure (EV, renderer) and tone mapping curve; white balance etc. live in lens.look
    look: {
        toneMappings: Object.keys(TONE_MAPPINGS),
        get exposure() { return Math.log2(renderer.toneMappingExposure); },
        set exposure(ev) { renderer.toneMappingExposure = 2 ** ev; },
        get toneMapping() { return toneMappingKey(); },
        set toneMapping(key) { renderer.toneMapping = TONE_MAPPINGS[key] ?? THREE.ACESFilmicToneMapping; },
    },
    focusRange: () => Math.ceil(Math.max(camera.position.distanceTo(controls.target) * 3, dof.focusDistance * 1.5, 1)),
    focusOnTarget: ({ record = true } = {}) => setFocus(dof.depthOf(controls.target), { label: t('viewer.undo.focusOnPivot'), record }),
    onPickFocus: () => startFocusPick(),
    // dragging the focus slider: raster preview with tinted focus plane, then path tracing restarts
    onFocusEdit: active => (active ? pathTracing.pauseForEdit() : pathTracing.resumeAfterEdit('camera')),
    // quality per part (STEP only)
    partQuality: {
        presets: Object.keys(TESS_PRESETS),
        available: entry => model?.type === 'step' && !!currentPlan && entry.kind === 'node' && entry.extra === undefined,
        get: entry => settings.partQuality[nodeOf(entry)] || '',
        inherited: entry => nodeQuality(currentPlan.nodes, currentPlan.nodes[nodeOf(entry)]?.parent ?? -1) || settings.meshQuality,
        set: (entry, q) => setPartQuality(nodeOf(entry), q),
    },
});
// environment changed (HDRI, HDRI editor rendering, intensity, light boost, rotation): preview in the panel
environment.onChange = () => properties.refreshEnvironmentPreview();
const nodeOf = entry => Number(entry.key.slice(1));   // Scene Graph key 'n<index>'

// --- Depth of field: set the focus plane (pivot, click into the model, autofocus) ---
function setFocus(distance, { label = t('viewer.undo.setFocus'), record = true } = {}) {
    const before = dof.focusDistance;
    const apply = v => {
        dof.focusDistance = v;
        dof.focusSet = true;
        dof.apply();
        pathTracing.updateCamera();
        properties.refreshFocus();
    };
    apply(distance);
    if (record && before !== distance) history.record({ label, undo: () => apply(before), redo: () => apply(distance) });
}
let focusPick = false;   // next click into the 3D view sets the focus plane
function startFocusPick() {
    focusPick = true;
    renderer.domElement.style.cursor = 'crosshair';
    showStatus(t('status.focusPick'));
}
function endFocusPick() {
    focusPick = false;
    renderer.domElement.style.cursor = '';
    hideStatus();
}
controls.addEventListener('change', () => {
    if (selection?.kind === 'camera') properties.refreshCamera();   // live position/rotation in the panel
    if (!dof.enabled || !dof.autoFocus) return;
    dof.focusDistance = dof.depthOf(controls.target);
    dof.apply();
    properties.refreshFocus();
});
// view keys (view cube directions)
const VIEW_KEYS = { t: [0, 1, 0], f: [0, 0, 1], b: [0, 0, -1], d: [0, -1, 0], l: [-1, 0, 0], r: [1, 0, 0] };
// text fields keep their own Ctrl+Z (sliders, colour pickers, checkboxes do not)
const isTextField = el => !!el.closest?.('textarea, select, input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=button])');
window.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || key === 'y')) {
        if (isTextField(e.target)) return;
        e.preventDefault();
        undoRedo(key === 'y' || e.shiftKey);
        return;
    }
    if (e.target.closest?.('input, textarea, select')) return;
    // Ctrl+A (Cmd+A): select all visible parts (in text fields it stays select-all text)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'a') {
        e.preventDefault();
        if (rootGroup) sceneGraph.selectAllParts();
        return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && ['1', '2', '3'].includes(e.key) && !splatMesh) setViewMode(['basic', 'default', 'hq'][Number(e.key) - 1]);
    if (key === 'u' && !e.ctrlKey && !e.metaKey && !e.altKey) toggleUi();
    if (e.key === 'w' || e.key === 'W') { transformer.setMode('translate'); properties.show(selection); }
    if (e.key === 'e' || e.key === 'E') { transformer.setMode('rotate'); properties.show(selection); }
    // S: scale (was R – R is the right view now, user's choice)
    if (key === 's' && !e.ctrlKey && !e.metaKey && !e.altKey) { transformer.setMode('scale'); properties.show(selection); }
    // views like the view cube: T top, F front, B back, D bottom (down), L left, R right
    const view = !e.ctrlKey && !e.metaKey && !e.altKey && VIEW_KEYS[key];
    if (view) flyToDirection(new THREE.Vector3(...view));
    if (key === 'x' && !e.ctrlKey && !e.metaKey && !e.altKey && !splatMesh) toggleExplode();
    if (e.key === 'Escape') {
        if (focusPick) endFocusPick();
        else if (nodeEditor.isOpen) nodeEditor.close(); else sceneGraph.select(null);
    }
    // A: frame the camera on the selection (was F – F is the front view now), H: hide the selection
    if (key === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey && isModelEntry(selection)) frameObject(selection.object);
    // Z: centre the camera on the whole (visible) model and zoom in
    if (key === 'z' && !e.ctrlKey && !e.metaKey && !e.altKey && rootGroup) frameObject(extraModels.length ? slicer.group : rootGroup);
    if (key === 'h' && isModelEntry(selection)) hideSelection();
    // Space: play/pause the animation
    if (e.key === ' ' && clipAnims().length && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setAnimPlaying(!animPlaying); }
    // Del: delete the selection (parts, models, saved camera views)
    if ((e.key === 'Delete' || e.key === 'Del') && selection?.kind === 'view') cameraViewApi.remove(selection.view);
    else if ((e.key === 'Delete' || e.key === 'Del') && selection?.kind === 'views') cameraViewApi.removeMany(selection.entries.map(v => v.view));
    else if ((e.key === 'Delete' || e.key === 'Del') && isModelEntry(selection)) deleteSelection();
    else if ((e.key === 'Delete' || e.key === 'Del') && selection?.kind === 'missing') removeMissingModel(selection);
});

// --- Scenes with several models + asset tracking (scene-state.js, assets.js) ---
// All loaded models in one list (main model first); sceneIndex = position in the opened scene file
function runtimeModels() {
    const list = [];
    if (rootGroup && model) list.push({ main: true, root: rootGroup, nodeGroups: currentNodeGroups, meshes: currentMeshes, prefix: '',
        file: { name: model.name, type: model.type, size: model.size ?? null }, holder: null, sceneIndex: mainSceneIndex, source: model,
        morphs: animations.find(a => a.owner === 'main')?.anim.morphValues(), animation: animState('main') });
    for (const x of extraModels) list.push({ main: false, id: x.id, root: x.root, nodeGroups: x.nodeGroups, meshes: x.meshes, prefix: `x${x.id}:`,
        file: { name: x.source.name, type: x.source.type, size: x.size ?? null }, holder: x.holder, sceneIndex: x.sceneIndex, source: x.source,
        morphs: animations.find(a => a.owner === x.id)?.anim.morphValues(), animation: animState(x.id) });
    return list;
}
const sameFile = (a, b) => !!a && !!b && a.name === b.name && (a.size == null || b.size == null || a.size === b.size);
const baseName = path => path.split(/[\\/]/).pop().toLowerCase();
let filePool = [];   // files handed in for relinking (models, textures, HDRIs) – kept for later relinks

/**
 * Where is the file of a saved model? 1. an already loaded model with the same file (its textures + the
 * pool are passed along), 2. a handed-in file (drop, asset window), 3. the server (public/models).
 */
async function resolveModelSource(info, pool) {
    const extras = pool.filter(f => !MAIN_EXTENSIONS.includes(extOf(f.path)));
    const loaded = runtimeModels().find(rm => sameFile(rm.file, info))?.source;
    if (loaded) return loaded.type === 'mesh' ? { ...loaded, files: [...(loaded.files || []), ...extras] } : loaded;
    // incomplete model (glTF without its .bin): the dropped file itself + the new files
    const incomplete = missingModels.find(m => m.source && m.name === info.name)?.source;
    if (incomplete) return { ...incomplete, files: [...(incomplete.files || []), ...extras], incomplete: true };
    const match = pool.find(f => baseName(f.path) === info.name.toLowerCase());
    if (match) return modelFromFiles([match, ...extras]);
    const url = `${import.meta.env.BASE_URL}models/${encodeURIComponent(info.name)}`;
    try {
        const res = await fetch(url, { method: 'HEAD' });
        if (!res.ok) return null;
    } catch { return null; }
    return sourceForUrl(info.name, url, extras);
}
// model source of a file on the server by its extension (Gaussian splats: .sog, .ply – a .ply may still turn
// out to be a mesh when loading)
function sourceForUrl(name, url, files = []) {
    const ext = extOf(name);
    if (SPLAT_EXTENSIONS.includes(ext)) return { name, type: 'splat', url, main: null };
    return MESH_EXTENSIONS.includes(ext)
        ? { name, type: 'mesh', url, main: null, files, baseUrl: url }
        : { name, type: 'step', url, content: null };
}
// a .ply without splat properties: plain mesh (mesh-importer.js)
const meshSourceOf = src => ({ name: src.name, type: 'mesh', main: src.main || null, url: src.url, files: src.files || [], ...(src.url && !src.main ? { baseUrl: src.url } : {}) });
async function classifyModel(src) {
    return src?.type === 'splat' && !(await isSplatSource(src)) ? meshSourceOf(src) : src;
}

/**
 * Open a scene file: find every saved model, load the found ones (first = main model, the others with
 * their saved placement), then apply the state. Missing ones stay as placeholders (⚠ in the Scene Graph,
 * asset window). files: handed in together with the scene (drop) – go into the pool.
 */
async function openSceneFile(state, files = [], { reload = false } = {}) {
    filePool = [...filePool, ...files];
    const chunks = sceneModels(state);
    if (!chunks.length) { await restoreScene(state, { force: true }); rebuildPathTracing(); return; }
    // exactly these models are loaded already: only apply the state
    const loaded = runtimeModels();
    if (!reload && loaded.length === chunks.length && loaded.every((rm, i) => sameFile(rm.file, chunks[i].file))) {
        mainSceneIndex = 0;
        extraModels.forEach((x, i) => { x.sceneIndex = i + 1; });
        missingModels = [];
        await restoreScene(state, { force: true });
        checkAssets(state);
        return;
    }
    showProgress(t('status.restoringScene'));
    sceneChunks = chunks;
    const sources = await Promise.all(chunks.map(c => resolveModelSource(c.file || {}, filePool).then(classifyModel)));
    missingModels = chunks.map((chunk, sceneIndex) => ({ sceneIndex, name: chunk.file?.name || '?', chunk })).filter((m, i) => !sources[i]);
    const first = sources.findIndex(Boolean);
    if (first < 0) {
        // no model file found: nothing can be loaded – show what is missing
        hideProgress();
        sceneGraph.select(null);
        clearModel();
        model = null;
        primaryContent = null;
        // take over everything else of the scene anyway (materials, HDRI + its options, lights, camera, path
        // tracing, lens …): a later relink captures the state again – it would otherwise save the defaults
        // (previously only the materials, the HDRI choice etc. were lost)
        await restoreScene(state, { force: true });
        refreshSceneGraph();
        checkAssets(state);
        return;
    }
    mainSceneIndex = first;
    openModel(sources[first]);
    sources.forEach((src, i) => { if (src && i !== first) addModel(src, { sceneIndex: i, placement: chunks[i].placement }); });
    await runLoad(null);
    await restoreScene(state, { force: true });
    refreshSceneGraph();
    checkAssets(state);
}
// Scene opened or relinked: build the path tracing scene once from scratch with the final state (camera
// incl. depth of field, lens, environment, materials) – the incremental updates while loading/restoring
// did not always reach it (e.g. depth of field). In Default it is rebuilt on the next switch to HQ.
function rebuildPathTracing() {
    pathTracing.invalidate();
    updatePathTracingScene();
}
let openedScene = null;
let sceneChunks = [];     // models of the scene being opened (an incomplete one keeps its saved state)   // last opened scene (relinking reopens it with the new files)
// status of the HDRI and missing parts → asset window (opens by itself if something is missing)
function checkAssets(state) {
    openedScene = state;
    rebuildPathTracing();
    const hdri = state?.environment?.hdri;
    missingHdri = hdri && !environment.hdris.includes(hdri) && !environment.customName(hdri) ? hdri : null;
    assetsWindow.render();
    if (assetRows().some(r => r.status === 'missing')) assetsWindow.show();
    updateAssetsTool();
}
let missingHdri = null;
function assetRows() {
    const rows = [];
    for (const rm of runtimeModels()) {
        rows.push({ kind: 'model', name: rm.file.name, status: 'ok' });
        const textures = rm.main ? model?.missingTextures : extraModels.find(x => x.id === rm.id)?.missingTextures;
        for (const tex of textures || []) rows.push({ kind: 'texture', name: tex.split(/[\\/]/).pop(), status: 'missing', detail: t('assets.textureOf', { model: rm.file.name }) });
    }
    for (const m of missingModels) {
        // incomplete (glTF without .bin): the model itself is there, its files are not
        rows.push({ kind: 'model', name: m.name, status: 'missing', detail: m.files ? t('assets.incomplete') : undefined });
        for (const f of m.files || []) rows.push({ kind: f.kind === 'image' ? 'texture' : 'file', name: f.uri.split(/[\\/]/).pop(), status: 'missing',
            detail: t(f.kind === 'image' ? 'assets.textureOf' : 'assets.bufferOf', { model: m.name }) });
    }
    if (environment.hdri) rows.push({ kind: 'hdri', name: environment.customName(environment.hdri) ?? environment.hdri, status: 'ok',
        detail: environment.customName(environment.hdri) ? t('hdriEditor.assetDetail') : undefined });
    if (missingHdri) rows.push({ kind: 'hdri', name: missingHdri, status: 'missing' });
    return rows;
}
// relink: HDRIs directly; models/textures → the scene is reopened with the files (state of everything kept).
// Serialised: a second drop while the first relink is still loading waits for it (otherwise it captured a
// half-loaded scene). Afterwards a short message: how many were linked, which dropped files match nothing.
let relinkChain = Promise.resolve();
function relinkFiles(files) {
    relinkChain = relinkChain.then(() => relinkNow(files)).catch(err => console.error(err));
    return relinkChain;
}
async function relinkNow(files) {
    await runLoad(null);
    const missingBefore = new Set(assetRows().filter(r => r.status === 'missing').map(r => r.name.toLowerCase()));
    const dropped = files.map(f => baseName(f.path));
    const unmatched = dropped.filter(n => !missingBefore.has(n));
    await relinkApply(files);
    const missingAfter = new Set(assetRows().filter(r => r.status === 'missing').map(r => r.name.toLowerCase()));
    const linked = [...missingBefore].filter(n => !missingAfter.has(n)).length;
    if (unmatched.length) showStatus(t('status.relinkUnmatched', { count: linked, files: unmatched.slice(0, 3).join(', ') + (unmatched.length > 3 ? ` (+${unmatched.length - 3})` : '') }));
    else flashStatus(t('status.relinked', { count: linked }), 4000);
    if (!missingAfter.size) assetsWindow.hide();   // everything linked: the window has done its job
}
async function relinkApply(files) {
    const hdrFile = files.find(f => /\.(hdr|exr)$/i.test(f.path) && (!missingHdri || baseName(f.path) === missingHdri.toLowerCase()));
    if (missingHdri && hdrFile) {
        await environment.selectFile(hdrFile.file, p => showProgress(t(p.decoding ? 'status.decodingHdri' : 'status.loadingHdri'), p.total ? p.loaded / p.total : undefined));
        hideProgress();
        missingHdri = null;
        assetsWindow.render();
        updateAssetsTool();
    }
    const others = files.filter(f => f !== hdrFile);
    if (!others.length) return;
    // models (missing ones and existing ones with missing textures): reopen the current scene
    const state = captureState(sceneStateContext);
    // nothing loaded yet (only placeholders, e.g. a .gltf without its .bin): the current camera belongs to
    // the empty scene – keep the camera fit of the load instead of restoring it (model was out of view)
    if (!runtimeModels().length && !openedScene) delete state.camera;
    // the loaded models stay the same files – reload anyway so missing textures/.bin get picked up
    await openSceneFile(state, others, { reload: true });
}

// A glTF could not be loaded because files are missing (.bin): it stays in the scene as an incomplete
// placeholder (⚠ in the Scene Graph, its files listed in the asset window) – handing in the files reloads it
// (also when reloading such a model fails otherwise – it must not vanish from the scene)
function registerIncomplete(source, err, sceneIndex) {
    const files = err.files || source.missingFiles || [];
    source = { ...source, files: source.files || [], missingFiles: files, incomplete: false };
    // replace the earlier entry of the same model: same position in the scene – not the same name
    // (the same file can be in the scene twice; previously the second one removed the first)
    const index = Number.isFinite(sceneIndex) ? sceneIndex : Infinity;
    missingModels = missingModels.filter(m => Number.isFinite(index) ? m.sceneIndex !== index : m.source?.main !== source.main);
    // from a scene file: keep its saved state (placement, materials …) for the next save/relink
    const saved = Number.isFinite(index) && sceneChunks[index]?.file?.name === source.name ? sceneChunks[index] : null;
    missingModels.push({ sceneIndex: index, name: source.name, source, files,
        chunk: saved || { file: { name: source.name, type: source.type, size: source.main?.size ?? null }, placement: null, transforms: {}, hidden: [], deleted: [], assignments: {} } });
    missingModels.sort((a, b) => a.sceneIndex - b.sceneIndex);
    if (!(err instanceof MissingFilesError)) { console.error(err); refreshSceneGraph(); assetsWindow.show(); updateAssetsTool(); showStatus(t('status.error', { message: err.message })); return; }
    const names = files.map(f => f.uri.split(/[\\/]/).pop());
    showStatus(t('status.modelIncomplete', { name: source.name, files: names.slice(0, 3).join(', ') + (names.length > 3 ? ` (+${names.length - 3})` : '') }));
    refreshSceneGraph();
    assetsWindow.show();
    updateAssetsTool();
}

// remove a missing/incomplete model from the scene (placeholder only – nothing loaded to dispose)
async function removeMissingModel(entry) {
    const m = missingModels[entry.index];
    if (!m) return;
    if (!await confirmDialog({ title: t('viewer.removeModelTitle', { count: 1 }), message: t('viewer.confirmRemoveMissing', { name: m.name }),
        confirmLabel: t('viewer.removeModelConfirm'), danger: true })) return;
    missingModels = missingModels.filter(x => x !== m);
    sceneGraph.select(null);
    refreshSceneGraph();
    assetsWindow.refresh();
    updateAssetsTool();
    if (!rootGroup && !missingModels.length) { assetsWindow.hide(); showDropHint(); }   // empty again
}

// --- Delete (Del key, quad menu) ---
// Parts/assemblies/surface groups: invisible and out of the Scene Graph (sceneGraph.deleted, saved in the
// scene state, survives re-tessellation), one undo step; "reset" brings them back. A whole model is
// removed (after a question – not undoable).
async function deleteSelection() {
    if (!isModelEntry(selection)) return;
    const entries = selection.kind === 'selection' ? [...sceneGraph.marked] : [selection];
    // whole models (all of them – previously only the first): additional ones first, the main model last
    // (its successor is then chosen among the remaining models)
    const models = entries.filter(e => e.kind === 'model');
    if (models.length) {
        const question = models.length === 1
            ? t('viewer.confirmRemoveModel', { name: models[0].name })
            : t('viewer.confirmRemoveModels', { count: models.length, names: models.map(m => m.name).join(', ') });
        if (!await confirmDialog({ title: t('viewer.removeModelTitle', { count: models.length }), message: question, confirmLabel: t('viewer.removeModelConfirm'), danger: true })) return;
        for (const m of models) if (m.extra !== undefined) removeExtraModels(m.extra);
        if (models.some(m => m.extra === undefined)) removeMainModel();
        return;
    }
    const keys = entries.filter(e => e.kind === 'node' || e.kind === 'surface').map(e => e.key);
    if (!keys.length) return;
    const apply = del => {
        keys.forEach(k => (del ? sceneGraph.deleted.add(k) : sceneGraph.deleted.delete(k)));
        sceneGraph.select(null);
        refreshSceneGraph();
        pathTracing.updateTransforms();
        materialManager.dispatchEvent(new CustomEvent('change'));   // usage counts in the material list
    };
    apply(true);
    history.record({ label: t('viewer.undo.delete', { count: keys.length }), undo: () => apply(false), redo: () => apply(true) });
}

// --- Show/hide (key H, quad menu) – one undo step each ---
function hideSelection() {
    if (!isModelEntry(selection)) return;
    sceneGraph.setVisible(selection.kind === 'selection' ? [...sceneGraph.marked] : selection, false);
}
function showAll() {
    const models = sceneGraph.tree.filter(e => e.kind === 'model');
    if (models.length) sceneGraph.setVisible(models, true);
}
// hide everything except the selection; parent assemblies of the selection stay visible
function hideUnselected() {
    if (!isModelEntry(selection)) return;
    const selected = selection.kind === 'selection' ? selection.object.members : [selection.object];
    const within = (a, b) => { for (let o = b; o; o = o.parent) if (o === a) return true; return false; };   // b in a
    const hide = [];
    const walk = entry => {
        for (const c of entry.children) {
            if (!c.object || (c.kind !== 'node' && c.kind !== 'surface')) continue;
            if (selected.some(sel => within(sel, c.object))) continue;          // belongs to the selection
            if (selected.some(sel => within(c.object, sel))) walk(c);           // contains selected items
            else hide.push(c);
        }
    };
    const modelEntry = sceneGraph.tree.find(e => e.kind === 'model');
    if (modelEntry) walk(modelEntry);
    if (hide.length) sceneGraph.setVisible(hide, false);
}

// --- Quad menu (right click without movement, like MAX) ---
const quadMenu = new QuadMenu();
function openQuadMenu(x, y) {
    if (!rootGroup) return;
    const hasSel = isModelEntry(selection);   // without a selection: only "Show all"
    const canTransform = hasSel && !!gizmoTarget(selection);
    const mode = m => ({
        label: t(`quadMenu.${m}`),
        shortcut: { translate: 'W', rotate: 'E', scale: 'S' }[m],
        active: canTransform && transformer.mode === m,
        disabled: !canTransform,
        onClick: () => { transformer.setMode(m); properties.show(selection); },
    });
    quadMenu.open(x, y, [
        {
            title: t('quadMenu.display'), quadrant: 'tr', items: [
                { label: t('quadMenu.showAll'), onClick: showAll },
                { label: t('quadMenu.hideUnselected'), disabled: !hasSel, onClick: hideUnselected },
                { label: t('quadMenu.hideSelection'), shortcut: 'H', disabled: !hasSel, onClick: hideSelection },
            ],
        },
        { title: t('quadMenu.transform'), quadrant: 'br', items: [mode('translate'), mode('rotate'), mode('scale')] },
    ]);
}
let rightDown = null;
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', e => { if (e.button === 2) rightDown = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', e => {
    if (e.button !== 2 || !rightDown) return;
    const moved = Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y);
    rightDown = null;
    if (moved > 4) return;   // right-dragged = camera panned
    // without a selection: select the object under the pointer (empty space: menu without selection)
    if (!isModelEntry(selection)) {
        const mesh = pickMesh(e);
        const entry = mesh ? sceneGraph.entryForObject(mesh) : null;
        if (entry) sceneGraph.select(entry);
    }
    openQuadMenu(e.clientX, e.clientY);
});
// Scene Graph: right click on a row selects it (unless already part of the selection) and opens the menu
document.querySelector('#scene-graph [data-tree-list]').addEventListener('contextmenu', e => {
    const entry = sceneGraph.entryAt(e.target);
    if (entry?.kind === 'missing') {
        e.preventDefault();
        sceneGraph.select(entry, { reveal: false });
        quadMenu.open(e.clientX, e.clientY, [{ title: t('quadMenu.display'), quadrant: 'tr', items: [
            { label: t('properties.missing.relink'), onClick: () => assetsWindow.show() },
            { label: t('quadMenu.delete'), shortcut: t('quadMenu.deleteKey'), onClick: () => removeMissingModel(entry) },
        ] }]);
        return;
    }
    if (!isModelEntry(entry)) return;
    e.preventDefault();
    if (entry !== selection && !sceneGraph.inSelection(entry)) sceneGraph.select(entry, { reveal: false });
    openQuadMenu(e.clientX, e.clientY);
});
const updateHighlight = () => highlighter.set(selection?.object, hovered?.object);

// --- Materials ---
const materialManager = new MaterialManager();
materialManager.scene = scene;
materialManager.history = history;
// Node graphs: constants directly, textures are baked (then update the path tracer)
const graphApplier = new GraphApplier(renderer, { onBaked: () => pathTracing.updateMaterials() });
materialManager.onApply = entry => graphApplier.apply(entry);
materialManager.addEventListener('change', () => pathTracing.updateMaterials());
materialManager.addEventListener('update', () => pathTracing.updateMaterials());
// edited material (alpha map, side …) can change the shadow; assignments are seen by the batcher's comparison
materialManager.addEventListener('update', () => markShadowsDirty());
const isModelEntry = e => e && (e.kind === 'node' || e.kind === 'model' || e.kind === 'surface' || e.kind === 'selection');
const materialPanel = new MaterialPanel(document.getElementById('materials'), materialManager, {
    getSelectionObject: () => (isModelEntry(selection) ? selection.object : null),
    onAssignToSelection: id => {
        if (!isModelEntry(selection)) return;
        assignMaterial(selection.object, id);
        materialPanel.setSelection(selection.object);
    },
    onOpenNodeEditor: id => openNodeEditor?.(id),
    onMergeDuplicates: () => mergeDuplicateMaterials(),
    // select all meshes with this material (multi-selection, "assign" replaces it on all of them)
    onSelectUsers: id => {
        const entry = materialManager.get(id);
        if (!entry || !rootGroup) return;
        const meshes = [];
        rootGroup.traverse(c => { if (c.isMesh && c.material === entry.material) meshes.push(c); });
        if (meshes.length) sceneGraph.selectMeshes(meshes, t('viewer.objectsWithMaterial', { name: entry.def.name }));
    },
});
const nodeEditor = new NodeEditor(document.getElementById('node-editor'), materialManager);
function openNodeEditor(id) { nodeEditor.open(id); }

// --- HDRI editor (hdri/hdri-editor.js): own procedural HDRIs, docked at the bottom or as a free window ---
const hdriEditor = new HdriEditor(document.getElementById('hdri-editor'), {
    service: hdriService,
    // rendered image of a description: shown if that HDRI is (still) the environment
    onApply: (texture, { final, id }) => {
        if (environment.hdri !== CUSTOM_HDRI + id) { texture.dispose(); return; }
        environment.useTexture(texture);
        if (!final) pathTracing.updateCamera();   // while dragging: reduced path tracing like orbiting
    },
    onSave: doc => {
        environment.custom.set(doc.id, doc);
        if (selection?.kind === 'environment') properties.show(selection);
    },
    onDuplicate: doc => {
        const copy = cloneHdri(doc);
        copy.name = t('hdriEditor.copyName', { name: doc.name });
        editCustomHdri(copy, { add: true });
    },
    onDelete: async doc => {
        const ok = await confirmDialog({ title: t('hdriEditor.deleteTitle'), message: t('hdriEditor.deleteMessage', { name: doc.name }), confirmLabel: t('hdriEditor.delete'), danger: true });
        if (!ok) return;
        hdriEditor.close();
        environment.custom.delete(doc.id);
        if (environment.hdri === CUSTOM_HDRI + doc.id) await environment.select('');
        if (selection?.kind === 'environment') properties.show(selection);
    },
    onDrag: active => (active ? pathTracing.beginInteraction() : pathTracing.endInteraction()),
    record: step => history.record(step),
    onClose: () => { if (selection?.kind === 'environment') properties.show(selection); },   // pencil no longer active
});
/** open the HDRI editor for a description (add: new one) – it becomes the environment */
async function editCustomHdri(doc, { add = false } = {}) {
    if (add) environment.custom.set(doc.id, doc);
    hdriEditor.open(doc);
    if (environment.hdri !== CUSTOM_HDRI + doc.id) {
        const before = environment.hdri;
        await environment.select(CUSTOM_HDRI + doc.id);
        history.record({ label: t('properties.environment.undo.hdri'), undo: () => environment.select(before), redo: () => environment.select(CUSTOM_HDRI + doc.id) });
    }
    if (selection?.kind === 'environment') properties.show(selection);
}
const hdriApi = {
    prefix: CUSTOM_HDRI,
    list: () => [...environment.custom.values()],
    // new HDRI from the studio template
    create: () => editCustomHdri(studioPreset(t('hdriEditor.newName', { n: environment.custom.size + 1 })), { add: true }),
    edit: id => { const doc = environment.custom.get(id); if (doc) editCustomHdri(doc); },
    isOpen: id => hdriEditor.isOpen && hdriEditor.docId === id,
};

let selection = null;   // selected Scene Graph entry
let hovered = null;     // entry under the mouse in the Scene Graph
const sceneGraph = new SceneGraph(document.getElementById('scene-graph'), {
    onVisibility: changed => {
        const kinds = new Set(changed.map(e => e.kind));
        if (kinds.has('node') || kinds.has('model')) pathTracing.updateTransforms();
        if (kinds.has('light') || kinds.has('folder')) { pathTracing.updateLights(); if (ground.enabled) environment.apply({ params: true }); }
        if (kinds.has('slicer') && selection?.kind === 'slicer') properties.show(selection);
        // selection hidden or shown again: remove or restore the gizmo, update the panel
        if (selection && selection.kind !== 'slicer') {
            const target = gizmoTarget(selection);
            if (target !== transformer.object) transformer.attach(target, selection.kind);
            properties.show(selection);
        }
        updateHighlight();
    },
    onSelect: entry => {
        if (entry?.kind === 'view' && entry !== selection) flyToView(entry.view);   // click on a saved view: fly there
        selection = entry;
        transformer.attach(gizmoTarget(entry), entry?.kind ?? null);
        properties.show(entry);
        updateSlicerHelper();
        materialPanel.setSelection(isModelEntry(entry) ? entry.object : null);
        updateHighlight();
    },
    onWarn: () => assetsWindow.show(),
    onHover: entry => { hovered = entry; updateHighlight(); },
    onActivate: entry => { if (isModelEntry(entry)) frameObject(entry.object); },
    onVisibilityEdit: (before, after) => history.record({
        label: t([...after.values()][0] ? 'viewer.undo.show' : 'viewer.undo.hide'),
        undo: () => sceneGraph.applyVisibility(before),
        redo: () => sceneGraph.applyVisibility(after),
    }),
});
// --- Saved camera views (camera panel "Save view", entries below "Camera" in the Scene Graph) ---
// position, orbit target, field of view and depth of field; a click flies there. In the scene state,
// adding/renaming/overwriting/deleting can be undone.
const cameraViews = [];   // [{ id, name, position, target, fov, dof }]
let cameraViewSeq = 0;
function viewEntry(view) {
    return (view.entry ??= { key: 'view-' + view.id, kind: 'view', view, children: [], get name() { return view.name; } });
}
const captureView = () => ({ position: camera.position.toArray(), target: controls.target.toArray(), fov: viewAngle(camera), roll: camera.userData.roll || 0, dof: dof.toJSON() });

// Roll (Dutch angle): the orbit controls keep the camera level; the roll (camera.userData.roll, degrees) is applied
// every frame after them as a rotation about the view axis – raster, path tracer (reads the camera on its next
// frame), fisheye, picking and gizmo all use the camera matrix and follow. Mouse orbiting stays level-based.
function applyCameraRoll() {
    const roll = camera.userData.roll || 0;
    if (!roll) return;
    camera.rotateZ(THREE.MathUtils.degToRad(roll));
    camera.updateMatrixWorld();
}
function setCameraRoll(deg) {
    const v = ((((Number(deg) || 0) + 180) % 360) + 360) % 360 - 180;
    const roll = Math.abs(v) < 1e-6 ? 0 : v;
    if (roll === (camera.userData.roll || 0)) return;
    camera.userData.roll = roll;
    controls.update();
    applyCameraRoll();
    pathTracing.updateCamera();
}
// roll (degrees) that turns the level camera looking along `forward` so that its up vector becomes `up` (BCF)
function rollFromUp(forward, up) {
    const f = forward.clone().normalize();
    const level = new THREE.Vector3(0, 1, 0).addScaledVector(f, -f.y);
    const want = up.clone().addScaledVector(f, -up.dot(f));
    if (level.lengthSq() < 1e-8 || want.lengthSq() < 1e-8) return 0;   // looking straight up/down: undefined
    level.normalize(); want.normalize();
    return THREE.MathUtils.radToDeg(Math.atan2(-f.dot(new THREE.Vector3().crossVectors(level, want)), level.dot(want)));
}
function setCameraViews(list, { select = null } = {}) {
    cameraViews.splice(0, cameraViews.length, ...list);
    if (cameraViews.length) sceneGraph.expanded.add('camera');
    refreshSceneGraph();
    if (select) sceneGraph.select(viewEntry(select));
    else if (selection?.kind === 'view' && !cameraViews.includes(selection.view)) sceneGraph.select(null);
}
function flyToView(view) {
    splatSpin.active = false;
    flight = {
        t0: performance.now(), duration: 600,
        fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
        toPos: new THREE.Vector3().fromArray(view.position), toTarget: new THREE.Vector3().fromArray(view.target),
        fromRoll: camera.userData.roll || 0, toRoll: view.roll || 0,
    };
    streamFit.active = false;
    setViewAngle(camera, view.fov ?? viewAngle(camera));
    if (view.dof) { dof.fromJSON(view.dof); dof.apply(); }
    flightInteraction = true;
    pathTracing.beginInteraction();
}
const cameraViewApi = {
    save() {
        const view = { id: ++cameraViewSeq, name: t('cameraViews.name', { n: cameraViewSeq }), ...captureView() };
        const before = [...cameraViews], after = [...cameraViews, view];
        setCameraViews(after);
        history.record({ label: t('viewer.undo.saveView'), undo: () => setCameraViews(before), redo: () => setCameraViews(after) });
        flashStatus(t('status.viewSaved', { name: view.name }));
    },
    fly: view => flyToView(view),
    rename(view, name) {
        const before = view.name;
        if (name === before) return;
        const apply = n => { view.name = n; sceneGraph.render(); properties.show(selection); };
        apply(name);
        history.record({ label: t('viewer.undo.renameView'), undo: () => apply(before), redo: () => apply(name) });
    },
    overwrite(view) {
        const before = { position: view.position, target: view.target, fov: view.fov, dof: view.dof };
        const after = captureView();
        Object.assign(view, after);
        history.record({ label: t('viewer.undo.overwriteView'), undo: () => Object.assign(view, before), redo: () => Object.assign(view, after) });
        flashStatus(t('status.viewOverwritten', { name: view.name }));
    },
    remove(view) {
        this.removeMany([view]);
    },
    // several views at once (multi-selection) – one undo step
    removeMany(views) {
        const before = [...cameraViews], after = cameraViews.filter(v => !views.includes(v));
        if (after.length === before.length) return;
        if (selection?.kind === 'views') sceneGraph.select(null);
        setCameraViews(after);
        history.record({ label: t('viewer.undo.deleteView', { count: views.length }), undo: () => setCameraViews(before), redo: () => setCameraViews(after) });
    },
};

// --- Animation (animated glTF/FBX, animation.js): play bar above the toolbar ---
// All animated models share one timeline. While playing/scrubbing only the raster view runs
// (pauseForEdit); afterwards the path tracer gets the current frame.
const animations = [];   // [{ anim: ModelAnimation, owner: 'main' | extra id }]
let animPlaying = false, animScrubbing = false, animLast = 0;
let hqBeforePlay = false;   // HQ was on when playing started (restored on pause)
const playbar = createPlaybar(document.getElementById('playbar'), {
    onPlay: play => setAnimPlaying(play),
    onScrub: time => {
        if (!animScrubbing) {
            animScrubbing = true;
            setAnimPlaying(false);
            pathTracing.pauseForEdit();
            clipAnims().forEach(a => a.anim.startLive());   // GPU skinning while scrubbing
        }
        clipAnims().forEach(a => a.anim.setTime(time));
        loadRender.dirty = true;
        updatePlaybar();
    },
    onScrubEnd: () => { animScrubbing = false; settleAnimation(); },
    onClip: index => { clipAnims()[0]?.anim.setClip(index); settleAnimation(); updatePlaybar(); },
}, { t });
// shared timeline: a newly added animation jumps to the current time of the others (previously it started
// at 0 and ran offset from then on)
function addAnimation(anim, owner) {
    const time = clipAnims()[0]?.anim.time ?? 0;
    animations.push({ anim, owner });
    anim.setTime(time);
    updatePlaybar();
}
// models with animation clips (the play bar); models with morph targets only are in `animations` too
const clipAnims = () => animations.filter(a => a.anim.clips.length);
function removeAnimations(owner) {
    for (let i = animations.length - 1; i >= 0; i--) {
        if (owner !== undefined && animations[i].owner !== owner) continue;
        animations[i].anim.dispose();
        animations.splice(i, 1);
    }
    if (!clipAnims().length) animPlaying = false;
    updatePlaybar();
}
function updatePlaybar() {
    const list = clipAnims();
    playbar.setVisible(list.length > 0);
    const first = list[0]?.anim;
    if (!first) return;
    playbar.setPlaying(animPlaying);
    playbar.setTime(first.time, Math.max(...list.map(a => a.anim.duration)));
    playbar.setClips(first.clips.map(c => c.name), first.clipIndex);
}
// pause playing/scrubbing: pose into our meshes, puppet out of the scene
function stopAnimation() {
    if (animPlaying) setAnimPlaying(false);
    else if (animScrubbing) { animScrubbing = false; settleAnimation(); }
}
function setAnimPlaying(play) {
    if (play === animPlaying || (play && !clipAnims().length)) return;
    animPlaying = play;
    // playing = raster only: in HQ switch to Default for the time being (otherwise zooming/orbiting resumed
    // the path tracer, which does not show the running animation) – back to HQ on pause
    if (play && viewMode === 'hq') { setViewMode('default'); hqBeforePlay = true; }
    if (play) { animLast = performance.now(); pathTracing.pauseForEdit(); clipAnims().forEach(a => a.anim.startLive()); }
    else settleAnimation();
    if (!play && hqBeforePlay) { hqBeforePlay = false; setViewMode('hq'); }
    updatePlaybar();
}
// paused: the path tracer renders the current frame (deformed meshes: new BVHs + scene)
function settleAnimation(list = clipAnims(), options) {
    list.forEach(a => a.anim.settle(options));
    pathTracing.resumeAfterEdit('node');
    contactShadow.markDirty();
    if (list.some(a => a.anim.deforms)) { pathTracing.invalidate(); updatePathTracingScene(); }
}

// --- Morph targets (blend shapes): sliders in the properties of a model/part with such meshes ---
// Dragging: the puppet's mesh shows the mix live (GPU), release: baked once into our meshes (path tracer,
// picking, section) + one undo step per slider move (same slider within 1 s = one step).
const animOf = entry => animations.find(a => a.owner === (extraOf(entry) ?? 'main'))?.anim;
// our meshes below a Scene Graph entry (model: all of it)
const meshesOf = entry => { const set = new Set(); entry?.object?.traverse?.(o => { if (o.isMesh) set.add(o); }); return set; };
let morphEditing = null;   // anim being dragged live
function settleMorphs(anim) {
    morphEditing = null;
    if (animPlaying || animScrubbing) return;   // the animation settles itself on pause
    settleAnimation([{ anim }], { morphsOnly: true });
    loadRender.dirty = true;
}
function setMorphValue(anim, name, value) {
    anim.setMorph(name, value);
    settleMorphs(anim);
    properties.show(selection);
}
const morphApi = {
    list(entry) {
        const anim = animOf(entry);
        if (!anim?.morphs.size) return [];
        return anim.morphNames(entry.kind === 'model' ? null : meshesOf(entry)).map(name => ({ name, value: anim.getMorph(name) }));
    },
    get: (entry, name) => animOf(entry)?.getMorph(name) ?? 0,
    set(entry, name, value) {
        const anim = animOf(entry);
        if (!anim) return;
        if (morphEditing !== anim) { morphEditing = anim; pathTracing.pauseForEdit(); anim.startLive(); }
        anim.setMorph(name, value);
        loadRender.dirty = true;
    },
    end(entry, name, before) {
        const anim = animOf(entry);
        if (!anim) return;
        const after = anim.getMorph(name);
        settleMorphs(anim);
        if (after === before) return;
        history.record({
            label: t('viewer.undo.morph', { name }), mergeKey: 'morph:' + name,
            undo: () => setMorphValue(anim, name, before),
            redo: () => setMorphValue(anim, name, after),
        });
    },
    reset(entry) {
        const anim = animOf(entry);
        if (!anim) return;
        const names = anim.morphNames(entry.kind === 'model' ? null : meshesOf(entry));
        const before = Object.fromEntries(names.map(n => [n, anim.getMorph(n)]));
        if (!names.some(n => before[n])) return;
        const apply = values => { names.forEach(n => anim.setMorph(n, values[n] ?? 0)); settleMorphs(anim); properties.show(selection); };
        apply({});
        history.record({ label: t('viewer.undo.morphReset'), undo: () => apply(before), redo: () => apply({}) });
    },
};
// scene state: clip + point in time of an animated model
function animState(owner) {
    const anim = animations.find(a => a.owner === owner)?.anim;
    return anim?.clips.length ? { clip: anim.clipIndex, time: +anim.time.toFixed(3) } : undefined;
}
function setModelAnimation(rm, { clip = 0, time = 0 } = {}) {
    const anim = animations.find(a => a.owner === (rm.main ? 'main' : rm.id))?.anim;
    if (!anim?.clips.length) return;
    stopAnimation();
    if (clip !== anim.clipIndex) anim.setClip(clip);
    anim.setTime(time);
    settleAnimation([{ anim }]);
    updatePlaybar();
}
// scene state: morph values of a model (all others 0)
function setModelMorphs(rm, values) {
    const anim = animations.find(a => a.owner === (rm.main ? 'main' : rm.id))?.anim;
    if (anim?.morphs.size && anim.setMorphs(values)) settleMorphs(anim);
}
let animUiLast = 0;
function stepAnimation(now) {
    if (!animPlaying) return;
    const dt = Math.min((now - animLast) / 1000, 0.5);   // real time; at most 0.5 s per frame (inactive tab)
    animLast = now;
    clipAnims().forEach(a => a.anim.update(dt));
    loadRender.dirty = true;
    // time display and contact shadow ~10× per second (both cost every frame otherwise)
    if (now - animUiLast > 100) { animUiLast = now; updatePlaybar(); contactShadow.markDirty(); }
}

// Extent of the whole scene (main + additional models, unmoved placement): the environment (projected floor,
// dome, ground shadow), the lights' shadow cameras and the section plane are sized and centred on it.
// Previously only on the main model – a much bigger second model next to a small STEP part stood outside
// the dome, the camera zoomed out beyond the sphere and the floor appeared far too low.
function updateSceneExtent() {
    const box = new THREE.Box3();
    for (const b of [rootGroup?.userData.unmovedBox, ...extraModels.map(x => x.unmovedBox)]) if (b) box.union(b);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const sceneSize = Math.max(size.x, size.y, size.z);
    environment.modelSize = sceneSize;
    box.getBoundingSphere(shaftBounds);
    lens.volume.markDirty();
    environment.centerX = center.x;
    environment.centerZ = center.z;
    slicer.setModelSize(sceneSize);
    fitShadows(sceneSize, new THREE.Vector3(center.x, environment.groundY, center.z));
    environment.apply({ geometry: true });
    pathTracing.updateLights();
}

// Scene Graph content: main model (primaryContent) + additionally loaded models (extraModels)
let primaryContent = null;
let missingModels = [];     // models of an opened scene whose files were not found: [{ sceneIndex, name, chunk }]
let assetsWindow = null;    // asset window (created further down)
let updateAssetsTool = null;
let mainSceneIndex = 0;     // position of the main model in the opened scene file
const extraModels = [];   // [{ id, name, root, meshes, nodeGroups, content }]
let extraSeq = 0;
// BCF button visibility (set once the toolbar button exists – refreshSceneGraph already runs at startup)
const bcfUi = { update: () => {} };
function refreshSceneGraph() {
    if (primaryContent) primaryContent.warn = model?.missingTextures?.length || 0;
    // morph target marker (icon in the Scene Graph)
    const morphCount = owner => animations.find(a => a.owner === owner)?.anim.morphs.size || 0;
    if (primaryContent) primaryContent.morphs = morphCount('main');
    for (const x of extraModels) if (x.content) x.content.morphs = morphCount(x.id);
    // Gaussian splats: lights have no effect on them (baked appearance) → not listed
    const entries = splatMesh ? sceneEntries.filter(e => e.key !== 'lights') : sceneEntries;
    bcfUi.update();
    sceneGraph.setContent(entries, primaryContent, extraModels.map(x => x.content), missingModels.map(m => m.name));
    assetsWindow?.refresh();
    updateAssetsTool?.();
}
refreshSceneGraph();

// --- Assign material via drag & drop (3D view or Scene Graph) ---
function materialFromDrop(e) {
    try {
        const data = JSON.parse(e.dataTransfer.getData(MATERIAL_MIME));
        if (data.id) return materialManager.get(data.id);
        if (data.libraryId) return materialManager.fromLibrary(data.libraryId);
    } catch { /* no material data */ }
    return null;
}
// Target of a material drop: if it is in the multi-selection, the drop applies to the whole selection
// (a sub-surface stays single unless it is marked itself)
const dropEntryFor = entry => (sceneGraph.inSelection(entry) && (entry.kind !== 'surface' || sceneGraph.marked.has(entry)) ? selection : entry);
// Drop target in the 3D view: part, with Alt only the hit sub-surface (face colour)
const dropEntryForMesh = (mesh, alt) => {
    if (!mesh) return null;
    const surface = alt && sceneGraph.entryForObject(mesh, { surfaces: true });
    return surface?.kind === 'surface' ? surface : dropEntryFor(sceneGraph.entryForObject(mesh));
};
function dropOnto(entry, e, { exact = false } = {}) {
    if (!exact) entry = dropEntryFor(entry);
    if (!isModelEntry(entry)) return;
    // create library material + assign = one undo step
    history.transaction(t('viewer.undo.assignMaterial'), () => {
        const mat = materialFromDrop(e);
        if (!mat) return;
        assignMaterial(entry.object, mat.def.id);
        materialPanel.open(mat.def.id, 'scene');
    });
    if (selection) materialPanel.setSelection(isModelEntry(selection) ? selection.object : null);
    sceneGraph.render();   // names/colours of the sub-surfaces
}

// Assign a material to all meshes under object, remember the previous materials for undo
// (via the mesh index – meshes are replaced in the same order on re-tessellation)
// mesh index over the main model and the additional models (in this order)
let meshIndex = { list: null, extras: null, all: [], map: null };
function allModelMeshes() {
    const extras = extraModels.map(x => x.id).join(',');
    if (meshIndex.list !== currentMeshes || meshIndex.extras !== extras) {
        const all = [...currentMeshes, ...extraModels.flatMap(x => x.meshes)];
        meshIndex = { list: currentMeshes, extras, all, map: new Map(all.map((m, i) => [m, i])) };
    }
    return meshIndex.all;
}
function indexOfMesh(mesh) {
    allModelMeshes();
    return meshIndex.map.get(mesh);
}
function assignMaterial(object, id) {
    const target = materialManager.get(id)?.material;
    if (!target) return;
    const previous = new Map();   // previous material ID -> mesh indices
    object.traverse(c => {
        if (!c.isMesh || c.material === target) return;
        const i = indexOfMesh(c);
        const old = c.material?.userData?.materialId;   // animation puppet (material array): not ours
        if (i === undefined || !old) return;
        if (!previous.has(old)) previous.set(old, []);
        previous.get(old).push(i);
    });
    materialManager.assign(object, id);
    if (!previous.size) return;
    const all = [...previous.values()].flat();
    const setMaterial = (matId, indices) => {
        const entry = materialManager.get(matId);
        if (!entry) return;
        const all = allModelMeshes();
        for (const i of indices) if (all[i]) all[i].material = entry.material;
    };
    history.record({
        label: t('viewer.undo.assignMaterial'),
        undo: () => { previous.forEach((indices, old) => setMaterial(old, indices)); materialManager.dispatchEvent(new CustomEvent('change')); },
        redo: () => { setMaterial(id, all); materialManager.dispatchEvent(new CustomEvent('change')); },
    });
}

// Merge identical materials (e.g. the same file loaded twice): the meshes of the duplicates get the
// most used one, the duplicates are deleted – one undo step (re-assignment by mesh index + re-creation)
async function mergeDuplicateMaterials() {
    const groups = await materialManager.findDuplicates();
    if (!groups.length) { flashStatus(t('materials.merge.none'), 3000); return; }
    let merged = 0;
    history.transaction(t('materials.merge.undo'), () => {
        for (const [keeper, ...dups] of groups) {
            const dupSet = new Set(dups);
            for (const mesh of allModelMeshes()) {
                if (dupSet.has(mesh.material?.userData?.materialId)) assignMaterial(mesh, keeper);
            }
            for (const id of dups) if (materialManager.remove(id)) merged++;
        }
    });
    if (materialPanel.current && !materialManager.get(materialPanel.current)) materialPanel.current = null;
    materialPanel.refresh(isModelEntry(selection) ? selection.object : null);
    flashStatus(t('materials.merge.done', { count: merged }), 4000);
}

// --- Undo / redo ---
function undoRedo(redo) {
    if (loading) { flashStatus(t('status.busyLoading')); return; }
    if (transformer.controls.dragging) return;
    const label = redo ? history.redo() : history.undo();
    if (!label) { flashStatus(t(redo ? 'status.nothingToRedo' : 'status.nothingToUndo')); return; }
    // update the display to the restored state
    sceneGraph.render();
    transformer.sync();
    properties.show(selection);
    materialPanel.refresh(isModelEntry(selection) ? selection.object : null);
    updateHighlight();
    flashStatus(t(redo ? 'status.redone' : 'status.undone', { label }));
}
let dropTarget = null;
const setDropTarget = entry => {
    if (entry === dropTarget) return;
    dropTarget = entry;
    highlighter.set(selection?.object, (dropTarget || hovered)?.object);
};
const isMaterialDrag = e => e.dataTransfer?.types.includes(MATERIAL_MIME);
// dragover fires continuously (~every 50 ms) even without moving: pick only when the pointer/Alt changed
let dragPick = '';
renderer.domElement.addEventListener('dragover', e => {
    if (!isMaterialDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const key = `${e.clientX},${e.clientY},${e.altKey}`;
    if (key === dragPick) return;
    dragPick = key;
    setDropTarget(dropEntryForMesh(pickMesh(e), e.altKey));
});
renderer.domElement.addEventListener('dragleave', () => { dragPick = ''; setDropTarget(null); });
renderer.domElement.addEventListener('drop', e => {
    if (!isMaterialDrag(e)) return;
    e.preventDefault();
    const target = dropTarget;
    setDropTarget(null);
    if (target) dropOnto(target, e, { exact: true });   // target is already known (dragover)
});
const graphList = document.querySelector('#scene-graph [data-tree-list]');
graphList.addEventListener('dragover', e => {
    if (!isMaterialDrag(e)) return;
    const entry = sceneGraph.entryAt(e.target);
    if (!isModelEntry(entry)) return setDropTarget(null);
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(dropEntryFor(entry));
});
graphList.addEventListener('dragleave', () => setDropTarget(null));
graphList.addEventListener('drop', e => {
    if (!isMaterialDrag(e)) return;
    e.preventDefault();
    const entry = sceneGraph.entryAt(e.target);
    setDropTarget(null);
    dropOnto(entry, e);
});

// --- Selection by clicking into the 3D view (BVH-accelerated raycasting) ---
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const raycaster = patchRaycaster(new THREE.Raycaster());
raycaster.firstHitOnly = true;
raycaster.layers.enable(BATCH_LAYER);
// shown? (a mesh hidden only because the animation shows its puppet counts as shown – picking while playing)
const isShown = o => {
    if (o && !o.visible && !o.userData.liveHidden) return false;
    for (o = o?.parent; o; o = o.parent) if (!o.visible) return false;
    return true;
};
const pickMesh = event => pickHit(event)?.object ?? null;
function pickHit(event) {
    if (!rootGroup) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    // with an active section check all hits – the first one may be clipped away
    raycaster.firstHitOnly = !slicer.enabled;
    return raycaster.intersectObjects([rootGroup, ...extraModels.map(x => x.root)], true).find(h => isShown(h.object) && !slicer.clips(h.point)) ?? null;
}
// --- Double click: centre the camera on an object and zoom in ---
let flight = null;
// A camera flight (double click, saved view) pauses path tracing (beginInteraction). It must be ended exactly
// once – also when the flight is cancelled or replaced (scene restore, panel input, load fit). Previously
// cancelling left the path tracer in "motion" for good: status "Bewegung – Pathtracing pausiert", HQ black.
let flightInteraction = false;
function endFlightInteraction() {
    if (!flightInteraction) return;
    flightInteraction = false;
    pathTracing.endInteraction();
}
function cancelFlight() {
    splatSpin.active = false;
    flight = null;
    endFlightInteraction();
}
function frameObject(object) {
    streamFit.active = false;
    splatSpin.active = false;
    const box = new THREE.Box3();
    for (const o of object.isMeshSet ? object.members : [object]) {   // multi-selection
        o.updateMatrixWorld(true);
        o.traverseVisible(c => {
            if (!c.isMesh) return;
            if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
            box.union(new THREE.Box3().copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld));
        });
    }
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const vFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const fov = Math.min(vFov, Math.atan(Math.tan(vFov) * camera.aspect));
    const dist = Math.max(sphere.radius, 1e-3) / Math.sin(fov) * 1.15;
    const dir = camera.position.clone().sub(controls.target).normalize();
    flight = {
        t0: performance.now(), duration: 450,
        fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
        toPos: sphere.center.clone().addScaledVector(dir, dist), toTarget: sphere.center.clone(),
    };
    // clipping planes for the new distance: near matching the object (small parts are not cut), far covering the
    // whole scene from there – previously far stayed at the first model (small STEP part + building added →
    // everything clipped) and near only ever shrank (poor depth precision for large scenes)
    const sceneBox = new THREE.Box3().setFromObject(slicer.group);
    const reach = sceneBox.isEmpty() ? 0 : flight.toPos.distanceTo(sceneBox.getCenter(new THREE.Vector3())) + sceneBox.getSize(new THREE.Vector3()).length() / 2;
    camera.near = dist * 0.001;
    camera.far = Math.max(dist * 100, reach * 2);
    camera.updateProjectionMatrix();
    flightInteraction = true;
    pathTracing.beginInteraction();
}
function updateFlight() {
    if (!flight) return;
    const u = Math.min((performance.now() - flight.t0) / flight.duration, 1);
    const k = u * u * (3 - 2 * u);
    if (flight.orbit) {   // view cube: azimuth and elevation around the orbit centre, the distance stays
        const o = flight.orbit;
        _flightDir.setFromSphericalCoords(o.dist, o.fromPhi + (o.toPhi - o.fromPhi) * k, o.fromTheta + o.dTheta * k);
        camera.position.copy(o.center).add(_flightDir);
    } else {
        camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
        controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
    }
    if (flight.toRoll !== undefined) {   // views with roll: the shorter way round
        const d = ((flight.toRoll - flight.fromRoll + 540) % 360) - 180;
        camera.userData.roll = flight.fromRoll + d * k;
    }
    controls.update();   // fires 'change' -> path tracing pauses during the flight
    if (u === 1) {
        flight = null;   // (following during loading is "quiet": without begin/endInteraction)
        endFlightInteraction();
    }
}
const _flightDir = new THREE.Vector3();

// --- View cube (view-cube.js): click = fly to the view, drag = orbit like the mouse in the viewport ---
// The camera turns around the current orbit centre (a straight flight to the opposite side would pass through
// the centre), distance kept, roll back to 0. Interpolated in azimuth + elevation (OrbitControls' coordinates):
// a rotation along the great circle (slerp) reached top/bottom with the azimuth of the start and swung it
// around to the top view's in the last frames (right → top: a 90° jump). Top/bottom: OrbitControls needs an
// azimuth → tilted minimally towards the front, so the front is at the bottom of the top view (at the top of
// the bottom view), like Blender.
function flyToDirection(dir) {
    streamFit.active = false;
    cancelFlight();
    const center = controls.target.clone();
    const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(center));
    const to = new THREE.Spherical().setFromVector3(Math.abs(dir.y) > 0.999 ? new THREE.Vector3(0, Math.sign(dir.y), 1e-3) : dir);
    // shorter way round in azimuth; from top/bottom (azimuth undefined there) it simply turns into the new one
    const dTheta = ((to.theta - from.theta) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    flight = {
        t0: performance.now(), duration: 500,
        orbit: { center, dist: from.radius, fromTheta: from.theta, dTheta, fromPhi: from.phi, toPhi: to.phi },
        fromRoll: camera.userData.roll || 0, toRoll: 0,
    };
    flightInteraction = true;
    pathTracing.beginInteraction();
}
const _orbit = new THREE.Spherical();
function orbitCamera(dx, dy) {
    const offset = camera.position.clone().sub(controls.target);
    _orbit.setFromVector3(offset);
    _orbit.theta -= dx * 0.012;
    _orbit.phi = THREE.MathUtils.clamp(_orbit.phi - dy * 0.012, 1e-4, Math.PI - 1e-4);
    camera.position.copy(controls.target).add(offset.setFromSpherical(_orbit));
    controls.update();   // 'change' → path tracing reduced like orbiting with the mouse
}
const viewCube = new ViewCube(document.getElementById('view-cube'), {
    onSelect: dir => flyToDirection(dir),
    onOrbitStart: () => { cancelFlight(); controls.dispatchEvent({ type: 'start' }); },
    onOrbit: orbitCamera,
    onOrbitEnd: () => controls.dispatchEvent({ type: 'end' }),
});

// Gaussian splats: one cloud without parts – double click flies towards the point hit instead (it becomes the
// orbit centre, the camera keeps its direction and covers 60 % of the way; again = closer)
function flyToPoint(point) {
    streamFit.active = false;
    cancelFlight();
    const dist = camera.position.distanceTo(point) * 0.4;
    const dir = camera.position.clone().sub(point).normalize();
    flight = {
        t0: performance.now(), duration: 600,
        fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
        toPos: point.clone().addScaledVector(dir, dist), toTarget: point.clone(),
    };
    camera.near = Math.min(camera.near, dist * 0.01);
    camera.updateProjectionMatrix();
    flightInteraction = true;
    pathTracing.beginInteraction();
}
renderer.domElement.addEventListener('dblclick', e => {
    if (splatMesh) {
        const hit = pickHit(e);
        if (hit) flyToPoint(hit.point);
        return;
    }
    const mesh = pickMesh(e);
    const entry = mesh && sceneGraph.entryForObject(mesh);
    if (!entry) return;
    sceneGraph.select(entry);
    frameObject(entry.object);
});

let pointerDown = null;
renderer.domElement.addEventListener('pointerdown', e => {
    pointerDown = transformer.busy ? null : { x: e.clientX, y: e.clientY };   // a click on the gizmo is not a selection
});
renderer.domElement.addEventListener('pointerup', e => {
    if (!pointerDown || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y);
    pointerDown = null;
    if (moved > 4) return;   // camera was rotated, not a click
    if (focusPick) {
        const hit = pickHit(e);
        if (!hit) return;   // clicked beside: keep waiting
        endFocusPick();
        if (dof.autoFocus) dof.autoFocus = false;
        setFocus(dof.depthOf(hit.point), { label: t('viewer.undo.focusByClick') });
        properties.show(selection);
        return;
    }
    const mesh = pickMesh(e);
    const entry = mesh ? sceneGraph.entryForObject(mesh) : null;
    if (e.shiftKey) { if (entry) sceneGraph.toggleSelect(entry); }   // multi-selection
    else sceneGraph.select(entry);
});

// Current model: { name, type: 'step', url|file, content? } or { name, type: 'mesh', main, files, baseUrl? }
let model = null;
let splatMesh = null;                 // Gaussian splat scene (SplatMesh) – always alone, no further models
// UI for a splat scene: hidden what has no effect on splats – materials + node editor, explosion, view modes
// (Basic shows them unchanged, HQ cannot trace them), lights, depth of field (HQ only); environment stays
// (background). Called when a splat scene is shown or removed.
function applySplatUi() {
    const on = !!splatMesh;
    document.getElementById('materials').hidden = on;
    if (on && nodeEditor.isOpen) nodeEditor.close();
    viewModeBar.setHidden({ modes: on, groups: on ? ['start'] : [] });   // 'start' = explosion
    if (on && selection && (selection.key === 'lights' || selection.kind === 'light')) sceneGraph.select(null);
    refreshSceneGraph();
    properties.show(selection);
}
let toneMappingBeforeSplats = null;   // splats switch tone mapping off; restored when they are removed
let rootGroup = null;
let currentMeshes = [];       // meshes in import order (for re-tessellation)
let currentNodeGroups = [];   // groups per import node

// --- GUI ---
// Setup menu (gear in the bar, setSetupOpen): path tracing + tessellation
const setupMenu = document.getElementById('setup-menu');
const setup = new SetupMenu(setupMenu, t('setup.title'), { onClose: () => setSetupOpen(false) });   // sections left, options right
const settings = {
    meshQuality: 'medium',
    partQuality: {},   // quality per part (STEP node index -> level), also applies to child nodes
};

// --- Quality per part (STEP only) ---
// A solid is tessellated with the finest level of all parts it occurs in
// (identical parts share one geometry). If only the level of single parts changes,
// only their solids are re-tessellated and the geometries swapped (retessellateParts).
let currentPlan = null;        // STEP structure (nodes, solids, instances) of the loaded model
let solidQualityUsed = [];     // level each solid is currently tessellated with

// own or inherited level of a node (null = global quality)
function nodeQuality(nodes, i) {
    for (let n = i; n >= 0; n = nodes[n]?.parent ?? -1) {
        if (settings.partQuality[n]) return settings.partQuality[n];
    }
    return null;
}
function solidQualities(plan, quality = settings.meshQuality) {
    const out = plan.solids.map(() => quality);
    const seen = plan.solids.map(() => false);
    for (const inst of plan.instances) {
        const q = nodeQuality(plan.nodes, inst.node) || quality;
        if (!seen[inst.solid] || TESS_PRESETS[q].rel < TESS_PRESETS[out[inst.solid]].rel) out[inst.solid] = q;
        seen[inst.solid] = true;
    }
    return out;
}

// Memory protection (IMPORT in config.js): the tessellation would exceed the triangle limit.
// kind 'open': nothing loaded. 'reload' (quality changed) / 'parts': the old model stays, the setting
// returns to the level the model has.
// ?debug&triangleBudget=…&triangleLimit=… (testing): override the limits from config.js
const IMPORT_LIMITS = (() => {
    const params = new URLSearchParams(location.search), debug = params.has('debug');
    const get = (name, fallback) => (debug && Number(params.get(name)) > 0 ? Number(params.get(name)) : fallback);
    return { budget: get('triangleBudget', IMPORT.triangleBudget), limit: get('triangleLimit', IMPORT.triangleLimit) };
})();
let loadedQuality = null;   // level the current model is tessellated with
let appliedPartQuality = {};   // part levels the current model is tessellated with
const formatCount = n => new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
function showLimitError(err, kind) {
    console.warn('[Load]', err.message);
    const params = { triangles: formatCount(err.triangles), limit: formatCount(err.limit), quality: t(`tessellation.quality.${err.quality}`) };
    if (kind === 'parts') showStatus(t('status.partsTooFine', params));
    else if (kind === 'reload' && loadedQuality) {
        settings.meshQuality = loadedQuality;
        qualityController?.refresh();
        showStatus(t('status.qualityTooFine', { ...params, previous: t(`tessellation.quality.${loadedQuality}`) }));
    } else showStatus(t('status.modelTooLarge', params));
}

// Release large STEP files after import (content on the main thread + index/file in the workers):
// saves the full file size. Re-tessellation reads it again (dropped file from disk, otherwise
// again from the URL) and rebuilds the index (~2 s for 400 MB).
const RELEASE_STEP_BYTES = 64 * 1024 * 1024;
async function ensureStepContent() {
    if (model.content) return;
    showProgress(t('status.loadingFile'));
    const signal = loadAbort?.signal;
    model.content = model.file ? await readStepFile(model.file, signal) : await fetchStepFile(model.url, signal);
}
async function releaseLargeStep() {
    if (model?.type !== 'step' || !model.content || model.content.byteLength < RELEASE_STEP_BYTES) return;
    if (!model.file && !model.url) return;   // cannot be read again
    model.content = null;
    releaseStepFile();
}

/** Set the level of a part ('' = as parent) and re-tessellate only the affected solids */
function setPartQuality(node, quality, { record = true } = {}) {
    const before = settings.partQuality[node] || '';
    if (before === (quality || '')) return;
    const apply = q => {
        if (q) settings.partQuality[node] = q; else delete settings.partQuality[node];
        runLoad('parts');
        properties.show(selection);
    };
    apply(quality);
    if (record) history.record({ label: t('viewer.undo.partQuality'), undo: () => apply(before), redo: () => apply(quality) });
}

// Re-tessellate only solids with a changed level; meshes keep material, placement and selection
async function retessellateParts() {
    const plan = currentPlan;
    if (model?.type !== 'step' || !plan || !rootGroup) return;
    const target = solidQualities(plan);
    const changed = new Set(target.flatMap((q, si) => (q !== solidQualityUsed[si] ? [si] : [])));
    if (!changed.size) return;
    try {
        await ensureStepContent();
        showProgress(t('status.tessellatingParts'));
        const result = await tessellateStep(model.content, settings.meshQuality, showProgress, {
            bvh: pathTracing.supported, instancing: IMPORT.instancing, solidQualities: () => target, onlySolids: () => changed,
            limits: { auto: false, ...IMPORT_LIMITS },
        });
        // same meshes (instance + face colour) expected – otherwise re-tessellate completely
        const byKey = new Map(currentMeshes.map(m => [m.userData.key, m]));
        const oldKeys = currentMeshes.filter(m => changed.has(plan.instances[m.userData.instance]?.solid)).map(m => m.userData.key);
        if (oldKeys.length !== result.meshes.length || result.meshes.some(m => !byKey.has(m.key))) {
            debugLog('[STEP] part quality: face groups changed – re-tessellating completely');
            hideProgress();
            runLoad('reload');
            return;
        }
        invalidatePathTracing();
        const geometries = [];
        const old = new Set();
        for (const m of result.meshes) {
            const mesh = byKey.get(m.key);
            old.add(mesh.geometry);
            mesh.geometry = geometries[m.geometry] ??= makeGeometry(result.geometries[m.geometry]);
            mesh.matrix.fromArray(m.matrix);   // instancing: alignment to the shared geometry may change
            mesh.updateMatrixWorld();
        }
        // instancing: unchanged solids may still use an old geometry of a changed one
        for (const mesh of currentMeshes) old.delete(mesh.geometry);
        old.forEach(g => { g.boundsTree = null; g.dispose(); });
        changed.forEach(si => { solidQualityUsed[si] = target[si]; });
        appliedPartQuality = { ...settings.partQuality };
        await releaseLargeStep();
        finishProgress();
        updateHighlight();
        updatePathTracingScene();
    } catch (err) {
        hideProgress();
        if (err.name === 'AbortError') return;   // new model dropped
        if (err instanceof ImportLimitError) {
            // too fine: back to the part levels the model actually has
            settings.partQuality = { ...appliedPartQuality };
            properties.show(selection);
            showLimitError(err, 'parts');
            return;
        }
        console.error(err);
        showStatus(t('status.error', { message: err.message }));
    }
}

// --- Light shafts (lens effect): centre = brightest point of the HDRI, projected into the image ---
// Brightest direction per environment texture (8×8 blocks of the equirect data, cached): the sun or the
// brightest window/softbox. World direction = environmentRotation · texture direction (three.js looks up
// rotationᵀ · direction). With the dome background ("flatten ground") the HDRI is shown shifted in latitude –
// the visible sun is where hdriShift() maps it from.
const shaftDirections = new WeakMap();
function brightestDirection(tex) {
    if (shaftDirections.has(tex)) return shaftDirections.get(tex);
    let dir = null;
    const img = tex?.image;
    if (img?.data && img.width && img.height) {
        const { data, width: w, height: h } = img, ch = Math.round(data.length / (w * h));
        const value = data instanceof Uint16Array ? i => THREE.DataUtils.fromHalfFloat(data[i]) : i => data[i];
        const B = Math.max(2, Math.round(w / 256));
        let best = -1, bx = 0, by = 0;
        for (let y0 = 0; y0 < h; y0 += B) {
            for (let x0 = 0; x0 < w; x0 += B) {
                let sum = 0;
                for (let y = y0; y < Math.min(y0 + B, h); y += 2) for (let x = x0; x < Math.min(x0 + B, w); x += 2) {
                    const i = (y * w + x) * ch;
                    sum += 0.2126 * value(i) + 0.7152 * value(i + 1) + 0.0722 * value(i + 2);
                }
                if (sum > best) { best = sum; bx = x0 + B / 2; by = y0 + B / 2; }
            }
        }
        // equirect (three.js equirectUV): u = atan2(z, x) / 2π + 0.5, v = asin(y) / π + 0.5, row 0 = v 0
        const a = (bx / w - 0.5) * 2 * Math.PI, lat = (by / h - 0.5) * Math.PI;
        dir = new THREE.Vector3(Math.cos(lat) * Math.cos(a), Math.sin(lat), Math.cos(lat) * Math.sin(a));
        // colour of the light (lens flare tint): mean of the brightest block, normalised to luminance 1
        const color = new THREE.Color(0, 0, 0);
        for (let y = by - B / 2; y < Math.min(by + B / 2, h); y++) for (let x = bx - B / 2; x < Math.min(bx + B / 2, w); x++) {
            const i = (y * w + x) * ch;
            color.r += value(i); color.g += value(i + 1); color.b += value(i + 2);
        }
        const luma = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
        dir.color = luma > 0 ? color.multiplyScalar(1 / luma) : color.setRGB(1, 1, 1);
        dir.color.setRGB(Math.min(dir.color.r, 2), Math.min(dir.color.g, 2), Math.min(dir.color.b, 2));
    }
    shaftDirections.set(tex, dir);
    return dir;
}
// Lens flare visibility: rays from the camera towards the light in a small cone (~1°, the sun's disc plus a
// little soft edge) against the shown model (BVH) – share that gets through. World space, so independent of
// fisheye/DOF and of what the image shows there (bright reflections on a covering object no longer count).
const sunRaycaster = new THREE.Raycaster();
sunRaycaster.layers.enable(BATCH_LAYER);
const SUN_TAPS = [[0, 0]];
for (let k = 0; k < 6; k++) SUN_TAPS.push([0.5 * Math.cos(k * Math.PI / 3), 0.5 * Math.sin(k * Math.PI / 3)]);
for (let k = 0; k < 6; k++) SUN_TAPS.push([Math.cos((k + 0.5) * Math.PI / 3), Math.sin((k + 0.5) * Math.PI / 3)]);
const _sunU = new THREE.Vector3(), _sunV = new THREE.Vector3(), _sunOrigin = new THREE.Vector3();
function sunVisibility(dir) {
    if (!rootGroup) return 1;
    const roots = [rootGroup, ...extraModels.map(x => x.root)];
    _sunU.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0).cross(dir).normalize();
    _sunV.crossVectors(dir, _sunU);
    camera.getWorldPosition(_sunOrigin);
    const cone = 0.018;   // radians
    sunRaycaster.firstHitOnly = !slicer.enabled;
    let open = 0;
    for (const [a, b] of SUN_TAPS) {
        sunRaycaster.ray.origin.copy(_sunOrigin);
        sunRaycaster.ray.direction.copy(dir).addScaledVector(_sunU, a * cone).addScaledVector(_sunV, b * cone).normalize();
        const hit = sunRaycaster.intersectObjects(roots, true).find(h => isShown(h.object) && !slicer.clips(h.point));
        if (!hit) open++;
    }
    return open / SUN_TAPS.length;
}
const _shaftDir = new THREE.Vector3(), _shaftPoint = new THREE.Vector3(), _shaftForward = new THREE.Vector3(), _shaftMatrix = new THREE.Matrix4(), _shaftNdc = new THREE.Vector2();
const _shaftLight = new THREE.Vector3(), _shaftColor = new THREE.Color();
const shaftBounds = new THREE.Sphere(new THREE.Vector3(), 0);   // whole scene (updateSceneExtent)
// volumetric light shafts (volume-shafts.js): scene, camera and what stays out of the depth passes
lens.sceneContext = () => ({
    scene, camera, bounds: rootGroup ? shaftBounds : null, modelSize: environment.modelSize,
    hide: splatMesh ? [splatMesh] : [], ground: ground.enabled ? ground.mesh : null,
});
function updateShaftSource() {
    const dir = environment.on ? brightestDirection(environment.texture) : null;
    lens.volume.setLight(null);
    if (!dir) { lens.setShaftSource(0.5, 0.5, 0); return; }
    _shaftDir.copy(dir);
    // shown shifted on the dome: latitude back through the remap (texture latitude → visible latitude)
    if (environment.background && environment.dome && environment.domeShift) {
        const half = Math.PI / 2, shift = -Math.min(Math.max(environment.domeShift, -0.95), 0.95) * half;
        const lat = Math.asin(THREE.MathUtils.clamp(_shaftDir.y, -1, 1));
        const vis = lat >= shift ? (lat - shift) * half / (half - shift) : (lat - shift) * half / (half + shift);
        const hz = Math.hypot(_shaftDir.x, _shaftDir.z) || 1;
        _shaftDir.set(_shaftDir.x / hz * Math.cos(vis), Math.sin(vis), _shaftDir.z / hz * Math.cos(vis));
    }
    _shaftDir.applyMatrix4(_shaftMatrix.makeRotationFromEuler(scene.environmentRotation)).normalize();
    // volumetric shafts: the real light direction (without the visible background's latitude shift)
    if (lens.shafts.enabled) {
        _shaftLight.copy(dir).applyMatrix4(_shaftMatrix).normalize();
        lens.volume.setLight(_shaftLight, _shaftColor.copy(dir.color).multiplyScalar(environment.intensity));
    }
    if (lens.flare.enabled) lens.setFlareSource(sunVisibility(_shaftDir), dir.color);
    // fisheye: project with its mapping (the light may lie far to the side or even behind)
    if (fisheyeEnabled()) {
        const local = _shaftForward.copy(_shaftDir).transformDirection(_shaftMatrix.copy(camera.matrixWorld).invert());
        const ndc = fisheyeProject(local, _shaftNdc);
        if (!ndc) { lens.setShaftSource(0.5, 0.5, 0); return; }
        lens.setShaftSource(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, 1);
        return;
    }
    // fades out when the light is beside/behind the camera
    camera.getWorldDirection(_shaftForward);
    const facing = _shaftDir.dot(_shaftForward);
    _shaftPoint.copy(camera.position).addScaledVector(_shaftDir, camera.far * 0.5).project(camera);
    const fade = facing <= 0 ? 0 : THREE.MathUtils.smoothstep(facing, 0, 0.3);
    lens.setShaftSource(_shaftPoint.x * 0.5 + 0.5, 0.5 - _shaftPoint.y * 0.5, fade);   // uv of the quad: origin top left
}

// --- View mode: Basic (grey) / Default (raster with materials) / HQ (path tracing) ---
// Basic only overrides the display (scene.overrideMaterial); ground etc. have allowOverride = false.
const clayMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x8a8a8a, roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
clayMaterial.maskNode = FADE_MASK;   // fade-in on import also in Basic
ground.material.allowOverride = false;
let viewMode = pathTracing.enabled ? 'hq' : 'default';
const viewModeBar = new ViewModeBar(document.getElementById('view-mode'), mode => setViewMode(mode));

// --- AI rendering (ki-render.js → Gemini directly from the browser, ki-gemini.js) ---
let captureRequest = null;   // render loop delivers the next frame as a data: URL
const captureFrame = () => new Promise(resolve => { captureRequest = resolve; loadRender.force = true; });
// image export: the render loop delivers the next frame as a canvas (without gizmo, highlight, focus line)
let exportRequest = null;
const exportFrame = () => new Promise(resolve => { exportRequest = resolve; loadRender.force = true; });
function grabCanvas() {
    const src = renderer.domElement, c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
}
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

// Transparent PNG by "triangulation matting": the same view twice – in front of a black and a grey background
// (only the visible background; HDRI light, reflections and the ground shadow catcher stay). Per pixel the
// background shines through by (I_grey − I_black) / background → alpha; the black image is the colour
// premultiplied with it (stored as is). Works for everything that blends with the background: soft depth of
// field edges, glass, the ground shadow, bloom/glare/colour fringes (additive). The path
// tracer's noise is the same in both passes (stable noise), so solid parts stay exactly opaque.
// Computed before tone mapping: the 8-bit values are turned back through sRGB and the ACES curve per channel.
const MATTE_GREY_Y = 0.6;   // grey background before the ACES fit (display ≈ 0.44 linear) – well below the bloom threshold
// Larger than the screen (scale > 1): the canvas' drawing buffer is enlarged via the pixel ratio (CSS size stays,
// the screen shows the large image scaled down meanwhile), raster and path tracer render at that size (the path
// tracer restarts by itself on the size change), effects keep their screen look (lens.setPixelScale); restored
// afterwards. Limit: maxExportSize (GPU texture limit, at most 8192 px for memory).
const maxExportSize = () => Math.min(renderer.backend?.device?.limits?.maxTextureDimension2D || 8192, 8192);
async function exportImage(transparent, onProgress, isOpen, scale = 1) {
    if (scale === 1) return exportPasses(transparent, onProgress, isOpen);
    const ratio = renderer.getPixelRatio();
    renderer.setPixelRatio(ratio * scale);
    lens.setPixelScale(scale);
    loadRender.force = true;
    await nextFrame(); await nextFrame();   // path tracer noticed the new size and restarted
    try {
        return await exportPasses(transparent, onProgress, isOpen);
    } finally {
        renderer.setPixelRatio(ratio);
        lens.setPixelScale(1);
        loadRender.force = true;
    }
}
// alpha of the transparent export is computed back through the ACES curve without the image look: those
// captures are taken with ACES + neutral look (only the output changes – the path traced image stays)
async function captureNeutral() {
    const curve = renderer.toneMapping;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    lens.neutralLook = true;
    lens.apply();
    try {
        return await exportFrame();
    } finally {
        renderer.toneMapping = curve;
        lens.neutralLook = false;
        lens.apply();
    }
}
async function exportPasses(transparent, onProgress, isOpen) {
    if (!transparent) {
        await waitForImage(onProgress, isOpen);
        return exportFrame();
    }
    // grey in scene units: the ACES input is colour · exposure / 0.6
    // (rounded to 8 bit – the path tracer stores colour backgrounds as 8-bit texture)
    const grey = Math.round(MATTE_GREY_Y * 0.6 / renderer.toneMappingExposure * 255) / 255;
    const greyY = grey * renderer.toneMappingExposure / 0.6;
    const passes = [['black', 0], ['grey', grey]];
    const shots = [];
    let color = null;   // image in front of black with the image look (colour of the PNG)
    try {
        for (let n = 0; n < passes.length; n++) {
            // plain colour: the path tracer has its own path for colour backgrounds (an own float/half-float
            // texture produced a shader variant with an unresolved sampler)
            environment.matte = new THREE.Color(passes[n][1], passes[n][1], passes[n][1]);
            environment.apply();
            contactShadow.markDirty();
            await nextFrame(); await nextFrame();   // path tracer restarted with the new background
            await waitForImage((text, p) => onProgress(t('imageExport.pass', { n: n + 1, total: passes.length, text }), (n + p) / passes.length), isOpen);
            shots.push(await captureNeutral());
            if (n === 0) color = await exportFrame();
        }
    } finally {
        environment.matte = null;
        environment.apply();
    }
    return composeMatte(shots[0], shots[1], greyY, color);
}
// ACES fit (three.js RRTAndODTFit) inverted: display-linear value → value before the fit
function acesFitInverse(L) {
    const A = 1 - 0.983729 * L, B = 0.0245786 - 0.983729 * 0.432951 * L, C = -0.000090537 - 0.238081 * L;
    if (A < 1e-6) return 1e6;
    return (-B + Math.sqrt(Math.max(B * B - 4 * A * C, 0))) / (2 * A);
}
// Output premultiplied with black: colour = image in front of black, alpha = coverage – light without
// coverage (bloom, glare) stays additive (compositing software: interpret as premultiplied)
function composeMatte(black, grey, greyY, color) {
    const w = black.width, h = black.height;
    const K = black.getContext('2d').getImageData(0, 0, w, h).data;
    const G = grey.getContext('2d').getImageData(0, 0, w, h).data;
    const C = color.getContext('2d').getImageData(0, 0, w, h).data;   // colour with the image look
    // 8-bit sRGB → value before the ACES fit
    const LUT = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const v = i / 255, lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        LUT[i] = acesFitInverse(Math.min(lin, 0.9999));
    }
    for (let i = 0; i < K.length; i += 4) {
        let alpha = 0;
        for (let c = 0; c < 3; c++) alpha += 1 - (LUT[G[i + c]] - LUT[K[i + c]]) / greyY;
        // 8-bit rounding: background never exactly 0, solid parts never exactly 1 – small tolerance at both ends
        alpha = Math.min(Math.max((alpha / 3 - 0.015) / 0.97, 0), 1);
        C[i + 3] = Math.round(alpha * 255);
    }
    // written as PNG directly: a canvas keeps colours premultiplied itself and would lose the colour of
    // glow pixels with alpha 0 (and round the others)
    return encodePng(C, w, h);
}
// current view: Default/Basic immediately, HQ only once the image is finished (denoised); isOpen: the
// asking window is still open (otherwise cancelled)
const waitForImage = (onProgress, isOpen) => new Promise((resolve, reject) => {
        if (!rootGroup) return reject(new Error(t('viewer.ki.noModel')));
        if (viewMode !== 'hq') return resolve();
        const tick = () => {
            if (!isOpen()) return reject(new Error(t('viewer.ki.dialogClosed')));
            const st = pathTracing.getStatus();
            if (st.phase === 'done') return resolve();
            if (st.phase === 'error') return reject(new Error(st.error || t('viewer.ki.ptError')));
            if (st.phase === 'suspended') return reject(new Error(t('viewer.ki.sectionActive')));
            const phase = { bvh: 'bvh', compiling: 'bvh', rendering: 'rendering', 'denoise-loading': 'denoiseLoading', denoising: 'denoising', preview: 'moving', motion: 'moving' }[st.phase] || 'waiting';
            onProgress(t(`viewer.ki.progress.${phase}`, { samples: Math.round(st.samples), maxSamples: st.maxSamples }), st.phase === 'denoising' ? 0.9 + 0.1 * st.progress : st.progress * 0.9);
            setTimeout(tick, 200);
        };
        tick();
    });
const kiRender = new KiRender({
    getTitle: () => model?.name.replace(/\.[^.]+$/, '') || '',
    waitForImage: onProgress => waitForImage(onProgress, () => kiRender.isOpen),
    capture: captureFrame,
    // materials of the visible parts with their part names, most frequent first
    getMaterials: () => {
        const byId = new Map();
        const shown = o => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
        rootGroup?.traverse(o => {
            if (!o.isMesh || !shown(o)) return;
            const entry = materialManager.get(o.material?.userData?.materialId);
            if (!entry) return;
            let m = byId.get(entry.def.id);
            if (!m) {
                const p = entry.def.params || {};
                byId.set(entry.def.id, m = {
                    name: entry.def.name, color: (p.color || '#808080').toUpperCase(), description: describeMaterial(p),
                    cad: entry.def.source === 'step', partSet: new Set(), meshes: 0,
                });
            }
            m.meshes++;
            const part = o.parent?.name || o.name;
            if (part) m.partSet.add(part.split(/[\\/]/).pop());
        });
        return [...byId.values()].sort((a, b) => b.meshes - a.meshes).map(({ partSet, meshes, ...m }) => ({
            ...m, parts: [...partSet].slice(0, 6), partCount: partSet.size,
        }));
    },
    openSettings: () => { setup.show('ki'); setSetupOpen(true); },
    getEnvironment: () => {
        const env = captureState(sceneStateContext).environment;
        const light = env.hdri ? t('viewer.ki.environment.lightHdri', { name: env.customName(env.hdri) ?? env.hdri.replace(/\.[^.]+$/, '') }) : t('viewer.ki.environment.lightStudio');
        const background = t(env.background ? 'viewer.ki.environment.backgroundHdri' : 'viewer.ki.environment.backgroundStudio');
        return t(env.ground ? 'viewer.ki.environment.sentenceGround' : 'viewer.ki.environment.sentence', { light, background });
    },
});
viewModeBar.addAction({
    label: t('toolbar.ki'), title: t('toolbar.kiTitle'),
    // sparkle icon (large + small star), stroke style like the tool icons
    icon: '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.3" stroke-linejoin="round"><path d="M6.5 2.5l1.1 3.4 3.4 1.1-3.4 1.1-1.1 3.4-1.1-3.4L2 7l3.4-1.1z"/><path d="M12 9.5l.55 1.45L14 11.5l-1.45.55L12 13.5l-.55-1.45L10 11.5l1.45-.55z"/></svg>',
    onClick: () => kiRender.start(),
});

// Hide/show the UI (key U) and fullscreen – buttons on the right of the view-mode bar.
// Elements with data-ui="left|right|down" slide out (CSS in index.astro); loading progress stays.
const ICON_UI = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M5.5 2.5v11M1.5 6h4"/></svg>';
const ICON_FULL = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.5"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';
const ICON_FULL_EXIT = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.5"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>';
let uiHidden = false;
// Save/load scene (own group before UI/fullscreen) – file input independent of the GUI,
// so that "load" also works without a model
const ICON_IMAGE = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 11l3.5-3.5 3 3 2-2L14 12"/><circle cx="10.5" cy="5.5" r="1"/></svg>';
const ICON_SAVE = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 2.5h8.5l2.5 2.5v8.5h-11z"/><path d="M5 2.5v3.5h5.5V2.5M5 13.5V9.5h6v4"/></svg>';
const ICON_OPEN = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linejoin="round"><path d="M1.5 12.5v-9h4.5l1.5 1.5h6v2"/><path d="M1.5 12.5l2-5.5h11l-2 5.5z"/></svg>';
const sceneFileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json,.bcfzip,.bcf', hidden: true });
sceneFileInput.onchange = async () => {
    const file = sceneFileInput.files[0];
    sceneFileInput.value = '';
    if (file && BCF_EXTENSIONS.includes(extOf(file.name))) { openBcfFile(file); return; }   // BIM: issues + scene
    const state = file && await openJsonFile(file);
    if (state) { closeBcf(); openSceneFile(state); }
};
document.body.append(sceneFileInput);
const imageExport = createImageExport({
    exportImage,
    getName: () => (sceneFileName?.replace(/\.scene\.json$|\.json$/i, '') || model?.name.replace(/\.[^.]+$/, '') || 'rindr'),
    getSize: () => ({ width: renderer.domElement.width, height: renderer.domElement.height }),
    maxSize: maxExportSize,
});
viewModeBar.addTool({ icon: ICON_IMAGE, title: t('toolbar.exportImage'), onClick: () => { if (rootGroup) imageExport.open(); else showStatus(t('status.loadModelFirst')); }, group: 'scene' });
// save/open scene: hidden for now (config.js SCENE.saveOpen)
if (SCENE.saveOpen) {
    viewModeBar.addTool({ icon: ICON_SAVE, title: t('toolbar.saveScene'), onClick: () => saveScene(), group: 'scene' });
    viewModeBar.addTool({ icon: ICON_OPEN, title: t('toolbar.loadScene'), onClick: () => sceneFileInput.click(), group: 'scene' });
}
// asset window (links): which files the scene uses, relink missing ones
assetsWindow = createAssetsWindow({ rows: () => assetRows(), onFiles: files => relinkFiles(files) });
const ICON_ASSETS = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round"><path d="M6.5 9.5l3-3"/><path d="M7 4.5l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8"/><path d="M9 11.5l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/></svg>';
const setAssetsTool = viewModeBar.addTool({ icon: ICON_ASSETS, title: t('toolbar.assets'), onClick: () => (assetsWindow.isOpen ? assetsWindow.hide() : assetsWindow.show()), group: 'scene' });
updateAssetsTool = () => {
    const missing = assetRows().filter(r => r.status === 'missing').length;
    setAssetsTool(false, missing ? t('toolbar.assetsMissing', { count: missing }) : t('toolbar.assets'));
    setAssetsTool.button.classList.toggle('text-amber-300', missing > 0);
};
updateAssetsTool();

// --- BCF issues (bcf/): window right, .bcfzip open/save; viewpoints in IFC world coordinates (metres, z up) are
// mapped through the first IFC model: web-ifc output = shift + (x, z, −y), × 1000 mm, then its root ---
const BCF_EXTENSIONS = ['bcfzip', 'bcf'];
let bcfModule = null, bcfPanel = null;
const loadBcf = () => (bcfModule ??= Promise.all([import('./bcf/bcf-format.js'), import('./bcf/bcf-panel.js')]).then(([format, panel]) => {
    bcfPanel = panel.createBcfPanel({
        apply: (vp, topic) => applyBcfViewpoint(vp, topic),
        capture: () => captureBcfViewpoint(format.uuid),
        open: () => bcfFileInput.click(),
        save: doc => saveBcf(doc, format),
        author: () => bcfAuthor.get(),
        openSettings: () => { setup.show('bim'); setSetupOpen(true); },
        onShow: open => { setBcfTool(open, t('toolbar.bcf')); updateBcfTool(); },
    });
    return { format, panel: bcfPanel };
}));
const bcfFileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.bcfzip,.bcf', hidden: true });
bcfFileInput.onchange = () => { const f = bcfFileInput.files[0]; bcfFileInput.value = ''; if (f) openBcfFile(f); };
document.body.append(bcfFileInput);
const ICON_BCF = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5.5 6h5M5.5 8h3" stroke-linecap="round"/></svg>';
const setBcfTool = viewModeBar.addTool({ icon: ICON_BCF, title: t('toolbar.bcf'), onClick: async () => (await loadBcf()).panel.toggle(), group: 'scene' });
// only with BIM: an IFC model is loaded (issues can be created and saved) or a BCF file is open
function updateBcfTool() {
    const ifc = [rootGroup, ...extraModels.map(x => x.root)].some(r => r?.userData.bim);
    const visible = ifc || !!bcfPanel?.doc;
    setBcfTool.button.hidden = !visible;
    if (!visible && bcfPanel?.isOpen) bcfPanel.hide();
}
updateBcfTool();
bcfUi.update = updateBcfTool;
// author of new issues and comments (settings → BIM, per browser)
const bcfAuthor = {
    get: () => { try { return localStorage.getItem('rindr.bcf.author') || ''; } catch { return ''; } },
    set: v => { try { localStorage.setItem('rindr.bcf.author', v); } catch { /* storage blocked */ } window.dispatchEvent(new Event('rindr:bcf-author')); },
};

/**
 * Open a .bcfzip: issues into the window; RINDR's own (with scene) opens like a scene file – models found among
 * the handed-in files/on the server, missing ones in the asset window; a foreign one with IFC file names in the
 * topic headers adds those IFC models (or lists them as missing). files: dropped along (asset pool).
 * @returns {Promise<boolean>} models were taken care of (the drop handler must not load the files itself)
 */
async function openBcfFile(file, files = []) {
    try {
        const { format, panel } = await loadBcf();
        if (panel.dirty && !(await confirmDialog({ title: t('bcf.replaceTitle'), message: t('bcf.replaceMessage'), confirmLabel: t('bcf.replaceConfirm'), danger: true }))) return true;
        const doc = await format.readBcf(await file.arrayBuffer());
        doc.name = file.name;
        const scene = doc.scene ? JSON.parse(doc.scene) : null;
        delete doc.scene;
        panel.setDocument(doc);
        updateBcfTool();
        flashStatus(t('status.bcfLoaded', { count: doc.topics.length, name: file.name }), 4000);
        if (scene) {
            sceneFileName = file.name;
            await openSceneFile(scene, files);
            return true;
        }
        const names = [...new Map(doc.topics.flatMap(x => x.header || []).filter(f => f.filename).map(f => [f.filename.toLowerCase(), f])).values()];
        if (!names.length) return false;
        await addBcfModels(names, files);
        return true;
    } catch (err) {
        console.error(err);
        showStatus(t('status.error', { message: err.message }));
        return true;
    }
}
// The issues belong to the scene: replacing it (splats, "replace models", opening a plain scene file) closes them –
// saving is a .scene.json again unless IFC models remain (adding a model keeps them)
function closeBcf() {
    if (!bcfPanel) return;
    bcfPanel.clear();   // also an open window without issues
    updateBcfTool();
}
// IFC files named in the topic headers that are not loaded yet: load (dropped along / server) or list as missing.
// Added to what is loaded – a BCF never removes models.
async function addBcfModels(files, pool) {
    filePool = [...filePool, ...pool];
    const loaded = runtimeModels();
    const loadedNames = new Set([...loaded.map(m => m.file.name.toLowerCase()), ...missingModels.map(m => m.name.toLowerCase())]);
    const loadedProjects = new Set(loaded.map(m => m.root.userData.bim?.project?.guid).filter(Boolean));
    const wanted = files.filter(f => !loadedNames.has(f.filename.split(/[\\/]/).pop().toLowerCase()) && !(f.ifcProject && loadedProjects.has(f.ifcProject)));
    let index = loaded.length + missingModels.length;
    for (const f of wanted) {
        const name = f.filename.split(/[\\/]/).pop();
        const src = await resolveModelSource({ name }, filePool).then(classifyModel);
        if (src && !rootGroup && !loading) openModel(src);
        else if (src) addModel(src, { sceneIndex: index });
        else missingModels.push({ sceneIndex: index, name, chunk: { file: { name, type: 'mesh' }, placement: null, count: 1, transforms: {}, hidden: [], deleted: [], assignments: {} } });
        index++;
    }
    refreshSceneGraph();
    if (missingModels.length) checkAssets(openedScene);
}

const ifcToWorld = (ref, p, direction = false) => {
    const v = new THREE.Vector3(p[0], p[2], -p[1]);
    ref.root.updateWorldMatrix(true, false);
    if (direction) return v.transformDirection(ref.root.matrixWorld);
    return ref.root.localToWorld(v.add(new THREE.Vector3(...ref.origin)).multiplyScalar(1000));
};
const worldToIfc = (ref, v, direction = false) => {
    ref.root.updateWorldMatrix(true, false);
    const q = direction ? v.clone().transformDirection(ref.root.matrixWorld.clone().invert())
        : ref.root.worldToLocal(v.clone()).multiplyScalar(0.001).sub(new THREE.Vector3(...ref.origin));
    return [q.x, -q.z, q.y].map(x => +x.toFixed(6));
};
// IFC elements of all loaded IFC models by GlobalId (element groups – not storeys or class groups)
function ifcElements() {
    const map = new Map();
    for (const root of [rootGroup, ...extraModels.map(x => x.root)]) {
        root?.traverse(o => { const ifc = o.userData.ifc; if (ifc?.guid && !ifc.spatial && !ifc.group) map.set(ifc.guid, o); });
    }
    return map;
}

function applyBcfViewpoint(vp, topic) {
    const ref = ifcReference();
    if (vp.camera && ref) {
        const c = vp.camera;
        const position = ifcToWorld(ref, c.position);
        const direction = ifcToWorld(ref, c.direction, true).normalize();
        const box = new THREE.Box3().setFromObject(slicer.group);
        const center = box.isEmpty() ? position.clone().addScaledVector(direction, 10000) : box.getCenter(new THREE.Vector3());
        let fov = Math.min(Math.max(c.fov ?? 60, 10), 100), eye = position, target;
        if (c.type === 'orthogonal') {
            // no orthographic camera: perspective with a narrow angle at a distance showing the same height
            fov = 30;
            target = position.clone().addScaledVector(direction, Math.max(direction.dot(center.clone().sub(position)), 0));
            eye = target.clone().addScaledVector(direction, -(c.scale * 1000) / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2))));
        } else {
            target = position.clone().addScaledVector(direction, Math.max(direction.dot(center.clone().sub(position)), 2000));
        }
        camera.near = Math.min(camera.near, 10);
        camera.updateProjectionMatrix();
        const roll = c.up ? rollFromUp(direction, ifcToWorld(ref, c.up, true)) : 0;
        flyToView({ position: eye.toArray(), target: target.toArray(), fov, roll: Math.abs(roll) < 0.05 ? 0 : roll });
    }
    // visibility: BCF default + exceptions for the IFC elements; selection
    const elements = ifcElements();
    if (!elements.size) return;
    const exceptions = new Set(vp.visibility.exceptions);
    const show = [], hide = [];
    for (const [guid, group] of elements) {
        const want = vp.visibility.defaultVisible !== exceptions.has(guid);
        const entry = sceneGraph.entryForObject(group);
        if (!entry || entry.object !== group) continue;
        if (want && !shownInScene(group)) show.push(entry);
        else if (!want && group.visible) hide.push(entry);
    }
    if (show.length) sceneGraph.setVisible(show, true);
    if (hide.length) sceneGraph.setVisible(hide, false);
    const selected = vp.selection.map(g => elements.get(g)).filter(Boolean);
    if (selected.length) sceneGraph.selectObjects(selected, topic.title || t('bcf.untitled'));
    else sceneGraph.select(null);
    const referenced = new Set([...vp.selection, ...vp.visibility.exceptions]);
    const missing = [...referenced].filter(g => !elements.has(g)).length;
    if (missing && missing === referenced.size) flashStatus(t('status.bcfNoElements', { count: missing }), 5000);
}

async function captureBcfViewpoint(uuid) {
    const ref = ifcReference();
    const direction = controls.target.clone().sub(camera.position).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const cameraInfo = ref ? {
        type: 'perspective', position: worldToIfc(ref, camera.position), direction: worldToIfc(ref, direction, true),
        up: worldToIfc(ref, up, true), fov: Math.min(Math.round(viewAngle(camera) * 100) / 100, 100),
    } : null;
    // selected IFC elements (also all elements inside a selected storey/class group) and hidden ones
    const elements = ifcElements();
    const guidOf = new Map([...elements].map(([g, o]) => [o, g]));
    const selected = new Set();
    const sel = selection?.kind === 'selection' ? selection.object.members : selection && isModelEntry(selection) ? [selection.object] : [];
    for (const o of sel) o.traverse?.(c => { if (guidOf.has(c)) selected.add(guidOf.get(c)); });
    const hidden = [...elements].filter(([, o]) => !shownInScene(o)).map(([g]) => g);
    // snapshot without gizmo/highlight, at most 1600 px wide
    const frame = await exportFrame();
    const k = Math.min(1, 1600 / frame.width);
    const c = document.createElement('canvas');
    c.width = Math.round(frame.width * k); c.height = Math.round(frame.height * k);
    c.getContext('2d').drawImage(frame, 0, 0, c.width, c.height);
    const snapshot = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
    return { guid: uuid(), index: null, camera: cameraInfo, selection: [...selected], visibility: { defaultVisible: true, exceptions: hidden }, coloring: [], clipping: [], snapshot };
}

async function saveBcf(doc, format) {
    // header: the loaded IFC files (project GlobalId + file name) for topics without one
    const files = [rootGroup, ...extraModels.map(x => x.root)].map(r => r?.userData.bim).filter(Boolean)
        .map(b => ({ ifcProject: b.project?.guid || '', ifcSpatial: '', filename: b.fileName, date: '', reference: '' }));
    for (const topic of doc.topics) if (!topic.header?.length) topic.header = files;
    if (!doc.project) {
        const p = [rootGroup, ...extraModels.map(x => x.root)].map(r => r?.userData.bim?.project).find(Boolean);
        doc.project = { id: format.uuid(), name: p?.name || model?.name || '' };
    }
    // the scene (materials, light, camera, models …) goes along – RINDR opens the .bcfzip like a scene file
    const scene = rootGroup || missingModels.length ? JSON.stringify(captureState(sceneStateContext), null, 1) : null;
    const blob = await format.writeBcf(doc, { scene });
    const suggested = doc.name || (sceneFileName && /\.bcfzip$/i.test(sceneFileName) ? sceneFileName : `${(model?.name || 'issues').replace(/\.[^.]+$/, '')}.bcfzip`);
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'BCF', accept: { 'application/zip': ['.bcfzip'] } }] });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            bcfPanel.markSaved(handle.name);
            sceneFileName = handle.name;
            flashStatus(t('status.bcfSaved', { name: handle.name }), 3000);
            return;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.warn('[BCF] save dialog not available, downloading instead:', err);
        }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = suggested;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    bcfPanel.markSaved(suggested);
    sceneFileName = suggested;
}
// BIM context: an IFC model is loaded or BCF issues are open → saving writes a .bcfzip
const bimActive = () => [rootGroup, ...extraModels.map(x => x.root)].some(r => r?.userData.bim) || !!bcfPanel?.doc?.topics.length;

// Setup menu: gear left of the UI button, panel centred in the window
const ICON_GEAR = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.3" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M6.9 1.5h2.2l.35 1.75 1.2.7 1.7-.57 1.1 1.9-1.35 1.18v1.38l1.35 1.18-1.1 1.9-1.7-.57-1.2.7-.35 1.75H6.9l-.35-1.75-1.2-.7-1.7.57-1.1-1.9 1.35-1.18V6.98L2.55 5.8l1.1-1.9 1.7.57 1.2-.7z"/></svg>';
let setupOpen = false;
const setGearTool = viewModeBar.addTool({ icon: ICON_GEAR, title: t('toolbar.setup'), onClick: () => setSetupOpen(!setupOpen) });
// centred in the window
function centerSetupMenu() {
    setupMenu.style.left = `${Math.max(8, (window.innerWidth - setupMenu.offsetWidth) / 2)}px`;
    setupMenu.style.top = `${Math.max(8, (window.innerHeight - setupMenu.offsetHeight) / 2)}px`;
}
window.addEventListener('resize', () => { if (setupOpen) centerSetupMenu(); });
function setSetupOpen(open) {
    setupOpen = open;
    setGearTool(open);
    if (open) {
        centerSetupMenu();
        // slight scale-in only when opening; closing just fades (shrinking while fading looked odd)
        setupMenu.style.transition = 'none';
        setupMenu.classList.add('scale-[0.98]');
        void setupMenu.offsetWidth;
        setupMenu.style.transition = '';
        setupMenu.classList.remove('scale-[0.98]');
    }
    setupMenu.classList.toggle('opacity-0', !open);
    setupMenu.classList.toggle('pointer-events-none', !open);
    setupMenu.classList.toggle('pointer-events-auto', open);
}
document.addEventListener('pointerdown', e => {
    if (setupOpen && !dialogOpen() && !setupMenu.contains(e.target) && !setGearTool.button.contains(e.target)) setSetupOpen(false);
}, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape' && setupOpen && !dialogOpen()) { e.stopPropagation(); setSetupOpen(false); } }, true);
const setUiTool = viewModeBar.addTool({ icon: ICON_UI, title: t('toolbar.hideUi'), onClick: () => toggleUi() });
function toggleUi(hidden = !uiHidden) {
    uiHidden = hidden;
    if (hidden) setSetupOpen(false);
    document.body.classList.toggle('ui-hidden', hidden);
    setUiTool(hidden, t(hidden ? 'toolbar.showUi' : 'toolbar.hideUi'));
}
const setFullTool = viewModeBar.addTool({
    icon: ICON_FULL, title: t('toolbar.fullscreen'),
    onClick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
});
// Exploded view (key X, button in the bar, strength in the model panel). Raster preview during the
// animation, then update the path tracing scene once (rebuilding it every frame would be too expensive).
const exploder = new Exploder(() => [...currentNodeGroups, ...extraModels.flatMap(x => x.nodeGroups)].filter(g => g.children.some(c => c.isMesh)));
const ICON_EXPLODE = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4"><rect x="6" y="6" width="4" height="4" rx="0.5"/><path d="M4.5 4.5L2 2m0 0h2.5M2 2v2.5M11.5 4.5L14 2m0 0h-2.5M14 2v2.5M4.5 11.5L2 14m0 0h2.5M2 14v-2.5M11.5 11.5L14 14m0 0h-2.5M14 14v-2.5"/></svg>';
const setExplodeTool = viewModeBar.addTool({ icon: ICON_EXPLODE, label: t('toolbar.explodeLabel'), title: t('toolbar.explode'), onClick: () => toggleExplode(), start: true });
// Undo/redo far left (start group created later = further left)
const ICON_UNDO = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3L2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 010 8H7"/></svg>';
const ICON_REDO = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3l3 3-3 3"/><path d="M13.5 6h-7a4 4 0 000 8H9"/></svg>';
const setUndoTool = viewModeBar.addTool({ icon: ICON_UNDO, title: t('toolbar.undo'), onClick: () => undoRedo(false), start: true, group: 'history' });
const setRedoTool = viewModeBar.addTool({ icon: ICON_REDO, title: t('toolbar.redo'), onClick: () => undoRedo(true), start: true, group: 'history' });
// reset all model changes (materials, moves/rotations/scaling, visibility, explosion) – one undo step
const ICON_RESET = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 0 1.5-3.6"/><path d="M3 2.5v2.5h2.5"/><circle cx="8" cy="8" r="1"/></svg>';
viewModeBar.addTool({ icon: ICON_RESET, title: t('toolbar.resetModel'), onClick: () => resetModel(), start: true, group: 'history' });
function resetModel() {
    if (!rootGroup || loading) return;
    history.transaction(t('viewer.undo.resetModel'), () => {
        // materials: back to the material from the file
        const byDefault = new Map();
        for (const mesh of allModelMeshes()) {
            const id = mesh.userData.defaultMaterialId;
            if (!id || mesh.material?.userData?.materialId === id) continue;
            if (!byDefault.has(id)) byDefault.set(id, []);
            byDefault.get(id).push(mesh);
        }
        byDefault.forEach((meshes, id) => assignMaterial({ traverse: fn => meshes.forEach(fn) }, id));
        // moves/rotations/scaling of the parts
        const changed = [...currentNodeGroups, ...extraModels.flatMap(x => x.nodeGroups)].filter(g => {
            const xf = g.userData.xf;
            return xf && (xf.offset.lengthSq() > 0 || xf.rotation.x || xf.rotation.y || xf.rotation.z || xf.scale.x !== 1 || xf.scale.y !== 1 || xf.scale.z !== 1);
        });
        if (changed.length) {
            const before = changed.map(g => captureTransform(g, 'node'));
            const identity = { offset: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) };
            const apply = states => { changed.forEach((g, i) => restoreTransform(g, 'node', states ? states[i] : identity)); pathTracing.updateTransforms(); transformer.sync(); properties.show(selection); };
            apply(null);
            history.record({ label: t('viewer.undo.resetModel'), undo: () => apply(before), redo: () => apply(null) });
        }
        // deleted parts come back
        if (sceneGraph.deleted.size) {
            const before = [...sceneGraph.deleted];
            const apply = keys => { sceneGraph.deleted = new Set(keys); refreshSceneGraph(); pathTracing.updateTransforms(); };
            apply([]);
            history.record({ label: t('viewer.undo.resetModel'), undo: () => apply(before), redo: () => apply([]) });
        }
        // visibility (own undo record via the scene graph)
        showAll();
    });
    // explosion: back together (not part of undo, like the explode button)
    if (exploder.active) exploder.set(0);
    flashStatus(t('status.modelReset'));
}
const updateHistoryTools = () => {
    setUndoTool(false, history.canUndo ? t('toolbar.undoStep', { label: history.undoStack.at(-1)?.label ?? '' }) : t('toolbar.nothingToUndo'), history.canUndo);
    setRedoTool(false, history.canRedo ? t('toolbar.redoStep', { label: history.redoStack.at(-1)?.label ?? '' }) : t('toolbar.nothingToRedo'), history.canRedo);
};
history.addEventListener('change', updateHistoryTools);
updateHistoryTools();
function toggleExplode() {
    if (!rootGroup || loading) return;
    exploder.toggle();
}
exploder.addEventListener('start', () => pathTracing.pauseForEdit());
let explodeDragging = false;
exploder.addEventListener('update', () => {
    transformer.sync();
    loadRender.dirty = true;
    // set immediately (number field): update the path tracing scene; animation/slider do it at the end
    if (!exploder.anim && !explodeDragging) pathTracing.updateTransforms();
});
exploder.addEventListener('end', () => { transformer.sync(); pathTracing.resumeAfterEdit('node'); });
exploder.addEventListener('change', () => setExplodeTool(exploder.active, t(exploder.active ? 'toolbar.collapse' : 'toolbar.explode')));
document.addEventListener('fullscreenchange', () => {
    const full = !!document.fullscreenElement;
    setFullTool(full, t(full ? 'toolbar.exitFullscreen' : 'toolbar.fullscreen'));
    setFullTool.button.innerHTML = full ? ICON_FULL_EXIT : ICON_FULL;
});
function setViewMode(mode) {
    // the path tracer cannot trace Gaussian splats – they are shown rasterised (that is their final look)
    if (mode === 'hq' && (!pathTracing.supported || splatMesh)) mode = 'default';
    // HQ while playing: pause first (the path tracer shows the paused frame); another mode chosen during
    // playing: no automatic return to HQ
    if (animPlaying && clipAnims().length) { hqBeforePlay = false; if (mode === 'hq') setAnimPlaying(false); }
    viewMode = mode;
    scene.overrideMaterial = mode === 'basic' ? clayMaterial : null;
    // Basic without shadow maps: each one is another pass over the whole model (one draw call per mesh –
    // large assemblies: 2 × ~7500 extra draw calls per frame); the contact shadow stays.
    // Not via castShadow: switching it off disposes the light's ShadowNode, but cached render objects of the
    // shadowed variant keep it → back in Default updateBefore reads the freed map ("reading 'depthTexture'
    // of null", three r186). Instead: no shadow-map updates and shadow intensity 0 (uniform, no recompile)
    const shadows = mode !== 'basic';
    shadowsOn = shadows;
    for (const light of [dirLight1, dirLight2]) {
        light.shadow.needsUpdate = shadows;
        light.shadow.intensity = shadows ? 1 : 0;
    }
    updateShadowMaps();   // autoUpdate only without the batcher
    pathTracing.setEnabled(mode === 'hq');
    if (mode === 'hq') checkPathTracingScene();
    updatePathTracingScene();
    viewModeBar.set(mode, { disabled: pathTracing.supported && !splatMesh ? [] : ['hq'] });
    setup.refresh();   // "Active" checkbox in the path tracing folder
    loadRender.force = true;
    // first Basic/Default with these batches: compiles their shader variants → "taking over scene" first
    const variant = `${mode}:${batcher.generation}`;
    if (mode !== 'hq' && batcher.batches.length && !preparedModes.has(variant)) {
        preparedModes.add(variant);
        announcePrepare();
    }
}

// A frame that compiles many shaders blocked the main thread (node building, large assembly: ~0.7 s) and then the GPU
// process (synchronous pipelines, ~0.9 s) – first Basic/Default switch with these batches (a regrouping
// compiles itself beforehand, render-batcher.js). Instead the next frame only compiles: compileAsync
// (shader-compile.js; through the batches, into the same target as the raster view) builds object by object
// with pauses and creates the pipelines asynchronously. Until done no frame is drawn – the canvas keeps the previous image, the status shows
// "Übernehme Szene", the page stays responsive.
const preparedModes = new Set();
const prepare = { compile: false, jobs: 0, shown: false, generation: 0 };
function announcePrepare() {
    prepare.compile = true;
    prepare.shown = true;
}
function compileRaster() {
    if (lens.active) lens.begin();   // the raster view draws into the lens target then (other pipelines)
    try {
        return batcher.compileAsync(scene, camera);
    } finally {
        renderer.setRenderTarget(null);
    }
}

// Path tracing scene still matching the scene? Snapshot per mesh (geometry, its position/index data version,
// BVH) at setScene; switching to HQ compares and rebuilds on a difference – with a console note which meshes
// changed. Materials are checked against the path tracer's material list (a missing one would make the mesh
// use material 0 – often the ground shadow catcher, i.e. invisible); then only the materials are updated. Safety net for parts missing in HQ while Default shows them (a change that did not
// reach the path tracer, cause not found yet).
let ptSnapshot = null;
function sceneMeshes() {
    const list = [];
    for (const root of [rootGroup, ...extraModels.map(x => x.root)]) root?.traverse(o => { if (o.isMesh) list.push(o); });
    return list;
}
const meshSignature = m => `${m.geometry.uuid}|${m.geometry.getAttribute('position')?.version}|${m.geometry.index?.version}|${!!m.geometry.boundsTree}`;
function snapshotPathTracingScene() {
    ptSnapshot = new Map(sceneMeshes().map(m => [m, meshSignature(m)]));
}
function checkPathTracingScene() {
    if (!pathTracing.ready || !ptSnapshot) return;
    const meshes = sceneMeshes();
    const changed = meshes.filter(m => ptSnapshot.get(m) !== meshSignature(m));
    if (!changed.length && meshes.length === ptSnapshot.size) {
        const known = pathTracing.pathTracer?._bvhData?.materialsMap;
        const unknown = known && meshes.filter(m => !Array.isArray(m.material) && !known.has(m.material));
        if (unknown?.length) {
            console.warn('[Pathtracer] materials out of date – updating:', unknown.slice(0, 10).map(m => `${m.name}: ${m.material?.name}`));
            pathTracing.updateMaterials();
        }
        return;
    }
    console.warn('[Pathtracer] scene out of date – rebuilding:', { meshesNow: meshes.length, meshesBefore: ptSnapshot.size,
        changed: changed.slice(0, 10).map(m => `${m.name || m.uuid}: ${ptSnapshot.get(m) ?? 'new'} → ${meshSignature(m)}`) });
    pathTracing.invalidate();
}

// Build the path tracing scene as soon as it is enabled and a model is loaded
// Not while a model is loading: STEP solids arrive one after another (streaming) – switching to HQ during the
// import built the path tracer with the solids so far, later ones never got into its BVH (parts missing,
// could not be shown again). runLoad() calls this right after each load instead.
async function updatePathTracingScene() {
    if (!pathTracing.enabled || !rootGroup || pathTracing.ready || pathTracing.building || loading) return;
    const version = sceneVersion;
    try {
        await pathTracing.setScene(scene, camera);
        snapshotPathTracingScene();
    } catch (err) {
        console.error(err);
        showStatus(t('status.ptError', { message: err.message }));
    }
    // scene changed during the build (new model) -> again
    if (version !== sceneVersion) {
        pathTracing.invalidate();
        updatePathTracingScene();
    }
}

// Geometry/scene changed: the path tracing scene must be taken over again
let sceneVersion = 0;
function invalidatePathTracing() {
    sceneVersion++;
    pathTracing.invalidate();
}

// Remove the model group (release geometries)
function disposeRoot(root) {
    root.userData.bim?.dispose();   // IFC: close the web-ifc worker
    root.userData.bim = null;
    root.traverse(c => {
        if (!c.isMesh) return;
        if (c.isSplat) c.sorter.dispose();   // Gaussian splats: sort workers
        c.geometry.boundsTree = null;
        c.geometry.dispose();
        // three.js (WebGPU) keeps every render object in renderer._objects._renderObjects (Set) until
        // 'dispose' is fired on the object itself – geometry.dispose() is not enough. Without this the
        // whole old model stayed in memory on every re-tessellation/model change (+450 MB per pass).
        c.dispatchEvent({ type: 'dispose' });
    });
    root.removeFromParent();
}
function clearModel() {
    splatSpin.active = false;
    fading.clear();
    removeAnimations();
    removeExtraModels();
    if (splatMesh) {
        splatMesh = null;
        // tone mapping switched off for the splats: back to the previous curve (unless changed meanwhile)
        if (toneMappingBeforeSplats !== null && renderer.toneMapping === THREE.NoToneMapping) renderer.toneMapping = toneMappingBeforeSplats;
        toneMappingBeforeSplats = null;
        applySplatUi();
        viewModeBar.set(viewMode, { disabled: pathTracing.supported ? [] : ['hq'] });   // HQ possible again
    }
    if (!rootGroup) return;
    invalidatePathTracing();
    disposeRoot(rootGroup);
    rootGroup = null;
    currentMeshes = [];
    currentNodeGroups = [];
    currentPlan = null;
    solidQualityUsed = [];
}

// Import geometry -> BufferGeometry (geometries are shared by all instances of a solid)
function makeGeometry(g) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
    if (g.tangents) geometry.setAttribute('tangent', new THREE.BufferAttribute(g.tangents, 4));
    geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
    // take over the BVH built in the worker (index is already reordered accordingly)
    if (g.bvh) {
        geometry.boundsTree = MeshBVH.deserialize({ version: 1, roots: g.bvh, index: g.index, indirectBuffer: null }, geometry);
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

// Lowest y of all vertices (mesh.matrix = position in the model root), fallback if there are none
function lowestPoint(meshes, fallback) {
    let min = Infinity;
    for (const mesh of meshes) {
        const p = mesh.geometry.getAttribute('position'), e = mesh.matrix.elements;
        if (!p) continue;
        const a = p.array;
        // fast path for plain float positions, otherwise getX/Y/Z (normalised/interleaved)
        if (!p.isInterleavedBufferAttribute && !p.normalized && a instanceof Float32Array) {
            for (let i = 0; i < a.length; i += 3) {
                const y = e[1] * a[i] + e[5] * a[i + 1] + e[9] * a[i + 2] + e[13];
                if (y < min) min = y;
            }
        } else {
            for (let i = 0; i < p.count; i++) {
                const y = e[1] * p.getX(i) + e[5] * p.getY(i) + e[9] * p.getZ(i) + e[13];
                if (y < min) min = y;
            }
        }
    }
    return Number.isFinite(min) ? min : fallback;
}

// Place the camera so that box (world) fits the view; animated, view direction is kept
function fitCamera(box, { animate = true, direction = null } = {}) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-6);
    const vFovHalf = THREE.MathUtils.degToRad(camera.fov / 2);
    const hFovHalf = Math.atan(Math.tan(vFovHalf) * camera.aspect);
    const dist = (radius / Math.tan(Math.min(vFovHalf, hFovHalf))) * 1.2;
    const dir = direction || camera.position.clone().sub(controls.target).normalize();
    const toPos = center.clone().addScaledVector(dir, dist);
    camera.near = dist * 0.001;
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    if (!animate) {
        cancelFlight();
        camera.position.copy(toPos);
        controls.target.copy(center);
        controls.update();
        return;
    }
    flight = {
        t0: performance.now(), duration: 350, quiet: true,
        fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toPos, toTarget: center,
    };
}

// Fade in new parts during import (mask in material-manager.js, userData.fade 0..1)
const FADE_MS = 400;
const fading = new Map();   // mesh -> start time
function startFade(mesh) {
    mesh.userData.fade = 0;
    fading.set(mesh, performance.now());
}
function updateFades(now) {
    for (const [mesh, t0] of fading) {
        const f = Math.min((now - t0) / FADE_MS, 1);
        mesh.userData.fade = f * f * (3 - 2 * f);
        if (f >= 1) { delete mesh.userData.fade; fading.delete(mesh); }
    }
}

// Camera follows the growing model until the user orbits/zooms
const streamFit = { active: false };
controls.addEventListener('start', () => { streamFit.active = false; splatSpin.active = false; });
// Splat scenes: after loading the camera slowly circles the orbit centre (SPLATS.autoRotate) until the user
// takes over – around an object, or panning on the spot inside a room (centre right in front of the camera)
const splatSpin = { active: false, period: 40, last: 0 };
function updateSplatSpin(now) {
    if (!splatSpin.active || flight) { splatSpin.last = 0; return; }
    const dt = splatSpin.last ? Math.min(now - splatSpin.last, 100) / 1000 : 0;
    splatSpin.last = now;
    if (!dt) return;
    camera.position.sub(controls.target).applyAxisAngle(THREE.Object3D.DEFAULT_UP, 2 * Math.PI * dt / splatSpin.period).add(controls.target);
}
// throttled rendering during import (see render loop)
const loadRender = { active: false, dirty: false, force: false, last: 0 };
controls.addEventListener('change', () => { if (!flight) loadRender.force = true; else loadRender.dirty = true; });
window.addEventListener('resize', () => { loadRender.force = true; });
window.addEventListener('pointermove', () => { if (loadRender.active) loadRender.dirty = true; });

// --- Load and process the model (STEP: tessellate; glTF/FBX: take over meshes) ---
// reload = re-tessellate the same STEP model (materials + transforms are kept). The old model stays
// visible until the new one is done; when opening, the model builds up part by part.
async function loadModel(reload = false) {
    if (model.type === 'splat') {
        // a .ply can also be a plain mesh: then the mesh import
        if (await isSplatSource(model)) return loadSplatScene();
        model = meshSourceOf(model);
    }
    const root = new THREE.Group();
    try {
        hideStatus();
        stopAnimation();   // the live puppet must not be in the scene while loading
        if (model.type === 'step') await ensureStepContent();
        if (model.type === 'mesh' && !model.main) {
            showProgress(t('status.loadingFile'));
            const res = await fetch(model.url, { signal: loadAbort?.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            model.main = await res.blob();
        }
        model.size ??= model.content?.byteLength ?? model.main?.size ?? null;   // matching of scene states

        // On re-tessellation remember material assignments and transforms
        // (structure and mesh order stay the same)
        let keep = null;
        if (reload && rootGroup) {
            keep = { materials: currentMeshes.map(m => m.material.userData.materialId), transforms: currentNodeGroups.map(g => g.userData.xf || null) };
        }
        invalidatePathTracing();
        loadRender.active = true;
        if (!reload) {
            sceneGraph.select(null);
            clearModel();
            history.clear();   // steps refer to the old model
            exploder.reset();
            // show the new model immediately (grows while loading)
            rootGroup = root;
            root.userData.modelRoot = true;   // explosion per model
            slicer.group.add(root);
            streamFit.active = true;
        }

        // STEP: dummy material per colour (replaceable by library materials), otherwise material from the file
        const materialFor = m => (m.materialId ? materialManager.get(m.materialId) : materialManager.forStepColor(m.color));
        const threeGeometries = [];
        const meshByKey = new Map();   // mesh key (instance/colour) -> mesh (from streaming)
        let nodeGroups = [];
        const bbox = new THREE.Box3();
        const meshBox = new THREE.Box3();

        // One group per assembly/part (object tree). Groups have no transformation
        // of their own – the mesh matrices are already absolute.
        const setupNodes = nodes => {
            nodeGroups = nodes.map(n => { const g = new THREE.Group(); g.name = n.name; if (n.ifc) g.userData.ifc = n.ifc; return g; });
            nodes.forEach((n, i) => (n.parent >= 0 ? nodeGroups[n.parent] : root).add(nodeGroups[i]));
        };
        const addMesh = (m, geometries) => {
            const geometry = threeGeometries[m.geometry] ??= makeGeometry(geometries[m.geometry]);
            const entry = materialFor(m);
            const mesh = new THREE.Mesh(geometry, entry.material);
            mesh.userData.key = m.key;                        // stable across reloads (scene state)
            mesh.userData.instance = m.instance;              // STEP: instance in the plan (part quality)
            mesh.userData.defaultMaterialId = entry.def.id;   // default from the file
            mesh.matrixAutoUpdate = false;
            mesh.matrix.fromArray(m.matrix);
            mesh.castShadow = true;
            if (!reload) startFade(mesh);   // fade in softly when opening (re-tessellation swaps invisibly)
            mesh.receiveShadow = true;
            if (m.name) mesh.name = m.name;
            (nodeGroups[m.node] || root).add(mesh);
            mesh.updateMatrixWorld();
            bbox.union(meshBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrix));
            meshByKey.set(m.key, mesh);
            return mesh;
        };

        // Streaming: attach finished solids immediately, update camera + shadows now and then
        let lastFit = 0, first = true;
        const onSolid = (meshes, geometries) => {
            for (const m of meshes) addMesh(m, geometries);
            loadRender.dirty = true;
            const now = performance.now();
            if (reload || bbox.isEmpty() || now - lastFit < 250) return;
            lastFit = now;
            const size = bbox.getSize(meshBox.min).length();
            fitShadows(size);
            // first view: default view without animation, then follow smoothly
            if (streamFit.active) fitCamera(bbox, first ? { animate: false, direction: DEFAULT_VIEW } : {});
            first = false;
        };

        // STEP with memory protection (IMPORT in config.js): opening chooses a coarser level by itself if
        // the estimate exceeds the budget; if the hard limit is hit while tessellating, the parts streamed
        // so far are discarded and it starts again one level coarser. A quality change by the user beyond
        // the limit is refused (ImportLimitError → catch below, old model stays).
        const tessellateWithLimits = async () => {
            const levels = Object.keys(TESS_PRESETS);
            const requested = settings.meshQuality;
            let quality = requested;
            const counted = {};   // level -> triangles counted until the limit stopped it
            for (;;) {
                try {
                    const res = await tessellateStep(model.content, quality, showProgress, {
                        bvh: pathTracing.supported, instancing: IMPORT.instancing, onPlan: p => { plan = p; setupNodes(p.nodes); }, onSolid,
                        // only part levels (null = global level – it may still become coarser)
                        solidQualities: p => solidQualities(p, quality).map(q => (q === quality ? null : q)),
                        limits: { auto: !reload, ...IMPORT_LIMITS },
                    });
                    usedQualities = solidQualities(plan, res.quality);
                    if (res.quality !== requested) {
                        settings.meshQuality = res.quality;
                        qualityController?.refresh();
                        reducedQuality = { from: requested, to: res.quality, triangles: res.estimates[requested] ?? counted[requested] };
                    }
                    return res;
                } catch (err) {
                    const coarser = levels[levels.indexOf(err.quality) - 1];
                    if (!(err instanceof ImportLimitError) || !err.during || reload || !coarser) throw err;
                    console.warn(`[Load] triangle limit reached at "${err.quality}" – retrying with "${coarser}"`);
                    counted[err.quality] = err.triangles;
                    // discard what was streamed so far
                    for (const c of [...root.children]) disposeRoot(c);
                    fading.clear();
                    threeGeometries.length = 0;
                    meshByKey.clear();
                    bbox.makeEmpty();
                    first = true;
                    quality = coarser;
                }
            }
        };
        let reducedQuality = null;
        if (!reload) settings.partQuality = {};
        let plan = null, usedQualities = [];
        const result = model.type === 'step'
            ? await tessellateWithLimits()
            : await importMeshFile(model, { renderer, materialManager, onStatus: showProgress, bvh: pathTracing.supported });
        const { geometries, meshes, nodes, missing } = result;
        root.userData.bim = result.bim || null;   // IFC: property lookups (worker stays open, closed in disposeRoot)
        root.userData.ifcOrigin = result.bim?.origin || null;   // IFC: shift to the origin (metres) – alignment, BCF
        if (!nodeGroups.length) setupNodes(nodes);
        showProgress(t('status.buildingScene', { count: meshes.length }));
        await afterPaint();

        // Final mesh list in import order (reuse streamed meshes)
        const partCounts = new Array(nodes.length).fill(0);
        const countedInstances = new Set();
        const meshList = [];
        for (const [mi, m] of meshes.entries()) {
            const mesh = meshByKey.get(m.key) || addMesh(m, geometries);
            const kept = keep && materialManager.get(keep.materials[mi]);
            if (kept) mesh.material = kept.material;
            meshList.push(mesh);
            // counted per instance (STEP solid); IFC: per element (its geometries are separate instances)
            if (m.node >= 0 && !countedInstances.has(m.countId ?? m.instance)) {
                countedInstances.add(m.countId ?? m.instance);
                partCounts[m.node]++;
            }
        }
        if (bbox.isEmpty()) throw new Error(t('status.noFaces'));
        // animated glTF/FBX: play bar
        if (result.animation) addAnimation(new ModelAnimation(result.animation, meshList, root), 'main');

        // On re-tessellation, swap the old model for the new one now
        if (reload) {
            if (rootGroup) disposeRoot(rootGroup);
            rootGroup = root;
            root.userData.modelRoot = true;
            slicer.group.add(root);
        }
        currentMeshes = meshList;
        currentNodeGroups = nodeGroups;
        currentPlan = plan;
        solidQualityUsed = usedQualities;

        // --- centre (move the camera along so nothing jumps) ---
        const center = bbox.getCenter(new THREE.Vector3());
        root.position.copy(center).negate();
        root.userData.centerOffset = root.position.clone();
        root.userData.unmovedBox = bbox.clone().translate(root.position);   // placement of further models
        root.updateMatrixWorld(true);
        if (!reload) {
            camera.position.sub(center);
            controls.target.sub(center);
            if (flight) { flight.fromPos.sub(center); flight.fromTarget.sub(center); flight.toPos.sub(center); flight.toTarget.sub(center); }
            controls.update();
        }
        // reapply remembered moves/rotations
        keep?.transforms.forEach((xf, i) => {
            if (xf && nodeGroups[i]) { nodeGroups[i].userData.xf = xf; applyTransform(nodeGroups[i]); }
        });
        if (reload) exploder.refresh();   // new groups: recompute explode directions
        materialManager.pruneUnused();
        // ground = lowest vertex. Not bbox.min.y: the boxes of rotated meshes (glTF nodes, rotated STEP
        // instances) are rotated local boxes, i.e. larger than the mesh – a glTF car floated 127 mm.
        // Centre and size stay with bbox (scene states/camera positions relate to them).
        environment.groundY = lowestPoint(meshList, bbox.min.y) - center.y;
        // floor, dome, ground shadow, light shadows, section: sized for all models
        updateSceneExtent();

        if (!reload && streamFit.active) {
            const centered = bbox.clone().translate(center.clone().negate());
            // nothing streamed (glTF/FBX, very small model) -> default view directly
            fitCamera(centered, first ? { animate: false, direction: DEFAULT_VIEW } : {});
        }
        streamFit.active = false;
        loadRender.active = false;

        // before the Scene Graph: its model row shows ⚠ for missing textures
        model.missingTextures = missing || [];
        primaryContent = { name: model.name.replace(/\.[^.]+$/, ''), importNodes: nodes, groups: nodeGroups, partCounts, root };
        refreshSceneGraph();
        finishProgress();
        loadedQuality = settings.meshQuality;
        appliedPartQuality = { ...settings.partQuality };
        if (reducedQuality) {
            const q = reducedQuality;
            flashStatus(t('status.qualityReduced', { triangles: formatCount(q.triangles), from: t(`tessellation.quality.${q.from}`), to: t(`tessellation.quality.${q.to}`) }), 8000);
        }
        assetsWindow.refresh();
        if (missing?.length) showStatus(t('status.missingTextures', { files: missing.slice(0, 3).map(u => u.split(/[\\/]/).pop()).join(', ') +
            (missing.length > 3 ? ` (+${missing.length - 3})` : '') }));
        updatePathTracingScene();

        setupGUI();
        qualityController.enable(model.type === 'step');
        await releaseLargeStep();
    } catch (err) {
        hideProgress();
        streamFit.active = false;
        loadRender.active = false;
        // aborted (new model dropped): clean up silently, the new one loads right away
        if (err.name === 'AbortError') debugLog('[Load] aborted:', model.name);
        else if (err instanceof MissingFilesError || model.incomplete) registerIncomplete(model, err, mainSceneIndex);
        else if (err instanceof ImportLimitError) showLimitError(err, reload ? 'reload' : 'open');
        else { console.error(err); showStatus(t('status.error', { message: err.message })); }
        // discard the half-built model; on re-tessellation the old one stays
        if (root === rootGroup) clearModel(); else disposeRoot(root);
        // materials of the previous model (replaced) must not stay behind – a relinked model would otherwise
        // take over their settings
        if (!reload) materialManager.pruneUnused();
        if (rootGroup) updatePathTracingScene();
        else { primaryContent = null; refreshSceneGraph(); }
    }
}
const DEFAULT_VIEW = new THREE.Vector3(1, 0.6, 1).normalize();

// --- Gaussian splats (PLY / SOG, splat/) ---
async function loadSplatScene() {
    const root = new THREE.Group();
    let buildError = null;   // building in onBegin failed (e.g. too many splats) – shown instead of "aborted"
    try {
        hideStatus();
        stopAnimation();
        invalidatePathTracing();
        sceneGraph.select(null);
        clearModel();
        history.clear();
        exploder.reset();
        materialManager.pruneUnused();
        model.size ??= model.main?.size ?? null;   // matching of scene states
        showProgress(t('status.loadingSplats'), 0);
        const maxBinding = renderer.backend?.device?.limits?.maxStorageBufferBindingSize;
        const name = model.name.replace(/\.[^.]+$/, '');
        // Built as soon as the first splats are read (shared buffers, `begin`) – the scene appears while
        // loading, the reveal circle grows with the progress. Without SharedArrayBuffer only at the end.
        let splat = null;
        const center = new THREE.Vector3();
        const build = data => {
            if (maxBinding && data.count * 16 > maxBinding) throw new Error(t('status.splatsTooMany', { count: formatCount(data.count) }));
            splat = new SplatMesh(data, { onSorted: () => { loadRender.force = true; } });
            splat.name = name;
            splat.scale.setScalar(SPLATS.unitScale);
            splat.rotation.x = Math.PI;   // y down → y up
            splat.updateMatrix();
            const group = new THREE.Group();
            group.name = name;
            group.add(splat);
            root.add(group);
            root.userData.modelRoot = true;
            rootGroup = root;
            slicer.group.add(root);
            splatMesh = splat;
            // centre on the robust bounds (far floaters ignored)
            const bbox = splat.geometry.boundingBox.clone().applyMatrix4(splat.matrix);
            bbox.getCenter(center);
            root.position.copy(center).negate();
            root.updateMatrixWorld(true);
            root.userData.centerOffset = root.position.clone();
            root.userData.unmovedBox = bbox.clone().translate(root.position);
            environment.groundY = bbox.min.y + root.position.y;
            updateSceneExtent();
            currentMeshes = [];   // no material slots
            currentNodeGroups = [group];
            currentPlan = null;
            solidQualityUsed = [];
            fitCamera(bbox.clone().translate(root.position), { animate: false, direction: DEFAULT_VIEW });
            streamFit.active = true;   // refit to the final bounds unless the user moves the camera meanwhile
            if (renderer.toneMapping !== THREE.NoToneMapping) {
                toneMappingBeforeSplats = renderer.toneMapping;
                renderer.toneMapping = THREE.NoToneMapping;
            }
            setViewMode(viewMode);   // HQ → Default, HQ button disabled
            model.missingTextures = [];
            primaryContent = { name, importNodes: [{ name, parent: -1 }], groups: [group], partCounts: [1], root };
            applySplatUi();   // includes refreshSceneGraph
        };
        const data = await loadSplats(model, {
            signal: loadAbort?.signal, onProgress: f => showProgress(t('status.loadingSplats'), f),
            onBegin: d => { try { build(d); } catch (err) { buildError = err; loadAbort?.abort(); } },
            onLoaded: (count, sh) => splat?.setLoaded(count, sh),
            maxShDegree: SPLATS.shDegree, shBudget: SPLATS.shBudgetMB * 2 ** 20, maxBinding, shared: true,
        });
        if (!data.count) throw new Error(t('status.noSplats'));
        if (!splat) build(data);
        splat.finish(data);
        // final bounds: centre again on the robust box – the camera moves along, nothing jumps
        const bbox = splat.geometry.boundingBox.clone().applyMatrix4(splat.matrix);
        const delta = bbox.getCenter(new THREE.Vector3()).sub(center);
        root.position.sub(delta);
        root.updateMatrixWorld(true);
        camera.position.sub(delta);
        controls.target.sub(delta);
        if (flight) { flight.fromPos.sub(delta); flight.fromTarget.sub(delta); flight.toPos.sub(delta); flight.toTarget.sub(delta); }
        controls.update();
        root.userData.centerOffset = root.position.clone();
        root.userData.unmovedBox = bbox.clone().translate(root.position);
        environment.groundY = bbox.min.y + root.position.y;
        updateSceneExtent();
        // camera: inside a room → on the free spot in it, otherwise fit (bounds were an estimate while
        // loading) – only if the user did not take the camera meanwhile; then circle slowly
        const room = streamFit.active ? analyzeSplatScene(splat) : null;
        if (room?.indoor) {
            const lookAt = room.eye.clone().addScaledVector(room.direction, Math.max(room.clearance * 0.3, room.size * 0.002));
            if (viewAngle(camera) < 70) setViewAngle(camera, 70);   // inside a room: wider view
            camera.near = room.size * 0.0002;
            camera.far = room.size * 20;
            camera.updateProjectionMatrix();
            cancelFlight();
            flight = { t0: performance.now(), duration: 1200, quiet: true, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toPos: room.eye, toTarget: lookAt };
        } else if (room) fitCamera(root.userData.unmovedBox);
        if (room) debugLog(`[Splats] camera ${room.indoor ? 'inside (room)' : splat.data.unbounded ? 'around the core (outdoor capture)' : 'outside (object)'}`);
        const period = room && SPLATS.autoRotate?.[room.indoor ? 'indoor' : 'object'];
        if (period > 0) Object.assign(splatSpin, { active: true, period, last: 0 });
        streamFit.active = false;
        hideProgress();
        setupGUI();
        qualityController.enable(false);
        assetsWindow.refresh();
        debugLog(`[Splats] ${model.name}: ${data.count} splats (${data.format}), SH coefficients ${data.shCoeffs}/${data.fileShCoeffs}`);
        flashStatus(t('status.splatsLoaded', { count: formatCount(data.count) }), 3000);
    } catch (err) {
        streamFit.active = false;
        hideProgress();
        if (buildError) err = buildError;
        if (err.name === 'AbortError') debugLog('[Load] aborted:', model.name);
        else { console.error(err); showStatus(t('status.error', { message: err.message })); }
        if (root === rootGroup) clearModel(); else disposeRoot(root);
        if (!rootGroup) { primaryContent = null; refreshSceneGraph(); setViewMode(viewMode); }
    }
}

// --- GUI (set up once) ---
let qualityController = null;
function setupGUI() {
    if (qualityController) return;
    const pt = setup.addSection('pathtracing', t('setup.pathtracing'));
    pt.toggle(pathTracing.supported ? t('setup.active') : t('setup.activeNoWebGpu'),
        () => pathTracing.enabled, v => setViewMode(v ? 'hq' : viewMode === 'hq' ? 'default' : viewMode))
        .enable(pathTracing.supported);
    if (pathTracing.supported) {
        pt.range(t('setup.bounces'), () => pathTracing.bounces, v => pathTracing.setBounces(v), 1, 20, 1);
        pt.range(t('setup.resolution'), () => pathTracing.renderScale, v => { pathTracing.renderScale = v; }, 0.25, 1, 0.05);
        pt.range(t('setup.maxSamples'), () => pathTracing.maxSamples, v => { pathTracing.maxSamples = v; }, 1, 256, 1);
        pt.range(t('setup.glossyFilter'), () => pathTracing.filterGlossyFactor, v => { pathTracing.filterGlossyFactor = v; }, 0, 1, 0.01);
        pt.toggle(t('setup.denoise'), () => pathTracing.denoiseEnabled, v => pathTracing.setDenoise(v));
        pt.toggle(t('setup.upscale'), () => pathTracing.upscaleEnabled, v => pathTracing.setUpscale(v));
        pt.range(t('setup.fsrSharpness'), () => pathTracing.sharpness, v => { pathTracing.sharpness = v; }, 0, 2, 0.01);
        // ?bench: benchmark of different path tracer variants (samples/s on the real GPU)
        if (new URLSearchParams(location.search).has('bench')) {
            const benchButton = pt.button(t('viewer.benchmark.start'), async () => {
                if (!pathTracing.ready) { showStatus(t('viewer.benchmark.needsModel')); return; }
                benchButton.enable(false);
                controls.enabled = false;
                try {
                    showBenchmarkResult(await runBenchmark(pathTracing, { renderer, onProgress: showProgress }));
                    hideProgress();
                } catch (err) {
                    console.error(err);
                    hideProgress();
                    showStatus(t('viewer.benchmark.error', { message: err.message }));
                } finally {
                    controls.enabled = true;
                    benchButton.enable(true);
                }
            });
        }

        // keep path tracing at reduced quality while orbiting/zooming (otherwise raster preview)
        const motion = setup.addSection('motion', t('setup.motion'));
        motion.toggle(t('setup.motionEnabled'), () => pathTracing.motion.enabled, v => { pathTracing.motion.enabled = v; });
        motion.range(t('setup.resolution'), () => pathTracing.motion.renderScale, v => { pathTracing.motion.renderScale = v; }, 0.1, 1, 0.05);
        motion.range(t('setup.bounces'), () => pathTracing.motion.bounces, v => { pathTracing.motion.bounces = v; }, 1, 8, 1);
        motion.range(t('setup.samplesPerFrame'), () => pathTracing.motion.samples, v => { pathTracing.motion.samples = v; }, 1, 4, 1);
        // Kuwahara (kuwahara.js): paints over the noise while orbiting and while the image refines (look: config.js)
        motion.toggle(t('setup.kuwahara'), () => pathTracing.motion.kuwahara, v => { pathTracing.motion.kuwahara = v; pathTracing.reset(); });
    }

    // changing the quality -> re-tessellate automatically, path tracing restarts afterwards
    // (STEP only – glTF/FBX bring their own triangles)
    const tess = setup.addSection('tessellation', t('setup.tessellation'));
    qualityController = tess.select(t('setup.quality'), Object.keys(TESS_PRESETS).map(q => ({ label: t(`tessellation.quality.${q}`), value: q })),
        () => settings.meshQuality, q => { settings.meshQuality = q; reloadModel(); });

    // AI rendering: own Gemini API key (localStorage, shown masked), model, resolution
    const ki = setup.addSection('ki', t('setup.ki.title'));
    const keyField = ki.text(t('setup.ki.apiKey'), () => kiSettings.apiKey, v => { kiSettings.apiKey = v; removeKey.enable(!!v); },
        { placeholder: t('setup.ki.apiKeyPlaceholder'), mask: () => kiSettings.masked });
    const removeKey = ki.button(t('setup.ki.removeKey'), () => { kiSettings.apiKey = ''; keyField.refresh(); removeKey.enable(false); });
    removeKey.enable(!!kiSettings.apiKey);
    ki.text(t('setup.ki.model'), () => kiSettings.model, v => { kiSettings.model = v || KI.model; }, { placeholder: KI.model });
    ki.select(t('setup.ki.size'), KI.sizes.map(v => ({ label: v, value: v })), () => kiSettings.size, v => { kiSettings.size = v; });
    const note = document.createElement('div');
    note.className = 'mt-2 text-white/40';
    note.textContent = t('setup.ki.hint') + ' ';
    const link = document.createElement('a');
    Object.assign(link, { href: KI.keyUrl, target: '_blank', rel: 'noopener', textContent: t('setup.ki.getKey') });
    link.className = 'text-sky-300 hover:underline';
    note.append(link);
    ki.append(note);

    // BIM: author of BCF issues/comments
    const bim = setup.addSection('bim', t('setup.bim.title'));
    bim.text(t('setup.bim.author'), () => bcfAuthor.get(), v => bcfAuthor.set(v.trim()), { placeholder: t('setup.bim.authorPlaceholder') });
    const bimNote = document.createElement('div');
    bimNote.className = 'mt-2 text-white/40';
    bimNote.textContent = t('setup.bim.authorHint');
    bim.append(bimNote);

    setup.addSection('about', t('about.title')).append(buildAbout());

    // save/load scene and undo/redo live in the bar at the bottom
}

// Load/re-tessellate one after another: if an operation is already running, restart exactly once
// afterwards (fresh load for a new model, otherwise re-tessellation)
let loading = null;
let pending = null;   // null | 'parts' | 'reload' | 'open' (the more comprehensive request wins)
let loadLoop = null;  // promise until everything requested is loaded
const LOAD_RANK = { parts: 1, reload: 2, open: 3 };
const addQueue = [];   // additional models waiting to be loaded (addModel)
function runLoad(kind) {
    if (kind && (!pending || LOAD_RANK[kind] > LOAD_RANK[pending])) pending = kind;
    if (loading) return loadLoop;
    loadLoop = (async () => {
        while (pending || addQueue.length) {
            if (!pending) {
                // additional model (only when no main load is waiting)
                loadAbort = new AbortController();
                const item = addQueue.shift();
                loading = loadExtraModel(item.source, item.options);
                await loading;
                loading = null;
                loadAbort = null;
                updatePathTracingScene();   // blocked while loading (see there)
                continue;
            }
            const next = pending;
            pending = null;
            // take over the new model only now – a running load reads `model` until it finishes
            if (next === 'open' && nextModel) { model = nextModel; nextModel = null; }
            if (!model || (next !== 'open' && model.type !== 'step')) continue;
            loadAbort = new AbortController();
            loading = next === 'parts' ? retessellateParts() : loadModel(next === 'reload');
            await loading;
            loading = null;
            loadAbort = null;
            updatePathTracingScene();   // blocked while loading (see there)
        }
        // scene state waiting for a model (scene dropped without a model)
        if (pendingState && matchesModel(pendingState, model) && rootGroup) {
            const state = pendingState;
            pendingState = null;
            await restoreScene(state);
        }
    })();
    return loadLoop;
}
const reloadModel = () => runLoad('reload');

// --- Additional models (load a second model next to the first one, e.g. to compare) ---
// Static: no re-tessellation/part quality, not part of the scene state. Placed to the right of everything
// loaded so far, standing on the same ground. Removing via the quad menu; a new main model removes them.
// options: { sceneIndex, placement } when opened from a scene file
function addModel(source, options = {}) {
    if (!rootGroup && !loading) return openModel(source);   // nothing loaded yet: becomes the main model
    // Gaussian splats are never combined with other models: they replace the scene / are replaced
    if (source.type === 'splat' || (splatMesh && !loading)) return openModel(source);
    addQueue.push({ source, options });
    return runLoad(null);
}
async function loadExtraModel(source, { sceneIndex, placement: savedPlacement } = {}) {
    const id = ++extraSeq, prefix = `x${id}:`;
    // unique name in the Scene Graph: the same file twice → "name (2)", "name (3)" …
    const base = source.name.replace(/\.[^.]+$/, '');
    const taken = new Set([primaryContent?.name, ...extraModels.map(x => x.name)]);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
    const root = new THREE.Group();
    root.name = name;
    root.userData.modelRoot = true;   // explosion per model
    try {
        stopAnimation();   // live puppet out of the scene (placement, material counts)
        showProgress(t('status.loadingFile'));
        const signal = loadAbort?.signal;
        let result, plan = null;
        if (source.type === 'step') {
            const content = source.file ? await readStepFile(source.file, signal) : await fetchStepFile(source.url, signal);
            result = await tessellateStep(content, settings.meshQuality, showProgress, {
                bvh: pathTracing.supported, instancing: IMPORT.instancing, onPlan: p => { plan = p; }, limits: { auto: true, ...IMPORT_LIMITS },
            });
        } else {
            if (!source.main) {
                const res = await fetch(source.url, { signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                source.main = await res.blob();
            }
            result = await importMeshFile(source, { renderer, materialManager, onStatus: showProgress, bvh: pathTracing.supported });
        }
        const { geometries, meshes, nodes } = result;
        const groups = nodes.map(n => { const g = new THREE.Group(); g.name = n.name; if (n.ifc) g.userData.ifc = n.ifc; return g; });
        root.userData.bim = result.bim || null;   // IFC: property lookups (worker stays open)
        root.userData.ifcOrigin = result.bim?.origin || null;
        nodes.forEach((n, i) => (n.parent >= 0 ? groups[n.parent] : root).add(groups[i]));
        const threeGeometries = [], meshList = [], partCounts = new Array(nodes.length).fill(0), counted = new Set();
        const bbox = new THREE.Box3(), box = new THREE.Box3();
        for (const m of meshes) {
            const geometry = threeGeometries[m.geometry] ??= makeGeometry(geometries[m.geometry]);
            const entry = m.materialId ? materialManager.get(m.materialId) : materialManager.forStepColor(m.color);
            const mesh = new THREE.Mesh(geometry, entry.material);
            mesh.userData.key = prefix + m.key;
            mesh.userData.defaultMaterialId = entry.def.id;
            mesh.userData.extra = id;
            if (plan) mesh.userData.closedSolid = !plan.solids[plan.instances[m.instance]?.solid]?.surface;
            mesh.matrixAutoUpdate = false;
            mesh.matrix.fromArray(m.matrix);
            mesh.castShadow = mesh.receiveShadow = true;
            if (m.name) mesh.name = m.name;
            (groups[m.node] || root).add(mesh);
            bbox.union(box.copy(geometry.boundingBox).applyMatrix4(mesh.matrix));
            meshList.push(mesh);
            if (m.node >= 0 && !counted.has(m.countId ?? m.instance)) { counted.add(m.countId ?? m.instance); partCounts[m.node]++; }
            startFade(mesh);
        }
        if (bbox.isEmpty()) throw new Error(t('status.noFaces'));
        if (result.animation) addAnimation(new ModelAnimation(result.animation, meshList, root), id);
        // the model itself is centred on its own bounding box like the main model (as if loaded alone – its
        // zero point and position fields stay untouched); a placement group around it puts it to the right of
        // the existing models (as seen from the camera) on the ground – computed from their unmoved
        // layout, so later moves of other models do not shift it
        root.position.copy(bbox.getCenter(new THREE.Vector3())).negate();
        root.userData.centerOffset = root.position.clone();
        const centred = bbox.clone().translate(root.position);
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0);
        if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
        right.normalize();
        const along = (box, dir) => {   // min/max of a box along a horizontal direction
            const d = [box.min.x, box.max.x].flatMap(x => [box.min.z, box.max.z].map(z => x * dir.x + z * dir.z));
            return [Math.min(...d), Math.max(...d)];
        };
        const placed = [rootGroup?.userData.unmovedBox, ...extraModels.map(x => x.unmovedBox)].filter(Boolean);
        const placement = new THREE.Vector3();
        if (placed.length) {
            const [, oldMax] = placed.map(b => along(b, right)).reduce((a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1])]);
            const [newMin, newMax] = along(centred, right);
            const gap = Math.max(...placed.map(b => { const [lo, hi] = along(b, right); return hi - lo; }), newMax - newMin) * 0.15;
            placement.copy(right).multiplyScalar(oldMax + gap - newMin);
        }
        placement.y = environment.groundY - (lowestPoint(meshList, bbox.min.y) + root.position.y);   // on the ground
        // IFC next to IFC: several files of one project (architecture, structure, MEP) share their coordinates →
        // placed exactly where they belong relative to the first IFC model instead of beside it
        const ref = root.userData.ifcOrigin && ifcReference();
        if (ref) placement.copy(ref.position).add(new THREE.Vector3(...ref.origin).sub(new THREE.Vector3(...root.userData.ifcOrigin)).multiplyScalar(1000)).sub(root.position);
        if (savedPlacement) placement.fromArray(savedPlacement);   // from the scene file
        const holder = new THREE.Group();
        holder.name = 'Placement';
        holder.position.copy(placement);
        holder.add(root);
        const unmovedBox = centred.clone().translate(placement);
        slicer.group.add(holder);
        holder.updateMatrixWorld(true);
        const size = source.file?.size ?? source.main?.size ?? null;
        extraModels.push({ id, name, source, size, sceneIndex, missingTextures: result.missing || [], root, holder, unmovedBox, meshes: meshList, nodeGroups: groups,
            content: { name, importNodes: nodes, groups, partCounts, root, id, warn: (result.missing || []).length } });
        updateSceneExtent();   // floor/dome/shadows for all models
        refreshSceneGraph();
        exploder.refresh();   // exploded: the new model explodes too
        invalidatePathTracing();
        updatePathTracingScene();
        contactShadow.markDirty();
        frameObject(slicer.group);
        finishProgress();
        flashStatus(t('status.modelAdded', { name }), 3000);
    } catch (err) {
        hideProgress();
        disposeRoot(root);
        if (err.name === 'AbortError') return;
        if (err instanceof MissingFilesError || source.incomplete) { registerIncomplete(source, err, sceneIndex); return; }
        console.error(err);
        showStatus(err instanceof ImportLimitError ? t('status.modelTooLarge', { triangles: formatCount(err.triangles), limit: formatCount(err.limit), quality: t(`tessellation.quality.${err.quality}`) })
            : t('status.error', { message: err.message }));
    }
}
// first loaded IFC model (main model first): its root position (in the models' space) + its shift to the origin
function ifcReference() {
    if (rootGroup?.userData.ifcOrigin) return { root: rootGroup, position: rootGroup.position.clone(), origin: rootGroup.userData.ifcOrigin };
    const x = extraModels.find(m => m.root.userData.ifcOrigin);
    return x ? { root: x.root, position: x.holder.position.clone().add(x.root.position), origin: x.root.userData.ifcOrigin } : null;
}
/** Remove one additional model (id) or all (no id) */
function removeExtraModels(id) {
    const remove = extraModels.filter(x => id === undefined || x.id === id);
    if (!remove.length) return;
    for (const x of remove) {
        removeAnimations(x.id);
        disposeRoot(x.root);
        x.holder?.removeFromParent();
        extraModels.splice(extraModels.indexOf(x), 1);
    }
    if (id === undefined) return;   // part of clearing the whole model
    updateSceneExtent();
    // undo steps refer to meshes by index – after removing they would hit the wrong ones
    history.clear();
    if (selection && extraOf(selection) === id) sceneGraph.select(null);
    refreshSceneGraph();
    exploder.refresh();
    invalidatePathTracing();
    updatePathTracingScene();
    contactShadow.markDirty();
}
/**
 * Remove the main model. Additional models: the first one becomes the new main model, the others are
 * added again – reloaded from their files (their changes in the viewer are lost).
 */
function removeMainModel() {
    const rest = extraModels.map(x => x.source);
    if (!rest.length) {
        sceneGraph.select(null);
        clearModel();
        model = null;
        primaryContent = null;
        history.clear();
        refreshSceneGraph();
        updatePathTracingScene();
        showDropHint();   // empty again: the drop hint returns
        return;
    }
    openModel(rest[0]);
    rest.slice(1).forEach(src => addModel(src));
}
// additional model of a Scene Graph entry (undefined = main model / not a model entry)
function extraOf(entry) {
    if (entry?.kind === 'selection') entry = sceneGraph.selected;
    for (let e = entry; e; e = e.parent) if (e.extra !== undefined) return e.extra;
    if (entry?.kind === 'surface') return entry.object?.userData.extra;
    return undefined;
}

/**
 * Open a new model (replaces the current one). A running import is aborted
 * (file reading via AbortSignal, STEP workers terminated) – the new model loads right after.
 */
let nextModel = null;
let loadAbort = null;   // AbortController of the running load
function openModel(next) {
    nextModel = next;
    if (loading) {
        loadAbort?.abort();
        abortStepImport();
    }
    return runLoad('open');
}

// --- Save / restore scene state (scene-state.js) ---
let pendingState = null;   // state whose model is not loaded yet
const sceneStateContext = {
    get model() { return model; },
    stopCameraMotion: () => { cancelFlight(); streamFit.active = false; },
    setModelMorphs,
    setModelAnimation,
    scene, camera, controls, renderer, environment, lightsGroup, pathTracing, slicer, sceneGraph, materialManager, settings, dof, lens, toneMappings: TONE_MAPPINGS,
    lights: () => lightsGroup.children.filter(l => l.isLight),
    meshes: () => currentMeshes,
    nodeGroups: () => currentNodeGroups,
    root: () => rootGroup,
    rootCenterOffset: () => rootGroup?.userData.centerOffset || new THREE.Vector3(),
    ensureTransform, applyTransform, refreshSceneGraph: () => refreshSceneGraph(),
    runtimeModels: () => runtimeModels(),
    missingModels: () => missingModels,
    // saved camera views (scene state)
    getCameraViews: () => cameraViews.map(({ entry, ...v }) => v),
    setCameraViews: list => {
        cameraViewSeq = Math.max(0, ...list.map(v => v.id || 0));
        setCameraViews(list.map(v => ({ ...v, id: v.id || ++cameraViewSeq })));
    },
    retessellate: async () => { qualityController.refresh(); await runLoad('reload'); },
    retessellateParts: () => runLoad('parts'),
    getViewMode: () => viewMode,
    exploder,
    setViewMode: mode => setViewMode(mode),
    onLightMoved: light => LIGHT_DIRECTIONS.set(light, light.position.clone().normalize()),
    setSlicerEnabled: v => { slicer.enabled = v; pathTracing.setSuspended(v); updateSlicerHelper(); },
    afterRestore: () => {
        // HDRI editor: show the restored description of the edited HDRI, close it if that one is gone
        if (hdriEditor.isOpen) {
            const doc = environment.custom.get(hdriEditor.docId);
            if (doc) hdriEditor.setDoc(doc); else hdriEditor.close();
        }
        setup.refresh();
        pathTracing.updateTransforms();
        pathTracing.updateLights();
        pathTracing.updateCamera();
        sceneGraph.render();
        properties.show(selection);
        materialPanel.setSelection(isModelEntry(selection) ? selection.object : null);
        updateHighlight();
    },
};

// "Save as": the browser's save dialog (File System Access API – Chrome/Edge) with the name of the last
// opened/saved scene file as suggestion; other browsers (Firefox, Safari) download the file as before.
let sceneFileName = null;   // last opened/saved scene file (suggestion in the dialog)
async function saveScene() {
    // BIM (IFC loaded or issues open): one .bcfzip with the issues and the scene
    if (bimActive()) {
        const { format } = await loadBcf();
        try { await saveBcf(bcfPanel.doc ?? { version: '2.1', project: null, topics: [], name: null }, format); } catch (err) { if (err?.name !== 'AbortError') console.error(err); }
        return;
    }
    if ((!model || !rootGroup) && !missingModels.length) { showStatus(t('status.loadModelFirst')); return; }
    const state = captureState(sceneStateContext);
    const json = JSON.stringify(state, null, 1);
    const firstName = state.models[0]?.file?.name || model?.name || 'scene';
    const suggested = sceneFileName || firstName.replace(/\.[^.]+$/, '') + '.scene.json';
    if (window.showSaveFilePicker) {
        let handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: suggested,
                types: [{ description: t('viewer.sceneFileType'), accept: { 'application/json': ['.json'] } }],
            });
        } catch (err) {
            if (err.name === 'AbortError') return;   // dialog cancelled
            console.warn('[Scene] save dialog not available, downloading instead:', err);
        }
        if (handle) {
            try {
                const writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
                sceneFileName = handle.name;
                flashStatus(t('status.sceneSaved', { name: handle.name }), 3000);
            } catch (err) {
                console.error(err);
                showStatus(t('status.sceneSaveError', { message: err.message }));
            }
            return;
        }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = suggested;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function restoreScene(state, { force = false } = {}) {
    try {
        if (loading) await loadLoop;
        if (!force && (!matchesModel(state, model) || !rootGroup)) {
            pendingState = state;
            showStatus(t('status.sceneBelongsTo', { name: state.model?.name }));
            return;
        }
        showProgress(t('status.restoringScene'));
        const warnings = await applyState(sceneStateContext, state);
        history.clear();   // scene completely replaced
        hideProgress();
        if (warnings.length) { console.warn('[Scene]', warnings); showStatus(warnings.join(' · ')); }
        else hideStatus();
    } catch (err) {
        console.error(err);
        hideProgress();
        showStatus(t('status.sceneError', { message: err.message }));
    }
}

// JSON file (scene or materials) from drop/file picker
async function openJsonFile(file) {
    let json;
    try { json = JSON.parse(await file.text()); }
    catch { showStatus(t('status.invalidJson', { name: file.name })); return null; }
    if (json?.format === SCENE_FORMAT) { sceneFileName = file.name; return json; }   // suggestion for "save as"
    if (json?.format === 'step-viewer-materials') {
        const entries = materialManager.fromJSON(json);
        if (entries[0]) materialPanel.open(entries[0].def.id, 'scene');
        return null;
    }
    showStatus(t('status.notSceneOrMaterials', { name: file.name }));
    return null;
}

// --- Open files via drag & drop into the window ---
const STEP_EXTENSIONS = ['stp', 'step'];
const MAIN_EXTENSIONS = [...STEP_EXTENSIONS, ...MESH_EXTENSIONS, ...SPLAT_EXTENSIONS];
const extOf = name => name.split('.').pop().toLowerCase();

// Several model files at once: one model per main file (STEP/glTF/GLB/FBX); textures/.bin go with every
// glTF/FBX (resolved by path/name). Sorted by name.
function modelsFromFiles(files) {
    const mains = files.filter(f => MAIN_EXTENSIONS.includes(extOf(f.path))).sort((a, b) => a.path.localeCompare(b.path));
    const rest = files.filter(f => !MAIN_EXTENSIONS.includes(extOf(f.path)));
    return mains.map(main => modelFromFiles([main, ...rest])).filter(Boolean);
}
function modelFromFiles(files) {
    // main file: STEP before glTF/GLB before FBX; the rest (textures, .bin) is passed along
    const main = MAIN_EXTENSIONS.map(ext => files.find(f => extOf(f.path) === ext)).find(Boolean);
    if (!main) return null;
    const name = main.path.split('/').pop();
    if (STEP_EXTENSIONS.includes(extOf(name))) return { name, type: 'step', url: null, content: null, file: main.file };
    if (SPLAT_EXTENSIONS.includes(extOf(name))) return { name, type: 'splat', main: main.file, files: [] };
    // paths relative to the main file's folder (glTF references .bin/textures relatively)
    const dir = main.path.includes('/') ? main.path.slice(0, main.path.lastIndexOf('/') + 1) : '';
    return {
        name, type: 'mesh', main: main.file,
        files: files.filter(f => f !== main).map(f => ({ path: f.path.startsWith(dir) ? f.path.slice(dir.length) : f.path, file: f.file })),
    };
}

// Collect dropped files + folders (recursively)
async function droppedFiles(dataTransfer) {
    const entries = [...dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...dataTransfer.files].map(file => ({ path: file.name, file }));
    const out = [];
    const walk = async (entry, prefix) => {
        if (entry.isFile) {
            const file = await new Promise((res, rej) => entry.file(res, rej));
            out.push({ path: prefix + file.name, file });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            for (;;) {
                const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                if (!batch.length) break;
                for (const e of batch) await walk(e, prefix + entry.name + '/');
            }
        }
    };
    for (const e of entries) await walk(e, '');
    return out;
}

const dropOverlay = document.getElementById('drop-overlay');
// While the drop area is shown, the status text behind it (e.g. the drop hint) is hidden – no two texts on
// top of each other. With a model loaded the area is split: left "replace models", right "add to the scene";
// the half under the pointer is highlighted and decides on drop (dropSide).
const dropZones = { replace: dropOverlay.querySelector('[data-drop-zone="replace"]'), add: dropOverlay.querySelector('[data-drop-zone="add"]') };
let dropSide = 'add';
// Gaussian splat scene loaded: only "replace" (one zone) – splats are never combined with other models
function setDropOverlay(visible, mode = rootGroup ? (splatMesh ? 'replace' : 'split') : 'single') {
    dropOverlay.hidden = !visible;
    loadingEl.style.visibility = visible ? 'hidden' : '';
    if (!visible) return;
    dropMode = mode;
    dropZones.add.hidden = mode !== 'split';
    dropOverlay.querySelector('[data-drop-single]').hidden = mode !== 'single';
    dropOverlay.querySelector('[data-drop-split]').hidden = mode !== 'split' && mode !== 'replace';
    dropOverlay.querySelector('[data-drop-splat]').hidden = mode !== 'replace';
    dropOverlay.querySelector('[data-drop-relink]').hidden = mode !== 'relink';
    if (mode !== 'split') highlightDropZone(mode === 'relink' || mode === 'replace' ? 'replace' : null);
}
let dropMode = 'single';
// Only pictures dragged (textures – no 3D data): with missing files of the scene they are linked (one zone
// "link missing files"), otherwise there is nothing to do (no drop plane). The browser tells the MIME types
// during the drag, not the names – folders/unknown types count as possibly 3D.
const isAssetDrag = e => {
    const items = [...(e.dataTransfer?.items || [])];
    return items.length > 0 && items.every(i => i.kind === 'file' && /^image\//.test(i.type));
};
const hasMissingAssets = () => assetRows().some(r => r.status === 'missing');
function highlightDropZone(side) {
    dropSide = side || 'add';
    for (const [key, zone] of Object.entries(dropZones)) {
        const active = side === key;
        zone.classList.toggle('bg-sky-500/25', active);
        zone.classList.toggle('border-solid', active);
        zone.classList.toggle('bg-black/55', !active);
        zone.classList.toggle('border-dashed', !active);
    }
}
// Only real files from outside the page (Explorer/Finder/file manager: 'Files' without 'text/html').
// Images/links dragged within the page also report 'Files' but carry 'text/html'; material drags carry
// MATERIAL_MIME. Stateless on purpose: a dragstart/dragend flag got stuck when the dragged element was
// removed during the drag (material panel re-renders on assignment -> dragend never reached the
// document -> every later file drop was ignored and the browser opened the file itself).
const isFileDrag = e => {
    const types = e.dataTransfer?.types;
    return !!types && types.includes('Files') && !types.includes('text/html') && !types.includes(MATERIAL_MIME);
};
let dragDepth = 0;
window.addEventListener('dragenter', e => {
    if (!isFileDrag(e)) return;
    dragDepth++;
    // asset window open: it is the drop target (relink) – no replace/add plane behind it
    if (assetsWindow.isOpen) assetsWindow.setDragActive(true);
    else if (isAssetDrag(e)) { if (hasMissingAssets()) setDropOverlay(true, 'relink'); }
    else setDropOverlay(true);
});
window.addEventListener('dragleave', e => {
    if (!isFileDrag(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; setDropOverlay(false); assetsWindow.setDragActive(false); }
});
// anything carrying files that we do not accept: still prevent the browser from opening it itself
// (navigating away from the viewer) – the drop is simply ignored
const hasFiles = e => !!e.dataTransfer?.types.includes('Files');
window.addEventListener('dragover', e => {
    if (!isFileDrag(e)) {
        if (hasFiles(e) && !isMaterialDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; }
        return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (isAssetDrag(e) && !hasMissingAssets() && !assetsWindow.isOpen) { e.dataTransfer.dropEffect = 'none'; return; }
    if (rootGroup && !assetsWindow.isOpen && dropMode === 'split') highlightDropZone(e.clientX < window.innerWidth / 2 ? 'replace' : 'add');
});
window.addEventListener('drop', async e => {
    if (!isFileDrag(e)) {
        if (hasFiles(e) && !isMaterialDrag(e)) e.preventDefault();
        return;
    }
    e.preventDefault();
    dragDepth = 0;
    const side = rootGroup ? (e.clientX < window.innerWidth / 2 ? 'replace' : 'add') : 'add';
    setDropOverlay(false);
    const relink = assetsWindow.isOpen;
    assetsWindow.setDragActive(false);
    let files = await droppedFiles(e.dataTransfer);
    // BCF issues (.bcfzip): into the issue window; models dropped along with them load as usual
    // (with RINDR's scene or IFC names in the headers it opens like a scene – the other files serve as its assets)
    const bcfFile = files.find(f => BCF_EXTENSIONS.includes(extOf(f.path)));
    if (bcfFile) {
        files = files.filter(f => f !== bcfFile);
        if (await openBcfFile(bcfFile.file, files) || !files.length) return;
    }
    if (relink) { relinkFiles(files); return; }
    // scene/material files (.json) – with or without a model
    const jsonFile = files.find(f => extOf(f.path) === 'json' && !/\.gltf$/i.test(f.path));
    const state = jsonFile ? await openJsonFile(jsonFile.file) : null;
    const models = modelsFromFiles(files.filter(f => f !== jsonFile));
    if (jsonFile && !models.length) {
        if (state) { closeBcf(); openSceneFile(state); }
        return;
    }
    if (!models.length && assetRows().some(r => r.status === 'missing')) {
        relinkFiles(files);
        return;
    }
    if (!models.length) {
        const exts = [...new Set(files.map(f => '.' + extOf(f.path)))].join(', ');
        showStatus(t('status.unsupportedFormat', { extensions: exts }));
        return;
    }
    // with a scene file: the scene is opened, the dropped files serve as its assets
    if (state) {
        closeBcf();
        openSceneFile(state, files.filter(f => f !== jsonFile));
        return;
    }
    // Gaussian splats (.sog, .ply with splat properties) are always alone: the first one replaces the scene,
    // further models of the drop are ignored; a loaded splat scene is replaced by whatever is dropped
    const typed = await Promise.all(models.map(classifyModel));
    const splat = typed.find(m => m.type === 'splat');
    if (splat || splatMesh) {
        closeBcf();   // splats always replace the whole scene
        missingModels = []; missingHdri = null; openedScene = null; sceneChunks = [];
        if (splat) {
            if (typed.length > 1) flashStatus(t('status.splatsAlone'), 6000);
            openModel(splat);
        } else {
            openModel(typed[0]);
            typed.slice(1).forEach(m => addModel(m));
        }
        return;
    }
    models.splice(0, models.length, ...typed);
    if (side === 'replace' || !rootGroup) { missingModels = []; missingHdri = null; openedScene = null; sceneChunks = []; }
    // left half "replace": everything loaded is removed, the first new model becomes the main model;
    // otherwise (right half, or nothing loaded) every model is added next to the existing ones
    if (rootGroup && side === 'replace') {
        closeBcf();
        openModel(models[0]);
        models.slice(1).forEach(m => addModel(m));
        return;
    }
    models.forEach(m => addModel(m));
});

// Start: empty scene or ?model=<file from public/models>
setupGUI();
setViewMode(viewMode);   // start mode (config: PATHTRACING.enabled -> HQ, otherwise Default)
qualityController.enable(false);
// fill the setup menu even without a model; open at start with ?debug
setupGUI();
if (new URLSearchParams(location.search).has('debug')) requestAnimationFrame(() => setSetupOpen(true));
if (MODEL_FILE) {
    openModel(sourceForUrl(MODEL_FILE, MODEL_URL));
} else {
    showDropHint();
}

// Debug access for automated tests + fps/memory/polygon display (only with ?debug in the URL)
if (new URLSearchParams(location.search).has('debug')) {
    globalThis.__viewer = { getSplats: () => splatMesh, flyToDirection, contours, openBcfFile, loadBcf, applyBcfViewpoint, captureBcfViewpoint, loadSplats, lens, contactShadow, animations, openSceneFile, pickHit, raycaster, exportFrame, brightestDirection, addModel, removeExtraModels, extraModels, graphApplier, highlighter, scene, camera, controls, renderer, pathTracing, setup, sceneGraph, getRootGroup: () => rootGroup, getSelection: () => selection, getHovered: () => hovered, transformer, slicer, ground, environment, materialManager, materialPanel, nodeEditor, history, undoRedo, dof, frameObject, openModel, getModel: () => model, isLoading: () => !!loading, captureState: () => captureState(sceneStateContext), restoreScene, whenLoaded: () => loadLoop };
}

// --- Resize ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    // the path tracer handles the render size itself, the projection (aspect ratio) only here
    pathTracing.updateCamera();
});

// --- Path tracing status display ---
const ptStatus = {
    root: document.getElementById('pt-status'),
    dot: document.getElementById('pt-status-dot'),
    label: document.getElementById('pt-status-label'),
    value: document.getElementById('pt-status-value'),
    bar: document.getElementById('pt-status-bar'),
    detail: document.getElementById('pt-status-detail'),
    last: '',
};
// label: i18n key, translated when the status is shown
const PT_PHASES = {
    unsupported:       { label: 'pathtracing.phases.unsupported',    color: 'bg-neutral-400' },
    waiting:           { label: 'pathtracing.phases.waiting',        color: 'bg-neutral-400' },
    bvh:               { label: 'pathtracing.phases.bvh',            color: 'bg-amber-400' },
    compiling:         { label: 'pathtracing.phases.compiling',      color: 'bg-amber-400' },
    preview:           { label: 'pathtracing.phases.preview',        color: 'bg-violet-400' },
    motion:            { label: 'pathtracing.phases.motion',         color: 'bg-violet-400' },
    error:             { label: 'pathtracing.phases.error',          color: 'bg-red-400' },
    suspended:         { label: 'pathtracing.phases.suspended',      color: 'bg-orange-400' },
    rendering:         { label: 'pathtracing.phases.rendering',      color: 'bg-sky-400' },
    'denoise-loading': { label: 'pathtracing.phases.denoiseLoading', color: 'bg-fuchsia-400' },
    denoising:         { label: 'pathtracing.phases.denoising',      color: 'bg-fuchsia-400' },
    done:              { label: 'pathtracing.phases.done',           color: 'bg-emerald-400' },
};
const STATIC_PHASES = new Set(['done', 'waiting', 'unsupported', 'error', 'suspended']);
const FULL_BAR_PHASES = new Set(['preview', 'motion', 'bvh', 'compiling', 'denoise-loading', 'suspended']);
function updatePathTracingStatus() {
    const s = prepare.shown ? { phase: 'bvh', progress: 0, samples: 0, maxSamples: 0 } : pathTracing.getStatus();
    const phase = PT_PHASES[s.phase];
    const pct = Math.floor(s.progress * 100);
    const samples = t('pathtracing.samples', { samples: Math.floor(s.samples), maxSamples: s.maxSamples });
    let value = '';
    let detail = '';
    switch (s.phase) {
        case 'unsupported':
            detail = t('pathtracing.detail.unsupported');
            break;
        case 'error':
            detail = s.error.includes('maximum storage buffer binding size') || s.error.includes('maxBufferSize')
                ? t('pathtracing.detail.bufferTooSmall')
                : t('pathtracing.detail.gpuError');
            break;
        case 'suspended':
            detail = t('pathtracing.detail.suspended');
            break;
        case 'preview':
            detail = t('pathtracing.detail.preview');
            break;
        case 'motion':
            detail = t('pathtracing.detail.motion');
            break;
        case 'rendering':
            value = t('pathtracing.percent', { value: pct });
            detail = s.denoise ? t('pathtracing.detail.renderingDenoise', { samples }) : samples;
            break;
        case 'denoise-loading':
            detail = t('pathtracing.detail.denoiseLoading');
            break;
        case 'denoising':
            value = t('pathtracing.percent', { value: pct });
            detail = samples;
            break;
        case 'done':
            value = t('pathtracing.percent', { value: 100 });
            detail = s.denoise ? t('pathtracing.detail.doneDenoised', { samples }) : samples;
            break;
    }
    const key = `${s.phase}|${value}|${detail}|${progressEl.hidden}`;
    if (key === ptStatus.last) return;
    ptStatus.last = key;
    // while loading, the progress display shows the state at the same place
    ptStatus.root.classList.toggle('hidden', !phase || !progressEl.hidden);
    if (!phase) return;
    ptStatus.label.textContent = t(phase.label);
    ptStatus.value.textContent = value;
    ptStatus.detail.textContent = detail;
    ptStatus.dot.className = `inline-block size-2 rounded-full ${phase.color}`
        + (STATIC_PHASES.has(s.phase) ? '' : ' animate-pulse');
    ptStatus.bar.className = `h-full rounded ${phase.color}`;
    ptStatus.bar.style.width = FULL_BAR_PHASES.has(s.phase) ? '100%' : `${s.progress * 100}%`;
}

// Units for the duplicate measurement (debug display): one per geometry, meshes sharing it count as instances
// (declared reuse in the file or instanced by the import)
function duplicateScanUnits() {
    if (loading) return [];
    const units = new Map();
    for (const mesh of allModelMeshes()) {
        const g = mesh.geometry;
        if (!g?.getAttribute('position')) continue;
        if (!units.has(g)) units.set(g, { name: mesh.name || '?', geometry: g, instances: 0 });
        units.get(g).instances++;
    }
    return [...units.values()];
}

// --- Render-Loop ---
// Debug display (fps, memory, polygons) only with ?debug
const debugStats = new URLSearchParams(location.search).has('debug')
    ? new DebugStats(document.getElementById('debug-stats'), {
        renderer, adapter, getRoot: () => rootGroup,
        getPhase: () => (pathTracing.enabled ? `PT ${pathTracing.getStatus().phase} (${viewMode})` : viewMode) + (loading ? ', loading' : '')
            + (batcher.stats.batches ? `, ${batcher.stats.instances} meshes in ${batcher.stats.batches} batches` : ''),
        scanUnits: duplicateScanUnits,
        getTiming: () => batcher.timing,
    })
    : null;
renderer.setAnimationLoop(() => {
    const frameStart = performance.now();
    batcher.newFrame();
    stepAnimation(frameStart);
    updateFlight();
    updateSplatSpin(frameStart);
    exploder.update(frameStart);
    controls.update();
    applyCameraRoll();
    viewCube.update(camera);
    // clipping planes follow the distance to the orbit centre (zooming far out/close in, flights to far views) –
    // they were only set when a model was framed: far at least 20×, near at most 1/100 of the distance
    const orbitDist = camera.position.distanceTo(controls.target);
    if (camera.far < orbitDist * 20 || camera.near > orbitDist * 0.01) {
        camera.far = Math.max(camera.far, orbitDist * 100);
        camera.near = Math.min(camera.near, orbitDist * 0.001);
        camera.updateProjectionMatrix();
    }
    // vignette follows the camera (the path tracer takes over the rotation at the next camera restart)
    if (scene.background === vignette.texture && !environment.matte && vignette.update(camera, scene)) pathTracing.updateEnvironment();
    dome.update(camera);   // dome background: camera position relative to the projection centre
    // During import rasterize only when needed: the main thread merges the worker results in
    // parallel. New parts at most every 100 ms, camera following ~30 fps, user input immediately.
    updateFades(performance.now());
    if (fading.size) loadRender.dirty = true;
    if (loadRender.active && !loadRender.force) {
        const now = performance.now();
        const interval = flight || fading.size ? 33 : 100;   // fade-in ~30 fps
        if (!loadRender.dirty || now - loadRender.last < interval) { updatePathTracingStatus(); return; }
        loadRender.last = now;
    }
    // a regrouping compiles its shaders beforehand for the mode it happens in (render-batcher.js, _stage)
    if (batcher.generation !== prepare.generation) {
        prepare.generation = batcher.generation;
        preparedModes.add(`${viewMode === 'basic' ? 'basic' : 'default'}:${batcher.generation}`);
    }
    updateShadowMaps();
    if (prepare.compile) {
        prepare.compile = false;
        prepare.jobs++;
        const t0 = performance.now();
        Promise.resolve().then(compileRaster).catch(err => console.warn('[Render] shader precompile failed:', err)).finally(() => {
            prepare.jobs--;
            loadRender.force = true;
            debugLog(`[Render] shaders compiled in ${(performance.now() - t0).toFixed(0)} ms`);
        });
    }
    if (prepare.jobs > 0) {
        updatePathTracingStatus();
        return;
    }
    loadRender.dirty = false;
    loadRender.force = false;
    let rasterDrawn = false;
    // camera effects: raster/path tracing linear into the HDR target, end() outputs to the canvas with effects
    // lens effects (bloom, glare, chromatic aberration, shafts, flare) in all view modes – image effects on the
    // HDR image; only depth of field stays HQ (a raster approximation deviated too much from path tracing)
    const post = lens.active;
    if (post && (lens.shafts.enabled || lens.flare.enabled)) updateShaftSource();   // light for shafts + flare
    // view angle beyond perspective = fisheye (camera rays of the path tracer): a change restarts the image
    if (setFisheye(camera)) pathTracing.restartCamera();
    // Gaussian splats: re-sort (in workers) when the camera moved; the new order arrives a few frames later.
    // Depth of field + focus line in their shader (the raster is their final look; not in AI capture / export)
    splatMesh?.update(camera, { fisheye: rasterFisheye.active, dof, focusLine: !captureRequest && !exportRequest && dof.showPlane && selection?.kind === 'camera' });
    if (post) lens.begin();
    const contact = ground.enabled && environment.ground && rootGroup && !splatMesh;   // splats cast no shadow
    if (contact) {
        if ((contactLive && !animPlaying) || loadRender.active || fading.size) contactShadow.markDirty();
        contactShadow.update(renderer, scene, extraModels.length ? slicer.group : rootGroup, environment.groundY, [ground.mesh]);
    }
    // focus line while the camera is selected (not in the AI capture / image export); normal view: over the
    // finished raster image (below), fisheye: into every cube face (needs that face's depth buffer)
    const capture = captureRequest;   // AI capture: image without focus plane, highlight and gizmo
    captureRequest = null;
    const exportReq = exportRequest;   // image export: likewise
    exportRequest = null;
    const focusLine = !capture && !exportReq && dof.enabled && dof.showPlane && selection?.kind === 'camera';
    const drawRaster = cam => {
        renderer.render(scene, cam);
        slicer.renderCaps(renderer, scene, cam);
        if (contact) contactShadow.render(renderer, cam);
        if (focusLine && cam !== camera) dof.renderLine(renderer, scene, [ground.material], cam);
    };
    const rasterize = () => {
        if (rasterFisheye.active) rasterFisheye.render(renderer, camera, drawRaster, { shadowLights: lightsGroup.children });
        else drawRaster(camera);
        rasterDrawn = true;
    };
    // while parts are still fading in, raster view (the path tracer does not know the mask)
    if (fading.size || !pathTracing.render(rasterize)) rasterize();
    // focus line over the raster image (uses its depth buffer; fisheye: already in the cube faces)
    if (focusLine && rasterDrawn && !rasterFisheye.active) dof.renderLine(renderer, scene, [ground.material]);
    if (post) lens.end();
    if (!rasterFisheye.active) contours.render();   // toon/outline lines (not through the fisheye cube map)
    if (capture) {
        // read in the same task as the rendering (afterwards the canvas image is presented and discarded)
        capture(renderer.domElement.toDataURL('image/png'));
        updatePathTracingStatus();
        return;
    }
    if (exportReq) {
        exportReq(grabCanvas());   // in the same task as the rendering
        updatePathTracingStatus();
        return;
    }
    highlighter.render();
    // gizmo on top of everything
    if (transformer.object && rasterFisheye.active) {
        rasterFisheye.render(renderer, camera, cam => renderer.render(transformer.overlayScene, cam), { overlay: true });
    } else if (transformer.object) {
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(transformer.overlayScene, camera);
        renderer.autoClear = autoClear;
    }
    prepare.shown = false;   // the blocking frame is done
    checkOptimizeWait();
    updatePathTracingStatus();
    debugStats?.frame(performance.now() - frameStart);
});
