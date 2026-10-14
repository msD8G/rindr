// STEP import without OpenCASCADE: own parser + B-rep tessellator (src/scripts/step/),
// parallelised over a pool of web workers (one worker per CPU core).
//
// Flow:
//  1. One worker indexes the file (byte offsets of all entities) and resolves the
//     product structure (assemblies, transformations, colours, face lists).
//  2. All workers receive file + index. With cross-origin isolation both live in
//     SharedArrayBuffers (no copy), otherwise each worker gets a copy.
//  3. Faces are distributed dynamically in small batches to idle workers and
//     tessellated there; the main thread assembles the results per solid and colour.
//  4. Optional: build BVHs (for the path tracer) per geometry in parallel in the workers.
//  5. Optional (with BVHs): instancing – geometries identical in shape to an earlier one (any position/rotation)
//     are dropped, their meshes use the earlier geometry with an alignment matrix (Instancer below).
//
// Index and structure stay cached, "re-tessellate" starts directly at step 3.

import { t, getLocale } from './i18n.js';
import { Matrix4 } from 'three';
import { Instancer } from './instancer.js';

// Tessellation quality levels:
//   rel = chord error relative to the solid diagonal, ang = max. angle between normals (rad)
export const TESS_PRESETS = {
    coarse:   { rel: 0.004,   ang: 0.6 },
    medium:   { rel: 0.0015,  ang: 0.4 },
    fine:     { rel: 0.0005,  ang: 0.25 },
    veryFine: { rel: 0.0002,  ang: 0.15 },
};
// Quality levels used to be stored with their German names (scene states before the i18n refactoring)
const LEGACY_QUALITY = { 'Grob': 'coarse', 'Mittel': 'medium', 'Fein': 'fine', 'Sehr fein': 'veryFine' };
/** Valid TESS_PRESETS key for a stored value (also legacy German names), otherwise null */
export const normalizeQuality = q => (q in TESS_PRESETS ? q : LEGACY_QUALITY[q] || null);

const FACES_PER_JOB = 16;

// Loads the file. With cross-origin isolation directly into a SharedArrayBuffer (read by all
// workers without a copy) – otherwise the file would be in memory twice.
export async function fetchStepFile(url, signal = null) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const length = Number(response.headers.get('Content-Length'));
    const encoded = response.headers.get('Content-Encoding');
    if (self.crossOriginIsolated && length > 0 && !encoded && response.body) {
        const bytes = new Uint8Array(new SharedArrayBuffer(length));
        const reader = response.body.getReader();
        let offset = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            signal?.throwIfAborted();
            if (offset + value.length > length) throw new Error(t('import.step.fileTooLong'));
            bytes.set(value, offset);
            offset += value.length;
        }
        if (offset === length) return bytes;
        return bytes.slice(0, offset);
    }
    return new Uint8Array(await response.arrayBuffer());
}

// Read a dropped file (File/Blob) – like fetchStepFile directly into a SharedArrayBuffer
export async function readStepFile(blob, signal = null) {
    if (!self.crossOriginIsolated || !blob.stream) return new Uint8Array(await blob.arrayBuffer());
    const bytes = new Uint8Array(new SharedArrayBuffer(blob.size));
    const reader = blob.stream().getReader();
    let offset = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) { reader.cancel(); signal.throwIfAborted(); }
        bytes.set(value, offset);
        offset += value.length;
    }
    return bytes;
}

// --- Worker pool ---

const createWorker = () => new Worker(new URL('./step/worker.js', import.meta.url), { type: 'module' });

// Single request to a worker, answer as a promise (a worker only ever handles one request at a time).
// Pending requests are tracked: abortStepImport() rejects them with AbortError (terminated workers
// never answer – the promises would hang forever otherwise).
const inflight = new Set();
function requestWorker(w, msg, transfer = []) {
    return new Promise((resolve, reject) => {
        const entry = { w, reject };
        inflight.add(entry);
        const done = fn => v => { inflight.delete(entry); fn(v); };
        w.onmessage = e => {
            if (e.data.type === 'error') done(reject)(new Error(e.data.message));
            else done(resolve)(e.data);
        };
        w.onerror = e => done(reject)(new Error(e.message || t('import.step.workerError')));
        w.postMessage(msg, transfer);
    });
}

class WorkerPool {
    constructor(size) {
        this.workers = [];
        for (let i = 0; i < size; i++) this.workers.push(createWorker());
    }
    request(w, msg, transfer = []) {
        return requestWorker(w, msg, transfer);
    }
    terminate() {
        this.workers.forEach(w => w.terminate());
        this.workers = [];
    }
}

let pool = null;
let session = null; // { source, bytes, offsets, plan, ready: Promise }

function poolSize() {
    // ?workers=N (testing): fixed pool size
    const forced = Number(new URLSearchParams(self.location?.search || '').get('workers'));
    if (forced > 0) return Math.min(forced, 32);
    const cores = navigator.hardwareConcurrency || 4;
    // Without SharedArrayBuffer every worker gets its own copy of the file
    return Math.max(1, Math.min(cores, self.crossOriginIsolated ? 16 : 6));
}

async function prepare(source, onStatus) {
    if (session && session.source === source) return session.ready;
    const shared = !!self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    pool ??= new WorkerPool(poolSize());
    session = { source };
    session.ready = (async () => {
        let bytes = source;
        if (shared && !(source.buffer instanceof SharedArrayBuffer)) {
            const sab = new SharedArrayBuffer(source.byteLength);
            bytes = new Uint8Array(sab);
            bytes.set(source);
        }
        onStatus(t('import.step.analyzing'));
        const [first, ...rest] = pool.workers;
        const t0 = performance.now();
        const res = await pool.request(first, { type: 'index', bytes: shared ? bytes.buffer : source.slice().buffer, shared });
        console.info(`[STEP] Index + structure: ${res.entityCount} entities, ${res.plan.solids.length} solids, ` +
            `${res.plan.instances.length} instances in ${(performance.now() - t0).toFixed(0)} ms ` +
            `(${pool.workers.length} workers, ${shared ? 'SharedArrayBuffer' : 'copy per worker'})`);
        // default names of unnamed nodes come from the worker as autoName (no i18n there)
        for (const node of res.plan.nodes) {
            if (node.autoName) node.name = t(`import.step.autoName.${node.autoName[0]}`, { number: node.autoName[1] });
        }
        onStatus(t('import.step.initWorkers', { count: pool.workers.length }));
        await Promise.all(rest.map(w => pool.request(w, {
            type: 'init',
            bytes: shared ? bytes.buffer : source.slice().buffer,
            offsets: res.offsets,
            angleUnit: res.plan.angleUnit,
        })));
        orientUpAxis(res.plan, bytes);
        session.plan = res.plan;
        return session;
    })();
    try {
        return await session.ready;
    } catch (err) {
        session = null;
        throw err;
    }
}

