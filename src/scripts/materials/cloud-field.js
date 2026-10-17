// Cloud volumes (clouds.js): the shape field of the meshes that carry a cloud material – a signed distance per voxel
// (negative inside), over their union's box plus a margin for the puffs. Pure functions, run in a worker
// (cloud-worker.js); also used directly for the material preview (sphere, analytic).
//  1. surface voxels: every triangle sampled densely enough (step ≤ half a voxel) – fast for millions of
//     triangles, no exact triangle/box overlap needed
//  2. outside = flood fill from the grid's border through non-surface voxels (holes in a mesh make it hollow
//     there, the surface still stays)
//  3. distances: exact Euclidean distance transform (Felzenszwalb & Huttenlocher, separable, anisotropic voxel
//     sizes) to the nearest inside voxel and to the nearest outside voxel → signed distance
//  4. stored as 8 bit: distance / (FIELD_RANGE · scale) mapped to 0…1 (0.5 = surface) – clouds need no more
//     precision, 8-bit 3D textures filter everywhere

export const FIELD_RES = 96;          // voxels along every axis (the box need not be a cube)
export const FIELD_RANGE = 0.3;       // stored distance range ± FIELD_RANGE × scale
export const NOISE_RES = 32;          // tiling detail noise, voxels per period

/**
 * @param {Float32Array} triangles  world-space positions, 9 floats per triangle
 * @param {{ min: number[], max: number[] }} box  grid bounds (world)
 * @param {number} scale  cloud scale (world units) – distances are stored relative to it
 * @returns {Uint8Array} FIELD_RES³ values, x fastest
 */
export function shapeField(triangles, box, scale) {
    const n = FIELD_RES, size = [0, 1, 2].map(a => (box.max[a] - box.min[a]) / n);
    const surface = new Uint8Array(n * n * n);
    // 1. surface voxels
    const step = 0.5 * Math.min(...size);
    const idx = (x, y, z) => x + n * (y + n * z);
    const mark = (px, py, pz) => {
        const x = Math.floor((px - box.min[0]) / size[0]), y = Math.floor((py - box.min[1]) / size[1]), z = Math.floor((pz - box.min[2]) / size[2]);
        if (x >= 0 && y >= 0 && z >= 0 && x < n && y < n && z < n) surface[idx(x, y, z)] = 1;
    };
    for (let t = 0; t < triangles.length; t += 9) {
        const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
        const ux = triangles[t + 3] - ax, uy = triangles[t + 4] - ay, uz = triangles[t + 5] - az;
        const vx = triangles[t + 6] - ax, vy = triangles[t + 7] - ay, vz = triangles[t + 8] - az;
        const k = Math.max(1, Math.ceil(Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz)) / step));
        for (let i = 0; i <= k; i++) {
            for (let j = 0; j <= k - i; j++) {
                const a = i / k, b = j / k;
                mark(ax + a * ux + b * vx, ay + a * uy + b * vy, az + a * uz + b * vz);
            }
        }
    }
    // 2. outside: flood fill from the border
    const outside = new Uint8Array(n * n * n);
    const stack = new Int32Array(n * n * n);
    let top = 0;
    const push = i => { if (!surface[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; } };
    for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
            push(idx(0, a, b)); push(idx(n - 1, a, b));
            push(idx(a, 0, b)); push(idx(a, n - 1, b));
            push(idx(a, b, 0)); push(idx(a, b, n - 1));
        }
    }
    while (top > 0) {
        const i = stack[--top], x = i % n, y = ((i / n) | 0) % n, z = (i / (n * n)) | 0;
        if (x > 0) push(i - 1);
        if (x < n - 1) push(i + 1);
        if (y > 0) push(i - n);
        if (y < n - 1) push(i + n);
        if (z > 0) push(i - n * n);
        if (z < n - 1) push(i + n * n);
    }
    // 3. distances (squared, world units) to the nearest inside voxel / to the nearest outside voxel
    const toInside = edt(i => !outside[i], n, size);
    const toOutside = edt(i => outside[i] === 1, n, size);
    // 4. signed distance, 8 bit
    const field = new Uint8Array(n * n * n), range = FIELD_RANGE * scale;
    for (let i = 0; i < field.length; i++) {
        const d = outside[i] ? Math.sqrt(toInside[i]) : -Math.sqrt(toOutside[i]);
        field[i] = Math.round(Math.min(Math.max(d / range * 0.5 + 0.5, 0), 1) * 255);
    }
    return field;
}

/** Field of a sphere (centre 0, `radius`) for the material preview – the same sphere as every other material's: exact */
export function sphereField(radius, box, scale) {
    const n = FIELD_RES, field = new Uint8Array(n * n * n), range = FIELD_RANGE * scale;
    for (let z = 0; z < n; z++) {
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const p = [x, y, z].map((v, a) => box.min[a] + (v + 0.5) / n * (box.max[a] - box.min[a]));
                const d = Math.hypot(p[0], p[1], p[2]) - radius;
                field[x + n * (y + n * z)] = Math.round(Math.min(Math.max(d / range * 0.5 + 0.5, 0), 1) * 255);
            }
        }
    }
    return field;
}

