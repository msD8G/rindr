// Animation of imported glTF/FBX models.
//
// The importer bakes models into own meshes (absolute matrices, own buffers, skinning frozen). For animated
// files it keeps the loader's source object as a "puppet": three.js' AnimationMixer drives it.
//   - rigid parts (node animation): every frame our mesh matrix = scale (→ mm) · puppet world matrix
//   - deformed parts (skinning/morph targets): while playing/scrubbing the puppet's own SkinnedMesh is shown
//     (GPU skinning like Sketchfab – vertex shader with the bone matrices) with our material, our baked
//     mesh is hidden. Only when it stops (settle) the current pose is copied once into our mesh on the CPU
//     (positions + normals) – for the path tracer, picking and the section caps. Previously every frame was
//     skinned on the CPU and uploaded completely → very jerky.
// The puppet hangs in a container (scale → mm) below the model root while live; user moves of single parts
// (xf) do not apply to the live skinned parts, the explosion neither (both apply again after settle).
import * as THREE from 'three/webgpu';

const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _base = new THREE.Vector3(), _tip = new THREE.Vector3();
const _m = new THREE.Matrix4(), _im = new THREE.Matrix4(), _inv = new THREE.Matrix4();

export class ModelAnimation {
    /**
     * @param {{ root: THREE.Object3D, clips: THREE.AnimationClip[], scale: number, links: object[] }} source  from importMeshFile
     * @param {THREE.Mesh[]} meshes  our meshes in the order of the import result (links[i] belongs to meshes[i])
     * @param {THREE.Object3D} modelRoot  our model root group (the live puppet is attached there)
     */
    constructor({ root, clips, scale, links }, meshes, modelRoot) {
        this.root = root;
        this.clips = clips;
        this.modelRoot = modelRoot;
        this.toMm = new THREE.Matrix4().makeScale(scale, scale, scale);
        this.items = links.map((link, i) => ({ ...link, target: meshes[i] })).filter(it => it.target);
        // container: puppet space → model space (mm)
        this.container = new THREE.Group();
        this.container.name = 'AnimationPuppet';
        this.container.matrixAutoUpdate = false;
        this.container.matrix.copy(this.toMm);
        this.container.add(root);
        // puppet: only its deformed meshes are ever shown (with our materials); no lights/cameras
        this.live = new Map();   // puppet mesh -> our target meshes
        root.traverse(o => {
            if (o.isLight || o.isCamera) o.visible = false;
            if (o.isMesh) {
                o.visible = false;
                // never hit by picking: SkinnedMesh.raycast skins every vertex on the CPU (hover/material drag
                // while playing stuttered) – picking uses our meshes (userData.liveHidden) instead
                o.raycast = () => {};
            }
        });
        for (const it of this.items) {
            if (!it.posed) continue;
            if (!this.live.has(it.mesh)) this.live.set(it.mesh, []);
            this.live.get(it.mesh).push(it);
        }
        for (const mesh of this.live.keys()) {
            mergeGroups(mesh.geometry);
            mesh.frustumCulled = false;
            mesh.castShadow = mesh.receiveShadow = true;
            // move of the part (see _followParts): applied after three.js computed the matrices of the frame
            const update = mesh.updateMatrixWorld;
            mesh.updateMatrixWorld = function (force) {
                update.call(this, force);
                const x = this.userData.follow;
                if (!x) return;
                if (this.isSkinnedMesh) this.bindMatrixInverse.multiply(x);   // attached: was matrixWorld⁻¹
                else this.matrixWorld.premultiply(x);
            };
        }
        this._syncMaterials();
        // morph targets (blend shapes): name → [{ mesh, index, targets }] – the same name on several meshes
        // (face + eyelashes) is one slider
        this.morphs = new Map();
        for (const [mesh, its] of this.live) {
            for (const [name, index] of Object.entries(mesh.morphTargetDictionary || {})) {
                if (!this.morphs.has(name)) this.morphs.set(name, []);
                this.morphs.get(name).push({ mesh, index, targets: its.map(it => it.target) });
            }
        }
        this.isLive = false;
        this.mixer = new THREE.AnimationMixer(root);
        this.clipIndex = 0;
        this.action = null;
        this.setClip(0);
    }

