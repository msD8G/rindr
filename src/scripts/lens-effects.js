// Camera effects (post-processing): bloom, glare, chromatic aberration, light shafts, lens flare – in all view
// modes (image effects on the HDR image); only the depth of field is HQ only.
//
// If an effect is active, the image (raster or path tracer output, both linear/HDR, since no
// tone mapping happens when rendering into a render target) is drawn into a half-float target:
// begin() … end(). end() applies the effects and draws the result as a fullscreen quad onto the
// canvas – via the renderer's normal output path (internal framebuffer target + tone mapping/sRGB),
// exactly as without effects. Highlight and gizmo come afterwards (not blurred).
// Caution: do NOT use RenderPipeline – it draws directly onto the canvas without tone mapping,
// bypassing the internal framebuffer target; that one is then never cleared again, gizmo/highlight (with
// autoClear = false) paint onto the old image and copy it over the new one → frozen image, smearing.
// If both are off, everything stays as before (directly onto the canvas, no extra pass).
//
// - Bloom: BloomNode (three/addons) on the HDR image – threshold in linear luminance, i.e.
//   values above 1 (highlights, emissive surfaces, sun in the HDRI) bloom.
// - Glare (streaks, star rays like in KeyShot): filter out bright spots (threshold) at ¼ resolution
//   (4 bilinear taps = 4×4 average, so small highlights are not lost),
//   then per ray 3 "Kawase streak" passes (4 taps along the direction, spacing 1/4/16 texels,
//   weight = decay^distance) and additively into an accumulation target. Length = decay.
// - Light shafts ("god rays", like GPU Gems 3 "volumetric light scattering" in screen space): the path tracer
//   knows no participating media, so the rays are an effect: bright parts of the image (threshold – the
//   visible sun/bright sky; what an object covers is dark there) at ½ resolution, blurred radially towards the
//   light centre (setShaftSource: brightest point of the HDRI projected into the image, viewer.js) in two
//   passes of 48 samples, additively onto the image. Fades out when the light is behind the camera.
// - Lens flare: from the same light as the shafts (brightest point of the HDRI, setShaftSource), in the
//   style of J. Chapman's "pseudo lens flare": bright parts of the image, only in a soft window around the
//   light (the sun, its bright sky, edges cutting in) → 6 ghosts = copies of it in different sizes on the line
//   light → centre → beyond, a halo ring; red/blue shifted along the direction to the centre (colour fringe),
//   a damped spectral tint, 2× separable Gauss (softness), tinted with the light colour (from the HDRI).
//   Without the window every highlight made ghosts and the tint was a full rainbow → disco; plain analytic
//   discs (tried in between) looked too round; Chapman's fixed steps put the ghosts off-screen when the only
//   source is the sun near the edge.
//   Visibility = share of rays from the camera towards the light (small cone, viewer.js sunVisibility, BVH)
//   that miss the model → the model between camera and sun hides the flare, partially = fainter
//   (setFlareSource). ¼ resolution, 6 passes.
// - Fisheye is not here: the camera's view angle beyond perspective (fisheye.js) – a distortion of the
//   finished image had to zoom in (a fisheye shows more than a perspective camera can capture).
// - Chromatic aberration (lateral): the image is scaled slightly differently per wavelength
//   (red outside, blue inside), 9 spectral samples instead of 3 hard channels → soft colour fringes that
//   increase towards the image edge. Strength 1 = 1 % size difference red/blue at the image edge.
// - Image look (camera panel "Image"): white balance (colour temperature like Lightroom – higher = warmer –
//   plus tint green↔magenta, luminance kept), contrast (power curve around mid grey 0.18 in linear) and
//   saturation – all before tone mapping, on the HDR image, as the last step of the output quad. Exposure and
//   the tone mapping curve are renderer settings (viewer.js). Neutral look = no extra pass.
// - Exports larger than the screen (setPixelScale): glare/shafts/flare targets keep their size relative to
//   the screen version and bloom its resolution scale → effects look the same, only the image is sharper.
import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, vec2, vec3, vec4, float, dot, max, min, pow, length, mix, exp, smoothstep, cos, normalize } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const SPECTRUM = 9;
// weights per spectral sample (t = 0 blue … 1 red), normalised to sum 1 per channel → white stays white
const WEIGHTS = (() => {
    const g = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
    const ws = [];
    for (let i = 0; i < SPECTRUM; i++) {
        const t = i / (SPECTRUM - 1);
        ws.push([g(t, 0.85, 0.28), g(t, 0.5, 0.22), g(t, 0.15, 0.28)]);
    }
    const sum = [0, 1, 2].map(k => ws.reduce((s, w) => s + w[k], 0));
    return ws.map(w => w.map((v, k) => v / sum[k]));
})();

