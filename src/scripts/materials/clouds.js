// Cloud material (wish of the user: "das Objekt als fluffige Wolke rendern" – puffing out over the object's shape,
// real volume in HQ). The meshes carrying a cloud material are not drawn themselves (RindrMaterial.setCloud: the
// material is invisible, the path tracer leaves them out); per cloud material one volume stands in for all of them:
//  - shape: signed distance field of the meshes' union (cloud-field.js, worker), 96³ voxels over their box plus a
//    margin for the puffs, in one 3D texture atlas (CLOUD_SLOTS volumes + one slot for the material preview);
//    recomputed when the meshes move, appear or disappear (checked every frame, cheap; computed after a short pause)
//  - density = inflated shape: the surface pushed out by `puff` × scale, modulated by billows (inverted Worley) and
//    eroded by wisps (gradient fbm) from a small tiling noise texture – the same lookups in raster and path tracer
//  - proxy: a unit box per volume, scaled over the field's box – the raster ray-marches it (front faces with the
//    depth test: things in front hide it; camera inside the box: back faces; ends at the ground), the path tracer
//    scatters through it (cloud-pt.js). The scene's depth copy (viewportDepthTexture) cannot be bound: the canvas
//    has a stencil (depth24plus-stencil8, both aspects in one view)
//  - raster lighting: single scattering towards the environment's sun (brightest region of the HDRI, its
//    irradiance above the average) with a few shadow steps, a softer multiple-scattering term, ambient from the
//    environment's average darkened with depth inside – an approximation; HQ is the real thing
// Scale S = the largest extent of the meshes' box: puffs, noise and density are relative to it (the same look for a
// 10 mm part and a 10 m building). Optical depth across the cloud ≈ CLOUD_SIGMA × density.
import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, texture3D, vec2, vec3, vec4, float, If, Loop, Break, Discard, max, min, exp, mix, smoothstep, clamp, dot, normalize, select, length, positionWorld, cameraPosition, cameraWorldMatrix, cameraViewMatrix, modelWorldMatrixInverse, screenCoordinate, fract } from 'three/tsl';
import { MeshBVH } from 'three-mesh-bvh';
import { FIELD_RES, FIELD_RANGE, NOISE_RES, detailNoise, sphereField } from './cloud-field.js';
import { debugLog } from '../log.js';

export const CLOUD_SLOTS = 4;               // cloud materials at the same time (more: the rest stays invisible)
const ATLAS_SLOTS = CLOUD_SLOTS + 1;        // + the material preview's sphere
const PREVIEW_SLOT = CLOUD_SLOTS;
const PREVIEW_PUFF = 0.12;                  // material preview: puff at least (lumps visible at icon size)
const PREVIEW_LIGHT = 5;                    // material preview: key light from the upper left (irradiance)
const PREVIEW_CORE = 0.7;                   // material preview: sphere radius – with its puffs as big as the others
const PREVIEW_AMBIENT = 0.35;               // material preview: environment share (shading of the lumps visible)
export const CLOUD_SIGMA = 12;              // optical depth across the cloud (scale S) at density 1
export const CLOUD_G = 0.6;                 // Henyey-Greenstein anisotropy (forward scattering, silver lining)
// noise frequencies per scale S, divided by puff: the lumps scale with the swelling (~2.4 puffs across at 0.07 –
// fixed sizes made a small puff blobby, the shape got lost; CPU prototype: Scratchpad cloudproto.mjs)
export const CLOUD_NOISE = { billow: 0.07, wisp: 0.25 };
export const CLOUD_REACH = 2.0;             // the cloud reaches this many puffs beyond the surface (density 0 there)
const MARGIN = 2.3;                         // box margin in puffs (beyond the reach)
const STEPS = 160;                          // raster: view steps at most (empty space is skipped)
const FINE = 1 / 90;                        // raster: step inside the cloud, × scale
const LIGHT_STEPS = 5;                      // raster: shadow steps towards a light, doubling (0.02 … 0.62 × scale)
// raster approximation of what HQ scatters many times: a soft sun term (transmittance^0.25, isotropic) and ambient
// fading slowly with the depth inside – matched to HQ (test body, studio: centre 187 → 218, edge 142 → 173 before)
// octaves: light scattered many times seen as ever weaker extinction (× extinction), weight (× weight) and
// anisotropy (×0.5) per octave – weights matched to HQ (with ×0.25/×0.5 the shadowed bases stayed far too dark)
// per octave (Wrenninge – bright soft insides); powder: the first stretch below a surface facing away from the light
// is darker (dark creases between the lumps)
const RASTER = { ambientFade: 0.04, gain: 0.55, sky: 0.75, octaves: 4, extinction: 0.3, weight: 0.75, floor: 0.12 };
const RECOMPUTE_MS = 150;                   // pause after the last change before the field is made anew
const MAX_TRIANGLES = 2e6;                  // more: every n-th triangle (the surface stays dense enough)

// --- shared textures (raster materials and the path tracer's kernel read the same ones) ---

