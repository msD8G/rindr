// Gaussian splat file formats → one compact layout for the renderer (splat-mesh.js).
// Runs in the load worker (splat-load-worker.js); pure functions, also usable from Node test scripts.
//
// Supported:
//   - PLY (3D Gaussian Splatting, binary little endian): x/y/z, f_dc_0..2 (or red/green/blue), opacity,
//     scale_0..2, rot_0..3, f_rest_* (spherical harmonics, channel-major). Streamed – a 3 GB file is never
//     held in memory as a whole.
//   - compressed PLY (PlayCanvas/SuperSplat): chunk element (bounds per 256 splats) + packed vertex
//     (11-10-11 position/scale, smallest-three rotation, rgba8) + optional uchar SH element
//   - SOG (PlayCanvas "spatially ordered gaussians", .sog = zip of meta.json + lossless WebP images),
//     version 1 and 2. WebP decoding is passed in (decodeImage) – the worker uses WebGL, tests use a codec.
//
// Output layout per splat (SplatBuilder):
//   a  (uvec4, SharedArrayBuffer – also read by the sort workers): x, y, z as float bits, rgba8 colour
//      (rgb = SH band 0 as display colour 0..1, a = opacity after the sigmoid)
//   b  (uvec4): half2(log scale x, y), half2(log scale z, 0), half2(qw, qx), half2(qy, qz)
//   sh (u32 × shWords): higher SH bands as snorm8 × shRange, coefficient-major (r, g, b per coefficient)
// Coordinates stay in the file's space (units/axes are applied by the object's matrix).

export const SH_C0 = 0.28209479177387814;
export const SH_COEFFS = [0, 3, 8, 15];   // coefficients per channel for SH degree 0..3

const sigmoid = v => 1 / (1 + Math.exp(-v));

// float → IEEE half (round to nearest)
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
export function toHalf(v) {
    _f[0] = v;
    const x = _u[0];
    const sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 112;
    let m = x & 0x7fffff;
    if (e >= 31) return ((x >>> 23) & 0xff) === 0xff && m ? sign | 0x7e00 : sign | 0x7c00;   // NaN / overflow
    if (e <= 0) {   // subnormal half
        if (e < -10) return sign;
        m |= 0x800000;
        const shift = 14 - e;
        return sign | ((m + (1 << (shift - 1))) >> shift);
    }
    return (sign | (e << 10) | (m >> 13)) + ((m >> 12) & 1);
}

const unorm8 = v => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255) || 0);   // unorm8
// log scale: clamped to a sane range (half precision, invisible beyond anyway)
const ls = v => (v > 16 ? 16 : v < -30 || !(v === v) ? -30 : v);
const snorm8 = v => { v = Math.round(v); return v > 127 ? 127 : v < -127 ? -127 : v || 0; };

export class SplatBuilder {
    /**
     * @param {number} count
     * @param {number} shCoeffs higher-band coefficients per channel that are kept (0, 3, 8, 15)
     * @param {boolean} shared positions in a SharedArrayBuffer (sort workers read them without a copy)
     * @param {{ a, b, sh }} [buffers] existing (shared) buffers – parallel parsers write into one builder
     */
    constructor(count, shCoeffs = 0, shared = typeof SharedArrayBuffer !== 'undefined', buffers = null) {
        this.count = count;
        this.shCoeffs = shCoeffs;
        this.shWords = Math.ceil(shCoeffs * 3 / 4);
        this.shRange = 1;
        // shared: the main thread shows the splats while they are still being read (progressive loading)
        const Buffer = shared ? SharedArrayBuffer : ArrayBuffer;
        this.shared = shared;
        this.a = buffers?.a || new Uint32Array(new Buffer(count * 16));
        this.af = new Float32Array(this.a.buffer);
        this.b = buffers?.b || new Uint32Array(new Buffer(count * 16));
        this.sh = buffers ? buffers.sh : this.shWords ? new Uint32Array(new Buffer(count * this.shWords * 4)) : null;
        this.shBytes = this.sh ? new Int8Array(this.sh.buffer) : null;
    }

