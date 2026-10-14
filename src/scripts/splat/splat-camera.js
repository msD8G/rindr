// Camera for a freshly loaded splat scene: inside (room, captured from within) or outside (object)?
//
// The pick sample (≤ 1.5 M clearly visible splats) goes into an occupancy grid over the robust box (world
// space). Indoor = the middle of the box is clearly emptier than the average AND the best free spot there is
// enclosed – most rays from it hit something before they leave the box. The eye then sits on that spot
// (largest clearance near the middle), looking horizontally along the longest free ray.
import * as THREE from 'three/webgpu';

const N = 24;   // grid cells per axis
const RAYS = 96;

/**
 * @param {import('./splat-mesh.js').SplatMesh} splat (matrixWorld up to date)
 * @returns {{ indoor: false } | { indoor: true, eye: THREE.Vector3, direction: THREE.Vector3, clearance: number, size: number }}
 */
export function analyzeSplatScene(splat) {
    const { pickIndex } = splat.data;
    const a = splat.data.a, pos = new Float32Array(a.buffer, a.byteOffset, splat.count * 4);
    if (!pickIndex || pickIndex.length < 1000) return { indoor: false };
    const box = splat.geometry.boundingBox.clone().applyMatrix4(splat.matrixWorld);
    const size = box.getSize(new THREE.Vector3());
    if (!(size.x > 0 && size.y > 0 && size.z > 0)) return { indoor: false };
    const cell = size.clone().divideScalar(N);
    const counts = new Uint32Array(N * N * N);
    const e = splat.matrixWorld.elements, v = new THREE.Vector3();
    const at = (x, y, z) => (z * N + y) * N + x;
    for (let s = 0; s < pickIndex.length; s++) {
        const o = pickIndex[s] * 4;
        const x = pos[o], y = pos[o + 1], z = pos[o + 2];
        v.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
        const ix = Math.floor((v.x - box.min.x) / cell.x), iy = Math.floor((v.y - box.min.y) / cell.y), iz = Math.floor((v.z - box.min.z) / cell.z);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= N || iy >= N || iz >= N) continue;
        counts[at(ix, iy, iz)]++;
    }
    // occupied = noticeably filled (a few stray splats in the air are no wall)
    let filled = 0, sum = 0;
    for (const c of counts) if (c) { filled++; sum += c; }
    if (!filled) return { indoor: false };
    const threshold = Math.max(2, 0.05 * sum / filled);
    const occupied = new Uint8Array(counts.length);
    for (let i = 0; i < counts.length; i++) occupied[i] = counts[i] >= threshold ? 1 : 0;

    // 1. middle (central 40 % per axis) clearly emptier than the box on average
    const lo = Math.floor(N * 0.3), hi = Math.ceil(N * 0.7);
    let mid = 0;
    for (let z = lo; z < hi; z++) for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) mid += counts[at(x, y, z)];
    const midCells = (hi - lo) ** 3;
    if (mid / midCells > 0.5 * sum / counts.length) return { indoor: false };

    // 2. clearance (city-block distance to the next occupied cell, in cells) – BFS from all occupied cells
    const dist = new Int16Array(counts.length).fill(-1);
    let queue = [];
    for (let i = 0; i < counts.length; i++) if (occupied[i]) { dist[i] = 0; queue.push(i); }
    while (queue.length) {
        const next = [];
        for (const i of queue) {
            const x = i % N, y = Math.floor(i / N) % N, z = Math.floor(i / (N * N));
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const nx = x + dx, ny = y + dy, nz = z + dz;
                if (nx < 0 || ny < 0 || nz < 0 || nx >= N || ny >= N || nz >= N) continue;
                const j = at(nx, ny, nz);
                if (dist[j] < 0) { dist[j] = dist[i] + 1; next.push(j); }
            }
        }
        queue = next;
    }
    // best spot: large clearance, close to the middle
    let best = -1, bestScore = -Infinity;
    const c = (N - 1) / 2;
    for (let z = lo; z < hi; z++) for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) {
        const i = at(x, y, z);
        if (dist[i] < 1) continue;
        const score = dist[i] - 0.25 * Math.hypot(x - c, y - c, z - c);
        if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return { indoor: false };
    const bx = best % N, by = Math.floor(best / N) % N, bz = Math.floor(best / (N * N));
    const eye = new THREE.Vector3((bx + 0.5) * cell.x, (by + 0.5) * cell.y, (bz + 0.5) * cell.z).add(box.min);

    // 3. enclosed: rays from the eye (march through the grid) hit an occupied cell before leaving the box
    const step = Math.min(cell.x, cell.y, cell.z) * 0.5;
    const maxSteps = Math.ceil(size.length() / step);
    const d = new THREE.Vector3(), p = new THREE.Vector3();
    let hits = 0, far = 0;
    const longest = new THREE.Vector3(1, 0, 0);
    for (let r = 0; r < RAYS; r++) {
        // Fibonacci sphere
        const yy = 1 - 2 * (r + 0.5) / RAYS, rr = Math.sqrt(1 - yy * yy), phi = r * Math.PI * (3 - Math.sqrt(5));
        d.set(Math.cos(phi) * rr, yy, Math.sin(phi) * rr);
        p.copy(eye);
        let hit = false, k = 0;
        for (; k < maxSteps; k++) {
            p.addScaledVector(d, step);
            const ix = Math.floor((p.x - box.min.x) / cell.x), iy = Math.floor((p.y - box.min.y) / cell.y), iz = Math.floor((p.z - box.min.z) / cell.z);
            if (ix < 0 || iy < 0 || iz < 0 || ix >= N || iy >= N || iz >= N) break;
            if (occupied[at(ix, iy, iz)]) { hit = true; break; }
        }
        if (hit) hits++;
        // look along the longest free, roughly horizontal ray (sees most of the room)
        if (hit && Math.abs(yy) < 0.35 && k > far) { far = k; longest.set(d.x, 0, d.z).normalize(); }
    }
    if (hits / RAYS < 0.75) return { indoor: false };
    return { indoor: true, eye, direction: longest, clearance: dist[best] * Math.min(cell.x, cell.y, cell.z), size: size.length() };
}