const atlasData = new Uint8Array(FIELD_RES * FIELD_RES * FIELD_RES * ATLAS_SLOTS).fill(255);   // 255 = far outside
const atlas = new THREE.Data3DTexture(atlasData, FIELD_RES, FIELD_RES, FIELD_RES * ATLAS_SLOTS);
atlas.format = THREE.RedFormat;
atlas.minFilter = atlas.magFilter = THREE.LinearFilter;
atlas.wrapS = atlas.wrapT = atlas.wrapR = THREE.ClampToEdgeWrapping;
atlas.unpackAlignment = 1;
atlas.needsUpdate = true;

// filled on first use (ensureNoise: ~30 ms – not at the start for everyone)
const noiseData = new Uint8Array(NOISE_RES ** 3 * 2);
const noise = new THREE.Data3DTexture(noiseData, NOISE_RES, NOISE_RES, NOISE_RES);
noise.format = THREE.RGFormat;
noise.minFilter = noise.magFilter = THREE.LinearFilter;
noise.wrapS = noise.wrapT = noise.wrapR = THREE.RepeatWrapping;
noise.unpackAlignment = 1;
noise.needsUpdate = true;

let noiseFilled = false;
function ensureNoise() {
    if (noiseFilled) return;
    noiseFilled = true;
    noiseData.set(detailNoise());
    noise.needsUpdate = true;
}

export const CLOUD_TEXTURES = { atlas, noise, slots: ATLAS_SLOTS };


// light for the raster approximation: LIGHTS directions towards the light + irradiances – slot 0 = the environment's
// sun (setEnvironment), the others = the scene's directional lights (update: main and fill light of the viewer,
// shown ones); ambient radiance = the environment's (× intensity) + the scene's ambient light / π
const LIGHTS = 4;
const lightDir = uniformArray(Array.from({ length: LIGHTS }, () => new THREE.Vector4(0, 1, 0, 0)), 'vec4');
const lightColor = uniformArray(Array.from({ length: LIGHTS }, () => new THREE.Vector4(0, 0, 0, 0)), 'vec4');
// ambient: radiance from above (sky) and below (floor) – mixed by the height inside the cloud (light tops, darker
// bases); a uniform ambient made every cloud the same white whatever the HDRI or lights did
const ambientSky = uniform(new THREE.Vector3(0.5, 0.5, 0.5));
const ambientGround = uniform(new THREE.Vector3(0.3, 0.3, 0.3));
const envSky = new THREE.Vector3(0.5, 0.5, 0.5), envGround = new THREE.Vector3(0.3, 0.3, 0.3);
const groundOn = uniform(false, 'bool');
const groundY = uniform(0);

// --- density (TSL; the WGSL version in cloud-pt.js must match) ---

// local: position in the unit box (−0.5…0.5), world: world position; volume: { slot, scale, puff }
function fieldAt(local, slot) {
    const h = 0.5 / FIELD_RES;
    const w = clamp(local.z.add(0.5), h, 1 - h).add(slot).div(ATLAS_SLOTS);
    const f = texture3D(atlas, vec3(local.x.add(0.5), local.y.add(0.5), w)).r;
    return f.sub(0.5).mul(2 * FIELD_RANGE);   // signed distance / scale
}

// coverage from the shape (1 at the surface and inside, 0 at CLOUD_REACH puffs outside, linear), eroded by
// remapping: between the billows (inverted Worley) fully, then by the wisps, sharpened (÷ 0.3) – crisp lumps; the
// core stays dense (remap keeps 1). Before (Oct. 2026): billows pushed the surface out additively – soft edges; a
// circular coverage rose too fast, the erosion only reached a thin shell (smooth blob)
export const EROSION = { billow: 1.0, wisp: 0.3, sharp: 0.3 };
const remap01 = (x, lo) => clamp(x.sub(lo).div(max(float(1).sub(lo), 0.001)), 0, 1);
function densityAt(local, world, v, cheap = false) {
    const sd = fieldAt(local, v.slot);
    const reach = v.puff.mul(CLOUD_REACH);
    const coverage = clamp(reach.sub(sd).div(reach), 0, 1);
    const q = world.div(v.scale);
    const billow = texture3D(noise, q.mul(float(CLOUD_NOISE.billow).div(v.puff)).add(vec3(0.13, 0.71, 0.37))).r;
    const d = remap01(coverage, float(1).sub(billow).mul(EROSION.billow));
    if (cheap) return min(d.div(EROSION.sharp), 1);
    const wisp = texture3D(noise, q.mul(float(CLOUD_NOISE.wisp).div(v.puff))).g;
    return min(remap01(d, wisp.mul(EROSION.wisp)).div(EROSION.sharp), 1);
}

const hg = (cos, g) => float(1 - g * g).div(float(1 + g * g).sub(cos.mul(2 * g)).pow(1.5)).mul(1 / (4 * Math.PI));

