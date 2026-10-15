// Raster draw calls: meshes with the same geometry + material are drawn as one InstancedMesh.
//
// Large assemblies have one mesh per solid instance and surface group (large assembly: ~7500) and every mesh is
// a draw call – the CPU cost of the raster view. The path tracer is not affected (it draws via its scene BVH).
//
// Draw-only proxy: the individual meshes stay the scene for everything else (selection, picking, highlight,
// gizmo, explosion, materials, scene state, path tracer). A batched mesh only leaves layer 0, so the
// raster camera skips it; the InstancedMesh draws it instead. Picking raycasters enable BATCH_LAYER, the
// highlight mask uses its own layer.
//
// Nothing has to report changes – every frame that rasterizes `scene` compares the batched meshes with
// their InstancedMesh before drawing:
//   - matrix changed (gizmo, explosion, animation) → copied into the instance matrix
//   - hidden / shown (also via a parent) → instances repacked
//   - geometry/material changed, transparent, fading in, morph … → the mesh leaves its batch at once and is
//     drawn individually again; the grouping is rebuilt once nothing has changed for `delay` ms
//   - new or removed meshes → rebuild likewise
// Before a rebuild switches over, the shaders of its new InstancedMeshes are compiled asynchronously (_stage:
// compileAsync in the real draw context, shader-compile.js) – meanwhile the current grouping keeps drawing. Compiled in
// the draw frame, a regrouping blocked the main thread and then the GPU process (large assembly: ~0.7 s + ~0.9 s).
// The InstancedMeshes only hang in the scene during renderer.render(scene) – other traversals (path tracer,
// bounds, material usage) never see them.
//
// Side products of the comparison (one pass per frame anyway):
//   - `changed`: did anything that is drawn change since the last frame (matrix, shown/hidden, geometry,
//     material, new/removed mesh; skinned/morphed meshes always)? The viewer only re-renders the light
//     shadow maps then (onChange) – they were redrawn every frame (two passes over the whole model).
//   - one scene.updateMatrixWorld() per frame: three.js runs it in every renderer.render(scene) (main image,
//     every shadow map, highlight mask …) – a full pass over all objects each time.
import * as THREE from 'three/webgpu';
import { compileAsync } from './shader-compile.js';

export const BATCH_LAYER = 30;

export class RenderBatcher {
    /**
     * @param {{ renderer, scene, parent: THREE.Object3D, roots: () => THREE.Object3D[], minInstances?: number, delay?: number }} options
     *   parent = where the InstancedMeshes hang while drawing (section ClippingGroup), roots = model roots
     */
    constructor({ renderer, scene, parent, roots, minInstances = 2, delay = 500 }) {
        this.renderer = renderer;
        this.scene = scene;
        this.parent = parent;
        this.roots = roots;
        this.minInstances = minInstances;
        this.delay = delay;
        this.enabled = true;
        this.group = new THREE.Group();
        this.group.name = 'RenderBatches';
        this.group.matrixAutoUpdate = false;
        this.batches = [];               // { key, mesh: InstancedMesh, members: Mesh[], slots: Mesh[] }
        this.token = {};                 // state of a mesh: mesh[STATE] with st.token === this.token (cleared = new token)
        this.frame = 0;
        this._synced = -1;
        this._changedAt = null;          // last change of the grouping (null = none pending)
        this._depth = 0;
        this.generation = 0;             // +1 per rebuild that created batches (new shader variants possible)
        this.stats = { batches: 0, instances: 0, rebuilds: 0, rebuildMs: 0 };
        this.changed = true;             // last sync: something drawn changed
        this.onChange = null;            // called by sync when `changed` (before the render draws shadow maps)
        this._visHash = [0, 0];          // shown meshes of the last sync (sum + xor of ids)
        this._matrixFrame = -1;
        this.staging = new THREE.Group();   // new InstancedMeshes of a pending rebuild, compiling (_stage)
        this.staging.name = 'RenderBatchesStaging';
        this.staging.matrixAutoUpdate = false;
        this._staged = null;             // { at, ready, batches: Map key -> batch }

        const render = renderer.render.bind(renderer);
        // timing (debug display): CPU time of all renders of `scene` per frame, nested ones = shadow maps
        // (three.js renders them via renderer.render from inside the main render), comparison (sync)
        this.timing = { render: 0, nested: 0, sync: 0 };
        renderer.render = (s, camera) => {
            if (s !== this.scene) return render(s, camera);
            const t0 = performance.now();
            const outer = this._depth++ === 0;
            const auto = s.matrixWorldAutoUpdate;
            if (outer && this.enabled) {
                // world matrices once per frame (sync does it), all renders of this frame use them
                if (this._matrixFrame !== this.frame) { this._matrixFrame = this.frame; s.updateMatrixWorld(); }
                this._attach(camera);
                s.matrixWorldAutoUpdate = false;
            }
            try {
                return render(s, camera);
            } finally {
                if (outer) s.matrixWorldAutoUpdate = auto;
                if (--this._depth === 0) this._detach();
                this.timing[outer ? 'render' : 'nested'] += performance.now() - t0;
            }
        };
    }

