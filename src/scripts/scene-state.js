// Save/restore the scene state (JSON, without geometry).
// Contains everything that, together with the model file, uniquely defines an image – the basis
// for later offloading path tracing to a render server (server loads model + state + HDRI).
//
//   model          name, type, file size (association with the model file; geometry itself is not included)
//   tessellation   quality level (STEP)
//   camera         position, target, focal length, depth of field (aperture, focus plane, bokeh)
//   environment    HDRI file (public/hdr), intensity, rotation, background, ground projection
//   lights         per light: position, intensity, colour, visible
//   pathtracing    bounces, resolution, max. samples, glossy filter, denoise, upscaling
//   slicer         section plane
//   models         (version 2) every loaded model: file (name, type, size), placement, translations/rotations,
//                  hidden/deleted nodes, material assignments – keys without the runtime prefix of additional
//                  models ('x<id>:'); the first one is the main model. Version 1 only knew the main model
//                  (model/nodes/assignments at the top level – still read, see sceneModels)
//   assets         list of the external files the scene needs (models, HDRI, missing textures) – the asset
//                  window checks it when opening
//   materials      all materials of the scene (like the material export)
//
// Mesh keys (mesh.userData.key) and material origin (def.origin) are stable across reloads and
// quality levels; material IDs of STEP/import materials, however, are not.
import { viewAngle, setViewAngle } from './fisheye.js';
import * as THREE from 'three/webgpu';
import { normalizeHdri } from './hdri/hdri-model.js';
import { normalizeQuality } from './step-importer.js';
import { t } from './i18n.js';

export const SCENE_FORMAT = 'step-viewer-scene';
const VERSION = 2;

const vec = v => v.toArray().map(x => +x.toFixed(6));

/**
 * @param {object} ctx  see viewer.js (sceneStateContext)
 */
// keys of a model in the Scene Graph sets: 'model', 'n<i>', 's<mesh key>' – additional models carry a prefix
const stripKey = (key, prefix) => (!prefix ? key : key.startsWith('s' + prefix) ? 's' + key.slice(1 + prefix.length) : key.startsWith(prefix) ? key.slice(prefix.length) : null);
const addKey = (key, prefix) => (!prefix ? key : key[0] === 's' ? 's' + prefix + key.slice(1) : prefix + key);

/** State of one loaded model (ctx.runtimeModels() entry) */
function modelState(rm, sceneGraph) {
    const vecs = v => v.toArray().map(x => +x.toFixed(6));
    const scaleOf = xf => (xf.scale && (xf.scale.x !== 1 || xf.scale.y !== 1 || xf.scale.z !== 1) ? { scale: vecs(xf.scale) } : {});
    const rot = xf => [xf.rotation.x, xf.rotation.y, xf.rotation.z].map(r => +THREE.MathUtils.radToDeg(r).toFixed(4));
    const transforms = {};
    const rootXf = rm.root.userData.xf;
    // root: translation relative to the automatic centring
    if (rootXf) transforms.model = { offset: vecs(rootXf.offset.clone().sub(rm.root.userData.centerOffset || new THREE.Vector3())), rotation: rot(rootXf), ...scaleOf(rootXf) };
    rm.nodeGroups.forEach((g, i) => { const xf = g.userData.xf; if (xf) transforms['n' + i] = { offset: vecs(xf.offset), rotation: rot(xf), ...scaleOf(xf) }; });
    // material assignments: only deviations from the import default
    const assignments = {};
    for (const m of rm.meshes) {
        const id = m.material?.userData?.materialId;
        if (!id || id === m.userData.defaultMaterialId || !m.userData.key) continue;
        (assignments[id] ||= []).push(stripKey(m.userData.key, rm.prefix));
    }
    const own = set => [...set].map(k => stripKey(k, rm.prefix)).filter(k => k !== null && (rm.prefix || !/^s?x\d+:/.test(k)));
    return {
        file: rm.file,
        placement: rm.holder ? vecs(rm.holder.position) : null,
        count: rm.nodeGroups.length,
        transforms,
        hidden: own(sceneGraph.hiddenModel),
        deleted: own(sceneGraph.deleted),
        assignments,
        ...(rm.morphs && Object.keys(rm.morphs).length ? { morphs: rm.morphs } : {}),
        ...(rm.animation ? { animation: rm.animation } : {}),
    };
}

/** Models of a state (version 1: only the main model at the top level) */
export function sceneModels(state) {
    if (Array.isArray(state?.models)) return state.models;
    if (!state?.model) return [];
    return [{ file: state.model, placement: null, count: state.nodes?.count, transforms: state.nodes?.transforms || {},
        hidden: state.nodes?.hidden || [], deleted: state.nodes?.deleted || [], assignments: state.assignments || {} }];
}