// light reaching a point: octaves of scattering (exp(−τ·aⁱ) · bⁱ · phase with g·cⁱ, dual lobe) × powder
function lightEnergy(tau, mu) {
    const sum = float(0).toVar();
    let a = 1, b = 1, c = 1;
    for (let i = 0; i < RASTER.octaves; i++) {
        const phase = hg(mu, -0.3).mul(0.25).add(hg(mu, CLOUD_G * c).mul(0.75));
        sum.addAssign(exp(tau.mul(-a)).mul(phase).mul(b));
        a *= RASTER.extinction; b *= RASTER.weight; c *= 0.5;
    }
    const powder = float(1).sub(exp(tau.mul(-2)));
    // functional mix(a, b, t): the method form x.mix(a, b) takes x as the factor (swapped powder and sky/floor)
    return sum.mul(mix(powder.mul(2), float(1), mu.mul(0.5).add(0.5)));
}

// ray march through the proxy box (raster): empty space skipped by the shape's distance (no density beyond the
// reach), fine steps inside the cloud
function cloudNode(v) {
    return Fn(() => {
        const ro = cameraPosition, rd = normalize(positionWorld.sub(cameraPosition));
        const lo = modelWorldMatrixInverse.mul(vec4(ro, 1)).xyz;
        const ld = modelWorldMatrixInverse.mul(vec4(rd, 0)).xyz;
        const inv = vec3(1).div(ld.add(1e-9));
        const t0 = vec3(-0.5).sub(lo).mul(inv), t1 = vec3(0.5).sub(lo).mul(inv);
        const tmin = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
        const tmax = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
        // the ground ends the march (the box reaches below the floor for the puffs). Things in front of the cloud
        // hide it by the depth test (front faces, CloudSystem.update); things inside it are not seen through
        const tGround = select(groundOn.and(rd.y.lessThan(-1e-6)).and(ro.y.greaterThan(groundY)), groundY.sub(ro.y).div(rd.y), float(1e30));
        const tNear = max(tmin, 0).toVar(), tFar = min(tmax, tGround).toVar();
        const transmittance = float(1).toVar(), color = vec3(0).toVar();
        // toVar: assigned here – TSL declares a shared expression where it is first used, which was inside the
        // first light's If (light off → σ stayed 0, the whole cloud vanished)
        const sigma = v.density.mul(CLOUD_SIGMA).div(v.scale).toVar();
        const fine = v.scale.mul(FINE).toVar();
        const reach = v.puff.mul(CLOUD_REACH).toVar();
        // per-pixel start offset (interleaved gradient noise) against banding
        const jitter = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189)).toVar();
        const t = tNear.add(fine.mul(jitter)).toVar();
        Loop(STEPS, () => {
            If(t.greaterThanEqual(tFar).or(transmittance.lessThan(0.01)), () => { Break(); });   // block: returning Break() emitted it twice
            const p = ro.add(rd.mul(t)).toVar();
            const local = lo.add(ld.mul(t)).toVar();
            const gap = fieldAt(local, v.slot).sub(reach).mul(v.scale).toVar();
            If(gap.greaterThan(fine), () => {
                t.addAssign(gap);   // nothing closer than this
            }).Else(() => {
                const d = densityAt(local, p, v).toVar();
                If(d.greaterThan(0.001), () => {
                    // every light: optical depth towards it through the cloud (doubling steps, cheaper density)
                    const sun = vec3(0).toVar();
                    for (let l = 0; l < LIGHTS; l++) {
                        const L = lightDir.element(l).xyz, E = lightColor.element(l).xyz;
                        If(lightColor.element(l).w.greaterThan(0), () => {
                            const tau = float(0).toVar();
                            let from = 0;
                            for (let k = 0; k < LIGHT_STEPS; k++) {
                                const len = 0.02 * 2 ** k;
                                const pl = p.add(L.mul(v.scale.mul(from + len / 2)));
                                tau.addAssign(densityAt(modelWorldMatrixInverse.mul(vec4(pl, 1)).xyz, pl, v, true).mul(len));
                                from += len;
                            }
                            sun.addAssign(E.mul(lightEnergy(tau.mul(sigma).mul(v.scale), dot(rd, L))));
                        });
                    }
                    // ambient: sky above, floor below (height in the box), fading with the depth inside
                    const depth = reach.sub(fieldAt(local, v.slot)).max(0).mul(v.scale);
                    const up = smoothstep(-0.45, 0.45, local.y);
                    const amb = mix(ambientGround, ambientSky, up).mul(exp(depth.mul(sigma).mul(-RASTER.ambientFade)));
                    const absorb = exp(d.mul(sigma).mul(fine).negate());
                    // energy-conserving integration of the step (Hillaire)
                    const scattered = sun.add(amb).mul(v.albedo).mul(float(1).sub(absorb)).mul(RASTER.gain);
                    color.addAssign(scattered.mul(transmittance));
                    transmittance.mulAssign(absorb);
                });
                t.addAssign(fine);
            });
        });
        return vec4(color, transmittance.oneMinus());
    })();
}

