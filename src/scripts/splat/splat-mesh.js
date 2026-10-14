// Gaussian splat object for the WebGPU renderer (raster only – the path tracer cannot trace splats).
// One instanced quad per splat; the vertex shader reads the splat data from storage buffers in the order of
// the last sort (splat-sorter.js, back to front), projects the 3D covariance to the screen (EWA, like the
// reference implementation of 3D Gaussian Splatting) and stretches the quad along its two axes (±3σ).
// The fragment shader fades with the Gaussian; blending premultiplied, no depth writes.
//
// Data (splat-formats.js): a = position + rgba8, b = log scales + rotation (halfs), sh = higher SH bands.
// Colours of splats are display values (sRGB) – they are turned linear here, the viewer switches tone
// mapping off for splat scenes, so the screen shows the trained colours.
//
// Progressive loading: the load worker fills shared buffers; setLoaded() uploads the new range, only the
// splats read so far are sorted/drawn. A reveal grows with the progress – splats at its edge fade in (size +
// opacity, colour unchanged) – and runs out to the farthest splats after loading (finish()). Shapes (`reveal.mode`):
// sphere from the centre outwards (default), plane from the bottom up, circle on screen (cone from the camera);
// settings in SPLATS.reveal (config.js). Pulse: in the edge band splats start larger, transparent and glowing (glow
// colour or own colour, brightened) and settle to their size/colour – the glow also covers the oddly coloured inner
// splats (never seen by the training cameras) that a spatial reveal exposes on its cut.
import * as THREE from 'three/webgpu';
import {
    Fn, If, Discard, storage, instanceIndex, uniform, vec2, vec3, vec4, float, uint, uintBitsToFloat, unpackHalf2x16,
    unpackUnorm4x8, unpackSnorm4x8, mix, abs, modelViewMatrix, modelWorldMatrixInverse, cameraProjectionMatrix, cameraPosition,
    positionGeometry, screenSize, varyingProperty, exp, sqrt, max, min, normalize, length, dot, select, sRGBTransferEOTF, smoothstep,
} from 'three/tsl';
import { SplatSorter } from './splat-sorter.js';
import { SPLATS } from '../config.js';

export const REVEAL_MODES = ['sphere', 'plane', 'screen'];

const SH_C1 = 0.4886025119029199;
const SH_C2 = [1.0925484305920792, -1.0925484305920792, 0.31539156525252005, -1.0925484305920792, 0.5462742152960396];
const SH_C3 = [-0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154, -0.4570457994644658, 1.445305721320277, -0.5900435899266435];

// SH basis of the higher bands for direction d (3DGS ordering) – coefficient j ↔ f_rest index j
function shBasis(d) {
    const { x, y, z } = d;
    const xx = x.mul(x), yy = y.mul(y), zz = z.mul(z);
    return [
        y.mul(-SH_C1), z.mul(SH_C1), x.mul(-SH_C1),
        x.mul(y).mul(SH_C2[0]), y.mul(z).mul(SH_C2[1]), zz.mul(2).sub(xx).sub(yy).mul(SH_C2[2]), x.mul(z).mul(SH_C2[3]), xx.sub(yy).mul(SH_C2[4]),
        y.mul(xx.mul(3).sub(yy)).mul(SH_C3[0]), x.mul(y).mul(z).mul(SH_C3[1]), y.mul(zz.mul(4).sub(xx).sub(yy)).mul(SH_C3[2]),
        z.mul(zz.mul(2).sub(xx.mul(3)).sub(yy.mul(3))).mul(SH_C3[3]), x.mul(zz.mul(4).sub(xx).sub(yy)).mul(SH_C3[4]),
        z.mul(xx.sub(yy)).mul(SH_C3[5]), x.mul(xx.sub(yy.mul(3))).mul(SH_C3[6]),
    ];
}

const _inv = new THREE.Matrix4(), _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _d = new THREE.Vector3();
const _frustum = new THREE.Frustum(), _widen = new THREE.Matrix4().makeScale(1 / 1.25, 1 / 1.25, 1);