    /** compileAsync() (shader-compile.js) with the current batches attached: compiles the shaders of what render()
     *  would draw. three.js collects the objects synchronously in the call, the batches only hang in the scene
     *  meanwhile. No sync here: a due regrouping is staged by the next real draw (its context, not e.g. the
     *  denoiser's albedo/normal pass). */
    compileAsync(s, camera) {
        const hang = s === this.scene && this.enabled && this._depth === 0 && this.batches.length > 0;
        if (hang) this._hang(this.group);
        try {
            return compileAsync(this.renderer, s, camera);
        } finally {
            if (hang) this._detach();
        }
    }

    /** Call once per frame before rendering – the first render of `scene` in a frame syncs */
    newFrame() {
        this.frame++;
        this.lastTiming = this.timing;
        this.timing = { render: 0, nested: 0, sync: 0 };
    }

    /** Grouping change waiting for its rebuild? */
    get pending() {
        return this.enabled && this._changedAt !== null;
    }

    /** Did the current frame already compare the meshes (scene rasterized this frame)? */
    get synced() {
        return this._synced === this.frame;
    }

    get meshes() {
        return this.batches.map(b => b.mesh);
    }

    setEnabled(on) {
        if (this.enabled === on) return;
        this.enabled = on;
        if (!on) this._clear();
        this._changedAt = on ? -Infinity : null;
        this.changed = true;
    }

    _attach(camera) {
        if (this._synced !== this.frame) {
            this._synced = this.frame;
            const t0 = performance.now();
            this.sync(camera);
            this.timing.sync += performance.now() - t0;
        }
        if (!this.batches.length) return;
        this._hang(this.group);
    }

    // instance matrices are world matrices → the group cancels the parent's world matrix
    _hang(group) {
        this.parent.updateWorldMatrix(true, false);
        group.matrix.copy(this.parent.matrixWorld).invert();
        group.matrixWorldNeedsUpdate = true;
        this.parent.add(group);
    }

    _detach() {
        if (this.group.parent) this.group.parent.remove(this.group);
    }

    /** Which meshes may be drawn as instances? Everything special is drawn individually */
    _keyOf(mesh) {
        const { material, geometry } = mesh;
        if (!material || Array.isArray(material) || mesh.isInstancedMesh || mesh.isSkinnedMesh || mesh.isBatchedMesh
            || mesh.isSplat || mesh.morphTargetInfluences || geometry.morphAttributes?.position) return null;
        if (material.transparent || material.transmission > 0 || mesh.renderOrder !== 0) return null;   // sorted per object
        if (mesh.userData.fade !== undefined && mesh.userData.fade < 1) return null;                      // dither fade-in per object
        if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return null;
        return `${geometry.id}/${material.id}/${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}${mesh.frustumCulled ? 1 : 0}`;
    }

