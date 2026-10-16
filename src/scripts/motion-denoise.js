// Edge-aware denoiser for the path tracer's noisy images (pathtracer.js): while orbiting (1 sample per pixel at
// reduced resolution) and while the image refines, until OIDN takes over. Own implementation after
//   - Dammertz et al. 2010, "Edge-Avoiding À-Trous Wavelet Transform for fast Global Illumination Filtering"
//   - Schied et al. 2017, "Spatiotemporal Variance-Guided Filtering" (SVGF: demodulated albedo, variance-guided
//     luminance weight, temporal accumulation with geometric reprojection)
//
// Guides (pt-guides.js): position, normal, albedo, circle of confusion – traced with the path tracer's own camera
// and scene data, through mirrors and clear glass to what the pixel shows. So the filter matches the image with
// fisheye, depth of field, reflections, glass, textures and every material.
//
// Passes (render targets at the size of the path traced image), all on demodulated light (colour / albedo – the
// textures are multiplied back at the end and stay sharp; within the blur of depth of field no demodulation):
//   1. temporal (optional, only while orbiting): reproject the history into the current camera (world position →
//      previous camera, perspective or fisheye → previous uv, 2 × 2 taps each checked against the previous
//      position/normal, so silhouettes do not drag along); the history is clamped to the current neighbourhood
//      (reflections on glossy surfaces move differently than the surface – unclamped they left double images),
//      then blended in with 1/n up to maxHistory frames. History = unfiltered accumulation (a = its length).
//   2. variance: per pixel the luminance variance of its 3 × 3 neighbourhood (a)
//   3. à-trous: 5 × 5 B3 spline kernel with growing gaps (1, 2, 4, …), weights: normal similarity, plane
//      distance (does the neighbour lie in the tangent plane? – scale free), luminance difference relative to the
//      local noise (√variance, filtered along); in the blur of depth of field the geometry weights relax
//   4. result: × albedo, alpha 1
import * as THREE from 'three/webgpu';
import { compileAsync } from './shader-compile.js';
import { Fn, texture, uniform, screenUV, vec2, vec3, vec4, float, dot, max, min, abs, exp, pow, sqrt, floor, fract, select,
    mix, clamp, length, atan, tan, saturate, If, getScreenPositionFromClip } from 'three/tsl';

const LUMA = vec3(0.2126, 0.7152, 0.0722);
const B3 = [3 / 8, 1 / 4, 1 / 16];   // B3 spline, index = |offset|