    /** scales as log values, quaternion (w, x, y, z), colour 0..1 (display), alpha 0..1 */
    set(i, x, y, z, s0, s1, s2, qw, qx, qy, qz, r, g, b, alpha) {
        const o = i * 4;
        if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) { x = y = z = 0; alpha = 0; }
        this.af[o] = x;
        this.af[o + 1] = y;
        this.af[o + 2] = z;
        this.a[o + 3] = (unorm8(r) | (unorm8(g) << 8) | (unorm8(b) << 16) | (unorm8(alpha) << 24)) >>> 0;
        let n = Math.hypot(qw, qx, qy, qz);
        if (!(n > 0)) { qw = 1; qx = qy = qz = 0; n = 1; }
        this.b[o] = (toHalf(ls(s0)) | (toHalf(ls(s1)) << 16)) >>> 0;
        this.b[o + 1] = toHalf(ls(s2));
        this.b[o + 2] = (toHalf(qw / n) | (toHalf(qx / n) << 16)) >>> 0;
        this.b[o + 3] = (toHalf(qy / n) | (toHalf(qz / n) << 16)) >>> 0;
    }

    /** higher SH coefficient j (0..shCoeffs-1) of splat i */
    setSh(i, j, r, g, b) {
        const o = i * this.shWords * 4 + j * 3, k = 127 / this.shRange;
        this.shBytes[o] = snorm8(r * k);
        this.shBytes[o + 1] = snorm8(g * k);
        this.shBytes[o + 2] = snorm8(b * k);
    }

    /**
     * Result for the main thread: data + bounds (exact and robust – 0.5/99.5 % per axis of the clearly
     * visible splats, for framing: captured scenes have far "floaters") + a pick sample (raycasting)
     */
    finish(info = {}) {
        return finishStats(this, [this.rangeStats(0, this.count)], info);
    }

    /**
     * Bounds + samples of the splats [start, end): exact min/max of visible splats, positions of clearly
     * visible ones (robust bounds) and a pick sample (raycasting). Parallel parsers compute it per range.
     */
    rangeStats(start, end) {
        const { count, af, a, b } = this;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        const sampleStep = Math.max(1, Math.floor(count / 200000));
        const pickStep = Math.max(1, Math.floor(count / 1500000));
        const xs = [[], [], []], pickIndex = [], pickRadius = [];
        for (let i = start; i < end; i++) {
            const alpha = a[i * 4 + 3] >>> 24;
            if (!alpha) continue;   // fully transparent
            for (let k = 0; k < 3; k++) {
                const v = af[i * 4 + k];
                if (v < min[k]) min[k] = v;
                if (v > max[k]) max[k] = v;
            }
            if (alpha < 64) continue;
            if (i % sampleStep === 0) for (let k = 0; k < 3; k++) xs[k].push(af[i * 4 + k]);
            if (i % pickStep === 0) {
                const s = Math.max(fromHalf(b[i * 4] & 0xffff), fromHalf(b[i * 4] >>> 16), fromHalf(b[i * 4 + 1] & 0xffff));
                pickIndex.push(i);
                pickRadius.push(2 * Math.exp(s));
            }
        }
        return { min, max, xs, pickIndex: Uint32Array.from(pickIndex), pickRadius: Float32Array.from(pickRadius) };
    }
}

// half → float (log scales: normal range, 0 exponent = very small)
const _hf = new Float32Array(1), _hu = new Uint32Array(_hf.buffer);
export function fromHalf(h) {
    const e = (h >> 10) & 0x1f;
    if (!e) return -30;
    _hu[0] = ((h & 0x8000) << 16) | ((e + 112) << 23) | ((h & 0x3ff) << 13);
    return _hf[0];
}

/** Result for the main thread from the builder's buffers + the stats of all ranges */
export function finishStats(builder, stats, info = {}) {
    const min = [0, 1, 2].map(k => Math.min(...stats.map(s => s.min[k])));
    const max = [0, 1, 2].map(k => Math.max(...stats.map(s => s.max[k])));
    const xs = [0, 1, 2].map(k => stats.flatMap(s => s.xs[k]));
    const { min: robustMin, max: robustMax, unbounded } = robustBounds(xs, { min, max });
    const cat = (T, key) => { const out = new T(stats.reduce((n, s) => n + s[key].length, 0)); let o = 0; for (const s of stats) { out.set(s[key], o); o += s[key].length; } return out; };
    const { count, a, b, sh, shWords, shCoeffs, shRange } = builder;
    return { count, a, b, sh, shWords, shCoeffs, shRange, min, max, robustMin, robustMax, unbounded,
        pickIndex: cat(Uint32Array, 'pickIndex'), pickRadius: cat(Float32Array, 'pickRadius'), ...info };
}

/** Data the main thread needs to show splats while loading (shared buffers + estimated bounds) */
export function beginInfo(builder, estimate) {
    const { count, a, b, sh, shWords, shCoeffs, shRange } = builder;
    return { count, a, b, sh, shWords, shCoeffs, shRange, min: estimate.min, max: estimate.max, robustMin: estimate.min, robustMax: estimate.max, loading: true };
}

/**
 * Bounds for framing from sample coordinates xs = [[x…], [y…], [z…]] (fallback if empty): 0.5 / 99.5 % per axis.
 * Captured outdoor scenes ("unbounded": subject + surroundings + a far shell of sky/background, e.g. a bike at a
 * tree: half of the splats within ~26 units, 5 % beyond ~590) → only the core around the centre of mass, otherwise
 * the camera framed the sky shell from far outside and the subject was a dot. Measured: objects/rooms have a ratio
 * 95 %/50 % distance of 2–4, such a capture ~23.
 */