// Depth of a cloud for the light shafts' depth passes (volume-shafts.js): where the optical depth along the view ray
// reaches 1 – the shafts then see the cloud's shape (shadow wedges behind it, rays end in it) instead of its box.
// kind 'sun': orthographic sun camera, value = view depth / far; 'camera': modelSize / distance (like the shafts'
// override materials). No such point: nothing written.
const DEPTH_STEPS = 32;
const depthParams = { sunFar: uniform(1), modelSize: uniform(1) };
function cloudDepthNode(v, kind) {
    return Fn(() => {
        const ortho = kind === 'sun';
        const rd = ortho ? normalize(cameraWorldMatrix.mul(vec4(0, 0, -1, 0)).xyz) : normalize(positionWorld.sub(cameraPosition));
        const ro = ortho ? positionWorld.sub(rd.mul(v.scale.mul(1e-3))) : cameraPosition;
        const lo = modelWorldMatrixInverse.mul(vec4(ro, 1)).xyz;
        const ld = modelWorldMatrixInverse.mul(vec4(rd, 0)).xyz;
        const inv = vec3(1).div(ld.add(1e-9));
        const t0 = vec3(-0.5).sub(lo).mul(inv), t1 = vec3(0.5).sub(lo).mul(inv);
        const tNear = max(max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), 0);
        const tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
        const dt = max(tFar.sub(tNear), 0).div(DEPTH_STEPS);
        const sigma = v.density.mul(CLOUD_SIGMA).div(v.scale);
        const tau = float(0).toVar(), tHit = float(-1).toVar();
        Loop(DEPTH_STEPS, ({ i }) => {
            const t = tNear.add(dt.mul(float(i).add(0.5)));
            const p = ro.add(rd.mul(t));
            tau.addAssign(densityAt(lo.add(ld.mul(t)), p, v, true).mul(sigma).mul(dt));
            If(tau.greaterThanEqual(1), () => { tHit.assign(t); Break(); });
        });
        If(tHit.lessThan(0), () => { Discard(); });
        const p = ro.add(rd.mul(tHit));
        const value = ortho ? cameraViewMatrix.mul(vec4(p, 1)).z.negate().div(depthParams.sunFar) : depthParams.modelSize.div(max(length(p.sub(cameraPosition)), 1e-6));
        return vec4(value, 0, 0, 1);
    })();
}

/** Raster material of a cloud volume (proxy box) + its path tracer stand-in */
function cloudMaterial(slot) {
    const v = {
        slot: uniform(slot), scale: uniform(1), puff: uniform(0.1), density: uniform(1),
        albedo: uniform(new THREE.Color(1, 1, 1)),
    };
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide, transparent: true, depthWrite: false, depthTest: true });
    const result = cloudNode(v);
    material.colorNode = result.rgb.div(max(result.a, 1e-4));
    material.opacityNode = result.a;
    material.userData.cloudUniforms = v;
    material.userData.noBatch = true;
    material.allowOverride = false;   // Basic (clay override): the cloud stays a cloud
    // depth variants for the light shafts – not replaced by their override material
    material.userData.depth = Object.fromEntries(['sun', 'camera'].map(kind => {
        const m = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide });
        m.outputNode = cloudDepthNode(v, kind);
        m.allowOverride = false;
        return [kind, m];
    }));
    return material;
}

// path tracer: the proxy box marks the volume (ptVolume 3, cloud-pt.js); its values in fields this material has no
// other use for
function setStandIn(material, v) {
    const c = v.albedo.value;
    material.userData.ptStandIn = {
        ptVolume: 3, color: { r: c.r, g: c.g, b: c.b }, metalness: v.slot.value, roughness: v.density.value,
        ior: v.puff.value, clearcoat: v.scale.value, anisotropy: CLOUD_G, transmission: 0, side: THREE.DoubleSide,
    };
}

// cloud parameters of a material (RindrMaterial.setCloud) or null
const cloudOf = material => (material && !Array.isArray(material) ? material.userData?.cloud ?? null : null);

export class CloudSystem {
    /**
     * @param {THREE.Scene} scene
     * @param {() => THREE.Object3D[]} getRoots  model roots (the meshes with cloud materials are searched there)
     * @param {() => number | null} [getGround]  height of the shown ground (null: none) – the raster ends there
     * @param {() => THREE.Light[]} [getLights]  the scene's lights (directional + ambient light the raster clouds)
     */
    constructor(scene, getRoots, getGround = null, getLights = null) {
        this.getRoots = getRoots;
        this.getGround = getGround;
        this.getLights = getLights;
        this.group = new THREE.Group();
        this.group.name = 'clouds';
        scene.add(this.group);
        const box = new THREE.BoxGeometry(1, 1, 1);
        box.boundsTree = new MeshBVH(box);   // the path tracer needs it before setScene
        this.volumes = Array.from({ length: CLOUD_SLOTS }, (_, slot) => {
            const material = cloudMaterial(slot);
            setStandIn(material, material.userData.cloudUniforms);
            const mesh = new THREE.Mesh(box, material);
            mesh.visible = false;
            mesh.renderOrder = 10;      // after the other transparent things
            mesh.frustumCulled = false;
            mesh.userData.cloudProxy = true;
            this.group.add(mesh);
            return { slot, mesh, material, key: null, signature: '', dirtyAt: null, job: 0, meshes: [] };
        });
        this._scan = true;              // materials/assignments changed: search the meshes anew
        this._worker = null;
        this._jobs = new Map();
        this._seq = 0;
        this.onChange = null;           // proxies/field changed (path tracer: transforms, materials)
    }