export class MotionDenoiser {
    /**
     * @param {THREE.WebGPURenderer} renderer
     * @param {{ iterations?: number, sigmaNormal?: number, sigmaPlane?: number, sigmaLuminance?: number,
     *   maxHistory?: number, clampGamma?: number, firefly?: number }} options (PATHTRACING.denoiseMotion in config.js)
     */
    constructor(renderer, { iterations = 5, sigmaNormal = 64, sigmaPlane = 0.1, sigmaLuminance = 4, maxHistory = 8,
        clampGamma = 1.5, firefly = 8 } = {}) {
        this.renderer = renderer;
        this.iterations = iterations;
        this.maxHistory = maxHistory;

        const rt = (type = THREE.HalfFloatType) => new THREE.RenderTarget(1, 1, { type, depthBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        this._posPrev = rt(THREE.FloatType);   // copies of the previous frame's guides
        this._normalPrev = rt();
        this._hist = rt();
        this._histPrev = rt();
        this._ping = rt();
        this._pong = rt();
        this._output = rt();
        this._output.texture.minFilter = this._output.texture.magFilter = THREE.LinearFilter;   // on to FSR / the blit
        this._output.texture.name = 'MotionDenoise';
        this._targets = [this._posPrev, this._normalPrev, this._hist, this._histPrev, this._ping, this._pong, this._output];
        // full-screen pass: own plane + camera instead of QuadMesh – QuadMesh swaps in its vertex node only during
        // render(), the asynchronous shader build (compile()) would see the material without it; the shaders read
        // screenUV, independent of the geometry's uvs
        this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this._quad.name = 'MotionDenoise';
        this._quad.frustumCulled = false;
        this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._historyOk = false;           // _histPrev/_posPrev/_normalPrev belong to the previous frame
        this._prev = { view: new THREE.Matrix4(), proj: new THREE.Matrix4(), pos: new THREE.Vector3(), k: 1, aspect: 1 };

        const u = this.u = {
            texel: uniform(new THREE.Vector2()),
            size: uniform(new THREE.Vector2()),
            prevView: uniform(new THREE.Matrix4()),
            prevProj: uniform(new THREE.Matrix4()),
            prevCamPos: uniform(new THREE.Vector3()),
            prevK: uniform(1),                // fisheye of the previous frame (1 = perspective)
            prevAspect: uniform(1),
            tanLimit: uniform(1),
            maxHistory: uniform(maxHistory),
        };
        // inputs set per frame: path traced image, guides (storage textures of pt-guides.js)
        const src = this._src = texture(null);
        const gPos = this._gPos = texture(null), gNormal = this._gNormal = texture(null), gAlbedo = this._gAlbedo = texture(null);
        const posPrev = texture(this._posPrev.texture), normalPrev = texture(this._normalPrev.texture);
        const histPrev = texture(this._histPrev.texture);
        const luma = c => dot(c, LUMA);
        // fireflies: limit the luminance (keeps the hue) – one bright sample would otherwise become a blob
        const tame = c => c.mul(min(float(1), float(firefly).div(max(luma(c), 1e-6))));
        // albedo used for (de)modulation: none over the background and within the blur of depth of field (the image
        // is blurred there, the guide albedo sharp)
        const modAlbedo = p => {
            const a = gAlbedo.sample(p).rgb, surface = gPos.sample(p).w.greaterThan(0);
            const blur = saturate(gNormal.sample(p).w.sub(0.5));
            return select(surface, mix(max(a, vec3(0.01)), vec3(1), blur), vec3(1));
        };
        const demod = p => tame(src.sample(p).rgb).div(modAlbedo(p));

        // uv in the previous camera (perspective or fisheye); x < 0 = not visible there
        const prevUv = P => {
            const v = u.prevView.mul(vec4(P, 1)).xyz.toVar();
            const clip = u.prevProj.mul(vec4(v, 1));
            const persp = select(clip.w.greaterThan(0), getScreenPositionFromClip(clip), vec2(-1));
            const len = length(v.xy);
            const half = atan(len, v.z.negate()).div(u.prevK);
            const rho = tan(min(half, 1.5)).div(u.tanLimit);
            const ndc = v.xy.div(max(len, 1e-9)).mul(rho).div(vec2(u.prevAspect, 1));
            const fish = select(half.lessThan(Math.PI / 2 - 1e-3), vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)), vec2(-1));
            return select(u.prevK.greaterThan(1), fish, persp);
        };

        // 1. temporal accumulation (demodulated)
        this._temporalMaterial = new THREE.NodeMaterial();
        this._temporalMaterial.fragmentNode = Fn(() => {
            const p = screenUV;
            const raw = demod(p).toVar();
            const g = gPos.sample(p);
            const out = vec4(raw, 1).toVar();
            If(g.w.greaterThan(0), () => {
                const P = g.xyz;
                const n = gNormal.sample(p).xyz;
                const dist = length(P.sub(u.prevCamPos));
                const f = prevUv(P).mul(u.size).sub(0.5);
                const base = floor(f), t = fract(f);
                const sum = vec4(0).toVar(), wsum = float(0).toVar();
                for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                    const tc = base.add(vec2(dx + 0.5, dy + 0.5)).mul(u.texel);
                    const w = (dx ? t.x : t.x.oneMinus()).mul(dy ? t.y : t.y.oneMinus());
                    const pp = posPrev.sample(tc);
                    const ok = tc.x.greaterThan(0).and(tc.x.lessThan(1)).and(tc.y.greaterThan(0)).and(tc.y.lessThan(1))
                        .and(pp.w.greaterThan(0))
                        .and(length(pp.xyz.sub(P)).lessThan(dist.mul(0.02)))
                        .and(dot(normalPrev.sample(tc).xyz, n).greaterThan(0.9));
                    const wk = select(ok, w, float(0));
                    sum.addAssign(histPrev.sample(tc).mul(wk));
                    wsum.addAssign(wk);
                }
                If(wsum.greaterThan(0.05), () => {
                    const hist = sum.div(wsum);
                    // neighbourhood of the current frame: mean ± γ·σ per channel
                    const m1 = vec3(0).toVar(), m2 = vec3(0).toVar();
                    for (let y = -1; y <= 1; y++) {
                        for (let x = -1; x <= 1; x++) {
                            const c = x || y ? demod(p.add(vec2(x, y).mul(u.texel))) : raw;
                            m1.addAssign(c);
                            m2.addAssign(c.mul(c));
                        }
                    }
                    const mean = m1.div(9);
                    const sigma = sqrt(max(m2.div(9).sub(mean.mul(mean)), 0)).mul(clampGamma);
                    const h = clamp(hist.rgb, mean.sub(sigma), mean.add(sigma));
                    const len = min(hist.a.add(1), u.maxHistory);
                    out.assign(vec4(mix(h, raw, float(1).div(len)), len));
                });
            });
            return out;
        })();