// --- Up axis ---
// STEP knows no up axis – coordinates come 1:1 from the CAD system, and its convention decides what
// is "up". The viewer (three.js) uses +Y up. CATIA, NX and Solid Edge model with +Z up – without
// conversion those models lay on their back. The exporting program is in the header
// (FILE_NAME: preprocessor_version, originating_system); for these systems all instance matrices are
// rotated by −90° about X (x, y, z) → (x, z, −y). Others (SolidWorks, Inventor, Creo) stay.
// Converters (HOOPS Exchange, …) hide the original program: then the beginning of the data is searched
// for CATIA traces (CATPart/CATProduct names, e.g. 'Product1_AllCATPart').
// Test/override: ?upAxis=z|y.
const Z_UP_SYSTEMS = /CATIA|3DEXPERIENCE|\bNX\s*\d*\b|UNIGRAPHICS|SOLID\s*EDGE/i;
const Y_UP_SYSTEMS = /SOLID\s*WORKS|SWSTEP|INVENTOR|CREO|PRO\/?ENGINEER|FUSION/i;
const CATIA_TRACES = /CAT(?:Part|Product)\b|CATIA/;
const TRACE_SCAN_BYTES = 4 * 1024 * 1024;

/** FILE_NAME of the header: { preprocessor, system } (empty strings if not found) */
export function readStepHeader(bytes) {
    const text = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(bytes.length, 65536)))
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const start = text.search(/FILE_NAME\s*\(/i);
    if (start < 0) return { preprocessor: '', system: '' };
    // top-level arguments of FILE_NAME( … ) – strings with '' escapes, nested lists
    const args = [];
    let depth = 0, current = '', inString = false;
    for (let i = text.indexOf('(', start) + 1; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === "'" && text[i + 1] === "'") { current += "'"; i++; }
            else if (c === "'") inString = false;
            else current += c;
        } else if (c === "'") inString = true;
        else if (c === '(') depth++;
        else if (c === ')') { if (depth-- === 0) { args.push(current.trim()); break; } }
        else if (c === ',' && depth === 0) { args.push(current.trim()); current = ''; }
        else if (depth === 0 && !/\s/.test(c)) current += c;
    }
    return { preprocessor: args[4] || '', system: args[5] || '' };
}

function orientUpAxis(plan, bytes) {
    const header = readStepHeader(bytes);
    const forced = new URLSearchParams(self.location?.search || '').get('upAxis');
    const programs = `${header.system} ${header.preprocessor}`;
    let up = 'y', reason = 'header';
    if (forced === 'z' || forced === 'y') { up = forced; reason = '?upAxis'; }
    else if (Z_UP_SYSTEMS.test(programs)) up = 'z';
    else if (!Y_UP_SYSTEMS.test(programs)) {
        // unknown program/converter: CATIA traces in the data?
        const text = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(bytes.length, TRACE_SCAN_BYTES)));
        if (CATIA_TRACES.test(text)) { up = 'z'; reason = 'CATIA traces in the data'; }
        else reason = 'unknown program, default';
    }
    plan.upAxis = up;
    plan.originatingSystem = header.system || header.preprocessor;
    console.info(`[STEP] Originating system: "${header.system}" (${header.preprocessor}) → ${up === 'z' ? '+Z up, rotated to +Y up' : '+Y up'} (${reason})`);
    if (up !== 'z') return;
    // R · M with R = rotation −90° about X (column-major): row y ← z, row z ← −y
    for (const inst of plan.instances) {
        const m = inst.matrix, r = m.slice();
        for (let c = 0; c < 4; c++) { r[c * 4 + 1] = m[c * 4 + 2]; r[c * 4 + 2] = -m[c * 4 + 1]; }
        inst.matrix = r;
    }
}

/**
 * Tessellates a STEP file.
 * Solids are streamed: as soon as all faces of a solid are done, it is assembled, its BVH is built
 * (priority over further face jobs) and onSolid is called with its mesh instances.
 * @param {Uint8Array} content file content
 * @param {string} quality key of TESS_PRESETS
 * @param {(text: string, fraction?: number) => void} onStatus
 * @param {{bvh?: boolean, onPlan?: (plan) => void, onSolid?: (meshes: object[], geometries: object[]) => void,
 *   solidQualities?: (plan) => (string|null)[], onlySolids?: (plan) => Set<number>, instancing?: boolean}} options
 *   bvh: build BVHs (geometries[i].bvh = serialised roots for MeshBVH.deserialize)
 *   instancing: share geometries of identical shapes (only with bvh) – dropped entries of `geometries` are null
 *   onPlan: structure is known (plan.nodes), before tessellating
 *   onSolid: finished solid – entries as in meshes, geometries via geometries[m.geometry]
 *   solidQualities: quality per solid (null = quality) – quality per part
 *   onlySolids: tessellate only these solids (meshes then contains only their instances)
 * @returns {Promise<{geometries: {positions: Float32Array, normals: Float32Array, index: Uint32Array, bvh?: ArrayBuffer[]}[],
 *   meshes: {geometry: number, matrix: number[], color: number[]|null, name: string, node: number, instance: number}[],
 *   nodes: {name: string, parent: number}[], stats: object}>}
 */
