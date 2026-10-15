// Anisotropic Kuwahara filter (Kyprianidis, Kang, Döllner 2009: "Image and Video Abstraction by Anisotropic
// Kuwahara Filtering"; polynomial sector weights as in Kyprianidis 2010 / Acerola's implementation).
// Used by the path tracer (pathtracer.js): while orbiting the low-resolution image with 1 sample per pixel is
// painted over instead of shown noisy – the noise disappears into brush strokes that follow the edges; afterwards
// the brush shrinks with the accumulating samples until the final image.
//
// Passes (render targets at the size of the input):
//   1. structure tensor (Sobel per channel) of the image
//   2. + 3. tensor smoothed (separable Gaussian) – direction and anisotropy of the local structure
//   4. Kuwahara: per pixel an ellipse along the structure (eccentricity: how strongly it stretches along
//      edges), split into 8 sectors; per sector mean (+ variance with sharpness > 0: the calm sectors dominate;
//      sharpness 0 = all sectors equal – the user's choice, softer strokes, no variance needed)
// The sector statistics (variance, structure tensor) use compressed colours (c / (1 + luminance)) – the path
// tracer's HDR fireflies would otherwise dominate them; the colour itself is averaged linearly (clamped), so the
// image keeps its brightness (averaging compressed values darkened it and swallowed the highlights).
import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, vec2, vec3, vec4, float, int, dot, max, min, sqrt, atan, cos, sin, exp, pow, abs, clamp, select, length, normalize, Loop, If } from 'three/tsl';

const LUMA = vec3(0.2126, 0.7152, 0.0722);
const compress = c => c.div(dot(c, LUMA).add(1));
const FIREFLY = 16;   // linear colour clamp for the averages

// Gaussian for the tensor smoothing (σ = 2 texels)
const BLUR_RADIUS = 6;
const BLUR = (() => {
    const w = [];
    for (let i = -BLUR_RADIUS; i <= BLUR_RADIUS; i++) w.push(Math.exp(-(i * i) / (2 * 2 * 2)));
    const sum = w.reduce((a, b) => a + b, 0);
    return w.map(v => v / sum);
})();