export function robustBounds(xs, fallback) {
    const n = xs[0].length;
    const percentiles = (lo, hi, take = () => true) => {
        const min = [], max = [];
        for (let k = 0; k < 3; k++) {
            const v = Float32Array.from(xs[k].filter((_, i) => take(i))).sort();
            min[k] = v.length ? v[Math.floor(v.length * lo)] : fallback.min[k];
            max[k] = v.length ? v[Math.min(v.length - 1, Math.floor(v.length * hi))] : fallback.max[k];
        }
        return { min, max };
    };
    if (n < 1000) return percentiles(0.005, 0.995);
    // centre of mass of the inner part: start at the median, mean of the nearest 30 %, repeated
    let c = [0, 1, 2].map(k => Float32Array.from(xs[k]).sort()[n >> 1]);
    const dist = new Float32Array(n);
    const measure = () => { for (let i = 0; i < n; i++) dist[i] = Math.hypot(xs[0][i] - c[0], xs[1][i] - c[1], xs[2][i] - c[2]); return Float32Array.from(dist).sort(); };
    for (let it = 0; it < 5; it++) {
        const limit = measure()[Math.floor(n * 0.3)];
        const sum = [0, 0, 0];
        let w = 0;
        for (let i = 0; i < n; i++) if (dist[i] <= limit) { sum[0] += xs[0][i]; sum[1] += xs[1][i]; sum[2] += xs[2][i]; w++; }
        c = sum.map(v => v / w);
    }
    const sorted = measure();
    const q = t => sorted[Math.floor((n - 1) * t)];
    if (!(q(0.95) > 8 * q(0.5))) return percentiles(0.005, 0.995);
    // box around the centre of mass (it becomes the orbit centre – the subject; the densest part of a capture is
    // where the photos were aimed at), half extent per axis = 98 % of the core splats (75 % nearest)
    const core = q(0.75), min = [], max = [];
    for (let k = 0; k < 3; k++) {
        const off = [];
        for (let i = 0; i < n; i++) if (dist[i] <= core) off.push(Math.abs(xs[k][i] - c[k]));
        const half = Float32Array.from(off).sort()[Math.floor((off.length - 1) * 0.98)];
        min[k] = c[k] - half;
        max[k] = c[k] + half;
    }
    return { min, max, unbounded: true };
}

// --- quantisation range of the SH coefficients: 99.9th percentile of |value| of a sample ---
function shRangeOf(values) {
    if (!values.length) return 1;
    const v = Float32Array.from(values, Math.abs).sort();
    return Math.max(v[Math.floor((v.length - 1) * 0.999)], 1e-3);
}

// SH degree that is kept: file degree, limited by the setting and the memory budget (bytes)
export function keptShCoeffs(count, fileCoeffs, { maxShDegree = 3, shBudget = 512 * 2 ** 20, maxBinding = Infinity } = {}) {
    let d = Math.min(SH_COEFFS.indexOf(fileCoeffs), maxShDegree);
    while (d > 0 && count * Math.ceil(SH_COEFFS[d] * 3 / 4) * 4 > Math.min(shBudget, maxBinding)) d--;
    return Math.max(0, SH_COEFFS[d] ?? 0);
}

// ============================================================================================
// PLY
// ============================================================================================

const PLY_TYPES = {
    char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
    int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};
const PLY_GET = {
    char: 'getInt8', int8: 'getInt8', uchar: 'getUint8', uint8: 'getUint8', short: 'getInt16', int16: 'getInt16',
    ushort: 'getUint16', uint16: 'getUint16', int: 'getInt32', int32: 'getInt32', uint: 'getUint32', uint32: 'getUint32',
    float: 'getFloat32', float32: 'getFloat32', double: 'getFloat64', float64: 'getFloat64',
};

/** Parse a PLY header (text up to and including "end_header") */
export function parsePlyHeader(text) {
    const lines = text.split(/\r?\n/);
    if (lines[0].trim() !== 'ply') throw new Error('Not a PLY file');
    const header = { format: null, elements: [], comments: [] };
    let el = null;
    for (const line of lines.slice(1)) {
        const p = line.trim().split(/\s+/);
        if (p[0] === 'format') header.format = p[1];
        else if (p[0] === 'comment') header.comments.push(line.trim().slice(8));
        else if (p[0] === 'element') header.elements.push(el = { name: p[1], count: +p[2], properties: [] });
        else if (p[0] === 'property' && el) {
            if (p[1] === 'list') el.properties.push({ name: p[4], type: p[3], list: p[2] });
            else el.properties.push({ name: p[2], type: p[1] });
        } else if (p[0] === 'end_header') break;
    }
    for (const e of header.elements) {
        let offset = 0;
        for (const prop of e.properties) {
            prop.offset = offset;
            offset += PLY_TYPES[prop.type] || 0;
        }
        e.rowSize = e.properties.some(p => p.list || !PLY_TYPES[p.type]) ? 0 : offset;   // 0 = variable/unknown
    }
    return header;
}

