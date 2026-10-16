// Path tracing view based on the WebGPU path tracer of three-gpu-pathtracer
// (https://github.com/gkjohnson/three-gpu-pathtracer, cf. example/denoise.js):
//  - Motion (mouse pressed / zoom): path tracing continues heavily reduced (motion: low resolution,
//    few bounces, every frame anew) or – motion.enabled = false – raster preview
//  - Object editing (gizmo, focus slider): raster preview (BVH/camera parameters change)
//  - Standing still: accumulate samples up to maxSamples, then denoise once with OIDN (AI, oidn-web)
//  - optional FSR upscaling, so rendering can run at reduced resolution
// The BVHs of the geometries are built in advance, in parallel, in the STEP workers (geometry.boundsTree).
// The path tracer, OIDN and the upscaler (~120 KB) are not in the start bundle: load() imports them – the
// viewer calls it when idle after the start (preload), setScene() waits for it at the latest. Until then
// the settings (samples, resolution, …) are only stored.
// Responsiveness: large kernels (megakernel) are compiled asynchronously (_installAsyncCompile), the
// environment's importance-sampling table is computed in a worker (env-cdf.js).
import { Matrix4, Vector2 } from 'three/webgpu';
import { PATHTRACING } from './config.js';   // defaults (samples, resolution, bounces, …)
import { isEnvCdfReady, prepareEnvCdf } from './env-cdf.js';
import { compileAsync } from './shader-compile.js';
import { KuwaharaFilter } from './kuwahara.js';
import { MotionDenoiser } from './motion-denoise.js';
import { ImageFade } from './image-fade.js';
import { fisheyeParams } from './fisheye.js';
import { PT_MOTION } from './pt-motion.js';
import { t } from './i18n.js';
import { debugLog } from './log.js';

// environments up to this size get their importance-sampling table from the library directly (updateEnvironment)
const SMALL_ENV_PIXELS = 512 * 512;
// paths per dispatch while orbiting: the whole image in one tile (the GPU time is kept by the resolution, _adapt)
const MOTION_FRAME_BUDGET = 2 ** 30;
const _size = new Vector2();

export class PathTracingView {
    constructor(renderer, { denoiseWeightsUrl }) {
        this.renderer = renderer;
        // The path tracer needs compute shaders -> only with a real WebGPU backend
        this.supported = Boolean(renderer.backend?.isWebGPUBackend);
        this.enabled = this.supported && PATHTRACING.enabled;
        this.ready = false;
        this.building = false;

        this.bounces = PATHTRACING.bounces;   // bounces when standing still
        this.interacting = false;       // camera is being moved -> rasterizer instead of path tracing
        this._pendingCameraUpdate = false;
        this.backgroundFollowsCamera = false;   // background rotation is tied to the camera (vignette)
        this._dragging = false;
        this.error = null;              // GPU error of the current scene -> no path tracing
        this.suspended = false;         // e.g. section view active (the path tracer knows no clipping)
        this._lastCount = 0;

        // path tracing while orbiting (reduced), settings see config.js
        this.motion = { ...PATHTRACING.motion };
        this._motion = null;            // active: { saved: { renderScale, bounces, minSamples }, end }

        this.denoiseEnabled = PATHTRACING.denoise;
        this.upscaleEnabled = PATHTRACING.upscale;
        this.denoiseProgress = 0;       // 0..1 of the OIDN tiles
        this.denoiseLoading = false;    // network/weights are loading

        this.pathTracer = null;         // created by load()
        this._denoiseWeightsUrl = denoiseWeightsUrl;
        // settings until the path tracer exists
        this._settings = { renderScale: PATHTRACING.renderScale, maxSamples: PATHTRACING.maxSamples,
            filterGlossyFactor: PATHTRACING.filterGlossyFactor, sharpness: PATHTRACING.sharpness };
        this._loading = null;

        this._tracing = false;          // inside a path tracer call from render() (async compile applies)
        this._compiling = 0;            // pipelines being compiled asynchronously
        this._compiled = false;         // a compile finished -> restart (the skipped dispatches counted as samples)
        this._envToken = 0;
        if (this.supported) { this._installAsyncCompile(); this._installTimestamps(); }

        // shader precompilation of the denoiser's albedo/normal pass (_prepareDenoiser); the viewer replaces
        // compileScene with the batch-aware variant and reports changes of the drawn objects via compileKey
        this.compileScene = (scene, camera) => compileAsync(renderer, scene, camera);
        this.compileKey = () => '';
        this._denoisePrep = null;       // { key, done }
        this._materialsVersion = 0;
        this._filterState = { spp: 0, view: new Matrix4(), proj: new Matrix4(), w: 0, h: 0, k: 1 };
        this._motionReady = false;      // motion denoiser compiled once for this scene (_prepareMotionDenoiser)
        this._ownCompile = null;        // promise list: compute pipelines created meanwhile compile asynchronously
        this._restarted = false;        // reset with the view kept (HDRI, material, light …): show the first sample at once
        this._tsPending = false;        // a timestamp read is running (_readTimestamps)
        this._frameMs = 0;              // GPU time of the last refining frame (≈ one megakernel tile)
        this._motionScale = 1;          // orbit resolution factor learned from the GPU time (≤ 1)
        this._motionScaleAt = 0;
        this.gpuCautious = false;       // the GPU was reset before (device lost): half the frame target
        this._holdShown = false;        // first sample of a restart incomplete: keep showing the previous image
        this._holdCover = false;        // … unless it is outdated: raster image meanwhile (_fade)
        this.onRestart = null;          // called then (viewer: soft transition of the picture – the path tracer often
                                        // takes over a change a few frames later, e.g. a new HDRI after its table)
        // soft transition between the images (_fade): rest = share of the non-final image still shown once done
        this._blend = { last: 0, frame: 0, view: new Matrix4(), proj: new Matrix4(), rest: 0, prepared: false };
    }