/**
 * Apply the saved state of one model to a loaded model (ctx.runtimeModels() entry).
 * idMap: saved material id -> current id (materialManager.restore). Hidden/deleted keys are returned
 * (with the runtime prefix) – the caller sets them for all models at once.
 */
export function applyModelState(ctx, rm, chunk, idMap, warnings) {
    const { materialManager } = ctx;
    // materials: defaults first, then the saved deviations
    const byKey = new Map(rm.meshes.map(m => [m.userData.key, m]));
    for (const m of rm.meshes) { const def = materialManager.get(m.userData.defaultMaterialId); if (def) m.material = def.material; }
    let missing = 0;
    for (const [id, keys] of Object.entries(chunk.assignments || {})) {
        const entry = materialManager.get(idMap?.get(id) ?? id);
        if (!entry) { missing += keys.length; continue; }
        for (const k of keys) { const mesh = byKey.get(addKey(k, rm.prefix)); if (mesh) mesh.material = entry.material; else missing++; }
    }
    if (missing) warnings.push(t('sceneState.missingAssignments', { count: missing }));
    // morph targets (blend shapes); all others back to 0
    ctx.setModelMorphs?.(rm, chunk.morphs || {});
    // animation: clip + point in time
    if (chunk.animation) ctx.setModelAnimation?.(rm, chunk.animation);
    // placement (additional models)
    if (rm.holder && chunk.placement) { rm.holder.position.fromArray(chunk.placement); rm.holder.updateMatrixWorld(true); }
    // transforms
    if (chunk.count != null && chunk.count !== rm.nodeGroups.length) warnings.push(t('sceneState.treeMismatch'));
    else {
        const all = [['model', rm.root], ...rm.nodeGroups.map((g, i) => ['n' + i, g])];
        for (const [key, o] of all) {
            if (!o) continue;
            const tr = chunk.transforms?.[key];
            if (!tr && !o.userData.xf) continue;
            ctx.ensureTransform(o);
            const xf = o.userData.xf;
            const base = key === 'model' ? (rm.root.userData.centerOffset || new THREE.Vector3()) : new THREE.Vector3();
            if (tr) {
                xf.offset.fromArray(tr.offset).add(base);
                xf.rotation.set(...tr.rotation.map(THREE.MathUtils.degToRad));
                xf.scale.set(...(tr.scale || [1, 1, 1]));
            } else {
                xf.offset.copy(base);
                xf.rotation.set(0, 0, 0);
                xf.scale.set(1, 1, 1);
            }
            ctx.applyTransform(o);
        }
    }
    return {
        hidden: (chunk.hidden || []).map(k => addKey(k, rm.prefix)),
        deleted: (chunk.deleted || []).map(k => addKey(k, rm.prefix)),
    };
}

/**
 * @param {object} ctx  see viewer.js (sceneStateContext)
 */
export function captureState(ctx) {
    const { model, scene, camera, controls, environment: env, lights, lightsGroup, pathTracing: pt, slicer, sceneGraph, materialManager } = ctx;
    const models = ctx.runtimeModels().map(rm => modelState(rm, sceneGraph));
    // models whose files were missing when the scene was opened stay in the scene (at their position)
    for (const m of ctx.missingModels?.() || []) models.splice(Math.min(m.sceneIndex, models.length), 0, m.chunk);
    const assets = [
        ...models.map(m => ({ kind: 'model', name: m.file?.name, size: m.file?.size ?? null })),
        ...(env.hdri ? [{ kind: 'hdri', name: env.hdri }] : []),
    ];
    return {
        format: SCENE_FORMAT,
        version: VERSION,
        savedAt: new Date().toISOString(),
        model: model ? { name: model.name, type: model.type, size: model.size ?? null } : null,   // main model (older readers)
        models,
        assets,
        tessellation: { quality: ctx.settings.meshQuality, parts: { ...ctx.settings.partQuality } },
        view: { mode: ctx.getViewMode(), explode: ctx.exploder?.target || 0 },
        camera: {
            position: vec(camera.position), target: vec(controls.target),
            fov: viewAngle(camera), near: camera.near, far: camera.far, roll: camera.userData.roll || 0,
            dof: ctx.dof?.toJSON(),
            views: ctx.getCameraViews?.() || [],
            lens: ctx.lens?.toJSON(),
        },
        renderer: {
            exposure: ctx.renderer.toneMappingExposure,
            toneMapping: Object.keys(ctx.toneMappings || {}).find(k => ctx.toneMappings[k] === ctx.renderer.toneMapping) || 'aces',
        },
        environment: {
            on: env.on, hdri: env.hdri || null,
            intensity: env.intensity, lightBoost: env.lightBoost, rotation: +THREE.MathUtils.radToDeg(scene.environmentRotation.y).toFixed(3),
            background: env.background, ground: env.ground, groundRadius: env.groundRadius, groundSoftness: env.groundSoftness, dome: env.dome, domeShift: env.domeShift, groundHeight: env.groundHeight, domeRadius: env.domeRadius, domeBlend: env.domeBlend,
            // ground reflection + bad weather (ground-reflection.js)
            reflection: env.reflection, reflectionStrength: env.reflectionStrength, reflectionBlur: env.reflectionBlur,
            wet: env.wet, puddles: env.puddles, puddleSize: env.puddleSize,
            // own HDRIs of the HDRI editor (descriptions, hdri-model.js)
            custom: env.custom?.size ? [...env.custom.values()] : undefined,
        },
        lights: {
            visible: lightsGroup.visible,
            items: lights().map(l => ({
                name: l.name, type: l.type, visible: l.visible,
                position: vec(l.position), intensity: l.intensity, color: '#' + l.color.getHexString(),
            })),
        },
        pathtracing: {
            enabled: pt.enabled, bounces: pt.bounces, renderScale: pt.renderScale, maxSamples: pt.maxSamples,
            filterGlossyFactor: pt.filterGlossyFactor, denoise: pt.denoiseEnabled, upscale: pt.upscaleEnabled,
            sharpness: pt.sharpness ?? 1,
            motion: { ...pt.motion },
        },
        slicer: {
            enabled: slicer.enabled, flipped: slicer.flipped,
            position: vec(slicer.object.position), quaternion: vec(slicer.object.quaternion),
            capColor: '#' + slicer.capMaterial.color.getHexString(),
        },
        materials: materialManager.toJSON(),
    };
}

