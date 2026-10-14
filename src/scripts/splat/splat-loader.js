// Main-thread side of the Gaussian splat import: file type detection and loading in a worker
// (splat-load-worker.js). Aborting terminates the worker.
import { plyHeaderOf, parsePlyHeader, plyKind, splatPlyLayout, samplePly, keptShCoeffs, SplatBuilder, beginInfo, finishStats } from './splat-formats.js';
import { debugLog } from '../log.js';

export const SPLAT_EXTENSIONS = ['ply', 'sog'];
const extOf = name => name.split('.').pop().toLowerCase();

/**
 * Does the file hold Gaussian splats? .sog always; .ply: by its header (a PLY can also be a plain mesh).
 * @param {{ name: string, file?: Blob, main?: Blob, url?: string }} source
 * @returns {Promise<boolean>}
 */
export async function isSplatSource(source) {
    const ext = extOf(source.name);
    if (ext === 'sog') return true;
    if (ext !== 'ply') return false;
    try {
        const blob = source.file || source.main;
        let bytes;
        if (blob) bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
        else {
            const res = await fetch(source.url, { headers: { Range: 'bytes=0-65535' } });
            if (!res.ok) return false;
            bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, 65536);
        }
        const head = plyHeaderOf(bytes);
        return !!head && plyKind(parsePlyHeader(head.text)) !== 'mesh';
    } catch {
        return false;
    }
}

/**
 * Load splats (PLY streamed, SOG) in a worker.
 * @param {{ name: string, file?: Blob, main?: Blob, url?: string }} source
 * @param {{ signal?: AbortSignal, onProgress?: (fraction: number) => void, maxShDegree?: number, shBudget?: number, maxBinding?: number }} options
 *   onBegin(data): shared buffers + estimated bounds as soon as the first splats are read (progressive display),
 *   onLoaded(count, shCount): splats (and their SH) read so far – only with SharedArrayBuffer
 */
export async function loadSplats(source, options = {}) {
    // binary splat PLY: several workers in parallel (dropped file or server with range requests)
    const parallel = await loadPlyParallel(source, options);
    return parallel || loadInWorker(source, options);
}

function loadInWorker(source, { signal, onProgress, onBegin, onLoaded, ...options } = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./splat-load-worker.js', import.meta.url), { type: 'module' });
        const finish = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
        const abort = () => { finish(); reject(new DOMException('Aborted', 'AbortError')); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort);
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') onProgress?.(data.fraction);
            else if (data.type === 'begin') onBegin?.(data.data);
            else if (data.type === 'loaded') onLoaded?.(data.ranges, data.shRanges);
            else if (data.type === 'done') { finish(); resolve(data.result); }
            else if (data.type === 'error') { finish(); reject(new Error(data.message)); }
        };
        worker.onerror = e => { finish(); reject(new Error(e.message || 'Splat worker failed')); };
        worker.postMessage({ file: source.file || source.main || null, url: source.file || source.main ? null : source.url, name: source.name, options });
    });
}

// --- Parallel PLY loading ---
// Every vertex row of a 3DGS PLY has the same size: the rows are split into ranges, one worker per range
// reads its bytes (file.slice / HTTP range) and writes into the shared buffers. Bounds and SH range come
// from rows sampled across the file beforehand – the scene can be shown right away and fills up from all
// ranges at once. null = not possible (no SharedArrayBuffer, compressed PLY, no range requests …).
const SHARED = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated !== false;