    // Large compute shaders (megakernel ~110 KB WGSL) via createComputePipelineAsync. three.js creates compute
    // pipelines synchronously: Chrome compiles them on the GPU process main thread (Windows/DXC without shader
    // cache: ~4 s) – no frame at all meanwhile, the whole page freezes. The async variant compiles on a
    // worker thread of the GPU process; until it is ready the dispatch is skipped and render() shows the raster
    // image. Applies only to calls from render() (_tracing) – a skipped dispatch would break one-off computes.
    _installAsyncCompile() {
        const backend = this.renderer.backend;
        const create = backend.createComputePipeline.bind(backend);
        const compute = backend.compute.bind(backend);
        backend.createComputePipeline = (pipeline, bindings, promises = null) => {
            // own kernels (denoiser guides, _prepareMotionDenoiser): asynchronously, the caller waits for the list
            if (this._ownCompile && !promises) return create(pipeline, bindings, this._ownCompile);
            if (promises || !this._tracing || pipeline.computeProgram.code.length < PATHTRACING.asyncCompileMinChars) {
                return create(pipeline, bindings, promises);
            }
            const list = [];
            create(pipeline, bindings, list);
            const t0 = performance.now();
            this._compiling++;
            Promise.all(list).then(() => {
                this._compiling--;
                this._compiled = true;
                debugLog(`[Pathtracer] kernel compiled asynchronously in ${(performance.now() - t0).toFixed(0)} ms`);
                if (backend.get(pipeline).error) this.fail(t('render.gpuError'));
            });
        };
        // pipeline not ready yet (async compile running): skip
        backend.compute = (group, node, bindings, pipeline, dispatchSize) => {
            if (backend.get(pipeline).pipeline) compute(group, node, bindings, pipeline, dispatchSize);
            else this._skips = (this._skips || 0) + 1;   // timing of these frames is meaningless (_readTimestamps)
        };
    }

    /** Compute the environment's importance-sampling table in advance (worker), e.g. when idle after the start
     *  or for a newly loaded HDRI. Resolves when ready (never rejects). */
    prepareEnvironment(texture) {
        return this.supported ? prepareEnvCdf(texture) : Promise.resolve();
    }

    /** Load and create the path tracer (once; later calls return the same promise). false = not supported */
    load() {
        if (!this.supported) return Promise.resolve(false);
        this._loading ??= Promise.all([import('three-gpu-pathtracer/webgpu'), import('oidn-web'), import('@pmndrs/upscaler'), import('./pt-guides.js')])
            .then(([ptLib, oidn, upscalerLib, guidesLib]) => { this._create(ptLib, oidn, upscalerLib, guidesLib); return true; })
            .catch(err => { this._loading = null; throw err; });
        return this._loading;
    }

    _create({ WebGPUPathTracer, OIDNDenoiser, FSRUpscaler }, { initUNetFromURL }, { Upscaler }, { GuideKernel }) {
        const t0 = performance.now();
        const s = this._settings;
        this._initUNetFromURL = initUNetFromURL;
        const pt = this.pathTracer = new WebGPUPathTracer(this.renderer);
        pt.renderScale = s.renderScale;
        pt.maxSamples = s.maxSamples;
        pt.maxBounces = this.bounces;
        pt.filterGlossyFactor = s.filterGlossyFactor;
        // No low-res preview and no cross-fade: until the first sample per pixel is available,
        // the raster image is drawn over the path tracer (see render()).
        pt.dynamicLowRes = false;
        pt.renderDelay = 0;
        pt.fadeDuration = 0;

        this.denoiser = new OIDNDenoiser({
            initUNetFromURL: (url, backend, options) => this._initUNet(url, backend, options),
            auxWeightsUrl: this._denoiseWeightsUrl,
        });
        this.upscaler = new FSRUpscaler({ Upscaler });
        this.upscaler.sharpness = s.sharpness;
        this.kuwahara = new KuwaharaFilter(this.renderer, PATHTRACING.kuwahara);
        this.motionDenoiser = new MotionDenoiser(this.renderer, PATHTRACING.denoiseMotion);
        this.guides = new GuideKernel(PATHTRACING.denoiseMotion);   // its guide buffers, traced like the image
        this.imageFade = new ImageFade(this.renderer);
        // the path tracer's "upscaler" slot: image filter while orbiting and while the image refines (Kuwahara or
        // denoiser, see _filter), then FSR if switched on, then the soft transition to the shown image (_fade)
        const fsr = this.upscaler;
        this._imageChain = {
            init: renderer => fsr.init(renderer),
            dispose: () => { fsr.dispose?.(); this.kuwahara.dispose(); this.motionDenoiser.dispose(); this.guides.dispose(); this.imageFade.dispose(); },
            upscale: (texture, camera) => {
                texture = this._filter(texture);
                if (this.upscaleEnabled) texture = fsr.upscale(texture, camera);
                return this._fade(texture, camera);
            },
        };
        // the denoise waits until the shaders of the albedo/normal pass are compiled (_prepareDenoiser)
        const denoiseUpdate = this.denoiser.update.bind(this.denoiser);
        this.denoiser.update = target => (this._denoisePrep && !this._denoisePrep.done ? this.denoiser.texture : denoiseUpdate(target));
        pt.setDenoiser(this.denoiseEnabled ? this.denoiser : null);
        pt.setUpscaler(this._imageChain);
        // restart while the image is shown (environment, materials, lights, objects …): the raster image used to cover
        // the path tracer until the first sample was complete – a jump to the raster view and back. Instead the first
        // sample is computed at once (_renderFirstSample) and fades in over the previous image (_fade).
        const reset = pt.reset.bind(pt);
        pt.reset = () => {
            reset();
            this._restarts = (this._restarts || 0) + 1;   // image filter cache (_filter)
            if (this.ready && !this._motion && !this.interacting) {
                this._restarted = true;
                this.onRestart?.();
            }
        };
        debugLog(`[Pathtracer] created in ${(performance.now() - t0).toFixed(0)} ms`);
    }

