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
import { Vector2 } from 'three/webgpu';
import { PATHTRACING } from './config.js';   // defaults (samples, resolution, bounces, …)
import { t } from './i18n.js';
import { debugLog } from './log.js';

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
    }

    /** Load and create the path tracer (once; later calls return the same promise). false = not supported */
    load() {
        if (!this.supported) return Promise.resolve(false);
        this._loading ??= Promise.all([import('three-gpu-pathtracer/webgpu'), import('oidn-web'), import('@pmndrs/upscaler')])
            .then(([ptLib, oidn, upscalerLib]) => { this._create(ptLib, oidn, upscalerLib); return true; })
            .catch(err => { this._loading = null; throw err; });
        return this._loading;
    }

    _create({ WebGPUPathTracer, OIDNDenoiser, FSRUpscaler }, { initUNetFromURL }, { Upscaler }) {
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
        pt.setDenoiser(this.denoiseEnabled ? this.denoiser : null);
        pt.setUpscaler(this.upscaleEnabled ? this.upscaler : null);
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
        this.upscaleEnabled = enabled;
        this.pathTracer?.setUpscaler(enabled ? this.upscaler : null);
    }

    // Take over the scene. The BVHs must already be attached to the geometries (geometry.boundsTree),
    // otherwise the path tracer builds them synchronously on the main thread.
    async setScene(scene, camera) {
        if (!this.supported) return;
        this.ready = false;
        this.building = true;
        this.error = null;
        try {
            await this.load();   // usually preloaded already
            // wait one frame so the status display becomes visible
            await new Promise(resolve => requestAnimationFrame(resolve));
            const t0 = performance.now();
            this.pathTracer.setScene(scene, camera);
            // switch only now: useMegakernel() needs the camera and BVH data of the scene
            if (PATHTRACING.megakernel && !this._megakernel) {
                this._megakernel = true;
                this.pathTracer.useMegakernel(true);
                this.pathTracer.updateMaterials();   // useMegakernel() does not carry over textures
            }
            this.pathTracer.maxBounces = this.bounces;
            this.pathTracer.frameBudget = PATHTRACING.frameBudget;
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

    // scene.environment / background changed
    updateEnvironment() {
        if (!this.ready) return;
        this.pathTracer.updateEnvironment();
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
        // motion over (hold time elapsed): back to full quality, restart
        if (this._motion?.end && performance.now() - this._motion.end > this.motion.holdMs) this._exitMotion();
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
            if (this._fullFirst) this._renderFirstSample();
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
        if (pt.fadeState < 1) rasterize();

        // update the sample count for the display occasionally (it is a GPU readback)
        const now = performance.now();
        if (!this._isDone() && now - this._lastCount > PATHTRACING.countInterval) {
            this._lastCount = now;
            pt.getSampleCountsAsync();
        }
        return true;
    }

    _canMotion() {
        return this.motion.enabled && this.enabled && this.ready && !this.error && !this.suspended;
    }

    // reduced settings for motion (once per motion; changing the resolution reallocates buffers)
    _enterMotion() {
        if (this._motion) { this._motion.end = 0; return; }
        const pt = this.pathTracer;
        this._motion = { saved: { renderScale: pt.renderScale, bounces: this.bounces, minSamples: pt.minSamples }, end: 0 };
        pt.renderScale = Math.min(this.motion.renderScale, pt.renderScale);
        pt.maxBounces = Math.min(this.motion.bounces, this.bounces);
        pt.minSamples = 0;   // show immediately (otherwise the raster image covers it until the first sample is counted)
    }

    _exitMotion() {
        const m = this._motion;
        if (!m) return;
        this._motion = null;
        const pt = this.pathTracer;
        pt.renderScale = m.saved.renderScale;
        pt.maxBounces = this.bounces;
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
        // the size change otherwise happens only in renderSample()
        const size = this.renderer.getDrawingBufferSize(new Vector2());
        const w = Math.floor(pt.renderScale * size.x), h = Math.floor(pt.renderScale * size.y);
        pt.setSize(w, h);
        const current = inner.getSize(new Vector2());
        if (current.x !== w || current.y !== h) inner.setSize(w, h);
        inner.lowResMode = false;
        for (let i = 0; i < 64; i++) {
            inner.update();
            if (inner._tileProgress === 1) break;
        }
    }

    _isDone() {
        const pt = this.pathTracer;
        if (pt.maxSamples <= 0) return false;
        if (this.denoiseEnabled) return this.denoiser.complete;
        return pt._lastSampleCounts.min >= pt.maxSamples;
    }

    // Current state for the status display.
    // phase: unsupported | off | waiting | bvh | error | preview | rendering | denoise-loading | denoising | done
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
        if (this._motion) return { ...status, phase: 'motion' };

        const counts = pt._lastSampleCounts;
        status.samples = counts.avg;
        status.progress = pt.maxSamples > 0 ? Math.min(counts.avg / pt.maxSamples, 1) : 0;

        if (this._isDone()) return { ...status, phase: 'done', progress: 1 };
        if (this.denoiseEnabled && this.denoiser.running) {
            return this.denoiseLoading
                ? { ...status, phase: 'denoise-loading', progress: 0 }
                : { ...status, phase: 'denoising', progress: this.denoiseProgress };
        }
        status.phase = 'rendering';
        return status;
    }
}