export async function tessellateStep(content, quality, onStatus = () => {}, { bvh = false, onPlan, onSolid, solidQualities, onlySolids, limits, instancing = false } = {}) {
    const t0 = performance.now();
    const { plan } = await prepare(content, onStatus);
    onPlan?.(plan);
    const qualities = solidQualities?.(plan) || [];
    const presetOf = si => TESS_PRESETS[qualities[si] || quality] || TESS_PRESETS.medium;
    const only = onlySolids?.(plan) || null;
    const wanted = si => !only || only.has(si);
    const solidCount = only ? only.size : plan.solids.length;

    // Memory protection: estimate the triangle count from a sample first – opening may choose a coarser
    // level automatically (limits.auto), beyond the hard limit nothing is tessellated at all
    let estimate = null;
    const estimates = {};   // level -> estimated triangles
    if (limits) {
        const sample = sampleFaces(plan, wanted);
        if (sample) {
            onStatus(t('import.step.estimating'));
            const levels = Object.keys(TESS_PRESETS);
            for (;;) {
                estimate = estimates[quality] = await estimateTriangles(plan, sample, presetOf);
                const coarser = levels[levels.indexOf(quality) - 1];
                if (!limits.auto || estimate <= limits.budget || !coarser) break;
                quality = coarser;
            }
            console.info(`[STEP] Estimate from ${sample.count} sample faces: ` +
                Object.entries(estimates).map(([q, n]) => `"${q}" ~${Math.round(n).toLocaleString('en')}`).join(', ') +
                ` triangles (budget ${limits.budget.toLocaleString('en')}, limit ${limits.limit.toLocaleString('en')})`);
            if (estimate > limits.limit) throw new ImportLimitError(estimate, limits.limit, quality, false);
        }
    }

    // Instances per solid (for onSolid and the mesh list)
    const instancesBySolid = plan.solids.map(() => []);
    plan.instances.forEach((inst, ii) => instancesBySolid[inst.solid].push(ii));

    // --- Jobs: faces per solid in batches ---
    const jobs = [];
    const faceResults = plan.solids.map(s => new Array(s.faces.length).fill(null));
    const facesLeft = plan.solids.map(s => s.faces.length);
    let totalFaces = 0;
    plan.solids.forEach((s, si) => {
        if (!wanted(si)) return;
        const preset = presetOf(si);
        const defl = Math.max(preset.rel * s.size, 1e-6);
        for (let i = 0; i < s.faces.length; i += FACES_PER_JOB) {
            const faces = Int32Array.from(s.faces.slice(i, i + FACES_PER_JOB));
            jobs.push({ si, start: i, faces, defl: new Float64Array(faces.length).fill(defl), ang: preset.ang });
        }
        totalFaces += s.faces.length;
    });

    const geometries = [];
    const solidGroups = new Array(plan.solids.length).fill(null);
    const bvhQueue = [];   // finished solids whose BVH is still missing
    let assembleMs = 0, bvhMs = 0, solidsDone = 0, flippedFaces = 0, flippedSolids = 0;

    // Solid finished: one geometry per face colour, then BVH (or report directly)
    const finishSolid = si => {
        const ta = performance.now();
        solidGroups[si] = assembleSolid(plan.solids[si], faceResults[si], geometries, n => { flippedFaces += n; flippedSolids++; });
        faceResults[si] = null;   // free partial results
        assembleMs += performance.now() - ta;
        if (bvh && solidGroups[si].length) bvhQueue.push(si);
        else emitSolid(si);
    };
    const emitSolid = si => {
        solidsDone++;
        if (!onSolid || !solidGroups[si].length) return;
        const out = [];
        for (const ii of instancesBySolid[si]) {
            const inst = plan.instances[ii];
            for (const g of solidGroups[si]) {
                out.push(meshEntry(inst, ii, g));
            }
        }
        onSolid(out, geometries);
    };
    plan.solids.forEach((s, si) => { if (!s.faces.length && wanted(si)) finishSolid(si); });

    const instancer = bvh && instancing ? new Instancer(geometries) : null;
    const runBVH = async (w, si) => {
        const tb = performance.now();
        // sequentially: a worker only ever handles one request (request() sets onmessage)
        for (const g of solidGroups[si]) await buildBVH(w, geometries[g.geometry], instancer ? g.geometry + 1 : 0);
        bvhMs += performance.now() - tb;
        if (instancer) {
            // the same tessellation level is required (a coarse duplicate must not stand in for a fine part)
            const preset = presetOf(si);
            const defl = Math.max(preset.rel * plan.solids[si].size, 1e-6);
            for (const g of solidGroups[si]) instancer.add(g, `${preset.rel}/${preset.ang}`, defl);
        }
        emitSolid(si);
    };

    // --- Dynamic distribution: BVHs of finished solids first, then more faces ---
    // triangles: running count against limits.limit – exceeded = all workers stop after their
    // current job (no request stays open, the pool can be reused), then ImportLimitError
    let next = 0, doneFaces = 0, errors = 0, triangles = 0, stopped = false;
    const t1 = performance.now();
    const fmt = n => n.toLocaleString(getLocale());
    const status = () => onStatus(t('import.step.tessellating', { faces: fmt(doneFaces), totalFaces: fmt(totalFaces), solids: fmt(solidsDone), totalSolids: fmt(solidCount) }),
        totalFaces ? doneFaces / totalFaces : 1);
    const runWorker = async w => {
        for (;;) {
            if (stopped) break;
            if (bvhQueue.length) { await runBVH(w, bvhQueue.shift()); status(); continue; }
            if (next >= jobs.length) break;
            const job = jobs[next++];
            const r = await pool.request(w, { type: 'faces', job: 0, faces: job.faces, defl: job.defl, ang: job.ang });
            let vo = 0, io = 0, eo = 0;
            for (let k = 0; k < job.faces.length; k++) {
                const nv = r.counts[k * 3], ni = r.counts[k * 3 + 1], ne = r.counts[k * 3 + 2];
                if (nv > 0 && ni > 0) {
                    faceResults[job.si][job.start + k] = {
                        positions: r.positions.subarray(vo * 3, (vo + nv) * 3),
                        normals: r.normals.subarray(vo * 3, (vo + nv) * 3),
                        indices: r.indices.subarray(io, io + ni),
                        edges: r.edges.subarray(eo, eo + ne),
                    };
                }
                vo += nv; io += ni; eo += ne;
            }
            triangles += r.indices.length / 3;
            if (limits && triangles > limits.limit) stopped = true;
            if (stopped) break;
            if (r.errors.length) {
                errors += r.errors.length;
                console.warn('[STEP] Faces could not be tessellated:', r.errors);
            }
            doneFaces += job.faces.length;
            facesLeft[job.si] -= job.faces.length;
            if (facesLeft[job.si] === 0) finishSolid(job.si);
            status();
        }
    };
    await Promise.all(pool.workers.map(runWorker));
    if (stopped) {
        console.warn(`[STEP] Triangle limit exceeded: ${triangles.toLocaleString('en')} > ${limits.limit.toLocaleString('en')} after ${doneFaces} of ${totalFaces} faces`);
        throw new ImportLimitError(triangles, limits.limit, quality, true);
    }
    // BVH jobs that were added only after a worker had finished
    await Promise.all(pool.workers.map(async w => { while (bvhQueue.length) await runBVH(w, bvhQueue.shift()); }));
    const t2 = performance.now();

    const meshes = [];
    for (const [ii, inst] of plan.instances.entries()) {
        if (!wanted(inst.solid)) continue;
        for (const g of solidGroups[inst.solid] || []) {
            meshes.push(meshEntry(inst, ii, g));
        }
    }

    // Free the workers' caches – they would otherwise occupy memory until the next import
    await Promise.all(pool.workers.map(w => pool.request(w, { type: 'trim' })));

    let uniqueTriangles = 0;
    for (const g of geometries) if (g) uniqueTriangles += g.index.length / 3;
    instancer?.dispose();
    const stats = {
        workers: pool.workers.length,
        faces: totalFaces,
        solids: solidCount,
        failedFaces: errors,
        flippedFaces, flippedSolids,   // orientation repaired (orientFaces)
        triangles: uniqueTriangles,
        quality,
        estimate: estimate === null ? null : Math.round(estimate),
        prepareMs: Math.round(t1 - t0),
        tessellateMs: Math.round(t2 - t1),   // incl. BVH (runs interleaved)
        assembleMs: Math.round(assembleMs),
        bvhMs: Math.round(bvhMs),             // sum over all workers
        ...instancer?.stats,                  // instanced geometries / triangles no longer stored
    };
    console.info('[STEP] Tessellation:', stats);
    if (flippedFaces) console.info(`[STEP] Orientation repaired: ${flippedFaces} faces in ${flippedSolids} solids flipped (inconsistent same_sense or inward-facing surface model)`);
    return { geometries, meshes, nodes: plan.nodes, stats, quality, estimates };
}