    /** FSR sharpness (setup menu) */
    get sharpness() { return this.upscaler?.sharpness ?? this._settings.sharpness; }
    set sharpness(v) { this._settings.sharpness = v; if (this.upscaler) this.upscaler.sharpness = v; }

    // Load the oidn-web network and wrap tileExecute: track progress, but do NOT show
    // intermediate results. oidn-web writes into a reused output buffer; the
    // OIDNDenoiser copies the whole buffer per tile -> tiles not processed yet
    // show the denoised image of the previous camera perspective (flashing through).
    // Without intermediate results the path traced image stays until the result is complete.
    async _initUNet(url, backend, options) {
        this.denoiseLoading = true;
        let unet;
        try {
            unet = await this._initUNetFromURL(url, backend, options);
        } finally {
            this.denoiseLoading = false;
        }
        const tileExecute = unet.tileExecute.bind(unet);
        unet.tileExecute = inputs => {
            this.denoiseProgress = 0;
            return tileExecute({
                ...inputs,
                progress: (output, tileData, tile, current, total) => {
                    this.denoiseProgress = total ? Math.min((current + 1) / total, 1) : 0;
                },
            });
        };
        return unet;
    }

    get samples() {
        return this.pathTracer ? this.pathTracer._lastSampleCounts.avg : 0;
    }

    get maxSamples() { return this.pathTracer?.maxSamples ?? this._settings.maxSamples; }
    set maxSamples(v) { this._settings.maxSamples = v; if (this.pathTracer) this.pathTracer.maxSamples = v; }

    // during motion this shows/changes the standing-still resolution (reduction is internal only)
    get renderScale() { return this._motion?.saved.renderScale ?? this.pathTracer?.renderScale ?? this._settings.renderScale; }
    set renderScale(v) {
        this._settings.renderScale = v;
        if (!this.pathTracer) return;
        if (this._motion) this._motion.saved.renderScale = v; else this.pathTracer.renderScale = v;
    }

    get filterGlossyFactor() { return this.pathTracer?.filterGlossyFactor ?? this._settings.filterGlossyFactor; }
    set filterGlossyFactor(v) {
        this._settings.filterGlossyFactor = v;
        if (this.pathTracer) { this.pathTracer.filterGlossyFactor = v; this.reset(); }
    }

    setDenoise(enabled) {
        this.denoiseEnabled = enabled;
        this.pathTracer?.setDenoiser(enabled ? this.denoiser : null);
    }

    setUpscale(enabled) {
        this.upscaleEnabled = enabled;   // _imageChain reads it
    }

    // Take over the scene. The BVHs must already be attached to the geometries (geometry.boundsTree),
    // otherwise the path tracer builds them synchronously on the main thread.
    async setScene(scene, camera) {
        if (!this.supported) return;
        this.ready = false;
        this.building = true;
        this.error = null;
        try {
            // path tracer usually preloaded already; the environment table comes from a worker
            await Promise.all([this.load(), prepareEnvCdf(scene.environment)]);
            // wait one frame so the status display becomes visible
            await new Promise(resolve => requestAnimationFrame(resolve));
            const t0 = performance.now();
            this.pathTracer.setScene(scene, camera);
            this._motionReady = false;   // new scene data: Kuwahara until the denoiser's shaders are compiled for it
            // switch only now: useMegakernel() needs the camera and BVH data of the scene
            if (PATHTRACING.megakernel && !this._megakernel) {
                this._megakernel = true;
                this.pathTracer.useMegakernel(true);
                this.pathTracer.updateMaterials();   // useMegakernel() does not carry over textures
            }
            this.pathTracer.maxBounces = this.bounces;
            this.pathTracer.frameBudget = this.gpuCautious ? PATHTRACING.minFrameBudget : PATHTRACING.startFrameBudget;
            this._firstSample = performance.now();
            debugLog(`[Pathtracer] scene set up in ${(this._firstSample - t0).toFixed(0)} ms (main thread)`);
        } finally {
            this.building = false;
        }
        this.ready = true;
    }

    // GPU error with the current scene: no more path tracing until the next setScene()
    fail(message) {
        if (!this.error) console.warn('[Pathtracer] disabled:', message);
        this.error = message || t('render.gpuError');
    }

    setEnabled(enabled) {
        this._exitMotion();
        this.enabled = enabled && this.supported;
        this.reset();
    }

    // Temporarily rasterize only (e.g. section view); start over when resuming
    setSuspended(suspended) {
        if (this.suspended === suspended) return;
        this._exitMotion();
        this.suspended = suspended;
        if (!suspended) this._pendingCameraUpdate = true;
        this.reset();
    }

    setBounces(bounces) {
        this.bounces = bounces;
        if (this.ready && !this._motion) {
            this.pathTracer.maxBounces = bounces;
            this.reset(); // also discards an already denoised image
        }
    }

    // Scene has changed (e.g. retessellated) – no path tracing until the next setScene().
    invalidate() {
        this._exitMotion();
        this.ready = false;
    }

    // Camera movement begins: pause path tracing (rasterizer takes over).
    beginInteraction() {
        this._dragging = true;
    }

    // Camera movement ended: restart with the new camera – but only if the camera
    // actually moved (a plain click, e.g. for selecting, restarts nothing).
    endInteraction() {
        this._dragging = false;
        if (this._motion) this._motion.end = performance.now();   // return to full quality in render()
        if (this.interacting) {
            this.interacting = false;
            this._pendingCameraUpdate = true;
        }
    }