    get duration() {
        return this.clips[this.clipIndex]?.duration || 0;
    }

    get time() {
        return this.action ? this.action.time : 0;
    }

    /** Has deformed (skinned/morphed) meshes – the path tracer then needs new BVHs after settle */
    get deforms() {
        return this.live.size > 0;
    }

    setClip(index) {
        this.action?.stop();
        if (!this.clips.length) { this.action = null; return; }   // morph targets only
        this.clipIndex = Math.min(Math.max(index, 0), this.clips.length - 1);
        this.action = this.mixer.clipAction(this.clips[this.clipIndex]);
        this.action.setLoop(THREE.LoopRepeat, Infinity);
        this.action.play();
        this.setTime(0);
    }

    /** Show the deformed parts live (GPU skinning) – while playing/scrubbing */
    startLive() {
        if (this.isLive || !this.live.size) return;
        this.isLive = true;
        this._syncMaterials();   // our meshes may have got other materials since (assignment, merging)
        this.modelRoot.add(this.container);
        for (const [mesh, its] of this.live) {
            mesh.visible = true;
            for (const it of its) { it.wasVisible = it.target.visible; it.target.visible = false; it.target.userData.liveHidden = true; }
        }
        this._followParts();
    }

    // the puppet's deformed meshes show the materials of our meshes
    _syncMaterials() {
        for (const [mesh, its] of this.live) {
            if (Array.isArray(mesh.material)) {
                const mats = [...mesh.material];
                for (const it of its) if (it.materialIndex >= 0) mats[it.materialIndex] = it.target.material;
                mesh.material = mats;
            } else mesh.material = its[0].target.material;
        }
    }

    /** Back to our baked meshes with the current pose (CPU, once) */
    stopLive() {
        if (!this.isLive) return;
        this.isLive = false;
        this.container.removeFromParent();
        for (const [mesh, its] of this.live) {
            mesh.visible = false;
            mesh.userData.follow = null;
            for (const it of its) { it.target.visible = it.wasVisible ?? true; delete it.target.userData.liveHidden; }
        }
    }

    /** Jump to a time (s) and copy the pose (rigid parts; deformed ones only when not live) */
    setTime(t) {
        if (!this.action) return;
        this.action.time = Math.min(Math.max(t, 0), this.duration);
        this.mixer.update(0);
        this.apply(!this.isLive);
    }

    /** Morph target names (blend shapes), optionally only those of the given meshes of ours */
    morphNames(targets) {
        const names = [];
        for (const [name, list] of this.morphs) if (!targets || list.some(m => m.targets.some(t => targets.has(t)))) names.push(name);
        return names;
    }

    getMorph(name) {
        const m = this.morphs.get(name)?.[0];
        return m ? m.mesh.morphTargetInfluences[m.index] : 0;
    }

    /** Set a morph target (0…1) – visible live (startLive) or after settle() */
    setMorph(name, value) {
        for (const m of this.morphs.get(name) || []) m.mesh.morphTargetInfluences[m.index] = value;
    }

    /** All morph values ≠ 0 (scene state) */
    morphValues() {
        const out = {};
        for (const name of this.morphs.keys()) { const v = this.getMorph(name); if (v) out[name] = +v.toFixed(4); }
        return out;
    }

    /** Set all morph targets (missing names = 0); true if something changed */
    setMorphs(values = {}) {
        let changed = false;
        for (const name of this.morphs.keys()) {
            const v = values[name] ?? 0;
            if (this.getMorph(name) !== v) { this.setMorph(name, v); changed = true; }
        }
        return changed;
    }

    /** Advance by dt (s) */
    update(dt) {
        this.mixer.update(dt);
        this.apply(!this.isLive);
    }

    // puppet pose → our meshes: matrices always, CPU deformation only if asked (not while live)
    apply(deform) {
        this.container.updateMatrixWorld(true);
        _inv.copy(this.container.matrixWorld).invert();
        for (const it of this.items) {
            const { mesh, target } = it;
            // puppet world → puppet space (as at import) → mm
            _m.multiplyMatrices(_inv, mesh.matrixWorld).premultiply(this.toMm);
            if (it.instance >= 0) _m.multiply((mesh.getMatrixAt(it.instance, _im), _im));
            target.matrix.copy(_m);
            target.matrixWorldNeedsUpdate = true;
            if (it.posed && deform) this._deform(it);
        }
        if (this.isLive) this._followParts();
    }