    /** camera: of the render that syncs – a due rebuild is compiled for it first (_stage); without, at once */
    sync(camera = null) {
        if (!this.enabled) return;
        const now = performance.now();
        const frame = this.frame;
        this._changed = false;
        let sum = 0, xor = 0;

        // 1. visible meshes of the models (three's rule: invisible parent = whole subtree not drawn)
        const visit = o => {
            if (!o.visible) return;
            if (o.isMesh) {
                this._check(o, frame, now);
                sum += o.id;
                xor ^= Math.imul(o.id, 0x9E3779B1);
            }
            const children = o.children;
            for (let i = 0; i < children.length; i++) visit(children[i]);
        };
        for (const root of this.roots()) if (root) visit(root);
        if (sum !== this._visHash[0] || xor !== this._visHash[1]) { this._visHash = [sum, xor]; this._changed = true; }

        // 2. grouping changed and quiet since `delay` ms → compile the new batches (_stage), then rebuild
        //    (before 3., so the batches draw this frame). Changed again during compiling → stage anew.
        if (this._changedAt !== null && now - this._changedAt > this.delay) {
            const staged = this._staged;
            if (!camera) this.rebuild();
            else if (!staged) this._stage(camera);
            else if (staged.ready && staged.at >= this._changedAt) this.rebuild();
            else if (staged.ready) { this._dropStaged(); this._stage(camera); }
        }

        // 3. instance data
        for (const batch of this.batches) this._update(batch, frame, now);

        this.changed = this._changed;
        if (this.changed) this.onChange?.();
    }

    _check(mesh, frame, now) {
        let st = this._state(mesh);
        const e = mesh.matrixWorld.elements;
        if (!st) {
            st = this._newState(mesh, -1);
            st.seen = frame;
            st.matrix.set(e);
            st.moved = true;
            this._changed = true;
            if (st.key !== null) this._changedAt = now;   // new mesh – might join a batch
            return;
        }
        st.seen = frame;
        // matrix (all shown meshes: shadow maps; batched: instance data)
        const m = st.matrix;
        st.moved = false;
        for (let j = 0; j < 16; j++) {
            if (m[j] !== e[j]) { m.set(e); st.moved = true; this._changed = true; break; }
        }
        // skinning (animation puppet) deforms without a matrix change; morphs: compare the influences
        if (mesh.isSkinnedMesh) this._changed = true;
        else if (mesh.morphTargetInfluences) {
            let h = 0;
            mesh.morphTargetInfluences.forEach((v, i) => { h += v * (i + 1.618); });
            if (h !== st.morph) { st.morph = h; this._changed = true; }
        }
        // key only recomputed when one of its inputs changed (no string per mesh and frame)
        const flags = flagsOf(mesh);
        if (st.geometry === mesh.geometry && st.material === mesh.material && st.flags === flags) return;
        st.geometry = mesh.geometry; st.material = mesh.material; st.flags = flags;
        this._changed = true;
        const key = this._keyOf(mesh);
        if (st.key === key) return;
        if (st.batch) this._leave(mesh, st);
        st.key = key;
        if (key === null) return;
        // back to its batch (e.g. material transparent and opaque again): rejoin at once
        if (st.home?.alive && st.home.key === key) this._join(mesh, st, st.home);
        else this._changedAt = now;
    }

    _leave(mesh, st) {
        st.batch = null;
        mesh.layers.enable(0);
        mesh.layers.disable(BATCH_LAYER);
    }

    _join(mesh, st, batch) {
        st.batch = st.home = batch;
        mesh.layers.disable(0);
        mesh.layers.enable(BATCH_LAYER);
    }

    _update(batch, frame, now) {
        const { mesh: im, members, slots } = batch;
        const array = im.instanceMatrix.array;
        let n = 0, dirty = false;
        for (const m of members) {
            const st = m[STATE];
            if (st.batch !== batch) continue;
            if (st.seen !== frame) {
                // hidden – or removed from the scene (then rebuild to drop it)
                if (!inScene(m, this.scene)) { this._leave(m, st); this._changedAt = now; this._changed = true; }
                continue;
            }
            if (slots[n] !== m || st.moved) {
                slots[n] = m;
                array.set(st.matrix, n * 16);
                dirty = true;
            }
            n++;
        }
        if (n !== im.count) { im.count = n; slots.length = n; dirty = true; }
        im.visible = n > 0;
        if (dirty) {
            im.instanceMatrix.needsUpdate = true;
            im.boundingSphere = null;   // frustum culling recomputes it from the instances
            im.boundingBox = null;
        }
    }