    /** materials or their assignment changed (manager 'change'/'update') – search again on the next update */
    invalidate() {
        this._scan = true;
    }

    /** every frame: find changes, start recomputing after a quiet moment; camera inside a box → its back faces */
    update(camera) {
        if (this._scan) this._rescan();
        const now = performance.now();
        const ground = this.getGround?.() ?? null;
        groundOn.value = ground !== null;
        groundY.value = ground ?? 0;
        if (this.volumes.some(v => v.mesh.visible)) this._updateLights();
        for (const vol of this.volumes) {
            if (vol.mesh.visible && camera) {
                const local = _local.copy(camera.position).applyMatrix4(_inverse.copy(vol.mesh.matrixWorld).invert());
                const inside = Math.max(Math.abs(local.x), Math.abs(local.y), Math.abs(local.z)) < 0.5 + 1e-3;
                const side = inside ? THREE.BackSide : THREE.FrontSide;
                if (vol.material.side !== side) {
                    vol.material.side = side;
                    vol.material.depthTest = !inside;
                    vol.material.needsUpdate = true;
                }
            }
            if (!vol.key) continue;
            const sig = signature(vol.meshes);
            if (sig !== vol.signature) { vol.signature = sig; vol.dirtyAt = now; }
            if (vol.dirtyAt !== null && now - vol.dirtyAt > RECOMPUTE_MS) {
                vol.dirtyAt = null;
                this._compute(vol);
            }
        }
    }

    // meshes per cloud material (one volume each, in order of appearance)
    _rescan() {
        this._scan = false;
        const byMaterial = new Map();
        for (const root of this.getRoots()) {
            root?.traverse(o => {
                if (!o.isMesh) return;
                const cloud = cloudOf(o.material);
                if (!cloud) return;
                if (!byMaterial.has(o.material)) byMaterial.set(o.material, []);
                byMaterial.get(o.material).push(o);
            });
        }
        const entries = [...byMaterial].slice(0, CLOUD_SLOTS);
        if (byMaterial.size > CLOUD_SLOTS) console.warn(`Clouds: only ${CLOUD_SLOTS} cloud materials at a time`);
        let changed = false;
        this.volumes.forEach((vol, i) => {
            const [material, meshes] = entries[i] ?? [null, []];
            vol.meshes = meshes;
            vol.source = material;
            const key = material ? material.uuid : null;
            if (key !== vol.key) {
                vol.key = key;
                vol.signature = '';
                if (!key && vol.mesh.visible) { vol.mesh.visible = false; changed = true; }
            }
            if (material) this._applyParams(vol, cloudOf(material));
        });
        if (changed) this.onChange?.();
    }

    // material parameters → uniforms + stand-in (the box margin depends on puff: field anew when it changed)
    _applyParams(vol, cloud) {
        const v = vol.material.userData.cloudUniforms;
        if (v.puff.value !== cloud.puff) vol.signature = '';
        v.puff.value = cloud.puff;
        v.density.value = cloud.density;
        v.albedo.value.set(cloud.color);
        setStandIn(vol.material, v);
    }

    async _compute(vol) {
        const visible = vol.meshes.filter(isShown);
        if (!visible.length) {
            if (vol.mesh.visible) { vol.mesh.visible = false; this.onChange?.(); }
            return;
        }
        const { triangles, box } = worldTriangles(visible);
        const size = box.getSize(new THREE.Vector3());
        const scale = Math.max(size.x, size.y, size.z, 1e-6);
        const v = vol.material.userData.cloudUniforms;
        box.expandByScalar(MARGIN * v.puff.value * scale + scale * 0.02);
        const job = ++vol.job;
        const t0 = performance.now();
        const field = await this._run({ triangles, box: { min: box.min.toArray(), max: box.max.toArray() }, scale }, [triangles.buffer]).catch(err => { console.warn('Cloud field failed:', err); return null; });
        if (!field || job !== vol.job) return;
        ensureNoise();
        debugLog(`[Clouds] field ${vol.slot}: ${(triangles.length / 9) | 0} triangles in ${(performance.now() - t0).toFixed(0)} ms`);
        atlasData.set(field, vol.slot * field.length);
        atlas.needsUpdate = true;
        v.scale.value = scale;
        setStandIn(vol.material, v);
        box.getCenter(vol.mesh.position);
        vol.mesh.scale.copy(box.getSize(new THREE.Vector3()));
        vol.mesh.updateMatrixWorld();
        vol.mesh.visible = true;
        this.onChange?.();
    }