    // Live deformed meshes hang in the puppet container, not below our part groups – user moves/rotations
    // of the part and the explosion (group matrices, userData.xf) would not apply. X = move of the part group
    // in world space (root · (root⁻¹ · group) · root⁻¹). Skinning (attached) puts the vertices at the bones'
    // world positions: world = matrixWorld · bindMatrixInverse · S with bindMatrixInverse = matrixWorld⁻¹ –
    // multiplying X onto bindMatrixInverse moves the result by X. Morph-only meshes: X before matrixWorld.
    _followParts() {
        this.modelRoot.updateMatrixWorld(true);
        _inv.copy(this.modelRoot.matrixWorld).invert();
        for (const [mesh, its] of this.live) {
            const group = its[0].target.parent;
            if (!group) continue;
            const x = mesh.userData.follow ??= new THREE.Matrix4();
            x.multiplyMatrices(_inv, group.matrixWorld).premultiply(this.modelRoot.matrixWorld).multiply(_inv);
        }
    }

    // CPU re-skinning of one deformed mesh into our geometry
    _deform({ mesh, target, sourceVertex }) {
        const geometry = target.geometry;
        const pos = geometry.getAttribute('position'), nor = geometry.getAttribute('normal');
        const srcPos = mesh.geometry.getAttribute('position'), srcNor = mesh.geometry.getAttribute('normal');
        const skinned = mesh.isSkinnedMesh;
        for (let o = 0; o < sourceVertex.length; o++) {
            const v = sourceVertex[o];
            mesh.getVertexPosition(v, _p);
            pos.setXYZ(o, _p.x, _p.y, _p.z);
            if (srcNor && nor) {
                _n.fromBufferAttribute(srcNor, v);
                if (skinned) {
                    _base.fromBufferAttribute(srcPos, v);
                    _tip.copy(_base).add(_n);
                    mesh.applyBoneTransform(v, _base);
                    mesh.applyBoneTransform(v, _tip);
                    _n.subVectors(_tip, _base).normalize();
                }
                nor.setXYZ(o, _n.x, _n.y, _n.z);
            }
        }
        pos.needsUpdate = true;
        if (nor) nor.needsUpdate = true;
    }

    /** After playing/scrubbing: current pose into our meshes, stale BVHs dropped (path tracer/picking rebuild) */
    settle({ morphsOnly = false } = {}) {
        this.stopLive();
        this.apply(false);
        // morph slider: only meshes the morph targets actually move (the face of a character, not its
        // 2.6 million other vertices) – deforming and new BVHs only there
        for (const it of this.items) {
            if (!it.posed || (morphsOnly && !this._morphAffected(it))) continue;
            this._deform(it);
            const g = it.target.geometry;
            g.computeBoundingBox();
            g.computeBoundingSphere();
            g.boundsTree = null;
        }
    }

    // does any morph target move a vertex of this mesh of ours? (cached)
    _morphAffected(it) {
        if (it.morphAffected !== undefined) return it.morphAffected;
        const geometry = it.mesh.geometry, targets = geometry.morphAttributes.position || [];
        const base = geometry.getAttribute('position');
        const relative = geometry.morphTargetsRelative;
        it.morphAffected = targets.some(attr => {
            const plain = !attr.isInterleavedBufferAttribute && !base.isInterleavedBufferAttribute;
            const a = attr.array, b = base.array, sa = attr.itemSize, sb = base.itemSize;
            for (const v of it.sourceVertex) {
                for (let c = 0; c < 3; c++) {
                    const d = plain ? a[v * sa + c] - (relative ? 0 : b[v * sb + c])
                        : attr.getComponent(v, c) - (relative ? 0 : base.getComponent(v, c));
                    if (d > 1e-9 || d < -1e-9) return true;
                }
            }
            return false;
        });
        return it.morphAffected;
    }

    dispose() {
        this.stopLive();
        this.mixer.stopAllAction();
        this.mixer.uncacheRoot(this.root);
    }
}