/** What a PLY header describes: 'splat', 'compressed' (PlayCanvas) or 'mesh' */
export function plyKind(header) {
    const el = name => header.elements.find(e => e.name === name);
    const has = (e, ...names) => e && names.every(n => e.properties.some(p => p.name === n));
    const v = el('vertex');
    if (el('chunk') && has(v, 'packed_position', 'packed_rotation', 'packed_scale', 'packed_color')) return 'compressed';
    if (has(v, 'x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3')) return 'splat';
    return 'mesh';
}

/** Find the end of the header in the first bytes of a file: { text, size } or null */
export function plyHeaderOf(bytes) {
    const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const m = /end_header\r?\n/.exec(text);
    return m ? { text: text.slice(0, m.index + m[0].length), size: m.index + m[0].length } : null;
}

/**
 * Reads a byte stream in rows: rows(rowSize, count, cb) hands the rows over in aligned blocks
 * (cb(buffer, rows, first) – buffer holds `rows` rows from offset 0).
 */
export class RowReader {
    constructor(reader, first, onBytes) {
        this.reader = reader;
        this.pending = first;   // bytes received but not consumed yet
        this.onBytes = onBytes;
    }
    async next() {
        const { done, value } = await this.reader.read();
        if (done) return null;
        this.onBytes?.(value.length);
        return value;
    }
    async rows(rowSize, count, cb) {
        const blockRows = Math.max(1, Math.floor((8 << 20) / rowSize));
        const buf = new ArrayBuffer(blockRows * rowSize), u8 = new Uint8Array(buf);
        let fill = 0, done = 0;
        while (done < count) {
            if (!this.pending?.length) {
                this.pending = await this.next();
                if (!this.pending) throw new Error(`Unexpected end of file (${done} of ${count} rows)`);
            }
            const want = Math.min(buf.byteLength, (count - done) * rowSize) - fill;
            const take = Math.min(want, this.pending.length);
            u8.set(this.pending.subarray(0, take), fill);
            this.pending = this.pending.subarray(take);
            fill += take;
            const rows = Math.floor(fill / rowSize);
            if (fill === buf.byteLength || done + rows === count) {
                await cb(buf, rows, done);
                done += rows;
                const rest = fill - rows * rowSize;
                if (rest) u8.copyWithin(0, rows * rowSize, fill);
                fill = rest;
            }
        }
    }
}

/**
 * Streamed PLY → SplatBuilder.
 * @param {ReadableStreamDefaultReader} reader
 * @param {object} options { maxShDegree, shBudget, maxBinding, onProgress(bytes) }
 */
export async function readPly(reader, options = {}) {
    // header
    let head = new Uint8Array(0), found = null;
    let bytes = 0;
    const onBytes = n => { bytes += n; options.onProgress?.(bytes); };
    while (!found) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Not a PLY file');
        onBytes(value.length);
        const merged = new Uint8Array(head.length + value.length);
        merged.set(head);
        merged.set(value, head.length);
        head = merged;
        found = plyHeaderOf(head);
        if (!found && head.length > 65536) throw new Error('PLY header too long');
    }
    const header = parsePlyHeader(found.text);
    if (header.format !== 'binary_little_endian') throw new Error(`PLY format "${header.format}" is not supported for Gaussian splats (binary_little_endian only)`);
    const kind = plyKind(header);
    const rows = new RowReader(reader, head.subarray(found.size), onBytes);
    if (kind === 'compressed') return readCompressedPly(header, rows, options);
    if (kind !== 'splat') throw new Error('PLY without Gaussian splat properties');
    return readSplatPly(header, rows, options);
}

async function skipElement(rows, el) {
    if (!el.rowSize) throw new Error(`PLY element "${el.name}" with lists cannot be skipped`);
    await rows.rows(el.rowSize, el.count, () => {});
}

/**
 * Layout of a splat PLY vertex element: byte offset in the file, row size, SH coefficients in the file and
 * the property offsets the decoder needs (all-float rows: Float32Array view; otherwise copied into one)
 */