/**
 * Tessellation would exceed the triangle limit (memory protection, IMPORT in config.js).
 * during = false: refused beforehand (estimate), true: aborted while tessellating (counted).
 */
export class ImportLimitError extends Error {
    constructor(triangles, limit, quality, during) {
        super(`Triangle limit exceeded: ${Math.round(triangles)} > ${limit} (${quality})`);
        this.name = 'ImportLimitError';
        Object.assign(this, { triangles: Math.round(triangles), limit, quality, during });
    }
}

// Below this many faces the estimate is skipped: tessellating is quick, the running count protects
const SAMPLE_MIN_FACES = 3000;

/**
 * Random sample of the faces to tessellate (reproducible, fixed seed): 1.5 % of the faces, 400–2000.
 * Returns { faces: [[si, faceIndex]], count, total } or null for small models.
 */
function sampleFaces(plan, wanted) {
    let total = 0;
    plan.solids.forEach((s, si) => { if (wanted(si)) total += s.faces.length; });
    if (total <= SAMPLE_MIN_FACES) return null;
    const count = Math.min(2000, Math.max(400, Math.ceil(total * 0.015)));
    let seed = 0x2545F491;
    const random = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const picks = new Set();
    while (picks.size < count) picks.add(Math.floor(random() * total));
    const sorted = [...picks].sort((a, b) => a - b);
    const faces = [];
    let offset = 0, k = 0;
    plan.solids.forEach((s, si) => {
        if (!wanted(si)) return;
        while (k < sorted.length && sorted[k] < offset + s.faces.length) faces.push([si, sorted[k++] - offset]);
        offset += s.faces.length;
    });
    return { faces, count, total };
}

/** Triangles of the whole model, extrapolated from the sample (tessellated in the pool, results discarded) */
async function estimateTriangles(plan, sample, presetOf) {
    // jobs of FACES_PER_JOB faces with the same angle (ang is per job)
    const byAngle = new Map();
    for (const [si, fi] of sample.faces) {
        const preset = presetOf(si);
        if (!byAngle.has(preset.ang)) byAngle.set(preset.ang, []);
        byAngle.get(preset.ang).push([plan.solids[si].faces[fi], Math.max(preset.rel * plan.solids[si].size, 1e-6)]);
    }
    const jobs = [];
    for (const [ang, list] of byAngle) {
        for (let i = 0; i < list.length; i += FACES_PER_JOB) {
            const part = list.slice(i, i + FACES_PER_JOB);
            jobs.push({ faces: Int32Array.from(part, f => f[0]), defl: Float64Array.from(part, f => f[1]), ang });
        }
    }
    let next = 0, triangles = 0;
    await Promise.all(pool.workers.map(async w => {
        while (next < jobs.length) {
            const job = jobs[next++];
            const r = await pool.request(w, { type: 'faces', job: 0, faces: job.faces, defl: job.defl, ang: job.ang });
            triangles += r.indices.length / 3;
        }
    }));
    return triangles * sample.total / sample.count;
}