// One draw group per material instead of one per source group (an animated FBX had 33 683 groups for 43
// materials → 101 000 draw calls per frame incl. shadow passes while live). Reorders the index so the
// groups of a material are contiguous; vertices (and with them sourceVertex, morph/skin data) stay.
function mergeGroups(geometry) {
    const groups = geometry.groups;
    if (groups.length < 2 || new Set(groups.map(g => g.materialIndex)).size === groups.length) return;
    const src = geometry.index?.array;
    const total = src ? src.length : geometry.getAttribute('position').count;
    const sorted = groups.map((g, i) => ({ g, i })).sort((a, b) => (a.g.materialIndex - b.g.materialIndex) || (a.i - b.i));
    const index = new Uint32Array(sorted.reduce((n, { g }) => n + Math.max(0, Math.min(total, g.start + g.count) - g.start), 0));
    const merged = [];
    let w = 0;
    for (const { g } of sorted) {
        const end = Math.min(total, g.start + g.count);
        const last = merged[merged.length - 1];
        if (last?.materialIndex === g.materialIndex) last.count += end - g.start;
        else merged.push({ start: w, count: end - g.start, materialIndex: g.materialIndex });
        for (let i = g.start; i < end; i++) index[w++] = src ? src[i] : i;
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.clearGroups();
    for (const m of merged) geometry.addGroup(m.start, m.count, m.materialIndex);
}

const ICON_PLAY = '<svg viewBox="0 0 16 16" class="size-3.5 fill-current"><path d="M4.5 2.8v10.4L13 8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-current"><rect x="3.5" y="2.8" width="3" height="10.4" rx="0.6"/><rect x="9.5" y="2.8" width="3" height="10.4" rx="0.6"/></svg>';

/**
 * Play bar above the bottom toolbar: play/pause, time slider, time, clip choice (several clips).
 * @param {HTMLElement} root
 * @param {{ onPlay(playing: boolean), onScrub(t: number), onScrubEnd(), onClip(index: number) }} handlers
 */
export function createPlaybar(root, { onPlay, onScrub, onScrubEnd, onClip }, { t }) {
    root.className = 'pointer-events-auto absolute bottom-16 left-1/2 flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 py-1 pr-4 pl-1 text-xs text-white/80 backdrop-blur-sm';
    const play = document.createElement('button');
    play.className = 'flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-white/10 hover:text-white';
    const slider = document.createElement('input');
    Object.assign(slider, { type: 'range', min: 0, max: 1, step: 'any', value: 0 });
    slider.className = 'min-w-0 flex-1 accent-sky-400';
    slider.title = t('animation.timeline');
    const time = document.createElement('span');
    time.className = 'shrink-0 tabular-nums text-white/60';
    const clips = document.createElement('select');
    clips.className = 'max-w-40 shrink-0 cursor-pointer truncate rounded bg-white/10 px-1.5 py-0.5 text-white outline-none';
    clips.title = t('animation.clip');
    root.append(play, slider, time, clips);

    let playing = null, scrubbing = false;
    // only on a real change: the bar is refreshed ~10× per second while playing – replacing the icon
    // between mouse down and up made the browser drop the click (pause did not work)
    const setPlaying = p => {
        if (p === playing) return;
        playing = p;
        play.innerHTML = p ? ICON_PAUSE : ICON_PLAY;
        play.title = t(p ? 'animation.pause' : 'animation.play');
    };
    setPlaying(false);
    play.onclick = () => { play.blur(); onPlay(!playing); };
    slider.addEventListener('input', () => { scrubbing = true; onScrub(Number(slider.value)); });
    slider.addEventListener('change', () => { scrubbing = false; onScrubEnd(); });
    clips.addEventListener('change', () => onClip(Number(clips.value)));

    return {
        setVisible(v) { root.hidden = !v; },
        setPlaying,
        get playing() { return playing; },
        setTime(current, duration) {
            slider.max = duration || 1;
            if (!scrubbing) slider.value = current;
            time.textContent = `${current.toFixed(1)} / ${duration.toFixed(1)} s`;
        },
        setClips(names, index) {
            clips.replaceChildren(...names.map((n, i) => new Option(n || t('animation.clipName', { n: i + 1 }), i)));
            clips.value = index;
            clips.hidden = names.length < 2;
        },
    };
}