export class SplatMesh extends THREE.Mesh {
    /**
     * @param {object} data result of splat-formats.js (count, a, b, sh, shWords, shCoeffs, shRange, bounds, pick sample)
     * @param {{ onSorted?: () => void }} options onSorted: a new order is ready (request a frame)
     */
    constructor(data, { onSorted } = {}) {
        const count = data.count;
        const { geometry, attrs } = createGeometry(data.a, data.b, data.sh, count);
        // bounds for framing/fitting: robust box (captured scenes have far floaters)
        geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...data.robustMin), new THREE.Vector3(...data.robustMax));
        geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
        super(geometry, createMaterial());
        const { a: attrA, b: attrB, sh: attrSh, order: attrOrder } = attrs;
        this.isSplat = true;
        this.frustumCulled = false;
        this.castShadow = this.receiveShadow = false;
        this.renderOrder = 10;

        this.count = count;
        this.data = data;
        this.attrOrder = attrOrder;
        this.attrs = { a: attrA, b: attrB, sh: attrSh };
        this.loading = !!data.loading;
        this.ranges = this.loading ? [] : [[0, count]];   // splats read so far (parallel parsers: one range each)
        this.loaded = this.loading ? 0 : count;           // number of splats in `ranges`
        this._uploaded = new Map();                        // range start → uploaded up to (a/b and sh separately)
        this.onSorted = onSorted;
        this.sorter = new SplatSorter(data.a, count);
        this.sorting = false;
        this.lastSort = null;   // camera of the last sort (data space)
        this.fullBox = new THREE.Box3(new THREE.Vector3(...data.min), new THREE.Vector3(...data.max));
        this._release = [attrB, attrSh].filter(Boolean);
        this._drawn = 0;
        this.reveal = {
            center: uniform(new THREE.Vector3()), radius: uniform(0), width: uniform(1),
            mode: uniform(0), up: uniform(new THREE.Vector3(0, 1, 0)), base: uniform(0),
            glow: uniform(0), glowColor: uniform(new THREE.Color(1, 1, 1)), glowMix: uniform(1), startSize: uniform(1), minStart: uniform(0),
            band: 0.2, minStartSize: 0, r: 0, robust: 1, full: 1, active: true, t: 0,
        };
        this.setRevealOptions(SPLATS.reveal);
        // depth of field (dof.js values, set in update()): aperture diameter + focus in mm, focus as a sphere
        // around the camera (fisheye), focus line (green, like dof.renderLine for meshes)
        this.dof = { enabled: uniform(0), aperture: uniform(0), focus: uniform(1000), sphere: uniform(0), line: uniform(0) };
        this._revealBounds();
        this._buildMaterial(attrA, attrB, attrOrder, attrSh, data);
    }

    // centre (robust box) and radii of the reveal circle (robust box / all splats)
    _revealBounds() {
        const rv = this.reveal, box = this.geometry.boundingBox;
        if (!this._centerSet) { box.getCenter(rv.center.value); this._centerSet = true; }
        const far = b => {
            let d = 0;
            for (let i = 0; i < 8; i++) d = Math.max(d, rv.center.value.distanceTo(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)));
            return d || 1;
        };
        rv.robust = far(box);
        rv.full = Math.max(far(this.fullBox), rv.robust);
        rv.width.value = rv.robust * rv.band;
        rv.minStart.value = rv.robust * rv.minStartSize;
    }

    /**
     * Splats (and their SH) read so far – lists of [start, end) ranges: upload what is new since the last call
     * and sort/draw only these
     */
    setLoaded(ranges, shRanges = ranges) {
        const up = (attrs, list, key, words) => {
            for (const [start, end] of list) {
                const from = this._uploaded.get(key + start) ?? start;
                if (end <= from) continue;
                for (const attr of attrs) {
                    if (!attr) continue;
                    attr.addUpdateRange(from * words, (end - from) * words);
                    attr.needsUpdate = true;
                }
                this._uploaded.set(key + start, end);
            }
        };
        up([this.attrs.a, this.attrs.b], ranges, 'p', 4);
        if (this.attrs.sh) up([this.attrs.sh], shRanges, 's', this.data.shWords);
        this.ranges = ranges.map(r => [...r]);
        this.loaded = ranges.reduce((n, [s, e]) => n + e - s, 0);
    }

    /** loading finished: final bounds + pick sample (result of splat-formats.js) */
    finish(result) {
        const { min, max, robustMin, robustMax, unbounded, pickIndex, pickRadius, format, fileShCoeffs } = result;
        Object.assign(this.data, { min, max, robustMin, robustMax, unbounded, pickIndex, pickRadius, format, fileShCoeffs });
        // outdoor capture: the estimated bounds while loading (e.g. SOG: meta.json = everything incl. the sky shell)
        // may lie far off the core → reveal from the core's centre
        if (unbounded) this._centerSet = false;
        this.geometry.boundingBox.set(new THREE.Vector3(...robustMin), new THREE.Vector3(...robustMax));
        this.geometry.boundingSphere = this.geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
        this.fullBox.set(new THREE.Vector3(...min), new THREE.Vector3(...max));
        this.setLoaded([[0, this.count]]);
        this.loading = false;
        this.data.loading = false;
        this._revealBounds();
    }

    // reveal radius: follows the progress while loading (at most the robust extent / 1.5 s), then out to the
    // farthest splat; afterwards switched off (radius "infinite")
    _animateReveal(camera) {
        const rv = this.reveal;
        if (!rv.active) return;
        const now = performance.now();
        this.updateWorldMatrix(true, false);
        _inv.copy(this.matrixWorld).invert();
        rv.up.value.set(0, 1, 0).transformDirection(_inv);   // world up in data space
        // extent to cover: robust bounds while loading, all splats at the end
        let load = rv.robust, end = rv.full;
        const mode = REVEAL_MODES[rv.mode.value];
        if (mode === 'plane') {
            const span = box => {
                let lo = Infinity, hi = -Infinity;
                for (let i = 0; i < 8; i++) {
                    const h = _d.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(rv.center.value).dot(rv.up.value);
                    lo = Math.min(lo, h); hi = Math.max(hi, h);
                }
                return [lo, hi];
            };
            const [lo, hi] = span(this.geometry.boundingBox);
            rv.base.value = -lo;   // distance = height above the bottom of the robust box
            load = hi - lo;
            end = Math.max(span(this.fullBox)[1] - lo, load);
        } else if (mode === 'screen') {
            // splats in front of the centre are magnified in the cone
            const dist = _v.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv).distanceTo(rv.center.value);
            end = rv.full * Math.min(dist > rv.full ? dist / (dist - rv.full) : 5, 5);
        }
        const dt = rv.t ? Math.min(now - rv.t, 100) / 1000 : 0;
        rv.t = now;
        const target = this.loading ? load * (0.1 + 0.9 * this.loaded / this.count) : end + rv.width.value;
        const speed = this.loading ? load / 1.5 : Math.max(load / 1.5, end - load);
        rv.r = Math.max(rv.r, Math.min(target, rv.r + speed * dt));
        rv.radius.value = rv.r;
        if (!this.loading && rv.r >= target) {
            rv.active = false;
            rv.radius.value = 1e30;
        }
    }

    /** shape of the reveal (REVEAL_MODES), edge band, pulse – see SPLATS.reveal in config.js */
    setRevealOptions({ mode, band, glow, startSize, minStartSize, glowColor } = {}) {
        const rv = this.reveal;
        if (mode !== undefined) rv.mode.value = Math.max(0, REVEAL_MODES.indexOf(mode));
        if (band !== undefined) rv.band = band;
        if (glow !== undefined) rv.glow.value = glow;
        if (startSize !== undefined) rv.startSize.value = startSize;
        if (minStartSize !== undefined) rv.minStartSize = minStartSize;
        if (glowColor !== undefined) {
            rv.glowMix.value = glowColor ? 1 : 0;
            if (glowColor) rv.glowColor.value.set(glowColor);
        }
    }

    _buildMaterial(attrA, attrB, attrOrder, attrSh, data) {
        const count = this.count;
        const A = storage(attrA, 'uvec4', count).toReadOnly();
        const B = storage(attrB, 'uvec4', count).toReadOnly();
        const ORDER = storage(attrOrder, 'uint', count).toReadOnly();
        const W = data.shWords, K = data.shCoeffs;
        const SH = attrSh ? storage(attrSh, 'uint', count * W).toReadOnly() : null;
        const shRange = uniform(data.shRange);
        const antialias = !!data.antialias;
        this.uniforms = { shRange };
        const vColor = varyingProperty('vec4', 'vSplatColor');
        const vCoord = varyingProperty('vec2', 'vSplatCoord');

        // local position = splat centre: positionView/world of the material are then those of the centre –
        // the section plane (ClippingGroup) cuts whole splats at their centre
        this.material.positionNode = Fn(() => {
            const a = A.element(ORDER.element(instanceIndex));
            return vec3(uintBitsToFloat(a.x), uintBitsToFloat(a.y), uintBitsToFloat(a.z));
        })();

        this.material.vertexNode = Fn(() => {
            const index = ORDER.element(instanceIndex);
            const a = A.element(index).toVar();
            const b = B.element(index).toVar();
            const center = vec3(uintBitsToFloat(a.x), uintBitsToFloat(a.y), uintBitsToFloat(a.z)).toVar();
            const view = modelViewMatrix.mul(vec4(center, 1)).toVar();
            const clip = cameraProjectionMatrix.mul(view).toVar();
            const out = vec4(0, 0, 2, 1).toVar();   // culled: outside the clip volume
            vColor.assign(vec4(0));
            vCoord.assign(vec2(0));
            const bound = clip.w.mul(1.2);
            // reveal: 1 inside, grows from 0 within the edge band, 0 outside. Distance by mode: 0 = to the centre
            // (sphere), 1 = height above the bottom (plane), 2 = distance from the axis camera → centre, scaled to
            // the depth of the centre (cone = circle on screen; camera at the centre → sphere)
            const { center: revealCenter, radius: revealRadius, width: revealWidth, mode: revealMode, up: revealUp, base: revealBase } = this.reveal;
            const sphereDist = length(center.sub(revealCenter));
            const planeDist = dot(center.sub(revealCenter), revealUp).add(revealBase);
            const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz.toVar();
            const axis = revealCenter.sub(eye).toVar();
            const axisLength = length(axis).toVar();
            const rel = center.sub(eye).toVar();
            const along = dot(rel, axis).div(max(axisLength, 1e-6)).toVar();
            const lateral = length(rel.sub(axis.mul(along.div(max(axisLength, 1e-6)))));
            const cone = select(along.greaterThan(0), lateral.mul(axisLength).div(max(along, axisLength.mul(0.05))), float(1e30));
            const screenDist = select(axisLength.greaterThan(revealWidth), cone, sphereDist);
            const revealDist = select(revealMode.lessThan(0.5), sphereDist, select(revealMode.lessThan(1.5), planeDist, screenDist));
            // grow: 0 = just reached by the reveal, 1 = through
            const grow = float(1).sub(smoothstep(revealRadius.sub(revealWidth), revealRadius, revealDist)).toVar();
            const pulse = float(1).sub(grow).toVar();
            // pulse: size per axis from `startSize` × own size (at least `minStart`) down to the own size
            // (shrinking from nothing made single bright pixels – sparkles)
            const { startSize, minStart } = this.reveal;
            const scaleIn = s => mix(s, max(s.mul(startSize), minStart), pulse);
            If(grow.greaterThan(0.002).and(clip.w.greaterThan(0)).and(clip.x.abs().lessThan(bound)).and(clip.y.abs().lessThan(bound)), () => {
                // 3D covariance = M Mᵀ with M = R·S; its columns in view space
                const s01 = unpackHalf2x16(b.x), s2 = unpackHalf2x16(b.y).x;
                const qwx = unpackHalf2x16(b.z), qyz = unpackHalf2x16(b.w);
                const w = qwx.x, x = qwx.y, y = qyz.x, z = qyz.y;
                const r0 = vec3(float(1).sub(y.mul(y).add(z.mul(z)).mul(2)), x.mul(y).add(w.mul(z)).mul(2), x.mul(z).sub(w.mul(y)).mul(2));
                const r1 = vec3(x.mul(y).sub(w.mul(z)).mul(2), float(1).sub(x.mul(x).add(z.mul(z)).mul(2)), y.mul(z).add(w.mul(x)).mul(2));
                const r2 = vec3(x.mul(z).add(w.mul(y)).mul(2), y.mul(z).sub(w.mul(x)).mul(2), float(1).sub(x.mul(x).add(y.mul(y)).mul(2)));
                const m0 = modelViewMatrix.mul(vec4(r0.mul(scaleIn(exp(s01.x))), 0)).xyz;
                const m1 = modelViewMatrix.mul(vec4(r1.mul(scaleIn(exp(s01.y))), 0)).xyz;
                const m2 = modelViewMatrix.mul(vec4(r2.mul(scaleIn(exp(s2))), 0)).xyz;
                // Jacobian of the perspective projection in pixels (x/z clamped like the reference)
                const focal = vec2(cameraProjectionMatrix.element(0).x, cameraProjectionMatrix.element(1).y).mul(screenSize).mul(0.5);
                const depth = view.z.negate().toVar();
                const limit = vec2(1.3).div(vec2(cameraProjectionMatrix.element(0).x, cameraProjectionMatrix.element(1).y));
                const txy = view.xy.div(depth).clamp(limit.negate(), limit).mul(depth);
                const project = m => vec2(m.x.mul(depth).add(txy.x.mul(m.z)), m.y.mul(depth).add(txy.y.mul(m.z))).mul(focal).div(depth.mul(depth));
                const t0 = project(m0).toVar(), t1 = project(m1).toVar(), t2 = project(m2).toVar();
                const c00 = dot(vec3(t0.x, t1.x, t2.x), vec3(t0.x, t1.x, t2.x));
                const c01 = dot(vec3(t0.x, t1.x, t2.x), vec3(t0.y, t1.y, t2.y));
                const c11 = dot(vec3(t0.y, t1.y, t2.y), vec3(t0.y, t1.y, t2.y));
                // low-pass filter (≥ ~1 px) + eigen decomposition
                const ca = c00.add(0.3).toVar(), cb = c01.toVar(), cc = c11.add(0.3).toVar();
                // depth of field: every splat is blurred by its circle of confusion (thin lens like the path tracer:
                // diameter on the focus plane = aperture · |d − focus| / d, in pixels · focal / focus; Gaussian with
                // σ = radius / 2) – added to its 2D covariance, opacity lowered so the energy stays the same
                const dof = this.dof;
                const dofDist = select(dof.sphere.greaterThan(0.5), length(view.xyz), depth).toVar();
                const cocRadius = dof.aperture.mul(abs(dofDist.sub(dof.focus))).div(max(dofDist, 1e-6)).mul(focal.y).div(max(dof.focus, 1e-6)).mul(0.5);
                const cocVar = cocRadius.mul(0.5).pow(2).mul(dof.enabled).toVar();
                const detLowPass = ca.mul(cc).sub(cb.mul(cb)).toVar();
                ca.addAssign(cocVar);
                cc.addAssign(cocVar);
                const dofEnergy = sqrt(detLowPass.div(ca.mul(cc).sub(cb.mul(cb))));
                const mid = ca.add(cc).mul(0.5);
                const radius = length(vec2(ca.sub(cc).mul(0.5), cb));
                const l1 = mid.add(radius), l2 = max(mid.sub(radius), 0.1);
                const diag = vec2(cb, l1.sub(ca));
                const dir = select(length(diag).greaterThan(1e-12), normalize(diag), vec2(1, 0)).toVar();
                const major = dir.mul(min(sqrt(l1).mul(3), 2048));
                const minor = vec2(dir.y, dir.x.negate()).mul(min(sqrt(l2).mul(3), 2048));
                const corner = positionGeometry.xy;
                const offset = major.mul(corner.x).add(minor.mul(corner.y)).mul(2).div(screenSize);
                out.assign(vec4(clip.xy.add(offset.mul(clip.w)), clip.z, clip.w));
                vCoord.assign(corner.mul(3));
                // colour: band 0 + view-dependent bands (direction in data space)
                const base = unpackUnorm4x8(a.w);
                const color = base.rgb.toVar();
                if (SH) {
                    const d = normalize(center.sub(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz)).toVar();
                    const basis = shBasis(d);
                    const bytes = [];
                    for (let k = 0; k < W; k++) {
                        const v = unpackSnorm4x8(SH.element(index.mul(uint(W)).add(uint(k)))).toVar();
                        bytes.push(v.x, v.y, v.z, v.w);
                    }
                    let sum = vec3(0);
                    for (let j = 0; j < K; j++) sum = sum.add(vec3(bytes[j * 3], bytes[j * 3 + 1], bytes[j * 3 + 2]).mul(basis[j]));
                    color.addAssign(sum.mul(shRange));
                }
                // pulse: towards the glow colour (or the own one) and brightened, settling with the band
                const glowTarget = mix(color, this.reveal.glowColor.mul(max(max(base.r, base.g), max(base.b, 0.35))), this.reveal.glowMix);
                color.assign(mix(color, glowTarget, pulse).mul(float(1).add(this.reveal.glow.mul(pulse))));
                // focus line: splats at the focus distance turn green (~2.5 px wide band)
                const lineWidth = dofDist.mul(2.5).div(focal.y);
                color.assign(mix(color, vec3(0.2, 1, 0.3), dof.line.mul(float(1).sub(smoothstep(lineWidth.mul(0.5), lineWidth, abs(dofDist.sub(dof.focus)))))));
                let alpha = base.a.mul(grow).mul(dofEnergy);
                // Mip-Splatting style files ("antialias"): keep the energy of the low-pass filtered splat
                if (antialias) alpha = alpha.mul(sqrt(max(c00.mul(c11).sub(c01.mul(c01)), 0).div(detLowPass)));
                vColor.assign(vec4(sRGBTransferEOTF(max(color, 0)), alpha));
            });
            return out;
        })();

        this.material.fragmentNode = Fn(() => {
            const d2 = dot(vCoord, vCoord);
            Discard(d2.greaterThan(9));
            const alpha = exp(d2.mul(-0.5)).mul(vColor.a).toVar();
            Discard(alpha.lessThan(1 / 255));
            return vec4(vColor.rgb, min(alpha, 0.99));
        })();
    }

    /**
     * Before rendering: start a new sort when the camera (relative to the splats) changed noticeably.
     * fisheye: sorted by distance (valid for every cube face of the raster fisheye), no frustum culling.
     */
    update(camera, { fisheye = false, dof = null, focusLine = false } = {}) {
        this._animateReveal(camera);
        const d = this.dof;
        d.enabled.value = dof?.enabled ? 1 : 0;
        d.line.value = dof?.enabled && focusLine ? 1 : 0;
        if (dof) {
            d.aperture.value = camera.getFocalLength() / Math.max(dof.fStop, 0.1);
            d.focus.value = Math.max(dof.focusDistance, 1e-3);
        }
        d.sphere.value = fisheye ? 1 : 0;
        if (this.sorting || this.sorter.disposed || !this.loaded) return;
        this.updateWorldMatrix(true, false);
        _inv.copy(this.matrixWorld).invert();
        const origin = _v.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv);
        const dir = _d.set(0, 0, -1).transformDirection(camera.matrixWorld).transformDirection(_inv);
        const size = this.fullBox.getSize(new THREE.Vector3()).length() || 1;
        const last = this.lastSort;
        const changed = !last || last.fisheye !== fisheye || last.loaded !== this.loaded || last.origin.distanceTo(origin) > size * 1e-4 || last.dir.dot(dir) < 0.99995 ||
            !last.matrix.equals(this.matrixWorld) || (!fisheye && !last.projection.equals(camera.projectionMatrix));
        if (!changed) return;
        let planes = null;
        if (!fisheye) {
            // side planes of the (somewhat widened) frustum in data space
            _m.multiplyMatrices(_widen, camera.projectionMatrix).multiply(camera.matrixWorldInverse).multiply(this.matrixWorld);
            _frustum.setFromProjectionMatrix(_m, camera.coordinateSystem);
            planes = _frustum.planes.slice(0, 4).flatMap(p => [p.normal.x, p.normal.y, p.normal.z, p.constant]);
        }
        // key range: from very close to the farthest corner of the bounds
        let far = 0;
        for (let i = 0; i < 8; i++) {
            const c = new THREE.Vector3(i & 1 ? this.fullBox.max.x : this.fullBox.min.x, i & 2 ? this.fullBox.max.y : this.fullBox.min.y, i & 4 ? this.fullBox.max.z : this.fullBox.min.z);
            far = Math.max(far, c.distanceTo(origin));
        }
        const sorter = this.sorter;
        const state = { loaded: this.loaded, origin: origin.clone(), dir: dir.clone(), fisheye, matrix: this.matrixWorld.clone(), projection: camera.projectionMatrix.clone() };
        this.sorting = true;
        sorter.sort({ origin: origin.toArray(), dir: dir.toArray(), mode: fisheye ? 'distance' : 'depth', planes, near: size * 1e-5, far: far * 1.01,
            ranges: this.loading ? this.ranges : null })
            .then(visible => {
                this.sorting = false;
                if (sorter.disposed) return;
                const order = this.attrOrder;
                order.array.set(visible === this.count ? this.sorter.order : this.sorter.order.subarray(0, visible));
                order.clearUpdateRanges();
                if (visible) order.addUpdateRange(0, visible);
                order.needsUpdate = true;
                this.geometry.instanceCount = visible;
                this.lastSort = state;
                this.onSorted?.();
            })
            .catch(err => { this.sorting = false; console.error('[Splats] sort failed', err); });
    }

    // After the first draws the data lives on the GPU – drop the CPU copies that are not needed any more
    // (scales/rotations, SH: hundreds of MB with large scenes). Positions stay (sorting, picking).
    onAfterRender() {
        if (!this._release || this.loading || !this.geometry.instanceCount || ++this._drawn < 3) return;
        for (const attr of this._release) attr.array = new attr.array.constructor(attr.itemSize);
        this.data.b = this.data.sh = null;
        this._release = null;
    }

    // Picking: nearest splat of the pick sample (clearly opaque splats) whose ellipsoid (2σ of the largest
    // axis) the ray passes – no BVH, ~1 M samples brute force
    raycast(raycaster, intersects) {
        if (!this.visible) return;
        _inv.copy(this.matrixWorld).invert();
        const ray = raycaster.ray.clone().applyMatrix4(_inv);
        const { pickIndex, pickRadius, a } = this.data;
        if (!pickIndex) return;   // still loading
        const pos = new Float32Array(a.buffer);
        const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z, dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
        let best = Infinity, hit = -1;
        for (let k = 0; k < pickIndex.length; k++) {
            const o = pickIndex[k] * 4;
            const x = pos[o] - ox, y = pos[o + 1] - oy, z = pos[o + 2] - oz;
            const t = x * dx + y * dy + z * dz;
            if (t <= 0 || t >= best) continue;
            const r = pickRadius[k];
            if (x * x + y * y + z * z - t * t < r * r) { best = t; hit = k; }
        }
        if (hit < 0) return;
        const point = ray.at(best, new THREE.Vector3()).applyMatrix4(this.matrixWorld);
        const distance = raycaster.ray.origin.distanceTo(point);
        if (distance < raycaster.near || distance > raycaster.far) return;
        intersects.push({ distance, point, object: this, index: pickIndex[hit] });
    }

    dispose() {
        this.sorter.dispose();
        this.geometry.dispose();
        this.material.dispose();
    }
}

// instanced quad + storage buffers (they hang on the geometry as well: geometry.dispose() frees their GPU memory)
function createGeometry(a, b, sh, count) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = 0;   // until the first sort
    const attrs = {
        a: new THREE.StorageBufferAttribute(a, 4),
        b: new THREE.StorageBufferAttribute(b, 4),
        order: new THREE.StorageBufferAttribute(new Uint32Array(count), 1),
        sh: sh ? new THREE.StorageBufferAttribute(sh, 1) : null,
    };
    geometry.setAttribute('splatA', attrs.a);
    geometry.setAttribute('splatB', attrs.b);
    geometry.setAttribute('splatOrder', attrs.order);
    if (attrs.sh) geometry.setAttribute('splatSH', attrs.sh);
    return { geometry, attrs };
}

function createMaterial() {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide });
    material.premultipliedAlpha = true;
    material.allowOverride = false;   // Basic view (clay) and mask passes keep the splats as they are
    material.fog = false;
    material.name = 'Gaussian Splats';
    return material;
}