// Mesh entry of an instance; key is stable across quality levels (instance + face colour),
// so scene states find their material assignments again
function meshEntry(inst, ii, g) {
    return {
        geometry: g.geometry, matrix: g.align ? _m.fromArray(inst.matrix).multiply(_align.fromArray(g.align)).toArray() : inst.matrix, color: g.color || inst.color || null, name: inst.name, node: inst.node, instance: ii,
        key: `${ii}/${g.color ? g.color.map(c => c.toFixed(4)).join(',') : '-'}`,
    };
}

const _m = new Matrix4(), _align = new Matrix4();

/**
 * Ray test for orientFaces: does the normal of a face point inwards? From the centre of its largest
 * triangle, three slightly scattered rays along the triangle normal; an odd number of hits with the
 * own solid = inside. Bounding box per face as pre-filter, then Möller-Trumbore.
 * Returns (fi) => +1 (inside), -1 (outside), 0 (unclear).
 */
function insideTester(results) {
    const boxes = results.map(r => {
        if (!r) return null;
        const p = r.positions, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { if (p[i + c] < b[c]) b[c] = p[i + c]; if (p[i + c] > b[c + 3]) b[c + 3] = p[i + c]; }
        return b;
    });
    let size = 0;
    for (const b of boxes) if (b) size = Math.max(size, b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    const eps = size * 1e-6;
    const slab = (b, o, d) => {
        let t0 = 0, t1 = Infinity;
        for (let c = 0; c < 3; c++) {
            if (Math.abs(d[c]) < 1e-300) { if (o[c] < b[c] - eps || o[c] > b[c + 3] + eps) return false; continue; }
            let ta = (b[c] - eps - o[c]) / d[c], tb = (b[c + 3] + eps - o[c]) / d[c];
            if (ta > tb) { const t = ta; ta = tb; tb = t; }
            t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
            if (t0 > t1) return false;
        }
        return true;
    };
    const hits = (o, d) => {
        let count = 0;
        for (let fi = 0; fi < results.length; fi++) {
            const b = boxes[fi];
            if (!b || !slab(b, o, d)) continue;
            const { positions: p, indices: ix } = results[fi];
            for (let t = 0; t < ix.length; t += 3) {
                const a = ix[t] * 3, b1 = ix[t + 1] * 3, c = ix[t + 2] * 3;
                const e1x = p[b1] - p[a], e1y = p[b1 + 1] - p[a + 1], e1z = p[b1 + 2] - p[a + 2];
                const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
                const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (Math.abs(det) < 1e-18) continue;
                const inv = 1 / det, sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2];
                const u = (sx * px + sy * py + sz * pz) * inv;
                if (u < 0 || u > 1) continue;
                const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
                const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
                if (v < 0 || u + v > 1) continue;
                if ((e2x * qx + e2y * qy + e2z * qz) * inv > eps) count++;
            }
        }
        return count;
    };
    return fi => {
        const { positions: p, indices: ix } = results[fi];
        let best = -1, ba = 0, nx = 0, ny = 0, nz = 0;
        for (let t = 0; t < ix.length; t += 3) {
            const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
            const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, ar = Math.hypot(cx, cy, cz);
            if (ar > ba) { ba = ar; best = t; nx = cx / ar; ny = cy / ar; nz = cz / ar; }
        }
        if (best < 0) return 0;
        const a = ix[best] * 3, b = ix[best + 1] * 3, c = ix[best + 2] * 3;
        const o = [(p[a] + p[b] + p[c]) / 3 + nx * eps * 10, (p[a + 1] + p[b + 1] + p[c + 1]) / 3 + ny * eps * 10, (p[a + 2] + p[b + 2] + p[c + 2]) / 3 + nz * eps * 10];
        let odd = 0;
        for (const [jx, jy, jz] of [[0, 0, 0], [0.013, 0.021, -0.017], [-0.019, 0.011, 0.015]]) {
            const l = Math.hypot(nx + jx, ny + jy, nz + jz);
            if (hits(o, [(nx + jx) / l, (ny + jy) / l, (nz + jz) / l]) % 2) odd++;
        }
        return odd >= 2 ? 1 : -1;
    };
}

/**
 * Boundary edges of all faces of a solid, matched by position (edges are sampled identically per face).
 * Typed open-addressing hash tables instead of a Map with string keys: a car assembly (a single solid
 * with 79 000 faces, millions of edges) needed several GB of JS heap that way – shared with all workers
 * (one 4 GB V8 pointer cage per tab), the tab crashed. Typed arrays live outside the cage.
 * Positions are compared like the former string keys (exact value, -0 = 0).
 * Returns { edgeCount, uses }: per edge 5 entries [count, face0, dir0, face1, dir1] (dir +1: from the lower
 * to the higher vertex id); only the first two uses are stored, count keeps counting.
 */
const HASH_F64 = new Float64Array(1), HASH_U32 = new Uint32Array(HASH_F64.buffer);
const hashNumber = (h, x) => {
    HASH_F64[0] = x + 0;   // -0 → 0
    h = Math.imul(h ^ HASH_U32[0], 0x9E3779B1);
    h = Math.imul(h ^ (h >>> 15) ^ HASH_U32[1], 0x85EBCA77);
    return h ^ (h >>> 13);
};
const growArray = (a, min) => { const b = new a.constructor(Math.max(a.length * 2, min)); b.set(a); return b; };
const pow2Above = x => { let c = 1024; while (c < x) c *= 2; return c; };

