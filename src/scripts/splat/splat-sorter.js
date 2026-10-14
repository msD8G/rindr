// Coordinates the sort workers (splat-sort-worker.js): parallel counting sort of all splats back to front.
// With SharedArrayBuffer (cross-origin isolated, see astro.config.mjs/.htaccess) positions, keys, histograms
// and the result are shared – each worker handles a slice, the main thread only turns the histograms into
// offsets (65 536 × workers additions). 13 M splats: a few 10 ms instead of ~150 ms in one worker.
// Result: `order` (Uint32Array, splat indices, the first `visible` entries are valid).
const SHARED = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated !== false;

export class SplatSorter {
    /**
     * @param {Uint32Array} a splat data (x, y, z float bits + colour per splat; SharedArrayBuffer if possible)
     * @param {number} count
     */
    constructor(a, count) {
        this.count = count;
        const shared = SHARED && a.buffer instanceof SharedArrayBuffer;
        const n = !shared ? 1 : Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1, Math.ceil(count / 250000)));
        this.shared = shared;
        this.order = new Uint32Array(shared ? new SharedArrayBuffer(count * 4) : new ArrayBuffer(0));
        const keys = shared ? new SharedArrayBuffer(count * 4) : null;
        this.hist = shared ? new Uint32Array(new SharedArrayBuffer(n * 65536 * 4)) : null;
        this.workers = [];
        for (let w = 0; w < n; w++) {
            const worker = new Worker(new URL('./splat-sort-worker.js', import.meta.url), { type: 'module' });
            const start = Math.floor(count * w / n), end = Math.floor(count * (w + 1) / n);
            worker.postMessage({
                type: 'init', worker: w, start, end, a: shared ? a.buffer : a.buffer.slice(0),
                keys, order: shared ? this.order.buffer : null, hist: this.hist?.buffer,
            });
            this.workers.push(worker);
        }
    }

    _call(worker, msg) {
        return new Promise(resolve => {
            worker.onmessage = ({ data }) => resolve(data);
            worker.postMessage(msg);
        });
    }

    /**
     * camera (data space): { origin, dir (unit, forward), mode: 'depth' | 'distance', planes: [nx, ny, nz, d, …]
     * (keep where ≥ 0), near, far (depth range of the keys) } → number of visible splats in `order`
     */
    async sort(camera) {
        if (this.disposed) return 0;
        if (!this.shared) {
            const res = await this._call(this.workers[0], { type: 'sortAll', camera });
            if (res.order) this.order = new Uint32Array(res.order);
            return res.visible;
        }
        const counts = await Promise.all(this.workers.map(w => this._call(w, { type: 'keys', camera })));
        if (this.disposed) return 0;
        // histograms → start offsets (bin-major, worker-minor: stable order within a bin)
        const h = this.hist, n = this.workers.length;
        let run = 0;
        for (let k = 0; k < 65536; k++) {
            for (let w = 0, o = k; w < n; w++, o += 65536) { const c = h[o]; h[o] = run; run += c; }
        }
        await Promise.all(this.workers.map(w => this._call(w, { type: 'scatter' })));
        return counts.reduce((s, c) => s + c.visible, 0);
    }

    dispose() {
        this.disposed = true;
        for (const w of this.workers) w.terminate();
        this.workers = [];
    }
}