export class KuwaharaFilter {
    /**
     * @param {{ eccentricity?: number, sharpness?: number, maxRadius?: number }} options
     *   eccentricity: 0 = circular, larger = stretched further along edges; sharpness: how strongly calm sectors
     *   win (q, 0 = equal – fixed at construction); maxRadius: limit of the kernel radius (cost ∝ radius²)
     */
    constructor(renderer, { eccentricity = 1, sharpness = 8, maxRadius = 8 } = {}) {
        this.renderer = renderer;
        this.eccentricity = eccentricity;
        this.sharpness = sharpness;
        this.maxRadius = maxRadius;

        const rt = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        this._tensor = rt();
        this._tmp = rt();
        this._output = rt();
        this._output.texture.minFilter = this._output.texture.magFilter = THREE.LinearFilter;
        this._output.texture.name = 'Kuwahara';
        this._quad = new THREE.QuadMesh();
        this._quad.name = 'Kuwahara';

        const u = this.u = {
            texel: uniform(new THREE.Vector2()),
            radius: uniform(1),
            alpha: uniform(1),
            q: uniform(sharpness),
        };
        const src = this._src = texture(null);

        // 1. structure tensor (E, F, G) from Sobel gradients of all three channels
        this._tensorMaterial = new THREE.NodeMaterial();
        this._tensorMaterial.fragmentNode = Fn(() => {
            const p = uv();
            const t = (x, y) => compress(src.sample(p.add(vec2(x, y).mul(u.texel))).rgb);
            const gx = t(1, -1).add(t(1, 0).mul(2)).add(t(1, 1)).sub(t(-1, -1)).sub(t(-1, 0).mul(2)).sub(t(-1, 1)).mul(0.25);
            const gy = t(-1, 1).add(t(0, 1).mul(2)).add(t(1, 1)).sub(t(-1, -1)).sub(t(0, -1).mul(2)).sub(t(1, -1)).mul(0.25);
            return vec4(dot(gx, gx), dot(gx, gy), dot(gy, gy), 1);
        })();

        // 2./3. separable Gaussian: tensor → tmp (horizontal) → tensor (vertical)
        const blur = (input, step) => {
            const material = new THREE.NodeMaterial();
            const tex = texture(input.texture);
            material.fragmentNode = Fn(() => {
                const p = uv();
                let sum = vec3(0);
                BLUR.forEach((w, k) => {
                    sum = sum.add(tex.sample(p.add(step.mul(k - BLUR_RADIUS))).xyz.mul(w));
                });
                return vec4(sum, 1);
            })();
            return material;
        };
        this._blurH = blur(this._tensor, vec2(u.texel.x, 0));
        this._blurV = blur(this._tmp, vec2(0, u.texel.y));
        const tensorIn = texture(this._tensor.texture);

        // 4. Kuwahara on the ellipse of the smoothed tensor
        this._kuwaharaMaterial = new THREE.NodeMaterial();
        this._kuwaharaMaterial.fragmentNode = Fn(() => {
            const p = uv();
            const tn = tensorIn.sample(p);
            const E = tn.x, F = tn.y, G = tn.z;
            const root = sqrt(E.sub(G).mul(E.sub(G)).add(F.mul(F).mul(4)));
            const l1 = E.add(G).add(root).mul(0.5), l2 = E.add(G).sub(root).mul(0.5);
            const tv = vec2(l1.sub(E), F.negate());
            const dir = select(length(tv).greaterThan(1e-8), normalize(tv), vec2(0, 1));
            const phi = atan(dir.y, dir.x).negate();
            const A = select(l1.add(l2).greaterThan(1e-8), l1.sub(l2).div(l1.add(l2)), float(0));
            // ellipse: stretched along the edge by the anisotropy A, alpha = 1 / eccentricity
            const a = u.radius.mul(clamp(u.alpha.add(A).div(u.alpha), 0.1, 2));
            const b = u.radius.mul(clamp(u.alpha.div(u.alpha.add(A)), 0.1, 2));
            const cp = cos(phi), sp = sin(phi);
            const maxX = int(sqrt(a.mul(a).mul(cp.mul(cp)).add(b.mul(b).mul(sp.mul(sp)))));
            const maxY = int(sqrt(a.mul(a).mul(sp.mul(sp)).add(b.mul(b).mul(cp.mul(cp)))));
            // polynomial sector weights (zero crossing ~0.58 rad)
            const zeta = float(1).div(u.radius);
            const zeroCross = 0.58;
            const eta = zeta.add(Math.cos(zeroCross)).div(Math.sin(zeroCross) ** 2);
            const m = Array.from({ length: 8 }, () => vec4(0).toVar());   // linear colour · weight, weight
            const mc = Array.from({ length: 8 }, () => vec3(0).toVar());  // compressed colour · weight
            const s = Array.from({ length: 8 }, () => vec3(0).toVar());   // compressed colour² · weight
            const useVariance = sharpness > 0;
            Loop({ start: maxY.negate(), end: maxY, type: 'int', condition: '<=', name: 'y' }, ({ y }) => {
                Loop({ start: maxX.negate(), end: maxX, type: 'int', condition: '<=', name: 'x' }, ({ x }) => {
                    const xf = float(x), yf = float(y);
                    // SR · (x, y): rotate into the ellipse's frame, scale to the unit disc (radius 0.5)
                    const v = vec2(cp.mul(xf).sub(sp.mul(yf)).mul(0.5).div(a), sp.mul(xf).add(cp.mul(yf)).mul(0.5).div(b)).toVar();
                    If(dot(v, v).lessThanEqual(0.25), () => {
                        const lin = min(src.sample(p.add(vec2(xf, yf).mul(u.texel))).level(0).rgb, FIREFLY).toVar();
                        const c = useVariance ? compress(lin).toVar() : null;
                        const w = [];
                        const weights = vv => {
                            const vxx = zeta.sub(eta.mul(vv.x).mul(vv.x)), vyy = zeta.sub(eta.mul(vv.y).mul(vv.y));
                            const sq = z => { const k = max(z, 0); return k.mul(k); };
                            return [sq(vv.y.add(vxx)), sq(vv.x.negate().add(vyy)), sq(vv.y.negate().add(vxx)), sq(vv.x.add(vyy))];
                        };
                        const w0 = weights(v);
                        const vr = vec2(v.x.sub(v.y), v.x.add(v.y)).mul(Math.SQRT1_2);
                        const w1 = weights(vr);
                        for (let k = 0; k < 4; k++) w.push(w0[k], w1[k]);   // sectors 0, 1, 2, … alternate between both frames
                        let sum = float(0);
                        for (const wk of w) sum = sum.add(wk);
                        const g = exp(dot(v, v).mul(-3.125)).div(max(sum, 1e-6));
                        for (let k = 0; k < 8; k++) {
                            const wk = w[k].mul(g);
                            m[k].addAssign(vec4(lin.mul(wk), wk));
                            if (!useVariance) continue;
                            mc[k].addAssign(c.mul(wk));
                            s[k].addAssign(c.mul(c).mul(wk));
                        }
                    });
                });
            });
            // calm sectors (low variance) dominate
            let out = vec4(0);
            for (let k = 0; k < 8; k++) {
                const n = max(m[k].w, 1e-6);
                if (!useVariance) { out = out.add(vec4(m[k].rgb.div(n), 1)); continue; }
                const meanC = mc[k].div(n);
                const variance = abs(s[k].div(n).sub(meanC.mul(meanC)));
                const sigma2 = variance.r.add(variance.g).add(variance.b);
                const wk = float(1).div(pow(min(sigma2.mul(8000), 1e4), u.q.mul(0.5)).add(1));
                out = out.add(vec4(m[k].rgb.div(n).mul(wk), wk));
            }
            return vec4(out.rgb.div(max(out.w, 1e-6)), 1);
        })();
    }

    /** Filter `source` (texture of the path tracer's output) with the kernel radius in its pixels – returns the
     *  filtered texture (same size) */
    render(source, radius) {
        const r = this.renderer;
        r.initTexture(source);
        const w = source.image?.width ?? source.width, h = source.image?.height ?? source.height;
        for (const t of [this._tensor, this._tmp, this._output]) if (t.width !== w || t.height !== h) t.setSize(w, h);
        const u = this.u;
        u.texel.value.set(1 / w, 1 / h);
        u.radius.value = Math.min(Math.max(radius, 0.5), this.maxRadius);
        u.alpha.value = 1 / Math.max(this.eccentricity, 1e-3);
        u.q.value = this.sharpness;
        this._src.value = source;

        const target = r.getRenderTarget(), autoClear = r.autoClear;
        r.autoClear = true;
        const draw = (rt, material) => { r.setRenderTarget(rt); this._quad.material = material; this._quad.render(r); };
        draw(this._tensor, this._tensorMaterial);
        draw(this._tmp, this._blurH);
        draw(this._tensor, this._blurV);
        draw(this._output, this._kuwaharaMaterial);
        r.setRenderTarget(target);
        r.autoClear = autoClear;
        return this._output.texture;
    }

    dispose() {
        for (const t of [this._tensor, this._tmp, this._output]) t.dispose();
        for (const m of [this._tensorMaterial, this._blurH, this._blurV, this._kuwaharaMaterial]) m.dispose();
    }
}