function collectEdgeUses(results) {
    let endpoints = 0;
    for (const r of results) if (r && r.edges) endpoints += r.edges.length;
    // vertices: slot -> vertex id (-1 = empty), coordinates per id
    let vMask = pow2Above(endpoints / 2) - 1, vSlots = new Int32Array(vMask + 1).fill(-1);
    let coords = new Float64Array(3072), vCount = 0;
    const vHash = (x, y, z) => hashNumber(hashNumber(hashNumber(0x811C9DC5, x), y), z) & vMask;
    const vertexId = (x, y, z) => {
        let h = vHash(x, y, z);
        for (let id = vSlots[h]; id >= 0; h = (h + 1) & vMask, id = vSlots[h]) {
            if (coords[id * 3] === x && coords[id * 3 + 1] === y && coords[id * 3 + 2] === z) return id;
        }
        const id = vCount++;
        if (vCount * 3 > coords.length) coords = growArray(coords, vCount * 3);
        coords[id * 3] = x; coords[id * 3 + 1] = y; coords[id * 3 + 2] = z;
        vSlots[h] = id;
        if (vCount > (vMask + 1) * 0.6) {
            vMask = vMask * 2 + 1;
            vSlots = new Int32Array(vMask + 1).fill(-1);
            for (let v = 0; v < vCount; v++) {
                let s = vHash(coords[v * 3], coords[v * 3 + 1], coords[v * 3 + 2]);
                while (vSlots[s] >= 0) s = (s + 1) & vMask;
                vSlots[s] = v;
            }
        }
        return id;
    };
    // undirected edges (lower, higher vertex id): slot -> edge id
    let eMask = pow2Above(endpoints / 2) - 1, eSlots = new Int32Array(eMask + 1).fill(-1);
    let ends = new Int32Array(2048), uses = new Int32Array(5120), edgeCount = 0;
    const eHash = (a, b) => { const h = Math.imul(a ^ Math.imul(b, 0x85EBCA77), 0x9E3779B1); return (h ^ (h >>> 15)) & eMask; };
    for (let fi = 0; fi < results.length; fi++) {
        const r = results[fi];
        if (!r || !r.edges) continue;
        const { positions: p, edges: e } = r;
        for (let k = 0; k < e.length; k += 2) {
            const i = e[k] * 3, j = e[k + 1] * 3;
            const A = vertexId(p[i], p[i + 1], p[i + 2]), B = vertexId(p[j], p[j + 1], p[j + 2]);
            if (A === B) continue;
            const lo = A < B ? A : B, hi = A < B ? B : A, dir = A < B ? 1 : -1;
            let h = eHash(lo, hi), ei = eSlots[h];
            for (; ei >= 0; h = (h + 1) & eMask, ei = eSlots[h]) if (ends[ei * 2] === lo && ends[ei * 2 + 1] === hi) break;
            if (ei < 0) {
                ei = edgeCount++;
                if (edgeCount * 2 > ends.length) ends = growArray(ends, edgeCount * 2);
                if (edgeCount * 5 > uses.length) uses = growArray(uses, edgeCount * 5);
                ends[ei * 2] = lo; ends[ei * 2 + 1] = hi;
                eSlots[h] = ei;
                if (edgeCount > (eMask + 1) * 0.6) {
                    eMask = eMask * 2 + 1;
                    eSlots = new Int32Array(eMask + 1).fill(-1);
                    for (let q = 0; q < edgeCount; q++) {
                        let s = eHash(ends[q * 2], ends[q * 2 + 1]);
                        while (eSlots[s] >= 0) s = (s + 1) & eMask;
                        eSlots[s] = q;
                    }
                }
            }
            const c = uses[ei * 5]++;
            if (c < 2) { uses[ei * 5 + 1 + c * 2] = fi; uses[ei * 5 + 2 + c * 2] = dir; }
        }
    }
    return { edgeCount, uses };
}

/**
 * Make the orientation of a solid's faces consistent (like ShapeFix in OpenCascade).
 * Some exports (CATIA, spline surfaces) state `same_sense` wrongly – the face then points inwards
 * and is invisible with FrontSide materials ("holes", Basic with DoubleSide looks closed).
 * In a correctly oriented shell, two neighbouring faces traverse their shared edge in opposite
 * directions. Shared boundary edges (same boundary points – edges are sampled identically per face;
 * only edges with exactly two faces) determine which faces have to be flipped; the overall direction
 * per shell is chosen so that as few faces as possible flip relative to the file. These candidates
 * are confirmed group-wise by a ray test (insideTester) – only then flipped.
 * Strongest face pairs decide first (union-find with parity); if more than 2 % of a shell's edge
 * weight disagrees, it stays unchanged. Returns the number of flipped faces.
 */