export function splatPlyLayout(header, headerSize) {
    let offset = headerSize;
    for (const e of header.elements) {
        if (e.name === 'vertex') break;
        if (!e.rowSize) throw new Error(`PLY element "${e.name}" with lists before the vertices`);
        offset += e.rowSize * e.count;
    }
    const el = header.elements.find(e => e.name === 'vertex');
    if (!el.rowSize) throw new Error('PLY vertex element with lists');
    const props = new Map(el.properties.map(p => [p.name, p]));
    let rest = 0;
    while (props.has(`f_rest_${rest}`)) rest++;
    const dc = props.has('f_dc_0') ? ['f_dc_0', 'f_dc_1', 'f_dc_2'] : ['red', 'green', 'blue'];
    if (!dc.every(n => props.has(n))) throw new Error('PLY splat without colour (f_dc_* / red/green/blue)');
    return {
        offset, count: el.count, rowSize: el.rowSize, properties: el.properties, dc,
        fileCoeffs: SH_COEFFS.includes(rest / 3) ? rest / 3 : 0,
        dcScale: dc[0] === 'red' ? 1 / (PLY_TYPES[props.get('red').type] === 1 ? 255 : 1) : 0,
    };
}

/** Row decoder (buf, rows, first) → builder; the builder's shRange must be set before */
export function plyRowDecoder(layout, builder) {
    const { properties, rowSize, fileCoeffs, dc, dcScale } = layout;
    const coeffs = builder.shCoeffs;
    const props = new Map(properties.map(p => [p.name, p]));
    const names = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity'];
    const restIdx = [];   // coefficient j, channel c → property
    for (let j = 0; j < coeffs; j++) for (let c = 0; c < 3; c++) restIdx.push(props.get(`f_rest_${c * fileCoeffs + j}`));
    const fields = [...[...names, ...dc].map(n => props.get(n)), ...restIdx];
    const allFloat = properties.every(p => p.type === 'float' || p.type === 'float32');
    const S = allFloat ? rowSize / 4 : fields.length;
    const at = allFloat ? fields.map(p => p.offset / 4) : fields.map((p, k) => k);
    const [px, py, pz, s0, s1, s2, r0, r1, r2, r3, op, d0, d1, d2] = at;
    return (buf, n, first) => {
        let f;
        if (allFloat) f = new Float32Array(buf, 0, n * S);
        else {
            const dv = new DataView(buf);
            f = new Float32Array(n * S);
            for (let r = 0; r < n; r++) for (let k = 0; k < S; k++) f[r * S + k] = dv[PLY_GET[fields[k].type]](r * rowSize + fields[k].offset, true);
        }
        for (let r = 0, o = 0; r < n; r++, o += S) {
            const i = first + r;
            const cr = dcScale ? f[o + d0] * dcScale : 0.5 + SH_C0 * f[o + d0];
            const cg = dcScale ? f[o + d1] * dcScale : 0.5 + SH_C0 * f[o + d1];
            const cb = dcScale ? f[o + d2] * dcScale : 0.5 + SH_C0 * f[o + d2];
            builder.set(i, f[o + px], f[o + py], f[o + pz], f[o + s0], f[o + s1], f[o + s2],
                f[o + r0], f[o + r1], f[o + r2], f[o + r3], cr, cg, cb, sigmoid(f[o + op]));
            for (let j = 0, k = 14; j < coeffs; j++, k += 3) builder.setSh(i, j, f[o + at[k]], f[o + at[k + 1]], f[o + at[k + 2]]);
        }
    };
}

/**
 * Sample rows of a splat PLY (bounds estimate + SH quantisation range) through random access:
 * readRange(start, end) → ArrayBuffer. groups × rows consecutive rows spread across the file.
 */
export async function samplePly(layout, readRange, { groups = 256, rows = 4 } = {}) {
    const { offset, count, rowSize, properties, fileCoeffs } = layout;
    const prop = n => properties.find(p => p.name === n);
    const pos = ['x', 'y', 'z', 'opacity'].map(prop);
    const rest = Array.from({ length: fileCoeffs * 3 }, (_, k) => prop(`f_rest_${k}`));
    const xs = [[], [], []], sh = [];
    const g = Math.min(groups, Math.max(1, Math.floor(count / rows)));
    const tasks = Array.from({ length: g }, (_, k) => Math.min(count - rows, Math.floor(k * count / g)));
    for (let k0 = 0; k0 < tasks.length; k0 += 64) {
        const bufs = await Promise.all(tasks.slice(k0, k0 + 64).map(i0 => readRange(offset + Math.max(0, i0) * rowSize, offset + (Math.max(0, i0) + rows) * rowSize)));
        for (const buf of bufs) {
            const dv = new DataView(buf);
            for (let r = 0; r + 1 <= buf.byteLength / rowSize; r++) {
                const get = p => dv[PLY_GET[p.type]](r * rowSize + p.offset, true);
                const [x, y, z, op] = pos.map(get);
                if (sh.length < 40000) for (const p of rest) sh.push(get(p));
                if (sigmoid(op) < 0.25 || !Number.isFinite(x + y + z)) continue;
                xs[0].push(x); xs[1].push(y); xs[2].push(z);
            }
        }
    }
    return { estimate: xs[0].length > 16 ? robustBounds(xs) : null, shRange: shRangeOf(sh) };
}

