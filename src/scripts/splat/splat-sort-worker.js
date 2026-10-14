// Sort worker for Gaussian splats (parallel counting sort, coordinated by splat-sorter.js).
// Every worker owns a contiguous range of splats:
//   'keys'    – 16-bit key per splat (back to front: far = small key; culled = KEY_CULLED) + histogram
//   'scatter' – the main thread turned the histograms into start offsets; write the splat indices
// Key = float bits of the depth relative to the nearest depth, shifted into 16 bits: roughly logarithmic
// (constant relative precision – fine near the camera, coarse far away) without Math.log per splat.
// Without SharedArrayBuffer (no cross-origin isolation) one worker sorts everything ('sortAll').
const KEY_CULLED = 65536;
let pos = null, keys = null, order = null, hist = null, start = 0, end = 0, worker = 0;
let segments = [];   // [{ from, to }]: index ranges of this worker that are loaded
const bits = new Uint32Array(1), bitsF = new Float32Array(bits.buffer);
const floatBits = v => { bitsF[0] = v; return bits[0]; };

// ranges: only the splats read so far (progressive loading, [start, end) lists) – the rest is not touched
// (keys, scatter); null = all
function computeKeys(camera) {
    const { origin, dir, mode, planes, near, far, ranges = null } = camera;
    const cull = planes && planes.length ? Float64Array.from(planes) : null;   // [nx, ny, nz, d] × n
    segments = (ranges || [[start, end]]).map(([s, e]) => ({ from: Math.max(s, start), to: Math.min(e, end) })).filter(s => s.to > s.from);
    const [ox, oy, oz] = origin, [dx, dy, dz] = dir;
    const base = floatBits(Math.max(near, 1e-12));
    const range = floatBits(Math.max(far, near * 2)) - base;
    const shift = Math.max(0, Math.ceil(Math.log2((range + 1) / 65536)));
    const keyF = new Float32Array(keys.buffer, keys.byteOffset, keys.length);
    const h = new Uint32Array(65536);
    const distance = mode === 'distance';
    const np = cull ? cull.length / 4 : 0;
    let visible = 0;
    for (const { from, to } of segments) for (let i = from; i < to; i++) {
        const o = i * 4;
        const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
        const x = px - ox, y = py - oy, z = pz - oz;
        let culled = false;
        for (let p = 0; p < np; p++) {
            if (cull[p * 4] * px + cull[p * 4 + 1] * py + cull[p * 4 + 2] * pz + cull[p * 4 + 3] < 0) { culled = true; break; }
        }
        const d = distance ? Math.sqrt(x * x + y * y + z * z) : x * dx + y * dy + z * dz;
        if (culled || !(d > 0)) { keys[i] = KEY_CULLED; continue; }
        keyF[i] = d;
        let k = (keys[i] - base) >> shift;   // keys[i] reads the float bits just written
        k = k < 0 ? 0 : k > 65535 ? 65535 : k;
        k = 65535 - k;   // back to front
        keys[i] = k;
        h[k]++;
        visible++;
    }
    hist.set(h, worker * 65536);
    return visible;
}

function scatter() {
    const off = hist.slice(worker * 65536, worker * 65536 + 65536);
    for (const { from, to } of segments) for (let i = from; i < to; i++) {
        const k = keys[i];
        if (k < KEY_CULLED) order[off[k]++] = i;
    }
}

self.onmessage = ({ data }) => {
    switch (data.type) {
        case 'init':
            ({ worker, start, end } = data);
            pos = new Float32Array(data.a);
            keys = data.keys ? new Uint32Array(data.keys) : new Uint32Array(end - start);
            order = data.order ? new Uint32Array(data.order) : null;
            hist = data.hist ? new Uint32Array(data.hist) : new Uint32Array(65536);
            break;
        case 'keys':
            self.postMessage({ visible: computeKeys(data.camera) });
            break;
        case 'scatter':
            scatter();
            self.postMessage({});
            break;
        case 'sortAll': {   // single worker without shared memory
            const visible = computeKeys(data.camera);
            let run = 0;
            for (let k = 0; k < 65536; k++) { const c = hist[k]; hist[k] = run; run += c; }
            order = new Uint32Array(end - start);
            scatter();
            self.postMessage({ visible, order: order.buffer }, [order.buffer]);
            order = null;
            break;
        }
    }
};