export function orientFaces(s, results) {
    const n = results.length;
    const { edgeCount, uses } = collectEdgeUses(results);
    // Face pairs via edges with exactly two faces (otherwise touching sub-solids, seams …):
    // weight = number of opposite minus same-direction shared edges
    const pairW = new Map();
    let openEdges = 0;
    for (let ei = 0; ei < edgeCount; ei++) {
        const count = uses[ei * 5];
        if (count === 1) openEdges++;
        if (count !== 2 || uses[ei * 5 + 1] === uses[ei * 5 + 3]) continue;
        const a = uses[ei * 5 + 1], da = uses[ei * 5 + 2], b = uses[ei * 5 + 3], db = uses[ei * 5 + 4];
        const k = a < b ? a * n + b : b * n + a;
        pairW.set(k, (pairW.get(k) || 0) + (da !== db ? 1 : -1));
    }
    // Union-find with parity: strongest pairs first (maximum spanning forest) – single contradicting
    // edges (folded triangles, edge cases at transitions) are outvoted this way instead of blocking the
    // whole shell. Parity 1 = flip face relative to the root.
    const parent = new Int32Array(n).map((_, i) => i), par = new Uint8Array(n);
    const find = x => {
        let p = 0, r = x;
        while (parent[r] !== r) { p ^= par[r]; r = parent[r]; }
        // path compression
        let y = x, py = p;
        while (parent[y] !== y) { const next = parent[y], pn = py ^ par[y]; parent[y] = r; par[y] = py; y = next; py = pn; }
        return [r, p];
    };
    // strongest first; on a tie, agreeing (opposite) pairs before contradicting ones –
    // otherwise chance decides when all pairs have weight 1 (a circular pattern feature: a single
    // same-direction edge flipped planes that two neighbours confirmed as correct)
    const pairs = [...pairW].filter(([, w]) => w !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || b[1] - a[1]);
    for (const [k, w] of pairs) {
        const a = Math.floor(k / n), b = k % n, rel = w > 0 ? 0 : 1;
        const [ra, pa] = find(a), [rb, pb] = find(b);
        if (ra !== rb) { parent[rb] = ra; par[rb] = pa ^ pb ^ rel; }
    }
    const flipOf = new Uint8Array(n), root = new Int32Array(n);
    for (let fi = 0; fi < n; fi++) { const [r, p] = find(fi); root[fi] = r; flipOf[fi] = p; }
    // local refinement: flip a face if more edge weight agrees with it afterwards
    const adj = Array.from({ length: n }, () => []);
    for (const [k, w] of pairs) { const a = Math.floor(k / n), b = k % n; adj[a].push(b, w); adj[b].push(a, w); }
    const disagree = (fi, f) => { let d = 0; const l = adj[fi]; for (let q = 0; q < l.length; q += 2) { const rel = l[q + 1] > 0 ? 0 : 1; if ((f ^ flipOf[l[q]]) !== rel) d += Math.abs(l[q + 1]); else d -= Math.abs(l[q + 1]); } return d; };
    for (let pass = 0; pass < 10; pass++) {
        let changed = false;
        for (let fi = 0; fi < n; fi++) if (adj[fi].length && disagree(fi, flipOf[fi]) > 0) { flipOf[fi] ^= 1; changed = true; }
        if (!changed) break;
    }
    // collect components (shells), count contradictions after the refinement
    const comps = new Map();
    for (let fi = 0; fi < n; fi++) {
        if (!results[fi]) continue;
        let c = comps.get(root[fi]);
        if (!c) comps.set(root[fi], c = { faces: [], flip: [], weight: 0, bad: 0 });
        c.faces.push(fi); c.flip.push(flipOf[fi]);
    }
    for (const [k, w] of pairs) {
        const a = Math.floor(k / n), b = k % n, c = comps.get(root[a]);
        c.weight += Math.abs(w);
        if ((flipOf[a] ^ flipOf[b]) !== (w > 0 ? 0 : 1)) c.bad += Math.abs(w);
    }
    // Shells with two orientation classes (parity 0/1): the geometry decides which class is wrong –
    // a ray along the normal hitting the own solid an odd number of times = points inwards.
    // Every connected group of a class is checked separately. The edge votes alone were unreliable for
    // SLA/spline data, a majority rule fails for small parts that are mostly wrong
    // (seen: 8 of 10 faces). Only (nearly) closed shells.
    const candidate = new Uint8Array(n);
    for (const c of comps.values()) {
        if (c.faces.length < 2 || c.bad > c.weight * 0.02) continue;
        const ones = c.flip.filter(f => f).length;
        if (ones === 0 || ones === c.faces.length) continue;   // consistent: nothing to do
        for (const fi of c.faces) candidate[fi] = 1;
    }
    const flipFace = fi => {
        const { normals: nr, indices: ix } = results[fi];
        for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
        for (let q = 0; q < nr.length; q++) nr[q] = -nr[q];
    };
    let flipped = 0;
    if (candidate.some(Boolean) && openEdges <= edgeCount * 0.05) {
        const inside = insideTester(results);
        // check connected candidate groups (via adjacency) together
        const seenF = new Uint8Array(n);
        for (let start = 0; start < n; start++) {
            if (!candidate[start] || seenF[start]) continue;
            const group = [start];
            seenF[start] = 1;
            for (let h = 0; h < group.length; h++) {
                const l = adj[group[h]];
                // only neighbours of the same class (same parity)
                for (let q = 0; q < l.length; q += 2) if (candidate[l[q]] && !seenF[l[q]] && flipOf[l[q]] === flipOf[group[h]]) { seenF[l[q]] = 1; group.push(l[q]); }
            }
            // sample: up to 5 faces of the group (largest first), largest triangle of each
            const sample = group.slice().sort((a, b) => results[b].indices.length - results[a].indices.length).slice(0, 5);
            let inward = 0, outward = 0;
            for (const fi of sample) { const v = inside(fi); if (v > 0) inward++; else if (v < 0) outward++; }
            if (inward <= outward) continue;
            for (const fi of group) { flipFace(fi); flipped++; }
        }
    }
    if (s.surface) flipped += orientSkins(results, root, flipFace);
    return flipped;
}

/**
 * Surface models (SHELL_BASED_SURFACE_MODEL, open shells): STEP defines no inside for a skin, CAD systems
 * orient it arbitrarily (a vehicle cabin: a perfectly consistent skin with 97 % of its area facing
 * inward – looks flipped with FrontSide materials). Turn every connected skin (root = component id
 * from orientFaces) so its normals point away from the centre of the whole body (area weighted,
 * measured against the body centre so separate panels like doors match the rest). Only if clearly
 * inward – flat single sheets (no clear side) stay as they are. Returns the number of flipped faces.
 */
function orientSkins(results, root, flipFace) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const r of results) {
        if (!r) continue;
        const p = r.positions;
        for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { if (p[i + c] < mn[c]) mn[c] = p[i + c]; if (p[i + c] > mx[c]) mx[c] = p[i + c]; }
    }
    const C = mn.map((v, c) => (v + mx[c]) / 2);
    const skins = new Map();   // component -> { faces, out (signed), total (abs) }
    results.forEach((r, fi) => {
        if (!r) return;
        let sk = skins.get(root[fi]);
        if (!sk) skins.set(root[fi], sk = { faces: [], out: 0, total: 0 });
        sk.faces.push(fi);
        const { positions: p, indices: ix } = r;
        for (let t = 0; t < ix.length; t += 3) {
            const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
            const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
            // (triangle centre − body centre) · (area-weighted normal)
            const m = ((p[a] + p[b] + p[c]) / 3 - C[0]) * (uy * vz - uz * vy)
                + ((p[a + 1] + p[b + 1] + p[c + 1]) / 3 - C[1]) * (uz * vx - ux * vz)
                + ((p[a + 2] + p[b + 2] + p[c + 2]) / 3 - C[2]) * (ux * vy - uy * vx);
            sk.out += m;
            sk.total += Math.abs(m);
        }
    });
    let flipped = 0;
    for (const sk of skins.values()) {
        if (sk.total === 0 || sk.out > -0.2 * sk.total) continue;   // outward or undecided
        for (const fi of sk.faces) { flipFace(fi); flipped++; }
    }
    return flipped;
}