    // Camera changed: while the mouse is pressed -> pause path tracing, otherwise restart
    updateCamera() {
        if (this._dragging && this._canMotion()) {
            // keep path tracing reduced: every frame from scratch with the new camera
            this._enterMotion();
            this._pendingCameraUpdate = true;
        } else if (this._dragging) {
            // Movement begins: abort running denoising immediately (otherwise OIDN keeps working
            // during the raster view – with glass this led to "Destroyed texture" errors)
            if (!this.interacting && this.ready) this.pathTracer.reset();
            this.interacting = true;
        } else this._pendingCameraUpdate = true;
    }

    // Camera projection changed without a drag (e.g. fisheye toggle/number field): restart, but show the
    // first full sample at once like after orbiting instead of the raster view in between
    restartCamera() {
        if (!this.ready || this._dragging || this._motion) return this.updateCamera();
        if (!this._fullFirst) {
            this._fullFirst = true;
            this._fullFirstMin = this.pathTracer.minSamples;
            this.pathTracer.minSamples = 0;
        }
        this._pendingCameraUpdate = true;
    }

    // Visibility (object.visible incl. parents) or transforms changed
    updateTransforms() {
        if (!this.ready) return;
        this.pathTracer.updateTransforms();
    }

    // Object is being edited via gizmo: pause path tracing (raster view)
    pauseForEdit() {
        if (!this.interacting && this.ready) this.pathTracer.reset();
        this.interacting = true;
    }

    // Editing finished: update scene data and restart
    resumeAfterEdit(kind) {
        this.interacting = false;
        if (kind === 'light') this.updateLights();
        else if (kind === 'camera') this._pendingCameraUpdate = true;
        else this.updateTransforms();
    }

    // Light toggled or changed
    updateLights() {
        if (!this.ready) return;
        this.pathTracer.updateLights();
    }

    // scene.environment / background changed. A new environment first gets its importance-sampling table
    // in a worker (the path tracer keeps the previous one until then); otherwise applied at once.
    // Small textures (HDRI editor while dragging a pin: 512 × 256, several per second) at once – the library
    // computes their table in a few ms; through the worker every new one dropped the previous preparation, the
    // path tracer only showed the change once the mouse stood still.
    updateEnvironment() {
        if (!this.ready) return;
        const token = ++this._envToken;
        const env = this.pathTracer.scene.environment;
        const small = env?.image?.width * env?.image?.height <= SMALL_ENV_PIXELS;
        if (small || isEnvCdfReady(env)) { this.pathTracer.updateEnvironment(); return; }
        prepareEnvCdf(env).then(() => {
            if (token === this._envToken && this.ready) this.pathTracer.updateEnvironment();
        });
    }

    // Only intensity/rotation of environment and background changed: apply the parameters without
    // updateEnvironment() – that clones the textures and rebuilds the importance sampling table
    // (4k HDRI: 8 million pixels on the CPU -> stutter while dragging the sliders)
    updateEnvironmentParams() {
        if (!this.ready) return;
        const pt = this.pathTracer, scene = pt.scene;
        pt._pathTracer.setEnvironmentParams(scene.environmentIntensity, scene.environmentRotation);
        pt._pathTracer.setBackgroundParams(scene.backgroundIntensity, scene.backgroundRotation, scene.backgroundBlurriness);
        pt.reset();
    }

    updateMaterials() {
        this._materialsVersion++;   // new materials -> new shader variants for the denoiser's albedo/normal pass
        if (!this.ready) return;
        this.pathTracer.updateMaterials();
    }

    reset() {
        if (!this.ready) return;
        this.pathTracer.reset();
    }

    // Render one frame. Returns false if path tracing is not possible (yet).
    // rasterize: draws the raster image. As long as the path tracer has no complete image yet
    // (fadeState < 1), it is drawn AFTER the path tracer and covers it completely.
    // Background: the path tracer's blit is not transparent at opacity 0 (colour is
    // added), and right after a reset its buffer still contains the old image – both let
    // the previous rendering in the old perspective shine through.
    render(rasterize) {
        if (!this.enabled || !this.ready || this.interacting || this.error || this.suspended) return false;
        const pt = this.pathTracer;
        // kernel compiling asynchronously: raster image meanwhile; afterwards start over (the frames without
        // dispatch were counted as samples)
        if (this._compiling) { rasterize(); return true; }
        if (this._compiled) {
            this._compiled = false;
            pt.reset();
            this._firstSample ||= performance.now();
        }
        this._prepareDenoiser();
        this._prepareMotionDenoiser();
        this._tracing = true;
        try {
            this._renderPathTraced(pt);
        } finally {
            this._tracing = false;
        }
        this._readTimestamps();
        if (this._compiling) { rasterize(); return true; }
        if (pt.fadeState < 1 || (this._holdShown && this._holdCover)) rasterize();

        // update the sample count for the display occasionally (it is a GPU readback)
        const now = performance.now();
        if (!this._isDone() && now - this._lastCount > PATHTRACING.countInterval) {
            this._lastCount = now;
            pt.getSampleCountsAsync();
        }
        return true;
    }

    // GPU time of the path tracer's dispatches from timestamp queries – compute passes only (render passes untouched):
    // three.js tracks per pass with trackTimestamp; the queue (onSubmittedWorkDone) measured latency incl. presenting,
    // not GPU work. Without the 'timestamp-query' feature the budget stays at PATHTRACING.startFrameBudget.
    _installTimestamps() {
        const backend = this.renderer.backend;
        if (!backend?.hasFeature?.('timestamp-query')) return;
        const init = backend.initTimestampQuery.bind(backend);
        backend.initTimestampQuery = (type, uid, descriptor) => { if (type === 'compute') init(type, uid, descriptor); };
        backend.trackTimestamp = true;
        this._timestamps = true;
    }