export const NEUTRAL_LOOK = { temperature: 6500, tint: 0, contrast: 1, saturation: 1 };

// colour of a black body (Tanner Helland's fit, sRGB 0…1) → linear
function blackbody(kelvin) {
    const t = kelvin / 100;
    const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    const lin = v => { v = Math.min(Math.max(v / 255, 0), 1); return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return new THREE.Vector3(lin(r), lin(g), lin(b));
}

/**
 * White balance multiplier like a camera's/Lightroom's setting: temperature K = colour of the light that becomes
 * white (higher → warmer image), tint −1 (green) … +1 (magenta); luminance stays 1
 */
export function whiteBalance(kelvin, tint) {
    const m = blackbody(6500).divide(blackbody(Math.min(Math.max(kelvin, 1500), 15000)).max(new THREE.Vector3(1e-4, 1e-4, 1e-4)));
    m.y *= 1 - 0.25 * tint;
    return m.divideScalar(m.dot(new THREE.Vector3(0.2126, 0.7152, 0.0722)));
}

export class LensEffects {
    constructor(renderer) {
        this.renderer = renderer;
        this.bloom = { enabled: false, strength: 0.6, radius: 0.5, threshold: 1 };
        this.chromatic = { enabled: false, strength: 0.5 };
        this.glare = { enabled: false, strength: 0.3, length: 0.4, rays: 6, rotation: 15, threshold: 4 };
        this.shafts = { enabled: false, strength: 0.6, length: 0.6, threshold: 2 };
        this.flare = { enabled: false, strength: 0.6, spacing: 0.35, halo: 0.45, chromatic: 0.5, softness: 0.5 };
        this.look = { ...NEUTRAL_LOOK };
        this.neutralLook = false;   // transparent export: alpha passes without the look (viewer.js)
        this.pixelScale = 1;        // export larger than the screen: render size / screen size

        // same multisampling as the canvas (antialias)
        // stencil buffer: cut surfaces of the section plane are drawn into this target too
        this.target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, stencilBuffer: true });
        this.target.texture.name = 'LensEffects';
        this.input = texture(this.target.texture);
        this.u = {
            bloomStrength: uniform(this.bloom.strength),
            bloomRadius: uniform(this.bloom.radius),
            bloomThreshold: uniform(this.bloom.threshold),
            chromatic: uniform(this.chromatic.strength),
            glareStrength: uniform(this.glare.strength),
            glareThreshold: uniform(this.glare.threshold),
            shaftsStrength: uniform(this.shafts.strength),
            shaftsThreshold: uniform(this.shafts.threshold),
            shaftsLength: uniform(this.shafts.length),
            shaftsCenter: uniform(new THREE.Vector2(0.5, 0.5)),   // light centre in uv of the image
            shaftsFade: uniform(0),                                // 0 = light behind the camera / none
            flareStrength: uniform(this.flare.strength),
            flareVisible: uniform(0),                              // share of the light not covered (viewer)
            flareColor: uniform(new THREE.Color(1, 1, 1)),         // light colour (normalised)
            flareSpacing: uniform(this.flare.spacing),
            flareHalo: uniform(this.flare.halo),
            flareChromatic: uniform(this.flare.chromatic),
            flareSoftness: uniform(this.flare.softness),
            lookBalance: uniform(new THREE.Vector3(1, 1, 1)),   // white balance multiplier (linear RGB)
            lookContrast: uniform(1),
            lookSaturation: uniform(1),
        };
        this._setupGlare();
        this._setupShafts();
        this._setupFlare();
        this.output = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.output.name = 'LensEffectsOutput';
        this._key = '';
        this._size = new THREE.Vector2();
        this.apply();
    }

    get active() {
        return this.bloom.enabled || this.chromatic.enabled || this.glare.enabled || this.shafts.enabled || this.flare.enabled || this.lookActive;
    }

    /** Image look differs from neutral (needs the output pass) */
    get lookActive() {
        const l = this.look;
        return l.temperature !== NEUTRAL_LOOK.temperature || l.tint !== 0 || l.contrast !== 1 || l.saturation !== 1;
    }

    /** Export larger than the screen: effects keep their size relative to the image (1 = screen) */
    setPixelScale(scale) {
        this.pixelScale = scale;
        this._bloomNode?.setResolutionScale(0.5 / scale);
    }

    /** Apply values (after a change); rebuilds the output shader only when toggling on/off */
    apply() {
        const u = this.u;
        u.bloomStrength.value = this.bloom.strength;
        u.bloomRadius.value = this.bloom.radius;
        u.bloomThreshold.value = this.bloom.threshold;
        u.chromatic.value = this.chromatic.strength;
        u.glareStrength.value = this.glare.strength;
        u.glareThreshold.value = this.glare.threshold;
        u.shaftsStrength.value = this.shafts.strength;
        u.shaftsThreshold.value = this.shafts.threshold;
        u.shaftsLength.value = this.shafts.length;
        u.flareStrength.value = this.flare.strength;
        u.flareSpacing.value = this.flare.spacing;
        u.flareHalo.value = this.flare.halo;
        u.flareChromatic.value = this.flare.chromatic;
        u.flareSoftness.value = this.flare.softness;
        const look = this.neutralLook ? NEUTRAL_LOOK : this.look;
        u.lookBalance.value.copy(whiteBalance(look.temperature, look.tint));
        u.lookContrast.value = look.contrast;
        u.lookSaturation.value = look.saturation;
        const key = `${this.bloom.enabled}|${this.chromatic.enabled}|${this.glare.enabled}|${this.shafts.enabled}|${this.flare.enabled}|${this.lookActive}`;
        if (key === this._key) return;
        this._key = key;
        this._bloomNode?.dispose();
        this._bloomNode = null;
        if (!this.active) return;

        const color = this.chromatic.enabled ? this._chromatic(this.input) : this.input;
        let out = vec4(color.rgb, 1);
        if (this.bloom.enabled) {
            // bloom from the undistorted image (saves samples, difference invisible)
            this._bloomNode = bloom(this.input, u.bloomStrength, u.bloomRadius, u.bloomThreshold);
            this._bloomNode.setResolutionScale(0.5 / this.pixelScale);
            out = vec4(out.rgb.add(this._bloomNode.rgb), 1);
        }
        if (this.glare.enabled) out = vec4(out.rgb.add(texture(this._glare.accum.texture).rgb.mul(u.glareStrength)), 1);
        if (this.shafts.enabled) out = vec4(out.rgb.add(texture(this._shafts.b.texture).rgb.mul(u.shaftsStrength.mul(u.shaftsFade))), 1);
        if (this.flare.enabled) out = vec4(out.rgb.add(texture(this._flare.target.texture).rgb.mul(u.flareStrength)), 1);
        if (this.lookActive) {
            // white balance, contrast around mid grey (power curve in linear = straight line in log), saturation
            const c = out.rgb.mul(u.lookBalance);
            const contrasted = pow(max(c, 1e-6).div(0.18), vec3(u.lookContrast)).mul(0.18);
            const luma = dot(contrasted, vec3(0.2126, 0.7152, 0.0722));
            out = vec4(max(mix(vec3(luma), contrasted, u.lookSaturation), 0), 1);
        }
        this.output.material.fragmentNode = out;
        this.output.material.needsUpdate = true;
    }

    _chromatic(input) {
        const amount = this.u.chromatic;
        return Fn(() => {
            const p = uv();
            const offset = p.sub(0.5);
            const sum = vec3(0).toVar();
            for (let i = 0; i < SPECTRUM; i++) {
                const t = i / (SPECTRUM - 1);
                // scale relative to the image centre: blue -0.5 %, red +0.5 % at strength 1
                const scale = float(1).add(amount.mul((t - 0.5) * 0.01));
                const q = vec2(0.5).add(offset.mul(scale));
                sum.addAssign(input.sample(q).rgb.mul(vec3(...WEIGHTS[i])));
            }
            return vec4(sum, 1);
        })();
    }

    /** From here on draw into the HDR target (only if active) */
    begin() {
        const r = this.renderer;
        r.getDrawingBufferSize(this._size);
        if (this.target.width !== this._size.x || this.target.height !== this._size.y) {
            this.target.setSize(this._size.x, this._size.y);
        }
        r.setRenderTarget(this.target);
    }

    /** Apply the effects and output to the canvas */
    end() {
        if (this.glare.enabled) this._renderGlare();
        if (this.shafts.enabled) this._renderShafts();
        if (this.flare.enabled) this._renderFlare();
        const r = this.renderer;
        const autoClear = r.autoClear;
        r.autoClear = true;   // also clears the internal framebuffer target
        r.setRenderTarget(null);
        this.output.render(r);
        r.autoClear = autoClear;
    }

    // --- Lens flare ---

    _setupFlare() {
        const rt = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        const f = this._flare = { bright: rt(), tmp: rt(), soft: rt(), target: rt(), quad: new THREE.QuadMesh(),
            aspect: uniform(1), texel: uniform(new THREE.Vector2()), dir: uniform(new THREE.Vector2()), source: texture(null) };
        f.quad.name = 'LensFlare';
        const src = this.input, u = this.u, L = u.shaftsCenter;
        const LUMA = vec3(0.2126, 0.7152, 0.0722);
        // 1. source: bright parts of the image, only around the light (soft window) → the ghosts show the sun with
        //    its bright sky and whatever cuts into it, not every highlight of the image (that was the disco)
        f.brightMaterial = new THREE.NodeMaterial();
        f.brightMaterial.fragmentNode = Fn(() => {
            const p = uv(), o = f.texel;
            const c = src.sample(p.add(vec2(o.x.negate(), o.y.negate()))).rgb
                .add(src.sample(p.add(vec2(o.x, o.y.negate()))).rgb)
                .add(src.sample(p.add(vec2(o.x.negate(), o.y))).rgb)
                .add(src.sample(p.add(o)).rgb).mul(0.25);
            const l = dot(c, LUMA);
            const k = min(max(l.sub(1), 0), 40).div(max(l, 1e-4));
            const d = length(p.sub(L).mul(vec2(f.aspect, 1)));
            const window = exp(d.div(0.25).pow(2).negate());
            // light outside the image: fade out over a short margin
            const outside = max(max(L.x.negate(), L.x.sub(1)), max(L.y.negate(), L.y.sub(1)));
            const vis = u.flareVisible.mul(u.shaftsFade).mul(float(1).sub(smoothstep(0, 0.12, outside)));
            return vec4(c.mul(k).mul(window).mul(vis), 1);
        })();
        // 2. ghosts: copies of the source (the sun, its bright sky, edges cutting in – no plain discs) on the
        //    line light → centre → beyond (t: 0 = light, image centre, negative = across; × spacing), sizes
        //    around the source's; colour fringe = red/blue shifted along the line to the centre; a damped
        //    spectral tint by distance from each ghost's centre; halo = ring of the source around the centre.
        const GHOSTS = [
            { t: 0.55, k: 0.45, i: 0.8 },
            { t: 0.25, k: 0.3, i: 1.0 },
            { t: -0.2, k: 0.55, i: 0.9 },
            { t: -0.5, k: 0.85, i: 0.6 },
            { t: -0.85, k: 1.2, i: 0.35 },
            { t: -1.35, k: 0.7, i: 0.4 },
        ];
        const ramp = t => vec3(0.7).add(vec3(0.3).mul(cos(vec3(t, t, t).add(vec3(0, 0.33, 0.67)).mul(6.2832))));
        f.ghostMaterial = new THREE.NodeMaterial();
        f.ghostMaterial.fragmentNode = Fn(() => {
            const br = f.bright.texture, p = uv(), asp = f.aspect;
            const l = L.sub(0.5);
            const dir = normalize(l.negate().add(vec2(1e-5, 0)));
            const sp = u.flareSpacing.div(0.35);
            const ca = u.flareChromatic.mul(0.025);
            // outside the image there is no source
            const inside = q => smoothstep(0, 0.02, min(min(q.x, q.y), min(float(1).sub(q.x), float(1).sub(q.y))));
            const chroma = q => vec3(texture(br, q.sub(dir.mul(ca))).r, texture(br, q).g, texture(br, q.add(dir.mul(ca))).b).mul(inside(q));
            const sum = vec3(0).toVar();
            for (const g of GHOSTS) {
                const c = vec2(0.5).add(l.mul(sp.mul(g.t)));
                const q = L.add(p.sub(c).div(g.k));
                const r = length(p.sub(c).mul(vec2(asp, 1))).div(g.k * 0.25);
                sum.addAssign(chroma(q).mul(ramp(r.mul(0.8).add(g.t))).mul(g.i));
            }
            // halo: the source pushed outwards from the image centre by the halo width → ring through the light
            const haloVec = normalize(p.sub(0.5).add(vec2(1e-5, 0))).mul(u.flareHalo.mul(0.3));
            const hq = p.sub(haloVec.mul(vec2(1, asp)));
            const hr = length(p.sub(0.5).mul(vec2(asp, 1)));
            sum.addAssign(chroma(hq).mul(ramp(hr.mul(2))).mul(u.flareHalo.mul(0.5)));
            return vec4(sum.mul(mix(vec3(1), vec3(u.flareColor), 0.5)).mul(0.35), 1);
        })();
        // 3. separable Gauss before and after the ghosts (softness = width)
        const TAPS = [0.0702, 0.1311, 0.1907, 0.2160, 0.1907, 0.1311, 0.0702];
        f.blurMaterial = new THREE.NodeMaterial();
        f.blurMaterial.fragmentNode = Fn(() => {
            const p = uv(), step = f.dir.mul(u.flareSoftness.mul(3).add(0.5));
            const sum = vec3(0).toVar();
            TAPS.forEach((w, i) => sum.addAssign(f.source.sample(p.add(step.mul(i - 3))).rgb.mul(w / 0.9999)));
            return vec4(sum, 1);
        })();
    }

    _renderFlare() {
        const r = this.renderer, f = this._flare;
        // quarter resolution: everything is soft
        const d = 4 * this.pixelScale, w = Math.max(1, Math.floor(this.target.width / d)), h = Math.max(1, Math.floor(this.target.height / d));
        for (const t of [f.bright, f.tmp, f.soft, f.target]) if (t.width !== w || t.height !== h) t.setSize(w, h);
        f.aspect.value = this.target.width / Math.max(this.target.height, 1);
        f.texel.value.set(this.pixelScale / this.target.width, this.pixelScale / this.target.height);
        const autoClear = r.autoClear;
        r.autoClear = true;
        const draw = (target, material) => { r.setRenderTarget(target); f.quad.material = material; f.quad.render(r); };
        const blur = (from, to) => {
            f.source.value = from.texture; f.dir.value.set(1 / w, 0); draw(f.tmp, f.blurMaterial);
            f.source.value = f.tmp.texture; f.dir.value.set(0, 1 / h); draw(to, f.blurMaterial);
        };
        // blurred before the ghosts too: the small sun at ¼ resolution showed a grid when copied/enlarged
        draw(f.soft, f.brightMaterial);
        blur(f.soft, f.bright);
        draw(f.soft, f.ghostMaterial);
        blur(f.soft, f.target);
        r.autoClear = autoClear;
    }

    // --- Glare ---

    _setupGlare() {
        const rt = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        const g = this._glare = { bright: rt(), a: rt(), b: rt(), accum: rt(), quad: new THREE.QuadMesh() };
        g.quad.name = 'Glare';

        // bright spots: 4 bilinear taps at the corners of a 4×4 block
        g.texel = uniform(new THREE.Vector2());   // texel of the full image
        const src = this.input;
        g.brightMaterial = new THREE.NodeMaterial();
        g.brightMaterial.fragmentNode = Fn(() => {
            const p = uv(), o = g.texel;
            const c = src.sample(p.add(vec2(o.x.negate(), o.y.negate()))).rgb
                .add(src.sample(p.add(vec2(o.x, o.y.negate()))).rgb)
                .add(src.sample(p.add(vec2(o.x.negate(), o.y))).rgb)
                .add(src.sample(p.add(o)).rgb).mul(0.25);
            const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            // soft onset above the threshold, clamp very bright values (sun in the HDRI)
            const k = min(max(l.sub(this.u.glareThreshold), 0), 50).div(max(l, 1e-4));
            return vec4(c.mul(k), 1);
        })();

        // streak pass: 4 taps along dir at spacing step, weight att^(step·i), normalised
        g.source = texture(null);
        g.dir = uniform(new THREE.Vector2());   // direction in uv per texel (¼ resolution)
        g.step = uniform(1);
        g.att = uniform(0.9);
        const streak = Fn(() => {
            const p = uv();
            const sum = vec3(0).toVar(), wsum = float(0).toVar();
            for (let i = 0; i < 4; i++) {
                const w = pow(g.att, g.step.mul(i));
                sum.addAssign(g.source.sample(p.add(g.dir.mul(g.step.mul(i)))).rgb.mul(w));
                wsum.addAssign(w);
            }
            return vec4(sum.div(wsum), 1);
        })();
        g.streakMaterial = new THREE.NodeMaterial();
        g.streakMaterial.fragmentNode = streak;
        g.addMaterial = new THREE.NodeMaterial();   // last pass: additive into the accumulation target
        g.addMaterial.fragmentNode = streak;
        g.addMaterial.blending = THREE.AdditiveBlending;
        g.addMaterial.transparent = true;
    }

    _renderGlare() {
        const r = this.renderer, g = this._glare, cfg = this.glare;
        const d = 4 * this.pixelScale, w = Math.max(1, Math.floor(this.target.width / d)), h = Math.max(1, Math.floor(this.target.height / d));
        for (const t of [g.bright, g.a, g.b, g.accum]) if (t.width !== w || t.height !== h) t.setSize(w, h);
        const autoClear = r.autoClear;
        const clearColor = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
        r.autoClear = true;
        r.setClearColor(0x000000, 0);
        const draw = (target, material) => { r.setRenderTarget(target); g.quad.material = material; g.quad.render(r); };

        g.texel.value.set(this.pixelScale / this.target.width, this.pixelScale / this.target.height);
        draw(g.bright, g.brightMaterial);
        r.setRenderTarget(g.accum);
        r.clear();
        r.autoClear = true;
        // length 0…1 → decay per texel 0.8…0.985 (reach ~5…60 texels at ¼ resolution)
        g.att.value = 0.8 + 0.185 * Math.min(Math.max(cfg.length, 0), 1);
        const rays = Math.max(2, Math.round(cfg.rays));
        for (let k = 0; k < rays; k++) {
            const a = THREE.MathUtils.degToRad(cfg.rotation) + k * 2 * Math.PI / rays;
            g.dir.value.set(Math.cos(a) / w, Math.sin(a) / h);
            g.source.value = g.bright.texture; g.step.value = 1; draw(g.a, g.streakMaterial);
            g.source.value = g.a.texture; g.step.value = 4; draw(g.b, g.streakMaterial);
            g.source.value = g.b.texture; g.step.value = 16;
            r.autoClear = false;
            draw(g.accum, g.addMaterial);
            r.autoClear = true;
        }
        r.setClearColor(clearColor, clearAlpha);
        r.autoClear = autoClear;
    }

    // --- Light shafts ---

    /** Light centre in the image (uv, may lie outside 0…1) and its visibility 0…1 (viewer, every frame) */
    setShaftSource(x, y, fade) {
        this.u.shaftsCenter.value.set(x, y);
        this.u.shaftsFade.value = fade;
    }

    /** Lens flare: share of the light not covered by the model 0…1 and its colour (viewer, every frame) */
    setFlareSource(visible, color) {
        this.u.flareVisible.value = visible;
        if (color) this.u.flareColor.value.copy(color);
    }

    _setupShafts() {
        const rt = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        const sh = this._shafts = { bright: rt(), a: rt(), b: rt(), quad: new THREE.QuadMesh() };
        sh.quad.name = 'LightShafts';
        const src = this.input, u = this.u;
        sh.texel = uniform(new THREE.Vector2());
        // bright parts (4×4 average like the glare), clamped (the sun itself is thousands of times brighter)
        sh.brightMaterial = new THREE.NodeMaterial();
        sh.brightMaterial.fragmentNode = Fn(() => {
            const p = uv(), o = sh.texel;
            const c = src.sample(p.add(vec2(o.x.negate(), o.y.negate()))).rgb
                .add(src.sample(p.add(vec2(o.x, o.y.negate()))).rgb)
                .add(src.sample(p.add(vec2(o.x.negate(), o.y))).rgb)
                .add(src.sample(p.add(o)).rgb).mul(0.25);
            const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            const k = min(max(l.sub(u.shaftsThreshold), 0), 20).div(max(l, 1e-4));
            return vec4(c.mul(k), 1);
        })();
        // radial blur towards the centre: 48 samples, the second pass with 1/48 of the step of the first
        // (together 2304 effective samples without banding); weights decay along the way (same falloff
        // over the length as the earlier 32 samples × 0.97)
        const SAMPLES = 48;
        sh.source = texture(null);
        sh.scale = uniform(1);
        sh.samples = SAMPLES;
        const blur = Fn(() => {
            const p = uv();
            const delta = p.sub(u.shaftsCenter).mul(u.shaftsLength.mul(0.95).mul(sh.scale).div(SAMPLES));
            const sum = vec3(0).toVar();
            let wsum = 0;
            for (let i = 0; i < SAMPLES; i++) {
                const w = Math.pow(0.97, i * 32 / SAMPLES);
                sum.addAssign(sh.source.sample(p.sub(delta.mul(i))).rgb.mul(w));
                wsum += w;
            }
            return vec4(sum.div(wsum), 1);
        })();
        sh.blurMaterial = new THREE.NodeMaterial();
        sh.blurMaterial.fragmentNode = blur;
    }

    _renderShafts() {
        const r = this.renderer, sh = this._shafts;
        // half resolution (¼ looked coarse at the edges of objects cutting into the light)
        const d = 2 * this.pixelScale, w = Math.max(1, Math.floor(this.target.width / d)), h = Math.max(1, Math.floor(this.target.height / d));
        for (const t of [sh.bright, sh.a, sh.b]) if (t.width !== w || t.height !== h) t.setSize(w, h);
        const autoClear = r.autoClear;
        r.autoClear = true;
        const draw = (target, material) => { r.setRenderTarget(target); sh.quad.material = material; sh.quad.render(r); };
        sh.texel.value.set(this.pixelScale / this.target.width, this.pixelScale / this.target.height);
        draw(sh.bright, sh.brightMaterial);
        sh.source.value = sh.bright.texture; sh.scale.value = 1; draw(sh.a, sh.blurMaterial);
        sh.source.value = sh.a.texture; sh.scale.value = 1 / sh.samples; draw(sh.b, sh.blurMaterial);
        r.autoClear = autoClear;
    }

    toJSON() {
        return { bloom: { ...this.bloom }, chromatic: { ...this.chromatic }, glare: { ...this.glare }, shafts: { ...this.shafts },
            flare: { ...this.flare }, look: { ...this.look } };
    }

    fromJSON(s) {
        if (!s) return;
        Object.assign(this.bloom, { enabled: false }, s.bloom);
        Object.assign(this.chromatic, { enabled: false }, s.chromatic);
        Object.assign(this.glare, { enabled: false }, s.glare);
        Object.assign(this.shafts, { enabled: false }, s.shafts);
        Object.assign(this.flare, { enabled: false }, s.flare);
        delete this.flare.threshold;   // older scenes (visibility came from image brightness)
        Object.assign(this.look, NEUTRAL_LOOK, s.look);
        this.apply();
    }
}