async function readSplatPly(header, rows, options) {
    const vi = header.elements.findIndex(e => e.name === 'vertex');
    for (const el of header.elements.slice(0, vi)) await skipElement(rows, el);
    const layout = splatPlyLayout(header, 0);
    const { count, rowSize, fileCoeffs, properties } = layout;
    const coeffs = keptShCoeffs(count, fileCoeffs, options);
    const builder = new SplatBuilder(count, coeffs, options.shared);
    const decode = plyRowDecoder(layout, builder);
    const prop = n => properties.find(p => p.name === n);
    const pos = ['x', 'y', 'z', 'opacity'].map(prop);
    await rows.rows(rowSize, count, (buf, n, first) => {
        if (!first) {
            // SH quantisation range + bounds (sampled before for dropped files) from the first block
            const dv = new DataView(buf), sample = [], xs = [[], [], []];
            const step = Math.max(1, Math.floor(n / 4000));
            for (let r = 0; r < n; r += step) {
                const get = p => dv[PLY_GET[p.type]](r * rowSize + p.offset, true);
                for (let k = 0; k < fileCoeffs * 3 && sample.length < 40000; k++) sample.push(get(prop(`f_rest_${k}`)));
                const [x, y, z, op] = pos.map(get);
                if (sigmoid(op) >= 0.25) { xs[0].push(x); xs[1].push(y); xs[2].push(z); }
            }
            builder.shRange = options.shRange ?? shRangeOf(sample);
            options.onBegin?.(builder, options.estimate || robustBounds(xs, { min: [-1, -1, -1], max: [1, 1, 1] }));
        }
        decode(buf, n, first);
        options.onLoaded?.([[0, first + n]]);
    });
    return builder.finish({ format: 'ply', fileShCoeffs: fileCoeffs });
}

