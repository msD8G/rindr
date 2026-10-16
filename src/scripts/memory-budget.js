// Memory budget of this device – for import limits and parallel work (STEP tessellation, BVH builds), so large models
// adapt to the computer instead of crashing the tab. Derived only from what the browser reports, never from the
// numbers of one development PC:
//   - navigator.deviceMemory: RAM in GB, rounded by the browser (older Chrome capped it at 8, current versions report
//     e.g. 32; missing in Firefox/Safari)
//   - JS heap: Chrome lets all JS heaps of a tab (main thread + workers) share one 4 GB area, independent of the RAM;
//     typed array data does not count. Exceeding it is a crash that JS cannot catch.
// A tab gets about half of the reported RAM as working budget (the rest: system, browser, other tabs).
// Testing: ?deviceMemory=2 pretends a smaller device.

const GB = 2 ** 30;

/** Reported RAM in GB (unknown: 4 – a cautious middle) */
export function deviceMemoryGB() {
    const forced = Number(new URLSearchParams(globalThis.location?.search || '').get('deviceMemory'));
    if (forced > 0) return forced;
    const reported = globalThis.navigator?.deviceMemory;
    return reported > 0 ? reported : 4;
}

let safe = false;
/** Safe mode (load-guard.js – the last load of this model ended the tab): half the budget */
export function setSafeMode(on) {
    safe = !!on;
}

/** Bytes the tab should stay below (RAM data of models, BVHs, worker heaps, file buffers) */
export function memoryBudget() {
    return Math.min(Math.max(deviceMemoryGB() * 0.5, 0.75), 6) * GB * (safe ? 0.5 : 1);
}

/** JS heap area of the tab (Chrome reports it; elsewhere the common 4 GB) */
export function jsHeapLimit() {
    return globalThis.performance?.memory?.jsHeapSizeLimit || 4 * GB;
}

// Bytes per triangle of a finished model in RAM: geometry (positions/normals/uvs/index ~ 0.5 vertex per triangle),
// BVH (~ 32 B per triangle + reordered index), tangents, the copy the path tracer packs – measured on large
// assemblies ~ 180–260 B; rounded up
export const BYTES_PER_TRIANGLE = 260;

/** Triangle budget/limit for opening models on this device (STEP: coarser quality above the budget) */
export function triangleLimits({ budget, limit }) {
    const fit = Math.floor(memoryBudget() / BYTES_PER_TRIANGLE);
    // config values are the upper end (devices reporting ≥ 8 GB); smaller devices scale down
    return { budget: Math.min(budget, Math.max(Math.floor(fit / 2), 500_000)), limit: Math.min(limit, Math.max(fit, 1_500_000)) };
}

/** Workers of a pool that may run at once, each needing about `perWorker` bytes, on top of `shared` bytes */
export function workersWithin(perWorker, shared = 0, max = 16) {
    const free = memoryBudget() - shared;
    return Math.max(1, Math.min(max, Math.floor(free / Math.max(perWorker, 1))));
}

/** Format bytes for messages ("5,8 GB") in the current locale */
export function formatBytes(bytes, locale) {
    const gb = bytes / GB;
    return gb >= 1 ? `${gb.toLocaleString(locale, { maximumFractionDigits: 1 })} GB` : `${Math.round(bytes / 2 ** 20).toLocaleString(locale)} MB`;
}

/**
 * Admission by memory: acquire(bytes) resolves when the jobs in flight plus this one fit into `limit` – at least one
 * job always runs (a single job larger than the limit runs alone). release(bytes) when the job is done.
 */
export class MemoryGate {
    constructor(limit) {
        this.limit = limit;
        this.used = 0;
        this.running = 0;
        this.waiting = [];
    }
    acquire(bytes) {
        return new Promise(resolve => {
            this.waiting.push({ bytes, resolve });
            this._pump();
        });
    }
    release(bytes) {
        this.used -= bytes;
        this.running--;
        this._pump();
    }
    _pump() {
        while (this.waiting.length) {
            const { bytes, resolve } = this.waiting[0];
            if (this.running > 0 && this.used + bytes > this.limit) return;
            this.waiting.shift();
            this.used += bytes;
            this.running++;
            resolve();
        }
    }
}