    // longest megakernel dispatch of the frames since the last read → paths per dispatch (refining) or the resolution
    // (orbiting: one dispatch per frame). Every device: aims at PATHTRACING.frameTargetMs per dispatch – fixed values
    // fitted one GPU at Full HD; at 4K / on slower GPUs single dispatches came close to the GPU watchdog (Windows TDR
    // ~2 s: DXGI_ERROR_DEVICE_HUNG, the WebGPU device is lost).
    _readTimestamps() {
        if (!this._timestamps || this._tsPending) return;
        // only frames in which the kernel really traced: while it compiles the dispatches are skipped, a finished image
        // returns at once – those near-zero times let the budget grow to the maximum before anything was measured
        const inner = this.pathTracer?._pathTracer;
        const traced = !this._compiling && !this._compiled && !this._isDone() && !(this.pathTracer.maxSamples > 0 && inner?._completedSamples >= this.pathTracer.maxSamples);
        // a skipped dispatch since the last read: its pass (empty) is among the queries – drop this read
        const skips = this._skips || 0, clean = skips === this._lastSkips;
        this._lastSkips = skips;
        if (!traced || !clean) { this.renderer.resolveTimestampsAsync('compute').catch(() => {}); return; }   // drop those queries
        this._tsPending = true;
        const motion = !!this._motion;
        this.renderer.resolveTimestampsAsync('compute').then(() => {
            this._tsPending = false;
            const pool = this.renderer.backend.timestampQueryPool?.compute;
            const id = String(this.pathTracer?._pathTracer?.kernel?.kernel?.id ?? '');
            let ms = 0;
            for (const [uid, d] of pool?.timestamps ?? []) if (uid.split(':')[2] === id) ms = Math.max(ms, d);
            if (ms > 0) this._adapt(ms, motion);
        }, () => { this._tsPending = false; });
    }

    _adapt(ms, motion) {
        const pt = this.pathTracer;
        if (!pt || !this.ready || motion !== !!this._motion) return;
        const target = PATHTRACING.frameTargetMs * (this.gpuCautious ? 0.5 : 1);
        if (motion) {
            this._motionMs = ms;
            // in steps and at most twice a second – every resolution change reallocates the buffers
            const now = performance.now();
            if (now - this._motionScaleAt < 500) return;
            const want = Math.min(Math.max(this._motionScale * Math.sqrt(target / ms), 0.35), 1);
            if (Math.abs(want - this._motionScale) < 0.15 && want < 1) return;
            if (want === this._motionScale) return;
            this._motionScale = want > 0.95 ? 1 : want;
            this._motionScaleAt = now;
            pt.renderScale = Math.min(this.motion.renderScale, this._motion.saved.renderScale) * this._motionScale;
            return;
        }
        this._frameMs = ms;
        const set = f => { pt.frameBudget = Math.round(Math.min(Math.max(pt.frameBudget * f, PATHTRACING.minFrameBudget), PATHTRACING.frameBudget)); };
        // tiles cost very differently (empty background ~1 ms, the model many times that): shrink at once on a slow
        // one, grow only once a whole sample has run – by its most expensive tile
        if (ms > target) { set(Math.max(target / ms, 0.5)); this._sampleMax = 0; return; }
        this._sampleMax = Math.max(this._sampleMax || 0, ms);
        const done = pt._pathTracer?._completedSamples ?? 0;
        if (done === this._sampleSeen) return;
        this._sampleSeen = done;
        const worst = this._sampleMax;
        this._sampleMax = 0;
        set(Math.min(target / Math.max(worst, 0.5), worst < target / 3 ? 2 : 1.25));
    }

    // The denoiser rasterizes albedo + normals with its own shader variant of every material. Built at denoise
    // time this blocked the main thread (large assembly: ~0.8 s) and then the GPU process (synchronous pipelines, ~1 s).
    // Instead compile them while the samples accumulate: the denoiser's own pass setup (_renderAuxiliaryBuffers:
    // target, MRT, tone mapping) with compileAsync (shader-compile.js) instead of render – node building object
    // by object with pauses, pipelines asynchronously. Again when the drawn objects or the materials change.
    _prepareDenoiser() {
        if (!this.denoiseEnabled) return;
        const key = `${this.compileKey()}/${this._materialsVersion}`;
        if (this._denoisePrep?.key === key) return;
        const prep = this._denoisePrep = { key, done: false };
        const r = this.renderer, size = this.pathTracer._pathTracer.getSize(new Vector2());
        const render = r.render;
        let job = null;
        const t0 = performance.now();
        r.render = (scene, camera) => { job = this.compileScene(scene, camera); };
        try {
            this.denoiser._renderAuxiliaryBuffers(Math.max(size.x, 1), Math.max(size.y, 1));
        } catch (err) {
            console.warn('[Pathtracer] denoiser precompile failed:', err);
        } finally {
            r.render = render;
        }
        Promise.resolve(job).catch(err => console.warn('[Pathtracer] denoiser precompile failed:', err)).finally(() => {
            prep.done = true;
            debugLog(`[Pathtracer] denoiser shaders compiled in ${(performance.now() - t0).toFixed(0)} ms`);
        });
    }