async function readCompressedPly(header, rows, options) {
    const el = name => header.elements.find(e => e.name === name);
    const chunkEl = el('chunk'), vertexEl = el('vertex'), shEl = el('sh');
    const count = vertexEl.count;
    const restCount = shEl ? shEl.properties.length : 0;
    const fileCoeffs = SH_COEFFS.includes(restCount / 3) ? restCount / 3 : 0;
    const coeffs = keptShCoeffs(count, fileCoeffs, options);
    const builder = new SplatBuilder(count, coeffs, options.shared);
    builder.shRange = 4;   // compressed SH: (byte/256 − 0.5) · 8 → ±4
    let chunks = null;     // { name: Float32Array }
    const unorm = (v, bits) => (v & ((1 << bits) - 1)) / ((1 << bits) - 1);
    const lerp = (a, b, t) => a + (b - a) * t;
    const ROT = 1 / (Math.sqrt(2) * 0.5);
    for (const e of header.elements) {
        if (e === chunkEl) {
            const cols = Object.fromEntries(e.properties.map(p => [p.name, new Float32Array(e.count)]));
            await rows.rows(e.rowSize, e.count, (buf, n, first) => {
                const dv = new DataView(buf);
                for (let r = 0; r < n; r++) for (const p of e.properties) cols[p.name][first + r] = dv[PLY_GET[p.type]](r * e.rowSize + p.offset, true);
            });
            chunks = cols;
            // bounds right away: the chunk boxes cover every splat (robust: percentiles of the chunk boxes)
            if (cols.min_x) {
                const box = (lo, hi) => [Array.from(lo), Array.from(hi)];
                const [x0, x1] = box(cols.min_x, cols.max_x), [y0, y1] = box(cols.min_y, cols.max_y), [z0, z1] = box(cols.min_z, cols.max_z);
                const lo = robustBounds([x0, y0, z0], { min: [0, 0, 0], max: [0, 0, 0] }).min;
                const hi = robustBounds([x1, y1, z1], { min: [0, 0, 0], max: [0, 0, 0] }).max;
                options.onBegin?.(builder, { min: lo, max: hi });
            }
        } else if (e === vertexEl) {
            if (!chunks) throw new Error('compressed PLY: chunk element missing before vertex');
            const off = name => e.properties.find(p => p.name === name).offset;
            const [op, orot, os, oc] = ['packed_position', 'packed_rotation', 'packed_scale', 'packed_color'].map(off);
            const c = chunks, hasColor = !!c.min_r;
            const q = [0, 0, 0, 0];
            await rows.rows(e.rowSize, e.count, (buf, n, first) => {
                const dv = new DataView(buf);
                for (let r = 0; r < n; r++) {
                    const i = first + r, ci = i >> 8, base = r * e.rowSize;
                    const pp = dv.getUint32(base + op, true), pr = dv.getUint32(base + orot, true);
                    const ps = dv.getUint32(base + os, true), pc = dv.getUint32(base + oc, true);
                    const a = (unorm(pr >>> 20, 10) - 0.5) * ROT, b = (unorm(pr >>> 10, 10) - 0.5) * ROT, cc = (unorm(pr, 10) - 0.5) * ROT;
                    const m = Math.sqrt(Math.max(0, 1 - (a * a + b * b + cc * cc)));
                    const largest = pr >>> 30;
                    let k = 0;
                    for (let t = 0; t < 4; t++) q[t] = t === largest ? m : [a, b, cc][k++];
                    const cx = unorm(pc >>> 24, 8), cy = unorm(pc >>> 16, 8), cz = unorm(pc >>> 8, 8);
                    builder.set(i,
                        lerp(c.min_x[ci], c.max_x[ci], unorm(pp >>> 21, 11)),
                        lerp(c.min_y[ci], c.max_y[ci], unorm(pp >>> 11, 10)),
                        lerp(c.min_z[ci], c.max_z[ci], unorm(pp, 11)),
                        lerp(c.min_scale_x[ci], c.max_scale_x[ci], unorm(ps >>> 21, 11)),
                        lerp(c.min_scale_y[ci], c.max_scale_y[ci], unorm(ps >>> 11, 10)),
                        lerp(c.min_scale_z[ci], c.max_scale_z[ci], unorm(ps, 11)),
                        q[0], q[1], q[2], q[3],
                        hasColor ? lerp(c.min_r[ci], c.max_r[ci], cx) : cx,
                        hasColor ? lerp(c.min_g[ci], c.max_g[ci], cy) : cy,
                        hasColor ? lerp(c.min_b[ci], c.max_b[ci], cz) : cz,
                        unorm(pc, 8));
                }
                options.onLoaded?.([[0, first + n]], []);
            });
        } else if (e === shEl && coeffs) {
            const offs = [];
            for (let j = 0; j < coeffs; j++) for (let ch = 0; ch < 3; ch++) offs.push(e.properties.find(p => p.name === `f_rest_${ch * fileCoeffs + j}`).offset);
            const val = v => (v === 0 ? 0 : v === 255 ? 1 : (v + 0.5) / 256) * 8 - 4;
            await rows.rows(e.rowSize, e.count, (buf, n, first) => {
                const u8 = new Uint8Array(buf);
                for (let r = 0; r < n; r++) {
                    const base = r * e.rowSize;
                    for (let j = 0; j < coeffs; j++) builder.setSh(first + r, j, val(u8[base + offs[j * 3]]), val(u8[base + offs[j * 3 + 1]]), val(u8[base + offs[j * 3 + 2]]));
                }
                options.onLoaded?.([[0, count]], [[0, first + n]]);
            });
        } else {
            await skipElement(rows, e);
        }
    }
    return builder.finish({ format: 'compressed-ply', fileShCoeffs: fileCoeffs });
}

// ============================================================================================
// SOG
// ============================================================================================

/** Minimal zip reader (stored + deflate entries): { name → () => Promise<Uint8Array> } */
// keys: file names (SOG – flat bundle); paths: full paths (BCF – one folder per topic, same names in each)
export function readZip(buffer, { paths = false } = {}) {
    const dv = new DataView(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip/SOG file');
    const entries = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = new Map();
    const dec = new TextDecoder();
    for (let n = 0; n < entries; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip directory');
        const method = dv.getUint16(p + 10, true);
        const size = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const name = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        const data = new Uint8Array(buffer, start, size);
        if (name.endsWith('/')) continue;   // directory entry
        files.set(paths ? name : name.split('/').pop(), async () => {
            if (method === 0) return data;
            if (method !== 8) throw new Error(`Unsupported zip compression (${method})`);
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        });
    }
    return files;
}

const QUAT_IDX = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];

/**
 * SOG (zip or loose files) → SplatBuilder.
 * @param {(name: string) => Promise<Uint8Array>} file loads a file of the bundle
 * @param {(bytes: Uint8Array) => Promise<{ width, height, rgba: Uint8Array }>} decodeImage lossless WebP → RGBA (not premultiplied)
 */