/** Does the state match the loaded model? (name + file size) */
export function matchesModel(state, model) {
    if (!state?.model || !model) return false;
    return state.model.name === model.name && (state.model.size == null || model.size == null || state.model.size === model.size);
}

/**
 * Apply a state. The matching model must be loaded; a different quality level is re-tessellated
 * first (ctx.retessellate).
 * @returns {Promise<string[]>} warnings (e.g. HDRI not found)
 */
export async function applyState(ctx, state) {
    if (state?.format !== SCENE_FORMAT) throw new Error(t('sceneState.notSceneFile'));
    if (state.version > VERSION) throw new Error(t('sceneState.newerVersion', { version: state.version }));
    const warnings = [];
    const { scene, camera, controls, environment: env, lights, lightsGroup, pathTracing: pt, slicer, sceneGraph, materialManager } = ctx;

    // quality first (replaces the geometry); part levels alone -> only their solids anew
    // normalizeQuality: also accepts the German level names of older scene files
    const quality = normalizeQuality(state.tessellation?.quality);
    const parts = Object.fromEntries(Object.entries(state.tessellation?.parts || {}).map(([k, q]) => [k, normalizeQuality(q)]).filter(([, q]) => q));
    if (ctx.model?.type === 'step') {
        const sameParts = JSON.stringify(sortKeys(parts)) === JSON.stringify(sortKeys(ctx.settings.partQuality));
        ctx.settings.partQuality = { ...parts };
        if (quality && quality !== ctx.settings.meshQuality) {
            ctx.settings.meshQuality = quality;
            await ctx.retessellate();
        } else if (!sameParts) {
            await ctx.retessellateParts();
        }
    }

    // materials, then per loaded model (rm.sceneIndex = its position in the saved list) its state
    const idMap = state.materials ? materialManager.restore(state.materials) : new Map();
    const chunks = sceneModels(state);
    const hidden = [], deleted = [];
    for (const rm of ctx.runtimeModels()) {
        const chunk = chunks[rm.sceneIndex];
        if (!chunk) continue;
        const keys = applyModelState(ctx, rm, chunk, idMap, warnings);
        hidden.push(...keys.hidden);
        deleted.push(...keys.deleted);
    }
    sceneGraph.deleted = new Set(deleted);
    ctx.refreshSceneGraph?.();
    sceneGraph.setHiddenModel(hidden);
    materialManager.dispatchEvent(new CustomEvent('change'));

    // camera
    // a camera flight still running from loading (fit/frame of a new model) would move it away again
    if (state.camera) ctx.stopCameraMotion?.();
    if (state.camera) {
        const c = state.camera;
        camera.position.fromArray(c.position);
        controls.target.fromArray(c.target);
        setViewAngle(camera, c.fov ?? viewAngle(camera));
        camera.near = c.near ?? camera.near;
        camera.far = c.far ?? camera.far;
        camera.userData.roll = c.roll || 0;   // older states: level
        if (c.dof) ctx.dof?.fromJSON(c.dof);
        ctx.setCameraViews?.(c.views || []);
        ctx.lens?.fromJSON(c.lens || {});   // older states: effects off
        camera.updateProjectionMatrix();
        controls.update();
    }
    if (state.renderer) {
        ctx.renderer.toneMappingExposure = state.renderer.exposure ?? 1;
        // older states: ACES (the only curve back then)
        ctx.renderer.toneMapping = ctx.toneMappings?.[state.renderer.toneMapping] ?? ctx.toneMappings?.aces ?? ctx.renderer.toneMapping;
    }

    // lights (matched by order, name as a check)
    if (state.lights) {
        lightsGroup.visible = state.lights.visible !== false;
        const list = lights();
        state.lights.items?.forEach((s, i) => {
            const l = list[i];
            if (!l || l.type !== s.type) { warnings.push(t('sceneState.lightNotFound', { name: s.name })); return; }
            l.visible = s.visible !== false;
            l.position.fromArray(s.position);
            l.intensity = s.intensity;
            l.color.set(s.color);
            l.updateMatrixWorld();
            ctx.onLightMoved(l);
        });
    }

    // path tracing settings
    if (state.pathtracing) {
        const p = state.pathtracing;
        if (p.bounces != null) pt.setBounces(p.bounces);
        if (p.renderScale != null) pt.renderScale = p.renderScale;
        if (p.maxSamples != null) pt.maxSamples = p.maxSamples;
        if (p.filterGlossyFactor != null) pt.filterGlossyFactor = p.filterGlossyFactor;
        if (p.denoise != null) pt.setDenoise(p.denoise);
        if (p.upscale != null) pt.setUpscale(p.upscale);
        if (p.sharpness != null) pt.sharpness = p.sharpness;   // stored until the path tracer is loaded
        if (p.motion) Object.assign(pt.motion, p.motion);
    }
    // view mode (older states: path tracing on -> HQ)
    const mode = state.view?.mode ?? (state.pathtracing?.enabled != null ? (state.pathtracing.enabled ? 'hq' : 'default') : null);
    if (mode) ctx.setViewMode(mode);
    if (ctx.exploder && ctx.root()) ctx.exploder.set(state.view?.explode || 0, { animate: false });

    // section plane
    if (state.slicer) {
        const s = state.slicer;
        slicer.object.position.fromArray(s.position);
        slicer.object.quaternion.fromArray(s.quaternion);
        slicer.object.updateMatrixWorld();
        if (!!s.flipped !== slicer.flipped) slicer.flip();
        if (s.capColor) slicer.capMaterial.color.set(s.capColor);
        slicer.update();
        ctx.setSlicerEnabled(!!s.enabled);
    }

    // environment (HDRI loads asynchronously)
    if (state.environment) {
        const e = state.environment;
        env.on = e.on !== false;
        env.background = !!e.background;
        env.ground = !!e.ground;
        if (e.groundRadius != null) env.groundRadius = e.groundRadius;
        if (e.groundSoftness != null) env.groundSoftness = e.groundSoftness;
        env.reflection = !!e.reflection;
        env.wet = !!e.wet;
        for (const key of ['reflectionStrength', 'reflectionBlur', 'puddles', 'puddleSize']) if (e[key] != null) env[key] = e[key];
        if (e.dome != null) env.dome = !!e.dome;
        if (e.domeShift != null) env.domeShift = e.domeShift;
        if (e.groundHeight != null) env.groundHeight = e.groundHeight;
        if (e.domeRadius != null) env.domeRadius = e.domeRadius;
        if (e.domeBlend != null) env.domeBlend = e.domeBlend;
        if (e.intensity != null) env.intensity = e.intensity;
        env.lightBoost = e.lightBoost ?? 1;
        if (e.rotation != null) scene.environmentRotation.y = THREE.MathUtils.degToRad(e.rotation);
        // own HDRIs (HDRI editor): replaced by the scene's; the selected one is rendered again from its description
        if (env.custom) env.custom = new Map((Array.isArray(e.custom) ? e.custom : []).map(d => normalizeHdri(d)).map(d => [d.id, d]));
        const hdri = e.hdri || '';
        const own = !!env.customName?.(hdri);
        if (hdri !== env.hdri || own) {
            if (hdri && !env.hdris.includes(hdri) && !own) warnings.push(t('sceneState.hdriMissing', { name: hdri }));
            try { await env.select(env.hdris.includes(hdri) || own ? hdri : ''); }   // progress: status monitor
            catch (err) { warnings.push(t('sceneState.hdriError', { name: env.customName?.(hdri) ?? hdri, message: err.message })); }
        }
        env.apply({ geometry: true });
    }

    ctx.afterRestore();
    return warnings;
}

function sortKeys(o) {
    return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