        // 2. demodulated light + luminance variance of the 3 × 3 neighbourhood – two materials: from the path
        // traced image (float, value per frame) or from the history (half float); one node switching between both
        // texture kinds would need another shader at the switch
        const variance = sample => {
            const material = new THREE.NodeMaterial();
            material.fragmentNode = Fn(() => {
                const p = screenUV;
                const s1 = float(0).toVar(), s2 = float(0).toVar();
                for (let y = -1; y <= 1; y++) {
                    for (let x = -1; x <= 1; x++) {
                        const l = luma(sample(p.add(vec2(x, y).mul(u.texel))));
                        s1.addAssign(l);
                        s2.addAssign(l.mul(l));
                    }
                }
                const mean = s1.div(9);
                return vec4(sample(p), max(s2.div(9).sub(mean.mul(mean)), 0));
            })();
            return material;
        };
        const hist = texture(this._hist.texture);
        this._varianceSource = variance(demod);
        this._varianceHist = variance(p => hist.sample(p).rgb);

        // 3. à-trous iterations: ping → pong → ping …, gap 2^i
        const atrous = (input, step) => {
            const material = new THREE.NodeMaterial();
            const tex = texture(input.texture);
            material.fragmentNode = Fn(() => {
                const p = screenUV;
                const gp = gPos.sample(p), np = gNormal.sample(p);
                const cp = tex.sample(p);
                const lp = luma(cp.rgb);
                const bgP = gp.w.lessThanEqual(0);
                // variance of the centre, smoothed 3 × 3 (Gaussian) – a single noisy value would decide too much
                let v = float(0);
                for (let y = -1; y <= 1; y++) {
                    for (let x = -1; x <= 1; x++) {
                        v = v.add(tex.sample(p.add(vec2(x, y).mul(u.texel))).a.mul((x ? 0.25 : 0.5) * (y ? 0.25 : 0.5)));
                    }
                }
                const sigmaL = sqrt(max(v, 0)).mul(sigmaLuminance).add(1e-4).toVar();
                const sum = vec4(cp.rgb.mul(B3[0] * B3[0]), B3[0] * B3[0]).toVar();
                const varSum = cp.a.mul((B3[0] * B3[0]) ** 2).toVar();
                for (let y = -2; y <= 2; y++) {
                    for (let x = -2; x <= 2; x++) {
                        if (!x && !y) continue;
                        const q = p.add(vec2(x * step, y * step).mul(u.texel));
                        const gq = gPos.sample(q), nq = gNormal.sample(q);
                        const cq = tex.sample(q);
                        const bgQ = gq.w.lessThanEqual(0);
                        const wl = exp(abs(lp.sub(luma(cq.rgb))).div(sigmaL).negate());
                        const wn = pow(max(dot(np.xyz, nq.xyz), 0), sigmaNormal);
                        const d = gq.xyz.sub(gp.xyz);
                        const plane = abs(dot(np.xyz, d)).div(max(length(d), 1e-9));
                        const wz = exp(plane.div(sigmaPlane).negate());
                        // surfaces only with surfaces, background only with background of a similar direction (guide
                        // normal = direction it is seen in: reflected backgrounds keep their detail and do not blur
                        // into the backdrop beside the mirror)
                        const wd = pow(max(dot(np.xyz, nq.xyz), 0), 1024);
                        const sharp = select(bgP, select(bgQ, wd, float(0)), select(bgQ, float(0), wn.mul(wz)));
                        // depth of field: where the image is blurred over more than the gap, geometry does not separate
                        const relax = saturate(max(np.w, nq.w).div(step).sub(1));
                        const w = mix(sharp, float(1), relax).mul(wl).mul(B3[Math.abs(x)] * B3[Math.abs(y)]);
                        sum.addAssign(vec4(cq.rgb.mul(w), w));
                        varSum.addAssign(cq.a.mul(w).mul(w));
                    }
                }
                return vec4(sum.rgb.div(sum.w), varSum.div(sum.w.mul(sum.w)));
            })();
            return material;
        };
        this._atrous = Array.from({ length: iterations }, (_, i) => atrous(i % 2 ? this._pong : this._ping, 2 ** i));

        // 4. result: × albedo, alpha 1
        const result = this._result = texture(null);
        this._resolveMaterial = new THREE.NodeMaterial();
        this._resolveMaterial.fragmentNode = vec4(result.sample(screenUV).rgb.mul(modAlbedo(screenUV)), 1);

