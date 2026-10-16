// Exploded view: parts glide smoothly away from the model centre and back together.
//
// Every part (group with its own meshes) moves by (part centre − model centre) · factor ·
// strength – distant parts further, central ones barely. With several models side by side every model
// explodes around its own centre (root group marked with userData.modelRoot). Nested parts only get the difference to
// the nearest exploded ancestor (otherwise doubled). The offset lives in xf.explode (parent space,
// see transform.js) – separate from the user's translations, not in the undo history.
// Centres are determined in the collapsed state during preparation (prepare). Stray objects (userData.stray, see
// outliers.js) count for no centre: a part made only of them keeps its place.
import * as THREE from 'three/webgpu';
import { applyTransform, ensureTransform } from './transform.js';

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _m3 = new THREE.Matrix3();
const _inv = new THREE.Matrix4();

export class Exploder extends EventTarget {
    /**
     * Events: 'start', 'update', 'end' (animation), 'change' (target value changed – button/panel)
     * @param {() => THREE.Object3D[]} getParts  part groups, parents before children
     */
    constructor(getParts) {
        super();
        this.getParts = getParts;
        this.factor = 0;         // current value (0 = collapsed)
        this.target = 0;         // animation target
        this.strength = 1;       // value when switched on (button/key)
        this.duration = 700;     // ms
        this.parts = null;       // [{ group, dir (world), ancestor }]
        this.anim = null;
    }

    get active() {
        return this.target > 0;
    }

    toggle() {
        this.set(this.active ? 0 : this.strength);
    }

    /** Set the target value (0 = collapsed); animate = move smoothly */
    set(value, { animate = true } = {}) {
        value = Math.max(0, value);
        if (value > 0) this.strength = value;
        this.target = value;
        this.dispatchEvent(new Event('change'));
        if (!this.parts) this.prepare();
        if (!animate) {   // immediately (slider, scene state) – the caller updates the path tracer
            this.anim = null;
            this.factor = value;
            this.apply();
            this.dispatchEvent(new Event('update'));
            return;
        }
        if (Math.abs(this.factor - value) < 1e-6) return;
        if (!this.anim) this.dispatchEvent(new Event('start'));
        this.anim = { from: this.factor, to: value, t0: performance.now() };
    }

    /** Call in the render loop; true while animating */
    update(now) {
        const a = this.anim;
        if (!a) return false;
        const t = Math.min((now - a.t0) / this.duration, 1);
        const k = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;   // ease-in-out (cubic)
        this.factor = a.from + (a.to - a.from) * k;
        this.apply();
        this.dispatchEvent(new Event('update'));
        if (t >= 1) { this.anim = null; this.dispatchEvent(new Event('end')); }
        return true;
    }

    /** New model: forget everything (collapsed) */
    reset() {
        this.anim = null;
        this.factor = this.target = 0;
        this.parts = null;
        this.dispatchEvent(new Event('change'));
    }

    /** Groups rebuilt (re-tessellation): recompute directions, keep the current value */
    refresh() {
        this.parts = null;
        if (this.factor > 0 || this.target > 0) {
            this.anim = null;
            this.factor = this.target;
            this.prepare();
            this.apply();
        }
    }

    // Determine directions in the collapsed state
    prepare() {
        const groups = this.getParts();
        for (const g of groups) { ensureTransform(g); g.userData.xf.explode.set(0, 0, 0); applyTransform(g); }
        const centerOf = g => {
            _box.makeEmpty();
            g.updateMatrixWorld(true);
            g.traverse(c => {
                if (!c.isMesh || c.userData.stray) return;   // stray objects (outliers.js) neither move nor shift the centre
                if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
                _box.union(new THREE.Box3().copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld));
            });
            return _box.isEmpty() ? null : _box.getCenter(new THREE.Vector3());
        };
        // centre per model (several models side by side must not drift apart)
        const modelOf = g => { for (let p = g; p; p = p.parent) if (p.userData.modelRoot) return p; return null; };
        const boxes = new Map();
        const centers = groups.map(g => {
            const c = centerOf(g);
            if (c) {
                const m = modelOf(g);
                if (!boxes.has(m)) boxes.set(m, new THREE.Box3());
                boxes.get(m).union(_box);
            }
            return c;
        });
        const mids = new Map([...boxes].map(([m, b]) => [m, b.getCenter(new THREE.Vector3())]));
        const set = new Set(groups);
        this.parts = groups.map((group, i) => {
            let ancestor = null;
            for (let p = group.parent; p; p = p.parent) if (set.has(p)) { ancestor = p; break; }
            const mid = mids.get(modelOf(group));
            return { group, dir: centers[i] && mid ? centers[i].clone().sub(mid) : new THREE.Vector3(), ancestor };
        });
    }

    // Set the offset for the current factor (parents before children)
    apply() {
        if (!this.parts) return;
        const world = new Map();   // group -> world offset
        for (const { group, dir, ancestor } of this.parts) {
            const D = dir.clone().multiplyScalar(this.factor);
            world.set(group, D);
            // relative to the ancestor, into parent space (linear part of the parent matrix only)
            _v.copy(D);
            if (ancestor) _v.sub(world.get(ancestor));
            group.parent.updateMatrixWorld(true);
            _m3.setFromMatrix4(_inv.copy(group.parent.matrixWorld).invert());
            group.userData.xf.explode.copy(_v.applyMatrix3(_m3));
            applyTransform(group);
        }
    }

    toJSON() {
        return this.target;
    }
}