async function rangeReader(source, signal) {
    const file = source.file || source.main;
    if (file) return { size: file.size, read: (a, b) => file.slice(a, b).arrayBuffer() };
    const read = async (a, b) => {
        const res = await fetch(source.url, { headers: { Range: `bytes=${a}-${b - 1}` }, signal });
        if (res.status !== 206) { res.body?.cancel(); throw new Error('no range requests'); }
        return res.arrayBuffer();
    };
    // the first request tells whether ranges work and the file size (Content-Range: bytes 0-…/size)
    const res = await fetch(source.url, { headers: { Range: 'bytes=0-65535' }, signal });
    if (res.status !== 206) { res.body?.cancel(); return null; }
    const size = +res.headers.get('content-range')?.split('/')[1] || 0;
    const first = await res.arrayBuffer();
    return { size, read: (a, b) => (a === 0 && b <= first.byteLength ? Promise.resolve(first.slice(0, b)) : read(a, b)) };
}

async function loadPlyParallel(source, { signal, onProgress, onBegin, onLoaded, maxShDegree, shBudget, maxBinding } = {}) {
    if (!SHARED || extOf(source.name) !== 'ply') return null;
    let reader;
    try { reader = await rangeReader(source, signal); } catch (err) { if (err.name === 'AbortError') throw err; return null; }
    if (!reader) return null;
    const head = plyHeaderOf(new Uint8Array(await reader.read(0, 65536)));
    if (!head) return null;
    const header = parsePlyHeader(head.text);
    if (header.format !== 'binary_little_endian' || plyKind(header) !== 'splat') return null;
    let layout;
    try { layout = splatPlyLayout(header, head.size); } catch { return null; }
    const { count, rowSize, fileCoeffs } = layout;
    if (!count || (reader.size && layout.offset + count * rowSize > reader.size)) return null;
    const t0 = performance.now();
    const fromFile = !!(source.file || source.main);
    const { estimate, shRange } = await samplePly(layout, reader.read, fromFile ? {} : { groups: 32, rows: 32 });
    const shCoeffs = keptShCoeffs(count, fileCoeffs, { maxShDegree, shBudget, maxBinding });
    const builder = new SplatBuilder(count, shCoeffs, true);
    builder.shRange = shRange;
    onBegin?.(beginInfo(builder, estimate || { min: [-1, -1, -1], max: [1, 1, 1] }));
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1, Math.ceil(count / 200000)));
    const done = new Array(n).fill(0);
    const ranges = Array.from({ length: n }, (_, w) => [Math.floor(count * w / n), Math.floor(count * (w + 1) / n)]);
    const workers = [];
    const stop = () => workers.forEach(w => w.terminate());
    const report = () => {
        onLoaded?.(ranges.map(([s], w) => [s, s + done[w]]));
        onProgress?.(done.reduce((a, b) => a + b, 0) / count);
    };
    let timer = 0;
    try {
        const stats = await new Promise((resolve, reject) => {
            const results = [];
            let left = n;
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            ranges.forEach(([start, end], w) => {
                const worker = new Worker(new URL('./splat-parse-worker.js', import.meta.url), { type: 'module' });
                workers.push(worker);
                worker.onmessage = ({ data }) => {
                    if (data.type === 'progress') {
                        done[w] = data.done;
                        if (!timer) timer = setTimeout(() => { timer = 0; report(); }, 100);
                    } else if (data.type === 'done') {
                        results[w] = data.stats;
                        if (--left === 0) resolve(results);
                    } else reject(new Error(data.message));
                };
                worker.onerror = e => reject(new Error(e.message || 'Splat parser failed'));
                worker.postMessage({
                    file: source.file || source.main || null, url: fromFile ? null : new URL(source.url, location.href).href, layout, start, rows: end - start, total: count,
                    buffers: { a: builder.a, b: builder.b, sh: builder.sh }, shCoeffs, shRange,
                });
            });
        });
        clearTimeout(timer);
        done.forEach((_, w) => { done[w] = ranges[w][1] - ranges[w][0]; });
        report();
        debugLog(`[Splats] parsed ${count} splats with ${n} workers in ${Math.round(performance.now() - t0)} ms`);
        return finishStats(builder, stats, { format: 'ply', fileShCoeffs: fileCoeffs });
    } finally {
        clearTimeout(timer);
        stop();
    }
}