// squared Euclidean distance transform of the voxels where `isSeed` holds (0 there), separable over x, y, z with
// the voxel size of each axis
function edt(isSeed, n, size) {
    const INF = 1e20, total = n * n * n, d = new Float64Array(total);
    for (let i = 0; i < total; i++) d[i] = isSeed(i) ? 0 : INF;
    const f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), zb = new Float64Array(n + 1);
    const strides = [1, n, n * n];
    for (let axis = 0; axis < 3; axis++) {
        const s = strides[axis], w2 = size[axis] * size[axis];
        const [o1, o2] = strides.filter((_, a) => a !== axis);
        for (let a = 0; a < n; a++) {
            for (let b = 0; b < n; b++) {
                const base = a * o1 + b * o2;
                for (let q = 0; q < n; q++) f[q] = d[base + q * s];
                edt1d(f, n, w2, out, v, zb);
                for (let q = 0; q < n; q++) d[base + q * s] = out[q];
            }
        }
    }
    return d;
}

// 1D lower envelope of parabolas (Felzenszwalb & Huttenlocher 2012), sample spacing² = w2; f ≥ 1e20 = no seed
function edt1d(f, n, w2, out, v, z) {
    let k = -1;
    for (let q = 0; q < n; q++) {
        if (f[q] >= 1e20) continue;
        let s = -Infinity;
        while (k >= 0) {
            const p = v[k];
            s = ((f[q] + w2 * q * q) - (f[p] + w2 * p * p)) / (2 * w2 * (q - p));
            if (s > z[k]) break;
            k--;
        }
        if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; }
        else { k++; v[k] = q; z[k] = s; }
        z[k + 1] = Infinity;
    }
    if (k < 0) { out.fill(1e20, 0, n); return; }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const p = v[k];
        out[q] = w2 * (q - p) * (q - p) + f[p];
    }
}

/**
 * Tiling detail noise (NOISE_RES³, 2 channels, x fastest): R = billows (inverted Worley, soft round lumps),
 * G = finer gradient-noise fbm (wisps at the edge). Periodic in all axes, so it repeats without seams.
 */
export function detailNoise(seed = 7) {
    const n = NOISE_RES, out = new Uint8Array(n * n * n * 2);
    let s = seed >>> 0;
    const rand = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
    // Worley points: one per cell of a 6³ grid
    const C = 6, pts = new Float32Array(C * C * C * 3);
    for (let i = 0; i < pts.length; i++) pts[i] = rand();
    // gradient noise lattice (periodic 8)
    const G = 8, grads = new Float32Array(G * G * G * 3);
    for (let i = 0; i < G * G * G; i++) {
        const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
        grads.set([r * Math.cos(a), r * Math.sin(a), z], i * 3);
    }
    const mod = (a, m) => ((a % m) + m) % m;
    const worley = (x, y, z) => {
        // x, y, z in cells (0…C, periodic)
        const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
        let best = 9;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const gx = cx + dx, gy = cy + dy, gz = cz + dz;
            const i = (mod(gx, C) + C * (mod(gy, C) + C * mod(gz, C))) * 3;
            const px = gx + pts[i], py = gy + pts[i + 1], pz = gz + pts[i + 2];
            best = Math.min(best, (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2);
        }
        return Math.sqrt(best);
    };
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const gradient = (x, y, z, period) => {
        const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
        let sum = 0;
        for (let c = 0; c < 8; c++) {
            const ix = x0 + (c & 1), iy = y0 + ((c >> 1) & 1), iz = z0 + (c >> 2);
            const g = (mod(ix, period) % G + G * (mod(iy, period) % G + G * (mod(iz, period) % G))) * 3;
            const dx = x - ix, dy = y - iy, dz = z - iz;
            const w = (c & 1 ? fade(x - x0) : 1 - fade(x - x0)) * ((c >> 1) & 1 ? fade(y - y0) : 1 - fade(y - y0)) * (c >> 2 ? fade(z - z0) : 1 - fade(z - z0));
            sum += w * (grads[g] * dx + grads[g + 1] * dy + grads[g + 2] * dz);
        }
        return sum;
    };
    for (let z = 0; z < n; z++) {
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                const u = x / n, v = y / n, w = z / n, o = (x + n * (y + n * z)) * 2;
                // billows: inverted Worley, two octaves
                const b = (1 - Math.min(worley(u * C, v * C, w * C), 1)) * 0.7 + (1 - Math.min(worley(u * C * 2 + 0.37, v * C * 2 + 0.11, w * C * 2 + 0.73), 1)) * 0.3;
                // wisps: gradient fbm, periods 4 / 8 (all divide the tile)
                const g = gradient(u * 4, v * 4, w * 4, 4) * 0.6 + gradient(u * 8, v * 8, w * 8, 8) * 0.4;
                out[o] = Math.round(Math.min(Math.max(b, 0), 1) * 255);
                out[o + 1] = Math.round(Math.min(Math.max(g * 0.9 + 0.5, 0), 1) * 255);
            }
        }
    }
    return out;
}