    _run(msg, transfer) {
        this._worker ??= this._createWorker();
        const id = ++this._seq;
        return new Promise((resolve, reject) => {
            this._jobs.set(id, { resolve, reject });
            this._worker.postMessage({ id, ...msg }, transfer);
        });
    }

    _createWorker() {
        const w = new Worker(new URL('./cloud-worker.js', import.meta.url), { type: 'module' });
        w.onmessage = ({ data }) => {
            const job = this._jobs.get(data.id);
            if (!job) return;
            this._jobs.delete(data.id);
            if (data.error) job.reject(new Error(data.error)); else job.resolve(data.field);
        };
        w.onerror = e => {
            for (const job of this._jobs.values()) job.reject(new Error(e.message || 'cloud worker failed'));
            this._jobs.clear();
        };
        return w;
    }

    /** current light values of the raster clouds (tests, ?debug) */
    lightState() {
        return {
            dir: lightDir.array.map(v => v.toArray()), color: lightColor.array.map(v => v.toArray()),
            sky: ambientSky.value.toArray(), ground: ambientGround.value.toArray(), groundOn: groundOn.value,
        };
    }

    /**
     * Passes that draw the scene with an override material (contour, contact shadow, depth of field lines, section
     * caps, selection outline, light shafts …) must not see the boxes – they drew them as solid boxes. renderer.render
     * is wrapped once: with an override material other than `keep` (Basic's clay) the group is hidden for that call;
     * the light shafts' depth passes (beginDepth) draw the clouds' own depth instead.
     */
    attach(renderer, keep = () => null) {
        const render = renderer.render.bind(renderer);
        renderer.render = (scene, camera) => {
            const override = scene.overrideMaterial;
            const hide = override && override !== keep() && !this._depthPass && this.group.visible;
            if (hide) this.group.visible = false;
            try {
                return render(scene, camera);
            } finally {
                if (hide) this.group.visible = true;
            }
        };
    }

    /**
     * Light shafts' depth passes (volume-shafts.js): the boxes draw their cloud's depth (kind 'sun' with the sun
     * camera's far plane, 'camera' with the shafts' model size) until endDepth()
     */
    beginDepth(kind, value) {
        if (kind === 'sun') depthParams.sunFar.value = value; else depthParams.modelSize.value = value;
        this._depthPass = true;
        for (const vol of this.volumes) {
            if (!vol.mesh.visible) continue;
            const m = vol.material.userData.depth[kind];
            m.side = kind === 'camera' ? vol.material.side : THREE.FrontSide;   // camera inside the box: back faces
            vol.mesh.material = m;
        }
    }

    endDepth() {
        this._depthPass = false;
        for (const vol of this.volumes) vol.mesh.material = vol.material;
    }

    /**
     * Material preview (material-thumbs.js): a cloud volume around a sphere of `radius` at the origin, or null for
     * other materials. The sphere's field is exact (no voxelising); dispose the returned mesh's material after use.
     */
    previewFor(material, radius) {
        const cloud = cloudOf(material);
        if (!cloud) return null;
        ensureNoise();
        const scale = 2 * radius, half = radius + MARGIN * 0.25 * scale;
        if (this._previewRadius !== radius) {
            this._previewRadius = radius;
            const box = { min: [-half, -half, -half], max: [half, half, half] };
            atlasData.set(sphereField(radius * PREVIEW_CORE, box, scale), PREVIEW_SLOT * FIELD_RES ** 3);
            atlas.needsUpdate = true;
        }
        const mat = cloudMaterial(PREVIEW_SLOT);
        const v = mat.userData.cloudUniforms;
        v.scale.value = scale;
        // at least PREVIEW_PUFF: the material's small puff made a plain white disc at icon size
        v.puff.value = Math.max(cloud.puff, PREVIEW_PUFF);
        v.density.value = cloud.density;
        v.albedo.value.set(cloud.color);
        this._updateLights();
        const mesh = new THREE.Mesh(this.volumes[0].mesh.geometry, mat);
        mesh.scale.setScalar(2 * half);
        mesh.renderOrder = 10;
        mesh.frustumCulled = false;
        // around its render (material-thumbs.js): a key light from the upper left instead of the scene's lights
        // (they mostly shine from the camera's side – the lumps cast no shadows), the environment stays
        let saved = null;
        mesh.userData.beforeRender = () => {
            saved = lightColor.array.map(c => c.clone());
            ambientSky.value.multiplyScalar(PREVIEW_AMBIENT);
            ambientGround.value.multiplyScalar(PREVIEW_AMBIENT);
            for (let l = 1; l < LIGHTS; l++) lightColor.array[l].w = 0;
            lightDir.array[1].set(-0.7, 0.65, 0.3, 0).normalize();
            lightColor.array[1].set(PREVIEW_LIGHT, PREVIEW_LIGHT, PREVIEW_LIGHT, 1);
        };
        mesh.userData.afterRender = () => {
            saved?.forEach((c, l) => lightColor.array[l].copy(c));
            this._updateLights();
        };
        return mesh;
    }