    // Image filter of the path traced image while orbiting and while it refines (motion.filter). The denoiser's
    // guides are traced with the path tracer's camera and scene (pt-guides.js) – fisheye, depth of field, mirrors,
    // glass, materials. Kuwahara only until its shaders are compiled for a new scene (_prepareMotionDenoiser).
    _filter(texture) {
        const mode = this.motion.filter;
        if (mode === 'denoise' && this._motionReady) {
            const iterations = this._denoiseIterations(texture);
            if (!iterations) { this.motionDenoiser.resetHistory(); return texture; }
            const pt = this.pathTracer, camera = pt.camera, s = this._filterState, lens = fisheyeParams();
            const spp = this._motion ? 0 : this._samplesNow();
            // refining: filter again only once a sample is complete (at 4K a sample takes several frames – filtering
            // every frame cost ~300 ms GPU per frame); the image chain keeps the last result meanwhile
            const whole = this._motion ? -1 : Math.floor(spp);
            if (!this._motion && s.out && s.whole === whole && s.restarts === this._restarts && s.input === texture && s.w === (texture.image?.width ?? texture.width)) return s.out;
            const w = texture.image?.width ?? texture.width, h = texture.image?.height ?? texture.height;
            // guides only when the view or the scene changed (restart = fewer samples: objects, materials, depth of
            // field …); while orbiting every frame
            if (this._motion || spp < s.spp || s.w !== w || s.h !== h || s.k !== lens.k
                || !s.view.equals(camera.matrixWorld) || !s.proj.equals(camera.projectionMatrix)) {
                this.guides.trace(this.renderer, pt._bvhData, w, h, camera);
                s.view.copy(camera.matrixWorld);
                s.proj.copy(camera.projectionMatrix);
                Object.assign(s, { w, h, k: lens.k });
            }
            s.spp = spp;
            s.whole = whole;
            s.restarts = this._restarts;
            s.input = texture;
            return (s.out = this.motionDenoiser.render(texture, { guides: this.guides, camera, lens, iterations,
                temporal: Boolean(this._motion) && this.motion.temporal }));
        }
        if (mode !== 'kuwahara' && mode !== 'denoise') return texture;
        const radius = this._kuwaharaRadius(texture);
        return radius > 0 ? this.kuwahara.render(texture, radius) : texture;
    }

    // Soft transition (image-fade.js, user's wish: no jumps between the orbit preview and the sample stages): the
    // shown image moves towards the new one with time constant PATHTRACING.fadeMs. Cut (show at once): while
    // orbiting, after a new view (camera changed, e.g. fly-to – no cross-fade between two views) and after a
    // pause of the path tracer (raster preview while editing – the old image shows the old state).
    _fade(texture, camera) {
        const b = this._blend, tau = PATHTRACING.fadeMs;
        if (!(tau > 0)) { b.rest = 0; return texture; }
        const now = performance.now(), dt = now - b.last;
        const moved = !b.view.equals(camera.matrixWorld) || !b.proj.equals(camera.projectionMatrix);
        const cut = Boolean(this._motion) || dt > 100 || moved;
        const k = cut ? 1 : 1 - Math.exp(-dt / tau);
        // the image shown before is outdated: the path tracer was not shown in the last frame (paused, other view
        // mode, parts fading in) or the view changed – by frames, not time (slow frames of large scenes are no pause)
        const frame = this.renderer.info.frame, stale = moved || frame - b.frame > 1;
        b.frame = frame;
        b.last = now;
        b.view.copy(camera.matrixWorld);
        b.proj.copy(camera.projectionMatrix);
        // the final image is reported done only once the earlier ones have faded out (export/AI take the next frame)
        b.rest = this._isDone() ? b.rest * (1 - k) : 1;
        if (!b.prepared) {   // first use: compile asynchronously, show the image as it is meanwhile
            b.prepared = true;
            b.ready = false;
            this.imageFade.compile(texture).catch(err => console.warn('[Pathtracer] fade precompile failed:', err))
                .finally(() => { b.ready = true; });
        }
        if (!b.ready) { b.rest = 0; return texture; }
        const size = this.renderer.getDrawingBufferSize(new Vector2());
        // restart whose first sample is still being computed: keep the image shown before (k 0) instead of a half
        // tiled one; then it fades in as usual. Unless that image is outdated (stale, e.g. back to HQ after playing
        // an animation) – it flashed up before the new one; the raster image covers the path tracer meanwhile
        // (render()) and the first sample fades in over it (onRestart)
        let cover = false;
        if (this._holdShown) {
            if (stale) this._holdCover = true;
            if (!this._firstSampleDone()) {
                if (this._holdCover) return texture;
                return this.imageFade.render(texture, 0, Math.max(size.x, 1), Math.max(size.y, 1));
            }
            this._holdShown = false;
            cover = this._holdCover;
            this._holdCover = false;
        }
        if (cover) this.onRestart?.();
        return this.imageFade.render(texture, cover ? 1 : k, Math.max(size.x, 1), Math.max(size.y, 1));
    }

    _fadeSettled() {
        return this._blend.rest < 1 / 256;
    }

    // samples per pixel so far – from the megakernel's tile progress (CPU, no readback)
    _samplesNow() {
        const pt = this.pathTracer, inner = pt._pathTracer;
        return Math.max(1, '_completedSamples' in inner ? inner._completedSamples + inner._tileProgress : pt._lastSampleCounts.avg);
    }

    // à-trous passes of the denoiser: all while orbiting, afterwards fewer with the samples (the noise halves every
    // 4 samples, one pass less per doubling) but at least 2 until the final image (1 left visible grain); 0 = none
    _denoiseIterations(texture) {
        const n = PATHTRACING.denoiseMotion.iterations;
        if (this._motion) return n;
        if (texture === this.denoiser.texture || this._isDone()) return 0;   // final image
        return Math.min(Math.max(Math.ceil(n - Math.log2(this._samplesNow())), 2), n);
    }