export async function readSog(file, decodeImage, options = {}) {
    const meta = JSON.parse(new TextDecoder().decode(await file('meta.json')));
    const v1 = !(meta.version >= 2);
    const count = v1 ? meta.means.shape[0] : meta.count;
    const image = async name => {
        const img = await decodeImage(await file(name));
        if (img.width * img.height < count && !/centroids/.test(name)) throw new Error(`SOG image ${name} too small`);
        return img;
    };
    options.onProgress?.(0.1);
    const [lo, hi] = [(await image(meta.means.files[0])).rgba, (await image(meta.means.files[1])).rgba];
    const quats = (await image(meta.quats.files[0])).rgba;
    const scales = (await image(meta.scales.files[0])).rgba;
    const sh0 = (await image(meta.sh0.files[0])).rgba;
    options.onProgress?.(0.5);
    // higher SH bands (palette + labels)
    let fileCoeffs = 0, centroids = null, labels = null, cW = 0, cH = 0, shValue = null, paletteCount = 0;
    if (meta.shN) {
        const cen = await image(meta.shN.files[0]);
        centroids = cen.rgba;
        cW = cen.width;
        cH = cen.height;
        labels = (await image(meta.shN.files[1])).rgba;
        fileCoeffs = v1 ? ({ 192: 3, 512: 8, 960: 15 })[cW] || 0 : SH_COEFFS[meta.shN.bands] || 0;
        paletteCount = v1 ? Math.floor(cW / Math.max(fileCoeffs, 1)) * cH : meta.shN.count;
        if (v1) { const lo = meta.shN.mins, span = meta.shN.maxs - meta.shN.mins; shValue = b => lo + span * b / 255; }
        else { const cb = meta.shN.codebook; shValue = b => cb[b]; }
    }
    options.onProgress?.(0.7);
    const coeffs = keptShCoeffs(count, fileCoeffs, options);
    const builder = new SplatBuilder(count, coeffs, options.shared);
    if (coeffs) {   // quantisation range from the palette values in use
        const all = [];
        for (let b = 0; b < 256; b++) all.push(shValue(b));
        builder.shRange = shRangeOf(all) * 1.0001;
    }
    const { mins, maxs } = meta.means;
    const invLog = v => (v < 0 ? -(Math.exp(-v) - 1) : Math.exp(v) - 1);
    const scaleOf = v1 ? (k, b) => meta.scales.mins[k] + (meta.scales.maxs[k] - meta.scales.mins[k]) * b / 255 : (k, b) => meta.scales.codebook[b];
    const dcOf = v1 ? (k, b) => meta.sh0.mins[k] + (meta.sh0.maxs[k] - meta.sh0.mins[k]) * b / 255 : (k, b) => meta.sh0.codebook[b];
    const alphaOf = v1 ? b => sigmoid(meta.sh0.mins[3] + (meta.sh0.maxs[3] - meta.sh0.mins[3]) * b / 255) : b => b / 255;
    const q = [0, 0, 0, 0];
    // bounds from the meta data (log-transformed min/max of all positions)
    const ext = [0, 1, 2].map(k => [invLog(mins[k]), invLog(maxs[k])]);
    options.onBegin?.(builder, { min: ext.map(e => e[0]), max: ext.map(e => e[1]) });
    for (let i = 0; i < count; i++) {
        const o = i * 4;
        const pos = k => invLog(mins[k] + (maxs[k] - mins[k]) * ((lo[o + k] | (hi[o + k] << 8)) / 65535));
        const tag = quats[o + 3] - 252;
        if (tag >= 0 && tag <= 3) {
            const idx = QUAT_IDX[tag];
            let sum = 0;
            for (let k = 0; k < 3; k++) { const v = (quats[o + k] / 255 * 2 - 1) / Math.SQRT2; q[idx[k]] = v; sum += v * v; }
            q[tag] = Math.sqrt(Math.max(0, 1 - sum));
        } else { q[0] = 1; q[1] = q[2] = q[3] = 0; }
        builder.set(i, pos(0), pos(1), pos(2), scaleOf(0, scales[o]), scaleOf(1, scales[o + 1]), scaleOf(2, scales[o + 2]),
            q[0], q[1], q[2], q[3],
            0.5 + SH_C0 * dcOf(0, sh0[o]), 0.5 + SH_C0 * dcOf(1, sh0[o + 1]), 0.5 + SH_C0 * dcOf(2, sh0[o + 2]), alphaOf(sh0[o + 3]));
        if (coeffs) {
            const label = labels[o] | (labels[o + 1] << 8);
            if (label >= paletteCount) continue;
            const cy = Math.floor(label / 64), cx = (label % 64) * fileCoeffs;
            if (cy >= cH) continue;
            for (let j = 0; j < coeffs; j++) {
                const t = (cy * cW + cx + j) * 4;
                builder.setSh(i, j, shValue(centroids[t]), shValue(centroids[t + 1]), shValue(centroids[t + 2]));
            }
        }
        if ((i & 0x3ffff) === 0x3ffff) { options.onProgress?.(0.7 + 0.3 * i / count); options.onLoaded?.([[0, i + 1]]); }
    }
    return builder.finish({ format: 'sog', fileShCoeffs: fileCoeffs });
}