    /**
     * Light of the environment for the raster clouds: texture (equirect, CPU data), intensity (× light boost),
     * rotation (environment rotation y)
     */
    setEnvironment(texture, intensity, rotation) {
        const light = environmentLight(texture);
        if (!light) return;
        const c = Math.cos(rotation), s = Math.sin(rotation);
        // three.js looks the environment up with rotationᵀ · direction → world direction = rotation · texture direction
        const d = light.dir, e = light.sun;
        lightDir.array[0].set(c * d.x + s * d.z, d.y, -s * d.x + c * d.z, 0).normalize();
        lightColor.array[0].set(e.x * intensity, e.y * intensity, e.z * intensity, e.x + e.y + e.z > 0 ? 1 : 0);
        envSky.copy(light.sky).multiplyScalar(intensity);
        envGround.copy(light.ground).multiplyScalar(intensity);
    }

    // the scene's lights → slots 1…: shown directional lights (direction towards the light, irradiance = colour ×
    // intensity like three's), ambient lights as radiance (colour × intensity / π)
    _updateLights() {
        const lights = this.getLights?.() ?? [];
        let slot = 1;
        ambientSky.value.copy(envSky);
        ambientGround.value.copy(envGround);
        for (const light of lights) {
            if (!isShown(light) || !(light.intensity > 0)) continue;
            const c = light.color, k = light.intensity;
            if (light.isAmbientLight) {
                for (const a of [ambientSky.value, ambientGround.value]) { a.x += c.r * k / Math.PI; a.y += c.g * k / Math.PI; a.z += c.b * k / Math.PI; }
            } else if (light.isDirectionalLight && slot < LIGHTS) {
                light.updateMatrixWorld();
                light.target.updateMatrixWorld();
                _light.setFromMatrixPosition(light.matrixWorld).sub(_target.setFromMatrixPosition(light.target.matrixWorld)).normalize();
                lightDir.array[slot].set(_light.x, _light.y, _light.z, 0);
                lightColor.array[slot].set(c.r * k, c.g * k, c.b * k, 1);
                slot++;
            }
        }
        for (; slot < LIGHTS; slot++) lightColor.array[slot].w = 0;
        // shown floor: the lights it receives come back up onto the bases (HQ: the ground's bounce lit them – the
        // raster bases stayed dark and blue); albedo RASTER.floor, irradiance from above / π
        if (groundOn.value) {
            for (let l = 0; l < LIGHTS; l++) {
                const d = lightDir.array[l], c = lightColor.array[l];
                if (!c.w || d.y <= 0) continue;
                const k = RASTER.floor * d.y / Math.PI;
                ambientGround.value.x += c.x * k; ambientGround.value.y += c.y * k; ambientGround.value.z += c.z * k;
            }
            ambientGround.value.addScaledVector(ambientSky.value, RASTER.floor);   // the sky it sees
        }
    }
}

const _local = new THREE.Vector3(), _inverse = new THREE.Matrix4(), _light = new THREE.Vector3(), _target = new THREE.Vector3();

// visible incl. parents (scene graph)
function isShown(o) {
    for (let c = o; c; c = c.parent) if (!c.visible) return false;
    return true;
}

// cheap change test: transforms and visibility of the meshes
function signature(meshes) {
    let h = meshes.length;
    for (const m of meshes) {
        const e = m.matrixWorld.elements;
        h = (h * 31 + (isShown(m) ? 1 : 2)) | 0;
        for (let i = 0; i < 16; i += 5) h = (h * 31 + Math.round(e[i] * 1e4)) | 0;
        h = (h * 31 + Math.round(e[12] * 1e3) + Math.round(e[13] * 7e2) + Math.round(e[14] * 3e2)) | 0;
    }
    return String(h);
}

// world-space triangles of the meshes (every n-th beyond MAX_TRIANGLES) and their box
function worldTriangles(meshes) {
    let total = 0;
    for (const m of meshes) total += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    const every = Math.max(1, Math.ceil(total / MAX_TRIANGLES));
    const out = new Float32Array(Math.ceil(total / every) * 9 + 9);
    const box = new THREE.Box3(), v = new THREE.Vector3();
    let o = 0, k = 0;
    for (const m of meshes) {
        const pos = m.geometry.attributes.position, index = m.geometry.index;
        const count = index ? index.count : pos.count;
        for (let i = 0; i + 2 < count; i += 3, k++) {
            if (k % every) continue;
            for (let j = 0; j < 3; j++) {
                v.fromBufferAttribute(pos, index ? index.getX(i + j) : i + j).applyMatrix4(m.matrixWorld);
                out[o++] = v.x; out[o++] = v.y; out[o++] = v.z;
                box.expandByPoint(v);
            }
        }
    }
    return { triangles: out.subarray(0, o).slice(), box };
}