    /** Group all batchable meshes by geometry + material; unchanged batches are kept */
    rebuild() {
        const t0 = performance.now();
        this._changedAt = null;
        const byKey = new Map();
        const visit = o => {
            if (o.isMesh) {
                let st = this._state(o);
                if (!st) st = this._newState(o, -1);
                const key = st.key = this._keyOf(o);
                st.geometry = o.geometry; st.material = o.material; st.flags = flagsOf(o);
                if (key !== null) {
                    if (!byKey.has(key)) byKey.set(key, []);
                    byKey.get(key).push(o);
                }
            }
            for (const c of o.children) visit(c);
        };
        for (const root of this.roots()) if (root) visit(root);

        const old = new Map(this.batches.map(b => [b.key, b]));
        const batches = [];
        let instances = 0, created = 0;
        for (const [key, members] of byKey) {
            if (members.length < this.minInstances) {
                for (const m of members) { const st = m[STATE]; if (st.batch) this._leave(m, st); }
                continue;
            }
            let batch = old.get(key);
            if (batch && sameMembers(batch.members, members)) old.delete(key);
            else { batch = this._takeStaged(key, members) || this._create(key, members); created++; }
            for (const m of members) this._join(m, m[STATE], batch);
            batches.push(batch);
            instances += members.length;
        }
        // dropped batches: members that are not in a new batch are drawn individually again
        for (const batch of old.values()) {
            for (const m of batch.members) {
                const st = this._state(m);
                if (st?.batch === batch) this._leave(m, st);
            }
            batch.alive = false;
            batch.mesh.dispose();   // frees its render objects + instance buffer (geometry/material are shared)
            this.group.remove(batch.mesh);
        }
        this.batches = batches;
        this._dropStaged();
        if (created) this.generation++;
        const ms = performance.now() - t0;
        this.stats = { batches: batches.length, instances, rebuilds: this.stats.rebuilds + 1, rebuildMs: ms };
    }

    // Compile the shaders of the next grouping before switching to it: its new InstancedMeshes (filled, not drawn
    // otherwise) hang in `staging` – same parent, camera and render target as the draw – only while compileAsync
    // (shader-compile.js) collects the scene, i.e. the same render objects as later. Called inside the draw
    // (renderer state = this render's). Current batches are detached meanwhile, their members are not on the
    // camera layer → compiled are the staged meshes plus individually drawn ones (already compiled, cheap).
    _stage(camera) {
        const old = new Map(this.batches.map(b => [b.key, b]));
        const staged = this._staged = { at: performance.now(), ready: false, batches: new Map() };
        for (const [key, members] of this._plan()) {
            if (members.length < this.minInstances) continue;
            const batch = old.get(key);
            if (batch && sameMembers(batch.members, members)) continue;
            const b = this._create(key, members, this.staging);
            const im = b.mesh, array = im.instanceMatrix.array;
            members.forEach((m, i) => array.set(m.matrixWorld.elements, i * 16));
            im.count = members.length;
            im.frustumCulled = false;   // no bounds yet
            staged.batches.set(key, b);
        }
        if (!staged.batches.size) { staged.ready = true; return; }
        let job;
        this._hang(this.staging);
        try {
            job = compileAsync(this.renderer, this.scene, camera);
        } catch (err) {
            job = Promise.reject(err);
        } finally {
            this.staging.removeFromParent();
        }
        job.catch(err => console.warn('[Batches] shader precompile failed:', err)).finally(() => { staged.ready = true; });
    }

    // grouping as rebuild() would do it – without touching the mesh states
    _plan() {
        const byKey = new Map();
        const visit = o => {
            if (o.isMesh) {
                const key = this._keyOf(o);
                if (key !== null) {
                    if (!byKey.has(key)) byKey.set(key, []);
                    byKey.get(key).push(o);
                }
            }
            for (const c of o.children) visit(c);
        };
        for (const root of this.roots()) if (root) visit(root);
        return byKey;
    }