// Assemble the faces of a solid into geometries: one per face colour
function assembleSolid(s, results, geometries, onFlipped) {
    const flipped = orientFaces(s, results);
    if (flipped) onFlipped?.(flipped);
    const byColor = new Map();
    s.faces.forEach((_, fi) => {
        const r = results[fi];
        if (!r) return;
        const c = s.faceColors[fi];
        const key = c ? c.join(',') : '';
        if (!byColor.has(key)) byColor.set(key, { color: c, faces: [] });
        byColor.get(key).faces.push(r);
    });
    const groups = [];
    for (const { color, faces } of byColor.values()) {
        let nv = 0, ni = 0;
        for (const f of faces) { nv += f.positions.length / 3; ni += f.indices.length; }
        const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), index = new Uint32Array(ni);
        let vo = 0, io = 0;
        for (const f of faces) {
            positions.set(f.positions, vo * 3);
            normals.set(f.normals, vo * 3);
            const src = f.indices;
            for (let k = 0; k < src.length; k++) index[io + k] = src[k] + vo;
            vo += f.positions.length / 3;
            io += src.length;
        }
        groups.push({ geometry: geometries.length, color });
        geometries.push({ positions, normals, index, uvs: boxUVs(positions, normals), name: s.name });
    }
    return groups;
}

// Texture coordinates via box projection (CAD geometry has no UVs): per vertex the plane
// perpendicular to the dominant normal axis, 1 UV unit = UV_TILE model units (mm).
// Shared by the raster view and the path tracer (material textures).
export const UV_TILE = 100;
export function boxUVs(positions, normals, tile = UV_TILE) {
    const n = positions.length / 3;
    const uv = new Float32Array(n * 2);
    const k = 1 / tile;
    for (let i = 0; i < n; i++) {
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        const ax = Math.abs(normals[i * 3]), ay = Math.abs(normals[i * 3 + 1]), az = Math.abs(normals[i * 3 + 2]);
        if (ax >= ay && ax >= az) { uv[i * 2] = y * k; uv[i * 2 + 1] = z * k; }
        else if (ay >= az) { uv[i * 2] = x * k; uv[i * 2 + 1] = z * k; }
        else { uv[i * 2] = x * k; uv[i * 2 + 1] = y * k; }
    }
    return uv;
}

// Build BVH (+ tangents) of one geometry in a worker; buffers are transferred there and back.
// shapeSeed > 0: also the shape fingerprint (g.shape, for the Instancer)
async function buildBVH(w, g, shapeSeed = 0) {
    const r = await requestWorker(w, { type: 'bvh', positions: g.positions, index: g.index, normals: g.normals, uvs: g.uvs, shape: shapeSeed > 0, seed: shapeSeed },
        [g.positions.buffer, g.index.buffer, g.normals.buffer, g.uvs.buffer]);
    if (r.shape) g.shape = r.shape;
    g.positions = r.positions;
    g.index = r.index;
    g.bvh = r.roots;
    g.normals = r.normals;
    g.uvs = r.uvs;
    g.tangents = r.tangents;
}

// Distribute the BVHs of all geometries dynamically to the workers, largest first (better utilisation).
async function buildBVHs(geometries, onStatus) {
    const order = geometries.map((_, i) => i)
        .sort((a, b) => geometries[b].index.length - geometries[a].index.length);
    let next = 0, done = 0;
    const runWorker = async w => {
        while (next < order.length) {
            await buildBVH(w, geometries[order[next++]]);
            done++;
            onStatus(t('import.step.buildingBvh', { done, total: order.length }), done / order.length);
        }
    };
    await Promise.all(pool.workers.map(runWorker));
}

/**
 * BVH + tangents of a single geometry in its own short-lived worker – independent of the pool,
 * so an import starting at the same time does not collide with the same worker
 * (e.g. ground disc at startup). g as for buildGeometryBVHs.
 */
export async function buildBVHIsolated(g) {
    const w = createWorker();
    try { await buildBVH(w, g); } finally { w.terminate(); }
}

/**
 * Orientation repair of a triangle soup (STL, mesh-orient.js) in its own short-lived worker.
 * positions (non-indexed) are transferred; returns { positions, stats }.
 */
export async function orientTrianglesIsolated(positions) {
    const w = createWorker();
    try {
        const r = await requestWorker(w, { type: 'orient', positions }, [positions.buffer]);
        return { positions: r.positions, stats: r.stats };
    } finally { w.terminate(); }
}

/**
 * Build BVHs + tangents for foreign geometries (glTF/FBX import) in the worker pool.
 * Every geometry needs its own buffers (they are transferred to the worker and replaced).
 */
export async function buildGeometryBVHs(geometries, onStatus = () => {}) {
    pool ??= new WorkerPool(poolSize());
    await buildBVHs(geometries, onStatus);
}

/**
 * Release file and index (large files after the import). The workers are terminated: idle workers
 * practically never collect their memory, so the file (SharedArrayBuffer) would stay in the
 * process – every re-tessellation would have piled up another copy (+400 MB per run).
 * The next call of tessellateStep starts a new pool and rebuilds the index.
 */
export function releaseStepFile() {
    if (!session) return;
    disposeStepImporter();
}

/**
 * Abort a running import immediately (new model dropped): terminate the worker pool, pending requests
 * end with AbortError. The next import starts a new pool.
 */
export function abortStepImport() {
    const err = new DOMException('Import aborted', 'AbortError');
    for (const e of [...inflight]) if (pool?.workers.includes(e.w)) { inflight.delete(e); e.reject(err); }
    disposeStepImporter();
}

// Release worker pool and cache
export function disposeStepImporter() {
    pool?.terminate();
    pool = null;
    session = null;
}