    // The motion denoiser's shaders (guide kernel, full-screen passes) – compiled asynchronously while the image
    // accumulates; built on the first orbit they blocked the main thread and the GPU process. Once per scene data
    // (pt._bvhData, new with setScene): until then the image filter is Kuwahara, afterwards the denoiser stays on –
    // the filter must not change by itself (user). Material/environment changes need no new kernel (the scene
    // data's buffers are updated in place; with them in the key the filter fell back to Kuwahara on each HDRI
    // change).
    _prepareMotionDenoiser() {
        if (this.motion.filter !== 'denoise') return;
        const pt = this.pathTracer, key = pt._bvhData;   // guide kernel per scene data
        if (!key || this._motionPrep?.key === key) return;
        const prep = this._motionPrep = { key, done: false };
        const t0 = performance.now();
        let job = null;
        try {
            const source = pt._pathTracer.outputTarget;
            const w = Math.max(source.image?.width ?? source.width ?? 1, 1), h = Math.max(source.image?.height ?? source.height ?? 1, 1);
            // the guide kernel: its first dispatch creates the pipeline – asynchronously (_ownCompile), skipped meanwhile
            const own = this._ownCompile = [];
            const { kernel, dispatch } = this.guides.update(key, w, h, pt.camera);
            this.renderer.compute(kernel, dispatch);
            this._ownCompile = null;
            this._filterState.w = 0;   // trace the guides again at the first use
            job = Promise.all([Promise.all(own), this.motionDenoiser.compile(source, this.guides)]);
        } catch (err) {
            console.warn('[Pathtracer] motion denoiser precompile failed:', err);
        } finally {
            this._ownCompile = null;
        }
        Promise.resolve(job).catch(err => console.warn('[Pathtracer] motion denoiser precompile failed:', err)).finally(() => {
            prep.done = true;
            if (this._motionPrep === prep) this._motionReady = true;
            debugLog(`[Pathtracer] motion denoiser shaders compiled in ${(performance.now() - t0).toFixed(0)} ms`);
        });
    }

    // Kuwahara brush radius in pixels of the path traced image (0 = no filter). While orbiting the configured size
    // on the reduced image. Afterwards the same size on screen at first, shrinking with the samples (noise ∝
    // 1/√samples, towards maxSamples another factor down to ½) but at least 1 px until the final image (denoised,
    // or maxSamples without denoiser) – the painted image gets finer and finer up to the final one instead of
    // showing the noisy accumulation (user's wish).
    _kuwaharaRadius(texture) {
        const base = PATHTRACING.kuwahara.radius;
        if (this._motion) return base;
        const pt = this.pathTracer;
        if (texture === this.denoiser.texture || this._isDone()) return 0;   // final image
        const scale = pt.renderScale / Math.min(this.motion.renderScale, pt.renderScale);
        const spp = this._samplesNow();
        const radius = base * scale / Math.sqrt(spp);
        // endless accumulation (maxSamples 0): fades out on its own
        if (pt.maxSamples <= 0) return radius >= 0.75 ? radius : 0;
        return Math.max(1, radius * (1 - 0.5 * Math.min(spp / pt.maxSamples, 1)));
    }

    _renderPathTraced(pt) {
        // motion over (hold time elapsed): back to full quality, restart
        if (this._motion?.end && performance.now() - this._motion.end > this.motion.holdMs) this._exitMotion();
        this._syncSize();
        // while orbiting possibly several samples per frame (the whole image is one tile then)
        if (this._motion && !this._pendingCameraUpdate) {
            for (let i = 1; i < this.motion.samples; i++) pt._pathTracer.update();
        }
        // restart in the render loop, right before the next sample
        if (this._pendingCameraUpdate) {
            this._pendingCameraUpdate = false;
            // only the parameters: updateEnvironment() would rebuild the environment (importance sampling)
            if (this.backgroundFollowsCamera) {
                const { scene } = pt;
                pt._pathTracer.setBackgroundParams(scene.backgroundIntensity, scene.backgroundRotation, scene.backgroundBlurriness);
            }
            pt.updateCamera();
            if (this._fullFirst && pt.material?.initialized) { this._renderFirstSample(); this._restarted = false; }
        }
        // (not before the library's first renderSample(): it initialises the material the kernel is built from)
        if (this._restarted && !this._motion && pt.material?.initialized) {
            this._restarted = false;
            if (!this._fullFirst) {
                this._fullFirst = true;
                this._fullFirstMin = pt.minSamples;
                pt.minSamples = 0;
            }
            this._renderFirstSample();
        }
        pt.renderSample();
        if (this._fullFirst) {   // first full-quality image is on screen: normal gate again
            this._fullFirst = false;
            pt.minSamples = this._fullFirstMin;
        }
        if (this._firstSample) {   // timing of the first frame (console, for comparisons on a real GPU)
            // The JS call only hands off the work; shader compilation + computation run afterwards in the
            // GPU process – only onSubmittedWorkDone() shows when the GPU is really done.
            const start = this._firstSample;
            this._firstSample = 0;
            debugLog(`[Pathtracer] first sample submitted after ${(performance.now() - start).toFixed(0)} ms (main thread)`);
            this.renderer.backend?.device?.queue.onSubmittedWorkDone()
                .then(() => debugLog(`[Pathtracer] first sample finished on the GPU after ${(performance.now() - start).toFixed(0)} ms (incl. shader compilation)`));
        }
    }

    _canMotion() {
        return this.motion.enabled && this.enabled && this.ready && !this.error && !this.suspended;
    }

    // reduced settings for motion (once per motion; changing the resolution reallocates buffers)
    _enterMotion() {
        this._holdShown = this._holdCover = false;   // orbiting shows every frame anew
        if (this._motion) { this._motion.end = 0; return; }
        const pt = this.pathTracer;
        this._motion = { saved: { renderScale: pt.renderScale, bounces: this.bounces, minSamples: pt.minSamples, frameBudget: pt.frameBudget }, end: 0 };
        pt.renderScale = Math.min(this.motion.renderScale, pt.renderScale) * this._motionScale;   // learned from the GPU time
        pt.maxBounces = Math.min(this.motion.bounces, this.bounces);
        // glass keeps the bounces of standing still (refractions within this budget are not counted, pt-motion.js)
        PT_MOTION.glassBounces.value = Math.max(this.bounces - pt.maxBounces, 0);
        pt.minSamples = 0;   // show immediately (otherwise the raster image covers it until the first sample is counted)
        // every frame starts over: the whole image in one dispatch. With the refining budget (learned per tile, small
        // for large scenes / 4K) the image was split into tiles and only the first one (bottom left) was ever traced
        // before the next camera change – the rest stayed black (quarters, black half)
        pt.frameBudget = MOTION_FRAME_BUDGET;
    }

