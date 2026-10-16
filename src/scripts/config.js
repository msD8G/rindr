// Central default settings of the viewer – adjust here.
// The values apply at startup; in the UI (Settings → Path tracing) they can be changed afterwards
// as usual, a saved scene state overrides them as well.

export const PATHTRACING = {
    enabled: false,             // path tracing on at startup (= HQ view instead of Default; WebGPU only)
    bounces: 8,                 // light paths: number of reflections/refractions per path (GUI: 1–20)
    maxSamples: 32,             // samples per pixel, then stop + denoise (GUI: 1–256)
    renderScale: 1,           // resolution relative to the window (0.25–1); < 1 is upscaled via FSR
    filterGlossyFactor: 1,      // glossy filter 0–1: dampens glossy noise (fireflies), slightly softer
    denoise: true,              // OIDN denoising after maxSamples
    denoiseGuideSamples: 8,     // rays per pixel of OIDN's albedo/normal guides (antialiasing, depth of field; pt-guides.js)
    upscale: true,              // FSR upscaling (only useful with renderScale < 1)
    sharpness: 1,               // FSR sharpness 0–2

    // While orbiting/zooming (HQ): keep path tracing, but heavily reduced – instead of the raster preview
    motion: {
        enabled: true,          // false = raster preview while orbiting
        renderScale: 0.35,      // resolution relative to the window (FSR upscales)
        bounces: 3,             // light paths while orbiting
        samples: 1,             // samples per pixel and frame (more = calmer, but slower)
        holdMs: 250,            // stays reduced this long after release (mouse wheel: no switching per notch)
        // image filter while orbiting and while the image refines (until the final image), instead of showing the
        // noise: 'kuwahara' paints over it (kuwahara.js, look: PATHTRACING.kuwahara), 'denoise' smooths it edge-aware
        // (motion-denoise.js, PATHTRACING.denoiseMotion), 'off'
        filter: 'kuwahara',
        temporal: false,        // 'denoise': also blend in the previous frames (reprojected) while orbiting
    },

    // Kuwahara look (painterly while orbiting and while the image refines) – values chosen by the user
    kuwahara: {
        radius: 4,              // brush size in pixels of the reduced image while orbiting; afterwards the same size
                                // on screen, shrinking with the samples (∝ 1/√samples, 0 at maxSamples)
        eccentricity: 2.5,      // 0 = round strokes, larger = stretched along edges
        sharpness: 0,           // 0 = all sectors equal (soft strokes); > 0 calm areas win over noisy ones
        maxRadius: 8,           // limit in pixels of the full-resolution image (cost ∝ radius²)
    },

    // soft transition between the successive images (orbit preview → first full sample → refinement stages →
    // denoised result, image-fade.js): time constant in ms (~95 % after 3×), 0 = jump as before
    fadeMs: 80,

    // Edge-aware denoiser (motion-denoise.js: à-trous wavelet + optional temporal accumulation)
    denoiseMotion: {
        iterations: 5,          // à-trous passes while orbiting (gaps 1, 2, 4, 8, 16 px); while refining fewer with
                                // the samples (iterations − log2(samples), at least 2 until the final image)
        sigmaNormal: 64,        // normal weight: cos(angle)^sigmaNormal
        sigmaPlane: 0.1,        // plane weight: how far a neighbour may leave the tangent plane (sin of the angle)
        sigmaLuminance: 4,      // luminance weight: allowed difference in units of the local noise (√variance)
        maxHistory: 8,          // temporal: at most this many frames blended (newest with ≥ 1/maxHistory)
        clampGamma: 1.5,        // temporal: history clamped to mean ± clampGamma·σ of the current neighbourhood
        firefly: 8,             // luminance limit per sample (linear) – single bright samples would become blobs
    },

    // Technical (benchmark with ?bench in the URL)
    megakernel: true,           // megakernel instead of wavefront – ~4× faster on the tested GPU
    frameBudget: 1_000_000,     // upper limit of paths per pass (library: 250 000) – the actual budget follows the
                                // GPU time per frame (pathtracer.js _adapt): starts at startFrameBudget, aims at
                                // frameTargetMs. Fixed 1 M fitted one GPU at Full HD; at 4K / on slower GPUs single
                                // dispatches came close to the GPU watchdog (Windows TDR ~2 s → device lost)
    startFrameBudget: 65_536,   // the very first dispatch runs before any measurement – small, it grows within frames
    minFrameBudget: 32_768,
    frameTargetMs: 50,          // GPU time per frame the path tracer aims at (refining and orbiting)
    firstSampleMs: 250,         // after a restart the first sample is computed in one frame up to about this long
    countInterval: 200,         // ms between two sample counts for the status display (GPU readback)
    asyncCompileMinChars: 32_000,   // compute shaders from this WGSL size are compiled asynchronously (megakernel
                                    // ~110 KB: synchronous ~4 s without shader cache, the page froze meanwhile)
};

