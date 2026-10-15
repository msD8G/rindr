// Main-thread side of the HDRI generator: worker requests (hdri-worker.js), textures.
import * as THREE from 'three/webgpu';

export class HdriRenderService {
    constructor() {
        this._worker = null;
        this._seq = 0;
        this._pending = new Map();   // id -> { resolve, reject }
    }

    _ensureWorker() {
        if (this._worker) return this._worker;
        const w = this._worker = new Worker(new URL('./hdri-worker.js', import.meta.url), { type: 'module' });
        w.onmessage = ({ data }) => {
            const p = this._pending.get(data.id);
            if (!p) return;
            this._pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data);
        };
        w.onerror = e => {
            for (const p of this._pending.values()) p.reject(new Error(e.message || 'HDRI worker failed'));
            this._pending.clear();
        };
        return w;
    }

    /**
     * Render `doc` at `width` (height = width / 2).
     * @returns {Promise<{ width, height, half?: Uint16Array, pixels?: Uint8ClampedArray, float?: Float32Array }>}
     */
    async render(doc, width, { preview = false, half = true, float = false } = {}) {
        const w = this._ensureWorker();
        const id = ++this._seq;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            w.postMessage({ id, doc, width, preview, half, float });
        });
    }

    /** Environment texture of `doc` at its resolution */
    async texture(doc, width = doc.resolution || 2048) {
        const r = await this.render(doc, width);
        return makeEnvTexture(r.half, r.width, r.height);
    }
}

/**
 * Coalesces requests: while one render runs, only the newest further request is kept and run afterwards
 * ("latest wins") – dragging never queues up stale frames.
 */
export class LatestRender {
    constructor(service, onResult) {
        this.service = service;
        this.onResult = onResult;
        this._busy = false;
        this._next = null;
    }

    request(doc, width, opts) {
        this._next = { doc: JSON.parse(JSON.stringify(doc)), width, opts };
        if (!this._busy) this._run();
    }

    async _run() {
        const job = this._next;
        this._next = null;
        if (!job) return;
        this._busy = true;
        try {
            this.onResult(await this.service.render(job.doc, job.width, job.opts), job);
        } catch (e) {
            console.warn('[HDRI] render failed:', e);
        } finally {
            this._busy = false;
            if (this._next) this._run();
        }
    }
}

/** DataTexture like loadHdri (environment.js): RGBA half float, equirect, row 0 = bottom */
export function makeEnvTexture(half, width, height) {
    const texture = new THREE.DataTexture(
        half, width, height, THREE.RGBAFormat, THREE.HalfFloatType, THREE.EquirectangularReflectionMapping,
        THREE.RepeatWrapping, THREE.ClampToEdgeWrapping, THREE.LinearFilter, THREE.LinearFilter,
    );
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
}