    _exitMotion() {
        const m = this._motion;
        if (!m) return;
        this._motion = null;
        const pt = this.pathTracer;
        pt.renderScale = m.saved.renderScale;
        pt.frameBudget = m.saved.frameBudget;
        pt.maxBounces = this.bounces;
        PT_MOTION.glassBounces.value = 0;
        // show the first full sample immediately instead of the raster image (see _renderFirstSample)
        this._fullFirst = true;
        this._fullFirstMin = m.saved.minSamples;
        pt.minSamples = 0;
        this._pendingCameraUpdate = true;
    }

    // Back from motion to full quality: the first sample at full resolution needs several frames
    // (megakernel: one tile per frame), until it is counted the raster image covered the path tracer –
    // the raster view "blipped" in between motion and full quality. Instead compute all tiles of the
    // first sample right away (one longer frame) and show it immediately (minSamples 0 for this frame).
    _renderFirstSample() {
        const pt = this.pathTracer, inner = pt._pathTracer;
        if (!('_tileProgress' in inner)) { this._fullFirst = false; pt.minSamples = this._fullFirstMin; return; }   // wavefront
        // the inner size change otherwise happens only in renderSample()
        const { w, h } = this._syncSize();
        const current = inner.getSize(new Vector2());
        if (current.x !== w || current.y !== h) inner.setSize(w, h);
        inner.lowResMode = false;
        // as many tiles as fit into PATHTRACING.firstSampleMs (tile time measured while refining); the rest follows
        // in the next frames while the previous image stays (_holdShown, _fade) – all tiles at once took seconds of
        // GPU time in one frame on large scenes at 4K
        const tileMs = Math.max(this._frameMs || PATHTRACING.frameTargetMs, 1);
        const tiles = Math.max(1, Math.floor(PATHTRACING.firstSampleMs / tileMs));
        for (let i = 0; i < Math.min(tiles, 64); i++) {
            inner.update();
            if (inner._tileProgress === 1) break;
        }
        this._holdShown = inner._tileProgress < 1;
    }

    // Image size from the canvas and renderScale – before renderSample(): the library resizes inside it only after
    // its "first frame since the reset" check, so that frame counted as low-res and traced nothing (opacity 0 →
    // the raster image covered the path tracer: Default view flashed up when orbiting/zooming began and whenever
    // the orbit resolution changed)
    _syncSize() {
        const pt = this.pathTracer, size = this.renderer.getDrawingBufferSize(_size);
        const w = Math.floor(pt.renderScale * size.x), h = Math.floor(pt.renderScale * size.y);
        pt.setSize(w, h);
        return { w, h };
    }

    // first sample of the restart complete? (megakernel tile progress)
    _firstSampleDone() {
        const inner = this.pathTracer._pathTracer;
        return !('_tileProgress' in inner) || inner._completedSamples >= 1 || inner._tileProgress === 1;
    }

    _isDone() {
        const pt = this.pathTracer;
        if (pt.maxSamples <= 0) return false;
        if (this.denoiseEnabled) return this.denoiser.complete;
        return pt._lastSampleCounts.min >= pt.maxSamples;
    }

    /** State for diagnostics after a GPU reset (viewer.js keeps the last one): budget, dispatch times, sizes */
    diagnostics() {
        const pt = this.pathTracer, size = pt?._pathTracer?.getSize?.(new Vector2());
        return {
            phase: this.getStatus().phase, samples: Math.round(this.samples * 10) / 10, motion: !!this._motion,
            frameBudget: pt?.frameBudget ?? null, lastDispatchMs: Math.round(this._frameMs * 10) / 10,
            motionDispatchMs: Math.round((this._motionMs || 0) * 10) / 10, motionScale: Math.round(this._motionScale * 100) / 100,
            traceSize: size ? `${size.x}x${size.y}` : null, renderScale: pt?.renderScale ?? null,
            filter: this.motion.filter, temporal: this.motion.temporal, bounces: this.bounces,
            timestamps: !!this._timestamps, cautious: this.gpuCautious,
        };
    }

    // Current state for the status display.
    // phase: unsupported | off | waiting | bvh | compiling | error | preview | rendering | denoise-loading | denoising | done
    getStatus() {
        const status = {
            phase: 'off',
            samples: 0,
            maxSamples: this.maxSamples,
            progress: 0,
            denoise: this.denoiseEnabled,
        };
        if (!this.supported) return { ...status, phase: 'unsupported' };
        if (!this.enabled) return status;
        if (this.building) return { ...status, phase: 'bvh' };
        if (!this.ready) return { ...status, phase: 'waiting' };
        if (this.error) return { ...status, phase: 'error', error: this.error };
        if (this.suspended) return { ...status, phase: 'suspended' };

        const pt = this.pathTracer;
        if (this.interacting) return { ...status, phase: 'preview' };
        if (this._compiling) return { ...status, phase: 'compiling' };
        if (this._motion) return { ...status, phase: 'motion' };

        const counts = pt._lastSampleCounts;
        status.samples = counts.avg;
        status.progress = pt.maxSamples > 0 ? Math.min(counts.avg / pt.maxSamples, 1) : 0;

        if (this._isDone()) {
            if (this._fadeSettled()) return { ...status, phase: 'done', progress: 1 };
            // final image still fading in (_fade)
            return { ...status, phase: this.denoiseEnabled ? 'denoising' : 'rendering', progress: 1 };
        }
        // all samples there, the denoiser's shaders are still compiling
        if (this.denoiseEnabled && this._denoisePrep && !this._denoisePrep.done && counts.min >= pt.maxSamples) {
            return { ...status, phase: 'denoise-loading', progress: 0 };
        }
        if (this.denoiseEnabled && this.denoiser.running) {
            return this.denoiseLoading
                ? { ...status, phase: 'denoise-loading', progress: 0 }
                : { ...status, phase: 'denoising', progress: this.denoiseProgress };
        }
        status.phase = 'rendering';
        return status;
    }
}