// sun (brightest region, its irradiance above the average) and ambient (average radiance) of an equirect texture
const envLights = new WeakMap();
function environmentLight(tex) {
    if (envLights.has(tex)) return envLights.get(tex);
    const img = tex?.image;
    let result = null;
    if (img?.data && img.width && img.height) {
        const { data, width: w, height: h } = img, ch = Math.round(data.length / (w * h));
        const value = data instanceof Uint16Array ? i => THREE.DataUtils.fromHalfFloat(data[i]) : i => data[i];
        const CW = 64, CH = 32;
        const cells = new Float32Array(CW * CH * 3);
        const counts = new Uint32Array(CW * CH);
        // every texel up to 2K (once per texture, cached): a small sun disc fell between sparser samples – the
        // raster clouds lost the sun and turned blue under outdoor HDRIs
        const sy = Math.max(1, Math.floor(w / 2048)), sx = sy;
        for (let y = 0; y < h; y += sy) {
            for (let x = 0; x < w; x += sx) {
                const i = (y * w + x) * ch, c = Math.min(CH - 1, (y * CH / h) | 0) * CW + Math.min(CW - 1, (x * CW / w) | 0);
                cells[c * 3] += value(i); cells[c * 3 + 1] += value(i + 1); cells[c * 3 + 2] += value(i + 2);
                counts[c]++;
            }
        }
        const avg = new THREE.Vector3(), sumW = { v: 0 }, sky = new THREE.Vector3(), ground = new THREE.Vector3();
        let best = -1;
        for (let c = 0; c < CW * CH; c++) {
            const n = counts[c] || 1;
            cells[c * 3] /= n; cells[c * 3 + 1] /= n; cells[c * 3 + 2] /= n;
            const lat = ((Math.floor(c / CW) + 0.5) / CH - 0.5) * Math.PI, wgt = Math.cos(lat);
            avg.x += cells[c * 3] * wgt; avg.y += cells[c * 3 + 1] * wgt; avg.z += cells[c * 3 + 2] * wgt;
            const half = lat > 0 ? sky : ground;
            half.x += cells[c * 3] * wgt; half.y += cells[c * 3 + 1] * wgt; half.z += cells[c * 3 + 2] * wgt;
            sumW.v += wgt;
            const luma = 0.2126 * cells[c * 3] + 0.7152 * cells[c * 3 + 1] + 0.0722 * cells[c * 3 + 2];
            best = Math.max(best, luma);
        }
        avg.multiplyScalar(1 / sumW.v);
        sky.multiplyScalar(2 / sumW.v);
        ground.multiplyScalar(2 / sumW.v);
        // the sun: every cell clearly brighter than the average (a softbox spans many cells – only the brightest one
        // gave the raster clouds too little light), its excess irradiance, direction weighted by it
        const avgLuma = 0.2126 * avg.x + 0.7152 * avg.y + 0.0722 * avg.z;
        const threshold = Math.max(3 * avgLuma, 0.25 * best);
        const dir = new THREE.Vector3(), sun = new THREE.Vector3(), d = new THREE.Vector3();
        for (let c = 0; c < CW * CH; c++) {
            const luma = 0.2126 * cells[c * 3] + 0.7152 * cells[c * 3 + 1] + 0.0722 * cells[c * 3 + 2];
            if (luma < threshold) continue;
            // equirect (three.js): u = atan2(z, x) / 2π + 0.5, v = asin(y) / π + 0.5, row 0 = v 0
            const a = ((c % CW + 0.5) / CW - 0.5) * 2 * Math.PI, lat = ((Math.floor(c / CW) + 0.5) / CH - 0.5) * Math.PI;
            const omega = (2 * Math.PI / CW) * (Math.PI / CH) * Math.cos(lat);
            const ex = Math.max(cells[c * 3] - avg.x, 0) * omega, ey = Math.max(cells[c * 3 + 1] - avg.y, 0) * omega, ez = Math.max(cells[c * 3 + 2] - avg.z, 0) * omega;
            sun.x += ex; sun.y += ey; sun.z += ez;
            d.set(Math.cos(lat) * Math.cos(a), Math.sin(lat), Math.cos(lat) * Math.sin(a));
            dir.addScaledVector(d, 0.2126 * ex + 0.7152 * ey + 0.0722 * ez);
        }
        if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0); else dir.normalize();
        // ambient from above and below; the light spreads inside, so both halves mix (RASTER.sky: share of the
        // other half – the plain floor average darkened the bases too much)
        const top = sky.clone().multiplyScalar(RASTER.sky).addScaledVector(ground, 1 - RASTER.sky);
        const bottom = ground.clone().multiplyScalar(RASTER.sky).addScaledVector(sky, 1 - RASTER.sky);
        result = { dir, sun, sky: top, ground: bottom };
    }
    envLights.set(tex, result);
    return result;
}