// Materials: editing (parameters, node editor, rename, new, copy) hidden for now –
// list (scene/library), drag & drop, assign, select objects, delete and import/export remain.
// Existing node graphs (e.g. from imported materials or scenes) are still applied.
export const MATERIALS = {
    editing: false,
    importExport: false,   // JSON import/export buttons in the material panel (comes back later)
};

// Scene files: "save scene" / "open scene" buttons in the toolbar hidden for now (still buggy, user Oct. 2026 –
// comes back later). Saving/restoring code stays; dropping a scene file still opens it.
export const SCENE = {
    saveOpen: false,
};

// Opening large models (STEP): protection against running out of memory. Before tessellating, the
// triangle count is estimated from a sample of the faces (unique triangles – instances share geometry).
export const IMPORT = {
    triangleBudget: 10_000_000,   // opening: estimate above this → quality automatically coarser (down to "coarse")
    triangleLimit: 30_000_000,    // hard limit: not started beyond it (estimate) or aborted while tessellating –
                                  // opening then retries one level coarser, a quality change keeps the old model
    instancing: true,             // identical solids that the file does not declare as reused share one geometry
                                  // (shape comparison after tessellating, shape-match.js) – saves RAM/GPU memory
    // binary FBX is read by an own lean reader (fbx/fbx-parse.js, typed arrays). Animated / skinned FBX up to this
    // size still go to three.js' FBXLoader (animation, skinning, blend shapes) – it needs roughly 6–8× the file size
    // in JS heap, and all JS heaps of a tab share one 4 GB area in Chrome (independent of the computer's RAM)
    fbxLoaderMaxBytes: 256 * 2 ** 20,
};

// Soft transition of the whole picture on changes (screen-fade.js): HDRI, lens effects, depth of field, materials,
// visibility, view mode … – the last frame fades out over the new ones (all view modes; not while dragging)
export const TRANSITION = {
    ms: 300,               // duration (smoothstep), 0 = jump as before
};

// Raster view (Basic/Default): meshes with the same geometry + material are drawn as one InstancedMesh
// (render-batcher.js) – large assemblies need hundreds instead of thousands of draw calls. Test: ?batching=0
export const RASTER = {
    batching: true,
};

// Gaussian splats (.ply / .sog, splat/): memory protection for the spherical harmonics (view-dependent
// colour). Degree 3 costs 48 bytes per splat on the GPU – large scenes are reduced to a lower degree so that
// the SH data stays within the budget (13 M splats: degree 2). Positions/shape/colour: 32 bytes per splat.
export const SPLATS = {
    shDegree: 3,          // highest SH degree that is kept (0 = no view-dependent colour)
    shBudgetMB: 512,      // GPU memory for the SH data
    unitScale: 1000,      // file units → mm (3DGS scenes are roughly in metres)
    // after loading the camera slowly circles the scene until the user takes over: seconds per turn
    // (object: around it, room: panning on the spot); 0 = off
    autoRotate: { object: 40, indoor: 60 },
    // reveal while loading: shape ('sphere' centre → out, 'plane' bottom → up, 'screen' circle on screen), edge band
    // (share of the robust radius), pulse in the band: glow (brightening), start size (× own size, at least
    // `minStartSize` × robust radius per axis – fine scans have tiny splats, 2× tiny stayed tiny), glow colour
    // (null = own colour)
    reveal: { mode: 'sphere', band: 0.25, glow: 0.5, startSize: 1.5, minStartSize: 0.0, glowColor: '#ffffff' },
};

// "About" in the settings menu (version comes from package.json)
export const ABOUT = {
    author: 'Marco Schrenk',                          // author name
    email: 'mail@marco-schrenk.de',
};

// AI rendering (ki-gemini.js): the browser calls Gemini directly with the user's own key (settings → AI).
// Google renames models often – see https://ai.google.dev/gemini-api/docs/image-generation;
// the model can also be changed in the settings (per browser).
export const KI = {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    model: 'gemini-nano-banana-2.1',
    size: '2K',                       // default output resolution
    sizes: ['1K', '2K', '4K'],
    keyUrl: 'https://aistudio.google.com/apikey',   // where to get a key (link in the settings)
};