        this._passes = [this._temporalMaterial, this._varianceSource, this._varianceHist, ...this._atrous, this._resolveMaterial];
        for (const m of this._passes) { m.depthTest = m.depthWrite = false; m.toneMapped = false; }
        // target of each full-screen material (for compile())
        this._passTargets = new Map([[this._temporalMaterial, this._hist], [this._varianceSource, this._ping], [this._varianceHist, this._ping],
            [this._resolveMaterial, this._output], ...this._atrous.map((m, i) => [m, i % 2 ? this._ping : this._pong])]);
    }

    _setInputs(source, guides) {
        this._src.value = source;
        this._gPos.value = guides.position;
        this._gNormal.value = guides.normal;
        this._gAlbedo.value = guides.albedo;
    }

    /**
     * Compile the full-screen passes asynchronously (the first render() otherwise builds them synchronously:
     * ~170 ms main thread). source = a texture like the path traced image, guides = pt-guides.js outputs.
     * @returns {Promise}
     */
    compile(source, guides) {
        const r = this.renderer, jobs = [];
        const target = r.getRenderTarget();
        try {
            this._setInputs(source, guides);
            this._result.value ??= this._ping.texture;
            for (const [material, t] of this._passTargets) {
                r.setRenderTarget(t);
                this._quad.material = material;
                jobs.push(compileAsync(r, this._quad, this._quadCamera));
            }
        } finally {
            r.setRenderTarget(target);
        }
        return Promise.all(jobs);
    }

    /** Forget the history (next frame starts without the previous one) */
    resetHistory() {
        this._historyOk = false;
    }

    /**
     * Filter the path traced image `source` (linear HDR) – returns the filtered texture (same size).
     * @param {THREE.Texture} source
     * @param {{ guides: { position, normal, albedo }, camera: THREE.Camera, lens: { k, aspect, tanLimit },
     *   iterations: number, temporal: boolean }} opts guides of this frame's view (pt-guides.js), lens = fisheye
     *   parameters of the camera (fisheyeParams())
     */
    render(source, { guides, camera, lens, iterations, temporal }) {
        const r = this.renderer;
        r.initTexture(source);
        const w = source.image?.width ?? source.width, h = source.image?.height ?? source.height;
        let resized = false;
        for (const t of this._targets) {
            if (t.width !== w || t.height !== h) { t.setSize(w, h); resized = true; }
        }
        if (resized) {
            this._historyOk = false;
            // targets only written by copies (history) get their GPU texture at the new size here – otherwise the
            // copy hit the old one (1 × 1 after compile()) and the command buffer was invalid
            for (const t of this._targets) r.initRenderTarget(t);
        }
        const u = this.u;
        u.texel.value.set(1 / w, 1 / h);
        u.size.value.set(w, h);
        u.maxHistory.value = this.maxHistory;
        this._setInputs(source, guides);

        const target = r.getRenderTarget(), autoClear = r.autoClear, mrt = r.getMRT();
        const clearColor = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
        r.autoClear = true;
        r.setMRT(null);
        try {
            const draw = (t, material) => { r.setRenderTarget(t); this._quad.material = material; r.render(this._quad, this._quadCamera); };
            let fromHistory = false;
            if (temporal) {
                const p = this._prev;
                u.prevView.value.copy(p.view);
                u.prevProj.value.copy(p.proj);
                u.prevCamPos.value.copy(p.pos);
                u.prevK.value = p.k;
                u.prevAspect.value = p.aspect;
                u.tanLimit.value = lens.tanLimit;
                // without valid history: the previous positions are "background" everywhere → nothing reprojects
                if (!this._historyOk) { r.setRenderTarget(this._posPrev); r.setClearColor(0x000000, 0); r.clear(); r.setClearColor(clearColor, clearAlpha); }
                draw(this._hist, this._temporalMaterial);
                r.copyTextureToTexture(this._hist.texture, this._histPrev.texture);
                r.copyTextureToTexture(guides.position, this._posPrev.texture);
                r.copyTextureToTexture(guides.normal, this._normalPrev.texture);
                p.view.copy(camera.matrixWorldInverse);
                p.proj.copy(camera.projectionMatrix);
                p.pos.setFromMatrixPosition(camera.matrixWorld);
                p.k = lens.k;
                p.aspect = lens.aspect;
                this._historyOk = true;
                fromHistory = true;
            } else this._historyOk = false;

            draw(this._ping, fromHistory ? this._varianceHist : this._varianceSource);
            const n = Math.min(Math.max(Math.round(iterations), 0), this._atrous.length);
            for (let i = 0; i < n; i++) draw(i % 2 ? this._ping : this._pong, this._atrous[i]);
            this._result.value = (n % 2 ? this._pong : this._ping).texture;
            draw(this._output, this._resolveMaterial);
            return this._output.texture;
        } finally {
            r.setMRT(mrt);
            r.setRenderTarget(target);
            r.autoClear = autoClear;
        }
    }

    dispose() {
        for (const t of this._targets) t.dispose();
        this._quad.geometry.dispose();
        for (const m of this._passes) m.dispose();
    }
}