    // staged batch with exactly these members → into the drawn group
    _takeStaged(key, members) {
        const batch = this._staged?.batches.get(key);
        if (!batch || !sameMembers(batch.members, members)) return null;
        this._staged.batches.delete(key);
        const im = batch.mesh;
        im.count = 0;   // _update fills the instances
        im.frustumCulled = members[0].frustumCulled;
        this.group.add(im);
        return batch;
    }

    _dropStaged() {
        if (!this._staged) return;
        for (const batch of this._staged.batches.values()) {
            batch.alive = false;
            batch.mesh.dispose();
            this.staging.remove(batch.mesh);
        }
        this._staged = null;
    }

    _create(key, members, parent = this.group) {
        const first = members[0];
        const im = new THREE.InstancedMesh(first.geometry, first.material, 0);
        im.name = `Batch ${first.name || ''}`.trim();
        im.count = 0;
        im.castShadow = first.castShadow;
        im.receiveShadow = first.receiveShadow;
        im.frustumCulled = first.frustumCulled;
        im.matrixAutoUpdate = false;
        im.raycast = () => {};
        im.userData.batch = true;
        // section caps ask whether the body is closed (same geometry = same solid)
        if (first.userData.instance !== undefined) im.userData.instance = first.userData.instance;
        if (first.userData.closedSolid !== undefined) im.userData.closedSolid = first.userData.closedSolid;
        // Instance matrices as a storage buffer: runtime-sized array in the shader → one shader per material.
        // The default (uniform buffer up to maxUniformBufferBindingSize – we request the adapter maximum)
        // writes the instance count into the shader (array<mat4x4f, N>) → every batch size was its own
        // shader, compiled synchronously on first use (freeze after loading and on the first view mode switch).
        // WebGL2 has no storage buffers: capacity rounded up to a power of two → few sizes.
        if (this.renderer.backend?.isWebGPUBackend) {
            im.instanceMatrix = new THREE.StorageInstancedBufferAttribute(new Float32Array(members.length * 16), 16);
        } else {
            im.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(2 ** Math.ceil(Math.log2(members.length)) * 16), 16);
            im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        }
        parent.add(im);
        return { key, mesh: im, members, slots: [], alive: true };
    }

    _clear() {
        for (const batch of this.batches) {
            for (const m of batch.members) {
                const st = this._state(m);
                if (st?.batch === batch) this._leave(m, st);
            }
            batch.alive = false;
            batch.mesh.dispose();
            this.group.remove(batch.mesh);
        }
        this.batches = [];
        this._dropStaged();
        this.token = {};   // all mesh states invalid
    }

    _state(mesh) {
        const st = mesh[STATE];
        return st && st.token === this.token ? st : null;
    }

    _newState(mesh, seen) {
        const st = {
            token: this.token, key: this._keyOf(mesh), batch: null, home: null, seen,
            geometry: mesh.geometry, material: mesh.material, flags: flagsOf(mesh),
            matrix: new Float64Array(16), moved: true,
        };
        st.matrix.set(mesh.matrixWorld.elements);
        mesh[STATE] = st;
        return st;
    }
}

const STATE = Symbol('renderBatch');

// inputs of _keyOf besides geometry/material identity – compared per frame instead of building the key
function flagsOf(mesh) {
    const m = mesh.material;
    const fading = mesh.userData.fade !== undefined && mesh.userData.fade < 1;
    const range = mesh.geometry.drawRange;
    return (mesh.castShadow ? 1 : 0) | (mesh.receiveShadow ? 2 : 0) | (mesh.frustumCulled ? 4 : 0)
        | (m?.transparent ? 8 : 0) | (m?.transmission > 0 ? 16 : 0) | (fading ? 32 : 0)
        | (mesh.renderOrder !== 0 ? 64 : 0) | (range.start !== 0 || range.count !== Infinity ? 128 : 0);
}

function sameMembers(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function inScene(o, scene) {
    for (; o; o = o.parent) if (o === scene) return true;
    return false;
}
